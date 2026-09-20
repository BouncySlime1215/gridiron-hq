# TDD evidence: playoff-odds-calibration (2026-09-20)

Source: the model evidence audit reported that **no historical calibration of a
week-w playoff or title probability exists anywhere in this repository** — the
only thing ever measured about those numbers is `trade-verify.js:78-90`, which
bounds their Monte Carlo *noise*, i.e. how much the number moves between runs of
the same simulation. A simulation can be perfectly stable and perfectly wrong.
Verified: nothing in `scripts/`, `server/` or `test/` compares a published
playoff percentage against a real finish.

This change grades one. It changes no model, adds no consumer, and writes
nothing anywhere; `season-sim.js` is untouched.

Runner:

    node scripts/calibrate-playoff-odds.mjs --sims 200
    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test --test-concurrency=1 test/calibration-metrics.test.js

## What is graded, and what is not

From the games played through week w: simulate every remaining **scheduled** game
by resampling each team's own observed weekly scores, seed the league as Sleeper
does (wins, then points for), and count how often each team finishes inside the
playoff cut. That is `season-sim.js`'s structure with one substitution —
empirical team-week draws where the app uses per-player projections.

So this measures **the simulate-and-count step and the bracket logic**, on real
finishes. It is **not** a calibration of the app's projections and cannot be:
these are Sleeper leagues, `players.sleeper_id` covers 751 of 8,556 players, and
a roster priced through an 8.8% crosswalk would be measuring the crosswalk. The
number below is the floor the app's own odds should beat, not the app's score.

Nothing is fitted by the simulator, so there is no fit/test split to get wrong and
no season is held out: **every league-season in the corpus is a test case.**

## Measured, on 184,959 team-weeks of real finishes

2,500 leagues, 2021-2025, 16,688 league-weeks graded, 336 skipped (a league-week
is skipped when a team has fewer than two scoring weeks on file at w, or no
unplayed games remain). 200 simulations each, deterministic RNG.

| week | n | **simulation** | league base rate | "in the cut now" | worst bin gap | **fitted, held out** | its worst gap |
|---|---|---|---|---|---|---|---|
| 2 | 26,150 | **0.2855** | 0.2410 | 0.3513 | 0.3473 | **0.2134** | 0.0150 |
| 3 | 26,307 | **0.2439** | 0.2410 | 0.3187 | 0.2780 | **0.1994** | 0.0218 |
| 4 | 26,450 | 0.2162 | 0.2410 | 0.2919 | 0.2198 | 0.1870 | 0.0171 |
| 5 | 26,484 | 0.1882 | 0.2409 | 0.2596 | 0.1794 | 0.1709 | 0.0214 |
| 6 | 26,512 | 0.1663 | 0.2409 | 0.2355 | 0.1378 | 0.1566 | 0.0162 |
| 7 | 26,476 | 0.1491 | 0.2409 | 0.2157 | 0.1120 | 0.1435 | 0.0156 |
| 8 | 26,580 | 0.1342 | 0.2409 | 0.1980 | 0.0852 | 0.1312 | 0.0158 |

Brier score, lower is better. Overall **0.19737** against **0.24095** for the
league's own base rate and **0.26701** for "whoever is inside the cut right now".

**Three findings, in order of how much they matter.**

**1. At weeks 2 and 3 the simulation is worse than no information at all.** Its
Brier of 0.2855 at week 2 is above the 0.2410 you get by telling every team its
league's base rate — and the base rate is not a guess here, it is exactly right on
average, because precisely `playoff_teams` of `num_teams` qualify in every league.
The simulation only starts beating it at week 4. A percentage published in week 2
is not a weak signal; it is a harmful one.

**2. It is overconfident at both ends at every week.** Pooled reliability, equal-count
bins of 18,495 rows each:

| predicted | observed | | predicted | observed |
|---|---|---|---|---|
| 0.0005 | **0.1212** | | 0.6787 | 0.5938 |
| 0.0261 | 0.1962 | | 0.8390 | 0.6954 |
| 0.1201 | 0.3049 | | 0.9433 | 0.7846 |
| 0.2807 | 0.4016 | | 0.9904 | 0.8581 |
| 0.4801 | 0.5042 | | 1.0000 | **0.8989** |

A team the simulation gives no chance makes the playoffs **12% of the time**, and a
team it calls certain misses **10% of the time**. The middle of the range is nearly
right (0.4801 against 0.5042), so this is not bias — the mean prediction equals the
observed rate to four decimals at every week — it is a spread that is too wide.
That is what simulating from a thin estimate of a team's own distribution does, and
it is the property the app shares in kind: a projection carries no term for "we
barely know this team yet".

**3. The fitted alternative wins at every week, and is calibrated.** Fitting
`team-outlook.js`'s logistic on league-relative features, **leave one season out**
(each graded season predicted by a model fitted on the other four, so it never sees
its own outcomes), beats the simulation at every week from 0.2134 down to 0.1312,
and its worst bin gap never exceeds **0.022** against the simulation's 0.085 to
0.347. The gap is largest exactly where the simulation is worst: at week 2 the
fitted model is informative (0.2134 against a 0.2410 base rate) while the
simulation is harmful.

**Stable across seasons**, which is what says this is not one odd year: 0.2010,
0.2089, 0.1898, 0.1958, 0.1919 for 2021-2025 against a base rate of ~0.2411
throughout.

**The conclusion does not rest on the simulation count.** At 200 draws the standard
error of a probability at p = 0.5 is `sqrt(0.25/200)` = 0.035. The week-2 bin gap is
0.347, ten times that, and the week-8 gap is 0.085, still more than double. A
`--sims 500` run moves the table's fourth decimal.

## What this does NOT license anyone to conclude

- **It is not a grade of `season-sim.js`'s published number.** The app simulates
  from week 1 with zero records and through-2025 projections (per the audit:
  `MyTeam.tsx:62` sends no `from_week`, `season-sim.js:173` defaults `fromWeek` to
  1, `:122` returns zero records, `:180` builds projections through `SEASON-1`).
  That configuration was not graded and there is no reason to assume it does
  better than the floor measured here.
- **The substitution is least like the app early**, which is where the worst numbers
  are: at week 2 a team has two observations and the bootstrap draws from two
  values. Some of that week-2 overconfidence is the substitution rather than the
  app. The *direction* is not — extremes too extreme is what any
  simulate-from-your-own-history procedure does with a thin history.
- **The fitted model's win is partly home advantage.** It was fitted on other
  seasons of this same corpus, whose format mix is not Nick's leagues'. Its
  calibration here does not transfer automatically to five ESPN leagues, and
  claiming it would be the same error this file exists to catch.
- **No recommendation is implemented.** The three honest options — do not publish a
  percentage before week 4, publish the fitted probability for the playoff
  question, or widen the simulator's spread — all change what a page says, which is
  a proposal, not a grading result.

## Tests, and the mutations that prove them

The conclusion rests on two functions, so they were extracted from the script into
`server/services/calibration-metrics.js` and tested against values computed by hand.
A function that only ever runs against these 184,959 rows is one nobody can show
failing.

| | |
|---|---|
| RED | 7 tests, module absent — `ERR_MODULE_NOT_FOUND`, `# fail 1` |
| GREEN | `# pass 7 # fail 0` |

Two of the seven failed first against the real implementation, on float
associativity (`0.04 + 0.04 + 0.25` summed left to right is not bit-identical to
`0.33`). **The test was wrong, not the code**: pinning one summation order would pin
an accident. Those two now compare within 1e-12 and say why; exact equality is kept
wherever the answer is representable (0, 1, 0.25, every bin count).

Six mutations, each verified **applied** (the driver asserts its anchor occurs
exactly once and reports `ANCHOR NOT FOUND` otherwise), each restored from a
pristine copy:

| Mutation | Result | Caught by |
|---|---|---|
| genuinely equal-WIDTH bins (by probability range) | applied; pass 5, fail 2 | bins hold equal COUNTS, not equal widths |
| bin size by `ceil` instead of `floor` | applied; pass 6, fail 1 | the last bin takes the remainder |
| last bin does not take the remainder | applied; pass 6, fail 1 | (same) |
| an empty set scores zero instead of null | applied; pass 6, fail 1 | an empty set has no score to report |
| `pick` ignored, so every predictor grades as the simulation | applied; pass 6, fail 1 | an alternative predictor is graded through `pick` |
| bins built without sorting by probability | applied; pass 6, fail 1 | bins are ordered by probability |

**Why equal-count bins are the guarded rule and not a detail:** a simulator's
probabilities pile up near 0 and 1. Under equal-width bins almost every row falls
in the two end bins, where a 0.12 disagreement averages away against thousands of
rows — the exact overconfidence this report found would have been reported as
nothing. The test's fixture (six rows below 0.06, three above 0.9) is built so the
two rules disagree, and the equal-width mutation above is what proves it.

`regularSeasonWeeks` was exported from `history-corpus.js` for this, rather than the
script re-writing its query: the grading has to run on the same population as the
model it grades, and a second copy of that query is how the two drift apart.

## The five questions

1. **Well built?** It grades rather than asserts, on the largest population
   available, with a deterministic RNG so two runs agree, and it refuses rather
   than guesses when the corpus is absent. It adds one exported function to
   `history-corpus.js` and one new module; `season-sim.js` is not touched.
2. **Stats or made up?** Entirely measured. The only chosen numbers are the
   evaluation weeks (2-8, `OUTLOOK_GATE.weeks`, pre-registered elsewhere), 10 bins
   and 200 simulations, and the last of those is shown not to matter.
3. **How do we know?** 184,959 team-weeks across five seasons and 2,500 leagues,
   graded against `sh_team_seasons.made_playoffs`; three comparators (base rate,
   current cut, held-out fitted model); per-season stability; and the metrics
   themselves mutation-tested.
4. **Pointed anywhere else?** Yes, and this is the more valuable half. Any
   published probability in this app can be graded by the same two functions, and
   none of them has been: the title odds, `predictRankGap`'s boom/bust, the trade
   window, the Trade Brain's confidence. The first thing to point it at is the
   app's own `season-sim` output once a Nick league has a finished season.
5. **How does it unify?** One definition of "is this probability any good",
   applied by one module with its own tests, on the same corpus population the
   models are fitted on. Before this the answer to "how do we know this percentage
   is right" was that nobody did.
