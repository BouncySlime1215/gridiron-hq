# PROJ-00 licences, read before any pull

Unit PROJ-00 (Layer 2 v2 history backfill). Written and committed before any data
file for this unit was downloaded. Every source below was fetched on 2026-09-23
(~19:50Z) from the URL shown; the sha256 prefix is of the fetched bytes.
`scripts/backfill-history.mjs` refuses to run unless this file exists and names
a source as `usable` (test/proj-00-history-backfill.test.js).

The loaders read the `decision:` lines below, one per source, verbatim.

## 1. nflverse play-by-play (`pbp/play_by_play_<season>.csv.gz`)

- Licence file: `nflverse/nflverse-data` `LICENSE.md` on `main` and `master`
  (identical, sha256 `2a82ac9bbc3e3ee0`); last changed in commit
  `f0697ac22524b0c7d0e64517475f252bb6b78409` (2022-01-28). No `LICENSE`,
  `LICENSE.txt` or `COPYING` on main, master or gh-pages (all 404); the README
  names no other terms.
- Licence: Creative Commons Attribution 4.0 International. Its first line reads
  "Attribution 4.0 International". Section 3(a) requires credit, a licence link,
  and a note that the data was changed.
- Attribution in the app already exists: `NFLVERSE_SOURCE` on
  `GET /api/data-freshness` (#133, `docs/tdd/nflverse-attribution.tdd.md`).
- nflreadr's `load_pbp` reference page (sha256 `211f3fe4fecedc25`) adds no
  separate terms.
- decision: nflverse_pbp usable (CC BY 4.0, attribution already shown)

## 2. nflverse participation (`pbp_participation/pbp_participation_<season>.csv`)

- Terms are in nflreadr's loader, not nflverse-data's licence:
  `R/load_participation.R` at nflreadr commit `68077e6d1a56` (2026-02-19), and
  the rendered reference page (sha256 `8417a5840a9f279e`). They say it is
  released under CC BY-SA 4.0 with attribution to "FTN Data via nflverse" from
  2023 on, and to "NFL NextGenStats via nflverse" for 2022 and earlier.
- Share-alike applies to adapted material we distribute. We store it per play
  and count it, and the repo commits only aggregates (row counts, match rates).
  No participation row is committed.
- Attribution in the app: `FTN_CHARTING_SOURCE` already credits "FTN Data via
  nflverse" (CC BY-SA 4.0) on the freshness report. There is no descriptor for
  the pre-2023 "NFL NextGenStats via nflverse" credit. That is a known gap,
  and it predates this unit: `nfl_play_formations` already holds 2022 participation.
  Listed as a follow-up in the evidence file.
- Route runners: the published file has no per-play route-runner list, only
  `route` for the targeted receiver. `was_route_runner` stays NULL.
- decision: nflverse_participation usable (CC BY-SA 4.0, aggregates only in the repo)

## 3. FTN charting as nflverse redistributes it (`ftn_charting`)

- nflreadr `load_ftn_charting` reference (sha256 `749ecb84e2187684`): CC BY-SA
  4.0, attribute to "FTN Data via nflverse"; available from 2022.
- This unit does not pull FTN charting (`nfl_play_charting` is loaded by
  `ingestCharting`, server/services/nfl-formations.js). It is recorded because the
  2023+ participation file is FTN's data under the same terms.
- decision: ftn_charting not pulled by this unit

## 4. ESPN fantasy API (`leaguedefaults/3`, weekly projections)

- ESPN publishes no API licence. The governing terms are the Disney Terms of
  Use, "Last Updated: May 24, 2024" (fetched copy
  `~/gridiron-local/rnd/loop/data/terms/disney_tou_fetched_2026-09-23T0000Z.html`,
  sha256 `0acba2c483f7d62f`).
- The licence grant is for personal, noncommercial use only, with no right to
  reproduce or distribute.
- Prohibited use (x) bars accessing, copying or extracting the products with a
  script or other automated means, including to compile "any collection of data, data set or database".
- A scripted pull of every 2025 week of ESPN projections into an archive is exactly
  that: a script that copies the product to build a data set. The coordinator
  rule for this unit is "if a licence forbids the use, stop that source and
  report it (do not pull)".
- Not decided here: whether the app's own per-league ESPN reads (a user's own
  league, `server/routes/espn.js:41`) fall under the personal-use grant. That is
  outside this unit.
- Also outside this unit: the 2021-2024 and 2026 files already in
  `~/gridiron-local/rnd/loop/data/espn_proj_hist/` were pulled 2026-09-22 by the
  R&D loop under the same terms (`rnd/loop/r2-external-espn-weekly-projection-history.md` §0).
  This unit did not create them and does not delete them.
- decision: espn_leaguedefaults usable for LOCAL archive only; Nick accepted the Disney ToU risk 2026-09-23 ~6:05 PM ET; data never committed

## 5. Open-Meteo historical archive (realized kickoff weather)

Not named in the unit row. It is listed because weather gaps are filled by the
existing canonical producer, `syncGameWeather` (server/services/nfl-weather.js),
which reads `archive-api.open-meteo.com`.

- open-meteo.com/en/licence (sha256 `d39dc07fcbb58372`): API data are CC BY 4.0.
- open-meteo.com/en/terms (sha256 `1d46aa2062d39eed`): free API use must be
  non-commercial and stay under 10,000 calls per day, 5,000 per hour and 600 per
  minute.
- The fill makes one call per outdoor game (about 190 per season) with a 150 ms
  pause. That stays under every limit.
- decision: open_meteo_archive usable (CC BY 4.0, free non-commercial tier)
