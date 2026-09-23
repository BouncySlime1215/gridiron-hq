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
