---
name: availability-fit-attribution-map
description: Which Trade Brain fields the availability fit can move and which it provably cannot — the trade value is a free control variable, and the playoff odds have a non-zero drift floor because their cache is fingerprinted on live data.
metadata:
  type: project
---

Verified in code 2026-09-19 for the release's before/after reading. Companion
to [[availability-fit-before-after]].

**The trade value CANNOT move. This is the useful one.** `value` on an asset is
`m?.value ?? 0` (`trade-engine.js:419`), and `m` is a row from `dynasty_values`,
loaded at `:307-309` — the FantasyCalc market price, not derived from ppg,
`adj_ppg` or availability at any remove. The fit writes exactly two tables
(`scripts/fit-availability.mjs:412-421`: DELETE + INSERT on
`nfl_availability_rates` and `nfl_availability_role_rates`). `dynasty_values` is
not one of them.

So `value`, `give_value`, `get_value` and `ratio` — all sums of that same market
number (`:1876-1877`, `:2225`, `:2345`, `:2386`) — are a **control variable**.
They should be byte-identical across the fit. If they move, the fit did not do
it (a dynasty-values sync or a merged PR did), and the attribution for
everything else in that reading is broken too. Check them first.

**What does move:** `current_week_ppg` undamped, `adj_ppg` through the quarter
weight (`decisionPpg = 0.25 * currentWeekPpg + 0.75 * rosPpg`, `:385`, only the
first term carrying availability — about 6.76% at c=r and a0=0.70, roughly 5.3x
attenuated), `floor`/`ceiling` (the week distribution at `:399` is seeded with
`activeProbability`), both ppg deltas, `horizon_value`, `playoff_odds`, and
`acceptance` via `edge.passes`. `efficiency` is the in-between case:
`gain.value / (giveValue / 100)` (`:2242`), so its numerator moves and its
denominator cannot — it moves, and it is the fit doing it.

**The playoff odds have a drift floor that is NOT zero and NOT measurable by
repeating the read.** `myPlayoffOdds` caches under `assetPrint` (`:1300-1311`),
a fingerprint over `ASSET_INPUT_TABLES` (`:200-228`) — 14 inputs including
`nfl_injuries.modified_at`, `game_lines.fetched_at`, `leagues.fetched_at`,
`news_items`, `trending_players`, `player_metrics` — plus `servedInputsDigest()`
for in-place stat corrections. The sim itself runs under a fixed
`HORIZON_SIM_SEED`. So same seed + same fingerprint returns the identical cached
number, and a CHANGED number means an input moved, not that the sim is random.

**Measured, 2026-09-19.** Two captures 15 minutes apart, nothing deployed
between (20:31:56Z and 20:46:52Z, all five leagues). `value`, `give_value`,
`ratio`, `adj_ppg` and `active_probability` came back IDENTICAL everywhere —
value 10700/10787/10787/10700/10787, adj_ppg 14.77, active_probability 0.805.
The control variable is confirmed empirically, not just from the code.

Only the playoff odds moved: league 2 0.63 to 0.64 and league 4 0.24 to 0.25;
leagues 1, 3 and 5 unchanged at 0.62, 0.26, 0.90. **Drift floor is 0.01 in 2 of
5 leagues over 15 minutes**, and 0.01 is the unit of least precision
(`toFixed(2)` at `:1324`), so that is the smallest move this surface can
express. Read a post-fit move of 0.01 in one league as drift; 0.02+ as signal.

Best explanation, inferred not proven: the league payload refreshed.
`leagues.fetched_at` is in the fingerprint and `simulateSeason(lg, …)` reads the
payload's standings directly, which is the only path that moves the odds while
leaving every player-level number untouched — exactly the pattern seen. It
cannot be confirmed from outside the database.

Either way the deploy's own restart and league sync will move the odds for
reasons unrelated to the fit, which is why the capture taken between the deploy
and the fit is the only thing that separates code from data.
