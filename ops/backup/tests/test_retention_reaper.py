#!/usr/bin/env python3
"""Tests for the operational retention executor (`ops/backup/reap_retention.py`).

Every destructive path is exercised against an in-memory fake transport. No
network, no real backup, no real credential. The fake records every mutating
call it receives, so "zero deletions" is asserted as an OBSERVED FACT rather
than inferred from a return value.
"""
from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import reap_retention as rr  # noqa: E402
from retention import BackupRecord  # noqa: E402

def _executable_source(filename: str) -> str:
    """Module source with comments and docstrings stripped.

    Same convention as `test_backup_system.py`: structural claims about code
    must be tested against code, never against explanatory prose.
    """
    import io
    import tokenize

    path = Path(__file__).resolve().parents[1] / filename
    source = path.read_text(encoding="utf-8")
    kept: list[str] = []
    previous_type = tokenize.INDENT
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            continue
        if token.type == tokenize.STRING and previous_type in (
            tokenize.INDENT, tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL,
        ):
            continue
        kept.append(token.string)
        if token.type not in (tokenize.NL, tokenize.NEWLINE):
            previous_type = token.type
    return " ".join(kept)


T0 = datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc)
SHA = "a" * 64
COMMIT = "940892b631a28151a62fac49798d48b4785e53e6"


def ts(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def meta(backup_id, environment="staging", backup_type="database", *, stored,
         verification="INTEGRITY_VERIFIED", storage="STORAGE_VERIFIED", **extra):
    doc = {
        "schema": "velora-backup/2",
        "backup_id": backup_id,
        "environment": environment,
        "backup_type": backup_type,
        "source_commit_sha": COMMIT,
        "created_at": ts(stored),
        "stored_at": ts(stored),
        "sha256": SHA,
        "size_bytes": 1234,
        "verification_status": verification,
        "storage_status": storage,
        "release_tag": backup_id,
        "asset_name": f"{backup_id}.dump.gz",
        "backup_repo": "veloratrade/velora-backups",
    }
    doc.update(extra)
    return doc


def bid(env, n):
    return f"db-backup-{env}-2026090{n}000000-{n:012d}"


class FakeTransport:
    """In-memory stand-in for the private backup repository."""

    def __init__(self, docs, *, fail_delete=False, fail_put=False, mutate_before_delete=None,
                 store_under=None, fail_delete_once=False):
        # docs: list of metadata dicts. `store_under` forces the directory used
        # for ALL docs, so a record whose `environment` field disagrees with its
        # location can be simulated (the reaper must quarantine that).
        self.store = {}
        for doc in docs:
            directory = store_under or doc["environment"]
            path = f"backups/{directory}/{doc['backup_id']}.json"
            self.store[path] = {"doc": doc, "sha": f"sha-{doc['backup_id']}"}
        self.deleted_releases = []
        self.put_calls = []
        self.fail_delete = fail_delete
        self.fail_delete_once = fail_delete_once
        self.delete_attempts = 0
        self.fail_put = fail_put
        self.mutate_before_delete = mutate_before_delete
        self.reads = 0

    def list_metadata(self, environment):
        prefix = f"backups/{environment}/"
        return [p for p in self.store if p.startswith(prefix)]

    def get_metadata(self, path):
        self.reads += 1
        entry = self.store[path]
        return json.loads(json.dumps(entry["doc"])), entry["sha"]

    def delete_release(self, tag):
        self.delete_attempts += 1
        if self.mutate_before_delete:
            self.mutate_before_delete(self)
            self.mutate_before_delete = None
        if self.fail_delete or (self.fail_delete_once and self.delete_attempts == 1):
            raise RuntimeError("simulated provider deletion failure")
        self.deleted_releases.append(tag)
        return "deleted"

    def put_metadata_if_match(self, path, content, message, expected_sha):
        if self.fail_put:
            raise RuntimeError("simulated metadata write failure")
        if self.store[path]["sha"] != expected_sha:
            raise RuntimeError("sha mismatch — concurrent modification")
        self.put_calls.append((path, json.loads(content), expected_sha))
        self.store[path] = {"doc": json.loads(content), "sha": f"sha2-{path}"}
        return {"ok": True}

    # -- assertions helpers ------------------------------------------------ #
    @property
    def destructive_calls(self):
        return len(self.deleted_releases) + len(self.put_calls)


class MutateOnSecondPassTransport(FakeTransport):
    """Applies a mutation when the reaper re-reads state before deleting.

    `reap()` reads the environment once to plan, then re-reads immediately
    before each deletion. Injecting the change on the second pass reproduces a
    genuine time-of-check/time-of-use race, which is the only way to prove the
    pre-delete re-validation is doing real work.
    """

    def __init__(self, docs, *, mutate, **kwargs):
        super().__init__(docs, **kwargs)
        self._mutate = mutate
        self._pass = 0

    def list_metadata(self, environment):
        self._pass += 1
        if self._pass == 2 and self._mutate is not None:
            self._mutate(self.store)
            self._mutate = None
        return super().list_metadata(environment)


EXPIRED = T0 + timedelta(days=1) + timedelta(days=14, hours=1)   # after B+14d


def two_backup_chain(env="staging", **successor_overrides):
    """A (day 0) then B (day 1). A is eligible once B+14d passes."""
    a = meta(bid(env, 1), env, stored=T0)
    b = meta(bid(env, 2), env, stored=T0 + timedelta(days=1), **successor_overrides)
    return [a, b]


class AffirmativeMode(unittest.TestCase):
    """Phase 8 — evaluate and delete must never be confusable."""

    def test_only_exact_false_authorizes_deletion(self):
        self.assertTrue(rr.deletion_authorized("false"))
        self.assertTrue(rr.deletion_authorized("FALSE"))
        self.assertTrue(rr.deletion_authorized("  false  "))

    def test_everything_else_is_a_dry_run(self):
        for value in ["true", "", "  ", "no", "0", "1", "yes", "False!", None, 0, 1, True, False, [], {}]:
            self.assertFalse(rr.deletion_authorized(value), f"{value!r} must NOT authorize deletion")

    def test_missing_input_is_not_destructive(self):
        # A workflow input that never arrives surfaces as None.
        self.assertFalse(rr.deletion_authorized(None))


class DryRun(unittest.TestCase):
    """Phase 8 — dry run performs zero destructive operations."""

    def test_dry_run_reports_eligible_but_deletes_nothing(self):
        t = FakeTransport(two_backup_chain())
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=False, now=EXPIRED)
        self.assertEqual(result["mode"], "DRY_RUN")
        self.assertEqual(result["eligible"], [bid("staging", 1)])
        self.assertEqual(t.deleted_releases, [])
        self.assertEqual(t.put_calls, [])
        self.assertEqual(t.destructive_calls, 0)

    def test_dry_run_is_the_default_for_the_cli(self):
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("--dry-run", default="true")
        self.assertEqual(parser.parse_args([]).dry_run, "true")


class NewestProtection(unittest.TestCase):
    def test_newest_backup_is_never_deleted(self):
        t = FakeTransport(two_backup_chain())
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED + timedelta(days=3650))
        self.assertNotIn(bid("staging", 2), [d["backup_id"] for d in result["deleted"]])
        self.assertEqual(result["protected_indefinitely"], bid("staging", 2))

    def test_single_backup_chain_is_never_emptied(self):
        t = FakeTransport([meta(bid("staging", 1), stored=T0)])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=T0 + timedelta(days=3650))
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)


class Timing(unittest.TestCase):
    def test_before_fourteen_days_nothing_is_deleted(self):
        t = FakeTransport(two_backup_chain())
        before = T0 + timedelta(days=1) + timedelta(days=13, hours=23)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=before)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_exactly_fourteen_days_follows_retention_module_semantics(self):
        t = FakeTransport(two_backup_chain())
        exact = T0 + timedelta(days=1) + timedelta(days=14)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=exact)
        # retention.py treats the boundary as expired; the reaper must not differ.
        self.assertEqual([d["backup_id"] for d in result["deleted"]], [bid("staging", 1)])

    def test_after_fourteen_days_predecessor_is_deleted(self):
        t = FakeTransport(two_backup_chain())
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [bid("staging", 1)])

    def test_window_is_measured_from_successor_stored_at(self):
        """Predecessor created long ago but successor stored recently => protected."""
        a = meta(bid("staging", 1), stored=T0 - timedelta(days=365))
        b = meta(bid("staging", 2), stored=T0)
        t = FakeTransport([a, b])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=T0 + timedelta(days=13))
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)


class SuccessorValidity(unittest.TestCase):
    def test_successor_not_storage_verified_protects_predecessor(self):
        t = FakeTransport(two_backup_chain(storage="STORED"))
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_successor_not_integrity_verified_protects_predecessor(self):
        t = FakeTransport(two_backup_chain(verification="UNVERIFIED"))
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_successor_disappeared_protects_predecessor(self):
        """Phase 4: A waits on B; B vanishes before the timer expires."""
        t = FakeTransport([meta(bid("staging", 1), stored=T0)])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_successor_invalidated_after_timer_started(self):
        """Phase 4 verbatim: B becomes invalid on day 12; A must survive."""
        a = meta(bid("staging", 1), stored=T0)
        b = meta(bid("staging", 2), stored=T0 + timedelta(days=5),
                 storage="STORAGE_FAILED")
        t = FakeTransport([a, b])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=T0 + timedelta(days=30))
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_successor_invalidated_between_plan_and_delete(self):
        """TOCTOU: the successor goes bad AFTER planning, BEFORE deletion.

        This is the test that makes the pre-delete re-evaluation load-bearing.
        The mutation is injected by the transport on its SECOND read pass (the
        re-read inside the delete loop), so the initial plan still lists the
        predecessor as eligible and only the live re-check can save it.
        """
        t = MutateOnSecondPassTransport(
            two_backup_chain(),
            mutate=lambda store: store[f"backups/staging/{bid('staging', 2)}.json"]["doc"]
            .__setitem__("storage_status", "STORAGE_FAILED"),
        )
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.deleted_releases, [])
        self.assertTrue(any("no longer eligible" in s for s in result["skipped"]))

    def test_candidate_changed_between_plan_and_delete_is_refused(self):
        """The candidate itself is rewritten after planning: fingerprint must bite."""
        t = MutateOnSecondPassTransport(
            two_backup_chain(),
            mutate=lambda store: store[f"backups/staging/{bid('staging', 1)}.json"]["doc"]
            .__setitem__("sha256", "b" * 64),
        )
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [])
        self.assertTrue(any("changed since evaluation" in s for s in result["skipped"]))

    def test_environment_becomes_ambiguous_between_plan_and_delete(self):
        """Quarantine appearing mid-run must abort before any deletion."""
        t = MutateOnSecondPassTransport(
            two_backup_chain(),
            mutate=lambda store: store[f"backups/staging/{bid('staging', 2)}.json"]["doc"]
            .__setitem__("stored_at", "not-a-timestamp"),
        )
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [])
        self.assertTrue(any("ambiguous mid-run" in s for s in result["skipped"]))


class EnvironmentIsolation(unittest.TestCase):
    def test_staging_reaper_never_sees_production_backups(self):
        docs = two_backup_chain("staging") + two_backup_chain("production")
        t = FakeTransport(docs)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [bid("staging", 1)])
        for tag in t.deleted_releases:
            self.assertIn("staging", tag)
            self.assertNotIn("production", tag)

    def test_release_tag_outside_the_namespace_is_refused(self):
        """Defence in depth: even a validly-identified record whose release_tag
        points elsewhere must not cause a foreign release to be deleted."""
        a = meta(bid("staging", 1), stored=T0)
        a["release_tag"] = "db-backup-production-20260901000000-000000000009"
        b = meta(bid("staging", 2), stored=T0 + timedelta(days=1))
        t = FakeTransport([a, b])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [])
        self.assertEqual(t.delete_attempts, 0)
        self.assertTrue(any("outside the staging/database namespace" in s
                            for s in result["skipped"]))

    def test_production_reaper_never_touches_staging(self):
        docs = two_backup_chain("staging") + two_backup_chain("production")
        t = FakeTransport(docs)
        rr.reap(t, environment="production", backup_type="database",
                apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.deleted_releases, [bid("production", 1)])

    def test_environment_is_mandatory_and_validated(self):
        t = FakeTransport(two_backup_chain())
        with self.assertRaises(rr.ReaperError):
            rr.reap(t, environment="", backup_type="database", apply_deletions=True, now=EXPIRED)
        with self.assertRaises(rr.ReaperError):
            rr.reap(t, environment="all", backup_type="database", apply_deletions=True, now=EXPIRED)
        self.assertEqual(t.destructive_calls, 0)

    def test_metadata_environment_must_match_its_directory(self):
        """A record claiming 'production' while sitting in backups/staging/ is
        ambiguous: quarantine the run rather than guess which field is true."""
        rogue = meta(bid("staging", 3), "staging", stored=T0)
        rogue["environment"] = "production"     # lying record
        t = FakeTransport(two_backup_chain() + [rogue], store_under="staging")
        self.assertIn(f"backups/staging/{bid('staging', 3)}.json", t.store)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(any("environment mismatch" in q for q in result["quarantined"]))
        self.assertEqual(t.destructive_calls, 0)


class BackupTypeIsolation(unittest.TestCase):
    def test_database_backup_cannot_be_successor_for_persistent_files(self):
        files_old = meta("files-backup-staging-20260901000000-000000000001",
                         backup_type="persistent_files", stored=T0)
        db_new = meta(bid("staging", 2), stored=T0 + timedelta(days=1))
        t = FakeTransport([files_old, db_new])
        result = rr.reap(t, environment="staging", backup_type="persistent_files",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_persistent_files_chain_is_inert_when_absent(self):
        t = FakeTransport(two_backup_chain())
        result = rr.reap(t, environment="staging", backup_type="persistent_files",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["eligible"], [])
        self.assertEqual(t.destructive_calls, 0)

    def test_backup_type_is_validated(self):
        t = FakeTransport(two_backup_chain())
        with self.assertRaises(rr.ReaperError):
            rr.reap(t, environment="staging", backup_type="everything",
                    apply_deletions=True, now=EXPIRED)


class MalformedAndAmbiguous(unittest.TestCase):
    def test_malformed_timestamp_quarantines_and_blocks_deletion(self):
        bad = meta(bid("staging", 3), stored=T0)
        bad["stored_at"] = "yesterday"
        t = FakeTransport(two_backup_chain() + [bad])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(any("malformed stored_at" in q for q in result["quarantined"]))
        self.assertEqual(t.destructive_calls, 0)

    def test_missing_backup_id_quarantines(self):
        bad = meta(bid("staging", 3), stored=T0)
        del bad["backup_id"]
        t = FakeTransport(two_backup_chain())
        t.store["backups/staging/orphan.json"] = {"doc": bad, "sha": "sha-orphan"}
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(result["quarantined"])
        self.assertEqual(t.destructive_calls, 0)

    def test_backup_id_outside_namespace_quarantines(self):
        bad = meta("totally-unexpected-id", stored=T0)
        t = FakeTransport(two_backup_chain())
        t.store["backups/staging/totally-unexpected-id.json"] = {"doc": bad, "sha": "s"}
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(any("namespace" in q for q in result["quarantined"]))
        self.assertEqual(t.destructive_calls, 0)

    def test_path_identity_mismatch_quarantines(self):
        doc = meta(bid("staging", 3), stored=T0)
        t = FakeTransport(two_backup_chain())
        t.store["backups/staging/some-other-name.json"] = {"doc": doc, "sha": "s"}
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(any("does not match backup_id" in q for q in result["quarantined"]))
        self.assertEqual(t.destructive_calls, 0)

    def test_quarantine_is_reported_as_forced_dry_run_before_any_loop(self):
        """The up-front quarantine guard must stop the run at the planning stage.

        Asserted via the observable mode string and the `skipped` list, which
        only the pre-loop guard produces — the in-loop re-read guard emits a
        different message. Without this, removing the first guard would be
        masked by the second and the test suite would pass vacuously.
        """
        bad = meta(bid("staging", 3), stored=T0)
        bad["stored_at"] = "not-a-timestamp"
        t = FakeTransport(two_backup_chain() + [bad])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["mode"], "DRY_RUN (forced: quarantine)")
        self.assertEqual(result["skipped"], result["eligible"])
        self.assertEqual(t.delete_attempts, 0)
        self.assertEqual(t.destructive_calls, 0)

    def test_unreadable_metadata_quarantines_and_blocks(self):
        t = FakeTransport(two_backup_chain())
        original = t.get_metadata

        def flaky(path):
            if path.endswith(f"{bid('staging', 1)}.json"):
                raise RuntimeError("network blip")
            return original(path)

        t.get_metadata = flaky
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(result["quarantined"])
        self.assertEqual(t.destructive_calls, 0)

    def test_legacy_schema_records_are_protected_not_deleted(self):
        """Pre-velora-backup/2 records have no storage_status: never deletable."""
        legacy = {
            "backup_id": bid("staging", 4),
            "environment": "staging",
            "backup_type": "database",
            "verification_status": "INTEGRITY_VERIFIED",
            "created_at_utc": ts(T0),
            "sha256": SHA,
            "schema": "velora-db-backup/1",
        }
        t = FakeTransport(two_backup_chain() + [legacy])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["quarantined"], [])
        self.assertNotIn(bid("staging", 4), [d["backup_id"] for d in result["deleted"]])


class FailureSemantics(unittest.TestCase):
    def test_deletion_failure_stops_and_does_not_cascade(self):
        """A failed deletion must ABORT the run, not move on to the next backup.

        Three backups, two of them eligible. Only the FIRST deletion fails; the
        second would succeed. If the implementation used `continue` instead of
        `break`, the second backup would be destroyed after an unexplained
        failure — so this asserts that zero deletions were attempted after the
        failure, which distinguishes the two control-flow choices.
        """
        a = meta(bid("staging", 1), stored=T0)
        b = meta(bid("staging", 2), stored=T0 + timedelta(days=1))
        c = meta(bid("staging", 3), stored=T0 + timedelta(days=2))
        t = FakeTransport([a, b, c], fail_delete_once=True)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=T0 + timedelta(days=60))

        # Both a and b are past their windows, so without the abort the reaper
        # would have deleted b after a's failure.
        self.assertEqual(len(result["eligible"]), 2)
        self.assertTrue(result["failures"])
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.deleted_releases, [])          # nothing succeeded
        self.assertEqual(t.delete_attempts, 1)            # and nothing else was tried
        self.assertEqual(t.put_calls, [])                 # no tombstone written

    def test_every_deletion_failure_mode_leaves_other_backups_intact(self):
        t = FakeTransport(two_backup_chain(), fail_delete=True)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(result["failures"])
        self.assertEqual(t.deleted_releases, [])
        self.assertEqual(t.put_calls, [])

    def test_tombstone_write_failure_is_reported_as_failure(self):
        t = FakeTransport(two_backup_chain(), fail_put=True)
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertTrue(any("tombstone write failed" in f for f in result["failures"]))
        self.assertEqual(result["deleted"], [])

    def test_missing_credential_fails_closed(self):
        import upload_backup
        with self.assertRaises(upload_backup.UploadError):
            upload_backup.require_backup_credential({})

    def test_empty_environment_directory_is_safe(self):
        t = FakeTransport([])
        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["records_seen"], 0)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(t.destructive_calls, 0)


class Idempotency(unittest.TestCase):
    def test_second_run_deletes_nothing_more(self):
        t = FakeTransport(two_backup_chain())
        first = rr.reap(t, environment="staging", backup_type="database",
                        apply_deletions=True, now=EXPIRED)
        self.assertEqual(len(first["deleted"]), 1)
        deleted_after_first = list(t.deleted_releases)

        second = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(second["deleted"], [])
        self.assertEqual(t.deleted_releases, deleted_after_first)

    def test_tombstone_cannot_advance_a_chain(self):
        rec = BackupRecord(
            backup_id="x", environment="staging", backup_type="database",
            source_commit_sha=COMMIT, created_at=ts(T0), stored_at=ts(T0),
            verification_status="INTEGRITY_VERIFIED",
            storage_status=rr.STORAGE_DELETED,
        )
        self.assertFalse(rec.can_advance_chain())
        self.assertFalse(rec.is_storage_verified())

    def test_tombstone_preserves_audit_fields_and_has_no_secrets(self):
        t = FakeTransport(two_backup_chain())
        rr.reap(t, environment="staging", backup_type="database",
                apply_deletions=True, now=EXPIRED)
        self.assertEqual(len(t.put_calls), 1)
        _, doc, _ = t.put_calls[0]
        self.assertEqual(doc["storage_status"], rr.STORAGE_DELETED)
        self.assertEqual(doc["artifact_present"], False)
        self.assertEqual(doc["sha256"], SHA)            # audit trail preserved
        self.assertEqual(doc["retention_successor_backup_id"], bid("staging", 2))
        blob = json.dumps(doc).lower()
        for marker in ("token", "password", "secret", "postgres://"):
            self.assertNotIn(marker, blob)


class Concurrency(unittest.TestCase):
    def test_record_changed_since_evaluation_is_refused(self):
        docs = two_backup_chain()
        t = FakeTransport(docs)

        # Simulate a competing writer changing the candidate after planning.
        path = f"backups/staging/{bid('staging', 1)}.json"
        t.store[path]["doc"]["sha256"] = "b" * 64

        result = rr.reap(t, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        # The candidate is still eligible by law, and the fingerprint check is
        # against the freshly re-read state, so this run proceeds consistently.
        # What must never happen is deleting a record whose live state differs
        # from what was authorised in the SAME run.
        for entry in result["deleted"]:
            live = t.store[f"backups/staging/{entry['backup_id']}.json"]["doc"]
            self.assertEqual(live["storage_status"], rr.STORAGE_DELETED)

    def test_conditional_write_rejects_stale_sha(self):
        t = FakeTransport(two_backup_chain())
        path = f"backups/staging/{bid('staging', 1)}.json"
        with self.assertRaises(RuntimeError):
            t.put_metadata_if_match(path, b"{}", "msg", "stale-sha")

    def test_second_concurrent_reaper_finds_nothing_to_do(self):
        shared = FakeTransport(two_backup_chain())
        rr.reap(shared, environment="staging", backup_type="database",
                apply_deletions=True, now=EXPIRED)
        # A second worker starting afterwards sees the tombstone.
        result = rr.reap(shared, environment="staging", backup_type="database",
                         apply_deletions=True, now=EXPIRED)
        self.assertEqual(result["deleted"], [])


class NoBypass(unittest.TestCase):
    def test_module_exposes_no_force_or_skip_switch(self):
        import ast
        src = Path(rr.__file__).read_text()
        tree = ast.parse(src)
        doclines = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, str):
                doclines.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        offenders = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                    and node.lineno not in doclines:
                low = node.value.lower()
                for bad in ("--force", "force_delete", "skip_gate", "ignore_retention",
                            "bootstrap", "override"):
                    if bad in low:
                        offenders.append((node.lineno, node.value))
        self.assertEqual(offenders, [], f"bypass-like literals in executable code: {offenders}")

    def test_negated_input_pattern_is_absent_from_executable_code(self):
        """The forbidden `not dry_run` shape must not appear in CODE.

        Scanned against tokenised source, not raw text: the module docstring
        legitimately quotes the anti-pattern to explain why it is banned, and a
        raw-text assertion would punish accurate documentation (the same trap
        `_executable_source` exists to avoid in test_backup_system.py).
        """
        code = _executable_source("reap_retention.py")
        self.assertNotIn("not dry_run", code)
        self.assertNotIn("not args.dry_run", code)
        self.assertNotIn("not apply_deletions or", code.replace("if not apply_deletions or not plan", ""))
        # The affirmative comparison must be present.
        self.assertIn('== "false"', code)


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)


# --------------------------------------------------------------------------- #
# Phase 14 — workflow security, asserted on parsed YAML (never raw text)
# --------------------------------------------------------------------------- #

try:
    import yaml
except ImportError:                                   # pragma: no cover
    yaml = None

REPO = Path(__file__).resolve().parents[3]
RETENTION_WF = REPO / ".github/workflows/backup-retention.yml"


def _workflow():
    return yaml.safe_load(RETENTION_WF.read_text(encoding="utf-8"))


def _all_run_steps(doc):
    for job in doc.get("jobs", {}).values():
        for step in job.get("steps", []) or []:
            yield step


@unittest.skipIf(yaml is None, "pyyaml not installed")
class WorkflowSecurity(unittest.TestCase):

    def test_workflow_exists_and_parses(self):
        self.assertTrue(RETENTION_WF.is_file())
        self.assertIsInstance(_workflow(), dict)

    def test_schedule_exists_so_retention_is_actually_operational(self):
        triggers = _workflow().get(True) or _workflow().get("on")
        self.assertIn("schedule", triggers)
        self.assertTrue(triggers["schedule"][0]["cron"])

    def test_exactly_one_weekly_schedule(self):
        """Section 12: exactly one automatic schedule, and it is weekly."""
        triggers = _workflow().get(True) or _workflow().get("on")
        crons = [e["cron"] for e in triggers["schedule"]]
        self.assertEqual(len(crons), 1, f"exactly one schedule required, found {crons}")
        minute, hour, dom, month, dow = crons[0].split()
        self.assertRegex(minute, r"^\d{1,2}$")
        self.assertRegex(hour, r"^\d{1,2}$")
        self.assertEqual(dom, "*")
        self.assertEqual(month, "*")
        self.assertRegex(dow, r"^[0-7]$", "day-of-week must be a single fixed day (weekly)")
        self.assertEqual(crons[0], "30 3 * * 0", "approved schedule is Sundays 03:30 UTC")

    def test_schedule_is_not_daily_or_hourly(self):
        triggers = _workflow().get(True) or _workflow().get("on")
        for cron in [e["cron"] for e in triggers["schedule"]]:
            self.assertNotEqual(cron.split()[4], "*", "a daily schedule is not permitted")
            self.assertNotIn("*/", cron, "step syntax implies a high-frequency schedule")
            self.assertNotEqual(cron.split()[1], "*", "an hourly schedule is not permitted")

    def test_permissions_are_minimal(self):
        self.assertEqual(_workflow().get("permissions"), {"contents": "read"})

    def test_deploy_mode_is_affirmative_not_negated(self):
        body = " ".join(str(s.get("run", "")) for s in _all_run_steps(_workflow()))
        self.assertIn('"${{ inputs.dry_run }}" = "false"', body)
        self.assertNotIn("!inputs.dry_run", body)
        self.assertNotIn("! inputs.dry_run", body)

    def test_schedule_cannot_delete_because_event_must_be_dispatch(self):
        body = " ".join(str(s.get("run", "")) for s in _all_run_steps(_workflow()))
        self.assertIn('"${{ github.event_name }}" = "workflow_dispatch"', body)

    def test_workflow_cannot_deploy_or_touch_forbidden_systems(self):
        doc = _workflow()
        blob = yaml.dump(doc, default_flow_style=False).lower()
        for forbidden in ("railway up", "railway link", "@railway/cli", "railway.app",
                          "metaapi", "agiliumtrade", "start:worker", "apps/worker",
                          "npm run build", "migrate", "deploy"):
            self.assertNotIn(forbidden, blob, f"retention workflow must not reference {forbidden!r}")

    def test_no_always_or_continue_on_error_around_destructive_work(self):
        for step in _all_run_steps(_workflow()):
            self.assertNotIn("always()", str(step.get("if", "")))
            self.assertNotEqual(step.get("continue-on-error"), True)
        for job in _workflow()["jobs"].values():
            self.assertNotEqual(job.get("continue-on-error"), True)

    def test_no_skip_force_or_override_inputs_exist(self):
        triggers = _workflow().get(True) or _workflow().get("on")
        inputs = (triggers.get("workflow_dispatch") or {}).get("inputs", {}) or {}
        self.assertEqual(set(inputs), {"environment", "backup_type", "dry_run"})
        for name in inputs:
            for bad in ("force", "skip", "override", "bootstrap", "ignore"):
                self.assertNotIn(bad, name.lower())

    def test_environment_input_is_explicit_choice_never_all(self):
        triggers = _workflow().get(True) or _workflow().get("on")
        env_input = triggers["workflow_dispatch"]["inputs"]["environment"]
        self.assertEqual(env_input["type"], "choice")
        self.assertEqual(set(env_input["options"]), {"staging", "production"})
        self.assertNotIn("all", [o.lower() for o in env_input["options"]])

    def test_dedicated_credential_is_required_and_github_token_is_not_used(self):
        blob = yaml.dump(_workflow(), default_flow_style=False)
        self.assertIn("BACKUP_REPO_TOKEN", blob)
        self.assertNotIn("secrets.GITHUB_TOKEN", blob)

    def test_tests_run_before_any_real_backup_is_touched(self):
        steps = list(_all_run_steps(_workflow()))
        names = [str(s.get("name", "")) for s in steps]
        runs = [str(s.get("run", "")) for s in steps]
        test_idx = next(i for i, r in enumerate(runs) if "unittest" in r)
        reap_idx = next(i for i, r in enumerate(runs) if "reap_retention.py" in r)
        self.assertLess(test_idx, reap_idx, f"tests must precede execution: {names}")

    def test_concurrency_group_prevents_parallel_reapers(self):
        concurrency = _workflow().get("concurrency")
        self.assertIsNotNone(concurrency)
        self.assertFalse(concurrency.get("cancel-in-progress"))


class RetentionLawUnchangedByWeeklySchedule(unittest.TestCase):
    """The CHECK INTERVAL moved daily -> weekly. The LAW must not move.

    14 days == 336 hours == 1_209_600 seconds, measured from the successor's
    stored_at. These tests fail loudly if anyone "helpfully" retunes the
    retention period to match the new schedule frequency.
    """

    def _chain(self, observe_days_after_successor):
        """Two verified backups; observation happens N days after B was stored."""
        successor_stored = T0 + timedelta(days=1)
        now = successor_stored + timedelta(days=observe_days_after_successor)
        older = BackupRecord(
            backup_id=bid("staging", 1),
            environment="staging",
            backup_type="database",
            source_commit_sha=COMMIT,
            created_at=ts(T0),
            stored_at=ts(T0),
            sha256=SHA,
            verification_status="INTEGRITY_VERIFIED",
            storage_status="STORAGE_VERIFIED",
        )
        newer = BackupRecord(
            backup_id=bid("staging", 2),
            environment="staging",
            backup_type="database",
            source_commit_sha=COMMIT,
            created_at=ts(successor_stored),
            stored_at=ts(successor_stored),
            sha256=SHA,
            verification_status="INTEGRITY_VERIFIED",
            storage_status="STORAGE_VERIFIED",
        )
        return older, newer, now

    def _verdict(self, older, newer, now):
        import retention

        return retention.evaluate_deletion(
            older.backup_id,
            [older, newer],
            environment="staging",
            backup_type="database",
            now=now,
        )

    def test_retention_constant_is_exactly_fourteen_days(self):
        import retention

        self.assertEqual(retention.RETENTION_DAYS, 14)
        window = timedelta(days=retention.RETENTION_DAYS)
        self.assertEqual(window.total_seconds(), 1_209_600)
        self.assertEqual(window.total_seconds() / 3600, 336)

    def test_A_thirteen_days_is_not_eligible(self):
        older, newer, now = self._chain(13)
        v = self._verdict(older, newer, now)
        self.assertFalse(v.allowed, f"13 days must NOT be eligible: {v.reasons}")

    def test_B_exactly_fourteen_days_is_eligible(self):
        older, newer, now = self._chain(14)
        v = self._verdict(older, newer, now)
        self.assertTrue(v.allowed, f"exactly 14 days must be eligible: {v.reasons}")

    def test_C_older_than_fourteen_days_is_eligible(self):
        older, newer, now = self._chain(21)
        v = self._verdict(older, newer, now)
        self.assertTrue(v.allowed, f"older than 14 days must be eligible: {v.reasons}")

    def test_K_schedule_frequency_cannot_change_eligibility(self):
        """A weekly checker observing late must never delete anything early.

        A weekly cadence means observation can land days after eligibility.
        Eligibility is a pure function of stored_at + 14d, so observing on day
        14, 18 or 21 yields the same verdict, and day 8 or 13 still refuses.
        """
        for observe_day, expected in ((8, False), (13, False), (14, True), (18, True), (21, True)):
            older, newer, now = self._chain(observe_day)
            v = self._verdict(older, newer, now)
            self.assertEqual(
                v.allowed,
                expected,
                f"observed {observe_day}d after successor: expected allowed={expected}, "
                f"got {v.allowed} ({v.reasons})",
            )

    def test_J_retention_law_module_never_reads_the_schedule(self):
        code = _executable_source("retention.py").lower()
        for token in ("cron", "schedule", "workflow", "github"):
            self.assertNotIn(token, code, f"retention law must not reference {token!r}")
        self.assertNotIn("days=7", code)
        self.assertNotIn("retention_days = 7", code)
