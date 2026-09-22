# Phase A, "routes run (not just targets)" — source audit and a retraction

Measured 2026-09-22 in the cloud container, repo tree `2ead3c08` (docs-only
commits over origin/main `654ff93`). Every figure below is a read of a
downloaded file, not a read of an HTTP status code. That distinction is the
whole point of this document.

## 1. Retraction

I told the coordinator:

> `pfr_advstats/advstats_week_rec_{season}.csv` carries weekly receiving
> routes from 2018, so eight seasons of history.

**That is false.** The file has no `routes` column, in any season. I had
checked only that the URL returned HTTP 206. I never read the header.

`advstats_week_rec_{2018..2025}.csv`, all 8 seasons, 17 columns each,
`grep -c '^routes$'` = **0/8**:

```
game_id, pfr_game_id, season, week, game_type, team, opponent,
pfr_player_name, pfr_player_id, rushing_broken_tackles,
receiving_broken_tackles, passing_drops, passing_drop_pct, receiving_drop,
receiving_drop_pct, receiving_int, receiving_rat
```

Same fault class as the handler-truncation alarm I retracted earlier tonight:
I verified that a thing was reachable and then reported a property of it I had
never looked at. The rule I handed the coordinator and then broke again here is
"a new instrument reports nothing until it has reproduced an answer you already
have."

## 2. True routes run is not in free nflverse data at all

| source | route-level per player? | evidence |
|---|---|---|
| `advstats_week_rec` | no | 17 columns above, no `routes` |
| `stats_player_week` | no | header grep for `rout\|snap\|particip` returns nothing |
| `snap_counts` | no — total snaps only | `offense_snaps, offense_pct, defense_snaps, defense_pct, st_snaps, st_pct` |
| `pbp_participation` | **no, and this is the near miss** | has a `route` column, but it is one charted route per *play* |

`pbp_participation_2024.csv`, 45,919 rows: `route` is non-empty on 19,110
(41.6%) and its values are route *types* for the targeted receiver — top
values `QUICK OUT` 3,462, `HITCH/CURL` 3,299, `SCREEN` 1,995, `IN/DIG` 1,760,
`GO` 1,683. One value per play, not one per receiver on the field. So it
cannot be counted into routes-run per player per week.

**Conclusion: the feature as specified cannot be built from free data.** Any
"routes run" figure this platform shows would be a proxy, and must be labelled
one.

## 3. What *is* available, verified by content

`pbp_participation` carries `offense_players` — a semicolon-delimited list of
gsis ids, one row per play, **100.0% populated** in both 2024 (45,919 rows,
285 games, weeks 1-22) and 2025 (45,184 rows, 285 games, weeks 1-22). 285 =
272 regular + 13 playoff, i.e. complete seasons.

Season coverage was content-probed, not inferred: for 2016-2025 the first
400 KB of each file parses, the `nflverse_game_id` prefixes match the
requested season, and `offense_players` is populated. **Coverage is 2016-2025,
ten seasons** — two more than the eight I had claimed.

Pass plays can be marked in-file by `number_of_pass_rushers > 0`: 22,151 of
45,919 plays in 2024 (48.2%). It is good, not exact — 222 plays carry a
charted route with pass rushers at 0, and 3,263 pass plays have no charted
target (sacks, throwaways, scrambles), which are correct to *include* since
receivers ran routes on them. The marker therefore needs validating against
`play_by_play`'s `play_type` on one season before it is used, with the
agreement rate reported.

## 4. The finding that changes the plan: the proxy cannot serve 2026

```
pbp_participation_2026.csv  -> HTTP 404 (body: "Not Found")
snap_counts_2026.csv        -> 2,901 rows, season 2026, weeks {1: 1492, 2: 1409}
stats_player_week_2026.csv  -> 2,162 rows, season 2026, weeks {1: 1118, 2: 1044}
```

Participation stops at 2025. The two live feeds are current through week 2,
which matches the app's own "2026 week 2" — an independent instrument
reproducing an answer we already had.

So a participation-derived feature can **prove lift on history and cannot
score a 2026 lineup**. On Nick's five questions it would fail "pointed
anywhere else on the platform".

## 5. Two stale claims inside the repo, both falsified by measurement

`server/services/nfl-formations.js` already ingests this exact release
(`:56`), and asserts at `:23`, `:60-61` and `:239`:

> participation ends after 2023. The NFL restricted the underlying tracking
> feed, so nflverse could not continue it.

It branches on `season > 2023` to emit that note. But 2024 and 2025 both
download complete (above). `server/services/td-features.js:174` says
"2016-2025" and agrees with the measurement. Two files in the same tree
disagree; the measurement settles it as 2016-2025.

`server/services/nfl-advanced.js:169` states:

> The nflverse weekly PFR advanced release begins in 2024; earlier 404s are
> source absence, not empty football data.

Measured row counts for `advstats_week_rec`: 2018 **4,292**, 2019 4,269,
2020 4,428, 2021 4,608, 2022 4,547, 2023 4,594, 2024 4,453, 2025 4,533 —
each with only its own season's rows. Six seasons of real data sit behind a
comment saying they do not exist. Note `syncSnaps` fetches the `.csv.gz` form;
for participation `.csv.gz` is a hard 404 while `.csv` serves, so the
extension is not interchangeable across releases.

Neither file is this thread's to edit (one editor per server file). Both go
to the coordinator to route.

## 6. What `nfl-formations.js` does not store

It writes `nfl_play_formations (game_id, play_id, season, possession,
offense_formation, offense_personnel, defense_personnel, defenders_in_box,
pass_rushers)`. It parses the participation CSV but **never stores
`offense_players`**, so the existing ingester cannot produce per-player
counts. Three files read a table named `pbp_participation`
(`td-features.js:191`, `nfl-weekly-feature-store-v2.js:272`,
`nfl-formations.js:10`) and **no migration or schema file creates it** —
`grep -rln pbp_participation server/db/ server/migrations/` returns nothing.

## 7. The five questions

- **Well built?** Nothing built yet. This is the source audit that precedes it,
  and it stopped the feature before code was written.
- **Stats or made up?** Stats. Row counts, column lists and week maps from
  downloaded files; the one figure I previously stated from a status code is
  retracted in §1.
- **How do we know?** Every number above is reproducible by downloading the
  named file and parsing it; the commands are in the thread.
- **Pointed anywhere else on the platform?** Not yet, and §4 is the reason that
  matters: the best available proxy has no 2026 data to point anywhere with.
- **How does it unify?** It does not, until §4 is decided.
