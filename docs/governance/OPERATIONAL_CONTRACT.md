# Velora Modern — Operational Behavioral Contract

Port of the PHP agent/governance behavioral contract (`AGENTS.md` §§4–10, 12–14,
`docs/06_MERGE_REVIEW_POLICY.md`) to Modern-native paths. Platform mechanics
changed; the contract did not. Anything below that names a PHP artifact does so
as a provenance pointer, not as an instruction to use it.

## 1. Evidence-first reporting (non-negotiable)

- Never claim a test passed, a gate cleared, a backup exists, or a deploy
  succeeded without executing the check and citing inspectable evidence (exact
  file path, command output, run URL, commit SHA).
- A verbal or logical statement that something "should" hold is NOT evidence.
  Only machine output validated by the responsible gate counts (PHP §14 rule,
  kept verbatim in spirit).

## 2. No-secret-output rule (non-negotiable)

- Real secret VALUES are forbidden in git, files, artifacts, logs, and chat.
  Report secret NAMES only (e.g. `RAILWAY_TOKEN`, `RESEND_API_KEY`).
- Findings, provenance records, and deployment reports must be safe to paste
  into a public log. The secret scanner (`npm run secret:scan`) enforces the
  committed side; human discipline enforces the chat side.
- If a secret value ever appears where it should not: stop, rotate it (owner),
  purge it — never forward it.

## 3. Production change control

- Production is touched ONLY through `deploy.yml` / `rollback.yml` /
  `healthcheck-production.yml` with their exact confirm phrases, or through a
  per-operation owner approval that is non-transferable (an approval for
  staging is not an approval for production; an approval for reads is not an
  approval for writes).
- Push triggers on deploy workflows are prohibited (OC-9). Manual dispatch
  only, dry-run default true, `production` GitHub environment on every
  production-touching job.

## 4. Backup-gate law (adapted, not weakened)

- No deploy or data migration proceeds without successfully created AND
  verified backup evidence, validated by `npm run backup:evidence:check`
  (contract: `BACKUP_ID`, `RELEASE_TAG`, `SHA256`, `SOURCE_COMMIT_SHA`,
  `VERIFICATION_STATUS=INTEGRITY_VERIFIED`, `ENVIRONMENT`).
- Binding (D5): evidence MUST name the deployment commit (`SOURCE_COMMIT_SHA`
  equals the deploy SHA; on production `RELEASE_TAG` equals `BACKUP_ID` in
  the production namespace). Independent store re-read stays deferred — the
  gate verifies the claim, never the store.
- There is no skip flag. The only alternative path is the empty-target
  bootstrap attestation (`EMPTY-TARGET-BOOTSTRAP`), usable ONLY against a
  target that provably holds no data, recorded loudly in the deployment
  report. Using it against a data-bearing target is a contract violation.
- Database backup EXECUTION is deferred to the final database phase; the law
  above governs evidence handling from today (see `docs/ops/BACKUP_POLICY.md`).

## 5. GitHub cost constraints

- `npm run github:cost:check` must PASS before any workflow change is merged:
  standard Linux runners only, `timeout-minutes` on every real job (≤30),
  no schedules, no `repository_dispatch`/`workflow_run`, no write permissions
  by default, artifact retention ≤14 days.
- CI minutes are a budget, not a free good: prefer fast static gates on every
  push and reserve the full battery for the release gate.
- PHP posture adaptation (explicit, D12 — NOT silently transferred): PHP
  AGENTS §10 required Actions disabled-by-default with owner-approved
  temporary windows. Modern runs CI permanently (required checks cannot
  function otherwise) and enforces the zero-cost rules on every run instead.
  This trades the default-deny posture for always-on enforcement — owner
  acknowledgment required at merge review (see MERGE_REVIEW_POLICY §5).

## 6. Minimal footprint

- Fetch/clone the minimum needed for the mission; never full-clone casually in
  automation. Clean up temp files, artifacts, and branches created during an
  operation. Report volume transparently (files/steps/retention).

## 7. Verification requirements

- Every migrated responsibility is proven by BEHAVIOR, not by file existence:
  file exists, behavior executes, validators pass, failure mode demonstrated
  (at least one negative test or a documented fail-closed reason).
- Negative space is reported: what was checked and found absent counts as a
  result, not as an omission.

## 8. Fail-closed behavior

- Unknown state blocks. Missing evidence blocks. Ambiguous environment blocks.
  A guard that cannot evaluate MUST fail, never warn-and-continue — except the
  explicitly documented warn-only cases (version drift in smoke checks), which
  exist because they detect governance findings, not outages.

## 9. Owner-approval boundaries

- The agent decides HOW (mechanism, code, commands). The owner decides WHAT
  touches production data, money, users, secrets provisioning, and external
  systems — plus all items in the decision registers. Silence is never consent.
- Database work in ANY form (schema, migration, data, backup/restore
  execution, live DB access) is out of scope until the final database phase is
  explicitly approved.

## 10. Session bootstrap (Modern adaptation of PHP §2)

1. Read `docs/governance/AGENTS.md` + this contract.
2. Run `npm run ops:status` (or `git rev-parse HEAD` + `git status` when Node is unavailable).
3. Read `docs/migration/ROADMAP.md` for the active phase.
4. Read the runbook for the operation (`docs/ops/`) BEFORE dispatching anything.
5. State the plan, the exact scope, and what will NOT be touched — then execute.

## 11. Change-report discipline

Every operation ends with: what changed (responsibility-level), verification
evidence (commands + results), what was explicitly NOT touched, and residual
risks. Concise conclusions + verifiable evidence; never full file dumps.

## 12. Deferred automation — n8n (lives here, not only in a README)

- n8n policy, archive tooling (`tools/n8n_archive/`), and migration tooling
  (`tools/n8n_migrate/`) are DEFERRED (owner decision pending). Their safety
  properties (secret guards, HMAC/read guards, archive safety, live-client
  boundaries, credential non-migration, disposable-instance policy) are
  recorded in `docs/ops/README.md` and `QUALITY_GATES.md` — summarized here
  so the deferral is contractual, not folkloric.
- No agent may connect to, migrate, or execute n8n automation until the
  owner decision lands. This section is removed only by that decision.
