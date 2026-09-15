# Verification pass — G05-nfl-core-model claims (5)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
Files fully read: server/services/nfl-ensemble.js (1423 lines), server/services/nfl-scheme.js (254 lines, full file),
server/services/nfl-roster-strength.js (424 lines, sections 1-185 and 340-424 read in full, remainder skimmed for
imports/usage only — the claim's cited lines 92-118 and 340-373 are fully covered), server/services/nfl-pbp.js
(lines 220-460 read in full around the cited region; teamWeeks/import reachability confirmed via grep).

## #20 — market_anchor uses opener live, fit on closer — REFUTED = false (claim holds), P2

- `games()` (nfl-ensemble.js:55-67) is the *only* source for `all` in `calibrate()`/`fitEnsemble()`'s weight-fit
  loop and hardcodes `NULL AS open_spread, NULL AS open_total` (line 60), for every row it returns (all historical,
  played games). So `buildContext(...).openSpread` is always `null` during weight fitting → `market_anchor.predict`
  (line 601-603) always falls through to `c.spread` (the close) when learning `margin_weight`/`residual_slope` for
  that component.
- In `ensembleLine()` (the live/predict path), the single-target-game query at line 1245-1249 does
  `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` — i.e. for an unplayed (future) game it
  *does* surface the real opening line into `ctx.openSpread`, and `market_anchor.predict` then uses
  `-c.openSpread` instead of `-c.spread`.
- Confirmed `open_spread` is a real, populated column (grep shows `nfl-opening-lines.js`, `odds-archive.js`,
  `beat-the-close.js`, etc. all read/write it) — not a column that's always empty in the DB.
- Reachability: `ensembleLine` is imported and called from `server/routes/nfl-betting.js` (mounted at
  `/api/nfl-betting` in `server/index.js:106`), plus `nfl-unified-engine.js`, `nfl-expert-council.js`,
  `nfl-engine-backfill.js`, `decision-basis.js`, etc. — a live, mounted, everyday code path, not dead code.
- Verdict: claim is accurate and reachable. The docstring at line 597 ("Starts from the number the books opened")
  is true only for the live path, false for the entire fit/grading history — matches the reader's framing.

## #21 — calibration slope leak into 2018-2021 weight-fit games — REFUTED = false (claim holds), P2

- `calibrate(all, restMap, evalFrom)` (nfl-ensemble.js docstring 818-829, body 831-...) trains its 15
  feature-differential OLS slopes (`ids` list at ~836-838, count = 15, confirmed) on
  `train = all.filter(g => g.season < evalFrom)` (line 832).
- `fitEnsemble()` computes `calibrationCutoff = beforeSeason == null ? evalFrom : Math.min(evalFrom, beforeSeason)`
  (line 1010) and calls `calibrate(all, restMap, calibrationCutoff)` — so calibration training data is
  `season < min(2022, beforeSeason)`.
- The **weight-fit grading loop** uses `eligible = all.filter(g => g.season >= WEIGHT_FIT_FROM && (...))` (line
  1026), where `WEIGHT_FIT_FROM = 2018` (line 36) — i.e. it grades games starting in **2018**, four years before
  `EVAL_FROM = 2022` (line 35).
- For any realistic live call (`beforeSeason` = current/recent season, e.g. 2025/2026), `calibrationCutoff = 2022`
  (train on 2015-2021) while `eligible` for weight-fit spans 2018 through `beforeSeason-1` (e.g. 2018-2025) — so
  the 2018-2021 slice of weight-fit games is the *same* data the 15 calibrated components were just fit on. Verified
  against actual DB: `SELECT MIN(season),MAX(season) FROM game_lines` → 1999-2026 (read via
  `node:sqlite {readOnly:true}` one-liner), so the 2018-2021-of-2018-2025 window really is "roughly half."
- `market_anchor` has no calibration step (its predict function at line 601 doesn't touch `c.cal`) — unaffected,
  matching the claim.
- The docstring at nfl-ensemble.js:827-829 explicitly claims "no game used to fit a slope is ever also used to
  grade it" — this is false given the WEIGHT_FIT_FROM/EVAL_FROM mismatch.
- `docs/CLAUDE-NEXT-STEPS.md:229-233` (C07) and `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md:313` show a
  **different, already-fixed** leak (the 70/30 residual-split row index cutting mid-week, fixed by aligning to
  week boundaries — see nfl-ensemble.js:746, 1079, 1148 "Codex correction C07" comments). That fix addressed the
  *residual regression* split, not the calibrate()/WEIGHT_FIT_FROM mismatch the reader is describing. So this is a
  genuinely separate, still-open leak, not a re-flagging of an already-fixed issue.
- Reachability: `fitEnsemble`/`ensembleLine` mounted as in #20.
- Verdict: accurate, reachable, and distinct from the "closed" C07 item.

## #22 — validateSchemeAdjustment leak via full-season 'changed' flag — REFUTED = false (claim holds), P2

- `seasonProfiles(season)` (nfl-scheme.js:57) reads `SELECT team, features FROM nfl_team_week_features WHERE season = ?`
  with **no week bound** — averages every week of that season, confirmed exactly as cited.
- `schemeChange(team, season)` (line 87-89 area, actual body ~84-114) calls `teamSchemeProfile(team, season)` →
  `seasonProfiles(season).get(team)` for the "after" identity — i.e., a full-season average including weeks that
  haven't been graded yet relative to any single game.
- `validateSchemeAdjustment({ testSeason })` (line 220-252): `changes = allSchemeChanges(testSeason)` (line 223)
  uses that same full-testSeason-average "changed" boolean to decide whether to apply the `factor` (fit only from
  `fitSeasons`) to each player's naive→actual opportunity-ratio prediction, and grades the result against
  `a.opp / a.games`, which is itself computed from the **same full testSeason** of usage rows (line 226-230,
  237-247). So the gating decision and the graded outcome are both derived from the same season's full data —
  the "changed" flag is not knowable before or during the season being graded, only after it, using information
  from the very weeks whose predictions are being scored.
- The trailing note at line 251-252 ("Factor fit on fitSeasons ... applied to testSeason, so the adjustment never
  sees the games it is graded on") is true only for the *magnitude factor*; it does not cover the *gating flag*,
  which does see (derives from) those games. This matches the reader's framing precisely.
- Reachability: `GET /api/nfl-betting/research/scheme` (nfl-betting.js:1364-1370, inside the `/research/:topic`
  route registered and mounted at `/api/nfl-betting` in server/index.js) calls
  `m.validateSchemeAdjustment({})` directly and returns its `improves` verdict over HTTP — live, reachable.
  `schemeChange` itself is also consumed live in `nfl-roster-strength.js:363` inside `teamRosterStrength()`'s
  `preseason_context.scheme_change` field (confirmed via grep + read).
- Verdict: accurate and reachable; the "improves" verdict from this diagnostic endpoint is contaminated as claimed.

## #23 — latestDepth's current-season overlay ignores requested week's cutoff — REFUTED = false (claim holds), P2

- `latestDepth(season, week, team)` (nfl-roster-strength.js:81-119): the cutoff-respecting query for historical
  `nfl_depth` rows is filtered by `gameCutoff(season, week, team)` (lines 82-85, `.filter(row => !cutoff ||
  !row.captured || row.captured <= cutoff)`), which correctly resolves to the actual kickoff timestamp for that
  (season, week, team) via `game-cutoff.js:19-24` (`SELECT gameday, gametime FROM game_lines ...`).
- But at line 97: `if (season === currentSeason) { ... }` (currentSeason from `process.env.NFL_SEASON ||
  new Date().getFullYear()`, line 92) unconditionally queries the live `players`/`nfl_teams` tables — today's
  roster, **not scoped by `week` or by `gameCutoff` at all** — and pushes those rows with
  `captured: 'current_local_roster_snapshot'` (line 111).
- Dedup at lines 116-118: `if (!existing || player.captured === 'current_local_roster_snapshot')
  deduped.set(key, player)` — the live-snapshot rows unconditionally win the merge over any earlier, properly
  cutoff-filtered depth-chart rows for the *same* key, regardless of which `week` was actually requested.
- Net effect: calling `teamRosterStrength`/`rosterStrengthWeek(2026, 3, TEAM)` in week 10 of the 2026 season
  returns today's live roster overlaid onto the week-3 request, not the week-3-cutoff roster.
- `rookieProfiles(season)` (line ~163-176) has the analogous "current season → fallback to live `players`/
  `roster_players` tables" pattern (`configuredSeason === season` branch), matching the reader's "does the same at
  :172" claim in spirit (exact line differs slightly by version but the pattern is present and unguarded by week).
- `cutoff_policy` field returned by `teamRosterStrength` (nfl-roster-strength.js:363): `'Depth snapshot before
  target game; snaps, player features and external grades strictly before target week.'` — directly contradicted
  by the unconditional current-season overlay above it.
- `roster_strength` is `challengerOnly: true` in nfl-ensemble.js:338-339 (confirmed), i.e. excluded from the
  production blend whenever `includeChallengers` is false (the ensemble's default) — so it carries zero production
  weight today, matching the claim's own caveat.
- Reachability: `includeChallengers`/candidate-mode paths are real, non-dead code: `nfl-auto-picks.js:84,104,140,198`
  branches on `modelOptions.includeChallengers`, and `nfl-engine-backfill.js` (imported by
  `server/routes/nfl-betting.js:75`, mounted) explicitly runs backfills with challenger inputs enabled. Any such
  backfill/candidate run against an earlier week of the *current* season inherits this cutoff violation via
  `sharedContext()`'s unconditional `rosterStrengthWeek(g.season, g.week)` call (nfl-ensemble.js:799).
- Verdict: accurate and reachable, correctly scoped to "challenger/backfill audits of 2026 weeks," not production
  scoring (which the claim itself already excludes).

## #24 — team pass attempts include sacks, biasing rate stats — REFUTED = false (claim holds), P2

- nfl-pbp.js:274, inside `if (isPass) { ... }` (opened at line 234, `isPass = playType === 'pass'`, no sack
  exclusion): `side.att++;` — unconditional for every play where nflverse's `play_type` is `'pass'`. nflverse
  classifies sack plays as `play_type === 'pass'` (a sack is coded as a passing play that ended in a sack), so
  `side.att` (team-level pass attempts) includes sacks.
- Contrast with the **player**-level path at nfl-pbp.js:344-349 (`passerId` block): `if (num(rec,'sack') === 1)
  p.sacks++; else { p.att++; ... }` — sacks are explicitly excluded from the player's `p.att`. The team-side and
  player-side accounting genuinely disagree, exactly as claimed.
- Downstream consumers at nfl-pbp.js:438 (`${p}_explosive_pass_rate = div(a.expl_pass, a.att)`) and :443
  (`${p}_completion_pct = div(a.comp, a.att)`), plus :441 adot (`div(a.air_yards, a.att)`), :444
  deep_attempt_rate (`div(a.deep_att, a.att)`), and :450 int_rate (`div(a.ints, a.att)`) all use the
  sack-inflated `a.att` denominator — every one of these rates is biased low by (roughly) that team's sack rate,
  and the bias is uneven across teams since sack rates vary by team.
- `nfl-features.js:36`: `['explosive_pass_rate', 'Share of attempts gaining 20+ yards', 'rate']` — confirms the
  catalog documents this as literally "share of attempts," so the sack contamination is a real definitional bug,
  not an intentional design choice.
- Reachability: `off_explosive_pass_rate`/`def_explosive_pass_rate` (produced by `sideFeatures`) are picked up at
  nfl-ensemble.js:284 (`off_expl_pass: pick('off_explosive_pass_rate'), def_expl_pass: pick('def_explosive_pass_rate')`)
  and fed into the `explosive_pass` challenger model (nfl-ensemble.js:427-430, `challengerOnly: true`) via
  `netFeature(f,'off_expl_pass','def_expl_pass')`. `teamWeeks()` (which produces these feature blobs) is imported
  into nfl-ensemble.js at line 26 and used throughout (line 262, etc.) — this is live, mounted-route-reachable
  code (nfl-ensemble.js is mounted per #20's reachability chain), not dead code.
- Verdict: accurate and reachable. Confirmed impact matches claim: "wrong numbers in feature blobs, uneven across
  teams, propagating to one challenger [explosive_pass] and every catalog consumer [nfl-features.js]."

## Summary

All 5 claims survive verification. None were refuted; no severity corrections warranted — all are genuinely P2:
real methodological/data-quality defects, reachable through mounted API routes and production/challenger model
code paths, but each with a stated, bounded blast radius (challenger-only signals, one component's weight
calibration, one diagnostic endpoint, or feature-blob bias) rather than a production-crashing or outright wrong
top-line P1.
