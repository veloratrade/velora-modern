#!/usr/bin/env bash
# Deploy the staging edge (apps/web-edge-cf). Modeled on the repo's own deploy-kit discipline:
# never prints a secret, gates the upload on every local check, reads state back from the API
# instead of trusting its own logs, and REFUSES to touch any Worker other than the one named in
# wrangler.jsonc. Swapping the live edge is owner-gated: CONFIRM_EDGE_DEPLOY=yes is required,
# because the running version predates this package (see README "Fidelity caveat").
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PKG/../.." && pwd)"
CONFIRM="${CONFIRM_EDGE_DEPLOY:-}"
TOKEN_FILE="${TOKEN_FILE:-}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-9ef5ad5202a5e9db190bf3ecb83e3eff}"

die() { printf '\nABORT: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$1" "$2"; }

[[ "$CONFIRM" == "yes" ]] || die "CONFIRM_EDGE_DEPLOY=yes is required to swap the live edge. The reconstruction is unproven against the manually-uploaded original; that decision is the owner's. (Everything up to the upload — typecheck, tests, assets, dry-run — can be run by invoking the npm scripts directly.)"

if [[ -n "$TOKEN_FILE" ]]; then
  [[ -f "$TOKEN_FILE" ]] || die "TOKEN_FILE=$TOKEN_FILE not found"
  export CLOUDFLARE_API_TOKEN="$(tr -d '\n\r' < "$TOKEN_FILE")"
fi
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "no Cloudflare credential (CLOUDFLARE_API_TOKEN or TOKEN_FILE). Refusing to guess."
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

log 1 "typecheck + handler tests (the real gate is the whole repo battery — run `npm test` at $ROOT before a swap; this is the local floor)"
( cd "$PKG" && "$ROOT/node_modules/.bin/tsc" -p tsconfig.json --noEmit )
( cd "$PKG" && "$ROOT/node_modules/.bin/tsx" --test src/*.test.ts >/tmp/edge-tests.out 2>&1 ) || { tail -20 /tmp/edge-tests.out; die "handler tests failed"; }
grep -qE "^# fail 0" /tmp/edge-tests.out || { tail -5 /tmp/edge-tests.out; die "handler tests not fully green"; }
log 1 "ok: $(grep -E '^# pass [0-9]+' /tmp/edge-tests.out | head -1)"

log 2 "assets"
[[ -d "$ROOT/apps/web/.next/static" ]] || die "apps/web/.next/static missing — build the web app first"
node "$PKG/prepare-assets.mjs"

log 3 "wrangler dry-run (bundle must build)"
( cd "$PKG" && npx -y wrangler@4.86.0 deploy --dry-run --outdir dist -c wrangler.jsonc >/tmp/edge-dryrun.out 2>&1 ) \
  || { tail -20 /tmp/edge-dryrun.out; die "dry-run failed"; }

log 4 "record current version for rollback"
BEFORE="$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/velora-modern-staging/versions" \
  | python3 -c 'import json,sys; items=(json.load(sys.stdin).get("result") or {}).get("items",[]); print(items[0]["id"] if items else "")')"
[[ -n "$BEFORE" ]] || die "could not read the current version id — refusing to upload blind"
log 4 "current: $BEFORE"

log 5 "deploy"
( cd "$PKG" && npx -y wrangler@4.86.0 deploy -c wrangler.jsonc >/tmp/edge-deploy.out 2>&1 ) \
  || { tail -30 /tmp/edge-deploy.out; die "deploy failed; current version $BEFORE still live"; }

AFTER="$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/velora-modern-staging/versions" \
  | python3 -c 'import json,sys; items=(json.load(sys.stdin).get("result") or {}).get("items",[]); print(items[0]["id"] if items else "")')"
[[ -n "$AFTER" && "$AFTER" != "$BEFORE" ]] || die "uploaded but the API does not show a new newest version — investigating is required before declaring anything"
log 5 "new version: $AFTER"

log 6 "live post-checks (against the public URL)"
BASE="https://velora-modern-staging.yadgar-s-ict.workers.dev"
code=$(curl -s -o /tmp/edge-home.out -w '%{http_code}' --max-time 30 "$BASE/")
grep -qi "x-robots-tag: noindex" <(curl -sI --max-time 30 "$BASE/") && robots=yes || robots=no
[[ "$code" == "200" && "$robots" == "yes" ]] || die "GET / → $code, x-robots(noindex)=$robots — the edge changed behavior; rollback below"
log 6 "GET / 200 + noindex contract verified"

cat <<EOF

Deployed $AFTER. Rollback if anything looks wrong:
  curl -X POST -H "Authorization: Bearer \$CLOUDFLARE_API_TOKEN" \\
    https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/velora-modern-staging/rollback \\
    -H 'Content-Type: application/json' -d '{"version_id":"$BEFORE"}'
EOF
