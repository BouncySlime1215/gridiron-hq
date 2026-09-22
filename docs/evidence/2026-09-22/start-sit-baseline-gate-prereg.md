# Pre-registration: the standing start/sit gate (C-01, plan item C12)

Written and committed **before any number is run**. Tree: branch
`claude/local-c-01-startsit-baseline-gate` off `origin/main d6d7bd5a`. Nothing in
this file was measured; every number below is a rule, a threshold or a
configuration value read from code.

## 1. The question

Plan item 12, Nick's words: "start/sit must beat 'start highest projection' ...
If it can't beat dumb, it's decoration."

The app's start/sit rule is already "start the higher projection"
(`lineup-brain.js#lineupCall` solves `bestLineup` on `week_points`). So the gate
is only meaningful if the *projection* is what gets graded against a dumb one:
does starting by **our** projection beat starting by the **dumbest projection a
manager has**?

- **Our policy (π).** Start the player with the higher weekly projection as
  production would have served it that week: the configuration-B structural
  head (`buildProjections` with `roleRecency: WEEKLY_ROLE_RECENCY` passed
  explicitly, `kOverride` omitted, so the fitted volume k comes from
  `shrinkage-fit.js#activeKVectorFor`, cutoff-safe per season), blended by the
  **as-of** weekly ensemble champion `weekly-weight-store.js#activeWeeklyWeightSet({season, week})`
  (the same resolution `player-week-engine.js:265` uses live).
- **The dumb rule (β).** Start the player with the higher **season-to-date PPR
  average** (mean of his in-season games before week W: the "AVG" column any
  platform shows). It uses no model at all.

Why not ESPN's weekly projection as β: `espn_player_market_weekly` holds 2026
week 2 only (614 rows with `week_proj`, one league, local copy), so no past
season can be graded on it. The gate interface is baseline-agnostic; ESPN's
projection can be plugged in as β once weeks accumulate (named follow-up).

## 2. Hypothesis

H1: where π and β disagree about which of two startable same-position players
to start, π's pick scores more actual PPR points than β's pick.

## 3. The decision universe

Source rows: `weekly-backtest.js#replaySeasonWeekly(season, { distributions: false,
roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: <as-of champion> })._decision_rows`
— players active in week W−1 (known at forecast time), graded on week W with
**0 when he did not play**. This is the harness's existing decision population;
no second harness.

1. **Bye weeks removed.** A player whose week W−1 team has no row in
   `player_week_usage` for week W is on a bye (the published schedule knows
   this before the season; neither a manager nor production would start him).
   Injury DNPs stay in as zeros for both rules.
2. **Pairs.** Two different players in the same (season, week, position),
   position ∈ {QB, RB, WR, TE}, each projected **≥ 8.0 PPR by both rules**
   (the startable universe `lineup-brain.js DECISION_CURVE` is stated on). Each
   unordered pair once.
3. **Disagreement.** π and β order the pair strictly and differently. A pair
   where either rule has an exact projection tie is not a disagreement.
4. **Outcome of one disagreement d.** X = π's pick, Y = β's pick.
   `win_d` = 1 if actual(X) > actual(Y), 0 if less, 0.5 if equal.
   `points_d` = actual(X) − actual(Y).

## 4. Metrics and sign convention

- **Decision win rate** = mean(`win_d`) over disagreements.
- **Points per disagreement** = mean(`points_d`), PPR.
- **Sign convention:** points = π's pick minus β's pick. **Positive favours our
  projection.** Win rate above 0.5 favours our projection.
- Also reported: n disagreements, n pairs, agreement share, players (clusters),
  each rule's pair accuracy on the whole pair set (comparable with
  `scripts/promote-early-week-weights.mjs:153 startSitPairAccuracy`), and MAE of
  each rule on the decision rows including DNP zeros (discipline d: decisions
  and error both).
- **Failing weeks:** every (season, week) whose points per disagreement is below
  0. All listed, never truncated.

## 5. Interval method (pre-registered)

- **Primary: player-clustered 90% CI, two-factor (pigeonhole) bootstrap.** A
  disagreement involves two players, and each player recurs across many pairs
  and weeks. `backtest-significance.js#pairedBootstrapDiff` takes one cluster
  key per unit, so it cannot express this. Resample the set of players with
  replacement; weight each disagreement by m(X)·m(Y), the product of its two
  players' resample counts. 2,000 draws, seed 1, percentile interval.
- **Secondary: week-clustered 90% CI** via `pairedBootstrapDiff` itself with
  `groups` = season-week (the second dependence axis: all pairs in a week share
  that week's scores). 2,000 draws, seed 1. Few clusters (28 in the past
  window): stated as a limit.
- **Power:** minimum detectable effect at 80% power for a two-sided 90% test,
  MDE = (1.6449 + 0.8416) × SE, SE = the player-clustered bootstrap SD.
  Reported for every verdict that is not a pass.

Grounding. Grading a forecast by the decisions it drives rather than by its
error is decision-based forecast evaluation (Pesaran & Skouras 2002, "Decision-based
methods for forecast evaluation", *A Companion to Economic Forecasting*), and a
naive benchmark is the minimum bar a forecast must clear (Hyndman & Koehler 2006,
*IJF* 22(4), which scales every error by a naive forecast). The two rules are
compared on identical decisions, as in Diebold & Mariano (1995, *JBES* 13(3)).
Because outcomes are shared by player on two sides and by week, the interval uses
the crossed-factor bootstrap of Owen (2007, "The pigeonhole bootstrap", *Annals of
Applied Statistics* 1(2)) with a second, week-clustered check in the spirit of
multiway clustering (Cameron, Gelbach & Miller 2011, *JBES* 29(2)); power is
reported as a minimum detectable effect (Bloom 1995, *Evaluation Review* 19(5)).

## 6. Windows (the held-out split)

| window | seasons / weeks | why |
|---|---|---|
| **past (gating)** | 2024 and 2025, weeks 5-18, pooled; each season also shown alone | the as-of champion for both is `frozen-2023` (fit on 2023 only, `weekly-ensemble.js:10-11`), so both are out of sample for the weights; weeks 5-18 is where the per-position vectors apply |
| **forward holdout** | 2026, every played week ≥ 2 | what production actually serves, including the fit-2 early-week block; week 1 has no in-season history, so the harness does not grade it |
| excluded | 2023 | in-sample for `frozen-2023` |
| excluded | 2021-2022 | the as-of weights were fit on a LATER season (look-ahead) |

2025 is the held-out season: this unit's run is a recorded look (evidence file,
"Holdout looks"). A standing re-run over 2025 is deterministic and repeats the
same number unless the policy changes; a policy change is a new look owned by the
unit that made it.

Known non-independence, stated now: only the fitted volume k is cutoff-safe by
construction. Hand-set constants inside `buildProjections` (e.g. `RECENCY`) were
chosen with 2021-2025 visible, so the past window is not a pristine holdout for
the whole policy. The 2026 forward window is the only fully clean one.

## 7. Configuration controls (run before any metric)

- **k control:** for each graded season, resolve
  `activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason })?.target_share?.ALL`.
  If it is missing or equals the hardcoded `K.share = 6` (`projections.js:103`),
  **stop**: configuration B requires a fitted k live, and 6 means none resolved.
  The resolved value is printed. Expected from the local copy's `shrinkage_fits`
  (fit 1 active, through 2025): a refit value for 2024/2025, 0.1733 for 2026.
- **Configuration printout:** role recency read from `WEEKLY_ROLE_RECENCY`
  itself, `kOverride: omitted`, champion id per graded week.
- **Known-nonzero control first:** an oracle policy (π = the actual score) on the
  same real rows must show win rate 1.0 on non-tied disagreements and a positive
  points delta before the real result is read. An identity policy (π = β) must
  show 0 disagreements.

## 8. Ship rule (verdict the page shows)

On the **past** window:

- **G1** points per disagreement, player-clustered 90% CI lower bound > 0;
- **G2** points per disagreement, week-clustered 90% CI lower bound > 0;
- **G3** decision win rate, player-clustered 90% CI lower bound > 0.5.

On the **forward** window:

- **G4** points per disagreement point estimate > 0 with at least one disagreement.

| verdict | condition |
|---|---|
| `beats_dumb` | G1 ∧ G2 ∧ G3 ∧ G4 |
| `beats_dumb_unconfirmed_forward` | G1 ∧ G2 ∧ G3, not G4 |
| `loses_to_dumb` | player-clustered CI upper bound of points < 0 |
| `not_distinguishable` | anything else; MDE reported |
| `no_disagreements` | past window has 0 disagreements |

This unit ships an **instrument**. The instrument ships if its controls and
tests hold; the policy's verdict is displayed whichever way it lands. A verdict
other than `beats_dumb` is shown on the Lineup page as exactly that, never
hidden. Nothing in the app is switched on or off by this verdict in this unit.

## 9. What would make this wrong

- The replay predictor is not production's full `week_points` chain
  (coordinator correction, chance to play, betting-line lift are not in the
  replay: memory `gridiron-replay-may-not-grade-the-shipped-model`). The gate
  grades the replay predictor in production's configuration, and says so on the
  page.
- PPR scoring, not each league's `scoringItems`.
- A league-wide pool of pairs, not Nick's rosters (no walk-forward rosters exist
  for 2024-2025: `league_roster_history` holds final snapshots only).
- Players on a bye in week W−1 are not in week W's pool (harness convention).
