# Blocker Lab — 2026-09-22 (20:25Z → 21:10Z)

Scope: blocked / broken / rejected items on the plan board. Each item: root cause (data / code / licence / cost / decision), evidence, what was tried and its honest result, then a unit spec (BL-xx) or "valid as is: leave it".

**Ground rules kept.** Repo read-only (git grep/show, gh). Experiments ran on `~/gridiron-local/blocker-lab/data.sqlite` (a `.backup` of `~/gridiron-local/data.sqlite` taken 20:21Z, after the local app had stopped); the live copy was only read with `sqlite3 -readonly`. Code ran from a detached worktree `~/gridiron-local/wt/blocker-lab` at origin/main d6d7bd5a (node_modules symlinked; removed at the end). Wrapper `blocker-lab/scripts/labnode.sh` sets `GRIDIRON_DB_PATH` to the lab copy, blanks every paid key, forces the Anthropic key invalid, and every script refuses to run unless `dbPath` is the lab copy. `leagues.espn_s2/swid`: presence only (5/5 leagues have both). No PRs, no installs, nothing paid.

Skipped because a running unit owns it: R-02 (formations / #119 / `nfl_play_formations`), S-02, S-18, R-07, F-05 (#94 landing), C-01, S-00, F-08.

Scripts and logs (the worktree is removed; re-create it with the same `git worktree add` + symlink to re-run): `~/gridiron-local/blocker-lab/scripts/` (census.sh, labnode.sh, run-growth.mjs, run-writers.mjs, settle-94.mjs, derive-outcomes.py), `census-*.txt`, `growth-run.log`.

---

## Cluster 1 — Stale data

### 1.0 Why nothing refreshes (applies to every stale table)

Three different machines, three different reasons:

| Where | What writes the DB | Why the stale writers don't run | Evidence |
|---|---|---|---|
| Production (Fly) | nothing | Every deploy re-asserts the brake `SCHEDULER_DISABLED=1` as an app secret, so no tier runs at all. Heavy tier also needs `AUTO_HEAVY_SYNC=1` (state unknown: N5). | `.github/workflows/deploy.yml:10,62-69`; scheduler.js `startScheduler` returns `{disabled:true}` on the brake |
| Nick's Mac app (`server/data.sqlite`) | only the off-server refresh loop, PID 75522 | `scripts/launcher.mjs:23,87` runs the app with `SCHEDULER_DISABLED=1` by design. The loop started **2026-09-17 21:17:29Z** and loaded its job list once: `nfl_lines, nfl_injuries, league_rosters, player_rosters, nfl_offseason_depth_injury, espn_rosters, rss_news, espn_news, nfl_news_signals` (+ league_tx, league_chat steps). Main's list (`refresh-live-data.mjs:42-57`) adds `nfl_weekly_learning, nfl_model_growth, ffopportunity, league_history, manager_archetypes`. None of those has ever run from the loop. | `ps -o lstart= -p 75522` → Thu Sep 17 17:17:29 (local); `grep "jobs:" ~/Library/Logs/gridiron-launcher/refresh-live-data.log \| tail -1` → the 9-job list; last tick 20:11:40Z "tick done in 2 s" |
| Local copy app (port 5177, OPS-01) | its own scheduler, `AUTO_HEAVY_SYNC=1`, paid keys blank | Its 19:40Z instance was up only ~6 min (last `sync_log` write 19:46:19Z; DB closed cleanly by 19:54Z; nothing listening on 5177 at 20:20Z; OPS-01 restarted it at 20:49Z, PID 50656). Growth, metered and **heavy** jobs only run on the background tier, whose first pass is `intervalMinutes` = **30 min** after start (scheduler.js:2156-2157, `setInterval(..., intervalMinutes*60000)`). So `league_history`, `manager_archetypes`, `nfl_weekly_learning`, `fantasy_coordinator_refit` had no chance. What did run (boot jobs + delayed timers) fixed usage/PBP/snaps to week 2. | `sqlite3 -readonly ~/gridiron-local/data.sqlite "select job,last_run_at,last_status from sync_log ..."`: no row for league_history / manager_archetypes; nfl_weekly_learning & fantasy_coordinator_refit last 2026-09-19 |

Plus one code defect that bites every path, even a restarted loop or an unbraked server:

- **`nfl_model_growth` cannot finish inside its budget.** It is growth tier, `offThread: true`, with no `timeoutMs` (scheduler.js:1416), so it gets `DEFAULT_JOB_TIMEOUT_MS = 120_000` (:1558, applied at :1926 `job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS`). The local scheduler's run died that way: `sync_log nfl_model_growth 2026-09-22T19:43:59Z error "exceeded its 120s budget in a worker thread and the thread was terminated"`, leaving `nfl_model_growth_runs` id 5 stuck at `status=running`. `nfl_reports` died the same way at 19:44:59Z. The refresh loop calls the same `runIfStale`, so a restarted loop would hit the same wall. Measured on the lab copy: see 1.1.

### 1.1 Writers run on the lab copy (before → after)

One process at a time, niced, via `labnode.sh`. Census before (`census-00-before.txt`, 20:23Z) and after (`census-02-after-writers.txt`, 20:58Z):

| Writer (how run) | Wall time | Before → after on the lab copy |
|---|---|---|
| `runNflModelGrowthCycle()` (`run-growth.mjs`), **first run after week 2 finalized** | **1,772 s** (29.5 min; 818 s user CPU, load avg ~20 from other units) | status `ok`; `ingestion {}` (usage/PBP/snaps were already current from the local app's 19:42Z jobs), so the time is the learning half: signal reliability, online neural, risk lab, expert council, postgame truth, feature-store freeze (32 teams), engine, team cards, player learning. `weekly_prediction_snapshots` W2 settled 0 → 351, W3 captured 0 → 1,196. Stuck run id 5 stays `running` (abandoned by the 120 s kill). |
| same, **second run, nothing new** | **35 s** (14 s user) | status `ok`, no-op |
| `backfillLeagueHistory({})` | 12.8 s | 5 league-seasons ok, 8 prior seasons `not_existing`, 636 team-weeks. `league_week_scores` 2026 wk2 scored **0/46 → 46/46** (avg 118.7, range 72.7–171.6; wk1 avg 129.4); `captured_at` 09-17 23:42Z → 09-22 20:54Z; `league_season_teams` same |
| `scripts/build-manager-archetypes.mjs --json` (child, as the job does) | 7.5 s | 6,575 rows rewritten, `computed_at` 09-18 01:38Z → 09-22 20:55Z (12 league-seasons, 45 managers). `manager_archetype_jev` unchanged: `jev: null` (needs `--jev` + paid AI gateway key) |
| `scripts/build-manager-signals.mjs --json` | 2.1 s | `manager_signals` 247 (league 4 only) → **1,114**: leagues 1/2/3/5 = 192/240/195/240 from roster, standings, tx, draft, outcome (no chat). League 4 fails closed: "this league has confirmed chat identities, but there is no chat DB … upload the corpus before naming who is who" (correct: the lab worktree has no chat corpus; Nick's Mac does) |
| `runWeeklyLearningCycle()` | 5.8 s | W3 already captured (first kickoff 2026-09-25T00:15Z); settlement pending 2,028, settled 0 new; training `false` ("need 250 settled snapshots outside the early-week window") — by design until week 5 |
| `syncEspnMarket(league 1)` (stored cookie) | 1.3 s | 400 of 1,000 rows refreshed (limit 400): `fetched_at` 09-17 → 09-22 20:57Z. Versus the 09-17 snapshot: mean abs ADP change 1.41 picks, 145/400 moved >1 pick, `injury_status` changed on 48/400 |

**Independent confirmation from OPS-01 (read-only on the live copy):** at 20:48–20:50Z main's `refresh-live-data.mjs` ran once against the local copy. Its `sync_log`: `nfl_weekly_learning` ok (captured 1,196), `league_history` ok, `manager_archetypes` ok ("jev: not run — opt-in, needs AI_GATEWAY_API_K…"), `manager_signals` ok (chat DB present, all 5 leagues), and **`nfl_model_growth` error at 20:50:19Z "exceeded its 120s budget in a worker thread"** — the same wall, through the loop path.

**BL-01 — Give `nfl_model_growth` (and `nfl_reports`) a budget that fits the weekly run**
- Root cause: code. Measured: the first run after a week finalizes needs ~30 min wall on this Mac (818 s CPU); steady state 35 s. The 120 s default kills it every time it has real work, and the error backoff (`nextDueMinutes`: 5 × 2^(failures−1) min, capped at the 6 h cadence; `RETRY_BASE_MINUTES = 5`, scheduler.js:225) restarts that same doomed work at 5, 10, 20, 40… min — a CPU treadmill that never lands the week's labels or fit.
- Files: `server/services/scheduler.js:1416` add `timeoutMs: 45 * 60_000` to `nfl_model_growth` (it is `offThread: true`, so the request thread stays free; the watchdog is not involved); same review for `nfl_reports` (:1430, died at 19:44:59Z) with its own measured runtime. Test beside the existing scheduler budget tests (e.g. `test/growth-jobs-off-thread.test.js`): assert `JOBS.nfl_model_growth.timeoutMs >= 30 * 60_000` and `offThread === true`, and that `resolveOffThread` still sends it to a worker.
- Acceptance: on a DB copy with a newly finalized week, `runIfStale('nfl_model_growth', {force:true})` returns `ok` (not the budget error) and `nfl_model_growth_runs` gets a finished row; a second call within 6 h is `skipped`/fast (<60 s). Killed attempts are closed: `reapAbandonedRuns` (scheduler.js:156) only reaps `sync_log`, so a terminated worker leaves its `nfl_model_growth_runs` row at `status='running'` forever (id 5 on both copies); on the next start mark such rows `error`/abandoned (test: seed a `running` row older than the budget → it is closed with a reason).
- Coordinate: R-02 (running) edits `nfl-model-growth.js`/`nfl-formations.js`, not this JOBS entry; no file overlap. ~1 h.

**BL-02 — Put the two fast fantasy feeds on the refresh loop's list**
- Root cause: code. Main's `FANTASY_LIVE_JOBS` (`scripts/refresh-live-data.mjs:42-57`) refreshes `player_week_usage` only through `nfl_model_growth` (`nfl-model-growth.js:228`), which dies at 120 s (BL-01). The standalone jobs `nflverse_weekly_usage` (scheduler.js:1208) and `nflverse_snap_counts` (:1211) did the same fantasy work in ~3 s on the local app (19:42:03Z: usage `inserted 1052`; snaps `inserted 1041`).
- Files: `scripts/refresh-live-data.mjs:42-57` (add both, before `nfl_model_growth`), `test/refresh-loop-steps.test.js`.
- Acceptance: test asserts both names are in `FANTASY_LIVE_JOBS` and exist in `JOBS`; on a DB copy whose 2026 usage stops one finalized week short, one `tick()` brings `MAX(week)` to the last finalized week with a known-nonzero control (2025 rows unchanged), in <60 s. Independent of BL-01 (belt and braces: usage must not depend on the betting-side learning finishing). ~45 min.

### 1.2 Per stale table

| Table (finding) | Writer → job, tier, cadence | Why it isn't running | Lab result | Verdict |
|---|---|---|---|---|
| `player_week_usage` (#132; control for #86) | `syncWeeklyUsage` (nflverse.js:245) → `nflverse_weekly_usage` (scheduler.js:1208), growth, 6 h; also `nfl_model_growth` step `weekly_usage_and_base_snaps` (nfl-model-growth.js:228) | Fly: brake. Mac: loop's frozen list has neither job. Main's loop list relies on `nfl_model_growth` (dies at 120 s). | Already healed on the local copy by the local app's 19:42Z run: 2026 wk1 → wk2 (42,099 → 42,624 rows); no change needed on the lab copy | **Data healed locally; BL-01 + BL-02** for the loop path |
| `league_week_scores`, `league_season_teams` (#89, #124) | `backfillLeagueHistory` (league-history.js:117/:148) → `league_history` (scheduler.js:1490), growth, 12 h, offThread, 300 s | Mac loop started 09-17; job added by #89 on 09-22 15:42Z. Local app was down before its first 30-min tick. | wk2 0/46 → 46/46 in 12.8 s | **Code is fine: valid as is.** Needs the loop restarted (decision D1 below) |
| `manager_archetypes` (#91, #89) | `build-manager-archetypes.mjs` → `manager_archetypes` (scheduler.js:1493), **heavy**, 24 h, child process, 10 min | Heavy gate + Fly brake + loop predates it | 09-18 → 09-22 in 7.5 s | **Valid as is**; loop restart. The false "no scheduler job" builder sentence (manager-archetypes.js:1003-1004, :1041) is text for R-06 |
| `manager_archetype_jev` (#91) | same script with `--jev` only: paid AI gateway (`build-manager-archetypes.mjs:20-25,35,40`, `JEV_MAX_USD`) | **Cost**: the scheduled job never passes `--jev` | not refreshed (correct) | **Valid as is: leave it.** Its `as_of` 09-18 is served honestly; refresh only under N7 |
| `manager_signals` (#91) | `build-manager-signals.mjs` → main's loop step `manager_signals` (+ `refreshManagerSignalsOffThread`, scheduler.js:614) | Running loop predates the step (its log shows `league_tx`, `league_chat` only) | leagues 1/2/3/5: 0 → 192/240/195/240; L4 fails closed without chat DB | **Valid as is**; loop restart |
| `espn_player_market` (#55) | `syncEspnMarket` (espn-market.js) — no caller | Code (no job) | stored cookie works, 400 refreshed in 1.3 s | **Leave it** (no live consumer post-draft, see 2.3) |
| `weekly_prediction_snapshots` (H3) | `nfl_weekly_learning` (scheduler.js:1395), heavy, 6 h; also `nfl_model_growth` player learning | Heavy gate / brake / loop; W3 capture must happen before 2026-09-25T00:15Z | W3 captured 1,196; W2 settled 351/1,183 | **BL-05** (settlement gap below) |
| `nfl_team_week_features.fourth_down_go_rate` (#92) | `syncPbpSeason` (nfl-pbp.js:482-486) | History never re-synced since #92 | 2026: 64/65 blobs have it (local app 19:42Z); 2024 and 2025: **0/561** each | Owned by **A-14** (re-derive history); not run here (CPU) |
| `player_metrics` `fc_value` (H2) | `syncFantasyCalc` (routes/aggregates.js:88, not exported) | No job; only POST routes reach it | not tried (not callable without a route; S-10's scope) | S-10. Note `sleeper_rank` now 1,627 rows (local app `sleeper_players` 19:45Z), so #55's "no Sleeper fallback" is healed locally |
| `fantasy_coordinator_fits` (H4) | `fantasy_coordinator_refit`, heavy, 24 h | Heavy gate | **deliberately not run**: the latest fit is served with no promotion gate (fantasy-coordinator.js:379); running it would only add an ungated fit | S-03 first |
| `nfl_play_formations` (#87, #92, #119) | — | — | skipped: R-02 owns it | — |

**BL-05 — Settle a player who played but recorded no stat as 0, not "pending forever"**
- Root cause: code (a survivorship gap). `settleWeeklyPredictions` (weekly-learning.js:155-171) settles only snapshots with a `player_week_usage` row. nflverse weekly stats list only players with a stat, so a player who took snaps and recorded nothing never settles. W2 on the lab copy: 832 of 1,183 pending; 794 have no snaps row (did not play), **38 played offense snaps with no stat line (28 TE, 9 WR, 1 RB)**. Leaving those 38 out biases settled actuals upward, which is what the promotion gate and coverage checks score.
- Files: `server/services/weekly-learning.js:155-171`, a test beside the weekly-learning tests.
- Goal: no usage row + `player_week_snaps.offense_pct > 0` for that week → settle `actual = 0` with a basis note; no usage and no snaps → stays pending with a named reason (`did_not_play`), and the DNP policy (exclude vs settle 0) is written down, not implied.
- Acceptance: fixture RED first (snaps>0, no usage → 0.0; no snaps → pending with reason). On the lab copy W2 settled 351 → 389 (+38), control: the 351 existing `actual` values unchanged. ~1 h.

---

## Cluster 2 — ESPN-cookie blockers (F4 first real `trade_outcomes` row, B6 real outcomes, #55 ESPN market)

**Root cause: decision (production-only), not data.** The blocker text "needs Nick's ESPN cookie on the live collector" is true only for Fly. On Nick's Mac the collector already runs every 15 minutes inside the refresh loop (`league_tx` step → `scripts/collect-league-transactions.mjs`, "pull approved 2026-09-17" in its header), all 5 leagues have a stored cookie (presence only), and `league_transactions_raw` holds 1,466 real rows, last seen 2026-09-22T18:56Z on the copy (20:11Z on the Mac DB).

### 2.1 F4 / F-06 — #94's own derivation on real rows (done on the lab copy)

Ran #94's committed code (wt/pr94 HEAD **f2e04dc5**, copied into my worktree: `067_outcome_ledgers.js` + `trade-outcomes.js`) against the lab copy: `labnode.sh settle-94.mjs`.

```
{"league":1,"written":2,"skipped":0}
{"league":2,"written":9,"skipped":1,"reasons":{"its related_tx_id <id> names a proposal that is not in the collected rows":1}}
{"league":3,"written":12,"skipped":12,...same reason:12}
{"league":4,"written":37,"skipped":22,...same reason:20,"it carries no related_tx_id, so the proposal it answers is unknown":2}
{"league":5,"written":2,"skipped":0}
second run written (idempotence): 0
[{"status":"accepted","source":"observed","n":6},{"status":"declined","source":"observed","n":25},{"status":"proposed","source":"observed","n":31}]
```

So **the first 62 real observed `trade_outcomes` rows exist today on local data**: 6 accepted, 25 declined, 31 "proposed", idempotent. F-06's proof is done; what remains for F4 is landing #94 (F-05, running) and the migration word (N9).

Raw vocabulary check (why #94's filter is right): `TRADE_PROPOSAL/EXECUTE` = 62 proposals; answers point at them through `related_tx_id` (`TRADE_DECLINE/EXECUTE` 48, of which 25 matched; `TRADE_ACCEPT/EXECUTE` 18, 6 matched); `TRADE_PROPOSAL/CANCEL` 83 are cancellation records; `TRADE_ACCEPT/PROCESS` 8 = league processing after review; `TRADE_VETO` 7 / `TRADE_UPHOLD` 9 = league votes. The 31 unmatched answers (23 declines, 8 accepts) answer proposals made before the collector's first run; they carry no items (0/23 declines have items) and no cancel record shares their target, so **they cannot be recovered honestly**; #94 skips them, correctly.

### 2.2 What #94 leaves on the table (prototype: `derive-outcomes.py`)

Of #94's 31 "proposed" rows, 29 are already closed, and the raw rows say how:

| Outcome (prototype) | n | Rule |
|---|---|---|
| accepted | 6 | `TRADE_ACCEPT/EXECUTE` → proposal. League review: 5 executed (`TRADE_ACCEPT/PROCESS`), 1 vetoed (`TRADE_ACCEPT/CANCEL` + 4 vetoes) |
| declined | 20 | `TRADE_DECLINE/EXECUTE` → proposal, no counter |
| declined then countered | 5 | decline + a reverse-direction proposal from the counterparty within 15 min |
| countered | 1 | cancel + reverse proposal within 15 min, no decline row |
| expired unanswered | 7 | cancel at exactly the 48 h `expirationDate` |
| withdrawn / invalidated | 21 | cancel before expiry, no answer, no counter (proposer withdrew, or a roster move voided it) |
| open | 2 | no answer, before expiry |

Per league (accepted/captured): L1 0/2, L2 0/9, L3 1/12, L4 5/37, L5 0/2.

Honest acceptance numbers: 6 of 31 answered (19%); 6 of 38 if an expiry counts as a no (16%). The engine's receptiveness default is 0.5 (`counterparty-pricing.js:317`); the master plan's observed figure was ~12%. **B6 reality check:** with 6 acceptances and ≤12 captured proposals in four of five leagues, a per-manager calibrated P(accept) is not estimable this season; the honest label is B-10's "experimental — 6 real outcomes".

Hand-checked sample (5 of 6 classes; team ids, no names; `+h` = hours after the proposal):

1. accepted→vetoed, L4: team 5 → team 2, 2-for-2. ACCEPT by team 2 +0.04h; VETO by teams 10, 8, 7 (+0.10/+0.21/+0.27h); ACCEPT/CANCEL by team 5 +0.48h; 4th VETO +0.48h. Counterparty said yes, league said no: correctly "accepted" for P(accept), "vetoed" for review.
2. declined, L4: team 5 → team 7, 2-for-2. DECLINE by team 7 +0.01h; cancel record +0.01h. Correct.
3. expired, L2: team 1 → team 4, 5 players. Only a cancel record at +48.00h = the proposal's expiry. Correct (no answer ever given).
4. withdrawn, L4: team 10 → team 5, 4-for-4. Cancel at +1.65h, no answer, no reverse proposal. Correct as "withdrawn or invalidated" (cause not observable; must not be scored as a decline).
5. declined-then-countered, L3: team 3 → team 8, 2-for-2. DECLINE by team 8 +0.01h; team 8 proposes back 3-for-2 at +0.04h. Correct.

**BL-20 — Settle cancellations, counters and league review from the rows #94 already reads**
- Goal: after #94 lands, `settleObservedOutcomes` writes 067's existing statuses instead of leaving closed proposals as "proposed": `expired` (cancel at `expirationDate` ± 60 s), `countered` (decline or cancel followed by a reverse-direction proposal from the counterparty within 15 min; `counter_json` = that proposal's items), and records league review (executed / vetoed) separately from the counterparty's answer. Withdrawn/invalidated stays `proposed` (067 has no `withdrawn` status; adding one needs a migration word, N9) but is counted in the settle result.
- Files: `server/services/trade-outcomes.js` (settleObservedOutcomes, on #94's branch or after it merges), `test/trade-outcomes.test.js`. No schema change (067 already allows `countered`, `expired`, `counter_json`).
- Acceptance: fixture tests RED first for each class (expired at +48h, withdrawn at +1.65h, decline+reverse proposal, accept+PROCESS, accept+CANCEL+vetoes). On the lab copy (control count 62 proposals): accepted 6 (review: executed 5, vetoed 1), declined 20, countered 6, expired 7, proposed 23 (21 withdrawn + 2 open); second run writes 0; 33 answers skipped as "proposal not captured" + 2 "no related_tx_id".
- Order: after F-05 lands #94. ~2-3 h.

### 2.3 #55 — ESPN market sync

- Root cause: **code + relevance**, not cookie. `syncEspnMarket` already sends the stored cookie when a league has one (`server/services/espn-market.js`: `if (lg.espn_s2 && lg.swid) headers.Cookie = ...`); the re-audit's "add the Cookie header" is stale. What's missing is a caller (wiring-map `producer-with-no-caller syncEspnMarket()`, scripts/wiring-map.mjs:3625).
- Relevance: its only readers are `computeConsensus()` → `GET /api/aggregates` (client caller: the unrouted `Projections.tsx:7`) and the draft routes (`drafts.js:80,445`). All 5 drafts are done. ESPN ADP is frozen after the draft, and the stored `week1_proj` is hard-wired to scoring period 1 (`stats[1120261]`). A weekly refresh would move nothing Nick sees.
- Tried: one `syncEspnMarket(1)` on the lab copy with the stored cookie → `{"synced":400}` in 1.3 s. The data is not frozen (vs 09-17: mean abs ADP change 1.41 picks, 145/400 moved >1, injury tag changed on 48/400), but nothing Nick uses reads it now.
- Verdict: **valid as is for 2026: leave it.** Wire it before the 2027 draft window through the existing open PR #50 (ESPN market timer, queue D-08). No new unit.

---

## Cluster 3 — BROKEN freshness check (#86, unit R-01)

- Root cause: **code.** `server/services/data-freshness.js:261-262` `predicate: 'season = ? AND week <= ?', bind: ['season','week']` is satisfied by one current-season row. `:274-275`: `servedTablesRegistry()` uses `registry.servedTables()` only if `source-registry.js` exports it; main exports only `MANUAL_SOURCES`, `confidence`, `allSources`, so the one-table fallback is the live path. No try/catch at :274 (a throwing `servedTables()` would throw `dataFreshness`).
- #96 (draft, head a24692d, 41 behind / 2 ahead of main): touches only `source-registry.js` + `test/served-tables-registry.test.js`; adds `servedTables()` (:345, 17 entries). Its `player_week_usage` rule (:355-358) is `MAX(week) >= ?` bound `['week','season']`: it catches "week 1 only in week 3", but it demands a row **for the week in progress**. `player_week_usage` only gets rows after games are played (nflverse weekly stats, `nflverse.js:246`), and the current week is the first week with an unscored game, so it would read stale every week from Tuesday until stats post: a false alarm by design. No upper bound either (future weeks count).
- #104 (draft, head e3a8676, base = #96's branch, 0 behind / 3 ahead of it, MERGEABLE/CLEAN): `source-registry.js` hunks at -28/-421/-567 only (`BINDABLE = ['season','week']` :584, `evaluateServedTable` :623, `servedTableVerdicts` :684). Does not touch the usage rule. **`BINDABLE` rejects any new bind name**, so the re-audit's proposed `last_week` bind would throw → `unknown` after #104.
- Neither PR touches `data-freshness.js` (the file was created on main after their merge base, +278 lines). `git merge-tree --write-tree origin/main bl/pr96` and `... bl/pr104` both exit 0 (no conflicts).
- Landing path: **(a) fix inside #104's stack**, because the rule that stays live after #96 merges is `source-registry.js:356`, not the fallback. (b) only delays the same edit; (c) fixes a path that goes dead the moment #96 merges.

**BL-03 — "last completed week present" = fresh, on the rule that stays live**
- Goal: `player_week_usage` is current when a current-season row exists for week `currentWeek-1` or later and not beyond `currentWeek`.
- Files: `server/services/source-registry.js:356-358` on #104's branch → `sql: 'SELECT CASE WHEN EXISTS (SELECT 1 FROM player_week_usage WHERE season = ? AND week >= ? - 1 AND week <= ?) THEN 1 ELSE 0 END AS current', params: ['season','week','week']` (only BINDABLE names); rule text updated; tests in `test/served-table-verdicts.test.js`.
- Acceptance (ctx season 2026, week 3, `evaluateServedTable`): week 1 only → `false`; weeks 1-2 → `true` (fails on #104 today); week 8 only → `false`; 2021-25 weeks 1-3 only → `false` with the premise `COUNT(*) = 15` asserted (known-nonzero control); week-1 edge (week 1, no 2026 rows) → `false` (fail-closed; flag it in the PR).
- Order: one commit on top of #104; lands with #104 right after #96. ~1 h.
- **BL-03b (optional, main, ~10 min):** mirror it in the fallback `data-freshness.js:261-262` as `season = ? AND week >= ? - 1 AND week <= ?`, bind `['season','week','week']`; no change to :83. Only matters until #96 lands. Add a test that feeds a week-late fixture (none of the 6 existing `test/data-freshness*.test.js` does; `data-freshness.test.js:76/82` test a local copy of the rule, not `FALLBACK_REGISTRY`).

Note the data side is already healed on the local copy: `player_week_usage` 2026 now reaches week 2 (42,099 → 42,624 rows after the local scheduler's `nflverse_weekly_usage` run at 19:42Z), which is exactly why the check needs to be right *before* the next late week, not after.

---

## Cluster 4 — Rejected R&D: data limit or true null?

MDE at α=0.05 two-sided, power 0.80. Correlations: MDE r = tanh(2.8016/√(n−3)). Lifts: the logged CIs are **90%** bootstrap intervals (draws 100 and 1899 of 2000: `ftn_analysis.py:69-70`, `ol_analysis.py:76`), so SE = (hi−lo)/3.29 and MDE = 2.80·SE. Materiality anchor (the repo has no fixed floor): `matchups.js:43-47` treats ~0.1% of weekly MAE 4.333 (≈0.004 PPR/week) as what start/sit "cannot feel".

| Item | Test that was run | MDE | Verdict |
|---|---|---|---|
| FTN drop / contested-catch rate | YoY r: FTN drops/catchable +0.137 (n=236), PFR drop % +0.141 (n=252), contested-catch rate −0.082 (n=82). Next-season PPR/target lift (validate 2024→25, n=120, MAE 0.2166): +drop +0.00176 [−0.00112, +0.00444]; +contested −0.00007 [−0.00073, +0.00061] (VALIDATOR-LOG:200-217) | r: 0.182 / 0.176 / 0.305. Lift: drop 0.0047, contested 0.00114 PPR/target | **Stays rejected.** Premise false (PFR drop % already stored and used, `nfl-player-value.js:168`). Contested-catch best case at the CI edge ≈ 0.00073 × ~6 targets ≈ 0.004 PPR/game, at the "cannot feel" line. No more data exists: FTN starts 2022, PFR has no contested field; +27 pairs/season → MDE 0.27 after 2026. Pooled PFR check 2018-25 (≥50 tgt): drop % YoY r = +0.154 [0.074, 0.232], n=590 — real but weak. |
| Coach 4th-down aggression index | GOE (go-rate over league rate in yards-to-go × field zone × WP buckets), REG 2016-25, 320 team-seasons. YoY r same coach 0.498 (n=220); coach changed 0.114 (n=68). Next-season plays/game R² 0.0608 → 0.0665 (n=288) (VALIDATOR-LOG:296-312) | n=220: 0.188 (observed CI [0.39, 0.59], powered). n=68: 0.334 (underpowered). Fantasy: observed partial r 0.078 vs MDE 0.165 | **Stays rejected as a model input — a true small effect, not a data limit.** Even at the MDE: 0.165 × 2.84 plays/game SD ≈ 0.47 plays/game per SD → δ ≈ 0.11 PPR/game for a 15-PPR player → MAE gain ≈ 0.399·δ²/σ (σ 5.43) ≈ **0.0009 PPR/week**, well under 0.004. Noise ceiling: 117.7 decisions/team-season caps one-season reliability at ~0.52; observed 0.50, so the trait persists as much as noise allows. Only open arm: "coach vs roster" (n=68) could get ~127 more coach-changed pairs from nflverse PBP 1999-2015 (CC BY 4.0) → MDE ≈ 0.20; needs a download (disk 19 GiB free) and isn't needed if the display says "within tenure". |
| OL continuity → fantasy efficiency | Walk-forward weeks 5-18, fit 2023-24, validate 2025, team-clustered CI. YPC MAE 1.0498, Δ +0.00003 [−0.00034, +0.00042]; sack rate MAE 0.0405, Δ −0.00008 [−0.00031, +0.00016] (VALIDATOR-LOG:371-382) | YPC 0.00065 (0.06% of MAE); sack 0.00040 (1%) | **Stays rejected — well-powered true null.** CI-edge pass-through ≈ 0.001 (YPC) and ≈ 0.003 (sacks) PPR per team-game. |

**BL-40 — Coach 4th-down aggression as a "why" display item (display only; honest because it is a real, persistent coach trait that the app must not sell as predictive)**
- Not a duplicate: A-14 (WORK-QUEUE:190) swaps consumers to the raw team go-rate (team-keyed, season-to-date, not situation-adjusted; raw vs GOE r = 0.622). A-15 (:191) is a lift proof whose 4th-down arm this lab predicts will decline (cite VALIDATOR-LOG §3 instead of a new harness run). BL-40 is coach-keyed, situation-adjusted, pooled over tenure, with a CI.
- Goal: `fourth_down_goe` trait in `coachingProfile`: go-rate minus league rate in the same buckets, over the last ≤5 seasons of the coach's tenure, with n and 95% CI; CI including 0 → "no clear lean". Expected 2021-25: 61 coaches with ≥60 decisions, median n 286, median CI ±3.5 pp, only 15/61 CIs exclude 0 (single season ≈ ±5.2 pp vs a true spread of 2.7 pp, so pooling is required).
- Coach source: PBP `home_coach`/`away_coach` (nflverse, CC BY 4.0), not the unlicensed `games.csv`.
- Files: `server/services/nfl-pbp.js` (accumulate near :215-224, publish near :484), `server/services/football-context.js` trait list :205-231 next to A-14's key, source text in `server/services/coach/tools.js:199-206`. Keep it out of `nfl-sim-policy.js:509` (A-14's). Client render waits for C-16/C-17 (no Coach UI yet).
- Label: "Coach 4th-down aggression: goes for it +x pp vs league in the same spots (seasons, n, 95% CI). Describes decisions, not fantasy output. Tested at ~0.4 plays/game per SD; not used in projections."
- Acceptance: fixture test of the GOE + CI maths; on `nflverse.sqlite` same-coach YoY r ∈ [0.39, 0.59] and 2021-25 top/bottom 5 match VALIDATOR-LOG:305-306 within ±0.005; CI-includes-0 → "no clear lean" (~46/61); contract test: nothing in `projections.js`, `player-week-engine.js`, `lineup-brain.js` imports it and the payload carries `predictive_for_fantasy: false`.
- Depends on A-14. ~4-6 h.

---

## Cluster 5 — Blocked moonshots (paid LLM; Kaggle BDB)

**Machine facts (checked):** Apple M2, 8 cores, **8 GB RAM** (`sysctl hw.memsize` = 8589934592; the "18 GB" in notes is the archive size), disk 96% used / 19-24 GiB free. `ollama` is installed (`/opt/homebrew/bin/ollama`) with `llama3:latest` 4.7 GB (Llama 3 8B Q4, Meta Llama 3 Community Licence). No llama.cpp, LM Studio or mlx_lm. An 8B Q4 model needs ~5.2 GB with a 4k context — borderline on 8 GB while the app runs; a 3-4B Q4 (~2-2.5 GB; e.g. Phi-3.5-mini MIT, Mistral 7B/Qwen2.5-7B Apache-2.0 are the licence-clean larger options) would fit. Any new model is a download: Nick's call. Nothing installed.

### 5.1 Calibrated news extraction
- Root cause: **code** (resolvers unwired), cost secondary. The paid LLM path already exists and has run (`nfl-news-signal.js:413-467`, `claude-typed-news-2026.1`: 60 attempts / 41 claims locally; locally now fails `invalid x-api-key` by design). A rule extractor exists too (`nfl-news-signal.js:14` `typed-rules-2026.1`, hand-set unavailability odds `STATUS_RULES` :61: out 0.94, doubtful 0.76, questionable 0.38): 284 rows, 223 verified; **159 verified availability signals** (2026-09-08..21) with a player id can be checked against 2026 weeks 1-2 snaps (2,994 rows).
- Why nothing is calibrated: the resolvers (`beat-reporter-accuracy.js:163-463`) read only `nfl_news_events` (0 rows; filled only by the paid extractor) and have no non-test callers.
- Verdict: **free alternative first.** Calibrate the rule extractor against snaps; if calibrated rules can't beat official designations, the moonshot is answered for free; if they can, any LLM must beat calibrated rules, not static weights. Power today: questionable n=27 → ±0.18; out n=56 → ±0.06; by week 18 questionable ≈ ±0.065.

**BL-50 — Resolve rule-extracted availability claims against next-game snaps, weekly**
- Files: `server/services/beat-reporter-accuracy.js` (reuse the "same shape" input contract ~:156), `server/services/scheduler.js` (weekly job after the snaps sync), a `docs/evidence` report.
- Acceptance: RED first: "out" + 0 snaps → confirmed; available + snaps>0 → confirmed; no next game → unresolved. ≥150 resolutions from 2026 weeks 1-2 on the local copy. Report per status: n, observed rate, 95% interval, Brier of the hand-set odds vs the official designation at the same timestamp. Pre-registered kill at week 18: rules no better than designations → close the moonshot. ~4 h.

### 5.2 Manager personas
- Root cause: **sample size + decision (privacy/cost).** A non-LLM path is on main: `scripts/build-person-profiles.mjs` (40 variables, none priceable) + `grade-person-profiles.mjs` (repeatability: ≥8 people, Spearman ≥0.5, skill >0, `grading.js:63/66`). Running it on the chat corpus is N6 (Nick's Mac).
- A local 8B model removes cost and the privacy problem, but the only ground truth is ~75 resolved proposals (this lab's rows: 31 answered + 7 expired captured; the log's 48 declines / ~27 accepts count includes pre-window answers). MDE at n=75 is r = 0.319, so a persona would have to explain ≥10% of accept/decline to show at all: smoke test only. **Local-LLM persona stays parked.**
- Risk found in the existing grader: at 8 people it can only detect Spearman 0.85 (0.73 at 12); a pure-noise variable clears ≥0.5 ~10% of the time at n=8, so ~2-3 of 27 gradeable variables would pass by chance, and `--apply` would mark noise priceable.

**BL-51 — Permutation guard in the person-profile grader (run before N6)**
- Files: `server/services/coach/people/grading.js:183-270` + test.
- Goal: a variable passes only if its shuffle-based p-value, corrected across all variables, is < 0.05.
- Acceptance: 27 pure-noise variables over 8 people → 0 passes in ≥95% of 200 seeds; a planted r=0.9 variable over 12 people still passes. ~1-2 h.

### 5.3 Kaggle Big Data Bowl
- Root cause: **licence/terms.** Kaggle needs an account + rule acceptance (forbidden here; `docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md:110-133`, API 401). It covers a few past seasons and no 2026, so it could not feed the live model anyway.
- Free, already-ingested equivalents: Next Gen Stats (`nfl-advanced.js:102-109` → `nfl_ngs`, 12,136 rows on the lab copy), participation + FTN charting (`nfl-formations.js`; FTN is CC BY-SA 4.0 with "FTN Data via nflverse" attribution — F-08's concern). NGS upstream terms beyond nflverse's CC BY 4.0 not verified.
- Verdict: **stays blocked (licence/terms). No unit.**

---

## Cluster 6 — Nick-only decisions (not worked around)

Listed with the smallest decision that unblocks each. Most valuable first.

| # | Decision | Unblocks | Smallest yes/no |
|---|---|---|---|
| D1 (new) | Restart the refresh loop (PID 75522, running Sep-17 code with a 9-job list) on current main | `league_history` (wk2 scores), `manager_archetypes`, `manager_signals` for leagues 1/2/3/5, `nfl_weekly_learning` on your Mac's app DB — all proven to run in seconds here and by OPS-01's one-off tick | "Yes, restart it" (≈1 min; it writes your real `server/data.sqlite`). Do it before Thursday 2026-09-25 00:15Z so W3 snapshots are captured pre-kickoff. `nfl_model_growth` will keep failing until BL-01, usage until BL-02 |
| N2 | Next deploy + brake | Everything above on Fly: the brake stops every tier there | "Deploy tip X, brake stays ON" or "release the brake" |
| N1 (reduced) | ESPN cookie on the live collector | F4/B6/C17 on Fly only | "The Mac collector is the system of record" (then N1 closes; 62 real outcome rows already derive locally) — or set the cookie as a Fly secret |
| N9 | Migration words | F-05 (#94 → 067), BL-20 (no new migration), #93 068, #88 063/064 collision | "GO on 067" |
| N6 | Chat-corpus run on your Mac | B6 person variables | Land BL-51 first (else noise variables get marked priceable), then run the two scripts |
| N8 | Advanced-stats arm (air-yards share + WOPR) | A2 | Approve / decline |
| N4 | Rotate 5 credentials (3 exposures, 0 rotated) | security | Rotate, or name a date you accept the risk until |
| N5 | Production DB read (5 commands + `fly secrets list` names incl. `AUTO_HEAVY_SYNC`) | production columns, heavy-tier state on Fly | Run and paste, labelled production |
| N12 | Push device/channel + permission to write lineups to ESPN | B11, C16 | Pick the device; yes/no to "tap to apply" |
| N11 | Deletions (`Model.tsx`, `Edge.tsx`, branch `tdd/xiezr0-hosted`, MLB tables) | D25 | Yes/no per item |
| N10 | Keep/close stale drafts #66 #79 #80 #83 #144 #46 | board hygiene | Keep/close per PR |
| N13 | C17 exploration offers (messages to league-mates) | C17 | "None" or "N per week" |
| N7 | Paid data / paid LLM (twitterapi-io, PFF, Jev refresh, news LLM) | A3 breadth, D24, `manager_archetype_jev` | Default "no"; BL-50 answers the news-LLM question for free first |
| N3 | Rollback image `deployment-01M2VZ9JRYSXVHCRWJ83V360QH` | F7 recovery | "Confirmed" |
| N14 | Usage pace (BURST/STEADY/PUSH) + meter readings | fleet pace | Pick one |
| D2 (new, optional) | Any model download (local LLM beyond the installed llama3 8B; nflverse PBP 1999-2015 for the coach-vs-roster arm) | only if BL-50 fails / only if BL-40 wants a "coach, not roster" claim | None needed now |
| obs | Public repo has no LICENSE file | nothing in the plan | none |

## Unit index (proposed)

| Unit | One line | Size | Depends on |
|---|---|---|---|
| BL-01 | `nfl_model_growth` budget 45 min (worker) + close killed runs; review `nfl_reports` | ~1 h | — |
| BL-02 | `nflverse_weekly_usage` + `nflverse_snap_counts` on the refresh loop list | ~45 min | — |
| BL-03 | Usage freshness rule "last completed week present", on #104's live rule (+ optional BL-03b fallback on main) | ~1 h | #96 → #104 |
| BL-05 | Settle played-no-stat as 0; DNP pending with a reason | ~1 h | — |
| BL-20 | Settle expired / countered / league review from the rows #94 reads | ~2-3 h | F-05 (#94) |
| BL-40 | Coach 4th-down GOE as a display-only "why" trait | ~4-6 h | A-14 |
| BL-50 | Resolve rule-extracted availability claims vs next-game snaps, weekly | ~4 h | — |
| BL-51 | Permutation guard in the person-profile grader | ~1-2 h | before N6 |

Stays rejected / blocked (measured): FTN contested-catch & drop rate; OL continuity; 4th-down index as a model input; Kaggle BDB; local-LLM personas; ESPN market refresh for 2026.

Open question (not worked): `nfl-player-value.js:168` prices players on PFR drop %, whose year-to-year r is only 0.15 (n=590, pooled 2018-25). A lift check on that modifier is a separate ask.

Cleanup: worktree `~/gridiron-local/wt/blocker-lab` removed; temporary fetch refs `refs/remotes/bl/pr96`, `bl/pr104` deleted. Kept as evidence: `~/gridiron-local/blocker-lab/` (lab DB copy 0.9 GB — safe to delete when done; scripts; census and run logs).
