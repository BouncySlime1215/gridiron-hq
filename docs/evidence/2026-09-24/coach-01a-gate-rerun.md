# COACH-01a Step 0: Coach's people gate, rerun with separate windows (RL-18-3)

Written 2026-09-24, in a cloud session. **The Step 0 table has not been produced yet.** The rerun
needs the private Sleeper history copy, which exists only on Nick's Mac. This file holds the method,
the pre-registered reading, the numbers that need no Sleeper data, and the commands. The table goes
in section 4 when the run happens.

Spec: ENGINE-SPECS.md row `| COACH-01a |` (handoff package `claude/handoff-package-2026-09-22`,
`docs/handoff/local/ENGINE-SPECS.md`), WORK-QUEUE.md `RL-18-3`.

## 1. What is being rerun, and why

The gate is `repeatability()` in `server/services/coach/people/grading.js`. It splits each person's
history in time and passes a variable when the early value predicts the late value across people
better than the population mean (skill > 0) and people keep their order (Spearman >= 0.5,
at least 8 people).

The r18 critique ("passes noise": 232 passes, precision 0.116) compared **overlapping cumulative**
windows. The early and late values shared weeks, so some of the repeatability was just the same
data counted twice. The validator put precision at about 1.7x a 0.067 base rate. It also said the
true numbers are unknown until a rerun with separate windows. This is that rerun.

## 2. Method (fixed before any Sleeper number)

- **Population:** TELLS-01a templates (`server/data/tells-screen.json`, arm A, 542 templates).
  The panel rebuilds 481 of them: the per-family statistics and the LINEUP means. It does not
  rebuild 61: afterloss (43), TRADESHAPE (4) and DROPTEN (14). The runner reports the count it
  actually covered.
- **People:** one league-season at a time. Its managers are the "people", the same way a chat
  corpus's people are. Only team-seasons with all of weeks 1-12 are used.
- **Windows. No week and no event is shared.**
  - PRIMARY `split_70_30`: each team-season's own weeks 1-12, cut 70/30 (weeks 1-8 vs 9-12).
  - SENSITIVITY `weeks_1_5_vs_6_11`.
  - A lineup change is measured against the week before, so a change that straddles the cut goes
    to neither window.
  - Pinned by `test/coach-gate-rerun.test.js` (`teamSeasonWindows`, `splitEvents`).
- **Template verdict:** a template passes the gate when it passes in at least half of the
  league-seasons that could grade it.
- **Labels:** a template counts as a hit for an outcome (adds, checkout, trade) when the screen
  CONFIRMED one of its tells for that outcome. `any` means any of the three.
- **Reported per outcome:** templates, confirmed, gate passes, precision, **base rate**, recall,
  lift, and a **league-clustered bootstrap** 90% CI (resample league-seasons; 1,000 reps; seed 1).

## 3. Pre-registered reading

1. For each outcome, the gate's precision is **claimed** only when the lower end of its 90% CI is
   above that outcome's base rate. If no outcome clears it, the gate is reported as
   **repeatability-only** and no precision bar is claimed. That is the ENGINE-SPECS PRE.
2. The spec says to set the precision and recall bar from the Step 0 table. There is no table
   yet, so **no bar is set in this PR**. Rule 1 is the only reading until the table exists.
3. The wording is fixed in code (`gate-rerun.js`, `statementFor`). An outcome with no confirmed tell
   reads "no replicated trade-next-week signal" (or the equivalent for that outcome). Nothing
   anywhere says "predicts nothing". A test asserts this.

## 4. Step 0 table

**Not run.** Fill this in from `--out` (aggregates only):

| mode | outcome | templates | confirmed | passes | base | precision | recall | lift | 90% CI | beats base |
|---|---|---|---|---|---|---|---|---|---|---|
| split_70_30 | adds | | | | | | | | | |
| split_70_30 | checkout | | | | | | | | | |
| split_70_30 | trade | | | | | | | | | |
| split_70_30 | any | | | | | | | | | |
| weeks_1_5_vs_6_11 | adds | | | | | | | | | |
| weeks_1_5_vs_6_11 | checkout | | | | | | | | | |
| weeks_1_5_vs_6_11 | trade | | | | | | | | | |
| weeks_1_5_vs_6_11 | any | | | | | | | | | |

Commands (about 5-15 minutes on the Mac; this is a guess, since the panel has never been built
on the full data):

```
sqlite3 <sleeper_history.sqlite> ".backup '<local>/sleeper.sqlite'"
TELLS_SLEEPER_DB=<local>/sleeper.sqlite TELLS_PLAYERIDS_CSV=<db_playerids.csv> \
  python3 scripts/rnd/coach-gate-panel.py --out <local>/coach-gate-panel.ndjson.gz
node scripts/coach-gate-rerun.mjs --panel <local>/coach-gate-panel.ndjson.gz --out <local>/coach-gate-rerun.json
```

The panel is derived from the private copy. It stays local and is never committed.

## 5. Numbers that need no Sleeper data (from the committed screen)

Base rates at the template level. A template counts as confirmed for an outcome when any of its
windows was confirmed for it:

| outcome | confirmed templates | of | base rate |
|---|---|---|---|
| adds | 24 | 542 | 0.0443 |
| checkout | 5 | 542 | 0.0092 |
| trade | 0 | 542 | 0.0000 |
| any | 28 | 542 | 0.0517 |

At the tell level: 43 of 1,504 tells are confirmed for some outcome (0.0286), and 43 of 3,219
tell-by-outcome tests (0.0134). **None of these is the validator's 0.067.** That number came from
r18's own counting (85 confirmed before the TELLS-01a rebuild). The runner prints the base rate
of the universe it actually scores, and prints 0.067 next to it only for reference.

The screen confirms **zero trade tells**, so the trade row will read "no replicated
trade-next-week signal" whatever the gate does. That matches the TELLS-01a trade KILL.

## 6. Smoke run (synthetic fixture, not evidence)

`coach-gate-panel.py --fixture test/fixtures/tells-golden-fixture.json` then the runner: both modes
ran end to end. They covered 401 and 427 of the 542 templates. The fixture has 5 team-seasons in
2 league-seasons, below the gate's 8-person floor, so the gate passed nothing and the runner said
"repeatability-only". This shows only that the pipeline runs.
