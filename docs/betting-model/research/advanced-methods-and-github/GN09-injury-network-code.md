# GN09 — Injury-impact / depth-chart-propagation network models: search results

## Verdict up front

**No credible open-source injury-impact network or depth-chart-propagation network model exists in sports analytics repos.** Searched GitHub (`gh search repos`, ~25 query variants: "injury propagation NFL", "depth chart projection fantasy football", "injury replacement value sports analytics", "player substitution network graph", "next man up", "injury cascade sports", etc.) and the open web (Google-Scholar-style queries for "injury network" + "propagation" + "depth chart" + "replacement value" + "Bayesian roster spillover"). What exists in public repos falls into four buckets, none of which is a network/graph model that propagates one player's absence through teammates' usage:

1. **Injury epidemiology toolkits** (burden/incidence/survival stats on individual players) — real, published, but answer "how often do players get hurt," not "what happens to the rest of the roster when one does."
2. **Individual injury-risk classifiers** (ML predicting whether *this* player gets hurt, or whether an already-injured player suits up) — single-player, no team-impact propagation.
3. **Naive fantasy injury handling** (Monte Carlo draft sims that randomly assign an injury shock with no downstream redistribution logic; DFS optimizers that don't model injury at all beyond an exclude-player checkbox).
4. **Replacement-value / WAR methodology** (a real, relevant *idea* — define replacement level, measure the gap — but implemented as a stale, unlicensed single-paper R package with no network structure and no depth-chart mechanics).

None of the four buckets contains what the task asked for: a model where injury to Player A produces quantified, position-aware redistribution to Players B, C, D via depth-chart edges (target share, carry share, snap share, protection assignments). This is a real gap in the public sports-analytics repo ecosystem, not a search-diligence failure — it is also, not coincidentally, a gap in Gridiron's own code (see below).

## What Gridiron already has (read-only grep of fantasy-football-dashboard, no edits made)

- `server/db/schema/nfl-a-to-m.js:53` — `CREATE TABLE nfl_snaps` (per-player, per-week offense/defense snap counts and pct).
- `server/db/schema/nfl-a-to-m.js:59` — `CREATE TABLE nfl_depth` (per-player depth-chart order, indexed by `gsis_id, season, week` at line 617).
- `server/services/nfl-player-value.js` — computes a **single-player** replacement-value gap ("value is... the gap between the role/quality a player supplied... and the next player the depth chart says will take those snaps"). Uses a **hand-tuned constant table** `POSITION_VALUE` (QB 4.8, WR 1.0, T 0.75, etc., lines ~28-35) as "a monotone prior, not production coefficients" — explicitly not empirically fit. It answers "how much does the departing player's own line lose," not "where does the vacated production actually go and to whom."
- `server/services/who-plays.js` — joins official/news/snap-share signals into one play-probability + `expected_snaps_lost` per player, with an honest precedence rule and disagreement reporting. This is the availability layer the propagation model would consume as input — it does not itself redistribute anything.
- `server/services/role-changepoint.js` — retrospectively *detects* sustained role changes (2 recent games moving the same direction past a materiality threshold, corroborated by snap share) — this is a labeled-event detector for role shifts, useful as ground truth to fit propagation coefficients against, but it is backward-looking confirmation, not a forward propagation model triggered by a new injury.

So: Gridiron has the depth-chart table, the snap-share table, the availability signal, and a historical role-change-event detector — all four ingredients a propagation model needs — but nothing joins "Player A is out" to "Players B/C/D's projected usage moves by X" except a single-player replacement-value constant. This is exactly the shape of an original, bounded, buildable capability, not a research dead end.

## Repos checked in detail

### lzumeta/injurytools — cloned
- License: MIT. Stars: 7. Last push: 2026-01-30 (active). Language: R.
- What it actually does (read, not README): an R package for **sports injury epidemiology** — computes injury incidence/prevalence/burden, survival-style time-loss curves, and a risk-matrix visualization (`R/gg_riskmatrix.R` — a 2D severity × frequency plot, not a graph/network). `grep -l network` across `R/*.R` returns only `utils.R` and `gg_riskmatrix.R`, and in both cases "network" appears as unrelated prose/variable naming, not a graph model. No depth-chart, roster, or substitution concept anywhere in the package — it treats one player's injury history in isolation.
- Adopt: **borrow-idea** (the risk-matrix chart type is a clean way to visualize a position group's injury-exposure/severity distribution) — not port/call, since it solves a different problem (surveillance, not propagation) and is R, not Gridiron's JS stack.
- Gridiron attachment: none directly; would only inform a diagnostic chart on top of `nfl_injuries`, not the propagation model itself.

### ryurko/nflWAR — reference-only, not cloned (57KB R package, checked via GitHub API metadata + arXiv paper 1802.00998)
- License: none set (all-rights-reserved by default — cannot legally port code). Stars: 38. Last push: 2018-09-18 (stale — built on nflscrapR, which was retired years ago and superseded by nflfastR/nflreadr).
- What it does: multilevel-model WAR for offensive players, using a **roster-based replacement-level definition** (the actual academic contribution worth taking). It is a single-player point-value metric, not a network — no propagation, no depth-chart mechanics.
- Adopt: **borrow-idea only** (the *methodology* for defining replacement level empirically from the observed backup pool, rather than a hand-tuned constant) — directly relevant to fixing `nfl-player-value.js`'s `POSITION_VALUE` table, which the file's own comment admits is "a monotone prior, not production coefficients."
- Gridiron attachment: `server/services/nfl-player-value.js` — replace/calibrate `POSITION_VALUE` against Gridiron's own `player_week_usage` + `nfl_depth` history (an empirical, position-group-specific replacement-level distribution) instead of the current fixed point-scale constants.

### joewlos/fantasy_football_monte_carlo_draft_simulator — checked, avoid
- License: MIT. Stars: 11. Last push: 2024-09-06. TypeScript/FastAPI.
- What it does: Monte Carlo draft simulator that **randomly assigns injuries and setbacks from historical base rates** during simulated seasons — no depth-chart lookup, no redistribution of vacated usage to specific teammates. An injury just zeroes out that player's simulated future value.
- Adopt: **avoid**. Confirms bucket 3 above; not a network model, nothing to port.

### chanzer0/NFL-DFS-Tools — cloned, avoid
- License: none set. Stars: 49. Last push: 2025-09-04. Python.
- What it actually does (read, not README): DFS lineup optimizer/GPP simulator. `grep -rliE "injury|depth.?chart|out.?probability|questionable"` across all `.py` files returned **zero matches** — the tool has no injury-awareness at all; player exclusion is manual (user removes a player from the pool by hand).
- Adopt: **avoid**. No injury or depth-chart logic exists to evaluate, let alone port.

### cbratkovics/fantasy-football-ai — checked via metadata, reference-only
- License: MIT. Stars: 15. Last push: 2026-09-11 (active, today's date is 2026-09-12). Python/nflverse.
- What it does per its own description: weekly point predictions via temporally-validated RF models vs. a causal baseline — a production-forecasting pipeline, not an injury/depth-chart model. No propagation logic implied by the description or file sizes; not cloned since nothing in its stated scope touches injury propagation.
- Adopt: **reference-only** (worth a look for its rolling-origin backtest harness pattern if Gridiron's forecast-validation practices ever need a second opinion — unrelated to this task's actual ask).

### jjti/ff — checked via metadata, reference-only
- License: none set. Stars: 78 (highest of the batch). Last push: 2026-09-11. TypeScript.
- What it does: draft assistant computing Value Over Replacement (VORP = projection minus the n+1th-ranked player at that position) — the simplest possible replacement-level definition (positional rank cutoff), no network, no depth-chart join.
- Adopt: **reference-only**. Simpler than what Gridiron already has in `nfl-player-value.js`; nothing to port.

## Original bounded design (since no credible network model exists to port)

**Depth-chart propagation graph, fit on Gridiron's own tables — no new data source, no paid API.**

Nodes = `(player_id, position, team)` from `nfl_depth`, edges = same-team, same-or-adjacent depth-chart slot pairs at each position group (e.g., WR1↔WR2↔WR3, RB1↔RB2, the interior-OL group as a unit rather than individually). Edge weight = the empirically observed share of a departing player's *usage* (targets for pass-catchers, carries for backs, snap share for line/front-seven) that historically moved to each teammate the last N times a player at that depth slot missed a game, computed directly from `player_week_usage` joined to `nfl_snaps` and `nfl_depth` (the same tables `role-changepoint.js` already reads). `who-plays.js`'s `expected_snaps_lost` becomes the trigger signal (a probability-weighted vacancy), and `role-changepoint.js`'s materiality/corroboration test becomes the labeled historical event set to fit and backtest the edge weights against — i.e., "when we saw this exact vacancy before, how much of the target share/carry share actually went to which specific teammate, and does the graph's predicted split beat the naive equal-split or depth-order-only baseline out of sample." Output plugs into `nfl-player-value.js` as a second team, not a replacement for it: the existing file answers "how much did the vacating player's own production cost the team"; the new graph answers "and specifically whose stock does that turn into." Ships shadow-only (same convention as `who-plays.js` and `news-fantasy-impact.js` — "does not alter production picks until forward calibration passes") until backtested against real historical redistribution, exactly like the rest of the codebase's stated practice.

This is scoped to *fantasy* usage-share redistribution (Nick's stated priority: fantasy edge before betting edge), reads only tables Gridiron already populates, and requires no new ingestion, no paid API, and no touching of the live/read-only fantasy-football-dashboard repo tonight — it is a design to hand to the next implementation pass, not code written against the read-only repo.
