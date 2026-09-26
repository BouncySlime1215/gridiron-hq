# U4 CONSISTENT-CHIP: results

<!-- prereg: docs/tdd/U4-CONSISTENT-CHIP-PREREG.md -->

**Verdict: FAIL. The reader stays unwired; A.J. Brown (277) stays locked.** `never-give.js#ajMayMove`
still gets no `consistentOf`, `SERVED_POSITIONS` is empty, and no flag was added (there is nothing to
switch on). Rule D's one producer is `scripts/rnd/consistent-chip.mjs`, not the prereg's planned
`server/services/campaign/consistent-chip.js`: an unwired module under `server/` fails the wiring gate
(module-reaches-no-surface), and study code stays out of production modules. The code is the same.

Pre-registration: `docs/tdd/U4-CONSISTENT-CHIP-PREREG.md`, committed first (`45f50100`).
Command: `node scripts/rnd/u4-consistent-backtest.mjs --db <copy of data.sqlite, 2026-09-25 21:28> --out docs/tdd/U4-CONSISTENT-CHIP.json`
(k = 1.71, 2,000 player-season cluster resamples, seed 20260925; tree in the PR body).

## Primary (pooled, 2024-2025, leagues 1:2024, 2:2024, 1:2025, 2:2025, 3:2025, W = 4..14)

| | flagged | unflagged | delta F (flagged - unflagged) | 95% CI | pass |
|---|---|---|---|---|---|
| rows | 69 | 978 | +0.06 pts | [-3.64, +4.27] | no |
| player-season clusters | **9** (bar 10) | 64 total | | | no |
| next-4 floor F (mean) | 13.53 | 13.47 | | | |
| shortfall under M (secondary, unflagged - flagged) | | | +1.60 | [-0.46, +4.01] | sign ok |

Fails bar 1 (9 flagged clusters < 10) and bar 2 (CI lower -3.64 <= 0). MDE at 80% power: 5.5 pts of
floor, against an observed +0.06.

## Per position (none served)

| pos | flagged rows (clusters) | delta F | 95% CI | verdict |
|---|---|---|---|---|
| QB | 0 (0) | n/a | n/a | too_few |
| RB | 31 (3) | -0.05 | [-4.07, +4.88] | too_few (clusters), CI straddles 0 |
| WR | 25 (4) | +1.13 | [-4.79, +9.13] | too_few |
| TE | 13 (2) | -0.91 | [-9.56, -0.06] | too_few, and favours UNflagged |

## Reported, not gating

- 2024 alone: +3.44 [-12.03, +7.24], 13 flagged rows (3 clusters). 2025 alone: -0.68 [-4.52, +5.18],
  56 rows (6 clusters).
- Adjusted for the mean (F residual after OLS on the production value, per position): -0.84
  [-4.47, +3.79]. Beyond what a player's scoring rate already says, the flag adds nothing measurable.
- NEXT-LEAP weekly bar: flagged rows' next-4 weeks at or over M 52.2% of the time (bar 70%);
  unflagged 46.2%.
- D0 (literal NEXT-LEAP clause, p25 against the median): 21 flagged rows in two seasons.
- Why rows are not consistent (a row can have several): p25 919, history 368, window_missing 282,
  inactive 59, hurt 18, of 1,047.
- Baselines (lagged a season): 2025 season M/L = QB 21.28/17.72, RB 17.75/17.01, WR 16.60/15.00,
  TE 12.35/10.46.

## League 4 now (live board 2026-09-26T01:22Z, DB copy, live env + GRIDIRON_CONSISTENT=1)

`node scripts/rnd/u4-consistent-league.mjs --db <copy> --plans <plans copy>`: as of week 4 (injury
report week 3), 21 Blue chips (83+). Rule D, read descriptively at every position, flags ONE: player
368 (WR, score 99, 6 of 6 window weeks over M, p25 15.59 vs line 12.69). Served (SERVED_POSITIONS
empty): none. So no step may give 277.

- Any 277 move: none. `check-rules-everywhere.mjs --league 4` on the copies: 10 of 10 surfaces pass,
  2 not run. The hourly check's rule block on the copies: no FAIL (only "number health: 0 broken").
- Next move before -> after: "keep your roster" (no path clears the sliders) -> unchanged.
- Caveat: 2026 week 3 has only Thursday's game in the copy, so most teams' windows reach back into
  2025 weeks 13-17.

## Statistical checklist (STATS-METHOD)

1. Prereg `45f50100`, an ancestor of this commit.
2. Ledger row L163 (a look at 2025), added in this commit.
3. Not an FL row (`other`): no BH entry.
4. Decline MDE80: 5.5 pts pooled (se 1.98).
5. Forward on 2026: not run (nothing ships); no flag.
6. Decision win rate: no producer (nothing served).
7. Replay configuration: not a replay; k = 1.71 from range-residuals.json (range_calibration empty on the copy).
8. Command beside every number above; tree in the PR body.

## What would change the answer

Nothing to re-run on these two seasons: nine player-seasons is the ceiling of what a strict
"consistent" flag finds among 83+ players in three leagues, and the mean-adjusted effect is negative.
Options for the coordinator, none taken here: (a) Nick picks the partner by hand and confirms (the
rule then reads his OK, not a model); (b) a new, committed addendum with more seasons (2021-2023 have
drafts only for leagues 1-2) before any re-test.
