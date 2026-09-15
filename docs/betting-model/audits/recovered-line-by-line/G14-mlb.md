# G14-mlb — line-by-line audit of the MLB system

Reader: **G14-mlb**. Date of audit: 2026-09-12 (prompt says "today is 2026-09-11"; the
machine clock and `sync_log` both read 2026-09-12, so I use the DB's own clock below).
Repo root: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only).
DB inspected via `node:sqlite` `{readOnly:true}` one-liners only. No process touched.

**Files read: 15. Lines read: 3,673 (= `wc -l` total).** Per-file line counts are in the
table at the bottom and each matches `wc -l` exactly.

---

## 0. Executive answer to the focus questions

**What it models.** Three markets, all props-shaped, none of them moneyline or full-game
totals:

| market key | question | line | source of truth |
|---|---|---|---|
| `nrfi` | no run in the 1st inning | 0.5 | `mlb_games.yrfi` |
| `batter_total_bases` | batter total bases | 1.5 | `mlb_batter_games.total_bases` |
| `pitcher_strikeouts` | starter strikeouts | 5.5 | `mlb_pitcher_games.strikeouts` |

There is **no MLB moneyline, no run line, and no full-game total** anywhere in the tree.
`MLB_MARKETS` in `odds-api.js` and the quote market keys (`mlb-auto-picks.js:111`) cover
exactly these three. So the MLB system is the *prop* half of the shop — which is notable
given the settled finding that props are the model's real skill but under-measured.

**Data sources.** All first-party and free:
- MLB Stats API `statsapi.mlb.com/api/v1` — `schedule?hydrate=linescore` (whole season +
  first-inning scoring in one request, `mlb.js:44`), `schedule?hydrate=probablePitcher`
  (`mlb.js:103`), `people/{id}/stats?stats=gameLog` (`mlb.js:168,196`), and
  `game/{pk}/boxscore` (`mlb.js:223`, `mlb-pregame.js:12`). No key, no cost.
- Odds: **the Odds API (shared NFL pool) or ParlayAPI** — both currently OFF (see below).

**The credit-drain incident guard.** Real, correct, and currently load-bearing.
`mlb-pregame.js:34-42` documents it: MLB odds share the NFL account's 500 monthly credits
at 3 credits per game per fetch; with `ttlMs: 0` on a five-minute daemon this burned
**498 credits on 2026-09-01** and starved the NFL capture windows the whole plan depends
on. The fix is two-part and both parts are in the code:
- `const MLB_ODDS_ENABLED = process.env.MLB_ODDS_CAPTURE === '1'` (`mlb-pregame.js:41`) —
  opt-in, and `.env` does **not** set it.
- `const MLB_ODDS_TTL_MS = 60 * 60e3` (`mlb-pregame.js:42`) — an hour of reuse instead of 0.
Plus a second, separate pool (ParlayAPI) with its own fail-closed reserve
(`parlay-api.js:79,116`); `.env` does **not** set `PARLAY_API_KEY` either.
Net effect today: `captureEnabled` is false, `oddsStatus` is `odds_capture_disabled`, and
**the last MLB market quote was captured 2026-09-01T19:41Z**. The guard works. It is also
the reason the whole pick pipeline has been dead for ten days (§3).

**Is it still scheduled?** **Yes — fully, aggressively, and right now.** From `sync_log`
at 2026-09-12T07:50Z, during NFL Week 1 weekend with the T-60 runner live:

```
mlb_schedule        2026-09-12T07:19:29Z  ok     333 runs   {"season":2026,"games":2458,"upcoming":215}
mlb_probables       2026-09-12T07:19:30Z  ok     228 runs   {"from":"2026-09-11","to":"2026-09-16","confirmed":89}
mlb_boxscores       2026-09-12T07:50:51Z  ok     603 runs   {"date":"2026-09-11","games":15,"hydrated":15}
mlb_tomorrow_picks  2026-09-12T07:12:20Z  ok     104 runs   {"date":"2026-09-13","picks":0}   <-- zero, every run
mlb_logs            2026-09-12T06:44:40Z  ERROR   40 runs   "exceeded its 120s budget and was abandoned"
```
Five jobs in `JOBS` (`scheduler.js:726-730`), three of them in the `live` tier, three in
the boot list (`scheduler.js:1091`). On top of that the **evidence daemon** plans 106 MLB
events every pass (2,275 passes) and, when a window is due, calls `captureMlbPregame(date)`
which loops every game on the slate and fetches a live boxscore for each
(`evidence-daemon.js:147-155`, `mlb-pregame.js:62-65`). That has written **23,300
`mlb_pregame_snapshots` rows and 5,004 `model_evidence_manifests` rows** since 2026-08-24,
into an **11.3 GB** synchronous SQLite file. This is the single largest piece of
non-fantasy, non-NFL background load on the box.

**Has it ever been graded?** Yes, but the honest number is much smaller than the row
counts suggest.
- `mlb_pick_decisions` = **2,635 rows**, all abstention bookkeeping, 2026-08-24 → 2026-09-13.
  Breakdown: `missing_real_price` 2,103 · `lineup_not_confirmed` 450 ·
  `price_edge_below_threshold_or_market_unmatched` 60 · `eligible` 26.
  So 26/2,635 = **1%** of candidates ever cleared the evidence bar.
- `mlb_first_party_picks` = **138 rows**, 2026-07-12 → **2026-09-02** (nothing since).
  115 are legacy/retrospective (`tracking_mode` NULL **and** `model_version` NULL) and are
  therefore *all* quarantined by `standing()` (`mlb-auto-picks.js:322` requires
  `model_version === 'mlb-projection-v2-cutoff'`, which none of them have).
  **23 are forward and priced.** That is the entire evidence base.
- Grading those 23 from the DB directly:
  - NRFI forward: **8-8** (16 settled).
  - Pitcher K forward: 5 picks → 2-3 (`Over 5.5` → 2 K = L; `Under 5.5` → 6 = L; → 5 = W;
    → 3 = W; → 7 = L).
  - Batter TB forward: 2 picks → 1-1 (`Under 1.5` → 4 TB = L; → 1 TB = W).
  - **Total: 11-12 on 23 settled priced picks.** ~48%. At the stored prices that is a
    small loss. n=23 is far below any of the code's own gates (500 historical, 150 forward,
    150 priced — `mlb-research.js:47,52,53`).
- `mlb_probability_calibrations`: **0 rows**. `mlb_model_experiments`: **0 rows**.
  `model_gate_audits` for MLB: **0 rows**. Three whole modules have never produced output.

**Verdict: FREEZE.** Detail in §8. Short version: the code is unusually honest and well
built, the data pipeline is genuinely first-party and healthy, but the evidence base is 23
picks at ~48%, the pick engine has produced zero picks for ten days, the season ends
2026-09-27 (~15 days away), Nick's stated priority is fantasy first, and the plan doc
explicitly says *"Do not delete props/fantasy/MLB code just because this project is
spreads-only"* (`docs/CLAUDE-NEXT-STEPS.md:688`). Deleting would destroy real work and
violate the plan; leaving it running costs ~1,300 HTTP boxscore fetches/day and thousands
of row-writes/day against the 11 GB DB that the 2026-09-07 responsiveness incident was
traced to. Freeze the *scheduling*, keep the *code and data*.

---

## 1. Wiring map

```
MLB Stats API (free)
   │
   ├─ mlb.js  syncSeasonSchedule / syncProbableStarters / syncPitcherGameLogs
   │          syncBatterGameLogs / syncGameBoxscore / syncFinalBoxscores
   │             writes mlb_games, mlb_probable_starters, mlb_pitcher_games,
   │                    mlb_batter_games, mlb_boxscore_sync
   │             ← scheduler.js JOBS.mlb_schedule/.mlb_logs/.mlb_boxscores/.mlb_probables
   │             ← scripts/bootstrap-mlb.mjs  (manual first-run, 2022-2025)
   │
   ├─ mlb-shrinkage-fit.js  nrfiKs(throughDate)  → fitK (shrinkage-fit.js)
   │             reads mlb_games only; writes nothing; per-day Map cache
   │
   ├─ mlb-projections.js  projectBatter / projectPitcher / nrfiFor / boardFor / coverage
   │             reads mlb_*_games + mlb_games; imports starterFor from mlb.js,
   │             nrfiKs from mlb-shrinkage-fit.js; writes nothing
   │
   ├─ mlb-pregame.js  captureMlbPregame / latestMlbQuotes / latestMlbSnapshot
   │             odds-api.js OR parlay-api.js (both currently disabled)
   │             writes mlb_pregame_snapshots, mlb_market_quotes,
   │                    model_evidence_manifests (via model-governance.js)
   │             ← evidence-daemon.js:147  ← routes/mlb.js:167
   │
   ├─ mlb-auto-picks.js  candidatesFor / priceForwardCandidates / ensurePicksFor /
   │             gradePick / allPicks / standing / modelAudit / backfill /
   │             auditCandidateDecisions
   │             writes mlb_first_party_picks, mlb_pick_decisions
   │             ← scheduler.js JOBS.mlb_tomorrow_picks  ← routes/mlb.js
   │
   ├─ mlb-calibration.js  buildMlbCalibration / mlbCalibrations   (0 rows ever)
   ├─ mlb-experiments.js  createMlbExperiment / runMlbExperimentStage  (0 rows ever)
   └─ mlb-research.js     mlbOperations  (aggregates everything above + governance)

routes/mlb.js  (mounted at /api/mlb by server/index.js:44)
   └─ client: App.tsx → MlbHub.tsx → { MlbBoard.tsx | MlbAutoPicks.tsx | Props* }

db/schema/mlb-model-misc.js ← server/migrations/000_legacy_schema.js:28
```

Every one of my files has at least one importer outside `test/`. **No orphans.**

---

## 2. Per-file notes

### 2.1 `server/services/mlb.js` — 295 lines

**Purpose.** The whole first-party ingestion layer. Season schedule + first-inning
linescore in one request; probable starters on their own cadence; per-player season game
logs; per-game boxscore hydration; coverage counts.

**Key functions.** `syncSeasonSchedule(season)` :43 · `syncProbableStarters(daysAhead=5)`
:99 · `starterFor(teamId, date)` :142 · `syncPitcherGameLogs` :156 · `syncBatterGameLogs`
:184 · `syncGameBoxscore(gamePk)` :218 · `syncFinalBoxscores(date)` :272 ·
`syncSeason(season)` :278 · `coverage()` :287.

**Data written.** `mlb_games` (upsert on `game_pk`), `mlb_probable_starters` (upsert on
`game_pk,team_id`), `mlb_pitcher_games` / `mlb_batter_games` (upsert on
`game_pk,player_id`), `mlb_boxscore_sync`.

**What is genuinely good here.**
- The cost design is real. One request per season for schedule+linescore (`:44`), one per
  player for game logs, one per *final game* for daily settlement (`:218` comment). The
  comment at `:9-14` is accurate: ~1,500 requests a season, not tens of thousands.
- `syncGameBoxscore` refuses to run on a non-final game (`:222`) and writes an explicit
  `mlb_boxscore_sync` receipt (`:263`) so downstream grading can distinguish "player did
  not appear" from "we never fetched this game". That receipt is the thing that makes
  `canConfirmVoid` honest. This is a genuinely well-thought-out anti-fake-void design.
- `:254-255` uses **plate appearances**, not at-bats, as the participation condition, so a
  walk-only player is a real 0-TB participant rather than a void. Correct.
- Transactions with explicit ROLLBACK on `:56-81`, `:115-133`, `:235-267`.

**Defects.**

- **[G14-MLB-08, P2] Stale/incorrect comment claims box-score starters for past dates.**
  `mlb-projections.js:366-369` says the pitcher list is *"confirmed probable for
  today/future, **the real box-score starter for past dates**"*. `starterFor` does no such
  thing — it reads one table:
  ```js
  // server/services/mlb.js:142-147
  export function starterFor(teamId, date) {
    const p = rows(`SELECT pitcher_id AS player_id, pitcher_name AS player_name
                    FROM mlb_probable_starters WHERE team_id = ? AND date = ?`,
      teamId, date)[0];
    return p?.player_id ? p : null;
  }
  ```
  `mlb_probable_starters` holds **676 rows spanning only 2026-08-04 → 2026-09-15** (29
  distinct dates). For every date before 2026-08-04 `starterFor` returns `null`. The
  docstring at `:137-141` is honest about this ("Historical dates without a preserved
  probable-starter snapshot remain unavailable"); the `boardFor` comment contradicts it.
  Consequence is not cosmetic — see **G14-MLB-03**.

- **[G14-MLB-11, P3] `teamFirst`'s denominator does not filter `yrfi IS NOT NULL`, but the
  league prior next to it does.**
  ```js
  // server/services/mlb-projections.js:256-262
  const g = rows(`SELECT first_inning_home_runs h, first_inning_away_runs a, home_team_id, away_team_id
                  FROM mlb_games
                  WHERE season = ? AND date < ? AND (home_team_id = ? OR away_team_id = ?)`, ...);
  if (!g.length) return null;
  const scored = g.filter(x => (x.home_team_id === teamId ? x.h : x.a) > 0).length;
  return { games: g.length, first_inning_score_rate: scored / g.length };
  ```
  A past-dated game with NULL first-inning runs (postponed / suspended / a Final whose
  linescore failed to hydrate — `mlb.js:64` writes NULLs for any non-Final) lands in the
  denominator and, because `null > 0` is `false` in JS, counts as *"did not score"*,
  deflating the team's rate. Eleven lines later the league prior does it correctly:
  `WHERE season = ? AND date < ? AND yrfi IS NOT NULL` (`:272`). I checked: **currently
  zero past-dated rows have NULL yrfi in any season**, so the impact today is nil — but it
  is live every time a game is postponed and sits un-rescheduled.

- **[G14-MLB-13, P2] `mlb_logs` is a 1,500-request job that times out on every run and is
  superseded by `mlb_boxscores`.** `sync_log` shows `last_status: "error"`, detail
  `"job 'mlb_logs' exceeded its 120s budget and was abandoned so the rest of the tier could
  run"`, 40 runs. `refreshMlbLogs` (`scheduler.js:110-117`) calls `syncPitcherGameLogs` +
  `syncBatterGameLogs` for the full season — that is `seasonPlayers()` (`mlb.js:151`) plus
  one `gameLog` request per player, twice. `mlb_boxscores` (603 runs, always `ok`) already
  hydrates every final game daily and has kept `mlb_batter_games` current through
  2026-09-11. `mlb_logs` is pure waste that burns 120 s of the heavy tier each attempt.

**Verdict: keep (freeze the schedule).** This file is the healthiest thing in the group and
is the only part with independent value — 9,144 games and 350k player-game rows across
2022-2026, all locally owned.

---

### 2.2 `server/services/mlb-projections.js` — 426 lines

**Purpose.** The model. Volume × rate, shrunk toward a date-bounded population mean, then
turned into a *distribution* rather than a point estimate.

**Key functions.** `leagueRates` :27 · `projectBatter` :57 · `battingEnvironment` :113 ·
`batterTotalBases` :142 · `positiveBaseDistribution` :154 · `compoundPoissonOver` :165 ·
`projectPitcher` :179 · `opponentStrikeoutFactor` :212 · `pitcherStrikeouts` :228 ·
`poissonCdf` :241 · `nrfiFor` :254 · `slateFor` :317 · `boardFor` :326 · `coverage` :415.

**Data read.** `mlb_batter_games`, `mlb_pitcher_games`, `mlb_games`. **Writes nothing.**

**What is genuinely good here — this is the strongest modelling code in the group.**
- **Cutoff discipline is real and everywhere.** Every single query carries `date < ?`. The
  comment at `:63-65` records a caught bug: the population priors used to be computed over
  the completed season while the player's own history was date-bounded, so a July backtest
  borrowed August/September league rates. Fixed by passing `throughDate` into
  `leagueRates` (`:66`), `battingEnvironment` (`:117,121,129,132`), and
  `opponentStrikeoutFactor` (`:217,219`). I traced every call site; there is **no
  look-ahead leakage in this file**.
- **Distributions, not point estimates.** `compoundPoissonOver` (`:165-175`) is an exact
  Panjer recursion over integer severities, and `positiveBaseDistribution` (`:154-162`)
  splits the non-HR extra-base value across adjacent integers so the simulated mean
  *exactly* preserves the projected TB/AB. The comment at `:90-92` says this replaced a
  hard-coded 28% double rate. That is real statistical care.
- `pitcherStrikeouts` (`:228-239`) uses Poisson thinning correctly, and the derivation is
  spelled out at `:230-231`.
- The NRFI shrinkage fix (`:274-281`) is documented with the failure it corrects: a
  modelAudit over 751 graded picks found an **inverted calibration slope** from the
  hand-picked k=12/k=40, and the fix both fits k from data and moves the blend into the
  arcsine-stabilised domain (`shrinkRate`, `stats-util.js:44`).
- `nrfiFor:297-298` gets the sidedness right: the home team's first-inning rate is adjusted
  by the **away** pitcher's run-environment factor and vice versa.

**Defects.**

- **[G14-MLB-03, P2] `modelAudit` evaluates a different model from the one that makes
  picks, in two independent ways.** This is the most consequential modelling defect I
  found, because every gate, calibration verdict and the "751 graded picks" claim rests on
  `modelAudit`.
  1. *No pitchers.* `nrfiFor` reaches for starters at `:284-287`:
     ```js
     const homeStarter = starterFor(homeTeamId, throughDate);
     const awayStarter = starterFor(awayTeamId, throughDate);
     ```
     `mlb_probable_starters` starts at **2026-08-04**. The default audit window is 120 days
     back from today (`routes/mlb.js:76`) and `mlb-research.js:33` uses 180. So for roughly
     nine-tenths of audited slates both starters are `null`, `hp`/`ap` are `null`, and
     `:297-298` fall back to `(ap?.run_environment_factor ?? 1)` — i.e. the audited NRFI
     model has **no pitcher term at all**, while the deployed one does.
  2. *No props.* `candidatesFor` (`mlb-auto-picks.js:69-70,85`) hard-skips batters and
     pitchers whenever `date < appDate()`. Every `modelAudit` date is historical by
     construction (`mlb-auto-picks.js:369-371` selects `date < throughDate`), so
     `by_market.batter_total_bases` and `by_market.pitcher_strikeouts` are **permanently
     `{n:0, status:'insufficient'}`** and `overall` is NRFI-only.
  The note the endpoint returns — *"Fixed-cadence walk-forward audit of the frozen
  selection policy"* (`mlb-auto-picks.js:427`) — is therefore not accurate for either the
  model or the policy.

- **[G14-MLB-12, P3] `boardFor` and `candidatesFor` compute 120 batter + pitcher
  projections and then throw them away on every historical date.** `candidatesFor` calls
  `boardFor(date, { limit: 120 })` (`mlb-auto-picks.js:52`) unconditionally; `boardFor`
  runs `projectBatter` for up to 120 players (`:374-386`), each doing its own
  `SELECT * FROM mlb_batter_games WHERE player_id=? AND season=? AND date<?` plus a
  `team_id` lookup (`:376`) against a 249k-row table inside an 11 GB file — and then
  `candidatesFor:70` discards the whole array. A `modelAudit` run samples ~26 dates; that
  is ~3,000 wasted per-player queries per audit call, on the main thread.

**Verdict: keep.** The modelling is careful and the leakage discipline is genuinely good.
The problem is not the model, it is that nothing has measured it.

---

### 2.3 `server/services/mlb-auto-picks.js` — 441 lines

**Purpose.** Selection policy, evidence gating, grading, standings, and the walk-forward
audit.

**Key functions.** `candidatesFor` :51 · `priceForwardCandidates` :109 · `diversifiedTop`
:142 · `recordCandidateDecisions` :158 · `auditCandidateDecisions` :179 · `ensurePicksFor`
:193 · `gradePick` :232 · `gameIsFinal` :270 · `canConfirmVoid` :294 · `allPicks` :307 ·
`standing` :327 · `modelAudit` :363 · `backfill` :434.

**Data written.** `mlb_first_party_picks`, `mlb_pick_decisions`.

**What is genuinely good here.**
- The honesty in the header (`:12-16`) — *"there is no MLB odds feed wired up, so these
  cannot be ranked by edge … the record below is therefore a test of the projections, not
  of any claimed edge over a sportsbook"* — is exactly the right framing and matches the
  settled NFL finding.
- `PLAUSIBLE_MIN/MAX` (`:41-42`) with the reasoning at `:28-40` is a real insight: ranking
  by conviction alone selects props no book would ever post ("this reliever will not strike
  out six"), inflating win rate while testing nothing. Excluding >0.78 is the correct move.
- `MIN_IP_PER_START = 4.0` (`:44`) excludes openers from a 5.5-K line. Correct.
- The Pending/Void distinction (`:248-250`, `:259-261`, `canConfirmVoid` `:294-304`) is the
  best piece of data-integrity thinking in the whole group: a missing player row is only a
  Void once `mlb_boxscore_sync.status = 'hydrated'` proves the participant list was
  actually fetched. Missing ingestion can never masquerade as "he didn't play".
- `diversifiedTop` (`:142-155`) caps two picks per market so five strikeout unders on one
  slate are not sold as five independent bets.
- `standing()` refuses to report units/ROI unless a real stored price exists
  (`:313-316,333`), and the route echoes that (`routes/mlb.js:145-147`).

**Defects.**

- **[G14-MLB-02, P2] `mlb_pick_decisions` abstention reasons are frozen at first touch, so
  the 2,635-row decision audit is systematically wrong.** The insert is
  ```js
  // server/services/mlb-auto-picks.js:169-172
  run(`INSERT INTO mlb_pick_decisions
    (pick_date,market,selection,game_pk,side,line,model_probability,eligible,abstention_reason,
     recorded_at,model_version,evidence_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, ...)
  ```
  and the primary key is `(pick_date,market,selection,side,line,model_version)`
  (`mlb-model-misc.js:67`). `eligible`, `abstention_reason` and `evidence_json` are **not**
  in the key, so `DO NOTHING` silently discards every later, better-informed evaluation of
  the same candidate. `mlb_tomorrow_picks` runs every 90 minutes and the route re-runs
  `auditCandidateDecisions` on every page load (`:197`), so the row that survives is the
  one written by the *earliest* pass — typically before the pregame snapshot or the quote
  existed. That directly biases the headline the UI renders
  (`ModelOperations.tsx:144`, "N explicit abstentions"): `missing_real_price` 2,103 and
  `lineup_not_confirmed` 450 are first-touch states, not final ones. An `ON CONFLICT ... DO
  UPDATE` on the non-key columns would fix it.

- **[G14-MLB-04, P2] Player-prop grading ignores `game_pk`, so a doubleheader settles
  against an arbitrary game.**
  ```js
  // server/services/mlb-auto-picks.js:246-247
  const b = rows(`SELECT total_bases FROM mlb_batter_games
                  WHERE player_id = ? AND date = ?`, p.player_id, p.pick_date)[0];
  ```
  Same shape at `:257-258` for strikeouts, and again in `mlb-calibration.js:23` and `:26`.
  There is no `ORDER BY` and no `game_pk` filter, so `[0]` is whichever row SQLite returns
  first. **`mlb_batter_games` currently holds 2,966 (player_id, date) pairs with more than
  one row** — every doubleheader. `mlb_first_party_picks` has carried `game_pk` for prop
  picks since the forward-tracking rewrite (all 7 forward prop rows have it; the 93 legacy
  rows are NULL), so the fix is available. No *current* pick is affected — I checked, zero
  picks land on a duplicated player-day — but any future doubleheader prop settles on a
  coin flip. The comment at `:275-277` ("Player props currently do not persist a game id")
  is stale.

- **[G14-MLB-05, P2] `market_brier` is hard-coded `null`, so the `market_benchmark`
  promotion gate can never pass.** In `score()`:
  ```js
  // server/services/mlb-auto-picks.js:418
  expected_calibration_error: r3(ece), market_brier: null,
  ```
  and the gate that consumes it:
  ```js
  // server/services/mlb-research.js:50-51
  { id: 'market_benchmark', label: 'Beats no-vig market probability',
    passed: metric.market_brier != null && metric.brier < metric.market_brier, ... }
  ```
  `passed` is `false` by construction, forever, for all three markets. `mlbOperations`
  then computes `verdict: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked'`
  (`mlb-research.js:62`) — so **MLB promotion is structurally unreachable regardless of
  model quality**, while the UI presents it as a measurable target with a real threshold
  ("model Brier < market Brier", rendered by `GateRow` in `ModelOperations.tsx:142`). If
  the intent is "not yet wired", it should say so; as written it is a gate that lies.

- **[G14-MLB-07, P2] `ensurePicksFor` re-runs the entire audit + board on every call when
  the slate yields nothing, which is every call for the last ten days.**
  ```js
  // server/services/mlb-auto-picks.js:193-201
  export function ensurePicksFor(date, n = 5) {
    const existing = rows('SELECT * FROM mlb_first_party_picks WHERE pick_date = ? ORDER BY rank', date);
    if (existing.length) return existing;
    const audited = auditCandidateDecisions(date);              // calls candidatesFor
    const { candidates: rawCandidates, date: actualDate } = candidatesFor(audited.slate_date);  // AGAIN
    ...
    if (!candidates?.length) return [];                          // nothing written -> next call repeats
  ```
  Two consequences. (a) `candidatesFor` — which runs `boardFor(date, {limit:120})` with its
  ~120 per-player queries — is invoked **twice** per call (`:197` then `:198`). (b) Because
  nothing is inserted when the candidate list is empty, there is no memo, so the work
  repeats forever. `sync_log` proves it: `mlb_tomorrow_picks` has **104 runs and every
  single one returns `{"date":"2026-09-13","picks":0}`**. The same path runs on every
  `GET /api/mlb/auto-picks` (`routes/mlb.js:128`). On an 11.3 GB database driven by
  `node:sqlite` — which has no worker thread, so a slow query blocks the whole HTTP server,
  the exact failure documented at `scheduler.js:1070-1078` — this is the MLB tree's main
  contribution to the responsiveness problem that forced `SCHEDULER_DISABLED` on draft
  night.

- **[G14-MLB-14, P3] `standing()` mixes two populations in one object.** `wins`, `losses`,
  `win_rate` and `by_market` are computed over `eligible` (`:329-332,346-354`), but
  `pushes`, `voids`, `pending` and `quarantined` are computed over `graded` = **all** picks
  (`:337-340`). `MlbAutoPicks.tsx:200,205` renders them side by side ("Forward record
  8-8 · N pending", "Pushes N · Voids N"), so the numbers do not belong to the same
  denominator and will not reconcile.

- **[G14-MLB-15, P3] The `Push` branch is dead code for every market.** `:251`
  `if (b.total_bases === p.line)` compares an integer to `1.5`; `:262`
  `if (s.strikeouts === p.line)` compares an integer to `5.5`. Every line the selector can
  emit is a half-point (`:79` line 1.5, `:96` line 5.5, `:64` line 0.5), so `Push` is
  unreachable — yet the UI reserves a status pill and a ledger stat for it
  (`MlbAutoPicks.tsx:49,205`).

- **[G14-MLB-16, P3] `auditCache` is an unbounded module-level `Map`.** `:45`, keyed at
  `:364` on `season|throughDate|lookback|cadence|fromDate`. `throughDate` defaults to today
  (`routes/mlb.js:73`, `mlb-research.js:31`), so the key rotates daily and every distinct
  audit result is retained for the process lifetime. Each value carries a full
  `reliability` array per market. Minor for a local app, but it is an unbounded cache on
  the process that also runs the T-60 capture.

- **Worth flagging as a modelling caveat, not a code defect.** `priceForwardCandidates`
  takes `available.reduce((a, b) => b.price > a.price ? b : a)` (`:124`) — the best price
  across all books — and then de-vigs against *that same book's* other side (`:126-130`)
  before applying a flat `probability_difference >= 0.03` threshold (`:138`). Picking the
  max of N books and measuring edge against the same quote mechanically manufactures edge;
  it is exactly the "line-shopping execution" effect the NFL work already isolated, and it
  is not separable from model skill here. With n=23 this is unmeasurable either way.

**Verdict: keep, freeze.**

---

### 2.4 `server/services/mlb-pregame.js` — 132 lines

**Purpose.** Capture pregame state — probable starters, announced lineups, scratches — plus
real sportsbook quotes, under a strict forward-only rule. Home of the credit-drain guard.

**Key functions.** `boxscoreLineup(gamePk)` :11 · `captureMlbPregame(date)` :44 ·
`mlbPregameCoverage()` :108 · `latestMlbQuotes(date)` :118 · `latestMlbSnapshot(gamePk)` :127.

**Data written.** `mlb_pregame_snapshots` (append-only, PK `game_pk,captured_at`),
`mlb_market_quotes`, and three `model_evidence_manifests` rows per call (`:100-104`).

**What is good.** The credit-drain guard (§0) is exactly right and the comment at `:34-42`
is a model of incident documentation. The retroactive-capture ban at `:46` is correct.
`latestMlbQuotes` (`:118-124`) does a proper latest-per-key join including the
`COALESCE(line,-999)` NULL handling. `validateEvidenceCutoff` is invoked (`:89`).

**Defects.**

- **[G14-MLB-01, P1] `captureMlbPregame` has no per-game first-pitch guard, so 1,271
  "pregame" snapshots were taken after the game started — and `latestMlbSnapshot`
  deliberately returns the newest one.** The only temporal check in the function is
  slate-level:
  ```js
  // server/services/mlb-pregame.js:44-48
  export async function captureMlbPregame(date) {
    const today = appDate();
    if (date < today) throw new Error('pregame snapshots cannot be created retroactively');
    await syncProbableStarters(5);
    const games = rows('SELECT * FROM mlb_games WHERE date=? ORDER BY game_time', date);
  ```
  Then the loop at `:62-94` snapshots **every** game on the slate, calling
  `boxscoreLineup(g.game_pk)` (`:65`) — a live `/game/{pk}/boxscore` fetch — with no
  comparison of `new Date()` against `g.game_time`. The evidence daemon triggers per
  *window* but captures per *date* (`evidence-daemon.js:147-149`), and its horizons include
  `T-15m` and `close` at kickoff−5 min (`evidence-daemon.js:23-25`). An MLB slate runs from
  ~1 pm to ~10 pm ET, so the `close` window for the 1 pm game re-snapshots all fifteen
  games — including ones that finished hours earlier.

  Measured in the live DB:
  ```
  SELECT COUNT(*), SUM(captured_at > game_time) FROM mlb_pregame_snapshots WHERE game_time IS NOT NULL
    -> 23300 total, 1271 captured after first pitch
  ```
  and every one of those 1,271 carries `lineup_status = 'confirmed'` — because after first
  pitch the boxscore has ≥18 batting orders, which is precisely the test at `:29`
  (`lineups.length >= 18 ? 'confirmed' : ...`). So the "confirmed lineup" flag on those rows
  is derived from outcome-era data, in a table named `mlb_pregame_snapshots`, feeding an
  evidence trail whose whole purpose is cutoff validity.

  `validateEvidenceCutoff` does not catch this. It only walks the payload for `*_at`-style
  keys and compares them to `cutoffAt`, which is `latestCapturedAt = new Date()`
  (`:88-89`, `model-governance.js:126-142`) — i.e. it checks the payload against *now*, not
  against first pitch. Nothing in the system compares a snapshot to its game's start.

  The consumer makes it worse rather than better:
  ```js
  // server/services/mlb-pregame.js:127-128
  export function latestMlbSnapshot(gamePk) {
    const r = rows(`SELECT * FROM mlb_pregame_snapshots WHERE game_pk=? ORDER BY captured_at DESC LIMIT 1`, gamePk)[0];
  ```
  For a started game that returns the post-first-pitch row, and
  `priceForwardCandidates` gates on exactly that row's `odds_status` and `lineup_status`
  (`mlb-auto-picks.js:114-118`) before stamping `pregame_snapshot_at` and `lineup_status`
  onto the pick (`:135`).

  **Why this is P1 and not P2:** the only reason no pick has actually been contaminated is
  that odds capture has been off since 2026-09-01, so `odds_status !== 'captured'` rejects
  everything at `:115`. I verified all 23 forward picks: every `pregame_snapshot_at`
  precedes its `game_time`. The guard holding the line is an unrelated budget switch. Set
  `MLB_ODDS_CAPTURE=1` or add a `PARLAY_API_KEY` and this immediately starts writing
  outcome-era "pregame" evidence into the forward ledger. The fix is one line: skip games
  where `new Date() >= new Date(g.game_time)` in the loop at `:62`.

- **[G14-MLB-09, P3] `odds_status = 'event_not_matched'` conflates "this game was not in
  the events list" with "no events were fetched at all".** `events` is `[]` whenever
  neither provider is enabled *or* whenever the provider returns nothing (`:58-59`), and
  the default at `:69` is `'event_not_matched'` whenever a key exists and capture is
  enabled. 15,539 of 23,300 snapshot rows carry this status — all from 2026-09-02 and
  earlier, i.e. the pre-guard era. Reading that number as "team-name matching is broken"
  would be wrong; it mostly means the fetch returned nothing. A distinct
  `'no_events_returned'` status would make `mlbPregameCoverage` interpretable.

**Verdict: keep the module, freeze the daemon.** The credit guard must not be removed.

---

### 2.5 `server/services/mlb-calibration.js` — 119 lines

**Purpose.** Fit a price-aware logistic recalibration per market:
`logit(p_calibrated) = b0 + b1·logit(p_model) + b2·logit(p_market)`, with a ridge-penalised
Newton solve and a monthly walk-forward gate.

**Key functions.** `samplesFor` :11 · `fit` :34 · `solve3` :57 · `probability` :69 ·
`score` :70 · `buildMlbCalibration` :77 · `latestMlbCalibration` :108 · `mlbCalibrations` :115.

**Data.** Reads `mlb_first_party_picks` + result tables; writes
`mlb_probability_calibrations`. **That table has 0 rows. This module has never produced
output.**

**What is good.** The statistics are sound and honest: ridge shrinks `b2` toward 1 (i.e.
toward "just use the market", `:38`), the training/walk-forward split is by calendar month
with no peeking (`:85-89`), and the gate demands the calibrated Brier actually beat the
*market* Brier on out-of-sample months, not just beat the raw model (`:97`). Refuses to fit
below 100 samples (`:80-82`).

**Defects.**
- Carries the same doubleheader bug as `gradePick` — `:23` and `:26` both query
  `WHERE player_id=? AND date=?` with no `game_pk`. Folded into **G14-MLB-04**.
- Structurally dead: `samplesFor` requires `tracking_mode='forward' AND american_price IS
  NOT NULL AND pregame_snapshot_at IS NOT NULL` (`:13-14`). **23 rows in the DB satisfy
  that.** The threshold is 100 and the gate needs 150 walk-forward. With quotes off and the
  season ending 2026-09-27, this can never fire this year.

**Verdict: keep (frozen). It has never run and cannot run this season.**

---

### 2.6 `server/services/mlb-experiments.js` — 79 lines

**Purpose.** A preregistration registry: name + falsifiable hypothesis + chronological
discovery/validation/holdout splits, hashed against a git commit and a data snapshot, with
the holdout sealed until validation passes.

**Key functions.** `provenance` :11 · `normalized` :24 · `createMlbExperiment` :40 ·
`score` :49 · `runMlbExperimentStage` :56 · `getMlbExperiment` :78 · `listMlbExperiments` :79.

**Data.** Writes `mlb_model_experiments`. **0 rows. Never used.**

**What is good.** The discipline is genuine and unusually rigorous for a personal project:
non-overlapping chronological splits enforced at `:32-34`, holdout refused until
`validation_passed === 1` (`:63`), each stage locked once written (`:61`), and a
`spec_hash` over `{name, hypothesis, spec}` including the git commit and a SHA-256 of the
row counts (`:11-21`). This is exactly the protocol the NFL side should have had before the
spread model was believed.

**Defects.**
- `score` (`:52`) calls `modelAudit(...)` and reads `audit.by_market[spec.market]`, so it
  inherits **G14-MLB-03** wholesale: for `batter_total_bases` and `pitcher_strikeouts` the
  metric is always `{n:0, status:'insufficient'}`, so `passed` at `:65` is always false and
  those two markets can never clear discovery. Only `nrfi` can produce a non-trivial
  result, and that result is for the pitcher-free variant of the model.
- `execFileSync('git', ...)` at `:13` on every `createMlbExperiment` — a synchronous
  subprocess on the request thread. Guarded by try/catch and only on create, so low impact.

**Verdict: keep (frozen). Zero rows; it is protocol scaffolding awaiting a model worth
preregistering.**

---

### 2.7 `server/services/mlb-research.js` — 74 lines

**Purpose.** The MLB readiness dashboard: six promotion gates per market, evaluated
independently, plus governance registry, contracts, experiments, calibrations, abstentions
and evidence manifests in one payload.

**Key functions.** `tableCoverage` :19 · `mlbOperations({throughDate, persist})` :31.

**Data.** Reads everything; writes `model_gate_audits` + `model_registry` only when
`persist` is true (`:58-61`). **`model_gate_audits` has 0 MLB rows — `/operations/audit` has
never been run.**

**What is good.** The central principle — *"NRFI, strikeouts and total bases cannot share a
record or rescue one another"* (`ModelOperations.tsx:138`) — is enforced structurally by the
per-market loop at `:39-64`. Requiring 500 historical, 150 forward, 150 *priced* and
positive CLV before promotion is a far higher bar than most of the NFL tree ever had.
`tableCoverage` wraps each count in try/catch (`:21-22`) so a missing table degrades rather
than 500s.

**Defects.**
- Owns **G14-MLB-05** (the `market_benchmark` gate, `:50-51`, can never pass).
- The `clv` gate is hard-coded `passed: false` (`:54`) with `actual` set to a quote count —
  honest, but it means two of six gates are permanently false independent of evidence.
- **Cost.** `:33` calls `modelAudit(season, throughDate, { lookbackDays: 180, cadenceDays: 7 })`
  — ~26 sampled slates, each running `candidatesFor` → `boardFor(limit:120)` (see
  **G14-MLB-12**) — synchronously inside an **unauthenticated `GET /api/mlb/operations`**
  (`routes/mlb.js:82-84`; note it has no `requireModelPermission`, unlike the POST at
  `:106`). On the 11.3 GB DB with a blocking driver this is a self-inflicted stall button
  that is reachable from the browser. Same for `GET /api/mlb/model/accuracy`
  (`routes/mlb.js:71`), which `MlbAutoPicks.tsx:92` wires to a button.

**Verdict: keep (frozen).**

---

### 2.8 `server/services/mlb-shrinkage-fit.js` — 116 lines

**Purpose.** Fit the two NRFI shrinkage constants (team first-inning rate, venue YRFI rate)
from real between-group variance instead of hand-picking them, via the same
method-of-moments one-way ANOVA (`fitK`, Searle 1992) the football side uses.

**Key functions.** `monthlyChunks` :33 · `chunkObservations` :48 · `firstInningTeamGames`
:59 · `venueYrfiGames` :67 · `fitTeamFirstInningK` :73 · `fitVenueYrfiK` :84 · `nrfiKs` :101
· `_clearNrfiKCache` :116.

**Data.** Reads `mlb_games` only. Writes nothing. Per-calendar-day `Map` cache (`:90,102`).

**This is the best-written file in the group.** The 27-line header (`:1-27`) explains *why*
the naive approach fails (a single season-to-date rate per team is one number — there is no
within-group variance to take), *what* the fix is (split each group's history into monthly
chunks, Brown 2008's split-season idea), and *why* the arcsine transform is needed (sampling
variance ≈ 1/(4n) regardless of where the rate sits). The fallback logic at `:107-108`
carefully distinguishes a genuine `Infinity` (no detectable between-group signal → trust the
prior) from a failed fit (→ the old hand-picked 12/40), and never lets `NaN` through. It
uses all seasons on hand rather than resetting each April, with the reasoning at `:52-58`.

It is also the only file in this group with a dedicated test (`test/mlb-nrfi-shrinkage.test.js`).

**Defects.** None found.

**Verdict: keep.** This module has standalone value beyond MLB — the chunked method-of-moments
k-fit is the reusable idea.

---

### 2.9 `server/routes/mlb.js` — 209 lines

**Purpose.** 24 endpoints under `/api/mlb`, mounted by `server/index.js:44`.

**What is good.** Every mutating endpoint carries `requireModelPermission('model:train')`
or `('model:promote')` (`:23,31,34,37,40,94,102,106,110,153,164,181,184,189,202`), and
`/auto-picks` requires `model:execute` (`:122`). `/board` and `/auto-picks` kick a
background refresh and answer immediately from stored state (`:61,126`) rather than blocking
on a sync. The `economics` block (`:142-148`) states plainly when ROI is unavailable and why.

**Defects.**
- `GET /operations` (`:82`), `GET /model/accuracy` (`:71`) and `GET /intelligence` (`:86`)
  have **no permission guard** and each triggers a multi-slate synchronous audit. See
  **G14-MLB-06** (grouped with the mlb-research cost finding). Every other heavy MLB
  operation is guarded; these three are the exceptions.
- `GET /auto-picks` (`:122-151`) calls `ensurePicksFor` on the request thread — inheriting
  **G14-MLB-07** — and then `allPicks()` (`:134`), which re-grades all 138 picks with 1-3
  queries each on every page load.

**Verdict: keep.**

---

### 2.10 `server/db/schema/mlb-model-misc.js` — 975 lines

**Purpose.** A legacy schema fragment consolidating verbatim DDL from 31 service modules
(only 5 of which are MLB). Four exports: `tables`, `alters`, `indexesAndTriggers`, `seeds`.
Consumed solely by `server/migrations/000_legacy_schema.js:28`.

**MLB-relevant regions.** Tables `:51-171` (`mlb_first_party_picks`, `mlb_pick_decisions`,
`mlb_probability_calibrations`, `mlb_model_experiments`, `mlb_pregame_snapshots`,
`mlb_market_quotes`, `mlb_games`, `mlb_probable_starters`, `mlb_pitcher_games`,
`mlb_batter_games`, `mlb_boxscore_sync`); alters `:806-825`; indexes `:886-899`; seeds
`:970-974` (none).

**What is good.** The provenance discipline is exemplary — `sources` (`:14-45`) lists every
contributing module, the header points at a manifest with source line ranges, and each block
is commented with its origin file and line numbers. The `alters` re-read `PRAGMA table_info`
before each add (`:812,817,819,823`), so it is idempotent. The `mlb_boxscore_sync` comment
(`:163-165`) preserves the design rationale for the void rule.

**Defects.**
- Owns the `mlb_pick_decisions` primary key that causes **G14-MLB-02** (`:67`, PK
  `(pick_date,market,selection,side,line,model_version)` excluding the mutable
  `eligible`/`abstention_reason`/`evidence_json`).
- **[G14-MLB-17, P3] Nullable columns inside two primary keys.** `mlb_pick_decisions` PK
  includes `side` and `line` (`:67`); `mlb_market_quotes` PK includes `selection`, `side`
  and `line` (`:100`). SQLite permits NULLs in PRIMARY KEY columns of rowid tables and
  treats each NULL as distinct, so `ON CONFLICT DO NOTHING` (`mlb-auto-picks.js:172`,
  `mlb-pregame.js:80`) silently stops deduplicating for any row with a NULL there. Every
  market the selector emits sets a numeric line, so no duplicates exist today; it is a trap
  for any future market with no line (moneyline, YRFI-only).
- `mlb_games` has no index on `(season, date)` — `idx_mlb_games_date` and
  `idx_mlb_games_season` are separate (`:893-894`). `nrfiFor:256-259,269-272,288-292` all
  filter on `season = ? AND date < ?` together and run several times per game per board
  build. Minor, but a compound index is the obvious win.

**Verdict: keep** — this is schema, path-sensitive, and `folder-map.csv:276` marks it
`keep` / `path_sensitive_keep`.

---

### 2.11 `client/src/pages/betting/MlbHub.tsx` — 84 lines

**Purpose.** The MLB workspace shell: a four-view nav (Model slate / Forward capture /
Settled ledger / Proof room) plus a first-party-vs-proxied source toggle.

**What is good.** The 15-line header comment (`:15-29`) is the clearest statement of the
two-implementation situation anywhere in the repo, and the decision to make the orphaned
`/props/*` path a labelled toggle rather than delete a working second opinion is sound.

**Defects.**

- **[G14-MLB-06, P2] The hub's pick counter reads the dead proxied table, not the
  first-party ledger.** `:43-44` fetches `/betting/summary` and reads
  `data?.mlb.standing.tracked_picks`. That field comes from:
  ```js
  // server/routes/betting-hub.js:66-70
  function mlbStanding() {
    const picks = rows(`SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank`);
    return {
      tracked_picks: picks.length,
      days_tracked: new Set(picks.map(p => p.pick_date)).size,
  ```
  `props_auto_picks` is the **old proxied table**: it holds **5 rows across 1 date, latest
  2026-07-19** — the exact date the upstream pipeline died, per the header comment in
  `mlb-auto-picks.js:4-6`. `mlb_first_party_picks` holds 138 rows across many dates and is
  never read here. So the nav badge (`:53`) and the NextAction copy (`:74`, *"The ledger
  currently holds ${standing?.tracked_picks ?? 0} tracked picks across ${days_tracked}
  days"*) both display **5 picks / 1 day** for a first-party ledger of 138 picks. The MLB
  hub's headline number describes a feed that has been dead for eight weeks.

- **[G14-MLB-18, P3] Two of the four first-party views render proxied components.** `:80`
  `{view === 'ledger' && <PropsPicks />}` and `:81` `{view === 'model' && <PropsModel />}` —
  neither respects the `source` toggle (`hasSourceToggle` is false for those views, `:45`).
  So "Settled ledger" and "Proof room" always show the proxied path, and the first-party
  `/mlb/operations`, `/mlb/model/accuracy` and `/mlb/model/calibrations` endpoints are
  reachable only through the "Data operations" disclosure buried inside MlbAutoPicks
  (`MlbAutoPicks.tsx:156,170`).

**Verdict: keep.**

---

### 2.12 `client/src/pages/betting/MlbBoard.tsx` — 232 lines

**Purpose.** The model slate: games + NRFI cards, batter total-bases table, pitcher
strikeout table, with a date picker and a manual schedule refresh.

**What is good.** This page is a model of not overclaiming. `:39-41`, `:76-78` and `:203-208`
all say the same true thing three ways: no odds feed, no edge column, these are model
probabilities and not priced opportunities. The `fell_back` banner (`:88-95`) surfaces the
server's date substitution instead of silently showing stale games. `bar()` (`:29`) clamps
to [2,100] so a 0% probability still renders a visible sliver.

**Defects.**
- **[G14-MLB-10, P3] Uses a UTC date where the server uses `appDate()`.** `:44`
  `const today = new Date().toISOString().slice(0, 10)`. Everything server-side uses
  `appDate()` (`routes/mlb.js:42,62,...`). For Nick in US Eastern, any page load after
  8 pm ET requests tomorrow's slate, which typically has no stored games, which triggers the
  `fell_back` path and shows the amber "Showing X, not Y" banner on an ordinary evening.
  `MlbAutoPicks.tsx:57-60` already has the correct `localIsoDate()` helper; this file does
  not use it.

**Verdict: keep.**

---

### 2.13 `client/src/pages/betting/MlbAutoPicks.tsx` — 295 lines

**Purpose.** The forward-capture console: capture pregame → build slate → settle → audit,
plus the evidence ledger, market cuts, reliability diagrams and the retrospective drawer.

**What is good.** The forward/retrospective separation is carried all the way into the UI:
quarantined and retrospective rows get distinct eyebrows and descriptions (`:184-190`), the
pick card stamps its own `tracking_mode` / `quarantined` pill (`:251`), and the standing
"Economics intentionally hidden" notice (`:173-175`) explicitly retires the old hypothetical
−110 units. `prepareTomorrow` (`:105-116`) snapshots *before* generating, with the reasoning
inline. The "Research quarantine" tile (`:203`) shows the quarantined count as a
first-class number rather than hiding it.

**Defects.**

- **[G14-MLB-06b / part of P2 family] The "Odds feed" readiness light is green while MLB
  odds capture is off.**
  ```tsx
  // client/src/pages/betting/MlbAutoPicks.tsx:162
  <Readiness label="Odds feed" value={pregameApi.data?.odds_api.has_key ? 'Connected' : 'Unavailable'} ready={!!pregameApi.data?.odds_api.has_key} />
  ```
  `odds_api.has_key` is `oddsUsage().has_key` (`routes/mlb.js:159`), i.e. *"an ODDS_API_KEY
  string exists"* — which is true. But MLB capture requires `MLB_ODDS_CAPTURE === '1'`
  (`mlb-pregame.js:41`, unset) or a `PARLAY_API_KEY` (unset). So the console shows a green
  **"Odds feed: Connected"** dot while **zero MLB quotes have been captured since
  2026-09-01** and 2,103 candidates have been abstained for `missing_real_price`. The server
  already returns everything needed to tell the truth — `captureMlbPregame` returns
  `odds_capture_enabled` and `parlay_capture_enabled` (`mlb-pregame.js:97`) and
  `/pregame/status` returns the parlay reserve (`routes/mlb.js:160`) — the component just
  reads the wrong field.

- **[G14-MLB-19, P2] `probability_difference` is labelled "calibrated gap" but nothing
  calibrates it.**
  ```tsx
  // client/src/pages/betting/MlbAutoPicks.tsx:255
  {p.american_price == null ? 'model confidence' : `${p.book} · ${pct(p.probability_difference)} calibrated gap`}
  ```
  The stored value is the raw difference `c.model_probability - marketP`
  (`mlb-auto-picks.js:133`). `mlb_probability_calibrations` has **0 rows**, `latestMlbCalibration`
  is never consulted anywhere in the selection path, and `buildMlbCalibration` has never
  run. Calling a raw, uncalibrated model-minus-market gap "calibrated" is precisely the kind
  of overclaim the rest of this page works hard to avoid.

- **[G14-MLB-20, P3] Reliability-diagram legend does not match the bars.** `:276` renders
  *"Blue predicted · black observed"* while `:275` paints predicted `bg-cyan-200` and
  observed `bg-sky-500`. Neither bar is black, and both are blue-ish, so the legend cannot
  disambiguate them.

**Verdict: keep.**

---

### 2.14 `scripts/bootstrap-mlb.mjs` — 29 lines

**Purpose.** One-shot historical pull, default seasons 2022-2025, via `syncSeason`.

Correct and honest: per-season timing, per-season failure isolation (`:23-25`), and a final
coverage dump. Defaults (`:10-11`) are now a year stale — 2026 is in the DB with 2,458 games
but is not in the default range; anyone re-running this would need
`node scripts/bootstrap-mlb.mjs 2022 2026`. P3, cosmetic.

**Status: script entry point (no importers by design). Keep.**

---

### 2.15 `test/mlb-nrfi-shrinkage.test.js` — 167 lines

**Purpose.** Four tests for the NRFI shrinkage fix: arcsine round-trip + degenerate guards
(`:40`), `shrinkRate` beating naive `shrink` on thin samples across a realistic rate range
(`:48`), method-of-moments convergence across 20 seeded replicates (`:72`), and the
`fitTeamFirstInningK`/`nrfiKs` DB wiring including cache behaviour (`:125`).

**This is a genuinely good test file.** It uses a deterministic PRNG independent of app
state (`:35-38`), it isolates the estimator from DB wiring in the convergence test
(`:73-75`), it tests the *property that matters* (lower bias **and** ≥3× lower variance,
`:115-122`) rather than a golden number, and it uses a real temp SQLite via
`GRIDIRON_DB_PATH` with proper cleanup (`:20-21,32`).

**Coverage gap (not a defect in this file).** It is the *only* MLB test. Nothing exercises
`nrfiFor`, `candidatesFor`'s plausible band, `priceForwardCandidates`' de-vig, `gradePick`,
`canConfirmVoid`, `standing`, or `modelAudit`. `test/model-integrity.test.js` touches
`projectBatter`/`batterTotalBases`/`pitcherStrikeouts` (`:12`), `buildMlbCalibration`
(`:31`), `createMlbExperiment` (`:29`) and `allPicks` (`:34`), but only for shape/no-throw.
Every P1/P2 above sits in untested code.

**Verdict: keep.**

---

## 3. Why picks stopped on 2026-09-02 — the full causal chain

1. 2026-09-01: MLB odds capture burned 498 of 500 shared Odds API credits in a day
   (`mlb-pregame.js:34-39`).
2. Fix shipped: `MLB_ODDS_CAPTURE` opt-in + 1-hour TTL (`:41-42`). `.env` never sets it.
   `PARLAY_API_KEY` is also unset.
3. → `captureEnabled === false` (`:57`) → `events = []` (`:58-59`) → `oddsStatus =
   'odds_capture_disabled'` (`:69`) → **no `mlb_market_quotes` rows written after
   2026-09-01T19:41Z.**
4. → `priceForwardCandidates` rejects every candidate at `:115`
   (`snapshot.odds_status !== 'captured'`), so `recordCandidateDecisions` stamps
   `missing_real_price` — **2,103 such rows, 2026-08-25 → 2026-09-13.**
5. → `ensurePicksFor` gets an empty `candidates` array and returns `[]` at `:201` **without
   writing anything**, so the next invocation repeats the whole computation.
6. → `mlb_tomorrow_picks`: 104 runs, `{"picks":0}` every time. Last stored pick 2026-09-02.

The system is not broken. It is correctly refusing to invent picks it has no prices for —
and then burning the full board-build cost every 90 minutes to re-derive that same refusal.

---

## 4. Ongoing cost right now (NFL Week 1, T-60 runner live, 11.3 GB DB)

| source | rate | evidence |
|---|---|---|
| `mlb_schedule` | hourly, 1 request | 333 runs, `live` tier |
| `mlb_probables` | 90 min, 1 request | 228 runs |
| `mlb_boxscores` | 30 min, ≤15 requests | 603 runs |
| `mlb_logs` | 6 h, **times out at 120 s every run** | 40 runs, `last_status: error` |
| `mlb_tomorrow_picks` | 90 min, full board build ×2 | 104 runs, **0 picks every time** |
| evidence daemon → `captureMlbPregame` | per due window, **loops all 15 games, 1 live boxscore fetch each** | 23,300 snapshot rows + 5,004 manifest rows since 2026-08-24; ~200-800 snapshot rows/day |

`scheduler.js:1070-1078` documents that the betting-side live tier's polling of this
database was *"the actual cause of the app going periodically unresponsive"* and that
"None of the fantasy pages depend on live NFL/MLB odds staying fresh". MLB is the larger
half of that load and the half with zero current output.

---

## 5. Data-integrity summary (what the DB actually says)

```
mlb_games              9,145 rows   2022-04-07 → 2026-09-27   (2026: 2,458; 215 unplayed)
mlb_batter_games     248,853 rows   (2026 through 2026-09-11)
mlb_pitcher_games    101,298 rows
mlb_probable_starters    676 rows   2026-08-04 → 2026-09-15 ONLY
mlb_boxscore_sync        271 rows   all 'hydrated'
mlb_pregame_snapshots 23,300 rows   1,271 captured AFTER first pitch
mlb_market_quotes     35,136 rows   LAST: 2026-09-01T19:41Z
mlb_first_party_picks    138 rows   LAST: 2026-09-02   (115 legacy+quarantined, 23 forward+priced)
mlb_pick_decisions     2,635 rows   26 eligible (1%)
mlb_probability_calibrations   0
mlb_model_experiments          0
model_gate_audits (MLB)        0
model_evidence_manifests (MLB) 5,004
```

Forward, priced, settled record: **11-12 (23 picks)**. NRFI 8-8, K 2-3, TB 1-1.

---

## 6. Defect index

| id | sev | file:line | claim |
|---|---|---|---|
| G14-MLB-01 | P1 | mlb-pregame.js:44-48,62-65,127-128 | No first-pitch guard; 1,271 post-first-pitch "pregame" snapshots with outcome-derived `confirmed` lineups; `latestMlbSnapshot` returns the newest |
| G14-MLB-02 | P2 | mlb-auto-picks.js:169-172 + mlb-model-misc.js:67 | Abstention reasons frozen at first touch; 2,635-row decision audit is first-touch, not final |
| G14-MLB-03 | P2 | mlb-auto-picks.js:69-70,85,427 + mlb-projections.js:284-287 | `modelAudit` audits a pitcher-free, NRFI-only model, not the deployed policy |
| G14-MLB-04 | P2 | mlb-auto-picks.js:246-247,257-258; mlb-calibration.js:23,26 | Prop grading ignores `game_pk`; 2,966 duplicated player-days in the table |
| G14-MLB-05 | P2 | mlb-auto-picks.js:418 + mlb-research.js:50-51 | `market_brier` hard-coded null → `market_benchmark` gate can never pass; promotion structurally unreachable |
| G14-MLB-06 | P2 | MlbHub.tsx:43-44 + betting-hub.js:66-70 | Hub pick counter reads `props_auto_picks` (5 rows, dead 2026-07-19), not `mlb_first_party_picks` (138) |
| G14-MLB-06b | P2 | MlbAutoPicks.tsx:162 | "Odds feed: Connected" green while MLB capture disabled and zero quotes since 2026-09-01 |
| G14-MLB-07 | P2 | mlb-auto-picks.js:193-201 | `ensurePicksFor` recomputes the full board twice per call, forever, when empty; 104 zero-pick scheduler runs |
| G14-MLB-08 | P2 | mlb-projections.js:366-369 vs mlb.js:142-147 | Comment claims box-score starters for past dates; `starterFor` reads only probables (2026-08-04+) |
| G14-MLB-19 | P2 | MlbAutoPicks.tsx:255 | Raw model-minus-market gap labelled "calibrated gap"; no calibration has ever been fitted |
| G14-MLB-13 | P2 | scheduler.js:110-117 (JOBS at :727) | `mlb_logs` times out at 120 s every run and is superseded by `mlb_boxscores` |
| G14-MLB-09 | P3 | mlb-pregame.js:58-59,69 | `event_not_matched` conflates empty event list with unmatched game (15,539 rows) |
| G14-MLB-10 | P3 | MlbBoard.tsx:44 | UTC date instead of `appDate()`; evening loads request tomorrow and trip the fallback banner |
| G14-MLB-11 | P3 | mlb-projections.js:256-262 vs :272 | `teamFirst` denominator lacks `yrfi IS NOT NULL` while the league prior has it |
| G14-MLB-12 | P3 | mlb-auto-picks.js:52,70,85 | 120 batter/pitcher projections computed then discarded on every historical date |
| G14-MLB-14 | P3 | mlb-auto-picks.js:329-340 | `standing()` mixes eligible-only and all-picks populations in one object |
| G14-MLB-15 | P3 | mlb-auto-picks.js:251,262 | `Push` branch unreachable (integer vs half-point line) |
| G14-MLB-16 | P3 | mlb-auto-picks.js:45,364 | Unbounded module-level `auditCache` keyed on a daily-rotating date |
| G14-MLB-17 | P3 | mlb-model-misc.js:67,100 | Nullable columns in primary keys defeat `ON CONFLICT DO NOTHING` |
| G14-MLB-18 | P3 | MlbHub.tsx:80-81 | "Settled ledger" and "Proof room" always render proxied components |
| G14-MLB-20 | P3 | MlbAutoPicks.tsx:275-276 | Reliability legend says "black observed"; bars are cyan-200 / sky-500 |

---

## 7. Dead / duplicate / disposition

Nothing here is dead code in the import sense — every file has a live importer. What exists
is **dormant capability** (never produced a row) and **duplicated surface**:

- `mlb-calibration.js`, `mlb-experiments.js` — 0 rows ever written. Not dead code (both are
  imported and routed); dormant pending a sample that cannot exist this season.
- `props_auto_picks` / `/props/*` path — the genuinely dead proxied feed (5 rows, frozen
  2026-07-19), still wired into the MLB hub's headline number (G14-MLB-06) and still the
  only thing behind two of four hub views (G14-MLB-18). This is outside my file list but is
  the duplicate that matters.
- `scripts/bootstrap-mlb.mjs` default seasons 2022-2025 are stale vs a 2026-populated DB.

---

## 8. Verdict: FREEZE (not keep-as-is, not delete)

**Not delete.** Three independent reasons. (a) `docs/CLAUDE-NEXT-STEPS.md:688` states the
policy explicitly: *"Do not delete props/fantasy/MLB code just because this project is
spreads-only."* (b) The data has standalone value — 9,145 games and 350k player-game rows
across five seasons, first-party, free to refresh, with no upstream dependency. (c)
`mlb-shrinkage-fit.js` and the Panjer/thinning work in `mlb-projections.js` are reusable
technique, and MLB props are the closest analogue to the one area the NFL work identified
as real-but-under-measured skill.

**Not keep-as-is.** The system currently produces **zero picks**, has produced zero since
2026-09-02, has a 23-pick / 11-12 evidence base, has never fitted a calibration or run an
experiment, and cannot reach any of its own gates before the season ends in ~15 days — while
consuming ~1,300 HTTP fetches and thousands of row-writes per day against the 11.3 GB
synchronous database whose polling load was already identified as the cause of the app
freezing on draft night. During NFL Week 1 with the T-60 capture running, that trade is
indefensible.

**Freeze means, concretely (all outside my read-only remit — recommendations only):**

1. Stop the background load, keep the code and data:
   - drop `mlb_logs` from `JOBS` outright (it times out every run and `mlb_boxscores`
     already covers settlement);
   - drop `mlb_tomorrow_picks` (104 runs, 0 picks, double board build);
   - remove MLB seeding from `planEvidenceWindows` (`evidence-daemon.js:55-57`) — this is
     the single biggest win, ~1,300 boxscore fetches/day for snapshots nothing consumes;
   - keep `mlb_schedule` + `mlb_boxscores` (1 and ≤15 cheap requests) so the dataset stays
     current through 2026-09-27 and the season closes out complete.
2. Fix **G14-MLB-01** before anything ever re-enables MLB odds capture. One line: skip games
   whose `game_time` has passed inside the `captureMlbPregame` loop. Without it, turning
   quotes back on starts writing outcome-era evidence into the forward ledger immediately.
3. Fix **G14-MLB-06** and **G14-MLB-06b** — two-line UI corrections that stop the hub
   reporting a dead feed's 5 picks and a green odds light that is off.
4. Leave `mlb-calibration.js` / `mlb-experiments.js` exactly where they are. They are
   correct, unused, and cheap.
5. Revisit in March 2027 with a full offseason to fix G14-MLB-02/03/04/05 first, then decide
   whether to spend a season's worth of capture budget on it — **after** the fantasy work
   the plan actually prioritises.

**One honest caveat on the model itself.** The MLB props here are unmeasured, not disproven.
The 23-pick sample says nothing. But the structural situation rhymes with the settled NFL
finding: edge is being computed as best-price-across-books minus a de-vig of that same book
(`mlb-auto-picks.js:124-130`), which is a line-shopping/execution effect, not demonstrated
prediction skill. If MLB is ever revived, the first thing to build is the CLV linkage that
`mlb-research.js:54` already names and hard-codes to `false` — not more picks.
