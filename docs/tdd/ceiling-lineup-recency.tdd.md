# The ceiling lineup and the weekly engine priced the same player-week differently

RED `6247820` · GREEN `81d0fa8` · branch
`claude/project-thread-xiezr0-ceiling-recency`, cut from `a1e661f`, 2026-09-22.
Independent Auditor R42 (the finding), R44 and R45 (the conditions this work was
built to).

**This is a user-visible behaviour change.** The My Team ceiling tool will pick
different players than it did yesterday. That is the fix, not a side effect.

## What was wrong

`ceiling-lineup.js:62` built its own projections and got the **cutoff** right:

```js
buildProjections({ through: season, throughWeek: week - 1, scoring })
```

`through: season, throughWeek: week - 1` is the walk-forward-safe mid-season
cutoff — the same one `player-week-engine.js:271-274` uses — and there was a
careful comment above it explaining exactly that.

What it never passed is the other half of the same configuration: `roleRecency`.
Omitted, `buildProjections` falls back to `RECENCY` (`seasonDecay: 0.35`). The
weekly engine passes `WEEKLY_ROLE_RECENCY` (`seasonDecay: 0.05`,
`weekHalfLife: 5`). **Under 0.35 a season-old game counts seven times more
toward a player's volume than under 0.05.**

So the My Team ceiling tab and the Start/Sit projection for the same player in
the same week were reading two different players: one whose role is mostly last
season's, one whose role is mostly this month's.

Measured on the rig rather than argued. The fixture's first quarterback,
2026 week 5:

| | ceiling lineup | weekly engine |
|---|---|---|
| `attempts` | 29.126 | 23.973 |
| `carries` | 0.221 | 0.369 |

Same player, same week, two answers, a 21% gap in projected volume.

### The second consequence, which is quieter and worse

`shrinkage-fit.js#activeKVectorFor` **withholds the fitted volume k** from any
caller whose recency is not the one it was estimated under. That is correct: a k
is only meaningful in the evidence units it was fitted in, and handing it to a
caller accumulating volume differently would be a units error. Those callers fall
back to hand-picked constants which `shrinkage-fit.js` itself describes as *"not
claimed to be right, only untested with the fitted k"*.

`ceiling-lineup` is named in that file's list of season-long callers
(`shrinkage-fit.js:507`), **and it does not belong there.** It passes a mid-season
`throughWeek`, exactly like the weekly engine. It was being classified by an
argument it forgot to pass rather than by the cutoff it actually uses.

That list is in another module and another editor's file. Correcting it is a
one-line change, it is coupled to this one, and **it is not in this branch.**
This work does not claim that half is done.

## The fix

`roleRecency: WEEKLY_ROLE_RECENCY`, matching `player-week-engine.js:271-273`
exactly. The cutoff is unchanged.

Passed explicitly rather than through a shared helper: there is no such helper
yet. A server-side `production()` is being built elsewhere, and per R44(1) this
does not wait for it — the migration note lives in the comment at the call site,
so the next reader knows the explicit argument is a placeholder for it.

The comment above the call changes **in the same commit**, per R44(3), because
it was false. It explained the cutoff at length and said nothing about recency,
which is precisely how the missing half stayed invisible to every reader who
checked the comment instead of the argument list. A reader told about one of two
halves concludes there is one half.

## How do we know

Two test files, 9 tests. RED `6247820` fails 6 of 9.

**`test/ceiling-lineup-weekly-agreement.test.js` pins the property**, as R44(2)
requires: the structural projection the ceiling lineup *consumes* must equal,
player for player, the one the weekly engine builds for that player-week. It
runs the **real** `buildProjections` over a real `player_week_usage` fixture and
drives the **real** `ceilingLineup` end to end, so the IR filter at `:159-163`
and the one-substitution solver are in the path rather than proxied — R45(2).
The spy calls straight through and records what came back, so the assertion is
on the values, not on the argument.

What "the same projection" can honestly mean here is worth stating, because a
looser reading would be false. **Not** the weekly engine's `ppg`: the engine
blends its structural projection with season-to-date, last-3, last-1 and median
through the weekly ensemble, and the ceiling lineup does not — it samples
outcome distributions from the structural projection directly, because a ceiling
is a question about a right tail and the ensemble emits a point. Asserting those
two numbers are equal would be asserting something false by design. What is
shared, and what the bug broke, is the layer underneath. That is what is pinned.

Its first test is a **control** proving the two configurations actually disagree
on this fixture. Without it every other assertion could pass on a fixture where
volume memory makes no difference, and the file would be measuring nothing. The
fixture gives every player a 2025 role that differs sharply from his 2026 role
for exactly this reason.

**`test/ceiling-lineup-recency.test.js` pins the configuration and the comment.**
Two of its six pass at RED, and both are controls that must keep passing: the
cutoff half is already correct, and the weekly engine really does pass
`WEEKLY_ROLE_RECENCY` — so "agreeing with the engine" means something, and if
the engine ever moves, this file reports the divergence rather than going quietly
green against a stale expectation.

GREEN `81d0fa8`: 9 of 9, and `test/decision-leftovers-home-away.test.js` — the
existing suite that drives this same module — passes unchanged.

## Mutation sweep

`python3 docs/tdd/sweeps/mutation-runner.py
docs/tdd/sweeps/ceiling-lineup-recency.mutations.json <out>`

10 rows: 7 mutations, all killed; 3 controls behaving as designed.

| | mutation | result |
|---|---|---|
| K1 | the recency argument is dropped again — the defect itself, restored | KILLED ×5 |
| K2 | a recency that looks weekly but is not the engine's (`0.06`) | KILLED ×4 |
| K3 | the season decay matches, the half-life does not | KILLED ×4 |
| K4 | the cutoff becomes a season-boundary one | KILLED ×3 |
| K5 | the cutoff stops tracking the week being projected | KILLED ×1 |
| K6 | the cutoff reads the week being projected, not the week before | KILLED ×2 |
| K7 | the comment goes back to explaining only the cutoff | KILLED ×1 |
| C1 | control: a comment reworded, nothing behavioural | SURVIVED, as designed |
| C2 | control: an anchor that does not exist | NOT APPLIED, anchor ×0 |
| C3 | control: an anchor that matches more than once | NOT APPLIED, anchor ×45 |

`restored; unrestored rows: none`.

K2 and K3 are the rows that matter beyond this fix. Passing *a* recency is not
the contract; passing *the engine's* recency is. A near-miss on either field —
`0.06` instead of `0.05`, or a 12-week half-life instead of 5 — is killed by
both the configuration test and the property test, which is what makes the word
"agree" in this branch's title mean something.

### K7 survived the first pass, and the mutation was the weaker half

The honest reading, recorded because the opposite reading is more flattering:
**K7 as first written did not break the contract it aimed at.** It rewrote one
line of the recency paragraph, and the rest of that paragraph still named both
halves — both decay values, the configuration being passed, and the fitted-k
consequence. A reader of the mutated comment learned everything they needed. The
test was right to pass.

It was repointed to delete the explanation itself, which is the regression it was
always meant to describe, and it now dies.

**The test was loose too**, and that half is a real finding. It asked only that
the word `recency` appear somewhere in a 1600-character window above the call —
and that window contains `roleRecency` and `WEEKLY_ROLE_RECENCY` several times
over, so almost any mutilation of the comment would have satisfied it. It now
requires the two decay values, the name of the configuration being passed, and
the fitted-k consequence. A comment that merely contains the word "recency" tells
a reader nothing.

This is the same lesson three other sweeps on this thread have produced, now for
the fifth time: **an assertion on a word is not an assertion on the claim.**

## Not in this change

- **`shrinkage-fit.js:507`** still lists `ceiling-lineup` among the season-long
  callers. False from this commit onward. One line, another editor's file,
  coupled to this one.
- **The self-referential target.** Auditor R45(1): `ceiling-lineup.js:141-142`
  defaults the target to a stretch above the team's own median, built from the
  same projections — so a configuration change moves the candidate pool and the
  bar together. Real, separate, not blocking, and the right next unit here.
- **The migration to a shared `production()` helper**, when one lands.

## The check

`npm run check` — typecheck, lint, the whole suite, build and `start:smoke` —
figures and the guard either side of the run are recorded in the commit that
adds them, which touches `docs/` only.

## The five questions

**Is it well built?** It is one argument and a comment. The weakest part is that
the configuration is now duplicated in two call sites rather than named once,
which is exactly how this bug happened — hence K1 and the migration note. The
sweep's K2/K3 rows exist because "some recency was passed" is a contract that
would let the two drift apart again by a digit.

**Are these statistics or are they made up?** Statistics, and the change is about
which evidence they are computed from. No constant is invented here; the
configuration being adopted is one the weekly engine already uses and
`shrinkage-fit.js` already trains under.

**How do we know?** Reproduced on a real fixture with the real
`buildProjections` before anything was changed, with numbers (29.126 against
23.973 attempts), and with a control proving the fixture can tell the two
configurations apart. RED 6 of 9 failing; GREEN 9 of 9; 7 of 7 mutations killed
with three behaving controls; the existing `decision-leftovers-home-away` suite
over the same module unchanged and passing.

**Is it pointed anywhere else?** Yes, and this is the general shape: any module
that rebuilds a shared computation with its own argument list rather than calling
a shared constructor will drift from it by omission, silently, because an omitted
argument has a default and a default is never an error.
`shrinkage-fit.js:500-515` names four more callers in the same list; each one
deserves the same question asked of it — is it season-long because of what it
does, or because of an argument it forgot to pass?

**How does it unify?** One rule: two surfaces answering the same question about
the same player-week have to be reading the same evidence, and "the same
evidence" includes every knob, not just the one somebody wrote a comment about.
