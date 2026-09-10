# Offseason changes model

What happens to a player's opportunity and production when his situation changes between
seasons — measured per effect, fitted walk-forward, and published as a multiplier the
preseason projection, the draft advisor and (in aggregate only) the betting engine can
consume.

Code: `server/services/offseason-model.js`. Tests: `test/offseason-model.test.js`.
Reads only; writes nothing to `server/data.sqlite`.

The test suite runs against a synthetic league with known effects injected, because on real
data a null is ambiguous between "no effect" and "the code lost it". The live-database smoke
is opt-in (`GRIDIRON_REAL_DB_SMOKE=1 npm test`) so the default suite never opens the
multi-gigabyte league file read-write.

**One-line summary.** Three effects survived out of sample — changing teams (0.82),
falling on the depth chart (0.71), and returning from missed time (0.92). Seven did not,
including the continuous "moved into an emptied room" interaction that motivated the whole
exercise, and both coaching and QB change. The shipped multiplier beats the no-change
baseline, the mean-reversion baseline and the existing flat "movers keep 78%" rule on
held-out 2023–2025, on both opportunity share and PPG. **It is also fully subsumed by
knowing the season-T depth chart and the two-year usage trend, so it must not be stacked on
a model that already has those** — see [What this does not add](#4-what-this-does-not-add).

**Second pass, 2026-09-06.** The same harness was re-run over the 66-column
`off_player_season_features` set (§9): 39 new variables as individual effect lines, then
jointly in the ridge and in a GBM, then graded on the published multiplier itself. Nothing
was adopted — v2 beats v1 in 0 of 3 held-out seasons on either outcome — and the whole
declined list is recorded with its numbers in §9.2 and §9.6. **SHIPPED v1.**

---

## 1. Setup

**Unit.** One player-season `T`. Features come from seasons `<= T-1` plus the `T` offseason
record (depth chart, roster snapshot, coaching table, Week 1 line). No season-`T` game
result is ever read as a feature.

**Outcomes.** Both are log ratios against `T-1`:

| | definition |
|---|---|
| `y_share` | `log( mean weekly opportunity_share at T / same at T-1 )` |
| `y_ppg` | `log( PPR points per game at T / same at T-1 )` |

`opportunity_share` (the player's share of his team's targets + carries + pass attempts) is
already computed per week in `nfl_player_week_features`; the season figure is its
games-played mean, so a 12-game season and a 17-game season are comparable. PPR points are
recomputed from the same feature blob with the repo's standard weights
(0.04/4/−2 pass, 0.1/6 rush, 1/0.1/6 rec). **Fumbles are not in that table and are
omitted**, worth roughly 1–4 points per season for RB/QB — the same limitation
`DRAFT_AUDIT_2021_2025.md` documents for its actuals.

**Panel.** `T` in 2021–2025 for fitting and grading; 2026 for production. Requires 4+
games at `T-1`, a non-zero prior share, presence on a `T` roster, and 3+ games at `T`.

| season | rows | with outcome | roster source |
|---|---|---|---|
| 2021 | 377 | 335 | `nfl_depth` week 1 |
| 2022 | 388 | 343 | `nfl_depth` week 1 |
| 2023 | 372 | 327 | `nfl_depth` week 1 |
| 2024 | 381 | 338 | `nfl_depth` week 1 |
| 2025 | 411 | 337 | `nfl_depth` week 1 |
| 2026 | 362 | — (no games yet) | `nfl_roster_snapshots` |

**Mean reversion is handled first and explicitly.** A 30%-share player almost always falls
and a 6%-share player almost always rises, for reasons that have nothing to do with the
offseason. Every effect below is the difference in **residual after a position-specific
regression of `y` on prior log share**. The fitted slopes are −0.21 (RB), −0.22 (WR),
−0.23 (QB), −0.24 (TE): a fifth of any deviation from a player's own baseline comes back
every year regardless. Without this control, "movers decline" is mostly a restatement of
"the players who get moved are the ones with more to lose".

**Identical player sets.** Every effect, every baseline and every candidate model is scored
on exactly the same rows, in the same order.

**Attrition is reported, not folded in.** Players who never appear at `T` are excluded from
the ratio panel — `log(0)` has no value and imputing one would put the whole effect in the
imputation. They are counted separately:

| | movers | stayers |
|---|---|---|
| played at all at T | 94.0% (n=533) | 97.1% (n=1396) |
| WR | 92.2% | 97.6% |
| QB | 92.2% | 95.1% |
| TE | 96.6% | 99.0% |
| RB | 96.1% | 96.1% |

A mover is ~3 points more likely to vanish entirely. That risk is real and the multiplier
does not express it; a consumer that cares about bust probability should read
`attrition()`, not the multiplier.

---

## 2. The effect table

Pooled 2021–2025, n = 1,680 player-seasons (1,676 for PPG). Each row is the group's mean
mean-reversion residual minus its contrast's, exponentiated, with a 95% bootstrap CI on the
difference. "Held-out lift" is the pooled 2023–2025 walk-forward change in MAE from adding
this effect's feature to the shipped model, negative = better.

| Effect | contrast | n (grp/ctr) | Share mult | 95% CI | PPG mult | 95% CI | Per-season n (21–25) | Held-out | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Team change** | stayed | 425 / 1255 | **0.823** | 0.781–0.869 | **0.815** | 0.759–0.878 | 93, 88, 85, 86, 73 | shipped block −0.0113 vs mean reversion (SIG) | **SHIPPED** |
| **Depth-chart demotion** (listed lower than prior usage rank) | delta 0 | 129 / 874 | **0.712** | 0.650–0.776 | **0.709** | 0.621–0.806 | 25, 26, 27, <20, 35 | same block | **SHIPPED** |
| **Prior-year games missed** (4+ vs ≤1) | ≤1 missed | 849 / 523 | **0.921** | 0.880–0.965 | **0.924** | 0.872–0.982 | 162, 180, 170, 175, 162 | same block | **SHIPPED** |
| Team change × vacated share (mover into >30% vacated vs ≤30%) | movers, low vacated | 234 / 191 | 1.059 | 0.954–1.172 | 1.001 | 0.872–1.147 | 60, 44, 47, 48, — | — | **DECLINED** |
| Net vacated share, stayers (>30% vs ≤30%) | stayers, low vacated | 565 / 690 | 0.975 | 0.934–1.023 | 1.007 | 0.947–1.068 | 114, 106, 127, 130, — | — | **DECLINED as a threshold**; kept as a continuous term inside the team-change interaction |
| Depth-chart promotion | delta 0 | 556 / 874 | 1.009 | 0.963–1.058 | 0.983 | 0.921–1.048 | 127, 120, 125, —, — | — | **DECLINED** |
| Starting QB change (pass catchers) | same QB1 | 568 / 909 | 0.980 | 0.940–1.023 | 1.001 | 0.944–1.063 | 133, 106, 117, —, — | — | **DECLINED** |
| Head-coach change | same HC | 412 / 1268 | 0.983 | 0.937–1.032 | 0.998 | 0.937–1.061 | 86, 123, 61, 70, 72 | — | **DECLINED** (re-test confirms `DRAFT_AUDIT_2021_2025` §5) |
| Team Week 1 implied total up 2+ | not up | 470 / 1210 | 0.995 | 0.951–1.044 | 1.049 | 0.983–1.117 | 80, 110, 69, —, — | — | **DECLINED** |
| Age 3+ years past positional peak | closer to peak | 301 / 1379 | 0.876 | 0.829–0.924 | 0.865 | 0.804–0.930 | 54, 55, 57, —, — | control only | **REAL, NOT PUBLISHED** — `dynasty-age-curve.js` already applies an age multiplier; publishing a second one double-counts it |
| Offensive-coordinator change | — | — | — | — | — | — | — | — | **NOT MEASURABLE** — no season-dimensioned OC table exists (`nfl_teams.oc_name` is one undated snapshot) |
| Rookie draft capital × vacated room | — | 297 rookies | level model, see §5 | | | | | pick rho 0.24–0.37; vacated rho ≈ 0 | **PARTLY SHIPPED as a reported fact**, not as a multiplier |

Three effects replicate in every season and clear their CI. Everything else is a coin flip
dressed as a mechanism.

**The most interesting failure is the one this module was built for.** "A receiver moved
into a room with 45% of last year's targets vacated" is the single most persuasive story in
August, and as a continuous interaction it does not work: movers into emptied rooms
did *slightly better than other movers* (1.059) with a CI straddling 1, and stayers on
gutted teams gained nothing (0.975). The room being empty does not tell you who fills it.
The share of the vacated term that survives is small and only inside the team-change
interaction, where the fitted weight partly offsets the move discount — a mover into a
genuinely empty room is discounted *less*, not promoted.

---

## 3. Walk-forward

Fit on every season `< T`, grade on `T`, for `T` in 2023 / 2024 / 2025. Ridge penalty is
chosen by **leave-one-season-out inside the training window** — a random row split leaks,
because teammates share an offense. The paired bootstrap (`backtest-significance.js`,
4,000 iterations, 90% CI) clusters by team-season for the same reason.

`shipped_adjustment` is the model that actually ships: ridge on prior log share + position
+ the three surviving change blocks. Pooled over 1,002 held-out player-seasons:

### Opportunity share

| model | MAE | Spearman | vs no-change | vs mean reversion | vs flat 74/78/82% rule |
|---|---|---|---|---|---|
| no change (multiplier 1.0) | 0.3462 | — | — | — | — |
| flat mover rule (the current production rule) | 0.3423 | 0.164 | −0.0039 ns | +0.0007 ns | — |
| mean reversion only | 0.3416 | 0.254 | −0.0046 ns | — | −0.0007 ns |
| shrunken means (empirical Bayes) | 0.3386 | 0.329 | −0.0076 **SIG** | −0.0030 ns | −0.0037 ns |
| **shipped (ridge, change features)** | **0.3303** | **0.336** | **−0.0160 SIG** [−0.0239, −0.0080] | **−0.0113 SIG** [−0.0178, −0.0049] | **−0.0119 SIG** [−0.0199, −0.0039] |
| *reference:* full ridge (adds trend, age, depth level) | 0.3190 | 0.417 | −0.0272 SIG | −0.0225 SIG | −0.0232 SIG |
| *reference:* GBM on the full feature set | 0.3127 | 0.435 | −0.0335 SIG | −0.0289 SIG | −0.0296 SIG |

### Fantasy PPG

| model | MAE | Spearman | vs no-change | vs mean reversion | vs flat rule |
|---|---|---|---|---|---|
| no change | 0.4508 | — | — | — | — |
| flat mover rule | 0.4453 | 0.136 | −0.0055 ns | −0.0020 ns | — |
| mean reversion only | 0.4475 | 0.184 | −0.0033 ns | — | +0.0021 ns |
| shrunken means | 0.4435 | 0.242 | −0.0073 ns | −0.0039 ns | −0.0018 ns |
| **shipped** | **0.4387** | **0.235** | **−0.0121 SIG** [−0.0200, −0.0045] | **−0.0087 SIG** [−0.0152, −0.0021] | **−0.0066 SIG** [−0.0125, −0.0011] |
| *reference:* full ridge | 0.4298 | 0.312 | −0.0211 SIG | −0.0176 SIG | −0.0156 SIG |
| *reference:* GBM | 0.4284 | 0.310 | −0.0224 SIG | −0.0190 SIG | −0.0170 SIG |

### Per season (share)

| T | fit on | n train | n test | λ | shipped MAE | shipped ρ | mean reversion | no change | flat rule |
|---|---|---|---|---|---|---|---|---|---|
| 2023 | 2021–22 | 678 | 327 | 100 | 0.3316 | 0.310 | 0.3507 | 0.3448 | 0.3316 |
| 2024 | 2021–23 | 1005 | 338 | 10 | 0.3391 | 0.367 | 0.3502 | 0.3559 | 0.3593 |
| 2025 | 2021–24 | 1343 | 337 | 30 | 0.3202 | 0.336 | 0.3241 | 0.3379 | 0.3356 |

2023 is the weak season: with only two seasons of training the shipped model exactly ties
the flat rule. The pooled result is carried by 2024 and 2025, and the shipped model's
advantage over the flat rule grows as the training window does — which is the direction you
want, but it also means the 2023 column should not be read as independent confirmation.

### Fit method: why ridge, and why the simple one

Four candidates were fitted identically. Empirical-Bayes shrunken per-effect means — the
first thing tried, and the most transparent — beat the no-change baseline but **could not
beat mean reversion alone** (−0.0030, ns), so it is kept as a reference candidate only.
Ridge beats every baseline on both outcomes. The GBM challenger (`nfl-gbm.js`, 120 trees,
depth 3, lr 0.05) beat ridge on share by 0.006 log units — but that margin is
**significant in only one of five random seeds** (mean diff −0.0060 to −0.0071, CI upper
bound wandering across zero) and is indistinguishable on PPG. Within noise the repo's rule
is the simpler model, and here simplicity is load-bearing rather than aesthetic: ridge is
linear, so the published `components` are an *exact* decomposition of the multiplier rather
than an attribution heuristic.

---

## 4. What this does not add

A nested ablation, same walk-forward, same rows:

| feature set | share MAE | ρ | vs previous row |
|---|---|---|---|
| prior log share + position | 0.3395 | 0.249 | — |
| + two-year usage trend, age terms | 0.3278 | 0.358 | −0.0116 **SIG** [−0.0156, −0.0078] |
| + "listed first on the T depth chart" | 0.3198 | 0.410 | −0.0080 **SIG** [−0.0130, −0.0032] |
| + the whole change block | 0.3185 | 0.418 | −0.0012 **ns** [−0.0054, 0.0028] |
| change block, *without* trend/age/depth level | 0.3303 | 0.336 | −0.0091 **SIG** vs row 1 |

Read the last two rows together, because they are the finding:

- Over a plain prior-season-rate prior, the change block is worth a real, held-out
  0.0091 log units. **That is the case for shipping it.**
- Over a model that already knows the two-year trend and whether the player is listed
  first on the season-`T` depth chart, it is worth 0.0012 and nothing. **Those features
  subsume it.**

The multiplier is therefore real but not *additional*. A "changed teams" flag is largely a
compressed way of saying "he is not the listed starter here and his usage was already
sliding". This constrains consumption more than any other result in this document, and it
is the contract in §6.

---

## 5. Rookies

A first-year player has no prior season, so the ratio framework cannot express him at all —
there is nothing to multiply. `measureRookieEntry()` measures the **level** instead:
`log(rookie opportunity share) = a + b·log(draft pick) + c·(room vacated share)`, n=297
across 2021–2025.

| | coefficient | held-out Spearman 2023 / 2024 / 2025 |
|---|---|---|
| `log(draft pick)` | −0.175 | pick alone: 0.368 / 0.260 / 0.239 |
| room vacated share | +0.015 | vacated alone: 0.006 / **−0.104** / 0.020 |
| joint model | — | 0.312 / 0.218 / 0.239 (MAE beats the flat mean in all three) |

**Draft capital predicts rookie opportunity; the vacated room does not, and adding it makes
the ranking slightly worse in 2024.** So the answer to "does a high pick landing in an empty
room break out?" is: the high pick matters, the empty room does not — the same null as the
veteran interaction in §2, found independently on a disjoint population.

Rookies keep `opportunity_multiplier: 1.0` from `offseasonAdjustment`. The level belongs to
the preseason model, and returning a level where a multiplier is expected is exactly the
category error this repo's audits keep catching.

---

## 6. The API, and how to consume it

```js
import { offseasonAdjustment, offseasonAdjustments, teamOffseasonSummary }
  from './server/services/offseason-model.js';

offseasonAdjustment(playerId, 2026)   // gsis id OR players.id
// {
//   opportunity_multiplier: 0.536, ppg_multiplier: 0.592,
//   confidence: 'high', n_basis: 1680,
//   drivers: [
//     'moved LAC→IND into a room with 18% of 2025 opportunity vacated',
//     'depth chart WR1 → WR3 (demoted)'
//   ],
//   components: { team_change: 0.843, depth: 0.635, qb_change: null,
//                 coach_change: null, injury_return: null, vacated: null,
//                 implied_total: null },
//   evidence: { fit, fit_seasons, team_source, prior_games, prior_opp_share, ... }
// }

offseasonAdjustments(2026)   // Map<gsis, adjustment>, built once per process (~1.3s), 362 players
                             // 2026: 338 players priced, 17 with only unpriced drivers, 7 unchanged
teamOffseasonSummary(2026)   // per team: vacated shares, QB1 change, HC change, arrivals/departures
```

**Rules that are part of the contract, not advice:**

1. **A player with no priced change gets exactly `1.0` and an empty `drivers`.** Not 0.99,
   not a small nudge. Multipliers are clamped to `[0.4, 1.6]`; nothing outside that band is
   credible from offseason evidence alone.
2. **`components` is an exact decomposition.** The per-effect terms sum (in log space) to
   the multiplier. A `null` component means the effect is either absent or unpriced.
3. **A declined effect still appears in `drivers`, suffixed `— no measured effect on
   share`, with a `null` component.** A human reading a draft board should know his receiver
   has a new quarterback; the model should not pretend that knowledge is worth anything.
4. **Do not apply this on top of a projection that already conditions on the season-`T`
   depth chart or the two-year usage trend** (§4). Doing so double-counts. The intended
   consumers — a preseason projection anchored on a prior-season rate, and the draft
   advisor — do not.
5. **Do not stack this with `dynasty-age-curve.js`'s age multiplier and then add the age
   effect from §2.** Age is a control here and is deliberately cancelled out of the
   published number.
6. `confidence` grades the **evidence**, not the size of the number: `low` when the roster
   row came from usage rather than a real depth chart or the player has <6 prior games;
   `high` for 10+ prior games with a real depth slot.

### How the betting engine should consume this

**Team-level aggregates only.** Player multipliers must not reach a market model. Three
reasons, in order of how much they should worry you:

1. The panel is ~340 player-seasons per year and the shipped edge is ~3% of MAE. That is a
   fantasy-grade signal. A market model asked to price a team total off it would be acting
   on noise the closing line absorbed in March.
2. `PATH_TO_PROFIT` / `gridiron-nfl-betting-model` already established this project has
   **zero demonstrated edge against closing lines**. Nothing here changes that, and an
   offseason feature is the most public information that exists — every book has the same
   depth chart.
3. The `implied_total` effect is the one place this model touches market data, and it
   **failed** (0.995, CI 0.951–1.044). The market already prices what the offseason did.

If a team-level aggregate is used at all, route it through
`model-governance.js` as a registered feature contract, in the shape the existing NFL rows
use, and start `blocked`:

| field | value |
|---|---|
| sport / market | `NFL` / `total` (or `spread`) |
| `feature_key` | `offseason_team_turnover` |
| source | `offseason-model.js teamOffseasonSummary(season)` — `vacated_opportunity_share`, `qb1_change`, `head_coach_change` |
| availability rule | roster/depth snapshot captured before Week 1 kickoff; **no season-T usage row may be read** |
| cadence / staleness | weekly / 10080 min (it is an offseason quantity; it does not move in-season) |
| missing behavior | `shrink to league prior` |
| leakage risk | `high` — the historical panel's pre-2021 fallback derives team from season-T usage |
| registry state | `blocked` until it passes the same chronological-accuracy, calibration, null and forward-CLV gates every other challenger faces |

The honest expected value of that promotion is zero. It is written down so that if someone
tries it, they try it inside the gate rather than around it.

---

## 7. Known limitations

- **Fumbles are missing from PPG** (§1), as in `DRAFT_AUDIT_2021_2025`.
- **Survivorship.** The panel needs 3+ games at `T`. Players who wash out entirely are in
  `attrition()`, not the multiplier.
- **Depth charts are three deep.** `nfl_depth` never lists a fourth, so a WR3→WR5 demotion
  is invisible and lands in the "no change" contrast, attenuating the demotion effect toward
  1. The measured 0.712 is a floor on the real effect, not an estimate of it.
- **2026 roster evidence is an ESPN snapshot**, not a published depth chart. `team_source`
  says so on every row, and those rows are `medium`/`low` confidence when the player is
  thin on prior games.
- **Training seasons before 2021 are not used.** Weekly features go back to 2016, but
  without a depth chart the season-`T` team would have to be derived from season-`T` usage,
  which is not pre-season evidence. That path exists in `rosterAtSeasonStart` for
  completeness, is flagged `team_source: 'usage'`, and never appears in an evaluation
  season.
- **The OC-change effect is not measurable at all** and no coefficient is offered.
  `nfl-offseason-change.js`'s `coachingSnapshot()` is the mechanism for accumulating that
  history; until two offseasons of snapshots exist, this stays empty.
- **n is small.** 1,680 fitting rows, ~340 per test season. Effects around 2–3% cannot be
  resolved here and are reported as declined rather than as small.

## 8. Reproducing

```js
const M = await import('./server/services/offseason-model.js');
M.measureEffects([2021, 2022, 2023, 2024, 2025]);              // §2, add {field:'y_ppg'}
M.walkForward({ field: 'y_share' });                            // §3
M.measureRookieEntry([2021,2022,2023,2024,2025], { evaluateOn: [2023,2024,2025] }); // §5
M.attrition([2021, 2022, 2023, 2024, 2025]);                    // §1
M.offseasonAdjustments(2026);                                   // §6
M.measureV2Effects([2021,2022,2023,2024,2025]);                 // §9, add {field:'y_ppg'}
M.walkForwardV2({ field: 'y_share' });                          // §9.3
M.multiplierWalkForward({ field: 'y_share' });                  // §9.4 — the decision
M.ablationV2({ field: 'y_share' });                             // §9.5
```

---

# 9. v2 (66 features)

A second pass over the same panel with `off_player_season_features` joined on —
the 66-column player-season table `docs/OFFSEASON_DATA.md` describes, covering
2021-2026. Same held-out seasons (2023/2024/2025), same rows, same
mean-reversion residual, same team-season-clustered paired bootstrap, v1 as the
incumbent.

**Result: nothing in the 66 columns earns a place in the published multiplier.**
The join is clean and several new variables are genuinely predictive, but every
one of them is a *level* — a fact about the player or his team, not a change in
his situation — and the two blocks that do improve the regression (prior-season
charting, biography) improve the forecast without improving the thing this
module publishes. Graded on the multiplier itself, like for like, v2 beats v1 in
**0 of 3 seasons on share and 0 of 3 on PPG**.

## 9.1 Setup and look-ahead

`attachV2Features` joins the feature row onto each panel row by gsis id. On the
1,680 fitting rows the join rate is **100%** — every player-season the panel
carries has a 66-column row. Three groups of columns are excluded before any
test, and the reasons are not interchangeable:

| excluded | why |
|---|---|
| `sleeper_depth_chart_order`, `sleeper_injury_status` | Sleeper publishes a live snapshot with no history. Stamping today's chart onto 2023 is a leak with nothing to fit on. |
| `apy`, `apy_cap_pct`, `apy_rank_on_team_at_position`, `contract_year`, `new_contract`, `contract_years_remaining` | **The contract feed is empty after 2022** (`OFFSEASON_DATA` gap 1: no OTC signing later than 2022, 2% coverage by 2026). They cannot be tested on any evaluation season, so no number is offered for them — not a null, not a small effect. |
| `team_change`, `qb_change`, `hc_change`, `rookie`, `home_surface` | Already tested in v1 (§2), or constant on this panel. |

`depth_slot_t` is the August-or-later snapshot and is legitimately preseason.
`implied_team_points`, `implied_points_delta_vs_prior` and `division_sos_proxy`
are **season means of per-game closing lines**, and the lines for weeks 2+ are
set during season `T`. They are tested and flagged; only the Week-1 line — v1's
`implied_points_delta`, which failed — is strictly preseason. Any effect those
three show should be read as an upper bound that a preseason-only version would
not reach. Nothing derived from a season-`T` weekly row is used anywhere.

## 9.2 The effect table

Pooled 2021-2025, n = 1,680 (1,676 for PPG), residual after the same
position-specific mean-reversion fit. A binary column is 1 vs 0; a continuous
one is top tercile vs bottom tercile of the rows that have it, except where the
terciles collapse on a discrete column (mostly zeros), in which case the only
split the data supports — any vs none — is used and labelled. "Verdict" is REAL
when the 95% difference CI excludes 1 on either outcome.

| Variable | block | cut | coverage | n (grp/ctr) | Share mult | 95% CI | PPG mult | 95% CI | per-season n (21-25) | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| `prior_adot` | charting | ≥9 vs ≤3.8 | 89% | 510 / 500 | 1.024 | 0.969–1.077 | 1.009 | 0.945–1.082 | 308, 305, 290, 300, 296 | DECLINED |
| `prior_drop_pct` | charting | ≥0.058 vs ≤0.024 | 89% | 505 / 504 | 1.009 | 0.955–1.064 | 1.075 | 1.001–1.153 | 308, 305, 290, 300, 296 | **REAL (PPG only, CI touches 1)** |
| `prior_broken_tackles` | charting | ≥4 vs ≤1 | 100% | 571 / 757 | **1.107** | 1.054–1.161 | **1.091** | 1.027–1.161 | 330, 341, 326, 338, 337 | **REAL** |
| `prior_ngs_separation` | charting | ≥3.26 vs ≤2.80 | 35% | 195 / 195 | 0.967 | 0.889–1.045 | 0.974 | 0.884–1.070 | 121, 114, 118, 108, 122 | DECLINED |
| `prior_ngs_cushion` | charting | ≥6.41 vs ≤5.83 | 35% | 195 / 195 | 0.940 | 0.871–1.010 | 0.985 | 0.904–1.075 | 121, 114, 118, 108, 122 | DECLINED |
| `prior_ngs_air_yards_share` | charting | ≥24.2 vs ≤14.6 | 35% | 195 / 195 | **1.220** | 1.134–1.308 | **1.204** | 1.102–1.313 | 121, 114, 118, 108, 122 | **REAL** |
| `prior_yac_oe` | charting | ≥0.90 vs ≤0.19 | 35% | 195 / 195 | **1.174** | 1.089–1.266 | **1.121** | 1.018–1.226 | 121, 114, 118, 108, 122 | **REAL** |
| `prior_ryoe_per_att` | charting | ≥0.29 vs ≤−0.10 | 14% | 77 / 77 | **1.212** | 1.057–1.390 | 1.061 | 0.898–1.263 | 48, 48, 43, 47, 44 | **REAL (share only, thinnest column in the set)** |
| `prior_snap_share` | role | ≥0.71 vs ≤0.43 | 74% | 415 / 415 | 1.047 | 0.982–1.110 | 1.026 | 0.947–1.117 | 0, 309, 304, 316, 314 | DECLINED |
| `prior_wopr` | role | ≥0.264 vs ≤0.098 | 78% | 438 / 438 | 1.012 | 0.952–1.070 | 1.031 | 0.947–1.113 | 0, 337, 320, 329, 326 | DECLINED |
| `prior_air_yard_share` | role | ≥0.119 vs ≤0.007 | 78% | 438 / 438 | 0.994 | 0.940–1.051 | 1.001 | 0.928–1.085 | 0, 337, 320, 329, 326 | DECLINED |
| `prior_epa_per_play` | role | ≥0.207 vs ≤−0.016 | 78% | 438 / 438 | **1.091** | 1.025–1.153 | **0.866** | 0.794–0.942 | 0, 337, 320, 329, 326 | **REAL, and it changes sign** |
| `prior_xfp_per_game` | role | ≥10.9 vs ≤5.3 | 60% | 334 / 335 | 1.027 | 0.965–1.095 | 0.998 | 0.909–1.095 | 0, 0, 327, 338, 337 | DECLINED |
| `prior_xfp_diff` | role | ≥0.46 vs ≤−0.48 | 60% | 334 / 335 | **1.113** | 1.046–1.188 | **0.810** | 0.737–0.889 | 0, 0, 327, 338, 337 | **REAL, and it changes sign** |
| `capital_added_at_position` | competition | any vs none | 100% | 330 / 1350 | 0.989 | 0.937–1.040 | 0.981 | 0.910–1.058 | 335, 343, 327, 338, 337 | DECLINED |
| `top_pick_added_at_position` | competition | ≥162 vs ≤74 | 44% | 249 / 253 | 1.010 | 0.935–1.090 | 1.039 | 0.934–1.156 | 162, 151, 141, 140, 138 | DECLINED |
| `veterans_added_at_position` | competition | ≥3 vs ≤2 | 100% | 872 / 808 | 0.975 | 0.934–1.017 | 0.986 | 0.929–1.047 | 335, 343, 327, 338, 337 | DECLINED |
| `new_team_vacated_target_share` | competition | ≥0.378 vs ≤0.236 | 80% | 460 / 456 | 0.989 | 0.931–1.047 | 0.978 | 0.901–1.056 | 0, 343, 327, 338, 337 | DECLINED |
| `new_team_vacated_carry_share` | competition | ≥0.399 vs ≤0.143 | 80% | 450 / 453 | 0.959 | 0.902–1.019 | 0.995 | 0.915–1.079 | 0, 343, 327, 338, 337 | DECLINED |
| `own_team_vacated_share` | competition | ≥0.383 vs ≤0.233 | 78% | 440 / 443 | **0.924** | 0.871–0.983 | 0.966 | 0.894–1.046 | 0, 337, 320, 329, 326 | **REAL (share only), and the sign is backwards** |
| `depth_slot_t` | depth | ≥2 vs ≤1 | 93% | 636 / 920 | **0.848** | 0.812–0.887 | **0.843** | 0.789–0.896 | 301, 312, 299, 311, 333 | **REAL — and it is a level, see §4** |
| `depth_slot_delta` | depth | any vs none | 66% | 221 / 885 | **0.814** | 0.759–0.873 | **0.792** | 0.712–0.879 | 0, 253, 272, 286, 295 | **REAL — v1's demotion effect on a second source** |
| `qb_qbr_delta` | qb_coach | QB upgrade vs not | 56% | 127 / 806 | 1.047 | 0.965–1.132 | **1.140** | 1.022–1.278 | 0, 275, 217, 213, 228 | **REAL (PPG only, n=127)** |
| `hc_tenure_years` | qb_coach | ≥4 vs ≤2 | 100% | 582 / 691 | 0.993 | 0.945–1.040 | 0.989 | 0.925–1.054 | 335, 343, 327, 338, 337 | DECLINED |
| `implied_team_points` | team | ≥23.7 vs ≤21.0 | 100% | 566 / 564 | 0.976 | 0.929–1.026 | 1.040 | 0.974–1.106 | 335, 343, 327, 338, 337 | DECLINED |
| `implied_points_delta_vs_prior` | team | ≥0.87 vs ≤−1.56 | 100% | 560 / 564 | **0.901** | 0.854–0.948 | 1.028 | 0.957–1.102 | 335, 343, 327, 338, 337 | **REAL (share only), sign backwards, and see the closing-line caveat** |
| `division_sos_proxy` | team | ≥22.6 vs ≤21.9 | 100% | 566 / 572 | **1.100** | 1.044–1.161 | 1.036 | 0.970–1.112 | 335, 343, 327, 338, 337 | **REAL (share only), closing-line caveat** |
| `team_pass_rate_prior` | team | ≥0.593 vs ≤0.559 | 100% | 563 / 564 | 0.992 | 0.943–1.044 | 0.986 | 0.922–1.055 | 335, 343, 327, 338, 337 | DECLINED |
| `team_plays_prior` | team | ≥64.4 vs ≤61.9 | 100% | 570 / 581 | 1.053 | 1.001–1.106 | 1.012 | 0.945–1.086 | 335, 343, 327, 338, 337 | **REAL (share only, CI touches 1)** |
| `team_points_per_game_prior` | team | ≥24.7 vs ≤20.5 | 100% | 567 / 567 | 1.048 | 0.992–1.105 | 1.008 | 0.941–1.081 | 335, 343, 327, 338, 337 | DECLINED |
| `dome_home` | team | 1 vs 0 | 100% | 558 / 1122 | 1.042 | 0.996–1.091 | 1.053 | 0.991–1.117 | 335, 343, 327, 338, 337 | DECLINED |
| `bye_week` | team | ≥11 vs ≤8 | 100% | 661 / 600 | 0.995 | 0.949–1.046 | 1.038 | 0.975–1.111 | 335, 343, 327, 338, 337 | DECLINED |
| `injury_games_missed_prior` | injury | ≥1 vs 0 | 65% | 407 / 685 | 0.987 | 0.940–1.041 | 1.019 | 0.956–1.086 | 0, 275, 268, 272, 277 | DECLINED |
| `injury_reports_prior` | injury | ≥5 vs ≤2 | 65% | 446 / 367 | 0.992 | 0.934–1.048 | 1.007 | 0.930–1.088 | 0, 275, 268, 272, 277 | DECLINED |
| `ir_stints_prior` | injury | any vs none | 65% | 53 / 1039 | 0.937 | 0.831–1.050 | 0.994 | 0.857–1.157 | 0, 275, 268, 272, 277 | DECLINED |
| `late_season_injury_flag` | injury | 1 vs 0 | 65% | 260 / 832 | 1.001 | 0.942–1.062 | 1.024 | 0.940–1.113 | 0, 275, 268, 272, 277 | DECLINED |
| `age_at_season` | bio | ≥28.0 vs ≤25.4 | 100% | 560 / 562 | **0.837** | 0.796–0.881 | **0.806** | 0.754–0.867 | 335, 343, 327, 338, 337 | **REAL — already a control (§2), not publishable** |
| `years_exp` | bio | ≥5 vs ≤3 | 100% | 724 / 741 | **0.888** | 0.849–0.929 | **0.888** | 0.834–0.944 | 335, 343, 327, 338, 337 | **REAL — age again, in other units** |
| `draft_round` | bio | ≥4 vs ≤2 | 81% | 490 / 622 | **0.929** | 0.882–0.979 | 0.915 | 0.853–0.980 | 257, 272, 269, 276, 283 | **REAL — a level, and constant across a career** |

Three things in that table are worth more than their row.

**`prior_epa_per_play` and `prior_xfp_diff` change sign between the outcomes.**
A player who beat his expected fantasy points last year gains opportunity share
(1.113) and loses points per game (0.810). That is regression to the mean in
efficiency arriving alongside a promotion in role, and it is the clearest
evidence in this document that share and PPG are two different questions rather
than one question measured twice.

**`own_team_vacated_share` and `implied_points_delta_vs_prior` are both
backwards.** A player whose own team lost a lot of opportunity does *worse*
(0.924), and a player whose team's implied points went up does *worse* (0.901).
These are not mechanisms; they are selection. Teams shed opportunity because
they were bad and are rebuilding, and implied totals rise for teams that just
changed something. This is the same null §2 found for the vacated-room
interaction, arriving from two more directions.

**`depth_slot_delta` (0.814) replicates v1's demotion effect (0.712) on an
independent source** — the `off_depth_chart` opening chart against the last
regular-season chart of `T-1`, rather than `nfl_depth` against a usage rank.
Two sources, two constructions, same sign and overlapping magnitude. It is the
only v2 line that measures an offseason *change* and survives.

## 9.3 Joint, in the ridge and in a GBM

`walkForwardV2`, same three held-out seasons, same rows, ridge with
leave-one-season-out lambda inside each training window, v1's shipped model as
the incumbent. n = 1,002 (share) / 999 (PPG). Negative = better than v1.

| candidate | share MAE | ρ | vs v1 (share) | seasons SIG | PPG MAE | vs v1 (PPG) | seasons SIG |
|---|---|---|---|---|---|---|---|
| v1 shipped (incumbent) | 0.3303 | 0.336 | — | — | 0.4387 | — | — |
| + charting block | **0.3240** | 0.370 | **−0.0063 SIG** [−0.0099,−0.0026] | **2 / 3** | 0.4353 | −0.0034 SIG | 1 / 3 |
| + role block | 0.3325 | 0.323 | +0.0022 ns | 0 / 3 | 0.4347 | −0.0041 ns | **2 / 3** |
| + competition block | 0.3333 | 0.322 | +0.0030 **SIG worse** | 0 / 3 | 0.4404 | +0.0017 ns | 0 / 3 |
| + depth block | 0.3370 | 0.317 | +0.0067 **SIG worse** | 0 / 3 | 0.4425 | +0.0038 SIG worse | 0 / 3 |
| + QB/coach block | 0.3315 | 0.324 | +0.0012 ns | 0 / 3 | 0.4394 | +0.0007 ns | 0 / 3 |
| + team block | 0.3320 | 0.330 | +0.0017 ns | 0 / 3 | 0.4375 | −0.0013 ns | 0 / 3 |
| + injury block | 0.3320 | 0.334 | +0.0017 ns | 0 / 3 | 0.4403 | +0.0016 SIG worse | 0 / 3 |
| + bio block | 0.3249 | 0.374 | −0.0054 SIG | 1 / 3 | 0.4339 | −0.0049 SIG | 1 / 3 |
| **v2 all blocks** | 0.3276 | 0.359 | −0.0026 **ns** | 1 / 3 | **0.4310** | −0.0077 SIG | **2 / 3** |
| **v2 GBM** (200 trees, depth 3, lr 0.05) | **0.3165** | **0.419** | −0.0137 SIG | 1 / 3 | 0.4291 | −0.0096 SIG | 1 / 3 |

Two blocks help as a *fit* — charting and bio — and adding all 78 v2 columns at
once helps less than adding charting alone, which is what a ridge does when most
of what it is handed is noise. The GBM has the best pooled numbers of anything
ever fitted here and still clears the per-season bar in only one season of
three; its 2023 and 2024 margins are the same size as its 2025 one and neither
survives the clustered bootstrap.

## 9.4 The comparison that decides it

None of §9.3 is what ships. `offseasonAdjustment` publishes a **multiplier**,
which a caller applies to a prior of his own — so a candidate that wins on
better *controls* wins nothing at all. `multiplierWalkForward` grades exactly
the published quantity: the mean-reversion prior plus that model's own change
partial, clamped to `[0.4, 1.6]` the way the shipped number is.

One correction is applied to every candidate equally. The published multiplier is
defined against a player with **no** change, while the mean-reversion prior a
caller holds is fitted on **every** player, average change included — so adding
one to the other charges the league's average offseason twice. The centred
variant subtracts the training-set mean partial. It is worth 0.0115 log units of
share MAE to v1 on its own (0.3451 → 0.3336), which is larger than any feature
difference in this document, and it is a fact about consumption, not about
features. Candidates are compared centred against centred.

| candidate (centred) | share MAE | vs v1 | 2023 | 2024 | 2025 | PPG MAE | vs v1 | seasons SIG |
|---|---|---|---|---|---|---|---|---|
| mean reversion only, no multiplier | 0.3416 | +0.0080 | — | — | — | 0.4475 | +0.0043 | — |
| **v1 multiplier (incumbent)** | **0.3336** | — | 0.3410 | 0.3409 | 0.3189 | **0.4432** | — | — |
| v2 charting multiplier | 0.3356 | +0.0020 **SIG worse** | +0.0037 SIG worse | +0.0012 ns | +0.0013 ns | 0.4428 | −0.0004 ns | 0 / 3 |
| v2 all-blocks multiplier | 0.3350 | +0.0015 ns | +0.0039 SIG worse | +0.0023 ns | −0.0017 ns | 0.4427 | −0.0004 ns | 0 / 3 |

**v2 beats v1 on the published multiplier in 0 of 3 seasons on share and 0 of 3
on PPG**, and is significantly worse in 2023 in both variants. The ship rule
required ≥2 of 3. It is not met, and it is not close.

Read against §9.3 the reason is plain: the charting and bio blocks improve the
*forecast* by describing the player better, and describing the player better
does not change what his offseason did to him. That is v1 §4's finding on a
feature set four times the size.

## 9.5 The nested ablation, re-run with the new blocks

Same walk-forward, same rows, each row adds one block to the row above
(share, n = 1,002).

| feature set | share MAE | ρ | vs previous row |
|---|---|---|---|
| prior log share + position | 0.3395 | 0.249 | — |
| + two-year usage trend, age terms | 0.3278 | 0.358 | −0.0117 **SIG** [−0.0155,−0.0079] |
| + season-`T` depth level | 0.3198 | 0.410 | −0.0081 **SIG** [−0.0131,−0.0033] |
| + the v1 change block | 0.3185 | 0.418 | −0.0013 **ns** [−0.0054,0.0030] |
| + v2 charting | **0.3132** | **0.436** | **−0.0053 SIG** [−0.0079,−0.0027] |
| + v2 role | 0.3184 | 0.419 | +0.0052 SIG worse |
| + v2 competition | 0.3205 | 0.412 | +0.0021 SIG worse |
| + v2 depth | 0.3239 | 0.394 | +0.0034 SIG worse |
| + v2 QB/coach | 0.3246 | 0.392 | +0.0007 ns |
| + v2 team | 0.3220 | 0.406 | −0.0026 ns |
| + v2 injury | 0.3205 | 0.414 | −0.0015 ns |
| + v2 bio | 0.3206 | 0.412 | 0.0000 ns |

**Exactly one thing in the 66 columns is additive over trend + age + the
season-`T` depth chart: the prior-season charting block** (broken tackles, aDOT,
drop rate, NGS separation/cushion/air-yards share, YAC over expected, RYOE),
worth a held-out 0.0053 log units. Everything after it makes the model worse or
does nothing, and `bio` adds precisely zero once charting is in — because age
was already in row 2.

That result belongs to whoever owns the preseason projection, not to this
module. It is a prior-season description of the player, on the same footing as
age in §2: real, well measured, and someone else's to apply. Publishing it here
would double-count it in any consumer that reads both.

## 9.6 Declined, with the number

Every variable in §9.2 with a DECLINED verdict is declined on both outcomes with
its CI straddling 1, and is not offered as a small effect. The ones most likely
to be proposed again, with the number that closed them:

- **Draft capital added at his position** — 0.989 share (0.937–1.040), 0.981 PPG.
  A team spending a first-, second- or third-rounder on his position group does
  not measurably cost the incumbent opportunity. n = 330 vs 1,350.
- **Veterans added at his position** — 0.975 (0.934–1.017). Same null, free-agency
  flavoured.
- **Vacated room on the team he joined** — 0.989 (targets) / 0.959 (carries).
  The third independent failure of the vacated-room story in this document.
- **Every injury-history column** — games missed 0.987, reports 0.992, IR stints
  0.937 (n=53), late-season flag 1.001. v1's `games_missed_prior >= 4` effect
  (0.921) does not extend to a finer injury history; the richer columns measure
  the same thing worse.
- **QB change quantified by QBR** — 0.981 share, but 1.140 PPG (1.022–1.278) on
  n = 127 upgrades. PPG-only, share-null, one thin arm, and the share nulls in
  §2 stand. Not priced.
- **Team pace, dropback rate, points, dome, bye week** — 0.99 to 1.05, every CI
  across 1. The team's shape does not redistribute a player's share of it.
- **Contract columns** — untestable, not null. The feed stops in 2022.

## 9.7 Verdict

**SHIPPED v1.** The published model is unchanged: ridge on prior log share +
position + team change (×0.823) + depth demotion (×0.712) + prior-year 4+ games
missed (×0.921), held out at 0.3303 share MAE / 0.4387 PPG MAE on 2023-2025, and
0.3336 / 0.4432 when graded as the multiplier a caller actually applies. v2 —
the same model with all 78 columns of the 66-feature set, or with the one block
that helps the regression — scores 0.3350 / 0.4427 on that same grading, beating
v1 in **0 of 3 held-out seasons on share and 0 of 3 on PPG**, and losing
significantly in 2023. The ≥2-of-3 bar was not met by any candidate.

What the pass did buy: `depth_slot_delta` (0.814, CI 0.759–0.873) replicates the
shipped demotion effect on an independent source, and the prior-season charting
block is additive over everything (−0.0053 SIG) but belongs to the preseason
projection rather than to a multiplier. Both are recorded above; neither changes
a number this module publishes.
