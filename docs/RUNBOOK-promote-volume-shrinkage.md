# Runbook — promoting the fitted volume shrinkage constants

Prepared 2026-09-19. **Not executed.** This changes how every weekly projection
comes out on the live app, so it waits on Nick's word.

The evidence for doing it at all is in `docs/OPPORTUNITY-FINDINGS-2026-09-19.md`.
This file answers only the operational questions: what gets written, how to undo
it, what to check afterwards, and what the app serves in between the two steps.

## What it is

`projections.js` shrinks target share and carry share toward a positional prior
with `K.share = 6`, and team pass/rush volume with `K.team_volume = 10`. The
variance-components fitter estimates those at roughly 0.18-0.28 and 1.3-2.9. No
fit has ever been persisted, so `activeKVector()` returns null and production has
always taken the hand-picked branch.

Everything needed already exists and is correct — the fitter, the pre-registered
gate, the cutoff-safety guard that re-fits when a stored fit would see the season
being graded, and the recency-units guard that keeps the vector off the
season-long callers it was not fitted for. The only missing thing is a row.

## Preconditions

1. The app answers. As of 16:30Z on 2026-09-19 `gridiron-hq.fly.dev` had not
   returned a byte for 25 minutes on any path, including the bare homepage.
2. The live database holds `player_week_usage` for 2021-2025. The gate replays
   three full seasons; it cannot run on a partial history. **Check this first** —
   if the live rows differ materially from the rebuild these numbers came from,
   the gate's verdict is not transferable and it has to be re-read on the day.
3. Nobody else is mid-sync. The gate is read-heavy and takes about 90 seconds on
   a warm machine; a synchronous backfill running alongside it will block both.

## Step 1 — re-read the gate on live data

```
node scripts/promote-volume-shrinkage.mjs --dry-run
```

Writes nothing. Prints the five gate conditions and the production vector. **All
five must read `true`.** For reference, on a database rebuilt from nflverse on
2026-09-19 they all passed, with ensemble MAE 4.453 → 4.428 (2024) and
4.362 → 4.341 (2025), and start/sit pair accuracy 0.6349 → 0.6395 and
0.6272 → 0.6334.

If any condition is false on live data, stop. Do not promote and do not argue
with the gate.

## Step 2 — promote

```
node scripts/promote-volume-shrinkage.mjs
```

Writes exactly this, in one transaction:

- **one row** in `shrinkage_fits` — the fit's metadata, MAE either side, and a
  note naming the gate script;
- **six rows** in `shrinkage_k` — one per (metric, position): `team_pass_att/ALL`,
  `team_rush_att/ALL`, `target_share/ALL`, `carry_share/RB`, `carry_share/OTHER`,
  `qb_attempts/QB`;
- `UPDATE shrinkage_fits SET active = 0`, then `active = 1` on the new row.

Nothing else in the database is touched. No existing row is modified except the
`active` flag on prior fits, and there are none. The script then reads the vector
back and refuses if it does not round-trip, and asserts that it reaches the weekly
path and *only* the weekly path.

## Step 3 — re-fit the ensemble weights

```
node scripts/promote-weekly-ensemble.mjs
```

Inserts a new row in `weekly_ensemble_fits` with `promoted = 1`. The existing
`fit-1` is not deleted; `activeWeeklyWeightSet` reads the newest promoted row
whose cutoff precedes the week being predicted.

## The window between step 2 and step 3

Asked directly, and measured rather than assumed: with the fitted k live and the
**currently promoted** weights `[0.20 structural, 0.40 season_to_date, 0.15
last3, 0.05 last1, 0.20 median]` still in force —

| season | promoted weights + hardcoded k | promoted weights + fitted k | |
|---|---|---|---|
| 2024 | 4.4406 | 4.4372 | −0.08%, ci90 [−0.006, +0.013] |
| 2025 | 4.3647 | 4.3685 | +0.09%, ci90 [−0.014, +0.007] |

Player-clustered paired bootstrap, neither significant (p = 0.27 and 0.72).

**So the intermediate state is a wash, not a hazard.** It is safe to sit in, but
it delivers none of the improvement: the whole gain comes from the re-fit, which
moves the structural head's weight from 0.20-0.25 up to 0.50-0.55. Run step 3 in
the same sitting anyway — there is no reason to leave a better head under weights
that do not use it.

## Rollback

```sql
UPDATE shrinkage_fits SET active = 0;
```

One statement, instant, and production is back on the hand-picked constants the
next time a projection is built. `activeKVector()` returns null with no active
row, and `pickK()` falls through to the literals. The fit rows stay on disk for
inspection; nothing is destroyed, so this is reversible in both directions.

To roll back step 3 as well:

```sql
UPDATE weekly_ensemble_fits SET promoted = 0 WHERE id = <the new id>;
```

which restores `fit-1` as the newest promoted row.

## What to check immediately afterwards, on live data

Each of these fails loudly rather than quietly, which is the point:

1. **The vector is live and scoped.** `activeKVector()` returns six entries, and
   `activeKVectorFor` with the season-long recency returns `null`. The script
   asserts both before it exits; re-check by hand if it was interrupted.
2. **Projections moved, and in the right direction.** Pull
   `GET /api/model/projections` for the current week before and after. Volume
   should be less regressed toward the positional prior — high-share players
   project higher and low-share players lower. If nothing moved, the vector is
   not reaching the weekly path.
3. **Nothing went negative or absurd.** Scan the same payload for a projection
   below zero or above the position's historical maximum. The fitted k for
   `carry_share/RB` is 0.08, which is close to full trust in the player's own
   number; a player with one prior game is the case to look at.
4. **The season-long callers are unchanged.** Draft assist, season sim and the
   preseason model must produce the same numbers as before, because the vector is
   deliberately withheld from them. If they moved, the recency guard failed.
5. **Re-grade on live data, not on the rebuild.** `scripts/grade-harness.mjs`
   against the live database is the honest confirmation that the gate's verdict
   holds on the rows the app actually has.

## Honest limits

- The gate's 2025 arm is not a pristine holdout: the structural head has been
  measured on 2025 before. What protects it is that the fit for season s never
  sees s, the constants are variance-component estimates rather than anything
  chosen by looking at an MAE, and the sign has to hold in every season.
- The numbers above come from a database rebuilt from public sources in a cloud
  session, not from the live volume. They should reproduce; step 1 exists to
  check that rather than to assume it.
