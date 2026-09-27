---
name: an-empty-read-must-not-reach-a-written-report
description: Evidence generators in gridiron-hq must declare their source row counts and refuse to write when a required one is zero; scripts/lib/evidence-report.mjs is the shared guard.
metadata:
  type: feedback
  modified: 2026-09-22T08:54:07.532Z
---

A generator that computes statistics from a database read and writes a JSON
report will, if nothing stops it, publish a finished-looking artifact when the
read returned nothing. Constants in the source file and fallbacks a few lines
down carry the pipeline all the way to `writeFileSync` and exit 0.

**Why:** measured 2026-09-22 on this project's own database.
`scripts/run-purged-evaluation.mjs` pushed two hardcoded bet-ledger rows after
its registry-derived loop, so a run whose real cross-section was empty still
computed a deflated Sharpe ratio — over two literals — and wrote
`purged-evaluation-report.json`. `scripts/run-historical-leaderboard.mjs` caught
the same emptiness only by throwing `TypeError: Reduce of empty array with no
initial value` at `:142`, and not at all in the case it exists for
(`audit_registry` empty while Group C is not), where it completed silently.
CLAUDE.md names this exact failure: a layer goes inert and the surface keeps
printing numbers as if nothing had happened. A constant is a layer going inert
that never even had to fail.

**How to apply:** use `scripts/lib/evidence-report.mjs` (added on
`claude/wiring-map-8f96ur-inventory-hold`, evidence in
`docs/tdd/evidence-report-guard.tdd.md`).

- `assertEvidenceSources(sources, required, what)` early, before any reduce or
  aggregation over the read, so an empty input gets a named cause instead of a
  TypeError. It names **every** empty source, not the first.
- `writeEvidenceReport({ outDir, filename, report, sources, required })` as the
  only write. It asserts **before** the `mkdir` and the write — a guard that
  throws afterwards has already published what it was guarding — and stamps the
  counts into `registry_summary.sources`.
- `resolveOutDir(argv, fallback, base)` for `--out`. A hardcoded output path is
  why these generators had never been exercised: every trial run overwrote the
  committed artifact it would have been compared against. Add `--out` first;
  the rest is untestable without it.

Three rules that came out of building it:

1. **Absent counts as empty.** A required key that is `undefined` (renamed, never
   wired) must fail. "Not checked, therefore fine" is how the silent version
   returns.
2. **Constants are recorded, never required.** Count them and put the count in
   the report, so `constant_bet_ledger_trials: 2` beside
   `sharpe_cross_section_trials: 3` tells a reader what they are looking at. Do
   not require them: they are always present, so the assertion says nothing and
   would fire on a correct run.
3. **Require where emptiness is invisible; record where the zero already shows.**
   A census section that already prints `real_rows: 0` needs recording, not a
   gate that stops an otherwise-real report from being written.

Related: [[local-data-sqlite-is-at-migration-000]],
[[a-guard-undone-by-a-later-line]], [[assertion-must-name-the-thing-it-guards]].
