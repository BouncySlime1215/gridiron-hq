# RL-4-2: no lineup swaps on a player whose game already kicked off

Branch `claude/local-rl-4-2-no-swaps-after-kickoff`, base `origin/main` at `89f69b3b` (#161).
Plan items B11 / SS-01, B10 / ST-03 (late swap), ST-10; C13 / GR-01.

## Audit (on `89f69b3b`), written before the first test

What exists for this surface, by command:

| Question | Command | Answer |
|---|---|---|
| Do the live leagues lock per game? | `sqlite3 .local-db/data.sqlite "select id, json_extract(payload,'$.settings.rosterSettings.lineupLocktimeType'), platform from leagues"` (local copy, not production) | all 5: `INDIVIDUAL_GAME`, all `espn` |
| Does any lineup path read ESPN's lock flag? | `git grep -n "lineupLocked\|lineup_locked" -- server client/src scripts` | only `scripts/collect-roster-snapshots.mjs:91,131` and `server/migrations/058_league_roster_snapshots.js:43` (the snapshot collector). Control: the same grep finds those known hits, so the grep works. |
| Is there a kickoff producer? | `sed -n 1,25p server/services/game-cutoff.js` | yes, the one cutoff representation: `gameCutoff(season, week, team)` at `server/services/game-cutoff.js:19`, reading `game_lines.gameday/gametime` through `date-util.js:48 nflKickoffDate` |
| Are kickoff times on hand for the current weeks? | `sqlite3 .local-db/data.sqlite "select week, count(*), sum(gametime is not null and gametime<>'') from game_lines where season=2026 and week in (2,3,4) group by week"` | W2 32/32, W3 32/32, W4 32/32 |
| Start/Sit solve | `server/services/lineup-brain.js:446` pool = every non-IR player; `:481` `bestLineup` re-solves every slot; `:506-515` bench and "beat" alternatives from the same pool | no lock, no kickoff |
| League Hub card + Decision Inbox | `server/services/trade-engine.js:2814` `lineupDiff` solves the full lineup; `:2941` `expiresAt: Date.now() + 72 h` with the comment "No exact kickoff time is threaded into this module today" | no lock, flat 72 h |
| Inbox expiry | `server/routes/decision-inbox.js:65` `expireStale()` expires `open` rows with `expires_at <= now`, run on every `publishRecommendation` (defined `:98`, sweep called `:110`) | a correct `expires_at` is honoured; nothing else needs to change there |
| Existing test pinning lock behaviour on a lineup solve | `git grep -n -i "lock" -- test \| grep -i lineup` | none on a lineup solve |

Baseline, the forward metric (local copy, not production). Command:

```
sqlite3 .local-db/data.sqlite "with r as (select id, league_id, expires_at, resolved_at, created_at,
  case when created_at < '2026-09-22 00:00' then 2 else 3 end wk, subject_ids from decision_recommendations where type='lineup'),
k as (select r.id, min(g.gameday||' '||g.gametime) first_ko from r, json_each(r.subject_ids) j join players p on p.id=j.value
  left join nfl_teams t on t.id=p.team_id left join game_lines g on g.season=2026 and g.week=r.wk and g.team=t.abbr group by r.id)
select r.league_id, r.wk, k.first_ko, r.expires_at, r.resolved_at from r join k on k.id=r.id order by r.created_at"
```

| Row | Week | First named kickoff (ET) | Closed at (min of expires, resolved) | Open after that kickoff |
|---|---|---|---|---|
| L4 | 2 | 2026-09-20 13:00 | 2026-09-22T01:01Z (expiry) | **32.0 h** |
| L5 | 2 | 2026-09-20 13:00 | 2026-09-18 10:09Z (superseded) | 0 |
| L1 | 2 | 2026-09-20 13:00 | 2026-09-18 10:08Z (superseded) | 0 |
| L2 | 2 | 2026-09-20 13:00 | 2026-09-21T10:09Z (expiry) | **17.2 h** |
| L3 | 2 | 2026-09-20 13:00 | 2026-09-18 10:09Z (superseded) | 0 |
| L1 | 3 | 2026-09-27 13:00 | open, expires 2026-09-25T19:08Z | 0 so far |

2 of 5 W2 rows stayed open after a named player locked (the queue's corrected figure; the R&D note's "2 of 6" counted the open W3 row). 13:00 ET on 2026-09-20 is 17:00Z. Caveat: teams are today's `players.team_id`, as in the R&D note.

### Extend or build

**Extend.** One producer each, reused:
- kickoff: `gameCutoff` (`game-cutoff.js:19`), no second clock;
- the lock flag: `playerPoolEntry.lineupLocked` from the payload the hourly `league_rosters` job already fetches (read today only by the snapshot collector);
- the solver: `bestLineup` (`trade-engine.js:637`) is not changed; a thin `pinnedBestLineup` removes locked starters and their slots, solves the rest with `bestLineup`, and puts them back.

**Build** only one leaf module, `server/services/lineup-lock.js` (lock state per rostered player), because `trade-engine.js` cannot import `lineup-brain.js` without a cycle (`test/lineup-surfaces-agree.test.js` header), and both surfaces must read the same lock. `trade-engine.js:340-362` (BLEND-01 / S-03) is not touched.

Not statistical: no projection, ranking or model number changes. The pinned solve is `bestLineup` itself whenever nobody is locked (tested). So no pre-registration and no 2025 holdout look.

## RED

`1fc889ef` — `test: RED - lineup card, inbox and Start/Sit move players whose game kicked off (RL-4-2)`

Run against the unfixed source (`trade-engine.js` and `lineup-brain.js` from `63ef4ad5`, the final test files, re-run after the last assertion change): `test/lineup-kickoff-locks.test.js` 0 pass / 7 fail, `test/start-sit-kickoff-locks.test.js` 1 pass (the pre-kickoff control) / 2 fail. Failing assertions, verbatim:

```
not ok 1 - control, before any kickoff: the swap is proposed and its row expires by the named starter's kickoff
  error: "expires_at 2026-09-26T06:32:01.573Z must be at or before Early Starter's kickoff 2026-09-20T17:00:00.000Z"
not ok 2 - after his kickoff a locked starter is never the "out" leg, and the open row is retired
  error: 'swaps named a locked player: Late Bench, Early Starter'
not ok 4 - a bench player whose game kicked off is never recommended IN
  error: 'swaps named a locked player: Early Bench, Late Starter'
not ok 2 - after his kickoff the started back holds his slot and the call says locked   (Start/Sit)
  + actual 'Late Bench'  - expected 'Early Starter'
```

## GREEN

`8e650996` — `fix: lineup card, inbox and Start/Sit hold players whose game kicked off (RL-4-2)`, then
`827d6fef` — `refactor: drop the pinned swap-legality check that changed no pairing (RL-4-2 mutant M8)`.

On `827d6fef` (targeted, `SCHEDULER_DISABLED=1`, `GRIDIRON_DB_PATH=$(mktemp -u)`, `node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`):

| Test file | pass / fail |
|---|---|
| `lineup-kickoff-locks` (new) | 7 / 0 |
| `start-sit-kickoff-locks` (new) | 3 / 0 |
| `lineup-diff-urgency` | 10 / 0 |
| `lineup-surfaces-agree` | 2 / 0 |
| `decision-leftovers-lineup`, `lineup-floor-objective`, `eval-lineup-objectives`, `decision-inbox`, `start-sit-decision-curve` (run on `8e650996`; `827d6fef` touches only `pairLineupSwaps` legality, covered by the first four) | 10, 3, 5, 8, 12 / 0 |

`node scripts/wiring-map.mjs --check` on `827d6fef`: exit 0. `npm run check` not run here (the Gate phase runs it once).

## What it does

- `server/services/lineup-lock.js:42` `rosterLocks(lg, rosterId, players, { season, week, now })`: per rostered ESPN player, `locked` when `playerPoolEntry.lineupLocked === true` (reason `espn_locked`) or `gameCutoff(season, week, team) <= now` (reason `kicked_off`), plus his `kickoff` and the ESPN `slot` he is set in. `:79` `lockPins` maps each locked player to that slot. Sleeper: `covered: false`, no locks.
- `server/services/trade-engine.js:717` `pinnedBestLineup(players, slots, key, pins)`: locked starters keep their slot, locked bench/IR players are out of the solve, the open slots are solved by the unchanged `bestLineup`. No pins returns `bestLineup` itself (tested with `deepEqual`).
- League Hub card + inbox, `lineupDiff` (`trade-engine.js:2927`): the optimum and the IR-activation check use the pinned solve, so a locked player is never a leg of a swap and no gain is claimed from an impossible move. The published row's `expiresAt` is `swapExpiry` (`:2840`, used `:3013`): the earliest kickoff among the players the swaps name; the flat 72 h only when none of them has a kickoff on file. The retire branch (`:3019`) says how many players were locked. New response fields `locked` and `lock_coverage`; `locked` is read by `client/src/pages/MyTeam.tsx:359` (one line on the card).
- Start/Sit, `lineupCall` (`lineup-brain.js:446`, `:486`, `:519`, `:586`): same locks, same pinned solve for all three objectives (a locked starter held out of a ceiling/floor pool is added back, pinned); locked players are never an alternative or a bench option; a locked slot's call has `confidence: 'locked'`, no `over`, and says when he kicked off. `client/src/pages/Lineup.tsx:34` renders the "Locked" chip. `lineupCall` now passes its own universe and clock to `lineupDiff` (`:686`), so the embedded card sees the same `now`.
- Routes reached: `GET /api/trades/:leagueId/lineup` (`server/routes/trades.js:215`, the Start/Sit tab) and `GET /api/trades/:leagueId/lineup-diff` (`:700`, the League Hub / My Team card, which publishes the inbox row).
- Not touched: `trade-engine.js:340-362` (BLEND-01 / S-03), `server/routes/decision-inbox.js` (verify only: its `expireStale` already honours `expires_at`).

## The numbers (local copy, not production: `.local-db/data.sqlite` backed up from `~/gridiron-local/data.sqlite` 2026-09-23)

Command: `GRIDIRON_DB_PATH=.local-db/data.sqlite SCHEDULER_DISABLED=1 node liveness.mjs <tree> <now>` (scratch script: for each of the 5 leagues with `my_team_id`, `lineupDiff(lg, my_team_id, { now })`, then counts swaps naming a player whose W3 `gameCutoff` is at or before Sun 2026-09-27 13:30 ET). Week 3 = `tradeWeekContext()` (first week with an unscored game).

| Tree | `now` | Swaps (5 leagues) | Swaps naming a player locked by Sun 1:30 pm ET | Players reported locked | Open inbox rows expire at |
|---|---|---|---|---|---|
| base `89f69b3b` | real (Wed 06:3xZ) | 11 | 11 (the base code has no clock: this is also what it shows at 1:30 pm Sunday) | n/a | Wed + 72 h (2026-09-26 06:39Z / 06:40Z) |
| branch `827d6fef` | real (Wed 06:40Z) | 11, same count and urgency per league as base | 11 (none locked yet; correct) | 0 | 2026-09-27T17:00Z = the first named kickoff (L1, L3) |
| branch | Sun W3 11:00 ET | 11 | 11 (none has kicked off yet) | 4 (the Thursday ATL-GB players: L1 1, L2 1, L3 2, matching the R&D table) | 17:00Z |
| branch | Sun W3 13:30 ET | **2** (L1 a Sunday-night swap, L2 a 4:05 pm swap) | **0** | 45 | no open row (retired) |

So at 1:30 pm Sunday the old code would still show 11 swaps that ESPN refuses; the new code shows 0 of those and still finds the 2 late-window swaps (the re-solve of open slots works). Base W2 forward metric (above): 2 of 5 rows open 17.2 h and 32.0 h after a named player's kickoff. Target W4-W6: 0; re-run the audit query each Tuesday. Not measurable today (W4 has not been played).

Not measured: the late-window points gained by re-solving at 1:30 pm (the R&D note's report-only value, ST-03's first number) needs per-window actual points; not in this unit.

## Mutation sweep (on `8e650996` for M1-M10, script `mutate.py`: one mutant at a time, targeted test files, source restored after each)

| Mutant | Where | Result |
|---|---|---|
| M1 ESPN flag ignored | unit, `lineup-lock.js` | killed (kickoff-locks test 3) |
| M2 kickoff never passes (`<= 0`) | unit, `lineup-lock.js` | killed (3 + 2 fails) |
| M3 a pinned starter is not held | unit, `pinnedBestLineup` | killed (4 + 1) |
| M4 `lineupDiff` pins = empty Map | call site | killed (4) |
| M5 `lineupCall` solve passes no pins | call site | killed (2) |
| M6 `lineupCall` startable ignores locks | call site | killed (1) |
| M7 expiry back to flat 72 h | unit, `swapExpiry` | killed (2) |
| M8 swap legality unpinned (`pairLineupSwaps` gets `bestLineup`, not the pinned solve) | call site predicate | **survived**. Checked for equivalence: 400 seeded random two-FLEX rosters, 40% early-window players, `now` 1:30 pm ET, 338 of them with swaps (the nonzero control): 0 differ in swaps between the two. Treated as redundant code and removed in `827d6fef`; comment at `pairLineupSwaps` says why. |
| M9 designed survivor: drop `.filter(Number.isFinite)` in `swapExpiry` | unit | survived, as designed: `gameCutoff` only returns `toISOString()` values, always finite |
| M10 not-applied control: pattern absent from the file | harness | not applied (pattern count 0), reported as such, not as survived |

## Holdout looks

None. No projection, ranking or model number changed, the 2025 season was not opened, so there is no `docs/evidence/HOLDOUT-LEDGER.md` row. Discipline (b)-(e): not a model result; the pinned solve equals the old solve whenever nobody is locked (test 6, and 11 = 11 swaps on the Wednesday run). Decision grading: the change removes calls that cannot be made; it does not re-rank any that can, so a decision win rate against "start highest projection" is unchanged by construction. Not a decline, so no MDE.

## Known defects / what it does not cover

- `gameCutoff` falls back to 23:59 ET when a game has a date but no time. For locks that is late, not early; ESPN's flag covers it within the payload's 60-minute refresh. All 32 W2-W4 games have a time today (audit query).
- ESPN slot ids this app does not model (e.g. RB/WR, WR/TE combos) pin a locked player out of the solve rather than into his slot. None of the 5 leagues uses them (`roster_positions`: QB, RB, WR, TE, DEF, K, FLEX only).
- Sleeper: no lock data read (`lock_coverage: false`); no live league is Sleeper.
- A locked starter still carries his pregame projection; switching to his actual points once his game is final is ST-10's job.
- `lineupCall` still has three pre-existing bare `catch {}` blocks (regression evidence, `fantasyContext`, the embedded `lineupDiff`); not added by this unit, reported here.
- K and D/ST are outside the solve (as before), so their locks change nothing.

## Nick's five questions

1. **Well built?** One lock producer (`lineup-lock.js`) read by both lineup surfaces, one kickoff producer reused (`gameCutoff`), the solver unchanged and wrapped (`pinnedBestLineup`). 10 new tests, RED shown on the unfixed code, 7 of 8 real mutants killed and the eighth removed as redundant after a 400-roster equivalence check.
2. **Stats or made up?** No statistics. Lock times are ESPN's own flag and the NFL schedule in `game_lines`. The 72 h fallback is the old hand-set constant, now used only when no named player has a kickoff on file.
3. **How we know:** fixtures with an injected clock (tests), and the local-copy run above: 11 swaps at 1:30 pm Sunday W3 on the old code, all naming a locked player; 2 on the new code, none locked. W2 baseline 2 of 5 inbox rows open 17.2 h / 32.0 h after kickoff; the forward W4-W6 count is the confirmation, not yet measurable.
4. **Pointed anywhere else?** Start/Sit tab (`/api/trades/:id/lineup`), League Hub / My Team card (`/api/trades/:id/lineup-diff`) and the Decision Inbox rows the card publishes. The matchup card (`lineup-posture.js`) and the trade engine's season lineups are not touched: they are not a this-Sunday move.
5. **How it unifies:** before, the snapshot collector was the only reader of ESPN's lock flag and no lineup path read kickoffs. Now both lineup surfaces read the same lock through one module and name the same pinned lineup (`lineup-surfaces-agree` still green). Follow-up named: ST-10 (actual points for final games) can reuse `rosterLocks`.
