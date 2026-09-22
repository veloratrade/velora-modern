# Parity (executable specification) — foundation

Per `docs/parity-plan.md`: specs are declarative and target-agnostic; comparison
is semantic with an explicit tolerance allowlist; differential testing vs PHP
staging is a SECONDARY signal and may only run from authorized environments.

- `specs/*.json` — external-tier specs (C-01 health, C-02/C-03 locale routing)
- `run.mjs` — runner: `node parity/run.mjs --target <base-url>` (CI/staging),
  or in-process via the exported `runSpecs(base)` (used by
  `tools/parity-smoke.ts` because this dev sandbox drops child→parent loopback
  TCP connections — parent-process fetch works, child-process fetch times out)

## Status (2026-08-31)

- Modern-side smoke: EXECUTED against the local API kernel (see ADR-011 test
  evidence) — health + locale specs PASS.
- PHP-staging differential: **BLOCKED** — (a) the PHP host silent-drops
  non-Iranian network positions (PHP repo OC-1 lesson), (b) no staging
  authorization window is open. Runs from an authorized environment per the
  parity plan once Phase 2 journeys exist.
- Journey categories (auth, email links, SEO, webhooks) are Phase 2 scope per
  the capability waves.
