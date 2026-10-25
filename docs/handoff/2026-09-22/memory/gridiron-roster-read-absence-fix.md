---
name: gridiron-roster-read-absence-fix
description: trade-engine.js rosterContext returned an empty Map when analyzeLeague threw, making a failed roster read identical to a league with no needs; fixed on hold branch claude/project-thread-5f9c3y-roster-read-hold (d38f676), with the three-state field the /evaluate route forced.
metadata:
  type: project
  modified: 2026-09-20T06:15:12.482Z
---

**2026-09-20, feature audit. Found by the wiring map thread, confirmed and
fixed here.** Hold branch `claude/project-thread-5f9c3y-roster-read-hold`,
head **d38f676**, stacked on `claude/project-thread-5f9c3y-trade-week-hold`
(`eb55f1d`, itself #57's `7c27517` + the `selfScout` week pin).

**Defect.** `rosterContext(lg)` (`trade-engine.js`) caught `analyzeLeague`'s
throw with a bare `catch {}` and returned an **empty Map** — the same shape a
league with no needs anywhere produces. `evaluate()`'s `ctx.theirNeeds` then
went undefined, `hurtsNeed` was always empty, `brokenForThem` collapsed to
"does it leave a hole", and offers came out as confident as ones where the
roster-fit check had real input. The sibling
`counterparty-pricing.js#deriveRosterNeeds` catches the same call and returns
`null`, its caller recording the absence at `:773` — so the house style already
existed and trade-engine.js was the outlier.

**Fix.** `rosterContext` returns `null`; `rosterReadAbsence(context, teamCtx)`
maps it to one of `ROSTER_READ_ABSENT.{unavailable,no_team,not_supplied}`;
all six `evaluate` call sites pass it; `evaluate` serves `roster_read_absent`.
The `unavailable` wording is copied verbatim from counterparty-pricing.js:773.

**The third state is the part worth remembering.**
`POST /api/trades/:leagueId/evaluate` (`routes/trades.js:934`, the Trade Lab
"check this trade" button) calls `evaluate()` with **no context at all** — the
plausibility check is inert there and always has been. A two-state field
defaulting to `null` would have made that surface claim a check it never ran,
i.e. worse than the defect. So the field defaults to the not-supplied reason.
`routes/trades.js` is Trade Brain's file; the finding went to them, not an edit.

**Also on the branch:** `tradelab.js#analyzeLeague`'s comment said
"needs/surplus stay on VOR", but `needs[].gap` is VOR units and
`surplus[].value` is market units. Both consumers read only `.position`
(`trade-engine.js:180`, `counterparty-pricing.js:301`), so the divergence is
real and **inert** — the comment was the defect. Comment-only commit.

**Evidence.** `docs/tdd/roster-read-absence-is-reported.tdd.md`. RED 38dd7fb
(6 tests, 1 pass — the pass is the control proving the mock reaches the
engine), GREEN 0f1fc71. Six applied injections, all biting. Full local check
2,984 tests, 2,943 passed, 0 failed, 41 skipped, lint 880 files, smoke passed.

**Two harness traps this cost time to:**
1. An injection script that restores with `git checkout -- .` **deletes an
   uncommitted fix**. Commit GREEN before injecting; the harness now refuses to
   run on a dirty tree.
2. A hand-built request needs `content-length`, or `express.json()` asks
   type-is whether there is a body, hears no, and the route sees an empty
   `req.body` — which reads as "the caller sent nothing", not as a harness bug.

Related: [[gridiron-served-field-deletion-pins]], [[feature-audit-shipped-prs-55-57]],
[[mocking-trade-engine-in-tests]], [[gridiron-test-fixture-traps]],
[[gridiron-held-branches-2026-09-20]].
