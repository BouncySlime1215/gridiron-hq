# LS-01 pre-registration: do benched-with-intact-usage players outscore what their manager later accepts in trades?

Written and committed before any outcome number was computed. Only row counts of
the input tables (how many snapshot rows, how many trades) were looked at before
this commit. Any change after this commit is a dated deviation below, never an
edit of the text above it.

## Question

When a manager benches a player he had been starting while that player's NFL
usage holds (benched-with-intact-usage, "BWIU"), does that player outscore what
the same manager accepts in his next trade, over the following four weeks? If yes,
BWIU is a buy-low read on that manager: he values the player below what the field
says. If no, the Trade Brain still shows the lineup fact, but its "buy low" reading
stays labelled a guess.

## Literature (why the effect might exist)

Owners overvalue what they hold and anchor on recent results: the endowment effect
(Kahneman, Knetsch and Thaler 1990, *J. Political Economy* 98:1325) and the
disposition to sell what recently disappointed (Shefrin and Statman 1985,
*J. Finance* 40:777). Both predict that a player his own manager has just stopped
starting is priced below his usage, which is the gap this test looks for. People
also over-read short streaks (Gilovich, Vallone and Tversky 1985, *Cognitive
Psychology* 17:295), so a benching after one or two poor weeks is the case where the
market-implied role and the manager's view should diverge most.

## Data

- Lineups and trades: the Sleeper corpus the skill study was built from,
  `data/derived/sleeper_history.sqlite` (read-only, `immutable=1`), tables
  `sh_team_weeks` (starters_json, players_json per team-week) and
  `sh_transactions` (type `trade`, status `complete`; adds_json/drops_json map
  player -> roster). `rnd/skill/team_seasons.sqlite` holds team-level aggregates
  only (no per-player start/bench and no usage), so it cannot identify a BWIU
  player; the study reads the raw corpus it was assembled from. Deviation from
  the unit text, recorded here before any number.
- Weekly points: `rnd/skill/cache/points.pkl` field `base` (nflverse PPR, built by
  `rnd/skill/build_01_points.py`), with its `played` flag.
- Usage: snap share `player_week_snaps.offense_pct` (writer `syncSnapCounts`,
  `server/services/nflverse.js:287`, INSERT at :300) in a local copy of the app database (not
  production), joined Sleeper id -> gsis (`points.pkl` `gsis_of`) -> `players.gsis_id`.
  Route share is not stored anywhere in the app, so usage means snap share only.
- Seasons 2021-2025, regular season weeks 1-18. Positions QB, RB, WR, TE.
- Nothing committed names a league, a manager or a player: aggregates only.

## Definitions (the same rule the product code `server/services/lineup-signals.js` uses)

- Starter in week w: listed in the team-week's starters.
- BWIU event (manager M, player P, week w): P is on M's roster in week w and not a
  starter; in the last three weeks before w in which P was on M's roster (at least
  two such weeks), M started P in at least two; P's snap share in week w is at
  least 0.90 x his mean snap share over those started weeks, that mean is at least
  0.40, and P played in week w (snap share present and > 0).
- Control event (started-and-kept, "SK"): same history rule, but M started P again
  in week w and P played.
- Trade pairing: for each event, M's first completed trade with leg week t,
  w < t <= w + 4, in which M receives at least one QB/RB/WR/TE. One pair per event.
- Outcome window: NFL weeks t+1 .. t+4 (strictly after the trade week), capped at 18.
- PPG(x) = mean `base` points over the window weeks in which x played. A player
  with no played week in the window drops out; a pair whose P drops out, or all of
  whose received skill players drop out, is excluded.
- D = PPG(P) - mean over received skill players of PPG(received). Sign
  convention: **positive D means the benched player outscored what his manager
  accepted.**

## Hypotheses, metric, split

- H1 (primary): mean D over BWIU pairs > 0.
- H2 (secondary): mean D(BWIU) - mean D(SK) > 0 (BWIU players are undervalued more
  than the players the same managers keep starting).
- Estimate: mean D, 95% interval from a cluster bootstrap over leagues (2,000
  resamples, seed 20260923). MDE at 80% power, two-sided alpha 0.05: 2.80 x the
  bootstrap standard error.
- Decision grade: share of BWIU pairs with D > 0 (win rate) against the dumb
  baseline of a fair trade, 50%.
- Discovery seasons 2021-2024. Held-out season 2025, looked at once, after the
  discovery result is written; the look is recorded in
  `docs/evidence/HOLDOUT-LEDGER.md`.
- Forward holdout: none. The Sleeper corpus has no 2026 season and the app's ESPN
  snapshots have two final weeks (no BWIU event can exist before week 3 final).

## Ship rule

The BWIU "buy low" reading is served as measured only if H1's 95% interval lower
bound is above 0 on 2021-2024 **and** the 2025 estimate is positive with its 95%
lower bound above 0. Even then it ships labelled "unconfirmed forward" (no 2026
data). Otherwise every lineup signal is served with `inference: "guess"`. The
detection itself (the lineup fact: he benched a player whose snaps held) is shown
either way; only the reading of it is gated.

## Deviations

(none yet)
