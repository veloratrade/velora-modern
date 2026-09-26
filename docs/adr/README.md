# docs/adr/ — Architecture Decision Records

Index and numbering register (created 2026-09-26 per audit §16.1 / MG-DOC-6 —
the numbering gap is now documented at the directory level; statuses per
`AGENTS.md` artifact map and `docs/phase-0-exit-criteria.md`).

| ADR | File | Subject | Status |
|---|---|---|---|
| ADR-001 | `ADR-001-money-math.md` | Money math (decimal, half-even; golden vectors) | Accepted 2026-08-29 (D-03) |
| ADR-002 | `ADR-002-trade-ledger.md` | Immutable trade ledger (Option B) | Accepted 2026-08-29 (D-01) |
| ADR-003 | `ADR-003-identity-canonicalization.md` | Email canonicalization (policy a) | Accepted 2026-08-29 (D-02) |
| ADR-004 | `ADR-004-time-model.md` | Time model (timestamptz/UTC, dual instants) | Accepted 2026-08-29 (D-11; open sub-item: legacy-TZ sampling) |
| ADR-005 | `ADR-005-auth-migration.md` | Auth migration (Argon2id, bcrypt `$2y$` proof gate) | Accepted 2026-08-29 (D-04) |
| ADR-006 | `ADR-006-contract-tiering.md` | Contract tiering (frozen external list) | Accepted 2026-08-29 (D-12) |
| ADR-007 | `ADR-007-job-semantics.md` | Job semantics (pg-boss) | Accepted 2026-08-29 (D-13) |
| ADR-008 | `ADR-008-webhook-ingestion.md` | Webhook ingestion (±5 min tolerance) | Accepted 2026-08-29 (D-05) |
| ADR-009 | `ADR-009-seo-locale-contract.md` | SEO/locale contract | Accepted 2026-08-29 (D-14; open sub-item: hreflang verification) |
| ADR-010 | `ADR-010-delivery-repository.md` | Delivery/repository (monorepo, images, roles) | Accepted 2026-08-29 (D-15; ownership model amended 2026-09-13) |
| ADR-011 | `ADR-011-phase1-implementation-record.md` | Phase-1 implementation record | Accepted (D-10 record, 2026-08-31) |
| ADR-012 | `ADR-012-backup-gate-law.md` | Backup-gate law (fail-closed) | Accepted 2026-09-12 (D-16) |
| ADR-013 | `ADR-013-environment-origin-safety.md` | Environment-origin safety | Accepted 2026-09-12 (D-17) |
| ADR-014 | `ADR-014-metaapi-platform-token.md` | MetaAPI platform token (distinct secret class) | Accepted 2026-09-15 (D-19) |
| **ADR-015** | — | **never assigned — intentionally unassigned; no ADR-015 exists and no document references one** (audit §16.1; recorded here 2026-09-26). Do not "fill" the number artificially; next ADR takes the next free number. | n/a |
| ADR-016 | `ADR-016-credential-encryption-key-management.md` | Credential encryption & key management | Accepted 2026-09-15 (D-18) |
| ADR-017 | `ADR-017-agent-context-system.md` | Agent Context System (persistent project state) | Accepted 2026-09-26 (owner instruction) |

Note: the **legacy** repository has its own, unrelated `ADR-014` (census-probe
transport); modern ADR numbering is independent of legacy numbering
(`docs/provenance/REMOTE_LINEAGE.md`).
