# Velora Modern — Merge Review Policy

Port of `docs/06_MERGE_REVIEW_POLICY.md` (PHP). Same protections, Modern-native
checks. GitHub-side settings (rulesets, required reviewers) are owner actions —
this document specifies WHAT must be configured, not a claim that it is.

## 1. Required status checks

The following checks must be green before merge to `main` or `staging`:

| Check | Source workflow | Blocks |
|---|---|---|
| `Lint, Typecheck, Guards, Test, i18n Gate & Build` | `ci.yml` → job `validate` | Everything (style, types, guards, tests, build) |
| `Secret scan` | `secret-scan.yml` | Secret/forbidden-file/user-data leaks |
| `Release verification battery` (+ `Secret scan`) | `quality-gate.yml` | Release PRs: any PR that will be deployed MUST show a green quality-gate run on its HEAD |

`quality-gate.yml` has no push/PR trigger by design (it is the release
authority, invoked by deploy workflows via `workflow_call` and manually via
`workflow_dispatch`). For release PRs, dispatch it once against the PR head and
link the run in the PR.

## 2. Human review expectations

- Every PR needs one human (owner) review before merge. Agent self-review does
  not count.
- Production-environment changes (deploy/rollback/healthcheck-production
  workflows, `railway.toml`, env contracts) need explicit owner approval noted
  in the PR, even when checks are green.
- The PR template checklist (`/.github/PULL_REQUEST_TEMPLATE.md`) must be
  completed truthfully; an unchecked box blocks merge.

## 3. Scope and safety rules

- No unrelated files in a PR. Database changes of any kind are out of scope
  until the final database phase (the PR template enforces the stop rule).
- Workflow changes must keep `npm run github:cost:check` green.
- Structural additions (new top-level/second-level boundaries) must update
  `docs/architecture/STRUCTURE_BASELINE.md` via the governed
  `npm run structure:check -- --update` in the SAME PR.

## 4. Merge method

- Squash-merge feature PRs into `staging`; fast-forward or squash `staging`
  into `main` only through a release PR with a green quality gate.
- Never push directly to `main` or `staging` (enforce via ruleset).

## 5. Owner configuration checklist (GitHub settings — live state)

- [ ] Branch ruleset on `main` + `staging`: required checks from §1, no direct pushes.
- [ ] `staging` and `production` GitHub Environments exist; `production` has required reviewers.
- [ ] `CODEOWNERS` created with owner handle (repo file — needs the owner username; intentionally not templated).
- [ ] Secrets/variables per `docs/ops/PROVISIONING_RUNBOOK.md` are set (names only, values via owner).
- [ ] Cost-posture adaptation acknowledged: permanent CI + always-on cost guard (PHP default-deny Actions posture intentionally not ported — contract §5).
