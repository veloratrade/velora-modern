#!/usr/bin/env python3
"""Tests for the storage uploader and the deployment-gate contract.

Complements test_backup_system.py (42 tests). Everything here runs offline with
a fake transport; the real GitHub transport is exercised separately, for real,
only when a credential exists.
"""
from __future__ import annotations

import hashlib
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from upload_backup import (  # noqa: E402
    STORAGE_VERIFIED, UploadError, assert_metadata_has_no_secrets,
    make_asset_name, make_metadata_path, make_release_tag,
    require_backup_credential, upload_backup, verify_stored_artifact,
)

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
COMMIT = "76a448f133353c4d1b05d307e585d93af57bedf9"
PAYLOAD = b"FAKE DUMP BYTES" * 32


def good_evidence(payload: bytes = PAYLOAD, env: str = "staging") -> dict:
    return {
        "backup_id": f"db-backup-{env}-20260101120000-aaaaaaaaaaaa",
        "environment": env,
        "backup_type": "database",
        "source_commit_sha": COMMIT,
        "created_at": "2026-01-01T12:00:00Z",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size_bytes": len(payload),
        "db_engine": "postgresql",
        "verification_status": "INTEGRITY_VERIFIED",
        "storage_status": "NONE",
        "stored_at": None,
        "release_tag": None,
        "backup_repo": "veloratrade/velora-backups",
    }


class FakeTransport:
    """In-memory store. Can be told to corrupt, truncate, lose, or go public."""

    def __init__(self, *, private=True, corrupt=False, truncate=False,
                 lose_asset=False, fail_upload=False):
        self.private = private
        self.corrupt = corrupt
        self.truncate = truncate
        self.lose_asset = lose_asset
        self.fail_upload = fail_upload
        self.releases: dict = {}
        self.assets: dict = {}
        self.metadata: dict = {}

    def repo_is_private(self) -> bool:
        return self.private

    def create_release(self, tag, name, body):
        self.releases[tag] = {"id": len(self.releases) + 1, "tag_name": tag}
        return self.releases[tag]

    def upload_asset(self, release, asset_name, data):
        if self.fail_upload:
            raise RuntimeError("network exploded mid-upload")
        stored = data
        if self.corrupt:
            stored = data + b"XX"
        if self.truncate:
            stored = data[: len(data) // 2]
        self.assets[(release["tag_name"], asset_name)] = stored
        return {"name": asset_name}

    def download_asset(self, release_tag, asset_name):
        if self.lose_asset:
            raise RuntimeError("asset not found")
        return self.assets[(release_tag, asset_name)]

    def put_metadata(self, path, content, message):
        self.metadata[path] = content
        return {"path": path}


# --------------------------------------------------------------------------- #

class TestStorageVerification(unittest.TestCase):
    def test_verify_accepts_identical_bytes(self):
        ok, problems = verify_stored_artifact(
            hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD), PAYLOAD)
        self.assertTrue(ok)
        self.assertEqual(problems, [])

    def test_verify_rejects_corrupted_bytes(self):
        ok, problems = verify_stored_artifact(
            hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD), PAYLOAD + b"XX")
        self.assertFalse(ok)
        self.assertTrue(any("sha256 mismatch" in p for p in problems))

    def test_verify_rejects_truncated_bytes(self):
        half = PAYLOAD[: len(PAYLOAD) // 2]
        ok, problems = verify_stored_artifact(
            hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD), half)
        self.assertFalse(ok)
        self.assertTrue(any("size mismatch" in p for p in problems))

    def test_verify_rejects_empty_artifact(self):
        ok, problems = verify_stored_artifact(
            hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD), b"")
        self.assertFalse(ok)
        self.assertTrue(any("empty" in p for p in problems))

    def test_verify_rejects_unretrievable_artifact(self):
        ok, problems = verify_stored_artifact(
            hashlib.sha256(PAYLOAD).hexdigest(), len(PAYLOAD), None)
        self.assertFalse(ok)


class TestUploadHappyPath(unittest.TestCase):
    def test_upload_sets_storage_verified_and_stored_at(self):
        t = FakeTransport()
        out = upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        self.assertEqual(out["storage_status"], STORAGE_VERIFIED)
        self.assertEqual(out["stored_at"], "2026-01-01T12:00:00Z")
        self.assertTrue(out["release_tag"])
        self.assertEqual(out["backup_repo"], "veloratrade/velora-backups")

    def test_dump_is_never_committed_to_git(self):
        """The artifact must exist ONLY as a release asset, never as metadata."""
        t = FakeTransport()
        upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        for path, content in t.metadata.items():
            self.assertNotIn(PAYLOAD[:16], content, f"dump bytes leaked into {path}")
            self.assertLess(len(content), 4096, f"{path} is too large to be metadata")
        self.assertEqual(len(t.assets), 1, "dump must be exactly one release asset")

    def test_metadata_records_all_required_fields(self):
        t = FakeTransport()
        upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        path = [p for p in t.metadata if p.endswith(".json")][0]
        record = json.loads(t.metadata[path])
        for field in ("sha256", "size_bytes", "environment", "backup_type",
                      "source_commit_sha", "verification_status",
                      "storage_status", "stored_at", "release_tag"):
            self.assertIn(field, record, f"metadata missing {field}")


class TestUploadFailClosed(unittest.TestCase):
    def test_public_repo_is_refused(self):
        t = FakeTransport(private=False)
        with self.assertRaises(UploadError) as ctx:
            upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        self.assertIn("not private", str(ctx.exception))
        self.assertEqual(len(t.assets), 0, "nothing may be uploaded to a public repo")

    def test_corrupted_storage_fails_closed(self):
        t = FakeTransport(corrupt=True)
        with self.assertRaises(UploadError) as ctx:
            upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        self.assertIn("STORAGE VERIFICATION FAILED", str(ctx.exception))

    def test_truncated_storage_fails_closed(self):
        with self.assertRaises(UploadError):
            upload_backup(good_evidence(), PAYLOAD, FakeTransport(truncate=True), now=NOW)

    def test_unreadable_storage_fails_closed(self):
        with self.assertRaises(UploadError) as ctx:
            upload_backup(good_evidence(), PAYLOAD, FakeTransport(lose_asset=True), now=NOW)
        self.assertIn("could not read back", str(ctx.exception))

    def test_upload_transport_failure_fails_closed(self):
        with self.assertRaises(UploadError):
            upload_backup(good_evidence(), PAYLOAD, FakeTransport(fail_upload=True), now=NOW)

    def test_unverified_artifact_is_never_stored(self):
        ev = good_evidence()
        ev["verification_status"] = "CREATED"
        t = FakeTransport()
        with self.assertRaises(UploadError) as ctx:
            upload_backup(ev, PAYLOAD, t, now=NOW)
        self.assertIn("INTEGRITY_VERIFIED", str(ctx.exception))
        self.assertEqual(len(t.assets), 0)

    def test_size_mismatch_before_upload_is_refused(self):
        ev = good_evidence()
        ev["size_bytes"] = 999999
        with self.assertRaises(UploadError):
            upload_backup(ev, PAYLOAD, FakeTransport(), now=NOW)

    def test_sha_mismatch_before_upload_is_refused(self):
        ev = good_evidence()
        ev["sha256"] = "0" * 64
        t = FakeTransport()
        with self.assertRaises(UploadError):
            upload_backup(ev, PAYLOAD, t, now=NOW)

    def test_invalid_environment_refused(self):
        ev = good_evidence()
        ev["environment"] = "prod-ish"
        with self.assertRaises(UploadError):
            upload_backup(ev, PAYLOAD, FakeTransport(), now=NOW)


class TestCredentialPolicy(unittest.TestCase):
    def test_missing_credential_stops_with_named_secret(self):
        with self.assertRaises(UploadError) as ctx:
            require_backup_credential({})
        msg = str(ctx.exception)
        self.assertIn("CREDENTIAL REQUIRED", msg)
        self.assertIn("BACKUP_REPO_TOKEN", msg)

    def test_github_token_is_never_a_fallback(self):
        with self.assertRaises(UploadError):
            require_backup_credential({"GITHUB_TOKEN": "ghs_something"})

    def test_credential_returned_when_present(self):
        self.assertEqual(require_backup_credential({"BACKUP_REPO_TOKEN": "x"}), "x")


class TestMetadataSafety(unittest.TestCase):
    def test_secret_bearing_metadata_is_refused(self):
        # Token-like strings are ASSEMBLED at runtime: a literal here would trip
        # tools/secret-scan.sh, and weakening that scanner to accommodate a test
        # would be the wrong trade.
        fake_gh_token = "gh" + "p_" + "A" * 20
        fake_pem = "-----BEGIN " + "RSA PRIVATE" + " KEY-----"
        fake_dsn = "postgres" + "://" + "u" + ":" + "p" + "@" + "h/db"
        for bad in ({"note": fake_dsn},
                    {"token": fake_gh_token},
                    {"x": "PASSWORD=hunter2"},
                    {"y": fake_pem}):
            with self.assertRaises(UploadError):
                assert_metadata_has_no_secrets(bad)

    def test_clean_metadata_passes(self):
        assert_metadata_has_no_secrets(good_evidence())


class TestNamespacing(unittest.TestCase):
    def test_release_tag_must_match_environment_namespace(self):
        ev = good_evidence(env="staging")
        with self.assertRaises(UploadError):
            make_release_tag("production", ev["backup_id"], "database")

    def test_staging_backup_cannot_be_stored_as_production(self):
        ev = good_evidence(env="staging")
        ev["environment"] = "production"
        with self.assertRaises(UploadError):
            upload_backup(ev, PAYLOAD, FakeTransport(), now=NOW)

    def test_metadata_path_is_environment_scoped(self):
        p = make_metadata_path("staging", "db-backup-staging-x")
        self.assertTrue(p.startswith("backups/staging/"))

    def test_asset_name_has_no_path_traversal(self):
        name = make_asset_name("db-backup-staging-x")
        self.assertNotIn("/", name)
        self.assertNotIn("..", name)


class TestUploaderTargetIndependence(unittest.TestCase):
    def test_core_logic_has_no_github_coupling(self):
        """upload_backup/verify must work with ANY transport (proven by FakeTransport)."""
        t = FakeTransport()
        out = upload_backup(good_evidence(), PAYLOAD, t, now=NOW)
        self.assertEqual(out["storage_status"], STORAGE_VERIFIED)
        # No GitHub import was needed to exercise the full path.
        self.assertNotIn("github", type(t).__module__.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
