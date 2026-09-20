# One constant, two statistics, four positions — and half of them do not exist

2026-09-20. `scripts/fit-efficiency-k.mjs` (new). Reads `server/services/projections.js`'s
`K.yards_per` and changes nothing: **no constant was altered, no row was written, nothing was
promoted.** On the arm-alignment branch off `main` (`791b131`), for a reason given below.

The coordinator's D31: `yards_per: 34` is one constant serving statistics that disagree on
held-out data; split it per metric and per position, re-fit each through the gate with an unseen
season, no promotion.

## What this is not, said first

The method-of-moments fitter's efficiency k is a **tested rejection** and this does not revisit
it. Substituting it made 2025 worse (4.773 against 4.749) because "player" is not a stable group
for efficiency within a season, so the between-player variance that method estimates is inflated;
`VOLUME_METRICS` in `shrinkage-fit.js` excludes efficiency for exactly that reason and the verdict
stands.

This is the other method in the same object — the held-out sweep that selected `int_rate: 1600`.
A variance decomposition and a held-out sweep can disagree, and where they do, the sweep is the
one that answers "does the projection get better". Anyone reading this as re-litigating the
rejection is reading the wrong study.

## Procedure

Selection on **2021 and 2022**. Held-out season **2023**, opened once. **2024 and 2025 are never
read**, by any stage, so a confirmation remains available that nobody has spent.

1. Coordinate-wise sweep: for each of the eight (metric, position) cells, sweep k over
   `{1, 2, 4, 8, 15, 25, 34, 50, 75, 120, 200, 400, ∞}` with every other cell left at 34.
2. Combine the non-flat winners and grade the combination, because the cells are **not
   independent** — a receiver's ypt changes the team volume every other player is measured
   against — so additivity is measured rather than assumed.
3. Open 2023 once, paired per player-week, bootstrapped clustered by player.

## The result

Pooled selection MAE, incumbent (all cells 34): **4.7527** over 8,700 player-weeks.

| metric | position | k=1 | k=2 | k=34 (now) | k=∞ | winner | gain |
|---|---|---|---|---|---|---|---|
| ypt | QB | 4.753 | 4.753 | 4.753 | 4.753 | — | **0.0000** |
| ypt | RB | 4.752 | 4.752 | 4.753 | 4.753 | 1 | 0.0007 |
| ypt | WR | 4.747 | 4.747 | 4.753 | 4.767 | 2 | **0.0062** |
| ypt | TE | 4.751 | 4.752 | 4.753 | 4.754 | 1 | 0.0014 |
| ypc | QB | 4.751 | 4.752 | 4.753 | 4.753 | 1 | 0.0013 |
| ypc | RB | 4.745 | 4.746 | 4.753 | 4.759 | 1 | **0.0079** |
| ypc | WR | 4.754 | 4.754 | 4.753 | 4.753 | ∞ | 0.0002 |
| ypc | TE | 4.753 | 4.753 | 4.753 | 4.753 | 4 | 0.0001 |

Combination of the five non-flat cells: sum of individual gains **0.0178**, the combination's own
gain **0.0170** — close to additive, and measured rather than assumed.

**2023, opened once:** incumbent **4.580**, candidate **4.555**, 4,389 rows paired on
`season|player|week`. Paired bootstrap clustered by player: `mean_diff -0.0244`,
`ci90 [-0.0342, -0.0144]`, significant, `clustered: true`.

## What it means, which is not simply "split the constant"

**1. The direction is unambiguous and the magnitude is small.** 34 over-regresses both efficiency
statistics wherever they exist. Every cell that moves at all moves the same way, monotonically,
and the held-out gain is **0.025 MAE on a 4.58 baseline — about half a percent**, significant on a
player-clustered bootstrap. Real, one-directional, and small.

**2. Every winner was at the grid's lower edge, so the sweep gave a direction, not a value.** That
needed a second measurement rather than a rounded-off answer, and below the edge the two live
cells **part company**:

| | k=0.01 | 0.1 | 0.25 | 0.5 | 1 | 2 | 4 |
|---|---|---|---|---|---|---|---|
| ypt WR | 4.7477 | 4.7477 | 4.7467 | 4.7467 | 4.7467 | **4.7462** | 4.7472 |
| ypc RB | **4.7437** | **4.7437** | **4.7437** | 4.7442 | 4.7447 | 4.7457 | 4.7472 |

- **ypt/WR has a real interior optimum, at about 2** — seventeen times smaller than 34, but a
  genuine minimum, so some shrinkage toward the prior is earning its place.
- **ypc/RB is minimised at zero**, flat from 0.25 downward. Its optimum is *no shrinkage at all*.

That second line is not a smaller k, it is **a statement about the prior rather than about k**: if
trusting a running back's own raw yards per carry beats every blend toward the prior, the prior is
contributing nothing for that metric, and encoding `k = 0.01` would bury that finding inside a
constant. **It is escalated rather than encoded** — the question is what the ypc prior is and why
it is not helping, and that is a bigger question than this one.

**3. Half the cells do not exist.** `ypt/QB` is flat to four decimals across the entire grid, and
exactly so: quarterbacks have no targets, so the constant is applied to a statistic they do not
have. `ypc/WR` and `ypc/TE` move by 0.0001–0.0002, which is noise. So "one constant serving two
statistics across four positions" is really one constant serving **two live cells, two marginal
ones and four dead ones** — and the dead cells are why a single shared number looked defensible
for as long as it did: most of what it governs cannot move.

## Verdict, and it is not a promotion

Nothing is promoted, and it should not be on this evidence.

- The gain is half a percent and the ensemble weights `[0.20 structural, 0.40 season_to_date,
  0.15 last3, 0.05 last1, 0.20 median]` were fitted against the **current** head. The
  `projections.js` header already carries this exact lesson from the 4.749 → 4.376 volume finding:
  the fix is "persist the fit, then re-run the ensemble promotion gate", not a constant change.
- One of the two live cells wants a prior investigation, not a constant.
- 2024 and 2025 are unspent. A change this small should be confirmed on a season the selection
  never saw before it moves live start/sit output.

What this establishes for Nick's list, in one line: **the shared efficiency constant is measurably
too strong, worth about half a percent of weekly accuracy, and the rushing half of it is really a
question about the prior rather than the constant.**

## The check that caught the study grading the wrong thing

The first version keyed on `_decision_rows` filtered to `played`. That is the **decision variant** —
players active the previous week — and a different population: **3,314 rows against the point
MAE's 4,341 on 2021, 4.987 against 4.875.** Every comparison in the sweep would still have been
internally consistent, so nothing would have looked wrong. The study would simply have answered a
question nobody asked, while quoting a number that did not describe it.

It is caught by construction now: the recomputed mean must equal the harness's own MAE to three
decimals over the same row count, and the script **exits non-zero** otherwise. Demonstrated rather
than asserted — restoring the wrong population makes it print:

```
  2021: harness 4.875 over 4341, recomputed 4.987 over 3314 rows
REFUSING: 2021 recomputed 4.987 over 3314 does not match the harness's 4.875 over 4341. The rows
being graded are not the rows the MAE quotes, so nothing below would mean what it says.
```

exit 1, with no table printed. Script hash after restoring: `2095fea97be3`.

**Why there is no mutation table or RED commit here.** This adds no served code — it is a study
whose output is its deliverable, and its one guard rail is demonstrated above by making it fire.
The behaviour it measures belongs to `projections.js`, which is unchanged, so there is nothing in
the shipped tree for a mutation to break. If any of this is promoted later, that change is RED-first
with a table of its own.

**Why it sits on the arm-alignment branch.** Stage 3 pairs two replays per player-week and
bootstraps them clustered by player — the exact call shape whose unguarded version compared
different seasons to each other in the offseason model. It uses the guarded `clusteredDiff`, which
throws rather than pair rows that do not line up, so a misaligned pairing cannot quietly become a
finding here. A study that measures a half-percent effect has no business using the primitive that
inverted a sign.

## Numbers

Full local check `npm run check` on this tree: exit 0 — **2,961 tests, 2,920 passed, 0 failed, 41
skipped**; typecheck, lint and build clean; `start:smoke` passed on an isolated database (32 teams).
Identical to the arm-alignment branch's figures, which is the point: this commit adds a script and
an evidence file and no served code, so the suite must not move. The totals are lower than other
branches in this thread report because this one is off `main` and carries none of their tests.

The study's own runtime: three stages, 13 grid points over 8 cells on the selection seasons, then
one held-out replay pair, at roughly 3.7 s per replay on the fixed seed 20260826.

## The five questions

**Is this well built?** It is a script with one job, a refusal that stops it lying, and three
stages in the order that keeps the held-out season held out. The part I would not call well built
is what it studies: one constant governing eight cells, four of which cannot respond to it.

**Is this based on stats, or is it made up?** Measured, on 8,700 selection player-weeks and 4,389
held-out ones, with the boundary probed rather than rounded off. The one thing not measured is what
the ypc prior should be, and that is named as open rather than guessed.

**How do we know?** The selection seasons and the held-out season are separate and 2024–25 are
untouched; the pairing is by row identity, not index; the interval is clustered by player; and the
grading is checked against the harness's own MAE before any of it runs. The finding that is *not*
supported — a specific value for ypc/RB — is reported as unsupported.

**Should this data be pointed anywhere else on the platform?** `K.td_rate = 70` and
`K.catch_rate = 26` are the same shape of constant in the same object, applied in the same raw
opportunity unit across the same positions, and the same dead-cell argument applies to them. Worth
one sweep with this script, which takes them as easily. Routed, not run.

**How does it unify?** It does not unify anything yet, deliberately. What it does is turn a
constant whose header already admitted "it is not a claim that it is correct" into a measured
statement about which of its eight cells are live, which are dead, and which one is asking a
different question than the one being answered.
