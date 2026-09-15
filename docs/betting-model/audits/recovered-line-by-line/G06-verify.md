# Verification notes: G06-nfl-council-research claims 25-29

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
DB: server/data.sqlite opened via node:sqlite {readOnly:true}

## #25 nfl-orthogonal-specialists.js:62 fitRidge -> all-NaN betas

Read server/services/nfl-orthogonal-specialists.js lines 1-258 (full file, 258 lines).
`fitRidge` (line 62) does 5 IRLS iterations solving a ridge system via Gaussian
elimination (`solve`, line 47). `fitArtifact` (line ~163) calls it once per
FAMILY_SPEC family and stores `beta: model.beta` verbatim (no r4 rounding) into
the persisted artifact (`persistArtifact` line ~229, INSERT OR IGNORE into
nfl_orthogonal_specialist_artifacts).

DB check (read-only, node:sqlite):
- All 49 rows in nfl_orthogonal_specialist_artifacts (seasons 2023 W5-18, 2024
  W5-18, 2025 W5-18) have every family's beta array entirely NaN (serializes to
  `null` in the stored JSON) -> 100% reproduction, not an isolated fluke.
- final_validation_mse is null on every row (also confirms `report` block never
  produces a finite MSE, consistent with NaN propagation through predict()).
- roster family's r4(influence) is `null` (NaN before rounding); all five other
  families show influence `0`.

Traced the runtime math for `orthogonalSpecialistPrediction` (lines 234-249):
`raw = predictFamily(family, vector)` uses the true (unrounded, still-NaN)
in-memory beta, so `raw` is NaN for every family. `contribution = raw *
family.influence` is NaN regardless of the influence value (NaN * anything is
NaN, and even where JS null-coerces influence to 0, NaN*0 is still NaN).
Crucially, the `specialists` map stores `contribution: r4(contribution)` -
`r4(NaN)` is `null` (r4 definition, line 40, explicitly maps non-finite -> null).
`forecast_residual: r4(specialists.reduce((sum,item)=>sum+item.contribution,0))`
then sums those *already-rounded* `null` values from the mapped array; in JS,
`0 + null === 0`, so every per-family null contribution behaves as +0 in the
sum, and the final reduce lands on exactly 0, then r4(0) = 0. This is exactly
why the observable forecast_residual is "exactly 0" and not NaN or null - the
claim's mechanism is right down to this subtlety.

No nfl_orthogonal_specialist_artifacts rows exist yet for season 2026 (checked;
empty), because `examplesBefore` for a 2026 W1 call would pull the identical
training universe (all games before 2026, i.e. through 2025 W18) that already
produces 100% NaN betas above - so the claim's forward-looking "for every 2026
game" is a reasonable, code-supported extrapolation from data that is otherwise
completely uniform across 3 full seasons and 49 distinct artifacts.

Confirmed live wiring into the council: nfl-expert-council.js imports
`orthogonalSpecialistPrediction` (line 26) and uses it for the `specialist_team`
expert (line 38 registry, called at line 494, `output('specialist_team', ...)`
at line 543). Pulled the actual persisted 2026 W1 LAR/SF T-15m combined_decision
trace from nfl_expert_forward_predictions and confirmed `specialist_team`'s
`raw_opinion` is literally `0` there - ties #25 directly into #26's evidence.

VERDICT: CONFIRMED, high-fidelity, universally reproduced in the current DB
(49/49 artifacts), and already live in the weekly growth cycle
(nfl-model-growth.js:242 calls `fitOrthogonalSpecialists(season, nextWeek,
{persist:true})` every week - "growth cycle re-persists the broken fit weekly"
is accurate). This voids an entire expert role's historical/forward evidence.
Severity P2 stands - not refuted.

## #26 nfl-expert-council.js:186 combinedDecisionTrace -> fake directional call

Read nfl-expert-council.js in full (867 lines, read across four sed/grep
passes covering 1-120, 155-220, 580-760, plus targeted greps for the symbols
in the claim). Read nfl-expert-coordinator.js in full (448 lines, one pass).

`combinedDecisionTrace` (line 165) sets `state: ready ? 'candidate_forecast_only'
: 'warmup_abstain'` (line 174) purely off `Boolean(coordinator?.ready)` - it
does NOT check whether any role actually contributed nonzero weight.
`projected_home_margin` (lines 186-187) is computed from
`game.market_margin + forecastResidual` whenever both are finite, again with
no check on whether the residual came from real signal or pure missingness
offset.

Live DB check against nfl_expert_forward_predictions (season=2026, week=1,
expert_id='coordinator' and 'combined_decision'):
- Latest two captures (2026-09-10T23:36 and 2026-09-11T00:25, i.e. the T-15m-
  ish captures right before each kickoff) show, across all 7 games captured at
  that horizon: forecast_residual is EXACTLY -0.075 or +0.047 - only two
  distinct values across every game.
- Pulled the full LAR/SF row: `active_weight_l1: 0`, all 19 `contributions[].
  shrink` are `0`, `missingness_offset: -0.196`, `forecast_residual: -0.075`.
  Confirms coefficients[0] (a small clamped intercept) + 0 (all shrink=0 so
  every contribution value is 0) + missingness_offset is literally the whole
  forecast. Matches nfl-expert-coordinator.js:412
  (`const forecast = fit.coefficients[0] + contributions.reduce(...) +
  missingOffset;`).
- Dumped the persisted `combined_decision` trace JSON for LAR/SF at the same
  timestamp: `state: "candidate_forecast_only"`, all 19 contributors show
  `learned_weight: 0, normalized_weight: 0, contribution: 0` - i.e. the trace
  the claim describes is literally what's on disk right now for the live 2026
  Week 1 slate.

Confirmed this trace is not just a throwaway debug object: it's persisted via
`persistWeeklyExpertAudit` (nfl-expert-council.js ~745-750, JSON.stringify with
`decision_trace: item.combined_decision`) into nfl_weekly_expert_examples,
which is the exact table `fitExpertCoordinator` reads back as training history
(`historical` query, coordinator.js ~397). It also feeds
`settleForwardExpertPredictions` -> `nfl_expert_forward_settlements`
(directional_correct computed off this forecast_residual's sign), and is
surfaced through nfl-blind-audit.js and nfl-slice-diagnostic.js /
nfl-specialist-audit.js (grepped `combined_decision` across the repo).

VERDICT: CONFIRMED exactly as described, evidence numbers match precisely
(active_weight_l1, missingness_offset, the two residual values). This is a
real audit-integrity defect: a directional number gets frozen, later scored as
right/wrong, and re-enters training, while representing nothing but which
roles happened to be missing. Severity P2 stands - not refuted.

## #27 nfl-team-card.js:213 matchupTeamCards freeze-on-first-ask

Read nfl-team-card.js in full (253 lines, one pass).

Line 213-214 (`matchupTeamCards`):
```
const homeCard = getFrozenTeamCard(season, week, home, options)
  ?? freezeTeamCard(season, week, home, options);
```
Exactly matches the claim's snippet/mechanism: whichever caller asks first
(any council capture at any horizon, including the earliest "open" council
snapshot days before kickoff) permanently freezes the card via
`freezeTeamCard` -> `buildTeamCard`, using `cutoff = gameKickoff` (line 174-176)
but computed with whatever `nfl_injuries` rows exist AT THE MOMENT OF THE FIRST
CALL, not at cutoff/kickoff time itself (the cutoff is a filter baked into the
query, but the query only ever sees rows already ingested by the time the freeze
runs).

DB check for 2026 W1:
- All 32 nfl_team_cards rows for season=2026,week=1 were created within one
  minute of each other on 2026-09-02 ~05:50-05:51 UTC (dumped every distinct
  created_at, all clustered there).
- Every sampled card's `injuries.players.length` is 0 (checked all 32, none
  nonzero) via JSON.parse(card_json).
- `nfl_injuries` for season=2026,week=1 currently has 167 rows total, with
  ARI=7 (claim's own numbers), confirming injury data has since arrived that
  the frozen cards never captured.
- Confirmed `cutoff` stored on the ARI card is `2026-09-13T20:25:00.000Z`,
  which matches game_lines' ARI W1 kickoff (gameday 2026-09-13, gametime
  16:25) - i.e. cutoff genuinely equals kickoff, not the (much earlier) actual
  freeze time. Kickoff (2026-09-13) minus freeze time (2026-09-02) is 11 days,
  matching the claim's "5-11 days before kickoff" (other teams' games are
  earlier in the week, giving the 5-day end of that range).

Traced consumption: nfl-expert-council.js:490 calls `matchupTeamCards(season,
week, game.home, game.away)` inside `gameExperts`, feeding `player_builder`
(line 514) directly from the stale card, and separately
`orthogonalSpecialistPrediction` (imported into nfl-expert-council.js, used at
line 494) calls `getFrozenTeamCard` inside nfl-orthogonal-specialists.js
(imported at that file's top) for every one of its 6 families. Confirmed via
the persisted LAR/SF T-15m trace (see #26) that `specialist_team` and
`player_builder`'s inputs are indeed being read from this frozen, pre-injury
evidence at kickoff-minus-15-minutes, while nfl_injuries already has real,
current data by then.

On "the growth cycle's weekly backfillTeamCards will then hit an unhandled
team card conflict": read `backfillTeamCards` (lines 232-252). It calls
`freezeTeamCard` unconditionally (not `getFrozenTeamCard ?? freeze`) for every
team/week in range, and `freezeTeamCard` (lines 199-212) DOES check for an
existing row and returns a structured `{error: 'team card conflict...'}`
object (not a thrown exception) when the freshly recomputed evidence_hash
differs from what's already frozen (which is exactly what will happen once
`buildTeamCard` recomputes with the now-167-row injury table against the old
0-row frozen hash). `backfillTeamCards` pushes that into a `failures` array
(line ~244) rather than throwing, so calling this "unhandled" is a mild
overstatement - it IS handled (as a recorded failure, not a crash) - but the
substantive claim is accurate: the weekly refresh cannot silently repair W1's
cards; every one of the 32 teams' cards will keep failing to update and stay
stuck on the stale, injury-free evidence used at freeze time. This is a real,
verifiable, ongoing bug in production data, already actively feeding kickoff-
adjacent predictions today (not merely a future hypothetical).

VERDICT: CONFIRMED (evidence numbers match exactly: 32 cards, ~05:50-05:51Z
2026-09-02, 0/32 nonzero injury lists, 167 current nfl_injuries rows, ARI=7,
cutoff=kickoff). Minor wording nit: the future conflict is caught/handled as a
recorded failure rather than an uncaught exception, but this doesn't change the
severity or the substance. Severity P2 stands - not refuted (noted the minor
"unhandled" wording imprecision in reasoning).

## #28 nfl-online-neural.js:185 production_eligible -> silent auto-promotion

Read nfl-online-neural.js in full (367 lines, one pass) and
nfl-auto-picks.js lines 1-140 (through the relevant board-computation logic).

nfl-online-neural.js:185-186:
```
production_eligible: metrics.production_eligible === true, metrics,
authority: metrics.production_eligible === true ? 'eligible_for_production_review' : 'shadow_only'
```
`metrics.production_eligible` (performanceMetrics(), ~line 305) is a
self-computed flag: >=128 trained examples, >=8 distinct settled weeks, and a
90% CI lower bound > 0 on MAE improvement over market - entirely internal,
no external gate.

nfl-auto-picks.js:104-108 (computeDecisionBoard, the function that builds the
live weekly production picks board):
```
const neural = onlineNeuralPrediction(game);
const neuralUsed = Boolean((modelOptions.includeChallengers || neural.production_eligible === true)
  && Number.isFinite(neural.predicted_margin));
...
const projectedMargin = neuralUsed && neural.predicted_margin != null
  ? neural.predicted_margin : e.projected_margin;
```
Confirmed exactly as quoted: `neural.production_eligible === true` alone (with
no `includeChallengers` flag, i.e. on the default champion/production board)
is sufficient to swap `projectedMargin` from the vetted ensemble's
`e.projected_margin` to the shadow neural head's own output, with zero human
review step in code.

Cross-checked the codebase's own explicit stated policy for this exact
mechanism (grepped "never auto-promote" / "auto-promot" / "production_eligible"
across all services):
- nfl-model-growth.js:144: "They never auto-promote a betting model; promotion
  still requires the frozen forward gates."
- nfl-risk-lab.js:490: "It still cannot auto-promote or size bets."
- nfl-online-neural.js:362: `staking_authority: '0 units until the forward
  weekly-clustered promotion gate passes'`
- nfl-online-neural.js:186 itself labels the state `eligible_for_production_
  review` (i.e. "ready for a human to review"), not `promoted`.
Despite this, nfl-auto-picks.js reads that exact flag and immediately
substitutes it into the live board computation with no review step - directly
contradicting the "review"/"gate" language used everywhere else in the same
codebase for the same kind of promotion decision.

Checked current state (read-only DB): nfl_online_neural_examples has 128 rows
captured but 0 rows with `selected_for_training=1`, and no artifacts in
nfl_online_neural_artifacts yet - so `metrics.production_eligible` is
certainly `false` right now (performanceMetrics only counts `selected_for_
training=1` rows, of which there are zero). This means `neuralUsed` currently
evaluates false in production, i.e. no live pick is being generated off the
neural head today. The bug is real but not yet triggered.

Unlike #29 (below), this code path requires no manual/human action to
eventually fire: `trainOnlineNeuralThroughSettled()` already runs
automatically every week inside the same growth cycle (nfl-model-growth.js)
that also runs the other confirmed-live bugs above, so once (if) settled
weeks accumulate the threshold sample, the swap happens silently on a future
routine run with nobody touching any code or config - this is a materially
different risk profile than an admittedly-unused, manually-invoked API.

VERDICT: CONFIRMED as a real, code-level policy violation (contradicts the
codebase's own repeatedly-stated "never auto-promote" rule), wired directly
into the live weekly production board function, and will trigger automatically
without any human action once the sample/CI thresholds are met. Currently
inert (0/128 examples trained/selected today) so no live number is wrong yet,
but this is a self-arming time bomb in an already-running automatic job, not
a hypothetical or manual-only path. Severity P2 stands - not refuted.

## #29 nfl-experiments.js:21 FAMILIES whitelist omits Roster availability

Read nfl-experiments.js in full (176 lines, one pass) and the referenced
comparison block in nfl-research.js lines 1-40.

Line 21 exactly: `const FAMILIES = new Set(['Rating systems', 'Efficiency',
'Context', 'Market']);` - confirmed verbatim and at the exact line number.
`normalizeConfig` (lines 32-46) filters `raw.modelOptions.families` through
this set (line 40-41: `families = raw.modelOptions.families == null ? null :
[...new Set(raw.modelOptions.families)].filter(x => FAMILIES.has(x));`).

Confirmed via nfl-research.js's own doc-comment (lines 14-27) that this exact
four-element hardcoded array was a previously-identified, already-understood
bug pattern: "This was a hardcoded four-element array... The ensemble actually
has FIVE families - the missing one being 'Roster availability'... Because
`families` acts as a WHITELIST in `ensembleLine`, every `without:X`
configuration was silently dropping roster availability TOO... Deriving the
list from `nflFeatureFamilies()` [i.e. `ensembleFeatureContracts()`] means a
family added to the ensemble can never again be silently omitted." That fix
(`ablationFamilies()`, nfl-research.js line 29) was applied in nfl-research.js
but nfl-experiments.js still carries the exact original stale hardcoded list.

Confirmed the whitelist mechanism in nfl-ensemble.js: `ensembleLine`'s
`allowedFamilies = families?.length ? new Set(families) : null;` (line 1255)
and `MODELS.filter(x => (!allowedFamilies || allowedFamilies.has(x.family)) &&
...)` (line 1256) - so any `families` list that omits 'Roster availability'
silently excludes every roster-availability model regardless of caller intent.

Checked reachability: nfl-experiments.js's `createExperiment` /
`runExperimentStage` / `experimentProtocol` ARE wired to a live route
(server/routes/nfl-betting.js:42, 1035, 1051, 1055 - POST /experiments and
POST /experiments/:id/:stage exist), so this is not dead code - the API surface
is live and reachable.

Checked current usage (read-only DB): `SELECT COUNT(*) FROM
nfl_model_experiments` = 0. No experiment has ever been created through this
route - confirming the claim's own evidence line ("nfl_model_experiments has 0
rows") and its own stated impact ("today it is unused").

Impact-lens judgment: unlike #28 (which fires automatically inside an
already-running weekly job with no human action needed), this route requires a
person to explicitly call `POST /experiments` with a `modelOptions.families`
list before the bug can mislabel anything, and in the life of this repo nobody
ever has. It changes no number Nick has ever seen, no money staked, no
decision recorded, and there is no backtest leakage today because there is no
backtest. Per the impact-lens instruction ("if it changes nothing a user or a
model sees, set refuted=true and corrected_severity P3"), this is exactly that
case: real bug, correctly identified line/mechanism, but zero materialized
impact and no automatic trigger path - it only matters the day a person
manually runs an experiment naming families, which has not happened.

VERDICT: REFUTED at P2 (the underlying defect is real and correctly cited),
corrected_severity P3 - dormant, manually-gated, zero rows/zero current
consumers, unlike the actively-running defects in #25-#28.
