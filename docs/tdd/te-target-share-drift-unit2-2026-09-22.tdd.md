# Unit 2 (TE target-share drift): criteria 1 and 3, and a magnitude that does not reconcile

2026-09-22. Measurement only, no code changed — `projections.js` is Fantasy
plan's file under the one-editor rule (Auditor, B3.5); this unit is
"measure and rule," not a build. Off `main` `654ff93`.

## Where this sits

The Auditor redirected Unit 2 before it started
(`audit-gate1-te-drift-and-verification-guard-2026-09-22.md`, Part B):
"the premise names one constant where the code has two, and they differ by
a factor of ten... Until 1 and 3 are answered, no half-life moves." This
answers criteria 1 and 3, and reports a criterion-0 problem found while
trying to satisfy criterion 2: the drift magnitude the unit was briefed
with does not reproduce against this container's real data under any
population definition tried.

## Criterion 3 — does the target-share prior inherit the recency lag?

**No — and not for either reason the criterion anticipated.**
`positionalPriors(log)` (`projections.js:392-435`) does accumulate a
per-position `tgtShare` array (`:401`, `p.tgtShare.push(u.target_share)`,
unweighted — no `roleW` or any recency factor applied to the push). But
that array is never read: `out[pos]` (`:423-432`) has no `share` key, so
the accumulated array is computed on every `buildProjections` call and
discarded. The actual value consumed at the call site
(`projections.js:583`, `targetSharePrior = 0.06`) is a **flat hardcoded
literal**, not derived from `log`, `positionalPriors`, or any
recency-weighted or unweighted history at all.

A constant carries no time dependence, so it cannot inherit a lag from
either `RECENCY` or `WEEKLY_ROLE_RECENCY` — the "compound vs. partly
cancel" question in criterion 3 has no live answer because the prior side
of the shrink is inert to season decay entirely. Whatever the structural
drift measured in criterion 2 is, it acts only through the `tgtShareObs`
side of `shrinkSafe(tgtShareObs, targetSharePrior, ...)`, never through the
prior.

**A separate, already-documented problem sits at the same line and is
worth restating because it bears on the same shrink call.** The comment
directly above `targetSharePrior = 0.06` (dated 2026-09-17, present before
this unit started) already states real per-position averages — WR 0.1311,
TE 0.0981, RB 0.0624, pooled 0.1025 — and that "only RB is anywhere near
0.06." One global prior for three non-exchangeable positions is a known,
open, unfixed issue, not something this unit is introducing or needs to
re-derive; it explains why the low-evidence end (rookies, one-game
samples) runs several points hot on TE/RB projections regardless of
whatever the drift analysis concludes.

## Criterion 1 — name the consumer

`roleRecency` has no default (`projections.js:453`, `"Omitted means
identical legacy behavior"`). Only one production caller passes
`WEEKLY_ROLE_RECENCY` for the volume/share accumulation this unit is
about: `player-week-engine.js:273`. The other eleven production callers
(`ceiling-lineup.js:62`, `week-postmortem.js:99`, `draft-assist.js:83`,
`season-sim.js:180,380`, `ros-projection.js:331`, `preseason-model.js:459`,
`routes/model.js:404,426,482`) omit it and get `RECENCY`
(`seasonDecay: 0.35, weekHalfLife: null`).

The Auditor's own closed form (B2, not re-derived here per criterion 2's
instruction not to) already splits the bias by consumer:

| consumer | seasonDecay | lag (H=3) | bias as % of the drift's own base |
|---|---|---:|---:|
| season-long paths (11 callers) | 0.35 | 0.478 seasons | 2.17% |
| weekly path (`player-week-engine`) | 0.05 | 0.053 seasons | 0.24% |

So: **the season-long paths are the ones a drift correction could matter
for; the weekly path is not**, independent of what the drift's true size
turns out to be (a smaller true drift only shrinks both numbers
proportionally, it does not change which side is ~9x the other).

## What blocks criterion 2, found while trying to satisfy it

Criterion 2 asks whether the TE drift is predictable ahead of time or only
visible in hindsight — a real walk-forward test against held-out seasons.
Building that test requires knowing what population the briefed drift
figures (0.2115 → 0.2449 over 3 seasons, 0.011133/season) were measured
on. **Three different real-data readings against this container's
`player_week_usage` (2021-2026, joined to `players.position = 'TE'`), none
within a factor of two of the briefed range:**

| definition | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|---:|
| flat player-week average, share>0 | 0.1090 | 0.1070 | 0.1094 | 0.1117 | 0.1165 |
| per-player-season avg, then league avg | 0.0860 | 0.0874 | 0.0877 | 0.0894 | 0.0961 |

A third definition — for each team-season, the TE with the most total
targets that season (the "starting TE" reading), league-averaged:

| definition | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|---:|
| starting TE per team, avg of season target-share | 0.1564 | 0.1624 | 0.1609 | 0.1672 | 0.1736 |

(query: `WITH te_season AS (SELECT player_id, season, team, SUM(targets)
total_targets, AVG(target_share) avg_share FROM player_week_usage JOIN
players ON players.id=player_week_usage.player_id WHERE position='TE' AND
target_share IS NOT NULL AND target_share>0 AND team IS NOT NULL GROUP BY
player_id, season, team), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION
BY team, season ORDER BY total_targets DESC) rn FROM te_season) SELECT
season, AVG(avg_share), COUNT(*) FROM ranked WHERE rn=1 GROUP BY season`,
32 teams every season — run against this same container's `server/
data.sqlite`.)

All three readings put TE target share in the 0.086-0.174 range across
every season in this container's real data, with a season-over-season
drift on the order of 0.001-0.005 — the "starting TE" reading (definition 3)
comes closest to the briefed endpoints but still tops out around 0.174, not
0.2449, and its own season-over-season drift (2021→2025: (0.1736-0.1564)/4
= 0.0043/season) is still roughly 2.6x smaller than the briefed
0.011133/season. None of the three reproduces the briefed 0.2115/0.2449
endpoints or their implied per-season drift.

**Reconcile-or-explain, per this session's own standing discipline for a
relayed figure that doesn't check out (same pattern as the Unit 4
21%-vs-29.82% reconciliation):** either the briefed 0.2115/0.2449 figures
come from a different metric than league TE target share (e.g. a
within-position share, a different stat entirely, or a source outside this
container's `player_week_usage`), or they come from a population this
container's real data can't currently reproduce. Not building criterion
2's predictability test against an unverified magnitude — a test tuned to
the wrong effect size would look measured while answering nothing.

## The five questions

**Is this well built?** Two real SQL aggregations against the actual
`player_week_usage` table, no synthetic data, cross-checked two ways
(flat player-week average, per-player-season-then-league average).

**Is this based on stats, or is it made up?** Every number here is a real
query result against this container's database or a citation of code
already in `projections.js`, not an assumption.

**How do we know?** `positionalPriors`'s discarded-array claim is a direct
code read (`:392-435`, `:583`), checkable by anyone; the magnitude
mismatch is checkable by re-running either SQL aggregation above.

**Should this data be pointed anywhere else on the platform?** The
0.06-flat-prior issue (already an open comment, not new) and this drift
figure's reconciliation both belong with whoever supplied the original
0.2115/0.2449 numbers — routing back through the coordinator rather than
guessed at further here.

**How does it unify?** Same discipline as the R&D step-3/Unit-1 writeup
and the Unit-4 injury-number reconciliation: a specific relayed number
gets checked against the source before anything is built on top of it, and
a mismatch is reported precisely rather than silently substituted or
silently accepted.
