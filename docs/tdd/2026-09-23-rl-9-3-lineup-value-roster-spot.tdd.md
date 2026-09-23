# RL-9-3: Trade Machine lineup value that charges the roster spot

Unit: RL-9-3 (WORK-QUEUE §9 round 9; R&D `rnd/loop/r9-internal-trade-fairness-ignores-roster-spots.md`). Plan items TR-03 / TM-01 / TM-42.
Branch `claude/local-rl-9-3-roster-spot-lineup-value`, base origin/main `ca64b2cc`.

## 1. Audit (written before the first test): extend, do not build

- **The summed value.** `server/services/trade-engine.js:1141-1142` (`side()` in `evaluate()`) sums `max(0, value)`; `:1166` `value_delta`; `:1167` `roster_spots = gets.length - gives.length` is computed and priced nowhere. Command: `git grep -n -i "roster.spot\|2-for-1" origin/main -- server/services/trade-engine.js server/routes/trades.js` -> only `trade-engine.js:1167`.
- **The lineup solver (reused, one producer).** `bestLineup` `trade-engine.js:637`. `side()` already solves the post-trade lineup (`ppg_delta`, `:1138`, `:1153`) but never fills the slot the 1-player side frees, and never charges the 2-player side a drop. `lineupDiff` (`:2814`) is the Start/Sit week diff on `week_points`, not a trade surface; nothing here reuses it beyond `bestLineup`.
- **No existing lineup-value or wire producer in the trade path.** `git grep -n -i "lineup_value\|lineupValue\|leagueWire" origin/main -- server client/src` -> 0 rows. Known-nonzero control for the same grep shape: `git grep -n -i "replacementLevel" origin/main -- server` -> `draft-assist.js:143` and `edge.js:36` (a draft-time positional replacement from a projected pool, not a league's live wire; not the same concept, not reused).
- **The league's wire (TM-42) exists once, inline.** `server/services/waiver-wire.js:152` `waiverBoard()` builds the free-agent pool inline (`rosteredNames` `:133`, `unownedAll`/`onNflTeam` `:222-227`). Extend: lift that filter into an exported `leagueWire(lg, assets)` that `waiverBoard` itself calls, and have the trade engine read the same producer. Input tables: `leagues.payload` (rosters; writer = league sync) and the priced asset universe `assetUniverse()` `trade-engine.js:283`; no new table, no migration.
- **Weeks remaining.** `trade-horizon.js:78` `horizonWeights()` already returns `regular_weeks_left` and `playoff_weeks_left` from `leagueSchedule(lg)` (`:55`); reused, not re-derived.
- **Open PR overlap (reported, not edited).** `gh pr list --state open` touching `trade-engine.js`/`waiver-wire.js`: #191 (replaces `rosteredNames` with an asset-id map), #178 (waiver alerts), #179, #174, #171 and others. #191 and this unit both touch the owned filter in `waiver-wire.js`; whichever merges second moves `leagueWire` onto the id map.

Decision: EXTEND `evaluate()`'s `side()` with a lazy `lineup_value` field, add `lineupValue()` + `lineupValueContext()` in `trade-engine.js` on top of `bestLineup`, and `leagueWire()` in `waiver-wire.js`. Expose on `POST /:leagueId/evaluate` and `GET /:leagueId/find`. No ranking, gate, tag or fairness input reads it (RL-8-2b pending Nick).

## 2. Pre-registration

Not a statistical unit in this PR: it runs no number on real data and ships no model number ON. `lineup_value` is a deterministic lineup solve labelled `status: 'not yet validated'`; whether it should replace the summed value in any decision is RL-8-2b's pre-registered gate (pending Nick). No 2025 row is read, so no holdout look is recorded.
Literature: the roster-spot charge is the replacement-level idea behind value over replacement (the free player anyone can add sets the zero; e.g. Tango, Lichtman and Dolphin, *The Book*, 2007, on replacement level) applied to one league's actual wire, which is how FantasyCalc's calculator is described to handle uneven trades (a waiver adjustment credited to the side receiving fewer players; R&D r9 §2b). The R&D measured the gap on Sleeper 2021-23 trades: holding the summed value fixed, each extra player received costs 4.61 [4.11, 5.14] ex-ante lineup points per remaining week (`rnd/loop/data/r9i/spot_cost.out`, R&D tree, not re-run here).

## 3. RED

- **#N/A (branch not yet a PR)** `test: RED for a lineup value that charges the roster spot in uneven trades (RL-9-3)` `07ced121`. On origin/main `ca64b2cc` code all 4 fail (`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/trade-lineup-value.test.js`, server stashed):
  - `not ok 1 - 2-for-1 ...` -> `error: 'lineup_value is on both sides of the evaluate payload'` (`assert.ok(a && b, ...)`)
  - `not ok 2 - 1-for-1 ...` -> `Cannot read properties of undefined (reading 'roster_spots')`
  - `not ok 3 - no wire supplied ...` -> `undefined !== null`
  - `not ok 4 - the replacement level reads THAT league's wire` -> `Cannot find module '.../server/services/league-wire.js'`
- `test: RED liveness for lineup_value on the evaluate route and the finder (RL-9-3)` `b94540af`: on base code both fail: `not ok 1 - POST /evaluate ...` -> `Cannot read properties of undefined (reading 'status')`; `not ok 2 - findTrades (GET /find) ...` fails the same way.

## 4. GREEN

- `feat: lineup value that charges the roster spot, beside the summed value (RL-9-3)` `5db7cc36`, then `fix: solve lineup_value on ppg_delta's key, pin it and the wire order in tests (RL-9-3)` `30e4cff4` (+ the evidence commit). Same commands: `trade-lineup-value` 4/4 pass, `trade-lineup-value-route` 2/2 pass.
- Regression, targeted, on the GREEN tree (same command shape): `find-trades` 3/3, `trade-engine-correctness` 15/15, `lineup-spread` 5/5, `decision-leftovers-waivers` 7/7, `decision-leftovers-lineup` 10/10, `lineup-surfaces-agree` 2/2, `wiring-map` 90/90.
- Found on the way: a first version imported `leagueWire` from `waiver-wire.js` into `trade-engine.js` (an import cycle). `decision-leftovers-waivers` went 0/7 because the engine then loaded `waiver-wire.js` before that test could mock the engine for it. Fixed by moving the wire into its own module, `league-wire.js`, which imports only `player-identity.js`. Re-run: 7/7.

## 5. What it does

- `server/services/trade-engine.js` `lineupValue(team, gives, gets, slots, { wire, weeksLeft })` returns `{ per_week, weeks, total, key, roster_spots, replacement[], unfilled_spots, dropped[], status: 'not yet validated', note }`.
  - The roster size stays what the team carries today.
  - A side that frees spots fills each one from the wire. It takes the best free agent at each position and keeps whichever raises the starting lineup most.
  - A side that needs spots drops, for each one, the player whose loss costs the lineup least. Ties go to the lowest-rated player.
  - `per_week` is the `bestLineup` change on `adj_ppg`, the same key as `ppg_delta`. `total` is `lineupSpan()` of the same two rosters over the weeks left (see section 10). It is NOT `per_week` times the weeks: `adj_ppg` is 25% this week, so that would count this week's byes and injuries in every week left.
- `lineupValueContext(lg, assets, teams)` takes the wire from `league-wire.js#leagueWire`, less anyone on a loaded roster by id. It takes `weeksLeft` = `regular_weeks_left + playoff_weeks_left` from `trade-horizon.js#horizonWeights(tradeWeekContext().week, leagueSchedule(lg))`.
- `evaluate()` `side()` adds `lineup_value` as a lazy field next to `value_delta` on `me` and `them`. It is `null` when the caller passes no wire. Being lazy, it costs only when read.
- Consumers:
  - `POST /api/trades/:leagueId/evaluate` (`server/routes/trades.js:857-858`) passes the context.
  - `GET /api/trades/:leagueId/find`: `findTrades` -> `findTradesUncached` builds it once per search (`trade-engine.js:1691`) and passes it into every `evaluate` (`:1731`).
  - No ranking, gate, tag, `fairness`, `their_value_pct`, `value_cost` or `score` reads it: `grep -n "lineup_value" server/services/trade-engine.js` shows only the producer lines.
- `server/services/league-wire.js` is the one producer of the league's wire: `rosteredNames`, `unrosteredSkill` and `onNflTeam`, moved unchanged from `waiver-wire.js`, plus `leagueWire(lg, assets)`. `waiverBoard()` now reads the same functions, so the Waivers page and the trade engine share one wire.
- Tables: nothing new is written. Reads are `leagues.payload` (rosters; never `espn_s2`/`swid`) and the priced asset universe (`assetUniverse`, `trade-engine.js:283`). **No migration.**

## 6. Mutation sweep (tree `30e4cff4`, both test files, script in the session scratchpad)

| Mutant | Where | Result |
|---|---|---|
| M1 freed spot never filled | unit | killed (unit 2, route 1) |
| M2 drop tie-break keeps the best-rated | unit | killed (1) |
| M3 fill picks the worst free agent | unit | **survived first**: the wire listed the best fill first. The test was wrong, so the fixture now lists it last. Then killed (2) |
| M4 total not multiplied by weeks | unit | killed (2) |
| M5 null guard removed (free spot with no wire) | unit | killed (1) |
| M6 needed spot never dropped | unit | killed (unit 1, route 1) |
| M7 evaluate route passes no wire | call site | killed (route 1) |
| M8 findTrades passes no wire | call site | killed (route 1) |
| M9 wire keeps rostered players | league-wire | killed (1) |
| M10 weeks = regular season only | call site | killed (unit 1, route 1) |
| M11 solved on ros_ppg instead of ppg_delta's key | unit | killed (route 1) |
| S1 designed survivor: id filter on loaded rosters removed | call site | survived, as designed. On an ESPN league the name filter already excludes rostered players. The id filter covers Sleeper payloads (which `rosteredNames` cannot read) and `findTradeSequences`' hypothetical rosters |
| N1 designed not-applied control | none | not applied (target count 0) |

## 7. The numbers

All numbers here are hand-built fixtures. No real row was read, no DB copy was made, and no 2025 row was touched.
- The 2-for-1 fixture (`test/trade-lineup-value.test.js`):
  - The summed value favours A, the side getting two players, by +1,100.
  - The lineup value favours B, the side getting one: A goes 109 -> 102 = -7/wk (-98 over 14 weeks). B goes 76 -> 85 = +9/wk (+126), because B's freed spot is filled by the wire WR (10).
  - Without the fill, B is +2/wk (`ppg_delta`).
- The same fixture with the wire WR rostered by a third team (league 2): B's fill becomes the wire RB, worth +5/wk.
- The 1-for-1 fixture: both numbers say A loses (value -300, lineup -1/wk). `per_week` equals `ppg_delta` exactly.

## 8. Known defects and limits

- **Not validated.** Whether the lineup value should replace or adjust the summed value in fairness, tags, gates or ranking is RL-8-2b's gate, pending Nick. Until then it is display-only, and the card (`client/src/components/TradeCard.tsx`) does not show it yet.
- **Roster size.** Capacity is the team's current roster count, not ESPN's roster limit. A team with an open spot is still charged a drop when it takes on an extra player. `waiverBoard()`'s claim-and-cut makes the same assumption.
- **Name-based wire on Sleeper.** `rosteredNames` reads only ESPN payloads. For Sleeper, `lineupValueContext` falls back to the id filter against the loaded rosters, which is correct only for rosters `loadRosters` resolved. Open PR #191 replaces `rosteredNames` with an asset-id map. Whichever of #191 and this branch merges second moves `leagueWire` onto that map.
- **Single-week pick.** The fill is chosen on `adj_ppg`, not on a week-by-week bye path. A fill that is on bye in a playoff week is not charged for it; `playoff_ppg_delta` is still charged the old way.
- **Decision grading (discipline d/e): not applicable.** No start/sit, waiver or trade call changes in this unit. The decision win rate against "offer fair value" belongs to RL-8-2b.
- **The finder over HTTP returns no deals on the seed.** Every seeded ppg is 0 (`considered: 0`), so the route-level `/find` proof drives `findTrades` through its override branch. That branch runs the same `findTradesUncached` the cached route calls.

## 9. Nick's five questions

1. **Well built?** It reuses `bestLineup` (the one solver), `horizonWeights` (weeks left) and one wire producer shared with the Waivers page. It is lazy, so the search pays only for returned deals. 11 of 11 mutants were killed (after the M3 test fix), with the designed survivor and not-applied control behaving as designed.
2. **Stats or made up?** No fitted number and no hand-set constant. It is a deterministic lineup solve over our existing projections (`adj_ppg`) and the league's real wire.
3. **How we know:** fixtures only (section 7). There is no backtest in this unit. The R&D's Sleeper 2021-23 measurement (4.6 lineup pts per extra player per week) is why it is worth building. Whether it predicts better than the summed value is RL-8-2b, not run here.
4. **Pointed anywhere else?** Yes. `POST /evaluate` and `GET /find` return it. `waiverBoard()` now reads the lifted wire functions (same behaviour: the `decision-leftovers-waivers` 7/7 regression). Nothing ranks on it yet.
5. **How it unifies:** one lineup number per scale. On any deal with no roster spot changing hands, `lineup_value.per_week === ppg_delta` (M11) and `lineup_value.total === season_delta` (section 10, S2). It is also one wire: `league-wire.js` serves both the Waivers page and the trade engine.

- Gap fixed: `trade-engine.js:1167` `roster_spots` was computed and priced nowhere (origin/main `ca64b2cc`).
- Incumbent: `value_delta` (summed value, `:1141-1142`) and `ppg_delta` (lineup with no spot charge, `:1153`), found with `git grep -n "roster_spots\|value_delta" origin/main -- server/services/trade-engine.js`.
- Not covered: the fairness word, tags, finder gates, ladder bands and TradeCard display.
- What would make it wrong: rosters carrying open spots (overcharged drops), or a wire read from a stale payload.

## 10. Skeptic round 1 fixes (tree `62edd6b7`)

Four blocking findings. All four were right; code changed for each.

**a. `total` multiplied this week across the season.** `adj_ppg` is 0.25 x this week + 0.75 x rest of season, so `per_week x 14` charged a this-week bye 14 times. New producer `lineupSpan(before, after, slots, weeksLeft)` (`server/services/trade-engine.js:1352`): the best-lineup change on `current_week_ppg` counted once, plus `(weeksLeft - 1)` x the change on `ros_ppg` (the same two legs `horizonGain` weighs). A player missing either field falls back to `adj_ppg` (fixtures). `lineup_value.total` now comes from it (`:1329`).
- Skeptic's case as a test (`test/trade-lineup-value.test.js`, "a bye THIS week"): A trades a 9/9 TE for a TE on bye this week (current 0, rate 8, adj 6), week 4, 14 weeks left. `per_week` -3 (= `ppg_delta`), `total` **-22** (by hand: 0 - 9, then 13 x (8 - 9)). Old code gave -42. RED on `58717748` server code: `expected: -22, actual: -42`.

**b/c. Two season-scale lineup numbers on one side object.** `season_delta` was `ppg_delta x GAMES` (17); `lineup_value.total` was `per_week x weeksLeft`. Now `lineupSpan` is the one producer of "lineup points over the rest of the season": `season_delta` (`:1199`, lazy) is `lineupSpan(team.players, after)` whenever the caller passed `lineupValueContext` (the evaluate route and the finder), and `lineup_value.total` is `lineupSpan(team.players, roster-with-spot-charged)`. The two differ only by the roster-spot charge.
- The side also carries `season_delta_weeks` and `season_delta_basis` (`:1203`), the fields `fmtSeasonSpan` (`server/routes/trades.js:311`) already read but that had no producer. With weeks known: basis `weeks_remaining`, weeks 14 at week 4. With no context (ladder, offerFor, older callers): `season_delta` stays `ppg_delta x 17`, basis `full_season_default`, weeks 17, so the explain prompt now says it is a default instead of implying a season.
- Both values on the same input (fixtures, week 4, 14 weeks, command: a one-off node script importing the test fixtures, deleted after), columns `ppg_delta / season_delta / lineup_value.per_week / lineup_value.total`:
  - 1-for-1 A: before -1 / -17 / -1 / -14. Now -1 / **-14** / -1 / -14 (equal, pinned).
  - 2-for-1 A: now -7 / -98 / -7 / -98 (A's drop is its bench WR, no lineup cost). B: 2 / 28 / 9 / 126; the gap of 98 = the wire WR fill, 7/wk x 14.
- `horizonGain` (`trade-horizon.js:129`) is named and not merged: it is a ranking score in this-week points (weights sum to 1, playoff weeks importance-weighted), not a season total. `lineupSpan` uses the same two legs, unweighted.
- Left as-is and named: `client/src/components/TradeCard.tsx:109` still labels `season_delta` "over the season"; with basis `weeks_remaining` that is the rest of the season. Wording belongs to the UI revamp.

**d. Finder test was not live on the roster-spot charge.** The finder fixture gave only 2-for-2 deals. Adding a fourth RB to my team (`test/trade-lineup-value-route.test.js`) makes the finder return 2-for-1s: all 5 returned deals are now 2-for-1, me fills with `Free WR`, them drops `T RB3` (probe on this tree). The test asserts a non-empty uneven set, every freed spot filled from the fixture wire, one drop on the other side, and `weeks === 14` on both sides of every deal.

**e. Drop rule unpinned.** New test "the needed spot costs the least-MISSED player": the only TE (6) starts and is the lowest-rated; the bench RB (8) is dropped and `per_week` is +1.

**Mutation sweep on `62edd6b7`** (scratchpad `mut2.py`, both new test files; each mutant's target count checked = 1):

| Mutant | trade-lineup-value | route | Result |
|---|---|---|---|
| C1 finder passes `wire: []` | 7/7 | 1/2 | killed |
| C2 finder passes no `weeksLeft` | 7/7 | 1/2 | killed |
| U1 drop the lowest-rated player | 6/7 | 2/2 | killed |
| S1 `total = per_week x weeks` | 6/7 | 2/2 | killed |
| S2 `season_delta` back to x17 with weeks known | 5/7 | 2/2 | killed |
| S3 this week counted in every week | 6/7 | 2/2 | killed |
| S4 basis always `weeks_remaining` | 6/7 | 2/2 | killed |

**Tests on `62edd6b7`** (`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<f>.test.js`): trade-lineup-value 7/7, trade-lineup-value-route 2/2, trade-season-span 3/3, find-trades 3/3, trade-engine-correctness 15/15, lineup-surfaces-agree 2/2, wiring-map 90/90, trade-engine-evidence-fault 10/10, fantasy-workflows 7/7, lineup-spread 5/5.
RED commit `02fdb4ad` against `58717748` server code: tests 2, 3, 4 fail (-14 vs -17; -22 vs -42; basis 17 missing); the drop and finder tests pass there and are killed by U1, C1, C2 above.

No DB copy, no real rows, no 2025 rows, no migration, no table written.
