# BUY-LOW v2 (gap-only) results

<!-- prereg: docs/tdd/BUY-LOW-V2-PREREG.md -->

Pre-registration: `docs/tdd/BUY-LOW-V2-PREREG.md`, committed before this run (`npm run check:prereg-order`).
Run: `node scripts/rnd/buy-low-v2-backtest.mjs --db <copy>` on a `.backup` copy of the local DB, taken
2026-09-25 (deleted after). Raw output: `BUY-LOW-V2-results.json`. The v1 backtest re-run on the same copy
reproduced `BUY-LOW-results.json` byte for byte.

## Primary (held-out 2021-2022, 4,688 eligible player-weeks): REPLACE v1 with v2

| | v1 (usage up + gap) | v2 (gap only) | v2 - v1 |
|---|---|---|---|
| Flagged rows | 211 | 592 | |
| **Pooled** | +0.84 [+0.02, +1.68] | **+1.98 [+1.37, +2.60]** | **+1.14 [+0.50, +1.82]** |
| QB | +0.39 [-0.99, +1.81] (62) | +1.38 [+0.32, +2.41] (167) | +0.98 [-0.28, +2.19] |
| RB | +0.83 [-1.41, +3.17] (43) | +2.56 [+0.81, +4.25] (105) | +1.73 [+0.16, +3.34] |
| WR | +0.83 [-0.42, +2.11] (84) | +2.03 [+1.19, +2.94] (245) | +1.20 [+0.24, +2.21] |
| TE | +2.19 [+0.27, +4.35] (22, too few) | +2.55 [+1.17, +4.17] (53) | +0.36 [-1.07, +1.70] |

Effects are the next-3-week PPG gain over prior-3 PPG, minus matched controls. The CIs are 95% cluster
bootstraps (2,000 resamples of player-seasons, seed 20260925).

- Bar 1: v2's pooled CI lower bound, +1.37, is above 0. **Pass.**
- Bar 2: the v2 - v1 lower bound, +0.50, is above -0.5. **Pass.** The CI is fully above 0, so v2 is better, not just no worse.
- Decision: replace v1 with v2 as the served rule, still a tie-breaker only. v2 serves at QB, RB, WR and TE,
  since each has 30+ rows and a CI lower bound above 0. TE still needs GRIDIRON_BUY_LOW_TE=1.

## Secondary (never decide)

- 2023-2025, already seen and not new evidence: v1 +1.91 [+1.18, +2.63], v2 +2.48 [+1.97, +3.04], diff +0.58 [+0.11, +1.03].
- v2 with controls also matched on xFP, held-out: +1.06 [+0.30, +1.85] pooled (QB +1.94, RB +1.28, WR +0.66,
  TE +1.08; only QB's CI clears 0 on its own). 229 rows had no xFP-matched control.

## Plainly

1. The usage-up rule was costing signal. It flags a third as many players, and on held-out seasons v1
   barely clears 0 pooled, with no single position passing on its own. The gap alone is stronger and
   replicates: +2.0 held-out against +2.5 on the seen seasons.
2. v1's held-out weakness matters for the flag already switched on. Its evidence was the 2023-2025 run;
   2021-2022 shows it about half as strong, with no position passing alone.
3. Still not tested: whether trade prices already reflect this gap. Beating a player's own recent points is not
   the same as buying below his market price.
