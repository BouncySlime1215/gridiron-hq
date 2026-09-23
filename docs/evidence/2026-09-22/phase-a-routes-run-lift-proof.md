# Phase A, routes run — the lift proof, and the verdict

Ran 2026-09-22. Verdict up front: **routes run does not earn a place in the
model.** It carries real information, and every bit of that information is
already in a feature this project ingests today. Per the standing instruction,
this falls to option C — red-zone touches inside the 10.

## The measured result

Purged walk-forward by season-week, 2018-2025, 25,323 out-of-sample
player-week predictions. Target is the player's PPR points that week, using
the weights in `server/services/scoring.js`.

| model | MAE | RMSE | R² |
|---|---|---|---|
| baseline — prior targets, receptions, yards, PPR, snap share, games, position | 4.7750 | 6.3836 | 0.3218 |
| + route share and targets-per-route | 4.7760 | 6.3838 | 0.3218 |

MAE improvement, paired bootstrap resampled **by player** (a player's weeks are
not independent draws), 2,000 iterations:

```
median -0.0010 PPR points   95% CI [-0.0027, +0.0008]   -> does not clear zero
```

The treatment is a hair *worse* than the baseline. Adding route share on top of
snap share specifically: **-0.0007 PPR, 95% CI [-0.0018, +0.0005]**. Per
position, MAE with snap share alone vs snap share plus route share: RB 5.2238 →
5.2237, TE 3.8601 → 3.8616, WR 4.9728 → 4.9737. Nothing anywhere.

## Why this is a real negative and not a broken harness

A null result is worthless until the instrument is shown to detect an effect
that is genuinely present. Against a deliberately weak baseline (prior PPR and
games played only, MAE 4.8180):

| feature added | MAE | improvement vs weak baseline | 95% CI |
|---|---|---|---|
| prior targets | 4.7996 | +0.0184 | [+0.0121, +0.0250] |
| snap share | 4.7787 | +0.0396 | [+0.0272, +0.0513] |
| **route share** | 4.7769 | **+0.0411** | [+0.0300, +0.0524] |
| route share + targets-per-route | 4.7761 | +0.0419 | [+0.0309, +0.0533] |
| same-week targets (deliberate leak) | 3.6140 | +1.1615 | [+1.1084, +1.2113] |

So the harness resolves effects down to roughly 0.012 PPR, and the leakage
control lights up at +1.16 as it must. **Route share does carry signal** — on
its own it is the strongest single volume feature tested, marginally ahead of
snap share.

The reason it earns nothing is redundancy, not absence. Head-to-head as the
volume feature, with targets, yards and prior PPR in the baseline:

```
+ snap share   MAE 4.7750
+ route share  MAE 4.7742
route minus snap: +0.0008 PPR   95% CI [-0.0035, +0.0055]  -> indistinguishable
```

Route share and snap share are the same information. The project already
ingests snap share: `server/services/nfl-advanced.js:175` writes `nfl_snaps`
with `offense_snaps` and `offense_pct`. Building routes run would spend the
ingest, the storage and the surface area to re-learn a column already in the
database.

## Controls

- **SHUFFLED** — route features permuted within (season, week, position):
  improvement -0.0009, CI [-0.0022, +0.0004]. Lift vanished, as required.
  Weak evidence on its own here, since there was no lift to destroy; the power
  table above is what makes the null meaningful.
- **NO-OP** — snap share duplicated as a fake new column: improvement
  +0.0000, CI [-0.0002, +0.0003]. A duplicate column buys nothing, so the
  harness is not rewarding mere width.
- **Positive control** — same-week targets: +1.1615. The harness can see.

## What the feature actually is, and its honest name

True routes run is **not in free nflverse data**, per
[the source audit](./phase-a-routes-run-source-audit.md).
`pbp_participation`'s `route` column is one charted route per *play* — the
targeted receiver's route type — not a per-player count.

So the feature measured here is **pass-play participation**: plays where the
player appears in participation's `offense_players` and `play_by_play` calls
the play a pass (attempt, sack, or QB scramble), excluding penalty-nullified
`no_play`. A blocking back on the field for a pass play is counted and ran no
route, so the proxy is biased upward, most for RB.

Measurement quality:

- **Join rate 100.00%** — every pass play in pbp was found in participation, in
  all eight seasons (2018: 19,765/19,765 … 2025: 19,830/19,830).
- The cheap in-file marker (`number_of_pass_rushers > 0`) was validated against
  pbp's own `play_type` on 2024: 45,919/45,919 joined, 96.78% agreement,
  precision 0.9456, recall 0.9871. False positives are almost all `no_play`
  (1,190 of 1,206). pbp's `play_type` was used for the build; the marker is
  documented only as a fallback.
- `pfr_player_id` → `gsis_id` crosswalk matched 195,933/196,130 snap rows
  (99.90%).
- The proxy reproduces football: WR median route share 0.714, TE 0.486, RB
  0.375, all bounded by 1.0. 2024's top pass-play participant reaches 718 over
  17 games (42.2/game), slightly above published routes-run leaders, which is
  the expected direction for a proxy that counts blocking snaps.
- **One bug found and fixed**: keying the team denominator off
  `stats_player_week`'s `team` produced a route share of 1.731 for a 2025 week 1
  receiver, which is impossible. The team is now taken from the possession team
  on the plays the player actually appeared in; 294 player-weeks disagree
  between the two, and no row now exceeds 1.0.

## Kaggle Big Data Bowl — checked, not usable from here

Reachability, measured:

```
https://www.kaggle.com/                                   200
.../competitions/nfl-big-data-bowl-2026-analytics/data    200  (JS shell, 5,708 bytes)
/api/v1/competitions/list                                 401
/api/v1/competitions/data/list/nfl-big-data-bowl-2026-analytics   401
/api/v1/competitions/data/download-all/...                401
```

No Kaggle credentials exist in this container (`KAGGLE_USERNAME`,
`KAGGLE_KEY`, `KAGGLE_CONFIG_DIR` all unset; no `~/.kaggle/kaggle.json`; no
CLI). Competition data also requires accepting the competition rules on an
account, which is not something a container can do. I could not enumerate the
files, so I am not asserting what they contain.

Two things are worth knowing before anyone chases it: Big Data Bowl releases
cover a small slice of seasons rather than 2016-2025, and **they have no 2026
data either**, so tracking data would improve the historical label and would
still not solve the live-serving problem. And competition data carries
use restrictions that need reading before it goes anywhere near a product.

## Consequence for the approved plan

Option B was: learn the feature on history, then serve an *estimated* version
for 2026 from live `snap_counts`. **B is dead at stage one.** The measured
feature does not beat the incumbent baseline, so there is nothing worth
estimating — an estimate of a feature that adds zero would add less. Falling to
C as instructed, rather than pushing B past its gate.

## The five questions

- **Well built?** Nothing shipped. The harness is validated by a power table
  and three controls, and the one bug it surfaced was fixed before any lift
  number was reported.
- **Stats or made up?** Stats. 25,323 out-of-sample predictions, 40,601
  player-weeks, every join rate stated.
- **How do we know?** Walk-forward with features built only from a player's
  earlier weeks in the same season, fixed feature scaling so no test-set
  statistic leaks in, and errors compared by a bootstrap resampled by player.
- **Pointed anywhere else on the platform?** No, and deliberately: it did not
  earn a consumer.
- **How does it unify?** It does not. The honest answer is that `nfl_snaps`
  already carries this information, and the next feature should be one the
  platform does not already have.
