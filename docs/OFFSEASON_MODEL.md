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
a model that already has those** — see [What this does not add](#what-this-does-not-add).

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
```
