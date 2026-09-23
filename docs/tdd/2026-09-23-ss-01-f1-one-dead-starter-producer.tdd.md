# SS-01-F1 one dead-starter producer (plan item Diligence Engine structure)

Branch `claude/local-ss-01-f1-one-dead-starter-producer`, built on
`claude/local-ss-01-dead-starter-guard` at `8985e03c` (PR #185, **open, not merged**; this
branch stacks on it and must merge after it, or be retargeted).

## 1. Audit: extend or build (written before the first test)

Every producer of "a starter who will score zero this week", grepped on `8985e03c`
(`grep -rn "flagged_starters\|dead_starters\|lineup_dead_starters\|DEAD_ESPN_STATUS" server client/src`):

| Producer | file:line | Definition | Reaches |
|---|---|---|---|
| `deadStarters()` / `deadReason()` | server/services/dead-starters.js:65-150 | ESPN-set starter (any non-bench, non-IR slot) who is IR, season-ending, Out or Doubtful by contingency.js#weekDesignation, on bye, or inactive; not once his game has kicked off; with a bench replacement | Start/Sit `dead_starters` (lineup-brain.js:455, client/src/pages/Lineup.tsx:115) |
| `lineupDiff().flagged_starters` | server/services/trade-engine.js:2945-2949, 2970 | ESPN-set starter in `SCORED` positions with `available === false` or on IR only. No Out, no Doubtful, no bye | League Hub card, client/src/pages/MyTeam.tsx:329, 395 |
| `rosterSignals()` `lineup_dead_starters` | server/services/manager-signals.js:313-314, 324 | count of ESPN starters whose status is a key of `DEAD_ESPN_STATUS` (OUT, INJURY_RESERVE, DOUBTFUL). No SUSPENSION | table `manager_signals`, written by `buildManagerSignals()` manager-signals.js:366 (via `rosterSignals` :390) |

The two page surfaces disagree on the same input. Local copy, not production (backup of
`~/gridiron-local/data.sqlite` taken 2026-09-23 05:59), tree `8985e03c`, week 3:

`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node study/replay/ss-01-f1-surface-compare.mjs`

| league | League Hub flagged_starters | Start/Sit dead_starters |
|---|---|---|
| 1 | [] | [QB:doubtful] |
| 2 | [] | [] |
| 3 | [] | [QB:doubtful] |
| 4 | [] | [] |
| 5 | [] | [] |

Totals: hub 0, Start/Sit 2, 2 of 5 leagues disagree. This is the known-nonzero control for
the after-run below.

Decision: **extend**. `dead-starters.js` is the one producer. `lineupDiff()` calls
`deadStarters()` on the same roster (same `loadRosters()` players, its own week_points,
which are built to equal Start/Sit's) and serves its items as `flagged_starters`, keeping
the fields MyTeam.tsx reads (`id, name, position, reason, espn_status, espn_disagrees`) and
adding `dead_reason`, `slot`, `replacement`, `why`. `slotAccepts` moves from lineup-brain.js
into dead-starters.js so both callers use one slot rule. manager-signals.js stops reading
a status list and asks `espnDeadReason()` (dead-starters.js), which is `deadReason()` on
the ESPN status alone, so SUSPENSION (and any status weekDesignation maps to Out/Doubtful)
counts. That changes the stored `manager_signals.lineup_dead_starters` value for a roster
with a suspended starter (no schema change, no migration). The card text rounds the
replacement's week_points to one decimal.

What stays different on purpose: `lineupDiff`'s point totals (`submitted_points`, swaps)
still count only IR/season-ending starters as 0; a Doubtful starter is priced at his
week_points (already discounted by his chance to play). The list of who is dead is the
thing unified, not the solver's scoring.

File allocation: trade-engine.js#lineupDiff is also edited by open PR #171 (RL-4-2). This
unit touches only the `flagged_starters` block and adds the same `now = Date.now()` option
#171 adds, with the same signature, so the merge is mechanical.

Statistical? No. A deterministic rule, no fitted number; no pre-registration. No 2025
held-out data read, so no holdout row. Rule (e) does not apply: no start/sit accuracy claim
is made, only that two surfaces agree.

## 2. RED

`1bc5d35b` test: RED for SS-01-F1, League Hub and Start/Sit must name the same dead starters
(test/dead-starter-one-producer.test.js; fixture roster with a Doubtful-report QB, ESPN OUT
RB, season-ending RB, bye WR, ESPN SUSPENSION TE and ESPN INJURY_RESERVE FLEX starter).
Run on `1bc5d35b`: 0 pass, 5 fail. Failing assertions:

- test 1 `assert.deepEqual(shape(hubItems), shape(sitItems), 'League Hub names the same players, reasons, slots and replacements')`: hub had 2 items with `reason: undefined`, Start/Sit had 6 (`doubtful`, `out`, `out_for_season`, `bye`, `out`, `ir`).
- test 2: `Cannot read properties of undefined (reading 'espn_disagrees')` (no Out Back row on the hub).
- test 3: `assert.equal(hub.length, 0)` expected 0, actual 2 (hub ignored kickoff).
- test 4: `assert.equal(typeof signalsMod.rosterSignals, 'function')` actual `'undefined'`.
- test 5: `assert.match(sit.why, /\(10\.4 projected\)/)` actual `'... Start Round Bench instead (10.37 projected).'`

## 3. GREEN

`76153e1f` fix: SS-01-F1 League Hub, Start/Sit and manager signals read one dead-starter producer.
`01cc5f1a` test: pins the caller's kickoff instant and the week_points basis on the League Hub
side (added after mutants M2/M3 below first survived; see section 5).

`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js` on `01cc5f1a`:

| test file | pass | fail |
|---|---|---|
| dead-starter-one-producer | 5 | 0 |
| dead-starter-guard | 9 | 0 |
| lineup-diff-urgency | 10 | 0 |
| lineup-surfaces-agree | 2 | 0 |
| decision-inbox | 8 | 0 |
| decision-leftovers-lineup | 10 | 0 |
| lineup-floor-objective | 3 | 0 |
| manager-signals-api | 27 | 0 |
| availability-fit-loader, availability-honest-degradation, posture-calibration, start-sit-ceiling-uncalibrated, start-sit-decision-curve | 7, 8, 6, 7, 12 | 0 |

(The non-contract rows ran on `76153e1f`; `01cc5f1a` changes only the contract test file.)

## 4. What it does

- `server/services/dead-starters.js`: the one producer. New exports `slotAccepts` (moved from
  lineup-brain.js, one slot rule for both callers), `DEAD_REASON_LABEL`, `espnDeadReason()`
  (deadReason on ESPN's status alone). `DEAD_ESPN_STATUS` is removed (its only reader was
  manager-signals.js). The card sentence rounds the replacement projection to one decimal;
  `replacement.week_points` in the payload keeps two.
- `trade-engine.js#lineupDiff`: `flagged_starters` is `deadStarters()`'s items on the same
  roster, each with `reason` (label), `dead_reason`, `slot`, `source`, `kickoff`,
  `replacement`, `why` and the existing `espn_status`/`espn_disagrees`. New option
  `now = Date.now()` (same signature as open PR #171). Totals and swaps are unchanged.
- `manager-signals.js#rosterSignals`: counts starters where `espnDeadReason()` is non-null, so
  SUSPENSION counts; exported for the contract test.
- `client/src/pages/MyTeam.tsx`: the League Hub line reads "<name> is <label>. Start <bench>
  instead (<week_points, 1 decimal> projected)." instead of "is counted as 0 this week", which
  was wrong for a Doubtful or bye starter who is not counted as 0 in the totals.

Consumers: League Hub `GET /api/trades/:leagueId/lineup-diff` (server/routes/trades.js:703)
-> MyTeam.tsx:329 LineupDiffCard; Start/Sit `GET /api/trades/:leagueId/lineup`
(server/routes/trades.js:215) -> Lineup.tsx:115; table `manager_signals`, writer
`buildManagerSignals()` manager-signals.js:366 via `rosterSignals()` :390.

## 5. Numbers (liveness), with commands

Local copy, not production (backup 2026-09-23 05:59), week 3,
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node study/replay/ss-01-f1-surface-compare.mjs`:

| tree | League Hub total | Start/Sit total | leagues disagreeing | signal count (leagues 1-5) |
|---|---|---|---|---|
| `8985e03c` (before) | 0 | 2 (QB:doubtful in leagues 1 and 3) | 2 of 5 | not exported |
| `76153e1f` (after) | 2 (QB:doubtful in leagues 1 and 3) | 2 | 0 of 5 | 1, 0, 1, 0, 0 |

Stored-signal effect of adding SUSPENSION, same copy:
`sqlite3 .local-db/data.sqlite "SELECT json_extract(e.value,'$.playerPoolEntry.player.injuryStatus') s, COUNT(*) FROM leagues l, json_each(l.payload,'$.teams') t, json_each(t.value,'$.roster.entries') e WHERE l.platform='espn' GROUP BY s"`
-> ACTIVE 591, QUESTIONABLE 64, (null) 48, DOUBTFUL 29, INJURY_RESERVE 18, DAY_TO_DAY 5, OUT 3,
SUSPENSION 0 (the non-zero OUT/IR rows are the control that the status path is read). So the
stored `lineup_dead_starters` value does not move on today's data; it will when a rostered
starter is suspended.

Mutation sweep (test/dead-starter-one-producer.test.js, each mutant applied, run, reverted;
script in the session scratchpad):

| mutant | where | result |
|---|---|---|
| M1 hub keeps only season-ending/IR | trade-engine.js flagged_starters | killed (tests 1, 2, 3) |
| M2 call site: hub passes `Date.now()` not `now` | trade-engine.js deadStarters call | survived on `76153e1f` (wall clock is after the fixture kickoff, so equivalent), killed after `01cc5f1a` (test 3 before-kickoff control) |
| M3 call site: hub ranks replacements on adj_ppg | trade-engine.js weekPoints map | survived on the first fixture (adj = week), killed after `01cc5f1a` (tests 1, 2) |
| M4 espnDeadReason drops SUSPENSION | dead-starters.js | killed (test 4) |
| M5 call site: signals back to its own OUT/IR/DOUBTFUL list | manager-signals.js | killed (test 4) |
| M6 card text unrounded | dead-starters.js why | killed (test 5) |
| M7 hub drops Doubtful | trade-engine.js flagged_starters | killed (tests 1, 3) |
| S1 designed survivor: `mine.find` for the `mineById` lookup | trade-engine.js | survived (equivalent) |
| C1 not-applied control (search string absent) | trade-engine.js | not applied, all pass |

No 2025 held-out data was read. Holdout looks: none.

## 6. Known defects / follow-ups

- Stacked on open PR #185; merge #185 first (or retarget).
- Open PR #171 (RL-4-2) also edits `lineupDiff`; both add `now = Date.now()` with the same
  signature. When #171 lands, SS-01-F2 (named in dead-starters.js) swaps the kickoff
  comparison for `rosterLocks()` in the one producer, which moves both surfaces at once.
- K/DEF starters are now eligible for the League Hub list (the producer checks every starting
  slot); before, lineupDiff ignored them. No K/DEF starter was flagged on the local copy.
- MyTeam.tsx text change has no client test (the repo's client has none for this card);
  the server fields it reads are pinned by test 2.

## 7. Nick's five questions

1. Well built? One producer (dead-starters.js) now feeds the League Hub card, the Start/Sit
   card and the stored signal; a contract test fails if any of them drifts; 7 of 7 real
   mutants killed.
2. Stats or made up? No model number. The rule is deterministic; the only numbers are counts.
3. How do we know? RED/GREEN above, plus the local-copy run: hub 0 vs Start/Sit 2 before,
   2 vs 2 after, 0 of 5 leagues disagreeing.
4. Pointed elsewhere? Nothing else computes "dead starter": grep for `flagged_starters`,
   `dead_starters`, `lineup_dead_starters`, `DEAD_ESPN_STATUS` on `76153e1f` finds only these
   three readers of dead-starters.js.
5. How it unifies: the League Hub list, the Start/Sit list and the manager signal answer
   "who is set and will score zero" from one function; the League Hub's point totals still
   price a Doubtful starter at his discounted week_points, on purpose.
