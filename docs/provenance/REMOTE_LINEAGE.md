# Remote Lineage Provenance Manifest

**Purpose:** preserve the Remote (pushed) `veloratrade/velora-modern` lineage inside this repository as **read-only provenance** for the Foundation-First Hybrid reconciliation, per owner decision **OD-2** (approved 2026-09-12; `docs/reconciliation/RECONCILIATION_DECISIONS.md`). The tag **references** the fetched history — it does not merge, import, or copy it. The Local lineage remains the **single authoritative application tree**.

## Snapshot record (all fields VERIFIED FACT, 2026-09-12)

| Field | Value |
|---|---|
| Remote repository | `https://github.com/Veloratrade/velora-modern.git` (public) |
| Remote branch | `main` |
| Exact remote SHA (pinned) | `99e024c829db1a9be0980d8eaf8272927aa0d25d` |
| Commit subject at pin | `chore(ops): update structure baseline for docs ops` |
| Tree hash at pin | `83621817ee8667ac4d1ceef037458946f52ae96d` |
| Fetch date/time (UTC) | `2026-09-12T16:27:12Z` |
| Annotated tag name | `remote-snapshot-99e024c829db` |
| Tagged SHA (verified) | `99e024c829db1a9be0980d8eaf8272927aa0d25d` (tag object type: `tag`; resolves to this commit) |
| Lineage size | 25 commits, `2026-09-10 13:12:31 +0000` (`7eb200b`) → `2026-09-11 23:03:43 +0000` (`99e024c`) |
| Author identities | Velora Agent ×18 · Velora Bot ×5 · arena-agent ×2 (agent identities; no human commits) |
| Relationship to Local foundation | **Unrelated histories** — `git merge-base` between Local `main` (`07977504c346034a3be402a67c3c0106eb6d8242`, 2026-09-12) and the pinned Remote SHA: none. Remote is treated as product/business-logic lineage to be ported selectively (OD-1); Local remains the architectural foundation and the only application tree. |
| Remote state at fetch | GitHub API (live check, 2026-09-12): `main` @ `99e024c…` — the pin equals the remote HEAD at fetch time; branches = [`main`] only. |

## Verification evidence (executed 2026-09-12, this session)

1. `git rev-parse remote-snapshot-99e024c829db^{commit}` → `99e024c829db1a9be0980d8eaf8272927aa0d25d` — tag points at the exact pinned commit. **PASS**
2. `git cat-file -t 99e024c…` → `commit`; snapshot retrievable from the local Git object database. **PASS**
3. `git cat-file -t remote-snapshot-99e024c829db` → `tag` (annotated, with tagger + message). **PASS**
4. No `reference/remote-import/` tree, no duplicate Remote application tree exists — `git ls-files` (this branch) contains no Remote paths; the only tree changes vs `main` are the governance/provenance documents listed in the A-Preparation commit. **PASS**
5. Local application tree remains authoritative: `apps/`, `packages/`, `db/`, `parity/`, `infra/`, `tools/` are byte-identical to Local `main` (`git diff main --stat` = documentation files only). **PASS**
6. No history rewrite, rebase, reset, merge, or force-push performed; Local `main` still at `0797750`; branch `reconcile/foundation-first` created from it; nothing pushed. **PASS**

## Usage rules (binding until owner changes them)

- Porting work reads Remote source via `git show remote-snapshot-99e024c829db:<path>`, `git diff`, or a **temporary** `git worktree` that is never committed and is removed after use.
- This tag is not a merge candidate; promotion of the hybrid trunk to GitHub `main` follows OD-10 (branch + owner-reviewed PR/fast-forward; never reset/rewrite/force-push).
- If the GitHub remote advances beyond the pin, drift is recorded in the capability-registry drift log and re-audited; the pin itself is immutable provenance.
