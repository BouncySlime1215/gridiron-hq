# Do the real feeds write literal zeros? Measured, 2026-09-22

Run `node docs/evidence/feed-zero-contamination-measured.mjs <dir>` against a
directory holding `ftn_2024.csv` and `part_2024.csv`, downloaded from
`https://github.com/nflverse/nflverse-data/releases/download/{ftn_charting,pbp_participation}/`.

## The question

`nfl-formations.js` writes numeric columns through `num()`, which returns
`null` — never `0` — for an empty cell, with a comment saying so. If the feeds
wrote blanks for "not charted", then `AVG()` would already skip them and there
would be no contamination anywhere to fix.

**That is the premise this measurement tests, and it is false.** The feeds do
not write blanks. They write literal zeros.

## FTN charting, 2024 (48,031 rows)

| column | blank → NULL | literal 0 → 0 | positive | AVG raw | AVG NULLIF |
|---|---|---|---|---|---|
| `n_defense_box` | **0** | **11,601** | 36,430 | 4.6252 | 6.0980 |
| `n_blitzers` | 0 | 41,539 | 6,492 | 0.1770 | 1.3095 |
| `n_pass_rushers` | 0 | 25,880 | 22,151 | 1.9877 | 4.3101 |

`n_defense_box` has **zero** blank cells. `num()` therefore never returns null
for it, every one of the 11,601 zeros is stored as `0`, and `AVG()` skipping
NULL protects nothing.

## Participation, 2024 (45,919 rows)

| column | blank → NULL | literal 0 → 0 | positive | zeros on a charted dropback | AVG raw | AVG NULLIF |
|---|---|---|---|---|---|---|
| `defenders_in_box` | 14 | **9,219** | 36,686 | 22 | 4.8726 | 6.0970 |
| `number_of_pass_rushers` | 14 | **23,754** | 22,151 | 286 | 2.0798 | 4.3101 |

## The cross-check that settles it

These are two independently produced datasets. They agree on the corrected
number and disagree on the raw one:

| quantity | participation | FTN | agreement |
|---|---|---|---|
| mean box, **NULLIF** | 6.0970 | 6.0980 | to 0.001 |
| mean box, **raw** | 4.8726 | 4.6252 | off by 0.247 |
| mean rushers, **NULLIF** | 4.3101 | 4.3101 | exact to 4 dp |
| mean rushers, **raw** | 2.0798 | 1.9877 | off by 0.092 |

Two separate charting operations converging on 6.097 defenders and 4.3101
rushers is a real quantity being recovered. The raw figures cannot both be
right and neither is: each is dragged down by however many zeros its own file
happens to carry, which is why they disagree.

## Per-column verdict — the treatment is NOT uniform

| column | table | correct treatment | why |
|---|---|---|---|
| `defenders_in_box` | `nfl_play_formations` | **NULLIF** | 9,219 zeros, only 22 on a charted dropback |
| `pass_rushers` | `nfl_play_formations` | **dropback gate** (NULLIF is close) | 286 of 23,754 zeros are on a charted dropback, so a few are real |
| `defense_box` | `nfl_play_charting` | **NULLIF** | 11,601 zeros, 0 blanks |
| `contested` | `nfl_play_charting` | **LEAVE ALONE** | `bool()` column; `0` means genuinely not contested |
| `n_blitzers` | `nfl_play_charting` | **gate on `n_pass_rushers > 0`** | see below |

## `n_blitzers`: the column where NULLIF is the wrong fix

| treatment | value | n |
|---|---|---|
| raw AVG (ships the zeros) | 0.1770 | 48,031 |
| `NULLIF(n_blitzers, 0)` | 1.3095 | 6,492 |
| gated on `n_pass_rushers > 0` | **0.3838** | 22,151 |

`NULLIF` lands **3.41x** above the gated figure. Blitzing nobody on a pass
play is a real measurement, so dropping every zero deletes the majority of
genuine observations. Here the reflex fix is worse than the bug: raw is 0.21x
low, NULLIF is 3.41x high.

This is why "add NULLIF to the contaminated averages" is not a safe blanket
instruction, and why any fix has to be argued per column against the feed.

---

# Sweep, 2026-09-22: further instances of the same pattern

Method: every `AVG(` in `server/` that is not already wrapped in `NULLIF`,
triaged against what its feed actually writes. Two confirmed instances beyond
the three already fixed, plus one checked and cleared.

## 1. `who-plays.js:69` — CONFIRMED, live, user-facing

```sql
SELECT player, position, AVG(offense_pct) AS pct FROM nfl_snaps
 WHERE season = ? AND week < ? AND UPPER(team) = ? GROUP BY player, position
```

Measured on the real `snap_counts_2024.csv` (26,615 rows):

| | count |
|---|---|
| `offense_pct` blank | **0** |
| `offense_pct` literal `0` | **16,063** |
| `offense_pct` positive | 10,552 |
| of those zeros, rows where `defense_pct > 0` — **a defender who played** | **11,027** |

`AVG(offense_pct)` raw = 0.2356; over non-zero rows = 0.5942.

So every defender's `snap_share` computes to **0.0000**, including a cornerback
who played every defensive snap. The value feeds the comment directly above it —
"Snap share, which decides whether an absence actually matters" — so a starting
defender's absence is scored as not mattering.

**This exact bug was already found, fixed and documented in this repository**,
in `nfl-availability.js:188-194`:

> This used to select `offense_pct` alone. `nfl_snaps` carries a fully populated
> `defense_pct` too (25,271 of 25,271 rows in 2021, and the same in every season
> since), so every defender -- about half of each roster -- matched nothing […]
> A starting cornerback and a fourth safety were the same number.

`who-plays.js` never got the same fix.

**Correct treatment — a third one, and neither of the first two.** Not `NULLIF`,
which would drop genuine bench zeros, and not a gate. It is the same expression
`nfl-availability.js` already uses:

```sql
AVG(MAX(COALESCE(offense_pct, 0), COALESCE(defense_pct, 0)))
```

## 2. `offseason-data.js:1013` — CONFIRMED by shape, same defect, different table

```sql
SELECT p.gsis_id, AVG(s.offense_pct) pct FROM player_week_snaps s …
```

Same expression over `player_week_snaps` rather than `nfl_snaps`. Not measured
against that table directly — flagged, not asserted.

## 3. `nfl-weekly-feature-store-v2.js:623, 634` — CONFIRMED, byte-identical to v1

The v2 study copy carries the same three contaminated aggregates as
`nfl-weekly-feature-store.js:149, 158-160`, character for character:

```sql
AVG(defenders_in_box) defenders_in_box, AVG(pass_rushers) pass_rushers
AVG(c.contested) contested_share, AVG(c.defense_box) charted_box
```

A fix applied to v1 alone leaves v2 wrong. v2 is study-only — its own header
says nothing in the server imports it — so this is not a live bug, but it is
what any future v2 gate would read, and the v2 study is what produced the
version-bump outage.

## 4. `nfl-availability.js:194` — CHECKED AND CLEAR

`AVG(MAX(COALESCE(offense_pct, 0), COALESCE(defense_pct, 0)))` injects zeros
deliberately so `MAX` can work across the two columns, and its comment explains
why. A row with both columns NULL would average in as a real 0, but the same
comment records `defense_pct` as fully populated. Correct as written. Recording
the negative because "there is a COALESCE to zero here" looks like the pattern
and is not.

## Running tally of treatments — four distinct, still never blanket

| treatment | where |
|---|---|
| `NULLIF(col, 0)` | `defenders_in_box`, `defense_box` |
| gate on a sibling column | `n_blitzers` (on `n_pass_rushers > 0`), `pass_rushers` |
| `MAX(COALESCE(a,0), COALESCE(b,0))` | `offense_pct` / `defense_pct` |
| leave alone | `contested` and every other `bool()` column |
