#!/usr/bin/env python3
"""VELORA MODERN — operational retention executor ("the reaper").

WHY THIS MODULE EXISTS
======================
`ops/backup/retention.py` already implements the owner-approved retention law
correctly and is independently audited. What did not exist was an *executor*:
nothing read the authoritative metadata, nothing applied the law to real
backups, and nothing was scheduled. This module is that missing wiring — and
nothing more. It does not restate, extend, or reinterpret the law; every
deletion decision is delegated to `retention.evaluate_deletion`.

DESIGN RULES (non-negotiable)
=============================
1. The law lives in `retention.py`. This file may only ever make deletion
   *less* likely, never more.
2. Dry run is the default. Deletion requires an affirmative `--dry-run false`.
   An empty, missing, or unrecognised value is a DRY RUN. The negation pattern
   `not dry_run` is deliberately never used: on an absent input it evaluates
   true and would delete.
3. Environment is mandatory and explicit. There is no "all environments" mode,
   so a staging reaper can never reach production backups.
4. Fail closed. Any ambiguity — unreadable metadata, malformed timestamp,
   mismatched namespace, changed candidate — results in ZERO deletions.
5. Deletion is a tombstone, not an erasure: the release (and therefore the dump
   asset) is removed, while the secret-free metadata record is retained and
   marked, preserving the audit trail and making re-runs idempotent.

WHAT IS DELETED
===============
Only the GitHub Release (which carries the dump asset) of a backup that
`retention.evaluate_deletion` has authorised. The metadata JSON is never
removed — it is rewritten as a tombstone. Because a tombstoned record reports
`storage_status = DELETED_BY_RETENTION` (rank 0), it can never advance a chain
and can never become a successor, so the chain logic stays sound afterwards.

NEVER prints tokens, credentials, or database contents.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional, Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))

from retention import (  # noqa: E402
    BACKUP_TYPES,
    ENVIRONMENTS,
    RETENTION_DAYS,
    BackupRecord,
    evaluate_deletion,
    format_ts,
    newest_protected,
    parse_ts,
    plan_deletions,
)
from upload_backup import (  # noqa: E402
    PRIVATE_BACKUP_REPO,
    assert_metadata_has_no_secrets,
    make_metadata_path,
)

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #

#: Written into a record whose artifact retention has removed. Deliberately not
#: one of retention.py's known storage states, so `_STORAGE_RANK.get(..., 0)`
#: scores it 0 and `can_advance_chain()` is False. Verified by test.
STORAGE_DELETED = "DELETED_BY_RETENTION"

#: Release-tag namespace per backup type (mirrors upload_backup._ID_PREFIX).
_TAG_PREFIX = {"database": "db-backup", "persistent_files": "files-backup"}

_METADATA_DIR = "backups/{env}"


class ReaperError(Exception):
    """Any condition that must stop the reaper without deleting anything."""


# --------------------------------------------------------------------------- #
# Transport (narrow; the reaper never speaks HTTP itself)
# --------------------------------------------------------------------------- #

class ReaperTransport(Protocol):
    """Exactly the four capabilities retention execution needs.

    Deliberately separate from `upload_backup.StorageTransport` so that adding
    read/delete powers cannot alter the upload contract or its existing fakes.
    """

    def list_metadata(self, environment: str) -> list[str]: ...
    def get_metadata(self, path: str) -> tuple[dict, str]: ...
    def delete_release(self, tag: str) -> str: ...
    def put_metadata_if_match(self, path: str, content: bytes, message: str,
                              expected_sha: str) -> dict: ...


# --------------------------------------------------------------------------- #
# Affirmative-mode decision (Phase 8)
# --------------------------------------------------------------------------- #

def deletion_authorized(dry_run_value: object) -> bool:
    """True ONLY for the exact string 'false' (case/space tolerant).

    Everything else — None, '', 'true', 'False ', 'no', 0, a missing workflow
    input — is a dry run. This is the same fail-safe shape as the deploy
    workflow's `deploy_effective`: destructive behaviour is opt-in by
    construction rather than opt-out by negation.
    """
    if not isinstance(dry_run_value, str):
        return False
    return dry_run_value.strip().lower() == "false"


# --------------------------------------------------------------------------- #
# Metadata -> BackupRecord (fail-closed parsing)
# --------------------------------------------------------------------------- #

def _clean(value: object) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def record_from_metadata(doc: dict, *, environment: str, path: str) -> BackupRecord:
    """Build a `BackupRecord` from one authoritative metadata document.

    Raises `ReaperError` on anything ambiguous. A record that is merely OLD
    (the pre-`velora-backup/2` schema, which has no storage fields) is NOT an
    error: it parses into a record that cannot advance a chain, and is
    therefore protected forever rather than quarantined.
    """
    if not isinstance(doc, dict):
        raise ReaperError(f"{path}: metadata is not a JSON object")

    backup_id = _clean(doc.get("backup_id"))
    if not backup_id:
        raise ReaperError(f"{path}: missing backup_id")

    doc_env = _clean(doc.get("environment"))
    if not doc_env:
        raise ReaperError(f"{backup_id}: missing environment")
    if doc_env != environment:
        raise ReaperError(
            f"{backup_id}: environment mismatch — metadata says {doc_env!r} but the "
            f"record was found under {path!r}"
        )
    # Path/identity cross-check: the filename must name this backup.
    if not path.endswith(f"/{backup_id}.json"):
        raise ReaperError(f"{backup_id}: metadata path {path!r} does not match backup_id")

    backup_type = _clean(doc.get("backup_type")) or "database"
    if backup_type not in BACKUP_TYPES:
        raise ReaperError(f"{backup_id}: unknown backup_type {backup_type!r}")

    # Identity must live in the right namespace — checked, never assumed.
    expected_prefix = f"{_TAG_PREFIX[backup_type]}-{environment}-"
    if not backup_id.startswith(expected_prefix):
        raise ReaperError(
            f"{backup_id}: not in the {environment}/{backup_type} namespace "
            f"(expected prefix {expected_prefix!r})"
        )

    stored_at = _clean(doc.get("stored_at"))
    if stored_at is not None:
        try:
            parse_ts(stored_at)
        except ValueError:
            raise ReaperError(f"{backup_id}: malformed stored_at {stored_at!r}") from None

    created_at = _clean(doc.get("created_at")) or _clean(doc.get("created_at_utc")) or ""

    storage = _clean(doc.get("storage_status"))
    record = BackupRecord(
        backup_id=backup_id,
        environment=doc_env,
        backup_type=backup_type,
        source_commit_sha=_clean(doc.get("source_commit_sha")) or "",
        created_at=created_at,
        sha256=_clean(doc.get("sha256")),
        size_bytes=doc.get("size_bytes") if isinstance(doc.get("size_bytes"), int) else None,
        verification_status=_clean(doc.get("verification_status")) or "UNVERIFIED",
        storage_status=storage or "NONE",
        stored_at=stored_at,
        release_tag=_clean(doc.get("release_tag")),
        backup_repo=_clean(doc.get("backup_repo")),
    )
    return record


def fingerprint(record: BackupRecord) -> tuple:
    """Identity+state signature used to detect a candidate changing mid-run."""
    return (
        record.backup_id,
        record.sha256,
        record.stored_at,
        record.storage_status,
        record.verification_status,
        record.release_tag,
    )


# --------------------------------------------------------------------------- #
# Loading the authoritative view
# --------------------------------------------------------------------------- #

def load_chain_state(transport: ReaperTransport, environment: str) -> tuple[list[BackupRecord], list[str], dict]:
    """Read every metadata record for one environment.

    Returns (records, quarantine, raw_by_id). `quarantine` holds human-readable
    reasons for documents that could not be parsed unambiguously; any entry
    there forbids deletion for the whole run.
    """
    if environment not in ENVIRONMENTS:
        raise ReaperError(f"invalid environment {environment!r}")

    paths = transport.list_metadata(environment)
    records: list[BackupRecord] = []
    quarantine: list[str] = []
    raw_by_id: dict = {}
    seen: set = set()

    for path in sorted(paths):
        try:
            doc, blob_sha = transport.get_metadata(path)
        except Exception as exc:                      # unreadable -> quarantine
            quarantine.append(f"{path}: unreadable ({type(exc).__name__})")
            continue
        try:
            record = record_from_metadata(doc, environment=environment, path=path)
        except ReaperError as exc:
            quarantine.append(str(exc))
            continue
        if record.backup_id in seen:
            quarantine.append(f"{record.backup_id}: duplicate metadata record — ambiguous identity")
            continue
        seen.add(record.backup_id)
        records.append(record)
        raw_by_id[record.backup_id] = {"doc": doc, "sha": blob_sha, "path": path}

    return records, quarantine, raw_by_id


# --------------------------------------------------------------------------- #
# Tombstone
# --------------------------------------------------------------------------- #

def build_tombstone(doc: dict, *, successor_backup_id: Optional[str],
                    expired_at: Optional[str], now: datetime) -> bytes:
    """The metadata a deleted backup leaves behind. Secret-free by assertion."""
    updated = dict(doc)
    updated["storage_status"] = STORAGE_DELETED
    updated["retention_deleted_at"] = format_ts(now)
    updated["retention_deleted_by"] = "ops/backup/reap_retention.py"
    updated["retention_policy_days"] = RETENTION_DAYS
    updated["retention_successor_backup_id"] = successor_backup_id
    updated["retention_expired_at"] = expired_at
    updated["artifact_present"] = False
    assert_metadata_has_no_secrets(updated)
    return json.dumps(updated, indent=2, sort_keys=True).encode() + b"\n"


# --------------------------------------------------------------------------- #
# The reaper
# --------------------------------------------------------------------------- #

def reap(
    transport: ReaperTransport,
    *,
    environment: str,
    backup_type: str,
    apply_deletions: bool,
    now: Optional[datetime] = None,
) -> dict:
    """Evaluate — and, only when explicitly authorised, execute — retention.

    Returns an auditable result dict. Raises nothing for ordinary "nothing to
    do"; raises `ReaperError` only when the caller must treat the run as failed.
    """
    if environment not in ENVIRONMENTS:
        raise ReaperError(f"invalid environment {environment!r}")
    if backup_type not in BACKUP_TYPES:
        raise ReaperError(f"invalid backup_type {backup_type!r}")

    now = now or datetime.now(timezone.utc)
    records, quarantine, raw = load_chain_state(transport, environment)

    plan = plan_deletions(records, now=now, environments=[environment],
                          backup_types=[backup_type])
    head = newest_protected(records, environment, backup_type)

    result = {
        "environment": environment,
        "backup_type": backup_type,
        "mode": "APPLY" if apply_deletions else "DRY_RUN",
        "evaluated_at": format_ts(now),
        "records_seen": len(records),
        "quarantined": quarantine,
        "protected_indefinitely": head.backup_id if head else None,
        "eligible": [e["backup_id"] for e in plan["delete"]],
        "retained": len(plan["retain"]),
        "deleted": [],
        "skipped": [],
        "failures": [],
    }

    # Quarantine is absolute: ambiguity anywhere in the environment stops all
    # deletion for this run, because a record we could not read might be the
    # successor another record's protection depends on.
    if quarantine:
        result["mode"] = "DRY_RUN (forced: quarantine)"
        result["skipped"] = list(result["eligible"])
        return result

    if not apply_deletions or not plan["delete"]:
        return result

    for entry in plan["delete"]:
        candidate_id = entry["backup_id"]
        planned = next((r for r in records if r.backup_id == candidate_id), None)
        if planned is None:                      # defensive; cannot normally happen
            result["failures"].append(f"{candidate_id}: vanished from the planned set")
            break

        # --- RE-EVALUATE AGAINST LIVE STATE, immediately before deleting ---- #
        try:
            fresh_records, fresh_quarantine, fresh_raw = load_chain_state(transport, environment)
        except Exception as exc:
            result["failures"].append(f"{candidate_id}: re-read failed ({type(exc).__name__})")
            break
        if fresh_quarantine:
            result["skipped"].append(f"{candidate_id}: environment became ambiguous mid-run")
            break

        verdict = evaluate_deletion(candidate_id, fresh_records,
                                    environment=environment, backup_type=backup_type, now=now)
        if not verdict.allowed:
            result["skipped"].append(f"{candidate_id}: no longer eligible — {'; '.join(verdict.reasons)}")
            continue

        fresh = next((r for r in fresh_records if r.backup_id == candidate_id), None)
        if fresh is None or fingerprint(fresh) != fingerprint(planned):
            result["skipped"].append(f"{candidate_id}: record changed since evaluation — refusing")
            continue

        tag = fresh.release_tag or candidate_id
        expected_prefix = f"{_TAG_PREFIX[backup_type]}-{environment}-"
        if not tag.startswith(expected_prefix):
            result["skipped"].append(
                f"{candidate_id}: release tag {tag!r} is outside the {environment}/{backup_type} namespace"
            )
            continue

        meta = fresh_raw.get(candidate_id)
        if not meta:
            result["skipped"].append(f"{candidate_id}: metadata disappeared mid-run")
            continue

        # --- EXECUTE (release first, then tombstone) ------------------------ #
        try:
            outcome = transport.delete_release(tag)
        except Exception as exc:
            result["failures"].append(f"{candidate_id}: release deletion failed ({type(exc).__name__})")
            break                                  # never continue deleting after a failure

        try:
            tombstone = build_tombstone(
                meta["doc"],
                successor_backup_id=entry.get("successor_backup_id"),
                expired_at=entry.get("retention_expires_at"),
                now=now,
            )
            transport.put_metadata_if_match(
                meta["path"], tombstone,
                f"retention({environment}): tombstone {candidate_id} [skip ci]",
                meta["sha"],
            )
        except Exception as exc:
            result["failures"].append(
                f"{candidate_id}: artifact deleted ({outcome}) but tombstone write failed "
                f"({type(exc).__name__}) — metadata now overstates availability"
            )
            break

        result["deleted"].append({"backup_id": candidate_id, "release_tag": tag, "outcome": outcome})

    return result


# --------------------------------------------------------------------------- #
# Real transport — the only network-aware part
# --------------------------------------------------------------------------- #

class GitHubBackupRepoTransport:
    """Read/delete access to the existing private backup repository.

    Reuses the established credential rule (`BACKUP_REPO_TOKEN`, never
    `GITHUB_TOKEN`) and the established layout (`backups/<env>/*.json` +
    one Release per backup). No new storage provider is introduced.
    """

    API = "https://api.github.com"

    def __init__(self, repo: str = PRIVATE_BACKUP_REPO, token: Optional[str] = None):
        from upload_backup import require_backup_credential
        self.repo = repo
        self._token = token or require_backup_credential()

    def _request(self, method: str, url: str, *, data: bytes = None) -> tuple[int, bytes]:
        import urllib.error
        import urllib.request
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()[:300]
            raise ReaperError(
                f"{method} {url.split('?')[0]} -> HTTP {exc.code}: {body!r}"
            ) from None

    def list_metadata(self, environment: str) -> list[str]:
        directory = _METADATA_DIR.format(env=environment)
        try:
            _, body = self._request("GET", f"{self.API}/repos/{self.repo}/contents/{directory}")
        except ReaperError as exc:
            if "HTTP 404" in str(exc):
                return []                          # no backups yet for this env
            raise
        listing = json.loads(body)
        return [f["path"] for f in listing
                if f.get("type") == "file" and f.get("name", "").endswith(".json")]

    def get_metadata(self, path: str) -> tuple[dict, str]:
        import base64
        _, body = self._request("GET", f"{self.API}/repos/{self.repo}/contents/{path}")
        payload = json.loads(body)
        content = base64.b64decode(payload["content"])
        return json.loads(content), payload["sha"]

    def delete_release(self, tag: str) -> str:
        """Delete the release carrying the dump. Idempotent: already-gone is OK."""
        import urllib.parse
        try:
            _, body = self._request(
                "GET", f"{self.API}/repos/{self.repo}/releases/tags/{urllib.parse.quote(tag)}")
        except ReaperError as exc:
            if "HTTP 404" in str(exc):
                return "already-absent"
            raise
        release_id = json.loads(body)["id"]
        self._request("DELETE", f"{self.API}/repos/{self.repo}/releases/{release_id}")
        return "deleted"

    def put_metadata_if_match(self, path: str, content: bytes, message: str,
                              expected_sha: str) -> dict:
        """Conditional write: fails if another run changed the record first."""
        import base64
        payload = json.dumps({
            "message": message,
            "content": base64.b64encode(content).decode(),
            "sha": expected_sha,
        }).encode()
        _, resp = self._request("PUT", f"{self.API}/repos/{self.repo}/contents/{path}", data=payload)
        return json.loads(resp)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    parser = argparse.ArgumentParser(
        description="Apply the owner-approved backup retention law. Dry run by default.")
    parser.add_argument("--environment", required=True, choices=list(ENVIRONMENTS),
                        help="MANDATORY. There is no 'all environments' mode.")
    parser.add_argument("--backup-type", required=True, choices=list(BACKUP_TYPES))
    parser.add_argument("--dry-run", default="true",
                        help="Deletion happens ONLY for the exact value 'false'.")
    args = parser.parse_args(argv[1:])

    apply_deletions = deletion_authorized(args.dry_run)

    try:
        transport = GitHubBackupRepoTransport()
        result = reap(transport, environment=args.environment,
                      backup_type=args.backup_type, apply_deletions=apply_deletions)
    except ReaperError as exc:
        print(f"::error::retention stopped safely, nothing deleted: {exc}", flush=True)
        return 1

    print(json.dumps(result, indent=2, sort_keys=True))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"## Backup retention — {result['environment']}/{result['backup_type']}\n\n")
            fh.write(f"- mode: `{result['mode']}`\n")
            fh.write(f"- records seen: {result['records_seen']}\n")
            fh.write(f"- protected indefinitely: `{result['protected_indefinitely']}`\n")
            fh.write(f"- eligible for deletion: {len(result['eligible'])}\n")
            fh.write(f"- deleted: {len(result['deleted'])}\n")
            if result["quarantined"]:
                fh.write(f"- **quarantined (deletion disabled): {len(result['quarantined'])}**\n")

    if result["quarantined"]:
        print("::error::metadata quarantine — deletion disabled for this run", flush=True)
        return 1
    if result["failures"]:
        for failure in result["failures"]:
            print(f"::error::{failure}", flush=True)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
