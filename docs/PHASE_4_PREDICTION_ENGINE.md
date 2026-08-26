# Phase 4 — Fantasy Prediction Engine

Companion to `docs/HANDOFF.md`. Read that first, especially §0 (what already
exists) and the testing conventions.

**Governing principle:** this phase is judged on *measured out-of-sample
accuracy and honest uncertainty*, not on how sophisticated the architecture
looks. Every section below ends in a number you can check.

---

## 0. Baseline — do this before writing any model code

The engine already exists (`services/projections.js`, `services/backtest.js`).
The first deliverable is **a published, reproducible accuracy report**, because
nothing after this is meaningful without a number to beat.

Known measured baseline (2025 held out, trained through 2024, identical player
set):

| | Model | "Last season points" |
|---|---|---|
| MAE | **42.9** | 47.0 |
| R² | **0.587** | 0.447 |
| Spearman | **0.776** | 0.754 |
| CRPS | 32.3 | — |
| 80% interval coverage | **0.71** | — |

Two things are immediately wrong and are your first real targets:
1. **Coverage is 0.71 when it should be 0.80.** The intervals are too narrow —
   the model is overconfident. See §3.
2. R² 0.587 on season points is respectable; **weekly** accuracy is the harder
   and more valuable problem and is not yet characterised at all.

**Ship first:** `GET /api/model/accuracy` already exists. Build the page that
renders it per position, per season, with the training cutoff and held-out
season stated on screen. No model changes in this step.

---

## 1. Variable taxonomy

Most of this data is **already in the database**. Check before ingesting
anything: `nfl_ngs`, `nfl_pfr_adv`, `nfl_snaps`, `player_week_usage`,
`player_week_snaps`, `nfl_player_week_features`, `nfl_team_week_features`,
`nfl_depth`, `nfl_injuries`, `schedule_games`, `player_gamelog`.

### 1.1 Opportunity (the dominant signal)
Fantasy points are mostly *volume × efficiency*, and volume is far more
predictable. Model it explicitly and separately.

**Receiving**
- Route participation rate (routes run ÷ team dropbacks) — more stable than
  target share and available in `player_week_usage`
- Target share, and **target share per route** (target rate)
- Air yards, air-yards share, aDOT
- WOPR (1.5 × target share + 0.7 × air-yards share)
- Red-zone and end-zone target share (separate — end-zone is where TDs live)
- Slot vs wide vs inline alignment rate (`nfl_ngs`, `nfl_pfr_adv`)
- Man/zone split usage where charting exists — **label as charted, not observed,
  if the source is partial**

**Rushing**
- Carry share, and carry share *inside the 10* and *inside the 5* separately
- Snap share on early downs vs third down vs two-minute
- Goal-line back identity (a near-binary, high-variance TD driver)
- Yards before/after contact (`nfl_pfr_adv`), broken tackle rate
- Committee structure: model the *backfield* as a unit, then allocate

**Passing**
- Dropbacks, attempts, aDOT, pressure rate faced, time to throw (`nfl_ngs`)
- Rush attempts + designed runs (the single largest QB fantasy differentiator)
- Play-action rate, deep-ball rate

### 1.2 Efficiency (regress hard)
Efficiency is mostly noise at small samples. Every efficiency term must be
shrunk toward a positional prior, with the shrinkage constant *fit*, not
guessed. Recorded from earlier work: `K.td_rate` needs ~70 games of shrinkage.

- Yards per route run, yards per target, catch rate over expected
- Yards per carry (very noisy — shrink aggressively)
- TD rate per opportunity, split by field position bucket
- EPA/CPOE for QBs
- xYAC and YAC over expected (`nfl_ngs`)

### 1.3 Availability — highest leverage term in the model
This was already identified as the single most valuable component. Rules that
must hold:

- Model availability as **share of team games played**, not average of games
  appeared in. Otherwise backup QBs project as starters.
- QBs need an **attempt-share cap** — the position is winner-take-all.
- Use `nfl_injuries` practice participation (DNP/LP/FP) as an ordinal signal,
  not a binary.
- Separate *probability of playing* from *expected snap share if playing*.
  A questionable RB who plays at 60% snaps is a different projection from one
  who plays at 100% with a 60% chance.
- Model **games missed as a distribution**, not an expectation — see §3.

### 1.4 Team and game context
- Pace (seconds/play, neutral-script), plays per game
- Pass rate, and **neutral-situation pass rate** (script-independent intent)
- Implied team total (from `game_lines`) — the best single game-context variable
- Spread, total, and their interaction with pace
- Opponent positional funnel: defensive efficiency split by pass/rush and by
  target position, shrunk (see §2.3)
- Coverage/pressure tendencies
- Weather (wind is the only weather variable with a reliable fantasy effect;
  temperature and light precipitation are mostly noise — do not overfit them)
- Rest, travel, timezone, short week

### 1.5 League context (this is what makes it *your* projection)
- Scoring: use `scoring.js:scoringFor(lg)` which already parses ESPN's real
  `scoringItems`. Custom scoring must flow through, not fall back to PPR.
- Roster requirements, superflex, TE premium
- **Replacement level computed for this league specifically** — VOR depends on
  team count × starters, not a generic table
- Waiver availability, opponent rosters, playoff weeks

---

## 2. Model architecture

### 2.1 Hierarchical, not flat
Do not fit one regression over all players. Fit a **partially pooled** model:

```
league prior  →  position prior  →  archetype prior  →  player
```

Each level shrinks toward its parent by a fitted amount. This is what lets a
rookie with 3 games get a sane projection instead of either the league mean or
a wildly overfit personal estimate. It is also the honest way to handle role
changes: a player who changes team/scheme keeps his *archetype* prior but loses
much of his *player* prior weight.

### 2.2 Structural decomposition
Project the chain, not the outcome:

```
team plays  →  team pass/rush split  →  player opportunity share
            →  player efficiency  →  fantasy points  →  distribution
```

Every arrow is separately testable, and errors become attributable. When the
projection is wrong you can say *which link* was wrong — which is the entire
basis of the "why did this change" UI in §5.

### 2.3 Empirical-Bayes shrinkage everywhere
Already used correctly in `matchups.js` (DvP measured on player-relative ratios
with K_DVP=12, K_SPLIT=8 — this turned "+59% vs DET on 2 games" into +12%).
Apply the same discipline to every rate: **no raw small-sample rate ever reaches
a projection.**

### 2.4 Correlation structure
`correlation_estimates` exists and `services/correlation.js` implements archetype
correlations (QB-WR same team 0.199, QB-TE 0.180, QB-QB opponents 0.144, scaled
by receiver target share). This matters for:
- Lineup construction / DFS-style stacking
- Season simulation variance (uncorrelated errors understate real variance)
- Trade impact (correlated players are worth less together than apart)

Extend to: RB-DEF same team (game script), WR-WR same team (negative,
cannibalisation), and player-vs-own-DEF.

### 2.5 Candidate model families to compare
The registry supports multiple candidates and already lists `mean_baseline` and
`volume_efficiency`. Add, in this order, and only keep what beats the previous
out-of-sample:
1. `volume_efficiency` (current) — the structural baseline
2. Hierarchical shrinkage version of the same
3. Gradient-boosted residual model **on top of** the structural projection (learn
   what the structure misses; never replace it wholesale — a pure GBM loses
   explainability and gains little)
4. Quantile regression for the distribution tails specifically

**Promotion rule:** a complex model that does not beat the simple one on unseen
data does not ship. The registry already enforces promotion gates — use them.

---

## 3. Uncertainty — the part that is currently wrong

80% intervals covering 71% means the model is systematically overconfident.
Three sources of variance must all be present:

1. **Outcome noise** — week-to-week variance given a fixed role. Present.
2. **Parameter uncertainty** — we don't know the player's true rate. Requires a
   log-normal level draw. Recorded from earlier work: without this, an 80%
   interval covered only ~33%.
3. **Role/availability uncertainty** — beta-binomial games played, plus discrete
   role-change scenarios (see §4).

Deliverables:
- **Reliability diagram** per position: predicted quantile vs realised
  frequency. This is the headline honesty chart.
- **PIT histogram** (probability integral transform) — should be flat; a U shape
  means overconfident, a hump means underconfident.
- CRPS as the single scalar distributional score (already implemented).
- Report **coverage at 50/80/90/95** rather than one number.

Target: 80% coverage in **[0.78, 0.82]** on held-out data. That is the acceptance
criterion for this section.

---

## 4. Higher-order concepts worth building

### 4.1 Scenario / contingency modelling
`services/contingency.js` exists with two hard-won rules already encoded:
beneficiaries must be restricted to the same position group, and each player's
window must be bounded to weeks he actually appeared for that team-season
(otherwise roster churn manufactures phantom opportunity).

Extend it into a first-class **scenario engine**:
- "If the starting RB misses 3 games, this handcuff's ROS value becomes X"
- Discrete scenario tree with probabilities, not point estimates
- Feeds the distribution in §3 rather than sitting beside it

### 4.2 Role-change detection
The largest projection errors are role changes, not efficiency misses. Build a
**changepoint detector** on snap share / route participation: flag when a
player's recent usage is statistically inconsistent with his prior, and
down-weight the prior accordingly. This is what makes the model react to a
breakout in week 3 instead of week 8.

### 4.3 Decision-value metrics (more important than MAE)
`weeklyDecisionBacktest` already exists. The user does not care about MAE; they
care about whether the tool made them win. Report:
- **Start/sit regret** — points lost vs the optimal lineup, per week
- **Waiver regret** — value of the best available player not recommended
- **Draft value error** — VOR realised vs projected at each pick
- **Win-probability delta** — the season-sim championship-odds change from
  following the tool's advice vs the naive alternative

These are the numbers the product should be judged on, and they should be on
screen.

### 4.4 Season simulation
`services/season-sim.js` exists. Invariants already discovered and which must be
asserted in tests: brackets must **re-seed high-vs-low each round** (pairing
survivors in seed order puts the top two seeds in the same semifinal every run),
and it must simulate **NFL weeks 15-17**, not the last three regular-season
weeks, or byes decide the title. Title odds must sum to 1.0, finals to 2.0,
playoff to `playoffTeamCount`.

---

## 5. UI — projections as an explanation, not a number

Nick's stated preference, which applies throughout: **light/white backgrounds,
clean and minimal, schematic diagrams rather than decorative ones.** No dark
dashboards, no faux-3D, no green-felt football field.

### 5.1 The projection card (the atomic unit)
Every projection anywhere in the app expands to the same card:

```
┌────────────────────────────────────────────────────────┐
│  Player · POS · TEAM              ⓘ model v4.2 · 2h ago │
│                                                         │
│         14.8  pts        ┌──────────────────────┐       │
│    floor 6.1 · ceil 26.4 │   distribution plot   │      │
│                          └──────────────────────┘       │
│                                                         │
│  WHY                                                    │
│  ▸ Opportunity   +3.1   route rate 82% (↑ from 61%)     │
│  ▸ Matchup       +0.9   SEA 3rd-most funnel to slot     │
│  ▸ Efficiency    −0.4   YPRR regressed toward prior     │
│  ▸ Availability  −1.2   LP Wed/Thu, 78% play prob       │
│                                                         │
│  WHAT CHANGED since last week          [ compare ▾ ]    │
│  Route rate ↑21pts after Smith's injury → +2.6          │
│                                                         │
│  CONFIDENCE  ████████░░  medium                         │
│  Based on 6 games in this role · intervals calibrated   │
│  at 80% coverage on 2025 holdout                        │
│                                                         │
│  [ Technical evidence ▾ ]                               │
└────────────────────────────────────────────────────────┘
```

Requirements:
- **Driver decomposition must be additive and sum to the projection.** If the
  bars don't add up, the explanation is decorative and should not ship.
- "What changed" diffs against the previous model run and names the *cause*.
- Confidence is derived from measured coverage, never a vibe.
- Technical evidence is progressive disclosure: raw inputs, model version,
  dataset version, feature vector.
- **Model-generated evidence and LLM commentary must be visually distinct.**
  Never let Claude's prose look like a model output.

### 5.2 New surfaces
1. **Projection Explorer** — sortable, filterable, with distribution sparklines
   inline. Compare up to 4 players' full distributions overlaid.
2. **Scenario Sandbox** — "what if X gets hurt / Y is traded / Z's team goes
   pass-heavy". Drives the contingency engine (§4.1) live.
3. **Accuracy Ledger** — public scoreboard of the model's own record.
   Reliability diagram, PIT histogram, MAE by position/week, and a running list
   of the model's *worst misses* with post-hoc explanations. Showing your
   failures is what makes the successes credible.
4. **Lineup Optimiser** — start/sit with correlation-aware simulation, showing
   win-probability delta, not just projected points.
5. **Model Lab** (Dev Hub) — experiments, walk-forward results, promotion gates,
   feature ablation. Already has backend support in `routes/model.js`.

### 5.3 Cross-cutting UI rules
- Every number carries **freshness** and **provenance**.
- Every recommendation carries **uncertainty**.
- Loading states are skeletons of the real layout, never spinners over blank space.
- No stale-data flash: keep the previous value visible, dimmed, until the new one
  resolves.
- Never expose raw JSON to an ordinary user.

---

## 6. Data contracts and leakage

Non-negotiable and partly built already (`model_feature_contracts`,
`model_evidence_manifests`, `nfl_validation_windows`, and tests asserting
"features cannot see beyond the predicted week").

- Every feature declares: source, timestamp, cutoff rule, missing-data policy,
  leakage risk.
- **Nothing published after the prediction cutoff may enter a prediction.**
- Missing critical input → **abstain or widen the interval**, never silently
  impute.
- Version datasets, features, models and predictions. Store every production
  prediction *before* the outcome is known, with its exact input vector.
- Walk-forward only. Never random-split time series.

### Known ingestion gotchas
- `nflverse.js` needs its own RFC-4180 CSV parser — naive comma splitting breaks
  because headshot URLs are quoted and contain commas.
- Join nflverse → local players on `espn_id`, **not name**. Where you must fall
  back to a name, use `services/player-identity.js` (added in this branch).
- `POST /api/stats/sync` populates `player_season_stats` and `refresh-all` does
  **not** call it. `syncGameLogs` selects targets by ordering on projected
  points, so without it the gamelog sync silently no-ops.

---

## 7. Sequence

1. Publish current accuracy (§0). No model changes.
2. Fix interval calibration (§3) — the clearest measured defect.
3. Error decomposition by position/week/usage/injury to find real weaknesses.
4. Hierarchical shrinkage (§2.1) on the largest measured gap.
5. Weekly projections + decision-value metrics (§4.3).
6. Scenario engine + role-change detection (§4.1, §4.2).
7. Projection card + Accuracy Ledger UI (§5).
8. Residual GBM (§2.5) only if 2-6 have plateaued.

Each step: measure, compare on an identical player set, permutation-null check,
then decide. **Do not proceed to the next step without a number showing the last
one worked.**
