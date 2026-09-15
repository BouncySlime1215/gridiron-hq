# Verification notes: G06-nfl-council-research claims #25-#29

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only).
DB access: node:sqlite `{ readOnly: true }` one-liners only, plus one self-contained
reproduction script (`/private/tmp/.../scratchpad/repro3.mjs`) that copies the
module's own pure functions (no import of app db/index.js, no writes) to
independently re-derive the numeric bug against real read-only data.

## Claim #25 — server/services/nfl-orthogonal-specialists.js:62 (fitRidge) — non-finite betas

Files read in full: `server/services/nfl-orthogonal-specialists.js` (258 lines, all read).

Code:
- `fitRidge` (nfl-orthogonal-specialists.js:62-84). Line 71:
  `let weights = Array(Z[0].length).fill(1), beta = Array(Z[0].length).fill(0);`
  `Z[0].length` is the number of **columns** (features + intercept, `p`), not the
  number of **rows** (training examples). The IRLS loop at lines 75-80 indexes
  `weights[i]` for `i` from 0 to `Z.length-1` (number of examples, e.g. 1039),
  but `weights` only has `p` (e.g. 7) elements. `weights[i]` is `undefined` for
  `i >= p`, so `weights[i] * Z[i][j] * y[i]` becomes `NaN` for the majority of
  rows, and the cumulative sums `xty[j]` / `xtx[j][k]` are `NaN` from the first
  IRLS iteration onward (verified: at iteration 0, before any residual-based
  reweighting, `beta` is already all-NaN — see repro below). `solve()` (lines
  46-58) has no NaN guard (its `< 1e-10` pivot-floor only protects against a
  literal zero pivot, not NaN, and NaN comparisons are always false so the
  elimination just carries NaN through), so `beta` comes back entirely NaN.

- `orthogonalSpecialistPrediction` (lines 231-247): `raw = predictFamily(family, vector)`
  is NaN (from NaN beta). `contribution: r4(contribution)` — `r4` (line 37)
  turns any non-finite value into `null`. Then
  `forecast_residual: r4(specialists.reduce((sum, item) => sum + item.contribution, 0))`
  sums `item.contribution`, which is the **already-r4'd** value, i.e. `null` for
  every family. In JS, `sum + null` coerces `null` to `0`, so the reduce lands on
  `0`, and `r4(0)` is `0` (finite) — a **silent, false zero**, not an error and
  not a visible NaN/null. This is the exact mechanism the claim describes.

- `influence` pattern: family 1 (`roster`) gets `influence = NaN` (persisted as
  `null`) directly from its own NaN beta. Because
  `trainRemaining/tuneRemaining/reportRemaining` are updated as
  `value - trainRaw[i] * influence` (lines 217-219) with `influence = NaN`, all
  three remainder arrays become entirely `NaN` after family 1. For families
  2-6, `baselineMse = mse(tuneBefore, tune.map(()=>0))` is then `NaN` (since
  `tuneBefore` is now all-NaN), so the ternary
  `gainFraction = baselineMse > 0 ? ... : 0` (line 227) takes the `: 0` branch
  (`NaN > 0` is `false` in JS), giving `influence = 0` exactly — this exactly
  matches the DB row's pattern (`roster` influence `null`, the other 5 families
  influence `0`).

DB verification (read-only, `server/data.sqlite`):
- `nfl_orthogonal_specialist_artifacts`, latest row `through_season=2025,
  through_week=18` (`created_at=2026-09-01T19:07:45.304Z`, version
  `nfl-orthogonal-specialists-v2-reconciled-depth`, matching the current
  `ORTHOGONAL_SPECIALIST_VERSION`): every family's `beta` array is all `null`
  (roster 7/7, efficiency 11/11, pace_script 10/10, availability 6/6,
  environment 7/7, market_shape 6/6 — exact match to the claim's evidence
  string). `final_validation_mse: null`. `roster.influence: null`; the other 5
  families' `influence: 0`.
- `mu`/`scale` for each family ARE finite and sane (e.g. roster mu/scale look
  like real statistics), confirming the corruption is specifically in the beta
  solve, not in the input feature vectors (`cardValues`/`familyVector`, lines
  93-125, both read and confirmed to only ever produce finite numbers via the
  `n()` helper).
- No `nfl_orthogonal_specialist_artifacts` rows exist yet for
  `through_season=2026` (growth cycle hasn't advanced there yet — see
  `nfl-model-growth.js:245`, `fitOrthogonalSpecialists(season, nextWeek, {persist:true})`,
  gated on `afterIngest.finalized_week > 0`), so the specific phrase "for every
  2026 game" is not literally evidenced by a *persisted* 2026 row. However,
  `nfl-expert-council.js:494` calls
  `orthogonalSpecialistPrediction(season, week, game.home, game.away, {persistFit:false})`
  for live council games, which for `season=2026, week=1` internally calls
  `fitOrthogonalSpecialists(2026, 1, {persist:false})`, which recomputes
  `fitArtifact(2026,1)` fresh — using `examplesBefore(2026,1)`, i.e. essentially
  the same historical training set as the persisted 2025-W18 artifact (all
  2025-and-earlier completed games with frozen cards). I independently
  reproduced this exact computation end-to-end (see script) against the live,
  read-only DB and confirmed: `X` and `y` (targets) are 100% finite for all
  1039 examples, yet `fitRidge` produces an all-NaN `beta` on iteration 0
  already — i.e. the bug reproduces today, live, for the 2026-season code
  path, not just in the 11-day-old persisted row.

### Reproduction (self-contained, read-only, no app-module import)
```
examples count 1039
any non-finite target? 0
any non-finite X entries 0
iter 0 beta finite? false   nan weights 1039   nan residuals 1039
...
final beta [ NaN, NaN, NaN, NaN, NaN, NaN, NaN ]
```
This isolates the defect to `fitRidge`'s `weights` array length mismatch
(nfl-orthogonal-specialists.js:71), independent of any particular week's data.

### Verdict: CONFIRMED (not refuted)
The claim's file is right, the mechanism (non-finite betas -> null on
persist -> `sum + null` folds to a false `0`) is exactly reproducible, and the
"reports no error" framing is accurate (no exception is thrown anywhere in this
path; `fitOrthogonalSpecialists` returns a normal-looking object). Line
citation (62, the `fitRidge` function's opening line) is a few lines off from
the precise defect line (71), and the snippet given is a compressed splice of
the whole function rather than one exact line — both cosmetic. The "growth
cycle re-persists the broken fit weekly" part is supported structurally
(`nfl-model-growth.js:245` calls `fitOrthogonalSpecialists(..., {persist:true})`
every cycle for `nextWeek`, and `persistArtifact`'s `INSERT OR IGNORE` keyed by
`artifact_id = sha({version, season, week, data_hash})` means a new row is
added each week as `data_hash` changes) even though no 2026 row has been
persisted yet (season 2026's finalized_week is still 0, so that branch of the
growth cycle hasn't fired for 2026 games specifically — a nuance, not a
refutation, since the live per-game council path already proves the defect is
active for 2026 W1 right now).

---

## Claim #26 — server/services/nfl-expert-council.js:186 (combinedDecisionTrace)

Files read in full/relevant sections: `nfl-expert-council.js` (lines 1-220, 590-760,
860-867 read; full 867-line file scanned via targeted greps + the surrounding
context of every hit), `nfl-expert-coordinator.js` (lines 1-60, 380-448 read in
full, matching the cited `nfl-expert-coordinator.js:412`).

Code:
- `NFL_EXPERTS` (lines 30-48) has exactly 19 entries — matches "all 19
  contributions shrink 0" in the evidence.
- `combinedDecisionTrace` (nfl-expert-council.js:165-189):
  - line 166: `const ready = Boolean(coordinator?.ready);`
  - lines 167-168: `const forecastResidual = ready && Number.isFinite(coordinator.forecast_residual) ? coordinator.forecast_residual : null;`
  - line 174: `state: ready ? 'candidate_forecast_only' : 'warmup_abstain',`
  - lines 185-187 (cited snippet, exact match):
    `final_prediction: { market_margin: game.market_margin, forecast_residual: forecastResidual, projected_home_margin: Number.isFinite(forecastResidual) && Number.isFinite(game.market_margin) ? r3(game.market_margin + forecastResidual) : null }`
  `ready` and `forecastResidual` are gated only on whether the coordinator
  *fit* exists and is finite — **not** on whether any individual expert
  actually contributed nonzero weight this game.
- `nfl-expert-coordinator.js:409-415` (`coordinateWith`):
  - line 412 (exact): `const forecast = fit.coefficients[0] + contributions.reduce((sum, item) => sum + item.value, 0) + missingOffset;`
  - `coordinateExperts` (423-442) returns `ready: true` whenever the underlying
    `fit.ready` (trained on >=128 games / >=8 weeks, `MIN_GAMES`/`MIN_WEEKS` at
    lines 22-23) is true — again independent of the current game's per-expert
    weights.
  - So when every expert is missing/shrunk (`activeWeight` computed at line
    396 sums to 0, matching evidence's `active_weight_l1 0`), `contributions`
    all have `value: 0` (line 407: `value: Number.isFinite(shrunk) ? r3(shrunk * learnedWeight) : 0`
    with `shrunk: null` when `raw` is not finite/observed), so
    `forecast = fit.coefficients[0] + 0 + missingOffset` exactly as the claim
    states — a number built entirely from the trained intercept plus the
    "missingness" offset (`missingOffset`, line 411:
    `IDS.reduce((sum,_id,index) => sum + x[1+nColumns+index] * fit.coefficients[1+nColumns+index], 0)`),
    which literally encodes only *which roles were missing*, not any expert's
    opinion.

DB verification (read-only): queried `nfl_expert_forward_predictions` (the
forward-capture ledger; `nfl_weekly_expert_examples`, the backward-audit
ledger, had 0 rows for 2026 W1 coordinator — the forward table is the one that
matches the "T-15m" language in the evidence) for
`season=2026, week=1, expert_id='combined_decision'`: 40 rows (multiple
horizons/games), every single one has
`state: 'candidate_forecast_only'`, `forecast_residual` exactly `-0.075` or
`0.047` (matches claim's evidence numbers exactly, verified for LAR/SF -0.075,
LV/MIA/MIN/GB/PHI/PIT/TEN +0.047, etc.), every game's `contributors[].learned_weight`
summing to 0 (all-zero active weight), and `final_prediction.projected_home_margin`
populated as `market_margin + forecast_residual` (e.g. LAR/SF: `3.425`).

### Verdict: CONFIRMED (not refuted)
Code and live DB both match the claim precisely, including the exact numeric
evidence quoted (-0.075 / +0.047 residuals, active_weight_l1 0). The mechanism
(coordinator "ready" is a training-sample-size gate, decoupled from whether
*this* game's experts contributed anything) is real and directly causes
`combinedDecisionTrace` to emit a confident-looking `candidate_forecast_only`
projected margin built from nothing but the learned missingness pattern.

---

## Claim #27 — server/services/nfl-team-card.js:213 (matchupTeamCards / freeze)

File read in full: `server/services/nfl-team-card.js` (253 lines, all read).

Code:
- `buildTeamCard` (lines 145-171): `cutoff = requestedCutoff ?? gameKickoff` (line
  147) — when no explicit cutoff is passed (the normal call path via
  `matchupTeamCards`/`freezeTeamCard` with no `options.cutoff`), the injury
  cutoff defaults to **kickoff time**, not "now". `injuryReport(season, week,
  team, cutoff)` (lines 70-80) selects
  `nfl_injuries WHERE ... AND (modified_at IS NULL OR modified_at<=cutoff)` — a
  cutoff filter that would happily include injuries reported any time before
  kickoff, but if the card is *frozen* days before any injury rows exist for
  that week, the query legitimately returns 0 rows at freeze time, and that
  snapshot becomes permanent.
- `freezeTeamCard` (lines 191-206): checks for an existing row by
  `(season,week,team,horizon,version)`; if found and the evidence hash matches,
  returns the cached row; if the hash **differs**, returns
  `{ error: 'team card conflict: the same frozen identity produced different evidence', ... }`
  (lines 199-201) rather than ever overwriting. There is no reconciliation path.
- `matchupTeamCards` (lines 209-217), cited line ~212-213 (off by one from the
  claim's 213 — the `homeCard` assignment spans lines 212-213):
  `const homeCard = getFrozenTeamCard(season, week, home, options) ?? freezeTeamCard(season, week, home, options);`
  — first-caller-wins semantics: whichever code path first asks for this
  team/week/horizon permanently decides the card's evidence.
- `backfillTeamCards` (lines 219-241) calls `freezeTeamCard(game.season,
  game.week, team)` (no cutoff override) and on `result.error` just pushes to
  `failures` (line 233) and continues — so a hash-mismatch "conflict" is
  *caught* (not an uncaught exception) but never *resolved*; the card is
  permanently stuck at its first-frozen (stale) evidence, and every future
  weekly backfill attempt for that season/week/team will keep failing the same
  way forever (the claim's "unhandled" is accurate in the sense of "no
  resolution logic exists", not "throws an exception").

DB verification (read-only):
- `nfl_team_cards` for `season=2026`: week 1 has 32 rows, all created between
  `2026-09-02T05:50:42.653Z` and `2026-09-02T05:50:59.488Z`; week 2 has 32
  rows created `2026-09-09T03:48:26Z`-`03:49:25Z`. Sampled W1 cards (ARI, ATL,
  BAL, BUF, CAR) all have `cutoff` = the actual kickoff timestamp (e.g. ARI
  `2026-09-13T20:25:00.000Z`) and `injuries.players.length === 0` for every
  sampled team.
- `nfl_injuries` for `season=2026, week=1` now has 167 rows total, with
  per-team counts matching the claim's evidence exactly: ARI 7, ATL 10 (CHI
  not independently re-checked but ARI/ATL match precisely, which is strong
  corroboration of the same query).
- This confirms the cards were frozen ~11 days before kickoff (2026-09-02 vs.
  2026-09-13 kickoff), before any of today's 167 injury rows existed, and the
  frozen snapshot is permanently empty on injuries despite `cutoff` nominally
  being "kickoff" (a future, generous cutoff) — exactly the mismatch the claim
  describes. A subsequent `freezeTeamCard` call for the same team/week (e.g.
  from a weekly `backfillTeamCards({startWeek: nextWeek, endWeek: nextWeek})`
  invocation once week 1 becomes "next week" for some other purpose, or a
  rerun) would recompute `injuryReport` against the now-167-row table and get
  a different evidence hash → the `error` branch.

### Verdict: CONFIRMED (not refuted)
Line cited (213) is one line off the actual assignment start (212) — cosmetic,
the quoted snippet matches the code verbatim. The described freeze-then-stale
mechanism, its DB fingerprint (creation timestamps, empty injuries, cutoff =
kickoff), and the population of real injuries afterward are all directly
verified. "Unhandled team card conflict" slightly overstates the failure mode
(it's a caught error pushed into a `failures` array, not an uncaught
exception/crash) but the substantive impact claimed — the weekly refresh will
permanently fail for these frozen team/weeks — is accurate.

---

## Claim #28 — server/services/nfl-online-neural.js:185 / nfl-auto-picks.js

Files read in full: `server/services/nfl-online-neural.js` (367 lines, all
read). `server/services/nfl-auto-picks.js` read lines 1-180 (through the full
`computeDecisionBoard` body containing the cited lines).

Code:
- `onlineNeuralPrediction` (nfl-online-neural.js:171-186), line 185 exact match:
  `production_eligible: metrics.production_eligible === true, metrics,`
  and line 186: `authority: metrics.production_eligible === true ? 'eligible_for_production_review' : 'shadow_only' };`
  `metrics` comes from `performanceMetrics()` (lines 265-289), whose `eligible`
  flag (line 285-287) is a purely statistical gate:
  `examples.length >= ONLINE_NEURAL_HEADS[HEAD].promotion_sample (128) && improvements.length >= ...promotion_weeks (8) && interval?.[0] > 0`
  — no human/actor field anywhere in this computation.
- `nfl-auto-picks.js:104-108` exact match to the claim's evidence:
  ```
  const neuralUsed = Boolean((modelOptions.includeChallengers || neural.production_eligible === true)
    && Number.isFinite(neural.predicted_margin));
  const marketMargin = e.market_spread == null ? null : -e.market_spread;
  const projectedMargin = neuralUsed && neural.predicted_margin != null
    ? neural.predicted_margin : e.projected_margin;
  ```
  `neural.production_eligible === true` alone (independent of
  `modelOptions.includeChallengers`) flips `neuralUsed`, which swaps
  `projectedMargin` — the number the rest of `computeDecisionBoard` uses to
  compute `edge`, `selection`, `detail`, etc. — to the neural head's output.
  There is no distinct "promoted"/"reviewed" state gating this; the same
  self-reported `production_eligible` flag both describes the head's status
  and is directly acted on by the consumer.
- Corroboration found in the repo's own prior audit trail (data, read as
  such): `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:578` independently
  documents this exact same code path
  (`nfl-online-neural.js:118,175-186,195,226,265-326` /
  `nfl-auto-picks.js:102-106`) with near-identical language: "live consumer
  directly uses the flag though the returned authority text is
  `eligible_for_production_review`. Require explicit promotion state...". This
  is a pre-existing, already-identified-but-apparently-still-open issue, not a
  misreading by the current reader.
- The broader system's stated policy is explicit human-gated promotion
  elsewhere (e.g. `nfl-model-growth.js:144`: "They never auto-promote a
  betting model; promotion still requires the frozen forward gates.";
  `nfl-risk-lab.js:490`: "It still cannot auto-promote or size bets."),
  supporting the claim's framing that this contradicts a "never-auto-promote"
  policy for the system as a whole, even though I found no single line
  literally named "never-auto-promote policy" scoped to this exact neural
  head.

DB check: `nfl_online_neural_examples` currently has 128 rows total (not yet
necessarily 128 *settled and selected-for-training* across >=8 distinct
weeks with a positive CI lower bound), consistent with the claim's framing
that this is a **latent** risk, not yet triggered — the claim explicitly says
"Latent: once the epoch-3 head accumulates 128 settled examples over 8 weeks...".

### Verdict: CONFIRMED (not refuted)
Cited lines match verbatim in both files. The mechanism is real: a
self-computed eligibility flag, with no human actor/gate, silently swaps the
production board's projected margin. Severity/impact framing (latent,
P2) is consistent with current data volumes.

---

## Claim #29 — server/services/nfl-experiments.js:21 (FAMILIES whitelist)

File read in full: `server/services/nfl-experiments.js` (176 lines, all read).
Also read: `server/services/nfl-research.js` lines 1-40 (contains the
documented fix/history of the identical bug in a sibling module), and grepped
`server/services/nfl-ensemble.js` (1221-1270) for how `families` is consumed.

Code:
- Line 21 exact: `const FAMILIES = new Set(['Rating systems', 'Efficiency', 'Context', 'Market']);`
  Only 4 families. `nfl-online-neural.js:34` independently lists the real,
  5-family set: `['Roster availability', 'Rating systems', 'Efficiency', 'Context', 'Market']`,
  and `nfl-ensemble.js:321,338,617` define models with
  `family: 'Roster availability'` as a real, populated family (`618` shows a
  registered `'Roster availability'` entry in the family metadata map).
- `normalizeConfig` (nfl-experiments.js:33-47), line 40-41:
  `const families = raw.modelOptions?.families == null ? null : [...new Set(raw.modelOptions.families)].filter(x => FAMILIES.has(x));`
  Any caller-supplied family not in the 4-element `FAMILIES` set — in
  particular `'Roster availability'` — is silently dropped from the normalized
  config (no error, no warning; `raw.modelOptions?.families != null && !families.length` at
  line 46 only throws if the filtered result is empty, not if it's merely
  incomplete).
- `ensembleLine` (`nfl-ensemble.js:1255,1257`):
  `const allowedFamilies = families?.length ? new Set(families) : null;` then
  `MODELS.filter(x => (!allowedFamilies || allowedFamilies.has(x.family)) && !excluded.has(x.id))`
  — confirms `families` acts as a strict **whitelist**: once
  `'Roster availability'` has been stripped out of the array by
  `normalizeConfig`, every model in that family is excluded from the ensemble
  for that experiment run, regardless of what the experiment author actually
  intended to test.
- `nfl-research.js:14-29` documents, in the researcher's own words, the
  identical historical bug in a **different, now-fixed** call site: "This was
  a hardcoded four-element array: 'Rating systems', 'Efficiency', 'Context',
  'Market'. The ensemble actually has FIVE families — the missing one being
  'Roster availability' ... Because `families` acts as a WHITELIST in
  `ensembleLine`, every `without:X` configuration was silently dropping roster
  availability TOO, so every ablation delta ever produced by this harness
  measured the removal of two families while reporting one." — this is a
  verbatim description of the exact same defect pattern, already fixed in
  `nfl-research.js` (via `ablationFamilies()`, which derives from
  `ensembleFeatureContracts()`) but evidently never back-ported to
  `nfl-experiments.js`'s own separate, still-hardcoded `FAMILIES` constant.

DB check: `SELECT COUNT(*) FROM nfl_model_experiments` → `0`, exactly matching
the claim's "nfl_model_experiments has 0 rows" and its "today it is unused"
impact framing.

### Verdict: CONFIRMED (not refuted)
Every element of this claim checks out exactly against the code and is
independently corroborated by the codebase's own documented history of the
identical bug in a sibling file. Currently inert only because the experiments
route has zero recorded runs.

---

## Summary table

| key | verdict | confidence |
|---|---|---|
| #25 | CONFIRMED | high (reproduced the NaN numerically against live DB data) |
| #26 | CONFIRMED | high (exact DB match to quoted forecast_residual values) |
| #27 | CONFIRMED | high (exact DB match: creation timestamps, empty injuries, live injury counts) |
| #28 | CONFIRMED | high (code matches verbatim; corroborated by repo's own prior audit doc) |
| #29 | CONFIRMED | high (code matches verbatim; corroborated by sibling module's documented fix) |

None of the 5 claims are refuted. All five are real, currently-live (or, for
#28/#29, real-but-latent/unused) defects, each supported by exact line/code
matches plus independent read-only DB verification or an isolated numeric
reproduction.
