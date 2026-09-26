# VELORA-MODERN — Migration Gap Register (Canonical)

**System:** Agent Context System (ADR-017) · **Created:** 2026-09-26
**Source of truth for gap content:** the immutable audit
`docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md` (§ references below point into it).
**Machine-readable twin:** `docs/state/migration-gap-register.json` (kept in sync in the same change).
**Mode:** TRACKING ONLY — this register records gaps and evidence; it fixes nothing.

## Vocabulary

- **Status:** `OPEN` (work remains) · `PARTIAL` (exists with material divergence) · `CLOSED` (verified complete, evidence linked).
- **Verification state** (CURRENT_STATE.md §3): `STATIC` · `RECORDED_RUNTIME` · `CURRENT_RUNTIME_VERIFIED` · `NOT_VERIFIED` · `OWNER_DECISION_REQUIRED`.
- A gap may only move to `CLOSED` with evidence captured against the current verified tree (AGENTS.md rule 10 applies to `CLOSED` exactly as it does to `SYNCED`).
- Priority: **P1** = blocks closure and corrupts correctness/operations · **P2** = blocks closure · **P3** = quality/debt.

---

## §A — Closure gates (audit §19.1; score line: 0 PASS · 1 PARTIAL · 14 FAIL)

| ID | Gate (abbreviated) | Audit verdict | Status | Verification | Closure requires |
|---|---|---|---|---|---|
| MG-G01 | Every legacy capability ported or owner-approved drop | FAIL | OPEN | STATIC | 76 missing routes (§4.2) ported or owner-dropped with recorded decisions |
| MG-G02 | API contracts match (method/path/status/semantics) | FAIL | PARTIAL | STATIC | Resolve §4.3 divergences (MG-API-CONTRACT-DIVERGENCE) |
| MG-G03 | Data model covers every legacy table/column with explicit mapping | FAIL | PARTIAL | STATIC | MG-SCHEMA-MAPPING closed |
| MG-G04 | Financial calculations identical for identical inputs | FAIL | PARTIAL | STATIC | MG-METAAPI-ASSEMBLY + MG-RMULTIPLE-SCALE closed |
| MG-G05 | Frontend surfaces for every legacy route | FAIL | PARTIAL | STATIC | MG-FRONTEND-SURFACES closed |
| MG-G06 | Authorization boundaries reproduced (incl. edge gating) | FAIL | PARTIAL | STATIC | MG-SEC-EDGE-AUTHZ resolved + R8 decided |
| MG-G07 | Security posture ≥ legacy on every control | FAIL | PARTIAL | STATIC | S1/S2/S4 regressions resolved (§10.2) |
| MG-G08 | Integrations behave equivalently | PARTIAL | PARTIAL | STATIC | MetaAPI assembly + cadence; Resend email types |
| MG-G09 | Background/cron work deployed and proven | FAIL | OPEN | STATIC (absence) + NOT_VERIFIED (runtime) | MG-WORKER-DEPLOY closed with runtime evidence |
| MG-G10 | Data migration rehearsed and validated end-to-end | FAIL | OPEN | NOT_VERIFIED | ADR-004 sampling decided + rehearsal executed |
| MG-G11 | Test suite covers migrated surface and passes | PARTIAL | PARTIAL | RECORDED_RUNTIME (804/804 @ `ffcb0e9`, 2026-09-24) | Coverage extends as capabilities land; re-run on current tree |
| MG-G12 | Documentation and ADRs current/complete/consistent | FAIL | OPEN | STATIC | MG-DOC-1…5 closed |
| MG-G13 | Operational tooling, backup and restore proven | FAIL | OPEN | NOT_VERIFIED | MG-BACKUP-RESTORE closed (mechanism ≠ backup ≠ restore) |
| MG-G14 | Deployment path complete for every runtime component | FAIL | OPEN | STATIC | Worker service defined; digests pinned; R2 wired; host exists |
| MG-G15 | Every remaining gap closed or owner-accepted in writing | FAIL | OPEN | STATIC | The 9 decisions in §C resolved with recorded owner sign-off |

## §B — Open and partial gaps (detail)

| ID | Gap | Priority | Status | Verification | Evidence (audit § + repo paths) | Related |
|---|---|---|---|---|---|---|
| MG-METAAPI-ASSEMBLY | MetaAPI sync creates **one trade per OUT fill** with `entry_price = exit_price`, volume = OUT fill volume, `contract_size` hardcoded 1, single timestamp; `ON CONFLICT DO NOTHING` never corrects. Legacy assembles per-position, volume-weighted, earliest-IN/latest-OUT | **P1** | OPEN | STATIC | §9.2; `apps/api/src/metaapi/` (`syncRepository.ts` importBatch); legacy `MetaApiDealAssembler::assemble()` | MG-G01, G04, G08; OD-M D-4 |
| MG-WORKER-DEPLOY | Worker absent from `railway.json` (single API service); compose is dev/staging-only; no scheduled job has ever run in a deployed environment | **P1** | OPEN | STATIC (absence) + NOT_VERIFIED (runtime) | §13.2; `railway.json`; `apps/worker/src/index.ts`; `infra/docker-compose.yml` | MG-G09, G14; owner decision: worker service definition |
| MG-SEC-COOKIE | Refresh cookie lost `__Host-` prefix, SameSite Strict→Lax, token accepted from request body (S1, HIGH) | **P1** | OPEN | STATIC | §10.2 S1; `apps/api/src/kernel/server.ts:421` | MG-G07 |
| MG-SEC-CSP | CSP release pinning/manifest lost; `Math.random()` nonce fallback (S2, HIGH) | **P1** | OPEN | STATIC | §10.2 S2; `apps/web/src/proxy.ts` | MG-G07; owner decision: pinning model |
| MG-SEC-HSTS | HSTS absent from proxy by design; must be confirmed at the edge (S4, MEDIUM) | P2 | OPEN | NOT_VERIFIED | §10.2 S4 | MG-G07 |
| MG-SEC-EDGE-AUTHZ | Legacy's 11 server-gated HTML routes have no modern edge equivalent; client-side gating only (S5, HIGH; unauthenticated `/dashboard` behavior NOT VERIFIED) | **P1** | OPEN | STATIC (boundary absent) + NOT_VERIFIED (behavior) | §10.2 S5; `apps/web/src/proxy.ts`; legacy `locale-router.php:193-221` | MG-G06; R8 |
| MG-ADMIN | Admin console 93% absent: 59 of 62 admin endpoints, 334 KB console, 38 modules | **P1** | OPEN | STATIC | §4.2, §6.2; `apps/web/src/app/(app)/admin` (GAP shell) | MG-G01, G05; MG-RBAC-VOCAB |
| MG-AI-OCR | AI layer is a provider boundary only: no live provider, no OCR/Tesseract, no screenshot extraction, no quota/retention/audit, 8 of 9 `ai_*` tables missing (~4,301 legacy lines) | **P1** | OPEN | STATIC | §12.5, §4.2, §8.1; `apps/api/src/aicoach/` (655 lines) | MG-G01, G08 |
| MG-BACKUP-RESTORE | No real backup ever taken; no restore drill ever run (Gate 3B rows 7/8 NOT VALIDATED) | **P1** | OPEN | NOT_VERIFIED | §17.2; `infra/backup/DR-RUNBOOK.md`; `ops/backup/` | MG-G13; RPO/RTO decision |
| MG-API-MISSING-ROUTES | 76 of 103 legacy routes have no modern counterpart (59 admin, 5 support, 3 dashboard, 3 AI, 2 accounts-sync, 1 each content-translation/trades/auth-alias/webhook) | P2 | OPEN | STATIC | §4.2 | MG-G01 |
| MG-API-CONTRACT-DIVERGENCE | Shared-route divergences: `POST→PATCH` (admin status/role); `symbol` exact→LIKE; `from` close→open; `q` strategy_tag→strategy; default sort close→open; `PUT /trades/{id}` financial 403; `r_multiple` scale 4→8 | P2 | PARTIAL | STATIC | §4.3, §9.1 | MG-G02, G04; R1 |
| MG-SCHEMA-MAPPING | 8+ legacy tables with no modern target (`ai_*` ×8, `support_tickets/messages`, `email_notifications`, `auth_events`, `user_achievements`, `content_translations`, `system_logs`, `integration_health`); `users` subscription/locale columns unmapped; subscription status vocabulary differs (`grace`/`expired` lost) | P2 | PARTIAL | STATIC | §8.1, §14 | MG-G03, G10; subscription-mapping decision |
| MG-FRONTEND-SURFACES | Missing surfaces: dashboard (product), performance, wallet, intelligence, support, admin console, blog (5×2 articles), privacy, terms, checkout | P2 | PARTIAL | STATIC | §6.1, §6.2 | MG-G05; R8 |
| MG-I18N-COVERAGE | 697 of 1,765 catalog keys migrated (39.5%); missing chunks: admin (457), blog (144), trades (127), privacy (96), terms (55), support (38), profile (37), checkout (27), intelligence (30), dashboard (62), markets (14), news (19), performance (11), wallet (12) | P2 | PARTIAL | STATIC | §7.1 | MG-G05 |
| MG-EMAIL-TYPES | 2 of 10 transactional email types; no HTML templates/CID icons; no locale-aware copy; no `email_notifications` delivery log | P2 | PARTIAL | STATIC | §12.3 | MG-G08 |
| MG-RBAC-VOCAB | 6 of 24 legacy permissions enforced; 18 have no enforcement point (operations do not exist); `guest` role dropped | P2 | PARTIAL | STATIC | §11.3; `packages/contracts/src/rbac.ts` | MG-ADMIN |
| MG-AUTH-EVENTS | No `auth_events` / login-history recording; anti-enumeration NULL-user events lost; admin security surfaces have no data source | P2 | OPEN | STATIC | §11.5 | MG-ADMIN |
| MG-METAAPI-CADENCE | Sync safety net 60× less frequent (hourly pg-boss cron vs per-minute worker); manual sync trigger `POST /accounts/{id}/sync` missing | P2 | PARTIAL | STATIC | §12.1, §4.2 | MG-G08 |
| MG-RMULTIPLE-SCALE | `r_multiple` scale 4 (legacy) vs 8 (modern) — different stored strings for identical inputs; affects every row at migration | P2 | OPEN | STATIC | §9.1 | MG-G04; MG-SCHEMA-MAPPING |
| MG-RANGE-GUARD | No runtime `assertFits` equivalent for PnL range guards | P3 | OPEN | STATIC | §9.1 | — |
| MG-DOMAIN-LEGACY-ONLY | `JalaliCalendar`, `TradingSessionEngine`, achievements engine have no modern counterpart | P3 | OPEN | STATIC | §9.3 | MG-G01 |
| MG-OPS-TOOLING | Legacy probe/monitoring toolset (`ops/velora-mgmt/probe/*`, `velora-status.sh`, structure/URL/cost guards) has no modern counterpart | P3 | OPEN | STATIC | §17.1 | MG-G13 |
| MG-DATA-MIGRATION | ADR-004 naive-datetime interpretation blocked on owner-confirmed sampling; no cutover rehearsal (no PG environment); tables-without-target = data loss unless archived | **P1** | OPEN | NOT_VERIFIED | §14 | MG-G10; ADR-004 |

## §C — Open owner decisions (audit §18/§19.1 gate 15 — none carries a recorded resolution)

| ID | Decision | Audit source | Blocks |
|---|---|---|---|
| OD-AC-R1 | Password policy at login (8–9-char legacy users rejected) — accept-any / forced-reset | §11.4 | MG-G02 |
| OD-AC-R2 | `trustedProxyCidrs` wiring (site-wide IP bucket behind proxy) | §10.2 S12 | MG-G14 |
| OD-AC-R8 | `/markets`, `/news`, `/support` public (contract) vs protected (legacy) | §10.2 S6 | MG-G06 |
| OD-AC-R9 | Strategy winRate/order/untagged semantics | §9.3 | MG-G02 |
| OD-AC-OD1 | Canonical staging origin ratification (ADR-013) | §18 | MG-G14 |
| OD-AC-ADR004 | Naive `datetime` sampling procedure (legacy TZ) | §14 | MG-G10 |
| OD-AC-RPORTO | RPO/RTO targets | §17.2 | MG-G13 |
| OD-AC-SUBMAP | Subscription status vocabulary mapping (`grace`/`expired`) | §8.1 | MG-G03, G10 |
| OD-AC-WORKER | Worker service definition in `railway.json` | §13.2 | MG-G09, G14 |

*(IDs prefixed `OD-AC-` to avoid colliding with existing D-*/OD-*/R-* namespaces; each row references its original identifier.)*

## §D — Verified complete (do not re-litigate without new evidence)

From audit §18 (`COMPLETE` ×31) and §19.2. Verification states reflect the audit baseline `ffcb0e9`/`edede31`; the tool governs whether they remain current.

| Area | Claim | Verification |
|---|---|---|
| Money math | Decimal-exact, typed scales, no float path (ADR-001) | STATIC (§9.1) |
| Trade ledger | Append-only, version CAS, tombstones, allocation guard (ADR-002) | STATIC (§9.3) |
| Auth/session | Register/login/refresh/logout/verify/forgot/reset; session store + atomic rotation; rate limits C-14 exact | STATIC (§4.3, §11) + RECORDED_RUNTIME (804/804) |
| Credentials | AES-256-GCM envelope, fail-closed key management (ADR-016), 3-step connect | STATIC (§10.1, §12.1) |
| Webhooks | HMAC verified, durable raw archive + dedupe (0008) | STATIC (§10.1) |
| DB roles | `velora_owner`/`velora_migrator`/`app_readwrite`, append-only REVOKEs | STATIC (§10.1) |
| Security headers | nosniff/DENY/Referrer-Policy/Permissions-Policy/COOP; CORS; nonce CSP (modulo S2) | STATIC (§10.1) |
| Landing page | Catalogs byte-identical; Playwright pixel-equivalence 1440/390; 110/110 closure checks; 0 CSP violations | RECORDED_RUNTIME (2026-09-24 reports) |
| i18n migrated set | fa↔en parity perfect for all migrated chunks; locale mechanics, RTL/LTR, Latin digits, brand terms | STATIC (§7) |
| Local battery | 804/804, `next build` 35 routes, secret-scan 0 findings @ `ffcb0e9` | RECORDED_RUNTIME (2026-09-24) |
| Backup-gate law | ADR-012 + `ops/backup/` adopted verbatim + extended | STATIC (§17.2 — mechanism only) |
| Stripe billing | `MODERN-ONLY` roadmap v1.0 capability; signature verification present (prices NOT VERIFIED) | STATIC (§12.2) |
| Queue mechanism | pg-boss v10, policies, outbox, DLQ (runtime NOT VERIFIED — worker undeployed) | STATIC (§12.4) |

## §E — Documentation defects, contradictions and observations (recorded, NOT fixed here)

| ID | Item | Source | Status |
|---|---|---|---|
| MG-DOC-1 | `README.md` claims "No application code exists" (267 TS files exist; merged 2026-09-24) | audit §16.3 D1 | OPEN |
| MG-DOC-2 | `README.md` understates ADR count ("all ten" vs 15) | audit §16.3 D2 | OPEN |
| MG-DOC-3 | `MASTER_ROADMAP.md` stale vs `main` (W1–W5 marked PLANNED, landed at `ffcb0e9`) **and** conflicts with the audit (ACCT-02/AI-01/ADMIN-01 marked `COMPLETED (backend)`; audit: MetaAPI assembly blocker, AI seam-only, admin 93% absent). Per owner instruction 2026-09-26: recorded for later reconciliation — the roadmap is NOT edited to hide this | audit §16.3 D3 + §4.2/§9.2/§12.5 | OPEN |
| MG-DOC-4 | `attachmentService.ts:20` cites non-existent legacy `ScreenshotController.php` | audit §16.3 D4 | OPEN |
| MG-DOC-5 | Three frontend reports coexist, none marked superseded | audit §16.3 D5 | OPEN |
| MG-DOC-6 | ADR-015 numbering gap | audit §16.1 | OPEN |
| MG-OBS-1 | Audit-internal discrepancy: §19.1 table marks gates 8 **and** 11 PARTIAL while the §19.1 score line and §2 summary state "1 PARTIAL, 14 FAIL". The immutable audit is stored as-is; this register tracks gates per-row (13 FAIL + 2 PARTIAL rows) and the headline per the audit's own score line. If the split ever matters to a decision, the owner must rule which reading is authoritative | inspection 2026-09-26 | OWNER_DECISION_REQUIRED (only if the split becomes decision-relevant) |
| MG-OBS-2 | Provenance tag `remote-snapshot-99e024c829db` (OD-2, `docs/provenance/REMOTE_LINEAGE.md`) was never pushed — remote has zero tags; pinned commit remains reachable via `backup/main-before-migration-promotion-99e024c8` branch | inspection 2026-09-26 | OPEN |
| MG-OBS-3 | Older authoritative session artifacts (2026-09-12 Reconciliation Gate Report, 2026-09-15 MetaAPI Readiness Audit) are referenced by committed records but were never committed themselves. The 2026-09-25 audit is now preserved (`docs/audits/`); the older two remain absent — accepted historical limitation unless the owner orders recovery | inspection 2026-09-26 | OPEN (accept-or-recover decision) |
| MG-OBS-4 | `AGENTS.md` artifact map was missing `MASTER_ROADMAP.md` and 2026-09-16+ evidence (fixed by the ADR-017 introducing commit, CHANGE_LOG AC-1) | inspection 2026-09-26 | CLOSED (this change) |

## Update rules

1. Closing a gap requires: evidence captured against the current verified tree, a CHANGE_LOG entry, and (where AGENTS.md rule 10 applies) human sign-off recorded here.
2. New gaps discovered later get new `MG-*` IDs; IDs are never reused or renumbered.
3. Contradictions between status documents are recorded in §E — never resolved by silently editing either document.
4. This register never asserts `CLOSED`/`CURRENT_RUNTIME_VERIFIED` without linked evidence (AGENTS.md rule 15).
