# VELORA MODERN — REPOSITORY STRUCTURE BASELINE & DRIFT GUARD

> **Purpose:**  
> This baseline document maintains the machine-readable structural contract for `veloratrade/velora-modern`.  
> It is enforced in CI and local workflows via `scripts/validate-structure.ts` (`npm run structure:check`).

---

## 1. Architectural Alignment & Purpose

* **Source of Truth Reference:** In the PHP repository (`veloratrade/veloratrade`), repository structure was guarded by `tools/structure_sync.py` against `docs/03_PROJECT_STRUCTURE_BASELINE.md`.
* **Modern Adaptation:** For `velora-modern`, structural governance is adapted to track:
  1. **Level 1:** Core top-level directories (`src`, `tests`, `prisma`, `scripts`, `locales`, `docs`, `.github`).
  2. **Level 2:** Essential architectural boundaries (`src/core`, `src/modules`, `src/config`, `src/types`, `tests/unit`, `tests/integration`, `.github/workflows`, etc.).
  3. **Required Structural Files:** Essential root governance and configuration files (`package.json`, `tsconfig.json`, `prisma/schema.prisma`, etc.).
* **Non-Recursive Design:** To prevent CI noise during routine source file edits, the validator tracks structural boundaries rather than performing an unstable full-repository file snapshot.

---

## 2. Machine-Readable Structure Index (script-maintained)

> This JSON block is parsed by `scripts/validate-structure.ts`.  
> Do not manually edit unless performing an approved structural update (`npm run structure:check -- --update`).

<!-- VELORA_STRUCTURE_BASELINE_BEGIN -->
```json
{
  "top_level_directories": [
    ".github",
    "docs",
    "locales",
    "prisma",
    "scripts",
    "src",
    "tests"
  ],
  "selected_second_level_boundaries": [
    ".github/workflows",
    "docs/admin",
    "docs/architecture",
    "docs/governance",
    "docs/infrastructure",
    "docs/integrations",
    "docs/migration",
    "docs/ops",
    "docs/security",
    "prisma/migrations",
    "src/config",
    "src/core",
    "src/modules",
    "src/types",
    "tests/integration",
    "tests/unit"
  ],
  "required_structural_files": [
    "CLAUDE.md",
    "README.md",
    "package.json",
    "prisma/schema.prisma",
    "tsconfig.json",
    "vitest.config.ts"
  ]
}
```
<!-- VELORA_STRUCTURE_BASELINE_END -->

---

## 3. Operational Rules & Safety

* **Default Inspection Mode (`npm run structure:check`):**
  * Read-only evaluation.
  * Compares live `git ls-files` state against the baseline index.
  * Returns Exit Code `0` if structure is intact, or Exit Code `1` if drift is detected.
  * **NEVER** mutates this file during standard validation runs.
* **Update Mode (`npm run structure:check -- --update`):**
  * Explicit developer action to update the machine-readable JSON block following an approved structural change.
  * Preserves human-readable documentation text while updating the index block.
* **CI Integration:**
  * Runs in read-only check mode to fail-closed if unindexed top-level or second-level structural boundaries are introduced.
