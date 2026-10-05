// SEC-04 — the protected-route contract guard.
//
// The edge gate is only as good as its list. This test walks the REAL route tree
// (`apps/web/src/app/(app)/**/page.tsx`), so a page added without a decision — or
// a decision that no page backs — fails here instead of in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  PROTECTED_APP_ROUTES,
  PANEL_ROLES,
  barePath,
  isProtectedAppPath,
  isAdminAppPath,
  loginPathFor,
  dashboardPathFor,
} from "./protectedRoutes.js";
import { resolvePublicRoute } from "../../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_GROUP = join(HERE, "..", "..", "app", "(app)");

/** Every page under the `(app)` group, as its bare URL path. */
function appPagePaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry !== "page.tsx") continue;
      const rel = relative(APP_GROUP, dir).split(/[/\\]/).filter(Boolean);
      found.push(barePath(rel.length === 0 ? "/" : `/${rel.join("/")}`));
    }
  };
  walk(APP_GROUP);
  return [...new Set(found)].sort();
}

test("SEC-04: every app page is either protected by the edge gate or public by contract", () => {
  const pages = appPagePaths();
  // The tree is real: 10 authenticated + 3 public surfaces, both locales.
  assert.ok(pages.length >= 13, `expected the (app) route tree, found ${pages.length} pages`);

  const undecided = pages.filter((p) => !isProtectedAppPath(p) && resolvePublicRoute(p) === undefined);
  assert.deepEqual(undecided, [], "these app pages are neither protected nor public — the edge would guess");

  const protectedPages = pages.filter((p) => isProtectedAppPath(p));
  assert.deepEqual(
    protectedPages,
    [...PROTECTED_APP_ROUTES].sort(),
    "the protected list and the protected pages of the route tree must be the same set",
  );
});

test("SEC-04: the three public app surfaces are public ON PURPOSE, and stay that way", () => {
  // Modern's frozen PUBLIC_ROUTES contract (ADR-009 C-03) declares these public;
  // Legacy protected markets + news. The delta is an OWNER DECISION (R8) — this
  // test pins the current truth so a silent flip in either direction is caught.
  for (const path of ["/markets", "/news", "/support"]) {
    assert.equal(isProtectedAppPath(path), false, `${path} is public by contract`);
    assert.notEqual(resolvePublicRoute(path), undefined, `${path} must be in PUBLIC_ROUTES`);
    assert.equal(isProtectedAppPath(`/en${path}`), false, `/en${path} must behave like ${path}`);
  }
});

test("SEC-04: the gate normalizes the locale prefix and trailing slashes", () => {
  assert.equal(barePath("/en/dashboard"), "/dashboard");
  assert.equal(barePath("/en/dashboard/"), "/dashboard");
  assert.equal(barePath("/dashboard/"), "/dashboard");
  assert.equal(barePath("/en"), "/");
  assert.equal(barePath("/"), "/");

  for (const route of PROTECTED_APP_ROUTES) {
    assert.equal(isProtectedAppPath(route), true, `${route} must be protected`);
    assert.equal(isProtectedAppPath(`/en${route}`), true, `/en${route} must be protected`);
    assert.equal(isProtectedAppPath(`/en${route}/`), true, `/en${route}/ must be protected`);
    assert.equal(isProtectedAppPath(`${route}/child`), true, `${route}/child must be protected with its parent`);
  }
});

test("SEC-04: near-misses are NOT protected (no prefix accident)", () => {
  // A path that merely starts with a protected name must not inherit the gate.
  assert.equal(isProtectedAppPath("/dashboards"), false);
  assert.equal(isProtectedAppPath("/profiles"), false);
  assert.equal(isProtectedAppPath("/administrators"), false);
  assert.equal(isProtectedAppPath("/trade"), false);
  // …and the public pages keep their own class even under a prefix.
  assert.equal(isProtectedAppPath("/market"), false);
});

test("SEC-04: the admin gate is a subset of the protected surface", () => {
  assert.equal(isAdminAppPath("/admin"), true);
  assert.equal(isAdminAppPath("/en/admin"), true);
  assert.equal(isAdminAppPath("/en/admin/anything"), true);
  assert.equal(isAdminAppPath("/administrators"), false);
  assert.equal(isAdminAppPath("/dashboard"), false);
  // Every admin path is protected, so a non-panel visitor can never be shown
  // the admin shell by a gate-ordering mistake.
  assert.equal(isProtectedAppPath("/admin"), true);

  // Panel roles are Legacy PANEL_ROLES (admin + super_admin) — the client-side
  // shell must never be the only thing standing between a user and /admin.
  assert.deepEqual([...PANEL_ROLES], ["admin", "super_admin"]);
});

test("SEC-04: refusals land on the locale-correct destination", () => {
  assert.equal(loginPathFor("/dashboard"), "/login");
  assert.equal(loginPathFor("/en/dashboard"), "/en/login");
  assert.equal(loginPathFor("/en/admin"), "/en/login");
  assert.equal(dashboardPathFor("/admin"), "/dashboard");
  assert.equal(dashboardPathFor("/en/admin"), "/en/dashboard");
});

test("SEC-04: the contract module is the only place the gate list is written down", () => {
  // A second copy of the list (in the proxy, or in a page) is how the two drift.
  const proxySource = readFileSyncSafe(join(HERE, "..", "..", "proxy.ts"));
  assert.ok(proxySource !== null, "proxy.ts must exist");
  assert.ok(proxySource.includes("isProtectedAppPath"), "the proxy must use this module's gate");
  assert.ok(
    proxySource.includes("isAdminAppPath") && proxySource.includes("PANEL_ROLES"),
    "the proxy must use this module's admin gate and role set",
  );
  for (const route of PROTECTED_APP_ROUTES) {
    assert.equal(
      proxySource.includes(`"${route}"`),
      false,
      `proxy.ts must not carry its own copy of the route list (found ${route})`,
    );
  }
});

function readFileSyncSafe(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
