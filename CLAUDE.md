# VELORA MODERN — DEVELOPER & AGENT INSTRUCTION MANUAL

> **Governance Hierarchy:**  
> `docs/governance/AGENTS.md` is the **authoritative architecture and governance policy document**.  
> This file (`CLAUDE.md`) provides **concise operating commands, safety constraints, and migration rules** for developers and AI agents working on `veloratrade/velora-modern`.

---

## 1. Repository & Migration Principles

* **Repository Identity:** `veloratrade/velora-modern` (Fastify Node.js/TypeScript Trading Journal & Intelligence Engine).
* **Reference Source of Truth:** `veloratrade/veloratrade` (PHP source repository).
* **Migration Core Principle:** Preserve the protected business capability, security boundary, and financial invariant of the PHP system — adapt implementation cleanly to Fastify, Prisma, and TypeScript.
* **Evidence-First Rule:** Never claim a test passed, a deployment succeeded, or a gate was cleared without executing commands and verifying actual repository or runtime evidence.

---

## 2. Essential Commands

```bash
# Typecheck & Static Analysis
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint check
npm run format:check      # Prettier formatting verification

# Quality & Localization Gate
npm run i18n:check        # tsx scripts/validate-i18n.ts

# Test Suite Execution
npm test                  # vitest run (16 test files / 87+ tests)

# Build & Validation
npm run build             # tsc build to dist/
npx prisma validate       # Validate Prisma schema syntax
```

---

## 3. Financial & Security Invariants

* **Financial Precision Rule:**
  * All monetary net profit/loss (`profitLoss`, `profit`) MUST use `@db.Decimal(24, 8)` in Prisma and `Decimal.js` in TypeScript.
  * Trade prices, volumes, commissions, swaps, and R-multiples MUST use `@db.Decimal(18, 8)`.
  * Account balance and equity MUST use `@db.Decimal(18, 2)` (`INTENTIONAL_SAFE_WIDENING`).
  * Floating-point primitive arithmetic (`+`, `-`, `*`, `/`) is strictly prohibited for monetary calculations.
* **Security & Secret Handling:**
  * Fail closed on authentication, authorization, database failures, or missing credentials.
  * Secrets (`DATABASE_URL`, `JWT_SECRET`, etc.) must NEVER be logged or echoed in CLI stdout/stderr.
* **Lifecycle State Clarity:**
  * Distinguish carefully between `implemented`, `committed`, `pushed`, `deployed`, and `runtime-verified`.
  * Never claim production or staging deployment without explicit deployment logs and runtime probe evidence.

---

## 4. Policy & Change Boundaries

* **Read-Only Default:** Perform audits, inspections, and plans in read-only mode.
* **Explicit Change Scope:** Modify only authorized files for the active phase.
* **No Unapproved Infrastructure Changes:** Never alter Railway services, DNS records, or live databases without explicit user direction.
