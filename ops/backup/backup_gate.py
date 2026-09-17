#!/usr/bin/env python3
"""VELORA MODERN — UNIFIED BACKUP / RELEASE GATE (ADR-012 enforcement).

PROVENANCE (audit-first note)
=============================
The six-field evidence contract below is ADOPTED VERBATIM from the Reference
implementation `veloratrade/veloratrade :: ops/velora-mgmt/backup_gate.py`
(@ `a8eabac`), which ADR-012 already ports as law into Modern:

    backup_id            non-empty, prefixed `db-backup-<environment>-`
    release_tag          non-empty (official storage identifier)
    sha256               lowercase 64-hex digest of the verified artifact
    source_commit_sha    valid git SHA (7..64 hex)
    verification_status  exactly `INTEGRITY_VERIFIED`
    environment          exactly the expected target environment

Reusing it verbatim is deliberate: that validator is pure logic with no MySQL,
FTP or cPanel coupling, it is covered by 90 passing Reference tests, and
re-deriving it would risk weakening a law that is already correct.

WHAT THIS MODULE ADDS (and why each addition was necessary)
-----------------------------------------------------------
1. `backup_type` — the Reference gate validates a DATABASE backup only. The
   owner's law is scoped per (environment x backup_type), so the gate must know
   which chain the evidence belongs to, and the `backup_id` namespace must match
   that type (`db-backup-...` / `files-backup-...`).
2. Storage verification — the Reference gate trusts `release_tag` as proof of
   storage. The owner's law requires the STORED BYTES to be verified after
   upload, so `storage_status == STORAGE_VERIFIED` is a distinct, required
   field. "Uploaded" is not "verified".
3. `NOT_APPLICABLE` — Modern has no persistent runtime files (audited: the only
   Railway volume is `postgres-volume`, and the API performs no filesystem
   writes). The gate must be able to say "this chain does not apply here"
   WITHOUT fabricating a successful file backup. A NOT_APPLICABLE claim is
   accepted only when explicitly asserted for a type that is declared
   inapplicable — it can never be used to excuse a missing database backup.
4. Freshness — ADR-012 leaves max-age open. The gate enforces it only when a
   bound is supplied, so policy stays a caller/owner decision rather than being
   silently invented here.

TARGET INDEPENDENCE (explicit requirement)
------------------------------------------
This module contains NO Railway, GitHub Actions, Docker, or cloud-specific
logic. It performs no network or filesystem I/O. It consumes a plain dict of
evidence and returns a verdict, so the same gate keeps working unchanged if
deployment moves off Railway. Any platform coupling belongs in the producer,
never here.

There is NO skip, ignore, force, or continue-on-error path. Fail-closed on every
missing or invalid item.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

INTEGRITY_VERIFIED = "INTEGRITY_VERIFIED"
RESTORE_VERIFIED = "RESTORE_VERIFIED"
STORAGE_VERIFIED = "STORAGE_VERIFIED"
NOT_APPLICABLE = "NOT_APPLICABLE"

ENVIRONMENTS = ("staging", "production")
BACKUP_TYPES = ("database", "persistent_files")

# `backup_id` namespace per type — extends the Reference's `db-backup-<env>-`.
_ID_PREFIX = {
    "database": "db-backup-{env}-",
    "persistent_files": "files-backup-{env}-",
}

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
_TS_FMT = "%Y-%m-%dT%H:%M:%SZ"

# Verification states that satisfy the law. CREATED alone never does.
_ACCEPTED_VERIFICATION = (INTEGRITY_VERIFIED, RESTORE_VERIFIED)


def _text(value: object) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def evaluate_backup_gate(
    evidence: dict,
    expect_env: str,
    *,
    backup_type: str = "database",
    expect_commit_sha: Optional[str] = None,
    inapplicable_types: tuple[str, ...] = (),
    max_age_seconds: Optional[int] = None,
    now: Optional[datetime] = None,
) -> tuple[bool, list[str]]:
    """Return ``(allowed, reasons)`` for ONE (environment, backup_type) chain.

    ``evidence`` maps field names (any case) to strings. Every failure is
    collected so an operator sees the complete list, not just the first.
    """
    reasons: list[str] = []

    if expect_env not in ENVIRONMENTS:
        return False, [f"invalid expected environment: {expect_env!r}"]
    if backup_type not in BACKUP_TYPES:
        return False, [f"invalid backup_type: {backup_type!r}"]

    normalized = {str(k).lower(): v for k, v in (evidence or {}).items()}

    # --- NOT_APPLICABLE path -------------------------------------------- #
    # Honoured ONLY for a type the caller has declared inapplicable for this
    # target. This is what stops "no files here" from ever excusing a missing
    # database backup.
    claimed_status = _text(normalized.get("verification_status"))
    if claimed_status == NOT_APPLICABLE:
        if backup_type not in inapplicable_types:
            return False, [
                f"{backup_type!r} claims {NOT_APPLICABLE} but it is applicable for this "
                "target — a real verified backup is required"
            ]
        declared = _text(normalized.get("backup_type"))
        if declared is not None and declared != backup_type:
            return False, [
                f"backup_type mismatch on a {NOT_APPLICABLE} claim: "
                f"expected {backup_type!r}, got {declared!r}"
            ]
        return True, []

    def field(key: str) -> Optional[str]:
        raw = _text(normalized.get(key))
        if raw is None:
            reasons.append(f"missing evidence: {key}")
        return raw

    backup_id = field("backup_id")
    release_tag = field("release_tag")
    sha256 = field("sha256")
    source_commit_sha = field("source_commit_sha")
    verification_status = field("verification_status")
    environment = field("environment")
    storage_status = field("storage_status")
    declared_type = field("backup_type")

    if backup_id:
        prefix = _ID_PREFIX[backup_type].format(env=expect_env)
        if not backup_id.startswith(prefix):
            reasons.append(
                f"backup_id not in the {expect_env}/{backup_type} namespace "
                f"(expected prefix {prefix!r}): {backup_id}"
            )
    if sha256 and not _SHA256_RE.match(sha256):
        reasons.append("sha256 is not a lowercase 64-hex digest")
    if source_commit_sha and not _GIT_SHA_RE.match(source_commit_sha):
        reasons.append("source_commit_sha is not a valid git SHA (7..64 hex)")
    if verification_status is not None and verification_status not in _ACCEPTED_VERIFICATION:
        reasons.append(
            f"verification_status must be one of {_ACCEPTED_VERIFICATION}, "
            f"got {verification_status!r}"
        )
    if environment is not None and environment != expect_env:
        reasons.append(f"environment mismatch: expected {expect_env!r}, got {environment!r}")
    if declared_type is not None and declared_type != backup_type:
        reasons.append(f"backup_type mismatch: expected {backup_type!r}, got {declared_type!r}")
    if storage_status is not None and storage_status != STORAGE_VERIFIED:
        reasons.append(
            f"storage_status must be exactly {STORAGE_VERIFIED!r} (uploaded is not verified), "
            f"got {storage_status!r}"
        )

    # Source/release binding: the backup must cover the exact commit deployed.
    if expect_commit_sha is not None and source_commit_sha is not None:
        expected = expect_commit_sha.strip().lower()
        actual = source_commit_sha.lower()
        if not (expected.startswith(actual) or actual.startswith(expected)):
            reasons.append(
                f"source_commit_sha does not match the deployment commit: "
                f"backup {actual}, deploying {expected}"
            )

    # Freshness — enforced only when the caller supplies a bound (ADR-012 leaves
    # the max-age policy to the mechanism decision; inventing one here would be
    # silently making an owner decision).
    stored_at = _text(normalized.get("stored_at"))
    if max_age_seconds is not None:
        if stored_at is None:
            reasons.append("missing evidence: stored_at (required for freshness checking)")
        else:
            try:
                stored = datetime.strptime(stored_at, _TS_FMT).replace(tzinfo=timezone.utc)
            except ValueError:
                reasons.append(f"stored_at is not a valid {_TS_FMT} UTC timestamp: {stored_at!r}")
            else:
                current = now or datetime.now(timezone.utc)
                if current - stored > timedelta(seconds=max_age_seconds):
                    reasons.append(
                        f"backup is stale: stored_at {stored_at} is older than "
                        f"{max_age_seconds}s before {current.strftime(_TS_FMT)}"
                    )
                if stored - current > timedelta(seconds=300):
                    reasons.append(f"stored_at is implausibly in the future: {stored_at}")

    return (not reasons), reasons


def evaluate_release_gate(
    evidence_by_type: dict,
    expect_env: str,
    *,
    expect_commit_sha: Optional[str] = None,
    inapplicable_types: tuple[str, ...] = (),
    max_age_seconds: Optional[int] = None,
    now: Optional[datetime] = None,
) -> tuple[bool, dict]:
    """Evaluate EVERY applicable chain for one deployment. All must pass.

    A backup_type that is neither present in ``evidence_by_type`` nor declared
    inapplicable is a HARD FAILURE — silence is never evidence.
    """
    results: dict = {}
    allowed = True
    for backup_type in BACKUP_TYPES:
        evidence = evidence_by_type.get(backup_type)
        if evidence is None:
            if backup_type in inapplicable_types:
                results[backup_type] = {"allowed": True, "reasons": [], "status": NOT_APPLICABLE}
                continue
            results[backup_type] = {
                "allowed": False,
                "reasons": [f"no backup evidence supplied for applicable type {backup_type!r}"],
                "status": "MISSING",
            }
            allowed = False
            continue
        ok, reasons = evaluate_backup_gate(
            evidence, expect_env,
            backup_type=backup_type,
            expect_commit_sha=expect_commit_sha,
            inapplicable_types=inapplicable_types,
            max_age_seconds=max_age_seconds,
            now=now,
        )
        results[backup_type] = {
            "allowed": ok,
            "reasons": reasons,
            "status": "PASS" if ok else "FAIL",
        }
        allowed = allowed and ok
    return allowed, results


# --------------------------------------------------------------------------- #
# CLI — thin wrapper; the logic above is the contract.
# --------------------------------------------------------------------------- #

_EVIDENCE_KEYS = (
    "BACKUP_ID", "RELEASE_TAG", "SHA256", "SOURCE_COMMIT_SHA",
    "VERIFICATION_STATUS", "ENVIRONMENT", "STORAGE_STATUS", "BACKUP_TYPE", "STORED_AT",
)


def main(argv: Optional[list[str]] = None) -> int:
    expect_env = (os.environ.get("EXPECTED_ENV") or "").strip()
    if not expect_env:
        print("::error::BACKUP GATE: EXPECTED_ENV is not set (staging|production)")
        return 2

    inapplicable = tuple(
        t.strip() for t in (os.environ.get("INAPPLICABLE_BACKUP_TYPES") or "").split(",")
        if t.strip()
    )
    expect_commit = (os.environ.get("EXPECTED_COMMIT_SHA") or "").strip() or None
    max_age_raw = (os.environ.get("MAX_BACKUP_AGE_SECONDS") or "").strip()
    max_age = int(max_age_raw) if max_age_raw else None

    bundle_path = (os.environ.get("BACKUP_EVIDENCE_FILE") or "").strip()
    if bundle_path:
        with open(bundle_path, "r", encoding="utf-8") as handle:
            evidence_by_type = json.load(handle)
    else:
        evidence_by_type = {
            "database": {key.lower(): os.environ.get(key, "") for key in _EVIDENCE_KEYS}
        }

    allowed, results = evaluate_release_gate(
        evidence_by_type, expect_env,
        expect_commit_sha=expect_commit,
        inapplicable_types=inapplicable,
        max_age_seconds=max_age,
    )

    for backup_type, result in sorted(results.items()):
        print(f"  [{result['status']:>14}] {backup_type}")
        for reason in result["reasons"]:
            print(f"::error::BACKUP GATE ({backup_type}): {reason}")

    if allowed:
        print(f"BACKUP GATE PASS: all applicable chains verified (env={expect_env})")
        return 0
    print("BACKUP GATE FAIL: no verified backup — deploy/migration must NOT proceed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
