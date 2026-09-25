# BUY-LOW results (rule v1)

<!-- prereg: docs/tdd/BUY-LOW-PREREG.md -->

Pre-registration: `docs/tdd/BUY-LOW-PREREG.md` (committed first, 73243895). Run: `node scripts/rnd/buy-low-backtest.mjs --db <copy>`
on a `.backup` copy of the local DB taken 2026-09-25 16:13 EDT (deleted after). Raw output: `BUY-LOW-results.json`.

Universe: 6,924 eligible player-weeks (2023-2025, as-of weeks 4-15); 367 flagged (295 confirmed, 72 detected);
246 had no baseline. Effect = next-3-week PPG gain over prior-3 PPG, flagged minus up to 5 matched non-flagged
(same season, week, position, prior-3 PPG within 2.0). 95% CI: 2,000 bootstrap resamples of player-season clusters.

## Primary: PASS

| | flagged rows | clusters | effect (pts/game) | 95% CI | verdict |
|---|---:|---:|---:|---|---|
| **Pooled** | 361 (6 no control) | 216 | **+1.91** | **[+1.18, +2.63]** | **pass** |
| QB | 86 | 53 | +1.70 | [+0.38, +2.93] | pass |
| RB | 96 | 58 | +2.24 | [+0.98, +3.56] | pass |
| WR | 152 | 85 | +1.89 | [+0.71, +3.17] | pass |
| TE | 27 | 20 | +1.44 | [-0.64, +4.10] | too few (< 30), not a pass |

Per season (not pre-registered, a stability check only): 2023 +1.90 [+0.69, +3.24], 2024 +1.80 [+0.59, +3.09],
2025 +2.01 [+0.89, +3.16].

## Secondary (reported, never decide)

| | effect | 95% CI |
|---|---:|---|
| Detected (1 game) only | +4.25 | [+2.55, +6.06] (n 69) |
| Confirmed (2+ games) only | +1.35 | [+0.63, +2.10] (n 292) |
| Controls also matched on xFP | **+0.67** | **[-0.20, +1.61]** (n 249, 118 no control) |
| Gap-only flag (no usage-trend rule) | +2.48 | [+1.97, +3.04] (n 751) |

## What this means, plainly

1. Flagged players do bounce back: about +1.9 points per game more than similar-scoring players over the next
   3 weeks, and the CI clears 0 at QB, RB and WR in every season checked. The pre-registered bar passes.
2. Almost all of that is the xFP gap (points below expected regress up). Once controls are also matched on
   xFP, what is left for the usage-trend rule is +0.67 with a CI that includes 0, and the gap-only flag
   (no usage rule) does at least as well. The "usage up" part is not shown to add anything on its own.
3. "Detected" beats "confirmed" here, the opposite of the research prior; on 69 rows, treat it as noise
   until a held-out season says otherwise.
4. Not tested: whether trade prices already reflect xFP. Beating a player's own recent points is not the same
   as beating the market's price for him (see the personnel-axis and props notes in project memory).

## Decision (per the pre-registration)

Pooled passes, so the recommendation is to turn GRIDIRON_BUY_LOW on for QB, RB and WR as a TIE-BREAKER ONLY
(its only served power). TE stays shadow (too few rows). No threshold was tuned on these seasons; a v2 that
drops the usage rule (secondary 4) needs its own pre-registration and a held-out season.
