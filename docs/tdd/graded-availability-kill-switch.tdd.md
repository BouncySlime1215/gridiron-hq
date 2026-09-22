# Plan 01's kill switch: GRADED_AVAILABILITY_ENABLED (Auditor §R40)

§R40 offered Plan 01 the same relief the target-share prior got: if the
multiplier ships default-off behind a flag nothing sets, pinned by a test
carrying the reason, it is not a behaviour change and #106 can merge on
green. The §R19.6 as-of refit still has to be regraded before the flag is
ever turned on.

## What shipped

`server/services/nfl-player-context.js`:

- `GRADED_AVAILABILITY_ENABLED = false`, exported, with the reason in the
  docstring above it.
- `gradedAvailabilityMultiplier(..., { enabled = GRADED_AVAILABILITY_ENABLED })`
  returns `{ multiplier: 1, known: false, reason: 'graded_availability_disabled' }`
  for every input while the flag is off — before any bucket lookup.

## Why this is zero behaviour change, checked rather than assumed

`grep -rn "gradedAvailabilityMultiplier" server/` (excluding tests) returns
one definition and **zero call sites**. Nothing in the projection path
calls it: it does not multiply anything, before or after the share shrink
at `projections.js:599-605`. So the flag changes no served number, because
no served number ever reached this function.

## Why a flag at all, if nothing calls it

Unreachable dead code and a default-off flag are not the same risk. With
no flag, the first caller to wire this up switches live behaviour in a diff
that only looks like wiring. With the flag, wiring and enabling are two
separate one-line changes, and the second one is the reviewable event.

## Why the flag is a default, not a hard block

`{ enabled: true }` runs the real logic. That is how this unit's existing
tests grade it — the look-ahead guard, the retained-bucket ratio, the
minN-floor collapse and the G1 invariant all describe what the multiplier
does when it runs, and they are Plan 01's evidence. Gating the logic itself
would have made those tests assert the kill switch instead, which is
deleting evidence to make a flag look clean. They now opt in explicitly
(`const ENABLED = { enabled: true }`), so each one reads as deliberately
exercising the disabled-by-default path.

## RED

Two tests added to `test/nfl-player-context-graded-availability.test.js`
before the flag existed:

1. `GRADED_AVAILABILITY_ENABLED defaults false` — failed: the export did
   not exist (`undefined !== false`).
2. `the flag is a hard kill switch, not a formality` — failed for the same
   reason.

`# pass 8 / # fail 2`.

## GREEN

`# tests 10 / # pass 10 / # fail 0`.

The kill-switch test does not merely assert "returns 1": it first asserts
`fit.ratios.Questionable` is strictly between 0 and 1 on the fixture, then
records a real `Questionable` revision and reads it at a decision time that
would resolve to that retained bucket. Returning 1 there can only happen if
the flag check runs before the bucket lookup — a fixture that fell through
to one of the already-neutral branches would pass a weaker assertion.

## What this does NOT cover

- Whether the multiplier's numbers are right. §R19.5/§R19.6 accepted Plan
  01 as built-ungraded; the grade is still owed, and the flag is what keeps
  an ungraded number out of production in the meantime.
- Any call site. There is none. Wiring it into the projection path is
  `projections.js`'s owner's decision (Model evidence audit), not this
  file's, and is explicitly not done here.
- The §R19.6 refit's identical-numbers result, which is a property of this
  container's revision store (a single reconstructed snapshot per
  player-week), not evidence the conditioning question is settled — see
  `injury-participation-term.tdd.md`.
