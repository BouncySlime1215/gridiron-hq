# SS-01 dead-starter guard (plan item B11, Diligence Engine)

Branch `claude/local-ss-01-dead-starter-guard`, built on origin/main `131a7ba0`.

## 1. Audit: extend or build (written before the first test)

What already exists for "a starter who will score zero this week", grepped on `131a7ba0`
(`grep -rn "flagged_starters\|dead_starter\|INJURY_RESERVE\|DOUBTFUL" server client/src`):

| Producer | file:line | Definition | Reaches |
|---|---|---|---|
| `lineupDiff().flagged_starters` | server/services/trade-engine.js:2861, 2904-2908 | ESPN-submitted starter with `available === false` (season-ending list) or on IR. No Out, no Doubtful, no bye, no inactive, no replacement | League Hub card, client/src/pages/MyTeam.tsx:327 |
| `rosterSignals().lineup_dead_starters` | server/services/manager-signals.js:309-312 | count of ESPN starters whose `injuryStatus` is OUT, INJURY_RESERVE or DOUBTFUL. No bye | stored manager signal (count only) |
| `lineupCall().warnings` | server/services/lineup-brain.js:657, 728-752 | the RECOMMENDED lineup's slots with `active_probability < 0.75` or on bye. Says nothing about what is actually set on ESPN | Start/Sit "Check before kickoff" card, client/src/pages/Lineup.tsx:197 |
| `lineupCall().on_ir` / `irOnRoster()` | server/services/lineup-brain.js:379-409 | ESPN IR slot or INJURY_RESERVE status | Start/Sit |
| kickoff time | server/services/game-cutoff.js:19 `gameCutoff()` | the one cutoff representation, from `game_lines` | many |
| kickoff locks | PR #171 `server/services/lineup-lock.js` (RL-4-2) | **not merged** into origin/main at `131a7ba0` | - |
| live gameday inactives | RL-3-2 `live-inactive-monitor.js` | **not landed**; main's only inactive source is nflverse weekly rosters in `nfl_verified_events` (writer server/services/nfl-event-archive.js:64), published after the week | - |

Decision: **extend**. No producer answers the unit's question (is the lineup SET ON ESPN
carrying someone who will score zero, and who on the bench replaces him). Build one
classifier, `deadReason()` in a new leaf module `server/services/dead-starters.js`, whose
status sets are the union of the two existing definitions (trade-engine's season-ending/IR
plus manager-signals' OUT/DOUBTFUL/IR) plus bye and gameday inactive; `manager-signals.js`
imports its ESPN status set so the two cannot drift. `lineupCall()` calls it and serves
`dead_starters` on `GET /api/trades/:leagueId/lineup` (server/routes/trades.js:215).
Kickoff: `gameCutoff()` per player, not the RL-4-2 lock module (unmerged; a named follow-up
swaps in `rosterLocks()` when #171 lands). Inactives: a named hook `inactiveSource` that
reports `covered: false` until RL-3-2 lands. `lineupDiff().flagged_starters` is left in place
(owned by RL-4-2's open edit of trade-engine.js); every row it flags is also a
`dead_starters` row (season-ending or IR), so the two agree where they overlap; unifying
the League Hub card onto `dead_starters` is follow-up SS-01-F1.

Statistical? No. The guard is a deterministic rule with no fitted number, so there is no
pre-registration. The replay count below is descriptive, and 2026 weeks 1-2 is an anecdote,
not a verdict (rule e); the multi-season evidence that dead starts cost points is the
skill-split study's (rnd/skill/SKILL-REPORT.md:57, Sleeper public leagues, several seasons).
No 2025 held-out data is read by this unit, so HOLDOUT-LEDGER.md gets no row.

## 2. RED / GREEN

- Audit: `9abc3cb2` docs: SS-01 dead-starter guard audit (extend, not build)
- RED: `84c933e7` test: RED for SS-01 dead-starter guard on the lineup payload.
  7 of 7 fail on origin/main code. Failing assertion (test 1, the acceptance fixture):
  `assert.ok(ds, 'the lineup payload carries dead_starters')` -> expected true, actual false
  (`lineupCall().dead_starters` is undefined).
- GREEN: `4f509e25` feat: SS-01 dead-starter guard on the Start/Sit lineup payload. 7 of 7 pass.
  The Sleeper case's fixture was given one rostered player in this commit (at RED it could
  return early on an error instead of asserting; it asserts now).
- Test hardening: `1d040646` test: SS-01 FLEX-first entry order pins fixed-slot-first
  replacement (killed mutant M7, which survived the first fixture because ESPN listed RB first).

Command (each run on its own tree, fresh temp DB):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/dead-starter-guard.test.js`
-> `# pass 7 # fail 0`. Neighbours on the GREEN tree, same command: lineup-floor-objective 3/3,
decision-leftovers-lineup 10/10, start-sit-decision-curve 12/12, manager-signals-api 27/27.

## 3. What it does

`GET /api/trades/:leagueId/lineup` (server/routes/trades.js:215 -> lineup-brain.js#lineupCall)
now carries `dead_starters` (server/services/lineup-brain.js:455, 686):

```
{ covered, applied: false, season, week, starters_checked, unmatched_starters,
  kickoff_basis: 'game_cutoff', inactive_source: { covered, source, reason },
  items: [{ slot, player, reason: ir|out_for_season|out|doubtful|bye|inactive,
            source: espn|injury_report|season_ending_list|schedule|<inactive source>,
            kickoff, replacement: { id, name, position, team_abbr, week_points } | null, why }] }
```

- Reads the lineup SET ON ESPN (payload lineupSlotId), not the recommended one.
- `deadReason()` (server/services/dead-starters.js:61): ESPN INJURY_RESERVE; season-ending list
  (`available === false`, trade-engine.js:466); ESPN OUT or injury report Out; ESPN DOUBTFUL or
  report Doubtful; bye (`p.bye === week`); inactive via the hook. Questionable is not dead.
- Replacement: best bench player not dead by the same rule, whose game has not kicked off, who
  can fill the slot (lineup-brain.js#slotAccepts), ranked by the Start/Sit `week_points`
  (startSitWeekPoints, the one weekly number). Fixed slots choose before FLEX; no bench player
  is offered twice. None available -> `replacement: null` and "look at the waiver wire".
- A starter whose game has kicked off (`gameCutoff()` <= now) is not flagged.
- Client: client/src/pages/Lineup.tsx:115 red card at the top of Start/Sit, rendered only when
  `items.length > 0`. Nav unchanged (no route or tab added). No migration.
- manager-signals.js:314 reads `DEAD_ESPN_STATUS` (same three statuses as before, so its
  stored `lineup_dead_starters` value does not change).

## 4. Mutation sweep (GREEN + hardening tree)

Script: scratchpad `mutate.py` (applies one exact-string patch, asserts it matched once,
runs the test file, restores). Results:

| Mutant | Result |
|---|---|
| M1 bye rule removed | killed (#1) |
| M2 ESPN OUT not dead | killed (#1, #4, #5) |
| M3 injury-report status ignored | killed (#3) |
| M4 dead bench players offered | killed (#1, #4, #5) |
| M5 kickoff ignored | killed (#5) |
| M6 replacement reused | killed (#4) |
| M7 fixed-slots-first order removed | killed (#4) (survived before the FLEX-first fixture; fixed in the test) |
| M8 season-ending list not dead | killed (#3) |
| M9 inactive hook ignored | killed (#6) |
| C1 call site: accepts any slot | killed (#5, #6) |
| C2 call site: empty week_points map | killed (#1, #3, #4, #5, #6) |
| C3 call site: `now` not passed | killed (#5, #6) |
| C4 call site: `inactive` not passed | killed (#6) |
| C5 call site: payload field dropped | killed (all 7) |
| S1 designed survivor: `Number(flex(x))` -> `(flex(x) ? 1 : 0)` (equivalent) | survived, as designed |
| N1 not-applied control: target string absent | NOT APPLIED (count 0), reported, not run |

## 5. Numbers (local copy, not production)

DB: `sqlite3 ~/gridiron-local/data.sqlite ".backup .local-db/data.sqlite"` at 2026-09-23 ~09:20Z.

**Replay, 2026 weeks 1-2** (`GRIDIRON_DB_PATH=.local-db/data.sqlite node study/replay/ss-01-dead-starter-replay.mjs`,
tree = this branch). Table `league_roster_snapshots` source 'final' (writer
scripts/collect-roster-snapshots.mjs:113 writePeriod); report status from `nfl_injuries`
(writer server/services/nfl-advanced.js:358 syncInjuries); inactives from `nfl_verified_events`
nflverse weekly rosters (writer server/services/nfl-event-archive.js:64).

Known-nonzero controls first:
- `nfl_injuries` Out/Doubtful rows: week 1 = 37, week 2 = 50.
- Rostered players (any slot, all 46 teams) the same classifier marks dead: week 1 = 12
  (out 10, doubtful 1, inactive 1); week 2 = 20 (out 10, doubtful 10). So the joins and the rule fire.
- Teams with a game: 32 in weeks 1 and 2, 30 in week 5, 28 in week 6 (the bye path has nothing
  to catch until week 5).

Result: 424 starters a week (332 skill), 46 team-weeks a week, **0 dead starters caught in either
week**, 0 points avoided, decision win rate vs "keep the lineup" undefined (n = 0). Every rostered
dead player was already on a bench. This agrees with the skill-split study's line for these
leagues ("zero blunders", rnd/skill/SKILL-REPORT.md:119). Anecdote, not a verdict: two early
weeks, and the study shows blunders grow from 0.9 pts/team-week in week 1 to 4.5 by week 14
(SKILL-REPORT.md:58). ESPN statuses were not replayable for weeks 1-2 (the 'final' rows carry
none; `pregame_injury_status` starts in week 3), so this undercounts IR/ESPN-only designations.

**Liveness on real data, week 3, Wednesday** (scratchpad `ss01-live.mjs`, `lineupCall(id, {})`
for leagues 1-5 on the local copy): covered 5/5, 9 starters checked each, 0 unmatched; 2 starters
flagged (league 1: QB `doubtful/espn`, replacement a bench QB at 16.36 week_points; league 3: QB
`doubtful/espn`, no bench QB, so `replacement: null`). Midweek statuses; they can clear by Sunday.
Across all 46 teams the week-3 live snapshot has 11 starters ESPN-Doubtful
(`SELECT ... FROM league_roster_snapshots WHERE scoring_period_id=3 AND source='live' AND is_starter=1 AND injury_status IN ('OUT','DOUBTFUL','INJURY_RESERVE')`).

Historical grade: the multi-season evidence is the skill-split study (Sleeper public leagues,
several seasons, walk-forward team-weeks): dead starts cost 2.8 pts/team-week, known-out 2.0
(SKILL-REPORT.md:57, 138). This unit does not re-derive it; it is a deterministic rule with no
fitted number, so there is no ship rule to pass or fail and no MDE to report.

## 6. Known defects / not covered

- ESPN only. Sleeper leagues get `covered: false` with the reason.
- K and DEF are checked only when the asset universe prices them (all 9 starters matched in the 5
  live leagues); a K/DEF has no week_points, so it is flagged but rarely gets a replacement.
- Gameday inactives: hook only, `covered: false` until RL-3-2 lands (SS-01-F3).
- Kickoff lock is `gameCutoff()` only; ESPN's own `lineupLocked` (delayed games) is RL-4-2's and is
  not read here (SS-01-F2: switch to `rosterLocks()` when #171 merges).
- `lineupDiff().flagged_starters` (League Hub card) is still the narrower definition (SS-01-F1:
  point it at `deadStarters()` once RL-4-2's edit of trade-engine.js has merged).
- No push notification and no apply: shown when the page is opened. "One-tap" is a suggestion.
- Doubtful counts as dead (the study's definition); some Doubtful players do play.

## 7. Nick's five questions

1. Well built? A leaf module with one classifier, called once from the Start/Sit route, 7 tests
   through the real route function, 14 of 14 applied mutants killed (unit and call site), the
   designed survivor survived and the not-applied control was caught. No migration, no nav change.
2. Stats or made up? No model number. It reads ESPN statuses, the official injury report, the
   schedule and the existing week_points; the only constants are the status lists.
3. How we know: the study's multi-season backtest says dead starts cost 2.8 pts/team-week; our
   2026 weeks 1-2 replay caught 0 (none were started), with a nonzero control showing the rule
   finds 12 and 20 dead rostered players on those weeks. That 0 is an anecdote, not a grade.
4. Pointed anywhere else? `/api/trades/:leagueId/lineup` -> Start/Sit page red card
   (client/src/pages/Lineup.tsx:115). manager-signals shares the ESPN status set. SK-01 (command
   center) is the planned second reader.
5. How it unifies: one definition of a dead starter (dead-starters.js#deadReason), the union of the
   two that disagreed (trade-engine flagged_starters, manager-signals lineup_dead_starters);
   manager-signals now imports it; the League Hub card is follow-up SS-01-F1. Replacement is ranked
   on the same week_points the Start/Sit lineup uses.
