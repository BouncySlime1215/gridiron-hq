# G05 verify (lens=code-truth) — Historical audit grades a forecast that is not served (raw vs market_residual)

Verdict: NOT REFUTED. Every cited path:line is accurate; the code does not do what should_be says; the DB confirms runs 27/32 carry no blend mode in spec_json and are not relabelled.

Files read in full: server/services/nfl-replay.js (1102), nfl-ensemble.js (1423), nfl-auto-picks.js (285), nfl-blind-audit.js (1005), nfl-forecast-identity.js (67). Partial: nfl-cover-calibration.js 255-300, nfl-experiments.js 25-60, routes/nfl-betting.js 680-740/1010-1040/1710-1730, docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md 1-80.

## Cited lines, verbatim

- nfl-replay.js:225 `const line = ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions });` — replaySeason's `modelOptions = {}` default (L186); nothing in the file sets blendMode.
- nfl-ensemble.js:1221 `weighting = 'exponential', families = null, blendMode = 'raw', includeEvidence = true,` — the default. L1299 `const margin = blendMode === 'market_residual' ? residualMargin : rawMargin;` — the two modes produce different projected margins. L1326 `blend_mode: blendMode` — reported on the ensemble object.
- nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions };` — a spread-default that callers could override, but the production entry `autoPickCandidates` L202 `return autoPickDecisionBoard(season, week, policy).selected;` passes no modelOptions, so the served board is always market_residual. L177 records `base_blend: e.blend_mode` in the pick's feature_snapshot.
- nfl-blind-audit.js:284 `replaySeason(season, { startWeek: week, endWeek: week, markets: [market] })` — no modelOptions, so raw. L307 `ensembleLine(season, week, b.home, b.away, { includeEvidence: false })` — the pick-explanation call is also raw (consistent, but equally unlabelled).

## Does the code already do what should_be says? No.

1. One function with explicit blendMode: replay (nfl-replay.js:225) and board (nfl-auto-picks.js:83 -> ensembleWeek L105 -> ensembleLine) both reach ensembleLine, but with different implicit/explicit blend modes; the replay never states one.
2. Recorded in spec_json/spec_hash: nfl-blind-audit.js normalizeSpec L185-217 has no model/blend field; spec = protocol, classification, seasons, startWeek, endWeek, schedule, domains, player_engine, player_head_registry, player_head_ids, betting_policy, expert_council, expert_ids, postgame_truth, rules, provenance. Live DB (readOnly): runs 27 and 32 spec_json contain 0 occurrences of "blend"; betting_policy is nfl-spread-historical-replay-v1 with no blend field. The persisted week result carries `betting.metrics.config.modelOptions: {}` (from replaySeason summary L337) — implicitly raw, never stated; the only two "blend" strings in a run-27 week result are fantasy player-week baselines (`"blend":{"mae":5.427...}`), not the spread blend.
3. Relabelled: run 27 label = "Re-audit 2026-09-09 -- opening-line fix + full team-card coverage pre-warmed, single clean pass"; run 32 label = "NFL five-year historical diagnostic (post Codex-plan implementation, 2026-09-10)". Neither says raw-blend.
4. Test asserting replay blend mode: grep -i blend over test/nfl-blind-audit-team-scope, blind-audit-lookback, nfl-replay-*, nfl-moneyline-domain, model-integrity, nfl-family-contribution — no assertion on replaySeason/blind-audit blend mode. test/nfl-cover-identity.test.js:74 asserts market_residual only for buildCoverCalibration's replay calls (nfl-cover-calibration.js:276 sets it explicitly) — that is the calibrator path, not the historical audit.

## Corroborating context

- docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md:28-30 states in prose: "the blind audit replays with `blendMode: 'raw'` (its long-standing default, per finding M06 — it does not exercise the `market_residual` blend's residual-skill gate at all)". Known and documented, not fixed in code or labels.
- nfl-experiments.js:38 `const blendMode = raw.modelOptions?.blendMode ?? 'raw';` — experiments lineage also defaults raw.
- nfl-forecast-identity.js:41 `const blendMode = modelOptions.blendMode ?? 'market_residual';` — the identity helper defaults the OTHER way; it is only invoked by the board (nfl-auto-picks.js:119) and calibrator (nfl-cover-calibration.js:280), never by replaySeason or the blind audit, so no identity/blend is stamped on audit output.
- The served pick is additionally gated by calibratedCoverProbability (nfl-auto-picks.js:124-126), whose calibrator IS fit from a market_residual replay; that does not change the fact that the historical audit runs 27/32 graded the raw blend.

## Minor wording caveat (does not refute)

"forces" at nfl-auto-picks.js:83 is technically a default overridable by a caller-supplied modelOptions.blendMode; in production no caller overrides it (L202), so the effect is as described.
