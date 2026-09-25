# BENCHMARKS

One row per model: what it is graded on, which way is better, the number it holds today, and the
command that reproduces that number. The merge gate runs `scripts/check-benchmarks.mjs` before and
after every merge and **refuses a regression** on any row that has a baseline.

- **Read-only.** The gate reads served numbers (plans.json, and what each row's command prints). It
  never computes its own copy of a number (one producer per number).
- **`unmeasured`** means nobody has run the command on a fixed input yet. The row is listed so it
  cannot be forgotten; the gate reports it and does not block on it. The first local run that
  produces the number sets the baseline with `--ratchet`.
- **`not run`** means the row has a baseline but this gate run was given no value for it. It is
  printed, never counted as a pass.
- **Tolerance** is an allowance before a change counts as a regression: `25%` is relative to the
  baseline, a bare number is absolute. For `target:X` rows, the distance from X may grow by at most
  the tolerance.
- **Ratchet.** `--ratchet` rewrites only the baseline cell of rows that improved. Nothing else in
  this file changes.
- Plans-file rows are league 4 only, on the plans file the loop last wrote. That file is rewritten
  every 15 min, so a before/after pair is comparable only on the same snapshot (CLEARS-BENCH
  `--db-snapshot`, ONE-PLAN.md night 1-2).

## Rows

<!-- benchmarks:begin -->
| id | model | metric | better | tolerance | baseline | measured | command |
|---|---|---|---|---|---|---|---|
| plans.candidates_scored | search (planner.js -> search.js) | paths scored for league 4 on one run | higher | 0 | 53 | 2026-09-24T14:23:43Z plans.json, ONE-PLAN.md 2 | `node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --league 4` |
| plans.runtime_ms | producer (produce-plans.mjs) | one league-4 plan, wall time, machine idle | lower | 25% | 97918 | 2026-09-24T14:23:43Z plans.json (2,221 s under load: not comparable) | `node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --league 4` |
| plans.number_health_broken | number audit (brain-gate.js readNumberHealth) | checks at status broken | lower | 0 | 2 | 2026-09-24T14:23:43Z plans.json: projection_basis, weekly_range | `node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --league 4` |
| sim.se_ratio_median | title sim, RB-TITLE (rb-title.js) | r50 harness median SE ratio on title levels | lower | 0.02 | 0.488 | 2026-09-25 tree a090712b, deterministic | `node --test test/rb-title.test.js 2>&1 \| node scripts/check-benchmarks.mjs --log -` |
| sim.se_ratio_paired | title sim, RB-TITLE (rb-title.js) | r50 harness SE ratio on paired deltas | lower | 0.02 | 0.318 | 2026-09-25 tree a090712b, deterministic | `node --test test/rb-title.test.js 2>&1 \| node scripts/check-benchmarks.mjs --log -` |
| clears_bench.survivors | search + confirm (confirm.js) | CLEARS-BENCH confirm survivors on a fixed seed and DB snapshot | higher | 0 | unmeasured | needs the REPRO-01 snapshot (#366) | CLEARS-BENCH script on `--db-snapshot`, value passed with `--current` |
| price_band.coverage_80 | accept band V2 (price-band.js) | pooled 2023-24 held-out coverage of the 80% band | target:0.8 | 0.01 | unmeasured | needs the Sleeper trades csv (local) | `node scripts/price-band-calibrate.mjs --trades <trades.csv> --check`, value passed with `--current` |
| love.hit_rate | LOVE tags (love.js) | luck-free r52 re-run BUY hit rate | higher | 0.02 | unmeasured | love.js reports ungraded: the r52 re-run needs the local fit | r52 re-run (local), value passed with `--current` |
| names.plans_text_hits | War Room text (view.js teamLabel) | team or manager names in plans.json text fields, league 4 | lower | 0 | unmeasured | ONE-PLAN.md counted 6 strings (flip_map 3, next_move 3) at 2026-09-24T14:23:43Z by hand; this scanner has not run on that file | `node scripts/check-names-leak.mjs --plans ~/gridiron-local/warroom/plans.json --report-plans` |
| names.public_hits | public boundary (check-names-leak.mjs) | names in tracked files and outgoing handoff files | lower | 0 | 0 | a bar, not a measurement: any hit fails | `node scripts/check-names-leak.mjs --plans ~/gridiron-local/warroom/plans.json --tracked` |
<!-- benchmarks:end -->

## Running the gate

```sh
# plans-file rows (league 4), plus any other row's number as JSON {"<id>": <number>}
node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --league 4 [--current more.json]

# the r50 rows read the harness's own printed line
node --test test/rb-title.test.js 2>&1 | node scripts/check-benchmarks.mjs --log -

# after a merge that improves a row, move its baseline (only improved rows change)
node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --ratchet
```

Exit 0: no row regressed. Exit 1: at least one `REGRESSED` line. Exit 2: bad input (unreadable file,
league not in the plans file).
