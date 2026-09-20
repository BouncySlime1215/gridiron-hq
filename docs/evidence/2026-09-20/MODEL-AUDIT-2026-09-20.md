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
| Is that tested on history? | **It is now. It loses.** Measured below: as shipped it is significantly *worse* than the player's own season-to-date average, on 4,828 paired player-weeks. With the shrinkage fit that is already in the repo but never persisted, it wins. |
| Is this trade fair? | "Fair" means the FantasyCalc market price, passed through untouched (`trade-engine.js:418`). Not our judgement, and not tested. |
| What will they accept? | A band that is honest about being a guess: with no counterparty data it is **2.5%-57.5%**, and `trade-acceptance.js` says in its own header "Nothing here is fitted." |
| What does it do for me? | A real lineup re-solve on `adj_ppg`, which is 25% this week + 75% rest-of-season. The rest-of-season part is the best-tested number in the app. The 25/75 split itself is a guess. |
| What's the goal? | Two goals, and the app knows it. Find Deals ranks on points; Title Trades ranks on championship odds and prints a note when they disagree. The championship odds themselves have no historical calibration. |
| How good is my team? | Two answers that do not talk to each other: a real relative rank against the league's own rosters, and a title percentage simulated from **week 1** on **through-2025** projections. |
| Where is ML? | Real and validated in the weekly point number (ensemble weights, ridge coordinator). Absent from opportunity, trades, acceptance and title odds. The advanced-stat feature store and the GBM are on the **betting** side and are not shared. |

---

## 1. Opportunity

### What it is made of

`News.tsx:149-153` prints `N att · N tgt · N car · N% tgt share`. That comes from
`projections.js`, which builds volume as:

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
- `rosPpg` carries **no availability term** (`trade-engine.js:365-367`), so 75%
  of a player's trade value survives an injury that ends his season.

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
perception bound, the `0.2` on joint gain, and the search filters at `:1564-1572`.

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
| Snap counts (`player_week_snaps`) | yes | only as a sentence (`player-week-engine.js:731`) |
| ffopportunity expected points | yes | via `preseason-model.js` into the ROS market prior — **and** as `priorFfOpportunity`, attached to every projection at `player-week-engine.js:358-359` and **read by nothing** |
| `opportunity-model.js` (fitted, with the vacated-teammate-share feature) | in the repo | **no consumer** — only `scripts/study-opportunity-volume.mjs` and `test/opportunity-model.test.js` |
| `nfl-gbm.js` (the gradient-boosted model) | in the repo | betting side only |

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

## Reproducing this

```
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/migrate.mjs
GRIDIRON_DB_PATH=/tmp/audit.sqlite node -e "import('./server/services/nflverse.js').then(m=>m.syncAll([2021,2022,2023,2024,2025,2026]))"

# opportunity, both arms, on one population
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out shipped-k.json
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/promote-volume-shrinkage.mjs        # then activate
GRIDIRON_DB_PATH=/tmp/audit.sqlite node scripts/grade-opportunity-vs-baseline.mjs --out fitted-k.json
node scripts/grade-opportunity-vs-baseline.mjs --compare shipped-k.json fitted-k.json
```
