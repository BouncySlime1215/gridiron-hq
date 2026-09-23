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
