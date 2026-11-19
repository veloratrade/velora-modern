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

Index refreshed 2026-10-08: ADR-018 was present as a file but missing from this
table (a documentation-consistency defect under `MG-G12`); it is now listed, and
ADR-019 takes the next free number. **ADR-020 is the next free number.**
| ADR-016 | `ADR-016-credential-encryption-key-management.md` | Credential encryption & key management | Accepted 2026-09-15 (D-18) |
| ADR-017 | `ADR-017-agent-context-system.md` | Agent Context System (persistent project state) | Accepted 2026-09-26 (owner instruction) |

| ADR-018 | `ADR-018-telegram-journal-client.md` | Telegram journal client (external identity + shared journal domain) | Accepted 2026-10-03 (**added to this index 2026-10-08** — the ADR existed but was never listed) |
| ADR-019 | `ADR-019-telegram-update-job-architecture.md` | Telegram update processing over the job architecture (`telegram.update` → pg-boss → worker) | Architecture accepted; repository path/test record at `e041856`; **worker deployment and live round trip deployment-gated**; exact second-process secret allowlist remains an owner decision (D-2) |
| ADR-020 | `ADR-020-dashboard-strategies-widget.md` | Dashboard strategies widget — port as-is, no invented strategy semantics (W0 decision R9 = A) | Accepted 2026-11-18 (owner); blocks W2 A5 + B10 |
| ADR-021 | `ADR-021-public-vs-protected-routes.md` | Public vs protected public surfaces — `/markets`/`/news` public, `/support` behind login (W0 decision R8 = C) | Accepted 2026-11-18 (owner); blocks W7 public surfaces + edge gate |
| ADR-022 | `ADR-022-subscription-status-vocabulary.md` | Subscription status vocabulary mapping — provider-agnostic model, keep history (W0 decision OD-AC-SUBMAP = A) | Accepted 2026-11-18 (owner); blocks W1 A3 subscription POST |
| ADR-023 | `ADR-023-admin-user-create-invitations.md` | Admin user creation + invitations — both, 7-day TTL, admin & super_admin invite (W0 decision user create/invite = A) | Accepted 2026-11-18 (owner); blocks W1 A1 + A2 + 4 RBAC |
| ADR-024 | `ADR-024-canonical-staging-origin.md` | Canonical staging origin — OD-1 = `https://staging.veloratrade.ir` (candidate only, not prod) (W5 ops setup) | Proposed — owner decision required (OD-1) |

**ADR-004 amendment:** `ADR-004-time-model.md` carries Amendment A-3 (2026-11-18) — owner confirms sampling-first for naive datetimes, Asia/Tehran standby (W0 decision ADR-004 = C); blocks W6 data migration (MG-G10, MG-DATA-MIGRATION).

Note: the **legacy** repository has its own, unrelated `ADR-014` (census-probe
transport); modern ADR numbering is independent of legacy numbering
(`docs/provenance/REMOTE_LINEAGE.md`). ADR-025 is the next free number.
