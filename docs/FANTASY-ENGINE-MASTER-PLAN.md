# Gridiron HQ — Fantasy Engine Overhaul: Master Plan

**Status:** approved plan, not yet started. Written 2026-09-17 for execution by Claude agents (Opus / Sonnet).
**Owner:** Nick Matta. **Repo:** `/Users/nick_matta/Documents/GitHub/gridiron-hq`.
**Read this whole document before touching anything.** Every number in it was measured this week, with code, and the acceptance criteria are anchored to those numbers.

---

## 0. What this is, in one paragraph

The fantasy trade engine (`server/services/trade-engine.js`, 1,515 lines) is well-built — lineup solver, market value as a separate axis, red flags, sim-verified verdicts — and it is standing on a projection that **loses to a moving average**, valuing both sides of every deal with *our* number instead of the counterparty's. The overhaul has three jobs: (1) make the projection genuinely good by feeding it information it has never seen, (2) model the *ten people Nick actually trades with* rather than the market, and (3) turn that into a trade engine that finds deals people accept, explains them from everything it knows, and coaches what to say. Live news and injury data is a hard prerequisite and it is currently half-broken.

---

## 1. State of the system — measured, not assumed

### 1.1 The projection foundation is cracked

Walk-forward, weeks 5–18, PPR, truth = `player_week_usage`, harness = `server/services/weekly-backtest.js#replaySeasonWeekly`:

```
2025 one-shot MAE   structural (buildProjections) 4.749
                    PRODUCTION (frozen 2023 weights) 4.455
                    season_to_date (naive)           4.386
                    ensemble_global (FITTED)          4.334   gate PASS, p=0.999 vs naive
per season 2021–25  structural loses to season_to_date by 2.8–6.2% MAE and on Spearman, every year
```

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

### 1.5 The leagues

All five are ESPN **redraft, PPR, 10-team** (one 8-team), all `connected`. "Long term" = rest-of-season + playoff weeks 15–17, **not** dynasty. Focus league for the counterparty work: id 4 "Transfer portal" (Nick = roster 5).

Roster map from chat → ESPN: Raj=1, Rami=2, Parth=4, Nick=5, Christian=8, Josh=9, Lars=10, Anthony (Vass)=11, Zach=12. **Haiden Bonczek ↔ roster 7 "Aiden Smith" — unconfirmed, ask Nick.**

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

**Acceptance:** all six feeds show `last_ok_at` within their cadence for 24 h straight; week-3 injury rows present by Thursday 08:00Z; `nfl_news_signals` inserts rows; server HTTP p95 < 500 ms under the external runner.
**If it doesn't go great:** nflverse late → Sleeper becomes primary for status until nflverse catches up; Anthropic key unavailable → typed signals fall back to a regex/keyword extractor over `news_items` (out / questionable / activated / IR / placed / designated), lower recall, never silent.

### Phase 1 — Projection foundation ⛔ (3–5 days)

**1a. Persist the validated fit (hours).** Run `scripts/fit-weekly-ensemble.mjs`, persist via `saveWeeklyFit({...promoted:1})`, verify `activeWeeklyWeightSet()` returns `source:'adaptive'`, re-run `replaySeasonWeekly(2025, {predictionHead: ctx => weeklyEnsemblePrediction(ctx, weights)})` and confirm MAE ≤ 4.34.
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

**4b. Behavioural profile (1 day).** Per manager: auto-drafter score (pick-vs-ADP distance, pick latency), waiver aggressiveness and recency (claims within 24 h of a box score), lineup discipline (byes left in), trade frequency, **accepted-value ratio** (what they took vs gave, by our value), counter rate, response latency, position bias, endowment effect (sell ratio − buy ratio), name-brand premium (prior-year ADP − current value of roster), panic-sell (drops after one bad week), buy-high. Plus the chat timing stats already computed (reply p50/p90, initiates%, unanswered%, night%).

**4c. Chat dossier + Jev labels (1 day; PLANNED, gated on Nick's privacy choice).**
- *Understand (Claude, once):* read the group thread and each DM whole; reconstruct conversations (`reply_to`, bursts < 2 min, name continuity); build an entity map (nicknames → people, team names → people, player nicknames → players); write a **dossier** per manager: role in chat, stated valuations with dates, confidence pattern and whether it was right, trade posture, loss reactions, what they respond to.
- *Label (Jev, at scale):* `scripts/news-line/jev_league_chat.mts` — topic, confidence, tone, own-roster sentiment, player sentiment (player pre-extracted), open-to-trade, reacting-to-loss — with the dossier line as context. ~$0.15. **Requires `providerOptions.gateway.zeroDataRetention:true`, which is Vercel Pro-only. Do not send without it unless Nick chooses to.**
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

### Phase 7 — Explain from everything (1 day)

Rebuild the `trade-explain` payload so Claude receives, per player on each side, a structured evidence block:
- projection: our mean, ESPN mean, delta, floor/ceiling, ROS and playoff value, confidence (from 80% coverage)
- efficiency: xFP regression sign, APM value, NGS skill flags
- opportunity: TPRR, snap Δ, redistribution note if a teammate is out, red-zone role
- matchup: next 3 weeks' coverage/pressure/run-defense fit; playoff-weeks SOS
- availability: status, practice pattern, team dialect P(play), first-game-back flag, news signals (typed, with source and time)
- market: `their_value`, endowment/name-brand adjustments, ESPN rank/ADP/%rostered
- counterparty: archetype, stated valuations from chat (with dates), timing stats, predicted response, P(accept)
- sim: title/playoff delta for both sides, seed, runs
- **weights:** each block tagged `strength ∈ {decisive, strong, supporting, weak}` from its measured lift, so the explanation leads with what actually decides the deal.
Prompt rule: argue only from the blocks; cite the block; never invent a number. Keep the propose→verify→retry loop from `trade-verify.js`.
**Acceptance:** a blind read-through of 20 explanations finds zero uncited numbers; each explanation names the decisive block first.

### Phase 8 — The Coach (1 day)

`POST /:leagueId/coach` with `{targetRosterId, package, draft}` → `{message, anchor, send_at, dont_say[], predicted_response, p_accept}`. Inputs: dossier, timing stats, recent thread, package numbers, anchoring ladder. Output tuned to the person (numbers-forward vs casual; length from their reply style). Reposition Nick's draft rather than replace it.
**Acceptance:** Nick rates ≥ 8/10 of coached messages as "I'd send that" in a first pass.

### Phase 9 — Trade-engine backtest (1–2 days)

Using `league_roster_history` (4a): for each week of 2024 and 2025, reconstruct every roster, run `findTrades` with the Phase-5 objective, take the top deal per partner, apply it in `tradeImpact` under the *then-current* projections, and record the title-odds delta and the realised end-of-season outcome. Placebo: random plausible trades. Drift baseline: "no trade."
**Acceptance:** recommended trades' mean title-odds delta > 0 and > placebo at 2 SE; realised points gained > 0.
**If it doesn't go great:** delta ≈ 0 → the engine is finding fair trades, not edges; tighten the objective toward `their_value` gaps; if still ≈ 0, the honest product claim becomes "finds trades people accept that don't hurt you," which is still valuable.

### Phase 10 — UI (1–2 days) — build on Trade Lab, don't replace it

Existing tabs stay: *Find deals, Target a player, Mock a trade, Title impact, Buy low, Buy the backup, Claim now, Go get them, Hold or sell, Matchups, News edge, You have him.* Add:
- **Live-data badge** (top of every page): injuries / news / rosters last refreshed, green/amber/red.
- **Find deals → tree view:** ideas grouped by partner; multi-step chains rendered as a tree; 3-team routes as a triangle; each card shows `P(accept)` as a filled bar, `their_value_delta`, ROS gain, title Δ, and the archetype hint.
- **Manager tab (new):** one card per league member — dossier summary, timing stats, position bias, endowment, recent stated valuations, trade history with Nick, "best time to send."
- **Mock a trade → Coach panel:** draft box → repositioned message, anchor, send time, don't-say list, predicted response.
- **Explain panel:** collapsible evidence blocks in strength order; every number links to its source block.
- **Projection card:** our mean vs ESPN, floor/ceiling, the top 3 drivers (e.g., "TPRR up 18% over 3 wks", "xTD −1.4 → regression", "faces 71% man, he's +0.9 ypt vs man").
- **Health page:** harness numbers (MAE vs naive, vs ESPN, coverage), backtest result, last fit date.

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
- **Privacy:** `data/derived/league_chat.sqlite` never leaves the machine except to Jev with ZDR. Never commit it. Never paste message text into logs or docs.

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
- **Not to be used:** anything that requires scraping a sportsbook, paid PFF data unless Nick supplies a license, or any source that cannot be re-fetched reproducibly.

## 9. What is needed from Nick before starting

1. **Anthropic API key, workspace-scoped** → `.env` `ANTHROPIC_API_KEY`. Unblocks typed news signals (Phase 0) and the Explain/Coach layers.
2. **Privacy choice for the chat layer:** Vercel Pro for Jev ZDR (~$20/mo) / fully local model / standard retention. Default if unanswered: **dossier is built by Claude in-session once; Jev labeling waits.**
3. **OK to pull 2023–25 league history from ESPN** (transactions, drafts, rosters by week) for all 5 leagues. Read-only, his cookies.
4. **OK to install the external live-data refresh loop** (a nohup/cron loop, every 15 min) — this replaces the in-server scheduler that hung the app.
5. **Confirm Haiden Bonczek = ESPN roster 7 ("Aiden Smith")** in the Transfer portal league.
6. **Go on Phase 0 and Phase 1a.** Both are unambiguous improvements; everything else gates on them.

---

*Every claim above is traceable to a measurement made 2026-09-17 in this repo. The betting-side registry (`docs/betting-model/research/EDGE-TEST-REGISTRY.md`, sections A–Z) holds the methodology that produced them.*
