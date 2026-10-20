# apps/web-edge-cf — the staging edge shell, now reproducible

**What this is.** A Cloudflare Worker that fronts the staging web app: static build output is served
from the Workers **assets** binding, everything else is proxied to `VELORA_API_ORIGIN`, and HTML gets
the staging `noindex` contract. The logic is `src/handler.ts` — a pure, dependency-free function tested
with `node --test`; `src/index.ts` only wires it up.

**Why this package exists (the gap it closes).** The live Worker `velora-modern-staging`
(`https://velora-modern-staging.yadgar-s-ict.workers.dev`, versions #1–#3, the last uploaded manually
with `wrangler` on 2026-10-06) had **no source in the repository** — the deploy was not reproducible,
which round 6's brief explicitly forbids. This package reconstructs the edge from its *observed*
behavior (asset serving with `immutable`; verbatim proxying including the app's 404 envelope and 302s;
`x-robots-tag` on HTML only — each observation is recorded as a test in `handler.test.ts`).

**Fidelity caveat, stated plainly.** The original uploaded script may differ from this reconstruction in
ways no external probe can see (header edge cases, internal retries). That is exactly why **swapping the
live edge is an explicit human decision**, gated in `deploy.sh` behind `CONFIRM_EDGE_DEPLOY=yes`, and
why the current staging behavior was NOT re-painted this round: the live #3 works and is verified live
(`docs/state/REPORT-round-6.md` §Cloudflare); this package makes the *next* edge change reproducible.

| File | Role |
|---|---|
| `src/handler.ts` | the whole routing decision, pure; pinned by `handler.test.ts` |
| `src/index.ts` | Workers entry — five lines of wiring, zero logic |
| `wrangler.jsonc` | the binding contract mirrored from the live settings (compat date included — change it deliberately, never accidentally) |
| `prepare-assets.mjs` | stages `apps/web/.next/static` + `public/` into `dist-assets/`; refuses to run without a fresh web build |
| `deploy.sh` | gated upload: typecheck → tests → assets → `--dry-run` → deploy (only with `CONFIRM_EDGE_DEPLOY=yes`) → live post-checks |

**Run it:**

```bash
npm run types -w @velora/web-edge-cf     # tsc --noEmit
npm run test  -w @velora/web-edge-cf     # node --test via tsx
npm run build -w apps/web && npm run assets -w @velora/web-edge-cf   # when staging assets
CONFIRM_EDGE_DEPLOY=yes TOKEN_FILE=/tmp/velora_cf_token ./deploy.sh  # the swap; owner-gated
```

Rollback is Cloudflare-native: `GET .../versions` lists history, `POST .../versions/{id}/rollback`
restores it — `deploy.sh` prints both commands with the ids it read back, and never prunes history.
