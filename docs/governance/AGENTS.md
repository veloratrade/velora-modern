# VELORA MODERN — Agent Operating & Governance Contract

This document defines the mandatory operating rules, evidence requirements, session bootstrap protocols, and safety constraints for all AI agents and contributors working on **Velora Modern** (`veloratrade/velora-modern`).

---

## 1. Foundational Operating Principle

> **«Read internally. Work directly in the repository. Report only concise conclusions and verifiable evidence.»**

- AI agents MUST inspect repository source code, Prisma schemas, REST routes, tests, and governance documents directly.
- AI agents MUST NOT reprint full file contents, verbose logs, or speculative code in chat responses.
- AI agents MUST back every completion claim with inspectable repository evidence (exact file path, line numbers, test results, commit SHA, remote SHA).

---

## 2. Mandatory Session Bootstrap Protocol

At the start of every session, the agent MUST execute the following read-only inspection in order:

1. Read this contract (`docs/governance/AGENTS.md`) completely.
2. Inspect `README.md` for project status, stage, and available scripts.
3. Inspect `docs/migration/ROADMAP.md` to verify the active engineering phase and 3-layer roadmap model.
4. Inspect `docs/migration/business-rules.md` for platform business rules and entitlement policies.
5. Inspect `docs/migration/capability-parity-matrix.md` for cross-platform capability migration statuses.
6. Verify local repository Git reality (`git rev-parse HEAD`, `git status`, `git remote -v`).

---

## 3. Non-Negotiable Engineering Rules

1. **Strict Read-Only Audit Mode Enforcement**: During an audit or verification task, the agent MUST NOT edit files, create files, run migrations, alter database records, or modify infrastructure.
2. **Fail-Closed Security Invariant**: Database or upstream connection failures during authentication, rate limiting, or session verification MUST fail closed in `development` and `production` environments by throwing HTTP 503 `SERVICE_UNAVAILABLE`. MemoryStore fallback is permitted ONLY when `NODE_ENV === 'test'`.
3. **Financial Precision (Scale 8)**: All gross PnL, net PnL, risk, and R-multiple calculations MUST use `Decimal.js` scale 8 arbitrary-precision decimal arithmetic. Floating-point arithmetic for financial calculations is strictly forbidden.
4. **Bilingual & Latin-Digit Invariant**: All user-facing data responses, prices, dates, volumes, and metrics across all locales (including Persian `fa`) MUST use ASCII/Latin digits (`0-9`). Eastern Arabic digits (`۰-۹`) are strictly prohibited in DTOs and API JSON responses.
5. **Brand Policy Preservation**: Product brand terms `"VELORA"` and `"MetaAPI"` MUST NOT be translated or altered in locale catalogs.
6. **Separation of Role and Subscription Plan**: User `Role` (`user`, `admin`, `super_admin`) governs authorization permissions. User `Plan` (`free`, `pro`, `enterprise`) governs resource quotas (e.g. Free = 1 Trading Account). Subscription Plan MUST NEVER elevate user permissions or grant administrative access.
7. **No Unapproved Scope Expansion**: AI agents MUST NOT introduce unapproved business features, create fake mock data, or alter database schemas outside the scope of the assigned task.
8. **Clean Working Tree & Remote Verification**: Before reporting task completion, agents MUST run code formatting (`npm run format`), linting (`npm run lint`), typechecking (`npm run typecheck`), localization checks (`npm run i18n:check`), tests (`npm run test`), create a Git commit, push to remote, and independently verify that the remote GitHub repository contains the commit SHA and published files.

---

## 4. Provenance & Traceability Matrix

| Requirement / Control | PHP Reference Evidence | Classification | Modern Target Location | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Agent Operational Directives** | `AGENTS.md` (Root) | `SHARED_ADAPTED` | `docs/governance/AGENTS.md` | `TRANSFER_COMPLETED` |
| **Silent Bootstrap Protocol** | `AGENTS.md` Section 2 | `SHARED_ADAPTED` | `docs/governance/AGENTS.md` | `TRANSFER_COMPLETED` |
| **Remote Publication Requirement** | Audit Findings | `MODERN_SPECIFIC` | `docs/governance/AGENTS.md` | `TRANSFER_COMPLETED` |

---

## 5. Operational Governance (ported behavioral contract)

The full agent behavioral contract — evidence-first reporting, no-secret-output
rule, production change control, BACKUP GATE law, GitHub cost constraints,
minimal-footprint principles, verification requirements, fail-closed behavior,
owner-approval boundaries — lives in `docs/governance/OPERATIONAL_CONTRACT.md`
and is MANDATORY for all agents and contributors. Operations handbook:
`docs/ops/README.md`. Merge expectations:
`docs/governance/MERGE_REVIEW_POLICY.md`.
