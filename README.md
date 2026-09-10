# Velora Modern

Velora Modern is the modern Node.js/TypeScript application for **Velora Trade** — an intelligent trading journal, performance analytics platform, and MetaApi execution engine.

## Current Status

* **Stage**: Phase 6 — Trading Accounts & Dashboard Performance Analytics (`v0.6.0`)
* **Current Operational Reference**: [`veloratrade/veloratrade`](https://github.com/veloratrade/veloratrade) (PHP 8.2+ / MySQL)
* **Hosting Platform**: Railway (Project: `Velora`)
  * Environment `production` (Deployment trigger: `main`)
  * Environment `staging` (Deployment trigger: `staging`)
* **Infrastructure & Database Status**:
  * MySQL: Canonical schema defined in `prisma/schema.prisma` (mapping 38 MySQL tables) and baseline SQL migration in `prisma/migrations/0_init/`. Staging database runtime instance provisioning deferred to staging deployment phase.
  * Redis: BullMQ background queue worker architecture planned for Phase 7 (MetaAPI Sync). Redis instance not yet provisioned.
  * Primary Domain (`veloratrade.ir`): Unchanged on PHP production.

## Local Development Instructions

### Prerequisites
* Node.js >= 20.0.0 LTS
* npm >= 10.0.0

### Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Copy environment configuration template
cp .env.example .env

# 3. Start development server with hot-reload
npm run dev

# 4. Check application health
curl http://localhost:8080/health
```

### Available npm Scripts

* `npm run dev`: Start Fastify application with `tsx` hot-reload
* `npm run build`: Compile TypeScript into `dist/`
* `npm run start`: Run compiled production server from `dist/server.js`
* `npm run typecheck`: Run TypeScript compiler without emitting files
* `npm run test`: Execute Vitest test suite
* `npm run test:watch`: Run Vitest in watch mode
* `npm run lint`: Run ESLint check
* `npm run format`: Format code with Prettier
* `npm run format:check`: Verify formatting with Prettier
* `npm run i18n:check`: Validate translation key parity, brand policy, and ASCII digit invariants

## Documentation Architecture

* [Canonical Migration Roadmap](docs/migration/ROADMAP.md)
* [Migration Principles](docs/architecture/migration-principles.md)
* [Capability Parity Matrix](docs/migration/capability-parity-matrix.md)
* [Business Rules Specification](docs/migration/business-rules.md)
* [API Contracts Specification](docs/migration/api-contracts.md)
* [Quality & Parity Gates](docs/migration/parity-gates.md)
* [Migration Changelog](docs/migration/migration-changelog.md)
* [Phase 2 Engineering Scaffolding Report](docs/VELORA_MODERN_PHASE_2_SCAFFOLDING.md)
* [Phase 3 Database Schema Report](docs/VELORA_MODERN_PHASE_3_DATABASE_PARITY.md)
* [Phase 4 Auth & Identity Report](docs/VELORA_MODERN_PHASE_4_AUTH_IDENTITY.md)
* [Phase 4.5 Parity Governance Report](docs/VELORA_MODERN_PHASE_4_5_PARITY_GOVERNANCE_REPORT.md)
* [Phase 5 Core Trading Report](docs/VELORA_MODERN_PHASE_5_CORE_TRADING_JOURNAL_REPORT.md)
* [Phase 5 Blocker Resolution Report](docs/VELORA_MODERN_PHASE_5_BLOCKER_RESOLUTION_REPORT.md)
* [Phase 6 Trading Accounts & Dashboard Report](docs/VELORA_MODERN_PHASE_6_CAPABILITY_MIGRATION_REPORT.md)
* [Railway Infrastructure Baseline](docs/infrastructure/railway-baseline.md)
* [Domain & DNS Strategy](docs/infrastructure/domain-strategy.md)

## Next Phase

`NEXT: Phase 6.5 — Plan / Subscription / Entitlement Foundation`
