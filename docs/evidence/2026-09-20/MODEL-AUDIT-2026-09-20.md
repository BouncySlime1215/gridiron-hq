# Is the fantasy model smart, or is it guessing? — 2026-09-20

Audit of `origin/main` at **791b131** (the deployed tree), answering Nick's four
questions one at a time. Every claim is a `file:line` on that commit or a number
measured here. Where a number could be measured, it was measured rather than
described; where it could not, this says so in the word "guess".

Local check for this branch: `npm ci` then `npm test` — **2,950 tests, 2,909
pass, 0 fail, 41 skipped** (354s). No server file is edited; this branch adds one
script and this document.

The measurement database is a scratch rebuild from the public sources the app
itself uses (`nflverse` crosswalk + `stats_player_week`, seasons 2021-2026):
8,294 players, 29,755 `player_week_usage` rows, 2026 through week 2. The live
`/data/data.sqlite` was not read or written.

---

## The short answer

| Question | Answer |
|---|---|
| What is an opportunity made of? | The structural head's `params.targets` / `params.carries` — a shrunk share of a shrunk team volume. No advanced stat enters it. |
| Is that tested on history? | **It is now. It loses.** Measured below on 4,828 paired player-weeks: as shipped it is significantly *worse* than the player's own season-to-date average, and worse than an EWMA of his own recent games. With the shrinkage fit that is already in the repo but never persisted, it beats both. |
| Is this trade fair? | "Fair" means the FantasyCalc market price, passed through untouched (`trade-engine.js:418`). Not our judgement, and not tested. |
| What will they accept? | A band that is honest about being a guess: with no counterparty data it is **2.5%-57.5%**, and `trade-acceptance.js` says in its own header "Nothing here is fitted." |
| What does it do for me? | A real lineup re-solve on `adj_ppg`, which is 25% this week + 75% rest-of-season. The rest-of-season part is the best-tested number in the app. The 25/75 split itself is a guess, and the rest-of-season half carries no availability term — which bites on the graded middle (a partial chance to play), not on a confirmed season-ender, which is caught elsewhere. |
| What's the goal? | Two goals, and the app knows it. Find Deals ranks on points; Title Trades ranks on championship odds and prints a note when they disagree. The championship odds themselves have no historical calibration. |
| How good is my team? | Two answers that do not talk to each other: a real relative rank against the league's own rosters, and a title percentage simulated from **week 1** on **through-2025** projections. |
| Are the efficiency numbers tested? | **They are now, and they mostly hold.** Nothing on a nine-point grid beats the shipped `yards_per: 34`, `catch_rate: 26` or `td_rate: 70` on 2024-2025, and every value *below* each literal loses. But all six curves bottom out at or above the literal, and on 2023 — a season the grid never saw — `k = 68` beats 34 for yards per target, interval clear of zero. The defect is not that 34 is wrong; it is that one constant serves yards per target, per carry and per attempt, and the three disagree about what it should be. |
| Can a worse model be published as a better one? | **Yes, in one place, and it is a live bug.** The offseason model's pooled comparison pairs two arms by index when one has fewer rows than the other, which happens whenever the GBM fit throws for one test season and succeeds for the others. Demonstrated below: a challenger genuinely worse by +0.10 comes back as **-0.80, 90% CI [-0.80, -0.80], significant**. The guard written in September to prevent exactly this closes the mirror case and lets this one through. |
| Where is ML? | Real and validated in the weekly point number (ensemble weights, ridge coordinator). Absent from opportunity, trades, acceptance and title odds. The advanced-stat feature store and the GBM are on the **betting** side and are not shared. For next-week *volume* specifically, ML was tried with those stats and lost to a four-line EWMA — a tested negative, not a gap. |

---

## 1. Opportunity

### What it is made of

`News.tsx:149-153` prints `N att · N tgt · N car · N% tgt share`. That comes from
`projections.js`, which builds volume as:

> **Precision, after the Opportunity thread read this file.** What the card
> renders is `projection.volume.targets_per_game × roleMultiplier ×
> activeProbability` (`news-fantasy-impact.js:118`), a what-if scenario scaled by
> a role multiplier and the chance he plays. What the backtest below grades is
> `projection.params.targets`. Those are the **same number** before scaling —
> `projections.js:723` sets `targets_per_game` from the same local as
> `params.targets` at `:697`, and the only step that can separate them,
> `applyRedistribution`, runs behind `redistributeVolume = false`
> (`player-week-engine.js:262`, `:381`). So the graded quantity is the card's
> quantity before the scenario multipliers, and the verdict carries. The earlier
> shorthand "the 6 tgt · 12 car a user reads" named the scaled number and has
> been corrected here rather than left to imply the multipliers were graded.

- a player's **target share** and **carry share**, shrunk toward a positional
  prior (`projections.js:719-720`: 0.06 target share, 0.25 carry share for RB
  and 0.02 otherwise);
- the **team's** pass and rush attempts, shrunk toward a league prior;
- multiplied together.

The shrinkage strengths are two literals, `projections.js:94-96`:

```js
const K = {
  share: 6,          // target/carry share
  team_volume: 10,   // team pass/rush rate
```

No EPA, CPOE, RACR, PACR, WOPR, air-yards share, Next Gen Stats or PFR advanced
column enters this. Those tables are synced and are read by thirteen
`nfl-*.js` modules on the betting side; the fantasy projection reads
`player_week_usage`, `nfl_depth`, `nfl_injuries`, `game_lines` and `players`.
Snap share appears in exactly one place on the fantasy side, and it is a
**sentence**, not a number (`player-week-engine.js:731`).

### Is that tested on history?

Not until now. The shrinkage constants were validated on fantasy **points**, never
on opportunity itself. `scripts/grade-opportunity-vs-baseline.mjs` (added on this
branch) grades the opportunity number directly, against the one baseline a manager
has without us: **the player's own season-to-date average.**

Population: 2024 and 2025, weeks 5-17, players with at least three prior in-season
games and a prior mean of at least three targets+carries. The gate reads only raw
usage, so switching the shrinkage constants cannot change who is graded. Both arms
and the baseline share all 4,828 rows. Significance is a paired bootstrap
clustered by player; the interval is on `baseline_error - model_error`, so
positive means the model wins.

| season | metric | n | own average | **model as shipped (k = 6/10)** | model with the fitted k |
|---|---|---|---|---|---|
| 2024 | targets | 2,461 | 1.773 | **2.006** · CI [−0.298, −0.174] | 1.749 · CI [+0.008, +0.039] |
| 2024 | carries | 2,461 | 1.626 | **2.003** · CI [−0.465, −0.295] | 1.600 · CI [+0.003, +0.052] |
| 2025 | targets | 2,367 | 1.768 | **1.901** · CI [−0.198, −0.074] | 1.735 · CI [+0.017, +0.050] |
| 2025 | carries | 2,367 | 1.602 | **1.943** · CI [−0.421, −0.268] | 1.575 · CI [+0.011, +0.044] |

MAE in targets or carries. All eight intervals exclude zero.

**As shipped, the opportunity number is beaten by an average a manager could do
in his head** — by 8% on targets and by 21-23% on carries. With the fitted
shrinkage it beats that baseline in all four cells. The sign flips.

The fitted constants are not a proposal; the fitter is in the repo and reproduces
independently. Fit through 2025 on this rebuild:

| metric | fitted k | shipped k |
|---|---|---|
| `target_share` | 0.175 | 6 |
| `carry_share` (RB) | 0.081 | 6 |
| `carry_share` (other) | 0.090 | 6 |
| `qb_attempts` | 0.264 | 6 |
| `team_pass_att` | 1.277 | 10 |
| `team_rush_att` | 1.708 | 10 |

Volume is regressed 6x to 74x harder than the data supports, in a head whose
stated thesis (`projections.js:4`) is that opportunity should be trusted.

`shrinkage_fits` and `shrinkage_k` are empty on the live database, so
`activeFitMeta()` returns null, `cutoffSafeKVector()` returns null, and every
caller takes the hardcoded branch at `projections.js:203-206`. **This is a
database write, not a code change**, and `docs/RUNBOOK-promote-volume-shrinkage.md`
already describes it.

### And against the strongest baseline the repo already knows about

A season-to-date average is the baseline a *manager* has. The baseline the
*repository* has is stronger, and it is four lines long: an exponentially
weighted average of the player's own recent games at alpha 0.4
(`opportunity-model.js:350`, recursion at `:64-69`). That module's own study
(`docs/OPPORTUNITY-FINDINGS-2026-09-19.md`, section 3) found that a sixteen-feature
ridge over air-yards share, WOPR, snap trajectory, ffopportunity expected points,
vacated teammate share, spread, implied total and opponent funnel **could not beat
it** for next-week volume. It had never been graded against what the app actually
ships. Added as a third arm on the same 4,828 rows:

| season | metric | own average | EWMA a=0.4 | **shipped (k = 6/10)** | fitted k |
|---|---|---|---|---|---|
| 2024 | targets | 1.773 | 1.804 | **2.006** | 1.749 |
| 2024 | carries | 1.626 | 1.606 | **2.003** | 1.600 |
| 2025 | targets | 1.768 | 1.770 | **1.901** | 1.735 |
| 2025 | carries | 1.602 | 1.588 | **1.943** | 1.575 |

Paired bootstrap clustered by player, interval on `ewma_error - model_error`, so
positive means the model beats the EWMA:

| season | metric | shipped vs EWMA | fitted k vs EWMA |
|---|---|---|---|
| 2024 | targets | [−0.264, −0.146] | **[+0.034, +0.076]** |
| 2024 | carries | [−0.483, −0.316] | [−0.023, +0.034] |
| 2025 | targets | [−0.187, −0.078] | **[+0.016, +0.056]** |
| 2025 | carries | [−0.434, −0.285] | [−0.014, +0.039] |

Three things follow.

1. **As shipped, the whole structural apparatus loses to a four-line recursion**,
   in all four cells, every interval clear of zero. Not "is inside the noise of" —
   loses to.
2. **With the fitted k it beats that recursion on targets** in both seasons, and
   ties it on carries. So promoting the shrinkage fit is not a marginal MAE
   improvement: it is the difference between machinery that is worse than the
   simplest thing in the repo and machinery that is modestly better than it.
3. The EWMA itself is not better than a plain season average — one of its four
   cells is significantly worse (2024 targets, [−0.057, −0.006]) and the other
   three straddle zero. The naive baselines are close to each other; it is the
   shipped model that is the outlier, in the wrong direction.

Sizes are small in absolute terms — 0.03 to 0.08 of a target per week — and these
are 90% intervals from a 2,000-iteration bootstrap. The claim is the sign and its
consistency, not the magnitude.

**What this does to the "use advanced stats and ML" question.** It narrows it.
The advanced stats are not unexplored: for *next-week volume* they were tried,
in the most favourable form anyone would build, and they lost to the EWMA — which
the fitted-k structural head then beats. So the ranked answer for opportunity is
promote the fit first, and treat air-yards share and WOPR as a tested negative for
this particular prediction rather than an obvious win waiting to be wired up.
They remain unexplored for the *efficiency* half (yards per target, catch rate,
touchdown rate), which is a different question and is where RACR, PACR and CPOE
would actually speak.

### What a user is told

Honestly, and better than anywhere else in the app. The News card is stamped
`SHADOW` (`News.tsx:135`), shows its model cutoff, and carries a **Live model
check** panel that grades the projection against the week's actual usage once the
game is played (`News.tsx:157-163`). It is the only surface in the app that shows
its own number being marked.

---

## 2. Trades

### "Is this fair?"

Fairness is the FantasyCalc market price and nothing else. Each asset carries
`value: m?.value ?? 0` from `dynasty_values` (`trade-engine.js:418`); a side's
value is the sum (`:1083-1084`); the label comes from hand-set cuts
(`:1233-1241`): ±4% is "even money", ±12% is "slightly", beyond that "lopsided".

Two consequences worth stating plainly:

- **It is not our opinion.** Whatever FantasyCalc says, the app repeats. The
  model's own projection does not price the trade's fairness at all.
- **A player FantasyCalc does not list is worth zero** (`?? 0`), so he is free in
  every fairness calculation.

### "What will they accept?"

There is now a real answer, `trade-acceptance.js#acceptanceBand`, rendered at
`ManagerRead.tsx:300`. It is a band, not a number, and it is candid: its header's
third line is *"Nothing here is fitted."* Each source carries its own cap —
perception 0.30, receptiveness 0.12, a stated no 0.08 — and the band's width is
set by how much evidence stands behind the anchor, not by how confident the
heuristic feels.

Measured by calling it directly:

| what we know about the manager | band shown |
|---|---|
| nothing (`manager_profiles` empty — today's state) | **2.5% - 57.5%**, basis `no_information` |
| chat read, no decided offers | 18.7% - 63.7%, basis `heuristic_unanchored` |

So today the honest answer to "what will they accept" is a 55-point-wide band
whose own code calls its centre "a declared starting point, not knowledge". That
is the right behaviour for an unfitted quantity. It is not an answer to the
question yet, and it will not become one until decided proposals accumulate
(forward capture began 2026-09-17; the count is 6 accepts to 24 declines).

### "What does this do for me?"

A real lineup re-solve. `evaluate()` (`trade-engine.js:1046`) solves the optimal
starting lineup before and after the deal and reports the difference. The number
it solves on is `adj_ppg`:

```js
// trade-engine.js:385
const decisionPpg = 0.25 * currentWeekPpg + 0.75 * rosPpg;
```

- `rosPpg` — the best-tested number in the app. `ros-projection.js` is
  `0.5 * structural + 0.5 * [n/(n+4) * season-to-date + 4/(n+4) * market prior]`,
  fitted by `scripts/fit-ros-projection.mjs` and passed on a pre-registered gate:
  2024 weeks 1-4 MAE 3.83/3.13/2.90/2.91 → 2.47/2.36/2.42/2.51, 2025
  3.58/3.12/2.85/2.79 → 2.37/2.32/2.42/2.44, **12 of 12 checks passed**
  (`ros-projection.js:44-67`).
- `0.25 / 0.75` — a guess. Nothing has measured it.
- `rosPpg` carries **no availability term** (`trade-engine.js:365-367`).

> **Correction, raised by the thread that owns `trade-engine.js` and verified
> here.** An earlier draft of this file said "75% of a player's trade value
> survives an injury that ends his season." **That is withdrawn.** Trade *value*
> is the market map — `value: m?.value ?? 0` at `trade-engine.js:419` — and it
> never reads `adj_ppg`. What `adj_ppg` drives is `bestLineup` (its default key,
> `:611`), and therefore `ppg_delta`, `season_delta` and every "does this trade
> improve my Sunday" sentence. The confirmed season-ending case is also caught,
> not missed: `available: false` at `:441` is guarded at `:616`, `:203` and
> `:448`. What is genuinely unguarded is the graded middle — a 40-60% chance for
> some weeks, an IR stint with a return — plus the hand-set 0.92 default chance
> to play at `:346`. That is a smaller and more specific defect than the sentence
> it replaces, and the proposed fix (a rest-of-season availability persistence
> curve fitted walk-forward from `player_week_usage`) is a new model and needs
> Nick's word.

Two display numbers on the same card are on the wrong horizon:
`season_delta = ppg_delta × 17` at `trade-engine.js:1096` (`GAMES = 17` at `:119`)
is rendered as "over the season" at `TradeCard.tsx:109`, at week 2 of a season
with at most 16 weeks left and a fantasy calendar the app already knows
(`trade-horizon.js#leagueSchedule`). `proj` at `:415` uses `18 − week` for the
same reason.

### "What's the goal here?"

The app has two, and it is honest about the gap.

**Find Deals** maximises (`trade-engine.js:1651-1653`):

```
score = receptiveness × tierFactor × fairnessFactor × perceptionFactor
        × (horizonGain + 0.2 × joint_ppg)  −  0.9 × max(0, theirValuePct) / 20
```

Every constant in that line is hand-set and the file says so at each one: the
fairness sigmoid and its 0.60 cap (`:1618-1620`), `VALUE_GIVEAWAY_LAMBDA = 0.9`
(`:138`, comment: "NOT FITTED"), `HARD_TIER_FACTOR = 0.55` (`:1348`), the ±10%
perception bound **on the deal score** (`:1362-1366`), the `0.2` on joint gain, and the search filters at `:1564-1572`.

**Title Trades** re-simulates each shortlisted deal and ranks on championship
odds (`title-odds-trades.js:64-88`), then prints which ranking to ignore when the
two disagree (`:112-128`). That is the correct structure, and it is the best
piece of design in the trade half: *"Points is a proxy; this is the thing it
proxies for."*

One number to read carefully. The card shows `title_delta` to two decimals of a
percentage (`TradeLab.tsx:291`), e.g. "+0.34%". The app's own measurement of that
quantity's seed-to-seed noise is sd **0.0107 at 1,200 runs**
(`trade-verify.js:78-90`) — about ±1.1 percentage points. The sense-check has a
`MATERIAL_TITLE_DELTA = 0.01` floor for exactly this reason
(`trade-verify.js:111-116`); the Title Trades card does not apply it.

### The label that scores nothing

`analyzeLeague` gives each rival a contention window — "Win-now", "Rebuild",
"Juggernaut" — from market capital ÷ league median and a core age of 25.5/27.5
(`tradelab.js:170-190`). It is passed into `evaluate()` as `ctx.theirWindow`, and
`evaluate` assigns it straight to its output (`their_window`) without reading it.
It reaches exactly one consumer: a chip at `TradeCard.tsx:237`. **No number in
the app is affected by it.** It is also a dynasty heuristic (age of core, draft
capital) applied to redraft leagues.

---

## 3. How good is my team, actually?

Two numbers, computed differently, that never reconcile.

**`selfScout` (`trade-engine.js:2439`) is real and relative.** It solves every
rival's optimal lineup from the same projections and ranks yours among them
(`:2454-2457`), then does the same per position and runs a depth test — what the
lineup loses if your best player at that position goes down (`:2470-2473`). The
comparison is honest; the words on top of it are cuts (`:2484`: strength above
1.12× the league average, weakness below 0.88×). Nobody has graded whether that
rank predicts anything.

**The title percentage is the headline, and it is the weakest number on the
page.** `MyTeam.tsx:62` calls `/model/${id}/simulate?runs=1500` and passes no
`from_week`, so `simulateSeason` takes its default `fromWeek = 1`
(`season-sim.js:173`). At week 2 of 2026 that means:

- `initialRecords` returns zeros (`season-sim.js:122`), so **your real record is
  discarded** and week 1 is simulated again;
- scoring is drawn from `buildProjections({ through: SEASON - 1 })`
  (`season-sim.js:180`), so **no 2026 game informs the odds** — this is the one
  projection basis in the app that ignores the current season, while Start/Sit,
  waivers and trades all use the weekly engine;
- a 2026 rookie with no earlier history has no `pr` entry and is dropped from the
  simulated pool entirely (`:219`, `:237`);
- the bracket is fixed at weeks 15-17 (`:195`, `matchups.js:25`) although
  `trade-horizon.js#leagueSchedule` derives each league's real playoff weeks and
  two of the five leagues are not shaped that way.

**There is no historical calibration of these odds anywhere in the repository.**
No script, no test, no evidence file grades a week-w playoff or title probability
against how a season actually finished. Its Monte Carlo *noise* has been measured
carefully (`trade-verify.js`); its *accuracy* has never been measured at all.

The trade horizon does now get real odds — `playoffOddsFor` calls the simulator
with `fromWeek: target.week` (`trade-engine.js:1317-1319`), which closes a gap
from the 2026-09-18 provenance audit. Those odds then weight the playoff leg via
`PLAYOFF_IMPORTANCE = 4` (`trade-horizon.js:34`), a borrowed published
finals-to-advance ratio.

---

## 4. Advanced stats and ML — where they are, where they are not

**Where ML is real, validated, and shipping.** `fantasy-coordinator.js` is a
week-clustered Huber ridge over three experts with walk-forward shrinkage,
correlation-based family de-duplication, and a pre-registered gate. Its result is
stated without flattery in its own header: the coordinated projection beats the
plain structural projection in all three testable seasons, Holm-corrected,
p ≈ 0.0005 each, MAE ≈ 4.28-4.40 against ≈ 4.41-4.52. The header also records
that `boom_bust_signal` shrank to **k = 0** — earned no weight — and that a
mixture-of-experts regime split was tested and **rejected**. That is the right
discipline.

`weekly-ensemble.js` is a fitted convex blend of five heads, promoted through a
gate, with a separate early-week bucket set for weeks 2-4.

### The defect: that ML is added to the wrong number

`coordinateFantasy(fit, expertValues, structuralPpg)` returns
`structuralPpg + correction` (`fantasy-coordinator.js:457`, `:478`). The fit's
target is `actualPoints - projection.structural_ppg` (`:324`), and the validation
gate grades `|target − correction|` (`fantasy-coordinator.js:519`) — so what was
proven is **structural + correction beats structural**.

Both live call sites pass the *ensemble* number instead:

```js
// trade-engine.js:347, :354
const weeklyPpg = weekProjection?.ppg ?? (proj / GAMES);
const coordinated = expertValues ? coordinateFantasy(fantasyFit, expertValues, weeklyPpg) : null;

// fantasy-coordinator.js:571  — the module's own convenience wrapper
const coordinated = expertValues ? coordinateFantasy(fit, expertValues, projection.ppg) : null;
```

So production serves `ensemble + correction`, a combination that was never
graded. The error is exactly `ppg − structural_ppg`, which the engine already
computes and stores as `ensemble_shift`. And `ensemble_shift` is itself one of
the three experts the correction is built from (`:33`), so the ensemble's
departure from the structural head is counted once inside the base and again
inside the correction.

**Measured on the scratch rebuild**, over players with `structural_ppg ≥ 3`:

| season, week | startable | carry a non-zero shift | mean abs | median | p90 | max |
|---|---|---|---|---|---|---|
| 2025 W2 | 1,059 | 354 (33%) | 1.96 | 1.31 | 4.40 | 12.32 |
| 2025 W8 | 1,054 | 469 (44%) | 1.44 | 0.90 | 3.23 | 7.61 |
| 2025 W12 | 1,069 | 515 (48%) | 1.38 | 0.87 | 3.08 | 9.68 |
| **2026 W2** | **1,169** | **352 (30%)** | **2.09** | **1.29** | **5.21** | **13.75** |

Fantasy points. This run used the frozen cold-start weights
(`weekly-ensemble.js:59-64`), which put 0.40-0.80 on the structural head; the
promoted fit-1 puts ≈0.20 there, so the live shift should be **larger** than this,
not smaller. Whether the path is live at all depends on
`activeFantasyCoordinatorFit()` returning a fit, which cannot be read from here.

The fix is one argument at each of the two call sites: pass
`weekProjection.structural_ppg` / `projection.structural_ppg`.

### Where advanced stats should be and are not

| signal | loaded? | reaches a fantasy number? |
|---|---|---|
| EPA (pass/rush/rec), CPOE, RACR, PACR, WOPR, air-yards share | yes, columns on `player_week_usage` | **no** |
| Next Gen Stats (`nfl_ngs`), PFR advanced (`nfl_pfr_adv`) | yes | **no** — thirteen betting modules read them; no fantasy module does |
| Snap counts (`player_week_snaps`) | yes | **not into any projection** — but it *is* rendered: see the correction below |
| ffopportunity expected points | yes | via `preseason-model.js` into the ROS market prior — **and** as `priorFfOpportunity`, attached to every projection at `player-week-engine.js:358-359` and **read by nothing** |
| `opportunity-model.js` (fitted, with the vacated-teammate-share feature) | in the repo | **no consumer** — only `scripts/study-opportunity-volume.mjs` and `test/opportunity-model.test.js` |
| `nfl-gbm.js` (the gradient-boosted model) | in the repo | betting side only |

### The efficiency half: hand-set constants, but the fitted alternative was measured and lost

Checked after the volume result, because the same question applies. The efficiency
terms are the player's own rate shrunk toward a positional prior —
`ypt`, `ypc`, `ypa`, `catch_rate`, `rec_td_rate`, `rush_td_rate`, `pass_td_rate`,
`int_rate` (`projections.js:562-582`) — with strength constants that are literals:
`yards_per: 34`, `catch_rate: 26`, `td_rate: 70`, `int_rate: 1600` (`:97-124`).

Two things make this a different case from the volume constants.

**The priors themselves are measured, not invented.** `:416-426` pools every
player-week at the position and takes the real rate; the literals beside each one
(`|| 7.5`, `|| 0.63`, `|| 0.05`) are fallbacks. Say the fallback condition
precisely, because this repository has shipped two silent-fallback bugs: `rate()`
returns `null` on a zero denominator, **and a measured rate of exactly zero is
falsy too**, so `|| 7.5` fires on a null *or* a zero rate. Over pooled
multi-season QB/RB/WR/TE windows a pooled rate of exactly zero does not occur, so
it is inert today — but "only on a zero denominator" is not what the code says,
and that is the shape both earlier bugs had.

**And the fitted alternative was tried and rejected on evidence, with the reason
recorded.** `shrinkage-fit.js:465-473`:

> The efficiency k from the same fitter is excluded on evidence, not taste:
> substituting it made 2025 worse (4.773 vs 4.749), because "player" is not a
> stable group for efficiency within a season and the method-of-moments
> between-player variance is inflated for those metrics.

So `volumeKFits` (`:481`) filters the fitter's output down to the six volume
pairs, and the efficiency constants stay hand-set deliberately. That is the right
call on that evidence and should not be re-opened as stated.

**But read the stated reason again, because it is the opening.** "Player is not a
stable group for efficiency within a season" is not an argument that efficiency is
unpredictable — it is an argument that *a player's own past rate* is a weak
estimator of it. That is exactly the condition under which a stabilising outside
signal earns its place: air-yards and aDOT for yards per target, CPOE for passing
efficiency, RACR and PACR for the receiving conversion the box score is noisy
about. Every one of those columns is already on `player_week_usage`, the same
table this head reads, and none of them is read here.

So the honest state of the "use advanced stats and ML" question, end to end:
tried and lost for **volume**; hand-set for **efficiency**, where the one
alternative tested was a different shrinkage estimator rather than a new signal,
and where the repository's own diagnosis for why that failed is the argument for
trying the signal. Nothing has graded that. It is the one ML build in the fantasy
half with a real prior reason to expect it to work, and it needs Nick's word
before anyone starts it.

**Correction to the snap-share row, from the wiring map thread, verified here.**
An earlier draft said snap share appears "only as a sentence". That is wrong on
the rendering and right on the modelling, and the distinction matters.

It is rendered as a number a user reads: `News.tsx:471` prints
`` `${actual.snap_share}% snaps` `` in the post-game actual line, fed by
`news-fantasy-impact.js:136`. It still enters **no fantasy projection** — the
sentence at `player-week-engine.js:731` quotes `snap_change_points`
(`model-signal-quality.js:104`), which is a points delta, not a share.

And the path it is rendered through guesses its own units per row:

```js
snap_share: actual?.offense_pct == null ? null
  : round(Number(actual.offense_pct) * (Number(actual.offense_pct) <= 1 ? 100 : 1))
```

`player_week_snaps.offense_pct` is written **unscaled**, 0-1, at
`nflverse.js:294` (`numAt(rec, iPct)`, no scaling), and the schema records no
unit. The `: 1` branch has therefore never fired. Work the failure case through,
because it is not the obvious one: a *percent* value that happens to be **below
1** — a player who took 0.8% of the snaps — reads as `<= 1`, gets multiplied by
100, and prints **80% snaps**. So if percent-scaled values ever landed, the
starters would still look right and the fringe players would print near
full-time, which is the hardest version of this bug to notice. `offense_pct` also
lives in `nfl_snaps` (`nfl-advanced.js:192`), also unscaled, with nothing
asserting the two agree. Reader and ingest routed to their owners.

This is the same shape as the efficiency `|| 7.5` fallback above and as the two
silent-fallback bugs in this repository's history: **a branch that has never
fired, guarding a unit nobody recorded.**

### Graded overnight: the three hand-set constants, swept on three seasons

Everything above this line says the efficiency constants are hand-set and that
the one efficiency experiment on record tested the **fitter**, not the literals.
That gap is now closed. `scripts/grade-efficiency-vs-baseline.mjs` does to
`yards_per`, `catch_rate` and `td_rate` exactly what `int_rate`'s own comment
(`projections.js:100-123`) already did to the fifth constant: a geometric grid,
scored on held-out data, winner taken on evidence rather than on taste.

**How it is set up, and why each choice is the fair one.**

- Every arm is the real `buildProjections`, called with a `kOverride` that moves
  one constant family and nothing else. `pickK` (`:203-206`) takes `rawN` when a
  fit supplies k and `hardcodedN` otherwise; for every efficiency metric those
  two are the same expression, so a supplied k changes the constant and only the
  constant.
- Every arm passes an override, so `activeKVectorFor` is never consulted
  (`:461`) and the **volume** half sits at its hardcoded constants in all arms,
  whether or not the database has an active shrinkage fit. This is a study of
  the efficiency constants; nothing else is allowed to move.
- `k = 0` and `k = Infinity` are *in the grid*, so the two baselines a manager
  has without us come out of the same machinery as the shipped arm: `k = 0` is
  his own rate to date, unshrunk; `k = Infinity` is the positional prior alone
  (`shrinkSafe`, `:209`).
- The gate is on **forward** usage — 20+ forward targets or carries, 40+ for the
  touchdown rates, 60+ forward attempts for quarterbacks. Forward usage is never
  an input to any arm, so the gate cannot favour one, and one cutoff builds one
  row set, so all nine arms are scored on identical rows by construction.
- Significance is a paired bootstrap **clustered by player**: one player appears
  at up to ten cutoffs in a season and those errors are not independent draws.
  The first version of this script clustered only the first metric family — the
  `groups` array was filled once globally instead of once per family — and
  `pairedBootstrapDiff` silently falls back to an *unclustered* resample when
  `groups.length !== n` (`backtest-significance.js:80`, and the comment above it
  explains why that fallback is deliberate). Unclustered intervals are too
  narrow, and in the smoke run they produced a "beats shipped" on
  `rec_td_rate` that did not survive the fix. Nothing below comes from that run.

**Result 1: nothing on the grid beats a shipped literal on 2024-2025.** Twenty
cutoffs, weeks 5 through 14 of each season, scored on what the player did in the
weeks after the cutoff.

| metric | rows / players | shipped k | shipped MAE | grid minimum | beats shipped? |
|---|---|---|---|---|---|
| yards per target | 2,811 / 259 | 34 | 1.3535 | **68** (1.3374) | no — 90% CI [-0.0004, +0.0317] |
| catch rate | 2,811 / 259 | 26 | 0.0707 | **52** (0.0702) | no — [-0.0003, +0.0013] |
| yards per carry | 1,821 / 156 | 34 | **0.8190** | 34 — the literal is the minimum | — |
| yards per attempt | 751 / 59 | 34 | 0.6690 | 300 (0.6395) | no — [-0.0289, +0.0824] |
| receiving TD rate | 1,181 / 158 | 70 | 0.0260 | 140 (0.0257) | no — [-0.0001, +0.0007] |
| rushing TD rate | 1,131 / 104 | 70 | 0.0184 | 140 (0.0183) | no — [-0.0002, +0.0004] |

**Result 2: but the direction is systematic, and it is one direction.** Every
value *below* a literal loses, most of them with the interval clear of zero —
and five of the six MAE curves bottom out *above* the literal. The efficiency
half is conservative in the right direction and consistently a notch too
trusting of the player's own rate. No single cell above proves that; the fact
that all six point the same way is the finding.

**Result 3: confirmed out of sample on 2023, a season the grid never saw.** The
grid minimum for yards per target on 2024-2025 was 68. Re-run against 2023
alone, with nothing else changed, `k = 68` beats the shipped 34 with the
interval clear of zero:

| 2023 | shipped k=34 | k=68 | shipped-minus-68 90% CI |
|---|---|---|---|
| yards per target | 1.4318 | **1.4065** | **[+0.0036, +0.0482]** |
| yards per carry | 0.7722 | **0.7428** | **[+0.0046, +0.0588]** |

Picked on one set and confirmed on another is the shape this repository already
requires of a promotion, so for **yards per target** this is a real
recommendation: `K.yards_per` is too low, and roughly double is better. It
should go through the same gate the volume fit got, not straight into the file.

**Result 4: and the three metrics sharing that constant disagree about it.**
Read the yards-per-carry row twice. On 2023 `k = 68` beats 34 outright; on
2024-2025 **34 is the grid minimum** and 68 is slightly worse. Yards per attempt
is worse again: its 2024-2025 curve falls all the way out to 300, and its 2023
curve has the minimum at 34. One literal, `yards_per: 34`, is doing three
different jobs, and the evidence for what it should be points in three
directions. That is the structural finding here — not "34 is wrong" but **"34 is
one number where the code needs three"**, the same shape as the volume half,
which already keys its constants per metric and per position.

Note also that yards per carry's 2023 win is weaker evidence than yards per
target's, and the difference matters: 68 was *chosen* on 2024-2025 for targets
and then confirmed, which is a pre-registered comparison; for carries 68 was not
the pick, so its 2023 win is one uncorrected comparison out of eight.

**What the sweep does not say.** It says the estimator is well tuned within its
own family. It says nothing about whether that family is the right one — the
outside-signal arm (aDOT, air-yards share, CPOE, RACR, PACR, all already columns
on `player_week_usage`) is still untried, and is still the one ML build in the
fantasy half with a prior reason to work. One earlier reading is also withdrawn
here: the 2024-2025 touchdown-rate arms are biased low at every k (-0.0060 on
receiving), which looked like a prior-level defect until 2023 came back at
-0.0014. It is not stable across seasons and is not a calibration finding.

### The efficiency half shrinks percentages with the wrong helper, and it costs nothing

`stats-util.js:31-48` is explicit: use `shrinkRate`, not `shrink`, "whenever
`observed` and `prior` are both proportions in [0,1]", because a fixed `k` on a
raw proportion "over-corrects near the middle of the range and under-corrects
near the edges". Every caller of `shrinkRate` in this repository is on the MLB
side (`mlb-projections.js:282,283,294`). The NFL efficiency half shrinks
`catch_rate` and all three touchdown rates — proportions, every one — with plain
`shrink` (`projections.js:564-578`).

That is a falsifiable prediction, not a style complaint. Catch rate sits near
0.63, the middle of the range, so it should be the case that suffers most.

`scripts/grade-proportion-shrinkage.mjs` measures it without touching a server
file. `shrink` is linear in the evidence weight `w = n/(n+k)`, and
`buildProjections` hands back all three terms if asked three times for the same
cutoff — `k = 0` gives `observed`, `k = Infinity` gives `prior`, `k = literal`
gives `shipped` — so `w = (shipped - prior)/(observed - prior)`, and the arcsine
arm is `shrinkRate` evaluated at the identical weight on the identical rows.

| metric | rows / players | plain `shrink` (ships) | arcsine `shrinkRate` | verdict |
|---|---|---|---|---|
| catch rate | 2,162 / 251 | **0.07133** | 0.07151 | no detectable difference, [-0.0004, 0] |
| receiving TD rate | 500 / 121 | **0.02801** | 0.02840 | no detectable difference, [-0.0008, 0] |
| rushing TD rate | 263 / 54 | **0.02342** | 0.02386 | no detectable difference, [-0.0011, +0.0002] |

The helper the docstring names is very slightly *worse* on all three, and on the
one metric where its own reasoning predicts the largest gain — catch rate, 2,162
rows, 251 players — there is no gain at all. So: **the rule is real, the code
breaks it, and fixing it would make the model marginally worse.** Recorded here
so nobody tidies it up later and quietly loses ground. (Rows where the player's
own rate is within 0.02 of the prior are dropped, since `w` is reconstructed by
dividing by that difference. For the touchdown rates that drops most of the
population — 681 of 1,181 and 868 of 1,131 — so those two lines are a bound on
the most extreme players, not a reading on everyone. The catch-rate line keeps
2,162 of 2,811 and is the one to trust.)

### A worse model, published as a significant win

This one is not a tuning question. It is a defect in the machinery that decides
whether any offseason model is worth shipping, and it is on `main`.

**The shape.** `walkForward` builds one pooled bucket per model arm, lazily:

```js
(pooled[name] ??= { errs: [], preds: [], truth: [], groups: [] });
pooled[name].errs.push(...e); ...
```
`offseason-model.js:1116-1118`

The GBM arm is optional. It is added only in a season where the fit succeeded:

```js
let gbmModel = null;
if (gbm) {
  try {
    gbmModel = fitGbm(Xtr, ytr, { trees: 120, ... });
  } catch { gbmModel = null; }
}
...
if (gbmModel) preds.gbm = test.map(r => predictGbm(gbmModel, featureVector(r)));
```
`offseason-model.js:1073-1077`, `:1095`

So if `fitGbm` throws for 2023 and succeeds for 2024 and 2025, `pooled.gbm`
holds two seasons of rows while `pooled.no_change` holds three. The pooled
comparison then pairs them by position:

```js
vs_no_change: pairedBootstrapDiff(baseP.errs, p.errs, { iterations: 4000, seed: 23, groups: p.groups })
```
`offseason-model.js:1149`

`p.groups` is the *candidate's* group array, so it is the short one. Inside,
`n = Math.min(valuesA.length, valuesB.length)` truncates the baseline to its
first `n` entries — which are 2023 rows — and compares them against the
challenger's 2024 rows. Different player-seasons, paired.

**The guard does not catch it, and its own comment says why.** The 2026-09-12
sweep found this caller and tightened `>=` to `===`:

```js
if (groups && groups.length === n) {
```
`backtest-significance.js:80`

The twenty-line comment above it names the failure exactly — "a caller passes a
`groups` array sized to ONE of the two value arrays (as every current caller in
offseason-model.js does…) while the OTHER value array is shorter" — and
concludes that such a call "now falls back to the ungrouped resample below".
**It does not.** When `groups` is sized to the *shorter* array, `groups.length`
equals `Math.min(A, B)` exactly, the guard passes, and the clustered branch runs
on the misaligned pairing. The `===` closes the mirror case, where `groups` is
sized to the longer array. The case the comment describes is the one still open.

**Measured, not argued.** Sixty baseline rows over two seasons (season A error
1.00, season B error 0.10) against a challenger that ran in season B only and
errs 0.20 there — so the challenger is genuinely **worse by +0.10**:

```
valuesA 60  valuesB 30  n=min=30  groups=30
guard  groups.length === n  ->  true   (takes the CLUSTERED branch)

as the code calls it :  mean -0.8  90% CI [-0.8,-0.8]  significant=true  n=30
aligned on season B  :  mean  0.1  90% CI [ 0.1, 0.1]  significant=true  n=30
```

Reproduce with `node scripts/probe-paired-bootstrap-alignment.mjs`.

The sign is inverted and the result is declared significant. Read through
`pairedBootstrapDiff`'s convention — a negative `mean_diff` means B beats A —
this publishes "the GBM beats the baseline by 0.80, decisively" about a model
that lost.

**Falling back would not fix it.** The ungrouped branch indexes both arrays with
the same `idx` in `[0, n)`, so the misalignment survives the fallback. The fix
belongs at the caller: pool only the seasons in which both arms ran, or key
every pooled row by its unit and align on the key before comparing. The same
shape is at `:1465-1471` in the v2 path, with `catch { /* the challenger is
optional */ }`.

**Why it stays silent.** `catch { gbmModel = null; }` is a bare catch that
swallows the fault, which `CLAUDE.md` forbids for exactly this reason: "If a
layer goes inert, the surface must say so." Nothing downstream records that an
arm ran on a different season set from everything it is compared against.

**How likely is it?** It needs `fitGbm` to throw in some seasons and not
others — thin training data, a degenerate split, an out-of-range hyper-parameter
on one panel. `gbm = true` is the default at `:1050` and `:1434`, so every
default `walkForward` run carries the arm. This audit did not observe the throw
happening on live data; it establishes that if it does, the report is wrong and
silent rather than absent. That is the part worth fixing before launch.

**Ownership.** No thread in tonight's allocation owns `offseason-model.js` or
`backtest-significance.js`, so this needs allocating rather than assuming.

### Both teammate-absence estimators are behind no surviving surface

Checked because it was put to this audit as a claim that `contingency.js#cascades()
ships an ungraded teammate-absence multiplier into six consumers`. **It does not.**
On main it has two callers: `role-scenario-engine.js:260`, inside a function whose
own header (`:250-258`) calls itself a consistency check — it tests whether
beneficiaries' gains sum to more than the starter's workload, and grades no
projection — and `routes/model.js:569, :575`. Those two routes' only client
consumer is `Model.tsx:450`, and `Model.tsx` has no `<Route>` in `App.tsx:84-156`
and is imported by nothing. So no number a user sees is affected by it either.
(The Opportunity thread reached the same chain independently; this is the agreed
statement, and the deleted page is Nick's own deliberate removal in `1694694` —
not something to restore.)

That leaves the real asymmetry. There are two teammate-absence estimators and
neither is in front of anyone: `opportunity-model.js`, which is fitted and graded
and whose payoff stayed inside the noise, and `cascades()`, which is ungraded and
whose page was deleted. The open question is therefore not "wire one of them up"
but whether a teammate-absence correction earns a place on a **surviving** surface
— Start/Sit's weekly volume, the waiver board, or the News fantasy impact — and
that is answered by grading it there, not by restoring a removed tab.

---

## 4b. The counterparty half is fed from outside the deployed app

Checked after the chat-sync thread raised the posture calibration and the luck
path. Both hold, and the thing underneath them is bigger than either.

**Every table behind "what will they accept" has exactly one writer, and it is a
manual script.**

| table | only writer | scheduled on the server? |
|---|---|---|
| `league_transactions_raw` | `scripts/collect-league-transactions.mjs` | **no** |
| `league_week_scores` | `scripts/backfill-league-history.mjs` | **no** |
| `manager_archetypes` | `manager-archetypes.js:563`, via the `manager_archetypes` scheduler job | yes, but `tier: 'heavy'` (`scheduler.js:1373`) |

`collect-league-transactions.mjs:8-12` states the constraint itself: ESPN's
`mTransactions2` view answers only for the last ~3 days, *"Anything not captured
inside that window is gone, so this runs every refresh tick."* The refresh tick
it means is `scripts/refresh-live-data.mjs:99`, which spawns it — and
`refresh-live-data.mjs` is, by its own header, an **off-server** loop
(`--loop 900`) that exists because the in-server scheduler pegged the web process.
Nothing in `fly.toml`, `package.json` or the scheduler runs it. The Fly app is a
single web process.

So on the deployed app the transaction collector never runs. A day in which that
loop is not running on Nick's own machine is a day of proposals, accepts and
declines permanently lost — and `league_transactions_raw` is the only table in the
repo that could ever anchor the acceptance band, feed `manager-signals.js`'s
`tx` source (`:167-169`), or supply the bluff detector.

Two consequences that are live today:

- **`luck_self_view` is a real numeric term in the trade price that currently
  prices nothing.** The chain is `league_week_scores` → `scripts/luck-panel.mjs`
  (run as a child process by the archetype build) → `manager_archetypes`
  (`source: 'outcome'`, `metric: 'luck_wins'`) → `manager-signals.js:264-276` →
  `counterparty-pricing.js:452-457`, where it adds a capped adjustment to what a
  package is worth to that manager.

  **Mechanism corrected after the Trade Brain thread verified it; the conclusion
  holds and the real defect is worse.** An earlier draft said the inertness "is
  in a comment and not on the object". That is false: `add()` pushes
  `{source, reason}` onto `inert` when the sample is short
  (`counterparty-pricing.js:383-386`), and `valuationMap` carries it into
  `sources_absent` with the reason (`:750`, `:770-771`). Two other paths are the
  silent ones. `add()` returns on `Math.abs(effect) < 0.001` at `:381`, **before**
  the `min_n` branch, so a below-threshold effect is dropped without a reason —
  and that applies to all eight sources, not just luck. And the luck branch
  guards on `managerProfile?.luck` at `:452`, so a manager with no archetype row
  never calls `add()` at all and falls through to the `else` at `:775`, which
  serves **"the data exists but no player in this league matched it"** — false in
  both halves, and the live shape of four of Nick's five leagues. Trade Brain has
  a RED/GREEN fix on their branch with the evidence file
  `docs/tdd/luck-read-not-firing.tdd.md`.
- **The posture calibration cannot be re-run without a human first.**
  `lineup-posture.js:131` and `trade-horizon.js:47` cite `league_week_scores` as
  what their constants were checked against. Note the shape precisely: neither
  file *reads* the table at serving time, so a stale table does not produce a
  stale number — it produces a calibration nobody can refresh. That distinction
  is the chat-sync thread's and it is the right one.

Not verifiable here: the claim that O4's Team Outlook basis uses 692 public
Sleeper leagues. `team-outlook.js` does not exist on main at 791b131; it is on a
branch. Their argument against repointing it at the in-league table — trading a
large out-of-sample base for a tiny in-sample one — is sound on its face and is
the correct instinct for this audit's fourth question: not every table that
*could* feed a number *should*.

---

## 5. Structure — is this well built?

What is genuinely well built, and should be the pattern for the rest:

- **A number that goes inert says so, on the page.** `availabilityDegradation`
  (`contingency.js:611`) returns the inert layer, its reason, its effect and its
  fix, and `Lineup.tsx:168-180` renders all four. This is the CLAUDE.md rule
  implemented properly.
- **Retired signals stay retired and stay visible.** Matchup and
  defence-vs-position multipliers failed their test and are pinned to 1, with the
  reason travelling on the asset (`trade-engine.js:340-341`, `:443-444`).
- **Objectives that disagree are surfaced rather than reconciled by fiat**
  (`title-odds-trades.js:112-128`).

Where the build works against itself:

1. **"This week's points" has four bases.** Start/Sit and the League Hub card use
   the coordinated, lift-adjusted number; the waiver board uses the unlifted
   `current_week_ppg`; the Roster tab uses the 25/75 blend; the Ceiling tab uses
   the structural head with chance-to-play pinned to 1. Two numbers for the same
   player in the same week can differ on two cards on one screen.
2. **"Current week" has three definitions**: `tradeWeekContext`
   (`trade-engine.js:172`), `leagueCurrentWeek` (`league-week.js:12`),
   `currentNflWeek` (`weekly-learning.js:371`). `tradeWeekContext` takes no
   league, so all five leagues share one week — and two of them do not run the
   standard calendar.
3. **"Needs and surplus" has three**: 0.80/1.15 on ESPN's preseason projection
   (`tradelab.js:13`), 0.80/1.15 on FantasyCalc value (`leagues.js:258`), and
   0.88/1.12 on the blended projection (`trade-engine.js:2484`). All three can
   appear inside League Hub.
4. **Two model worlds that share no features.** The betting engine has a weekly
   feature store, a GBM, a walk-forward expert council and an advanced-stat
   pipeline. The fantasy projection is a separate counting-stat model. The one
   genuine crossing is `fantasy-coordinator.js`, which *copies* the betting
   coordinator's machinery rather than importing it, for a stated and good reason.
   Everything else that could cross does not.

### Where this data should be pointed

Ranked by how much it would change what Nick sees, and all of it is data already
on disk:

1. **Persist the volume shrinkage fit.** One database write turns the opportunity
   number from worse-than-an-average into better, measured above. The gate, the
   fitter, the cutoff guard and the runbook all already exist.
2. **Pass `structural_ppg` at the two coordinator call sites.** One argument each;
   it is the difference between a validated correction and an ungraded one, worth
   a measured ~2 points a player at week 2.
3. **Rebuild the season simulator on the weekly engine and the real week.** The
   title percentage is the number the whole app was built to produce
   (`season-sim.js:5-10`) and it is the only one that ignores the season in
   progress. `MyTeam.tsx` passing `from_week` is a one-line start.
4. **Point the advanced stats at opportunity.** Air-yards share and WOPR are
   already columns on the same table the projection reads; `opportunity-model.js`
   is already written and graded. Neither is wired to anything.
5. **Calibrate the title odds against real finishes**, the way every other number
   in this repo has been gated. Until then the honest label on that percentage is
   that its noise is measured and its accuracy is not.

---

## 6b. The headline claim, checked from the consumer end

Section 1 says a database write flips the opportunity number. That is a claim
about a *consumer*, so it has to be verified as one: which served number reads
the promoted row, is the promoted row what that read selects, and what does a
real player's number become.

**The read is a single line.** `projections.js:461`:

```js
const k = kOverride === undefined ? activeKVectorFor(rr, { predictingSeason }) : kOverride;
```

`activeKVectorFor` (`shrinkage-fit.js:515`) → `cutoffSafeKVector` (`:540`) →
`activeFitMeta` (`:537-539`), which is literally
`SELECT id, through_season FROM shrinkage_fits WHERE active = 1 ORDER BY id DESC LIMIT 1`.
So the promoted row **is** what the read selects, and there is exactly one read.

**What a real player's served number becomes**, 2025 week 10 on the scratch
rebuild, with the row's `active` flag as the only difference:

| player | target share | `params.targets` | structural ppg | **ppg (Start/Sit)** |
|---|---|---|---|---|
| Ja'Marr Chase | 0.202 → 0.327 | 7.06 → 12.17 | 13.69 → 23.29 | **16.25 → 22.01** |
| Christian McCaffrey | 0.155 → 0.248 | 5.13 → 8.30 | 15.99 → 24.85 | **22.26 → 26.69** |
| Justin Jefferson | 0.187 → 0.311 | 6.01 → 9.87 | 11.40 → 18.39 | **12.95 → 17.14** |
| Travis Kelce | 0.127 → 0.186 | 4.24 → 6.37 | 8.01 → 11.70 | **8.92 → 11.87** |
| Chase Claypool | 0.060 → 0.062 | 1.96 → 2.03 | 3.62 → 3.63 | **3.62 → 3.63** |

These are large moves on the number Start/Sit ranks with, and they move in the
right direction for the right reason: a player with a big established role stops
being dragged toward the positional average, and a player with almost no sample
barely moves at all. That last row is the check that the change is shrinkage and
not a scale factor.

### Two things the consumer end shows that the producer end does not

**1. Season-long callers do not get the fit, by design.** Asked for the vector
under no `roleRecency`, `activeKVectorFor` returns **null**: the volume entries
are withheld from every season-long caller — `season-sim`, `draft-assist`,
`preseason-model`, `week-postmortem`, `ceiling-lineup` — because their evidence is
accumulated under a different recency and a `k` fitted for one weighting is not
valid under the other (`shrinkage-fit.js:499-513`, which explains itself well).
That is correct, and it bounds the claim: the promotion moves **the weekly path**
— Start/Sit, News, the Trade Lab's this-week number — and leaves the title odds
and the draft board on the hand-set constants.

**2. The promotion does not take effect on a running process.** The engine
memoises on `player-week-engine.js:267`:

```js
const cacheKey = JSON.stringify({ season, week, scoring, kOverride: kOverride ?? 'active',
  version: PLAYER_WEEK_ENGINE_VERSION, weightFit: weightChampion.id, redistributeVolume });
```

`weightFit` carries the **weekly ensemble** fit's id, so promoting *that* busts
the cache by construction. The shrinkage fit enters the key as the constant
string `'active'`, so flipping `shrinkage_fits.active` changes nothing a running
process serves. `clearPlayerWeekEngineCache()` exists at `:68` and **has no caller
anywhere in `server/` or `scripts/`**. This was found the honest way: the first
run of the check above reported +0.00 on every player, which was the cache, not
the model.

So the operational sentence needs one more clause: *one database write flips it,
**and the app has to restart before anyone sees it.*** Tonight that is free,
because the process is restarting every few minutes anyway. Once the scheduler
fix lands and the app stays up, a promotion run against the database is invisible
until a deploy. Reproduce with
`scratchpad/consumer.mjs`-style A/B and `useCache: false`; with the cache on, the
two arms are the same object.

---

## 7. Late findings, and one question this file cannot answer

Added after other threads read the sections above. Each is marked with who
verified it.

**A component that prints the word "Calibrated" with no fit behind it.**
`client/src/components/ui/DesignSystem.tsx:47-49` — `Confidence` renders
"Calibrated" at coverage ≥ .78, "Developing" at ≥ .65, "Low confidence" below,
from three literals. Nothing fits those cuts. Raised by the UI thread, verified
here: `grep` for `<Confidence` across `client/src` returns **no consumer**, which
is the only reason it is not a live false claim today. It belongs in the
provenance record as an unfitted, unrendered claim so that wiring it up later is
a deliberate act rather than an accident.

**A claim about O4, checked and then answered.** The fantasy plan thread
reported that the team-outlook model cannot run in production, because
`history-corpus.js:48` opens `data/derived/sleeper_history.sqlite` under
`process.cwd()` and the Dockerfile runtime stage does not copy it. Checked here
first: **neither `history-corpus.js` nor `team-outlook.js` exists on
`origin/main` at `791b131`** — 1,312 files, no path matching either name, nothing
under `server/` mentioning `sleeper_history`. They then confirmed it with the
same `git ls-tree`: both files live only on #42's branch and the fit-store branch
stacked on it. Their own two sentences, which are the right way to state it:

> O4 is not on main at all; it ships when #42 merges, and even then it cannot
> produce a number on the deployed app until the fit store on migration 065
> merges too, because the corpus is never in the image. Nothing is broken in
> production; the finding is about what would have happened the moment a consumer
> was wired.

So this is a pre-merge defect caught before it could ship, not a live one, and it
is classified that way here. One consequence travels with it: the corpus in their
container is 2,500 leagues and 27,586 team-seasons, and whether Nick's own clone
has it built is open — **so no O4 figure should be quoted to him until that is
answered**, because the number's basis is not known to exist on his machine.

**`cascades()` was graded and refused.** The Opportunity thread's numbers, theirs
to claim: walk-forward, 2024 n=49 over 14 players, 2025 n=77 over 21, with the
player-clustered 90% interval straddling zero in both. Their sentence, worth
keeping because it is the honest shape of a half-working signal: the with-starter
number reads low on an absence week and the without-starter number reads high, so
the published pair brackets the truth — mechanism real, calibration not. Read the
n before quoting either. This supersedes nothing in section 4; it confirms that
neither teammate-absence estimator has earned a surface.

### Graded on request: does the counterparty layer price anything?

The Trade Brain thread's measurement, `docs/tdd/valuation-map.tdd.md` §6 and §7,
**read here in the original rather than in summary**, because the summary that
reached this audit said "adds nothing detectable" and the file says something
more careful.

**The method holds, and it is better than most of what this audit has graded.**
Arm B rebuilds each manager's chat sentiment strictly before that decision's own
timestamp and zeroes every source that cannot be rebuilt as of the date — the
negotiation profiles, today's rosters, today's luck. Arm C keeps them and is
labelled contaminated by its own author, with the reason stated: *"its lift is
exactly the part that can see the future."* A repository that reports a
contaminated arm and then refuses to use it is doing this properly. The bootstrap
is clustered on the decider, 2,000 resamples, stable across four seeds, and the
subgroup that matters — the 16 decisions made by someone other than Nick — is
reported separately rather than pooled away.

**The result.** Own value gain alone scores AUC 0.813; the cutoff-safe map scores
0.806; B − A has median 0.000 with a 95% interval of −0.017 to 0.000, and on the
non-Nick decisions it is exactly 0.000.

**One thing to add to how it is read.** That interval is narrow, and the reason is
not precision. Its upper bound is exactly 0.000, meaning the cutoff-safe map never
once beat plain value in any resample, and the two arms are nearly the same
function of the data by construction: `perceptionFactorFor`
(`trade-engine.js:1362-1366`, verified here) clamps the entire counterparty read
to **±10% of a deal's score**, applied to a shift that already cancels our own
value gap. So a narrow interval around zero is what this code would produce
whether or not the underlying signal is real — it is evidence about the wiring as
much as about the signal.

Always say *of a deal's score* and never a bare "±10%", because there are **three
clamps at three layers** and a reader who sees the bare number will attach it to
the wrong one. Trade Brain's precision, and they are right: the four individual
sources each carry a `cap` of 0.10 as well, which is the easiest of all to
mistake for the bound.

| layer | constant | what it bounds |
|---|---|---|
| the deal | `perceptionFactorFor` (`trade-engine.js:1362-1366`) | **±10% of the deal's score** — this is the one |
| the player | `PLAYER_VALUATION_CAP = 0.20` (`counterparty-pricing.js:98`) | one player's valuation shift |
| the package | `PERCEPTION_CAP = 0.15` (`counterparty-pricing.js:28`) | the package multiplier |

**The honest phrasing, which is Trade Brain's own and not the relayed one.** With
six accepts, this is a **bound on detectability, not a finding of no effect**: the
chat layer's contribution is smaller than 30 decisions can resolve. "Adds
nothing" is looser than the data.

**One sentence for the page:** *the counterparty layer is a read, not a price —
measured against 30 real decisions it never beat plain value, and the code caps
its whole contribution at 10% of a deal's score, so it should be described as
what it tells you about a manager rather than as something that moves what a deal
is worth.*

The §7 ablation says the same thing from the other side and is worth keeping in
the record: zeroing each source in turn on league 4 changes **which ideas surface
for none of them**, and the order for three, behind two controls that had to pass
before the table was reported.

### The count this file will not give

Asked for one sentence stating the fitted-versus-hand-set split as a count: how
many served numbers are fitted, how many are literals. **This file cannot support
that number and neither can `NUMBER-PROVENANCE.md`.** Both are prose tables. A row
bundles several constants under one classification in some places and classifies
each constant separately in others, so any grep-derived total — and a grep does
return one — counts rows and letters, not served numbers. Producing a defensible
count means re-tabulating one row per served number, which is real work and has
not been done.

What can be said without inventing anything: **every number this audit traced to
a promotion gate is in the points path** — rest-of-season projection, the weekly
ensemble weights, the coordinator ridge, the availability fit — and **every number
it traced in the advice layer above them is a hand-set literal**: the fairness
cuts, the acceptance band, the 25/75 decision blend, the trade-value floor, the
bye-risk and waiver thresholds, the contention grid, the draft-board source
weights, the confidence cuts above. That is a statement about where the line
falls, which the evidence supports, rather than a ratio it does not.

---

## Reproducing this

```
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/migrate.mjs
GRIDIRON_DB_PATH=/tmp/audit.sqlite node -e "import('./server/services/nflverse.js').then(m=>m.syncAll([2021,2022,2023,2024,2025,2026]))"

# opportunity, both arms, on one population
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out shipped-k.json
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/promote-volume-shrinkage.mjs        # then activate
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out fitted-k.json
node scripts/grade-opportunity-vs-baseline.mjs --compare shipped-k.json fitted-k.json
# the season-average and EWMA baselines are emitted by both arms; --compare prints all three

# the three hand-set efficiency constants, swept against held-out forward usage.
# Read-only: it activates nothing, so it does not care which fit is active.
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-efficiency-vs-baseline.mjs
# the out-of-sample confirmation is the same script with SEASONS = [2023]

# plain shrink vs the arcsine shrinkRate the docstring asks for, on the proportions
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-proportion-shrinkage.mjs
```
