# F01 — Drive-sim mechanics: correct state encoding & transitions

Researcher: F01-drive-sim-mechanics (bucket: fix). Topic: how real drive-level NFL simulators
correctly encode turnover field position, a single canonical clock unit, kneel/timeout
accounting, home/away win-probability sign convention, continuous home-field advantage, and
halftime/overtime — used to ground a rewrite plan for `nfl-drive-sim.js`'s 6 broken mechanics.

## 0. Ground truth: exact defect locations in Gridiron today

Read in full (not from memory): `server/services/nfl-drive-sim.js` (1280 lines) and
`server/services/nfl-sim-policy.js`, plus `server/services/nfl-live.js`. HARD RULE respected:
read-only, no edits, no execution, no DB/process touched.

1. **Turnover field position handed to the wrong team.**
   `nfl-drive-sim.js:345-346` — on a turnover, `endYard: clamp(yard, 1, 99)` is returned as-is
   (offense-relative). `nfl-drive-sim.js:536` and `:825` then do
   `yard = (d.points > 0 || d.kneel) ? 25 : clamp(d.endYard, 1, 99);` — the **same** number is
   handed to the new possessing team with no mirror. Since field position 0-100 is a single
   physical line (0 = your own goal, 100 = opponent's), a turnover at offense-yard 70 should hand
   the new offense the spot `100 - 70 = 30` from *their* perspective. Gridiron gives them 70 —
   they inherit a spot 40 yards better than reality on every turnover, systematically biasing the
   simulator toward the outcome ("field flip" value) that generated the turnover.

2. **Half-seconds fed to full-game formulas.**
   `nfl-drive-sim.js:48` sets `const HALF = 1800;` (30-minute half, correct) and `secondsLeft`
   throughout the engine is scoped to *one half* (max 1800). But `nfl-sim-policy.js:214` and
   `:415` compute `urgency = clamp(1 - secondsLeft / 3600, 0, 1)` — dividing a half-scoped clock
   by a full-game denominator. At the opening kickoff of a half (`secondsLeft = 1800`), urgency
   is already `0.5` instead of `0`; two-point/pass-rate/variance policies are silently primed for
   "already halfway through the game" from the opening whistle of *every* half.

3. **Kneel/timeout accounting: both wrong, compounding.**
   - `nfl-sim-policy.js:291-304`, `kneelDecision`: `kneelable = 40 + timeouts * 40` where
     `timeouts` is the **opponent's** remaining timeouts (call site `nfl-drive-sim.js:265`,
     `timeouts: oppTimeouts`). More opponent timeouts *raises* the "safe to kneel" seconds
     threshold. This is backwards: a timeout stops the clock, so more opponent timeouts means
     the offense burns *less* clock per kneel and needs *more* real game time in hand before a
     kneel-out is safe — the relationship should be inverse (fewer opponent timeouts → higher
     safe threshold), matching real "kneel-down chart" logic.
   - The kneel branch (`nfl-drive-sim.js:266-268`) then returns
     `{ seconds: secondsLeft, kneel: true, ... }` — a single decision instantly consumes **the
     entire remaining half clock** in one function call, rather than a kneel being one ~40-second
     snap that a real defense could still stop via timeout and get the ball back.
   - Timeouts are never spent. `nfl-drive-sim.js:475`: `const to = P.timeoutPolicy(...)` computes
     a spend/hold decision but the result is discarded — nothing ever decrements
     `timeouts.home`/`timeouts.away` (`:453`). The only place timeouts change value in the whole
     file is the per-half reset to 3 at `:461`. A trailing team can never force a stoppage; a
     leading team is never actually threatened by the defense's timeouts because those timeouts
     never go down.

4. **Away-team win probability computed against the home team's spread.**
   `nfl-live.js:61-66`, `liveWinProbability(lead, secondsLeft, pregameSpread)` is documented
   explicitly: `@param lead current margin from the home team's view`,
   `@param pregameSpread ESPN convention: negative means the home side is favoured` — i.e. the
   function is only valid when `lead` and `pregameSpread` share the same (home) reference frame.
   `nfl-sim-policy.js`'s `wp()` helper (`:115`, used by `fourthDownByWinProbability`,
   `onsideDecision` at `:178-180`, `varianceProfile` at `:213`) is called with `lead` computed
   per-possession (`nfl-drive-sim.js:467`, `lead = possession === 'home' ? home - away : away -
   home`) — i.e. **flips sign when away has the ball** — but is always passed the same
   `spread` value, which is never flipped. When the away team is on offense, its "lead" is in
   away-perspective while the spread argument is still in home-favored convention: a sign
   mismatch on every fourth-down/onside/variance decision the away team makes.

5. **Home-field advantage is a coin-flip lump.**
   `nfl-drive-sim.js:562`: `if (homeFieldPoints > 0 && random() < homeFieldPoints / 7) home +=
   7;` — a single Bernoulli draw, applied once per simulated game *after* both halves and OT are
   already final, worth exactly one made touchdown (7) or nothing. This corrupts the discrete
   score distribution at exactly the key numbers (3, 7) the whole betting-model stack cares
   about, and it is not a function of anything about the specific matchup (travel, altitude,
   crowd, rest) — `homeFieldPoints` is one global scalar.

6. **Season-remainder simulator has no halftime or overtime.**
   `nfl-drive-sim.js:799-829` (inside the live/season-remainder resimulation path): a single
   `while (clock > 0)` loop counting down from `s.secondsLeft` to 0, with `timeouts: 3,
   oppTimeouts: 3` hardcoded on every drive (never threaded from real state, never decremented),
   `isHalfEnd: clock < 120` used as a rough proxy, and **no transition at all** when the clock
   would cross into a second half or into overtime if the score is tied at zero. Contrast with
   `simulateGame` (`:446-565`), which does model two explicit halves plus a 10-minute-OT block
   (`:541-558`) — the season-remainder path is a materially simpler, buggier copy of the same
   logic rather than sharing one halftime/OT-aware state machine.

## 1. Primary sources read

### (a) Williams, Palmquist & Elmore — "Simulation-Based Decision Making in the NFL using
NFLSimulatoR" (arXiv:2102.01846) — **read in full** (all 8 pages)

- Method: an R package (`NFLSimulatoR`, CRAN + github.com/rtelmore/NFLSimulatoR) that simulates
  drives by **directly resampling real historical plays** matching (down, distance, yard line)
  from nflscrapR/nflfastR play-by-play — no parametric play-outcome model at all. `sample_play()`
  samples one play satisfying (down, yards-to-go, yard line, ± a strategy filter); when a
  combination is too rare it widens the sampling window (nearest-neighbor fallback).
  `sample_drives()` repeatedly calls `down_distance_updater()` to update state and chain plays
  into a full drive.
- Data/sample: NFL play-by-play 2009-2019 via nflscrapR/nflfastR, ≈48,000 plays/season. The
  worked example draws 10,000 simulated single-drives from 2018-2019 data, starting 1st-and-10
  from the 25 (the standard post-kickoff-touchback spot), for five fourth-down sub-strategies.
- Result (Table 1, honest, no cherry-picking): mean simulated points/drive by strategy —
  *Always Go* 2.28 (95% CI 2.22-2.35), *Empirical* 1.96, *Expected Points* 2.19, *Never Go* 2.03,
  *Go if <5 yds* 2.24 — with *Always Go* and *Yards<5* statistically indistinguishable and both
  beating the standard *Empirical* (status-quo NFL coaching) baseline. This is a genuine
  out-of-sample comparison against a real behavioral benchmark (what NFL teams actually did),
  not a claim of beating the market.
- Relevance to the fix: the companion R source (`R/down_distance_updater.R`, read directly, not
  from the paper) is the actual working implementation and is the second independent GitHub
  confirmation of the correct turnover-flip convention (see §2).

### (b) Pelechrinis — "iWinRNFL: A Simple, Interpretable & Well-Calibrated In-Game Win
Probability Model for NFL" (arXiv:1704.00197) — **read in full** (6 pages, methodology +
evaluation)

- Model: logistic regression, `Pr[H=1|x] = exp(w·x) / (1+exp(w·x))`, where **H is fixed as "home
  team wins"** — every covariate is defined in the same, single reference frame: Score
  Differential (home − visiting), Rating Differential (home − visiting team strength), Home
  Timeouts, Away Timeouts, Ball Possession Team (binary: does home have it), Down/Field
  Position/Yards-to-go *interacted with* possession-team-is-home. This is the exact discipline
  Gridiron's `wp()` call sites violate: **one fixed perspective, every input in that frame,
  possession/side-switching modeled as an explicit interaction term — never by silently flipping
  one argument (lead) and not the other (spread)**.
- Data: NFL Game Center play-by-play via `nflgame`, 2009-2015 regular season, 1,792 games,
  **295,844 plays** (Table 1 "Observations").
- Result (honest, with a real benchmark): Brier score 0.158 vs. a climatology baseline (constant
  57% home-win prior) of 0.26; 76.5% same-sign accuracy; calibration curve slope 0.98 (95% CI
  [0.97, 1.01]), intercept 0.008 (95% CI [-0.001, 0.002]) — essentially the `y=x` line. Non-linear
  alternatives (naive Bayes, a 2-hidden-layer FNN) evaluated on the *same* features gave no
  material improvement (Brier 0.163 and 0.156 respectively) — the paper's headline finding is
  that the win-probability signal here is almost entirely in getting the linear covariates and
  their reference frame right, not in model complexity.
- Also explicit: "One could have expected the intercept to capture the home field advantage
  ([citation]), but the teams' rating differential has already included the home edge" — i.e.
  HFA is a rating-level input, not a separate additive bonus layered on afterward.

### (c) Yurko, Ventura & Horowitz — "nflWAR: A Reproducible Method for Offensive Player
Evaluation in Football" (arXiv:1802.00998, extended ed.) — **read in full** for the
introduction and full Expected-Points methodology (pp. 1-13; player-WAR sections beyond this
were not needed for this topic and were not read)

- State space for the EP model (Table 1/2, quoted directly): "Time Remaining: Seconds remaining
  in game, each game is **3600 seconds long (four quarters, halftime, and a potential
  overtime)**" for the *game-level* clock, but the EP model itself is explicitly built on
  "Seconds — number of seconds remaining in **half**" (Table 2) because its response variable
  ("next score, within the same half, with respect to the possession team") is half-scoped by
  construction. The paper is careful to state, in words, exactly which clock domain each number
  lives in — the discipline Gridiron's engine lacks (§0.2).
- Turnovers/possession changes: the response variable `Y ∈ {Touchdown(7), FieldGoal(3),
  Safety(2), NoScore(0), −Safety(−2), −FieldGoal(−3), −Touchdown(−7)}` is defined **relative to
  the current possession team** for the *entire* remainder of the half — i.e. the sign of the
  target flips with possession by construction, which forces the modeler to keep every
  covariate (including any market/rating input) in that same possession-relative frame or the
  fit breaks. QB kneels are explicitly excluded and hard-coded to `EP = 0` (a deliberate, named
  special case) rather than being handled by the same play-outcome sampler as a live snap.
- Sample & result: 304,896 non-PAT plays, NFL 2009-2016 (nflscrapR). Multinomial logistic
  regression with interactions (log(YTG)×Down, Yardline×Down, log(YTG)×GTG), evaluated with
  **leave-one-season-out cross-validation** (train on all-but-one season, test on the held-out
  season) — a genuine out-of-sample protocol. Calibration error (mean absolute
  |predicted−observed| probability per 5%-bin, weighted by play count) **e ≈ 0.013** across all
  seven scoring events (Figure 3, near-perfect diagonal). An ordinal alternative that assumes
  equal spacing between scoring values was tried and rejected for being worse (e ≈ 0.022) —
  reported as a negative result, not hidden.
- Relevance: Gridiron's own EP surface (`epFor()`, `nfl-drive-sim.js:578-588`) is generated by
  running its *own* simulator to convergence — self-consistent with its own generative process,
  as its comment says, but for that same reason it can never catch a bug *in* that generative
  process (like defects 1-6 above): a broken simulator just produces a different, still
  "self-consistent" EP table. nflWAR's approach — an EP model fit directly on real play-by-play,
  independent of any simulator, then calibration-checked with a stated numeric error — is the
  kind of external check Gridiron has never run (→ New candidate N1).

### (d) Goldner — "A Markov Model of Football: Using Stochastic Processes to Model a Football
Drive" (Journal of Quantitative Analysis in Sports, 2012) — cited, **not read in full**
(paywalled at De Gruyter; ResearchGate/Semantic Scholar mirrors returned only the abstract-level
description, not the fetchable body, in this session). Description per its own abstract and per
nflWAR's/NFLSimulatoR's citations of it: an absorbing Markov chain over (down, distance, yard
line) states, using the *touchdown/field-goal/safety* boundary events as absorbing states to
derive absorption probabilities, expected time-to-absorption, and expected points in closed
form. Included here because it is the historical origin of the "state = (down, distance,
yardline), scoring events = absorbing states" formalism that both nflWAR and NFLSimulatoR build
on directly — but flagged honestly as not independently verified in this session.

## 2. GitHub implementations read (3, all cloned and grepped directly — not judged by README)

### (i) `rtelmore/NFLSimulatoR` — 19 stars, MIT-family ("Other" license field on CRAN mirror), R,
last pushed 2026-06-30 (actively maintained). Companion code to source (a) above.
- `R/down_distance_updater.R:33-34`: guards field position into `[5, 90]` before sampling
  (`if (yards_from_own_goal <= 5) yards_from_own_goal <- 5`), and re-derives `yards_to_go` when
  pinned near the goal line — i.e. it treats field-position edge cases as first-class, not an
  afterthought clamp.
- `R/sample_drives.R:82`: **`new_yfog <- 100 - new_yfog`** — the field-position mirror on change
  of possession, applied exactly where Gridiron fails to apply it (defect 1). Independent
  confirmation #1.

### (ii) `tim-foldy-porto/nflsim` — small (2 stars) but structurally the cleanest reference found:
a from-scratch Python engine (`nflsim/engine/{game.py,game_state.py,clock.py,rules.py,
play_resolver.py}`), Python, actively pushed 2026-07-26.
- `nflsim/engine/rules.py:184-201`, `_apply_turnover()`: for an interception,
  `return_spot = 100 - int_spot + outcome.turnover_return_yards`; for a lost fumble,
  `new_spot = 100 - fumble_spot  # flip for new possessing team`. **Independent confirmation #2**
  of the exact fix defect 1 needs, in a completely different language/codebase from (i).
- `nflsim/engine/clock.py:1-90` + `nflsim/engine/game_state.py`: a single canonical clock unit,
  `state.quarter` (1-5, 5=OT) + `state.quarter_seconds_remaining` reset to a `QUARTER_SECONDS`
  constant on every quarter transition — never a raw "seconds since kickoff" value divided by an
  assumed total elsewhere. `compute_runoff()` assigns each play type its own fixed or
  situational runoff (kickoff, spike=1s, **kneel=40s** — one snap, not the whole clock);
  `_is_hurry_up()` gates on `state.quarter_seconds_remaining <= 120`, always within the *current*
  quarter's own domain. This directly demonstrates fix for defect 2 and half of defect 3 (kneel
  duration).
- `nflsim/engine/clock.py:122-153`, `transition_quarter()` / `_halftime()`: halftime is a named,
  explicit state transition — `state.quarter = 3`, timeouts reset
  (`TIMEOUTS_PER_HALF`), possession flipped per the pregame coin-toss record
  (`state.home_receives_2h`), `state.phase = Phase.KICKOFF`. `_start_overtime()` is a second,
  equally explicit transition. Both a fresh game and (implicitly, since it's the same state
  machine) a resumed mid-game simulation share this one function — there is no second, simplified
  copy of the game loop the way Gridiron's season-remainder simulator is. Directly informs fix
  for defect 6.
- `nflsim/engine/play_resolver.py:76-82`, `choose_play()`: the kneel-to-run-out-clock decision
  gates on `def_timeouts == 0` (opponent has **zero** timeouts left) before it will call a kneel
  late in the fourth quarter — the correct-direction version of Gridiron's inverted formula
  (defect 3, kneel-inversion half).
- No home-field-advantage model at all in this repo (grepped the whole tree for
  `home_field|HFA|home_advantage`, zero hits) — noted as a gap in this otherwise-clean reference,
  not a source for defect 5's fix.

### (iii) `martineastwood/penaltyblog` — 220 stars, MIT license, actively maintained (pushed
2026-09-10, i.e. two days before this research), Python. A general sports-modeling library
(soccer-focused, but the rating math is sport-agnostic and is the standard published NFL-Elo
approach, e.g. FiveThirtyEight/nfelo).
- `penaltyblog/ratings/elo.py:15-42`: `Elo.__init__(self, k=20.0, home_field_advantage=100.0)`
  stores HFA as **Elo points**, added directly onto the home team's rating *before* any win
  probability is computed: `r_home = self.get_team_rating(home) + self.hfa`,
  `r_away = self.get_team_rating(away)`, then the logistic
  `1 / (1 + 10**((r_away - r_home) / 400))`. HFA is therefore (a) continuous — any real number of
  rating points, not a binary lump — and (b) applied at the *input* to the probability model, not
  as a post-hoc score adjustment after the game is already simulated. This is the exact
  architectural pattern defect 5 needs: move `homeFieldPoints` from a post-game coin flip
  (`nfl-drive-sim.js:562`) into a small continuous shift applied to whichever rate/rating feeds
  `simulateDrive`/`liveWinProbability`, before any random draw happens.
- Not NFL-specific and carries no play-by-play/turnover logic — used here only for the HFA
  architecture citation, not as a drive-simulator reference.

## 3. Fix candidates → new candidates: what each one does and does not claim

All fix candidates are scoped to `server/services/nfl-drive-sim.js` and
`server/services/nfl-sim-policy.js` only (read-only verified against the live file; no other
files in the read-only repo were modified or need to be for these fixes). None of these claims
"beats the market" — they claim the simulator's *internal mechanics* stop contradicting
football's actual rules, which is a precondition for any of Gridiron's downstream betting-model
work (nfl-ensemble.js, CLV modules, teaser-leg correlation) that consumes drive-sim output to be
worth auditing at all.

New candidates are capabilities Gridiron has never had in this area: an independent (non-
self-referential) EP-surface audit; an empirical-resampling cross-check simulator; and a
continuous, team-specific HFA rating — all things this research surfaced as standard practice in
real implementations that Gridiron's current single hand-rolled simulator has no equivalent of.

## 4. Do-not-do list

- Do not "fix" the kneel/timeout bug by just capping `kneelable` at some small constant — the
  actual defect is a wrong *sign* on the opponent-timeout term (independence direction), and a
  cap papers over rather than corrects the relationship (would still be wrong at intermediate
  timeout counts).
- Do not fix the turnover field-position bug by special-casing only interceptions or only fumbles
  — `nfl-drive-sim.js:345-346` is a single shared return path for both turnover types; the
  mirror (`100 - endYard`) must be applied at that one shared point, not duplicated per-type
  (duplication is exactly how tim-foldy-porto/nflsim's own turnover code, which *does* apply the
  mirror in two separate branches for interception vs. fumble, risks drifting out of sync if only
  one branch is patched later — Gridiron's single shared branch is actually easier to fix
  correctly here).
- Do not replace the whole engine with an empirical-resampling model (NFLSimulatoR's approach) as
  the *primary* simulator — Gridiron's parametric engine is intentionally tunable by team/week
  context (form draws, matchup-specific rates) in ways a small-sample nearest-neighbor resampler
  from real historical plays cannot easily be conditioned on without reintroducing the "some
  (down, distance, yardline) combinations rarely occur" sparsity problem the NFLSimulatoR paper
  itself flags. Use resampling as an independent *audit*, not a replacement (see N2).
- Do not implement continuous HFA (fix 5 / candidate N4) as a single still-global scalar simply
  moved earlier in the pipeline (e.g. added to the league-average rate before the per-team draw)
  — that reintroduces the "one global scalar" problem defect 5 already has, just relocated. HFA
  needs to vary by team/matchup (travel, rest, stadium) to be worth making continuous at all.
- Do not treat `liveWinProbability`'s existing docstring convention (home-perspective,
  ESPN-sign-convention spread) as something to change — it is already correct and consistent
  with iWinRNFL's discipline. The bug is entirely in `nfl-sim-policy.js`'s call sites feeding it
  mismatched arguments; fix the call sites, not the function contract.
- Do not assume fixing these 6 mechanics will move the ensemble's -2.28 CLV or its 78%
  adverse-move rate — that defect lives in `nfl-ensemble.js`'s blend weights, a separate,
  already-diagnosed problem this research does not touch.
