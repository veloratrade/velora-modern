# ADR-023 — Admin user creation and invitations (W0 decision on user create/invite)

## Status

Accepted — owner decision (2026-11-18): **Option A — port both admin user creation and invitations; 7-day invite validity; admin and super_admin roles may invite.**

## Context

The W0 gap analysis flagged an open owner decision on user management: Legacy has admin user creation plus an invitation flow, but Modern's admin console deliberately left user creation + invitations (2 routes) as owner-gated stubs (AC-16 inventory; MG-ADMIN remaining 4 OD-gated stubs: invitations, subscription, create-user, strategies). Wave W1 items A1 (`POST /admin/users`) and A2 (admin invitations) plus the associated RBAC permissions need a binding decision before implementation: build both creation and invitations, only one, or defer both.

## Decision

**Option A — port both admin user creation and invitations.**

- `POST /admin/users` — admin user creation, implemented for `admin` and `super_admin` callers, ownership-scoped and consistent with the user-mutation guard order (self-action 403 → USER_NOT_FOUND 404 → System Owner protected → privileged target → super_admin peer → privilege-escalation denial → no-op without revoking sessions → LAST_SUPER_ADMIN 409, AC-16 §7).
- Invitations — an invite creates a pending user record with a 7-day invite validity (TTL 7 days) and a single-use, time-bound invite token; invitee completes registration through the normal verify flow. Invitable by `admin` and `super_admin`.
- Invite email is implemented + tested (AC-33 email types) but remains unwired at runtime until the owner connects a delivery provider (MG-EMAIL-TYPES / MG-WORKER-DEPLOY evidence class) — the route records the invite and surfaces it; delivery is deploy-gated.
- RBAC: 4 permissions are added/enforced for this surface (`users.create`, `users.invite` or equivalent per the RBAC vocabulary, plus `users.manage_status`/`users.view` as the guard order already requires), raising enforced Legacy permissions toward 24/24 (MG-RBAC-VOCAB).
- The decision is recorded here so W1 (A1 `POST /admin/users` + A2 invitations + A3 subscription POST + 4 RBAC permissions) implements against fixed roles, TTL, and permission set.

## Alternatives considered

- Option B (creation only, no invitations) — declined: Legacy's invitation flow is a real admin capability; dropping it removes operator workflow.
- Option C (invitations only, no direct creation) — declined: direct admin creation is needed for emergency/seeding use cases and is the cleaner `POST /admin/users` contract.
- Option D (defer both) — declined: W1 needs the admin user surface to be real, not stubbed.

## Consequences

### Positive
- W1 implements a complete admin user surface (create + invite) with fixed 7-day TTL and admin/super_admin invite rights.
- RBAC vocabulary grows by 4 enforced permissions; MG-RBAC-VOCAB moves toward 24/24.

### Negative
- Invite *delivery* is not live (no Resend/SMTP provider wired); the invite route is implemented but email sending stays deploy-gated until MG-WORKER-DEPLOY and a provider credential exist.
- No self-serve signup changes: registration remains the normal `normal`-role path.

## Migration impact

None — user creation/invitations write to existing `users` + `user_sessions`/invite storage already present; no new migration beyond what W1 adds (an invite token table or column, if W1 introduces one, is additive).

## Testing / verification requirements

- W1 tests: `POST /admin/users` 201/401/403/409 guard matrix; invitation create + 7-day TTL expiry + single-use token; 4 RBAC permissions enforced (admin/super_admin grant, other roles deny).
- `rbacCapabilityMap.test.ts` 5/5 continues to pass; RBAC map updated with the new permissions.

## Phase

Phase 2 wave W1 (admin: A1 + A2 + RBAC). Blocks MG-ADMIN and MG-RBAC-VOCAB.
