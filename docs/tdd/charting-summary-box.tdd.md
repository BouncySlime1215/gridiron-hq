# chartingSummary's box mean averages in the uncharted zeros

`server/services/nfl-formations.js`, `chartingSummary`.

## The five questions

**Well built?** The fix is one `NULLIF` and one bound parameter, in the same
shape the function directly above it already uses. No new concepts.

**Stats or made up?** The defect is measured, not argued: on the fixture the
shipped code publishes 4.50 where the measurement is 6.00. The production
magnitude is NOT measured here — see "What is not established" below.

**How do we know?** RED commit `ce75775` fails 2 of 5; the fix turns it green;
8 mutations against the fixed source are all killed.

**Pointed anywhere else on the platform?** Yes — this is the third instance of
one pattern. `formationDistribution` (same file) and the participation columns
were the first two.

**How does it unify?** It closes the last un-gated zero-contaminated aggregate
in this file, so every mean in `nfl-formations.js` now treats a feed zero the
same way.

## The defect

`chartingSummary` published `mean_defenders_in_box` from
`AVG(CAST(defense_box AS REAL))` over every charted row. The feed writes `0`
rather than blank where the box was never counted, so those rows were averaged
in as if a real count of zero defenders had been observed.

`formationDistribution`, one function above it in the same file, already wraps
the identical measurement in `NULLIF` for exactly this reason. The sibling read
never got the same treatment.

Fixture: three rows with the box counted at 7, 6 and 5, plus one uncharted row
at 0. Shipped code returns **4.50**; the measurement is **6.00**.

## The overcorrection trap, pinned deliberately

`play_action`, `motion`, `screen`, `rpo`, `no_huddle`, `trick` and
`out_of_pocket` are genuine 0/1 flags. A zero there is a real measurement — the
play was not play action. `NULLIF` applied across the SELECT would convert every
one of those rates from "share of plays" into "share of plays that had it",
which is 1.0 by construction, from a real dataset and with nothing throwing.

This is the more expensive of the two mistakes, and it is not hypothetical: the
`n_blitzers` measurement in this project landed **3.5x wrong** (1.3095 against a
true 0.3786) from exactly this overcorrection — worse than leaving the original
bug in place. So the test asserts both directions: the box mean must drop its
zeros, and every flag rate must keep its own. Four of the eight mutations below
exist only to enforce that second half.

## A second, separate defect in the same function

The season was interpolated into the SQL string rather than bound:

```js
const clause = season ? `WHERE season = ${Number(season)}` : '';
```

`Number()` kept it uninjectable, so this was not a SQL-injection hole. It was a
crash: a non-numeric season became the bare token `NaN`, which SQLite parses as
a column name and rejects at prepare time —
`ERR_SQLITE_ERROR: no such column: NaN`. A bad query parameter surfaced as a 500
instead of the function's own empty answer. Now bound, per CLAUDE.md's
parameterised-queries-only rule.

Worth recording: the first fix carried a `Number.isFinite` guard alongside the
binding. Mutation M4 of the first battery **survived** — deleting the guard
changed nothing, because a bound `NaN` simply matches no row and falls through
to the existing empty answer. The guard was dead code and was removed rather
than kept with a test written to justify it.

## Mutations — 8 injected into the fixed source, 8 killed

| # | Mutation | Result |
|---|---|---|
| M1 | revert `NULLIF` on the box mean | killed (1) |
| M2 | `NULLIF` leaks onto `play_action` | killed (1) |
| M3 | `NULLIF` sentinel `0` → `1` | killed (1) |
| M4 | `NULLIF` leaks onto `motion` | killed (1) |
| M5 | `total` counts only charted boxes | killed (5) |
| M6 | `NULLIF` leaks onto `out_of_pocket` | killed (1) |
| M7 | revert binding to interpolation | killed (5) |
| M8 | season argument dropped | killed (3) |

## Production magnitude — MEASURED after the fact

The section that stood here said the live magnitude was unestablished, because
the container held zero `nfl_play_charting` rows. It has since been measured
directly against the real 2024 FTN file, in response to a challenge from the
Feature audit thread that the defect might be an artefact of the fixture:

- `n_defense_box` has **0 blank cells and 11,601 literal zeros** in 48,031 rows.
- Shipped `AVG` reads **4.6252**; `AVG(NULLIF(...))` reads **6.0980**.

So the defect is real in production data, not only in the fixture, and the
fixture's 4.50-against-6.00 understates it slightly rather than inventing it.

The challenge was well founded and its reasoning was sound: `num()` does return
`null` for an empty cell, and `AVG()` does skip NULL. The premise is what fails
— this feed never writes an empty cell for that column. It writes `0`.

Independent corroboration: the participation feed, a separately produced
dataset, gives `AVG(NULLIF(defenders_in_box, 0))` = **6.0970** against FTN's
**6.0980** — agreement to 0.001 on the corrected figure, while the two raw
figures disagree with each other by 0.247. Full workings:
`docs/evidence/feed-zero-contamination-measured.md`.
