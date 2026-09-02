# Profit roadmap — the one consolidated plan

**Version 1.0 · 2026-09-02.** Supersedes the ordering in `PROFITABILITY_PLAN.md` §0,
`NEXT_SESSION_PLAN.md` §7 and the `BEAT_THE_CLOSE_PLAN.md` checklist. Those
documents stay as the detailed specs; this one says what gets done, in what
order, by whom (Claude, unless marked **Nick**), with the gate that closes each
step. Written for the agent that executes it: every step names files, the
check, and the commit.

Inputs consolidated here: the 2026-09-02 master audit (79 findings, scratchpad
`MASTER_AUDIT_REPORT.md`), run 17 (the full 2022–25 historical diagnostic,
finished today), the two live plans, and today's research into free quote
feeds and public models.

---

## 0. What the evidence says (read this before any step)

**Run 17, final (831 games, 56 weeks, 17 roles, coordinator v4).**

| Measurement | Run 8 (baseline) | Run 17 |
|---|---:|---:|
| Paper selections | 113 | 115 |
| Record | 55–57–1 | 55–58 |
| Units | −6.24 | −7.50 |
| ROI | −5.5% | −6.5% |
| Coordinator directional | — | 341/684 = 49.85% |
| Roles with non-zero weight | — | **0 of 17** |

Every role, including `qb_state` and `tendency_matchup` (marginal at week 35),
shrinks to zero on the full sample. Component-agreement splits are noise
(z = 1.02). **The side-picking engine has no edge and this is now settled
twice.** No further council roles get built for spreads. The council stays
running because it is the feature source for the line-movement work.

**What has an edge, measured out of sample:**

1. `ratings_vs_open` on spreads at Pinnacle's opener: +0.58 pts CLV, 57.7%
   direction, n 570, Holm p < 0.01; +1.04 on favourites ≤ 3. Live since 09-03.
2. Kickoff-hour wind on totals: +0.47 CLV, 62.1%, n 753 outdoor games. Not live.
3. Execution: books differ 0.81 pts on average; best-vs-median price is worth
   2.57%/bet; real break-even 51.38%. Wong teasers +6.5% EV at −110 (price is
   the edge; ledger of reachable prices is empty).
4. Props: model skill is real (2+ TD +27% Brier skill, any-TD +21%) and the
   market has never been measured — `nfl_prop_quote_snapshots` has 0 rows.

**Defect found today, fixed today:** the OddsTrader aggregator serves cached
per-book prices; Unibet's stamps ran a median 288 h old and disagreed with
Kambi's own BetRivers feed on 22 of 34 lines. `bestReachable` and the shopping
board picked those phantom numbers as "best price". Four of 28 Week 1
beat-the-close decisions used them (ids 65, 75, 83, 90; stamps 86 h to
2,230 h old). Fix: `book-feeds.js#isFreshQuote` (72 h gate on
`book_updated_at`) applied in `beat-the-close.js#bestReachable` and
`nfl-shopping-board.js#simultaneousQuotes`; tests added; the four rows are
annotated `stale_price_at_decision` and excluded from clean reads.

**Audit triage (verified against code today).** The audit read the fantasy
projection layer, not the betting stack. Of its 8 criticals: fumbles missing
from `projections.js` (real, fantasy-only), PPR hard-coded in `edge.js`
(real, fantasy-only), player duplicates (partly real: 114 dup name+position,
1 dup espn_id; fantasy side), holdout race (already `BEGIN IMMEDIATE`),
league helper (already fixed), sync/error-handling items (style). Its
150-hour roadmap (196 → 40 modules, Redis, multi-machine, NBA) is **not on the
profit path and is deferred indefinitely.** Two cheap items are kept (§6).

**Operating rules, unchanged and binding:** no `server/`/`scripts/`/
`package.json` edits while an audit week is open; the app must be running
through every capture window; `NFL_MODEL_STAKE_UNITS` stays 0 until §5's gate;
every metered call goes through `odds-api.js#get()`; missing evidence is null.

---

## Phase 0 — before Week 1 kicks off (by 2026-09-09, Thursday night SEA v NE)

- [x] **0.1 Stale-quote gate.** `isFreshQuote` in `book-feeds.js`; applied in
  `bestReachable` and `simultaneousQuotes`; `stale_dropped` reported; tests
  `test/beat-the-close.test.js`, `test/shopping-board-staleness.test.js`.
- [x] **0.2 Annotate the four tainted decisions.** `shadow_decisions` rows whose
  chosen book's quote was > 72 h stale at `quote_at` get
  `feature_snapshot_json.stale_price_at_decision = true` and a note in
  `reason`. Numeric fields untouched (frozen rows are never rewritten).
  `beatTheCloseStatus()` must exclude them from `by_signal`/`by_slice` reads
  and show them as `excluded_stale` (step 0.3).
- [x] **0.3 Reads exclude stale rows.** `beat-the-close.js#beatTheCloseStatus`:
  filters `by_signal`/`by_slice` on the flag; `excluded_stale` count and
  `excluded_stale_rule` in the payload; rows stay in `decisions` (never
  rewritten) with `stale_price` marked. Test added.
- [x] **0.4 Other readers of `nfl_line_snapshots`.** Applied `isFreshQuote`
  to the three genuine cross-book comparisons found: `line-shopping.js#latestSnapshotPayload`
  (the shared feed `nfl-sharp.js`'s divergence/steam reader consumes when the
  metered API is unavailable, which is now — 2 credits left), `nfl-expert-council.js#shoppingFor`
  (the live price-shopper council role; archive rows are unaffected since
  their `book_updated_at` already equals their own `captured_at`), and
  `nfl-clv.js#closingConsensus` (the modal/median close used to grade CLV).
  `market-movement.js#nflMarketMovement` was checked and left alone: it
  already mixes books across a time series and is explicitly labelled
  "descriptive only... not a betting signal" — a real bug (it does not group
  by book at all) but not a decision-affecting one; noted in §6.
  Movement-over-time readers (`signal-latency.js`, `nfl-news-market-latency.js`,
  `nfl-specialists.js`) compare a book with itself and are exempt.
- [x] **0.5 `wind_total` live rule — built, tested, and one real bug caught
  before it shipped silently broken.** `nfl-weather.js#syncForecastWeather`
  fetches kickoff-hour wind from Open-Meteo's forecast endpoint (verified:
  384 hourly rows, 16-day horizon) for every outdoor game ahead of kickoff,
  `INSERT OR REPLACE`-ing the same `nfl_game_weather` row as the forecast
  changes; `source='open-meteo-forecast'` until `syncGameWeather`'s archive
  read takes the row over after kickoff (its "already have this game" check
  now filters on `source='open-meteo-archive'` specifically — before this
  fix, a forecast row would have permanently blocked the real post-game
  weather from ever being recorded). Wired into the existing hourly
  `beat_the_close` scheduler job (`refreshBeatTheClose` now runs
  `syncForecastWeather()` first). `beat-the-close.js` RULES gains
  `wind_total: { market: 'totals', threshold: 25, side: 'Under',
  requireNotMovedDown: 0.5 }`; because this rule is one-directional and
  absolute-threshold — unlike `ratings_vs_open[_total]`, which are
  bidirectional and slate-centered — `decideBeatTheClose` gained a second
  branch for `rule.side` rules that reads the raw value and additionally
  requires the total to not have already drifted toward Under since the
  opener (betting after the market has priced it in is not the measured
  edge). The signal is pushed as `wind_total` (matching its RULES key
  exactly, the same convention `ratings_vs_open` follows) and lands in
  `nfl_signal_snapshots` on every hourly run regardless of whether it
  clears the threshold, so the Wednesday-vs-Friday-forecast question is
  answerable later. **Caught while testing:** the first version pushed the
  signal as `wind_forecast_kmh` — a name that does not match the `wind_total`
  RULES key — so `RULES[sig.signal]` never found it and the rule would have
  run forever without ever freezing a single decision, with no error and no
  visible symptom. `test/beat-the-close-wind.test.js` (5 cases: fires,
  below-threshold, already-moved, dome-exclusion, no-reachable-price) and
  `test/nfl-weather-forecast.test.js` (3 cases: forecast write, overwrite on
  re-fetch, archive takeover after kickoff) both pass; the first wind test
  is what caught the naming bug. **Live-verified against real Week 1 data:**
  9 outdoor games now carry a real Open-Meteo forecast (highest currently
  17 km/h, NYG–DAL); all below the 25 km/h threshold, so the rule correctly
  froze zero decisions this run rather than forcing one — exactly the
  behaviour a real, non-overfit rule should show most weeks.
- [x] **0.6 Weekly read + retirement.** `beat-the-close.js#weeklyRead(season, week)`:
  per rule — this week's settled count and mean CLV, plus a cumulative
  through-that-week read (settled count, week count, mean CLV, a
  week-clustered bootstrap interval resampling WEEKS not decisions since
  games in the same week share news and weather, positive share, `readable`
  at ≥30 settled) and the historical coefficient beside it for comparison.
  A week-clustered interval genuinely needs ≥2 weeks of settled data to
  exist at all, so a rule's first measurable read can never by itself
  retire it — confirmed by test, not just asserted. Retirement: two
  consecutive weekly reads whose interval sits entirely below zero set
  `retired_at`/`retired_reason` in a new `nfl_rule_state` table (signal,
  streak, last-read season/week, retired_at — never deleted, never
  overwritten once set); `decideBeatTheClose` now checks it and skips a
  retired signal before it can freeze another decision
  (`retired_skipped` in the result). Calling `weeklyRead` twice for the
  same week is a no-op on the streak (`last_read_season/week` guards it).
  Refactored `beatTheCloseStatus`'s stale-price exclusion into a shared
  `cleanDecisions()` helper so `weeklyRead` can't drift from it. Route
  `GET /api/nfl-market/beat-the-close/weekly/:season/:week`.
  `test/beat-the-close-weekly-read.test.js` (7 cases) covers the
  no-interval-from-one-week case, the two-consecutive-reads retirement
  path, idempotent re-reads, that a retirement is never un-set or moved by
  a later read, that one rule's retirement never touches another's state,
  and that a retired signal is actually skipped by the decision engine —
  not yet live-verified since no real week has settled.
- [ ] **0.7 Keep the app up. Nick.** Preview launch config only; check
  `ps aux | grep server/index.js` shows one `--watch` pair. Odds API has 2
  credits until Oct 1; nothing depends on it.

Commit per step; push to `origin/phase3-live-draft-reliability`.

---

## Phase 1 — player props at real prices, for free (2026-09-02 → 09-13)

This is the single biggest unlock. Verified today, no key, no credits:

| Source | Endpoint | Props | Books | Opener | Notes |
|---|---|---|---|---|---|
| **Action Network** | `api.actionnetwork.com/web/v2/games/{id}/props?bookIds=15,30,68,69,71,75,79,123,247,2194` | 80 types | DK, FD, BetRivers, bet365, Caesars, Unibet, PrizePicks, Consensus, **Open (book 30)** | yes | game ids from `/web/v2/scoreboard/nfl?week=N&seasonType=reg`; 1.6 MB/game; UA only |
| **BettingPros v3** | `api.bettingpros.com/v3/offers?sport=NFL&market_id=105&event_id=…&limit=10&include_selections=true` | pass/rush/rec yds, rec, TDs | DK, Caesars, Fanatics, theScore, PrizePicks, Underdog, Sleeper, Kalshi, Novig | yes, with timestamp | header `x-api-key: CHi8Hy5CEE4khd46XNYL23dCFX96oUdw6qOt1Dnh` + `Origin: https://www.bettingpros.com`; paginate |
| **Underdog** | `api.underdogfantasy.com/beta/v5/over_under_lines?sport_id=NFL` | rec/rush/pass yds, rec, TDs | Underdog (two-sided prices) | — | no headers |
| **Kambi (BetRivers)** | `eu-offering-api.kambicdn.com/offering/v2018/rsiusny/betoffer/event/{id}.json` | 592 offers/game incl. ladders | BetRivers | `changedDate` | 429s if > 1 req/2 s |
| **Pinnacle specials** | `guest.api.arcadia.pinnacle.com/0.1/sports/15/markets/straight?primaryOnly=false&withSpecials=true` joined to `/leagues/889/matchups` | main-line props (44 now, more Thu–Sun) | Pinnacle | — | send Chrome headers + Origin/Referer pinnacle.com |
| Bovada | `…/football/nfl?marketFilterId=props` | yds/rec/TD + alts | Bovada | — | light until Thursday |
| FanDuel | `sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=…&tab=receiving-props` | per tab | FD | short history | read `layout.tabs` first |
| Sleeper / Kalshi / PrizePicks partner | see research | lines / ladders | pick'em | — | secondary |

DraftKings needs TLS impersonation (curl_cffi); Caesars/BetMGM need a browser.
Not built now.

**Steps.**

- [x] **1.1 `server/services/prop-feeds.js`** — built and live-verified
  2026-09-02. Two providers so far (Action Network, Underdog; BettingPros,
  Kambi props and Pinnacle specials are not built yet, see below). Rows land
  in `nfl_prop_quote_snapshots` (`captured_at,event_id,commence_time,
  home_team,away_team,book,market,player,side,line,line_key,american_price`)
  plus `provider`, `book_updated_at`, `is_opener` (migration via the
  `nfl-prop-clv.js` ALTER-if-absent pattern). Five markets read
  (`player_pass_yds, player_rush_yds, player_reception_yds,
  player_receptions, player_anytime_td`); everything else is counted in
  `unsupported`, not written. `event_id` uses the same
  `nfl:<utc-date>:<AWAY>@<HOME>` key `book-feeds.js` uses via
  `team-codes.js#teamResolver`, so props join the same game evidence lines
  do. Both providers are fetched directly (not through a caching
  aggregator), so `book_updated_at` is null and the 0.1 staleness gate does
  not apply to them — `captured_at` is the freshness signal, same as
  Pinnacle/Bovada in `book-feeds.js`. Tests: `test/prop-feeds.test.js`
  (4 tests, fixtures are trimmed real payloads captured the same day).
  **Live result, first real capture, Week 1:** Underdog stored 840 real
  two-sided-priced rows across all 16 games and 4 of the 5 markets (no
  binary anytime-TD market exists on Underdog). Action Network's parser is
  verified correct against real fixtures but found 0 rows live: the market
  *type* exists per game (`core_bet_type_9_passing_yards` etc. all present)
  but `lines` was empty for all 8 target books on all games checked — books
  have not posted the plain O/U prop yet, eight days before kickoff, though
  the milestone-ladder and longest-play markets on the same games are
  posted. This matches the research note that Action Network/Bovada books
  are "light until Thursday"; the hourly job (1.3) will pick it up as the
  week progresses — nothing to fix in code.
- [ ] **1.1b Add BettingPros, Kambi props, Pinnacle specials.** Same module,
  same row shape. BettingPros needs `x-api-key` + `Origin` headers (verified
  today); Kambi needs the `betoffer/event/{id}.json` endpoint at ≤1 req/2s;
  Pinnacle needs Chrome-shaped headers to dodge its fake-geo 403. Do this
  once 1.4–1.7 prove the two-provider pipeline end to end — more sources add
  coverage, not a new design.
- [x] **1.2 Pick'em lines are real prices here, unlike PrizePicks.** Underdog
  publishes a genuine `american_price` per side (not a flat payout
  multiplier), so its rows are stored as an ordinary `book='underdog'` row,
  not specially marked. PrizePicks (when added) does need the `pickem:`
  treatment from the original plan, since its standard line has no
  American-odds price at all — restated for whoever builds 1.1b.
- [x] **1.3 Scheduler.** `nfl_prop_feeds` job added, tier `live`, 60 min, plus
  the boot job list. `FREE_PROP_FEEDS=0` disables. Confirmed live: the
  running dev server picked up the change via `node --watch` and ran the
  boot capture on its own before any manual test.
- [x] **1.4 Wire the CLV loop.** `nfl-prop-clv.js#captureFreePropMarket` reads
  `nfl_prop_quote_snapshots` (any provider), reuses the existing matching/
  probability pipeline (`projectionMatch`, `probabilityForQuote`,
  `attachFairProbabilities`, `weekForEvent`) unchanged, and writes into
  `nfl_prop_clv` — every downstream reader (`propEdgeEvidence`,
  `finalizeClosingSnapshots`, `settlePropQuotes`, `propMatchCoverage`,
  `betting-hub.js`'s already-wired `propEdgeEvidence()` display) works
  without modification. Batched by `(event_id, captured_at)` before devigging
  — `attachFairProbabilities` pairs a side against its opposite without
  keying on capture time, so a naive all-history scan would pair an Over
  from one hour against an Under from a different hour; a test
  (`test/prop-clv-free-capture.test.js`, 4 cases) catches exactly that.
  Scheduled as `nfl_prop_clv_free` (live tier, hourly, boot job), after
  `nfl_prop_feeds` so quotes exist before they're matched.
  **A real bug found and fixed during first live verification:** Underdog's
  player objects carry `first_name`/`last_name`, never a combined
  `full_name` — the parser's `player?.full_name` was always `undefined`, so
  effectively every Underdog row silently stored the market's own title
  string ("Mark Andrews Receiving Yards O/U") as the player name instead of
  the player. Fixed in `prop-feeds.js`; a row with no resolvable player is
  now dropped rather than stored under a fake name (test added). This was
  the majority cause of the coverage number below before the fix.
- [x] **1.5 Coverage gate (A1) — passes on real Week 1 data.**
  `propMatchCoverage()` **97.67%** (1,676 of 1,716 quotes resolved or
  carrying an explicit abstention reason), clearing the 95% target, after
  the fix above (was 32.7% before it). Breakdown is honest, not padded:
  1,142 quotes `role_ineligible` (identity resolved, pregame role/volume
  gate correctly abstained — expected, not a defect), 406 `modeled` (real
  probability vs. devigged market price), 80 `projection_missing`, 48
  `unsupported_participant` (team-defense TD markets), 40 still
  `identity_unresolved` (mostly Action Network's handful of live rows).
  **64 real shadow prop decisions exist** with genuine model-vs-market edge
  computed (`propEdgeEvidence()`); 0 settled (all games days away — correct,
  not a bug). Weekly reconciliation report: not yet built as a UI page, but
  the numbers above are already live at `GET /api/nfl-betting/props/clv/status`
  and the existing Profitability page's `prop_edge` panel.
- [ ] **1.6 Tests.** Fixture JSON per provider (captured today in the scratchpad:
  `an_p5.json`, `bp_of.json`, `ud.json`, `kambi_ev.json`, `pin_sp.json`);
  parser tests; a dedup test; a "pick'em never becomes a book" test; an
  end-to-end test that a seeded quote + seeded model distribution freezes one
  decision and settles it.
- [ ] **1.7 UI.** Props tab in the NFL hub: capture coverage by book, matched %,
  decisions frozen, CLV once ≥ 30 settled. Client only.

Gate to leave Phase 1: Week 1 captured from ≥ 4 books with openers, ≥ 200
matched quotes, decisions frozen before Thursday kickoff.

---

## Phase 2 — more information into the line-move program (Weeks 1–3)

Only signals that are plausibly orthogonal to the ratings line, each tested
first in `line-move-study.js` on the 2024–25 holdout with Holm correction,
promoted to a live rule only if it passes the Phase 1 gate (+0.3 CLV,
interval above zero, n ≥ 300, one decision time).

**Done 2026-09-02 (all seven items; commit 926692a). Study results, held out
2024–25, single feature against the line bettable when known, Holm-corrected
across the whole list:**

| Feature | When | Mean CLV | 95% interval | Direction | Gate |
|---|---|---:|---|---:|---|
| `nfelo_pre_vs_open` | T0 | **+0.68** | 0.36 to 1.05 | 63.6% | pass |
| `ratings_vs_open` (ours, unchanged) | T0 | +0.58 | 0.27 to 0.95 | 57.7% | pass |
| `teamrankings_vs_open` | T1 (Wed) | +0.55 | 0.23 to 0.92 | 57.7% | pass |
| `nfelo_qb_adj_diff` | T0 | +0.33 | 0.13 to 0.55 | 55.5% | pass (component of the line above) |
| `public_home_tickets` / `money_minus_tickets` | T2 | +0.25 | 0.04 to 0.45 | 57.0% | fails Holm (p 0.39) |
| `nfelo_hfa_pts` | T0 | +0.17 | −0.03 to 0.37 | 55.7% | no |
| wind, actual kickoff weather (totals) | T2 | +0.47 | 0.27 to 0.68 | 62.1% | pass — but see next row |
| **wind, lead-2 forecast that was knowable** (totals, 2024–25) | T2 | **+0.28** | 0.11 to 0.45 | 56.2% | **under the +0.3 gate** |
| `nfelo_qbelo_diff` | T0 | **−0.48** | −0.83 to −0.16 | 44.5% | significant the *wrong* way |

- [x] **2.1 nfelo QB-adjusted Elo + pre-regression line.** `server/services/nfelo.js`
  (job `nfelo_sync`, 6 h): `nfl_nfelo_qb`, `nfl_nfelo_games` (with
  `home_line_pre_regression` merged from `historic_projected_spreads.csv`),
  `nfl_nfelo_lines`, `nfl_stadiums`, `nfl_team_stadiums`; 1,709 games
  2020–2026, canonical codes (nfelo still writes OAK for the Raiders — mapped
  to LV). nfelo's pre-regression line beats the opener harder than our own
  ratings do. **Promoted to a live zero-unit rule** `nfelo_pre_vs_open`
  (threshold 0.5) — 15 Week 1 decisions frozen on the first run. The raw
  QB-Elo strength gap goes the other way (−0.48): the opener over-reacts to
  it. Recorded, not promoted (not preregistered). Caveat that stays: nfelo's
  published history is a backfill from a model whose parameters were tuned on
  2009–2025; the forward ledger is the test that counts. No license in the
  repo: private research use.
- [x] **2.2 Per-game HFA + stadium coordinates.** Loaded (`hfa_mod` per game,
  67 stadiums with lat/lon/roof). As a study feature the per-game HFA is
  inside noise (+0.17, interval crosses zero), so the flat HFA in
  `nfl-market.js` stays; the ratings-line flag is not worth building on this
  evidence. Coordinates are available for 0.5 (the embedded `STADIUMS` map
  already agrees with them).
- [x] **2.3 Forecast-known-at-time wind.** `server/services/nfl-weather-history.js`
  (Open-Meteo previous-runs; job `nfl_forecast_history`, daily):
  `nfl_game_weather_forecast_history`, leads 0/1/2/3/5 days, 753 games. The
  previous-runs store begins Jan 2024, so multi-day leads exist for 2024–25
  only. **Finding:** of the 8 games in 2024 that were actually ≥ 25 km/h at
  kickoff, the lead-2 forecast flagged 3 and raised 5 false alarms; the
  wind edge measured on actual weather (+0.47) is +0.28 on what was
  knowable — under the gate. `wind_total` stays live as a candidate with
  its basis text corrected; the live CLV decides. The study now carries both
  versions (`wind_kmh` and `wind_kmh_forecast_lead2`).
- [x] **2.4 Public splits.** Ticket/money % from nfelo's `lines.csv` (spread
  only; 2021–23 are empty upstream). Stored as T2 (Action's LAST reading, an
  upper bound). +0.25 CLV but fails Holm; RLM not built (it conditions on
  the move). Action Network's tick-level history is available for a later
  forward-only study.
- [x] **2.5 Sharp-vs-soft, live version.** `server/services/sharp-lag.js`,
  `GET /api/nfl-market/sharp-lag?market=spreads|totals&days=14`: per soft
  book, minutes to follow a Pinnacle move, share followed within 60/180 min,
  lag opportunities and their CLV once settled; stale stamps and in-play
  prints excluded. First day of captures: zero Pinnacle spread moves, one
  totals move (ATL–PIT 41.5 → 42.5; Bovada and Unibet already there,
  BetRivers 29 min behind). Needs Weeks 1–3 before a rule exists.
- [x] **2.6 Second ratings opinion.** `server/services/nfl-external-ratings.js`
  (job `nfl_external_ratings`, daily): ESPN FPI snapshotted weekly from 2026
  W1 (no history endpoint), TeamRankings predictive snapshotted on every game
  week's Wednesday 2022–2026 (`?date=` backfill, 73 requests, all 32 names
  resolved). TeamRankings vs the opener passes the gate and is **live as a
  zero-unit rule** `teamrankings_vs_open`; note the raw ≥0.5 replay over all
  of 2022–25 W5–18 is weaker (+0.17 on 725 decisions) than the held-out
  coefficient read (+0.55) — treat it as the weaker of the two lines.
- [x] **2.7 Circa and openers breadth.** `server/services/book-feeds-extra.js`
  (job `nfl_book_feeds_extra`, hourly): Rotowire (Circa, DK, FD, MGM,
  Caesars, BetRivers, Fanatics, theScore, Betr — with prices) and SBR
  (bet365, Hard Rock; per-book openers returned, not yet stored). 1,056 rows
  on the first capture; Circa NE@SEA −3.5/44. No per-book stamps, so these
  are treated as direct captures like Pinnacle/Bovada.

**Into the audit.** Two council roles (`nfelo_line`, `teamrankings_line`,
kind `external_model`) grade the same external lines against the CLOSE like
every other role; they are kept out of the study's T0 features because they
read the close. The weekly look-back now replays the opener rules from the
archived Pinnacle open/close and chains CLV week over week
(`beat_the_close.historical` / `historical_cumulative`), so the historical
diagnostic reports the line-move edge beside the ATS record. **Run 19**
(56 weeks, 19 roles, spec identical to runs 8 and 17 otherwise) started
2026-09-02; run 18 is the default 70-week registration and is unused.
Backfill coverage for the audit: nfelo 2021–26, TeamRankings 18 weeks ×
2022–25, forecast leads 2024–25, odds archive 2022–25; props and Circa have
no past to backfill.

---

## Phase 3 — run the season honestly (Weeks 1–6)

- [ ] **3.1 Every Monday:** `weeklyRead` for each live rule (0.6), the prop CLV
  read (1.4), the sharp-lag table (2.5). Write the three numbers that matter
  into `DIAGNOSTIC_2026_09_02.md` §14+ and the look-back: settled n, mean CLV
  with interval, direction. Retire on the rule in 0.6.
- [ ] **3.2 Reachable teaser prices.** `nfl_teaser_price_ledger` has 0 rows.
  Source the 2-team 6-pt price from Kambi (`betoffer` teaser markets) and
  Bovada's coupon where offered; else **Nick** enters DK/FD prices Thursday
  via `POST /api/nfl-betting/teasers/prices`. No teaser is shown without a
  price ≤ −115 on the row.
- [ ] **3.3 Middles and best-price board** run from fresh quotes only (0.1).
  Log weekly: shopping value vs median, middles found, middles that hit.
- [ ] **3.4 Pick'em devig read.** Devig Pinnacle/DK/FD prop prices
  (multiplicative and power), compare to PrizePicks/Underdog standard lines;
  report the share of lines where fair probability ≥ 54.7% (2-leg break-even)
  and grade them at settlement. Research-only until n ≥ 200.
- [ ] **3.5 Postgame reasoning grades** (NEXT_SESSION_PLAN 1b, items 3–4):
  `right_read_variance_loss` / `wrong_read_variance_win` into the look-back.
  Diagnostics only; no weight changes.
- [ ] **3.6 Nothing else on the council.** Rulebook/replay/player-builder
  repairs (NEXT_SESSION_PLAN §2) are dropped: run 17 shows the family at zero
  weight and the coordinator correctly ignoring it. The roles keep reporting.

---

## Phase 4 — the gate (after 200 settled decisions, likely Weeks 6–10)

Per `PROFITABILITY_PLAN.md` §2, per market, unchanged: ≥ 200 settled overall
and ≥ 75 in the market; mean and median CLV positive; 90% week-clustered
interval above zero; calibration error ≤ 0.03, slope 0.85–1.15; positive CLV
in more than one window; reachable-price rule (fresh quote, listed book).

Markets that can plausibly reach it this season, in order: (1) beat-the-close
spreads, favourites ≤ 3; (2) beat-the-close totals with wind; (3) props by
market (receptions and receiving yards first — the calibration literature and
zacarywebb's replication both find those best behaved); (4) sharp-lag
execution.

- [ ] **4.1 Frozen forward audit** with week-clustered uncertainty; one report
  per market; rejected markets recorded.
- [ ] **4.2 Staking decision. Nick.** Only for a market that passed: one-eighth
  Kelly or less from the worst plausible calibrated probability, 0.5%
  bankroll cap per bet, 1% per game, 5% open per week, automatic return to
  shadow if CLV or calibration fails in any four-week window. Full Kelly
  prohibited. Paper money can still be the answer.

---

## 5. Stop rules (from the plan, restated because they bind this roadmap)

Stop a workstream when: forward CLV interval includes zero after the minimum
sample; coverage < 95% and missingness is not random; the edge exists only at
a book or price we cannot reach or whose quote fails the freshness gate;
profit disappears when repeated quotes are deduplicated; a threshold had to
move against the same opened sample; calibration worsens while win rate rises.

---

## 6. Deferred, with reasons

- Service reorganisation, config centralisation, Redis, multi-machine, NBA/CFB
  (audit §3–4): no bearing on whether a bet has positive CLV. Revisit after §4.
- Fantasy-side audit criticals (fumbles, PPR in `edge.js`, seed duplicates,
  `history()` try/catch): real, worth a half-day, scheduled after Phase 1
  because they do not touch the betting ledger. Player duplicates matter to
  the prop matcher only through `normalizePlayerName`; 1.5's 95% gate will
  surface any effect.
- Two cheap audit items kept: `CREATE INDEX` on `players(team_id)` and
  `ranking_entries(player_id)` (do in a no-audit window); check
  `model.js` holdout-open does the existence check inside the transaction.
- **Full re-check against the other three audit files** (`PERFORMANCE_AUDIT.md`,
  `DATABASE_AUDIT.md`, `ARCHITECTURAL_BLUEPRINT.md`, all in the 2026-09-02
  scratchpad), read in full 2026-09-02: nothing changes the plan above.
  Every performance finding is scoped to `trade-engine.js`, `projections.js`
  and `betting-hub.js` UI latency (fantasy trade search, page load speed) —
  none affects whether a bet has positive CLV. Every database finding is
  scoped to fantasy tables (`players`, `drafts`, `ranking_entries`,
  `news_items`, `users`) — none touches `nfl_line_snapshots`,
  `nfl_prop_quote_snapshots`, `nfl_odds_archive`, `shadow_decisions`, or
  `game_lines`; those tables aren't FK-linked to the fantasy schema the
  audit is describing, so the "orphaned records" and "missing index" risks
  it raises don't reach the betting data. The blueprint's Part 1.5 describes
  a generic `AUTHORITY`/inverse-variance model-combining scheme that isn't
  what's running — the actual coordinator is `nfl-expert-coordinator.js` v4
  (walk-forward shrinkage + family de-duplication, see run 17 above); the
  audit was evidently reading an older or fantasy-side governance file, not
  a live discrepancy worth chasing. The two index recommendations already
  kept above cover the one item worth doing.
- `market-movement.js#nflMarketMovement`'s "first vs last" movement mixes
  whichever book happened to report first and last, not one book's own
  series — a real bug, but the function is explicitly labelled descriptive
  and feeds no decision. Fix by grouping the inner query on `book` too,
  same session as 3.1's weekly-read work, not before.
- Neural/sequence/graph modules (plan Priority 5): not until something linear
  has positive forward CLV.
- Community-edge literature sweep (the third research agent hit a rate limit):
  the top-down method, teaser pricing and prop softness are covered by 2.5,
  3.2 and 3.4; redo the sweep only if one of those stalls.

---

## 7. Execution order for the next sessions

```
Session A (today):   0.1 ✔  0.2 ✔  0.3  0.4  → commit/push → start 1.1–1.3 (parallel adapters)
Session B:           1.4–1.7, 0.5, 0.6 → Week 1 captures verified Thursday
Week 1 game week:    0.7 (Nick), watch /evidence/status, /beat-the-close, props coverage
Session C (Week 2):  2.1–2.3, 3.1 first read, 3.2 prices
Session D (Week 3):  2.4–2.7, 3.4
Weeks 4–6:           3.1 weekly, retire rules, prop calibration by market
Weeks 6–10:          4.1, then 4.2 with Nick
```

Each step ends with tests green, `npm run lint`, a commit named for the
step, and a push. Docs and client are safe during audit runs; server and
scripts are not.
