# GR-01: the recommendation ledger (C13 grading, C17, C-08)

Unit GR-01, plan item 13 (decision post-mortem loop). Branch
`claude/local-gr-01-recommendation-ledger`, cut from origin/main `89f69b3b`.

## 1. Audit: what already exists for this surface (tree 89f69b3b)

Commands: `grep -rn 'trade_outcomes' server`, `grep -rln 'CREATE TABLE IF NOT EXISTS [a-z_]*\(decision\|recommend\|grade\|ledger\)' server`,
`grep -rn 'INSERT[A-Z ]* INTO player_week_usage' server`, and the reads below.

| Existing surface | Table / writer (file:line) | What it answers | Why it is not this unit |
|---|---|---|---|
| Decision Inbox | `decision_recommendations`, `server/migrations/020_decision_recommendations.js`; publisher in `server/routes/decision-inbox.js` | "what has the app told me, and did I act on it" (open / actioned / dismissed / expired) | lifecycle of a nudge; no prediction, no baseline, no horizon, no score. An upsert keyed on `dedup_key` overwrites the prediction in place, so it cannot be graded later. |
| Trade outcome ledger | `trade_outcomes`, `server/migrations/067_outcome_ledgers.js`; writers `recordProposedOutcome` / `recordConsideredOnly` / `recordProposalSlate` at `server/services/trade-outcomes.js:234`, `:262`, `:321`; only caller `server/routes/trades.js:783` (`/proposals`) | "when the model said 70% he would accept, did he" (acceptance calibration of the AI proposals slate) | measures ACCEPTANCE of the `/proposals` slate. It records no points outcome and no horizon, and it is never written by `/find`, `/offer`, `/offer-many`, `/lineup` or `/waivers`. |
| NFL decision tape | `nfl_decision_runs` / `nfl_decision_events`, `server/migrations/027_decision_tape.js` | betting-side policy decisions | betting scope; out of this unit. |
| Forward ledger | `forward_picks`, `server/services/forward-ledger.js` | betting picks before kickoff | betting scope. |

**Realised weekly points, the one producer.** Two candidates exist:

- `player_gamelog.fantasy_points` (writer `syncGameLogs`, `server/routes/edge.js:99`): fixed PPR, top-250
  players only, defaults to the prior season. On the local copy (not production) it holds **0 rows**:
  `sqlite3 .local-db/data.sqlite "select season,count(*) from player_gamelog group by season"` returns nothing,
  while the known-nonzero control on the same file,
  `select season,count(*),max(week) from player_week_usage group by season order by season desc limit 3`,
  returns `2026|1052|2`, `2025|8857|18`, `2024|8675|18`.
- `player_week_usage` (writer `server/services/nflverse.js:260`, job `nflverse_weekly_usage`), scored per
  league by `scoreLine(u, scoringFor(lg))` (`server/services/scoring.js:52`, `:82`). This is what
  `actuals(season, scoring)` in `server/services/backtest.js:26` already does.

The grader reuses `actuals()` from `backtest.js`; it does not write a third scorer.

**Extend or build: BUILD a new table, reuse every producer.** `trade_outcomes` is the closest neighbour, but
its unit of truth is an accept/decline event keyed on the `/proposals` slate, and its CHECKs require
`model_p_accept` on a proposed row, which `/find`, `/offer` and `/lineup` do not produce. Folding points
grading into it would either weaken its contract or leave lineup and waiver calls with nowhere to go. A
separate `rec_ledger` answers the other question the plan item asks (did the call gain points against the
call we would otherwise have made), and it names `trade_outcomes` as its sibling rather than duplicating it:
no acceptance probability is stored here.

## 2. Pre-registration

Not applicable. This unit ships plumbing (a ledger, its writers, a grader and a count reader). It produces no
model number and no ship/no-ship claim; the grader's scores are stored, not reported as evidence. The first
unit to read `score` as evidence (GR-02, the report card) owns its pre-registration. No look at the 2025
held-out season was taken (Holdout looks: none).

## 3. RED / GREEN

- RED: `test: RED for the recommendation ledger, its grader and its reader (GR-01)`, `de37a3f4`. Stubs for
  `rec-ledger.js` / `routes/grades.js` plus migration 071, so the tests fail on behaviour. Failing assertions,
  quoted from the TAP output on that commit:
  - `test/rec-ledger.test.js` "record() writes one row per horizon": `'not_implemented' !== 'recorded'` (11 of 11 fail).
  - `test/rec-ledger-route.test.js` "GET /find records each shown deal": `0 !== 4` (9 of 9 fail).
  - `test/rec-ledger-considered.test.js` "every idea the edge test removed": `0 !== 20`.
- GREEN: `feat: record every recommendation and grade it at +1, +2 and +5 weeks (GR-01)`, `7e8ee6dc`, plus the
  follow-up commit that carries this file (it drops one test that could not die, see section 5).
  Targeted runs on the GREEN tree, each `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`:
  `rec-ledger` 12/12 pass, `rec-ledger-route` 9/9, `rec-ledger-considered` 2/2.
  Neighbours re-run on the same tree, all exit 0: `trade-outcomes-route` 5/5, `find-trades` 3/3, `trade-tactics` 39/39,
  `growth-jobs-off-thread` 6/6, `scheduler-job-modules` 13/13, `waiver-brain` 8/8, `decision-leftovers-waivers` 7/7,
  `waiver-kicker-defense` 7/7. `node scripts/wiring-map.mjs --check`: exit 0, "no missing-feed findings", no
  `rec_ledger` finding.
- Liveness on the FINAL tests: in a scratch worktree at `7e8ee6dc`, `rec-ledger.js`/`grades.js` restored to the RED
  stubs and `trades.js`, `trade-engine.js`, `waiver-wire.js`, `scheduler.js`, `index.js` restored to origin/main:
  `rec-ledger` 0/12 pass, `rec-ledger-route` 0/9, `rec-ledger-considered` 1/3. The one pass was "a cached second
  search writes nothing new", which cannot fail while inserts are `OR IGNORE`; it was removed (section 5).

## 4. What it does

| Piece | Where |
|---|---|
| Table `rec_ledger` (additive migration `071_rec_ledger`; `down()` drops it only while empty, gate round) | `server/migrations/071_rec_ledger.js` |
| Writer `record()` (INSERT OR IGNORE, one row per horizon) | `server/services/rec-ledger.js:104` (insert at `:123`) |
| Route adapter `recordRoute()` / `recsFromRoute()` | `server/services/rec-ledger.js:231`, `:173` |
| Call sites, one each, responses unchanged | `server/routes/trades.js:222` (/lineup), `:681` (/waivers), `:734` (/find), `:821` (/offer), `:836` (/offer-many) |
| Considered-not-shown rows (C-08) | `recordConsidered()` `rec-ledger.js:257`, called only from `recordRoute('find')` `rec-ledger.js:234`. The ideas ride on the findTrades result under the Symbol `LOST_IDEAS` (`rec-ledger.js:250`), set at `server/services/trade-engine.js:1897` only when no `teamsOverride`/`assetsOverride` is given (round-1 fix, section 8) |
| Ids on the waiver board so a claim is gradable (additive fields) | `server/services/waiver-wire.js:287`, `:299`, `:308` |
| Grader `gradeDue()` (UPDATE at `:346`), week gate `weekIsOver()` `:320` over `leagueCurrentWeek` `server/services/league-week.js:12` | `server/services/rec-ledger.js:331`; realised points from `actuals()` `server/services/backtest.js:26` over `player_week_usage` |
| Scheduler job `rec_ledger_grade` (growth tier, off-thread, 6 h) | `server/services/scheduler.js:742`, `:1567` |
| Reader `ledgerSummary()` | `server/services/rec-ledger.js:381`, served by `GET /api/grades/:leagueId/ledger` `server/routes/grades.js:15`, mounted `server/index.js:127` |

Grades: lineup at +1 week (each decided slot's starter vs the benched `over`); trade at +2 and +5 weeks
(points received minus points sent; baseline no trade); waiver at +2 and +5 weeks (added minus dropped;
immediate claims cut `drop_candidate`, stashes cut `ros_drop_candidate`). Horizon h covers weeks
`week .. week+h-1`; a row is graded only when the league clock (`leagueCurrentWeek`) is past `week+h-1` AND every one of those weeks has `player_week_usage` rows.

## 5. Numbers, with commands

**Mutation sweep** (scratch worktree `GR-01-mut` at `7e8ee6dc`; script `mutate.py` applies one mutant, runs the
named test file, restores). 15 killed, 1 designed survivor, 1 not-applied control:

| Mutant | Test | Result |
|---|---|---|
| M1 trade horizons [2,5] -> [2] | rec-ledger | killed (6 fail) |
| M2 inputs_hash includes the prediction | rec-ledger | killed |
| M3 grade when ANY horizon week is played | rec-ledger | killed |
| M4 trade score sign flipped | rec-ledger | killed |
| M5 lineup alternative points = 0 | rec-ledger | killed |
| M6 INSERT OR IGNORE -> OR REPLACE | rec-ledger | killed |
| M7 reader counts every league | rec-ledger-route | killed |
| M8 call site: /lineup record call removed | rec-ledger-route | killed |
| M9 call site: /find passes route name 'offer' | rec-ledger-route | killed |
| M10 call site: /offer-many record call removed | rec-ledger-route | killed |
| M11 call site: findTrades passes variants, not ideas | rec-ledger-considered | killed |
| M12 call site: findTrades considered call removed | rec-ledger-considered | killed |
| M13 call site: waiver board drops the claim id | rec-ledger-considered | killed |
| M14 call site: grades router not mounted | rec-ledger-route | killed |
| M15 grader job not off-thread | rec-ledger | killed |
| S1 designed survivor: grader row ORDER BY (equivalent) | rec-ledger | survived, as designed |
| N1 not-applied control: pattern absent | rec-ledger | not applied, tests pass |

The considered test's edge test is the real `edgeTest` with one forced failing check on odd hundredths of the
weekly gain, because a priced, lopsided fixture alone gave `considered 137, deals 30, edge_removed 0`
(probe on this tree). With the forced check: `edge_removed 10`, `edge_removed_variants 32`.

**Local copy, not production** (`.local-db/data.sqlite`, `.backup` of `~/gridiron-local/data.sqlite` on
2026-09-23; migration 071 applied to the copy by `up(db)`; script `.local-db/live.mjs`, uncommitted; tree `7e8ee6dc`):

| League (local id) | lineup rows | waiver rows | trade rows (shown / considered) | recordRoute cost |
|---|---|---|---|---|
| 1 | 1 (7 calls) | 14 (7 immediate x 2) | 12 / 2 (edge_removed 1) | 8.6 ms, 2.6 ms, 2.7 ms |
| 2 | 1 (7 calls) | 6 (3 x 2) | 26 / 0 (edge_removed 0) | 13.2 ms, 1.6 ms, 5.4 ms |

`gradeDue()` on the same copy: `graded 0, pending 62`. Known-nonzero control first: played weeks for 2026 on the
copy are `[1, 2]`, and every recorded row is for week 3 (`tradeWeekContext()`), so nothing is due yet; the first
lineup grades land when week 3's `player_week_usage` rows do. The cached second `findTrades` call returned the
same object (cache hit, 205.5 ms and 237.9 ms vs 42.8 s and 27.2 s cold); whether it wrote rows was not
measured separately (inserts are `OR IGNORE`, so a re-write could not add a row anyway).

Holdout looks: none. Statistical discipline (b)-(e) is not triggered: this unit reports no model number and no
win rate; the ledger is the instrument GR-02 will read.

## 6. Known defects and limits

- Trade and waiver scores are raw player points, not lineup points: a received player on the bench still counts.
- Waiver horizons (+2/+5) are a guess copied from trades; the plan item names only lineup and trade horizons.
- A lineup recomputed after an injury within a week is a second row (different inputs); GR-02 must pick the last
  call before kickoff (RL-4-2 owns lock timing).
- ~~A week counts as played when any `player_week_usage` row exists for it~~ fixed in round 1 (section 8): the league clock must also have passed it.
- A row whose last horizon week is 18 grades only once the league's `season` moves on (`leagueCurrentWeek` caps at 18); a horizon past week 18 never has usage rows and stays pending. Neither is measured on real data; guess that it matters little (week 14+ trades are rare).
- `inputs_hash` (`rec-ledger.js:76`) covers league, kind, season, week and inputs (partner, give, get), not roster state; the unique index (`071_rec_ledger.js:53`) adds disposition and horizon. Two real-roster `/find` searches in one week that price the same package differently keep the first ppg_delta. What-if searches can no longer reach the table (section 8).
- Two routes offering the same package in the same week share one row (first source wins), by design.
- `scenario` is an allowed kind with no writer and no horizon; `record()` refuses it until GR-02 defines one.
- `/proposals` stays on `trade_outcomes` (acceptance); it is not double-written here.

## 7. Nick's five questions

1. **Well built?** One writer, one grader, one reader, each with file:line above; parameterised SQL only; no bare
   catch (the one catch in `record()` logs and returns `state: 'error'`, tested); 15 of 15 real mutants die (round 0), and 5 of 5 real round-1 mutants die (section 8).
2. **Stats or made up?** No statistic is claimed. Scores are arithmetic on realised points; horizons are the unit
   row's (+1, +2, +5), waiver horizons are a guess.
3. **How we know:** tests on fixtures with exact expected scores at each horizon, and a local-copy run showing
   rows land from the real engines (62 rows over 2 leagues). No backtest: nothing to backtest yet.
4. **Pointed anywhere else?** `GET /api/grades/:leagueId/ledger` only. No page change (GR-02 builds the report card).
   Nav unchanged at 8 tabs.
5. **How it unifies:** realised points reuse `backtest.js actuals()` + `scoringFor` (no third scorer); week comes
   from the engines' own `tradeWeekContext()` via their responses; acceptance stays in `trade_outcomes`, points
   grading lives here, and neither stores the other's number.

## 8. Skeptic round 1 (tree 0c3775c7)

Three findings, all accepted and fixed; no skeptic was wrong.

| Finding | Fix | Test (RED on 5e8537e6 = 3d983c85 + new tests) |
|---|---|---|
| Considered rows written from what-if searches (`/sequences` teamsOverride) and from 5+ callers, while shown rows come only from `/find` | findTradesUncached no longer writes. It attaches the removed ideas under a non-enumerable Symbol `LOST_IDEAS` only when no override is set; `recordRoute('find')` writes them beside the shown rows. No response JSON changes (Symbol keys are not serialised). | rec-ledger-considered #1 (what-if search and `findTradeSequences` write 0 rows; control: what-if search had edge_removed > 0) and #2 (`findTrades` alone writes 0; `/find` path writes edge_removed x 2; refresh inserts 0) |
| Lineup same-slot guard (`!used.has(k)`) untested | none needed in code | rec-ledger #14: RB/RB starters 10 and 20, shared alternative 5: slots_graded 2, starters [9101, 9103], score 20 |
| Week "played" on any usage row; `leagueLastCompletedWeek` disagrees | `weekIsOver()`: past season, or `leagueCurrentWeek(lg) > last horizon week`; usage rows still required. Uses `leagueCurrentWeek`, not `leagueLastCompletedWeek`, because the latter floors at 1 and would call week 1 complete during week 1 (a second disagreement, named here; not changed in league-week.js, which is outside this unit). | rec-ledger #8 (only the Thursday line of 9102 at week 3, clock 3: graded 0) and #9 (weekIsOver cases incl. week 1) |

Commands (targeted, `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`):
- RED, tree 5e8537e6: rec-ledger 12 pass / 3 fail (#8, #9, #10; #10 fails because #8 already graded the lineup); rec-ledger-considered 1 pass / 2 fail (#1, #2). The RB/RB test passes on the old code by design: it guards existing behaviour and is proved live by mutant U1.
- GREEN, tree 0c3775c7: rec-ledger 15/15, rec-ledger-route 9/9, rec-ledger-considered 3/3. Neighbours exit 0: find-trades 3/3, trade-tactics 39/39, trade-outcomes-route 5/5, scheduler-job-modules 13/13. `node scripts/wiring-map.mjs --check` exit 0, "no missing-feed findings".
- Mutants (scratch worktree at 0c3775c7, removed afterwards): U1 drop `!used.has(k)` killed by #14; U2 drop the weekIsOver gate killed by #8/#10; U3 `>` to `>=` in weekIsOver killed by #8/#9; C1 attach LOST_IDEAS on override searches killed by considered #1; C2 recordRoute skips considered killed by considered #2. Designed survivor C3 (record LOST_IDEAS from any route, not just 'find'): survives because no other route passes a findTrades result to recordRoute, so it is behaviour-equivalent today.

Local copy, not production (`.local-db/data.sqlite`, tree 0c3775c7, after the round-0 live.mjs run): league 1 considered rows 2 before, 2 after `findTradeSequences` (which returned 3 sequences, so step 2 ran; the skeptic measured 2 to 8 on the old code). Then `/find` path (`findTrades` requireMutual false + `recordRoute('find')`): edge_removed 2, inserted 4 considered rows. League 2: sequences 3, considered 0 to 0; `/find` edge_removed 0, inserted 0. `gradeDue()`: graded 0, pending 132; both leagues have `current_week` 3 and every row is for week 3, so nothing is due (grading itself is proved by the fixture tests).

## 9. Gate round (full run `/tmp/gate-GR-01.log`, tree e2f9d08c)

Full suite: 4259 tests, 4214 pass, 4 fail, 41 skipped. Three of the four are this branch; one is not.

| Failing test | Cause | Owner |
|---|---|---|
| model-registry-persistence "latest migration down and re-up are transactional and reproducible" | `migration 071_rec_ledger has no down(db) export` (`server/db/migrate.js:70`) | this branch |
| migration-027-populated-upgrade "C03: 028 refuses to downgrade..." | same: `unwindTo()` walks back through 071 | this branch |
| migration-027-populated-upgrade "C03: 027 refuses to downgrade..." | same | this branch |
| route-deletion-impact "a call site inside an already-unreached function is a survivor" | not this branch. The branch touches neither `scripts/route-deletion-impact.mjs` nor its test (`git diff origin/main HEAD -- scripts test/route-deletion-impact.test.js` is empty). origin/main `131a7ba0`'s own copies of `scripts/`, `server/`, `docs/wiring/` and the test, extracted with `git archive` to a scratch dir and run under local Node 25.9: the same test fails, 7 pass / 1 fail. Main's CI (Node 22) is green on the same file. Local-environment failure, pre-existing. | not GR-01 |

**Fix.** `071_rec_ledger.js` gains `down(db)`: it refuses while `rec_ledger` holds any row (each row is a frozen
recommendation and its grade; dropping it deletes evidence, the same refusal 027 makes) and otherwise drops the
two indexes and the table. `up()` is unchanged and still additive.

- RED `0b826f96` (`test/rec-ledger.test.js` #16, #17): 15 pass / 2 fail, both `'migration 071_rec_ledger has no down(db) export'`.
- GREEN (the commit carrying this section): rec-ledger 17/17, model-registry-persistence 22/22,
  migration-027-populated-upgrade 16/16, rec-ledger-considered 3/3, rec-ledger-route 9/9. Each run
  `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.
- Liveness: mutant D1 (`if (n)` to `if (false && n)`, so a populated ledger is dropped) turns rec-ledger to 15 pass / 2 fail
  (#16 fails on the missing refusal; #17 then fails because D1 already dropped the table). Restored afterwards.
