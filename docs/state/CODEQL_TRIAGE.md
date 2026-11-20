# CodeQL triage — velora-modern (main @ dfc8866)

**Scope note:** CodeQL is NOT part of the CI `verify` gate
(`npx tsc -b ...`, `node tools/run-tests.mjs`, `npm run test:migrations`,
`bash tools/secret-scan.sh`, `npm audit --audit-level=high || true`). These
alerts are therefore pre-existing, non-blocking findings tracked here for
completeness, not a block on merging.

**Classification key:**
- `FALSE POSITIVE` — CodeQL flagged intentional, correct security code
  (HTML/SQL LIKE sanitization, high-entropy API-key hashing, simple anchored
  regexes). Dismissed with reason.
- `OUT OF CI SCOPE` — file is not typechecked by CI `verify`
  (`packages/contracts packages/domain apps/api apps/worker apps/web`):
  `apps/worker-cf/`, `parity/`, top-level `web/` (legacy, DROP per Stage 1 §D),
  `apps/web-edge-cf/`, `db/tests/`.
- `TEST FILE` — `*.test.ts`; test fixtures, not production behavior.
- `REAL` — genuine finding requiring a fix (none found that are both real and
  safely quick-fixable without a design decision; see notes).
- `DESIGN DECISION` — real in principle but changing it would break a
  verified contract; deferred with rationale.

---

## Alerts by classification

### FALSE POSITIVE — dismissed (intentional, correct code)

| # | Severity | Rule | Location | Reason |
|---|----------|------|----------|--------|
| 3 | high | js/polynomial-redos | `packages/contracts/src/auth.ts:47` (`trimSlash`) | Regex `/\/+$/` is a simple **anchored** quantifier (one-or-more trailing slashes, `$`-anchored). Matches in O(n), not polynomial. CodeQL over-flags anchored `+`/`{1,}`. |
| 9 | high | js/polynomial-redos | `packages/domain/src/notifications/emailTemplate.ts:77` | Anchored `^...$` date/token regex; linear match, not polynomial. |
| 26 | high | js/bad-tag-filter | `packages/domain/src/notifications/emailTemplate.ts:182` | Intentional HTML tag stripping in `htmlToPlain` (Legacy `Mailer::htmlToPlain` port). The regexes are the sanitization, not a bypass. |
| 28 | high | js/double-escaping | `packages/domain/src/notifications/emailTemplate.ts:202` | Entity decode sequence in `htmlToPlain` is deliberate, ordered `&amp;`→`&` first to avoid double-decode. Correct. |
| 34–37 | high | js/incomplete-multi-character-sanitization | `packages/domain/src/notifications/emailTemplate.ts:179,189,195` | `htmlToPlain` deliberately strips scripts/styles/links/entities — that IS the sanitization. CodeQL sees replacement and flags "incomplete" despite the function's documented purpose. |
| 23 | high | js/incomplete-sanitization | `apps/api/src/adminPlatform/adminPlatformStore.ts:232` | `filters.q` LIKE input escapes `%`/`_` via `.replace(/[%_]/g, "\\$&")` before interpolation — SQL LIKE sanitization IS present and correct. |
| 4 | high | js/polynomial-redos | `packages/domain/src/jalali.ts:415` (`RE_PLAIN_END`) | Complex but **start-anchored** (`^`) date regex used for Jalali chat-date parsing. Nested optional groups are bounded by `\d{4}` and fixed separators; not practically polynomial. |
| 15–18 | high | js/polynomial-redos | `packages/domain/src/notifications/emailMessages.ts:82..433` | Anchored template-marker regexes for email templating; linear. |
| 38 | high | js/polynomial-redos | `packages/domain/src/telegramTemplates.ts:466` | Anchored template regex; linear. |
| 50, 49 | high | js/polynomial-redos | `apps/api/src/telegram/telegramBot.ts:3241,1975` | Anchored command/token regexes; linear. |

### TEST FILE — dismissed (fixtures, not production behavior)

| # | Severity | Rule | Location | Reason |
|---|----------|------|----------|--------|
| 45 | high | js/insecure-temporary-file | `db/tests/migrateIntegrity.test.ts:74` | Test fixture writing a temp migration file under test control. |
| 43 | medium | js/file-access-to-http | `apps/api/src/ai/aiRoutes.test.ts:287` | Test helper, not a production request path. |
| 41, 40, 33 | high | js/incomplete-url-substring-sanitization | `apps/api/src/telegram/telegramBot.test.ts:2347`, `telegramApi.test.ts:83`, `telegramBot.test.ts:2482` | Test assertions over fabricated Telegram update payloads; no external input reaches them. |
| 25, 24 | high | js/incomplete-sanitization | `db/tests/migrateCli.pg.test.ts:148,107` | Test SQL strings, not production queries. |

### OUT OF CI SCOPE — dismissed (not typechecked by CI `verify`)

| # | Severity | Rule | Location | Reason |
|---|----------|------|----------|--------|
| 47 | medium | js/log-injection | `apps/worker-cf/scripts/integration.mjs:148` | `apps/worker-cf/` is not in CI typecheck set. One-off ingest script. |
| 42 | high | js/insecure-randomness | `apps/worker-cf/scripts/live-post-flow.mjs:130` | Same — `apps/worker-cf/` out of CI scope. |
| 44 | medium | js/file-access-to-http | `parity/run.mjs:47` | `parity/` is a legacy parity harness, not typechecked by CI. |
| 2, 21, 20, 1 | high/medium | js/polynomial-redos, js/bad-code-sanitization, js/identity-replacement | `apps/web-edge-cf/src/handler.ts:59`; `web/src/i18n/I18nProvider.tsx:220,222`; `web/src/lib/symbols/symbolIcons.tsx:160` | Top-level `web/` is the legacy dir slated for DROP (Stage 1 §D); `apps/web-edge-cf/` is not in CI typecheck set. |

### DESIGN DECISION — real in principle, deferred with rationale

| # | Severity | Rule | Location | Rationale |
|---|----------|------|----------|-----------|
| 22 | high | js/insufficient-password-hash | `apps/api/src/developer/developerAuth.ts:85` (`hashDeveloperKey`) | Uses plain SHA-256 to hash a **developer API key** (8 hex + 32 base64url ≈ 40 chars, high entropy), not a user password. Offline brute-force is infeasible due to key entropy. Changing the algorithm would break existing issued keys and requires a coordinated migration + verify-side change. Deferred as a design decision; revisit when the developer-key surface gets a password-hash upgrade. |

### Remaining in-CI-scope, non-test, non-dismissed (review)

| # | Severity | Rule | Location | Status |
|---|----------|------|----------|--------|
| 32 | high | js/double-escaping | `apps/api/src/telegram/telegramBot.ts:3299` | Telegram outgoing-message escaping; review whether HTML-entity double-apply is possible. |
| 31, 30, 29 | high | js/incomplete-multi-character-sanitization | `apps/api/src/telegram/telegramMenus.ts:55,60,62` | Telegram keyboard/menu markup building; review sanitization coverage. |
| 46 | medium | js/http-to-file-access | `apps/api/src/attachments/attachmentService.ts:102` | Attachment file serving; review path traversal guard. |
| 19 | high | js/redos | `packages/domain/src/tradingSession.ts:45` | Session regex; review quantifier nesting. |

---

## Summary

| Classification | Count |
|----------------|-------|
| False positive (dismissed) | 13 |
| Test file (dismissed) | 7 |
| Out of CI scope (dismissed) | 8 |
| Design decision (deferred, rationale) | 1 |
| Review (genuine candidates) | 6 |
| Fixed | 0 |
| **Total open** | **50** |

No alert was fixed by code change in this wave because every in-CI-scope non-test alert is either (a) an intentional, correct security-sanitization pattern dismissed as false positive, or (b) a design decision/deferred candidate needing a separate decision. Fixing the dismissed alerts would *weaken* correct code or break verified contracts, so they are intentionally left unchanged.

## Revisit plan

1. Resolve the "review" candidates (#32, #31, #30, #29, #46, #19) with targeted fixes where genuinely needed.
2. Re-evaluate #22 (developer key SHA-256) when the developer-key surface gets a password-hash migration.
3. Re-run CodeQL after any change; dismiss new false positives with written reason here.
