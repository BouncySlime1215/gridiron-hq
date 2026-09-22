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

---

# Sweep, pass 3, 2026-09-22: the two entry points are not one defect

Pass 2 stopped at the SQL. Pass 3 followed the same columns into the JS-side
means and found the consumers split across **two independent tables** —
`player_week_usage` and `nfl_player_week_features`. They needed measuring
separately, and they do not both carry the defect.

## 5. `football-context.js:93` — ~~CONFIRMED~~ **CORRECTED: a dead column**

> **Correction, 2026-09-22 16:30Z, from Feature audit.** This section first
> called the site a live defect and priced it. It is not live, and the pricing
> below describes a value nothing displays. `AVG(target_share)` is selected at
> `:93` and **never read**: `target_share` appears exactly once in the whole
> file, on that line. The number the function actually shows is `usage_share`
> at `:131`, computed at `:125` as `touches / totalTouch` out of `SUM(targets)` and
> `SUM(carries)` — raw sums, which literal zeros cannot move, because adding
> zero adds nothing. **The feed zeros do not reach any output here.** The site
> is a dead column, not a contaminated one.
>
> ~~"up to 46% of the value displayed"~~ is **WITHDRAWN**: nothing at this site
> displays it. The measurements below stand as measurements of the column —
> they were made against the feed, not against this function — and the section
> is kept because the treatment rule it establishes is what any genuinely live
> consumer will need. What is withdrawn is the claim that this consumer is one.
>
> The lesson is the one this document keeps relearning: **a defect is not live
> until the value reaches something.** I traced the read and priced the column
> without checking that the column was consumed. Feature audit checked, and was
> right.

### The column, measured anyway — the treatment rule is the part that survives

```sql
AVG(target_share) target_share, COUNT(*) games
```

over `player_week_usage` (`server/services/football-context.js:89-96`), with no
gate on whether the player was on the field. The feed writes a literal `0`, not
a blank, for a week a player did not play:

| season | REG skill rows | blank | literal 0 | > 0 |
|---|---|---|---|---|
| 2022 | 5,285 | 0 | 952 | 4,333 |
| 2023 | 5,234 | 0 | 866 | 4,368 |
| 2024 | 5,271 | 0 | 1,041 | 4,230 |
| 2025 | 5,444 | 0 | 1,161 | 4,283 |

Joined to snap counts, the zeros split cleanly and the control is empty:

| season | zero rows matched | `offense_snaps = 0` | `offense_snaps > 0` | control (`share > 0`) with 0 snaps |
|---|---|---|---|---|
| 2023 | 840 (97.0%) | 158 (18.8%) | 682 (81.2%) | **0 of 4,176** |
| 2024 | 1,012 (97.2%) | 206 (20.4%) | 806 (79.6%) | **0 of 4,043** |

That empty control is what rules `NULLIF(target_share, 0)` out. Roughly 80% of
the zeros are a player who **was** on the field and drew no target — a real
measurement that belongs in the mean. Only the `offense_snaps = 0` fifth is
inapplicable. The treatment is a **gate on the sibling snap column**, not a
blanket null of every zero.

Priced on the 4-week window this function actually reads:

| season | player windows | affected | mean understatement | largest |
|---|---|---|---|---|
| 2023 | 5,772 | 197 (3.4%) | 0.0079 share (46.3% of the value shown) | +0.0684 |
| 2024 | 5,809 | 315 (5.4%) | 0.0052 share (25.7% of the value shown) | +0.0607 |

## 6. `offseason-data.js:787-789` — CONFIRMED, ruled LEAVE (scope, not correctness)

```js
p.target_share = avg(w.map(x => x.target_share));
p.air_yard_share = avg(w.map(x => x.air_yards_share));
p.wopr = avg(w.map(x => x.wopr));
```

Same defect, same table: `priorUsage` at `:765` selects from
`player_week_usage`, and the `avg` helper at `:539` filters `null` and
`!Number.isFinite`, which does nothing whatever against a literal zero. Season
means are hit harder than 4-week windows because a season carries more
did-not-play weeks:

| season | players | affected | mean understatement | moving ≥ 0.005 | largest |
|---|---|---|---|---|---|
| 2023 | 487 | 50 (10.3%) | 0.0107 share | 24 | +0.0769 |
| 2024 | 499 | 78 (15.6%) | 0.0047 share | 26 | +0.0278 |

Unlike §5, this one is **not** a dead column. The season means become
`prior_target_share`, `prior_air_yard_share` and `prior_wopr` at `:1086-1089`,
stored columns in the offseason feature table (`db/schema/mlb-model-misc.js:459`)
and a declared model feature (`offseason-model.js:1256`). The value reaches
something. That is what makes it a real defect and §5 not one.

**Verdict: leave it.** Not because the numbers are small — they are the largest
in this document — but because the offseason product is outside approved scope,
so its inputs wait behind Phase A. The gate shape, if it is ever re-scoped, is
§5's: drop the week when the sibling snap column is zero, keep it when the
player was on the field. This row is the spec; no TDD cycle was spent.

## 7. `nfl_player_week_features` — CHECKED AND CLEAR, by construction

The three remaining consumers — `nfl-player-value.js:110, 116` and
`nfl-roster-strength.js:213` — average `target_share`, `carry_share` and `wopr`
out of this table, not out of `player_week_usage`. The same column names invited
the assumption that it is the same defect twice. It is not.

The writer is `nfl-pbp.js:589-678`, and its divide helper at `:115` is

```js
const div = (a, b) => (b > 0 ? a / b : null);
```

so every share is **null on an inapplicable denominator, never zero**. Measured
over all 21,427 rows:

| | rows |
|---|---|
| both `target_share` and `air_yards_share` measured | 21,427 (100.00%) |
| either one null | 0 |
| `wopr = 0` | 4,104 (19.15%) |
| — of those, a coerced null | **0** |
| — of those, a true zero (on the field, no targets, no air yards) | 4,104 |

Every zero in this table is a player who played and drew nothing. That is a
measurement, and the `Number.isFinite` filters in both consumers are correct
against it. **Fixing the `player_week_usage` consumer will not fix these, and
these need no fix.**

## 8. `nfl-pbp.js:650` — LATENT, fires on no row today

```js
wopr: r3(1.5 * (tgtShare ?? 0) + 0.7 * (airShare ?? 0)),
```

The one place in the writer that coerces a null share to zero, publishing the
sum as though both components were measured. Two ways in: a team week with no
targets at all, and a player row whose `team` is missing, since the team-total
loop skips `!p.team` at `:595` while the write loop at `:611` does not. Neither
occurs in the data as it stands — 0 coerced rows, 0 rows without a team — so
this is recorded as a latent shape, **not** a defect, and nothing is being
proposed against it. It is here so the next sweep does not re-derive it.

## Treatments tally — now five, still never blanket

| treatment | where |
|---|---|
| `NULLIF(col, 0)` | `defenders_in_box`, `defense_box` |
| gate on a sibling column | `n_blitzers` (on `n_pass_rushers > 0`), `pass_rushers`, **`target_share` (on `offense_snaps > 0`)** |
| `MAX(COALESCE(a,0), COALESCE(b,0))` | `offense_pct` / `defense_pct` |
| leave alone | `contested` and every other `bool()` column |
| **out of scope, priced and parked** | **`offseason-data.js:787-789`** |

## The five questions

1. **What would make this wrong?** A snap row that is itself zero-filled for a
   player who did play. The control rules it out in the direction that matters:
   0 of 4,176 (2023) and 0 of 4,043 (2024) rows with a positive target share
   have `offense_snaps = 0`, so the snap column is not fabricating zeros on
   players who were on the field.
2. **What is the incumbent?** The ungated `AVG`, which understates an affected
   4-week window by 0.0079 share (2023) and an affected season mean by 0.0107.
3. **How big is it, live?** Smaller than this document first said. §5's window
   figures price a column nothing reads, so they buy nothing on their own; the
   season-mean figures in §6 do reach a stored feature, and §6 is parked on
   scope. **On current evidence the live surface of this defect class in
   `player_week_usage` is not yet established** — see §9.
4. **What did I check that came back clean?** `nfl_player_week_features`, in
   full: 21,427 rows, no coerced null, every zero real. Recorded as §7 because a
   negative that narrows a routed unit is worth as much as a positive.
5. **What is still open?** Nothing in this document. The edits belong to whoever
   owns the files; this is the finding, not the fix.

---

## 9. `projections.js:492` — the first LIVE consumer, and it is fantasy-side

§5 was a dead column and §6 is parked on scope, so the question the class turns
on is whether any consumer of these zeros reaches a user. One does.

```js
// server/services/projections.js:492, inside the per-row accumulation
if (u.target_share != null) { a.tgtShareW += roleW; a.tgtShare += roleW * u.target_share; }
// :522
const tgtShareObs = a.tgtShareW ? a.tgtShare / a.tgtShareW : 0;
```

The rows come from `history()` at `:294-300`, which selects `u.*` from
`player_week_usage` with no snap filter, so a week the player took zero
offensive snaps enters the role-weighted mean as a real zero. The result is
served: it becomes `volume.target_share` at `:723`, which
`news-fantasy-impact.js:121` and `trade-engine.js:411` both read. Both are
fantasy surfaces. **This is live, and it is in Phase A scope.**

### The part that does not depend on a modelling opinion

Two other sites gate the identical column on `> 0`:

| site | gate |
|---|---|
| `projections.js:395` — the positional prior | `u.target_share != null && u.target_share > 0` |
| `shrinkage-fit.js:330` — the k fit | `u.target_share != null && u.target_share > 0 ? … : null` |
| **`projections.js:492` — the observation** | **`u.target_share != null`** |

So the observation is computed on one support and the prior it is shrunk
toward, together with the `k` controlling how hard it is shrunk, are fit on
another. Whichever support is correct, these three should agree, and they do
not. That is a defect independent of any view about zeros.

### Priced, reproducing the site's own weighting

`docs/evidence/feed-zero-projections-target-share.mjs`, using the shipped
constants (`RECENCY.seasonDecay = 0.35`, `weekHalfLife = null`, so
`rowWeight = 0.35 ** (through - season)`), `through = 2024`:

| | |
|---|---|
| rows entering the `:492` gate | 10,505 |
| matched to a snap row | 10,071 (95.9%) |
| of those, `offense_snaps = 0` | 364 |
| players with a usable mean | 627 |
| **affected** | **113 (18.0%)** |
| mean understatement of `tgtShareObs` | **0.0059 share, 34.1% of the value computed** |
| affected players moving ≥ 0.005 | 41 |
| largest single move | +0.0769 (jashaun corbin, 2 of 3 rows) |

**Two limits on that number, both stated rather than buried.** It is measured
on `tgtShareObs`, which is the input to `shrink()`, **not** the served
projection — the shrink step and the 0.06 prior sit between, and both damp it,
so this is an upper bound on what a user sees. And the snap files here cover
2023-2024 only, so seasons at `back >= 2` are absent; their weight is
`0.35^2 = 0.1225` and below, under 9% of the total an untruncated run would
carry.

Unmatched rows (4.1%) are kept in the gated mean rather than dropped, so the
measurement cannot manufacture an effect out of a failed join.

### What this does NOT settle

Whether the zero-snap weeks belong in the mean at all is a modelling question,
not a data-hygiene one, and it is not settled here. A mean that includes weeks
a player did not play is a different estimand — it prices availability into the
volume head — and there is a live argument that the DNP-inclusive version is
the honest one. This section says only that the site is **live**, that its
support **disagrees with its own prior and k**, and what that disagreement is
worth. Which way to resolve it is a unit, with an owner, acceptance criteria
and a held-out split.

`projections.js` is Fantasy plan's file under the one-editor rule. Nothing here
was edited.
