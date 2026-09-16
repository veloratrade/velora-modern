#!/usr/bin/env python3
"""Tests for the Velora Modern unified backup gate + retention chain.

Covers all 22 cases mandated by the owner brief (2026-09-16). Every test is
pure: no network, no filesystem, no real clock. Timestamps are injected so the
14-day law is asserted exactly, not approximately.
"""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backup_gate import (  # noqa: E402
    INTEGRITY_VERIFIED, NOT_APPLICABLE, STORAGE_VERIFIED,
    evaluate_backup_gate, evaluate_release_gate,
)
from retention import (  # noqa: E402
    RETENTION_DAYS, STATE_CREATED, STATE_INTEGRITY_VERIFIED,
    STORAGE_STORED, STORAGE_VERIFIED as R_STORAGE_VERIFIED,
    BackupRecord, compute_chain, evaluate_deletion, format_ts,
    newest_protected, parse_ts, plan_deletions,
)

DAY0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
COMMIT = "76a448f133353c4d1b05d307e585d93af57bedf9"


def _executable_source(filename: str) -> str:
    """Return a module's source with comments and docstrings removed.

    Structural assertions ("the gate must not depend on Railway") are about
    CODE. Using the raw file would let explanatory prose fail the test — and,
    worse, would tempt someone to delete accurate documentation to make a test
    pass. Tokenising strips comments and string literals so only real code is
    inspected.
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
        # A STRING/FSTRING at statement position is a docstring — drop it.
        if token.type == tokenize.STRING and previous_type in (
            tokenize.INDENT, tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL,
        ):
            continue
        kept.append(token.string)
        if token.type not in (tokenize.NL, tokenize.COMMENT):
            previous_type = token.type
    return " ".join(kept)


def day(offset: int) -> datetime:
    return DAY0 + timedelta(days=offset)


def rec(
    backup_id: str,
    *,
    env: str = "staging",
    btype: str = "database",
    stored: datetime | None,
    verification: str = STATE_INTEGRITY_VERIFIED,
    storage: str = R_STORAGE_VERIFIED,
    commit: str = COMMIT,
) -> BackupRecord:
    return BackupRecord(
        backup_id=backup_id,
        environment=env,
        backup_type=btype,
        source_commit_sha=commit,
        created_at=format_ts(stored) if stored else format_ts(DAY0),
        sha256="a" * 64,
        size_bytes=1024,
        verification_status=verification,
        storage_status=storage,
        stored_at=format_ts(stored) if stored else None,
        release_tag=backup_id,
        backup_repo="veloratrade/velora-backups",
    )


def evidence(**overrides) -> dict:
    base = {
        "backup_id": "db-backup-staging-20260101120000-abcdef123456",
        "release_tag": "db-backup-staging-20260101120000-abcdef123456",
        "sha256": "b" * 64,
        "source_commit_sha": COMMIT,
        "verification_status": INTEGRITY_VERIFIED,
        "environment": "staging",
        "storage_status": STORAGE_VERIFIED,
        "backup_type": "database",
        "stored_at": format_ts(DAY0),
    }
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


# =========================================================================== #
# RETENTION LAW — cases 1..3 (the worked example from the brief)
# =========================================================================== #

class TestRetentionLaw(unittest.TestCase):
    def test_01_first_backup_is_protected_indefinitely(self):
        a = rec("A", stored=day(0))
        compute_chain([a], "staging", "database")
        self.assertIsNone(a.retention_expires_at)
        self.assertIsNone(a.successor_backup_id)
        self.assertEqual(newest_protected([a], "staging", "database").backup_id, "A")

    def test_02_second_backup_gives_predecessor_14d_from_successor_storage(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        compute_chain([a, b], "staging", "database")
        # A expires 14 days after B's STORAGE time (day 5) => day 19.
        self.assertEqual(a.retention_expires_at, format_ts(day(19)))
        self.assertEqual(a.successor_backup_id, "B")
        self.assertIsNone(b.retention_expires_at)

    def test_03_third_backup_does_not_move_the_original_expiry(self):
        a, b, c = rec("A", stored=day(0)), rec("B", stored=day(5)), rec("C", stored=day(12))
        compute_chain([a, b, c], "staging", "database")
        self.assertEqual(a.retention_expires_at, format_ts(day(19)))   # unchanged by C
        self.assertEqual(b.retention_expires_at, format_ts(day(26)))   # 14d from C
        self.assertIsNone(c.retention_expires_at)                      # newest
        self.assertEqual(a.successor_backup_id, "B")
        self.assertEqual(b.successor_backup_id, "C")

    def test_timer_uses_successor_storage_not_predecessor_creation(self):
        """The distinguishing property of the owner's law."""
        a = rec("A", stored=day(0))
        a.created_at = format_ts(day(-100))          # ancient creation
        b = rec("B", stored=day(5))
        compute_chain([a, b], "staging", "database")
        self.assertEqual(a.retention_expires_at, format_ts(day(19)))


# =========================================================================== #
# DELETION SAFETY — cases 4..12
# =========================================================================== #

class TestDeletionSafety(unittest.TestCase):
    def test_04_expired_predecessor_may_be_deleted(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(19))
        self.assertTrue(v.allowed, v.reasons)

    def test_04b_not_deletable_one_second_early(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        v = evaluate_deletion("A", [a, b], environment="staging", backup_type="database",
                              now=day(19) - timedelta(seconds=1))
        self.assertFalse(v.allowed)
        self.assertTrue(any("not expired" in r for r in v.reasons))

    def test_05_newest_backup_can_never_be_deleted(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        v = evaluate_deletion("B", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)
        self.assertTrue(any("newest" in r for r in v.reasons))

    def test_06_deletion_without_successor_is_blocked(self):
        a = rec("A", stored=day(0))
        v = evaluate_deletion("A", [a], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)
        self.assertTrue(any("newest" in r or "no successor" in r for r in v.reasons))

    def test_07_wrong_environment_successor_is_rejected(self):
        a = rec("A", env="staging", stored=day(0))
        b = rec("B", env="production", stored=day(5))   # different chain
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)
        self.assertTrue(any("no successor" in r for r in v.reasons))

    def test_08_wrong_backup_type_successor_is_rejected(self):
        a = rec("A", btype="database", stored=day(0))
        b = rec("B", btype="persistent_files", stored=day(5))
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)
        self.assertTrue(any("no successor" in r for r in v.reasons))

    def test_09_unverified_successor_cannot_start_retention(self):
        a = rec("A", stored=day(0))
        b = rec("B", stored=day(5), verification=STATE_CREATED)
        compute_chain([a, b], "staging", "database")
        self.assertIsNone(a.retention_expires_at)
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)

    def test_10_unstored_successor_cannot_start_retention(self):
        a = rec("A", stored=day(0))
        b = rec("B", stored=None, storage="NONE")
        compute_chain([a, b], "staging", "database")
        self.assertIsNone(a.retention_expires_at)
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)

    def test_11_storage_verification_failure_prevents_transition(self):
        """Uploaded (STORED) is NOT storage-verified: the chain must not advance."""
        a = rec("A", stored=day(0))
        b = rec("B", stored=day(5), storage=STORAGE_STORED)
        compute_chain([a, b], "staging", "database")
        self.assertIsNone(a.retention_expires_at)
        v = evaluate_deletion("A", [a, b], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)

    def test_12_failed_new_backup_never_deletes_the_old_one(self):
        a = rec("A", stored=day(0))
        failed = rec("B", stored=None, verification="UNVERIFIED", storage="NONE")
        plan = plan_deletions([a, failed], now=day(999))
        self.assertEqual(plan["delete"], [])
        self.assertEqual(
            plan["chains"]["staging:database"]["protected_indefinitely"], "A"
        )

    def test_successor_missing_from_store_blocks_deletion(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        compute_chain([a, b], "staging", "database")
        v = evaluate_deletion("A", [a], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)

    def test_unknown_candidate_is_refused(self):
        a = rec("A", stored=day(0))
        v = evaluate_deletion("ghost", [a], environment="staging",
                              backup_type="database", now=day(999))
        self.assertFalse(v.allowed)
        self.assertTrue(any("not found" in r for r in v.reasons))

    def test_chain_is_never_emptied(self):
        a, b = rec("A", stored=day(0)), rec("B", stored=day(5))
        plan = plan_deletions([a, b], now=day(999))
        self.assertEqual([d["backup_id"] for d in plan["delete"]], ["A"])


# =========================================================================== #
# CHAIN ISOLATION — cases 13..15
# =========================================================================== #

class TestChainIsolation(unittest.TestCase):
    def test_13_db_backup_cannot_affect_file_retention(self):
        f = rec("F1", btype="persistent_files", stored=day(0))
        d = rec("D1", btype="database", stored=day(5))
        compute_chain([f, d], "staging", "persistent_files")
        self.assertIsNone(f.retention_expires_at)
        self.assertIsNone(f.successor_backup_id)

    def test_14_staging_cannot_affect_production_retention(self):
        p = rec("P1", env="production", stored=day(0))
        s = rec("S1", env="staging", stored=day(5))
        compute_chain([p, s], "production", "database")
        self.assertIsNone(p.retention_expires_at)

    def test_15_production_cannot_affect_staging_retention(self):
        s = rec("S1", env="staging", stored=day(0))
        p = rec("P1", env="production", stored=day(5))
        compute_chain([s, p], "staging", "database")
        self.assertIsNone(s.retention_expires_at)

    def test_four_chains_are_fully_independent(self):
        records = []
        for env in ("staging", "production"):
            for bt in ("database", "persistent_files"):
                records.append(rec(f"{env}-{bt}-1", env=env, btype=bt, stored=day(0)))
                records.append(rec(f"{env}-{bt}-2", env=env, btype=bt, stored=day(5)))
        plan = plan_deletions(records, now=day(19))
        self.assertEqual(len(plan["chains"]), 4)
        self.assertEqual(sorted(d["backup_id"] for d in plan["delete"]),
                         ["production-database-1", "production-persistent_files-1",
                          "staging-database-1", "staging-persistent_files-1"])


# =========================================================================== #
# UNIFIED GATE — cases 16..22
# =========================================================================== #

class TestUnifiedGate(unittest.TestCase):
    def test_16_missing_evidence_blocks_deployment(self):
        for field in ("backup_id", "release_tag", "sha256", "source_commit_sha",
                      "verification_status", "environment", "storage_status"):
            data = evidence()
            del data[field]
            ok, reasons = evaluate_backup_gate(data, "staging")
            self.assertFalse(ok, f"{field} must be required")
            self.assertTrue(any(field in r for r in reasons), reasons)

    def test_17_integrity_failure_blocks_deployment(self):
        ok, reasons = evaluate_backup_gate(
            evidence(verification_status="CREATED"), "staging")
        self.assertFalse(ok)
        self.assertTrue(any("verification_status" in r for r in reasons))

    def test_17b_invalid_sha256_blocks(self):
        for bad in ("A" * 64, "abc", "g" * 64, "b" * 63):
            ok, _ = evaluate_backup_gate(evidence(sha256=bad), "staging")
            self.assertFalse(ok, f"sha256={bad!r} must be rejected")

    def test_18_environment_mismatch_blocks_deployment(self):
        ok, reasons = evaluate_backup_gate(
            evidence(environment="production"), "staging")
        self.assertFalse(ok)
        self.assertTrue(any("environment mismatch" in r for r in reasons))

    def test_18b_staging_evidence_cannot_authorise_production(self):
        ok, _ = evaluate_backup_gate(evidence(), "production")
        self.assertFalse(ok)

    def test_19_source_commit_mismatch_blocks_deployment(self):
        ok, reasons = evaluate_backup_gate(
            evidence(), "staging", expect_commit_sha="deadbeef" * 5)
        self.assertFalse(ok)
        self.assertTrue(any("does not match the deployment commit" in r for r in reasons))

    def test_19b_matching_commit_passes_and_short_sha_is_accepted(self):
        ok, reasons = evaluate_backup_gate(
            evidence(), "staging", expect_commit_sha=COMMIT)
        self.assertTrue(ok, reasons)
        ok, reasons = evaluate_backup_gate(
            evidence(source_commit_sha="76a448f"), "staging", expect_commit_sha=COMMIT)
        self.assertTrue(ok, reasons)

    def test_20_valid_evidence_passes(self):
        ok, reasons = evaluate_backup_gate(evidence(), "staging")
        self.assertTrue(ok, reasons)
        self.assertEqual(reasons, [])

    def test_20b_storage_uploaded_but_unverified_blocks(self):
        ok, reasons = evaluate_backup_gate(
            evidence(storage_status="STORED"), "staging")
        self.assertFalse(ok)
        self.assertTrue(any("storage_status" in r for r in reasons))

    def test_20c_wrong_namespace_blocks(self):
        ok, reasons = evaluate_backup_gate(
            evidence(backup_id="db-backup-production-2026-x"), "staging")
        self.assertFalse(ok)
        self.assertTrue(any("namespace" in r for r in reasons))

    def test_21_gate_is_target_independent(self):
        """No Railway/platform coupling in EXECUTABLE CODE.

        Deliberately inspects code only, with comments and docstrings stripped:
        the module's provenance documentation legitimately *names* Railway when
        explaining why the gate must not depend on it. Scanning raw text would
        make prose fail a structural test.
        """
        code = _executable_source("backup_gate.py").lower()
        for token in ("railway", "nixpacks", "railpack", "heroku", "vercel"):
            self.assertNotIn(token, code, f"gate code must not reference {token!r}")
        for token in ("import requests", "urllib.request", "subprocess", "socket"):
            self.assertNotIn(token, code, f"gate code must not perform I/O via {token!r}")

    def test_22_file_backup_not_applicable_is_honoured(self):
        ok, reasons = evaluate_backup_gate(
            {"verification_status": NOT_APPLICABLE, "backup_type": "persistent_files"},
            "staging",
            backup_type="persistent_files",
            inapplicable_types=("persistent_files",),
        )
        self.assertTrue(ok, reasons)

    def test_22b_not_applicable_cannot_excuse_an_applicable_type(self):
        """The critical anti-fabrication guard."""
        ok, reasons = evaluate_backup_gate(
            {"verification_status": NOT_APPLICABLE, "backup_type": "database"},
            "staging",
            backup_type="database",
            inapplicable_types=("persistent_files",),
        )
        self.assertFalse(ok)
        self.assertTrue(any("applicable" in r for r in reasons))


class TestReleaseGate(unittest.TestCase):
    def test_all_applicable_chains_must_pass(self):
        ok, results = evaluate_release_gate(
            {"database": evidence()}, "staging",
            inapplicable_types=("persistent_files",))
        self.assertTrue(ok, results)
        self.assertEqual(results["persistent_files"]["status"], NOT_APPLICABLE)
        self.assertEqual(results["database"]["status"], "PASS")

    def test_silence_is_not_evidence(self):
        ok, results = evaluate_release_gate({}, "staging")
        self.assertFalse(ok)
        self.assertEqual(results["database"]["status"], "MISSING")

    def test_one_failing_chain_fails_the_release(self):
        ok, results = evaluate_release_gate(
            {"database": evidence(verification_status="CREATED")},
            "staging", inapplicable_types=("persistent_files",))
        self.assertFalse(ok)
        self.assertEqual(results["database"]["status"], "FAIL")


class TestFreshness(unittest.TestCase):
    def test_stale_backup_blocks_when_policy_supplied(self):
        ok, reasons = evaluate_backup_gate(
            evidence(stored_at=format_ts(day(0))), "staging",
            max_age_seconds=3600, now=day(2))
        self.assertFalse(ok)
        self.assertTrue(any("stale" in r for r in reasons))

    def test_fresh_backup_passes(self):
        ok, reasons = evaluate_backup_gate(
            evidence(stored_at=format_ts(day(0))), "staging",
            max_age_seconds=86400, now=day(0) + timedelta(minutes=5))
        self.assertTrue(ok, reasons)

    def test_no_policy_means_no_freshness_check(self):
        ok, _ = evaluate_backup_gate(evidence(stored_at=format_ts(day(-9999))), "staging")
        self.assertTrue(ok)


class TestNoBypass(unittest.TestCase):
    def test_no_skip_force_or_ignore_paths_exist(self):
        """No bypass in EXECUTABLE CODE (comments may legitimately say 'there is
        no continue-on-error path')."""
        code = _executable_source("backup_gate.py").lower()
        for token in ("skip_backup", "ignore_backup", "force_deploy",
                      "continue-on-error", "bypass"):
            self.assertNotIn(token, code, f"gate code must not contain {token!r}")

    def test_unknown_fields_cannot_grant_a_pass(self):
        ok, _ = evaluate_backup_gate(
            {"skip": "true", "force": "true", "verification_status": INTEGRITY_VERIFIED},
            "staging")
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
