# Velora Modern

Velora Modern is the future modern Node.js/TypeScript application for **Velora Trade** — an intelligent trading journal and MetaApi execution engine.

## Current Status

* **Stage**: Phase 2 — Repository Scaffolding & Engineering Foundation
* **Current Reference Implementation**: [`veloratrade/veloratrade`](https://github.com/veloratrade/veloratrade) (PHP 8.2+ / MySQL)
* **Hosting Platform**: Railway (Project: `Velora`)
  * Environment `production` (Scaffolded - Deployment trigger: `main`)
  * Environment `staging` (Scaffolded - Deployment trigger: `staging`)
* **Infrastructure Provisioning**:
  * MySQL: Planned for Phase 3 (Not currently provisioned)
  * Redis: Planned for Phase 6 (Not currently provisioned)
  * Primary Domain (`veloratrade.ir`): Unchanged on PHP production

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

## Documentation Architecture

* [Phase 0.1-R Evidence Verification](docs/VELORA_MODERN_PHASE_0_1_R_CORRECTION.md)
* [Phase 1 Architecture Decision Record](VELORA_MODERN_PHASE_1_ARCHITECTURE_DECISION.md)
* [Phase 2 Engineering Scaffolding Report](docs/VELORA_MODERN_PHASE_2_SCAFFOLDING.md)
* [Railway Infrastructure Baseline](docs/infrastructure/railway-baseline.md)
* [Migration Principles](docs/architecture/migration-principles.md)
* [Domain & DNS Strategy](docs/infrastructure/domain-strategy.md)

## Next Phase

`NEXT: Phase 3 — Database Schema & Migration Foundation`
