# Velora Modern Migration Changelog

## [0.6.0] - 2026-09-10 (Phase 6: Trading Accounts & Dashboard Performance Analytics Migration)

### Added
- **Trading Accounts Management Module** (`src/modules/accounts/`):
  - DTO types (`accounts.types.ts`), Prisma repository access layer (`accounts.repository.ts`), service layer with broker auto-detect logic (`accounts.service.ts`), Fastify REST routes (`accounts.routes.ts`), and plugin exports.
  - CRUD operations under `/api/v1/accounts` (`GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`, `POST /:id/sync`).
  - Server auto-detection mapping broker server strings (e.g. `MetaQuotes-Demo`, `ICMarkets-Demo`) to standard broker metadata.
  - Sync status lifecycle enum (`PENDING_SYNC`, `CONNECTING`, `SYNCED`, `SYNC_FAILED`).
  - User-scoped trading account ownership verification (`user_id -> account_id`).
- **Dashboard Performance Analytics Module** (`src/modules/dashboard/`):
  - DTO types (`dashboard.types.ts`), repository query layer (`dashboard.repository.ts`), service metrics computation engine (`dashboard.service.ts`), Fastify REST routes (`dashboard.routes.ts`), and plugin exports.
  - Key performance metrics summary (`GET /api/v1/dashboard/summary`): Net PnL, win rate, total trades, profit factor, average win/loss, max drawdown, and balance/equity curve.
  - Equity curve time-series endpoint (`GET /api/v1/dashboard/equity-curve`): Daily and trade-by-trade cumulative PnL aggregation.
  - Strategy performance breakdown endpoint (`GET /api/v1/dashboard/strategies`): Grouped analytics per strategy tag.
- **Integration Test Suite**:
  - `tests/integration/accounts.test.ts`: Fastify HTTP integration tests covering trading account creation, server auto-detect, updates, deletion, and ownership authorization boundary checks.
  - `tests/integration/dashboard.test.ts`: Fastify HTTP integration tests verifying summary analytics, win rate calculations, profit factor, drawdown metrics, equity curve aggregation, and strategy breakdowns.
- **Migration Documentation**:
  - Created `docs/VELORA_MODERN_PHASE_6_CAPABILITY_MIGRATION_REPORT.md` documenting Phase 6 capability migration completion.

---

## [0.5.0] - 2026-09-10 (Phase 5: Core Trading & Journaling Engine Migration)

### Added
- **PnL & Financial Math Engine** (`src/modules/trades/pnlCalculator.ts`):
  - Scale 8 arbitrary precision `Decimal.js` computations for Buy/Sell gross PnL, net PnL, risk, and R-multiple.
  - Zero/null Stop Loss handling and improper SL side protection.
  - Golden vector unit test suite (`tests/unit/financialParity.test.ts`) matching PHP `PnlCalculatorTest.php` cases.
- **Trades Data Layer & Types** (`src/modules/trades/trades.types.ts`, `src/modules/trades/trades.repository.ts`):
  - Canonical DTOs (`TradeSerialized`, `TradeExitSerialized`, `CreateTradeInput`, `UpdateTradeInput`, `CreateTradeExitInput`, `TradeFilter`).
  - User-scoped Prisma data access repository with test mode in-memory fallback store (`MemoryStore`).
  - Partial exit management (`TradeExit`) with cumulative volume validation and proportional cost allocation (commission & swap).
- **Trades Service Layer** (`src/modules/trades/trades.service.ts`):
  - Input field validation (symbol regex, directions `buy`/`sell`, positive prices/volumes, chronology `openTime <= closeTime`).
  - Account ownership verification (`user_id -> account_id -> trade_id`).
  - Numeric zero-trimming serialization (`trimZeros`) for clean Latin digit presentation.
- **Trades REST API Routes** (`src/modules/trades/trades.routes.ts`):
  - Endpoint definitions under `/api/v1/trades`:
    - `GET /api/v1/trades` (Search & Pagination)
    - `GET /api/v1/trades/:id` (Get Trade by ID)
    - `POST /api/v1/trades` (Create Manual Trade)
    - `PUT /api/v1/trades/:id` (Update Trade)
    - `DELETE /api/v1/trades/:id` (Delete Trade)
    - `GET /api/v1/trades/:id/exits` (List Trade Exits)
    - `POST /api/v1/trades/:id/exits` (Create Partial Exit)
    - `DELETE /api/v1/trades/exits/:exitId` (Delete Partial Exit)
  - Registered plugin in `src/app.ts` under `/api/v1/trades`.
- **Integration Test Suite** (`tests/integration/trades.test.ts`):
  - Fastify HTTP injection tests covering trade lifecycle, pagination, ownership authorization boundary checks, validation failures, and partial exit cumulative volume & chronology guards (7/7 tests passing).
- **Migration Documentation**:
  - Updated `business-rules.md`, `api-contracts.md`, `capability-parity-matrix.md`.

---

## [0.4.5] - 2026-09-10 (Phase 4.5R: Evidence Reconciliation & Gate Correction)

### Added
- Created `docs/VELORA_MODERN_PHASE_4_5R_RECONCILIATION.md` establishing Evidence Reconciliation Matrix.
- Implemented requirement failure tests in `tests/unit/i18nParity.test.ts` verifying key parity, brand term preservation, and ASCII/Latin digit rules.

### Fixed
- Calibrated phase claim status across 9 parity gates.
- Resolved database error handling fallback to ensure test suite isolation without live MySQL dependencies.

---

## [0.4.0] - 2026-09-10 (Phase 4: Database Schema & Migration Parity)

### Added
- Canonical Prisma schema (`prisma/schema.prisma`) mapping MySQL tables.
- Repository layer abstractions with test memory fallbacks.
- Schema parity unit test suite (`tests/unit/schemaParity.test.ts`).

---

## [0.3.0] - 2026-09-10 (Phase 3: Core API Architecture & Auth Migration)

### Added
- Argon2id password hashing & Bcrypt `$2y$` -> `$2a$` remapping.
- Auth Service (`src/modules/auth/auth.service.ts`) and JWT authentication.
- Auth REST routes under `/api/v1/auth`.
- Integration tests in `tests/integration/auth.test.ts`.

---

## [0.2.0] - 2026-09-10 (Phase 2: Project Architecture Scaffolding)

### Added
- Fastify server configuration (`src/app.ts`, `src/index.ts`).
- Standard error handler (`src/core/errors/errorHandler.ts`) and envelope contract.
- i18n validator script (`scripts/validate-i18n.ts`).
- Vitest testing framework setup.
