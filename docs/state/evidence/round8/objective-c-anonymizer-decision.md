# Objective C — the image anonymiser: a decision, not a dependency

**Question.** Should `apps/api` declare an image library (e.g. `sharp`) so that
`screenshot_extraction` can send a redacted capture to a vision model?

## What is true right now

| Fact | Evidence |
|---|---|
| The repository has **no declared** image dependency. Root `dependencies` are `postgres` and `tsx` only. | `package.json` |
| `sharp@0.35.5` is present, but only **transitively**, through `apps/web` → `next@16.4.1`. Nothing in `apps/api` may import it: it is not a dependency of that package, and a transitive dependency is not a licence to import it. | `npm ls sharp` |
| `DefaultImageAnonymizer` returns `null` — "cannot guarantee redaction" — and every caller treats `null` as a hard refusal. That is fail-closed by construction, not by policy. | `apps/api/src/ai/imageAnonymizer.ts` |
| On the Worker the consequence is visible: a chart/screenshot ingest is refused with `IMAGE_NOT_ANONYMIZED` rather than sent to a provider. | live run `docs/state/evidence/round8/live-post-flow.txt`, and the round-7 evidence |

## The decision

**Do not add `sharp` to `apps/api`.** Reasons, in the order that decides it:

1. **It would not fix the Worker, which is where the bot runs.** `sharp` is a native binding; there is no
   `workerd` build. Declaring it would make the Node path able to redact and leave the deployed path exactly as
   blocked as it is today — a change that turns a visible, honest refusal into a difference between two hosts.
2. **Declaring a transitive package is how a supply-chain rule gets broken.** `apps/web`'s copy is owned by
   `next`; pinning it as a direct dependency of `apps/api` creates a second consumer with its own upgrade
   schedule and no owner.
3. **The security property the user set is already satisfied.** No image leaves for an external provider
   without a redaction that actually happened. Adding a library nobody verified would *weaken* that, because the
   refusal would become a code path nobody exercises.

## What would change the decision

A redaction primitive that runs **inside `workerd`** (pure-WASM, no native binding), verified by a test that
proves a marked region is destroyed in the output bytes and that a decoder failure returns `null`. Until that
exists, the gap is a **BLOCKED** capability with a named blocker, not a task left undone:

- **Blocked on:** a Workers-compatible redaction primitive.
- **Current behaviour, stated to the user:** `IMAGE_NOT_ANONYMIZED`, with local OCR (Tesseract, Node host only)
  remaining the path that reads a capture without egress.
