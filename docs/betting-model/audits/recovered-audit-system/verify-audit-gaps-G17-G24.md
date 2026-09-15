# Adversarial verification, practice-truth lens — gaps G17-G24
Repo read-only. Live DB read via node:sqlite readOnly:true. No web lookups. 2026-09-12.

## G17 registry gate — SURVIVES (narrowed)
Verified:
- audit-registry.js:219 `const alwaysValidP = alwaysValid ? (alwaysValid.p_always_valid ?? alwaysValid.p_fixed_sample_only) : null;`
  Both C17 branches feed one gate variable; :220 `alwaysValidSignificant = alwaysValid ? alwaysValidP < correctedAlpha : null`.
- backtest-significance.js:239-250 returns EITHER `p_always_valid` (sigma declared, `anytime_valid:true`) OR
  `p_fixed_sample_only` ("NOT anytime-valid ... Ville's inequality does not apply").
- Persisted column is `always_valid_p` for either branch (:230-240 UPDATE), and auditHistory:306
  `always_valid_p: r4(a.always_valid_p)` reports it under that name with no variance_source. THIS is the real collapse:
  runAudit's own return object does still distinguish them (:250-262 `p_always_valid` / `p_fixed_sample_only` /
  `anytime_valid` / `variance_source`), so the "collapse" is at the persistence + history layer, not the response.
- Run-order alpha: :197-198 `priorTests = COUNT(*) ... status='sealed'`; `correctedAlpha = 1-0.95^(1/(priorTests+1))`.
  First audit run gets 0.05, the 15th gets ~0.0034. auditHistory:282-286 recomputes with the FINAL sealed n, so a
  sealed passed=1 can disagree with the history's own `survive_correction` list. Identical evidence, different verdict
  by order of execution.
- dataSignature :62-71 = six COUNT(*) values (game_lines, nfl_team_week_features, nfl_play_by_play, nfl_injuries,
  nfl_line_snapshots, espn_line_moves) — edits that preserve row counts are invisible. Not in the should_be.
Live DB (15 rows): always_valid_p NULL on all 15; require_significance=1 on ids 6,9,12(void),13,14,15 → 5 sealed, all
passed=0. id=14 observed 0.5789 vs threshold 0.5238 MET the threshold and still failed, because no sequence was
supplied, so the always-valid gate could not be evaluated. The gate is currently unpassable, not merely strict.
Refuted portion: "sequential p its own alpha" is not a standard. An anytime-valid p-value is a valid p at any stopping
time, so thresholding it at a Sidak alpha is conservative and correct; multiplicity and anytime-validity are
orthogonal corrections that compose. Surviving core = run-order-dependent alpha (family size must be declared at
preregistration) + a fixed-sample p persisted and reported under the name `always_valid_p`.

## G18 findings holdout — SURVIVES
- nfl-candidate-findings.js:218 `const passed = result.helped_holdout === true;`
- nfl-replay.js:810-811 `helpedHoldout = (holdAdj.roi ?? -9) > (holdBase.roi ?? -9)` — a bare sign test on a single
  season's ROI. No effect size, no interval, no minimum count of bets matching the segment. `uncertainty(list)` is
  computed in `score` (:799) and never consulted by the pass rule.
- Fence: :208 assertSeasonRoleAvailable + UNIQUE(finding_id, season) — per FINDING only. Nothing compares a holdout
  season to a global development cutoff; 2021-2025 are the seasons the whole replay/ensemble was built on.
- Promotion: :366-376 promoteFindingToShrink checks `finding.state !== 'flagged_for_review'` (a mutable column),
  actor, direction, assertRuleUnchanged. It never recounts nfl_candidate_finding_seasons holdout rows.
- Tests reach promotion by `UPDATE nfl_candidate_findings SET state='flagged_for_review'` at
  test/nfl-candidate-findings.test.js:104, 116, 158, 219 — the column is the only thing standing between
  "no evidence" and "live veto authority".
- Route path: routes/nfl-betting.js ~231 `season: Number(req.body?.season) || undefined` →
  runNflModelGrowthCycle → nfl-model-growth.js:256 runCandidateFindingsForSeasonEnd(season).
- P(3 straight directional passes | null) = 0.5^3 = 12.5%, as claimed (slightly less, since a tie scores as a fail).
Nuance: ">2025" is a project-specific instantiation of the standard principle (a holdout must postdate everything the
pipeline's design was informed by); the principle itself is not opinion.

## G19 family ablation — SURVIVES (strongest of the batch)
- nfl-ensemble.js:985-986 `export function fitEnsemble({ evalFrom, beforeSeason, beforeWeek, weighting, includeChallengers })`
  — there is NO `families` parameter. A refit per family set is not expressible.
- :1238 `const fit = fitEnsemble({ beforeSeason: season, beforeWeek: week, weighting, includeChallengers });`
- :1256-1257 `for (const m of MODELS.filter(x => (!allowedFamilies || allowedFamilies.has(x.family)) && ...))`
  — families filters which models CONTRIBUTE to the blend; weights come from the all-model fit and are renormalised
  by `wsum` in `blend`. That is frozen-fit removal sensitivity.
- Label: nfl-family-contribution.js:390 `ablation_kind: 'refit_leave_one_family_out'`;
  nfl-research.js:138-142 `'Each configuration REFITS the ensemble over the remaining families rather than zeroing a
  trained input, so this is a true leave-one-family-out ablation'`. Both false.
- Cost: :374-375 `models_removed` / `share_of_ensemble` = model_count / contracts.length.
- Report (:385-395) carries version/seasons/markets/scope/universe/baseline/families/consumers/policy — no data
  fingerprint, no fit artifact key, no calibration identity, although fitEnsemble already computes
  `fitDataFingerprint()`/`fitArtifactKey` (:991-992) and audit-registry already does codeHash/dataSignature.
Only soft part of the should_be: "measured runtime cost" is a preference, not a standard.

## G20 line-move study — SURVIVES (narrowed)
- line-move-study.js:196-199 `// Kickoff-hour weather (3d): the actual hour stands in for a Friday forecast, so it
  is a T2 feature.` → `features.T2.wind_kmh = wx?.wind_kmh ?? 0` from `gameWeather` (realised conditions). The honest
  version sits two lines below (`wind_kmh_forecast_lead2`, :205-207), so the file already knows the difference.
  Corroborated live: beat-the-close.js:52-53 — +0.47 CLV on the ACTUAL kickoff-hour wind, +0.28 [0.11,0.45] on the
  knowable lead-2 forecast, under the +0.3 gate.
- :132 `const market = includeModels ? (selectionThrough == null ? fitModel() : fitRatings({ selectionThrough })) : null;`
  fitModel() (nfl-market.js:100-105) calls fitRatings({}), and :130
  `const selectionCap = selectionThrough == null ? lastSeason - 1 : ...` → alpha/carryover chosen on seasons <= 2024
  while HOLDOUT_FROM = 2024 (line-move-study.js:38). report-cache.js:61 runs `lineMoveStudy` with `args: [{}]`, so the
  served report is the leaking path. `ratings_vs_open` — the one signal promoted to a live rule — is built from it.
- nfelo: nfl-external-ratings/nfelo.js carry only `fetched_at` (nfelo.js:111,131,237) — when we downloaded a bulk
  backfill, not when greerreNFL published. Treating `nfelo_pre_vs_open` as T0-knowable (:216-218) is an assumption.
  docs/CLAUDE-NEXT-STEPS.md nfelo row demands "Exact historical availability ... no blind vendoring".
Refuted portion: TeamRankings is NOT an unverified backfill. nfl-external-ratings.js:224-225 rejects a snapshot whose
page `as_of` differs from the requested Wednesday, and :171/:235 store the Wednesday of the game week — the T1 stamp
is evidenced per date. Narrow the claim to nfelo.

## G21 live beat-the-close — SURVIVES
- beat-the-close.js RULES:45 `ratings_vs_open_total ... 'the ratings term alone was weak (+0.08) — candidate, not a
  passed signal'`; :50-53 `wind_total ... +0.28 [0.11, 0.45], 56.2% — under the +0.3 gate. Candidate'`.
- decideBeatTheClose:212 `const rule = RULES[sig.signal]; if (!rule) continue;` — every RULES key is a live frozen
  rule; the pass/candidate distinction exists only inside the prose `basis` string, and weeklyRead:~430 loops
  `Object.keys(RULES)` and runs the same retirement machinery on all five.
- openerFor:71-83: archive Pinnacle open, else `ORDER BY captured_at ASC LIMIT 1` on live free:pinnacle snapshots,
  tagged `source:'free:pinnacle:first-capture'`. signalsFor:135 puts `opener_source` in `detail` only; snapshotSignals
  persists it in nfl_signal_snapshots.detail_json — and decideBeatTheClose's `feature` object (:238-245) does NOT
  include it at all, so the shadow_decisions row that grades CLV never records which reference it used. weeklyRead has
  no split on it.
Mitigation, not refutation: stake_units is 0 everywhere and the module disclaims staking authority; the defect is
evidence accounting (9.2: "count every attempted model, threshold ... in the trial register"; "reference composition"
is named explicitly in the CLV scorecard row).

## G22 packet scoping — SURVIVES
- nfl-t60-packet.js:264-270 `FROM nfl_news_events` with only the three cutoff comparisons — no WHERE. Any news row in
  the database, about any team, makes the source `received_by_cutoff` for every game.
- :250-255 injuries `WHERE season = ? AND week = ?` — no team predicate.
- :296 team features `WHERE season=? AND week < ?` — season only.
- Only the quote tape carries actual rows (:240-245 `values: receivedByCutoff.map(...)`), and it is the one source
  C11 was applied to; its own comment (:230-232) quotes C11: "It does not persist the actual rows, values, identities
  and fitted artifacts consumed by a forecast."
- test/nfl-t60-packet.test.js:130-145 inserts one unrelated news row and asserts
  `sourceIn(prospective,'nfl_news_events').claim === 'received_by_cutoff'` — the behaviour is pinned by test.
The standard invoked is the module's own declared one, so this is not opinion.

## G23 unreachable 'missed' — SURVIVES (narrowed)
- t60-runner.js:247-250 `WHERE experiment_id=? AND state='scheduled' AND cutoff_at <= ?` — lower-bounded only by the
  cutoff, never upper-bounded. Every branch of the loop leaves the row 'frozen' or 'failed'.
- runT60Pass:246-256 runs captureDueObservations BEFORE markMissedObservations, so nothing can still be 'scheduled'
  when :158-168 looks; `graceMinutes = 10` never bites on that path. openObservations:78 refuses to open a row whose
  cutoff already passed, so a stale 'scheduled' row IS an outage — and the next pass silently heals it.
- test/t60-runner.test.js:74-83 exercises markMissedObservations standalone, never through runT60Pass.
Partial refutation: this is NOT evidence leakage. freezeT60Packet filters every source by `cutoffAt`, so a late
reconstruction has the same contents a timely capture would have had (revisions after the cutoff are excluded by
construction). The surviving defect is coverage honesty — t60Coverage:290 `captured_rate` counts the reconstruction as
a capture, which is precisely the "a quiet week and a broken collector must not look the same" property the module's
own header claims (:14-20), and the row carries no late marker because captureDueObservations passes
`computationStartedAt` but not `computationFinishedAt`, leaving packet.emitted_after_cutoff null.

## G24 provenance checks kickoff — SURVIVES (strongest evidence)
- nfl-evidence-provenance.js:4-5 "Every frozen expert row carries an `evidence_cutoff` (the game's kickoff)";
  :35-36 `const cutoff = row.evidence_cutoff; const late = stamps.filter(s => cutoff && s.at > cutoff);`
  :54 `row.captured_at > row.evidence_cutoff` — same kickoff comparison.
- Provenance of that column: nfl-expert-council.js:688 writes `item.game.evidence_cutoff`, which is
  nfl-unified-engine.js:66 `evidence_cutoff: cutoff` = `gameCutoff(season, week, h)` (game-cutoff.js:19-23 = scheduled
  kickoff). `horizon` is a separate, free-text column (:632, :688).
- Live DB, nfl_expert_forward_predictions: horizons open / scheduled / T-24h / T-6h / T-60m / T-15m / close all exist
  (2,625 rows), and for CAR week 1 every one of the seven rows carries the SAME evidence_cutoff
  2026-09-13T17:00:00.000Z while captured_at ranges 2026-09-02T05:50 → 2026-09-10T00:20. A T-60m row whose payload
  carries a T-15m stamp is reported `stamped` / clean, and `verdict` reads "every stamped input predates its kickoff".
- Secondary symptom: the T-60m row was captured ~89 hours before kickoff, so the horizon labels are decoupled from the
  actual capture instant in both directions; nothing in the verifier notices.
