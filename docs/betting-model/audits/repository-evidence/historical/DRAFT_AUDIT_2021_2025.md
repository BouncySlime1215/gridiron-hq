# Draft audit: preseason rank vs. realized PPR production, 2021–2025

Read-only audit of `server/data.sqlite`. Scripts and intermediates in `scratchpad/audit/`; machine-readable signals in `scratchpad/draft-audit-signals.json`.

## Bottom line for an 8-team, 16-round PPR redraft

1. **Rounds 2–4 (overall 13–36): take the RB over the WR.** RBs drafted there realized 72 VORP+ per pick vs 32 for WRs (n=42/54, diff 40, SE 12, t=3.4). RB won 4 of 5 seasons in each sub-tier (2022 is the lone WR year). Hit rate 50% vs 20%. An elite QB (ECR QB1–3, drafted 20–48 overall) returned 56 VORP+ per pick, indistinguishable from RBs there (t=−0.9) and well above WRs.
2. **Round 1 is a coin flip between RB and WR** (90 vs 77 VORP+, t=0.7). Both realize only ~65% of their slot's value; the first round has a 32% bust rate and 28% hit rate regardless of position.
3. **Rookie WRs are systematically under-ranked.** Rookie WRs in the top 150 beat their ECR slot by +17 pts on average vs −26 for veteran WRs (n=28/278, t=3.4); hit rate 64% vs 37%, and ≥50% in every season. No such edge for rookie RBs (vs slot +3, t=0.2).
4. **Do not draft a second QB or a second TE, and do not take TE9+ or QB11+ expecting starter value.** Replacement is QB11/TE8. Only 28% of QBs drafted QB13–24 finished above QB11; TEs drafted TE9–24 returned 3.3 VORP+ per pick (n=80) and only 15% finished above TE8. Spend those picks on RB/WR upside: RBs drafted 61–100 overall returned 19.5 VORP+ per pick vs 11.6 for WRs (n=63/73, t=1.7).
5. **Age curves are not supported once ECR is conditioned on.** RB ≥27 vs <27 (top-36 at position, n=48/132): no difference (t=−0.7). WR ≥30 (n=23): direction consistent with decline (hit 30% vs 37%, VORP+ 15 vs 37) but t=−1.3, not significant.

## Data and method (what was actually scorable)

- **Preseason rank:** `nfl_historical_adp`, source `dynastyprocess_fpecr` = FantasyPros expert consensus rank scraped July–Sept each year. This is ECR, not the league's ADP. 523–619 players per season; only QB/RB/WR/TE used (2,552 player-seasons).
- **Actuals:** `player_week_usage` (the table `backtest.js` scores from) could not be used. Its `player_id` goes through `players.gsis_id`, which is corrupted for some rows: `players.id 424 "Noah Gray"` carries Travis Kelce's gsis `00-0030506`, and Isiah Pacheco's row points at a 2026 rookie, so Kelce, Kamara, Andrews, Murray, Ridley and Pacheco had zero weekly rows under their own ids. Instead, season PPR points were recomputed from `nfl_player_week_features` (play-by-play derived, keyed by the true gsis_id), weeks 1–18, with the exact `scoring.js` PPR weights (0.04/4/−2 pass, 0.1/6 rush, 1/0.1/6 rec). That table has no fumbles-lost column, so fumbles are omitted (about 1–4 pts/season for RB/QB).
- **Validation of the actuals:** vs ESPN's own 2025 totals in `player_season_stats` (n=413): r=0.9987, mean difference +0.15 pts, MAD 1.30. Vs nflverse ffopportunity `actual_fantasy_points` 2022–2025 (n=1,742): r=0.9999, MAD 0.85, games-played difference −0.02. No top-150 player has a material residual.
- **Join:** ECR `player_key` (`normalizePlayerName`) matched to gsis through full names in `nfl_depth`, `nfl_injuries`, `nfl_ffopportunity_weekly`, `nfl_roster_snapshots`, with position match, then nflverse's abbreviated name (e.g. "R.White") and team as tie-breaks. Seven explicit aliases for name changes (Hollywood Brown, Robbie Anderson, Kenneth Walker, Gabe Davis, Kenny Gainwell, Chig Okonkwo, Josh Palmer). Result: **2,182 matched; 289 known players with no stat line, scored 0 pts / 0 games (8 inside the top 150: Dobbins, Etienne, Gus Edwards, Michael Thomas, Irv Smith in 2021; Tim Patrick 2022; Mixon, Aiyuk 2025, all genuine DNPs); 0 ambiguous; 81 unmatched, all outside the top 150, excluded.** Every season scored; top-150 coverage 148/149/150/150/149.
- **Ranks and tiers:** overall tier = integer order of `ecr_rank` within the season (K/DST included; skill-only ordering changes no result). Positional draft rank = order within position. Finish rank = order by actual PPR among every player at the position that season (ECR-listed DNPs sit at the bottom with 0).
- **Definitions:** hit = finished at or above drafted positional rank; hit ±6 = within 6 spots; bust = finished ≥12 positional spots lower (two 6-slot tiers) or played ≤8 games. VORP = points minus the QB11 / RB27 / WR27 / TE8 finisher that season (8-team demand); VORP+ = max(0, VORP). Expected VORP+ of a slot = points of the player who actually finished at the drafted positional rank, minus replacement, floored at 0. Realized fraction = ΣVORP+ / Σexpected VORP+.
- **Replacement points by season** (QB11/RB27/WR27/TE8): 2021 301/163/203/164; 2022 287/168/189/147; 2023 278/183/215/181; 2024 287/181/201/173; 2025 282/167/183/184.
- **Sample sizes:** each positional tier 1–6 … 19–24 is exactly n=30 (6 per season × 5); 25–36 is n=58–60. Per-season cells are n=6 and are shown only to expose how noisy they are. Age available for 733 of 746 top-150 player-seasons via `nflverse_player_positions.birth_date`; rookie = `rookie_season == season`.

## What the tiers delivered

Reading guide: hit rate in deep tiers is inflated by construction (a QB25 "hits" whenever enough players above him bust), so past the first three positional tiers read VORP+ and bust rate, not hit rate. "vs tier top" = mean points minus that season's top-drafted player in the tier. "Realized" = fraction of the slot's value the tier delivered; it is undefined ("–") where the slot itself sits below replacement, and unstable (>1.5) where the slot is barely above it.

All positions pooled by overall ECR tier: 1–12 (n=60): hit 28%, bust 32%, realized 64%. 13–24 (n=60): 33% / 32% / 79%. 25–36 (n=60): 28% / 38% / 68%. 37–60 (n=120): 34% / 38% / 99%. 61–100 (n=200): slot value is at replacement, realized value is pure upside at 15 VORP+ per pick. 101–150 (n=246): 7 VORP+ per pick.

### Positional tiers, pooled 2021–2025

| Pos | Tier | n | Hit | Hit ±6 | Bust | ≤8 gm | Mean pts | Median | vs tier top | Mean VORP | VORP+ | Exp VORP+ | Realized |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QB | 1-6 | 30 | 27% | 50% | 23% | 7% | 294.8 | 294.8 | -66.3 | 7.8 | 40.2 | 71 | 0.567 |
| QB | 7-12 | 30 | 37% | 60% | 23% | 17% | 247.5 | 275.5 | -52.9 | -39.6 | 19.7 | 10.4 | 1.885 |
| QB | 13-18 | 30 | 57% | 73% | 10% | 10% | 242.4 | 252 | -11.5 | -44.7 | 10.7 | 0 | – |
| QB | 19-24 | 30 | 43% | 70% | 20% | 17% | 190.9 | 170.8 | 47.5 | -96.1 | 7.7 | 0 | – |
| QB | 25-36 | 58 | 53% | 72% | 33% | 31% | 147.2 | 149.7 | -49.9 | -139.9 | 1.6 | 0 | – |
| RB | 1-6 | 30 | 30% | 57% | 27% | 13% | 262.5 | 246.7 | 1.8 | 90.1 | 101.5 | 149.7 | 0.678 |
| RB | 7-12 | 30 | 50% | 70% | 27% | 3% | 239.1 | 242.6 | 12.1 | 66.6 | 74.9 | 77 | 0.972 |
| RB | 13-18 | 30 | 33% | 57% | 33% | 10% | 184.9 | 198.1 | 5.2 | 12.5 | 39.7 | 49.4 | 0.804 |
| RB | 19-24 | 30 | 40% | 50% | 40% | 27% | 155.2 | 167.3 | 12.6 | -17.2 | 23.9 | 23.8 | 1.003 |
| RB | 25-36 | 60 | 43% | 58% | 35% | 15% | 139.7 | 148 | 11.7 | -32.7 | 14.7 | 0.9 | 16.41 |
| WR | 1-6 | 30 | 40% | 57% | 33% | 7% | 272 | 292 | -26.8 | 73.9 | 86.4 | 129.9 | 0.665 |
| WR | 7-12 | 30 | 20% | 43% | 40% | 3% | 225.5 | 222.9 | -54.2 | 27.3 | 39.6 | 55.7 | 0.71 |
| WR | 13-18 | 30 | 27% | 50% | 47% | 13% | 194.7 | 206.1 | 28.5 | -3.4 | 23.9 | 32.8 | 0.731 |
| WR | 19-24 | 30 | 37% | 50% | 37% | 3% | 191.4 | 199.6 | -16.2 | -6.7 | 18.4 | 16.2 | 1.134 |
| WR | 25-36 | 60 | 47% | 50% | 47% | 17% | 169.6 | 175.7 | 7.4 | -28.5 | 18.3 | 0.9 | 21.231 |
| TE | 1-6 | 30 | 23% | 57% | 30% | 3% | 177.2 | 175.6 | -53.1 | 7.2 | 30 | 47.7 | 0.628 |
| TE | 7-12 | 30 | 37% | 57% | 30% | 10% | 143 | 140.3 | 8.3 | -27 | 10.1 | 0.4 | 28.491 |
| TE | 13-18 | 30 | 43% | 53% | 27% | 17% | 116.9 | 118.3 | -12.3 | -53.1 | 1.3 | 0 | – |
| TE | 19-24 | 30 | 50% | 80% | 20% | 7% | 114.5 | 119 | -36 | -55.5 | 3.4 | 0 | – |
| TE | 25-36 | 59 | 39% | 51% | 41% | 12% | 85 | 73.2 | 0.3 | -85.1 | 1.7 | 0 | – |

### Overall ECR tiers by position, pooled 2021–2025

| Pos | Overall tier | n | Hit | Hit ±6 | Bust | ≤8 gm | Mean pts | Median | Mean VORP | VORP+ | Exp VORP+ | Realized |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QB | 1-12 | 0 | | | | | | | | | | |
| QB | 13-24 | 4 | 25% | 75% | 0% | 0% | 340.4 | 348.8 | 56.8 | 56.8 | 113.9 | 0.499 |
| QB | 25-36 | 9 | 33% | 67% | 22% | 11% | 322.8 | 367.3 | 37.8 | 63.3 | 84.9 | 0.745 |
| QB | 37-60 | 14 | 21% | 29% | 29% | 7% | 263.5 | 240.9 | -23.6 | 22.1 | 58.6 | 0.377 |
| QB | 61-100 | 39 | 39% | 62% | 21% | 13% | 251.2 | 275.3 | -36.7 | 19.8 | 10.3 | 1.919 |
| QB | 101-150 | 39 | 54% | 74% | 15% | 13% | 225.4 | 230.2 | -61.4 | 10.2 | 0 | – |
| RB | 1-12 | 27 | 22% | 52% | 33% | 11% | 253.8 | 239.5 | 83.3 | 90.5 | 146.2 | 0.619 |
| RB | 13-24 | 21 | 48% | 71% | 19% | 10% | 244.1 | 247.1 | 72.6 | 88.4 | 90.9 | 0.973 |
| RB | 25-36 | 21 | 48% | 62% | 38% | 14% | 202.4 | 208.9 | 29.4 | 55.5 | 64.2 | 0.865 |
| RB | 37-60 | 37 | 24% | 46% | 41% | 19% | 168.1 | 167.6 | -2.7 | 32.2 | 38.9 | 0.827 |
| RB | 61-100 | 63 | 49% | 59% | 33% | 13% | 150.6 | 163.8 | -22.9 | 19.5 | 6.5 | 3.004 |
| RB | 101-150 | 80 | 44% | 56% | 38% | 14% | 117.4 | 113.7 | -55.7 | 9.4 | 0 | – |
| WR | 1-12 | 31 | 32% | 55% | 32% | 3% | 266.2 | 263.4 | 67.7 | 77 | 119.2 | 0.646 |
| WR | 13-24 | 30 | 27% | 47% | 47% | 13% | 220.1 | 222.9 | 21.4 | 42.9 | 60.1 | 0.714 |
| WR | 25-36 | 24 | 17% | 42% | 46% | 8% | 188.9 | 210.1 | -8.8 | 17.5 | 35.6 | 0.492 |
| WR | 37-60 | 60 | 42% | 50% | 42% | 12% | 188.3 | 198.9 | -9.6 | 23.9 | 12 | 1.986 |
| WR | 61-100 | 73 | 49% | 56% | 36% | 11% | 160.3 | 165.4 | -38.5 | 11.6 | 0.2 | 52.738 |
| WR | 101-150 | 88 | 42% | 49% | 49% | 9% | 122.4 | 109.5 | -75.9 | 5.1 | 0 | – |
| TE | 1-12 | 2 | 50% | 100% | 0% | 0% | 268.9 | 268.9 | 104.7 | 104.7 | 111.6 | 0.938 |
| TE | 13-24 | 5 | 20% | 60% | 20% | 0% | 215.4 | 188.5 | 46.6 | 54.7 | 91.5 | 0.599 |
| TE | 25-36 | 6 | 0% | 50% | 33% | 0% | 157.4 | 168.1 | -13.2 | 10.1 | 53 | 0.192 |
| TE | 37-60 | 9 | 44% | 67% | 22% | 11% | 185.7 | 188.8 | 19.4 | 36.2 | 36.4 | 0.995 |
| TE | 61-100 | 25 | 20% | 44% | 40% | 8% | 134.7 | 131.2 | -37.1 | 8.4 | 4.6 | 1.815 |
| TE | 101-150 | 39 | 46% | 59% | 26% | 13% | 129.6 | 126.1 | -39.2 | 3.4 | 0 | – |

### Per-season hit / bust by positional tier (n in parentheses)

| Pos | Tier | 2021 hit / bust | 2022 hit / bust | 2023 hit / bust | 2024 hit / bust | 2025 hit / bust |
|---|---|---|---|---|---|---|
| QB | 1-6 | 17% / 17% (6) | 33% / 17% (6) | 50% / 17% (6) | 17% / 17% (6) | 17% / 50% (6) |
| QB | 7-12 | 83% / 0% (6) | 17% / 33% (6) | 33% / 33% (6) | 33% / 17% (6) | 17% / 33% (6) |
| QB | 13-18 | 33% / 0% (6) | 83% / 0% (6) | 33% / 50% (6) | 33% / 0% (6) | 100% / 0% (6) |
| QB | 19-24 | 17% / 33% (6) | 17% / 33% (6) | 83% / 0% (6) | 67% / 17% (6) | 33% / 17% (6) |
| QB | 25-36 | 42% / 42% (12) | 46% / 36% (11) | 58% / 33% (12) | 58% / 17% (12) | 64% / 36% (11) |
| RB | 1-6 | 17% / 50% (6) | 33% / 17% (6) | 17% / 33% (6) | 50% / 33% (6) | 33% / 0% (6) |
| RB | 7-12 | 50% / 17% (6) | 33% / 17% (6) | 33% / 50% (6) | 67% / 33% (6) | 67% / 17% (6) |
| RB | 13-18 | 33% / 50% (6) | 33% / 17% (6) | 33% / 50% (6) | 50% / 0% (6) | 17% / 50% (6) |
| RB | 19-24 | 17% / 50% (6) | 17% / 67% (6) | 50% / 50% (6) | 67% / 0% (6) | 50% / 33% (6) |
| RB | 25-36 | 42% / 42% (12) | 50% / 42% (12) | 42% / 8% (12) | 25% / 50% (12) | 58% / 33% (12) |
| WR | 1-6 | 17% / 33% (6) | 67% / 17% (6) | 33% / 33% (6) | 50% / 33% (6) | 33% / 50% (6) |
| WR | 7-12 | 0% / 50% (6) | 33% / 33% (6) | 33% / 33% (6) | 17% / 50% (6) | 17% / 33% (6) |
| WR | 13-18 | 67% / 33% (6) | 17% / 50% (6) | 17% / 17% (6) | 17% / 67% (6) | 17% / 67% (6) |
| WR | 19-24 | 33% / 17% (6) | 33% / 67% (6) | 33% / 33% (6) | 33% / 33% (6) | 50% / 33% (6) |
| WR | 25-36 | 33% / 58% (12) | 67% / 25% (12) | 33% / 50% (12) | 42% / 58% (12) | 58% / 42% (12) |
| TE | 1-6 | 33% / 17% (6) | 33% / 33% (6) | 0% / 33% (6) | 17% / 33% (6) | 33% / 33% (6) |
| TE | 7-12 | 33% / 33% (6) | 50% / 0% (6) | 50% / 33% (6) | 33% / 33% (6) | 17% / 50% (6) |
| TE | 13-18 | 33% / 33% (6) | 33% / 33% (6) | 33% / 17% (6) | 33% / 33% (6) | 83% / 17% (6) |
| TE | 19-24 | 33% / 33% (6) | 67% / 0% (6) | 50% / 33% (6) | 67% / 17% (6) | 33% / 17% (6) |
| TE | 25-36 | 36% / 36% (11) | 25% / 58% (12) | 50% / 25% (12) | 42% / 33% (12) | 42% / 50% (12) |

### Realization multipliers (position × overall ECR tier)

| Pos | 1-12 | 13-24 | 25-36 | 37-60 | 61-100 | 101-150 |
|---|---|---|---|---|---|---|
| QB | – | 0.53 (n=4*) | 0.79 (n=9*) | 0.40 (n=14*) | 2.03 (n=39) | n/a (n=39, 10.2 VORP+/pick) |
| RB | 0.65 (n=27) | 1.03 (n=21*) | 0.91 (n=21*) | 0.87 (n=37) | n/a (n=63, 19.5 VORP+/pick) | n/a (n=80, 9.4 VORP+/pick) |
| WR | 0.68 (n=31) | 0.75 (n=30) | 0.52 (n=24*) | 2.10 (n=60) | n/a (n=73, 11.6 VORP+/pick) | n/a (n=88, 5.1 VORP+/pick) |
| TE | 0.99 (n=2*) | 0.63 (n=5*) | 0.20 (n=6*) | 1.05 (n=9*) | n/a (n=25, 8.4 VORP+/pick) | n/a (n=39, 3.4 VORP+/pick) |

### Trend: RB drafted RB7–RB18

| Season | n | Hit | Bust | ≤8 games |
|---|---|---|---|---|
| 2021 | 12 | 42% | 33% | 17% |
| 2022 | 12 | 33% | 17% | 8% |
| 2023 | 12 | 33% | 50% | 0% |
| 2024 | 12 | 58% | 17% | 8% |
| 2025 | 12 | 42% | 33% | 0% |

### Trend: WR drafted overall 61–100

| Season | n | Hit | Hit ±6 | VORP+/pick |
|---|---|---|---|---|
| 2021 | 18 | 28% | 28% | 15.2 |
| 2022 | 15 | 73% | 80% | 21.5 |
| 2023 | 16 | 50% | 56% | 7 |
| 2024 | 11 | 55% | 55% | 8.4 |
| 2025 | 13 | 46% | 69% | 3.8 |

### Rookies (first NFL season) vs veterans, drafted top-150 overall

| Pos | Group | n | Hit | Hit ±6 | Bust | Mean pts | vs slot | VORP+ |
|---|---|---|---|---|---|---|---|---|
| QB | rookie | 4 | 25% | 50% | 25% | 221.7 | -40.5 | 16 |
| QB | veteran | 101 | 42% | 63% | 19% | 254 | -32 | 21.9 |
| RB | rookie | 26 | 50% | 62% | 39% | 138.6 | -19.6 | 20.1 |
| RB | veteran | 223 | 40% | 56% | 35% | 169.1 | -22.8 | 36.4 |
| WR | rookie | 28 | 64% | 64% | 29% | 169.6 | 16.9 | 15.1 |
| WR | veteran | 278 | 37% | 49% | 44% | 174.1 | -25.5 | 23.1 |
| TE | rookie | 5 | 100% | 100% | 0% | 189 | 38.4 | 21.2 |
| TE | veteran | 81 | 30% | 53% | 31% | 144.6 | -30.7 | 13.7 |

Rookie hit rate by season (n): QB: 2021 0% (1), 2022 – (0), 2023 0% (1), 2024 50% (2), 2025 – (0); RB: 2021 60% (5), 2022 67% (6), 2023 40% (5), 2024 0% (3), 2025 57% (7); WR: 2021 100% (4), 2022 71% (7), 2023 50% (4), 2024 57% (7), 2025 50% (6); TE: 2021 100% (1), 2022 – (0), 2023 100% (1), 2024 100% (1), 2025 100% (2)

### Age (drafted top-36 at position, age on Sept 1)

| Pos | Age | n | Hit | Bust | ≤8 gm | Mean pts | vs slot | VORP+ |
|---|---|---|---|---|---|---|---|---|
| RB | <=23 | 44 | 39% | 43% | 18% | 183.4 | -45.6 | 49.1 |
| RB | 24-26 | 88 | 40% | 28% | 11% | 186.1 | -19.2 | 40.1 |
| RB | 27-28 | 33 | 39% | 27% | 12% | 197.7 | -36.8 | 47.9 |
| RB | 29+ | 15 | 47% | 40% | 20% | 177.9 | -38.7 | 53.9 |
| RB | <27 | 132 | 39% | 33% | 14% | 185.2 | -28 | 43.1 |
| RB | >=27 | 48 | 42% | 31% | 15% | 191.5 | -37.4 | 49.8 |
| WR | <=24 | 64 | 38% | 42% | 9% | 208.5 | -27.2 | 40.3 |
| WR | 25-27 | 59 | 37% | 39% | 9% | 205.8 | -26.1 | 29.9 |
| WR | 28-29 | 34 | 35% | 41% | 9% | 209.5 | -32 | 42.6 |
| WR | 30+ | 23 | 30% | 48% | 17% | 177.3 | -48 | 15.4 |
| WR | <30 | 157 | 37% | 41% | 9% | 207.7 | -27.8 | 36.9 |
| WR | >=30 | 23 | 30% | 48% | 17% | 177.3 | -48 | 15.4 |

RB age by positional tier (young <27 / old ≥27: n, hit, vs slot): 1-6: young n=19 21% -55.8 | old n=11 46% -66.3; 7-12: young n=22 50% -17.2 | old n=8 50% 8.3; 13-18: young n=22 36% -33.1 | old n=8 25% -47.3; 19-24: young n=23 39% -41.3 | old n=7 43% -39.8; 25-36: young n=46 44% -12.4 | old n=14 43% -33.8

WR age by positional tier (young <30 / old ≥30): 1-6: young n=28 43% -51.2 | old n=2 0% -124; 7-12: young n=27 22% -27.3 | old n=3 0% -38; 13-18: young n=24 21% -32.5 | old n=6 50% -50.8; 19-24: young n=25 44% -13.7 | old n=5 0% -68.9; 25-36: young n=53 45% -20.3 | old n=7 57% -13.2

### Two-sample comparisons (mean VORP+ unless noted; vs_slot = pts minus the slot's finisher)

| Comparison | nA | nB | mean A | mean B | diff | SE | t |
|---|---|---|---|---|---|---|---|
| RB_vs_WR_ov_13-24 | 21 | 30 | 88.4 | 42.9 | 45.5 | 18.2 | 2.5 |
| RB_vs_WR_ov_25-36 | 21 | 24 | 55.5 | 17.5 | 38 | 13.8 | 2.76 |
| RB_vs_WR_ov_37-60 | 37 | 60 | 32.2 | 23.9 | 8.3 | 9.3 | 0.89 |
| RB_vs_WR_ov_61-100 | 63 | 73 | 19.5 | 11.6 | 7.8 | 4.6 | 1.71 |
| RB_vs_WR_ov_101-150 | 80 | 88 | 9.4 | 5.1 | 4.2 | 3 | 1.43 |
| RB_vs_WR_ov_19_36 | 30 | 38 | 58.1 | 24.6 | 33.4 | 12.4 | 2.71 |
| RB_vs_WR_ov_37_100 | 100 | 133 | 24.2 | 17.2 | 7 | 4.6 | 1.51 |
| QB_1_3_vs_4_10 | 15 | 35 | 56.4 | 23.2 | 33.2 | 14.6 | 2.27 |
| TE_1_3_vs_4_8 | 15 | 25 | 43.6 | 17.1 | 26.5 | 15.1 | 1.75 |
| TE_4_8_vs_9_16 | 25 | 40 | 17.1 | 3.2 | 13.9 | 6.9 | 2.02 |
| QB_4_10_vs_11_18 | 35 | 40 | 23.2 | 11.5 | 11.8 | 7.2 | 1.64 |
| RB_old_vs_young_top36 | 48 | 132 | -37.4 | -28 | -9.4 | 13.8 | -0.68 |
| WR_old_vs_young_top36 | 23 | 157 | -48 | -27.8 | -20.1 | 15.5 | -1.3 |
| rookieRB_vs_vetRB_top150 | 26 | 223 | -19.6 | -22.8 | 3.2 | 15.9 | 0.2 |
| rookieWR_vs_vetWR_top150 | 28 | 278 | 16.9 | -25.5 | 42.5 | 12.4 | 3.41 |

### RB vs WR VORP+/pick by overall tier and season (nRB/nWR)

| Season | 13-24 | 25-36 | 37-60 | 61-100 |
|---|---|---|---|---|
| 2021 | RB 120.6 / WR 45 (5/5) | RB 11.8 / WR 14.2 (4/6) | RB 12.7 / WR 50.8 (9/9) | RB 14.4 / WR 15.2 (10/18) |
| 2022 | RB 62 / WR 95.6 (5/6) | RB 52 / WR 30.5 (4/6) | RB 22.1 / WR 21 (8/11) | RB 19.7 / WR 21.5 (12/15) |
| 2023 | RB 34.5 / WR 25 (5/6) | RB 31.5 / WR 9.2 (5/4) | RB 43.4 / WR 11.5 (5/13) | RB 18.7 / WR 7 (15/16) |
| 2024 | RB 85.1 / WR 15.4 (2/8) | RB 93.2 / WR 12.2 (4/4) | RB 61.9 / WR 15.9 (6/13) | RB 18.3 / WR 8.4 (14/11) |
| 2025 | RB 150.4 / WR 43.1 (4/5) | RB 95.2 / WR 16.5 (4/4) | RB 34.6 / WR 27.9 (9/14) | RB 25.8 / WR 3.8 (12/13) |

Notes on the multiplier table: `*` marks n<25. "n/a" cells are tiers whose slot sits at or below replacement, where a ratio is meaningless; the absolute VORP+ per pick is given instead and is what should drive those picks. The JSON caps raw ratios to [0.5, 1.5] (QB 61–100 raw 2.03, WR 37–60 raw 2.10, TE 25–36 raw 0.20, QB 37–60 raw 0.40) and records the raw value alongside. The multiplier scales a projected edge; where the absolute numbers disagree with it (RB 37–60: multiplier 0.87 but 32 VORP+/pick vs WR's 1.5 and 24 VORP+/pick), it is because WR slots in that range sit close to replacement, so a modest overperformance is a large ratio.

## Signals (in the JSON)

- `realization`: {position: {overallTier: multiplier, raw_multiplier, n, realized_fraction, expected_vorp_plus_per_pick, realized_vorp_plus_per_pick, hit_rate, bust_rate, note}} normalized so the expected-value-weighted pooled mean of raw multipliers is 1.0 (pooled realized fraction 0.946).
- `rules`: (1) RB over WR at overall 13–36; (2) rookie-WR premium; (3) TE cliff after TE8 in 8-team; (4) elite QB1–3 worth an early pick, QB4–10 not, QB11+ free. Each carries n, effect size, SE and t.
- `not_supported`: RB-27 and WR-30 age cliffs, an RB7–18 bust-rate trend, and a rising late-WR hit rate. RB7–18 bust rate by season is 33/17/50/17/33% (n=12 each). WR 61–100 hit rate is 28/73/50/55/46%, flat-to-noisy, while its realized VORP+ per pick fell 15→22→7→8→4 as RB 61–100 held at 14–26.

## Caveats

- ECR is one preseason snapshot per season and is not the league's own ADP; a league that drafts RBs earlier than ECR would see a smaller RB edge.
- Five seasons; n=30 per positional tier. Anything at the per-season level is noise. Effects reported with t<2 should be read as leans, not rules.
- The RB-over-WR result is concentrated in 2023–2025 (and 2021); 2022 went the other way. It is a real 5-year pattern, not a guarantee for 2026.
- Fumbles are absent from actuals. Hit/bust are rank-based and unaffected; VORP is shifted by at most a few points.
