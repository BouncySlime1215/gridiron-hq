# GF01 — GitHub drive/game simulator harvest (bucket: fix)

Task: find real open-source NFL/football drive or game simulators and extract exactly
how they handle the 6 things `server/services/nfl-drive-sim.js` gets wrong: turnover
field position, clock units, kneel/timeout logic, home-field advantage, and overtime.

Grounded first in the actual defective code (read-only), then in 6 external repos.

## The defects, pinned to exact lines (fantasy-football-dashboard is read-only; verified, not edited)

- `server/services/nfl-drive-sim.js:345` — on interception/fumble the return is
  `endYard: clamp(yard, 1, 99)` (yard NOT flipped). Compare the same file's own punt
  path two blocks later, `nfl-drive-sim.js:393` — `endYard: clamp(100 - Math.min(yard + net, 99), 1, 99)`
  — and its turnover-on-downs path, `nfl-drive-sim.js:402` — `endYard: clamp(100 - yard, 1, 99)`.
  Two of the three drive-ending turnover types flip the field to the new offense's frame;
  interceptions/fumbles do not. A turnover at the opponent's 20 (yard=80) hands the new
  offense endYard=80 — great field position for the team that just lost the ball — instead
  of the correct ~20.
- `server/services/nfl-drive-sim.js:460` — `let clock = HALF` where `HALF = 1800` (line 48,
  half-clock seconds, 0–1800) is what regulation drives are simulated against; `otClock = 600`
  (line 542) for OT. Various policy calls (`P.fourthDownByWinProbability`, `P.kneelDecision`,
  `P.timeoutPolicy`, `P.twoMinuteWarning`) receive `secondsLeft: clock` — a half-scoped number —
  through the same call shape used elsewhere in the file for what reads like full-game-clock
  semantics (e.g. the season-remainder path at line 799, `let clock = Math.max(0, s.secondsLeft ?? 900)`,
  and the `driveClockState` computation at 517-518 that takes `half` + `halfSeconds` together as
  two separate concepts). The mismatch is exactly what the task brief describes: some policy
  logic written to reason about "two minutes left in the game" is actually being fed "two minutes
  left in the half" without the half number attached.
- `server/services/nfl-drive-sim.js:562` — `if (homeFieldPoints > 0 && random() < homeFieldPoints / 7) home += 7;`
  runs immediately after the OT loop (`home === away` check starting line 541), i.e. HFA is
  applied as a Bernoulli(homeFieldPoints/7) draw of a full +7 to the already-decided final score,
  OT included. This creates a spike of games whose margin jumps by exactly 7 — landing squarely
  on the single most important NFL key number — instead of a smooth, pregame effect on the
  scoring process.
- Kneel/timeout: `kneelDecision({ lead, secondsLeft, timeouts: oppTimeouts, yard, isHalfEnd })`
  (line 265) is fed `oppTimeouts` under the `timeouts` param name; `timeouts.home = 3; timeouts.away = 3`
  (line 461) is reset every half but nothing in `simulateDrive` decrements a timeout counter when
  `P.timeoutPolicy` returns "spend" — the `timeouts` object passed into `simulateDrive` is read,
  never written back to the outer `timeouts` map.

## External repos read (cloned to `.../research2/github/`, blob:none depth-1)

### 1. rtelmore/NFLSimulatoR — turnover field-position flip
- **License**: MIT (Ryan Elmore & Ben Williams, 2020). **Stars**: 19. **Last commit**: 2022-08-19.
- **What it is**: a real CRAN-adjacent R package (has a JOSS-style `paper.md`, vignettes, `R CMD check`
  CI) for resampling actual play-by-play into simulated drives/possessions. Not a toy script.
- **What the code actually does**: `down_distance_updater()` (`R/down_distance_updater.R`) samples
  a real historical play matching the current (down, distance, yards-from-own-goal) state and
  returns `new_yfog` **in the possessing team's own frame** (yards from *their* own goal,
  `R/down_distance_updater.R:79`: `new_yfog <- min(99, yards_from_own_goal + yards_gained)`).
  The frame flip happens exactly once, at the drive boundary, in the caller:
  `R/sample_drives.R:82` — `new_yfog <- 100 - new_yfog` — fired whenever `end_of_drive` is true
  (turnover, turnover-on-downs, score, or safety; see `end_drive` logic in
  `down_distance_updater.R:90-93`). One flip, one place, applied uniformly to every drive-ending
  event — there is no separate "turnover path" that can drift out of sync with the "punt path."
- **Adopt**: **borrow-idea** (R, would need porting to JS, but the pattern is language-agnostic).
  Gridiron attachment point: `nfl-drive-sim.js`'s turnover branch (line 345) should call the exact
  same flip helper the punt (393) and turnover-on-downs (402) branches already use, rather than
  duplicating `100 - yard` arithmetic three times with one copy missing it. Concretely: extract a
  `flipToNewOffense(yard)` function and call it from every drive-ending branch — interception,
  fumble, punt, turnover-on-downs, safety (kickoff-equivalent) — so the fix can't regress by having
  a fourth branch added later that forgets the flip.
- **Cost**: hours (it's an 8-line change once the extraction is done). **Expected value**: closes a
  correctness bug that literally reverses field position on a subset of turnovers — this alone can
  bias projected margins/win probabilities on any drive following an INT or fumble, and interceptions
  are the plurality of live turnovers in the model (fumbles are rarer). **Exit test**: force a
  deterministic interception at a fixed yard line in a unit test; assert the next drive's starting
  field position is `100 - yard`, matching the punt/turnover-on-downs branches' own convention.

### 2. traskcon/Monte-carlo-NFL — turnover FP flip + possession swap as one atomic operation
- **License**: none declared (all-rights-reserved by default — treat as reference-only, do not
  copy code verbatim). **Stars**: 3. **Last commit**: 2025-09-11.
- **What it is**: a from-scratch Python Monte Carlo NFL game simulator built on nflverse player-level
  rate stats (completion %, INT rate by QB and by defense, punt distributions per punter, etc.),
  with a Streamlit app (`app.py`) and documented runtime/parallelism numbers in the README. Its own
  README lists real, honest limitations ("Static game length... no game clock... Lacks ability to
  adjust based on game clock"), i.e. the author explicitly chose not to build the thing Gridiron's
  sim gets wrong, rather than building it incorrectly.
- **What the code actually does**: `monte_carlo.py:243-247`:
  ```
  def __turnover(self, downs:int, score:bool):
      self.__down = 1 if downs else 0
      self.__distance = 10
      self.__yardline = 65 if score else 100 - self.__yardline
      self.__pos_team, self.__def_team = self.__def_team, self.__pos_team
  ```
  Field-position flip and possession swap are two statements inside the *same* method, called from
  every turnover site (interception at `monte_carlo.py:197-198`, fumble/turnover-on-downs at
  `:369-370` and `:386-387`). There is structurally no way to flip possession without also flipping
  field position, or vice versa, because a single function owns both.
- **Adopt**: **borrow-idea** (same reasoning: no license to port code from, but the design pattern —
  couple the two state mutations in one call — is free to imitate). Gridiron attachment point: same
  as #1, but the specific lesson here is *pair* the possession swap and the FP flip in one function
  rather than trusting three call sites to both remember to do both things. `nfl-drive-sim.js`
  currently does the FP flip inconsistently (missing on interception/fumble) and the possession
  swap separately in the outer game loop (line 535/824) — the two operations are in different
  files/scopes, which is exactly the kind of split that let the interception bug happen unnoticed.
- **Cost**: hours. **Expected value**: same defect as #1, reference for the *pattern* to prevent
  recurrence, not just to patch the one call site. **Exit test**: same as #1, plus a regression test
  asserting `possession` and `endYard`'s frame change together — never one without the other — for
  every one of the five drive-ending event types.

### 3. nishs9/nfl-simulation-engine — clock units (game vs. quarter) kept as two tracked variables, explicit halftime handler
- **License**: MIT. **Stars**: 0 (early-stage, but has a `test_game_simulator.py` test suite and a
  written `implementation-details.md` design doc — read for what it does, not stars).
  **Last commit**: 2026-02-11.
- **What it is**: a Flask + React app; the simulation core is `backend/src/GameEngine.py` +
  `GameModels.py`. Multiple "game models" (prototype, V1, V1a) share one `GameEngine` state machine.
- **What the code actually does — clock**: `GameEngine.py:15-17` initializes
  `"game_seconds_remaining": 3600, "quarter_seconds_remaining": 900` as two separate, always-present
  fields. Every play decrements *both* by the same `time_elapsed` (`GameEngine.py:41-42`):
  `self.game_state["quarter_seconds_remaining"] -= play_result["time_elapsed"]` /
  `self.game_state["game_seconds_remaining"] -= play_result["time_elapsed"]`. Quarter transitions
  (`:78-80`) and halftime (`:82-83`, dispatching to a dedicated `handle_halftime()` at `:120-124`)
  reset only `quarter_seconds_remaining` to 900, never touching `game_seconds_remaining`'s running
  total — so any policy that needs "seconds left in the game" and any policy that needs "seconds
  left in this quarter/half" each get an unambiguous, correctly-scoped number, and neither can be
  fed the other's value by accident.
- **What the code actually does — turnover/punt/FG**: `simulate_turnover()` (`:89-93`),
  `simulate_punt()` (`:95-102`), `simulate_field_goal()` (`:104-110`) each call `switch_possession()`
  (`:112-118`) and then set `self.game_state["yardline"] = 100 - self.game_state["yardline"]`
  (or a fixed reset for touchbacks/kickoffs) — same coupled-mutation pattern as repo #2, independently
  arrived at.
- **What's missing (be honest)**: `GameEngine.py:85-87` — when Q4's clock hits zero, the engine just
  returns `True` (game over). There is no overtime in this engine at all. This is useful negative
  evidence: of the 6 repos reviewed, none actually implements a correct OT drive loop — it is a
  genuinely under-built corner of the open-source ecosystem, not just of Gridiron's model. See
  "do_not_do" below.
- **Adopt**: **borrow-idea** for the two-clock-variable pattern; **reference-only** for the rest
  (small, unstarred, not a code base to depend on). Gridiron attachment point: in
  `nfl-drive-sim.js`, replace the single `clock` local (half-scoped, 0–1800) that gets threaded into
  `P.kneelDecision`/`P.timeoutPolicy`/`P.twoMinuteWarning`/`P.fourthDownByWinProbability` with an
  explicit pair — `halfSecondsRemaining` and `gameSecondsRemaining` — computed once per play
  (`gameSecondsRemaining = (2 - half) * HALF + halfSecondsRemaining` given `HALF = 1800`) and pass
  whichever one each policy function actually needs, renaming the params so it's impossible to
  silently swap them again. `driveClockState()` (line 70-ish) already computes something adjacent
  to this for logging — the fix is to promote that same "which clock am I" bookkeeping to feed the
  policy calls, not just the log.
- **Cost**: days (touches every `P.*Decision` call site and their signatures). **Expected value**:
  fixes end-game behavior broadly — two-minute-warning timing, timeout policy, kneel decisions, and
  fourth-down aggression near halftime are all currently at risk of using the wrong clock scope,
  which is a plausible contributor to unrealistic garbage-time and end-of-half drive outcomes.
  **Exit test**: unit tests that fix `half=2, halfSecondsRemaining=90` (1:30 left in the game) vs.
  `half=1, halfSecondsRemaining=90` (1:30 left in the *half*, 31:30 left in the game) and assert the
  two-minute-warning and kneel-decision policies fire only in the former.

### 4. fivethirtyeight/nfl-elo-game — home-field advantage as a pregame probability shift, gated by a neutral-site flag
- **License**: MIT. **Stars**: 348. **Last commit**: 2023-05-02 (dormant but this is the canonical,
  widely-cited FiveThirtyEight NFL Elo model source, not a hobbyist repo).
- **What it is**: the actual code behind FiveThirtyEight's published NFL Elo ratings/forecasts —
  Elo update + win-probability forecasting over `data/nfl_games.csv`, `data/initial_elos.csv`.
- **What the code actually does**: `forecast.py:6` — `HFA = 65.0` (a fixed Elo-point value, not a
  score-point value); `forecast.py:39` —
  `elo_diff = team1['elo'] - team2['elo'] + (0 if game['neutral'] == 1 else HFA)`. HFA is added to
  the *rating difference that produces the win probability*, once, before the game is scored, and is
  explicitly zeroed for `neutral == 1` games (Super Bowls, London/international games). It never
  touches the game's outcome or score after the fact — it's baked into the probability the model
  uses to update Elo, and margin-of-victory (the `pd`/`mult` block at `forecast.py:47-49`) is a
  completely separate multiplier applied only to the post-game rating update, never to a
  hypothetical "add points to the winner" step.
- **Adopt**: **borrow-idea** (this repo doesn't do drive simulation, so there's no code to port
  directly — the pattern to take is architectural). Gridiron attachment point:
  `nfl-drive-sim.js:562`'s `if (random() < homeFieldPoints/7) home += 7` should become a pregame
  adjustment to whatever proxy for "expected scoring rate" or "win probability" seeds `simulateGame`
  — e.g. folding `homeFieldPoints` into the same `spread`/`lead` inputs that already drive
  `fourthDownByWinProbability` and the offense/defense context, and applying it before any play is
  simulated (or better, distributing it as a small continuous bump to points-per-drive expectation
  rather than a one-shot 7-point coin flip) — and skip it entirely for known neutral-site games (the
  file already threads a `spread` parameter end-to-end; a `neutral: boolean` flag can travel the
  same path). The `nfl-drive-sim.js` header comment at line 10-11 already lists "the game clock,
  timeouts... overtime" as modeled — HFA should get the same treatment, an input to the simulation,
  not a patch to its output.
- **Cost**: hours (the call-site change) to days (if bumping per-drive scoring, since it touches
  `simulateDrive`'s context object). **Expected value**: removes an artificial spike at the 7-point
  margin, which directly matters for anything downstream that grades or bets against real spreads
  and totals near common key numbers (3, 7, 10). **Exit test**: histogram simulated home-away
  margins with `homeFieldPoints` on; confirm no anomalous spike exactly at +7 relative to the
  smooth density elsewhere (a Kolmogorov-Smirnov-style local-spike check, or simplest: compare the
  count of margins in `[6.5, 7.5]` against a linear interpolation of its neighboring 1-point bins).

### 5. greerreNFL/nfelohfa — dynamic, per-game HFA estimation instead of a constant
- **License**: none declared in-repo (treat as reference-only; do not copy code). **Stars**: 1
  (very small, but built by `greerreNFL`, the same author group behind the well-known `nfelo`
  ratings system — 56 stars, actively pushed same day as this harvest — so this is production
  infrastructure for a real, maintained project, not a student exercise). **Last commit**: 2026-09-12
  (today).
- **What it is**: a standalone Python package whose entire purpose is estimating time-varying,
  team/game-specific home-field advantage from real results, to feed into the `nfelo` rating system.
- **What the code actually does**: `nfelohfa/Model/BaseHFA.py` computes, for every (season, week),
  a rolling OLS regression of `home_margin_error` (`= result - expected_result_from_ratings`,
  `BaseHFA.py:64-67`) over a trailing window (`reg_weeks`), extrapolates the current week's expected
  HFA from that regression, and smooths it through an EMA (`BaseHFA.py:75-136`) — i.e. HFA is a
  *level that drifts over a season*, not a constant, and is only ever fit from `location != 'Neutral'`
  games (`BaseHFA.py:72`, in `prep_games()`), with the COVID no-fan 2020 season explicitly excluded
  as an outlier (`BaseHFA.py:70`). `Model/AdjustedHFA.py:15-49` layers per-game feature adjustments
  (e.g. travel, rest — see `Features` import) on top of that base value, and — critically —
  explicitly re-zeroes the base component for neutral-site games while keeping only the
  feature-based part (`AdjustedHFA.py:34-46`: `hfa_adj = hfa_adj - hfa_base` and `hfa_base = 0` when
  `location == 'Neutral'`).
- **Adopt**: **borrow-idea**, possibly **reference-only** given the missing license. Gridiron
  attachment point: `nfl-drive-sim.js` currently takes `homeFieldPoints` as a single caller-supplied
  constant (`1.6` at every one of its three call sites — 994, 1078, 1201 — never varied by team,
  travel, rest, or week). Even without adopting the regression machinery, the fix this repo argues
  for is cheap: stop hard-coding `1.6` in three places and route it through one function that at
  minimum knows about `neutral` sites (return 0) and, if `server/services/nfl-team-strength.js`
  or another Gridiron table already has travel/rest/rating data, can vary the value per matchup
  instead of a single system-wide magic number.
- **Cost**: hours (neutral-site gating) to days (a real trailing-regression HFA estimator per the
  full pattern). **Expected value**: moderate on its own, but directly upstream of the fix in #4 —
  fixing *how* HFA is applied (pregame, not post-hoc) without also fixing *what value* it uses just
  trades one wrong constant for another. **Exit test**: confirm `homeFieldPoints` is 0 for any
  game flagged neutral-site in the Gridiron schedule table (Super Bowls, London/Germany/Brazil
  games), and non-constant across at least two teams/weeks if the full estimator is adopted.

### 6. nflverse/nfl4th — timeouts as first-class, decrementing win-probability state (not a static context field)
- **License**: MIT (`LICENSE.md`, Ben Baldwin 2021 — this is nflverse's real, maintained 4th-down
  decision-making package, built on top of nflfastR's win-probability model). **Stars**: 22.
  **Last commit**: 2026-09-01.
- **What it is**: not a play-by-play drive simulator itself — it's the production win-probability
  model that nflfastR/nflverse expose for exactly the kind of end-game decision logic Gridiron's
  `P.kneelDecision`/`P.timeoutPolicy` are trying to approximate.
- **What the code actually does**: `R/apply_win_prob.R:74-83` derives
  `posteam_timeouts_remaining`/`defteam_timeouts_remaining` from `home_timeouts_remaining`/
  `away_timeouts_remaining` for every play fed into the WP model — i.e. timeouts remaining is
  treated as required, per-play, per-side model input on par with score, yard line, and time
  remaining, not a value set once and read passively. The model literally cannot produce a
  win-probability estimate without a live, correctly-decrementing timeout count for both sides.
- **Adopt**: **reference-only** (an R package around a fitted xgboost model — not something to
  port; the value is confirming timeouts belong in the state machine, not just in the log).
  Gridiron attachment point: `nfl-drive-sim.js:265`'s `kneelDecision({ ..., timeouts: oppTimeouts, ... })`
  and the outer `timeouts = { home: 3, away: 3 }` map (line 453, reset per half at 461) needs a
  write path — right now `simulateDrive` receives a `timeouts` number by value and nothing in its
  return object reports "a timeout was spent," so the outer loop's `timeouts.home`/`timeouts.away`
  never change during a half. Add `timeoutsSpent` to `simulateDrive`'s return and decrement the
  outer map from it, mirroring how nfl4th treats `posteam_timeouts_remaining` as data that must
  flow forward play-to-play.
- **Cost**: hours. **Expected value**: fixes the specific "timeouts never decrement... leading team
  burns an entire half" defect named in the brief — this is close to a one-function fix once the
  return-value wiring is added. **Exit test**: force `P.timeoutPolicy` to return "spend" three times
  in a half for the trailing team; assert the fourth attempted spend is rejected/no-ops because
  `timeouts[team] === 0`, and that clock-management behavior (spikes, sideline throws) changes once
  timeouts are exhausted.

## Repos considered and rejected (grep'd, not written up)
- `GallagherAiden/footballSimulationEngine` (177★, MIT, JS) — the most-starred hit for "football
  simulation engine," but it's an association-football (soccer) ball-physics engine
  (`README.md`: "simulation of football (soccer) matches... jumping, handball, gravity, friction").
  Not applicable to NFL drive logic.
- `dlm1223/nfl-simulation` (5★, no license file found, R) — real drive-resampling code, but its
  entire strategy for the clock/kneel problem is to **exclude** it: the training sample is filtered
  to `>=2 min before halftime` and `>=5 min before end of game` within one-score games (README,
  "Methodology" section), i.e. garbage-time/kneel-down snaps are dropped from the sample rather than
  modeled. Worth noting as an alternative philosophy (avoid the hard cases instead of getting them
  wrong) but not a source of a correct kneel/clock implementation to copy.
- `RobbyGillespie/Optimal-NFL-Play-Simulator` (3★, no license, Python) — resamples real outcomes by
  situational EPA, but has no clock, no kneel logic, and no OT (confirmed via grep: zero hits for
  "kneel"/"overtime"/"timeout" across the repo).
- `nishs9/nfl-simulation-engine-lite`, `nflverse/nflseedR` — checked for OT/tiebreaker logic;
  `nflseedR` simulates season standings from game-level results (not drives) and has no OT-specific
  code to extract; not written up as a numbered candidate but consulted as negative evidence that
  even nflverse's own season simulator doesn't model OT drives, it just consumes final scores.

## What this harvest could NOT find
No repo among those reviewed — including the two most credible ones (nflverse/nfl4th's WP model and
fivethirtyeight's Elo model) — implements a genuinely correct **overtime drive simulation** (sudden
death vs. modified-sudden-death rules, both-teams-possess logic, second-OT tie rules). This appears
to be a real gap in the open-source ecosystem, not just a Gridiron shortcoming: OT is rare enough
(~9-10% of games) and rule-fiddly enough (regular season vs. playoff differ) that hobbyist repos
either skip it (nishs9, traskcon) or never reach drive-level granularity at all (fivethirtyeight,
nflseedR, nfl4th). Recommendation for Gridiron: since `nfl-drive-sim.js` already has *an* OT loop
(lines 541-557, sudden-death-ish with an 8-drive cap), the highest-leverage fix is not "find a
better OT simulator to copy" but "stop double-counting HFA into it" (candidate #4) and validate the
existing OT loop's possession-alternation and win-condition against the actual current NFL OT rule
text directly, since no open-source reference implementation exists to compare against.
