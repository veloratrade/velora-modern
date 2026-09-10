# Velora Modern Migration Changelog

## Phase 4.5 — Cross-Platform Capability & Quality Parity Framework (2026-09-10)

### Added
- **Localization Infrastructure**:
  - `locales/en.json` & `locales/fa.json`: Bilingual translation catalogs with 100% key parity.
  - `scripts/validate-i18n.ts`: Modern-native TypeScript localization validator verifying key-level parity, brand term preservation ("VELORA", "MetaAPI"), direction (`en` LTR / `fa` RTL), and Latin-digit invariants.
  - `npm run i18n:check`: Dedicated npm script and CI quality gate.
  - `tests/unit/i18nParity.test.ts`: Vitest suite enforcing fail-closed gate mechanics (tested on missing keys, brand violations, and non-Latin digits).
- **Financial & Trading Math Parity**:
  - `src/modules/trades/pnlCalculator.ts`: Modern-native arbitrary precision PnL and R-multiple calculator using `Decimal.js`.
  - `tests/unit/financialParity.test.ts`: Golden vector tests matching PHP `PnlCalculator.php` arbitrary-precision behavior.
- **Migration Documentation Suite**:
  - `docs/migration/parity-gates.md`: Full cross-platform quality gate classification matrix.
  - `docs/migration/capability-parity-matrix.md`: Status matrix tracking capability migration across PHP and Modern.
  - `docs/migration/business-rules.md`: Comprehensive business rule specifications.
  - `docs/migration/api-contracts.md`: Shared REST API response envelope and error contracts.
  - `docs/VELORA_MODERN_PHASE_4_5_PARITY_GOVERNANCE_REPORT.md`: Phase 4.5 Governance Report.

### Verified
- Automated validation suite: `format`, `lint`, `typecheck`, `i18n:check`, `test` (48/48 tests across 11 files), and `build` passing with 0 errors.
