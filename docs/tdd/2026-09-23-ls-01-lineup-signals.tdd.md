# LS-01: lineup-signal tracker (Trade Machine, human side)

Branch `claude/local-ls-01-lineup-signals`, cut from `origin/main` at `3ac59fea`.
Pre-registration: `docs/evidence/2026-09-23/ls-01-bwiu-trade-prereg.md`.
Real-row numbers below come from a local copy of the app database, not production.

## 1. Audit: extend or build (written before the first test)

What exists for this surface on `3ac59fea`:

| piece | where | what it does | verdict |
|---|---|---|---|
| weekly lineup history | table `league_roster_snapshots` (migration `server/migrations/058_league_roster_snapshots.js`), writer `writePeriod` `scripts/collect-roster-snapshots.mjs:109` (INSERT at :113), rows from `rowsFromEntries` :65 | every team's roster and lineup slot per ESPN scoring period; `final` rows from the boxscore, `live` for the current period | reuse as the only lineup source |
| a reader of that table for lineups by manager | none (`git grep league_roster_snapshots -- server` returns the migration only) | | build |
| current dead starters | `rosterSignals` `server/services/manager-signals.js:307`, metric `lineup_dead_starters` | counts starters whose CURRENT payload status is OUT/IR/DOUBTFUL, one snapshot, no history | different concept (a status right now vs a started player who did not play in a completed week). Kept; the new signal is named `dead_starter_left_in`, and both values on the same league are reported in section 5 |
| trade block | `leagues.payload` `teams[].tradeBlock.players` (`ON_THE_BLOCK` / `UNTOUCHABLE`) | stored by the ESPN sync | no server reader today; build the read in the producer |
| usage share | `player_week_snaps.offense_pct` (writer `syncSnapCounts` `server/services/nflverse.js:287`, INSERT :300) | snap share 0-1 | reuse; route share is not stored anywhere, so "usage" is snap share |
| weekly fantasy points for a free agent | `pprPoints` `server/services/offseason-data.js:544` over `player_week_usage` | PPR from a stat row | reuse for "last week's top scorer". A second producer, `pprPoints` `server/services/offseason-model.js:73`, omits fumbles lost; not touched here, named as a follow-up |
| byes | `schedule_games` (writer `syncSchedules` `server/routes/nfldata.js:117`), `team_id` = ESPN pro team id (`nfl_teams.id`) | a team with no row in a week is on bye | reuse |
| matchup strength | `matchups.js` `MATCHUP_SIGNAL_REASON` :72 | DvP multipliers held at 1 as not validated | not used; "bad matchup" is read from ESPN's own weekly projection (`league_roster_snapshots.projected_points`) against the player's earlier projections |
| the route | `GET /api/trades/:leagueId/brain/managers` `server/routes/trades.js:225` -> `managerProfiles` `server/services/league-brain.js:126` | Nick's typed tiers | extend the route response with `lineup_signals`; `league-brain.js` keeps its export list (a test pins it) |

Decision: **build** one producer `server/services/lineup-signals.js`, computed on
read (no new table, no migration), and **extend** the `/brain/managers` response.
A stored table would need Nick's approval and a writer job; the inputs are small
(about 800 rows a week per league) so on-read is enough.

## 2. RED

- `fe2dfd34` test: RED lineup-signal tracker, one fixture and one near miss per signal, route test.
  Against a stub producer that returns no signals, 8 of 8 fail. First failing assertion:
  `player 101 benched in week 3 with snaps held` / `0 !== 1`; route test: `true !== false` on
  `body.lineup_signals?.available`.
- `4738346d` test: RED byes and dead starters must key on nfl_teams id, not ESPN pro_team_id.
  Found on real rows after the first GREEN: 72 "byes" in weeks 1-2, when no NFL team has a bye
  (`schedule_games` has all 32 teams in weeks 1-4). ESPN numbers teams its own way (33 = BAL,
  34 = HOU; `nfl_teams` 3 = BAL). Failing assertion: `dead.length` `0 !== 1`.
- `9ebc5c1d` test: RED a starter with points and a stat line but no snap row is not a dead
  starter. Found on real rows: 11 of 13 flagged "dead starters" had points (18.8, 11.2, 4.3) and
  a `player_week_usage` row, only no snap row. Failing assertion:
  `206 has a stat line and points, only no snap row` / `1 !== 0`.
- `470e5621` test: RED kickers are not ranked by PPR; a zero projection is ruled out, not a bad
  matchup. Found on real rows: kickers with 0 PPR "ranked" 3rd and 4th; a starter projected 0
  flagged as a bad matchup. Failing assertions: `a projection of 0 is ruled out, not a matchup`
  `1 !== 0`; `kickers are not ranked by PPR` `1 !== 0`.

## 3. GREEN

- `a66044dc` feat: lineup-signal tracker, one producer read by GET /brain/managers. 8/8 pass.
  One test expectation was wrong, not the code: benched WR 304 is also a passed-over flex
  option, so `over_player_ids` is `[304, 306]` (fixture oversight, fixed in the same commit).
- `f1371563` fix: byes keyed on `players.team_id` (nfl_teams id), dead starter needs no snaps AND
  no stat line AND no points, K/DEF excluded from PPR ranks, projection 0 excluded from bad
  matchup. 8/8 pass.
- `6b87a64f` test: tightened near misses after the mutation sweep (below). 8/8 pass.
- Neighbouring suites on the same tree: `test/league-brain.test.js` 5/5, `test/cross-account-league-access.test.js` 8/8
  (both read `/brain/managers` or `managerProfiles`).

Command for every run: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/lineup-signals.test.js`

## 4. What it does

`server/services/lineup-signals.js` `lineupSignals(leagueId)` reads `league_roster_snapshots`
for the league's season and returns, per manager (`roster_id`) and player, eight signals:
benched_intact_usage, benched_and_shopped, started_bad_matchup, dead_starter_left_in,
bye_unfilled, injured_not_on_ir, added_last_week_top_scorer, flex_choice. Each row carries its
week and the evidence it rests on (snap shares, projections, rank, trade-block status). The
response also has `by_manager` counts, the rules and thresholds, `unavailable` reasons when an
input is missing, and `inference: "guess"` with the sentence saying why.
`GET /api/trades/:leagueId/brain/managers` (`server/routes/trades.js:226`) now returns
`{ ...managerProfiles, lineup_signals }`. Computed on read: no table, no migration, no job.
The page that reads `/brain/managers` (`client/src/pages/TradeBrain.tsx:49`) gets the field; it
does not render it yet (named below).

## 5. Numbers (each with command and tree)

### 5a. Live signals, local copy (not production), tree `f1371563`

Command: `GRIDIRON_DB_PATH=$WT/.local-db/data.sqlite node scratchpad/live.mjs` (calls
`lineupSignals` for every league and sums by signal). Copy taken 2026-09-23 06:18 local with
`sqlite3 ~/gridiron-local/data.sqlite ".backup ..."`. Snapshot periods: 1 final, 2 final, 3 live
in all five leagues.

| signal | total, 5 leagues | known-nonzero / zero explained |
|---|---|---|
| flex_choice | 112 | about one FLEX per team per final week (5 leagues x ~11 teams x 2 weeks) |
| added_last_week_top_scorer | 8 | QB/RB/WR/TE only after the kicker fix |
| injured_not_on_ir | 8 | from the live week-3 rows (finals carry no status) |
| dead_starter_left_in | 2 | independent SQL (no snaps, no usage row, 0 points) returns the same 2 rows |
| started_bad_matchup | 0 | both earlier hits were projection-0 starters (ruled out), now excluded |
| bye_unfilled | 0 | no NFL byes in weeks 1-4 (`schedule_games` 2026: 32 teams each week 1-4) |
| benched_intact_usage | 0 | needs 2 prior weeks on the roster: the first possible event is week 3 final |
| benched_and_shopped | 0 | the one ON_THE_BLOCK player in all five payloads starts in the latest period (slot 2); he was benched in week 1, so the reader sees him |

Liveness proof, same copy, tree of the commit that adds this section (label change on top of `6b87a64f`): the real router mounted with a bearer
session on league 2, `GET /api/trades/2/brain/managers` -> 200, 10 managers,
`lineup_signals.available = true`, `inference = "guess"`, counts flex_choice 20,
added_last_week_top_scorer 2, injured_not_on_ir 2, no `espn_s2`/`swid` in the body
(`scratchpad/live-route.mjs`).

One number, two producers: `manager_signals.lineup_dead_starters` (stored, current status
OUT/IR/DOUBTFUL) sums to 3, 4, 1, 0, 3 across leagues 1-5; `dead_starter_left_in` (completed
weeks, did not play) is 1, 0, 0, 0, 1. Different questions (now vs history), served under
different names; not unified here.

### 5b. The pre-registered study (discovery 2021-2024), tree `9709c63c`

Command: `nice -n 10 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 docs/evidence/2026-09-23/ls-01-bwiu-study.py --split discovery --app $WT/.local-db/data.sqlite`
(28.6 s). Sleeper corpus, 2,000 leagues, 6,414 completed trades. Known-nonzero controls: 96,264
BWIU events, 1,488,765 SK events; snap share found for 3,444,403 of 4,298,269 skill player-weeks
(80%). Sign: positive D = the benched player outscored what his manager accepted (PPR per game,
the four NFL weeks after the trade).

| test | pairs | leagues | mean D | 95% CI (league bootstrap) | MDE at 80% | win rate |
|---|---|---|---|---|---|---|
| H1 BWIU vs what he accepted | 6,839 | 1,071 | -1.055 | [-1.275, -0.839] | 0.315 | 0.433 |
| SK control (kept starting) | 47,176 | 1,127 | +1.352 | [+1.204, +1.493] | 0.209 | 0.564 |
| BWIU sold in that trade (descriptive) | 910 | 560 | -0.749 | [-1.243, -0.280] | 0.681 | 0.454 |
| H2 BWIU minus SK | | | -2.407 | [-2.598, -2.227] | 0.264 | |

**Verdict: H1 fails its ship rule, in the opposite direction.** The interval excludes 0 on the
negative side and the test could detect 0.3 points per game, so this is not "underpowered".
Players a manager benches while their snaps hold score about a point per game LESS than what he
next accepts in a trade; his benching carries information rather than a blind spot. Decision
grade against the fair-trade baseline (50%): acquiring the benched player instead of what his
manager took would have won 43.3% of the time. The reading stays `inference: "guess"` and the
served sentence now says the test failed and not to read a benching as a buy-low. 2025 was not
opened: the ship rule needed both, and discovery already failed.

## 6. Mutation sweep

Script `scratchpad/mutate.mjs`: one mutant at a time on the producer and its call site, run the
file, restore. Final run on tree `6b87a64f`:

| mutant | result |
|---|---|
| M1 usage check dropped | killed (tests 1, 7) |
| M2 minStarts 2 -> 1 | killed (1, 7) |
| M3 any trade-block status counts | killed (2) |
| M4 better-bench requirement dropped | killed (all 8, by a TypeError on `better.player_id`, not an assertion) |
| M5 bye test inverted | killed (4) |
| M6 stat-line check dropped | killed (4, 7); SURVIVED the first sweep (206 had ESPN points, which also protected him) -> fixture set to no points in `6b87a64f` |
| M7 IR status in any slot | killed (4, 7) |
| M8 top-scorer rank 5 -> 10 | killed (5) |
| M9 designed survivor: flex "bench player played" filter dropped | survived, as designed: every benched flex option in the fixture played |
| M10 call site: route drops lineup_signals | killed (8) |
| M11 call site: route reads league id + 1 | killed (8) |
| M12 inference label flipped to measured | killed (7) |
| M13 bad-matchup ratio 0.8 -> 1.0 | killed (3); SURVIVED the first sweep -> 0.85 near miss (208) added in `6b87a64f` |
| C0 not-applied control (search string absent) | reported NOT APPLIED, not "survived" |

## 7. Known defects and limits

1. Usage is snap share only; route share is not stored anywhere in the app.
2. Byes key on `players.team_id`, the player's CURRENT team: a player traded mid-season has his
   old byes read against his new team. The as-of key is the snapshot's ESPN `pro_team_id`, but
   the ESPN -> abbr map exists three times and is exported nowhere (`server/routes/espn.js:29`,
   `server/routes/nfldata.js:12`, `server/services/espn-draft.js:70`). Follow-up: export one map,
   then key on `pro_team_id`.
3. Two `pprPoints` producers: `server/services/offseason-data.js:544` (used here, includes -2 per
   fumble lost) and `server/services/offseason-model.js:73` (no fumbles). On a stat line with one
   fumble lost they differ by 2.0. Follow-up: one PPR function.
4. `injured_not_on_ir` counts INJURY_RESERVE only; leagues whose IR slot also takes OUT are not
   flagged for OUT players. Final rows carry no status, so it reads the latest (live) period.
5. `started_bad_matchup` compares to the player's own earlier ESPN projections: with one prior
   week it is thin. DvP is not used because `matchups.js` holds it at 1 as unvalidated.
6. The study used Sleeper leagues, PPR regardless of league scoring, and Sleeper's lineups; ESPN
   leagues were not tested. Only the BWIU reading was tested; the other readings are untested
   guesses.
7. `TradeBrain.tsx` receives `lineup_signals` but does not render it; that belongs to the
   Trade Brain target board unit (TM-03).
8. Computed on read (about 40-125 ms per league on the local copy); no job writes it, so there
   is no `lineup_signal` table and no migration.

## 8. Holdout looks

None. 2025 was not opened (discovery failed the ship rule first), so no row goes in
`docs/evidence/HOLDOUT-LEDGER.md`. No 2026 forward look: the Sleeper corpus has no 2026 and the
app's 2026 snapshots cannot hold a BWIU event before week 3 final.

## 9. Nick's five questions

1. **Well built?** One producer, computed on read from the one lineup history table, eight
   signals each with a firing fixture and a near miss, 12 of 13 mutants killed plus the designed
   survivor, and four bugs found on real rows and fixed test-first.
2. **Stats or made up?** The lineup facts are stored rows (slots, snaps, projections, trade
   block). The thresholds (0.9, 0.4, 0.8, top 5) are chosen, not fitted; they are guesses and
   say so. The one reading tested failed.
3. **How we know?** Pre-registered (`10750988`) before any number, script committed before its
   first run (`9709c63c`), 6,839 pairs across 1,071 leagues, league-clustered interval, MDE 0.3.
4. **Pointed elsewhere?** Reuses `pprPoints`, `player_week_snaps`, `schedule_games`, the stored
   payload. It does not replace `lineup_dead_starters` (different question), and names the two
   pprPoints producers and the three ESPN team maps as follow-ups.
5. **How it unifies?** It extends `/brain/managers`, the route the Trade Brain page already
   reads, and puts the reading's status (guess, and why) in the same response, so no page can
   show a benching as a buy-low without the sentence saying the test failed.
