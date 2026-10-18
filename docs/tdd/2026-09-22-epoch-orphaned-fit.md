# An epoch rollover silently un-promotes the weekly champion

Base **654ff93**. Branch `claude/project-thread-o3wt2p-epoch-fallback-loud`.
RED `ea34923`, GREEN this commit.

## The defect

`activeWeeklyWeightSet()` filters `weekly_ensemble_fits` on
`epoch_id = activeLearningEpoch()?.id ?? 1`
(`server/services/weekly-weight-store.js:33`,
`server/services/nfl-engine-registry.js:115`).

Roll a learning epoch after a champion has been promoted and that fit stops
matching. `weightSetFrom()` finds nothing and returns the `frozen-2023`
constants (`weekly-weight-store.js:128` at 654ff93). No throw, no log, and the
returned object has the same shape as a genuine cold start, so no caller and no
surface can tell the two apart.

The trigger is `startLearningEpoch()` behind
`POST /api/nfl-betting/engine/learning-epoch`
(`server/routes/nfl-betting.js:268-273`). That route is authenticated and
requires `confirmed: true` plus a recorded reason, so this is not an exposure --
it is a gap that stays silent until someone reads a projection and wonders why it
moved.

Why it matters in weeks 2-4: with one prior game, `season_to_date`, `last3`,
`last1` and `median` are all that single score. The frozen vectors put 60/50/40/20
per cent of the projection on it, and a promoted fit carrying an `early` block
puts far less. The layer goes inert exactly when the difference is largest.

`grep -ic epoch test/weekly-early-week-blend.test.js` returns **0**: nothing
covered this.

## RED

`test/weekly-epoch-orphaned-fit.test.js`, 1 of 5 failing on exactly the defect:

    not ok 1 - a rollover after a good promotion is announced, not served silently
      error: 'the orphaned fallback is reported as an ordinary cold start:
              a caller cannot tell it apart'
    # tests 5   # pass 4   # fail 1

The other four pass before the fix as well as after, by design -- they are the
controls that stop the fix from being a blanket relabel:

- the orphaned fallback still serves the frozen vectors (no projection may move),
- a genuine cold start stays plain `frozen`,
- a fit excluded by the leakage cutoff is not an orphan,
- a fit in the active epoch is untouched.

The rollover runs through `startLearningEpoch()` itself, not hand-written SQL.
The first draft wrote `status='closed'` and SQLite rejected it --
`CHECK constraint failed: status IN ('active','archived')`. A fixture that guesses
the producer's vocabulary proves nothing about the producer.

## GREEN

`activeWeeklyWeightSet()` probes, only when the epoch-filtered lookup found
nothing, for a promoted fit it would have served but for the epoch clause: same
cutoff, epoch clause dropped. A hit returns the same frozen vectors under the same
`frozen-2023` id, with `source: 'frozen-orphaned-epoch'` and an `orphaned_fit`
block naming the fit, its epoch and the active epoch, plus one warning per
(fit, active epoch) pair -- not per player-week, since this runs once per projected
player.

**The numbers do not change.** This is an honesty fix. `player-week-engine.js:304`
already records the served set as `weight_source`, so the surface now says the
champion is orphaned rather than absent.

    # tests 6   # pass 6   # fail 0

## The injection

Per the project's rule, a test the code survives is a test that is wrong. Dropping
the cutoff from the orphan probe -- leaving only `epoch_id<>?` -- would report a
fit trained through a LATER week as an orphan, blaming the epoch roll for the
cutoff's work:

    mutation applied  -> not ok 6 - a fit in another epoch trained past the cutoff
                                    is not an orphan either
                         # tests 6  # pass 5  # fail 1
    mutation reverted -> # tests 6  # pass 6  # fail 0

Exactly one test caught it, and case 6 was added because the first five did not.

## The five questions

- **Well built?** It changes no number, runs no extra query on the common path,
  and distinguishes four situations that all previously collapsed to `frozen`:
  orphaned fit, cold start, cutoff exclusion, healthy fit.
- **Stats or made up?** Neither -- this is a control-flow honesty fix. The one
  quantitative claim, the 60/50/40/20 frozen exposure, is measured, not asserted.
- **How do we know?** RED, GREEN and a reverted mutation, all with counts above,
  and the epoch vocabulary read off the CHECK constraint rather than assumed.
- **Pointed anywhere else on the platform?** `player-week-engine.js:266,304`
  serves and records it; `trade-engine.js:257` folds the weight set's id into a
  cache key, so trade values cache under `frozen-2023` too.
- **How does it unify?** Same family as the fake data-healthy banner: a layer that
  answers confidently while serving nothing current. The registry fixed that for
  feeds; this fixes it for the weekly champion.

## Second pass: why frozen, not just that it is frozen

RED `8af544a`, GREEN this commit.

A live read on 2026-09-22 (Nick, read-only) found production's active epoch is
**1**, created 2026-09-19, holding **zero promoted `weekly_ensemble_fits` rows**.
That is not the orphan case above -- it is a cold start, and the fix above
deliberately does not fire on it (test 3). So the app has been serving the
frozen 2023 constants on every request since, and `weight_source` read exactly as
it would on a legitimate first boot. Nothing said the weekly learning loop had
never promoted anything.

`source` stays `'frozen'`: `test/model-integrity.test.js:618` pins that contract
for the cutoff case and it is a real one. The account goes in a new
`frozen_reason`, which no existing consumer has to re-learn.

Three situations that all read as bare `frozen` before:

| situation | reported as |
|---|---|
| nothing ever promoted in this epoch | `frozen_reason`: never promoted, names the epoch |
| promoted, but all past the leakage cutoff | `frozen_reason`: names the fit's through-season/week |
| promoted, left behind by an epoch roll | `source: 'frozen-orphaned-epoch'` + `orphaned_fit` |

The first two are not cosmetic variants of each other. "Nothing has ever been
promoted" means the learning loop has never completed a promotion and someone
should look at the loop; "everything promoted is trained through this week or
later" means the loop works and the leakage guard is doing its job. Collapsed into
one string, those send a reader to opposite ends of the system.

    # tests 9   # pass 9   # fail 0

Second injection: collapsing both reasons to the same string is caught by exactly
one test.

    mutation applied  -> not ok 8 - a cutoff-only exclusion says so, and is not
                                    confused with never having promoted
                         # tests 9  # pass 8  # fail 1
    mutation reverted -> # tests 9  # pass 9  # fail 0

Neighbouring suites -- `player-week-engine-weights`, `model-integrity`,
`weekly-early-week-blend`, `prediction-log-served-model`: **118 tests, 118 pass,
0 fail**. Measured when this branch still carried the `player-week-engine.js`
change removed below; it touches none of them now, so the figure is a floor
rather than a claim about the current diff. The 2x `npm run check` on the final
tree is the gate.

## Third pass: the unread field came back out

An earlier commit on this branch added four lines to
`server/services/player-week-engine.js` -- three of comment and one field:

    weight_reason: weightChampion.frozen_reason ?? weightChampion.orphaned_fit ?? null,

**Nothing read it.** By grep on that tree, `weight_reason` appeared in exactly
two places: that line, and this file. No test anywhere referenced it, and this
branch's own test file never touched `player-week-engine.js` at all -- every
test here is against `weekly-weight-store.js`.

So it was an output key with no consumer and no test, which is the same
decoration this unit exists to argue against. The sentence that justified it in
an earlier draft of this file -- "a field that is not read anywhere is
decoration, not honesty" -- was right about the principle and was being used to
license the opposite of it. A store that can say why it is frozen is the
finding; pre-placing a field on the off chance a surface later wants it is not.

**It should be written when a consumer exists, by whoever owns that consumer,
with a test that reads it.** `player-week-engine.js` belongs to another editor
under this project's one-editor-per-file rule, which made the removal the
cheaper answer as well as the better one: the allocation question disappears
rather than needing an adjudication.

Removed here. Zero test impact, established by grep before the edit rather than
discovered by the suite after it. What remains is `weekly-weight-store.js`, its
test, and this file.

## What this does NOT do

It does not promote anything, it does not change a single projected number, and
it does not tell you whether production has rolled an epoch. It makes the app say
which of three things is true when it serves the 2023 constants -- which, on the
live read above, it is doing on every request right now.
