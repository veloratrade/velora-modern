#!/usr/bin/env python3
"""VELORA MODERN — backup retention chain (owner-approved law, 2026-09-16).

WHY THIS MODULE EXISTS (audit-first note)
=========================================
The Reference repository (`veloratrade/veloratrade`) already implements backup
retention in `ops/velora-mgmt/backup.py::plan_retention_cleanup`. That
implementation is reused CONCEPTUALLY (keep-newest, never-delete-on-failure,
multiple historical backups) but it CANNOT be reused verbatim, because its
expiry rule is different from the law the owner approved:

    Reference : a record expires `keep_days` after ITS OWN `retention_expires_at`
                (derived from the artifact's own creation/expiry metadata), with
                `keep_last_n` protection.
    Owner law : a record expires exactly 14 days after THE SUCCESSOR'S
                SUCCESSFUL STORAGE TIME. The predecessor's own creation time is
                irrelevant.

That difference is not cosmetic — under the Reference rule the timer starts when
a backup is made; under the owner's rule the timer cannot start at all until a
*newer* backup has been created, verified, stored AND storage-verified. A chain
that never produces a successor therefore never expires anything. This module
implements the owner's rule exactly.

SCOPE IS PER CHAIN: (environment, backup_type). A staging database backup can
never advance the production chain, and a database backup can never advance a
persistent_files chain. Chains are fully independent.

Pure logic. No network, no filesystem, no clock dependency beyond an injectable
`now`. Never handles or prints secrets — it only ever sees non-secret evidence
identifiers.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #

RETENTION_DAYS = 14

ENVIRONMENTS = ("staging", "production")
BACKUP_TYPES = ("database", "persistent_files")

# Verification ladder (adopted from the Reference: CREATED alone is never enough).
STATE_UNVERIFIED = "UNVERIFIED"
STATE_CREATED = "CREATED"
STATE_INTEGRITY_VERIFIED = "INTEGRITY_VERIFIED"
STATE_RESTORE_VERIFIED = "RESTORE_VERIFIED"

_STATE_RANK = {
    STATE_UNVERIFIED: 0,
    STATE_CREATED: 1,
    STATE_INTEGRITY_VERIFIED: 2,
    STATE_RESTORE_VERIFIED: 3,
}

# Storage ladder. `STORED` means the artifact was uploaded to the official
# private repository; `STORAGE_VERIFIED` means the stored bytes were read back
# and re-hashed. Only STORAGE_VERIFIED may advance a chain.
STORAGE_NONE = "NONE"
STORAGE_STORED = "STORED"
STORAGE_VERIFIED = "STORAGE_VERIFIED"

_STORAGE_RANK = {STORAGE_NONE: 0, STORAGE_STORED: 1, STORAGE_VERIFIED: 2}

_TS_FMT = "%Y-%m-%dT%H:%M:%SZ"


def parse_ts(value: str) -> datetime:
    """Parse a UTC timestamp. Raises ValueError on anything malformed."""
    return datetime.strptime(value, _TS_FMT).replace(tzinfo=timezone.utc)


def format_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime(_TS_FMT)


# --------------------------------------------------------------------------- #
# Record
# --------------------------------------------------------------------------- #

@dataclass
class BackupRecord:
    """One backup in a chain. Field names mirror the Reference evidence contract
    so the same JSON can feed both the gate and retention."""

    backup_id: str
    environment: str
    backup_type: str
    source_commit_sha: str
    created_at: str
    sha256: Optional[str] = None
    size_bytes: Optional[int] = None
    verification_status: str = STATE_UNVERIFIED
    storage_status: str = STORAGE_NONE
    stored_at: Optional[str] = None          # successful OFFICIAL STORAGE time
    release_tag: Optional[str] = None
    backup_repo: Optional[str] = None
    # Retention bookkeeping — populated by `compute_chain`, never hand-written.
    successor_backup_id: Optional[str] = None
    retention_expires_at: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)

    # -- predicates ------------------------------------------------------- #

    def is_integrity_verified(self) -> bool:
        return _STATE_RANK.get(self.verification_status, 0) >= _STATE_RANK[STATE_INTEGRITY_VERIFIED]

    def is_storage_verified(self) -> bool:
        return _STORAGE_RANK.get(self.storage_status, 0) >= _STORAGE_RANK[STORAGE_VERIFIED]

    def can_advance_chain(self) -> bool:
        """A backup may advance its chain only when ALL four stages succeeded:
        created, integrity-verified, officially stored, storage-verified."""
        return (
            bool(self.stored_at)
            and self.is_integrity_verified()
            and self.is_storage_verified()
        )


# --------------------------------------------------------------------------- #
# Chain computation
# --------------------------------------------------------------------------- #

def chain_key(environment: str, backup_type: str) -> tuple[str, str]:
    return (environment, backup_type)


def _eligible_sorted(records: Iterable[BackupRecord]) -> list[BackupRecord]:
    """Chain-advancing records, oldest first, ordered by STORAGE time.

    Ordering is by `stored_at` — not `created_at` — because the law is written
    in terms of successful storage. A backup created earlier but stored later
    is, for retention purposes, the later one.
    """
    eligible = [r for r in records if r.can_advance_chain()]
    return sorted(eligible, key=lambda r: (parse_ts(r.stored_at), r.backup_id))  # type: ignore[arg-type]


def compute_chain(
    records: Iterable[BackupRecord],
    environment: str,
    backup_type: str,
) -> list[BackupRecord]:
    """Annotate one chain with successor + expiry, per the owner-approved law.

    Rules applied:
      * Only records matching BOTH `environment` and `backup_type` participate.
      * Only records that passed all four stages can advance the chain.
      * The newest such record is PROTECTED INDEFINITELY (expiry = None).
      * Every other record expires exactly RETENTION_DAYS after ITS IMMEDIATE
        SUCCESSOR'S `stored_at` — never after its own creation, and never
        recomputed when a later backup arrives (the worked example in the brief
        requires A's Day-19 expiry to survive C's arrival on Day 12).

    Records that cannot advance the chain (failed/unstored/unverified) are
    returned untouched with no expiry: a failed backup must never be scheduled
    for deletion, and must never start anybody else's timer.
    """
    mine = [r for r in records if r.environment == environment and r.backup_type == backup_type]
    ordered = _eligible_sorted(mine)

    # Reset bookkeeping so recomputation is idempotent.
    for r in mine:
        r.successor_backup_id = None
        r.retention_expires_at = None

    for index, record in enumerate(ordered):
        is_newest = index == len(ordered) - 1
        if is_newest:
            record.successor_backup_id = None
            record.retention_expires_at = None       # protected indefinitely
            continue
        successor = ordered[index + 1]
        record.successor_backup_id = successor.backup_id
        record.retention_expires_at = format_ts(
            parse_ts(successor.stored_at) + timedelta(days=RETENTION_DAYS)  # type: ignore[arg-type]
        )
    return mine


def newest_protected(records: Iterable[BackupRecord], environment: str,
                     backup_type: str) -> Optional[BackupRecord]:
    """The indefinitely-protected head of a chain, or None if the chain is empty."""
    ordered = _eligible_sorted(
        [r for r in records if r.environment == environment and r.backup_type == backup_type]
    )
    return ordered[-1] if ordered else None


# --------------------------------------------------------------------------- #
# Deletion safety (Phase 3) — seven independent preconditions
# --------------------------------------------------------------------------- #

@dataclass
class DeletionVerdict:
    allowed: bool
    reasons: list[str]

    def to_dict(self) -> dict:
        return {"allowed": self.allowed, "reasons": list(self.reasons)}


def evaluate_deletion(
    candidate_id: str,
    records: Iterable[BackupRecord],
    *,
    environment: str,
    backup_type: str,
    now: datetime,
) -> DeletionVerdict:
    """Decide whether ONE specific backup may be deleted. Fail-closed.

    Every one of the seven owner-mandated conditions is checked independently and
    ALL failures are reported, so an operator sees the full picture rather than
    only the first problem. An expired timer alone NEVER authorises deletion.
    """
    reasons: list[str] = []
    all_records = list(records)

    # (7) the target must exist, exactly once, in the stated chain.
    matches = [
        r for r in all_records
        if r.backup_id == candidate_id
        and r.environment == environment
        and r.backup_type == backup_type
    ]
    if not matches:
        return DeletionVerdict(False, [
            f"candidate {candidate_id!r} not found in chain "
            f"({environment}, {backup_type}) — refusing to delete an unknown backup"
        ])
    if len(matches) > 1:
        return DeletionVerdict(False, [
            f"candidate {candidate_id!r} is ambiguous: {len(matches)} records match — refusing"
        ])
    candidate = matches[0]

    # Recompute the chain from scratch: never trust caller-supplied bookkeeping.
    compute_chain(all_records, environment, backup_type)
    head = newest_protected(all_records, environment, backup_type)

    # (1) never delete the current newest verified backup.
    if head is not None and head.backup_id == candidate.backup_id:
        reasons.append(
            "candidate is the current newest verified+stored backup of this chain "
            "(protected indefinitely)"
        )

    # (2) a newer verified backup must exist for the SAME environment AND type.
    successor_id = candidate.successor_backup_id
    if successor_id is None:
        reasons.append(
            "no successor backup exists for this exact (environment, backup_type) chain"
        )
        successor = None
    else:
        # (3) the successor must still be present.
        found = [r for r in all_records if r.backup_id == successor_id]
        successor = found[0] if found else None
        if successor is None:
            reasons.append(f"successor {successor_id!r} is no longer present")

    if successor is not None:
        # Defence in depth: the successor must belong to the same chain. compute_chain
        # already guarantees this, but an explicit check documents the invariant and
        # protects against a future refactor quietly breaking isolation.
        if successor.environment != candidate.environment:
            reasons.append(
                f"successor environment mismatch: {successor.environment!r} != {candidate.environment!r}"
            )
        if successor.backup_type != candidate.backup_type:
            reasons.append(
                f"successor backup_type mismatch: {successor.backup_type!r} != {candidate.backup_type!r}"
            )
        # (4) the successor must still be valid/verified.
        if not successor.is_integrity_verified():
            reasons.append(
                f"successor {successor.backup_id!r} is not INTEGRITY_VERIFIED "
                f"(is {successor.verification_status!r})"
            )
        # (5) the successor must be officially stored AND storage-verified.
        if not successor.is_storage_verified():
            reasons.append(
                f"successor {successor.backup_id!r} storage is not verified "
                f"(is {successor.storage_status!r})"
            )
        if not successor.stored_at:
            reasons.append(f"successor {successor.backup_id!r} has no stored_at timestamp")

    # (6) the retention window must actually have expired.
    if candidate.retention_expires_at is None:
        if successor_id is not None:
            reasons.append("candidate has no computed expiry — retention has not started")
    else:
        expires = parse_ts(candidate.retention_expires_at)
        if now < expires:
            reasons.append(
                f"retention window has not expired: expires {candidate.retention_expires_at}, "
                f"now {format_ts(now)}"
            )

    # Absolute floor: deletion must never empty a chain.
    survivors = [
        r for r in all_records
        if r.environment == environment
        and r.backup_type == backup_type
        and r.backup_id != candidate.backup_id
        and r.can_advance_chain()
    ]
    if not survivors:
        reasons.append(
            "deletion would leave this (environment, backup_type) chain with zero valid backups"
        )

    return DeletionVerdict(not reasons, reasons)


def plan_deletions(
    records: Iterable[BackupRecord],
    *,
    now: datetime,
    environments: Iterable[str] = ENVIRONMENTS,
    backup_types: Iterable[str] = BACKUP_TYPES,
) -> dict:
    """Produce an auditable, fail-safe deletion plan across all chains.

    Every candidate is re-validated through `evaluate_deletion`, so a bug in
    chain computation cannot by itself authorise a deletion. Output is pure data
    — the caller decides whether to act on it.
    """
    all_records = list(records)
    plan: dict = {"delete": [], "retain": [], "chains": {}}

    for environment in environments:
        for backup_type in backup_types:
            chain = compute_chain(all_records, environment, backup_type)
            if not chain:
                continue
            head = newest_protected(all_records, environment, backup_type)
            plan["chains"][f"{environment}:{backup_type}"] = {
                "count": len(chain),
                "protected_indefinitely": head.backup_id if head else None,
            }
            for record in chain:
                verdict = evaluate_deletion(
                    record.backup_id, all_records,
                    environment=environment, backup_type=backup_type, now=now,
                )
                entry = {
                    "backup_id": record.backup_id,
                    "environment": environment,
                    "backup_type": backup_type,
                    "retention_expires_at": record.retention_expires_at,
                    "successor_backup_id": record.successor_backup_id,
                }
                if verdict.allowed:
                    plan["delete"].append(entry)
                else:
                    plan["retain"].append({**entry, "reasons": verdict.reasons})
    return plan
