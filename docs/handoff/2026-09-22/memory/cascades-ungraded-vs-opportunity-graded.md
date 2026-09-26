---
name: cascades-ungraded-vs-opportunity-graded
description: gridiron-hq has TWO teammate-absence estimators (contingency.js cascades, opportunity-model.js) and NEITHER reaches a surviving fantasy screen — cascades because Nick deleted its page, the other because it failed its gate. Verified at 93d4b39, 2026-09-20.
metadata:
  type: project
---

Found while answering Nick's five audit questions (01:21Z 2026-09-20), read at
93d4b39. An earlier version of this memory said cascades "ships on a
user-visible surface" — **that was wrong**, corrected below.

**Estimator A, `server/services/contingency.js` `cascades()`.** Per-starter
beneficiaries from a with/without-starter split of `player_week_usage`.

*It is soundly built* — do not go in expecting the box-score-row defect, it is
not there. It bounds each absence window to the player's first..last appearance
on that roster (`contingency.js:983-988`) so pre-signing weeks are not scored as
games missed; requires `MIN_MISSED` 3 and `minGames` 6; restricts transfers to
the `INHERITS` position group (explicitly refuses pass attempts to a backup QB);
shrinks the multiplier toward 1 by sample size.

*It reaches no surviving screen.* `cascades()` → `handcuffValue()`
(`contingency.js:1048`, built entirely on `b.gain`/`b.multiplier`) →
`GET /api/model/handcuffs` (`routes/model.js:569`) → `client/src/pages/Model.tsx:450`,
and **Model.tsx has no `<Route>`** in `client/src/App.tsx:84-156`.
`/api/model/cascade/:playerId` has no client caller. The other path,
`auditCascadeConservation` → `role-scenario-lab.js` → `nfl-research-lab.js`,
writes to `server/data/role-scenario-lab`, not to a screen.
**This is deliberate:** commit 1694694 quotes Nick naming "the model" among the
nine deleted tabs and states "A server route with no page in front of it is the
intended end state, not an oversight." So do NOT flag `/api/model/*` as a wiring
defect, and do NOT propose restoring the Handcuffs tab.

*It has no held-out grade.* `test/role-scenario-engine.test.js:116` calls
`auditCascadeConservation({})`, which calls `cascades()`, but asserts
`n_starters_checked === 0` on an empty DB — a no-crash test, grading nothing.
`role-scenario-engine.js:250-258` describes itself as a consistency audit (do
the multipliers sum past the starter's own opportunity), not a measurement of
whether they are right.

**Estimator B, `server/services/opportunity-model.js`.** Imported only by
`test/opportunity-model.test.js` and `scripts/study-opportunity-volume.mjs`.
**Unwired ON PURPOSE** — graded expanding-window with a player-clustered
bootstrap, payoff inside the noise. This answers the wiring map's orphan
question; it is not a forgotten connection. Mechanism real (vacated-share
coefficient positive every position, every season: WR/TE targets 0.492/0.668,
RB carries 0.718/0.828, RB targets 1.390/1.647); payoff not (RB carries
−0.86%/−0.98%, the only head whose sign holds on both slices in both seasons,
90% CI [−0.077,+0.027] and [−0.092,+0.037], both straddling zero).

**The real question** (coordinator approved grading 01:26Z): not "should we
wire cascades" — that means rebuilding a deleted page — but **does any
teammate-absence correction earn a place on a surviving surface** (Start/Sit
weekly volume, waiver board, News fantasy impact). B says no for itself.

**The trap any "who is out, who inherits" work must avoid:** searching for
absent teammates among players who have a box-score row in the graded week
finds nobody, because a ruled-out player has no row. Built that way the slice
was **0 of 5,336 rows**; from the roster as of prior weeks, **2,170 of 5,336
(41%)**. `test/opportunity-model.test.js` pins this.

See [[opportunity-stage-findings]], [[opportunity-dead-artifacts]].
