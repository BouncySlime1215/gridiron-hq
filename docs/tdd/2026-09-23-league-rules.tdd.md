# CE-05: one module for each league's exact rules (league-rules.js)

Branch `claude/local-ce-05-league-rules`, base `origin/main` at `89f69b3b`.
Plan item A1 (league config auto-ingest) / B9 (Championship Engine). Not a
statistical unit: it reads settings and applies them, it fits nothing, so there
is no pre-registration. The one check with a pass rule is the seed replay,
whose rule is written here before the module ran on real rows (see "Replay").

## 1. Audit: what already reads league rules (on `89f69b3b`)

Command: `git grep -n "playoffTeamCount\|playoffMatchupPeriodLength\|matchupPeriodCount\|lineupSlotCounts\|deadlineDate\|playoffSeedingRule\|scheduleSettings\|tradeSettings\|rosterSettings" -- server client/src scripts`

| Producer | Reads | Absent-field behaviour |
|---|---|---|
| `server/services/scoring.js:52` `scoringFor(lg)` | `settings.scoringSettings.scoringItems` | falls back to a PPR bucket. **Reused as-is** (not duplicated) |
| `server/services/season-sim.js:78` `fixtures()` | `matchupPeriodCount` | `?? 14`, silent |
| `server/services/season-sim.js:217` `simulateSeason` | nothing: `PLAYOFF_WEEKS` = `[15,16,17]` (`matchups.js:25`) | always 15-17, one week per round |
| `server/services/season-sim.js:220` `simulateSeason` | `playoffTeamCount` | `?? 6`, silent |
| `server/services/season-sim.js:299-301` seeding | nothing: wins then points for | division winners, `playoffSeedingRule` ignored |
| `server/services/season-sim.js:311-328` bracket | nothing: re-seeds every round | `playoffReseed` ignored |
| `server/services/trade-horizon.js:54` `leagueSchedule(lg)` | `matchupPeriodCount`, `playoffMatchupPeriodLength`, `playoffTeamCount`, `matchupPeriodLength` | returns 14 / `[15,16,17]` with `source: 'default'` (labelled) |
| `server/services/league-history.js:116` `saveScores` (writer of `league_week_scores.is_playoff`) | `matchupPeriodCount` | `?? 14`, silent |
| `server/routes/leagues.js:118,153` (writer of `leagues.roster_positions`) | `lineupSlotCounts` via a local `ESPN_SLOT_NAME` | unmapped slots dropped |
| `server/services/espn-draft.js:81-95` `SLOT_NAME`, `startingSlots` | `lineupSlotCounts` | bench/IR excluded; **reused** |
| `server/services/trade-tactics.js:426` | `tradeSettings.vetoVotesRequired` | `?? null` |

So the rules were read in six places, three of them with silent defaults, and
the season simulator (the producer of playoff and title odds) read two fields
and hard-coded the rest.

### What the five local payloads actually say (local copy, not production)

Command: `node scratchpad/shape.mjs .local-db/data.sqlite` (field names and counts only).
All five are ESPN, `settings` carries `scheduleSettings`, `rosterSettings`,
`tradeSettings`, `scoringSettings`, `acquisitionSettings`.

| league | teams | regular weeks | playoff teams | weeks per playoff round | reseed | seeding rule | divisions | IR slots | bench |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 8 | 14 | 4 | 2 | false | TOTAL_POINTS_SCORED | 1 | 1 | 7 |
| 2 | 10 | 14 | 6 | 1 | false | TOTAL_POINTS_SCORED | 2 | 1 | 7 |
| 3 | 8 | 13 | 4 | 2 | false | TOTAL_POINTS_SCORED | 1 | 1 | 7 |
| 4 | 10 | 14 | 6 | 1 | false | TOTAL_POINTS_SCORED | 1 | 1 | 7 |
| 5 | 10 | 14 | 6 | 1 | false | TOTAL_POINTS_SCORED | 1 | 1 | 7 |

Consequences for the simulator on `89f69b3b`:
- Leagues 1 and 3 play two-week playoff rounds; the sim plays one week per
  round on weeks 15-16. League 3's real bracket is weeks 14-17 (13-week season),
  league 1's is 15-18.
- League 2 has two divisions; the sim never gives a division winner a seed.
- All five have `playoffReseed: false` (fixed bracket); the sim re-seeds every
  round. Same answer for a 4-team bracket, different for the three 6-team
  brackets whenever the 6 seed beats the 3 seed.
- No median-game field exists in any payload (`scheduleSettings` and
  `scoringSettings` keys listed by the same command). Records show
  wins + losses + ties = 2 games per team after 2 decided weeks in all five
  (`node scratchpad/sched.mjs`), so none plays a median game this season.

### Extend or build

**Build** `server/services/league-rules.js` as the one producer of league
rules, reusing `scoringFor` and `espn-draft.js` `SLOT_NAME`/`startingSlots`.
**Extend** `simulateSeason` to consume it (regular weeks, playoff teams,
playoff weeks per round, reseed, tiebreaker, divisions) with the hard-coded
defaults removed. **Unify** `trade-horizon.js#leagueSchedule` onto the same
producer (same derivation, its labelled default kept for its callers).
Not touched, named as follow-ups: `league-history.js:116` (a writer; changing
it re-labels stored rows), `leagues.js:118` slot map, `trade-engine.js:565`
`lineupSlots` (reads the `roster_positions` column; trade-engine.js is being
edited by BLEND-01/S-03).

### Replay pass rule (written before the module ran on real rows)

For every league-season in `league_season_teams` (table; writer
`saveTeams`, `server/services/league-history.js:143`) with a stored
`playoff_seed` for every team, `seedStandings()` over that season's stored
wins, ties and points for, with that league's rules, must reproduce the stored
`playoff_seed` of **every** team. Pass = all seeds equal. The 2025 rows are the
held-out season: this is recorded in `docs/evidence/HOLDOUT-LEDGER.md`.
Disclosure: before writing this rule I eyeballed the stored seeds against a
plain wins-then-points order with one SQL query (leagues 1 and 3 matched; league
2 did not in 2023 and 2024, which is how the division-winner rule was found).
