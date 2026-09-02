# NFL Profitability Plan

**Version 1.3 · 2026-09-02** (1.2 · 2026-09-01)

This is the execution plan that follows from the completed model diagnostic.
It is not a promise of profit. Its purpose is to make a profitable result
possible to demonstrate without manufacturing one through hindsight,
multiple-testing, duplicated bets, or optimistic staking.

The governing distinction is:

1. **Prediction edge** — estimate an outcome more accurately than the market.
2. **Execution edge** — obtain a better number or price than the market
   consensus without needing to predict the game better.

Gridiron HQ has not demonstrated the first on NFL sides or totals. It has
demonstrated the second historically through line shopping and price-sensitive
Wong teasers. Player props remain open because real prices only started being
captured on 2026-08-27.

---

## 0. Current work queue — audit findings come first

This is the canonical "what needs to get done" list. Its ordering is binding:
the cutoff-safe audit is a diagnostic instrument, so every reproducible
failure it reveals is triaged before speculative model expansion. A task is not
closed because a run eventually completed; it closes only after the failure is
explained, fixed, covered by a regression test, and observed working in a clean
rerun.

### Measured baseline — audit run 8, completed 2026-09-01

This is the result the next iteration must beat. It is a 2022–2025 historical,
chronological, algorithmically blind reconstruction across Weeks 5–18. It is a
valid diagnostic, not an untouched profitability claim; only the preregistered
2026 forward ledger can provide that evidence.

| Measurement | Result |
|---|---:|
| Games evaluated | 831 |
| Weeks opened | 56 / 56 |
| Paper selections | 113 |
| Record | 55–57–1 |
| Win rate, pushes excluded | 49.1% |
| Units | -6.242 |
| ROI | -5.52% |
| Coordinator-ready games | 700 / 831 |
| Deep gameplay coverage | 769 / 831 |

The selector did not beat the market. Component agreement also failed to show
a reliable edge: agreed components won 50.63% versus 45.45% when scattered, but
the 5.2-point split was inside sampling noise (`z = 0.50`). Context agreement
was worse in this sample (34.78% versus 51.61%), but that split was also not
statistically reliable (`z = -1.38`). These buckets must not be converted into
new filters merely because one looks better after the result is visible.

#### Specialist coverage and directional baseline

| Specialist | Coverage | Directional accuracy | Audit finding |
|---|---:|---:|---|
| Rulebook | 100% | 46.24% | Reporting, below chance |
| Player builder | 100% | 51.42% | Best fully covered specialist |
| Game replay | 100% | 46.91% | Simulation requires recalibration |
| Similar games | 100% | 48.71% | Analogs did not add directional edge |
| Boosted tree | 100% | 51.60% | Best full-coverage directional rate |
| Neural residual | 98.07% | 51.70% | Best rate; 16 missing observations |
| Specialist team | 100% | 49.04% | Only 312 directional calls |
| Player opportunity | 100% | n/a | Usage output, not a spread call |
| Line movement | 0% | n/a | Historical quote tape unavailable |
| Verified-news reaction | 0% | n/a | Historical verified news unavailable |
| Live updater | 0% | n/a | Possession ledger was not yet built |
| Price shopper | 0% | n/a | Historical multi-book prices unavailable |

The interface's apparent "9 reporting" count was misleading. Eight specialists
had an observed supporting output, only seven made any spread-direction calls,
and four had zero historical coverage. The engine must expose these distinctions
instead of collapsing support, prediction, execution, and live models into one
ambiguous reporting number.

The postgame pass captured 560 player faults, 3,354 usage surprises, 176
structural trends, and variance markers for explosive plays (629 games),
non-offensive scores (177), turnovers (126), and reversed challenges (17).
Those records are diagnostic inputs for the weekly learning loop below; they do
not by themselves establish that a causal lesson is correct.

### Priority 0 — the 2026-09-02 full-codebase diagnostic (binding before Week 1)

Every line of the repository was read on 2026-09-02 and checked against the
live database (`docs/DIAGNOSTIC_2026_09_02.md`). The findings change what
"before Week 1" means. Items marked done were fixed and verified the same day;
the rest are ordered by what they do to the forward ledger.

**Budget reality.** The Odds API resets on the first of each month. 498 of 500
September credits were spent within 29 hours of the reset by the MLB pregame
capture, so there are no paid multi-book quotes for Weeks 1–4 regardless of any
other fix. The A2 targets (T-24h and T-1h at ≥90% coverage) are therefore
unreachable this month on the free tier. The reserve now lives inside the odds
client and cannot be bypassed; MLB quotes are opt-in; the daemon stops
retrying. This prevents a repeat, it does not recover September.

- [x] One credit reserve, enforced in `odds-api.js`, with `reserveStatus()`,
  an `odds_quota_exhausted` alert, and `skipped` (not `ok`) job status.
- [x] Scores land from ESPN finals without an odds object; opening lines read
  from the real field path; `neutral_site` and venue roof recorded.
- [x] A week is finalized only when every game in it is final.
- [x] Neutral-site games carry no home-field advantage in the ensemble or the
  simulator (LAR v SF, Melbourne, 2026-09-10).
- [x] Cover-calibration lookup uses the version the calibrator writes.
- [x] Model-derived stake is 0 units in code, not only in prose.
- [x] Settlement requires both scores; risk-lab and neural rows settle per
  horizon; prop closes exclude the quote's own capture.
- [x] Week 1 forward captures exist: GBM prior-season fallback, coordinator row
  unblocked, council errors surfaced, `nfl_decision_ledger` job every 3 hours,
  council added to the manual capture route, routes default to the live week.
- [x] Washington play-by-play join, preseason plays filed as regular season,
  availability edge on a missing injury feed.
- [x] Forward ledger, Ensemble and Variables pages reachable in the workbench.
- [x] **Second quote provider built (SportsGameOdds), opt-in.** Rather than
  wait on the owner's account decision, `server/services/sportsgameodds.js`
  ships as complete, dormant infrastructure: a no-op without
  `SPORTSGAMEODDS_API_KEY`, and once a free account exists and the key is set,
  it captures spreads/totals/moneylines from up to 9 books into the same
  `nfl_line_snapshots` table the Odds API path writes — every existing
  consumer (shopping board, sharp divergence, specialist movement feature,
  bet routing) reads it unchanged. Wired into the evidence daemon (fills in
  when the Odds API reserve is held) and a `nfl_sgo_snapshot` scheduler job,
  on its own 2,500-object budget that never touches the Odds API reserve.
  **Still the owner's decision to actually create the account** — upgrading
  The Odds API ($30/month, 20K credits) is the other option. The parser was
  built from SportsGameOdds' published docs, not a live key; check
  `events_matched` on the first real capture before trusting it.
- [x] Remove the line-movement leak in `nfl-specialists.js` — snapshot moves
  are now keyed by (team, kickoff date), not team alone; verified a 2026
  snapshot no longer attaches to an otherwise-identical 2016 game.
- [x] Choose orthogonal-specialist influence on a block that is not the one
  reported as validation — split into train/tune/report chronological blocks.
- [x] Sign the line edge in `nfl-execution.js#rankBooks` — verified against the
  real margin distribution that the router now prefers the better number.
- [x] Fix capture-trigger dedup scope: the trigger-queue's state update now
  targets only the exact batch of ids just considered, not every outstanding
  row.
- [x] Replace substring team matching in `nfl-news-market-latency.js` — full
  team name only; regression test confirms the Minnesota/Tennessee/New
  Orleans/New York collisions are gone.
- [x] Apply between-season carryover to the upcoming season in `nfl-market.js`,
  and zero home-field advantage on neutral-site games there too (it already
  was fixed in the ensemble and simulator in round 1).
- [x] Join officials to games, not weeks — resolved via nflverse's
  `old_game_id` crosswalk at ingest; verified live: 21,977 of 22,012
  assignments matched, `refereeTotals()` now returns 3,014 referee-games
  instead of the old 44,392.
- [x] **Free multi-book quotes, no key, no credits** (`server/services/book-feeds.js`,
  2026-09-02 round 3). Four public endpoints, each isolated: the OddsTrader
  aggregator that `sbrscrape` (github.com/nkgilley/sbrscrape) reads (11 books
  in one call with a per-book change stamp), **Pinnacle's guest API** (the
  sharp reference this plan has wanted, previously 4 credits a call), Kambi
  (BetRivers) and Bovada. Verified live: one capture wrote 1,354 quotes from
  11 books across 47 games. Same game keyed identically across feeds; a book
  present in two feeds is kept from the more direct one. Scheduled hourly
  (`nfl_book_feeds`) and run at every evidence-daemon NFL window. Set
  `FREE_BOOK_FEEDS=0` to disable. These are the books' own undocumented site
  endpoints; DraftKings and Caesars block server requests and are not read.
- [x] Provider-agnostic snapshot columns: `nfl_line_snapshots.provider` and
  `book_updated_at` (Odds API, SportsGameOdds and each free feed write through
  the same row shape). The immutable `nfl_quote_tape` now has real producers:
  every Odds API snapshot and every free-feed capture is appended.
- [x] **Line movement source = Polymarket** (`server/services/polymarket-lines.js`).
  Polymarket lists every game with an alternate-spread ladder and a totals
  ladder, and `polymarket.js` has stored their books every 30 minutes since
  2026-08-29. The point where the ladder's cover probability crosses 50% is
  the market's implied spread/total; it is read off every capture with a
  monotone (isotonic) fit so a thin leg's placeholder midpoint cannot invent
  a crossing, legs with a real two-sided book are preferred, out-of-band
  crossings are rejected, and a move is logged only when the number shifts
  ≥0.5. Rebuilt from stored quotes: 57 games (Weeks 1–4), 90 material moves
  since 08-29, implied openers within half a point of the books. Feeds the
  capture dispatcher, the news→market latency measurement (unioned with the
  ESPN log), and the movement panel. Scheduled every 15 minutes.
- [x] The sharp board reads stored snapshots first (Pinnacle from the free
  feed) and only spends a metered `eu` call when nothing recent is stored and
  the reserve allows it. `provenance` says which.
- [x] One forward-sample target: `FORWARD_SAMPLE_TARGETS` in `nfl-policy.js`
  (200 overall, 75 per market, per §2) replaces the 250/250/200/200 copies in
  four services.
- [x] One team-code map, one name normalizer, one cutoff representation:
  `team-codes.js` (`canonicalTeamCode`, `espnTeamCode`, `teamResolver`,
  `normalizeToken`, `LEGACY_CODE_PAIRS`) now backs gamescript (nflverse and
  ESPN sync), nfl-advanced (`normalizeDepthTeam`, `reconcileHistoricalTeamCodes`,
  which now also reconciles `game_lines` so OAK/SD/STL games belong to LV/LAC/LAR
  in the ratings walk), book-feeds and polymarket-lines, sportsgameodds,
  postgame truth (WAS/WSH on both sides of the play join) and news latency.
  `game-cutoff.js` is the one kickoff cutoff; the unified engine and roster
  strength had used the scheduled kickoff and the end of the game day
  respectively for the same game.
- [x] Audit names reconciled: the 2021–25 replay is the **historical
  diagnostic** (`historical_diagnostic` in profitability readiness and the
  diagnostic; the preregistration label and protocol say so), and **blind
  audit** means the preregistered 2026 forward ledger. UI labels follow.
- [x] `nfl-market.js` selects alpha/carryover on every season before the last
  completed one, holds that season out, and reports `fitWindow` with the
  selection score, the held-out score of the chosen pair and the pair
  hindsight would have picked.

**Operating rules added by this diagnostic.**

1. The server must be running at every capture window. Nothing here survives
   the app being closed on a Sunday.
2. A job that does no work records `skipped`. Freshness views must not show a
   capture that did not happen.
3. Missing evidence is null, never zero. The availability edge, the injury
   burden, and every specialist opinion abstain when their source is absent.
4. Any new metered call goes through `odds-api.js#get()`. No direct `fetch` to
   a paid endpoint.
5. Every "authority: shadow" field must be paired with a code path that refuses
   the stake; a string on a returned object is documentation.

### Priority 1 — close everything revealed by audit run 8

- [ ] Publish the final run manifest: exact code/data hashes, coverage, timing,
  failures, retries, results, calibration, and year-by-year measurements.
- [ ] Replace the misleading "nine reporting" display with a game × specialist
  matrix. Distinguish the eight observed supporting outputs, seven directional
  callers, four zero-coverage modules, intentional lifecycle differences, and
  genuine errors. Make every missing opinion explicit.
- [ ] Make all twelve specialists report reliably whenever their required
  cutoff-safe evidence exists. Never silently replace a missing opinion with
  zero.
- [ ] Verify that the combined decision records the contributing specialists,
  their raw opinions, learned weights, normalized weights, disagreement, final
  prediction, selected side, price, and settlement for every game.
- [ ] Diagnose accuracy and calibration by season, week, matchup type, market,
  specialist, confidence bucket, and data-coverage bucket. Treat 2021 as
  quarantined evidence unless its missing fields are genuinely repaired.
- [ ] Trace every failure, stall, lock, timeout, misleading counter, and retry
  from this rebuild. Add resumability and regression coverage for each one.
- [ ] Verify all 831 pregame cards contain only evidence available before their
  kickoffs; flag late, undated, reconstructed, or unverifiable inputs.
- [ ] Confirm that postgame truth cannot leak backward into the prediction it
  grades, while still becoming eligible evidence for the following week.
- [ ] Re-run the correctly named historical diagnostic after fixes, then leave
  the preregistered 2026 forward ledger untouched.

### Priority 2 — reliability, speed, progress, and UI

- [ ] Turn the rebuild into a one-command, crash-safe workflow that resumes from
  durable checkpoints without duplicate rows or manual database repair.
- [ ] Put bounded timeouts, retries, SQLite writer coordination, source-health
  checks, and actionable error messages around every loader and audit phase.
- [ ] Measure phase and per-game latency; remove repeated full-table work and
  cache immutable inventories. Set and enforce a performance budget.
- [ ] Show live counters for source rows, seasons, weeks, games, possessions,
  settlements, errors, retries, elapsed time, processing rate, and ETA.
- [ ] Redesign the audit UI around one honest path: coverage → frozen evidence →
  specialist opinions → combined decision → game result → postgame lesson.
- [ ] Make unavailable data say exactly what is missing, why it matters, whether
  the model continued, and the next recovery action. Never show "blocked" as a
  context-free KPI.
- [ ] Add per-model reporting and correctness views, ensemble-weight inspection,
  year/week filters, data-lineage drill-down, and a clean game-by-game snapshot.
- [ ] Run startup, image/data loading, empty-state, partial-source, reconnect,
  concurrent-writer, and interrupted-rebuild tests on the packaged Mac and
  Windows flows.

#### Speed contract and budgets

Speed is part of model quality. A slow capture can miss a price, a slow rebuild
reduces the number of honest experiments that can be run, and a frozen UI hides
failures. Every material path therefore records wall-clock duration, rows or
games processed, cache state, and peak payload size. Measurements are taken on
the packaged local application after one cold run and at least three warm runs.

| Path | Initial budget | Required behavior |
|---|---:|---|
| Warm application start | under 2 seconds | Health check is cached; a full database scan is explicit maintenance, never an import side effect. |
| Health and progress APIs | p95 under 100 ms | No model rebuild, data sync, or full-table hash on a read request. |
| Dashboard summary APIs | p95 under 250 ms and under 250 KB | Return summaries; large traces load only on demand with a bounded page or week limit. |
| Game/audit drill-down | p95 under 1 second and under 1 MB | Paginated, cancellable, and never returns the full multi-year trace implicitly. |
| Progress heartbeat | at least every second | Includes elapsed time, phase, throughput, ETA, retry count, and last durable checkpoint. |
| Checkpoint persistence | under 250 ms outside model compute | One writer, bounded transaction, idempotent resume key. |
| Weekly rebuild | continuously measured | Freeze check, feature build, model inference, postgame work, and persistence are timed separately. |

The first completed speed repair reduced the blind-audit summary response from
47.9 MB to 45 KB and its measured warm latency from roughly 722 ms to 2–5 ms.
Audit input verification now uses a persistent mutation journal and performs a
full content hash only after relevant source data changes. These measurements
are regression baselines, not permission to stop profiling.

The second speed repair (2026-09-02) moved every replay-backed read off the
request thread. Measured on the live server, the abstention audit took 267 s
and the football-first walk-forward 74 s of synchronous CPU per cold read, and
because Node serves every request on one thread a 170 ms profitability read
timed out at 120 s behind them. `server/services/report-cache.js` now computes
the abstention audit, NFL diagnostic, walk-forward, confidence calibration and
football-first coefficient fit in worker threads (own SQLite connection, WAL)
on the growth tick (`nfl_reports`, every 3 h) and stores the answer in
`nfl_cached_reports` keyed on a data fingerprint that counts scored games and
decisions rather than the hourly line refresh. The routes return the stored
answer in under 15 ms with `_report.computed_at`, `duration_ms` and `stale`,
or `{pending: true}` before the first run; they never compute inline.
`GET /api/nfl-market/reports` shows the store; `POST /reports/:name/refresh`
queues one.

Implementation order:

1. Instrument first so an optimization cannot merely move hidden work into a
   different request or process.
2. Remove accidental repeated work: full-table scans, repeated JSON parsing,
   duplicated ensemble fits, and unbounded API serialization.
3. Cache only immutable or content-addressed artifacts. Every cache key includes
   the code/model version, learning epoch, evidence cutoff, and input hash.
4. Batch independent games and feature reads while keeping one coordinated
   database writer. Parallelism may change latency, never prediction order.
5. Stream or page large traces and render the current week before historical
   detail. Cancellation must leave a durable, resumable checkpoint.
6. Add performance regression tests for payload limits and known hot paths.
   A statistically or operationally meaningful slowdown blocks release.

### Priority 3 — coordinate and strengthen the existing engine

- [ ] Learn which specialist deserves more weight for each matchup type while
  preventing duplicated signals from receiving duplicated influence.
- [ ] Preserve genuine multi-book opening, intermediate, and closing quotes with
  capture timestamps; never manufacture historical prices from a consensus row.
- [ ] Backfill verified, timestamped injury, practice, transaction, roster, and
  role news. Unverified or post-kickoff knowledge receives zero pregame weight.
- [ ] Learn from possession sequences, not only final scores, and distinguish
  genuinely forward live predictions from historical reconstructions forever.
- [ ] Separate prediction mistakes from high-variance events such as turnovers,
  drops, penalties, weather changes, and in-game injuries using counterfactual
  postgame review—without excusing genuine model errors.
- [ ] Improve player availability, usage, replacement quality, position-group
  continuity, and before/after injury impact across the full roster.
- [ ] Calibrate confidence so a stated probability is empirically trustworthy;
  report uncertainty and cap confidence when evidence is weak or specialists
  conflict.

### Priority 4 — matchup and situational evidence candidates

These are candidates, not assumed edges. Each must be cutoff-safe, ablated,
walk-forward tested, multiplicity-corrected, and rejected if it does not improve
the complete pipeline.

- Offensive-line and center/QB continuity; injury clusters and backup quality.
- Receiver/corner route matchups; QB response to pressure, blitz, coverage, and
  defensive disguise; pass-rush arrival versus release time.
- Personnel-package frequency and efficiency (11/12/13/21/22), offensive versus
  defensive personnel mismatch, motion, formation, play action, and sequencing.
- Early-down efficiency, drive conversion, explosive-play creation/prevention,
  missed tackles, coverage busts, red-zone/outside-red-zone efficiency, and
  misleading-game/garbage-time filtration.
- Neutral pace, pace when trailing, no-huddle, fourth-down choices, timeout and
  two-minute quality, halftime adjustment, and play-caller changepoints.
- Rest/preparation disparity, travel and body-clock effects, surface/venue,
  nonlinear weather interactions, schedule strength as known at the time, and
  opponent availability when interpreting prior games.
- Referee/style interactions, special-teams field-position value, kicker range,
  punt/return mismatch, and turnover regression.
- Rookie development from college production, opponent quality, combine
  evidence, draft capital, preseason role, and verified practice news.
- Sportsbook disagreement and leader/follower behavior, public overreaction,
  matchup similarity, former-team/system familiarity, and market movement after
  verified news.

### Priority 4A — weekly postgame understanding and learning loop

Every completed week must produce structured training evidence, not merely a
win/loss label. This loop runs only after games are final and may influence the
following week; it may never rewrite a prediction that has already been frozen.

1. Preserve every pregame belief: specialist opinions, assumptions, player and
   team state, weights, uncertainty, final prediction, price, and decision.
2. Reconstruct each game possession by possession with score, clock, field
   position, down/distance, personnel, formations, motion, pressure, coverage,
   substitutions, injuries, turnovers, penalties, and play success.
3. Locate the earliest point where the expected game story materially diverged
   from reality and record what changed.
4. Separate repeatable football information from high-variance events. Repeated
   protection failures can update beliefs; one tipped interception should not
   automatically rewrite a team rating.
5. Grade every specialist independently so the system can distinguish a correct
   player read from a bad simulation, a correct news signal from a bad weight,
   and a winning ensemble built from incorrect reasoning.
6. Run counterfactual replays without pivotal injuries, turnovers, drops, or
   unusual penalties to estimate whether the forecast was structurally wrong or
   the observed result was dominated by a rare event.
7. Update player availability, usage, replacement value, position-group
   continuity, team strength, coaching tendency, and scheme identity for the
   next eligible cutoff.
8. Save reusable matchup lessons with exact supporting plays, such as a
   quarterback/protection unit failing against a specific pressure family.
9. Change specialist weights gradually from repeated evidence. A single game
   can raise uncertainty, but cannot permanently redirect the engine by itself.
10. Build the following week's frozen cards only from finalized earlier games
    and timestamped current-week evidence.

Each game must emit a machine-readable and human-readable **why we were wrong**
report containing what was expected, what happened, when the game changed,
which assumptions failed, which events were likely noise, which states may need
updating, which specialist needs correction, and what future evidence would
confirm or reject the lesson.

#### Postgame reasoning safeguards

- Preserve multiple plausible explanations rather than selecting one convenient
  story after seeing the result.
- Attach source quality, sample size, uncertainty, and evidence confidence to
  every proposed lesson.
- Require delayed confirmation over the next two to four weeks before treating
  a one-game lesson as a persistent change.
- Adjust for opponent quality and opponent availability at the time of the game.
- Translate formation, motion, personnel, and sequencing evidence into readable
  coaching-tendency summaries without allowing prose to replace source data.
- Learn relationship effects: how one player's absence changes teammates,
  protection calls, formations, pace, and play selection.
- Prioritize disagreement games, near misses, correct picks made for the wrong
  reasons, and losing picks supported by otherwise sound reasoning.
- Detect league-wide concept, countermeasure, and officiating changes rather
  than mislabeling a widespread shift as a single-team change.
- Decay old lessons unless recent cutoff-safe evidence continues confirming
  them.
- Run an adversarial review that challenges hindsight bias, duplicated evidence,
  causal claims, and alternative explanations before a lesson changes weights.
- Publish a weekly **What the league taught us** report linking every proposed
  model change to its supporting games and plays.
- Grade reasoning quality separately from result quality. Winning cannot excuse
  broken reasoning, and losing cannot automatically invalidate a repeatable read.

### Priority 5 — advanced learning modules

- [ ] Play-sequence network for drive and play-call state transitions.
- [ ] Player interaction graph that propagates injuries and substitutions through
  position groups and matchup relationships.
- [ ] Matchup embeddings and a time-aware similar-game retrieval model.
- [ ] Dynamic mixture-of-specialists weighting with an explicit uncertainty
  model and regime-change detection.
- [ ] Counterfactual simulator and a full score/margin/player-outcome distribution
  rather than a single average result.
- [ ] Causal injury, coach-strategy, rookie-transfer, hidden in-game state, and
  market-closing-line models.
- [ ] An adversarial critic that records what would disprove each pick and catches
  duplicated evidence, contradictions, and unsupported confidence.
- [ ] A verified-news reader that converts sourced text into structured facts;
  the language model may extract evidence but may never create football facts.
- [ ] A self-auditing feature learner that proposes interactions and retains only
  effects that repeat across walk-forward seasons and survive the full pipeline.

#### Neural architecture — staged, shared, and uncertainty-first

The current neural stack is a useful starting point, not the intended final
architecture. It has a bounded online residual head, a five-member deep residual
ensemble, a Bayesian online challenger, and a contextual mixture-of-experts.
They remain shadow models because adding layers does not create evidence.

Build neural capability in this order:

**N0 — strong non-neural controls.** Every neural experiment is paired with a
shrunk linear/GBM control using the identical frozen rows. If the network cannot
beat the simpler control out of sample, reject it regardless of training loss.

**N1 — multi-task game encoder.** Build one cutoff-safe representation shared by
correlated heads: team plays, pass rate, sacks/scrambles, passing efficiency,
score margin, total points, and calibrated uncertainty. Each head has its own
mask, loss scale, baseline, and coverage report, so a missing prop label cannot
silently become zero. Auxiliary heads survive only when they improve the primary
head in chronological ablation.

**N2 — play-sequence network.** Encode a possession as ordered state transitions
containing score, clock, field position, down, distance, personnel, motion,
pressure, and outcome. Train only on possessions completed before the target
cutoff. Compare a compact gated recurrent/temporal-convolution model with pooled
drive summaries; keep the sequence model only if ordering adds repeatable value.

**N3 — player-interaction graph.** Nodes represent active players and position
units; typed edges represent protection, route/coverage, substitution, and
shared-unit relationships. Availability changes propagate through observed
replacement and continuity edges. Unknown players or edges raise uncertainty;
they do not inherit league-average health. Compare against the existing explicit
replacement-value model before retaining a graph network.

**N4 — matchup embeddings and retrieval.** Learn time-aware team, coach, player,
scheme, and game-state embeddings from cutoff-safe structured evidence. Retrieve
only earlier games, record exact neighbors and distances, and apply recency decay.
Text embeddings may retrieve sourced evidence but cannot directly create a
numeric football feature.

**N5 — dynamic mixture and uncertainty.** Route among market, linear, simulation,
player, sequence, graph, and neural specialists with a small preregistered gate.
Penalize correlated experts, cap any one family, expose gate weights on every
decision, and abstain when ensemble disagreement, missingness, epistemic spread,
or regime-change probability is high. Calibrate outcome and interval coverage
separately by market.

All neural artifacts must contain the feature schema, label schema, cutoff rule,
training range, seed, hyperparameters, parent artifact, code hash, input hash,
learning epoch, per-head coverage, calibration, and chronological metrics. A
training job predicts the complete week with frozen weights, settles the week,
then updates; it never learns game one before predicting game two in that week.

#### AI system — evidence workers, critic, and learning memory

AI is used where language and investigation help, not as an untraceable score
generator. Each worker writes a versioned typed object, retains its source and
publication timestamp, states uncertainty, and fails closed when evidence is
missing or contradictory.

1. **Verified-news extractor:** converts primary-source injury, role, roster,
   coach, and transaction reports into typed claims. Unsupported prose stays in
   quarantine and has zero numeric authority.
2. **Evidence librarian:** deduplicates claims, links them to canonical people,
   teams, games, and cutoffs, and retrieves the exact prior evidence used by a
   model or explanation.
3. **Pregame adversarial critic:** attempts to disprove the frozen pick, finds
   duplicated evidence and contradictions, names missing facts, and can lower
   confidence or force abstention. It cannot raise the numerical forecast.
4. **Postgame analyst:** produces the machine-readable “why we were wrong” packet,
   preserves alternative explanations, identifies the earliest divergence, and
   separates repeatable structure from high-variance events.
5. **Counterfactual reviewer:** requests bounded replays without a pivotal injury,
   turnover, drop, penalty, or weather transition. Its output is diagnostic and
   cannot rewrite the settled prediction.
6. **Data-quality agent:** watches source latency, identity conflicts, schema
   changes, impossible values, missing horizons, and stale caches; it opens a
   visible incident instead of filling gaps with plausible text.
7. **Experiment reviewer:** summarizes ablations and multiplicity-corrected
   results, checks preregistration and leakage constraints, and explicitly records
   rejection as useful evidence.

AI work is asynchronous and content-addressed. Extraction and retrieval are
batched, repeated documents reuse cached typed facts, and dashboard reads never
wait for an LLM call. Every material AI decision is reproducible from its stored
prompt/version, structured inputs, cited sources, typed output, and validation
errors. No AI worker can place a bet, change a settled label, promote a model, or
write directly into a production feature without a deterministic validator.

### Promotion rule

Thousands of variables, neural networks, or more code do not count as progress
by themselves. A module becomes influential only when its inputs are available
at prediction time, its output is recorded on every eligible example, its
incremental value survives untouched chronological evaluation, its confidence
is calibrated, and its failure modes remain visible. The historical audit can
teach us what to repair; only the forward ledger can establish future value.

---

## 1. Current evidence

### What is green

- The shared player-week engine beats each player's walk-forward season-to-date
  baseline on passing yards, rushing yards, receiving yards, and receptions.
- Fantasy and props read the same constrained event state.
- Twenty-four player-history heads and 416 signal paths can run in shadow;
  none receives production authority merely for existing.
- Anytime-TD calibration is walk-forward and gradeable.
- Line shopping has a measured execution value: best available prices differ
  materially from median prices and NFL key numbers make some half-points much
  more valuable than others.
- Historical six-point Wong teaser legs crossing both 3 and 7 won 74.69% over
  1,391 legs. That is +6.50% expected value at -110 and negative at -130. The
  price, not a new prediction, is the edge.
- Prop capture now stores book-specific quotes, model and no-vig probability,
  kickoff, NFL week, closing quote, settlement, and one deduplicated shadow
  decision per event/player/market.

### What is not green

- Zero of 21 spread models beat 15,096 closing lines through the required gate.
- No NFL prop has settled in the new forward ledger yet. Prop profitability is
  unmeasured, not proven positive or negative.
- Only 406 of the first 529 fresh prop quotes matched a model distribution
  (76.7%). Identity/eligibility coverage must exceed 95% before missing players
  can be treated as harmless.
- Passing yards remains the weakest point market. Of attributable squared
  error, 56.4% comes from pass volume and 43.6% from efficiency.
- Reachable teaser prices have not been archived. A historical strategy priced
  at an unavailable -110 does not create a real bet.

### The blind-audit correction

The 2022–2025 seasons have been opened repeatedly for diagnostics, candidate
rejection, calibration, and ablation. A replay can still be chronological and
cutoff-safe, but those seasons are no longer untouched holdouts. They must not
be used to claim a newly discovered profit edge.

The true blind audit is the pre-registered 2026 forward ledger. Historical
replays remain useful for rejecting bad ideas and finding failure modes; they
are not promotion evidence for a strategy selected after viewing them.

---

## 2. Definition of success

No model, market, or staking rule is allowed to say “profitable” until all
applicable gates pass.

### Forecast gates

- Cutoff-safe predictions captured before the first actionable quote.
- Better than a named trivial baseline on identical observations.
- Improvement survives a week-clustered bootstrap confidence interval.
- Rank accuracy does not decline.
- Probability calibration improves or remains within tolerance.
- The change improves the complete shipped pipeline, not only an isolated
  submodel.
- Every tested sibling is included in multiplicity correction.

### Market-edge gates

- Real book, line, price, and capture timestamp exist.
- Both sides are recorded when available and vig is removed.
- One decision per event/player/market; repeated books and hourly snapshots do
  not inflate the sample.
- At least **200 settled independent shadow decisions overall** before reading
  aggregate CLV.
- At least **75 settled decisions in a market** before making a market-specific
  claim. A market under 75 remains “accumulating” even if pooled results win.
- Mean and median CLV are positive, with the 90% week-clustered interval on
  mean CLV excluding zero.
- Calibration error is at most 0.03 and calibration slope is between 0.85 and
  1.15 on forward observations.
- Positive CLV is present in more than one time window; one hot month cannot
  promote a model.
- Realized ROI is reported, but CLV and calibration decide promotion because
  short-run wins are much noisier.

### Real-money gates

- The market-edge gates pass on frozen forward decisions.
- The policy was unchanged for the promoted sample.
- Best available price was actually reachable at an approved book.
- Open correlated exposure is capped.
- A rollback version is stored before activation.
- The first activation is a limited pilot, never full Kelly.

---

## 3. Workstream A — make the forward ledger complete

This is the highest-value work because every profitability claim depends on it.

### A1. Raise model-to-quote matching above 95%

For every unmatched quote, assign exactly one reason:

- player identity mismatch;
- suffix/punctuation mismatch;
- rookie missing from current projection population;
- backup or role gate intentionally abstained;
- unsupported market;
- stale roster/team assignment;
- genuine feed error.

Add a weekly reconciliation report with counts and examples. Never solve
coverage by silently loosening eligibility after seeing outcomes.

**Gate:** at least 95% of supported-market quotes either match a model or carry
an explicit, correct abstention reason.

### A2. Preserve the two useful market horizons

- T-24h: actionable early number.
- T-1h: closing proxy after injury/inactive information is mostly absorbed.

The scheduler already enforces these windows and keeps a 50-credit reserve.
Add an alert if a due window is missed, rather than backfilling it after kickoff.

**Gate:** at least 90% capture coverage at each horizon across a full week.

### A3. Verify settlement

Automatically reconcile yardage, receptions, and anytime TD against nflverse
results. Distinguish:

- win/loss/push;
- void because the player did not participate;
- unresolved identity;
- game postponed/cancelled;
- feed not final.

**Gate:** at least 99% of final, supported props settle or receive a documented
void reason within 24 hours.

### A4. Record reachable teaser prices

The current odds feed does not establish the price for a two-team, six-point
teaser at the user's actual books. Add a small manual price-entry surface or a
verified feed if one becomes available. Save book, price, timestamp, leg rules,
and whether correlated legs are prohibited.

**Gate:** no teaser recommendation unless the real offered price is -115 or
better and the two legs are from different games.

---

## 4. Workstream B — improve passing yards at the component that is failing

Do not build another set of final-yardage recency blends. Those were tested and
rejected. Build specialists that answer distinct questions and reconcile them
into one passing distribution.

### B1. Team-play volume

Question: **How many offensive plays will this team run?**

Candidate evidence, all cutoff-safe:

- plays per drive;
- expected drives;
- no-huddle rate;
- pace proxy;
- opponent drive length only if it adds value after the betting total is
  removed or ablated;
- roof/weather as uncertainty, not an automatic directional adjustment.

### B2. Pass-rate intent

Question: **What share of those plays become called passes?**

Candidates:

- neutral pass rate;
- pass rate over expected;
- early-down pass rate;
- score-neutral shotgun/no-huddle usage;
- coaching/scheme changepoint;
- spread and total game script, already in production.

Opponent-strength-on-volume stays excluded: it previously double-counted the
market and increased MAE from 70.6 to 90.8.

### B3. Dropback-to-attempt conversion

Question: **How many called passes become official attempts?**

Candidates:

- quarterback sack rate;
- scramble rate;
- pressure rate and offensive-line continuity;
- throwaway rate if a verified cutoff-safe source is available;
- designed QB rush separation.

This layer prevents a pressure matchup from being applied twice—once as fewer
attempts and again as lower YPA—unless ablation proves both pathways help.

### B4. Quarterback participation

Question: **Which passer owns the game state, and for how much of the game?**

- confirmed starter and depth-chart state;
- injury/practice designation as typed state;
- recent starter continuity;
- explicit abstention for unresolved competitions.

Injury context does not receive a generic multiplier. The previous generic
injury adjustment degraded the shipped model. It may alter participation only
when the state itself is observable.

### B5. Passing efficiency

Question: **How many yards result per attempt?**

- opportunity-weighted YPA prior;
- clean-pocket and pressured efficiency as separate states;
- air-yards and completion-over-expected features when source coverage is
  verified;
- receiver-route participation and offensive-line continuity;
- weather/wind as a candidate on efficiency, not broad volume.

### B6. Reconciliation and promotion

Every component outputs a distribution, not a point guess. Team plays constrain
pass plus rush; dropbacks constrain attempts plus sacks plus scrambles; QB
attempts constrain completions and passing yards. Incoherent combinations are
rejected before scoring.

Each family runs through:

1. chronological discovery;
2. redundancy pruning;
3. paired significance test;
4. Holm correction across the family;
5. independent validation;
6. full-pipeline ablation;
7. 2026 forward monitoring.

**Gate:** passing-yards MAE improves significantly over the active engine,
rank accuracy does not decline, distribution coverage remains calibrated, and
the improvement repeats in the forward ledger. If no family passes, keep the
current model.

---

## 5. Workstream C — calibration and edge selection

Academic betting-model evidence favors calibration over raw classification
accuracy for selecting wagering systems. That matches this architecture:
profit depends on whether a quoted 58% event really occurs about 58% of the
time, not whether the model chose the winning side more often than 50%.

### C1. Calibrate each market separately

Maintain separate walk-forward calibrators for:

- passing yards;
- rushing yards;
- receiving yards;
- receptions;
- anytime TD.

No pooled calibrator may hide a weak market behind a strong TD market. Use
simple monotone or logistic candidates first; complexity must beat the simple
head out of sample.

### C2. Learn an abstention policy, not a pick factory

Shadow-score edge bands, model uncertainty, source freshness, and model-market
disagreement. The output is one of:

- bet candidate;
- monitor only;
- abstain because price is too efficient;
- abstain because evidence is stale/missing;
- abstain because model uncertainty exceeds the estimated edge.

The policy may become more selective. It may never lower a threshold merely
because the latest backtest lost.

### C3. Market-residual model

Only after enough real quotes exist, train a small residual model on:

`actual outcome - market-implied expectation`.

The structural player model remains the foundation. The residual head asks
where the market is systematically wrong; it does not relearn football from
scratch. Candidate features must be available at the recorded quote timestamp.

**Gate:** positive forward CLV after calibration and abstention, not merely a
lower historical MAE.

---

## 6. Workstream D — execution edges

This is the shorter path to profit because it does not require beating the
closing market's prediction.

### D1. Line shopping

- Compare number first, price second.
- Price moves through NFL 3 and 7 using the empirical margin distribution.
- Alert on middles where books straddle 3 or 7.
- Record which books are actually reachable.

**Gate:** the selected quote must be better than the median contemporaneous
quote after accounting for both line and price.

### D2. Wong teasers

- Six-point legs only for favorite -7.5/-8.5 or underdog +1.5/+2.5.
- Both 3 and 7 must be crossed.
- Different games only.
- Real two-team price no worse than -115.
- No recommendation if the price field is missing.

### D3. Research-only extensions

Pre-register before testing:

- 6.5-point and 7-point teaser schedules;
- home underdogs;
- divisional unders;
- book-to-book middles around 3 and 7.

These are separate experiment families. Test count and rejected variants stay
visible. None can borrow the existing Wong result as proof.

---

## 7. Workstream E — progressive learning without drift or hallucination

### Numeric learning

- Champion/challenger only.
- Immutable pregame snapshots.
- Fit on settled prior observations.
- Minimum 250 forward snapshots before automated review.
- Newest-window MAE must improve without damaging rank or calibration.
- Changepoints require sustained usage plus snap-share corroboration.
- Missing evidence lowers confidence; it never becomes a zero-valued feature.

### AI/LLM role

Use the LLM only to convert news into typed claims:

- player identity;
- injury/body part;
- practice status;
- starter/backup language;
- expected role change;
- source and timestamp;
- confidence and supporting text span.

The LLM never emits a projection, edge, or stake. A numeric candidate derived
from its structured output must pass the same ablation gate as every other
signal. Unsupported claims are discarded before reaching the model.

---

## 8. Staking and bankroll policy

Until a market clears the forward gates:

- model-derived stake = **0 units**;
- shadow decisions continue;
- execution edges may be displayed only at a real reachable price.

After promotion:

- begin at one-eighth or quarter Kelly, whichever is smaller under the model's
  probability-uncertainty interval;
- cap one bet at 0.5% of bankroll during the pilot;
- cap one game at 1.0% across correlated props;
- cap one week at 5% open risk;
- calculate stake from the worst plausible calibrated probability, not the
  point estimate;
- never increase stake to recover losses;
- automatically return to shadow mode if forward calibration or CLV gates fail.

Full Kelly is prohibited. It is optimal only when the estimated probability is
correct, which is exactly the uncertain quantity being tested.

---

## 9. Delivery order

### Now — before Week 1 (revised 2026-09-02)

0. Keep the app running through 2026-09-15. The decision ledger, pregame
   snapshots, council freeze, shadow board, and settlement are all scheduled
   now, and all of them are process-local timers.
1. Quote source for Weeks 1–4: **resolved without spending.** The free book
   feeds capture 11 books including Pinnacle hourly and at every capture
   window, and Polymarket supplies the movement series. Multi-book CLV is
   measurable for Week 1. The Odds API upgrade and the SportsGameOdds account
   remain optional extras, not blockers.
2. Unmatched-prop reconciliation and explicit abstention reasons — **in code**:
   `reconcilePropQuoteMatches` runs inside the hourly prop job and writes a
   `model_match_status`/`model_match_reason` per quote; `propMatchCoverage`
   reports the 95% gate. What is missing is prop quotes themselves (the
   metered feed is the only prop source; the free feeds carry sides/totals).
3. Missed-window alerting — **done** (`missed_windows` and a `missed_windows`
   alert on `/api/nfl-market/evidence/status`: a window whose due time and
   kickoff both passed while still queued). Prop horizon misses were already
   in `propHorizonCoverage`.
4. Reachable teaser-price entry and archive — exists (`POST
   /api/nfl-betting/teasers/prices`, the form in Profitability Control).
5. Freeze/hash the 2026 prop decision policy — **done**; `nfl-prop-clv.js`
   freezes `nfl-prop-shadow-2026.1` into `nfl_prop_policy_archive` at import
   and throws if the policy text changes without a version bump.
6. Display capture coverage and the reserve in the NFL hub — **done**: the
   workspace strip now shows Polymarket line movement, the free-feed capture
   (books, games, age) and the paid credits left as backup.

### Weeks 1–4

1. Accumulate T-24h/T-1h quotes and settlements.
2. Run passing component specialists in shadow.
3. Report calibration and CLV by market and edge band.
4. Audit every unresolved/void result.
5. Make no model-based real-money bets.

### Weeks 5–10

1. Review component candidates only after chronological gates run.
2. Promote no candidate without full-pipeline ablation.
3. Evaluate line-shopping and teaser availability using reachable prices.
4. Continue shadow decisions until overall and per-market sample gates pass.

### After 200+ settled shadow decisions

1. Run the frozen forward audit with week-clustered uncertainty.
2. Promote only markets with positive CLV and acceptable calibration.
3. Start a capped real-money pilot at no more than 0.5% bankroll per play.
4. Keep non-passing markets independent; a TD win cannot authorize passing
   yards, and pooled success cannot hide a losing market.

### After 1,000+ settled decisions

1. Treat realized ROI as interpretable rather than anecdotal.
2. Compare CLV, ROI, drawdown, and calibration by season segment.
3. Consider residual GBM or more advanced mixture-of-experts only if the
   structural and calibrated systems have plateaued.

---

## 10. Stop rules

Stop spending development time or money when any of these holds:

- A candidate fails full-pipeline ablation even if its isolated test passes.
- Forward CLV confidence interval includes zero after the minimum sample.
- Model-match coverage remains below 95% and missingness is not random.
- A supposed edge exists only at a book/price the user cannot access.
- Profit disappears when repeated quotes are deduplicated.
- A strategy works only after changing thresholds against the same opened
  sample.
- Calibration worsens while win rate rises; this is likely variance, not skill.
- API cost exceeds the expected information value of another snapshot.

The objective is not to force Gridiron HQ to make five bets every week. The
objective is to identify the small set of decisions whose evidence survives
the market, uncertainty, and execution costs—and to abstain everywhere else.

---

## Research basis

- Hubáček, Šourek and Železný, *Machine learning for sports betting: should
  model selection be based on accuracy or calibration?*
  <https://arxiv.org/abs/2303.06021>
- The Odds API v4 documentation, including live event/market behavior,
  historical availability, and request accounting:
  <https://the-odds-api.com/liveapi/guides/v4/>

These references support the emphasis on calibrated probabilities and exact
timestamped market evidence. They do not establish that this model has an edge;
only the forward gates above can do that.
