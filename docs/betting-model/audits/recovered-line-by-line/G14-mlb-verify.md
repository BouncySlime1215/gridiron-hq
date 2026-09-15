# Adversarial verification of reader G14-mlb (11 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
DB: server/data.sqlite opened via `node:sqlite` `{readOnly:true}` one-liners only.
Today (per system): 2026-09-12.

All line numbers below were re-read directly from the files (not trusted from the claim text) unless noted.

---

## G14-mlb#151 — mlb-pregame.js:44, captureMlbPregame has no per-game first-pitch guard

Read server/services/mlb-pregame.js in full (132 lines). Confirmed exactly:
- `captureMlbPregame` (line 44) checks only `date < today` (line 46) — a **slate-level** date guard.
- The loop at 62-94 iterates every `mlb_games` row for that date and unconditionally calls `boxscoreLineup(g.game_pk)` (line 65), which hits the live `/game/{pk}/boxscore` endpoint — no comparison of `now` vs `g.game_time` anywhere in the function.
- `lineup.status` can be `'confirmed'` (boxscoreLineup line 29: `lineups.length >= 18 ? 'confirmed' : ...`) — and boxscore data is definitionally post/in-game data (a boxscore only populates a batting order once the game is underway).
- `latestMlbSnapshot` (127-132) does `ORDER BY captured_at DESC LIMIT 1` — returns the newest row regardless of lineage, i.e. would return a post-first-pitch "confirmed" snapshot if it's the most recent capture for that `game_pk`.
- Evidence-daemon call chain confirmed: `server/services/evidence-daemon.js:149` calls `captureMlbPregame(date)` inside a loop keyed by **date** (`for (const [date, windows] of mlbGroups)`, built at :100-104 by grouping `evidence_capture_windows` rows by `mlb_games.date`), confirming "triggers per window but captures per date" — no per-game filtering upstream either.

**DB verification (live, read-only):**
```
mlb_pregame_snapshots total: 23390
lineup_status='confirmed' AND game_time IS NOT NULL AND captured_at > game_time: 1271   <-- exact match to claim's "1,271"
lineup_status='confirmed' total: 2248
odds_status counts: captured=349, event_not_matched=15551, no_markets_posted=2692, odds_capture_disabled=4798
odds_status='captured' captured_at range: 2026-08-23T22:18 .. 2026-09-01T19:41 (all ≤ 2026-09-01, matches "odds capture has been off since 2026-09-01")
mlb_first_party_picks: pregame_snapshot_at always < corresponding mlb_games.game_time in every non-null row sampled (30 most recent) — consistent with the claim's "23 forward picks" self-check.
```

**Verdict: not refuted.** The mechanism is real, precisely as described, and the "1,271" figure is exactly reproduced from live data. The claim is honest that no pick is *currently* contaminated (protected by the unrelated odds-capture-disabled switch), so the live/today impact is: the raw `mlb_pregame_snapshots` table already contains 1,271 mislabeled "confirmed" rows (real, current data-integrity defect in the evidence store, even though it hasn't yet reached a priced pick). This is a serious, verified latent landmine, but the severity is inflated by treating it as if it's actively affecting today's decisions/prices, which the author's own evidence says it isn't (yet). Given Nick's own memory notes reference a live "pending quote-source decision" for MLB odds, this is a real, non-cosmetic risk one config flip away from live contamination.

**Corrected severity: P2** (real, verified, currently latent — not yet touching a priced pick or a number Nick reads on a page, but already corrupting the raw evidence table and one env-var away from flowing downstream).

---

## G14-mlb#152 — mlb-auto-picks.js:169, mlb_pick_decisions frozen by ON CONFLICT DO NOTHING

Confirmed schema (server/db/schema/mlb-model-misc.js:61-67):
```
CREATE TABLE IF NOT EXISTS mlb_pick_decisions (
  pick_date TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL,
  game_pk INTEGER, side TEXT, line REAL, model_probability REAL,
  eligible INTEGER NOT NULL, abstention_reason TEXT, recorded_at TEXT NOT NULL,
  model_version TEXT NOT NULL, evidence_json TEXT NOT NULL,
  PRIMARY KEY (pick_date,market,selection,side,line,model_version)
);
```
`eligible`, `abstention_reason`, `evidence_json` are indeed NOT in the PK. The only write path is `server/services/mlb-auto-picks.js:169-176`, a single `INSERT ... ON CONFLICT DO NOTHING` inside `recordCandidateDecisions`. Grepped the whole `server/` tree: there is no `UPDATE` of `mlb_pick_decisions` anywhere — confirmed the freeze is real (first successful insert for a given key is permanent for that key).

Confirmed the exact reason ladder at lines 164-168 (`missing_pregame_snapshot`, `missing_real_price`, `lineup_not_confirmed`, `price_edge_below_threshold_or_market_unmatched`) — all of these are states that legitimately change over the course of a day as snapshots/odds arrive, so a candidate genuinely can flip from ineligible to eligible between two calls on the same date, and the second call's `ON CONFLICT DO NOTHING` silently drops the corrected row.

Confirmed the call chain that would repeat this: `mlb_tomorrow_picks` (scheduler.js:730, `maxAgeMinutes: 90`) calls `prepareTomorrowPicks` -> `ensurePicksFor(tomorrow)` (scheduler.js:247-249) -> `auditCandidateDecisions` -> `recordCandidateDecisions`, repeatedly, as long as `mlb_first_party_picks` has no rows for that date yet (ensurePicksFor's early-return guard at line 194-195 only stops calling `auditCandidateDecisions` once picks are locked in). Since (per #158 below) tomorrow's picks have not locked in successfully for 108 consecutive runs, `recordCandidateDecisions` is in fact being called repeatedly against the same candidate set/date, which is exactly the scenario that freezes stale reasons.

Confirmed the consumers: `server/services/mlb-research.js:70-71` (`abstentions: rows(... FROM mlb_pick_decisions GROUP BY COALESCE(abstention_reason,'eligible') ...)`) and `client/src/components/betting/ModelOperations.tsx:144` (`{!!d.abstentions.length && <section>...title={`${d.abstentions.reduce(...)} explicit abstentions`}`) — both line numbers match exactly.

DB: `mlb_pick_decisions` currently has 2,639 rows (claim said "2,635" — close, drift consistent with more decisions recorded since the claim was written), all rows have distinct keys (no realized conflicts *currently on disk*, which is expected — ON CONFLICT DO NOTHING by definition never creates a second row for a repeated key, so this check can't distinguish "never repeated" from "repeated and correctly suppressed"; the mechanism is confirmed by code reading, not refuted by this count).

**Verdict: not refuted.** This is a real, currently-live defect: the abstention breakdown that appears on the ModelOperations page (a number Nick reads) is systematically biased toward whichever reason was recorded on the *first* evaluation of each candidate that day, not the final one.

**Corrected severity: P2** (matches claim).

---

## G14-mlb#153 — mlb-auto-picks.js:69, modelAudit's historical/live model mismatch

Confirmed in full read of mlb-auto-picks.js (lines 51-104, 363-431):
- `candidatesFor` line 69: `const historical = date < appDate();`
- Line 70: `for (const b of historical ? [] : board.batters)` — batters entirely skipped when historical.
- Line 85: `for (const pit of historical ? [] : board.pitchers)` — pitchers entirely skipped when historical.
- `modelAudit` (363-431): `eligible` dates come from `date>=lowerBound AND date<throughDate` (line 370) — strictly `< throughDate`, and `sampled` dates are drawn from `eligible` (line 372-378), so **every** date `modelAudit` ever calls `candidatesFor` with satisfies `date < appDate()` at call time (throughDate defaults to `appDate()` in mlb-research.js:31-33) → `historical` is always true inside every audit call → `board.batters`/`board.pitchers` are always `[]` for audit purposes.
- Confirmed `by_market.batter_total_bases`/`pitcher_strikeouts` therefore only ever contain `graded` items with `market==='nrfi'` (nrfi is not gated by `historical`), so `score([])` → `{n:0, status:'insufficient', ...}` (line 392) for those two markets, always.
- Confirmed the note text verbatim at line 427: `'Fixed-cadence walk-forward audit of the frozen selection policy. ...'` — no caveat that two of three markets are structurally excluded.

This is a genuine coverage gap: the live picks pipeline (`ensurePicksFor` -> `priceForwardCandidates`) *does* include batters/pitchers for forward dates, but the audit that is supposed to validate "the frozen selection policy" never exercises those two markets at all, for any date, ever (as currently coded — `modelAudit` has no forward-audit path).

**Verdict: not refuted.** The described mismatch and the inaccurate note text are both confirmed exactly as claimed, at the exact cited lines. This flows into `mlb-research.js:31-73`'s `mlbOperations()` gates (line 47-56) that Nick reads on the ModelOperations page (n, calibration slope, verdict for pitcher_strikeouts/batter_total_bases will permanently read "insufficient"/"blocked" for a reason the UI never states).

**Corrected severity: P2** (matches claim — real, currently displayed, but a diagnostic/audit-completeness defect rather than a wrong number already baked into a live decision).

---

## G14-mlb#154 — mlb-auto-picks.js:246, doubleheader grading collision

Confirmed exactly:
- mlb-auto-picks.js:246-247 (`gradePick`, batter_total_bases branch): `SELECT total_bases FROM mlb_batter_games WHERE player_id = ? AND date = ?` — no `game_pk`, no `ORDER BY`.
- mlb-auto-picks.js:256-258 (pitcher_strikeouts branch): same shape, `SELECT strikeouts FROM mlb_pitcher_games WHERE player_id = ? AND date = ?`.
- mlb-calibration.js:23 and :26: identical shape (`mlb_pitcher_games`/`mlb_batter_games` keyed on `player_id,date` only), confirmed by direct read.
- `mlb_batter_games`/`mlb_pitcher_games` PKs are `(game_pk, player_id)` (schema mlb-model-misc.js:130-163) — so a doubleheader really can produce two rows per `(player_id, date)`, and SQLite's row order for a `WHERE` with no `ORDER BY`/`LIMIT` on a query returning `[0]` is implementation-defined (currently insertion/rowid order in practice, but not guaranteed).

**However, the claim itself states, and I confirm independently, that this has zero current effect:**
- `mlb_probability_calibrations` has 0 rows (confirmed by reading mlb-calibration.js:77-105 gate — `buildMlbCalibration` requires `samples.length >= 100` forward, priced, real-price picks; given only 138 total `mlb_first_party_picks` rows and a very short window of real captured odds (2026-08-23 to 2026-09-01), it is very unlikely 100+ qualifying samples exist, and the claim itself asserts calibration has never been fit — i.e. the "calibration sampler" code path this claim warns about has never actually executed against live data).
- The claim explicitly says: "No current pick is affected — I verified zero picks land on a duplicated player-day."

Per the impact lens: this is a real latent bug in a code path that has not yet run against real duplicated data and would only matter for a calibration fit that has never been performed. Nothing on a page, no decision, and no backtest is affected today.

**Verdict: refuted** (as a *current* P2 — the mechanism is real but the claim's own evidence shows zero live effect and the one path that could matter, calibration fitting, has never executed). **Corrected severity: P3.**

---

## G14-mlb#155 — mlb-auto-picks.js:418, market_brier hardcoded null / structurally unreachable promotion

Confirmed exactly:
- mlb-auto-picks.js:418: `expected_calibration_error: r3(ece), market_brier: null,` inside `score()` — `market_brier` is a literal `null`, never computed from data anywhere in the function.
- Consumer `server/services/mlb-research.js:50-51`: `{ id: 'market_benchmark', ..., passed: metric.market_brier != null && metric.brier < metric.market_brier, ... }` — since `metric.market_brier` is always `null`, `passed` is always `false` by construction, for every market, forever.
- Additionally (confirmed while reading, extends the claim slightly): `mlb-research.js:54`, the `clv` gate is **also** hardcoded `passed: false` unconditionally — so two of the six gates (`market_benchmark` and `clv`) can never pass regardless of model quality, not "just" one.
- `verdict: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked'` (mlb-research.js:62, and again at line 67 for the overall `mlbOperations` verdict) — confirmed always `'blocked'`.
- `updateRegistry(...)` at line 59-61 persists `state: 'blocked'` on every `persist=true` call, confirmed.

This verdict/gate grid is rendered directly on the MLB ModelOperations page (`MlbModelOperations` in MlbAutoPicks.tsx, `<StatusPill tone={...}>{d.verdict}</StatusPill>` and the per-market `GateRow`s) — a number/verdict Nick reads.

**Verdict: not refuted.** Exactly as claimed, and slightly worse (two gates, not necessarily implied as exactly two by the truncated evidence, but I independently confirm exactly two: market_benchmark and clv).

**Corrected severity: P2** (matches claim — it's a real, currently-displayed, structurally-misleading gate, but "structurally unreachable" is a design/wiring gap rather than a wrong number already driving money at stake, since nothing is being staked on MLB per the codebase's own comments — "zero units").

---

## G14-mlb#156 — MlbHub.tsx:43, headline reads dead props_auto_picks table

Confirmed exactly:
- client/src/pages/betting/MlbHub.tsx:43-44: `const { data } = useApi<MlbSummary>('/betting/summary'); const standing = data?.mlb.standing;`
- server/routes/betting-hub.js:65-70 (confirmed exact lines via grep): 
```
function mlbStanding() {
  const picks = rows(`SELECT * FROM props_auto_picks ORDER BY pick_date DESC, rank`);
  return { tracked_picks: picks.length, days_tracked: new Set(picks.map(p => p.pick_date)).size, ... };
}
```
- MlbHub.tsx:53 (`WorkspaceNav` "Forward capture" `count: standing?.tracked_picks`) and :74 (`NextAction` detail string using `standing?.tracked_picks`/`days_tracked`) both consume this same stale value — confirmed exact lines.

**DB verification (live, read-only):**
```
props_auto_picks: 5 rows, all pick_date = 2026-07-19 (min=max)
mlb_first_party_picks: 138 rows, pick_date range 2026-07-12..2026-09-02, 29 distinct dates
```

This is an exact match to the claim's "5 rows / 1 day" vs "138 picks". This is a currently-live, directly-visible wrong number on the MLB hub's own landing nav badge and its "next action" copy — the single most prominent header stat on the page.

**Verdict: not refuted.** Directly confirmed, currently wrong on every page load.

**Corrected severity: P2** (matches claim; arguably could be argued P1 as a prominent always-wrong front-page number, but it is a display/wiring bug with no effect on any staked decision or model output, so P2 is appropriate under the impact lens).

---

## G14-mlb#157 — MlbAutoPicks.tsx:162, "Odds feed: Connected" is misleading

Confirmed exactly:
- client/src/pages/betting/MlbAutoPicks.tsx:162: `<Readiness label="Odds feed" value={pregameApi.data?.odds_api.has_key ? 'Connected' : 'Unavailable'} ready={!!pregameApi.data?.odds_api.has_key} />`
- `pregame/status` route (server/routes/mlb.js:156-160, confirmed) returns `odds_api: oddsUsage()`.
- `server/services/odds-api.js:21`: `export const hasKey = () => Boolean(process.env.ODDS_API_KEY);` and `:84-86`: `usage() { return { has_key: hasKey(), ... } }` — `has_key` is purely "does an env var string exist," unrelated to whether MLB capture is enabled.
- Confirmed `.env` currently has `ODDS_API_KEY` set (1 match), but **not** `MLB_ODDS_CAPTURE` (0 matches) and **not** `PARLAY_API_KEY` (0 matches) — i.e. exactly the state the claim describes: key present, MLB capture disabled.
- Confirmed via #151's DB check: no `odds_status='captured'` row has existed since 2026-09-01.

**Verdict: not refuted.** The readiness light is currently green/"Connected" while the actual precondition for any MLB pick to get a real price (MLB odds capture) has been off for 11 days as of today (2026-09-12). This is a live, currently-misleading status indicator on the page Nick actually uses to decide whether to run the capture flow.

**Corrected severity: P2** (matches claim).

---

## G14-mlb#158 — mlb-auto-picks.js:193, ensurePicksFor double board-rebuild / zero picks

Confirmed the double-build mechanism exactly:
- `ensurePicksFor` (193-222): line 194-195 returns early only if `mlb_first_party_picks` already has rows for that date.
- Line 197: `const audited = auditCandidateDecisions(date);` — which itself (line 179-187) calls `candidatesFor(date)` at its own line 180.
- Line 198: `const { candidates: rawCandidates, date: actualDate } = candidatesFor(audited.slate_date);` — a **second**, independent call to `candidatesFor` (and therefore a second full `boardFor(date, {limit:120})`) in the same invocation.
- `boardFor` (mlb-projections.js) does run one query per candidate batter/pitcher (confirmed by reading 358-395), consistent with "~120 per-player queries."

**DB verification (live, read-only):**
```
mlb_first_party_picks MAX(pick_date) = 2026-09-02 (10 days stale as of 2026-09-12)
sync_log 'mlb_tomorrow_picks': last_run_at 2026-09-12T13:26:07Z, last_status 'ok', last_detail '{"date":"2026-09-13","picks":0}', runs=108
```
Confirms "zero picks" is real and ongoing (108 runs now vs. the claim's "104" — consistent with more elapsed time since the claim was written, not a discrepancy).

**However, tracing *why* it's zero:** `ensurePicksFor` for a forward date routes candidates through `priceForwardCandidates` (line 200), which requires `snapshot.odds_status === 'captured'` (mlb-auto-picks.js:115) for every single candidate. Per #151/#157, MLB odds capture has been disabled since 2026-09-01, so `odds_status` can never be `'captured'` for any date after that — meaning the *actual* proximate cause of "zero picks, every run" is the disabled odds capture (same root cause as #151/#157), not primarily the double board-build. The double board-build is real, wasteful, and would still be worth fixing, but it does not explain the zero-output outcome by itself; it is orthogonal wasted computation on top of a candidate set that is going to be filtered to zero downstream regardless.

**Causal attribution check (scheduler.js:1070-1078):** Read the cited comment in full. It explicitly names the cause of the app-hang incident as "the betting-side live tier's 90-second polling of a 6GB+ synchronous SQLite database" — i.e., a **live-tier, 90-second-cadence** job. `mlb_tomorrow_picks` is tier `'heavy'` with `maxAgeMinutes: 90` — a 90-**minute** cadence, not 90-second, and not in the `'live'` tier. The claim's assertion that this job "is the MLB tree's largest contribution to that load" (i.e., to the specific documented app-hang incident) is not supported by the code's own account of that incident, which names a different, much-more-frequent job family as the cause.

**Verdict: not refuted on the mechanism** (double `candidatesFor`/`boardFor` call per invocation, and zero picks for 108 consecutive scheduled runs, both confirmed), **but the "impact" framing is overstated/misattributed** — it isn't the reason picks are empty (the odds-capture gate is), and it isn't the job the codebase's own incident post-mortem blames. No wrong number is displayed to Nick (an empty "no picks" state may well be the *correct* rendering given the current data), no decision or stake is affected, and no backtest is corrupted — this is pure wasted CPU cycles on a heavy-tier job that runs every 90 minutes for no output.

**Corrected severity: P3** (real inefficiency/dead-weight, but no current wrong number, decision, or data-integrity effect, and the headline incident-attribution in the impact section is not supported by the cited code).

---

## G14-mlb#159 — mlb-projections.js:366, boardFor comment vs. starterFor reality

Confirmed exactly:
- mlb-projections.js:365-367 (docstring immediately above the `pitcherIds` computation): "The pitcher for each of today's games specifically — confirmed probable for today/future, the real box-score starter for past dates — rather than the best arm anywhere in a five-man rotation."
- `starterFor` (server/services/mlb.js:142-146): `SELECT pitcher_id AS player_id, pitcher_name AS player_name FROM mlb_probable_starters WHERE team_id = ? AND date = ?` — one table, no boxscore fallback, returns `null` when absent. Confirmed by direct read.
- Even more tellingly: `mlb.js`'s own docstring immediately above `starterFor` (lines 137-140) **directly contradicts** the mlb-projections.js comment: "The starting pitcher known before the game. Completed-box-score starters are never substituted because that is outcome-era information. Historical dates without a preserved probable-starter snapshot remain unavailable." This is an internal, self-contradicting pair of comments across two files, and the code matches the mlb.js version, not the mlb-projections.js version.
- DB: `mlb_probable_starters` — 676 rows, 29 distinct dates, `MIN(date)=2026-08-04`, `MAX(date)=2026-09-15` — exact match to the claim's numbers.

**Functional (not just documentation) impact confirmed:** `nrfiFor` (mlb-projections.js:254-...) calls `starterFor` at lines 284-285, and at lines 293-294 does `hRate * (ap?.run_environment_factor ?? 1)` / `aRate * (hp?.run_environment_factor ?? 1)` — i.e. when `starterFor` returns `null` (any date before 2026-08-04), the run-environment adjustment silently falls back to a neutral `1.0` multiplier rather than erroring or flagging degraded confidence. Since NRFI (unlike batters/pitchers, see #153) is **not** skipped for historical dates in `candidatesFor`, every NRFI prediction and every NRFI entry in `modelAudit`'s graded set for dates before 2026-08-04 is silently missing the pitcher-quality adjustment, while the audit/calibration output presents a single uniform "nrfi" verdict.

**Verdict: not refuted.** This is a real, functionally consequential inaccuracy (not merely cosmetic), directly affecting the NRFI calibration numbers that feed `mlb-research.js`'s promotion gates and the ModelOperations page.

**Corrected severity: P2** (matches claim).

---

## G14-mlb#160 — MlbAutoPicks.tsx:255, "calibrated gap" mislabeling

Confirmed exactly:
- client/src/pages/betting/MlbAutoPicks.tsx:255: `{p.american_price == null ? 'model confidence' : \`${p.book} · ${pct(p.probability_difference)} calibrated gap\`}`
- `probability_difference` is computed at mlb-auto-picks.js:133: `probability_difference: r3(c.model_probability - marketP)` — a raw model-minus-market difference, with no calibration transform (no logistic fit, no shrinkage) applied anywhere in `priceForwardCandidates`.
- Confirmed `mlb_probability_calibrations` has 0 rows currently (read via mlb-calibration.js's own logic and consistent with #154's finding) — `latestMlbCalibration` (mlb-calibration.js:108-113) is genuinely never invoked from the pick-pricing path (`priceForwardCandidates`/`mlb-auto-picks.js`), only referenced from `mlbCalibrations()` for display in `mlb-research.js:69`.

**Verdict: not refuted.** This is a real, currently-displayed mislabel on every priced pick card — the one number on the page (`X% calibrated gap`) that most directly resembles a statistical edge claim is not what its label says it is.

**Corrected severity: P2** (matches claim).

---

## G14-mlb#161 — scheduler.js:727, mlb_logs job budget overrun

Confirmed the job definition exactly: scheduler.js:727 `mlb_logs: { run: refreshMlbLogs, maxAgeMinutes: 6 * 60, tier: 'heavy', label: 'MLB player game logs' },` and the docstring immediately above `refreshMlbLogs` (scheduler.js ~106-108): "Player game logs — roughly 1,500 requests, so this runs far less often..." — matches the claim's "1,500" figure verbatim from the code's own comment.

Confirmed the generic timeout mechanism is real: `DEFAULT_JOB_TIMEOUT_MS = 120_000` (scheduler.js:938) and `runIfStale` (944-990) races `job.run()` against a 120s timer, recording `'error'` with exactly the message format the claim quotes ("job '...' exceeded its Xs budget and was abandoned...") if it loses the race. No job (grepped the whole file) overrides `timeoutMs`, so `mlb_logs` does run under the generic 120s budget as claimed — the *mechanism* is real and the code is fragile by design for any job with many sequential-ish requests.

**However, the "abandoned on every run" / "permanent error status" factual claim is directly contradicted by the live database, checked just now:**
```
sync_log for job='mlb_logs':
  last_run_at:  2026-09-12T12:52:22.484Z
  last_status:  'ok'
  last_detail:  '{"pitchers":18725,"batters":46949}'
  runs: 41
```
This is a **successful, complete run** with substantial real output (18,725 pitcher-game rows + 46,949 batter-game rows written), not an aborted/error state, and it postdates the claim's own cited evidence row (`last_run_at 2026-09-12T06:44:40Z, last_status 'error'`, `40 runs`) by about 6 hours and exactly one run (`41` vs `40`) — i.e., the very next scheduled run (6-hour cadence matches `maxAgeMinutes: 6*60`) completed cleanly. So "exceeds its budget and is abandoned on every run" and "a permanent 'error' status" are both false as of the current, live state of the system — the job is at most intermittently slow, not permanently or consistently failing.

On "fully superseded by mlb_boxscores": confirmed `syncGameBoxscore` (server/services/mlb.js:218-266, called by `refreshMlbBoxscores`/`mlb_boxscores` job, tier `'live'`, `maxAgeMinutes: 30`) writes to the **same two tables** (`mlb_pitcher_games`, `mlb_batter_games`) that `mlb_logs`'s `syncPitcherGameLogs`/`syncBatterGameLogs` populate, doing so per finished game (cheap, ~15 requests/day per sync_log's `mlb_boxscores` detail) rather than a full-season per-player refetch. `mlb_boxscores` has run 614 times successfully (`last_status: 'ok'`). This part of the claim (redundancy for ongoing/rolling data) is reasonably supported — once daily boxscore hydration has been running, a full-season `mlb_logs` re-pull is mostly duplicate work for already-covered dates, though it may still catch backfill edge cases (games incorrectly marked non-final at boxscore-sync time, e.g.) that the daily job would miss.

**Verdict: refuted** on its central factual assertion ("exceeds budget and is abandoned on every run," "permanent 'error' status") — directly contradicted by the current live `sync_log` row, which shows the most recent run succeeded in full. The redundancy-with-mlb_boxscores observation has some merit but the claim's headline framing (systemic total failure) is not true right now.

**Corrected severity: P3** (the job is real, occasionally slow, and somewhat redundant with a cheaper daily job — worth simplifying — but it is not currently, or reliably, failing "on every run," and its current 'ok' status accurately reflects that it worked).

---

# Summary table

| key | claimed severity | verdict | corrected severity |
|---|---|---|---|
| G14-mlb#151 | P1 | not refuted | P2 |
| G14-mlb#152 | P2 | not refuted | P2 |
| G14-mlb#153 | P2 | not refuted | P2 |
| G14-mlb#154 | P2 | refuted | P3 |
| G14-mlb#155 | P2 | not refuted | P2 |
| G14-mlb#156 | P2 | not refuted | P2 |
| G14-mlb#157 | P2 | not refuted | P2 |
| G14-mlb#158 | P2 | not refuted (mechanism), impact overstated | P3 |
| G14-mlb#159 | P2 | not refuted | P2 |
| G14-mlb#160 | P2 | not refuted | P2 |
| G14-mlb#161 | P2 | refuted | P3 |
