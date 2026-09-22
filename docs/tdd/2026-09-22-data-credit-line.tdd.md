# TDD evidence: a data credit line that is always on screen (F-08)

Unit F-08, plan item F3 (licence). Branch `claude/local-f-08-data-credit-line`,
base `origin/main` `d6d7bd5a`.

**Before:** the app names no data source anywhere a user can see. The only
record of a data licence is the `sources` array on `GET /api/data-freshness`,
and no client code reads it. The freshness banner, the one component that reads
that route, returns `null` at `client/src/components/DataFreshnessBanner.tsx:132`
whenever every table is current or the banner was dismissed, so even a credit
placed inside it would vanish on a healthy day.

## 1. Audit (tree `d6d7bd5a`, before the first test)

### What `GET /api/data-freshness` says today

Mounted the route on a throwaway database (`GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite`,
`SCHEDULER_DISABLED=1`, `NFL_SEASON=2026`) with `.local-db/probe-sources.mjs`
(git-excluded) and printed `sources`:

```
status 200 keys season,week,all_fresh,tables,sources all_fresh false tables 1
{"repo":"nflverse/nflverse-data","dataset":null,"data_license":"CC BY 4.0","license_url":"https://creativecommons.org/licenses/by/4.0/","creator":"nflverse"}
{"repo":"ffverse/ffopportunity","dataset":null,"data_license":"CC BY 4.0","license_url":null,"creator":null}
```

So two sources, built at `server/routes/data-freshness.js:40` from
`NFLVERSE_SOURCE` (`server/services/nflverse.js:25`) and `FFOPPORTUNITY_SOURCE`
(`server/services/ffopportunity.js:17`). There is no FTN entry.

### What the client shows today

- `grep -c "report.sources\|\.sources" client/src/components/DataFreshnessBanner.tsx` → **0**.
  Control on the same file: `grep -c "report.tables"` → 3, so the grep finds
  fields the banner does read.
- `grep -rn -i -E "CC BY|CC-BY|creativecommons|licen[cs]e|attribut|FTN|nflverse" client/src`
  → 11 lines, none of them a credit. The hits are news-source attribution
  (`navigation.ts:51`, `features/news/*`, `pages/News.tsx`), an SVG
  `attributeName`, and a status count on `pages/Model.tsx:58`.

### Which licensed sources the app actually loads (grep of the loaders)

| Source | Loader (fetch) | Table and writer | Rows, local copy, not production |
|---|---|---|---|
| nflverse-data (CC BY 4.0) | `RELEASE` `server/services/nflverse.js:24` and 8 other files (listed in `docs/tdd/nflverse-attribution.tdd.md`) | many; e.g. `player_week_usage` | 42,624 (`player_week_usage`) |
| FTN charting via nflverse-data | `ingestCharting` `server/services/nfl-formations.js:135-136`, `${BASE}/ftn_charting/ftn_charting_${season}.csv` | `nfl_play_charting`, `INSERT … ON CONFLICT` at `nfl-formations.js:147` | 190,389 (2022: 41,643; 2023: 48,225; 2024: 48,031; 2025: 47,316; 2026: 5,174) |
| ffopportunity | `seasonCsv` `server/services/ffopportunity.js:31-32` | `nfl_ffopportunity_weekly` | 28,596 (2021-2025 about 5,600 a season; 2026: 315) |

Row counts: `sqlite3 .local-db/data.sqlite "SELECT season, COUNT(*) FROM nfl_play_charting GROUP BY season"`
(and the same for `nfl_ffopportunity_weekly`), on a `.backup` copy of
`gridiron-local/data.sqlite` taken 2026-09-22 about 20:13Z. Local copy, not production.

FTN charting is used, not just stored. It is read by
`nfl-weekly-feature-store.js:159` and `nfl-weekly-feature-store-v2.js:633` (the
`charting_*` team features behind `buildTeamFeatureVector`, which
`nfl-team-card.js:15` imports), and served raw at
`GET /api/nfl-betting/formations/charting` (`nfl-betting.js:1561-1564`,
`chartingSummary`). ffopportunity is read by `priorFfOpportunity` in
`player-week-engine.js:28` and refreshed by the scheduler job at
`scheduler.js:1552`.

### The licences, fetched 2026-09-22 20:08Z (not assumed)

- **nflverse-data.** Probed LICENSE, LICENSE.md, LICENSE.txt, COPYING and
  README.md on `master`, `main` and `gh-pages`. Only `LICENSE.md` exists (on
  `master` and `main`, identical: 18,651 bytes, sha256
  `2a82ac9bbc3e3ee066908381e8d373896db5a6025d083fbd59692fe9ccfb9111`, same hash
  #133 recorded). Its first line is "Attribution 4.0 International". The
  README (699 bytes) has no licence text. Repo HEAD `81b5d757`.
- **FTN charting.** The nflverse-data README says nothing about FTN. The
  terms are in nflreadr's loader docs, `R/load_ftn_charting.R` on `main`
  (`23f915a5`), lines 4-7, rendered at
  `https://nflreadr.nflverse.com/reference/load_ftn_charting.html` (HTTP 200).
  It says the data "is released under the CC-BY-SA 4.0 Creative Commons license
  and attribution must be made to **FTN Data via nflverse**". The FTN data
  dictionary page (`articles/dictionary_ftn_charting.html`) carries no licence
  text; the loader docs are the source.
- **ffopportunity.** `LICENSE.md` exists on `main`, `master` and `gh-pages`, and
  it is the GPL (package code). The README's "Terms of Use" (`main`, HEAD
  `74dcb35a`, which is the exact commit `FFOPPORTUNITY_SOURCE.pinned_code_commit`
  names) says the models and expected points data are "licensed under Creative
  Commons Attribution-ShareAlike 4.0 International". **The repo's descriptor says
  `CC BY 4.0`. That is wrong; the data is CC BY-SA 4.0.**

### Producers of the same concept

`grep -rn "CC BY\|CC-BY\|creativecommons" server client/src scripts test`:
`nflverse.js:14,29,30` (CC BY 4.0, correct), `ffopportunity.js:9,21` (CC BY 4.0,
wrong per above), `nfl-rookie-ingest.js:3,118` (`license: 'CC-BY-4.0'` on the
rookie ingest result, correct, a different field shape), the route comment
`data-freshness.js:25`, and the #133 test. One producer of the served source
list exists (`sources` on the freshness route); nothing else lists sources.

### File ownership

`gh pr list --state open --limit 200` (56 open PRs, under the limit), filtered to
files matching `ffopportunity|routes/data-freshness|source-registry`: only
`source-registry.js` (#38, #96, #104) and `docs/tdd/ffopportunity-season-completeness.tdd.md`
(#45) match. The `source-registry` hits are the control that the filter finds
real files. No open PR touches `server/routes/data-freshness.js`,
`server/services/ffopportunity.js`, `DataFreshnessBanner.tsx` or `App.tsx`.
`server/services/nfl-formations.js` is being edited by unit R-02
(`claude/local-r-02-formations-ingest-404`, 29 lines), so this unit does not
edit it; the FTN descriptor goes in a new file and a test ties it to that
loader's fetch URL instead.

### Extend or build: **extend**

- The server's `sources` array stays the one producer of "which sources, under
  which licence". This unit adds the missing FTN entry (new file
  `server/services/ftn-charting-source.js`, one line in the route) and corrects
  ffopportunity's licence in its own descriptor.
- The client gets one credit line, rendered by App below every page, outside
  the banner, so neither `all_fresh` nor a dismissal can hide it. It is static
  on purpose: attribution must still show when the freshness request fails or
  has not resolved (the route sits behind `legacyAuthenticated`, and the banner
  has a whole branch, `:116`, for the request failing). A test fails if the
  client's list and the route's `sources` ever differ in source or licence.
- No table, column or migration. Not a statistical unit (no model number), so
  no pre-registration and no look at the 2025 holdout.
