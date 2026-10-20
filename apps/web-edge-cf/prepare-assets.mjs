// Stages the two static trees the edge needs from the web app build into dist-assets/ for
// `wrangler`'s assets binding: hashed build output under /_next/static and the public/ files.
// Fails LOUDLY (exit 1) when the web build is missing — an edge deployed with a stale assets
// directory serves mismatched CSS/JS against freshly-deployed SSR HTML, which is exactly the
// half-deploy this repo's rules forbid.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is apps/web-edge-cf, so the web app is its SIBLING: apps/web. The previous form climbed two
// levels and resolved to <repo>/web, which never exists — so this script could only ever exit 1 and
// the edge could never be rebuilt from the repository (found 2026-10-20 while staging the assets).
const web = join(here, "..", "web");
const out = join(here, "dist-assets");

const nextStatic = join(web, ".next", "static");
if (!existsSync(nextStatic)) {
  console.error(
    "apps/web/.next/static is missing — run `npm run build -w apps/web` before `npm run assets -w @velora/web-edge-cf`.",
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "_next"), { recursive: true });
cpSync(nextStatic, join(out, "_next", "static"), { recursive: true });
if (existsSync(join(web, "public"))) cpSync(join(web, "public"), out, { recursive: true });

let files = 0;
const count = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    e.isDirectory() ? count(join(d, e.name)) : files++;
  }
};
count(out);
console.log(`staged ${files} files into ${out}`);
