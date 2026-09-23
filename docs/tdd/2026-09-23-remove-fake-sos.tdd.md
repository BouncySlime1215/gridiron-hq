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
