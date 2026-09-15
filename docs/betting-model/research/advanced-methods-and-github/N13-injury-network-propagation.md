# N13 — Injury network propagation through depth chart and scheme

Bucket: new (per assignment) — candidates below split ~3 fix / 4 new.

## What Gridiron does today (verified by reading the code, not assuming)

Three modules touch "one player's absence changes another player's value," and none of them is a network/graph model:

1. **`server/services/player-availability.js`** — `availability()` and `weeklyAvailability()` estimate whether *one* player suits up (durability prior + injury-report status/practice-participation shrinkage, validated: MAE 4.748 -> 3.71 vs no discount, 326 Questionable player-weeks 2025). This is single-node, not propagation.

2. **`server/services/contingency.js`** — `cascades()` and `handcuffValue()`. This is the closest thing to "propagation" that exists, and it is genuinely well-built: for every starter it empirically splits team-weeks into "starter played" vs "starter didn't," compares teammate opportunity across the split, and shrinks the ratio toward 1 with thin samples (`shrink(boosted/base, 1, n, 4)`). But it is **exactly one hop and strictly within a fixed position-inherits-position map**:
   ```js
   const INHERITS = { QB: ['QB'], RB: ['RB'], WR: ['WR', 'TE'], TE: ['TE', 'WR'] };
   ```
   A left tackle going down never appears in this table at all — `cascades()` only walks `player_week_usage` for QB/RB/WR/TE (line 41, 151-155), so offensive-line injuries produce zero cascade signal here, even though `nfl_depth`/`off_rosters` carry OL depth-chart rows (`pos_abb` LT/RT/LG/RG/C) and `nfl-roster-strength.js` weights OT at `1.45` importance (`POSITION_IMPORTANCE`, line 24-28). `handcuffValue()` also converts opportunity to points using a **flat per-position constant** (`ppo[position]`, lines 271-281) — the same points-per-opportunity number is applied to every backup at a position regardless of who that specific backup is.

3. **`server/services/nfl-roster-strength.js`** — aggregates the whole depth chart into one team/unit-strength number with a "depth fragility" component (`depthPrior = clamp(91 - 9*(depthRank-1), 38, 94)`, line 279). This is a **static roster-quality snapshot**, not a propagation mechanism — it never asks "if player X goes down this week, what happens to player Y's number."

4. **`server/services/nfl-scheme.js`** — measures offensive *scheme identity* (neutral pass rate, PROE, shotgun rate, no-huddle rate, plays/drive) per team-season from `nfl_team_week_features`, and is explicit that any such signal must be "measured, then validated out of sample, and only then considered for authority." This is the right methodological template to reuse, but it has never been pointed at an individual *player's* career scheme profile to ask whether a specific backup fits the system he is stepping into.

**Net:** Gridiron has (a) single-player availability, (b) one-hop, position-siloed, empirically-measured usage inheritance, and (c) a static aggregate depth-chart-strength score. It has never modeled *multi-hop* effects (OL -> QB -> pass-catchers), *cross-position coupling* driven by scheme, *backup-specific scheme fit*, or *correlated/simultaneous* injuries. That is the real gap this topic addresses — the injury-network idea is not a redundant restatement of `contingency.js`, it is the thing `contingency.js`'s own `INHERITS` map structurally cannot produce.

Also confirmed: `nfl_play_by_play` (the 251,591-row table cited in tonight's findings as unused for sequence models) carries **no player-identity columns at all** — no passer/rusher/receiver id, just team-level offense/defense, down/distance, shotgun/no_huddle flags (`server/db/schema/nfl-a-to-m.js:306-333`). Any graph/sequence approach built on it has to join by team+week to `player_week_usage`/`nfl_snaps` rather than by play-level player id, or pull a richer nflverse PBP pull that does carry those ids. That is a real, non-trivial cost item, not a detail to wave away.

## Has this been done credibly anywhere? (4 primary sources read in full)

**Short answer: not for NFL injury propagation specifically as a graph problem.** The closest real work is (a) individual replacement-level valuation (nflWAR), (b) spatial/graph attribution of offensive-line play (not injury-focused), (c) graph neural nets for in-play prediction (not injury-focused, but the right architecture), and (d) labor-economics evidence that backups really do perform measurably worse (the empirical fact a network model would need to explain). No paper combines "depth chart as graph" with "injury shock propagation" for NFL fantasy purposes. This is a genuinely open research niche, not a solved problem Gridiron is late to.

1. **Yurko, Ventura & Horowitz (2018), "nflWAR: A Reproducible Method for Offensive Player Evaluation in Football."** arXiv:1802.00998 (extended ed.), later published in *Journal of Quantitative Analysis in Sports*. Read in full (title through §4.1.4/4.2, replacement-level methodology). Data: `nflscrapR` public play-by-play, 2009-2017 (results shown for 2017 season). Model: multilevel (hierarchical/varying-intercept) regression dividing EPA/WPA credit jointly between QB, receiver/rusher, and opposing defense, with QB/RB rushing further divided by a 7-level "team-side-gap" grouping that stands in for O-line responsibility since individual O-line assignment data isn't public. Replacement level is defined **per position and per role** (rushing vs. receiving graded separately for the same player) via a roster-based approach adapted from `openWAR`. Win-probability model calibration validated by leave-one-season-out CV (well-calibrated across quarters/win-probability bins). Key relevance: it is the field's own admission that individual O-line attribution from public data is *hard* — its "team-side-gap" hack is a proxy, not a real per-player blocking assignment, which is exactly the gap a network/graph approach on richer data could close. Limitation stated by the authors: skill-position-only WAR, because the NFL does not publicly release on-field-player identity for every play (the same limitation that hits `nfl_play_by_play` above).

2. **Paul Ibrahim (2021), "A Spatial Framework for Analyzing NFL Offensive Line Play."** CMU Sports Analytics Conference. Read in full (all 6 pages). Data: publicly available player-tracking data from **6 games** of the 2020 season (Yui's dataset), sampled to 310 pocket-passing plays / 7,094 frames, first 3.5s post-snap only. Method: Voronoi tessellation of the pocket, then a fixed 2x2-yard bin grid, to measure actual vs. expected spatial occupation per bin and roll bins up into per-position responsibility zones (LT/LG/C/RG/RT + "QB-neighboring"). Honest result: a single case study (2020 Week 3 Chiefs-Ravens) shows Mahomes's protection area running 3.87 yd² below expectation at time of throw, with the deficit correctly localized to the side the O-line actually lost the rep on. Stated limitation, verbatim in spirit: the 6-game/310-play sample plus 10-Hz-vs-1-Hz asynchronous tracking noise means the authors "are unable to draw authoritative conclusions" — this is a proof-of-concept method paper, not a validated model. Relevance: this is the right *template* for attributing an in-game protection shortfall to a specific lineman's zone, which is the missing mechanism between "LT is out" and "QB pressure rate goes up" that Gridiron has zero version of today.

3. **Xenopoulos & Silva (2021/2022), "Graph Neural Networks to Predict Sports Outcomes."** IEEE (arXiv:2207.14124). Read in full (title through architecture description; abstract states the headline result). Data: player-tracking data for an American-football rushing-yards task and a CS:GO round-win task. Method: represents a game state as a fully-connected graph with players as nodes (no manual keypoint/anchor construction), compares a Graph Attention Network and a Graph Convolutional Network against a standard flattened-feature-vector baseline. Out-of-sample result stated in the abstract: **9% test-loss reduction on the American-football task and 20% on the esports task** versus the vector-baseline state-of-the-art. Limitation: neither task is injury-specific — it demonstrates the graph *representation* generalizes and beats hand-built feature vectors, but the paper's own "what-if" case studies are about swapping player positions/roles, not about a player being removed entirely (which is the injury case). Relevance: this is direct, published, quantified evidence that a graph representation of player nodes beats Gridiron's current approach (hand-built aggregate features feeding `nfl-roster-strength.js`) on a prediction task in the same sport.

4. **Gregory-Smith (2021), "Wages and Labor Productivity: Evidence from Injuries in the National Football League."** *Economic Inquiry* 59(2), open access (CC-BY), read in full through the identification strategy and Table 2 discussion (pp. 829-833). Data: player wages/bonuses 2011-2015 (spotrac.com) matched to injury data (Borghesi 2008 injury dataset), identification restricted mainly to the QB position because that is where the market's own pricing (Vegas spread) cleanly reveals expected talent loss. Method: injuries as an exogenous productivity shock, under a salary-cap constraint that prevents like-for-like replacement, to test whether wages track marginal product. Concrete, quotable result: **the backup QB's passing rating runs about 16 points below the starting QB's passing rating**, and the market (Vegas line) does not anticipate in-game injuries (spread differences between "starter got hurt this game" and control groups are statistically indistinguishable pregame). Limitation, stated by the author: main identifying specification is QB-only because only there is the counterfactual (backup quality) cleanly observable and priced; the paper explicitly does not extend the causal claim to skill positions. Relevance: this is the real-world magnitude an injury-propagation model has to reproduce and explain variance around — "backup is ~16 rating points worse, on average" is the naive baseline any network/scheme-fit model must beat, exactly the way Gregory-Smith frames replacement quality as heterogeneous rather than a single constant (which is precisely where Gridiron's flat `ppo[position]` in `handcuffValue()` falls short).

**Search coverage note:** I also searched explicitly for "injury propagation network graph NFL," "network centrality injury impact soccer," and "GNN player substitution NFL" — the soccer passing-network-centrality literature is real and mature (multiple ScienceDirect/PMC papers on centrality vs. match outcome) but is about *style of play*, not injury-driven node removal; I did not find a single paper that removes a node (injured player) from a sports graph and measures the propagated effect on teammates' output. That specific combination appears to be open.

## Candidates

do_not_do:
- Do not let a network/graph model touch any live projection, trade-engine value, or auto-pick before it clears the same forward-shadow discipline every other Gridiron model goes through (per `model-governance.js`'s CONTRACTS list) — an untested graph score is not exempt just because it "sounds structural."
- Do not build a full player-level graph neural network as a first step. Xenopoulos & Silva's own result (9% loss reduction) came from a fully-connected graph over *tracking data Gridiron does not have* (no NFL Big Data Bowl-grade tracking feed in this stack). Start with the depth-chart/snap-share graph that already exists in `nfl_depth`/`nfl_snaps`, not a tracking-data GNN Gridiron cannot currently feed.
- Do not extend `contingency.js`'s `INHERITS` map to cross positions (e.g., "OL -> QB") by hand-picking a multiplier. `nfl-scheme.js`'s own stated discipline — measure the play-calling behavior, validate out of sample, only then trust it — is the bar; a hand-tuned cross-position coefficient repeats the exact mistake already flagged tonight for `nfl-team-strength.js`'s "hand-tuned blend."
- Do not treat Paul Ibrahim (2021)'s 6-game/310-play spatial framework as validated — the author says so themselves. It is a template for the *method*, not a result to import as a coefficient.
- Do not claim the Gregory-Smith "-16 rating points" figure as fantasy-football truth without re-deriving it on Gridiron's own `player_week_usage`/`nfl_snaps` data — it is QB-specific, 2011-2015, real-money-wage-motivated economics, not a fantasy-points number.
- Do not build the correlated-injury interaction model (N3) on fewer than ~30 team-weeks with 2+ simultaneous starter-out flags — `contingency.js` already enforces `MIN_MISSED = 3` and `minGames = 6` for a *single*-player split; a two-player joint split needs more, not less, sample discipline.

candidates:

1. id: F1
   bucket: fix
   candidate: Build a team-week blocking/protection graph from play-by-play instead of leaving it as hand-built season aggregates
   fixes_finding: "251,591 rows of play-by-play exist and are used only for hand-built features, never sequence models."
   mechanism: Port Paul Ibrahim (2021)'s gap-based responsibility zones (LT/LG/C/RG/RT + QB-neighboring) as a *play-level* join key against nflverse's fuller PBP pull (which does carry passer/rusher ids upstream, unlike Gridiron's locally-stored `nfl_play_by_play`) to build a per-game, per-lineman "zone under pressure" signal, then aggregate to team-week so it can feed the existing pass-catcher/QB efficiency features instead of only the season-level `off_pfr_adv_season`/`off_team_season_stats` rollups.
   evidence_strength: moderate
   applies_to: infrastructure
   how_in_gridiron: `server/db/schema/nfl-a-to-m.js:306` (`nfl_play_by_play`, confirmed to carry no player-id columns today — team/down/distance/shotgun only); `server/services/nfl-pbp.js` (`syncPbpSeason`, `PBP_URL`) is the ingestion point that would need the richer nflverse column set; output would land as a new `nfl_pass_protection_zone` table joined by `event_id`/`play_id`, then rolled up by `server/services/nfl-team-tendencies.js`-style aggregation into a team-week feature `nfl-roster-strength.js` and `contingency.js` can both read.
   cost: weeks
   expected_value: A real per-lineman degradation signal to attach to "LT is out" instead of the current zero-signal gap in `INHERITS`; feeds directly into F3's Bayesian team-strength update.
   exit_test: Re-derive Ibrahim's own metric (protection area at time of throw vs. league expectation) on Gridiron's PBP+snap data for 2016-2025, and check whether weeks with a new/backup LT (via `nfl_depth` pos_rank change at LT) show a statistically significant drop in that metric vs. that same team's own baseline weeks (paired, not cross-team) — if the signal doesn't move on documented LT changes, stop before building anything downstream.

2. id: F2
   bucket: fix
   candidate: Pre-register the injury-network pilot itself before it is allowed to touch anything live
   fixes_finding: "No trial registry exists with real preregistration + multiplicity correction (Holm/PBO/deflated-Sharpe) for the 21-model historical search that has already been run."
   mechanism: Use `model-governance.js`'s existing `CONTRACTS` framework (it already has an `injury_availability` contract and a `pregame_role_eligibility` contract for player_props) as the registration point: add the injury-network score as a named challenger with its exit test written down *before* any backtest is run against it, so it cannot quietly become model #22 in the same undisciplined search that produced the 21-model problem flagged tonight.
   evidence_strength: strong
   applies_to: infrastructure
   how_in_gridiron: `server/services/model-governance.js` (`CONTRACTS` array, e.g. the existing `['NFL', 'player_props', 'pregame_role_eligibility', 'depth chart + prior usage snapshot', ...]` row is the template); `server/services/nfl-model-growth.js` (the publication-driven retrain/challenger pipeline that would need to register the new signal as a challenger, not a silent production change).
   cost: hours
   expected_value: Prevents this exact research idea from becoming an uncorrected 22nd entry in the historical model search; costs almost nothing and is a process fix, not a modeling one.
   exit_test: A written preregistration entry exists (exit metric, holdout weeks, Holm-adjusted significance threshold) dated before any backtest of the injury-network score is run; if the backtest already ran before this entry exists, the finding is treated as exploratory only and re-tested on a fresh holdout.

3. id: F3
   bucket: fix
   candidate: Use validated injury-network shocks as the state-space update team-strength is missing, instead of the current hand-tuned blend
   fixes_finding: "Team-strength ratings (nfl-team-strength.js) mix stale preseason priors with in-season data via a hand-tuned blend, not a principled state-space/Bayesian update."
   mechanism: Once F1's protection-degradation signal (or the simpler N1 depth-chart-graph signal) is validated, treat a starter going down as an observed shock in a real state equation (e.g. a Kalman-style update to the team-strength posterior) rather than letting the existing fixed-weight blend of preseason prior + in-season evidence slowly absorb it over several weeks.
   evidence_strength: weak
   applies_to: fantasy
   how_in_gridiron: `server/services/nfl-team-strength.js` (the blend logic around `depthPrior`/participation weighting, lines ~279-300) is exactly the hand-tuned mechanism that would be replaced; `server/services/contingency.js`'s `cascades()` output is the natural shock-magnitude input.
   cost: weeks
   expected_value: A team-strength number that reacts to a real injury the week it happens instead of drifting toward it — directly reduces the lag the hand-tuned blend is documented to have.
   exit_test: On weeks with a confirmed new starter (via `nfl_injuries` OUT + `nfl_depth` pos_rank change), compare next-week team-total forecast error under the state-space update vs. the current blend; require the improvement to be Holm-significant per F2's registered test before replacing the current blend.

4. id: N1
   bucket: new
   candidate: Two-hop depth-chart cascade graph (position-siloed one-hop -> cross-position, scheme-weighted multi-hop)
   fixes_finding: "none — new capability"
   mechanism: Represent each team-week's offense as a small directed graph — nodes are depth-chart slots from `nfl_depth`/`off_rosters` (including OL positions already carried there but never used for cascades), edges are (a) direct pos_rank succession within a position (what `contingency.js.INHERITS` already captures, one hop) and (b) cross-position edges weighted by the team's `nfl-scheme.js` profile (e.g., an OT-slot edge into the QB node weighted by pass rate/PROE, a QB-slot edge into WR/TE nodes weighted by target share). Walk two hops instead of one: OL starter out -> measured protection degradation (F1) -> QB efficiency delta -> pass-catcher value delta, instead of stopping at "OL injuries produce no cascade signal at all," which is today's actual behavior.
   evidence_strength: moderate
   applies_to: fantasy
   how_in_gridiron: `server/services/contingency.js` (`cascades()`, currently hard-scoped to `SKILL = ['QB','RB','WR','TE']` and the `INHERITS` map at lines 22-27 — extend rather than replace); `server/db/schema` tables `nfl_depth` (pos_abb includes OT/G/C), `nfl_snaps` (offense_pct), `off_rosters` (depth_chart_position) supply the graph nodes; `server/services/nfl-scheme.js`'s `SCHEME_DIMENSIONS` supplies edge weights.
   cost: weeks
   expected_value: Turns a documented zero (OL injuries currently produce no fantasy-relevant cascade at all) into a measured, shrinkage-disciplined signal for the pass-catchers behind an OL injury — a real gap in the existing handcuff-value ranking.
   exit_test: Holdout weeks with a documented new starting OT/G/C (via `nfl_depth`): does the two-hop cascade's predicted pass-catcher opportunity/points delta beat a "no change" null and beat the current one-hop `cascades()` output (which by construction predicts nothing for these weeks) on out-of-sample MAE, Holm-corrected per F2.

5. id: N2
   bucket: new
   candidate: Backup-specific scheme-fit score, reusing nfl-scheme.js's own methodology on the player instead of the team
   fixes_finding: "none — new capability"
   mechanism: Compute the same six `SCHEME_DIMENSIONS` `nfl-scheme.js` already uses for team identity (neutral pass rate, PROE, early-down pass rate, shotgun rate, no-huddle rate, plays/drive) from a *backup's own prior-team or prior-season* play-calling context, and measure the L2 (or cosine) distance to the current team's profile. Use Gregory-Smith's "-16 rating points" average backup gap as the null hypothesis to beat: does scheme-distance explain any of the variance around that average, i.e., are misfit backups (large distance) worse than the average -16 and well-fit backups closer to the starter's level?
   evidence_strength: weak
   applies_to: fantasy
   how_in_gridiron: `server/services/nfl-scheme.js` (`SCHEME_DIMENSIONS`, `seasonProfiles()`) is the exact function to call per-player instead of per-team, keyed by the backup's team-seasons in `player_week_usage`; QB1->QB2 transition weeks are findable via `nfl_injuries` (QB OUT) joined to `nfl_snaps` offense_pct spikes for the backup.
   cost: days
   expected_value: A cheap, reuses-existing-code signal that could sharpen the flat "backup is worse" prior into a fit-dependent one, directly relevant to trade-engine/waiver-wire valuation of backup QBs specifically.
   exit_test: On QB1->QB2 forced-start weeks since 2016 (when `nfl_team_week_features` coverage begins), does scheme-distance correlate with the backup's EPA/play shortfall vs. his own career baseline, beyond what career EPA alone predicts? If the correlation is not significant on a Holm-corrected test, drop it — do not ship a "scheme fit" number that is really just restating "this backup is bad."

6. id: N3
   bucket: new
   candidate: Correlated/simultaneous-injury interaction term (two starters out in the same game is not two independent one-hop cascades)
   fixes_finding: "none — new capability"
   mechanism: `contingency.js.cascades()` estimates each starter's inheritance independently; nothing in Gridiron asks what happens when, say, the LT and WR1 are out in the same game — whether the two effects are additive, sub-additive (both cascades compete for the same limited defensive attention/game script), or super-additive. Build a simple pairwise interaction residual: for team-weeks with 2+ starters flagged OUT/DOUBTFUL at *different* positions in `nfl_injuries`, compare actual backup performance to the sum of the two independently-estimated one-hop cascades, and characterize the sign/size of the residual.
   evidence_strength: weak
   applies_to: fantasy
   how_in_gridiron: `server/services/contingency.js` (`cascades()` output as the two independent baselines to sum); `server/services/nfl-advanced.js`'s `nfl_injuries` table (season/week/gsis_id/report_status) is the source for identifying simultaneous-OUT team-weeks.
   cost: days
   expected_value: Either confirms independence is a fine approximation (useful negative result, cheap to get) or surfaces a real correction term for the highest-leverage weeks (multiple starters out) where current handcuff rankings are most likely to be wrong.
   exit_test: On team-weeks with 2+ simultaneous OUT starters at different positions (target ~30+ such weeks 2016-2025 per the do-not-do sample-size floor), is the actual-vs-summed-independent residual significantly different from zero (paired test)? If the sample never reaches ~30 qualifying weeks league-wide, report that as the finding and stop — do not fit an interaction term on fewer observations than `cascades()` itself requires for a single starter.

7. id: N4
   bucket: new
   candidate: Replace handcuffValue()'s flat per-position points-per-opportunity with player-specific (nflWAR-style) replacement level
   fixes_finding: "none — new capability"
   mechanism: `handcuffValue()` currently converts every backup's inherited opportunity to points using one league-average `ppo[position]` constant (same number for every RB2 in football). Port nflWAR's core insight — replacement level should be estimated per role via a roster-based approach, not assumed constant across all players at a position — by substituting the specific backup's own trailing rate stats (or a shrunk role-specific replacement baseline) for the flat constant.
   evidence_strength: moderate
   applies_to: fantasy
   how_in_gridiron: `server/services/contingency.js` lines 271-281 (`ppo` computation) and lines 296-298 (`expected_points` calculation) are the exact lines to change; `player_week_usage` already carries the per-player rate stats needed (passing_yards, rushing_yards, receptions, etc. per opportunity) — no new table required.
   cost: hours
   expected_value: A more honest handcuff ranking — distinguishes a backup who is merely receiving carries from one who is efficient with them, which the current flat constant cannot do by construction.
   exit_test: Backtest handcuff-value rankings (flat-ppo baseline vs. player-specific replacement level) against actual fantasy points scored in backup-forced-into-starting weeks; require the player-specific version to beat the flat baseline on out-of-sample rank correlation or MAE, Holm-corrected per F2, before replacing the existing constant.
