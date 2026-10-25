---
name: gridiron-availability-constant-0-92
description: Gridiron HQ's `?? 0.92` chance-to-play fallback moves no number anywhere on main at 791b131 — it survives only as a served display field, and getting to that took three wrong claims from two threads.
metadata:
  type: project
  modified: 2026-09-19T21:40:00.000Z
---

`weeklyAvailability` selects `WHERE p.position IN ('QB','RB','WR','TE')`, so
K/DEF fall back to `active_probability ?? 0.92` at **`trade-engine.js:346`
(origin/main 791b131)** — the only place it is assigned.

## SETTLED: it changes no number. All four consumers verified in source.
| path | why it cannot fire for K/DEF |
|---|---|
| `:359` `currentWeekPpg` | `:336` gives them a fallback schedule with `games: []`, so `:348`'s `find` returns undefined, `thisGame` is null, branch returns **0** |
| `:385` `decisionPpg` | `0.25 * 0 + 0.75 * rosPpg`; `rosPpg` has no availability term (comment `:360-363`) |
| `:398` `weekDist`, `:406` `WEEK_MARGINAL` | gated on a `weekProjection` they never have — `buildProjections` is `WHERE p.position IN ('QB','RB','WR','TE')` at `projections.js:292` and `:300` |
| `:2827` `?? 0.92` | behind `:2824`'s `week_points > 0`, which is 0 for them by the same construction |

**Survivor: `:464` `active_probability: +activeProbability.toFixed(3)`** —
unconditional and served. A real defect of a different shape: a figure shown as
if the model produced it, with nothing behind it. Fix is a label/basis field,
not maths.

**Two entries in MEMORY.md line (d) are WRONG and were not written by this
thread:** the 0.92 reaches neither "the Start/Sit BENCH display" nor "K/DEF
trade value", and **a kicker on the Start/Sit bench list is a FINDING, not the
expected case** — the filter is `week_points > 0` and his is 0, so he cannot
appear. Anyone reading after the deploy should use this file, not that line.

**WITHDRAWN: `season-sim.js:226`** — reported by this thread as "every K/DEF in
every simulated playoff week"; `:201` filters the roster to `SCORED` before the
loop. Any expectation that playoff odds move less because of K/DEF is void.

**UNREAD, claim nothing:** `roster-risk.js:257`, `role-scenario-engine.js:124`,
`news-fantasy-impact.js:87`.
## The lesson: read BOTH directions from a constant
Three wrong claims came out of this one line in one evening, two from the
wiring-map thread and one from the UI-rebuild thread. They failed two ways:

- **Upward** — a filter earlier (often in another file) keeps the default from
  ever firing. Cheap to catch once you know to look.
- **Downward** — the constant genuinely *arrives* and is then annihilated by a
  zero sourced two modules away. Reading upward, the discipline adopted after
  the first mistake, does not catch this at all.

A hardcoded-constant hit is a **lead**, never a fact. Both directions are now in
`scripts/wiring-map.mjs`, in the rule's finding text and the printed limits, so
the output carries the caveat. Prefer the generated artifact to anything a
session types: twice that day the tool was right and the prose about it wrong.

**Verify retractions too:** the UI thread retracted its own claim and this
thread checked it in source rather than relaying it — the conclusion held but
the mechanism was wrong on main (it said the fallback object has no `games`
key; it has `games: []`). See [[gridiron-cite-the-ref-with-the-line]].

## Agreed payload shape (blocked on PR #40, which also edits routes/model.js)
    availability: { active_probability, durability_prior,
                    basis: 'role'|'pooled'|'constants'|'unfitted_position',
                    fitted }

Per player. `unfitted_position` = a position the fit does not cover; `constants`
= no fit on file. Replaces today's `availability:`, which serves the unfitted
durability prior under a name that sounds like the fit (`routes/model.js:463`,
beside the fitted `weekly_availability` at `:461`). Leave `weekly_availability`
alone so the Model page does not go blank.
