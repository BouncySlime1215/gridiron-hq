# Open-source sweep: projections, ensembles, draft strategy, platforms, data, agents, betting

Researched 2026-09-07; stars/last-push from the GitHub API that day, endpoints called live.
Deliberately **not** covered: the ESPN draft-room protocol (`RESEARCH_ADOPTABLE_CODE.md`) and UI
patterns (`RESEARCH_UI_PATTERNS.md`) — both closed.

Licence convention: **no LICENSE file = unusable, paraphrase only**; **GPL = may run it and use
its output, may not vendor the code.**

---

## 1. Season-long projections with reported accuracy

| Source | ★ | Last push | Licence | Reported result | Honest call |
|---|---|---|---|---|---|
| [FFA accuracy study](https://fantasyfootballanalytics.net/which-projections-are-most-accurate) | — | May 2026 | article | 2014–25, 11 sources, MAE/R²/ME per position | Best find here. Numbers below. |
| [mattgilgo/fantasy_football](https://github.com/mattgilgo/fantasy_football) | 0 | 2026-05-06 | GPL-3.0 | Beats experts at QB/WR/TE in **2022** (WR 47.3 vs 59.5) | One season, one direction, no CI, no walk-forward. Not evidence. |
| [dlm1223/fantasy-football-optimization](https://github.com/dlm1223/fantasy-football-optimization) | 10 | 2019-07-10 | **none** | "outside ranks have similar predictive accuracy to ADP.Rank" | Dead 7 yrs, unlicensed — but independently corroborates `PRESEASON_MODEL.md`. |
| [cbratkovics/fantasy-football-ai](https://github.com/cbratkovics/fantasy-football-ai) | 15 | 2025-08-21 | MIT | "93.1% accuracy (within 3 pts)", RMSE 2.31, CV R² 0.847 | RMSE 2.31 on weekly points is unattainable; no split stated. Leaked or mis-scoped. Ignore. |
| PFF · Sports Info Solutions · FTN OL | — | — | **paid** | grades, charting, OL ranks | No free tier, no API, no licence-clean scrape. ESPN's Pass Block Win Rate exists only inside feature articles. |

**The FFA study is the headline.** Best MAE 2014–25: QB 61.0 / WR 40.2 / TE 31.4 (FantasyPros),
RB 52.2 (CBS). The FFA *ensemble* was never best anywhere, yet won **69% of head-to-head
comparisons** (mean rank 4.2/11). Same verdict as ours from the other side: aggregation buys
consistency, not a win.

**Features we lack, priced.** PFF/SIS/FTN: paid, full stop. Referees and weather: free (§5).
OC/scheme history: no free feed (known gap). Two are **derivable today from data already in the
DB** — a target-competition index from `off_player_season_features`, and an OL proxy from
`off_pfr_adv_season` pass (pressure rate) + `off_ngs_season` passing (`avg_time_to_throw`),
neither yet aggregated to team level.

**Adopt first:** OL proxy + target-competition index, **~4 h**. Expected held-out impact:
**probably zero** — §9 of `OFFSEASON_MODEL.md` tested 39 variables and adopted none. Do it for
better drivers text.

---

## 2. Weekly ensembles and DFS feature engineering

| Repo | ★ | Last push | Licence | What / adoptable | Honest call |
|---|---|---|---|---|---|
| [FantasyFootballAnalytics/ffanalytics](https://github.com/FantasyFootballAnalytics/ffanalytics) | 190 | **2026-08-31** | **GPL** | 13 seasonal / 11 weekly public sources, imputed and weighted | Alive (recent commits: "prep for 2026", CSS→XPath). That migration is the warning — scrapers break yearly. |
| [chanzer0/NFL-DFS-Tools](https://github.com/chanzer0/NFL-DFS-Tools) | 49 | 2025-09-04 | **none** | GPP Monte Carlo | **Best modelling idea in the sweep** — below. |
| [ffverse/ffsimulator](https://github.com/ffverse/ffsimulator) | 22 | 2024-10-03 | MIT-ish | Bootstrap-resamples historical weekly ranks into seasons | Dormant 2 yrs, R-only, needs `ffscrapr`. Method is the value. |
| [DimaKudosh/pydfs-lineup-optimizer](https://github.com/DimaKudosh/pydfs-lineup-optimizer) (447★, MIT) · [BenBrostoff/draftfast](https://github.com/BenBrostoff/draftfast) (298★, **none**) | | 2024/2026 | | MILP lineup solvers | Solver plumbing. Nothing transfers to redraft. |
| [cjpearson/ffanalytics](https://github.com/cjpearson/ffanalytics) | 0 | 2019 | none | fork | Dead. Search surfaces it; ignore. |

**chanzer0 is the one to read.** It fits **empirical skewed families** (gamma, lognormal, Weibull,
skew-normal, ex-Gaussian) per position × projection-level window, affine-transforms each to a
player's mean/sd, and imposes correlation via a **Gaussian copula + Iman–Conover rank
reordering**, with a calibrated-gamma tail fallback. No ROI reported, no licence — reimplement the
pattern, don't lift the code.

**Why it matters.** `preseason-model.js` publishes a p20/p80 band; `draft-lookahead.js` runs 200
sims × 6 candidates. If those draws are independent and symmetric, both are mis-shaped: season
totals are right-skewed and a QB correlates with his own WR1. Skewed marginals plus a positional
correlation matrix is the only idea found today that could change a *decision* rather than a point
estimate. Adopt as (a) empirical p20/p50/p80 by position × market-rank bucket from the 2021-25
panel the curve already uses — **6 h**; (b) a QB↔pass-catcher correlation term in the lookahead
draws — **8 h**. MAE impact: **none by construction**. Lookahead impact: real but unmeasured —
gate by re-running the 2021-25 draft audit both ways.

**ffanalytics is GPL and R — do not vendor.** Clean route: a nightly R subprocess emitting a CSV
of the ~10-source consensus, read as one more source beside ESPN. Honest expectation, per the FFA
study: consistency, not edge.

---

## 3. Draft strategy, dynamic VBD, Monte Carlo simulators

| Repo | ★ | Last push | Licence | Validates a strategy? |
|---|---|---|---|---|
| [dlm1223/fantasy-football-optimization](https://github.com/dlm1223/fantasy-football-optimization) | 10 | 2019 | none | Closest: 2,000 sims/strategy over 2008–18 projection-error bins. Strategies land within 10–20 pts; Zero-RB > Zero-WR; skipping a backup QB is costly. **No CI.** |
| [faverogian/nfl-fantasim](https://github.com/faverogian/nfl-fantasim) | 1 | 2024-08-10 | MIT | **No.** RB_HEAVY 1740.8 vs BPA 1687.0, 1,000 sims, **one season, no p-value**. A 54-pt gap on 2023 alone is noise. Don't cite. |
| [joewlos/…draft_simulator](https://github.com/joewlos/fantasy_football_monte_carlo_draft_simulator) (11★, MIT) · [famendola1/Fantasy-Football-VBD](https://github.com/famendola1/Fantasy-Football-VBD) | | 2024 / old | | No. A draft-room UI, and static VBD with a fixed baseline — strictly weaker than `draft-assist.js`'s expected-replacement survival model. |

**Nobody public has done what `DRAFT_AUDIT_2021_2025.md` did.** Every simulator grades strategies
against *projections* or *resampled projection error*, never against real drafts with real ADP and
real finishes. RB-over-WR at 13–36 (t=3.4) and the rookie-WR premium have no open-source
equivalent. **This section yields no adoption**; its one transferable idea (error-bin resampling)
is superseded by §2.

---

## 4. Other platform integrations

| Repo | ★ | Last push | Licence | Honest call |
|---|---|---|---|---|
| [whatadewitt/yahoo-fantasy-sports-api](https://github.com/whatadewitt/yahoo-fantasy-sports-api) | 227 | 2026-08-06 | MIT | The only serious **JS** Yahoo client; covers `draft_results`. **npm is stale (2024-04) vs repo — vendor from git.** |
| [dtsong/sleeper-api-wrapper](https://github.com/dtsong/sleeper-api-wrapper) | 101 | 2026-09-03 | MIT | Alive, but `base_api.py` is `requests.get` + `raise_for_status`. Read it as an endpoint list; don't port. |
| [uberfastman/yfpy](https://github.com/uberfastman/yfpy) | 263 | 2026-04-21 | **GPL-3.0** | Best-documented Yahoo wrapper. Reference only — do not vendor. |
| [ffverse/ffscrapr](https://github.com/ffverse/ffscrapr) | 94 | **2024-11-01** | MIT-ish | Dormant ~22 mo. Copy the `ff_connect()` → `ff_league/ff_rosters/ff_draft` shape; the R code doesn't port. |
| [joeyagreco/leeger](https://github.com/joeyagreco/leeger) | 86 | 2024-12-25 | MIT | Dead ~21 mo, but proves 5-platform normalisation is tractable and shows the seams. |
| [mkreiser/ESPN-Fantasy-Football-API](https://github.com/mkreiser/ESPN-Fantasy-Football-API) | 351 | 2025-01-04 | LGPL-3.0 | ~20 mo stale and strictly behind us. Skip. |

**Sleeper needs no WebSocket — verified live.** A code search for `ws.sleeper.app` returns one
hit, in a markdown file. `GET /v1/draft/{id}/picks`, unauthenticated, against a real 2026 draft
(`draft_id 1368354515882889216`) returned all 180 picks, each self-contained (`pick_no`, `round`,
`draft_slot`, `roster_id`, `picked_by`, plus name/position/team/injury in `metadata` — **no
player-dictionary join needed**). Unlike ESPN's REST it reflects true state mid-draft, mock rooms
included. **A 3–6 s poll loop is the complete implementation.** Gotchas: autopick rows can carry
`roster_id: null` / `picked_by: ""` — resolve identity via `draft_slot` → `slot_to_roster_id`;
unmade picks are simply absent (no `-1` placeholder).

Yahoo is documented but **OAuth2 three-legged only** (unauthenticated `game/nfl` → 401), with
XML-shaped numeric-keyed JSON; its `draftresults` returns picks-so-far mid-draft, so Yahoo is a
slower *polling* target, not a socket. MFL is fully open (`.../2026/export?TYPE=players&JSON=1` →
200, no key); Fleaflicker's undocumented API is live and needs no auth. **No JS/TS ffscrapr
analogue exists** — building the adapter in TS fills a gap.

**Adopt first:** Sleeper polling behind an `ff_connect`-shaped adapter, **6–10 h** — the
highest-certainty item here, with zero protocol risk unlike the ESPN bookmarklet.

---

## 5. Data sources not yet catalogued

Verified live 2026-09-07. **Two entries in `OFFSEASON_DATA.md`'s skipped list are now wrong.**

| Asset | Seasons / size | Licence | Why |
|---|---|---|---|
| `pbp_participation` | **2016–2025, alive**; 49 MB/yr | CC-BY-4.0 | NGS stopped after 2022 but nflverse **switched to FTN from 2023**. 2025 fill: `was_pressure` 100%, `defenders_in_box` 100%, `offense_formation` 79.8%, `route` 41.8%, **`ngs_air_yards` 0.0% (dead col)**. Released only after the postseason — no in-season 2026. |
| `pbp` parquet | 1999–2025; **20.3 MB/yr, not 200 MB** | CC-BY-4.0 | **`xpass` and `pass_oe` are already computed columns** (76% non-null, exactly the qualifying plays). PROE = mean `pass_oe` by `posteam`+`season`. DuckDB `read_parquet(url)` with column pruning pulls **1–3 MB/season**. |
| `officials.csv` | 2015–2026; 1.29 MB | CC-BY-4.0 | 22,012 rows, 3,045 games × 7 crew slots, stable `official_id`. Joins to pbp `penalty_type`/`penalty_team`/`penalty_yards`. No maintained repo does this. ~17 games/crew/season → heavy shrinkage. |
| `combine.csv` | 2000–2026; 894 KB | CC-BY-4.0 | forty/bench/vertical/broad/cone/shuttle. **No `gsis_id`** — join via `players.csv` on `pfr_id`. |
| `ftn_charting` | 2022–2025; 556 KB parquet/yr | CC-BY-4.0 | 29 cols (`is_motion`, `is_play_action`, `is_rpo`, `n_blitzers`, `is_drop`…). **Confirms the existing skip: still no player id** — attribution needs `nflverse_play_id` → participation. |
| `players.csv`, `weekly_rosters`, `snap_counts`, `injuries`, `espn_data/qbr_week_level.csv` | various | CC-BY-4.0 | Not ingested. `qbr_week_level` (2.44 MB) and week-level rosters are the cheap ones. |
| [dynastyprocess/data](https://github.com/dynastyprocess/data) `db_playerids.csv` | 2.63 MB, weekly Fri | **GPL-3.0** | **34-col crosswalk: `gsis_id`, `sleeper_id`, `espn_id`, `mfl_id`, `pfr_id`, `fantasypros_id`, `ktc_id`, `pff_id`, `sportradar_id`.** Directly unblocks the open crosswalk fix. |
| DynastyProcess others | — | GPL-3.0 | `db_fpecr.parquet` (38.8 MB — full FantasyPros ECR history; the `.csv.gz` is 104.7 MB, don't), `db_fpecr_latest.csv`, `fp_latest_weekly.csv` (weekly ECR + `start_sit_grade`), `values-players.csv`, `values-picks.csv`. |
| FantasyCalc API | current; 155 KB JSON | **no published licence** | Verified 200, no key, CORS-open; carries `mflId`/`sleeperId`/`espnId`. Cleanest KTC alternative. |
| KeepTradeCut | — | **none granted** | No JSON API; values sit in an inline `var playersArray = [...]` on `/dynasty-rankings`. `robots.txt` allows that path, **disallows `/dynasty-rankings/histories`**. Personal-use scrape at best — and `db_playerids.csv` already has `ktc_id`. |
| Open-Meteo Archive | **1940→yesterday** | CC-BY-4.0, free non-commercial | Verified for 2021-09-12 *and* 2026-09-06 — ERA5T lag is **≤1 day in practice**, not the documented ~5. Hourly temp/wind/gusts/precip/humidity, no key. |
| aussportsbetting NFL xlsx | 2006– | — | **Now Cloudflare-gated: 403 to any script UA (tested today).** Manual download only. |
| The Odds API | 2020-06-06→ | paid | Historical snapshots on all tiers; **player props only after 2023-05-03**. 500 free credits/mo is a trickle, not a backfill. |

Stadium lat/lon for the weather join: `data/stadium_coordinates.csv` (3.2 KB) from
[ThompsonJamesBliss/WeatherData](https://github.com/ThompsonJamesBliss/WeatherData) — repo dead
(2021-10-06, no licence), the coordinate table is the useful part. pbp already carries
`weather`/`temp`/`wind`/`roof`, but 2025 `temp` fill is 66.3% (NA in domes) and `weather` is a
text blob.

**Adopt first:** `db_playerids.csv` (**2 h**), then team-season PROE from pbp parquet (**5 h**) —
closing `OFFSEASON_DATA.md` gap #6, whose cost estimate was wrong by 10×. Expected model impact of
PROE: **modest at best**; the market prices pace too.

---

## 6. LLM / agent-based fantasy assistants

| Repo | ★ | Last push | Licence | Grounding technique |
|---|---|---|---|---|
| [jdguggs10/flaim](https://github.com/jdguggs10/flaim) | 17 | 2026-09-06 | MIT | **Most disciplined artifact found.** `instructions.ts` is a ~900-token anti-hallucination rulebook injected at MCP `initialize`, with *field-specific* rules ("never derive an exact round slot from roster order"; "`percentOwned` is share of all ESPN leagues, not of rostered teams") plus a declared write-boundary. Has `instructions.test.ts`. |
| [derekrbreese/fantasy-football-mcp-public](https://github.com/derekrbreese/fantasy-football-mcp-public) | 74 | 2026-09-06 | MIT | Maths and LLM **separated**: `optimization.py` picks, `llm_enhancement.py` explains. 8 MCP prompt templates + 5 static `guide://` resources. |
| [aryatschand/FantasyFootballBench](https://github.com/aryatschand/FantasyFootballBench) | 0 | 2026-08-25 | **none** | 10 LLM teams draft, start/sit and **negotiate trades agent-to-agent** over a replayed season. Closed-world enumeration (`allowed_names` + "All names MUST be selected from this list"); logs `llm_calls_*.jsonl`. **Flaw: labels `[INJURED]` from that week's actual points — future leakage. Scores are not a clean benchmark.** |
| [GregBaugues/tokenbowl-mcp](https://github.com/GregBaugues/tokenbowl-mcp) | 6 | 2025-12-15 | MIT | 7 Claude Code subagents; `trade.md` is 5-phase (assess → scout all 9 opponents → research → construct). Take the architecture, not its explicit "downplay concerns" manipulation framing. |
| [cfagan17/muffed-mcp](https://github.com/cfagan17/muffed-mcp) | 0 | 2026-08-19 | MIT | One idea worth stealing: every metric returns **value + rank + population + as-of date + a quotable sentence** ("358.16 RYOE, 1st of 49"). |
| [bdwilliams3/ff-rag](https://github.com/bdwilliams3/ff-rag) | 1 | 2026-05-17 | **none** | Only true RAG here. Numbers every chunk `[1] [source season format]`, strict JSON with a `Why` column, "Do not invent stats." |
| [einreke/nflverse-mcp](https://github.com/einreke/nflverse-mcp) | 0 | 2025-05-12 | — | A stub. **Nobody has done nflverse-over-MCP properly.** Open gap. |

**~80% of this space is thin GPT wrappers** — ~15 Sleeper MCP servers and 12 ESPN ones differing
only in endpoint coverage. **They have that we don't:** tool-calling over prompt-stuffing,
field-specific anti-fabrication rules (we say "lead with a number"; nothing forbids inventing
one), opponent modelling, a scoreable decision trace, stat provenance, prompt regression evals.
**We have that none do:** offseason multipliers and preseason drivers as first-class inputs, full
per-candidate season history, dated injury notes fused with dated analyst takes, and a
page-context explain assistant — no repo here grounds explanation in UI state at all.

**Adopt first (all prompt-layer):** closed-world name enumeration with rejection (**1–2 h**);
field-specific negative rules (**2–3 h**); stat provenance envelope (**3–4 h**); JSONL decision
trace scored post-season (**4–6 h** — the only one that makes the advisor walk-forward-gradeable).

---

## 7. Betting / fantasy crossover

| Repo / source | ★ | Last push | Licence | Reported OOS result |
|---|---|---|---|---|
| [greerreNFL/nfelo](https://github.com/greerreNFL/nfelo) | 55 | **2026-09-07** | **none** | **55.09% ATS vs close, +5.85% avg CLV/play, 2009–25**, MAE 10.1, submitted to PredictionTracker |
| [quantgalore/nfl-props](https://github.com/quantgalore/nfl-props) | 5 | 2024 | none | **None.** Source reads `sort_values('timestamp').tail(1)` — the *latest* line, not the close — and never de-vigs. Any edge claim is invalid. |
| [ffverse/ffopportunity](https://github.com/ffverse/ffopportunity) | 23 | 2025-12-11 | GPL-3 | Expected receptions/yards/**TDs** from pbp; **no accuracy published, never market-validated**. Already ingested here. |
| [declanwalpole/sportsbook-odds-scraper](https://github.com/declanwalpole/sportsbook-odds-scraper) | 21 | 2025-04-15 | **none** | DK/MGM/Caesars/Bovada, all markets incl. props. No archive — you poll and concat. |
| [stranger9977/market_implied_fantasy_football](https://github.com/stranger9977/market_implied_fantasy_football) (0★, 2023-12-20) · [RMSummerlin/impliedseasontotals](https://github.com/RMSummerlin/impliedseasontotals) (0★, 2026-08-30) | | | none | The first documents **no conversion method and zero validation** and is abandoned; the second is a 3-hourly implied-totals JSON action — plumbing, no model. |

**nfelo is the only serious precedent, and it argues for restraint.** Its own
[market-regression writeup (2020-11-08)](https://www.nfeloapp.com/analysis/using-market-regression-to-improve-prediction-accuracy-in-the-nfl/)
concludes the optimal blend is **65% market / 35% model** — an independent signal is worth at most
a third, and only behind the market anchor. Caveats: figures are self-reported, the 65/35 weight
was fit in-sample, the site concedes 2024–25 returns are materially degraded, and the repo has no
LICENSE.

**There is no public evidence the fantasy→betting crossover works** — no paper, blog or repo shows
fantasy consensus carrying information beyond the closing total. The literature runs the other
way: DFS practitioners consume Vegas, not the reverse. **`OFFSEASON_MODEL.md` §6's "honest
expected value of that promotion is zero" survives this sweep unchanged.**

Two facts for the gate: nflverse `games.csv` `spread_line`/`total_line` are **closing** lines back
to 1999 ([nfldata DATASETS.md](https://github.com/nflverse/nfldata/blob/master/DATASETS.md)) — a
free 25-season CLV benchmark already ingested. And **no free historical NFL player-prop archive
exists.** Budget for props or don't build them.

**Adopt first:** nothing new. Wire the existing `offseason_team_turnover` contract's CLV test
against `off_schedule_games` closing lines (**4 h**) so the gate can fail *visibly* rather than sit
untested. Expected result: a confirmed null.

---

## Ranked top-10 actions

| # | Action | § | Hrs | Honest expected impact on held-out numbers |
|---|---|---|---|---|
| 1 | Ingest DynastyProcess `db_playerids.csv`; rebuild the id crosswalk on it | 5 | 2 | **High, non-model.** Unblocks the open `gsis_id` fix and every future join. |
| 2 | Closed-world name enumeration + rejection in advisor prompts | 6 | 1–2 | **High for correctness.** Kills the top failure mode. Zero on projections. |
| 3 | Sleeper draft polling behind an `ff_connect`-shaped adapter | 4 | 6–10 | **High certainty, zero protocol risk.** Second platform live; a fallback if the ESPN bookmarklet disappoints. |
| 4 | Field-specific anti-fabrication rules + stat provenance envelope | 6 | 5–7 | Medium. Makes "lead with a number" auditable. |
| 5 | JSONL advisor decision trace, scored post-season | 6 | 4–6 | Zero now; the only path to a gradeable advisor later. |
| 6 | Empirical skewed p20/p50/p80 by position × market-rank bucket | 2 | 6 | **Zero on MAE by construction.** Real on band honesty — totals are right-skewed. |
| 7 | Team-season PROE from `pbp` parquet (`pass_oe`) | 5 | 5 | Low. Do it because the cost estimate was wrong by 10×, not because it will move MAE. |
| 8 | QB↔pass-catcher correlation in `draft-lookahead.js` draws | 2 | 8 | Unmeasured; plausibly real on *candidate ordering*. Gate via the 2021-25 audit both ways. |
| 9 | Team OL proxy + target-competition index from existing columns | 1 | 4 | **Probably zero.** 39 variables already declined. For drivers text. |
| 10 | Kickoff weather from Open-Meteo (stadium lat/lon join) | 5 | 6 | **Low, likely zero for season-long** — a season projection averages weather away. Build it for weekly/betting surfaces or not at all. |

**Explicitly not recommended:** referee tendencies (~17 games/crew/season; shrinkage eats the
signal); `ftn_charting` at play level (no player id — the existing skip was right); KTC scraping
(no licence; `ktc_id` + FantasyCalc cover it); vendoring `ffanalytics` (GPL) or `nfelo`,
`draftfast`, `chanzer0`, `dlm1223`, `quantgalore` (no LICENSE); any props model (no free
historical prop archive); unblocking the fantasy→betting contract.

## Exact assets to ingest next

nflverse base `https://github.com/nflverse/nflverse-data/releases/download/<tag>/<file>` (CC-BY-4.0):
`players/players.csv` (7.3 MB) · `pbp/play_by_play_<YYYY>.parquet` (20.3 MB/yr, prune to
`xpass`/`pass_oe`) · `pbp_participation/pbp_participation_<YYYY>.csv` (2016–2025) ·
`officials/officials.csv` · `combine/combine.csv` (join on `pfr_id`) ·
`weekly_rosters/roster_weekly_<YYYY>.csv` · `snap_counts/snap_counts_<YYYY>.csv` ·
`injuries/injuries_<YYYY>.csv` · `espn_data/qbr_week_level.csv` ·
`ftn_charting/ftn_charting_<YYYY>.parquet` (only alongside participation).

DynastyProcess base `https://raw.githubusercontent.com/dynastyprocess/data/master/files/`
(GPL-3.0, weekly Fri): **`db_playerids.csv`** · `db_fpecr_latest.csv` · `db_fpecr.parquet` ·
`fp_latest_weekly.csv` · `values-players.csv` · `values-picks.csv`.

Keyless live APIs:
`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1` ·
`https://archive-api.open-meteo.com/v1/archive?latitude=<lat>&longitude=<lon>&start_date=<d>&end_date=<d>&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York` ·
`https://api.sleeper.app/v1/draft/{draft_id}` and `/picks` ·
`https://api.myfantasyleague.com/2026/export?TYPE=players&JSON=1` ·
`https://raw.githubusercontent.com/ThompsonJamesBliss/WeatherData/master/data/stadium_coordinates.csv`.

**Still unfixed by this sweep:** the stale contracts feed (nothing free and licence-clean replaces
OverTheCap post-2022), OC/scheme history (no free per-season feed), and free historical player
props. Gaps, not oversights.
