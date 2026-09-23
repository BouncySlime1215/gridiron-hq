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

## 2. RED

`803f8867` test: CE-05 RED - league rules module, division seeding, fixed bracket, no silent defaults.
`test/league-rules.test.js`, 15 tests, all failing on `179c9096` (= `89f69b3b` + docs):

- tests 1-10: `server/services/league-rules.js must exist (ERR_MODULE_NOT_FOUND ...)`
- tests 11-12: `season-sim must export playBracket via __test` — expected `'function'`, actual `'undefined'`
- test 13: `the 2-3 division-1 winner takes the second spot` — expected `1`, actual `0`
- test 14: `expected a named error, got playoff_teams=6` (the silent `?? 6` default, live)
- test 15: `body.rules_source` — expected `'espn_settings'`, actual `undefined`

Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/league-rules.test.js`

## 3. GREEN

`8b39a42d` feat: CE-05 league-rules.js is the one producer of league rules; season sim seeds and brackets by them.
Same command: 15/15 pass. Neighbouring targeted tests on `8b39a42d`, same harness, one run each:
`b-01-real-record-odds` 8/8, `decision-leftovers-home-away` 5/5, `trade-engine-correctness` 15/15,
`trade-tactics` 39/39, `model-integrity` 89/89, `trade-verify` 24/24. `node scripts/wiring-map.mjs --check` exit 0.

Follow-up test commits (the mutation sweep found survivors, section 5):
`0137f9b8` test: CE-05 pin the sim's bracket-format call site and the median game (also carries the
replay script and the two ledger rows), `b64b0dba` test: CE-05 median game at-the-median case.
Liveness of the new bracket test: against `origin/main`'s `season-sim.js` (swapped in, then restored with
`git checkout --`) `league-rules-bracket-sim.test.js` test 1 fails (`playoff_weeks` undefined; the
re-seeded bracket sends seed 2, not seed 6, to the final), test 2 (re-seeded control) passes.
Final on `b64b0dba` (tree `d59eeb26`): `league-rules.test.js` 16/16, `league-rules-bracket-sim.test.js` 2/2.

Three existing fixtures gained the schedule fields the simulator now requires (`playoffReseed`,
`playoffSeedingRule`, `divisions`; plus `matchupPeriodLength`/`playoffMatchupPeriodLength` in
decision-leftovers). Without them the sim returns its named error instead of running on a default,
which is the contract; the tests' assertions are unchanged.

## 4. What it does

`server/services/league-rules.js`
- `leagueRules(lg)` → `{ source, platform, schedule { regular_season_weeks, regular_matchup_length,
  playoff_teams, playoff_round_length, playoff_rounds, playoff_weeks [[...] per round], reseed },
  seeding { tiebreaker, divisions, division_winners_first, team_division }, median_game, missing[],
  unsupported[], unknown[] }`. A missing field is `null` plus its payload path in `missing`; no
  defaults. (Since `f2018730`: the roster, trade, scoring, scoring_items, tie-rule and consolation
  fields were removed because nothing outside the module read them; see section 9.)
- `seedStandings(standings, rules)`: division winners first when there is more than one division,
  then wins (ties = half), then the league's tiebreaker. Only `TOTAL_POINTS_SCORED` (all five leagues)
  is implemented; any other value throws by name.
- `simRulesProblem(rules)`: the simulator's blocking list (`SIM_REQUIRED`).

`server/services/season-sim.js` `simulateSeason`: reads regular weeks, playoff teams, playoff weeks per
round, reseed, tiebreaker, divisions and median game from `leagueRules`; returns
`{ error, rules_source, rules_missing, rules_unsupported }` when a required field is missing.
`playBracket` plays a fixed ESPN bracket (1 v 4/5 winner, 2 v 3/6 winner) unless `playoffReseed`, and
scores a two-week round over both weeks. Output adds `rules_source, playoff_weeks, seeding_rule,
reseed, division_winners_first, median_game, rules_unknown`. Removed: `PLAYOFF_WEEKS` import,
`?? 14`, `?? 6`, the inline wins-then-points sort and the always-re-seed bracket.

`server/services/trade-horizon.js` `leagueSchedule`: delegates to `leagueRules` (one producer); keeps
its labelled `source: 'default'` fallback. Behaviour change: a payload with no
`matchupPeriodLength` now falls back (it was treated as 1); all five local payloads carry it.

Consumer: `GET /api/model/:leagueId/simulate` (`server/routes/model.js:450-461`) returns the
`simulateSeason` result, so it carries `rules_source`; also reached by `myPlayoffOdds`
(`trade-engine.js:1380`, which already falls back on a returned `error`), `tradeImpact`
(`season-sim.js`), `title-odds-trades.js:66`, `routes/trades.js:1155`.

## 5. Mutation sweep

`python3 docs/evidence/2026-09-23/mutate-league-rules.py` on `0137f9b8` (M14/S1/N1 re-run on `b64b0dba`).
First sweep (on `8b39a42d` + the untracked script) had **M10 SURVIVED** (sim passes `reseed: true`):
with no projections every playoff game is 0-0 and the better seed always advances, so fixed and
re-seeded brackets crown the same teams. Fixed by `league-rules-bracket-sim.test.js`. Second sweep had
**M14 SURVIVED** (median tie counted as a win): no team sat exactly on the median. Fixed in `b64b0dba`.

Current sweep: `python3 docs/evidence/2026-09-23/mutate-league-rules.py` on `f2018730` (clean tree;
the script now refuses a dirty tree, because each mutant is reverted with `git checkout`).

| mutant | kind | result | failing tests |
|---|---|---|---|
| M1 division winners ignored | unit | killed | 3, 13 |
| M2 points-for tiebreak dropped | unit | killed | 1, 3, B3 |
| M3 missing playoffTeamCount → 6 | unit | killed | 2, 14 |
| M4 round length ignored | unit | killed | 5 |
| M5 unsupported tiebreaker seeded on points | unit | killed | 4 |
| M6 fixed bracket re-seeds | unit | killed | 10, B1 |
| M7 two-week round scored on one week | unit | killed | 11 |
| M8 sim seeds on plain wins-then-points | call site | killed | 13 |
| M9 sim ignores simRulesProblem | call site | killed | 14 |
| M10 sim passes reseed:true | call site | killed (survived before the fix) | B1 |
| M11 trade-horizon one week per round | call site | killed | 9 |
| M12 sim bracket on fixed weeks 15-17 | call site | killed | 13, 15, B1-B4 |
| M13 carried-in record skips median | call site | killed | 12 |
| M14 median tie counted as a win | unit | killed (survived before the fix) | 12 |
| MB1 sim seeds with `pf: 0` (skeptic's mutant) | call site | killed (survived on `0be6edfd`) | B3 |
| S1 winners not re-sorted (equivalent: winners are inserted in sorted order) | designed survivor | survived | none |
| N1 pattern absent | not-applied control | NOT APPLIED | n/a |

B<n> = `league-rules-bracket-sim.test.js` test n.

## 6. Numbers (all local copy, not production)

- Rules on the five local leagues (`GRIDIRON_DB_PATH=.local-db/data.sqlite node scratchpad/live.mjs`
  on `8b39a42d`): all five `source: espn_settings`, 0 missing, 0 unsupported, 0 unknown; playoff weeks
  league 1 `[[15,16],[17,18]]`, league 3 `[[14,15],[16,17]]`, leagues 2/4/5 `[[15],[16],[17]]`;
  starters agree with the `leagues.roster_positions` column on all five (league 4 has 2 FLEX in both);
  `median_game` false on all five.
- One real simulation (league 3, 200 runs, seed 3, same script with `sim`): no error,
  `rules_source: espn_settings`, `playoff_weeks [[14,15],[16,17]]`, playoff odds sum 4.000 (= 4 playoff
  teams), title odds sum 1.000, 123 s wall (mostly `buildProjections`). Odds magnitudes are not
  reported: this changes the playoff/title-odds producer, so it goes to the Independent Auditor
  before merge (rule 2), direction only.
- Seed replay: `docs/evidence/2026-09-23/league-rules-replay.md` — 2025 26/26, all stored 108/108,
  payload 46/46; control (no division rule) 8/10 in league 2 2023 and 2024.

Statistical discipline: not a model and no fit, so no pre-registration, MDE or decision win rate
applies; the replay is a deterministic rule check with a pass rule committed first. Holdout looks
recorded (`L154`, `F001`).

## 7. Known defects and follow-ups

- `server/services/league-history.js:116` `saveScores` (writer of `league_week_scores.is_playoff`)
  still uses `matchupPeriodCount ?? 14`; and the history backfill stores no past-season settings, so
  replays of past seasons use current settings (a guess). Follow-up: store settings per season.
- **Follow-up (slot map):** two ESPN slot maps remain: `routes/leagues.js:118` `ESPN_SLOT_NAME`
  (writer of `leagues.roster_positions`, `syncEspnLeague` at `:153-155`) and `espn-draft.js:78`
  `SLOT_NAME`. They differ on slot 7 (OP/superflex: `ESPN_SLOT_NAME` drops it). The sim takes slots from
  `trade-engine.js:565` `lineupSlots` (reads the column, silent default); not touched (trade-engine.js
  is being edited by BLEND-01/S-03). league-rules.js no longer produces roster fields, so it is not a
  third producer. The offensive slots agree on all five local leagues (skeptic's cmp.mjs); a superflex
  league would not.
- **Follow-up (trade settings):** `trade-tactics.js:426` reads `tradeSettings.vetoVotesRequired`
  itself; it moves here when a second reader needs trade settings.
- Tiebreakers other than `TOTAL_POINTS_SCORED` are refused, not implemented. `playoffSeedingRuleBy`
  is not interpreted.
- Playoff ties go to the better seed (unchanged); ESPN's `playoffMatchupTieRule: NONE` behaviour in a
  tied playoff game is not verified.
- **Follow-up (Sleeper reader):** Sleeper is `unsupported_platform`, and `simulateSeason` returns
  the named error "league rules incomplete: settings (no rules reader for platform sleeper)". Sleeper
  sims already returned "no remaining fixtures in this league schedule" on `89f69b3b`: the payload
  `syncSleeperLeague` writes (`routes/leagues.js:184`, `{ league, rosters, users, traded_picks,
  drafts }`) has no `matchups`, so no Sleeper sim regressed. The sim's Sleeper branches in `fixtures()`
  and `initialRecords()` were already unreachable and are now marked so. Follow-up: read
  `payload.league.settings` (`playoff_teams`, `playoff_week_start`; `sleeper-history.js:37` already
  reads them) and store Sleeper matchups. No Sleeper league exists in the local copy (`select platform,
  count(*) from leagues group by platform` → `espn|5`), so a reader could not be checked on real rows.
- `matchups.js:25` `PLAYOFF_WEEKS = [15,16,17]` remains the default for league-less callers (the
  Edge page's "Weeks 15-17" schedule tab, `edge.js`); every league-aware caller passes
  `leagueSchedule(lg).playoffWeeks`.
- The consolation ladder is not simulated (does not affect playoff or title odds), and
  `consolationLadderDisabled` is no longer read.
- Pre-existing, not this unit's file: `scoring.js:73` `catch { return fallback; }` swallows a JSON
  error silently.

## 8. Nick's five questions

1. **Well built?** One module, one producer; the simulator and the trade horizon read it; missing
   fields are named errors, not defaults. 15 + 4 + 5 targeted tests, 15 mutants killed (three only
   after fixing the tests), one designed equivalent survivor, one not-applied control.
2. **Stats or made up?** Neither a stat nor a guess: every rule is read from the league's own ESPN
   settings. Two things are inferred and labelled: division winners take the top seeds (from league 2's
   stored 2023-2025 seeds) and median game (from records per decided week). Past-season settings = the
   2026 ones is a guess.
3. **How we know:** replay of real stored seeds, 108/108 (2025: 26/26), with a control that fails
   (8/10) when the division rule is off. Tests pin each rule; one real sim run on a local copy.
4. **Pointed anywhere else?** `GET /api/model/:id/simulate` (with `rules_source`), `myPlayoffOdds` →
   trade ideas/horizon, `tradeImpact` → POST `/trade-impact`, title-odds trades, the trade sense-check;
   `leagueSchedule` → every trade-engine horizon. The Model and MyTeam pages now print the sim's
   own `playoff_weeks`. Nav unchanged; no migration; no new table or column.
5. **How it unifies:** the six readers of league settings in section 1 become one producer for the sim
   and the horizon; the remaining three are named above as follow-ups.

One line each: gap fixed — `season-sim.js:78,217,220,299-328` on `89f69b3b` (silent `?? 14`/`?? 6`,
fixed weeks 15-17, no divisions, always re-seed); incumbent — `simulateSeason` itself, by
`git grep -n "PLAYOFF_WEEKS\|?? 14\|?? 6" server/services/season-sim.js`; does NOT cover — Sleeper,
H2H tiebreakers, past-season settings storage, `lineupSlots`; would make it wrong — an ESPN league
whose division winners do not get top seeds (the replay covers one two-division league only) or a
payload whose `playoffTeamCount` means something other than bracket size.

## 9. Skeptic round 1 (on `0be6edfd`) and fixes

All test runs: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.

1. **Points-for tiebreaker had no call-site test (MB1 survived).** `dc68c2af` adds two
   `simulateSeason` tests (B3, B4) in `league-rules-bracket-sim.test.js`: T3 and T4 finish level on
   wins for the 4th and last spot, only points-for separates them, and input order favours T3. B3
   (T4 has more PF) asserts T4 playoff odds 1 and T3 0; B4 is the reversed control. On `dc68c2af`
   both pass (4/4). With MB1 applied (`pf: 0` at the `seedStandings` call), B3 fails (expected 1,
   actual 0) and B4 passes; MB1 is now in the sweep (killed by B3).
2. **Pages said "weeks 15–17".** RED `e8e03f63`: `test/league-rules-client-copy.test.js`
   failed 5/5 (`playoffWeeksText is not a function`, and both pages matched `15[–-]17`). Fix
   `b7285941`: `client/src/copy-constants.ts#playoffWeeksText` formats the sim's `playoff_weeks`
   (`[[15,16],[17,18]]` → "NFL weeks 15–18, two weeks per round"; absent → null, no week text), and
   `Model.tsx` / `MyTeam.tsx` render it. 5/5 pass. `rules_source` is not shown on the pages: a page
   only reaches the odds when the source is `espn_settings` (any other source is the named error that
   `Model.tsx` already shows as an empty state).
3. **Unread fields / three slot producers.** `f2018730` removes roster, trade, scoring,
   scoring_items, matchup/playoff tie rules and consolation from `leagueRules`; test 6 of
   `league-rules.test.js` pins the key set (it fails on `0be6edfd`'s module). Slot-map and
   trade-settings follow-ups are named in section 7.
4. **Sleeper.** Partly disputed: Sleeper leagues did not lose a working sim. On origin/main the
   Sleeper payload has no `matchups` (`git show origin/main:server/routes/leagues.js | grep -n "const
   payload = {"` → `184:  const payload = { league, rosters, users, traded_picks: tradedPicks, drafts };`),
   so `fixtures()` was empty and the sim already returned "no remaining fixtures". The follow-up is
   now named (section 7) and the dead branches are marked. `node -e` on `f2018730`:
   `simRulesProblem(leagueRules({platform:'sleeper', ...}))` →
   `{"error":"league rules incomplete: settings (no rules reader for platform sleeper)", ...}`.

Targeted runs on `f2018730`: league-rules 15/15, league-rules-bracket-sim 4/4,
league-rules-client-copy 5/5, b-01-real-record-odds 8/8, decision-leftovers-home-away 5/5,
trade-engine-correctness 15/15, wiring-map 90/90; `node scripts/wiring-map.mjs --check` exit 0.
The seed replay was not re-run: `seedStandings` and the schedule/seeding reads are byte-identical to
`0be6edfd` (`git diff 0be6edfd f2018730 -- server/services/league-rules.js` touches only the header,
`emptyRules`, the removed roster/trade/scoring blocks and `consolation`).
