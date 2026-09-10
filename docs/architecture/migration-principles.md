# Velora Migration Principles

This document defines the core principles governing the migration of **Velora** from the legacy PHP/MySQL implementation (`veloratrade/veloratrade`) to the modern Node.js/TypeScript architecture (`veloratrade/velora-modern`).

---

## Central Rule

> **«Migrate capabilities and business behavior, not PHP source code line-by-line.»**

---

## Role of the PHP Reference Repository (`veloratrade/veloratrade`)

The existing PHP repository is the **authoritative source of truth for current product behavior**. It is used exclusively to discover, verify, and specify:

* Existing user-facing and admin capabilities
* Business rules and edge cases
* Security rules, permission models, and RBAC constraints
* Data models, schema relationships, and financial consistency rules
* API request/response contracts
* Integrations (MetaApi bridge, Gemini/OpenAI AI routers, Resend email)
* System observability and audit logging standards

The PHP codebase is **NOT** a template for the modern codebase. We do not mechanically copy PHP file structures or procedural patterns into TypeScript.

---

## Modern Implementation Principles (`veloratrade/velora-modern`)

The modern codebase will independently implement discovered capabilities using a clean, maintainable Node.js/TypeScript architecture.

### What NOT to do:
* **Do NOT** mechanically translate PHP files line-by-line into TypeScript.
* **Do NOT** preserve obsolete PHP directory structures or legacy workarounds unnecessarily.
* **Do NOT** copy implementation details merely because they exist in the PHP repository.
* **Do NOT** introduce unapproved new product features or scope creep during migration.

### What TO do:
* **DO** preserve required user-visible behavior and UI workflows.
* **DO** preserve critical business rules, financial ledger consistency, and trade tracking integrity.
* **DO** preserve security guarantees, JWT token rotation rules, and data privacy filters.
* **DO** preserve required third-party integrations (MetaApi, Gemini, OpenAI).
* **DO** improve code architecture, type safety, modularity, and maintainability where justified.
* **DO** document any intentional architectural or behavioral improvements.

---

## Migration Conceptual Pipeline

```text
  PHP Reference Repository (veloratrade/veloratrade)
                         │
                         ▼
                Capability Discovery
                         │
                         ▼
                  Business Rules
                         │
                         ▼
          Security / Data / API Constraints
                         │
                         ▼
                Architecture Decision
                         │
                         ▼
         Modern TypeScript Implementation
                         │
                         ▼
                Parity Verification
```

---

## Parity Definition

In the context of the Velora rewrite:

* **Parity** means **functional, security, and business capability equivalence**.
* **Parity** does **NOT** mean source-code structure equivalence.
