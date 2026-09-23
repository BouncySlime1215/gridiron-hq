# RL-13-2: waiver board says how claim priority works in this league (race for claims, not hold priority)

Unit: RL-13-2 (WORK-QUEUE.md line 858; B-05 re-scope, WV-02, A-01/CE-05 league rules).
Branch: `claude/local-rl-13-2-waiver-reset-race`, based on origin/main `c83cb128`.

## 1. Audit (written before the first test): extend, don't build

What already exists for this surface, on `c83cb128`:

| Concept | Existing producer | Reader |
|---|---|---|
| League rules (schedule, seeding, median) | `server/services/league-rules.js:66` `leagueRules(lg)`: "the one producer of league rules (CE-05)" | season-sim.js, trade-horizon.js |
| Waiver processing clock (days, hour) | `server/services/waiver-wire.js:415` `nextWaiverRun(payload)` reads `settings.acquisitionSettings` itself | waiverBoard -> `waiver_run` -> WaiverWire.tsx |
| Weekly waiver-order reset rule | none (`grep -rnE 'waiverOrderReset' server client/src test`: 0 hits) | none |
| Team's current waiver rank | none (`grep -rnE 'waiverRank' server client/src test`: 0 hits) | none |
| "Hold priority" advice | none in code (`grep -rniE 'hold(ing)? (your )?(waiver )?priority' server client/src`: 0 hits); the framing lives only in plan text B-05 | none |

Where the data comes from: table `leagues`, column `payload`, written by
`server/routes/leagues.js:136` `syncEspnLeague` (UPDATE at `:163`) from ESPN views
`mTeam&mRoster&mMatchup&mSettings` (`:126`). `mSettings` carries
`settings.acquisitionSettings.waiverOrderReset` and `acquisitionType`; `mTeam` carries
`teams[].waiverRank`.

Known-nonzero check on real rows (local copy, not production; `sqlite3 .local-db/data.sqlite`
made with `.backup` from `~/gridiron-local/data.sqlite` on 2026-09-23 ~14:07 ET, synced
2026-09-23 17:15Z, week 3):

```
select id, json_extract(payload,'$.settings.acquisitionSettings') from leagues
```
-> all 5 ESPN leagues: `acquisitionType: WAIVERS_TRADITIONAL`, `isUsingAcquisitionBudget: false`,
`waiverOrderReset: true`.

```
select l.id, count(*), sum(json_extract(t.value,'$.waiverRank') is not null)
from leagues l, json_each(l.payload,'$.teams') t group by l.id
```
-> 8/8, 10/10, 8/8, 10/10, 10/10: every team in every league carries a waiverRank, and each
league's ranks are a permutation of 1..N.

Decision: EXTEND.
- `leagueRules()` gains a `waivers` block (`acquisition_type`, `order_resets_weekly`), so the
  rule has one producer; same null-plus-`missing` contract as the other blocks.
- `waiverBoard()` gains `claim_priority`, built from `leagueRules(lg).waivers` plus my team's
  `waiverRank`. No route change (`server/routes/trades.js` `/:leagueId/waivers` returns the board
  as-is). WaiverWire.tsx renders it next to the waiver run.
- `nextWaiverRun` keeps reading the clock fields itself (named follow-up below), because moving
  it is outside this unit's files.

Not statistical: no model number, no projection, no pre-registration. It surfaces a league rule
and a rank the platform publishes. No holdout season was looked at (nothing appended to
HOLDOUT-LEDGER.md).

## 2. RED / GREEN

- RED: `13b059a4` "test: RED waiver board claim_priority from league reset rule and team waiverRank".
  `test/waiver-priority-reset.test.js`, 8 tests, 0 pass / 8 fail on `92f21b04`. Failing assertion
  (test 1): `assert.ok(out.claim_priority, 'board has no claim_priority block')` -> `'board has no
  claim_priority block'`; test 8: `leagueRules(...).waivers.order_resets_weekly` -> `Cannot read
  properties of undefined (reading 'order_resets_weekly')`. The board itself built (no `error`),
  so the failures are the missing block, not a broken fixture.
- GREEN: `26048213` "feat: waiver board claim_priority, league waiver-reset rule and my current rank".
  Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<f>.test.js`

| test file | result on 26048213 |
|---|---|
| waiver-priority-reset | 8/8 |
| league-rules | 15/15 (fixture gains the real acquisitionSettings shape; field allowlist gains `waivers`, citing its reader) |
| waiver-injury-alerts, waiver-namesake-cut, decision-leftovers-waivers, waiver-brain, waiver-kicker-defense, waiver-confidence-is-hand-set | 8, 7, 7, 8, 7, 7 all pass |
| int-168-1-median-rule-unknown-notice | 4/4 |

`node_modules/.bin/tsc --noEmit` on 26048213: no output (clean). Lint, wiring, build and the
full suite are left to the Gate phase.

## 3. What it does

- `server/services/league-rules.js` `leagueRules()` returns `waivers: { acquisition_type,
  uses_budget, order_resets_weekly }` from `settings.acquisitionSettings`; absent fields are null
  and listed in `missing` (they are not in `SIM_REQUIRED`, so the season simulator is not blocked).
- `server/services/waiver-wire.js` `claimPriority(lg, payload, rosterId)` builds
  `claim_priority`: `known, reason, acquisition_type, uses_budget, resets_weekly, current_rank,
  teams, teams_ahead, as_of (leagues.fetched_at), stale_season, strategy, missing, source`.
  `waiverBoard()` returns it for the team the board is built for (`myTeamId`, else
  `lg.my_team_id`).
- Strategy line by rule: weekly reset -> "waiting gains nothing: a claim costs only this week's
  place in line"; rolling -> "a successful claim sends you to the back of the order"; bidding ->
  "the order only breaks tied bids". This replaces the plan's "hold priority" framing (B-05) for
  these leagues, since all five reset weekly.
- Route: unchanged. `server/routes/trades.js` `GET /:leagueId/waivers` (line ~682) returns
  `waiverBoard(...)` as-is, so `claim_priority` reaches the client.
- Page: `client/src/components/lineup/WaiverWire.tsx` `ClaimPriorityLine`, under the injury alerts
  and above "Claim now": "3rd of 8 (2 teams ahead of you), as of the last sync." plus the strategy
  line; a not-known reason is shown small.
- No migration, no new table or column.

## 4. Numbers (local copy, not production)

Liveness proof: `waiverBoard(lg, {})` for every league row, through the real service, DB at
`.local-db/data.sqlite` (scratchpad script `live.mjs`, `SCHEDULER_DISABLED=1
GRIDIRON_DB_PATH=.local-db/data.sqlite`), on 26048213:

| league row | board | resets_weekly | current_rank / teams | teams_ahead | known |
|---|---|---|---|---|---|
| 1 | ok | true | 3 / 8 | 2 | true |
| 2 | ok | true | 10 / 10 | 9 | true |
| 3 | ok | true | 1 / 8 | 0 | true |
| 4 | ok | true | 2 / 10 | 1 | true |
| 5 | ok | true | 8 / 10 | 7 | true |

Each rank matches the direct SQL read of `teams[].waiverRank` for that league's `my_team_id`
(section 1 query, per-team output) on the same copy.

What the reset resets to (not shipped as a claim): teams whose waiverRank equals reverse playoff
seed (`N + 1 - playoffSeed`):
```
select l.id, count(*), sum(json_extract(t.value,'$.waiverRank') =
  json_array_length(l.payload,'$.teams')+1-json_extract(t.value,'$.playoffSeed'))
from leagues l, json_each(l.payload,'$.teams') t group by l.id
```
-> 8/8, 4/10, 0/8, 2/10, 5/10 (19 of 46). Consistent with "reverse standings, then claimants
move to the back until the reset", but that is a guess, so the page does not state a basis.

## 5. Mutation sweep (test/waiver-priority-reset.test.js, on 26048213; script restores each file)

| mutant | where | result |
|---|---|---|
| M1 teams_ahead = rank (not rank - 1) | claimPriority | killed (2 fail) |
| M2 call site passes lg.my_team_id, ignoring myTeamId | waiverBoard call site | killed (1) |
| M3 reset defaults to true when absent | leagueRules | killed (2) |
| M4 stale season never flagged | claimPriority | killed (1) |
| M5 bidding branch dropped | claimPriority | killed (1) |
| M6 claim_priority dropped from the board | waiverBoard return (call site) | killed (7) |
| M7 missing rank defaults to 1 | claimPriority | killed (1) |
| M8 rolling league gets the reset text | claimPriority | killed (1) |
| S1 designed survivor: `teams: teams.length` (0 instead of null on an empty team list) | claimPriority | survived, as designed: every fixture has teams; an empty `teams` array also has no rank, so `known` is already false and the page shows the reason |
| C1 not-applied control (pattern absent) | - | not applied, file unchanged, not counted |

8/8 applied non-survivor mutants killed.

## 6. Known defects / follow-ups

- The rank is as of the last sync (`as_of`); claims processed since can move it. The page says
  "as of the last sync".
- `nextWaiverRun` still reads `acquisitionSettings` (days, hour) itself: a second reader of the
  same settings object, different fields, no disagreement. Follow-up: move the clock into
  `leagueRules().waivers`.
- Sleeper leagues: `leagueRules` returns `unsupported_platform`, so `claim_priority` is
  `known: false` with the missing fields named (no Sleeper league is synced locally).
- No decision grade: the unit ships a rule and a published rank, not a recommendation with a
  number, so there is no model, pre-registration, holdout look, win rate or MDE to report. The
  strategy line makes no quantitative claim.
- WORK-QUEUE.md has two rows with ID RL-13-2 (lines 858 and 862); this unit is line 858.

## 7. Nick's five questions

1. Well built? Extends the one league-rules producer and the existing board; 8 new tests, 8/8
   applied mutants killed, neighbouring waiver and rules tests pass, typecheck clean.
2. Stats or made up? Neither a stat nor a model: the reset flag and rank are ESPN's own fields,
   read from the synced payload. The one inference (what the reset resets to) is labelled a guess
   and not shown.
3. How do we know? Liveness run on a local copy of all 5 leagues matches the direct SQL read of
   each team's waiverRank.
4. Pointed elsewhere? Yes: `GET /api/trades/:leagueId/waivers` -> WaiverWire.tsx on the lineup
   page; no nav change (8 tabs).
5. How does it unify? The reset rule has one producer (`leagueRules().waivers`); the board reads
   it rather than parsing settings again. The remaining second reader (`nextWaiverRun`) is named
   above.
