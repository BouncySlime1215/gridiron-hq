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
| plans.candidates_scored | search (planner.js -> search.js) | paths scored for league 4 on one run | higher | 0 | 31 | 2026-09-25 integration-10a (#463), live-DB copy: reset by hand from 53 because FLIP-STRANDED (#432, a rule) drops paths that strand Nick under the floor between legs (main 52 -> 31 on the same snapshot), not a search regression | `node scripts/check-benchmarks.mjs --plans ~/gridiron-local/warroom/plans.json --league 4` |
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

## Shadow units

AUTO-PARK (plan item 52). One row per unit that runs in shadow behind its own flag. A `shadow` unit with no
progress toward its bar for 21 days gets `park?` and a one-line reason in the park cell; Nick decides.
Progress is the newer of the "last progress" date here and the newest entry for the unit in an optional
progress log (`{"unit","at","note"}` per line). A unit with no progress counts from its registered date
(the day its flag reached `main`). Only the park cells are machine-written.

<!-- shadow-units:begin -->
| unit | flag | status | bar | registered | last progress | progress note | park |
|---|---|---|---|---|---|---|---|
| LOVE-TAG | GRIDIRON_LOVE_TAG | shadow | luck-free r52 re-run BUY hit rate beats baseline (love.hit_rate row) | 2026-09-25 | none | ungraded: needs the local r52 fit |  |
| PRICE-BAND-V2 | GRIDIRON_PRICE_BAND_V2 | shadow | held-out 80% band coverage within 0.01 of 0.80 (price_band.coverage_80 row) | 2026-09-24 | none | needs the local Sleeper trades csv |  |
| BUY-LOW | GRIDIRON_BUY_LOW | shadow | BUY-LOW-PREREG.md v1 backtest bar | 2026-09-25 | none | no graded run on main yet |  |
| OPP-RADAR | GRIDIRON_OPP_RADAR | shadow | 4 gated O1 cells pass on held-out weeks | 2026-09-25 | none | cells pending local grade |  |
| PULSE-02 | GRIDIRON_PULSE_02 | shadow | grading only: labeller beats PULSE-01 on graded ticks | 2026-09-25 | none | no graded ticks yet |  |
| STOPS | GRIDIRON_STOPS | shadow | priced stops graded at L1 | 2026-09-25 | none | waiting on L1 |  |
| SELL-HIGH | GRIDIRON_SELL_HIGH | shadow | sell-high-grade.mjs beats trailing rate | 2026-09-25 | none | needs local grade |  |
| DEADLINE-MODE | GRIDIRON_DEADLINE_MODE | shadow | deadline report graded before it serves | 2026-09-25 | none | not measured yet |  |
| GAME-SHOCKS | GRIDIRON_GAME_SHOCKS | shadow | held-out 2025 tail co-exceedance CI improves | 2026-09-25 | 2026-09-25 | held-out 2025 bar failed; one season underpowered |  |
| CLONE-V2 | GRIDIRON_CLONE_V2 | shadow | LIVE-BLEND challenger arm beats the served arm | 2026-09-25 | none | no settled offers graded |  |
| E-BAYES | GRIDIRON_EBAYES_SHADOW | shadow | e-bayes-grade.mjs beats the served P(yes) | 2026-09-25 | none | no settled offers graded |  |
| E-LATENCY | GRIDIRON_REPLY_LATENCY | shadow | reply-latency calibration on settled offers | 2026-09-25 | none | no settled offers graded |  |
| CAL-MONITOR | GRIDIRON_CAL_MONITOR | shadow | ~4 logged weeks for a live calibration grade | 2026-09-25 | none | weeks logged: 0 on main |  |
| WAIVERS-PERISHABLE | GRIDIRON_WAIVERS_PERISHABLE | shadow | perishable board graded against claims | 2026-09-25 | none | not measured yet |  |
| O1C-WIRE | GRIDIRON_O1C_WIRE | shadow | o1c-grade.mjs: all 4 cells pass | 2026-09-25 | none | all 4 cells pending |  |
| WANTS-MENU | GRIDIRON_WANTS | shadow | wants predicts a roster move within 7 days vs trailing rate | 2026-09-25 | none | needs local grade (wants-grade.mjs) |  |
| IS-TITLE | GRIDIRON_IS_TITLE | shadow | work-normalized SE <= 0.5x direct MC, ESS_event >= 200 | 2026-09-25 | 2026-09-25 | bar failed (SE ratio max 1.59) |  |
| PLAYOFF-SEEDING | GRIDIRON_PLAYOFF_SEEDING | shadow | B1-B5 on a local league-4 run | 2026-09-26 | none | fixture passed; local run pending |  |
<!-- shadow-units:end -->

```sh
# dry run: prints OK / PARK? per unit, writes nothing
node scripts/auto-park.mjs [--as-of 2026-10-16] [--progress <progress.jsonl>]
# rewrite the park cells (off by default)
GRIDIRON_AUTO_PARK=1 node scripts/auto-park.mjs --write
```

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
