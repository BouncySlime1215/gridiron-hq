# Gridiron HQ — Model Architecture Diagnostic & Roadmap

**Version 1.0 · 2026-08-26**

Every number in Part I was measured on this machine against this database on
2026-08-26. Nothing is recalled or estimated. Where a claim is inherited from an
earlier document rather than re-measured, it says so — and in two places below,
re-measurement **contradicts** the inherited claim.

---

# PART 0 — EXECUTIVE SUMMARY

## 0.1 What we found

Four models exist: NFL fantasy, NFL props, NFL spreads, MLB. They were built
independently and share almost nothing. The consequences are measurable:

| Finding | Evidence |
|---|---|
| The props model has **no shrinkage, no priors, no availability model** | `grep -c "shrink\|prior\|availability" nfl-props.js` → **0** |
| ...while the fantasy model beside it has all three | `projections.js` K constants, positional priors, `K.games` |
| Every shrinkage constant in the system is **hand-picked, never fitted** | 20+ inline literals; zero fitting code anywhere |
| **Nothing retrains on a schedule.** All 8 scheduled jobs are ingestion | `scheduler.js:JOBS` |
| Props and fantasy have **zero outcome-feedback loops** | `grep -c calibrat` → **0** in both |
| 87.6% of player-weeks have **no position** | 45,746 of 52,231 NULL; only QB populated |
| A **trivial blend beats the fantasy model** | blend MAE 42.10 vs model 42.68 |
| Prop TD model's problem is **discrimination, not calibration** | recalibration recovers only 3.1% of Brier loss |

## 0.2 The one-sentence diagnosis

**The system ingests data continuously but its beliefs about how to weigh that
data never update** — the entire prior↔evidence balance is frozen in roughly
twenty hand-written constants, and three of the four models have no path from a
realised outcome back into a future decision.

## 0.3 What we are building

A single **Evidence Engine** — one hierarchical, fitted, calibrated player-state
model — feeding four thin decision heads. Plus the machinery that was missing:
fitted shrinkage, scheduled retraining, per-head calibration, and a genuinely
blind five-year audit.

---

# PART I — DIAGNOSTIC (all measured 2026-08-26)

## 1. How the model makes decisions *today*

This is the most important section. Everything else follows from it.

### 1.1 The decision chain

```
raw data ──► features ──► shrinkage ──► projection ──► simulation ──► decision
             (ingested)   (HARDCODED k)              (Monte Carlo)   (gates)
```

### 1.2 The evidence-weighting primitive

Everything hinges on one function (`stats-util.js:17`):

```js
shrink(observed, prior, n, k) = (n·observed + k·prior) / (n + k)
```

- `n = 0` → pure prior
- `n = k` → 50/50 blend
- `n → ∞` → pure observation

**`k` is the single number that decides how fast a decision responds to new
evidence.** It is the whole thesis of the model, and it is guessed everywhere.

### 1.3 Every evidence-weighting constant in the system

**NFL fantasy** (`projections.js:43`) — the code's own comment calls these "a
statement rather than constants," which is exactly right, and exactly the
problem:

| Constant | Value | Claim being made |
|---|---|---|
| `K.share` | 6 | role stabilises in 6 games |
| `K.team_volume` | 10 | team pass/rush rate stabilises in 10 |
| `K.yards_per` | 34 | efficiency takes ~2 seasons |
| `K.catch_rate` | 26 | |
| `K.td_rate` | 70 | TD rate "essentially never stabilises" |
| `K.games` | 8 | availability |
| `SEASON_WEIGHT` | `{0:1, 1:0.55, 2:0.28, else 0.12}` | recency decay |

**MLB** (`mlb-projections.js`) — inline literals, no named constants at all:
`60` (TB rate), `10` (AB/game), `60` (hit rate), `120` (HR rate), `600` (opp
ER), `1000` (park), `200` (K rate), `5` (BF/start), `250` (ER rate), `500` (opp
K), `12` (first-inning). Plus a hardcoded `0.7·all + 0.3·recent` blend.

**NFL props** — no shrinkage constants, because there is no shrinkage. Instead a
hardcoded `0.65·last3 + 0.35·season` blend and raw efficiency with magic
fallbacks (`ypa ?? 7`, `ypc ?? 4.2`, `catch_rate ?? 0.65`).

**None of these are fitted.** There is no code anywhere that estimates them.

### 1.4 Why this matters mathematically

The correct empirical-Bayes shrinkage constant is not a matter of taste:

```
k* = σ²_within / σ²_between
```

where `σ²_within` is a player's own game-to-game variance and `σ²_between` is
the spread of true talent across players. Both are **directly estimable from the
52,231 player-weeks already in the database.** Nobody has estimated them.

If `k` is too high the model under-reacts to real role changes (a week-3
breakout is invisible until week 8). If too low it chases noise. The current
values may be roughly right or badly wrong — **we have no idea, because it has
never been measured.**

### 1.5 How decisions change as data arrives — the four loops

| # | Loop | Fantasy | Props | Spreads | MLB |
|---|---|---|---|---|---|
| 1 | Within-player evidence (`shrink` as n grows) | ✅ *hardcoded k* | ❌ **none** | n/a | ✅ *hardcoded k* |
| 2 | Outcome → calibration refit | ❌ **none** | ❌ **none** | ✅ | ✅ |
| 3 | Calibration → execution gate | n/a | ❌ | ✅ | ✅ |
| 4 | Scheduled automatic retraining | ❌ | ❌ | ❌ **manual route only** | ❌ **manual route only** |

**Loop 4 is empty across the entire system.** `scheduler.js:JOBS` contains 8
jobs — `mlb_schedule`, `mlb_logs`, `mlb_boxscores`, `mlb_probables`,
`mlb_tomorrow_picks`, `nfl_lines`, `nfl_line_snapshots`, `evidence_daemon`.
All eight ingest data. None refits a model. `buildCoverCalibration()` and
`buildMlbCalibration()` run only when a human hits an HTTP route.

### 1.6 The decision layer is the best part of the system

Credit where due. `staking.js:safeStakeFor()` is disciplined and evidence-driven.
It returns **zero units** unless every gate passes:

- model probability valid
- market price valid
- `calibrationPassed` — cover calibration beat the market out-of-sample
- `forwardSettled >= 250` — a real forward sample exists
- `uncertaintyWidth <= 24` points
- portfolio exposure below `maxPortfolioFraction` (0.08)

then sizes at **fractional Kelly (0.25×)**, capped at 2.5% single / 8% portfolio.

And the `TIERS` comment records a finding that *contradicts the intuitive
design*, which is exactly the behaviour we want to preserve:

```
models disagree 0-3 pts   834 bets   47.7%   z = -2.70
models disagree 3-4 pts   412 bets   51.5%
models disagree 4-5 pts   276 bets   52.2%
models disagree 5-6 pts   164 bets   47.0%
```

Tight model agreement was the **worst** bucket. The author's read is correct:
when every component agrees they are reading the same obvious signal the market
has already priced. That instinct — measure it, believe the measurement over the
intuition — is the standard the rest of the system must be raised to.

`nfl-cover-calibration.js` is similarly rigorous: walk-forward logistic offset,
with `forward_gate_passed` requiring ≥200 walk-forward samples, calibrated Brier
< market Brier, log loss ≤ market, |intercept| ≤ 0.2, slope ∈ [0.7, 1.3], and
ECE ≤ 0.05.

**The gates are excellent. The models feeding them are weak.** That is the
central asymmetry of this codebase.

---

## 2. Measured model quality

### 2.1 NFL props — walk-forward, 2022-2025

Point accuracy:

| Market | n | MAE | RMSE | Bias |
|---|---|---|---|---|
| Passing yards | 2,335 | **70.14** | 90.28 | +0.11 |
| Rushing yards | 8,621 | 16.98 | 25.09 | +0.10 |
| Receiving yards | 16,750 | 18.66 | 26.05 | +0.88 |
| Receptions | 16,750 | 1.41 | 1.88 | +0.06 |

Passing yards MAE of 70 on a ~240 mean is ~29% error. Bias is near zero
everywhere, so the errors are *variance*, not systematic offset.

Anytime-TD probability (n = 19,705):

| Metric | Value |
|---|---|
| Brier | 0.1693 |
| Log loss | 0.5884 |
| Base rate | 0.2747 |
| Uncertainty (always predict base) | 0.1992 |
| **Skill score** | **15.0%** |

Reliability curve:

| Predicted | n | Predicted | Actual | Error |
|---|---|---|---|---|
| 0-10% | 5,957 | 0.028 | **0.123** | **−9.5** (4.4× too low) |
| 10-20% | 3,569 | 0.148 | 0.182 | −3.4 |
| 20-30% | 3,019 | 0.248 | 0.237 | +1.1 |
| 30-40% | 2,298 | 0.347 | 0.289 | +5.8 |
| 40-50% | — | 0.447 | 0.366 | +8.1 |
| 50-60% | — | 0.548 | 0.431 | +11.7 |
| 60-70% | — | 0.648 | **0.526** | **+12.2** |
| 70-80% | — | 0.749 | 0.716 | +3.3 |
| 80-90% | — | 0.848 | 0.800 | +4.8 |
| 90-100% | — | 0.926 | 0.870 | +5.6 |

### 2.2 ⚠️ This contradicts `NFL_MODEL_STATUS.md`

The existing doc states the TD error is *"monotonic, so walk-forward
recalibration should fix it."* **Both halves are wrong in their implication.**

**It is not monotonic.** The sign flips: the model *under*-predicts by 9.5 points
in the 0-10% bucket, then *over*-predicts by up to 12.2 in the middle. That is
an S-shaped miscalibration.

**Recalibration will not fix it.** Brier decomposition:

```
Brier = Uncertainty − Resolution + Reliability
0.1693 =    0.1992   −   0.0350   +   0.0052
```

- **Reliability (calibration loss) = 0.0052** → only **3.1%** of current loss
- **Resolution (discrimination) = 0.0350** → the real signal

Perfect recalibration would move Brier from 0.1693 to ~0.1642. The model
explains only **17.6%** of available uncertainty. **The deficit is
discrimination, not calibration.** Recalibration is cheap and worth doing, but
it will not make props bettable. A genuinely better model will.

**The good news:** the ranking is *perfectly monotonic* —
`0.123 → 0.182 → 0.237 → 0.289 → 0.366 → 0.431 → 0.526 → 0.716 → 0.800 → 0.870`.
Every bucket's realised rate exceeds the one below it. The model **ranks
correctly and is scaled wrong**, which means the signal is real and the fix is
tractable.

### 2.3 NFL fantasy — 2025 held out, trained through 2024, 382 players

| Source | MAE | R² | Spearman |
|---|---|---|---|
| **Gridiron model** | 42.68 | **0.5902** | 0.7786 |
| **Blend (60/40)** | **42.10** | 0.5817 | **0.7791** |
| Last season points | 46.70 | 0.4509 | 0.7568 |
| Last season ppg × 17 | 58.21 | 0.2375 | 0.7395 |

**The model is beaten by a trivial blend with last season's raw points** on both
MAE and Spearman. It only wins on R². This is direct evidence the model is
*discarding* information that the raw prior still carries — almost certainly
over-shrinking somewhere (see §1.4: `k` never fitted).

Distributional accuracy (n = 150):

| Metric | Value | Target |
|---|---|---|
| CRPS | 34.79 | lower |
| Calibration error | 0.227 | → 0 |
| **80% coverage** | **0.733** | **0.80** |
| PIT histogram | `[28,19,11,9,12,13,15,13,15,15]` | flat (15 each) |

The PIT histogram is heavily front-loaded — 28 in the lowest decile against 15
expected. Actuals systematically land in the *low* percentiles of the predicted
distribution, meaning the model **over-predicts** and its intervals are **too
narrow**. Both are correctable and neither has ever been corrected, because
fantasy has no outcome-feedback loop at all.

### 2.4 NFL spreads — inherited, not re-measured

From `docs/NFL_MODEL_STATUS.md`. I did not re-run the ensemble fit (expensive);
these are the project's own recorded numbers:

- Margin RMSE: model 13.14 vs market **12.66** — market wins all five seasons
- `corr(model edge, ATS outcome) = −0.005` over 1,424 games
- 15-specialist meta-model OOS R² **−0.0167** vs shuffled null **−0.0171**
- 798 bets: 50.8%, **−24.2 units**
- After governance: 203 bets, 47.0%, **−19.7 units**

**Treat sides/totals as a solved negative result.** No amount of architecture
changes this. The market is the most efficient forecast available and we do not
beat it. Any future "improvement" here should be assumed to be overfitting until
it survives the blind audit in Part IV.

### 2.5 MLB — structurally the healthiest

Proper shrinkage against population priors with explicit cutoff discipline
(`mlb-projections.js:71` — "Population priors must obey the same cutoff as the
player history"). Park and opponent adjustments, both shrunk. A real calibration
module. Actively running: 238,949 batter-games, 97,307 pitcher-games, 12,147
games, daily boxscore settlement.

Its weaknesses are the shared ones: hardcoded constants, a private duplicate
`shrink` implementation, manual-only calibration.

### 2.6 Data assets — strong, and underused

| Table | Rows | Through |
|---|---|---|
| `nfl_snaps` | 101,290 | 2025 w18 |
| `nfl_depth` | 55,829 | 2025 w22 |
| `nfl_player_week_features` | 52,231 | 2025 w18 |
| `nfl_pfr_adv` | 25,058 | 2025 w18 |
| `player_week_usage` | 24,625 | 2025 w18 |
| `nfl_injuries` | 17,595 | 2025 w18 |
| `game_lines` | 15,096 | 2026 w18 |
| `player_gamelog` | 14,306 | 2025 w18 |
| `nfl_ngs` | 9,398 | 2025 w18 |
| `mlb_batter_games` | 238,949 | live |
| `mlb_pitcher_games` | 97,307 | live |

The player-week feature blob already carries 60+ fields including `cpoe`,
`air_yards_share`, `wopr`, `epa_neutral_wp`, `red_zone_carries`,
`goal_line_carries`, `end_zone_targets`, `yac_over_expected`,
`rec_success_rate`, `explosive_play_rate`, `two_minute_targets`.

**The props model uses almost none of them.** It reads `targets`, `carries`,
`pass_attempts` and four efficiency rates. That is the gap in one sentence.

### 2.7 Data defects blocking better modelling

1. **Position is 87.6% missing.** 45,746 of 52,231 rows NULL; only QB populated
   (`nfl-pbp.js:128` writes `position: null` and it is never backfilled).
   Positional priors are impossible for RB/WR/TE in this state.
   **The fix is free** — `nflverse players.csv` is *already downloaded* by
   `syncCrosswalk()` and contains `position`, `position_group`, `ngs_position`.
   The code reads the column and uses it only as a name-match key.
2. **838 of 1,036 players have `gsis_id`** — 19% cannot join to nflverse at all.
3. **64 duplicate player groups** remain (new ones now prevented; existing
   unrepaired — see `HANDOFF.md §3.1`).

---

# PART II — TARGET ARCHITECTURE

## 3. One engine, four heads

The four models are not four problems. Three of them are **the same latent
quantity** — a player's distribution of outcomes this week — read through
different lenses.

```
                    ┌───────────────────────────────────────┐
                    │        THE EVIDENCE ENGINE            │
                    │                                       │
                    │  hierarchical state estimate:         │
                    │    league → position → archetype →    │
                    │    player → role → this week          │
                    │                                       │
                    │  outputs a JOINT DISTRIBUTION over    │
                    │  the underlying statistical events    │
                    └──────────────────┬────────────────────┘
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
   FANTASY HEAD    PROPS HEAD    SPREADS HEAD     MLB HEAD      DFS/LINEUP
   league scoring  vs market     aggregate to     same engine,  correlated
   → points dist   line → P(o/u) team → margin    baseball      optimisation
```

### 3.1 Why this is correct, not just tidy

**Fantasy and props are literally the same forecast in different units.** The
repo already knows this — `betting-fantasy-link.js` opens with:

> *"These were solving the same problem twice. A prop projection says 'we expect
> 78 receiving yards from him this week'; a fantasy projection says 'we expect
> 13.4 points'. They are the same forecast in different units, and when they
> disagree, one of them is wrong."*

That file **reconciles two separate models**. The correct move is to **delete
the second model** and give both heads the same engine. Reconciliation then
becomes a *test that should always pass*, not a feature.

### 3.2 The strategic payoff: the market as honest referee

This is the deepest argument for unification.

Fantasy projections are graded against a soft benchmark (ADP, consensus). Props
are graded against a **live market with real money on the other side.** If one
engine feeds both, then **prop CLV becomes an unforgeable audit of the fantasy
model.**

- Fantasy model claims MAE 42.68 and R² 0.59
- If that skill is real, the same engine should show positive CLV on props
- If it shows no CLV, the fantasy "skill" is partly an artifact of a weak
  benchmark

**No fantasy platform on the market has this.** It converts an unfalsifiable
claim ("our projections are good") into a falsifiable one.

### 3.3 What each head owns

| Head | Input | Output | Graded against |
|---|---|---|---|
| Fantasy | joint dist + league scoring | points distribution, VOR, start/sit | realised points, decision regret |
| Props | joint dist + market line | P(over), edge vs de-vigged price | CLV, then P&L |
| Spreads | aggregated team dist | margin distribution | closing line (expect: no edge) |
| MLB | same engine, baseball events | same shapes | CLV, calibration |

Shared, owned by neither: shrinkage, calibration, market pricing, evidence
manifests, the registry, the audit.

---

## 4. The Evidence Engine

### 4.1 Hierarchical state, not flat regression

```
league prior
  └─ position prior          (QB/RB/WR/TE differ structurally)
      └─ archetype prior     (slot WR ≠ X receiver ≠ gadget)
          └─ player talent   (multi-season, recency-decayed)
              └─ current role (this season, changepoint-aware)
                  └─ this week (opponent, script, weather, availability)
```

Each level shrinks toward its parent by a **fitted** amount. This is what lets a
rookie with three games get a sane projection, and what lets a player who
changed teams keep his archetype prior while losing player-specific role weight.

### 4.2 Structural decomposition — project the chain, not the outcome

```
team plays → pass/rush split → player opportunity share
           → efficiency per opportunity → events → fantasy points / prop outcome
```

Every arrow is separately testable, and every error becomes **attributable**.
This is the mechanism behind the "why did this change" UI, and it is why a pure
black-box GBM is the wrong top-level architecture.

### 4.3 Fitted shrinkage — the single highest-value fix

Replace all ~20 hardcoded constants with estimates:

```
k*_metric,position = σ²_within / σ²_between
```

Estimated per metric per position from the 52,231 player-weeks, **strictly from
data before the prediction cutoff**. Store as a versioned artifact in the model
registry so every projection records which `k` vector produced it.

**Acceptance test:** fitted `k` must beat hand-picked `k` on held-out CRPS. If it
does not, we keep the constants and we have *learned that they were fine* —
which is itself worth knowing, and is currently unknown.

**Prediction:** this alone should fix a meaningful part of both the 0.733
coverage gap and the "trivial blend beats the model" result, because both are
symptoms of mis-set shrinkage.

### 4.4 Role-change detection (changepoint)

The largest projection errors are role changes, not efficiency misses. Run an
online changepoint detector on snap share / route participation. When recent
usage is statistically inconsistent with the player's prior, **down-weight the
prior** — i.e. locally reduce `k`.

This is the direct answer to *"work off week-to-week changes without factoring
in overall bias"*: the model reacts fast when there is real evidence of change,
and stays anchored when there is not. **Adaptivity becomes evidence-driven
rather than a hardcoded recency weight.**

### 4.5 Availability as a first-class distribution

Split into two quantities, never one:

- `P(plays)` — from `nfl_injuries` practice status as an **ordinal** signal
  (DNP < LP < FP), report status, and injury history
- `E[snap share | plays]` — a questionable RB at 60% snaps is a different
  projection from one with a 60% chance of full snaps

Rules already learned and which must hold: availability is **share of team games
played**, not average of games appeared in (else backups project as starters);
QBs need an attempt-share cap (winner-take-all).

---

## 5. Data layer — 29 verified live sources

All HTTP-verified on 2026-08-26. ✅ = returns 200 right now.

### 5.1 nflverse release feeds (free, no key, auto-updated)

| # | Source | Gives us | Status |
|---|---|---|---|
| 1 | `players` | **position**, draft round/pick, experience, height/weight, 6 ID crosswalks | ✅ *already downloaded, position unused* |
| 2 | `pbp` | full play-by-play | ✅ |
| 3 | `pbp_participation` | **personnel groupings, snap participation** | ✅ *unused* |
| 4 | `nextgen_stats` | separation, cushion, time-to-throw, xYAC | ✅ |
| 5 | `ftn_charting` | **manual charting: motion, play action, screens** | ✅ *unused* |
| 6 | `pfr_advstats` | pressures, broken tackles, YAC/YBC | ✅ |
| 7 | `snap_counts` | snap share | ✅ |
| 8 | `depth_charts` | `pos_rank`, `pos_slot` — depth role | ✅ |
| 9 | `injuries` | **practice status DNP/LP/FP, report status** | ✅ |
| 10 | `weekly_rosters` | week-accurate roster/status | ✅ *unused* |
| 11 | `draft_picks` | draft capital | ✅ |
| 12 | `combine` | athletic testing | ✅ *unused* |
| 13 | `schedules` | schedule + results + rest days | ✅ |
| 14 | `contracts` | **OTC contract value — economic signal** | ✅ *unused* |
| 15 | `officials` | **referee crew tendencies** | ✅ *unused* |
| 16 | `espn_data` | ESPN ID crosswalk | ✅ |

### 5.2 Modelled external feeds

| # | Source | Gives us | Status |
|---|---|---|---|
| 17 | **ffopportunity** (`ffverse`) | **expected fantasy points (xgboost), 2006→** | ✅ *unused — strong benchmark AND feature* |
| 18 | Sleeper `/players/nfl` | cross-platform IDs, status | ✅ |
| 19 | Sleeper `/trending/add` | **waiver//market attention signal** | ✅ |
| 20 | FantasyCalc | market values, dynasty/redraft | ✅ |
| 21 | FFC ADP | draft market consensus | ✅ |
| 22 | Open-Meteo | **wind/precip by stadium, free, no key** | ✅ |
| 23 | ESPN scoreboard | live game state | ✅ |
| 24 | ESPN news | injury/news text | ✅ |
| 25 | ESPN core athletes | roster/bio | ✅ |
| 26 | Sleeper `/state/nfl` | season/week state | ✅ |

### 5.3 Betting & MLB

| # | Source | Gives us | Status |
|---|---|---|---|
| 27 | The Odds API | lines, **`us,eu` for Pinnacle** | ⚠ needs `ODDS_API_KEY` (unset) |
| 28 | MLB StatsAPI | official schedule/box/probables | ✅ |
| 29 | **Baseball Savant Statcast** | **exit velo, launch angle, xwOBA, barrel%** | ✅ *unused — major MLB upgrade* |

### 5.4 Source discipline

Every source registers in `nfl_source_registry` with: update cadence, cutoff
semantics, licence, failure mode, and **staleness budget**. A source that misses
its budget degrades the projection's confidence rather than silently serving old
numbers.

---

## 6. Feature engineering

### 6.1 Opportunity (dominant, most predictable)

**Receiving:** route participation rate (more stable than target share), targets
per route run, air-yards share, aDOT, WOPR, **end-zone target share** (separate
from red-zone — that is where TDs live), slot/wide/inline rate, motion rate
(ftn), screen share.

**Rushing:** carry share, **inside-10 and inside-5 carry share separately**,
early-down vs third-down vs two-minute snap share, goal-line back identity
(near-binary, dominates TD variance), YBC/YAC, broken-tackle rate. Model the
**backfield as a unit**, then allocate.

**Passing:** dropbacks, aDOT, pressure rate faced, time to throw, **designed
rush attempts** (the single largest QB fantasy differentiator), play-action rate.

### 6.2 Efficiency (regress hard, fitted k)

YPRR, yards per target, catch rate over expected, YPC, TD rate per opportunity
**split by field-position bucket**, EPA/CPOE, YAC over expected.

### 6.3 Context

Pace, neutral-script pass rate, **implied team total** (best single game-context
variable), spread × pace interaction, opponent positional funnel (shrunk,
player-relative — the method already correct in `matchups.js`), coverage/pressure
tendency, **wind** (the only weather variable with reliable fantasy effect — do
not overfit temperature), rest/travel/short week, **referee crew** (penalty and
pace effects).

### 6.4 Economic and market features

- **Contract value / guaranteed money** (source 14) — teams protect investments;
  a highly-paid back gets goal-line work
- **Draft capital** (source 11) — organisational commitment, strongest rookie prior
- **ADP / FantasyCalc** (20, 21) — crowd belief, and the *residual* vs our model
  is itself a feature
- **Sleeper trending** (19) — attention flow, leading indicator of role news
- **ffopportunity expected points** (17) — an independent model's opinion, both
  a feature and a benchmark to beat

---

## 7. Machine learning methodology

### 7.1 Model families, in the order to try them

1. **Structural + fitted hierarchical shrinkage** — the backbone. Explainable,
   robust at small n, gives real distributions.
2. **Gradient-boosted residual model** *on top of* the structural projection.
   Learns what structure misses. **Never replaces it** — a pure GBM loses
   attribution and gains little.
3. **Quantile regression** for tails specifically (the 0.733 coverage problem is
   a tail problem).
4. **Distributional/NGBoost-style** — predict parameters, not points.
5. **Mixture models** for genuinely bimodal outcomes (goal-line back: 0 or 2 TDs).

### 7.2 Where LLMs genuinely help — and where they must not

**Legitimate:**
- **Unstructured → structured**: beat-writer text, injury reports, press
  conferences → typed role signals with confidence and provenance
- **Changepoint narration**: explain *why* usage shifted (scheme change? injury
  upstream?) — this is genuine causal context a regression cannot see
- **Anomaly triage**: flag when the model's inputs look wrong
- **Explanation generation** from an *already-computed* additive decomposition

**Forbidden:**
- LLM output as a numeric feature without calibration
- LLM prose presented where a model number belongs
- Any LLM-produced number entering a stake calculation

**Hard rule:** model-generated evidence and LLM commentary must be visually and
structurally separate, always. The `nfl-ai-replay` tables and
`services/nfl-reasoning.js` already exist for this; keep them on the commentary
side of the line.

### 7.3 Ensembling

Ensemble at the **distribution** level, not the point-estimate level. Weights
fitted walk-forward. Carry the `TIERS` lesson forward: **do not upgrade
confidence when components agree** — that was measured to be the worst bucket
(z = −2.70).

---

## 8. Game theory and economics

### 8.1 Drafts are a sequential game, not a ranking

Current draft assist ranks players by value and cost-of-waiting. That is
decision-theoretic but not **game-theoretic** — it does not model opponents as
strategic agents.

Build:
- **Opponent need modelling** — each rival's roster implies a positional demand
  curve
- **Best-response drafting** — pick to maximise *my* value net of what survives
  to my next pick, given rivals draft to their needs
- **Positional run dynamics** — runs are correlated-equilibrium cascades; the
  existing `goneBy()` logistic is a reduced form of this and can be derived
  properly
- **Auction/value theory** for auction leagues: bid shading, winner's curse

### 8.2 Trades are bilateral bargaining

- **Surplus split**: compute the joint gain and where each side's reservation
  value sits
- **Acceptance likelihood** from the opponent's *own* roster-need model, not a
  generic fairness score
- Never propose a trade that is roster-illegal or leaves a starting hole (the
  existing `evaluate()` already enforces this — keep it)

### 8.3 Betting markets are an economics problem

- **Fair value = de-vigged sharp consensus**, not our opinion
- **Edge = our price vs fair value**, not our number vs the line
- **Market microstructure**: line origination, steam, reverse line movement,
  stale recreational books (Pinnacle in `eu` region — known)
- **Adverse selection**: if a soft book lets you bet, ask *why*
- **Kelly** only above ~55% demonstrated win rate; flat 1u = 1% otherwise

### 8.4 Lineup construction is correlated optimisation

`correlation.js` already has QB-WR 0.199, QB-TE 0.180, QB-QB(opp) 0.144, scaled
by target share. Extend to RB-DEF (same team, game script), WR-WR (negative,
cannibalisation), player-vs-own-DEF. Optimise the **distribution of outcomes**,
not expected points — for a favourite you want floor, chasing you want ceiling.

---

# PART III — CALIBRATION, ADAPTIVITY, HONESTY

## 9. Uncertainty and calibration

Three variance sources must **all** be present. Currently only the first is:

1. **Outcome noise** — week-to-week variance given fixed role ✅
2. **Parameter uncertainty** — we don't know true talent; needs a log-normal
   level draw ❌ *(recorded: without this an 80% interval covered ~33%)*
3. **Role/availability uncertainty** — beta-binomial games + discrete role
   scenarios ❌

**Every head reports:** reliability diagram, PIT histogram, CRPS, and coverage
at 50/80/90/95 — not one number.

**Acceptance: 80% coverage ∈ [0.78, 0.82] on held-out data.** Currently 0.733.

Per-head recalibration (isotonic or Platt, walk-forward, versioned) runs on a
**schedule**, not a route.

## 10. Week-to-week adaptivity without bias

The explicit requirement: *adapt to weekly change without absorbing overall
bias.* Four mechanisms:

1. **Evidence-proportional updating** — `shrink` with *fitted* `k` moves prior →
   observed at the statistically correct rate. Not a hand-set recency weight.
2. **Changepoint-gated prior decay** — `k` drops locally *only* when a detector
   fires on genuine role change. Fast when justified, anchored otherwise.
3. **Bias monitoring as a first-class metric** — track signed error by week,
   position, team, and usage class continuously. A drifting signed error is a
   *bug alarm*, not a tuning opportunity.
4. **Strict separation of adaptation from evaluation** — adaptation uses only
   pre-cutoff data. The audit (Part IV) never sees adapted parameters fitted on
   its own window.

**Anti-pattern explicitly banned:** tuning constants until last week looks good.
That is how the `maxDisagreement = 4.5` filter got "holdout validated" and
remained noise.

---

# PART IV — THE BLIND FIVE-YEAR AUDIT

## 11. Why the current setup is not yet blind

The registry has real infrastructure — `model_experiments`, sealed holdout,
promotion gates, `nfl_validation_windows`, leakage tests. But:

- Constants were chosen by humans who had **already seen all five seasons**
- Nothing prevents iterating against the "held-out" season and re-running
- No cryptographic seal on the pre-registration

## 12. Protocol

### 12.1 Pre-registration (before any data is touched)

Write and **hash** a specification containing: feature list, model family,
hyperparameter search space, shrinkage estimation method, calibration method,
decision rules, and the metrics that constitute success. Store the hash in
`model_experiments` with a timestamp. **The spec cannot change after the seal.**

### 12.2 Data partition

```
2016-2020  TRAIN        — freely usable
2021       VALIDATE     — hyperparameters only
2022-2025  SEALED       — opened one WEEK at a time, never re-used
2026       FORWARD      — the real out-of-sample, also graded week by week
```

### 12.3 Opening rules — by week, not by season

**Season-level opening was the original design; it is wrong, and this replaces
it.** The model runs every week in production, deciding start/sit and bet sizing
with only the data that exists *that Tuesday*. An audit that hands it a whole
season at once tests a task the model never actually performs, and it can only
report one aggregate number for 18 weeks of very different conditions.

Instead, within each sealed season, replay week by week:

```
for season in [2022, 2023, 2024, 2025]:      # sealed seasons, in order
  for week in 1..18:
    cutoff = everything strictly before (season, week)
    prediction = model(cutoff)                # only data through last week
    actual = reveal(season, week)              # unlock this week's results
    record(prediction, actual, cutoff)          # logged, irreversible
    # week's actual data now becomes part of "cutoff" for week+1
```

- Weeks open **one at a time, chronologically, within each sealed season**
- Each opening is **logged, irreversible, and attributed** — same guarantee as
  before, at finer grain (`nfl_validation_windows` already models a cutoff;
  extend it to week granularity)
- **A week, once opened, can never be used to select a model again** — including
  by a later week's hyperparameter choice
- This is mechanically the same discipline `propAccuracy()` already uses
  ("each player-week is projected only from earlier games") — the audit simply
  applies it as the *scoring unit* instead of only the *fitting unit*

### 12.4 Weekly fault analysis — examine failures where they happen, not after the season

After each week's predictions are scored, before moving to the next week, run a
fault pass:

- **Where did it miss, and by how much** — worst 10 misses that week, by player
- **Why** — attribute each miss to a structural link (§4.2): opportunity wrong,
  efficiency wrong, availability wrong, or a genuine surprise (injury mid-game,
  coaching change, weather) no model could have had
- **When in the season** — plot error by week number across all four sealed
  seasons. A model that is fine in weeks 1-10 and degrades in 11-18 has a
  specific, fixable problem (playoff-race game script? divisional-round
  familiarity? roster churn from injuries compounding?) that a single
  end-of-season number would hide entirely
- **Bye weeks, short weeks, and national-TV games** get their own slice — these
  are exactly the conditions a season-aggregate metric averages away

The output is a **week-by-week fault ledger**, not just a season scorecard:
`(season, week, player, predicted, actual, error, attributed_cause)` for every
graded player-week across all four sealed seasons — over 27,000 rows if
every active player-week is scored. That ledger is the real deliverable of the
audit; the aggregate MAE/Brier/CRPS numbers in §12.5 are a summary of it, not a
replacement for it.

#### Grade against what the game actually became, not just the stat line

A missed prediction and a *misunderstood* game are different failures, and the
ledger must be able to tell them apart. For every graded player-week, attach
the game's own realised context alongside the player's stat error:

- **Final score and margin** — was this a blowout? A player projected for volume
  who got pulled in the fourth quarter of a 35-point win was a *game-script*
  miss, not a role miss — the opportunity model should have seen the spread and
  discounted second-half volume, and if it didn't, that is the specific bug.
- **What game script the model assumed vs what happened** — the projection
  already carries an implied script (§1.5, `pass_mult`/`rush_mult` from
  `gameScriptFor`). Compare that assumption to the realised play-by-play pass
  rate. A big miss with the assumed script *correct* is an efficiency or
  availability failure; a big miss with the assumed script *wrong* is a
  game-theory failure — the projection trusted a pre-game line that the game
  itself invalidated in the first quarter.
- **In-game events with no pre-game signal** — an injury during the game, an
  ejection, a weather shift, a blowout that started a running-clock — these are
  logged as **unmodelable-in-advance**, separately from misses the pre-game data
  should have caught. A model should never be penalised the same way for a
  freak in-game injury as for ignoring a Wednesday DNP report that was sitting
  in `nfl_injuries` the whole time.

This is what makes the audit **learn**, not just score: the attributed-cause
column feeds directly back into Stage 3's calibration jobs (build order,
Stage 3.2-3.3). "Game-script misses cluster in blowout-favourite spots" is an
actionable finding that changes a feature; "MAE was 42.7" is not.

### 12.5 What gets reported (all of it, always)

Everything in the weekly fault ledger (§12.4), rolled up two ways:

1. **By week-in-season** (week 1 vs week 2 vs ... vs week 18), across all four
   sealed seasons — this is the primary view, since it is what actually
   happened to the model's own decisions over time
2. **By the usual slices** — season, position, usage class, injury status,
   confidence bucket

Per slice: MAE, RMSE, bias, R², Brier, log loss, CRPS, reliability, PIT,
coverage at four levels, rank correlation, **start/sit regret, waiver regret,
draft value error**, and CLV where a market exists. Plus **statistical
uncertainty on every metric** and the worst misses with their attributed cause
from §12.4.

### 12.6 Baselines that must be beaten

Every claim is relative to: (a) always-predict-base-rate, (b) last-season
points, (c) the 60/40 blend that currently beats us, (d) market/ADP consensus,
(e) **ffopportunity expected points**, (f) a **shuffled-null permutation**. All
six are computed on the **same weekly cadence** as the model, not once per
season, so the comparison is to what each baseline would have told you *that
week*, not what it says in hindsight.

### 12.7 The null test is mandatory

For any claimed edge, re-run with shuffled labels, **at the same weekly
cadence**. If the real result is not clearly outside the null distribution,
**there is no edge.** This is what correctly killed the 15-specialist
meta-model (R² −0.0167 vs null −0.0171).

### 12.8 Promotion gates

No model reaches production without: sealed-holdout performance beating all
baselines; calibration within tolerance; a permutation-null result; **N ≥ 250
shadow decisions with positive CLV** where a market exists; and reproducibility
from the pinned dataset + code hash.

---

# PART V — EXECUTION

## 13. Roadmap

### Phase A — Foundations *(no model changes; everything else depends on these)*
1. **Backfill position** from the already-downloaded `players.csv`. Unblocks
   positional priors for 87.6% of rows. Highest value-to-effort in the document.
2. Raise `gsis_id` coverage above 838/1,036.
3. Publish the current accuracy report as a **frozen baseline**.
4. One `shrink` implementation; delete MLB's private copy.
5. Source registry with staleness budgets.

### Phase B — The Evidence Engine
6. **Fit the shrinkage constants.** Compare fitted vs hardcoded on held-out CRPS.
7. Hierarchical state estimator.
8. Parameter + availability uncertainty → fix 0.733 coverage.
9. Changepoint detector.
10. **Delete `nfl-props.js:projectPlayer` and point the props head at the
    engine.** Re-run `propAccuracy` — expect a material MAE drop from
    shrinkage alone.

### Phase C — Heads and feedback
11. Fantasy head on the engine; must beat the 60/40 blend.
12. Props head + **scheduled walk-forward recalibration**.
13. Spreads head — expect no edge; the value is a fair, unified comparison.
14. MLB head on the shared engine + **Statcast** ingestion.
15. **Add retraining jobs to `scheduler.js`.** Close loop 4.

### Phase D — Advanced
16. New feature families (participation, ftn charting, contracts, officials).
17. Residual GBM, only if B–C plateau.
18. Game-theoretic draft and trade layers.
19. LLM structured-extraction layer, strictly gated.

### Phase E — The audit
20. Pre-register and seal.
21. Run the five-year blind audit.
22. Publish everything, including failures.

## 14. Success criteria

| Metric | Now | Target |
|---|---|---|
| Fantasy MAE (2025 holdout) | 42.68 | **< 42.10** (beat the blend) |
| Fantasy 80% coverage | 0.733 | **0.78-0.82** |
| Fantasy PIT | `[28,19,11,...]` | flat |
| Props pass-yds MAE | 70.14 | ~~< 60~~ → **beat own season-to-date avg, 90% CI excluding zero** (met: 59.77 vs 63.33, CI [-4.67,-2.49]) |
| Props rush/rec-yds, receptions | unmeasured | **same baseline-relative gate** (all met — see `BUILD_ORDER.md` §2.2) |
| Props TD Brier | 0.1693 | *superseded by skill score — Brier is not comparable across populations with different base rates* |
| Props TD skill score | 15.0% | **> 22%** (now measured per market: anytime-TD 6.2% broad / 4.0% market-eligible; 2+ TD 27.1%; **interceptions −1.6%, i.e. worse than base rate**) |
| Prop CLV | unmeasured | **positive median over ≥200 bets** |
| Spreads | no edge | *unchanged — do not chase* |
| Scheduled retraining jobs | **0** | ≥ 4 |
| Models with feedback loops | 2 of 4 (manual) | **4 of 4 (scheduled)** |

## 15. Honest limits

1. **Sides/totals will not become profitable.** Four independent tests say so.
   Unification does not change market efficiency. Any apparent improvement here
   should be treated as overfitting until it clears the blind audit.
2. **Props are a real but unproven lead.** Ranking is sound (monotonic
   reliability), discrimination is weak. Recalibration recovers only 3.1%.
   The engine rebuild is the actual bet, and it may still not clear the vig.
3. **A better fantasy model is near-certain; a profitable betting model is not.**
   The fantasy benchmark is soft, the betting benchmark is the sharpest market
   in sports. Expect the fantasy work to pay off and treat any betting edge as a
   hypothesis under test.
4. **This is a large build.** Phase A is days. Phase B is the real work. Phases
   C-E are months. Sequencing matters more than speed: every phase must show a
   measured improvement before the next begins.
5. **The gates must never be loosened to let a model through.** If the model
   cannot pass `safeStakeFor`, the answer is a better model, not a lower bar.
   That discipline is currently the single best thing in this codebase.
