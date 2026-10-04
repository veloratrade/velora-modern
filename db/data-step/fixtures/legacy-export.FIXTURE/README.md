# FIXTURE export — SYNTHETIC. NOT production data.

This directory exists so the LOAD REHEARSAL HARNESS (`tools/load_rehearsal.ts`) can
be executed and tested end to end without touching, copying or exporting a single
real user's journal. Every row here is invented; the emails use the reserved
`.test` TLD and the passwords are not hashes of anything.

It is the same discipline `ops/backup/sample_e2e.py` uses: a deterministic,
offline exercise of the real machinery, labelled as a fixture so no reader can
mistake its output for migration evidence about production.

What it is used for:
  * the A-gates (pre-load censuses) — including rows that MUST be excluded, so the
    harness's refusal paths are exercised, not just its happy path;
  * the load itself (id-preserving INSERT + sequence fixup);
  * the B-gates (post-load checks) — row counts, money totals, ownership, the
    money-scale invariant, and the PnL golden recomputation;
  * the timestamp honesty gate: one row carries an unresolved time, and it must
    stay unresolved through the load rather than being invented into a UTC instant.

The file layout is exactly what a real export produces (see `docs/migration-strategy.md` §5):
`manifest.json` plus one CSV per table, header row first, `\N` for NULL, UTC
instants in ISO-8601 for resolved times, and the ORIGINAL naive text preserved next
to the resolved instant.
