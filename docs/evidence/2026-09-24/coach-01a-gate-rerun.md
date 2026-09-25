# COACH-01a Step 0: Coach's people gate, rerun with separate windows (RL-18-3)

Written 2026-09-24 in a cloud session (sections 1-3, 5, 6). **The Step 0 table (section 4) was run
on the Mac on 2026-09-24** against a `.backup` copy of the private Sleeper history, 2021-2024
(2025 not opened). Only aggregates are recorded here. The panel stays local.

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
  The panel rebuilds all 542: the per-family statistics, afterloss (43), the LINEUP means,
  TRADESHAPE (4) and DROPTEN (14). A golden-fixture test pins the count to the screen's
  (`test/coach-gate-rerun.test.js`). On weeks 1-6 the panel's values equal the factory's own
  `w16` columns (`w26` for afterloss) exactly: 531 comparable columns, max difference 0
  (`coach-gate-panel.py --parity`).
  - afterloss uses only (loss week, next week) pairs with both weeks inside the window.
  - DROPTEN counts tenure from the first add inside the window. A player added before the window
    counts as an original-roster drop. A test moves every early-window transaction and checks that
    no late-window value changes.
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
2. The spec says to set the precision and recall bar from the Step 0 table. The bar is in
   section 4, set after the table and before any further run.
3. The wording is fixed in code (`gate-rerun.js`, `statementFor`). An outcome with no confirmed tell
   reads "no replicated trade-next-week signal" (or the equivalent for that outcome). Nothing
   anywhere says "predicts nothing". A test asserts this.

## 4. Step 0 table

Run 2026-09-24 on the Mac. There were 21,888 team-seasons with all of weeks 1-12, in 1,994
league-seasons. All 542 templates were covered in both modes, and 0 were unscreened. Bootstrap:
1,000 reps, seed 1, resampling league-seasons. Panel build: about 12 minutes. Scoring: about 1
minute for both modes.

| mode | outcome | templates | confirmed | passes | base | precision | recall | lift | 90% CI | beats base |
|---|---|---|---|---|---|---|---|---|---|---|
| split_70_30 | adds | 542 | 24 | 27 | 0.0443 | 0.0741 | 0.0833 | 1.67 | 0.0625..0.1176 | yes |
| split_70_30 | checkout | 542 | 5 | 27 | 0.0092 | 0 | 0 | 0 | 0..0 | no |
| split_70_30 | trade | 542 | 0 | 27 | 0 | 0 | — | — | 0..0 | no |
| split_70_30 | any | 542 | 28 | 27 | 0.0517 | 0.0741 | 0.0714 | 1.43 | 0.0625..0.1176 | yes |
| weeks_1_5_vs_6_11 | adds | 542 | 24 | 10 | 0.0443 | 0 | 0 | 0 | 0..0 | no |
| weeks_1_5_vs_6_11 | checkout | 542 | 5 | 10 | 0.0092 | 0 | 0 | 0 | 0..0 | no |
| weeks_1_5_vs_6_11 | trade | 542 | 0 | 10 | 0 | 0 | — | — | 0..0 | no |
| weeks_1_5_vs_6_11 | any | 542 | 28 | 10 | 0.0517 | 0 | 0 | 0 | 0..0 | no |

**Gate passes (template, share of league-seasons passed, league-seasons graded):**
- split_70_30, 27 passes:
  - 9 were graded in 100+ league-seasons: ADD_ANY:ALL|active (0.53, 1,875; confirmed adds),
    ADD_ANY:ALL|rate (0.51), CLAIM_ALL:ALL|active (0.51), DROP:ALL|active (0.54, 1,875; confirmed
    adds), DROP:ALL|rate (0.55), and LINEUP ro_QB, ro_RB, ro_TE, ro_WR (0.56-0.77).
  - The other 18 were graded in 5 or fewer league-seasons: rare CLAIM_* by K, QB and TE, where
    few leagues have 8+ managers with a value in both windows.
- weeks_1_5_vs_6_11, 10 passes: ADD_ANY:ALL|rate, DROP:ALL|rate, the same four LINEUP roster
  counts, and 4 thin CLAIM_FAIL templates. None is confirmed for any outcome.

**Reading under the rule fixed in section 3:**
1. Rule 1 as written is met for **adds, in the primary mode only**. The lower end of the CI
   (0.0625) is above the base rate (0.0443). This rests on **2 hits in 27 passes**. Both hits
   pass in only just over half of the league-seasons (0.53 and 0.54, against a 0.5 bar).
2. **It does not replicate.** In the sensitivity mode the gate passes 10 templates. Neither hit is
   among them, and precision is 0 for every outcome.
3. **The CI is narrower than it looks.** The bootstrap resamples league-seasons, so it covers how
   the gate's verdicts vary. It does not cover how few templates the precision rests on. The
   exact 90% binomial interval for 2 of 27 is 0.013..0.215, which contains the base rate.
4. checkout: 0 of 27. trade: no replicated trade-next-week signal (the screen confirmed none).
5. What the gate reliably passes is roster shape (LINEUP ro_*) and overall volume (ADD_ANY and
   DROP rate). These repeat week to week. Apart from the two `active` hits in the primary mode,
   the screen did not confirm them for any outcome.

### Pre-registered bar (set 2026-09-24 from this table, before any further run)

A people gate (this one or a later version, e.g. COACH-01b) is called **predictive** for an
outcome only when ALL of these hold:
1. In **both** window modes, the lower end of the league-clustered 90% CI is above the base rate.
2. In **both** window modes, the exact 90% binomial lower bound on passes_confirmed / passes is
   above the base rate. This covers the template count that the league bootstrap does not.
3. In the primary mode, precision >= 0.074 and recall >= 0.083 for adds. These are today's values,
   so a new version must not do worse.

**Today's gate does not meet the bar**: (1) and (2) fail in the sensitivity mode, and (2) fails in
the primary mode. **Status: repeatability-only.** This matches the code: `applyGrades` still sets
`priceable=1` only when the predictive verdict passes, and nothing is priceable. No precision
or recall number is claimed for the gate.

Commands used (the panel stays local and is never committed):

```
sqlite3 <sleeper_history.sqlite> ".backup '<local>/sleeper.sqlite'"
TELLS_SLEEPER_DB=<local>/sleeper.sqlite TELLS_PLAYERIDS_CSV=<db_playerids.csv> \
  python3 scripts/rnd/coach-gate-panel.py --out <local>/coach-gate-panel.ndjson.gz
node scripts/coach-gate-rerun.mjs --panel <local>/coach-gate-panel.ndjson.gz --out <local>/coach-gate-rerun.json
```

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
ran end to end. They covered 401 and 427 of the 542 templates before FIX-249-2, and all 542 after it
(358 and 365 with values; `test/fixtures/coach-gate-panel-golden.json`). The fixture has 5 team-seasons in
2 league-seasons, below the gate's 8-person floor, so the gate passed nothing and the runner said
"repeatability-only". This shows only that the pipeline runs.
