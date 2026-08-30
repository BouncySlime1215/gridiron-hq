# Work log

One consolidated record of what was done, what it measured, and what is still
open. Replaces the per-agent handoff documents (`CLAUDE_FEEDBACK.md`,
`CODEX_REVIEW.md`, `docs/HANDOFF*.md`) that accumulated one file per
conversation and drifted out of sync with the code.

Plans and specs are **not** here and are not superseded by this file:
`docs/BUILD_ORDER.md`, `docs/MODEL_ROADMAP.md`, `CODEX_SUGGESTIONS.md`, and
the `docs/PHASE_*.md` / `docs/UI_REVAMP.md` briefs describe intended work.
`docs/STAGE_1_RESULTS.md` and `docs/STAGE_2_RESULTS.md` are evidence records
that gates cite directly.

---

## 2026-08-27 — model evaluation: gates, metric coverage, candidate search

### 1. The `<60 MAE` passing-yards gate was not a real bar

`BUILD_ORDER.md` §2.2 and `MODEL_ROADMAP.md` §14 both set "props passing-yards
MAE < 60" as the target. That number came from the *previous* model's 70.14
MAE — it measured "better than the thing we replaced," not "has predictive
skill." Measured against baselines that actually represent no-skill:

| Predictor | MAE |
|---|---:|
| Always guess the league mean (222.6 yds) | 61.13 |
| Each QB's own season-to-date average | 60.46 |
| Current model | 59.30 |

Clearing `<60` was compatible with beating a constant guess by ~3%.

**Replaced with a significance-tested gate.** `passingYardsGateTest()` in
`server/services/nfl-props.js` runs the paired bootstrap already used for the
Stage 1 CRPS question (`backtest-significance.js`) against each QB's own
walk-forward season-to-date average. A candidate passes only if it beats the
baseline **and** the 90% CI on the difference excludes zero — a lower raw MAE
on a lucky sample is not enough.

Current model, 2022–2025, n=1530 aligned player-weeks:

- model 59.77 MAE vs baseline 63.33 MAE
- 90% CI on the difference **[-4.67, -2.49]**, excludes zero
- model better in 2000/2000 bootstrap resamples
- **verdict: real edge, ~5.9% over the baseline**

So the model does have genuine skill — but that is now demonstrated rather
than implied by clearing an arbitrary threshold.

**Extended to all four prop stats** (`baselineGateTest(metric, seasons)`,
`allBaselineGates()`). Each player's baseline records only weeks he actually
featured in, so it is an average over real games rather than being dragged to
zero by inactive weeks. All four pass on 2022–2025:

| metric | n | model MAE | baseline MAE | 90% CI on difference | passes |
|---|---:|---:|---:|---|---|
| passing yards | 1530 | 59.77 | 63.33 | [-4.67, -2.49] | yes |
| rushing yards | 3347 | 24.14 | 25.17 | [-1.33, -0.73] | yes |
| receiving yards | 9255 | 21.54 | 22.70 | [-1.33, -1.01] | yes |
| receptions | 9255 | 1.585 | 1.659 | [-0.085, -0.063] | yes |

`BUILD_ORDER.md` §2.2 and `MODEL_ROADMAP.md` §14 now cite this gate rather
than the flat `<60`.

### 2. Graded metrics: 5 → 25

`propAccuracy()` graded 4 point metrics + 1 probability. The simulator already
produced the underlying draws for far more; they were computed and discarded.
Now graded (`POINT_METRIC_KEYS` / `PROBABILITY_METRIC_KEYS`):

- **18 point metrics** — yards and receptions as before, plus pass attempts,
  carries, targets, TDs by type, interceptions, total touches/yards/TDs, and
  four efficiency rates (yards per attempt / carry / target / reception).
- **7 probability metrics** — anytime TD as before, plus per-type TD
  probability (passing, rushing, receiving separately), interception
  probability, any-type TD, and 2+ TD.

Both broad and pregame-market-eligible populations, as before, so abstention
cannot masquerade as accuracy. `touchdown_probability` and `point_metrics`
keys are unchanged for backward compatibility.

*Bug found and fixed while building this:* the market-eligible slice for
`receiving_tds` / `total_touches` / `total_yards` / `total_tds` returned
`n: 0` — the market-side aggregation was never wired for those four.

### 3. Candidate search: 564 candidate/target combinations, zero survivors

Two searches, both through the existing discovery → redundancy pruning →
paired sign-flip test → Holm correction pipeline. 2025 stayed sealed
throughout; nothing earned opening it.

**a. Player-history heads** — `nfl-prop-head-validation.js` generalizes the
24-head fantasy-points registry (`player-head-registry.js`) to prop stats,
reusing the primitives from `player-head-validation.js` rather than a second
copy that could drift. `active_champion` is the structural estimate, i.e. what
actually ships today, not an easier baseline.

| Metric | Structural MAE | Best candidate | Survivors |
|---|---:|---:|---|
| Passing yards | 67.02 | 66.09 | none — rank quality worse |
| Rushing yards | 16.97 | 16.95 | none — p=0.42 |
| Receiving yards | 17.64 | 17.58 | none — p=0.18 |
| Receptions | 1.374 | 1.373 | none — p=0.44 |

**b. Context heads** — `nfl-context-heads.js`, 141 candidates per metric:
opponent defense-vs-position × 10 weights × 8 shrinkage constants, plus
home/away, rest, and weather variants. 141 × 4 metrics = **564 combinations**.

Opponent DvP reuses `matchups.js`'s leave-one-out + shrinkage design but is
rebuilt **cutoff-safe** (prior seasons only). `matchups.js:dvpFor` aggregates
the whole current season with no per-week cutoff — correct for live use, a
look-ahead leak in a backtest. `matchups.js` was left untouched because the
live Matchups/My Team pages depend on it.

| Metric | Structural MAE | Pruned as redundant | Best survivor | p | Holm |
|---|---:|---:|---|---:|---|
| Passing yards | 70.56 | 131/141 | weather | 0.20 | fail |
| Rushing yards | 16.50 | 138/141 | rest | 0.22 | fail |
| Receiving yards | 17.43 | 138/141 | weather | **0.041** | fail (bar 0.025) |
| Receptions | 1.361 | 138/141 | home/away | 0.14 | fail |

Three findings worth keeping:

1. **Redundancy pruning removed 131–138 of 141 per metric.** Varying weight
   and shrinkage inside one signal family produces near-identical predictions;
   those were never independent tests. This is why a large grid stays honest —
   most of it collapses before any significance budget is spent, and Holm
   corrects across whatever survives, so more candidates means a *stricter*
   bar, not a looser one.
2. **Opponent DvP actively degrades point prediction at higher weights** —
   passing-yards MAE 70.56 → 90.81 at full weight, consistently across all
   four stats. A real negative result: matchup strength is useful for the
   app's fantasy *decision* surfaces (start/sit, trade value) but does not
   improve individual-player point forecasts here. Prediction accuracy and
   decision usefulness are different questions.
3. **Weather on receiving yards reached p=0.041** — significant at an
   uncorrected bar, rejected only under Holm given the batch size. Worth
   retesting as more seasons accumulate rather than treating as closed.

**Net:** no simple recency/blend head and no context signal (opponent,
weather, rest, home/away) beats the structural estimate at a statistically
real level on this data. The structural model is at the ceiling of what this
class of adjustment offers. A genuine next gain needs a different kind of
signal — participation/snap-share, injury designations, personnel packages —
which is what `MODEL_ROADMAP.md` Phase D already anticipated.

### 4. Weekly-distribution gate reconfirmed

Refit `WEEKLY_LEVEL` (`projections.js`) on 2023+2024, validated on 2025, after
the identity-coverage repair, to check the earlier CRPS wobble:

| | coverage (gate .78–.82) | calibration error | CRPS |
|---|---:|---:|---:|
| shipped | 0.725 | 0.157 | 3.170 |
| refit | **0.791** | **0.095** | 3.169 |

`sigma: 0.45, downMult: 1` remains best. No code change needed; the earlier
0.002 CRPS concern was on the fit-season sweep, not the validation run that
decides adoption.

### 5. `STAGE_2_RESULTS.md` was stale

It still reported the pre-fix numbers as current. Corrected, with the original
figures kept as the "before" column: coverage 83.24% → **97.34%** (an nflverse
importer defect discarding ~10–12k player-weeks/season, not cold-start
uncertainty), broad passing-yards MAE 67.72 → **59.28** (the QB participation
fix — attempts had been split across every QB on a roster, suppressing clear
starters 10–40%), broad TD Brier 0.1588 → 0.1531, market-eligible TD Brier
0.2014 → 0.1955.

---

## Verification

`npm run check` green after every change above: **199/199 tests**, typecheck,
production build, isolated-database startup smoke.

### 6. The "market-eligible TD calibration is red" item was two measurement bugs

It was carried as the last unresolved red item from Stage 2. Investigating it
found no model defect in the place the gate pointed, and two real reporting
defects instead.

**a. Brier was compared across populations with different base rates.** Broad
0.1531 vs market-eligible 0.1955 read as "the eligible model is much worse."
But the eligible population's TD base rate is 28.5% against the broad
population's 20.5%, and a higher base rate raises the achievable Brier floor
(climatology 0.2037 vs 0.1632). Against each population's own climatology the
gap is 6.2% vs 4.0% skill — real, but a fraction of what the raw numbers
implied. `brier_skill` and `base_rate` are now reported on every probability
metric, which makes them comparable.

This immediately surfaced something the 5-metric view could not see:
**interception probability has negative skill (−1.6%)** — it is worse than
simply predicting the base rate. `pass_td` is only marginally better (+2.3%).
The best-performing markets are 2+ TD (27.1%) and any-type TD (20.3%).

**b. The audit grades a model production does not ship.** A calibrator is
active (`ensemble-global-position`, fit through 2025) and `propBoard` and the
pick generator both route anytime-TD through `calibrateAnytimeTd`. But
`propReplayRows` computes raw probabilities and never calls it — so every
"TD calibration" number in the audit describes the pre-calibration model.
Same class of bug as the earlier "audit grades standalone opportunity while
production uses joint team simulation" defect.

Deliberately **not** resolved by applying the active calibrator in the replay:
it is fit through 2025, so applying it to a 2022–2025 replay would leak the
outcome seasons into their own grade. `propAccuracy().probability_calibration`
now reports the discrepancy, what is graded, and why, rather than silently
picking a side.

### 7. Adaptation: week-to-week is solid, offseason was a blind spot

**Week-to-week already works** and needed no change. Role/volume memory decays
on a five-week half-life within the season, prior seasons are discounted 95%
(`WEEKLY_ROLE_RECENCY.seasonDecay = 0.05`), the weekly ensemble reweights per
position, and `role-changepoint.js` promotes a sustained usage shift only once
**snap share corroborates it** — it will not chase two loud box scores.

**Correction to an earlier claim in this log:** snap-share data is NOT missing.
`player_week_snaps` has 26,647 rows and `nfl_snaps` 101,290. It is used as
corroboration inside role-change detection but never as a direct input to the
volume model, which is a real gap — but a different one from "we don't have
the data."

**Offseason was genuinely unmodelled.** The engine reads a player's current
team label and heavily discounts old seasons, but nothing asked what his new
offense implies. Heavy decay is a blunt substitute: it distrusts a returning
three-year starter exactly as much as a player who just changed teams, and
says nothing about opportunity a departing teammate left behind.

`nfl-offseason-change.js` derives both from `player_week_usage` (no new data
source): who changed teams, and each team's **vacated** target/carry share.
The spread is large and entirely ignored today — entering 2025, Houston had
50.5% of its targets leave the building; the Giants had 0%.

Measured effect on opportunity per game, season over season (median ratio):

| position | changed teams | stayed | n moved / stayed |
|---|---:|---:|---|
| WR | 0.743 | 0.956 | 126 / 306 |
| RB | 0.776 | 0.948 | 59 / 198 |
| TE | 0.821 | 0.986 | 52 / 181 |
| QB | 0.897 | 0.981 | 40 / 90 |

Every skill position, same direction. First-year players (no prior-season
usage) also receive materially less opportunity than returning players at
every position except TE in 2025.

**It was then validated rather than assumed**, factors fit on 2023+2024 and
applied to 2025 weeks 2–5 (narrow by design: with season decay at 0.05, an
offseason signal can only act before current-season history accumulates):

| | unadjusted MAE | adjusted MAE | 90% CI | improves |
|---|---:|---:|---|---|
| all players | 3.202 | 3.169 | [-0.064, -0.0008] | yes |
| movers only | 4.404 | 4.255 | [-0.295, -0.0018] | yes |

**This is the first candidate signal in this whole effort that passed** — but
it passed narrowly: both CI upper bounds sit within 0.002 of zero. Real, small,
early-season only. Fit factors put the effect in WR (0.76) and RB (0.80); QB
and TE come out ≈1.0, and the FB factor (1.79) is small-sample noise that
should not be shipped.

**Not wired into production.** It is validated as an opportunity forecast, not
yet as a projection adjustment, and given how narrow the margin is it should
go through the normal head-registry gate before it touches a user-facing
number.

#### Coaching changes cannot be measured on this data

`nfl_teams` carries `head_coach` / `oc_name` / `off_scheme`, but as a single
current snapshot with **no season dimension** — there is no record of who
coordinated which offense in 2022, so no historical coaching-change effect is
computable. `coachingSnapshot()` records the current staff so a change history
starts accumulating; until two snapshots exist an offseason apart, it reports
`comparable: false` and nothing should apply a coaching adjustment. An effect
that cannot be measured does not get a coefficient.

#### Schedule / opponent change

`schedule_games` holds 2026 only (544 rows), so historical schedule strength
comes from usage data. Opponent strength was already tested directly (§3b,
defense-vs-position across 80 weight/shrinkage variants) and **actively
degraded** point prediction. Schedule difficulty remains useful for the
fantasy decision surfaces; it is not a prediction-accuracy input.

### 8. What actually improved the model, and what did not

Two real defects were found and fixed. Everything else tested was rejected on
evidence.

**Fixed — a biased estimator behind every rate prior.** `positionalPriors`
averaged per-game ratios, giving a 5-attempt game the same weight as a
45-attempt game. Rates are bounded at zero below and unbounded above, so noisy
low-volume games pulled every prior upward. Now opportunity-weighted
(events/opportunities), which is both unbiased and the maximum-likelihood
pooled rate. Improved **every** probability metric, and roughly halved
rushing/receiving bias. This was the root cause of the negative-skill
interception probability: the INT prior sat at 0.0250 against a true 0.0219,
and since int_rate shrinks ~85% toward the prior, every QB inherited it.

**Fixed — the calibrated path is now gradeable.** `walkForwardTdCalibration`
fits a calibrator per season on earlier seasons only, including which head to
use. Improves in all three gradeable seasons (Brier skill 0.037 → 0.049, ECE
roughly halved). 2022 is skipped, not silently graded as raw.

**Rejected on evidence** — each measured, each real, none improving the model:

| candidate | measured effect | why rejected |
|---|---|---|
| 24 player-history heads × 4 stats | best ~1.4% MAE | zero survivors under Holm |
| 141 context candidates × 4 stats | — | zero survivors; DvP actively harmful |
| opponent on volume | MAE 70.6 → 90.8 | double-counts the betting line |
| opponent on efficiency | harm removed | no usable gain |
| scheme change | detection correct (NYJ −3.05 z) | CI straddles zero |
| teammate competition | corr 0.005–0.03 | own share already measures it |
| age | validated, CI [-0.149,-0.009] | **degrades shipped model** |
| injury | validated, 2000/2000 resamples | **degrades shipped model** |
| team change | validated, narrow | not wired; margin too thin |

**The recurring lesson, now seen five times:** a signal that beats a naive
baseline does not necessarily improve *this* model. The structural model
already regresses toward positional priors, and that shrinkage implicitly
encodes aging, availability, opponent difficulty and role competition. Adding
an explicit factor on top double counts it. Every failure above has the same
shape, and the ablation switch (`GRIDIRON_NO_CONTEXT_ADJ`) exists so the claim
stays checkable rather than asserted.

**Where the remaining error actually lives.** Passing yards is the weak stat
(r² 0.075, Spearman 0.27, within 40 yards 41% of the time) while rushing,
receiving and receptions are materially better (r² 0.28–0.34). Per-game NFL
outcomes are close to structurally unpredictable; the model beats every naive
baseline on every stat in every season, by 4–6%. That is the honest ceiling
for this class of model on this data.

### 9. Rookies: the model could not see them at all

Verified directly: at Week 1 of 2025, 880 players received a projection and
**zero** of them were players without prior NFL usage. `buildProjections`
builds entirely from `player_week_usage`, so a rookie is invisible until he
has already played — worst exactly at draft season and the opening weeks.

Not a modelling problem, a missing prior. Everywhere else an unknown starts
at a positional prior and shrinks toward evidence; rookies had no prior to
start from. Draft capital is that prior, and it is strong:

| draft band | rookie opportunity/game | n |
|---|---:|---:|
| Round 1 | 16.60 | 28 |
| Round 2 | 9.77 | 15 |
| Round 3 | 5.56 | 10 |
| Round 4+ | 5.14 | 22 |

A 4x spread, available before a snap is played. `nfl-rookies.js` provides the
prior (band × position, shrunk hard toward a conservative fallback because
n=75 and `player_accolades` only covers players still rostered in 2026 — these
are surviving rookies), refines it by depth-chart rank from `nfl_depth`, and
blends toward observed usage with k=4 games.

**On college data:** deliberately not used. Draft position already aggregates
college production, testing, medicals and interviews, priced by 32 teams with
far more information than this database. College box scores would help only
insofar as they beat that consensus — the same bet as beating a closing line.
If added later, they should be tested as a candidate against the draft-capital
prior, not assumed to improve on it.

### 10. Correction: coaching history DOES exist

§7 recorded coaching history as unavailable because `nfl_teams` holds only a
current snapshot. That was true of the local database and wrong as a
conclusion. `nflverse/nfldata`'s `games.csv` carries `home_coach`/`away_coach`
per game, yielding exact per-team-season head coaches — now synced into
`nfl_team_coaches` (`nfl-coaches.js`): **384 team-seasons, 2015–2026, 96
coaches**, 7–11 changes a year, verifiable against public record (Belichick →
Mayo 2024, Fisher → McVay 2017, Ben Johnson → CHI 2025).

It does not replace `nfl-scheme.js`; they answer different questions. Coaches
tell you **who** changed (a discrete, verifiable fact); scheme discontinuity
tells you **what** changed in play-calling, which is what actually reaches a
player's usage. A new coach who keeps the system should not move a projection;
a retained staff that overhauls its identity should. Limitation: head coach
only — nfldata carries no coordinator, and a coordinator change under a
retained head coach is exactly what scheme detection is for.

### 11. Passing yards: the "weak stat" framing was half a statistical artifact

Two hypotheses tested, informed by outside research.

**Hypothesis 1 — the volume × efficiency decomposition is hurting.** Published
work finds passing yards per game is itself the most stable QB stat while
efficiency (YPA, TD rate) has weak year-to-year correlation, which would
suggest decomposing a stable quantity into two unstable ones is a mistake.
**Rejected on measurement:** decomposed 63.19 MAE vs direct-prior 65.47, and
every blend from 20% to 60% direct made it worse. The decomposition is
already the better structure here.

**Hypothesis 2 — restricted range.** r² can only explain between-player
variance, and starting QBs are far more alike in volume than receivers are.
Variance decomposition over 2023–2025:

| stat | between-player | within-player | between share |
|---|---:|---:|---:|
| passing yards | 1550.6 | 4591.0 | **25.2%** |
| rushing yards | 503.9 | 421.2 | 54.5% |
| receiving yards | 407.7 | 477.5 | 46.1% |
| receptions | 2.3 | 2.4 | 48.7% |

**Confirmed.** Three-quarters of passing-yards variance is week-to-week noise
within the same quarterback, so the theoretical r² ceiling is ~0.25 against
~0.46–0.55 for the other stats. Against ceiling:

| stat | r² | ceiling | share of achievable |
|---|---:|---:|---:|
| passing yards | 0.075 | 0.252 | 30% |
| rushing yards | 0.338 | 0.545 | 62% |
| receiving yards | 0.278 | 0.461 | 60% |
| receptions | 0.284 | 0.487 | 58% |

So passing yards is genuinely harder — half the achievable ceiling of the
others — **and** the model captures a smaller share of what is available
(30% vs ~60%). Both are true; the raw r² comparison overstated the gap by
roughly 2x. Real remaining headroom exists, but it is about a third of what
"0.075 vs 0.34" implied.

### 12. Betting: the edge is in execution, not prediction

The spread question was being treated as one problem and it is two. Only one
was ever answered.

**Prediction edge — settled negative.** 21 component models against 15,096
closing lines, 0 clear the materiality gate. Do not re-litigate this.

**Execution edge — real, measured, never exploited.** Books disagree. In a
single 272-event snapshot across ~6.4 books per market: spread lines differ by
**0.813 points on average**, 37.5% of markets differ by a full point or more,
and taking the best available price rather than a median one is worth
**2.566% per bet**.

> **Correction, 2026-08-27.** The 0.813 average did not reproduce. Re-measured
> against the same `nfl_line_snapshots` table — 8 books, 272 events, verified
> captured in the same instant — the mean gap is **0.289 points**. The
> conclusion is unchanged and arguably stronger: the mean was always the wrong
> statistic, because line-shopping value lives entirely in the tail, and the
> tail here runs to 2.5–3.0 points. See `docs/PATH_TO_PROFIT.md`. The edge is
> now surfaced by `nfl-shopping-board.js` rather than left unread.

**The real break-even is 51.38%, not 52.38%.** The universally-quoted figure
assumes every spread is priced −110 both ways. Measured over 11,134 games
carrying real `spread_odds` (2006–2025), only **13.2%** actually were. A full
point of required win rate is a large share of any realistic edge.

*(Methodological note worth keeping: American odds cannot be averaged
directly — the scale is discontinuous at zero. An earlier pass this session
made that error and produced a nonsense mean of −58.3. Average implied
probabilities and convert back.)*

#### Key numbers are why line shopping beats price shopping

NFL margins are not smooth. Over 7,276 games here:

| margin | share of games |
|---|---:|
| **3** | **15.12%** |
| 7 | 9.03% |
| 6 | 5.99% |
| 10 | 5.51% |

A half point from 3.5→3.0 is worth **4.2×** one from 5.5→5.0. Treating all
half points as equal is what makes line shopping look marginal.
`lineMoveValue()` prices moves against the empirical margin distribution.

#### Wong teasers — the one defensible +EV bet found

Predicts nothing; exploits a structural property the teaser payout ignores. A
6-point teaser costs the same whether it crosses both key numbers or neither.

**1,391 qualifying legs, 74.69% win rate, SE 1.17pp (1999–2025).** Stable
across eras — leave-one-era-out gives 73.94%–75.68%.

| price | break-even | z | EV/bet |
|---|---:|---:|---:|
| **−110** | 72.37% | **1.99** | **+6.50%** |
| −115 | 73.14% | 1.33 | +4.30% |
| −120 | 73.85% | 0.71 | +2.27% |
| −130 | 75.18% | −0.42 | **−1.30%** |

The identical bet is +6.5% at −110 and −1.3% at −130 — which validates the
execution thesis directly. `findTeaserLegs()` enforces a −115 floor.

**Caveats, stated because overstating this costs real money:** z=1.99 clears a
one-sided 5% bar and nothing more; books have moved many 2-team 6-point
teasers to −120+ precisely because this is known, so price availability is the
binding constraint; legs must be in **different games** or the independence
behind p^n fails; and it still owes forward CLV before sizing real money.

#### Staking

Quarter Kelly, because full Kelly is growth-optimal only when the probability
is exact and is violently asymmetric to overestimated edge. The load-bearing
guardrail is `stakeFor()`'s `source`:

- `'execution'` — advantage observed at bet time. May size a bet.
- `'model'` — returns **zero units** until proven CLV exists. Spreads never
  beat a closing line; props have no recorded CLV. Sizing on an unvalidated
  edge is the ordinary way Kelly ends a bankroll, and the code refuses rather
  than warns.

#### Data sourcing, resolved

- **Historical opening lines: no free source exists.** `nfldata`'s
  `initial_lines.csv` is 2021-only, one book, and is **lookahead** lines
  (BAL −5.5 → +9.5 in Week 15 — that is Lamar Jackson's injury, not market
  drift; 45% move >3 points). Unusable for CLV.
- `closing_lines.csv` is 2006–2018 and does not overlap it.
- **You already have real prices locally**: 11,134 games with `spread_odds`.
- OddsPortal's `robots.txt` disallows every historical season path and every
  odds-serving AJAX endpoint. Not scraped.
- The forward capture job (§ `nfl-prop-clv.js`) is the clean path to CLV and
  needs only `ODDS_API_KEY`.

## Open

1. ~~Walk-forward TD calibrator~~ — **done** (§8). Improves in all three
   gradeable seasons.
2. ~~Interception negative skill~~ — **fixed** (§8). Root cause was the biased
   rate prior, not interceptions. Now ≈0 skill, the honest ceiling for an
   event whose year-over-year correlation is 0.023.
3. ~~New signal families~~ — **tested and rejected** (§8). Snap share already
   existed; age, injury, scheme, opponent and teammate competition were all
   built and measured. Each is real; none improves the shipped model, because
   structural shrinkage already encodes them.
4. **Passing yards specifically** — the one genuinely weak stat (r² 0.075 vs
   0.28–0.34 for the others). Further accuracy work should target passing
   volume and efficiency rather than the model as a whole; broad-brush signals
   have been exhausted.
5. **Wiring the team-change signal** — the only unrejected candidate (§7). It
   passed narrowly and is deliberately not applied; given every other
   narrowly-passing signal degraded the pipeline when wired, it should be
   ablation-tested end to end before being trusted.
6. **Draft Room / Trade Lab Phase 4+** — draft queue, waiver prescription,
   trade counteroffers, mobile navigation, saved views, model registry. Listed
   as open in the superseded handoff docs and still untouched.
7. **Spreads** — 0/21 component models clear the materiality gate. Settled
   finding (the market has no exploitable edge here), not an open task.

---

## Where to start next (handoff)

Ordered by value per unit of effort. Everything below is measured, not
guessed; the numbers behind each item are in the sections above.

**1. Set `ODDS_API_KEY`.** Nothing else unblocks as much. It starts
`nfl_prop_capture` (hourly) and turns the central open question — do props
have an edge — from unanswerable into measurable. ~200 settled bets before
median CLV means anything, so the clock starts the day it is set.

**2. Verify the teaser edge against live prices.** The strategy is +6.50% EV
at −110 and −1.30% at −130. Everything depends on whether a −110 or −115
2-team 6-point teaser is actually available at the books reachable from here.
That is a market-availability question, not an analysis question, and it
decides whether §12 is worth anything in practice.

**3. Extend the key-number work to other documented spots.** The teaser result
came from taking the margin distribution seriously. The same lens has not been
pointed at: alternate teaser lengths (6.5 and 7 points), home underdogs,
divisional unders, or middling opportunities where two books straddle 3.
`lineMoveValue()` already prices any of these correctly.

**4. Passing yards, and only passing yards.** It captures 30% of its
achievable ceiling against ~60% for the other stats. Broad-brush signals are
exhausted (nine documented rejections in §8) — this needs passing-specific
work on volume and efficiency, not another general-purpose head.

**5. LLM extraction from `news_items`.** 1,036 rows with `injury_entities_json`
and `fantasy_impact` already populated. This is the one signal family a
numeric model structurally cannot reach. It goes through the same gate as
everything else — "an LLM found it" is not evidence it helps.

### Retained but unwired — this is deliberate

A cleanup pass on 2026-08-28 found eight service modules that nothing imports.
They were checked individually and **kept**, because they are not dead weight —
they are the evidence behind the "do not redo these" list directly below, and
several are cited by filename in this log and in `NFL_MODEL_STATUS.md`.
Deleting them would leave dangling references and make a documented negative
result unreproducible.

`nfl-coaches.js` · `nfl-offseason-change.js` · `nfl-opponent.js` ·
`nfl-prop-grading.js` · `nfl-props-replay.js` · `nfl-rookies.js` ·
`nfl-specialists.js` · `nfl-teammate-competition.js`

Unwired is the correct state for all of them: each was built, measured, and
failed to improve the shipped pipeline. `nfl-coaches.js` is worth singling out —
it records a *correction* to an earlier claim in this log, which is exactly the
kind of thing that must not be quietly deleted. If any is ever retired for real,
retire the doc references in the same commit.

### Do not redo these

- **Sides/totals prediction.** 0 of 21 models beat 15,096 closing lines,
  three independent ways.
- **Recency/blend heads.** 24 candidates × 4 stats, zero survivors.
- **Opponent strength on volume.** Actively harmful (MAE 70.6 → 90.8); it
  double-counts the betting line, which already prices the opponent.
- **Teammate competition.** A player's own share already measures it.
- **Applying age/injury as adjustments.** Both validated in isolation and both
  degraded the shipped pipeline. Kept as displayed context only.
- **Scraping OddsPortal.** robots.txt disallows every historical path.

### The rule that produced every real result here

Never judge a change by a backtested win rate. Out-of-sample against a real
baseline, Holm-corrected across the whole batch, then **ablated against the
shipped pipeline**. Two signals passed the first two steps and failed the
third. The ablation switch (`GRIDIRON_NO_CONTEXT_ADJ`) exists so that claim
stays checkable rather than asserted.

---

## 2026-08-27 — passing attribution and a working prop-CLV loop

### Passing yards: volume is the larger remaining error source

`nfl-passing-diagnostic.js` now separates attempts from yards per attempt
without creating another collection of correlated full-output heads. On 1,450
pregame-eligible QB weeks from 2022–2025:

| View | MAE |
|---|---:|
| Shipped attempts × shipped YPA | **59.00** |
| Season attempts × shipped YPA | 62.08 |
| Shipped attempts × season YPA | 61.29 |
| Season attempts × season YPA | 61.98 |

All replacements are walk-forward. Both component replacements are worse, so
the volume × efficiency decomposition remains the champion. Exact target-game
error attribution (diagnostic only, never promotion evidence) assigns **56.4%
of pre-covariance squared error to attempts** and 43.6% to efficiency; volume
rises to 60.0% in 2025. Future passing work should therefore improve the
pregame attempts question with genuinely new evidence, not blend the final
yardage estimate toward another recent average.

Reproduce with `npm run diagnose:nfl-passing`.

### The original prop capture could never measure edge

Setting `ODDS_API_KEY` exposed three structural defects in the first CLV
implementation:

1. `flattenProps()` collapsed all books to the best price before persistence,
   so a book-specific close could not exist.
2. Captures stored no model probability, week, kickoff, or fair implied
   probability; settlement and model-vs-market grading could never run.
3. The evidence report counted every book, both sides, and every hourly quote
   as if each were an independent bet.

Fixed. The archive now preserves every book-specific quote, pairs over/under
prices to remove vig, attaches the shared player-week distribution at capture,
infers the NFL week, freezes the final pre-kick quote as the close, settles all
four yardage/reception markets plus anytime TD, and counts one immutable shadow
decision per event/player/market. Hourly observations establish line movement;
they never inflate the sample size.

The first real capture preserved 529 quotes from 12 events, matched 406 to
model distributions, and froze 64 distinct shadow decisions. Nothing is called
an edge: zero are settled, and the existing ≥200 forward-decision gate remains.

### Free-tier credit safety

An hourly full-slate capture would spend roughly 60 credits every time the
six-hour API cache expired and exhaust a free account before Week 1. Scheduled
capture now spends only at **T−24h and T−1h**, skips all other runs, and keeps
a hard 50-credit reserve. A forced scheduler test 319 hours before kickoff
correctly made zero paid requests.

---

## 2026-08-27 — profitability plan execution, first operational pass

### Forward evidence gates now exist in code

The prop decision policy is serialized, SHA-256 hashed, and archived under
`nfl-prop-shadow-2026.1`. Reusing that version with changed policy bytes throws
instead of silently rewriting the audit. The NFL operations API and UI now
report:

- direct model-match coverage and explicit abstention coverage separately;
- unresolved identity reasons instead of a single missing-projection count;
- T-24h and T-1h capture rates, pending windows, and irrecoverably missed
  windows;
- settlement resolution and results overdue by more than 24 hours;
- one forward scorecard per prop market, including sample, Brier, ECE,
  calibration slope, mean/median CLV and a week-clustered CLV interval;
- the 200-overall / 75-per-market minimums and `0u` staking authority while
  any gate remains blocked;
- reachable teaser prices. The Wong view cannot become eligible without a
  recorded two-team six-point price of -115 or better at a book the user can
  actually access.

The first quote reconciliation classified all 876 stored rows:

| Classification | Quotes |
|---|---:|
| Directly modeled | 406 |
| Identity resolved, role gate abstained | 382 |
| Team defense / unsupported participant | 48 |
| Genuine unresolved identity | 40 |

Operationally resolved coverage is therefore **95.43%**, clearing the 95%
gate without weakening prop eligibility. Direct model coverage remains 46.35%
and is deliberately reported as a different number.

### Twenty passing specialists were tested; zero were promoted

`npm run audit:nfl-passing-specialists` declares five question families
(team plays, pass intent, attempt conversion, QB participation, efficiency)
at four ridge penalties before validation. Discovery is 2022→2023 and the
fixed candidates are evaluated on 2024–2025. Every candidate must improve
MAE in both windows, survive Holm correction across all 20, preserve rank and
retain 76–84% coverage for its nominal 80% interval.

The strongest family was passing efficiency. Its four variants improved
validation MAE by 0.160–0.202 yards and improved Spearman rank, but none was
statistically reliable after multiplicity correction and interval coverage
was only 69.9–70.7%. Every volume-family candidate failed at least one earlier
gate. **No candidate received production authority; the active engine remains
unchanged.** These variants may accumulate 2026 shadow evidence but cannot be
called improvements.

### News is shared evidence, not prose pasted onto a pick

`nfl-news-signal.js` converts timestamped reporting into typed availability and
role claims with player identity, team, evidence span, confidence, source and
publication time. The shared player-week engine attaches the same pre-kickoff
claim to fantasy and prop views. Spread reasoning displays the typed claims for
both teams. Numeric authority is zero: generic injury adjustments previously
degraded the shipped pipeline, so this new family must pass chronological
ablation and forward replication before moving a number.

### GitHub source provenance

Historical lines were refreshed from nflverse `nfldata` (15,096 team rows,
1999–2026). The runtime registry pins the inspected upstream commits for
`nflverse/nfldata`, `nflverse/nflfastR`, `ffverse/ffopportunity`, and
`nflverse/nfl4th`. GPL-family model code was not copied. Expected-points,
game-state and expected-opportunity ideas are independently implemented shadow
benchmarks and still face the same promotion gates. The source archive has no
trustworthy multi-book historical opener, so opening-line and CLV claims remain
forward-only.

---

## 2026-08-29 — teaser execution and forward accountability

The only historically positive NFL bet in the repository now has an operational
loop. Per-book spread snapshots are screened for Wong windows, paired only
across different games at one book, and joined to the latest manually verified
two-team six-point teaser payout. The server refuses stale quotes, expired price
checks, negative-EV prices, and anything worse than the conservative −115 gate.

Every accepted paper or manually placed ticket persists its two exact legs,
expected ticket probability, expected EV, price timestamp, line timestamp and
stake. Final scores grade each teased line and roll into a forward-only leg rate;
placed profit units remain separate from paper results. No sportsbook order is
transmitted.

The repeated-server failure was fixed at the true boundary. Port availability is
now checked before database imports and background jobs, and an occupied port
names its PID/command before the process exits. This prevents a failed second
boot from becoming a second SQLite writer.

### Betting desk redesign and AI audit visibility

The NFL route now opens on the executable Wong-teaser workflow instead of the
unvalidated prediction board. A three-card control strip names the next action
for teaser pricing, line execution and the saved AI review; raw internal status
codes and unexplained `Blocked` KPIs were removed. The research board now says
`Paper track`, treats the largest model disagreement as research rather than a
"best bet", and cannot imply staking authority.

`Proof & AI` now opens directly to the saved outcome-blind AI review. Run #1 is
reported plainly: 203 candidates reviewed, 0 kept, 0 units staked, with 80 trace
rows available. The untouched-evidence card now reports the actual deficit—0 of
250 frozen 2026 decisions settled—instead of a context-free status.

MLB is labeled research-only until priced forward evidence exists. Its four
current surfaces are market board, forward ledger, paper picks and model lab;
the 41-day-old legacy board is a secondary research archive rather than an
equal primary tab.

---

## 2026-08-29 — profitability phases, auditable AI wording, and news command center

The profitability endpoint now reports the real distance to evidence instead
of collapsing unrelated failures into `blocked`. The sealed historical blind
audit is complete at 70/70 windows and 157 bets (72–83, −16.38u, −10.43% ROI),
while the untouched forward ledger remains 0/250 settled. AI replay #1 reviewed
203 historical candidates and kept zero; it is research-only because historical
decision-time quote timestamps were not preserved. Five independent phase cards
now name the current measurement and next action. The Wong-teaser pilot is the
closest path, but it still requires a reachable two-team six-point price at −115
or better and forward grading before any profit claim.

Post-pick AI explanation now has a strict authority boundary. The server selects
the pick deterministically, freezes and hashes the factor packet, asks the model
only for structured wording, filters cited factor keys against that packet, and
stores an immutable translation audit marked `wording_only`. The model cannot
change the side, introduce a new factor, or turn research evidence into staking
authority. A compact audit endpoint exposes the sequence and reasoning hash.

News now opens on a bounded Intelligence Desk rather than the full archive. The
server ranks a maximum first paint of 80 from 500 recent candidates by roster
match, availability/role materiality, freshness, official provenance,
reliability, and importance; the current store contains 1,322 stories from eight
sources, with 34 published in the last 24 hours and 47 typed claims. Duplicate
player identities are collapsed before rendering. Feed ingestion fans out in
parallel with per-source failure isolation, and deterministic signal typing runs
immediately after refresh instead of waiting for the hourly scheduler. Migration
013 adds the published-priority, team-date, and ingest-time read indexes.

### Connected betting workbench and play-by-play v2

The Betting Hub, NFL Auto and MLB Auto page hierarchies were replaced by one
shared operating sequence: **scan → price → review → track**. The overview now
names the next executable action, links directly into each sport desk, and keeps
the calibration restriction beside the execution state. Internal `blocked`
codes are no longer presented as unexplained KPIs.

The NFL workbench connects the model decision queue, paper ledger, price and
venue tools, proof room and saved blind AI review. AI remains wording-only: a
selection and factor packet are frozen and hashed before translation. The old
multi-panel play-by-play dashboard was removed. Its only surviving presentation
is the team-selected field replay, with matchup, offense and possession
selectors and a clickable snap tape.

The underlying drive engine is now `pbp-drive-v2`. Team shotgun tendency,
down-and-distance, play call and game script jointly determine formation and
personnel. Every recorded snap carries possession, score, quarter, clock, field
position and play number; every drive carries before/after score and clock
state. The score shown by the UI is generated from that same tape.

The MLB workbench connects the local model slate to forward capture, settlement
and calibration. Its forward console preserves the actual pregame state and
price before creating evidence. Current forward results and priced units are
shown separately from retrospective and incomplete rows, which remain visibly
quarantined.

# 2026-08-30 — current-season model growth loop

The model already used cutoff-safe weekly fits, but the operational loop stopped
short of turning a new NFL week into training data. Results/lines, official
weekly usage, finalized nflverse play-by-play features, advanced participation
feeds, frozen predictions, settlement, and the next cutoff fit were separate
manual operations. The forward shadow table also allowed the same game to be
inserted at every evidence horizon and had no frozen line/team columns, so it
could neither settle its own rows nor count an independent sample correctly.

`nfl-model-growth.js` now runs the full publication-driven cycle. It checks for
a newly finalized week, ingests the current-season nflverse usage, PBP, NGS,
PFR, snaps, depth and injury releases independently, settles both forward
ledgers, invalidates only in-process caches, and records the next-week ensemble
fit with its data fingerprint and cutoff. The scheduled check is enabled by
default but expensive downloads run only when the feature warehouse trails a
real finalized week. A late upstream release produces `source_lag` and retries;
it never manufactures missing rows.

The shadow ledger now freezes one row per event/market/model-policy version,
stores the line, price, quote timestamp and feature packet, and attaches the
final result and CLV later. Evidence horizons remain in the context archive but
cannot multiply the forward sample. Abstentions are labeled for filter research
while only independent `observe` decisions count toward the promotion firewall.
As of this change there are no 2026 regular-season finals, so the honest state
is `waiting_for_regular_season_results`; the first learning cycle starts after
Week 1 becomes final and the required nflverse releases publish.
