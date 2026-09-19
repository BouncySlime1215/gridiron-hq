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

## Where this runs

Both scripts talk to the database directly through `server/db/index.js`, not over
HTTP, so they have to run **on the machine holding the live volume** — a shell on
the Fly machine, with `GRIDIRON_DB_PATH` pointing at `/data/data.sqlite` as the
app itself uses it. There is no route that triggers either of them.

**Check the script is actually on the machine first — but it probably is.**
`scripts/promote-volume-shrinkage.mjs` does not exist on `main`; it lives only on
the branch stack. Measured over HTTP on 2026-09-19, read-only:

- `GET /api/league-chat` returns **401**, and a nonsense path returns **404**.
  That route is mounted only by `server/index.js` on the stack, so the deployed
  build is the stack, not `main`.
- The stack's `Dockerfile` runtime stage does `COPY scripts ./scripts`, so a
  build from that branch puts the script at `/app/scripts/`.

The one gap HTTP cannot close: `/api/league-chat` arrived in `cfa0e6f`, and the
promotion script in `75c47b8`, which is later on the same branch and adds no
route. So a build pinned between those two would serve league-chat without
carrying the script. `ls /app/scripts/promote-volume-shrinkage.mjs` in the shell
settles it in one second — do that before anything else, but expect it to be
there.

That means whoever runs this needs `fly ssh console` access. `GRIDIRON_FLY_TOKEN`
is an application bearer token, not a Fly API token, so it does not grant that,
and `flyctl` is not installed in the cloud session. Nick has the access; a cloud
session does not.

Running them against any other copy of the database fits and activates a vector
for that copy and leaves the live app untouched, which is a silent no-op rather
than an error — so check the path before assuming a run took effect.

## The precondition that is easy to miss

`projections.js:230` feeds a QB structural head from `nfl_qbr_weekly`, and **the
gate's verdict depends on how much of that table is populated.** Measured three
ways on 2026-09-19:

| `nfl_qbr_weekly` | gate |
|---|---|
| empty everywhere | passes |
| 2021-2026 fully backfilled | **fails** — the 2025 ensemble gain is no longer significant |
| 2025-2026 only | passes |

The live database was read at 16:38Z and holds 0 rows for 2021-2024, 540 for 2025
and 34 for 2026 — the third row, which passes. But another thread is backfilling
QBR, and if 2021-2024 lands before this promotion the gate has to be re-read and
may come back false. **Check `nfl_qbr_weekly` coverage before step 1 and record
what it was**, so a later reader knows which of the three verdicts they are
looking at.

## Preconditions

1. The app answers — and note it answers *intermittently*. It returned a full
   16 KB report at 16:38Z on 2026-09-19, then timed out again at 80 seconds on a
   different path shortly after, having been dead for 25 minutes before that. A
   separate thread traced this to heavy scheduler jobs blocking the main thread,
   which a TCP-only health check cannot see. One successful response is therefore
   not evidence the machine is healthy enough for a 90-second read-heavy gate;
   make sure it is responding steadily before starting, and expect to retry.
2. The live database holds `player_week_usage` for 2021-2025. **Verified
   2026-09-19 16:38Z:** 7,659 / 7,945 / 8,436 / 8,675 / 8,857 rows for 2021-2025,
   18 weeks and 32 teams each. Note 2026 is **0 rows** — the current season has no
   usage data on the live app at all, which does not block the gate (it replays
   2023-2025) but does mean this week's projections have no 2026 usage under them.
   That is somebody else's fix; it is recorded here so it is not mistaken for a
   consequence of this change.
3. Nobody else is mid-sync. The gate is read-heavy and takes about 90 seconds on
   a warm machine; a synchronous backfill running alongside it will block both.

## Step 1 — re-read the gate on live data

```
node scripts/promote-volume-shrinkage.mjs --dry-run
```

Writes nothing. Prints the production vector and these five conditions, which are
fixed in the script before the run rather than chosen after it. **All five must
read `true`:**

1. structural head better in all three seasons, each significant
2. structural head rank correlation not worse in any season
3. full ensemble better in 2024 and 2025, significant on 2025
4. start/sit ranking with a did-not-play scored as zero, not worse in either season
5. 80% interval coverage inside [0.78, 0.82]

The production vector it prints should land near these, which is what the numbers
below were measured with — six entries, one per metric and position:

| metric | position | fitted k | hand-picked today |
|---|---|---|---|
| `target_share` | ALL | ~0.18 | 6 |
| `carry_share` | RB | ~0.08 | 6 |
| `carry_share` | OTHER | ~0.09 | 6 |
| `qb_attempts` | QB | ~0.26 | 6 |
| `team_pass_att` | ALL | ~1.3 | 10 |
| `team_rush_att` | ALL | ~1.7 | 10 |

A vector wildly away from these means the live history differs from the rebuild;
read the gate rather than the table in that case, and say so. For reference, on a database rebuilt from nflverse on
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
