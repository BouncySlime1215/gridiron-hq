# Pre-registration addendum 1: the standing start/sit gate (C-01)

Written after the skeptic review of `b39b54c8` and **committed before any number in
it is computed by this unit**. The original pre-registration
(`start-sit-baseline-gate-prereg.md`, committed `a2ea8714`) is not edited; this file
corrects it and adds two descriptive arms. The ship rule (G1-G4 and the verdict
table, prereg §8) is **unchanged**.

## 0. What was already seen before this addendum

Stated so nobody reads an arm below as blind when it is not.

- The original gate result (evidence file §4, run on `42310804`).
- **Arm A below is NOT blind.** A skeptic (structure lens) computed it on its own
  local copy: served snapshot vs the season average on 2026 week 2, 63
  disagreements, points per disagreement positive, player-clustered 90% CI
  straddling 0. Its numbers are in the review text this unit was handed.
- **Arm B below is blind at commit time.** Nobody in the review computed it; one
  skeptic counted `espn_player_market_weekly` rows only. This unit has not computed it.

## 1. Correction: what the forward replay grades

Prereg §1 said our policy is the projection "as production would have served it that
week", and §6 called the forward window "what production actually serves". For the
**configuration** that holds (structural head, weekly role recency, fitted volume k,
as-of ensemble champion chosen by data cutoff). It does **not** hold for the number
served in 2026 week 2. That week's pregame snapshot (`weekly_prediction_snapshots`,
`as_of` 2026-09-17T18:56Z) was captured before the volume fit now in use
(`shrinkage_fits` id 1, `fitted_at` 2026-09-18T02:52Z) and before the week-2 ensemble
weights the replay resolves (`fit-2`). The snapshot says `weight_fit = frozen-2023`.

So the forward replay window is relabelled **"today's configuration, replayed on this
season's weeks"**. G4 still reads it, exactly as registered. What was served is
graded separately, in arm A.

## 2. Arm A: what the app served vs the season average (descriptive)

- **Ours:** `weekly_prediction_snapshots.prediction`, the pregame projection the app
  captured for that week (writer `server/services/weekly-learning.js:49`
  `captureWeeklyPredictions`, INSERT at `:63`; first write wins, refused once the
  slate starts).
- **Dumb rule, actual, population:** the forward replay rows' own `baseline`
  (season-to-date average) and `actual`, joined by (week, player). Only the policy
  value is swapped. Replay rows with no snapshot are excluded and counted.
- Same universe (both at or above 8.0, same position and week, byes out), same pairs,
  grading, intervals and sign convention as the gate.
- **Reported:** the grade, and its direction = the sign of points per disagreement
  (none when there are no disagreements). Per forward week: when the snapshot was
  captured, its `weight_fit`, the replay's champion, and whether the capture came
  before the active volume fit's `fitted_at`.
- **Not part of the verdict.**

## 3. Arm B: the literal rule, "start the highest projection" (descriptive)

Plan item 12 names the dumb rule "start highest projection". The projection a
manager actually sees is ESPN's.

- **H2:** where our served projection and ESPN's weekly projection disagree about
  which of two startable same-position players to start, our pick scores more
  actual PPR points.
- **Ours:** as arm A (`weekly_prediction_snapshots.prediction`).
- **Dumb rule:** ESPN's projected points for that player and week, from
  `league_roster_snapshots.projected_points`, rows with `source = 'final'` (writer
  `scripts/collect-roster-snapshots.mjs:109` `writePeriod`, value built at `:92`;
  the refresh loop runs it every tick). **One value per (player, week).** If the
  leagues hold different values for the same player-week, that player-week is
  excluded and counted, not averaged.
- **Actual and population:** the forward replay rows' `actual`, joined by (week,
  player); rows missing either projection are excluded and counted. Same universe
  rule (both rules at or above 8.0), pairs, grading, intervals, sign convention.
- **Reported:** the grade and its direction, as arm A. **Not part of the verdict.**
  Whether arm B should replace the season average as the gate's dumb rule once it
  holds enough weeks is a ruling for the Independent Auditor.
- **Known limits, stated now:** (1) ESPN's value is the one ESPN held for that
  period when the boxscore was read after it ended, so it may include news after
  our Thursday capture. That favours ESPN. (2) Only players rostered in the five
  synced leagues. (3) ESPN scores in the league's scoring. All five leagues have
  `leagues.ppr = 1.0`, but other scoring items can differ, which is why a
  disagreement between leagues excludes the player-week. (4) It starts at 2026
  week 2. The collector started 2026-09-22 and backfilled settled periods 1-2.
- **Why not `espn_player_market_weekly`:** it has no writer in the repository
  (`git grep -n espn_player_market_weekly d6d7bd5a` finds only a doc line calling it
  "one capture with no writer"). A standing gate cannot read a table that never
  grows.

## 4. Display (standing rule 3)

Replay magnitudes and lineup rates never reach Nick. The Lineup panel shows
**direction only**: the verdict, which way each forward arm points, and the failing
weeks by season and week without their sizes. The job's `sync_log` detail, which the
Coach can read, carries no rate or magnitude either. Magnitudes stay in the stored
evidence (`model_gate_audits.evidence_json`, served by `GET /api/gates/start-sit` for
the Auditor) and in the evidence file.

## 5. Standing rule 2, stated plainly

The original prereg was committed before any number was run. It was **not** filed
with the Independent Auditor before the run. This addendum is not filed with the
Auditor either: this unit has no channel to the Auditor. Rulings needed before
merge: (a) whether a committed-before-run prereg meets rule 2; (b) the two-factor
player interval; (c) the season average as the gating dumb rule, with arm B beside
it; (d) whether the unit row's "decision win rate and points shown on the Lineup
page" gives way to rule 3 (this unit assumes rule 3 wins).
