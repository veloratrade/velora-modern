#!/usr/bin/env python3
"""OFFLINE end-to-end proof of the backup chain — STRUCTURAL PROOF ONLY.

WHAT THIS IS
    A deterministic, offline exercise of the COMPLETE LOGICAL CHAIN:
        create -> verify -> store -> verify storage -> evidence -> gate -> decision
    using a real temporary file and a real SHA-256, so the integrity and
    storage-verification steps are genuinely computed rather than asserted.

WHAT THIS IS NOT
    It is NOT a real database backup, NOT a real upload to
    veloratrade/velora-backups, and NOT staging or production evidence.
    No PostgreSQL, no network, no credentials are involved. The artifact is a
    fixture, clearly labelled as such.

Run:  python3 ops/backup/sample_e2e.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backup_gate import evaluate_release_gate  # noqa: E402
from retention import (  # noqa: E402
    BackupRecord, STATE_INTEGRITY_VERIFIED, STORAGE_VERIFIED,
    compute_chain, format_ts, plan_deletions,
)

COMMIT = "76a448f133353c4d1b05d307e585d93af57bedf9"
ENV = "staging"
INAPPLICABLE = ("persistent_files",)   # audited: Modern has no persistent runtime files


def banner(text: str) -> None:
    print(f"\n{'=' * 72}\n{text}\n{'=' * 72}")


def simulate_backup(tag: str, stored_at: datetime, *, corrupt: bool = False) -> dict:
    """Create a REAL file, hash it, 'store' it, then re-verify the stored bytes."""
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / f"{tag}.sql.gz"
        artifact.write_bytes(f"-- FIXTURE dump {tag} — not a real database\n".encode() * 64)

        # 1) integrity: hash the bytes we actually produced
        local_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        size = artifact.stat().st_size

        # 2) "official storage": copy to a separate location
        stored = Path(tmp) / "official" / artifact.name
        stored.parent.mkdir(parents=True)
        payload = artifact.read_bytes()
        if corrupt:
            payload = payload + b"corruption"      # simulate a bad upload
        stored.write_bytes(payload)

        # 3) storage verification: re-read the STORED bytes and re-hash
        remote_sha = hashlib.sha256(stored.read_bytes()).hexdigest()
        storage_ok = (remote_sha == local_sha) and stored.stat().st_size == size

    ts = format_ts(stored_at)
    return {
        "backup_id": f"db-backup-{ENV}-{tag}",
        "release_tag": f"db-backup-{ENV}-{tag}",
        "sha256": local_sha,
        "source_commit_sha": COMMIT,
        "verification_status": STATE_INTEGRITY_VERIFIED,
        "environment": ENV,
        "backup_type": "database",
        "storage_status": STORAGE_VERIFIED if storage_ok else "STORED",
        "stored_at": ts,
        "size_bytes": size,
        "backup_repo": "veloratrade/velora-backups",
    }


def to_record(evidence: dict) -> BackupRecord:
    return BackupRecord(
        backup_id=evidence["backup_id"],
        environment=evidence["environment"],
        backup_type=evidence["backup_type"],
        source_commit_sha=evidence["source_commit_sha"],
        created_at=evidence["stored_at"],
        sha256=evidence["sha256"],
        size_bytes=evidence["size_bytes"],
        verification_status=evidence["verification_status"],
        storage_status=evidence["storage_status"],
        stored_at=evidence["stored_at"],
        release_tag=evidence["release_tag"],
        backup_repo=evidence["backup_repo"],
    )


def main() -> int:
    day0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    failures: list[str] = []

    banner("STEP 1 — VALID BACKUP must PASS the gate")
    good = simulate_backup("20260101120000-aaaaaaaaaaaa", day0)
    print(f"  sha256 (computed from real bytes): {good['sha256'][:24]}…")
    print(f"  storage_status (re-hashed stored bytes): {good['storage_status']}")
    ok, results = evaluate_release_gate(
        {"database": good}, ENV,
        expect_commit_sha=COMMIT, inapplicable_types=INAPPLICABLE)
    print(f"  GATE => {'PASS' if ok else 'FAIL'}")
    for bt, r in sorted(results.items()):
        print(f"    {bt:18} {r['status']}")
    if not ok:
        failures.append("valid backup was rejected")

    banner("STEP 2 — CORRUPTED STORAGE must BLOCK the gate")
    bad = simulate_backup("20260101130000-bbbbbbbbbbbb", day0, corrupt=True)
    print(f"  storage_status after byte re-verification: {bad['storage_status']}")
    ok_bad, results_bad = evaluate_release_gate(
        {"database": bad}, ENV,
        expect_commit_sha=COMMIT, inapplicable_types=INAPPLICABLE)
    print(f"  GATE => {'PASS' if ok_bad else 'BLOCKED'}")
    for reason in results_bad["database"]["reasons"]:
        print(f"    reason: {reason}")
    if ok_bad:
        failures.append("corrupted storage was accepted")

    banner("STEP 3 — WRONG COMMIT must BLOCK the gate")
    ok_c, res_c = evaluate_release_gate(
        {"database": good}, ENV,
        expect_commit_sha="0" * 40, inapplicable_types=INAPPLICABLE)
    print(f"  GATE => {'PASS' if ok_c else 'BLOCKED'}")
    for reason in res_c["database"]["reasons"]:
        print(f"    reason: {reason}")
    if ok_c:
        failures.append("commit mismatch was accepted")

    banner("STEP 4 — WRONG ENVIRONMENT must BLOCK (staging evidence -> production)")
    ok_e, res_e = evaluate_release_gate(
        {"database": good}, "production",
        expect_commit_sha=COMMIT, inapplicable_types=INAPPLICABLE)
    print(f"  GATE => {'PASS' if ok_e else 'BLOCKED'}")
    for reason in res_e["database"]["reasons"][:2]:
        print(f"    reason: {reason}")
    if ok_e:
        failures.append("staging evidence authorised production")

    banner("STEP 5 — FILE BACKUP is NOT_APPLICABLE, not a fake success")
    print(f"  persistent_files => {results['persistent_files']['status']}")
    print("  (audited: only Railway volume is postgres-volume; API writes no files)")
    ok_f, res_f = evaluate_release_gate({}, ENV, inapplicable_types=())
    print(f"  with NO inapplicable declaration => {'PASS' if ok_f else 'BLOCKED'} "
          f"(database={res_f['database']['status']})")
    if ok_f:
        failures.append("missing evidence was accepted")

    banner("STEP 6 — RETENTION LAW across a three-backup chain")
    a = to_record(simulate_backup("A", day0))
    b = to_record(simulate_backup("B", day0 + timedelta(days=5)))
    c = to_record(simulate_backup("C", day0 + timedelta(days=12)))
    compute_chain([a, b, c], ENV, "database")
    for r in (a, b, c):
        print(f"  {r.backup_id:28} stored={r.stored_at}  "
              f"expires={r.retention_expires_at or 'INDEFINITE (protected)'}")
    expect_a = format_ts(day0 + timedelta(days=19))
    expect_b = format_ts(day0 + timedelta(days=26))
    if a.retention_expires_at != expect_a:
        failures.append(f"A expiry {a.retention_expires_at} != {expect_a}")
    if b.retention_expires_at != expect_b:
        failures.append(f"B expiry {b.retention_expires_at} != {expect_b}")
    if c.retention_expires_at is not None:
        failures.append("newest backup must be protected indefinitely")

    banner("STEP 7 — DELETION PLAN at day 19 and day 26")
    for d in (19, 26):
        plan = plan_deletions([a, b, c], now=day0 + timedelta(days=d))
        deletable = [x["backup_id"] for x in plan["delete"]]
        print(f"  day {d:>2}: deletable={deletable or 'none'}  "
              f"protected={plan['chains'][f'{ENV}:database']['protected_indefinitely']}")
        if d == 19 and deletable != [f"db-backup-{ENV}-A"]:
            failures.append(f"day19 plan wrong: {deletable}")
        if d == 26 and sorted(deletable) != [f"db-backup-{ENV}-A", f"db-backup-{ENV}-B"]:
            failures.append(f"day26 plan wrong: {deletable}")

    banner("RESULT")
    if failures:
        for f in failures:
            print(f"  FAILURE: {f}")
        print("\nSAMPLE E2E: FAILED")
        return 1
    print("  VALID BACKUP   -> gate PASSES")
    print("  INVALID BACKUP -> gate BLOCKS deployment (4 distinct failure modes)")
    print("  RETENTION      -> successor-storage-based 14-day law holds exactly")
    print("\nSAMPLE E2E: PASSED  (STRUCTURAL PROOF — fixtures only, no real DB/upload)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
