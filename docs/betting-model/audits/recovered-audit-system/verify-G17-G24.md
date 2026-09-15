# Adversarial verification, materiality lens — G17..G24
Repo read-only. All DB reads via node:sqlite readOnly:true on server/data.sqlite.

## G17 audit registry gate — SURVIVES (narrowed)
- audit-registry.js:197-198 `priorTests = COUNT(sealed)` **at run time**; :286 auditHistory recomputes
  `corrected = 1 - (1-alpha)^(1/n)` over the FINAL sealed count. Two different alphas: the one that
  decided the stored `passed`, and the one printed in `multiple_comparisons.sidak_corrected_alpha` /
  `survive_correction`. Exposed to Nick at routes/betting-hub.js:676-677.
- :219 `p_always_valid ?? p_fixed_sample_only` — but the RETURN object (:253-262) keeps
  `p_always_valid`, `p_fixed_sample_only`, `anytime_valid`, `variance_source` apart. Only the DB
  column `always_valid_p` and auditHistory's per-audit row collapse them. So "collapses the C17
  relabel" is true of the persisted/history view only, not of runAudit's own report.
- :220 Šidák alpha applied to the mSPRT p is a category mix but is CONSERVATIVE (Šidák alpha <= 0.05),
  so it can never manufacture a pass.
- Live DB: 15 rows, always_valid_p NULL on all 15; p_value non-null on 3 (0.478, 0.488, 0.652) —
  nowhere near any alpha. Nothing currently flips. Survives on the forward record: `passed` is a
  recorded decision whose threshold depends on when the audit happened to be run, which contradicts
  the module's own "criterion declared BEFORE the number" promise (:26-28).

## G18 findings holdout — SURVIVES
- nfl-candidate-findings.js:218 `passed = result.helped_holdout === true`;
  nfl-replay.js:811 `helpedHoldout = (holdAdj.roi ?? -9) > (holdBase.roi ?? -9)` — a strict inequality
  on one season's ROI. No effect size, no minimum matching-bet count, no interval. 3 independent
  passes (REQUIRED_HOLDOUT_CONFIRMATIONS = :189) reach `flagged_for_review`, the one state a human
  promotes from into a LIVE veto (promotedFindingVeto is wired into nfl-auto-picks.js:12).
- No chronological fence: assertSeasonRoleAvailable (:83-88) only forbids the SAME season in the other
  role. routes/nfl-betting.js:229-235 accepts `body.season`; nfl-model-growth.js:256 runs the ledger
  for any season whose `season_complete` is true, so a 2022 rerun can be booked as "holdout" for a
  finding discovered on 2023/2024.
- Weak sub-claim: "promotion trusts a mutable column". promoteFindingToShrink (:367-...) has no HTTP
  route, requires an explicit `actor`, refuses `strong`, and re-runs assertRuleUnchanged. Reaching it
  by SQL UPDATE (tests 104/116/158/221) is a manual-DB path, not an app path.
- Live: 1 finding, state `discovered`, discovery seasons [2021..2025] — every past season is already
  locked as discovery, so its next holdouts are 2026+. The fence gap is structural, not realised.

## G19 family ablation "refit" — REFUTED (materiality)
The label is loose but the NUMBERS are identical to a true refit:
- nfl-ensemble.js:1238 `fitEnsemble({beforeSeason, beforeWeek, weighting, includeChallengers})` — no
  `families`, correct. :1257 filters MODELS after the fit.
- But each model's `margin_rmse`/`total_rmse` is accumulated per model independently (:1070-1090,
  :1112-1138) — removing a family changes no surviving model's RMSE.
- Weights are `exp(-0.7*rmse)` normalised over all models (:1160-1175), and the blend RE-normalises
  over only the models actually present: `usable`/`wsum` at :1275-1282, residual at :1291-1294.
  Proportional rescaling cancels, so filter-then-renormalise == refit-over-remaining-families.
- `calibration` (:1011-1014) and the residual gate (:1185-1189) are family-independent.
=> `ablation_kind: 'refit_leave_one_family_out'` (nfl-family-contribution.js:390) and
   nfl-research.js:139-142 describe the right numbers. Cost-as-model-count (:375) feeds nothing:
   decideFamily (:398-444) never reads `cost`. Missing identity hashes change no value on a
   `diagnostic_only` report that cannot promote anything (:386-388).

## G20 line-move study — SURVIVES (strongest of the study claims)
- line-move-study.js:39 `HOLDOUT_FROM = 2024`; :364 holdout = seasons >= 2024.
- :132 `fitModel()` when `selectionThrough == null` (the default, and report-cache.js:61 calls it with
  `[{}]`). nfl-market.js:130 `selectionCap = lastSeason - 1`. Live DB: max season with scores = 2026
  => selectionCap = 2025 => alpha/carryover selected on seasons <= 2025, i.e. on BOTH held-out seasons.
  The `selectionThrough` parameter exists for exactly this (nfl-market.js:107-112) and is never passed.
  The contaminated feature is `T0.ratings_vs_open` (:185) — the signal promoted to a live rule
  (beat-the-close.js:44, "+0.58 CLV, 57.7%, n 570 held out").
- :196-202 T2 = ACTUAL kickoff-hour weather, self-labelled "the actual hour stands in for a Friday
  forecast". The honest lead-2/lead-3 forecast exists beside it (:206-210), and beat-the-close.js:52-53
  records the drop (+0.47 -> +0.28) — i.e. the project already measured the leak's size.
- Third-party: TeamRankings is date-verified (nfl-external-ratings.js:135/145/224 store the page's own
  `as_of` and target `wednesdayOf`), so that half of the claim is weak; nfelo carries only a bulk
  `fetched_at` (nfelo.js:237, 300) with no per-date availability evidence.

## G21 live beat-the-close rules — REFUTED (downgrade to P3 note)
- The two candidates are real (RULES :45, :51-52) but nothing pools them: `cleanDecisions({signal})`
  filters by `model_version` (:326), `beatTheCloseStatus` reports `by_signal` with
  `rule: RULES[signal]` (:355-358), and `weeklyRead` iterates per signal and prints
  `historical_basis: RULES[signal].basis` (:395-396, :438) — which contains the literal strings
  "candidate, not a passed signal" and "under the +0.3 gate". Stake is 0 everywhere (:253),
  retirement state is per-signal (:416-431).
- Opener fallback (:78-82) has NEVER fired: all 35,239 nfl_signal_snapshots rows carry
  `detail_json.opener_source = 'archive:pinnacle:open'`.
- Real residual (P3): the frozen `feature` snapshot at :250-253 omits `opener_source`, so if the
  fallback ever fires the decision row itself cannot say which opener it used — only the parallel
  nfl_signal_snapshots row (:136, :203) can.
- Live: 61 beat-the-close decisions (16 candidate-rule), 6 settled.

## G22 packet scoping — SURVIVES
- nfl-t60-packet.js:264-270: the news query has NO WHERE clause at all — any row anywhere in
  nfl_news_events makes the source `received_by_cutoff` for every game. test/nfl-t60-packet.test.js
  :131-139 pins that behaviour (a news row about nobody, asserted eligible for the fixture game).
- :250-255 injuries scoped to season/week only (no team/player). :300-313 weather/features by
  season/week/home. Only the quote tape persists actual values (:240-243) after C11 fixed exactly
  this defect class for quotes (:162-184).
- Consequence: `summary.eligible` / `rows` per game and everything decisionTimeManifest aggregates
  from them (:383-393, coverage.by_claim / per_season.any_eligible) are a per-game knowability claim
  resting partly on rows about other games. No forecast consumes the packet (t60-runner.js:127-129
  stores only a hash), so no bet changes — but the packet IS the record of what was knowable.

## G23 'missed' unreachable — SURVIVES
- t60-runner.js:245-250 `runT60Pass` = open -> captureDueObservations -> markMissedObservations.
  :106-108 selects every `scheduled` row with `cutoff_at <= now` with NO upper bound, and each becomes
  `frozen` or `failed` (:127, :121). markMissedObservations (:160-161) then finds only rows still
  `scheduled`, of which there are none. `graceMinutes` (:158) is dead on that path; the only test that
  exercises `missed` calls it directly (test/t60-runner.test.js:74-83).
- Live proof: the single nfl_t60_observations row has cutoff_at 2026-09-10T23:35:00Z and
  capture_started_at 2026-09-10T23:37:32Z — captured 2m32s AFTER its cutoff, state `frozen`. Nothing
  bounds how late that can be.
- What changes: `t60Coverage.by_state` and `captured_rate` (:288-289) — the numbers the module says it
  exists for (:14-20) — would read 100% through a collector outage as soon as the job runs again.
  Packet CONTENT is unaffected (freezeT60Packet filters by receipt clock against cutoffAt).

## G24 forward provenance vs horizon — SURVIVES (highest materiality)
- nfl-evidence-provenance.js:4-5 and :36: `late = stamps.filter(s => s.at > row.evidence_cutoff)`,
  and evidence_cutoff is the KICKOFF (nfl-expert-council.js:654 `const kickoff = Date.parse(item.game.evidence_cutoff)`,
  written unchanged for every horizon at :688).
- nfl_expert_forward_predictions holds 7 horizons: open/scheduled/T-24h/T-6h/T-60m/T-15m/close — all
  with the same kickoff cutoff.
- Re-ran the module's own collectTimestamps against each row's OWN horizon cutoff
  (kickoff - lead): of 155 stamped rows, 8 carry a stamp later than their horizon cutoff
  (T-24h:3, T-6h:3, T-60m:1, T-15m:1). All are reported clean today, and
  `verdict` (:60) currently reads "every stamped input predates its kickoff".
  Closing this moves flagged_rows 0 -> >=8 on the live forward ledger.
