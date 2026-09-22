#!/usr/bin/env python3
"""Deployment-gate negative tests (Phase 9 mandated cases 1-11).

Uses a REAL evidence record produced by the real staging backup
(db-backup-staging-20260916234730-330e0f248694) as the control, embedded here so
the suite is hermetic. Each case mutates one thing and asserts the gate BLOCKS.

Also asserts the deployment WORKFLOW itself cannot deploy without the gate:
the deploy job must declare the gate in `needs:` and must not offer any
skip/force/bootstrap input.
"""
from __future__ import annotations

import copy
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backup_gate import evaluate_release_gate  # noqa: E402
from retention import (  # noqa: E402
    BackupRecord, STATE_INTEGRITY_VERIFIED, STORAGE_VERIFIED,
    compute_chain, evaluate_deletion, format_ts,
)

REPO = Path(__file__).resolve().parents[3]
COMMIT = "af3dd3e9d92840fdc79934c2d35ebdf9d872f399"

# Verbatim record of the REAL staging backup (metadata only — no dump bytes).
REAL_EVIDENCE = {
    "asset_name": "db-backup-staging-20260916234730-330e0f248694.dump.gz",
    "backup_id": "db-backup-staging-20260916234730-330e0f248694",
    "backup_repo": "veloratrade/velora-backups",
    "backup_type": "database",
    "created_at": "2026-09-16T23:47:30Z",
    "db_engine": "postgresql",
    "environment": "staging",
    "release_tag": "db-backup-staging-20260916234730-330e0f248694",
    "sha256": "9604a377e301cbc6713c1b5b376293893b7f0e7592afd695173c42f32ccd0ba1",
    "size_bytes": 9842,
    "source_commit_sha": COMMIT,
    "storage_status": "STORAGE_VERIFIED",
    "stored_at": "2026-09-16T23:47:52Z",
    "verification_status": "INTEGRITY_VERIFIED",
}
INAPPLICABLE = ("persistent_files",)


def gate(evidence_map, env="staging", commit=COMMIT, **kw):
    return evaluate_release_gate(evidence_map, env, expect_commit_sha=commit,
                                 inapplicable_types=INAPPLICABLE, **kw)


class TestControl(unittest.TestCase):
    def test_00_real_evidence_passes(self):
        """If this ever fails, the negative tests below prove nothing."""
        ok, _ = gate({"database": REAL_EVIDENCE})
        self.assertTrue(ok)


class TestMandatedNegatives(unittest.TestCase):
    def test_01_missing_backup(self):
        ok, res = gate({})
        self.assertFalse(ok)
        self.assertEqual(res["database"]["status"], "MISSING")

    def test_02_missing_release_tag(self):
        e = copy.deepcopy(REAL_EVIDENCE); e.pop("release_tag")
        ok, res = gate({"database": e})
        self.assertFalse(ok)
        self.assertTrue(any("release_tag" in r for r in res["database"]["reasons"]))

    def test_03_wrong_sha256(self):
        for bad in ("deadbeef", "X" * 64, "9604A377" + "0" * 56, ""):
            e = copy.deepcopy(REAL_EVIDENCE); e["sha256"] = bad
            ok, _ = gate({"database": e})
            self.assertFalse(ok, f"sha256={bad!r} must be rejected")

    def test_04_wrong_environment(self):
        e = copy.deepcopy(REAL_EVIDENCE); e["environment"] = "production"
        ok, _ = gate({"database": e})
        self.assertFalse(ok)

    def test_05_wrong_source_commit(self):
        ok, res = gate({"database": REAL_EVIDENCE}, commit="0" * 40)
        self.assertFalse(ok)
        self.assertTrue(any("does not match the deployment commit" in r
                            for r in res["database"]["reasons"]))

    def test_06_unverified_storage(self):
        for bad in ("STORED", "NONE", "UPLOADED", "STORAGE_FAILED"):
            e = copy.deepcopy(REAL_EVIDENCE); e["storage_status"] = bad
            ok, _ = gate({"database": e})
            self.assertFalse(ok, f"storage_status={bad} must block")

    def test_06b_unverified_integrity(self):
        e = copy.deepcopy(REAL_EVIDENCE); e["verification_status"] = "CREATED"
        ok, _ = gate({"database": e})
        self.assertFalse(ok)

    def test_09_production_backup_cannot_authorise_staging(self):
        e = copy.deepcopy(REAL_EVIDENCE)
        e["environment"] = "production"
        e["backup_id"] = e["backup_id"].replace("staging", "production")
        ok, _ = gate({"database": e}, env="staging")
        self.assertFalse(ok)

    def test_10_staging_backup_cannot_authorise_production(self):
        ok, _ = gate({"database": REAL_EVIDENCE}, env="production")
        self.assertFalse(ok)

    def test_11_database_cannot_claim_not_applicable(self):
        e = copy.deepcopy(REAL_EVIDENCE); e["verification_status"] = "NOT_APPLICABLE"
        ok, _ = gate({"database": e})
        self.assertFalse(ok)

    def test_stale_backup_blocked_when_freshness_required(self):
        ok, _ = gate({"database": REAL_EVIDENCE}, max_age_seconds=60,
                     now=datetime(2026, 12, 1, tzinfo=timezone.utc))
        self.assertFalse(ok)


class TestRetentionNegatives(unittest.TestCase):
    """Cases 7 and 8."""

    def _chain(self):
        day0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
        def rec(tag, when):
            return BackupRecord(
                backup_id=f"db-backup-staging-{tag}", environment="staging",
                backup_type="database", source_commit_sha=COMMIT,
                created_at=format_ts(when), sha256="a" * 64, size_bytes=10,
                verification_status=STATE_INTEGRITY_VERIFIED,
                storage_status=STORAGE_VERIFIED, stored_at=format_ts(when),
                release_tag=f"db-backup-staging-{tag}",
                backup_repo="veloratrade/velora-backups")
        a, b = rec("A", day0), rec("B", day0.replace(day=6))
        compute_chain([a, b], "staging", "database")
        return a, b, day0

    @staticmethod
    def _verdict(candidate_id, records, now):
        return evaluate_deletion(candidate_id, records, environment="staging",
                                 backup_type="database", now=now)

    def test_07_expired_backup_without_valid_successor_is_not_deletable(self):
        a, b, day0 = self._chain()
        far = day0.replace(month=6)
        # Control: with a healthy successor and an expired window, A IS deletable.
        self.assertTrue(self._verdict(a.backup_id, [a, b], far).allowed)
        # Now the successor is no longer storage-verified.
        b.storage_status = "STORED"
        v = self._verdict(a.backup_id, [a, b], far)
        self.assertFalse(v.allowed, f"must refuse: {v.reasons}")

    def test_07b_successor_disappeared(self):
        a, b, day0 = self._chain()
        far = day0.replace(month=6)
        v = self._verdict(a.backup_id, [a], far)  # successor gone
        self.assertFalse(v.allowed, f"must refuse: {v.reasons}")

    def test_07c_successor_integrity_revoked(self):
        a, b, day0 = self._chain()
        far = day0.replace(month=6)
        b.verification_status = "CREATED"
        v = self._verdict(a.backup_id, [a, b], far)
        self.assertFalse(v.allowed, f"must refuse: {v.reasons}")

    def test_08_current_newest_is_never_deletable(self):
        a, b, day0 = self._chain()
        far = day0.replace(year=2030)
        v = self._verdict(b.backup_id, [a, b], far)
        self.assertFalse(v.allowed, f"newest must never be deletable: {v.reasons}")

    def test_08b_unknown_candidate_refused(self):
        a, b, day0 = self._chain()
        v = self._verdict("db-backup-staging-NOPE", [a, b], day0.replace(year=2030))
        self.assertFalse(v.allowed)

    def test_08c_cross_environment_candidate_refused(self):
        a, b, day0 = self._chain()
        v = evaluate_deletion(a.backup_id, [a, b], environment="production",
                              backup_type="database", now=day0.replace(year=2030))
        self.assertFalse(v.allowed)


class TestDeploymentPathIsGated(unittest.TestCase):
    """Case 11: the deploy job structurally cannot run without the gate."""

    WF = REPO / ".github" / "workflows" / "deploy-staging-gated.yml"

    def setUp(self):
        if not self.WF.exists():
            self.skipTest(f"workflow not found at {self.WF}")
        self.text = self.WF.read_text()

    def test_deploy_job_depends_on_gate(self):
        m = re.search(r"^  deploy:\n(?:.*\n)*?    needs: \[([^\]]+)\]", self.text, re.M)
        self.assertIsNotNone(m, "deploy job must declare needs:")
        needs = [n.strip() for n in m.group(1).split(",")]
        for required in ("ci", "backup", "backup_gate"):
            self.assertIn(required, needs, f"deploy must depend on {required}")

    def test_gate_job_depends_on_backup(self):
        m = re.search(r"^  backup_gate:\n(?:.*\n)*?    needs: \[([^\]]+)\]", self.text, re.M)
        self.assertIsNotNone(m)
        self.assertIn("backup", m.group(1))

    def test_no_bypass_inputs_exist(self):
        low = self.text.lower()
        for token in ("bootstrap_ack", "empty-target-bootstrap", "skip_backup",
                      "skip_gate", "force_deploy", "continue-on-error"):
            self.assertNotIn(token, low, f"workflow must not offer {token!r}")

    def test_credential_has_no_fallback(self):
        self.assertIn("BACKUP_REPO_TOKEN", self.text)
        self.assertNotIn("secrets.GITHUB_TOKEN", self.text)

    def test_dump_is_not_published_as_artifact(self):
        self.assertIn("rm -f \"evidence/$BID.dump.gz\"", self.text,
                      "the dump must be deleted before artifact upload")
        m = re.search(r"name: backup-evidence\n\s+path: ([^\n]+)", self.text)
        self.assertIsNotNone(m)
        self.assertIn("evidence.json", m.group(1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
