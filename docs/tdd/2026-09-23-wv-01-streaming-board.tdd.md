# WV-01 streaming board: defenses ranked by the opponent's implied team total

Unit WV-01 (plan item B5, Diligence Engine). Branch `claude/local-wv-01-streaming-board`,
cut from `origin/main` at `89f69b3b`.

## 1. Audit: extend or build

What already exists for this surface, on `89f69b3b`:

| piece | where | what it does | reuse? |
|---|---|---|---|
| `game_lines` table | `server/db/schema/core-and-fantasy.js:682` | one row per (season, week, team): spread, total, `implied_points`, `closing_spread`/`closing_total`, `gameday`/`gametime` | read it |
| writers of `game_lines` | `syncHistoricalLinesImpl` `server/services/gamescript.js:55` (nflverse, 1999-present) and `syncCurrentLines` `server/services/gamescript.js:134` (ESPN, current season); the close is frozen by `closeStmt` `server/services/gamescript.js:166`, which only runs before kickoff | | no change |
| reader `linesFor(season, week)` | `server/services/gamescript.js:416` | every line row for a week | **reuse** as the only line reader |
| implied-points formula | `gamescript.js:31` (`total/2 - spread/2`, team perspective) and `offseason-data.js:556` (home perspective, same number) | two copies of one formula that agree by construction | reuse the `implied_points` column; recompute from `closing_*` only when the close is frozen (same formula) |
| kickoff clock | `nflKickoffDate` `server/services/date-util.js`, used by `gameCutoff` `server/services/game-cutoff.js:19` | the one kickoff representation | **reuse** for "locked" |
| waiver board `waiverBoard` | `server/services/waiver-wire.js:152`, route `GET /api/trades/:leagueId/waivers` `server/routes/trades.js:670` | QB/RB/WR/TE only (`SCORED`, `waiver-wire.js:43`); free agents derived by subtraction from the league's ESPN rosters (`rosteredNames`, `waiver-wire.js:133`) | reuse the subtraction rule; D/ST is not in its pool |
| `waiver-brain.js` `freeAgents`/`waiverUpgrades` | `server/services/waiver-brain.js:216,248` | includes DEF in its pool but `bestLineup` scores DEF at 0 by design (`docs/tdd/waiver-kicker-defense.tdd.md`), so no DEF ever ranks | not a ranking of defenses; nothing to unify |
| ESPN pro-team id to code | `PRO_TEAM` `server/services/espn-draft.js:70` (not exported) | | **export and reuse**, no second map |
| any existing D/ST streaming or matchup ranking | `grep -rlni "streaming\|d/st" server/services server/routes client/src` | no producer ranks defenses by matchup | build |

Decision: **build** one service, `server/services/streaming-board.js`, that reuses
`linesFor` for the line, `PRO_TEAM` for the ESPN team code, `nflKickoffDate` for the
lock, and the waiver wire's subtraction rule for free agents. No second implied-total
producer: the service reads `game_lines.implied_points` (or the same formula on the
frozen close). Route `GET /api/waivers/:leagueId/streams` is new; the card goes on the
Start/Sit page (`client/src/pages/Lineup.tsx`) next to the waiver wire. No table, no
column, no migration. Nav untouched.

QB/TE streaming is **not** built in this unit: the study's own skeptic found QB and TE
swaps follow a +7.0-point gap the week before, i.e. they are reactions to last week's
points, not Vegas streams (`rnd/skill/waivers.md:501`). Kicker streaming is not built
(+0.35 per swap, `waivers.md:205`; its by-week interval includes 0, `waivers.md:493`).

## 2. Pre-registration (committed before any number is run)

**Hypothesis.** A streamer who each week holds the free-agent defense whose opponent has
the lowest market implied team total scores more fantasy points in each swap week than
the defense they drop, by an amount consistent with the skill study's +1.94 per DEF
swap-week (`rnd/skill/waivers.md:204`; corrected by-NFL-week interval [1.38, 2.55],
`waivers.md:489`).

**Literature.** Closing NFL lines are close to efficient forecasts of game outcomes:
point spreads are unbiased predictors of margins with residual SD near 14 points
(Stern 1991, *The American Statistician* 45:179), and simple rules rarely beat them
(Gandar, Zuber, O'Brien & Russo 1988, *Journal of Finance* 43:995; Levitt 2004,
*Economic Journal* 114:223). A team's implied total is therefore the best public
forecast of the points a defense will allow, which is one of the largest components of
fantasy D/ST scoring; the study measured +0.446 D/ST points per implied point of edge
(`waivers.md:204`).

**Data.** `game_lines` (local copy, not production) for lines, scores and opponents,
2022-2025, weeks 1-18 (regular season); team defensive counts from nflverse
`stats_team_week` (season_type REG) in the local nflverse mirror
`data/line-history/nflverse.sqlite`, opened read-only. nflverse is CC BY 4.0 and already
attributed in the app (`docs/tdd/nflverse-attribution.tdd.md`); not a new source.

**Scoring.** The study's DEF scoring (`rnd/skill/build_01_points.py:11-12`), so the
number is comparable: sack 1, INT 2, opponent fumble recovery 2, forced fumble 1,
safety 2, blocked kick (FG, punt, PAT) 2, defensive or special-teams TD 6, points allowed
0:10, 1-6:7, 7-13:4, 14-20:1, 21-27:0, 28-34:-1, 35+:-4 (points allowed = opponent's
final score from `game_lines.opp_score`).

**Ranking.** The production function (`rankDefenses` in `streaming-board.js`), run on
each week's `game_lines` rows: opponent implied total ascending; the frozen close when
present, else the stored line. The history check imports that function; it does not
re-implement it.

**Simulation (primary).** One streamer in a 12-team league. Each week the other 11
managers are assumed to hold the K = 10 defenses with the most fantasy points per game
to date (weeks before w of the same season; before week 4, the previous full season) —
the free-agent pool is every defense with a game that week that is not in those 10
(guess: K = 10 is a stand-in for "the good defenses are rostered"). Week 1: hold the
top-ranked free agent. Each later week: X = top-ranked free agent; Y = the defense held
from last week. If X = Y, no swap. If Y has no game (bye), the move is forced and not
counted (the study counts only swaps where the dropped defense also played). Otherwise
a swap-week with gain = points(X, w) - points(Y, w). The streamer then holds X.

**Metric and sign.** Mean gain per swap-week, positive = streaming helped. 95% interval
by a bootstrap over swap-weeks (10,000 draws, seed 1), which is clustering by NFL week
because there is one swap per week.

**Split.** 2022-2024 development, 2025 held-out (one look, recorded in
`docs/evidence/HOLDOUT-LEDGER.md` in the same commit as the result). 2026 forward:
checked where team defensive stats exist.

**Ship rule (the history check passes when all hold, pooled 2022-2025):**
1. point estimate > 0 and the 95% lower bound > 0;
2. the 95% interval overlaps the study's corrected interval [1.38, 2.55]
   ("reproduces within its CI");
3. the 2025 held-out season alone has a positive point estimate (direction only).
If it fails, the board does not ship and the unit is recorded as declined with its
minimum detectable effect at 80% power (2.80 x SE).

**Secondary, reported, not gating.**
- Sensitivity: K = 0 (every defense available) and K = 16.
- Dumb baseline (decision grade): a streamer who instead picks the free agent with the
  most points last week (the study's placebo, "chasing"). Report its per-swap gain and
  the weekly decision win rate of the implied-total pick against the chase pick
  (share of weeks the ranked pick outscores the chase pick; ties half).
- Mechanism: slope of team D/ST points on opponent implied total over every team-week,
  2022-2025, against the study's +0.446 per implied point.
- Comparator 2: gain against holding one drafted defense all season (the 11th-best by
  previous-season points per game).

## 3. RED / GREEN

- Pre-registration: `c5f38e7f` "docs: WV-01 audit and pre-registration for the DEF streaming history check" (before any number).
- RED: `dac6afd1` "test: RED for the WV-01 defense streaming board". `test/streaming-board.test.js` against a stub
  service and no route: 0 pass, 12 fail. Failing assertions, inline:
  - test 1: `assert.deepEqual(order.slice(0, 4), ['DEN', 'NYG', 'SEA', 'HOU'])` — actual `[]`;
  - test 3: `assert.equal(b.position, 'DEF')` — actual `undefined`;
  - test 12: `assert.equal(res.status, 200)` — `404 !== 200` (no route).
- GREEN: `4fa9da8c` "feat: WV-01 defense streaming board service and GET /api/trades/:leagueId/streams": 12 pass, 0 fail
  (`SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test --test-reporter=tap test/streaming-board.test.js`).
- Card: `922ab48f` "feat: WV-01 streaming card on the Start/Sit page" (`tsc --noEmit` clean on that tree).

## 4. What it does

`GET /api/trades/:leagueId/streams` (`server/routes/trades.js`, the `/:leagueId/streams` handler, league membership
checked by the file's `league()` helper) calls `streamingBoard` (`server/services/streaming-board.js`) with the waiver
board's week (`tradeWeekContext`). The service:

1. reads the week's `game_lines` rows through `linesFor` (`gamescript.js:416`) and ranks every defense with a game by
   the opponent's implied total, lowest first (`rankDefenses`); the frozen close when stored, else the stored line;
   a game past kickoff (`nflKickoffDate`) is marked locked;
2. finds free-agent defenses by subtraction: all ranked teams minus every D/ST (ESPN `defaultPositionId` 16, team from
   `PRO_TEAM`, now exported from `espn-draft.js:70`) on any roster in the league; locked games are not offered;
3. shows the top 5 with `edge` = my defense's opponent implied minus the candidate's (positive = easier matchup);
4. suggests one move: `swap` (drop my unlocked defense, bye first, else worst matchup) when the best edge is at least
   `MIN_EDGE` = 1 implied point (guess, see the constant's note) or my defense is on bye; `hold` otherwise; `add` only
   with no defense, an open roster spot (roster size = every ESPN slot but IR) and room under the D/ST position limit;
   no move when my defense has already kicked off. The card links to ESPN's free-agent page for the league (the app
   cannot make the add itself; "tap to apply" waits on Nick's N12).

The card sits under the waiver wire on the Start/Sit page (`client/src/pages/Lineup.tsx`). Nav untouched (8). No
table, column or migration.

Liveness on the local copy (not production), week 3 of 2026, `now` = 2026-09-23 12:00Z (scratch script, league rows
only, no names): all five leagues return 21-24 free-agent defenses, 5 candidates, one held defense and a `swap`
suggestion with edges 2.75, 2, 7, 3 and 7.5 implied points.

One number: `game_lines.implied_points` and the frozen-close recomputation agree on all 96 rows of 2026 weeks 2-4
where a close is stored (0 disagreements; `sqlite3 .local-db/data.sqlite "select week, count(*), sum(closing_spread is
not null and closing_total is not null), sum(abs(implied_points - (closing_total/2.0 - closing_spread/2.0)) > 0.001)
from game_lines where season=2026 and week<=4 group by week"`). Week 1 has no stored close and uses `implied_points`.

## 5. The history check (local copy, not production)

Command, run on tree `4fa9da8c` plus the uncommitted script (the service file is byte-identical to `4fa9da8c`):

```
GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite GRIDIRON_DB_INTEGRITY_CHECK=off SCHEDULER_DISABLED=1 \
  node docs/evidence/streaming-def-history.mjs \
  --nflverse /Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite
```

Known-nonzero control first: 2,750 DEF team-weeks scored (2022: 542, mean 7.21 points a game; 2023: 544, 7.69;
2024: 544, 6.79; 2025: 544, 6.61). Skipped: 480 `game_lines` rows with no final score (unplayed 2026 weeks), 32
with no nflverse counts (2026 week 2, which nflverse does not have yet).

**Primary, K = 10 (pre-registered):**

| season | swap-weeks | gain per swap | 95% interval |
|---|---|---|---|
| 2022 | 14 | +2.00 | [-1.29, +5.00] |
| 2023 | 15 | +3.20 | [-0.60, +6.87] |
| 2024 | 14 | +3.07 | [-1.29, +7.07] |
| 2025 (held out) | 14 | +3.14 | [-0.50, +7.00] |
| **pooled 2022-2025** | **57** | **+2.86** | **[+0.93, +4.75]**, SE 0.97, MDE80 2.72 |
| dev 2022-2024 | 43 | +2.77 | [+0.56, +4.88] |

**Ship rule: PASS.** Lower bound > 0 (+0.93); the interval overlaps the study's [1.38, 2.55] (and contains the study's
+1.94); 2025 alone is positive (+3.14, direction only; its own interval includes 0, MDE80 5.63).

Secondary (reported, not gating):

| check | result |
|---|---|
| sensitivity K = 0 | +2.56 [+0.44, +4.63], 62 swaps |
| sensitivity K = 16 | +2.64 [+0.93, +4.36], 58 swaps |
| dumb baseline: chase last week's points (K = 10) | -0.48 [-2.49, +1.61], 61 swaps (the study's placebo was also ~0) |
| **decision win rate**, implied-total pick vs chase pick, same pool, K = 10 | **67.4% of 72 weeks** (K = 0: 61.8%; K = 16: 66.0%) |
| mean implied-point edge per swap (K = 10) | +5.66 |
| vs holding one drafted defense all season (K = 10) | +2.55 [+0.71, +4.40], 65 weeks |
| mechanism: D/ST points per implied point lower for the opponent, 2,174 team-weeks, bootstrap by 72 NFL weeks | +0.45 [+0.38, +0.52] (study +0.446, [0.345, 0.554]) |

Our point estimate (+2.86) sits above the study's +1.94. A likely reason (guess): the study averages real managers'
swaps, 12.7% of which went against the matchup, while this streamer always takes the top-ranked defense (mean edge
+5.66; the study's implied mean edge is about (1.94 + 0.11) / 0.453 = 4.5). At +0.45 per implied point, 1.2 more
points of edge is about 0.5 more points per swap.

MAE does not apply: the board makes no points projection. The decision grade is the win rate above.

**Forward 2026:** not checked. nflverse `stats_team_week` holds 2026 week 1 only, so no swap-week (two consecutive
scored weeks) exists: 0 computable. The card says "Not yet checked on 2026 games."

## 6. Mutation test

`test/streaming-board.test.js`, each mutant applied alone and reverted (scratch runner):

| mutant | result |
|---|---|
| M1 rank descending (`rankDefenses` sort) | killed, 5 tests fail |
| M2 ignore the frozen close | killed, 2 |
| M3 offer defenses already locked | killed, 4 |
| M4 offer defenses rostered by others | killed, 4 |
| M5 IR slot counts as a roster spot | killed, 1 |
| M6 edge sign flipped | killed, 4 |
| M7 **designed survivor**: `best.edge >= MIN_EDGE` to `>` | survived (no fixture sits exactly at 1.0 implied point) |
| M8 call site: route passes `week + 1` | killed, 1 (route test) |
| M9 call site: route passes a clock after every kickoff | killed, 1 (route test) |
| C0 **not-applied control** (pattern absent, file unchanged) | 0 fail, as it must |

History-script liveness: with M1 applied, the same command returns pooled -2.82 [-5.07, -0.69]; so the check runs
the production ranker, not a copy.

## 7. Known defects

1. K = 10 ("the ten best defenses to date are rostered elsewhere") is a stand-in for real league rosters, which we do
   not hold for 2022-2025 (`league_roster_history` has 18-26 rows a season). Sensitivities K = 0 and 16 agree.
2. Scoring is the study's (Sleeper-style, no yards-allowed tiers), for comparability. The five leagues are ESPN;
   ESPN's default D/ST scoring adds yards-allowed tiers, so the gain in ESPN points is not measured here.
3. One swap per week gives a wide interval (MDE80 2.72 pooled); 2025 alone cannot confirm anything by itself.
4. Forward 2026 is unconfirmed (section 5).
5. QB/TE streaming is not built (section 1). Kickers are not streamed.
6. `docs/wiring/wiring-map.json` was not regenerated; `node scripts/wiring-map.mjs --check` exits 0 on this branch.

## 8. Holdout looks

Two rows appended to `docs/evidence/HOLDOUT-LEDGER.md` (L154, L155) in the commit that records these numbers, and one
forward look (F001, 0 swap-weeks computable).

## 9. Nick's five questions

1. **Well built?** One service, one route on the existing trades router, one card; 12 targeted tests, 9 of 9 real
   mutants killed, designed survivor and control behave. No migration, nav still 8.
2. **Stats or made up?** The ranking is the betting market's own number from `game_lines`. The history numbers come from
   the command in section 5 on a local copy. `MIN_EDGE` = 1 and K = 10 are choices (guess), stated as such.
3. **How we know?** Pre-registered rule, committed first; passed: +2.86 per swap [+0.93, +4.75] on 2022-2025, inside
   the study's interval; the chase baseline gains nothing; the implied pick beats it in 67.4% of weeks.
4. **Pointed elsewhere?** Reuses `linesFor`, the stored `implied_points`, the frozen close, `nflKickoffDate`,
   `PRO_TEAM` and the waiver wire's subtraction rule; no second implied-total producer.
5. **How it unifies?** Same week and league as the waiver board, on the same page; SK-01's weekly command center can
   read the same route for its "streaming swap" line.
