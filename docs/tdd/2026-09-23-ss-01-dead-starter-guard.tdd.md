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
