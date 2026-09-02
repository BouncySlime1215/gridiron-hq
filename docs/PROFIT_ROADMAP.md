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
- [ ] **0.5 `wind_total` live rule.** `nfl-weather.js`: add
  `forecastKickoffWind(season, week, home)` from
  `https://api.open-meteo.com/v1/forecast?latitude&longitude&hourly=wind_speed_10m,wind_gusts_10m,precipitation&forecast_days=16`
  (verified: 384 hourly rows, 16 days) using `STADIUMS`; store in
  `nfl_game_weather` with `source='open-meteo-forecast'` and `forecast_at`.
  `beat-the-close.js` RULES gains `wind_total: { market: 'totals',
  threshold_kmh: 25, side: 'Under' }` — fires when the forecast for the
  kickoff hour ≥ 25 km/h, the game is outdoor (`STADIUMS` roof), and
  Pinnacle's total has not moved down ≥ 0.5 from the opener. Snapshot the
  forecast value in `nfl_signal_snapshots` (`signal='wind_forecast_kmh'`) at
  every hourly run so the Friday-forecast-vs-actual question is answerable.
  Test with a seeded forecast. Job: existing `beat_the_close` hourly.
- [ ] **0.6 Weekly read + retirement.** `beat-the-close.js#weeklyRead(season, week)`:
  per signal — settled, mean CLV, week-clustered bootstrap interval, direction,
  positive share, the historical coefficient beside it; writes into the
  look-back `reads`. Retirement: two consecutive weeks with the interval below
  zero set `RULES[x].retired_at` in a new `nfl_rule_state` table (recorded,
  never deleted). Route `GET /api/nfl-market/beat-the-close/weekly/:season/:week`.
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

- [ ] **1.1 `server/services/prop-feeds.js`** — mirror of `book-feeds.js`: one
  parser per provider (`parseActionNetwork`, `parseBettingPros`,
  `parseUnderdog`, `parseKambiProps`, `parsePinnacleSpecials`), each returning
  rows in the `nfl_prop_quote_snapshots` shape
  (`captured_at,event_id,commence_time,home_team,away_team,book,market,player,side,line,line_key,american_price`)
  plus `provider`, `book_updated_at`, `is_opener`. Market names map onto
  `PROP_MARKETS` (`player_pass_yds, player_rush_yds, player_reception_yds,
  player_receptions, player_anytime_td`); unsupported types are counted, not
  written. Player names go through `player-identity.js#normalizePlayerName`.
  Event keys through `team-codes.js#teamResolver`, same
  `nfl:<utc-date>:<AWAY>@<HOME>` key as the line feeds. A book present in two
  feeds is kept from the more direct one (Kambi over Action Network for
  BetRivers). Each provider isolated; a shape change reports `events: 0` with
  the error. Migration: add `provider`, `book_updated_at`, `is_opener` columns
  to `nfl_prop_quote_snapshots` if absent (pattern from `nfl-prop-clv.js`).
- [ ] **1.2 Pick'em lines are not prices.** PrizePicks standard lines and
  Underdog/Sleeper multipliers are stored with `book` prefixed `pickem:` and
  `american_price` derived only where a two-sided price exists; otherwise
  null. They never enter CLV as a "book"; they are a separate market to be
  devigged against (§3.4).
- [ ] **1.3 Scheduler.** `nfl_prop_feeds` job, tier `live`, 60 min, plus at every
  evidence-daemon NFL window; boot job. `FREE_PROP_FEEDS=0` disables.
- [ ] **1.4 Wire the CLV loop.** `nfl-prop-clv.js` currently imports
  `playerProps` from `odds-api.js`; make its capture read
  `nfl_prop_quote_snapshots` regardless of provider, run
  `reconcilePropQuoteMatches` (already in code) per capture, and freeze one
  deduplicated shadow decision per event/player/market when
  `|model − devigged market| ≥ threshold` under policy
  `nfl-prop-shadow-2026.1` (frozen; a threshold change needs a version bump).
  Closing quote = the last pre-kickoff quote at the same book; CLV in cents
  and in probability against Pinnacle's prop where it exists, else the
  consensus. Settlement from `nfl-pbp.js#playerWeeks`.
- [ ] **1.5 Coverage gate (A1).** `propMatchCoverage` ≥ 95% of supported-market
  quotes matched or carrying an explicit abstention reason before any read.
  Weekly reconciliation report on the Profitability page.
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

- [ ] **2.1 nfelo QB-adjusted Elo** (replaces the retired 538 file).
  `raw.githubusercontent.com/greerreNFL/nfeloqb/main/qb_elos.csv` — 538 schema
  through 2026 W1, maintained. Loader `server/services/nfelo.js` (daily job,
  growth tier), tables `nfl_nfelo_qb`, `nfl_nfelo_games`
  (`output_data/nfelo_games.csv`: `home_538_qb_adj`, `nfelo_dif_base`,
  `home_line_pre_regression` from `historic_projected_spreads.csv` — use the
  PRE-regression line or you re-measure the opener). Study features:
  `qb_adj_diff`, `nfelo_pre_vs_open`. No license in the repo: private research
  use only, note it.
- [ ] **2.2 Per-game HFA + stadium coordinates.** `greerreNFL/nfelohfa/main/estimated_hfa.csv`
  and `greerreNFL/Stadiums/main/data/stadiums.csv` (lat/lon/roof/tz keyed to
  nflverse `stadium_id`). Replace the flat HFA in the ratings line
  (`nfl-market.js`) behind a flag; compare walk-forward RMSE and the
  ratings_vs_open CLV with and without. Use the coordinates for 0.5.
- [ ] **2.3 Forecast-known-at-time wind.** Open-Meteo
  `historical-forecast-api.open-meteo.com` and `previous-runs-api` give what
  the forecast WAS N days before kickoff. Rebuild the wind study with the
  Wednesday and Friday forecasts instead of the actual weather; that is the
  honest version of §0 item 2 and sets the live threshold.
- [ ] **2.4 Public splits.** `greerreNFL/nfelomarket_data/main/Data/lines.csv`
  (ticket % and money %, ~7k games) and Action Network
  `/web/v2/markets/event/{id}/history` (tick-level line history) → study
  features `public_side_pct`, `rlm` (line moved against ≥ 65% tickets).
  Interaction with the ratings sign.
- [ ] **2.5 Sharp-vs-soft, live version (NEXT_SESSION_PLAN 3a).** With hourly
  per-book quotes and `book_updated_at`, measure per soft book: minutes to
  follow a Pinnacle move, and the CLV of taking the soft book's number when
  it lags Pinnacle by ≥ 0.5 with a fresh stamp. Report by book in
  `/api/nfl-market/sharp-lag`. This is the top-down method; it needs Week
  1–3 data before a rule exists.
- [ ] **2.6 Second ratings opinion.** ESPN FPI
  (`site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex`) and
  TeamRankings predictive (`?date=` gives history) as `fpi_vs_open`; value is
  disagreement with our ratings, not a new line. Cheapest item; do last.
- [ ] **2.7 Circa and openers breadth.** Rotowire
  `rotowire.com/betting/nfl/tables/nfl-games.php?week=N` (10 books incl.
  `circasports_*`) and SBR `_next/data/{buildId}/…/full-game.json` (8 books
  with `openingLine`). Into `nfl_line_snapshots` via `book-feeds.js`, with
  stamps where given.

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
