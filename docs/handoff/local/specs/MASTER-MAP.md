# MASTER MAP: the one structure everything builds from (Nick, 9/27)

Every unit in the build queue names the tier and box it builds. Nothing gets built outside this map; if the map is wrong, change the map first. This file wins where the detail specs conflict with it:
- MODEL-POOL-V2.md
- WEIGHTS-RESEARCH.md
- TRADE-EVAL-V2.md
- COACH-HOME.md
- TEAMS-V2.md
- SPEND-TRACKER-UI.md
- CLEANUP.md

## North star
Nick makes the playoffs (league 4, 2026) and then wins titles, by making better decisions than his league-mates.

The edge comes from:
- (1) correct trade pricing: stars are overpriced and depth underpriced (FFA 12-season finding);
- (2) timing: late news and role changes;
- (3) people: reply timing, their calculators, their needs;
- (4) decision quality: the chain lookahead, robustness, the cost of waiting.

Raw projection accuracy is table stakes; the goal there is to match the best blend, not to beat it by points.

## Tiers (data to decision)

| # | Tier | Boxes | Status 9/27 |
|---|---|---|---|
| 0 | Harness | health pre-flight (processes, app on main, disk, flags, credits, usage); cleanup; registry | partial (hourly check); HARNESS-HEALTH and CLEANUP queued |
| 1 | Data sources | nflverse PBP/xFP, FTN routes/coverage, markets (lines, props, FC), ESPN/FantasyPros projections, news/injuries/practice/inactives, weather, league data, people signals (masked) | mostly in |
| 2 | History archive | point-in-time pre-kickoff snapshots of every expert; backfill 2019-2025 (ESPN from Nick's league box scores, FFA archive, Data Pros) | ESPN frozen capture since 9/25 only |
| 3 | Feature store | as-of cutoff features, bye/out flags, quality and stale flags | partial (E-XGB panel) |
| 4 | Replay lab | whole pipeline as-of every past week; the training and testing ground | not built (SEASON-REPLAY #496 is a start) |
| 5 | Expert pool | 14 families + Nick-as-expert; each emits a range (p10/p50/p90/boom) + a typed reason; opportunity × efficiency core; STAR-SHRINK | pieces exist (ESPN, E-XGB, xFP, BUY-LOW, radar, game script, weather), not unified |
| 6 | Reason ledger | typed taxonomy; graded hit rate with CI, size calibration, lead time; guards (min n, pooling, FDR, priced-in check) | radar event-effects table only |
| 7 | Trust gate | Bayesian reliability by context (never zero); one vote per idea (error covariance); reason boost; Hedge + changepoints; conformal ranges; complexity budget; must beat equal weights, ESPN and FantasyPros walk-forward | not built |
| 8 | Objective | Nick sets it: playoffs vs title, now vs next year, risk, 5 leagues; contention mode (league 4 to week 8) | goal + risk mode exist; contention mode approved, not built |
| 9 | Decision engine | season sim in every world (paired seeds, 2-flex, byes, injuries, real schedule); lineups incl. D/ST and K; trades + chain lookahead (P(yes)); waivers/flip claims; value over time; game theory (rivals); rules module every step at today's prices; comparative statics; scorecard (worlds won, EV, worst case, cost of waiting) | planner, chain (#534), rules and lineup exist |
| 10 | Coach | home page (merged with Today); trade story pages: verdict, chain, lineup before/after, debate for/against with reason records, belief sliders (re-sim live), flip triggers (watch news), people lane (Jev, reply clock, their calculators, send timing), rules checklist, counter ladder | Coach v2 + N&P + chain card exist; home and pages designed (COACH-HOME) |
| 11 | Grading and safety | outcomes; counterfactual grading of paths not taken; kill switches with ESPN / LAST-GOOD fallback; model registry (version, weights, seed; replay; roll back); the weekly loop back to tiers 6 and 7 | partial (hourly check, spend, number audit) |

## Build order: phases with acceptance bars

**Phase A, NOW (this week, for the playoff push)**
1. HARNESS-HEALTH, then CLEANUP (tier 0).
2. CONTENTION-MODE rules (tier 8), then send Nick the top 5 trades from the chain (tier 9). BAR: 0 rule breaks; each trade shows Δ playoff odds with SE, P(yes) and the Claude/Jev read.
3. STAR-SHRINK + luck regression applied to values used in trades (tier 5). BAR: calibration slope on a 2019-2025 backfill closer to 1.0 than raw ESPN.
4. #534 COACH-CHAIN merged with its gaps closed (FA starters in the odds, injuries all weeks). BAR: the consolidation fixture shows the per-slot cost.
5. PLAYOFF-ODDS-ONE (tier 9/10). BAR: every surface shows the same number.

**Phase B, week 2 (foundation)**
6. HISTORY-ARCHIVE backfill (tier 2). BAR: ≥ 5 seasons of ESPN weekly projected vs actual for Nick's leagues.
7. REPLAY LAB (tier 4). BAR: re-runs any past week bit-for-bit (the registry seed).
8. STACK v1: wire existing experts + equal-weight baseline (tier 5 → 7). BAR: beats ESPN alone on held-out weeks (paired CI).
9. REASON LEDGER v1 (tier 6), starting from the radar events and BUY-LOW. BAR: every reason shows n, hit rate CI and size calibration.

**Phase C, week 3+ (the edge)**
10. TRUST GATE (tier 7). BAR: beats equal weights walk-forward, or it stays off.
11. Decision-first scorecards + comparative statics (tier 9).
12. COACH-HOME units 1-6 + the debate page with sliders and flip triggers (tier 10).
13. SCREEN-GAP + people market (tiers 5 and 9).
14. Kill switches, registry, counterfactual grading (tier 11).
15. New expert families, one per unit, each through the ablation gate (tier 5): info timing, matchups, scheme, team health, crowd.
16. TEAMS-V2, NAV-SHELL, TWO-SCREEN (UI).

## Standing rules
- Hard trade rules live in never-give.js only.
- One producer per number.
- The AI narrates and never computes numbers.
- Public repo: no names or secrets.
- Additive migrations.
- Draft PRs, merged through the gate queue.
- Pre-register every model test.
- Walk-forward only.
- Every unit names its tier and box.
