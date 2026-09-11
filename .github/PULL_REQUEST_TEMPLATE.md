## What changed

<!-- One paragraph: responsibility-level description, not a file list. -->

## Verification evidence

<!-- Commands run + results. Unchecked boxes mean the PR is not ready. -->

- [ ] `npm run format:check` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes (record: ___ files / ___ tests)
- [ ] `npm run i18n:check` passes (if locales touched)

## Bilingual verification

- [ ] New API/user-facing strings added to both `fa`/`en` catalogs (or N/A — no strings)
- [ ] No hardcoded user-facing strings introduced
- [ ] Emails/API messages follow locale rules (Latin digits `0-9`, brand tokens untouched)

## Workflow / operations changes (if any `.github/` or `scripts/` file changed)

- [ ] `npm run github:cost:check` passes (runners, timeouts, no prohibited triggers/permissions)
- [ ] `npm run structure:check` passes (or baseline updated via governed `--update`)
- [ ] No secret values in code, logs, artifacts, or this description (names only)

## Database changes

- [ ] N/A — no Prisma schema/migration/data change in this PR
- [ ] If checked otherwise: STOP — database work is deferred to the final migration phase and needs explicit owner approval.

## Safety confirmation

- [ ] No unrelated files changed
- [ ] Failure behavior preserved or explicitly justified below
