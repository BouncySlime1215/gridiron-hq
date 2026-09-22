# Every defender's snap share read 0.0000

`server/services/who-plays.js`, `whoPlays`.

## The five questions

**Well built?** One SQL expression, copied from the sibling file that already
solved it, plus removing a `?? 0` that would have re-broken it at the consumer.

**Stats or made up?** Measured on the real `snap_counts_2024.csv`: 26,615 rows,
`offense_pct` has **0 blank cells and 16,063 literal zeros**, of which **11,027
have a positive `defense_pct`** — defenders who were on the field.

**How do we know?** RED `decbee6` fails 2 of 5; the fix turns it green; 8
mutations killed with a no-op control that correctly survives. Two mutations
survived a first pass and exposed a genuine hole in the test.

**Pointed anywhere else?** `offseason-data.js:1013` has the same shape and
**cannot take this fix** — see below. `nfl-availability.js` already had it.

**How does it unify?** Snap share now means the same thing for a defender as
for a receiver, which is what every consumer already assumed.

## The defect

```sql
SELECT player, position, AVG(offense_pct) AS pct FROM nfl_snaps …
```

The comment above it reads "Snap share, which decides whether an absence
actually matters". For every defensive player it returned **0.0000**, including
a cornerback who played every defensive snap of every game.

Not cosmetic. `expected_snaps_lost` is `snap_share * (1 - play_probability)`,
and both the `out` and `questionable` lists sort by `snap_share`. A ruled-out
starting corner contributed **exactly 0** to the cost of his own absence and
sorted last among the players flagged.

## It was already known

`nfl-availability.js:188-194` carries the fix and the explanation:

> This used to select `offense_pct` alone. `nfl_snaps` carries a fully populated
> `defense_pct` too (25,271 of 25,271 rows in 2021, and the same in every season
> since), so every defender -- about half of each roster -- matched nothing, fell
> through to the 0.15 default below, and was valued by position alone. A starting
> cornerback and a fourth safety were the same number. They are not the same
> number.

`who-plays.js` is the sibling that never got it. This is a wiring gap, not a
discovery.

## The fix, and why it is not just `MAX(COALESCE(...))`

```sql
AVG(CASE WHEN offense_pct IS NULL AND defense_pct IS NULL THEN NULL
         ELSE MAX(COALESCE(offense_pct, 0), COALESCE(defense_pct, 0)) END)
```

plus dropping `?? 0` at the consumer. Three facts must stay apart:

| case | meaning | result |
|---|---|---|
| defender, `offense_pct` = 0, `defense_pct` > 0 | absent measurement | the defensive share |
| deep reserve, both = 0 | **real** measurement | 0 |
| no usable row | neither | **NULL**, not 0 |

A bare `MAX(COALESCE(...))` fixes the first and breaks the third: it turns
*never measured* into *played 0%*, which is the same absent-as-zero lie one
layer up. `NULLIF` would break the second, promoting a deep reserve to
unmeasured.

## Mutations — 8 killed, 1 no-op control correctly survived

| # | Mutation | Result |
|---|---|---|
| M1 | revert to `AVG(offense_pct)` | killed (2) |
| M2 | defence only | killed (1) |
| M3 | `MAX` → `MIN` | killed (3) |
| M4 | `NULLIF` instead (overcorrection) | killed (1) |
| M5 | consumer re-coerces null to 0 | killed (1) |
| M6 | `CASE` dropped | killed (1) |
| M7 | `CASE` uses `OR` not `AND` | killed (1) |
| M8 | `st_pct` substituted for `defense_pct` | killed (2) |
| M9 | **no-op control** (whitespace) | survived — as it must |

**M5 and M6 survived the first pass, and the test was wrong.** The "unmeasured"
case was covered only by a player with *no snap row*, who never reaches the
lookup at all — so neither the aggregate's NULL nor the consumer's coercion was
ever exercised. Added a player who *has* rows whose percentages are all NULL,
and both mutations died. A missing row and a row full of nulls are different
paths, and only the second tests the code.

**M7 needed a judgement.** `AND` versus `OR` is unreachable from the current
feed — measured: 0 rows in 26,615 have exactly one percentage column blank, so
on real data the mutant is equivalent. Rather than record it as equivalent, the
semantics were pinned with a fixture row carrying one column: `nfl_snaps` is a
table, not the file, and a partial ingest can leave one side NULL. One missing
column is still a measured player.

## `offseason-data.js:1013` — the same shape, and this fix CANNOT apply

```sql
SELECT p.gsis_id, AVG(s.offense_pct) pct FROM player_week_snaps s …
```

`player_week_snaps` **has no `defense_pct` column at all**
(`mlb-model-misc.js:279-285`: `offense_snaps REAL, offense_pct REAL`), and its
writer `nflverse.js:283` never reads one. So the contamination is real but the
correction is unavailable: there is no defensive column to take the `MAX`
against. Fixing it means widening the table and the writer, and `nflverse.js`
belongs to another owner. **Routed rather than attempted.** Recorded here so the
next reader does not try to copy this fix across and find it impossible.
