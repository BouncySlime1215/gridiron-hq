# JEV-01b pre-registration, addendum 2

Written before any graded run on real data. The first real run is still the
`LOCAL:` run on PR #289, and it has not run. This addendum makes two changes
(sweep fixes FIX-289-3 and FIX-289-4) and nothing else.

## 1. Roster size comes from the league, not a constant

**Change.** The `own_roster.untouchable` incumbent used roster size 16. It now
uses the league's own roster size: the sum of the payload's
`settings.rosterSettings.lineupSlotCounts`, starters plus bench, with the IR
slot (ESPN slot 21) left out. If the payload has no slot counts, the size is
not guessed. The question then reports
`{ status: 'unknown', reason: 'no_roster_size' }`, and no manager row is
written for it. `open_to_trade` does not use roster size, so it is unchanged.

**Why.** 16 was a guess, and the PR body already said so. A 15-slot league
under 16 understates the per-slot move-off rate by 1/16, and so overstates
P(held).

## 2. Grading the engine's stored `jev.*` answers (`server/services/jev/grader.js`)

This implements ENGINE-SPECS JEV-01b (1), (2) and (4) for the two question
types whose truth the app already records. The rule is fixed here before any
answer exists: JEV-01a (#248) is not merged, so `engine_state` holds no
`jev.*` row yet.

| qtype | unit | claim | outcome (y) | settled when | incumbent |
|---|---|---|---|---|---|
| `p_accept` | one offer (`trade_outcomes.id`) and one arm | that arm's **last** answer stamped before `resolved_at` | `status = 'accepted'` | status is accepted, declined, countered or expired, and `resolved_at <= grade time` | `trade_outcomes.model_p_accept`, the app's stated P(accept) midpoint at the time. If it is absent, the unit has no incumbent |
| `plays_sunday` | one player, one NFL week, one arm | that arm's last answer stamped **before the week's first kickoff** | the player has a snap in `nfl_snaps` that week (offense, defense or special teams). Matched on the normalised name | the week's `nfl.week` state reads `final` as of the grade time, and `nfl_snaps` has rows for that week | none wired yet (the preregistered one is the ESPN designation through weeklyAvailability) |

- **Week of an answer.** This is the earliest `nfl.week` whose last kickoff
  is after the answer, i.e. the week in progress or the next one. An answer
  stamped at or after that week's first kickoff is excluded as
  `asked_after_kickoff`. This is conservative: a Saturday answer for a Sunday
  player is dropped too, because Thursday's game has already started.
- **Leak rule.** No outcome stamped at or before the answer is used. No unit
  is graded before it settles. Each excluded answer is counted under its
  reason: `unsettled`, `outcome_before_answer`, `asked_after_kickoff`,
  `no_week`, `no_snaps_for_week` or `unknown_offer`.
- **Versions.** Only answers carrying the latest `question_version` seen for a
  type are pooled. Older versions are counted under `older_version`.
- **Per arm (`jev_cal.<qtype>.<arm>`).** The calibration map follows the chat
  rule: isotonic at n >= 200, Platt below. The floor is also the chat rule:
  n >= 60, with >= 10 of each outcome. Below the floor the value is null,
  with a typed absence `thin`.
- **Blend (`jev_weight.<qtype>`, `jev_score.<qtype>`).** The claim is the mean
  of the arms that answered. The weight, holdout, CI and leader are exactly the
  chat rule (`chat-grader.js#gradeUnits`): 70/30 time split, out-of-fold
  weight, 90% clustered bootstrap, and `w <= 0.05` means "incumbent leads".
  Clusters: the counterparty team for `p_accept` (manager-clustered), and the
  player for `plays_sunday`. If any unit lacks an incumbent, the weight is
  null with the absence `no_incumbent`. The score then reports Jev alone: raw
  log loss and Brier, n.
- **Writes.** `engine_state` rows by producer `jev_grader` on entity
  `engine:jev`, stamped at the grade time. Each row cites the answer rows it
  graded. Nothing is served from them.

Forward-only on the 2026 season. 2025 is never opened.
