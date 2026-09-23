# RL-8-3: stop printing a made-up strength-of-schedule rank

Unit RL-8-3 (plan C18, accuracy theater, URGENT). Source: R&D round 8 internal package
`rnd/loop/r8-internal-schedule-rank-is-washington-count.md` (local, not in repo). Branch
`claude/local-rl-8-3-remove-fake-sos`, cut from origin/main `3ac59fea` (#168).

Not a statistical unit: no model number is produced, so there is no pre-registration. No 2025
held-out data was opened, so no HOLDOUT-LEDGER row.

## 1. Audit: what exists, extend or build

Grep on origin/main `3ac59fea`: `grep -rnE "computeSOS|Remaining schedule|Strength of schedule" server client/src`.

| Surface | file:line | What it does today |
|---|---|---|
| Producer | `server/routes/nfldata.js:293-322` `computeSOS` | Opponent strength = `COALESCE(SUM(player_metrics.value),0)` for `source='fc_value'`. No empty check: with 0 rows every team is 0, the `?? avg` fallback fires only for the unknown code `WSH`, and the stable sort ranks teams 1-32 by "games vs Washington, then row order". |
| Table read | `player_metrics` (`source='fc_value'`) | Writer `syncFantasyCalc` `server/routes/aggregates.js:88-122`, reachable only from `/aggregates/sync` and `/aggregates/refresh-all`; the R&D package measured 0 `fc_value` rows on the local copy. |
| Consumer 1 | `server/routes/players.js:156` (`playerEvidenceFacts`), `:201` | Adds fact `schedule.rank` "Remaining schedule ranks N/32 where 1 is easiest." to the Buy/Sell evidence packet; `groundPlayerVerdict` falls back to `facts.slice(0,3)`, which includes it. |
| Consumer 2 | `server/routes/nfldata.js:338,367` `/offseason/:abbr` -> `client/src/components/OffseasonPanel.tsx:37-44` | X's & O's team page: "#N / 32, One of the hardest slates". |
| Consumer 3 | `server/routes/analysis.js:35,57` | Claude team-analysis prompt: "Strength of schedule ranks N/32". |
| Consumer 4 | `server/routes/nfldata.js:324` `GET /sos` | Serves the raw list. No client caller (`grep -rn "/sos" client/src` -> only `playoff_sos`/`season_sos` in Edge.tsx, a different producer). |
| Schedule writer | `server/routes/nfldata.js:145-146` `syncSchedules` -> table `schedule_games` | Finds "me" by `abbreviation === abbr`; ESPN sends `WSH`, loop key is `WAS`, so Washington rows get `home=0` and 9 of them name WSH (itself) as opponent; rivals store `WSH`. |
| Read-side repair | `server/services/matchups.js:285` `repairSchedule` | Already canonicalises + repairs self-opponent and home flags in memory; its comment says "The fix at the source belongs in the sync". |
| Canonical code map | `server/services/team-codes.js:35` `canonicalTeamCode` | `WSH -> WAS` already there. |
| Signal gate | `server/services/matchups.js:66,72` `DVP_MULTIPLIER_ENABLED=false`, `MATCHUP_SIGNAL_REASON` | The walk-forward test found no schedule/matchup adjustment that beats none. |

Decision: **extend**, no new producer.
- Schedule strength is not a validated signal (R&D r6; `MATCHUP_EVIDENCE`), so the rank is removed from every
  surface that prints it (players.js fact, analysis prompt, offseason route + panel). The panel shows
  `MATCHUP_SIGNAL_REASON`, the same words every other surface already uses.
- `computeSOS` gets a loud empty-data guard (returns `status: 'not available'` with the table and writer named,
  and warns) and canonicalises opponents instead of the `?? avg` fallback. When data exists it still returns
  descriptive values on `GET /sos` only, flagged `signal: false`.
- `syncSchedules` canonicalises with `canonicalTeamCode` at the writer; the stored rows are backfilled by an
  UPDATE (no deletes) that reuses `repairSchedule` (now exported), run at the end of every schedule sync and
  returned as counts.
- No migration, no new table or column.

## 2. RED / GREEN

- **RED** `b8e85134` "test: RED for the made-up strength-of-schedule rank and the WSH schedule writer".
  `test/schedule-strength-not-made-up.test.js`, 6 of 6 fail on origin/main code:
  1. `assert.equal(sos.status, 'not available')` -> actual `undefined` (computeSOS returned a ranked array on 0 `fc_value` rows).
  2. `assert.equal(sos.signal, false)` -> actual `undefined` (known-nonzero control: filled store).
  3. `assert.deepEqual(hits, [])` -> actual `['server/routes/analysis.js', 'server/routes/players.js', 'client/src/components/OffseasonPanel.tsx']`.
  4. `assert.equal(typeof players.playerEvidenceFacts, 'function')` -> actual `'undefined'`.
  5. `assert.equal(body.sos, undefined)` -> actual `{ abbr: 'WAS', games: 2, home_games: 0, ... rank }`.
  6. `assert.deepEqual(got, {...})` -> actual `{ WAS1: 'WSH/0', DAL1: 'WSH/0', PHI2: 'WSH/1', ... }`.
- **GREEN** `46d5fc7f` "fix: stop printing a made-up schedule rank; canonicalise WSH at the schedule writer". 6/6 pass.
  Neighbours on the same tree: `test/matchups-no-signal.test.js` 5/5, `test/model-integrity.test.js` 89/89
  (its grounding fixture's `schedule.rank` fact was swapped for a real fact id, `market.sleeper_rank`).
  `node scripts/wiring-map.mjs --check` exit 0, "no missing-feed findings".
  Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.

## 3. What it does

- `computeSOS` (`server/routes/nfldata.js`): with no `fc_value` strength for any team it logs a warning and returns
  `{ status: 'not available', signal: false, reason, teams: [] }`, naming the table and writer. With data it returns
  descriptive values only (`status: 'descriptive'`, `signal: false`, `reason: MATCHUP_SIGNAL_REASON`, no `rank`),
  canonicalises opponent codes and counts unknown opponents instead of silently substituting the average.
  Only reader: `GET /nfl/sos`.
- Buy/Sell evidence (`players.js playerEvidenceFacts`, now exported for the test): the `schedule.rank` fact is gone.
- Team-analysis prompt (`analysis.js refreshTeam`): the "Strength of schedule ranks N/32" sentence is gone.
- `/nfl/offseason/:abbr`: `sos` removed; new field `schedule_signal: { signal: false, reason }`, read by
  `OffseasonPanel.tsx`, which shows "No validated signal", the reason, and home games counted from the served schedule.
- `syncSchedules`: compares and stores `canonicalTeamCode(...)`, then calls the new `repairStoredSchedule(season)`,
  which runs `matchups.js repairSchedule` (now exported, unchanged) over the stored rows and UPDATEs only rows that
  change. The sync result carries `repaired` counts. No delete, no migration, no new table or column.

## 4. The numbers (local copy, not production)

Copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '.local-db/data.sqlite'"` on 2026-09-23, tree `46d5fc7f`.

| Check | Before | After backfill | Command |
|---|---|---|---|
| `player_metrics` `fc_value` rows | 0 | 0 | `select count(*) from player_metrics where source='fc_value'` |
| control: `sleeper_rank` rows | 1627 | 1627 | same, `source='sleeper_rank'` |
| `computeSOS(2026)` | ranked 32 teams (origin/main code) | `{"status":"not available","teams":0}` | scratch `live.mjs` |
| 2026 rows with an opponent not in `nfl_teams` | 26 | 0 | `select count(*) from schedule_games where season=2026 and opponent_abbr not in (select abbr from nfl_teams)` |
| WAS rows naming itself (WAS/WSH) | 9 | 0 | join `nfl_teams`, `t.abbr='WAS' and opponent_abbr in ('WAS','WSH')` |
| WAS home games | 0 | 9 of 17 | `sum(home)` for WAS |
| `schedule_games` total rows | 544 | 544 (no deletes) | `select count(*) from schedule_games` |
| backfill result | | `opponents_canonicalised 26, self_opponent_repaired 9, home_flag_repaired 9, rows_updated 26` | `repairStoredSchedule(2026)` |
| read-side `matchupModel().schedule_repairs` | 26 / 9 / 9 | 0 / 0 / 0 | same script |
| backfill rerun | | `rows_updated 0` (idempotent) | same script |

Liveness (same copy, express app on the real router): `GET /nfl/offseason/WAS` -> 17 schedule rows, 9 home,
0 self-opponent, no `sos` field, no `"rank"` anywhere, `schedule_signal.signal=false`; `GET /nfl/sos` -> `status: "not available"`.

Production gets the backfill the next time `syncSchedules` runs (`POST /nfl/sync/schedules`, the NFL sync-all,
or `/dev/refresh-all` at `server/routes/dev.js:91`).

## 5. Mutation sweep (tree `46d5fc7f`, scratch `mut.py`, file restored after each)

| Mutant | Result |
|---|---|
| M1 remove the empty-data guard | killed by test 1 |
| M2 writer compares raw ESPN code | killed by test 6 |
| M3 writer stores the raw opponent code (the backfill still canonicalises) | killed by test 6 (count `opponents_canonicalised` 4 != 2) |
| M4 call site: `syncSchedules` does not call the backfill | killed by test 6 |
| M5 call site: re-add the `schedule.rank` fact in players.js | killed by tests 3, 4 |
| M6 call site: offseason route serves `sos: computeSOS(season)` again | killed by test 5 |
| M7 `computeSOS` drops `canonicalTeamCode` | killed by test 2 |
| M9 designed survivor: delete the guard's `console.warn` | survived, as designed: the returned `status` is the contract, the log line is not asserted |
| M8 not-applied control (pattern absent, `git diff` empty) | survived, as expected |

## 6. Statistical discipline

Not a model unit: nothing is fit or graded, and no 2025 data was opened, so no HOLDOUT-LEDGER row, no forward
holdout, no MDE and no decision win rate apply. The change removes an input that was not measured (the rank);
it does not claim the Buy/Sell verdict got better.

## 7. Known defects and follow-ups

- `fc_value` still has no scheduled writer (S-10 / PR #170). (`GET /nfl/sos` and `computeSOS` were deleted in
  section 9; the one producer left is `edge.js#scheduleEdge`, which is null and unranked on an empty store.) A rank may only return through a schedule arm that passes the
  `MATCHUP_EVIDENCE` walk-forward protocol.
- `edge.js`, `gamescript.js:174` and `nfl-opening-lines.js:52` keep their own WSH aliases; after the backfill they
  are no-ops. Removing them is a follow-up, not done here (other files, other owners).
- `unitGrades` (`nfldata.js`) still reads `fc_value` for its "top-50 fantasy asset" badge and silently loses it on
  the empty store (S-18 item, not touched).
- "Remaining" was also false (the old rank averaged all 17 games). Moot now that no rank is printed.

## 8. Nick's five questions

1. **Well built?** One producer left (`edge.js#scheduleEdge`; `computeSOS` deleted, section 9), one repair reused
   (`repairSchedule`), one canonical code map (`canonicalTeamCode`). 7 tests, 7 of 7 original real mutants plus
   3 skeptic-round mutants killed, UPDATE-only backfill that is idempotent.
2. **Stats or made up?** Before: made up (the rank was "games vs Washington, then row order" on 0 `fc_value` rows).
   After: no number is printed; the page says why.
3. **How we know?** The table above: local-copy counts before/after with the commands, plus the route liveness check.
4. **Pointed elsewhere?** The player card's Scout report and Trade Lab outlook already showed no schedule signal;
   now the Buy/Sell evidence and the X's & O's panel agree with them and use the same reason text.
5. **How it unifies?** Every schedule surface now uses `MATCHUP_SIGNAL_REASON`; the schedule rows themselves are
   canonical at the writer, so the read-side repair in `matchupModel` reports 0 repairs.

## 9. Skeptic round 1 (commit `3329c70f`)

Sections 3-5 describe tree `46d5fc7f`. This section supersedes them where they mention `computeSOS` or `GET /nfl/sos`.

**Finding A (test liveness): the home-flag half of the backfill was untested.** Correct. Test 7 had no stale
Washington HOME row. Added `(2031, WAS, wk4, 'WSH', 0)` and `(2031, PHI, wk4, 'WSH', 0)`; expects `WAS4 PHI/1`,
`PHI4 WAS/0`, `home_flag_repaired === 1`, `opponents_canonicalised 4`, `self_opponent_repaired 2`, `rows_updated 4`.
Implementation unchanged (it was right; the test was too weak).

**Findings B-D (structure): two producers, partial-data 0, orphan route.** Correct.
`git grep -n "nfl/sos\|'/sos'" -- client server` on `fdd60d65` matched only the route definition, so
`computeSOS` + `GET /nfl/sos` were deleted (code removal, no data change). `edge.js#scheduleEdge` is now the one
producer of schedule strength (Edge page `client/src/pages/Edge.tsx:305-309`, `/scout` prompt `edge.js:282`). It
already treats `v <= 0` as missing (league average) and returns null/unranked on an empty store; the new tests 2-3
pin that.

Both values on the same input (skeptic's fixture: fc_value DAL=3000, PHI=6000, WAS none; tree `fdd60d65`):
computeSOS PHI 0.333, DAL 0.667, WAS 1; scheduleEdge DAL 1.167 (rank 1), PHI 0.833, WAS 1. Test 3 re-derives
the scheduleEdge side: DAL `(4500+6000)/2/4500`, PHI `(4500+3000)/2/4500`, DAL > PHI.

Tests, all `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap <file>`:

| Tree / mutant | Result |
|---|---|
| `3329c70f` schedule-strength-not-made-up | 7/7 pass |
| RED: `nfldata.js` from `fdd60d65` on `3329c70f` tests | test 1 fails (`computeSOS` still exported / `/sos` 200), 6 pass |
| M-B `upd.run(g.opponent_abbr, before.home ? 1 : 0, before.id)` | killed by test 7 |
| M-C scheduleEdge `Number.isFinite(v) ? v : avg` (missing = 0) | killed by test 3 |
| M-D scheduleEdge `hasStrength = true` (no empty guard) | killed by test 2 |
| `3329c70f` model-integrity / matchups-no-signal / legacy-route-security / nfldata-roster-sync | 89/89, 5/5, 6/6, 2/2 |
| `node scripts/wiring-map.mjs --check` | exit 0, "no missing-feed findings" |

Follow-ups named, not done here: `docs/wiring/WIRING-MAP.md:2027` still lists `GET /api/nfl/sos` (generated file,
not regenerated in this unit); `scheduleEdge` still ranks 1-32 on populated data and the `/scout` prompt prints
`rank N/32` for a signal that is not validated (`MATCHUP_EVIDENCE`) — it is the one producer, but it carries no
`signal:false` label.
