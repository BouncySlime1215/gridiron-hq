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

## What this does NOT do

It does not promote anything, and it does not tell you whether production has
rolled an epoch. That is still one read of the live database. It makes the
condition visible if and when it happens.
