# Gridiron HQ — Fantasy Engine Overhaul: Master Plan

**Status:** approved plan, not yet started. Written 2026-09-17 for execution by Claude agents (Opus / Sonnet).
**Owner:** Nick Matta. **Repo:** `/Users/nick_matta/Documents/GitHub/gridiron-hq`.
**Read this whole document before touching anything.** Every number in it was measured this week, with code, and the acceptance criteria are anchored to those numbers.

---

## 0aa. REVISED PRIORITY ORDER (2026-09-17, after the study ran)

The study is done (`docs/TARGET-SPEC.md`, gate 15/15). It invalidated three things in the order below and exposed one omission. **This section overrides the phase sequence in section 4.**

**What broke:**
1. **Phase 1f (per-stat ML head) was priority one; its ceiling is now measured and small.** Projections beat real managers by ~+0.2 wins/season, and our own replay puts managers at 79% lineup efficiency. Still worth building; no longer first.
2. **Phase 2 (beat ESPN's MAE) is the wrong gate.** The gate is attainable-arm all-play win rate and bench points per week. Accuracy is instrumental.
3. **The projection-before-person ordering is backwards.** Season-long fantasy is ~80% luck at the manager level (R* = 0.19). The football half has a low measured ceiling; the counterparty half does not — a manager reversing 5 of 5 untouchable declarations is not a coin flip.

**What was missing:** waivers. "Live players at week 14" is the strongest documented in-season driver and roughly half of a title roster's value arrives after the draft. It gets a phase.

**Execution order:**

| # | Work | Est. | Gate |
|---|---|---|---|
| 1 | **Availability** — replace `contingency.js`'s hand-set constants with the measured per-team injury dialect (TB "Questionable" = 81% play, PIT = 47%) | 1 h | bench points; starts-of-inactive-players falls |
| 2 | **Opportunity redistribution** (Phase 1b) — vacated targets move when a teammate sits | 2 h | attainable all-play; MAE on affected player-weeks |
| 3 | **Waivers / live players** — NEW. Claim recommendations ranked by win-rate added; live-player count surfaced | 3 h | live players at wk 14 vs league; all-play |
| 4 | **Expected-points anchor + TD regression** (Phase 1c) | 2 h | attainable all-play |
| 5 | **Lineup posture by stage** — floor when favoured, ceiling as underdog or in playoffs; volatility's sign is conditional, so the engine switches rather than averages | 2 h | all-play, and win rate vs the actual opponent |
| 6 | **Counterparty + Coach** (Phases 4–8, largely built) — finish and wire | — | P(accept) calibration; Nick's read of the messages |
| 7 | **ML head** (Phase 1f) — demoted, ceiling known | 2 d | ≥ 0.010 all-play, sign-stable 4/5 seasons |
| 8 | **UI teardown** — remove Players, Command Center, League Brain, Trends, Matchups, The Model, Accuracy & Experiments, Data Health, and all four betting tabs. Backends untouched | 2 h | `npm run build` passes |

Everything below stays valid as specification. Only the order and the gates change.

## 0a. Read first: the target is defined before the model (2026-09-17)

**`docs/WHAT-WINS-STUDY.md`** now precedes every phase below. A five-angle literature review found that season-long fantasy at the manager level is ~80% luck (Cates, R* = 0.19), that good projections beat real managers by only ~+0.2 wins/season, and that the documented in-season edge is keeping live players and capturing value vs market price. So: the study runs first, produces a per-format target spec, and **every gate in Phases 1–9 is re-pointed at attainable-arm all-play win % and bench points instead of MAE.** Availability and live players move to the top; the counterparty layer is the part of the system the luck finding does not touch.

## 0. What this is, in one paragraph

The fantasy trade engine (`server/services/trade-engine.js`, 1,515 lines) is well-built — lineup solver, market value as a separate axis, red flags, sim-verified verdicts — and it is standing on a projection that **loses to a moving average**, valuing both sides of every deal with *our* number instead of the counterparty's. The overhaul has three jobs: (1) make the projection genuinely good by feeding it information it has never seen, (2) model the *ten people Nick actually trades with* rather than the market, and (3) turn that into a trade engine that finds deals people accept, explains them from everything it knows, and coaches what to say. Live news and injury data is a hard prerequisite and it is currently half-broken.

---

## 1. State of the system — measured, not assumed

### 1.1 The projection foundation is cracked

Walk-forward, weeks 5–18, PPR, truth = `player_week_usage`, harness = `server/services/weekly-backtest.js#replaySeasonWeekly`:

```
2025 one-shot MAE   structural (buildProjections) 4.749
                    fixed 60/40 blend (never shipped) 4.455
                    PRODUCTION (frozen 2023 weights) 4.425
                    season_to_date (naive)           4.386
                    ensemble_global (FITTED)          4.334   gate PASS, p=0.999 vs naive
per season 2021–25  structural loses to season_to_date by 2.8–6.2% MAE and on Spearman, every year
```

> **Corrected 2026-09-17.** This table used to label 4.455 "PRODUCTION (frozen 2023 weights)". 4.455 is the harness's fixed 0.6·structural + 0.4·season_to_date blend, which production never ran. The frozen per-position `WEEKLY_ENSEMBLE_WEIGHTS` production actually ran score **4.425** on the same 4,532 rows (2023 4.361, 2024 4.549). The real displacement gain is 0.095, not 0.125. Stored row `weekly_ensemble_fits.id=1` has been corrected to match: `champion_mae` 4.455 → 4.425, and `candidate_mae` 4.33 (in-sample production path) → 4.334 (the gate's held-out figure). Weights unchanged. The gate still passes with the bootstrap clustered by player: vs season_to_date ci90 [−0.083, −0.018], vs the displaced champion [−0.120, −0.062].

- `weekly_ensemble_fits` has **0 rows**, so `activeWeeklyWeightSet()` returns `source:'frozen'`. Production runs weights that lose to a moving average. The validated fit exists (`scripts/fit-weekly-ensemble.mjs`) and was never persisted.
- **All 15 heads in `player-head-registry.js` are reweightings of the player's own FP history** (season_mean, median, trimmed/winsor, ewma×3, trend, level_shift, robust blends). No head carries new information — the same failure the betting ensemble showed at effective rank 2.61.
- `buildProjections` (`projections.js`) reads raw counts from `player_week_usage` and **0 of 67** keys in `nfl_player_week_features`. Efficiency is raw ypt/ypc/td_rate shrunk to a *global* K (td_rate K=70). Production reads the 67-key blob only in `activeDepthRoster` to decide who was active.
- Expected fantasy points (`nfl_ffopportunity_weekly`, 28,596 rows, strictly-prior) reaches `player-week-engine.js:248` as **context only**, not a head.
- **No opportunity redistribution**: when WR1 sits, WR2's projection does not move.
- The Vegas game-script fit (`gamescript.js`) is **r² = 0.026 pass / 0.044 rush** — dead for the mean; possibly alive for the distribution (blowout → garbage time).
- `replayImpl` grades `p.ppg` = structural only unless `predictionHead` (a **function** of the context, not a string) is passed. The stock backtest never measured the blend.

### 1.2 The trade engine is good and mis-anchored

- `evaluate()` prices **both** sides with our `adj_ppg` and `value`. It never asks what the counterparty thinks a player is worth.
- Acceptance is a binary `plausible` flag; `score = managerFactor × fairnessFactor × (my_ppg_delta + 0.2×joint)`. It maximises *my gain*, not `P(accept) × gain`.
- `findTrades`: `maxPerSide=2`, `limit=25`, 11 candidates per roster, 2-step `findTradeSequences` only. No 3-team trades.
- `tradeImpact()` (season-sim) is a paired sim under common random numbers, 1,200 runs, **~4.7 s per call**, almost all fixed overhead (asset universe + projection build). Share the build → ~1 s/candidate.
- `trade-explain` gives Claude: evidence lines, career record, floor/ceiling, injury flag, playoff SOS, title-odds delta. It does **not** see news signals, counterparty profile, chat sentiment, matchup/coverage, xFP regression, or stated valuations.
- `manager_profiles`: 0 rows. `espn_player_market` (ADP, rank, %owned, ESPN proj): 0 rows. `trending_players`: 0 rows. No transaction history table.

### 1.3 Live data — the bind

Measured 2026-09-17 19:40Z, Wednesday of NFL week 3:

| Feed | State | Cause |
|---|---|---|
| `rss_news` (ESPN) | **OK** after manual run | scheduler was disabled |
| `espn_news` (team pages) | **OK** after manual run | scheduler was disabled |
| `nfl_news_signals` (typed extraction the engine reads) | **BROKEN** | `ANTHROPIC_API_KEY` in `.env` is not workspace-scoped → HTTP 400 |
| `nfl_injuries` | weeks 1–2 only | nflverse publishes nightly; week 3's first practice report lands Wed night. Job itself succeeds. |
| Sleeper players (best free injury feed) | `off_sleeper_players`: 0 rows | source exists in `offseason-data.js`, never run in-season |
| `league_rosters` (ESPN) | **OK**, 5/5 leagues | cookies live |
| in-server scheduler | **disabled** (`SCHEDULER_DISABLED=1`) | its "live" tier runs synchronously and hung the server at 100% CPU / 854 MB |

### 1.4 Data we own and have never used for fantasy

| Source | Size | What it carries |
|---|---|---|
| `nfl_player_week_features` | 52,544 × 67 keys | opportunity_share, WOPR, red-zone/goal-line/end-zone, EPA per touch, YAC-oe, two-minute, third-down, catchable/contested |
| `nfl_team_week_features` | 5,310 × 183 keys | off/def EPA by situation, pace, PROE, neutral/leading/trailing pass rate, garbage-time share, drive rates, havoc, pressure |
| `adv_team_week` | 55 | tendencies: personnel groupings, motion, play-action, RPO, screen, shotgun, no-huddle, man/zone/cover-1/2/3, blitz, box, time-to-throw |
| `pbp_participation` | 478,989 | **route** (labeled on ~all pass plays 2016–25), offense/defense personnel, formation, defenders_in_box, pass rushers, `defense_man_zone_type` (58,902 man / 102,873 zone), coverage type, `was_pressure`, time_to_throw, who was on the field |
| `ngs_passing/receiving/rushing` | 10.7k / 26.8k / 10.9k | time-to-throw, air yards, aggressiveness, CPOE; cushion, separation, YAC-oe; RYOE, % vs 8+ box, time-to-LOS |
| `stats_player_week` | 183,373 × 152 | every counting stat + EPA/CPOE/PACR/RACR |
| `snap_counts` | 254,598 | offense/defense/ST snap share |
| `player_value_weekly` (`data/derived/player_value.sqlite`) | 436k, 2018–2026 wk5 | regularised APM; QB r=0.416 OOS vs placebo 0.10 |
| `nfl_ffopportunity_weekly` | 28,596 | expected FP, expected pass/rush/rec points, actual |
| `game_lines` | 2021–26, every game | spread, total, implied points, open/close, temp, wind, roof, rest_days, div_game |
| `injuries` (nflverse) | 55,749 | report_status, practice_status, date_modified. Measured: P(play\|Out)=0.0001, Doubtful=0.008, Questionable: Full 0.80 / Limited 0.69 / DNP 0.45; **team dialect** TB 80.8% vs PIT 47.0% on the same tag |
| `nfl-weekly-feature-store.js` | built, `nfl_player_feature_vectors` 1,090 rows (2026 only) | freezes cutoff-safe player/team vectors with history, trend, volatility, coverage, missingness. **Backfill 2021–25 before use.** |
| League chat extract | `data/derived/league_chat.sqlite`, 15,763 msgs, gitignored | "Transfer league 2026" group + 9 member DMs; names resolved; timing stats computed |

### 1.5 Betting-side assets to reuse

Nick: *"make sure we use the data and modeling from betting — we had a bunch of rly sharp things."* What carries over, and what doesn't:

| Asset | Where | Fantasy use |
|---|---|---|
| Regularised APM (`player_value_weekly`, QB r=0.416 OOS) | `data/derived/player_value.sqlite` | efficiency prior (1e) |
| Game lines: spread, total, implied points, weather, rest | `game_lines` 2021–26 | game-script **distribution** (blowout → garbage time), never the mean (r²=0.03) |
| `margin-distribution.js` | betting model | blowout probability per game → garbage-time share feature |
| Injury dialect by team (TB 80.8% vs PIT 47.0% on "Questionable") + practice-pattern rates | measured in registry §P | replaces the hand-set constants in `contingency.js:115–150` |
| `nfl-props.js#projectWeek` sim (+27.3% Brier skill on 2+TD) | `server/services/nfl-props.js:547` | the per-stat distribution engine for floor/ceiling — reuse, don't rebuild |
| Presser corpus: 10,670 timestamped coach pressers + `jev_presser_signals` (availability_state, team_impact, position_group, **coach_hedging**) | `line_history.sqlite` | coach_hedging as an injury-uncertainty feature; re-ask fantasy questions (role expansion, committee, "get him more touches") |
| `jev_transaction_signals` (10,543 official NFL transactions: move_type, availability_impact) | `line_history.sqlite` | roster-move features: starter_out/depth_in, IR, activation timing |
| Feature store + family-contribution harness | `nfl-weekly-feature-store.js`, `nfl-family-contribution.js` | the ML head (1f) and its admission gate |
| Prop-line history (`nfl_prop_clv`, 3,117 rows) | `line_history.sqlite` | validation set for the prop anchor (1g) |
| Harness discipline: walk-forward, placebo, BH, drift baseline, cluster-by-game, bet-everything control | registry §A–AA | section 6, verbatim |
| **Not carried over:** line-movement/CLV models, key-number atoms, teaser pricing, Polymarket/Kalshi | — | no fantasy use |

### 1.6 The leagues

All five are ESPN **redraft, PPR, 10-team** (one 8-team), all `connected`. "Long term" = rest-of-season + playoff weeks 15–17, **not** dynasty. Focus league for the counterparty work: id 4 "Transfer portal" (Nick = roster 5).

Roster map from chat → ESPN: Raj=1, Rami=2, Parth=4, Nick=5, Christian=8, Josh=9, Lars=10, Anthony (Vass)=11, Zach=12, Haiden Bonczek=7 ("Aiden Smith"; confirmed by Nick 2026-09-17).

**Nick's read on each manager (2026-09-17) — the dossier seeds.** (Repo made private the same day so this can live here; also in `data/derived/manager-dossiers.md` and the `manager_notes` table.) Archetype priors and Coach rules start from these:

| Person | Roster | Nick's read | Prior it sets |
|---|---|---|---|
| Raj ("Sai") | 1 | graduated, old roommate; sweaty; will try to scam | `sharp` high, adversarial; winner's-curse check on every incoming offer; his public valuations are anchors |
| Rami Fakih | 2 | at Michigan now; close with Nick; claims to know ball, doesn't; good team; asks others for help | slow, second-hand decisions; give him a reason he can repeat |
| Parth Bedi | 4 | abroad; kinda wants out | disengaged seller; low attention; simple 1-for-1s |
| Haiden Bonczek | 7 | noob, "just ass" — but active and locked in (Nick corrected his first read; data agrees: 10 starters set, none OUT; ESPN draft-day rank 4 → now 7) | low `sharp`, normal attention; reads offers; plain fair-looking 1-for-1s |
| Christian Etheridge | 8 | Commanders fan like Nick, not die-hard | light rapport lever |
| Josh Smith | 9 | smart, cocky (IB internship); co-coaches flag with Nick; second-ever fantasy team | `expertise` high in reasoning, low in fantasy: numbers-forward, no name-brand tricks |
| Lars Cramer | 10 | not sharp; uses fantasy Reddit for feedback; has a gf, rarely around; replies fast; scammed before | consensus-driven; cite ESPN/consensus; fast replies |
| Anthony Vasquez ("AV") | 11 | doesn't talk; knows some ball, lower end | DM only, short; little chat signal |
| Zach Ruggiero | 12 | has a gf, doesn't talk much | DM only; low volume; slow |

**Bias rule (Nick, 2026-09-17: "i could be wrong tho — my opinion is biased").** Nick's reads are **priors, not facts**: each starts with the weight of ~3 observations and decays as 4a/4c/4e data accrues for that person. Where data and the read disagree, the data wins and the disagreement is shown ("you said X; the last 12 proposals say Y"). The Haiden row above is the first example, and it cut both ways: "a bot" was withdrawn because his in-season lineups are set (10 starters, none OUT), but the draft data (checked 2026-09-18) says he DID auto-draft this league — all 17 Transfer portal picks carry ESPN auto type 3 — while drafting by hand in the league-3 league he shares with Nick (32 picks, 0 auto). Engaged in season, absent on draft day here.

Entity map (`entity_map` table): Sai = Raj; AV = Anthony. **Not in the league:** Aidan (roommate — not Haiden), Greg, Roan, Jake (Christian & Parth's roommate), Josh Arnold (roommate, abroad — not Josh Smith). The iMessage group **"Transfer Portal V4" is the friend chat — out of scope, never read.**

---

## 2. The final product

When this is done, Nick opens Trade Lab and:

1. **Every projection is one he can trust** — measurably better than a season-to-date average on a walk-forward harness, with a calibrated floor/ceiling from the sim, and a live-data health badge that says when injuries/news were last refreshed.
2. **Find Deals returns dozens of real options, not five** — 1-for-1 through 3-for-2, two-step sequences, and three-team routes — each priced with **his** number on his side and **their** number on theirs, ranked by `P(accept) × his ROS gain`, with the acceptance probability shown.
3. **Every deal has a dossier on the other manager** — how fast they reply, what they've said about their own players, whether they counter or ghost, what they overvalue — built from transaction history and the league chat.
4. **"Explain this trade" argues from everything** — projection deltas, xFP regression, matchup/coverage, injury/practice pattern, news signals, title-odds delta, the counterparty's stated valuations and archetype, and the timing stats — in one structured explanation with the evidence weighted by strength.
5. **The Coach** — given a target and Nick's draft message, returns a repositioned message, an opening anchor, a send time, a don't-say list, and a predicted response.
6. **The engine is backtested** — on replayed 2024–25 league states, recommended trades improved simulated title odds; the number is on the page.

---

## 3. Architecture

```
LIVE DATA (Phase 0)            PROJECTION (Phases 1–3)                COUNTERPARTY (Phase 4)
nflverse · ESPN · Sleeper      per-stat ML head  ─┐                   ESPN transactions/drafts
RSS/ESPN news → typed signals  (means)            ├→ sim (3,000-run  league chat → Claude dossier
game_lines · injuries          existing sim ──────┘  team-week events)  → Jev labels → archetype
                                   ↓                  → distribution      → per-manager valuation
                               scoreLine() → FP distribution              → P(accept | package, person)
                                   ↓                                          ↓
                           ROS + playoff value (Phase 3)  ──────────→  GAME THEORY (Phase 5)
                                                                    objective P(accept)×gain
                                                                    anchoring · multi-team · negotiation sim
                                                                              ↓
                                    FIND (Phase 6) · EXPLAIN (Phase 7) · COACH (Phase 8) · BACKTEST (Phase 9) · UI (Phase 10)
```

Boundary rule (from `betting-fantasy-link.js`): fantasy code reaches betting-model context **only** through that module. New betting→fantasy inputs (game lines, APM, availability rates) are wired through it, not by direct `nfl-*` imports from fantasy services.

---

## 4. Phases — step by step, with gates and fallbacks

Each phase lists **inputs**, **work**, **deliverable**, **acceptance** (numeric where possible), and **if the numbers don't go great**. Phases marked ⛔ are gates: later phases do not start until they clear.

### Phase 0 — Live data. Hard prerequisite. (0.5–1 day)

**Why first:** injury and news data feeds every projection and every trade. It is currently half-broken and the only refresh mechanism hangs the server.

**Work**
1. Move the scheduler's "live" tier **off the web server's event loop**. Build `scripts/refresh-live-data.mjs` that imports `JOBS` from `server/services/scheduler.js` and runs a named subset with timing and error capture (prototype ran tonight: `nfl_injuries`, `rss_news`, `espn_news`, `nfl_news_signals`, `league_rosters`, `player_rosters`). Run it from a loop script or cron every 15 min — **not** a LaunchAgent under `~/Documents` (TCC blocks it; learned tonight).
2. Fix `nfl_news_signals`: replace `ANTHROPIC_API_KEY` in `.env` with a **workspace-scoped** key (console.anthropic.com → inside a workspace → API keys). Verify with one run; the engine's `news_context` must repopulate.
3. Add **Sleeper** as a second injury/status source: `https://api.sleeper.app/v1/players/nfl` (no key, ~5 MB, `injury_status`, `injury_body_part`, `practice_participation`, `depth_chart_order`, updated continuously). Wire into `off_sleeper_players` (exists, 0 rows) and merge into `nfl_injuries` with source precedence: nflverse official report > Sleeper > ESPN news mention.
4. Add a **data-health table** `live_data_health(feed, last_ok_at, last_error, rows)` written by the runner, exposed at `GET /api/health/live-data`, rendered as a badge in the UI (green <30 min, amber <6 h, red otherwise).
5. Re-enable the in-server scheduler only for **growth** tier jobs (daily) once live tier runs externally; keep `SCHEDULER_DISABLED` semantics for interactive use.
6. **Week progression follows ESPN (done 2026-09-17):** `leagues.current_week` = ESPN `status.currentMatchupPeriod` at every sync (migration 056); `services/league-week.js#leagueCurrentWeek` is the only way pages resolve "this week"; the ESPN sync no longer pins `scoringPeriodId=1`; `nfl_lines` (finals) is in the refresh allowlist because unscored games are what advance `tradeWeekContext()`. Rule: no route or service defaults a week to `1`.
7. **24/7 hosting (Nick, 2026-09-17: "make it accessible even if my laptop isn't there or off the wifi… keep server running 24/7"):** the app must run off a host that is not the laptop. The fantasy app needs `server/data.sqlite` (635 MB) + `data/derived/player_value.sqlite` (66 MB) + the private `league_chat.sqlite` (56 MB); the 22 GB betting archive stays local. Same refresh loop runs on the host. Login is the existing single-user `local-auth`. Hosting choice and account creation are Nick's (see section 9).

**Acceptance:** all six feeds show `last_ok_at` within their cadence for 24 h straight; week-3 injury rows present by Thursday 08:00Z; `nfl_news_signals` inserts rows; server HTTP p95 < 500 ms under the external runner.
**If it doesn't go great:** nflverse late → Sleeper becomes primary for status until nflverse catches up; Anthropic key unavailable → typed signals fall back to a regex/keyword extractor over `news_items` (out / questionable / activated / IR / placed / designated), lower recall, never silent.

### Phase 1 — Projection foundation ⛔ (3–5 days)

**1a. Persist the validated fit — ✅ DONE 2026-09-17 (`scripts/promote-weekly-ensemble.mjs`, commit 06f05ff).**
Gate reproduced (fit 2023 → select 2024 → open 2025 once): **PASS**. ensemble_global **4.334** MAE vs season_to_date 4.386 vs frozen/60-40 **4.455**; paired bootstrap p=0.999 and p=1.000; Spearman 0.675 vs 0.668 / 0.667; 80% coverage 0.789; CRPS 3.086 vs structural 3.288. Production fit refit on 2023–25 pooled (13,340 player-weeks), cutoff 2025-W18, weights `[0.20 structural, 0.40 season_to_date, 0.15 last3, 0.05 last1, 0.20 median]` for every position; graded through the production path at **4.33** and re-graded after reading the row back. `activeWeeklyWeightSet({season:2026,week:3})` now returns `source:'adaptive'`, `fit-1`.
*Trap found and avoided:* `weeklyEnsemblePrediction` does `weightSet[context.position]` and expects a five-element array. Storing the global fit as a bare array would have silently demoted every prediction to structural-only (4.749) — worse than what we replaced. Weights are stored per position and the script refuses to promote anything that is not a convex 5-vector for all four.
**Acceptance:** production MAE on the 2025 walk-forward ≤ season_to_date − 1%. **Fallback:** none needed — this is strictly better than what runs.

**1b. Opportunity redistribution (1 day).** When a teammate is inactive (from `activeDepthRoster` + Phase-0 status), re-split team targets/carries among active players using historical absorption patterns for that team/QB (who took the targets last time WR1 sat), falling back to depth-chart order. Implement in `player-week-engine.js` before the ensemble. **Acceptance:** on player-weeks where a top-2 teammate at the same position was inactive, MAE improves ≥ 8% vs no redistribution; no regression elsewhere.

**1c. Efficiency anchor = xFP + xTD regression (1 day).** In `projections.js`, replace the global-K shrinkage target for ypt/ypc/td_rate with the player's strictly-prior expected rates from `nfl_ffopportunity_weekly` (`priorFfOpportunity`), and add an explicit `td_regression = xTD_prior − actual_prior` term. **Acceptance:** MAE improves ≥ 2% pooled; TD-component MAE improves ≥ 5%.

**1d. Volume leading indicators (1 day).** Build **targets-per-route-run** from `pbp_participation` (route ≠ '' on pass plays; player in `offense_players`), snap-share trajectory (Δ over last 3 weeks), red-zone/goal-line/end-zone shares, air-yards share. Add as heads/features. **Acceptance:** WR/TE target-volume MAE improves ≥ 5%.

**1e. APM as shrinkage target (½ day).** Shrink player efficiency toward `player_value_weekly.value_epa` (per-player, validated) instead of positional mean. **Acceptance:** no worse pooled; QB/WR efficiency MAE improves ≥ 2%.

**1f. Per-stat ML head (2 days).** Backfill `nfl_player_feature_vectors` 2021–25 via `backfillPlayerFeatureVectors`. Train gradient boosting per stat (targets, carries, ypt, ypc, td_rate) over the frozen vector + O-line/defense/coach families below. **Season-blocked walk-forward, early stopping on a held-out season, train/test gap reported.** Feed means into the existing `sampleTeamWeekEvents` sim → `scoreLine()`. **Acceptance:** fitted blend (including the GBM head) beats season_to_date by **≥ 5% MAE and ≥ +0.02 Spearman on all five seasons**, and 80% coverage in [0.78, 0.82].

**Feature families for 1f — each must earn its place via `nfl-family-contribution.js`:**
- *Coach/OC:* personnel rates, PROE, pace, play-action/RPO/screen/motion rates, OC change flag.
- *QB:* CPOE, time-to-throw, aggressiveness, target Herfindahl, catchable-target rate, QB APM.
- *O-line:* pressure rate allowed (`was_pressure`), time-to-throw allowed, sack/QB-hit rate, stuff rate, OL continuity (same five from `snap_counts`), OL injuries by position, box count faced.
- *Teammates:* active pass-catcher count, RB carry Herfindahl, goal-line role from goal-to-go participation.
- *Defense faced:* coverage rates (man/zone/cover-1/2/3), blitz rate, pass rushers, box, pressure/havoc, deep-pass EPA allowed, run EPA/success allowed, red-zone TD rate allowed, garbage-time share.
- *Efficiency (NGS/derived):* YAC-oe, separation, cushion, RYOE, % vs 8+ box, contested/catchable, aDOT stability, INT-worthy rate.
- *Context:* wind > 15, rest days, first game back from injury (`nfl-player-context`), blowout probability from `margin-distribution.js` (distribution only).
- *Novel:* **man/zone split × opponent man rate** — compute per-player efficiency vs man and vs zone from `pbp_participation`, interact with the opponent's rates.
- *On/off splits (Nick: "correlation between on/off field stats"):* each player's usage and efficiency **with and without** each key teammate on the field, from `pbp_participation.offense_players` — so 1b's redistribution uses measured absorption, not depth-chart guesses. Includes QB-on/QB-off splits for pass-catchers when the starter changes.
- *Off-field context:* contract year, holdout or trade request, suspension, coaching/OC change, first game back — typed from `nfl_news_signals` and the 10,543 labeled official transactions (`jev_transaction_signals`).
- *Trajectory ("history and future growth"):* usage-trend slope over the last 4 weeks, age/experience curve by position, rookie ramp (weeks 1–6 vs 7+), post-injury ramp, post-coaching-change ramp. In redraft "future" means the next 12 weeks, so the slope carries more than the level.

**1g. Second market anchor — sportsbook player props (½ day, optional).** Where a player has a prop line (receiving/rushing yards, receptions, anytime TD) it is the sharpest public estimate of that stat's median. Use it beside ESPN in the Phase-2 gate and as a shrinkage target for the per-stat head. Historical validation from `nfl_prop_clv`. Live props need a feed we do not currently collect (oddsapi player-prop calls cost more; collectors are off) — build only if a source clears the budget rule. **Acceptance:** on prop-covered players, prop-anchored per-stat MAE ≤ ESPN-anchored.

**If the numbers don't go great (Phase 1):**
- Fitted blend < 5% over naive → ship 1a–1e anyway (they are strictly better), report the ceiling honestly, and **use ESPN's consensus projection as the mean** (Phase 2) with our sim for the distribution. The trade engine still improves because the counterparty layer does not depend on projection edge.
- GBM train/test gap > 2× the test improvement → it is overfitting; drop to elastic net; reduce families to the top 3 by contribution.
- Any family with contribution p > 0.10 after BH across families → remove it. Do not keep decorative features.

### Phase 2 — Consensus gate ⛔ (1 day)

**Work:** run `espn-market.js` (`kona_player_info`, cookies are live) to populate `espn_player_market` now, and snapshot it **weekly** going forward (add to the Phase-0 runner). Build `vs_consensus` in the harness: for each player-week, our projection vs ESPN's; grade both; regress our *disagreement* with ESPN on the outcome residual.
**Acceptance:** report (a) our MAE vs ESPN's on the same player-weeks, (b) the calibration slope of our disagreement (need > 0.3 to claim information). **This decides Phase 1f's future**, not its shipping.
**If it doesn't go great:** slope ≈ 0 → ESPN's mean becomes the projection anchor; our work concentrates on the distribution, redistribution, and Phases 4–8, where the edge is the *person*, not the market. This is not failure; it is the betting-side lesson applied.

### Phase 3 — Long-term value for redraft (1 day)

**Work:** `ros_value = Σ_{w=now..17} P(active_w) × E[FP_w]` with week-specific matchup (`playoff_sos`, coverage matchup), bye alignment with *Nick's* roster, injury-return timing from `nfl-player-context`, and role trajectory (snap Δ). Playoff weeks 15–17 weighted ×1.5 for teams in contention (from `season-sim` playoff odds). Expose `ros_value`, `playoff_value`, `floor_ros`, `ceiling_ros`.
**Acceptance:** `ros_value` rank correlation with realised ROS points on 2021–25 ≥ 0.60 at week 6, ≥ 0.70 at week 10.

### Phase 4 — Counterparty model (2–3 days)

**4a. Transaction history collector (1 day).** Extend `espnGet(leagueId, season, views)` with `mTransactions2` and `mRoster` + `scoringPeriodId`, for seasons 2023–2026 across all 5 leagues. Store `league_transactions(league_id, season, ts, type, roster_id, items_json, bid, status, proposer, responder, response_ts)`, `league_draft_picks`, `league_roster_history(league_id, season, week, roster_id, player_ids_json)`. **Needs Nick's OK to hit ESPN for prior seasons.**
**Acceptance:** ≥ 3 seasons × 5 leagues of transactions; every accepted/declined trade proposal with both packages.
**Timestamps are the point (Nick, 2026-09-17: "source data on when trades were proposed/accepted vs when the text messages were sent — this gives us reactions to live information").** Capture `proposedDate`, `processDate`, `status`, `memberId`, `teamId`, `relatedTransactionId`, `scoringPeriodId` on every transaction (ESPN returns them in ms), and poll `mPendingTransactions` each refresh tick so proposals that are later cancelled or expire are still seen with their proposal time. ESPN's default `mTransactions2` answer is only the last ~3 days (verified 2026-09-17: 132 rows, 09-15 → 09-17; a first guess at the `X-Fantasy-Filter` header returned 400 — the filter shape still has to be worked out, ffscrapr's ESPN client is the reference). **Forward capture started 2026-09-17:** `scripts/collect-league-transactions.mjs` runs every refresh tick and upserts every transaction by id into `league_transactions_raw` (proposal time, process time, status, team, member, related proposal, items), so nothing inside the window is lost from today on.

**4e. Reaction timeline — chat × transactions × news (1 day).** Every event gets a UTC timestamp and the join is on time and person:
- *Events:* trade proposed / accepted / declined / cancelled / vetoed (4a), waiver claim and drop (4a), injury report change (`nfl_injuries.date_modified`), typed news signal (`nfl_news_signals`), weekly result (win/loss, final margin), and Nick's own DMs.
- *Windows:* for each event, the chat messages by each party in the group and in the relevant DM at −72 h … +72 h, labeled (4c).
- *Metrics it produces (into 4b):* **lead time** — minutes from the first DM mention of a player/trade to the in-app proposal (who talks first, who just sends it); **reaction latency** — event → first message by the affected manager; **reaction tone** after accept / decline / loss / injury (`tone`, `reacting_to_loss`, `own_roster.complaining`); **news reactivity** — P(chat mention within 6 h of a signal about a player they own) and P(transaction within 24 h); **public-commitment rate** — said it in the group, then did it; **persuasion susceptibility** — Nick pitch in DM → proposal → outcome; **decline-then-counter gap** — minutes between an in-app decline and the DM that explains it; **negotiation length** — messages and hours from first mention to executed trade.
- *Storage:* `event_timeline(event_id, kind, ts_utc, actor, counterparty, player_ids, ref_id)` and `event_chat_links(event_id, msg_id, offset_min, party)` in the private `league_chat.sqlite`.
**Acceptance:** every executed trade in 2026 has its proposal time, process time, and the linked chat window; lead-time and reaction-latency distributions per manager with n ≥ 3.
**If it doesn't go great:** ESPN history window too short for prior seasons → 2026 only, forward-collected; chat windows empty for quiet managers (AV, Zach) → metrics reported as "no chat signal", never imputed.

**4b. Behavioural profile (1–2 days).** Nick: *"more more more."* Every metric below is computed per manager per season from a named table, stored in `manager_profiles` (currently 0 rows) as `{metric, value, n, season}` so the UI can show the number and the sample it rests on. Source key: **D** = `league_draft_picks`, **T** = `league_transactions`, **R** = `league_roster_history`, **C** = chat labels (4c), **S** = scores/standings, **M** = `espn_player_market`.

*Draft (D, M):*
- reach rate and value rate — mean/SD of pick-vs-ADP distance; share of picks ≥ 12 spots early
- pick latency — seconds per pick; ESPN auto-pick flag; share of picks made at the clock
- positional sequencing — round of first RB / WR / QB / TE; zero-RB, hero-RB, early-QB, early-TE flags
- rank-follower score — correlation of pick order with ESPN default rank (drafts the list vs thinks)
- rookie share, own-NFL-team share (homer), QB+WR stack rate, handcuff-of-own-RB rate
- late-round style — ADP dispersion of rounds 10+ (upside swings vs floor veterans)
- attachment — same players re-drafted year over year; keeps his guys
- draft-capital efficiency — realised season points per draft slot vs league mean

*Waivers / free agency (T, M):*
- claims per week; FAAB bid size distribution and win rate (or waiver-priority spend) where applicable
- reaction latency — hours from a breakout box score to the claim
- streamer flag — DST/K/QB churn per week
- speculative vs reactive adds — handcuffs and injured stashes vs post-box-score adds
- impatience index — median days from add to drop; drops after N bad weeks (N per manager)
- IR-slot usage; roster churn by week 8
- waiver ROI — points scored by adds while rostered vs points by the players dropped

*Lineups (R, S):*
- points left on bench per week (optimal − actual); rank in league
- inattention index — byes or Out players left in the starting lineup
- projection-follower score — share of weeks the started lineup equals ESPN's projected-best lineup
- risk preference — starts high-variance players in must-win weeks vs floor players
- Thursday/Monday awareness — starters locked before a Thursday injury update

*Trades (T, R, M):*
- proposals sent / received / accepted / declined / countered / expired per season
- **personal acceptance curve** — P(accept) as a function of their-side value delta (by our value AND by ESPN value)
- response latency to proposals; probability of no response at all (ghost)
- counter rate and counter magnitude — how far they move from the original ask
- package shape preference — 2-for-1 consolidator vs depth collector
- positional bias — buys RB / sells TE etc., by value flow per position
- partner concentration — Herfindahl of trade partners (only trades with friends?)
- week distribution of trades; deadline-week activity; post-loss trade rate (48 h)
- endowment effect — asking price for own player vs price paid for an equivalent
- name-brand premium — value paid above ESPN for prior-year ADP top-50
- recency premium — price paid after a player's best week of the season vs his season mean
- injury discount — value at which they sell a player on IR / Questionable vs healthy
- playoff-schedule awareness — value flow toward good weeks-15–17 schedules
- fairness sensitivity — rejects lopsided deals even in their favour (needs "fair-looking")
- regret rate — re-trades a player received within 3 weeks
- accepted-value ratio over time (season trend) — sharp or fish, and getting sharper or not
- history with Nick — every proposal between them, outcome, and the chat around it

*Chat (C):*
- volume — messages/week, share of group messages, burst count
- timing — hour-of-day and day-of-week histograms; reply latency p50/p90; initiation %; unanswered %; night %
- tone mix — trash-talk / friendly / defensive / dismissive shares
- confidence index — mean `confidence`; **calibration** — join confident player claims to that player's next-4-week points (were they right?)
- stated valuations ledger — (player, sentiment, confidence, date); untouchables; sell statements; buy interest
- loss reactivity — message rate and tone in the 24 h after a loss vs after a win
- responsiveness to Nick — reply latency and reply probability to Nick vs to others
- persuasion susceptibility — after a Nick pitch in chat, did a proposal follow and what happened (join C→T)
- topic share — trade talk / lineups / NFL news / non-fantasy
- tapback ratio — reacts instead of replying (low-effort responder)
- social graph — who they reply to most; who they never answer
- public-commitment rate — says it in the group, then does it (join C→T)

*Outcomes (S, R):*
- finish history; points for; all-play record (luck-adjusted); playoff appearances
- roster value trajectory by week (did their trades gain value?)
- weekly-luck exposure — record vs all-play record (tilt risk)

*Coach signals (from `docs/COACH-PLAYBOOK.md` §7 — the profile must also carry these):*
- expertise: rate and sources of calculator/ADP/snap-share/rankings citations per 100 chat messages (drives ask-first, precision level, name-brand and contingent-contract gating)
- stated_valuation_unit: modal unit of the manager's value talk (pick round / tier / straight-up / points)
- stated-valuation channel (group vs DM) and loss-window flag on every ledger entry
- stated_needs and stated_denials ledger: explicit 'I need X' / 'my RBs are fine' statements with dates
- emoji_rate over the last 10 messages
- trust_with_nick composite: fitted from completed trades with Nick, last-thread outcome, tone toward Nick
- days_since_last_dm with Nick
- rejection_latency conditional on outcome, as a ratio to reply_p50 (time-to-decline vs time-to-accept)
- instant_accept_n: Nick's proposals accepted with no counter in under 1 hour
- their_counters_asset_class: asset class requested in each of their counters (pick / throw-in / starter swap)
- ultimatum_ledger: ultimatum phrases per asset with repetition count
- lopsided_complaints: 'lopsided/collusion/robbery' posts in the last 30 days
- tactic_exposure_log: per manager and thread, which Coach tactics fired (deadline revealed, BATNA mentioned, nibble, 'final' said, quoted valuation) and outcome
- reply_latency_by_hour: hour-of-day histogram restricted to replies rather than all messages
- team_news_mention_rate by NFL team: information-asymmetry proxy for players on that team
- roster constraints per opponent: droppable_count, positional_depth per slot, roster_at_max, ir_slots_free, bye_cluster_next_week, handcuff map, keeper eligibility
- acquisition_source_and_date per roster asset (draft round / waiver / trade, date) for endowment targeting
- batna_n: number of alternative rosters where an equivalent package is plausible, from findTrades
- league calendar: lineup lock times, waiver run time, trade deadline, veto rule and review window; NFL game windows for the week
- coach_threads state store: last_msg_class (accept / counter / reject-with-reason / reject-no-counter / ultimatum / valuation-claim / brush-off / confirmation / silence), keyword flags (fair/lowball/insult), counter_n, their_msgs, offer diff history, concessions_by_them, ultimatum_n, idle_time, next_allowed_followup, final_said, agreed_unsubmitted
- Nick draft lint: I/you ratio, exclamation/emoji/caps counts, negation count, obligation words, sarcasm markers, forbidden-vocabulary hits, unnamed value added vs last offer, implicit deadline, addressed channel

*Compound indices (fitted, not hand-set):* activity, sharpness, exploitability (P(accept a deal ≥ 15% lopsided by ESPN value)), reachability (reply probability × latency), tilt (post-loss behaviour delta), attention (inattention + lineup lag). Each index is a fitted weighting of the metrics above against realised acceptance/decline outcomes; report the weights.

**Archetypes (Nick: "we need JEV to seriously UNDERSTAND who this person is").** Every manager gets a score on every archetype, not one label; each is measurable from 4a + 4c:
- *Auto-drafter* — pick-vs-ADP distance ≈ 0, pick latency ≈ 0, byes left in lineups.
- *Waiver junkie* — claims per week, share of roster churned by week 8.
- *Name-brand buyer* — pays for last year's ADP; holds declining veterans.
- *Recency chaser* — buys after a big week, sells after a dud (trade timestamps vs box scores).
- *Hoarder* — declines everything for his top 3; "untouchable" declarations in chat.
- *Counter-everything* — never accepts v1; median counters per deal.
- *Ghost* — reply p90 > 24 h, high unanswered%; only reachable in the group.
- *Homer* — over-rosters his NFL team's players (roster share vs league base rate).
- *Sharp* — accepted-value ratio ≥ 1, buys before breakouts.
- *Panic seller* — drops or sells within 48 h of a loss; `reacting_to_loss` + own-roster complaining in chat.
- *Talker* — high initiates%, high trash-talk ratio, states valuations publicly (those are anchors to use).

**Seasonal price trend (Nick: "what price — trends").** Per manager, how the accepted-value ratio moves across weeks 1–4 → 5–9 → deadline → playoffs, and whether they overpay early or panic late. Feeds `send_at` in the Coach.

**4c. Chat dossier + Jev labels (1 day; PLANNED, gated on Nick's privacy choice).**
- *Understand (Claude, once):* read the group thread and each DM whole; reconstruct conversations (`reply_to`, bursts < 2 min, name continuity); build an entity map (nicknames → people, team names → people, player nicknames → players); write a **dossier** per manager: role in chat, stated valuations with dates, confidence pattern and whether it was right, trade posture, loss reactions, what they respond to.
- *Label (Jev, at scale):* `scripts/news-line/jev_league_chat.mts` — topic, confidence, tone, own-roster sentiment, player sentiment (player pre-extracted), open-to-trade, reacting-to-loss — with the dossier line as context. ~$0.15. Sent under **standard gateway retention by Nick's explicit choice (2026-09-17)** — ZDR is Pro-only and he declined to upgrade; re-enable `providerOptions.gateway.zeroDataRetention` if the plan changes.
- *Scope:* **every message** — members, Nick's own, and tapback reactions (Nick, 2026-09-17: "dont skip mine and tapbacks"); one- and two-character messages (`W`, `L`, `gg`, a lone emoji) count. Only bare attachment placeholders (383) and null bodies (26) are skipped. Nick's own messages feed the Coach (what he already said to whom, his tells) and a consistency check ("you told Raj X on 9/3").
- *Aggregate:* per manager, per week — sentiment toward each player they own, confidence index, trash-talk ratio, sell/untouchable declarations.

**4d. Per-manager valuation.** `their_value(player, manager) = ESPN consensus × (1 + name_brand_premium) × (1 + endowment if theirs) × sentiment_adjust(chat) × position_bias`. Fit the multipliers on 4a's accepted/declined history by maximum likelihood.
**Acceptance:** on held-out proposals, `their_value` ranks accepted over declined with AUC ≥ 0.70.
**If it doesn't go great:** AUC < 0.60 → use ESPN consensus + endowment only; keep dossier for the Coach and Explain (qualitative), not for pricing.

### Phase 5 — Game-theory engine (2–3 days)

**Work**
1. `P(accept | package, manager)` — logistic on: their perceived value delta (from 4d), positional need fit (existing `rosterContext`), package complexity, manager tradeability, timing (day-of-week from chat stats), recent-loss state, history with Nick. Fit on 4a. Calibrate (reliability diagram).
2. Objective: `score = P(accept) × my_ros_gain − λ × |their_value_delta|⁺` with a fairness floor so it never proposes something insulting (P(accept) < 0.15 pruned).
3. Refactor `tradeImpact` to accept a shared projection build and run ~1 s/candidate; verify the top 20 by title-odds delta.
4. **Anchoring ladder**: for each target, compute *ask* (P≈0.25), *fair* (P≈0.5), *floor* (P≈0.75 and still ≥ 0 gain for Nick).
5. **Negotiation sim**: from the manager's counter-history, model the counter distribution; search the opening ask that maximises expected final gain over the tree.
**Acceptance:** P(accept) Brier ≤ 0.20 on held-out proposals; reliability slope ∈ [0.8, 1.2]; ranking by objective beats ranking by `my_ppg_delta` on realised acceptance in the backtest (Phase 9).
**If it doesn't go great:** proposal history too thin (< 100 decided proposals) → fall back to the `plausible` heuristic weighted by manager tradeability and the timing stats; report P(accept) as a band, not a point.

### Phase 6 — Find-trades expansion (1–2 days)

**Work** (build on `findTrades`, keep its pruning and idea-dedup):
- `maxPerSide` 2 → 3; candidates 11 → 16 per roster; `limit` 25 → 60, grouped by partner and by *idea*.
- **Multi-step:** generalise `findTradeSequences` to depth 3 with a beam of 5 at each level; show as a tree ("do A, then B opens").
- **Three-team routes:** A gives to B, B gives to C, C gives to A — enumerate over the partner pairs where a 2-team deal fails only on positional fit, cap at 10 per week.
- Every result carries: `P(accept)`, `their_value_delta`, `my_ros_gain`, `title_delta` (sim), `floor/ceiling` change, `conflicts_with_earlier`, and the **archetype hint** ("counters — open high").
- Cache at the shared-projection layer so the whole search is < 30 s per league.
**Acceptance:** median league returns ≥ 25 distinct ideas with P(accept) ≥ 0.3; ≥ 5 multi-step; search < 30 s.

**Counterparty → finder data contract (Nick, 2026-09-17: "just want to make sure the data we gather on our league members and texts etc feeds into the trade finder").** Today `findTrades` reads exactly one counterparty fact: the hand-set `manager_profiles.tradeability` tier (`never` blocks, `hard` × 0.55). Everything below is a **hard requirement of Phase 6**, not the Coach — an agent that ships the Coach without these wired into `findTrades` has not finished Phase 6:

| Source (table) | Produced by | Consumed in `findTrades` as |
|---|---|---|
| `manager_chat_profile` (volume, tone, confidence, open-to-trade, reacting-to-loss, untouchable rate) | 4c rollup (running every 15 min) | archetype scores → `P(accept)` features; `open_to_trade` raises partner priority; `reacting_to_loss` sets the timing flag on the idea |
| `manager_player_sentiment` (per person × player) | 4c rollup | `their_value(player, manager)` multiplier for that exact player; praise ≥ 3.0 → "they overvalue him" (ask for more, or don't target); complaint ≤ 1.5 → buy-low candidate surfaced |
| stated **untouchables** and sell declarations (from `own_roster.untouchable` / chat ledger) | 4c | untouchables are **pruned from `candidates()`** for that partner; declared sells are boosted |
| `manager_notes` + `entity_map` (Nick's reads) | dossier seeds | archetype priors before data exists (Raj → adversarial/`sharp`, Haiden → auto-drafted this league but manages his lineup in season, Parth → seller, Lars → consensus-driven); the archetype hint shown on every idea card |
| `league_transactions_raw` (proposals, accepts, declines, vetoes with timestamps) | forward collector (running) | personal acceptance curve → `P(accept)` calibration; counter rate → MESO vs single offer; veto history → veto-proofing flag |
| 4e reaction timeline (lead time, reaction latency, news reactivity) | 4e | `send_at` on each idea; partners in a post-loss window get the T9/T10 rule applied to the ranking, not just the message |
| `their_value` (4d) | 4d | prices **their** side of every evaluated package; the finder ranks by `P(accept) × my_ros_gain − λ|their_value_delta|⁺` (section 5) |
| `P(accept | package, manager)` (5) | 5 | the ranking objective; ideas below 0.15 pruned; the filled bar on the card |

Rule: any new counterparty signal added anywhere in the system must name its `findTrades` consumer in this table or it is Coach-only by explicit decision.

**AI synthesis of realistic proposals (Nick, 2026-09-17: "use AI to combine all the data to realistic proposals").** After the numeric ranking, the top ~15 ideas per league go through one Claude pass (Sonnet, cached per league-day, ≤ 1 call per refresh) that receives, per idea: both packages priced both ways, `P(accept)`, the partner's chat profile and per-player sentiment, their stated untouchables/sells, their transaction history and acceptance curve, the reaction-timeline timing, Nick's read *and its current weight*, and the roster-fit notes. It returns 5–10 **realistic proposals**: the package to actually send, why this person would say yes in their terms, the opening ask and floor, `send_at`, the one risk, and which data points it leaned on. Rules: it may merge or drop ideas but may not invent players or numbers; when Nick's read and the data conflict it follows the data and says so; every claim cites the block it came from (same discipline as Explain). Output lands on the Find deals page above the raw list, and each proposal links to its Coach thread.
**Acceptance:** Nick rates ≥ 7/10 synthesized proposals "I'd actually send this"; every proposal's cited data points exist in the tables named above. **Acceptance addition:** for the Transfer portal league, the top-10 ideas change when `manager_player_sentiment` is zeroed out (proof the finder is reading it), and no idea targets a player its owner has declared untouchable in the last 30 days.

### Phase 7 — Explain from everything (1 day)

Rebuild the `trade-explain` payload so Claude receives, per player on each side, a structured evidence block:
- projection: our mean, ESPN mean, delta, floor/ceiling, ROS and playoff value, confidence (from 80% coverage)
- efficiency: xFP regression sign, APM value, NGS skill flags
- opportunity: TPRR, snap Δ, redistribution note if a teammate is out, red-zone role
- matchup: next 3 weeks' coverage/pressure/run-defense fit; playoff-weeks SOS
- availability: status, practice pattern, team dialect P(play), first-game-back flag, news signals (typed, with source and time)
- market: `their_value`, endowment/name-brand adjustments, ESPN rank/ADP/%rostered
- public sentiment (Nick: "player sentiment etc"): Sleeper trending adds/drops (`trending_players`), %rostered Δ week-over-week, ESPN rank movement, news-signal tone — the hype the counterparty is reading, separate from what the league chat says
- counterparty: archetype, stated valuations from chat (with dates), timing stats, predicted response, P(accept)
- sim: title/playoff delta for both sides, seed, runs
- **weights:** each block tagged `strength ∈ {decisive, strong, supporting, weak}` from its measured lift, so the explanation leads with what actually decides the deal.
Prompt rule: argue only from the blocks; cite the block; never invent a number. Keep the propose→verify→retry loop from `trade-verify.js`.
**Acceptance:** a blind read-through of 20 explanations finds zero uncited numbers; each explanation names the decisive block first.

### Phase 8 — The Coach (1–2 days)

**Playbook:** `docs/COACH-PLAYBOOK.md` (2026-09-17) — researched from six schools (Voss/FBI, Harvard PON, Cialdini, behavioural economics of bargaining, e-negotiation/text research, fantasy practitioner columns; 102 sources), every rule graded (P) peer-reviewed / (p) practitioner / (i) inference, keyed to measurable 4b triggers, with six cross-school conflicts resolved explicitly. Standing constraint: a ten-person league is repeated play — rapport-preserving moves outrank hardball; the Coach optimises season EV, not the current thread. The Coach implements the playbook's sections 1–6 (anchoring, framing, tactic table, concession ladder, channel/timing, never-list) and is measured by its section 8.

`POST /:leagueId/coach` with `{targetRosterId, package, draft}` → `{message, anchor, send_at, dont_say[], predicted_response, p_accept}`. Inputs: dossier, timing stats, recent thread, package numbers, anchoring ladder. Output tuned to the person (numbers-forward vs casual; length from their reply style). Reposition Nick's draft rather than replace it.
**Acceptance:** Nick rates ≥ 8/10 of coached messages as "I'd send that" in a first pass.

**8b. Live chat monitor (Nick, 2026-09-17: "do it live — people are unpredictable — this requires monitoring of the chat 24/7").** A watcher on the Mac polls `~/Library/Messages/chat.db` every 20–30 s for new rows in the Transfer-league group and the nine member DMs only, decodes them (same extractor as the one-off pull), classifies each new message (Jev, same questions as 4c; ≤ $0.001 each), updates `coach_threads` (last_msg_class, counter_n, idle_time, ultimatum_n…), and when a watched thread moves it (a) recomputes the next ladder step and (b) pushes a notification to Nick's phone with the suggested reply and the one-line reason. Nick's own sent messages are read the same way, so the thread state stays true even when he ignores the suggestion.
**Constraint that cannot be engineered away:** iMessage history lives only on the Mac (and the phone); a hosted server cannot read it. So the monitor runs on the Mac and relays to the hosted app. When the Mac is asleep or off, the Coach degrades to "paste the thread" mode in the UI and says so.
**Backfill on wake (Nick, 2026-09-17: "have it backfill chats when the laptop is on — and then rediagnose the new ones and add it to our database of player profiles").** iMessage itself syncs the missed messages to the Mac when it comes back; the monitor is `scripts/chat/extract_league_chat.py` run incrementally (rows with ROWID above the last stored `msg_id`), then `--classify` (Jev, only the new rows), then `--rollup`, which rebuilds `manager_chat_profile` (per person: volume, group share, night share, trade-talk / trash-talk / non-fantasy rates, confidence, tone mix, open-to-trade, reacting-to-loss, own-roster complaining / untouchable) and `manager_player_sentiment` (per person × player: mean sentiment on a 0–4 scale, share positive/negative, first/last mention). Those two tables are the chat half of the 4b profile; the transaction half joins on the manager's name. Cadence: every minute while the Mac is awake (a LaunchAgent that survives sleep, or the maintenance loop); every run is idempotent.
**Acceptance:** new league messages appear in `coach_threads` within 60 s of arrival; notification within 90 s; zero messages from non-league chats ever read.
**If it doesn't go great:** polling misses (chat.db WAL lag) → fall back to 2-minute polls with a 5-minute lookback; notifications too noisy → notify only on `last_msg_class ∈ {counter, reject-with-reason, accept, ultimatum, valuation-claim}`.

### Phase 9 — Trade-engine backtest (1–2 days)

Using `league_roster_history` (4a): for each week of 2024 and 2025, reconstruct every roster, run `findTrades` with the Phase-5 objective, take the top deal per partner, apply it in `tradeImpact` under the *then-current* projections, and record the title-odds delta and the realised end-of-season outcome. Placebo: random plausible trades. Drift baseline: "no trade."
**Acceptance:** recommended trades' mean title-odds delta > 0 and > placebo at 2 SE; realised points gained > 0.
**If it doesn't go great:** delta ≈ 0 → the engine is finding fair trades, not edges; tighten the objective toward `their_value` gaps; if still ≈ 0, the honest product claim becomes "finds trades people accept that don't hurt you," which is still valuable.

### Phase 10 — UI (1–2 days) — build on Trade Lab, don't replace it

**Sweep first (Nick: "the UI is fine but do a sweep").** Audit all 12 tabs and 47 endpoints in `routes/trades.js` + `routes/tradelab.js`: dead or duplicate endpoints, responses > 2 s, stale caches, console errors, numbers that disagree between tabs. Fix before adding.

Existing tabs stay: *Find deals, Target a player, Mock a trade, Title impact, Buy low, Buy the backup, Claim now, Go get them, Hold or sell, Matchups, News edge, You have him.* Add:
- **Live-data badge** (top of every page): injuries / news / rosters last refreshed, green/amber/red.
- **Find deals → tree view:** ideas grouped by partner; multi-step chains rendered as a tree; 3-team routes as a triangle; each card shows `P(accept)` as a filled bar, `their_value_delta`, ROS gain, title Δ, and the archetype hint.
- **Manager tab (new):** one card per league member — dossier summary, timing stats, position bias, endowment, recent stated valuations, trade history with Nick, "best time to send."
- **Mock a trade → Coach panel:** draft box → repositioned message, anchor, send time, don't-say list, predicted response.
- **Explain panel:** collapsible evidence blocks in strength order; every number links to its source block.
- **Projection card:** our mean vs ESPN, floor/ceiling, the top 3 drivers (e.g., "TPRR up 18% over 3 wks", "xTD −1.4 → regression", "faces 71% man, he's +0.9 ypt vs man").
- **Health page:** harness numbers (MAE vs naive, vs ESPN, coverage), backtest result, last fit date.

More offerings (Nick: "those are good but we need more"):
- **Counter an offer:** paste an incoming trade → its value both ways, P(accept) of three counters, the archetype hint.
- **Package builder:** 2-for-1 and 3-for-1 consolidation finder — who in the league needs depth, what my bench is worth to them.
- **Playoff planner:** weeks 15–17 matchups for my roster vs targets; who to own for the playoff run.
- **Deadline mode:** trade-deadline countdown; what to do by when; which partners go quiet before it (timing stats).
- **Claim-and-flip:** waiver adds that become trade chips within 2 weeks (trending + partner need).
- **Who needs what:** league-wide needs map from `partners` — positions, byes, injuries per roster.
- **Sell-high timing:** my players whose public sentiment (Phase 7) is above our projection — sell into hype.

### Phase 11 — Accounts, per-user data, and the 24/7 host (last; after everything above) (2–3 days)

Nick, 2026-09-17: *"we would need to create an account login and saved data for different users if we do this — add to the last item on the plan, after all the trade analyzer stuff."* Hosting is deferred to here on purpose: the engine gets built and proven on the Mac first.

**What exists:** `local-auth.js` (single-user pairing login, loopback vs remote detection), `req.auth.userId`, `league_memberships(user_id, league_id, role)` — the leagues route already filters by user. What is missing is real sign-up/sign-in and per-user isolation for everything added in Phases 4–8.

**Work**
1. **Accounts:** email + password (argon2) or magic-link sign-in; sessions in the DB; Nick is the admin; invite-only sign-up (no open registration).
2. **Per-user data:** every user-owned row carries `user_id` — leagues and their ESPN cookies (encrypted at rest), `manager_profiles`, `manager_notes`, `entity_map`, `coach_threads`, `tactic_exposure_log`, chat labels and profiles. A user sees only their leagues and only the counterparty data derived from *their* chats and *their* leagues' transactions. Shared, non-personal data (projections, NFL stats, news, injuries) stays global.
3. **Chat data stays personal:** the iMessage extractor runs only on the owning user's Mac and uploads labeled rows tagged with their `user_id`; no cross-user joins, ever. Nick's private DB never becomes someone else's feature.
4. **24/7 host (Fly.io Machines, Nick's account):** `fly launch` with a persistent volume for the SQLite files, secrets for the Anthropic/gateway keys, the refresh loop as a second process, HTTPS on the Fly URL, invite-only login on top. The Mac keeps only the chat relay (Phase 8b). Cut-over = copy `server/data.sqlite` + `data/derived/player_value.sqlite`, verify a full refresh tick on the host, point Nick's phone at the URL.
5. **Spend guardrails per user:** Explain/Coach/synthesis calls metered per user per day; Jev and Anthropic budgets are Nick's, so a second user's calls are capped or need their own keys.

**Acceptance:** two accounts (Nick + one invited friend) each see only their own leagues, cookies, profiles, and chat-derived data; a full refresh tick runs on the host in < 2 min; the Mac can be closed and the app still answers from a phone.
**If it doesn't go great:** volume I/O too slow for the 635 MB DB → move the read-heavy NFL tables to a read replica or LiteFS; friend's ESPN cookies fail → their leagues show `needs_reconnect`, never Nick's data.

### Where Jev fits (Nick: "we have Jev so that could help MASSIVELY")
1. League-chat labels (4c) — running.
2. Presser corpus — fantasy questions over the 10,670 pressers: role expansion, committee, target-share promises; `coach_hedging` already labeled.
3. Typed news extraction fallback (Phase 0) when the Anthropic key is unavailable — choice/score questions over `news_items`.
4. Coach (Phase 8) — second opinion on wording: "reads as a lowball?", predicted reply tone.
5. P(accept) second opinion (Phase 5) — boolean "would a manager with this dossier accept this package?" as one feature in the logistic; kept only if held-out Brier improves.
Budget: each run ≤ $1 without asking; check `GET https://ai-gateway.vercel.sh/v1/credits` before every run (balance $9.96 on 2026-09-17).

### Timeline (Nick: "figure out how long this whole thing will take")

| Phase | Days | Depends on |
|---|---|---|
| 0 Live data | 0.5–1 | key from Nick |
| 1 Projection | 3–5 | 0 |
| 2 Consensus gate | 1 | 1 |
| 3 ROS value | 1 | 2 |
| 4 Counterparty | 2–3 | 0 (runs beside 1–3) |
| 5 Game theory | 2–3 | 3, 4 |
| 6 Find | 1–2 | 5 |
| 7 Explain | 1 | 6 |
| 8 Coach | 1 | 4, 7 |
| 9 Backtest | 1–2 | 6 |
| 10 UI | 1–2 | 6–9 |
| 11 Accounts + host | 2–3 | 10 (last) |

Sequential: **16.5–25 working days** (Phase 11 added). With Phase 4 in parallel with 1–3 and agents on separate phases: **~12–15 working days, about three calendar weeks.** First visible change (Phase 0 + 1a) inside one day of the go.

---

## 5. Weighting — how components combine

1. **Projection blend:** convex weights fitted by the existing cutoff-safe procedure (2023 fit → 2024 select → next season one-shot). Never hand-set. Re-fit weekly as data accrues; promote only if the gate passes.
2. **Feature families in the ML head:** included only if `nfl-family-contribution` lift is positive with BH-adjusted p < 0.10 across families.
3. **Trade ranking:** `score = P(accept) × my_ros_gain − λ|their_value_delta|⁺`, λ fitted so the top-10 acceptance rate in the backtest is maximised subject to mean gain > 0. Start λ = 0.3.
4. **ROS value:** weeks weighted by `P(active)`; playoff weeks ×1.5 if playoff odds > 40%.
5. **Explain strength tags:** `decisive` = family lift ≥ 5% or title Δ ≥ 3pp; `strong` ≥ 2%; `supporting` > 0; `weak` = qualitative only (chat sentiment, dossier).
6. **P(accept) inputs:** standardised; regularised logistic; timing and recent-loss as interactions, not main effects.

## 6. Harness and rules every agent follows

- **Walk-forward, season-blocked.** Fit on prior seasons; grade on the held-out one. `replaySeasonWeekly(season, {predictionHead: fn})` is the harness; `predictionHead` is a **function**.
- **Baselines:** season_to_date is the floor; ESPN consensus (Phase 2) is the bar.
- **Placebo before any sweep.** Shuffle labels/direction/time; the null must null.
- **Drift baseline for any CLV/timing claim:** always-favourite / always-home first.
- **Cluster by game** (player-weeks in a game are not independent).
- **Bet-everything control** for anything priced.
- **Report the whole family** searched; BH across it.
- **Controls before spend:** gates run **before** expensive labeling, never alongside it ($4.51 was burned tonight by running them in parallel).
- **One workflow at a time** on this 8-core Mac against the 18 GB archive. Scan `ps -eo pcpu,args | grep Python.framework` by cwd after every run; `TaskStop` does not kill children.
- **Databases read-only** except the designated writes: `weekly_ensemble_fits`, `nfl_player_feature_vectors`, `espn_player_market`, `league_transactions*`, `live_data_health`, `off_sleeper_players`, `jev_chat_signals` (private DB only).
- **Privacy:** `data/derived/league_chat.sqlite` never leaves the machine except to Jev (standard retention, Nick's choice 2026-09-17). Never commit it. Never paste message text into logs or docs.
- **Budget (Nick: "pls dont run up my bofa card", "for API stuff keep it low"):** no new paid data or subscriptions; Jev runs ≤ $1 each without asking and check the balance first; Claude workflows one at a time. Anthropic API: `nfl_news_signals` runs on Haiku 4.5, hourly not every 15 min, only on new `news_items`; Explain/Coach calls are on-demand and cached per (trade, day); no background loops on Opus/Sonnet.
- **Focus (Nick: "the ideas should be focused not all over the place"):** an addition enters this plan only if it serves one of the three jobs (projection, counterparty, trade engine) or Phase 0. Everything else goes to the backlog in section 10 or is dropped.
- **Storage:** `storage_watch.sh` stays in the maintenance loop; checkpoint WALs over 512 MB; `.metadata_never_index` on every new data directory.

## 7. If the whole thing doesn't go great — the honest tree

```
Phase 1f can't beat naive by 5%?
  → ship 1a–1e (strictly better), anchor on ESPN mean (Phase 2), pour effort into Phases 4–8.
Phase 2 slope ≈ 0 (our disagreements carry no information)?
  → same: the edge is the person, not the market. This is expected and fine.
Phase 4d AUC < 0.60?
  → ESPN + endowment only; dossier stays qualitative.
Phase 5 proposal history < 100 decided?
  → heuristic P(accept) as a band; collect forward; refit in 8 weeks.
Phase 9 delta ≈ 0?
  → the engine finds acceptable, non-harmful trades. Say so on the page.
Everything ≈ 0?
  → the product is still: live data that doesn't lie, a projection that beats naive, a
    distribution you can trust, a manager dossier nobody else has, and a coach. That is
    materially better than today, and every number on the page is real.
```

## 8. Outside materials authorised by Nick

- **Sleeper API** (`api.sleeper.app`) — injuries, status, depth, trending adds/drops. Free, no key. Use it.
- **nflverse / ffopportunity** releases — already ingested; keep current.
- **ESPN public APIs** (`lm-api-reads.fantasy.espn.com`) — leagues, transactions, rosters by period, `kona_player_info`. Cookies are live.
- **FantasyCalc** (already in `dynasty_values`) — refresh weekly for redraft values.
- **Open-source benchmarks** — permitted for method comparison only (e.g., ffopportunity, nflfastR-based projection repos). Cite; do not copy GPL code into the repo.
- **GitHub, specifically:** `nflverse/nflverse-data` releases (pbp, participation, NGS, snap counts, injuries, depth charts, FTN charting); `ffverse/ffopportunity` (xFP, already ingested); `ffverse/ffsimulator` (season-sim method — compare with `season-sim.js`); `ffverse/ffscrapr` (MIT; ESPN/Sleeper endpoint shapes incl. `mTransactions2`, `kona_player_info` — read for API knowledge); `nflverse/nfl_data_py`; `dynastyprocess/data` (values — use only for the name-brand-premium proxy, all leagues are redraft). FantasyPros ECR public pages as a consensus-rank anchor (respect rate limits). Pro-Football-Reference only if `snap_counts` cannot give OL continuity.
- **Not to be used:** anything that requires scraping a sportsbook, paid PFF data unless Nick supplies a license, or any source that cannot be re-fetched reproducibly.

## 9. What is needed from Nick before starting

1. **Anthropic API key, workspace-scoped** → `.env` `ANTHROPIC_API_KEY`. Unblocks typed news signals (Phase 0) and the Explain/Coach layers. *Pending — Nick is replacing it locally.*
2. **Privacy choice for the chat layer** — **answered 2026-09-17: standard retention, no upgrade.** Jev labels the chat without ZDR; the private DB still never leaves the machine otherwise.
3. **OK to pull 2023–25 league history from ESPN** (transactions, drafts, weekly rosters, all 5 leagues, read-only with live cookies) — **approved 2026-09-17.**
4. **OK to run an external 15-minute refresh loop** for injuries/news/rosters, replacing the in-server scheduler that hung the app — **approved 2026-09-17.**
5. **Haiden Bonczek = ESPN roster 7 ("Aiden Smith")** — **confirmed 2026-09-17.**
6. **Go on Phase 0 and Phase 1a.** *Phase 0 started 2026-09-17 (refresh loop live, news signals live, roster-sync bug fixed). 1a still pending explicit go — it changes live recommendations.*

From the Coach playbook — **answered 2026-09-17:**
7. Neutral reference: Nick asked whether pointing at one loses leverage. Resolved: the Coach cites an outside number (ESPN) **only as a closing move** — gap < 10 % after ≥ 2 counters — and **only when that number is at or above Nick's floor**. If the referee number favours them, it is never introduced. Pointing early, or at a number against you, is what loses leverage; pointing late at a number on your side is what ends a stall.
8. A/B test: **no** — Nick prefers to trust it. Measurement falls back to predicted-vs-realised acceptance (is P(accept) calibrated on coached threads?) and season-over-season acceptance rate, both confounded but honest about it.
9. Conditional picks / side deals: **no** → contingent-contract tactic (T16) disabled in every league.
10. Concession ladder: **live, step by step** — "people are unpredictable." The ladder's floor is still fixed before message 1 (so the Coach can never concede below it), but each step is chosen from the counterparty's actual reply. **This requires the live chat monitor (Phase 8b).**
Decided without asking: `coach_threads` and `tactic_exposure_log` live in the private `league_chat.sqlite`, never the main DB.
11. **Hosting for 24/7 access** — deferred by Nick to Phase 11 ("ill do it later"); when ready, pick one and create the account yourself (I cannot create accounts or enter payment details): (a) **Fly.io** — stable `https://<app>.fly.dev` URL, no domain, built-in HTTPS, ~$5–7/mo for a small VM + 3 GB volume; (b) **Hetzner CX22 + Tailscale** — ~€4/mo, private (only your phone on the VPN can reach it), no public URL. Recommended: (a) for simplicity. I prepare the Dockerfile/systemd unit, data upload, secrets list, and the cut-over; you run the two login commands.

---

*Every claim above is traceable to a measurement made 2026-09-17 in this repo. The betting-side registry (`docs/betting-model/research/EDGE-TEST-REGISTRY.md`, sections A–Z) holds the methodology that produced them.*

## 10. Not worth our time — and the backlog

Nick asked for the "what is not worth our time" list. Deliberately skipped:
- Beating the closing line for game-script **means** (r² = 0.03; the betting oracle test measured the ceiling at zero). Distribution only.
- Dynasty values and pick valuation — every league is redraft.
- Props as a betting market (no liquidity) — prop **lines** as an anchor are fine (1g).
- DFS or lineup-optimizer work.
- A 16th reweighting of the same FP series as a "new head".
- Hand-tuned weights of any kind.
- A local LLM for chat labeling — Jev does the whole corpus for ~$1.
- Scraping sportsbooks or paid data.

Backlog (mentioned, deferred, not in any phase): three-team routes beyond 10/week; Reddit/Twitter sentiment; a DK/FD prop scraper; Kalshi/Polymarket anything.
