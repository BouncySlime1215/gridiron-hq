# G13c — infra & misc services: line-by-line audit

Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`
Read-only pass. 37 files, 4,181 lines, every line read via `cat -n` (no sampling).
Date of audit: 2026-09-12 (NFL Week 1 weekend; live server PID 56651 on :5177 untouched).

---

## 0. Executive summary

The infra layer is unusually well-written for a personal project: the installer, the
packaging script and the CI workflow all show real care (SHA-256 verification of the Node
tarball, pinned Action commit hashes, an offline guard, isolated temp databases). The
defects that matter are not sloppiness — they are **guarantees the prose asserts that the
code does not actually deliver**.

Four of those, in descending order of consequence:

1. **`scripts/import-scottfree.mjs` leaks this game's own outcome into the feature blob.**
   `OUTCOME_COLUMNS` is declared and never referenced. `home_total_points` /
   `away_total_points` fall through into `features_json` as if pregame.
2. **The launcher cannot recover a dead tunnel.** `scripts/tunnel.mjs` (PID 50971) is dead
   right now; its `cloudflared` child (PID 50981) is orphaned and still serving port 5177 to
   the public internet. `startTunnel()` probes the *child*, so it reports "already running"
   forever and never restarts the registrar. Phone access is broken and the app does not
   know it is publicly exposed.
3. **`scripts/package-release.mjs`'s non-git fallback would ship the 11.3 GB live database**,
   directly contradicting its own header.
4. **`GET /football-first/:season/:week/:home/:away` runs a ~90 s fit on the request thread**,
   against an explicit prohibition written in `compute-cache.js` itself.

Plus a cluster of P2 "wrong number / misleading output" issues in `football-context.js`,
`football-first.js`, `nfl-live.js` and `system-connectivity.js`.

**Answers to the focus questions** are in §13.

---

## 1. `server/services/stats-util.js` — 268 lines

**Purpose.** Shared statistics: empirical-Bayes shrinkage, variance-stabilising transforms,
a seedable PRNG, samplers (normal, gamma, Poisson, negative binomial, beta, binomial),
Cholesky + correlated normals, probit / normal CDF, Holm-Bonferroni.

**Imported by (37 files)** — the most widely depended-on module in my set:
`server/routes/model.js`, `server/modeling/candidates.js`, and 33 services including
`nfl-ensemble.js`, `nfl-props.js`, `nfl-prop-correlation.js`, `staking.js`,
`weekly-backtest.js`, `backtest-significance.js`, `matchups.js`, `projections.js`,
`mlb-*`; plus `scripts/fit-shrinkage.mjs`, `scripts/fit-level-uncertainty.mjs`,
`scripts/freeze-baseline.mjs`, `scripts/analyze-qbr-fantasy-signal.mjs`, and 2 tests.

### Correctness review of the named focus items

**Holm-Bonferroni (`holm`, L262-267) — CORRECT.** I verified the step-down algorithm
carefully:

```js
const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
const m = pvals.length, adjusted = new Array(m).fill(1);
let running = 0;
order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (m - rank) * p)); adjusted[i] = running; });
```

- `rank` is 0-based, so the multiplier `(m - rank)` equals the textbook `(m - i + 1)` for
  1-based `i`. Correct.
- `running = Math.max(...)` enforces the required monotonicity of adjusted p-values.
- Capping at 1 *before* the max is safe (the max of capped values is still ≤ 1).
- **Ties are handled correctly**: tied p-values sort adjacently, the lowest rank gets the
  largest multiplier, and `running` propagates that same value to all of them — which is
  what Holm specifies.
- Order is preserved via the stored index `i`.

No defect. This is a correct implementation.

**`probit` (Acklam, L221-245) — CORRECT.** Central branch, lower tail (`p < 0.02425`) and
upper tail (`p > 1 - 0.02425`) all match Acklam's published coefficients and sign
convention. No refinement step, so worst-case relative error ≈ 1.15e-9 — fine for copula
threshold work. Infinities returned for `p ≤ 0` / `p ≥ 1`.

**`normalCdf` (L248-254) — CORRECT** (Abramowitz & Stegun 7.1.26, |ε| < 7.5e-8).

**`cholesky` (L177-199) — CORRECT**, including the jitter ladder (`1e-7 … 1e-3` over five
retries) and the documented identity fallback when the matrix stays indefinite.

**Samplers.** `randGamma` (Marsaglia-Tsang with the correct sub-1 shape boost),
`randNegBinomial` (gamma-Poisson with shape `dispersion`, scale `mean/dispersion` → mean
`mean`, variance `mean + mean²/dispersion`), `randBeta`, `randBinomial` — all correct.

**"SE" and "bootstrap".** There is **no standard-error helper and no bootstrap routine in
this file.** The focus question assumed both live here; they do not. `stdev` (L57-61) is
the only dispersion primitive, and it is the correct sample standard deviation (`n-1`).
Bootstrap machinery lives elsewhere — `test/paired-bootstrap-clustering.test.js` and
`server/services/backtest-significance.js` import *from* stats-util, so the bootstrap is
built on these primitives rather than contained in them. **Out of my scope; flagged as an
open question for whoever owns `backtest-significance.js`.**

### Defects

**[G13c-01] P3 — the arcsine variance comment is wrong by a factor of 4.** L26:

```
* ~1/(4n) regardless of p, so one k applies uniformly. Maps [0,1] -> [0, pi].
```

The transform implemented at L28 is `2·asin(√p)`, whose asymptotic variance is `1/n`. It
is `asin(√p)` — without the factor of 2 — that has variance `1/(4n)`. The code is right and
the comment is wrong. No numeric impact (`k` is empirically fitted in `shrinkage-fit.js`),
but anyone deriving a `k` prior from this comment would be off by 4×.

**[G13c-02] P3 — `percentiles()` rounds to 1 decimal, which destroys probabilities.** L72-73:

```js
Object.fromEntries(qs.map(q => [`p${Math.round(q * 100)}`, +(quantile(a, q) ?? 0).toFixed(1)]));
```

Fine for fantasy points (the apparent intent). If ever handed an array of probabilities,
`p05 = 0.05` becomes `0.1` — a 100 % error. Precedence is correct (`(x ?? 0).toFixed(1)`
then unary `+`); the issue is only the fixed 1-dp scale.

**[G13c-03] P3 — `withRandomSeed` is not async-safe.** L93-98 restores `rng` in a `finally`.
If `fn` returns a promise, the seed is restored *before* the async work runs, so the
"reproducible" block silently uses the global RNG. The docstring says "Runs one synchronous
simulation", so this is a latent trap rather than a live bug — but nothing enforces it.

**[G13c-04] P3 — `mean([])` returns `0`, not `null`.** L50. A zero mean is a claim; an empty
sample is an absence. `quantile` correctly returns `null` for the same case (L65), so the
file is internally inconsistent about it.

**Verdict: good.** The statistics here are sound. Four P3 hygiene notes, no P1/P2.

---

## 2. `server/services/format.js` — 83 lines

**Purpose.** Derives a FantasyCalc league-format key (dynasty/superflex/teams/PPR) so each
league shape gets its own value set.

**Imported by (19):** routes `aggregates.js`, `leagues.js`, `model.js`, `tradelab.js`,
`trades.js`; services `trade-engine.js`, `draft-assist.js`, `league-brain.js`,
`lineup-brain.js`, `waiver-brain.js`, `roster-risk.js`, `ceiling-lineup.js`,
`season-sim.js`, `td-regression.js`, `trend-exploits.js`, `position-liquidity.js`,
`news-lag-trader.js`, `week-postmortem.js`; `test/format-bestball.test.js`.

### Defects

**[G13c-05] P3 — `ALLOWED_TEAM_COUNTS` snapping breaks ties toward the *lower* count.**
L56-58:

```js
const numTeams = ALLOWED_TEAM_COUNTS.reduce(
  (best, n) => (Math.abs(n - total) < Math.abs(best - total) ? n : best)
);
```

Strict `<` means an exact tie keeps the earlier (smaller) entry. An 11-team league is
equidistant from 10 and 12 and resolves to **10**, not 12. Given fantasy leagues are far
more often 12 than 10, and player values are meaningfully different between them, snapping
down is the wrong tiebreak. Low blast radius (odd team counts are rare) but it is a silent
mispricing for exactly the leagues the module exists to price correctly.

Everything else here is careful — the ESPN best-ball field is read fail-closed with an
explicit provenance note (L28-38), keeper is deliberately priced as dynasty with a stated
reason (L60-62), and the `lg.payload` JSON.parse is guarded (L69).

**Verdict: good.**

---

## 3. `server/services/date-util.js` — 50 lines

**Purpose.** App-local date string; and `zonedDateTime`, which converts a date + wall-clock
time in an IANA zone into a true UTC instant by iterating the `Intl` round-trip.

**Imported by (25):** `server/betting/nfl/strategy/t60-runner.js` (**the live T-60
capture runner**), `server/routes/mlb.js`, and 23 services including `game-cutoff.js`,
`forward-ledger.js`, `nfl-execution-clv.js`, `nfl-postgame-truth.js`,
`nfl-weekly-feature-store.js`, `evidence-daemon.js`, `alt-spread-import.js`.

**Review.** `zonedDateTime` (L17-45) is genuinely well built and I could not break it:
strict regex validation, explicit range checks, a real-date round-trip check (L27-28)
that rejects e.g. `2026-02-31`, a 3-pass fixed-point correction that converges in 1-2
passes for every normal case, and `hourCycle: 'h23'` (not `hour12: false`, which has a
known 24-vs-0 bug). DST spring-forward gap times converge to a defensible instant.

**[G13c-06] P3 — `APP_TIMEZONE` defaults to `Pacific/Honolulu` (L3).** That is a deliberate
choice (Nick's zone), but it is a 5-6 hour offset from the Eastern zone every NFL date in
this codebase uses, and `appDate()` is the "what day is it" primitive. Worth a comment
saying so, since `nflKickoffDate` right below it hard-codes `America/New_York`.

**Verdict: good.** No correctness defects found.

---

## 4. `server/services/compute-cache.js` — 119 lines

**Purpose.** Fingerprint-keyed memoisation (row count + max timestamp per dependency table)
instead of a TTL, so a cached answer is correct by construction.

**Imported by (10):** routes `betting-hub.js`, `nfl-betting.js`, `nfl-market.js`; services
`football-first.js`, `nfl-spread-context.js`, `pick-confidence.js`, `player-ids.js`,
`report-cache.js`, `td-regression.js`, `trade-engine.js`.

The core idea is right and the docstring (L10-17) argues it well. Issues:

**[G13c-07] P2 — `cachedAsync` has no in-flight deduplication.** L88-96:

```js
export async function cachedAsync(key, print, compute) {
  const hit = store.get(key);
  if (hit && hit.print === print) { hit.hits++; return hit.value; }
  const started = Date.now();
  const value = await compute();
```

Two concurrent requests that both miss will both `await compute()`. For the fetch-backed
computations this exists for, that is a duplicated upstream call per concurrent request —
a thundering herd against a rate-limited or paid endpoint, and doubled latency. The
synchronous `cached()` cannot have this problem; `cachedAsync` can, and does not guard it.
Fix is a `Map` of in-flight promises keyed the same way.

**[G13c-08] P3 — table names are interpolated straight into SQL.** L40 and L43:

```js
const n = row(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0;
...
s = String(row(`SELECT MAX(${stamp}) AS m FROM ${name}`)?.m ?? '');
```

Every current call site passes a hard-coded literal, so this is not presently exploitable.
It is one careless `fingerprint([req.query.table])` away from being an injection point, and
there is no allow-list or identifier validation to stop that.

**[G13c-09] P3 — the store is unbounded and never evicted.** L24, L82. Bounded in practice
by the number of distinct call-site keys, so not a live leak — but `invalidate()` is the
only way anything is ever removed, and nothing calls it on a timer.

**[G13c-10] P3 — a detached docblock.** L52-57 documents `cached()` but is immediately
followed by L58-69, `peek()`'s own docblock, and then `peek()`. So `cached()` (L74) ships
with no adjacent documentation and `peek()` has two blocks above it.

**Verdict: acceptable.**

---

## 5. `server/services/confidence-tier.js` — 93 lines

**Purpose.** Turns a per-expert walk-forward shrinkage `k` and a count of *independent
weeks* into an honest confidence tier, then weights those into a prediction-level tier.

**Imported by (3):** `server/services/nfl-expert-coordinator.js`,
`server/services/fantasy-coordinator.js`, `test/confidence-tier.test.js`.

**I verified the `k` contract**, since the whole module depends on it. At
`nfl-expert-coordinator.js:114`: `k: clamp(cov / (vf + SHRINK_RIDGE), 0, 1)` — so `k` is
genuinely in [0,1] and `clamp(k * weekFactor, 0, 1)` at L62 is well-formed. The
scholarship cited (Brill/Yurko/Wyner on effective-sample-size inflation) is correctly
applied: both coordinators pass *week*-level counts, not raw row counts.

### Defects

**[G13c-11] P3 — a legacy unshrunk fit reports as 'low' confidence.**
`nfl-expert-coordinator.js:302` falls back to `{ k: 1, reason: 'legacy fit: unshrunk' }`
with **no `independent_weeks` field**. That reaches L57:

```js
if (!Number.isFinite(independentWeeks) || independentWeeks < 1) {
  return { tier: 'low', score: 0, independent_weeks: 0,
    reason: 'no independent weeks of settled evidence behind this weight' };
}
```

So `k = 1` (maximum earned weight) reports as `low` / score 0. The direction is
conservative and arguably correct — but the stated `reason` is misleading: there may be
plenty of evidence, the legacy fit just didn't record the count.

**[G13c-12] P3 — inconsistent return shape.** The success path (L64) returns `k`; both
early-return low paths (L54, L58) omit it and add `reason` instead. Consumers reading
`confidence.k` get `undefined` exactly when they most want to know why.

**Verdict: good.** The design is sound and honest; both findings are cosmetic.

---

## 6. `server/services/football-context.js` — 529 lines

**Purpose.** Assembles the *football* behind a pick: injury availability weighted by recent
usage, observed coaching tendencies, defence-vs-position, weather, the quarterback
downgrade, and roster continuity.

**Imported by (4):** `server/routes/nfl-betting.js`, `server/services/football-first.js`,
`server/services/nfl-player-value.js`, `server/services/player-case.js`.

This file contains genuinely good work — the id-bridge fix (L101-112), the
attempts-define-the-starter argument (L331-336), and the `nameKey` first-initial+surname fix
(L448-460) are each real bugs found and properly fixed, with the failure mode recorded. But:

### Defects

**[G13c-13] P2 — the tempo trait label is inverted.** `coachingProfile`, L209-216:

```js
let pct = all.filter(x => x < v).length / all.length;
// Lower is "faster" for seconds per drive, so the percentile has to invert
// or the label reads backwards.
if (t.flip) pct = 1 - pct;
...
trait: pct >= 0.75 ? t.label : t.inverse,
```

with the trait defined at L193 as
`{ key: 'off_seconds_per_drive', label: 'plays slowly', inverse: 'plays fast', flip: true }`.

Trace a genuinely slow team: high `off_seconds_per_drive` → `pct ≈ 0.9` → flip → `pct = 0.1`
→ `0.1 >= 0.75` is false → **`inverse`, i.e. "plays fast"**. The label is exactly backwards.

The flip itself is *correct for the numeric consumer* — `football-first.js:216`'s
`paceOf()` reads `.percentile` and wants high = fast, which the flip delivers. The bug is
that `label`/`inverse` were written against the **un**flipped direction, so applying the
flip double-inverts the English. Fix is to swap `label` and `inverse` for this one trait
(not to remove the flip, which would break `pace_edge`).

Consequence: `reading` (L228) — the human-readable coaching summary shown to the user and
fed into pick explanations — asserts the opposite of the truth about tempo for every team
outside the middle 50 %.

**[G13c-14] P2 — `rosterContinuity` has no season filter on the current roster.** L498-500:

```js
const current = new Set(rows(
  `SELECT p.id FROM players p JOIN nfl_teams t ON t.id = p.team_id WHERE t.abbr = ?`, team)
  .map(r => r.id));
```

`season` is a parameter (L487) and is used for the prior-season usage query (L492) but
**not** for the roster. `players.team_id` reflects *today's* roster. So
`rosterContinuity(team, 2023)` compares 2022 usage against the 2026 roster and reports it as
2023 continuity. The module header claims (L12) "Everything is CUTOFF-SAFE".

For live use (`season = 2026`, today) it is correct. It is only wrong when replaying a past
season — see **[G13c-18]** for the one path that does that.

**[G13c-15] P3 — the stated cutoff window is wider than the real one.** `footballContext`
L299 advertises `usage and tendencies from weeks 1..${week - 1}`, but
`availabilityPicture` (L97) actually reads `week >= Math.max(1, week - lookback)` with
`lookback = 4`, and `quarterbackPicture` uses `lookback = 6`. The real windows are the
trailing 4 and 6 weeks. The claim is safe in the leakage direction (narrower, not wider)
but it is not what the field says.

**[G13c-16] P3 — `_replacementCache` is never invalidated.** L443-447:

```js
const _replacementCache = new Map();
function cachedReplacement(key, fn) {
  if (!_replacementCache.has(key)) _replacementCache.set(key, fn());
  return _replacementCache.get(key);
}
```

Keyed on `season:week` only. The live server has been up since 2026-09-11 and syncs data
continuously; once `replacementQb(2026, 2)` is computed it is frozen for the process
lifetime even as `nfl_player_week_features` gains rows. This is precisely the failure mode
`compute-cache.js` was written to prevent, and this module does not use it.

**[G13c-17] P3 — minor.** L137 `.filter(x => SKILL.includes(x.position) || x.position === 'QB')`
— `SKILL` already contains `'QB'` (L44), so the second clause is dead. L135/L140 round to
2 dp *then* sum then round to 3 dp, compounding rounding into `usage_share_at_risk`.
L354 aggregates quarterbacks by `player_name` rather than id, so two same-named players
merge and one player under two spellings splits.

**`ordinal` (L310-314) — verified correct** for 1, 2, 3, 11, 12, 13, 21, 22, 23 (the
negative-modulo path falls through to the right branch in every case).

**Verdict: messy.** Real substance, but two P2s that reach user-facing output.

---

## 7. `server/services/football-first.js` — 418 lines

**Purpose.** Regresses seven pre-chosen football features on the market's *residual*
(actual margin − market margin). The header is admirably honest: this is the eighth attempt
to beat a closing line and the eighth failure (audit #14 57.89 % on n=57 → audit #15
48.35 % on n=242).

**Imported by (3):** `server/routes/nfl-betting.js`, `server/services/weekly-walkforward.js`,
`scripts/audit-football-first.mjs`. (`forward-ledger.js:269` also dynamic-imports it.)

### Defects

**[G13c-18] P1 — the ~90-second fit runs on the Express request thread.**
`server/routes/nfl-betting.js:1748-1752`:

```js
r.get('/football-first/:season/:week/:home/:away', (req, res, next) => {
  ...
  const lean = footballFirstLean(season, week, home, away);
```

`footballFirstLean` → L361 `residualModel(season, target)` → L345 `cached(...)`, which
**computes on a miss**. `compute-cache.js:60-64` prohibits exactly this in as many words:

> `cached()` computes on a miss, which is right for a background job and wrong inside a
> route — a ninety-second fit called from an Express handler blocks the whole event loop
> and takes every other endpoint down with it.

The author clearly knows: `peekResidualModel` exists for this (L339-341), is imported at
`nfl-betting.js:5`, and *is* used at `nfl-betting.js:1782` — just not in this handler. The
sibling `POST /football-first/fit` route (L1799-1810) goes out of band to a worker for the
same reason, with the note "Fitting in a worker thread (~90 s)".

**Why this is P1 and not P3, today:** the fingerprint is
`fingerprint([{table:'game_lines', stamp:'week'}, {table:'nfl_injuries', stamp:'week'},
{table:'nfl_team_week_features', stamp:'week'}], ...)` (L346-348), and `fingerprint()`
includes `COUNT(*)` — so **any single inserted row in any of those three tables busts the
cache**. It is NFL Week 1 and a T-60 capture runner is writing `game_lines` live. One GET
to this endpoint after any capture blocks the event loop for ~90 s, which stalls the
capture runner sharing that loop. Additionally, `report-cache.js:56` pre-warms
`residualModel` **in a worker thread**, which has its own module instance and therefore its
own `store` Map — so the pre-warm cannot populate the main thread's cache at all.

**[G13c-19] P2 — train/serve skew in weeks 1-4, and the abstain guard no longer catches it.**
`fitResidualModel` trains only on `week >= 5` (L257):

```sql
WHERE home = 1 AND season < ? AND season >= ? AND week >= 5
```

but `footballFirstLean` scores any week. In weeks 1-4, `earlySeason` (L184) is true and
`withCarryover` substitutes **last season's** efficiency gap and coaching profile,
continuity-weighted (L185-211). So `efficiency_edge`, `pace_edge` and `script_conflict`
carry a different meaning at serve time than in every single training row, while using the
same coefficients.

Worse, the abstention guard was the safety net and it no longer fires. L368-373 says:

> In week 1 every feature is zero — no prior weeks of the season exist … An all-zero
> feature vector means "no information", and the honest output for no information is no
> pick.

That was true before carryover was added. I traced Week 1 2026 explicitly:
`availability_edge = 0` (no prior weeks), `qb_downgrade_edge = 0` (no prior weeks), but
`efficiency_edge`, `pace_edge` and `script_conflict` are all **non-zero** via the 2025
carryover. So `informative.length > 0` at L377, the abstain branch is skipped, and the
model emits a lean for Week 1 games from a feature distribution it never saw in training.
That is happening this weekend.

This also activates **[G13c-14]**: `contOf` (L206) calls `rosterContinuity(t, season)`
inside the carryover path. For a *live* 2026 week-1 game that is correct. For any
historical replay of weeks 1-4 (`scripts/audit-football-first.mjs`,
`weekly-walkforward.js`, `forward-ledger.js`) it silently uses the 2026 roster as the
continuity denominator for a past season — future information in a backtest feature.
The fit itself is safe (it filters `week >= 5`, so carryover never fires during training).

**[G13c-20] P2 — ridge is applied to unstandardised features, so λ is effectively arbitrary
per feature.** L293-294:

```js
const lambda = 5;
for (let i = 1; i < p; i++) XtX[i][i] += lambda;   // intercept unpenalised
```

The seven features live on wildly different scales: `availability_edge` ~ ±0.3 (a usage
share), `pace_edge` ∈ [−1, 1] (a percentile difference), `wind` = `(mph − 15)/10`, and
`qb_downgrade_edge` is **in points** and documented at L125 as reaching 9.9. A flat ridge
penalty shrinks coefficients equally in absolute terms, so a feature measured in points is
barely penalised while a feature measured as a share is crushed. The docstring (L249-251)
claims the regularisation is principled:

> The regularisation is not decoration: six correlated features on a few hundred games will
> happily produce large opposing coefficients that cancel

— which is true of ridge *on standardised features*. As written, λ=5 means something
different for each column. Standardise before penalising, or scale λ per column.

**[G13c-21] P2 — `script_conflict` carries the opposite sign from the stated convention.**
L198-199 establishes "Positive means the home side is advantaged". L221-224:

```js
// `spread` is from the home team's view: positive means home is the underdog.
const scriptConflict =
  (g.spread > 3 ? (0.5 - passOf(homeCoach)) : 0) -
  (g.spread < -3 ? (0.5 - passOf(awayCoach)) : 0);
```

`spread > 3` → home is a 3+ point underdog → likely trailing → a run-heavy home staff (low
`passOf`) is forced out of its identity. `0.5 - passOf` is then **positive**, i.e. the
feature says "home advantaged" for a situation that disadvantages home. The second term
inverts the same way. Because the coefficient is fitted, predictions are unaffected (the
sign is absorbed) — but `contributions[].points`, `leading_reason` and `leading_story`
(L391-411) then narrate the mechanism backwards, and `FEATURES[3].story` (L111-112)
describes the intended direction. The whole selling point of this module is that "the
explanation is the decomposition rather than a story told afterwards" (L356-358).

**[G13c-22] P3 — `r_squared` is computed against an uncentred total sum of squares.** L301:

```js
const ssTot = samples.reduce((s, x) => s + x.y * x.y, 0);
```

`Σy²`, not `Σ(y − ȳ)²`. For a market residual `ȳ ≈ 0` so the numbers are close, but it is
not conventional R² and it is reported to the user as one at L413 ("The fit explains X% of
the market's residual").

**[G13c-23] P3 — the reported lean is not the model's actual prediction.** `m.coefficients`
are stored already rounded to 3 dp (L310, `r3`), each contribution is rounded again (L395),
and then seven rounded values are summed (L399). Error up to ~3.5e-3 points on a quantity
that is itself often under a point.

**[G13c-24] P3 — the fit is triggered before the cheap guard.** L361-363 calls
`residualModel(...)` and only then checks `if (!f) return { error: 'no market number …' }`.
Reorder and a game with no market number costs nothing.

`solve()` (L316-331) — **verified correct**: full Gauss-Jordan with partial pivoting; row
swaps keep pivot `i` in row `i`, so the final `row_[n] / M[i][i]` division is right. Only
nit is the scale-blind `1e-12` singularity threshold (L322) against an unnormalised `XtX`
whose entries scale with sample count.

**Verdict: messy.** Intellectually the most honest module in the set, and simultaneously
the one with the most numeric defects.

---

## 8. `server/services/system-connectivity.js` — 116 lines

**Purpose.** Builds the import graph and reports modules nothing imports (ORPHANED) or that
no route can reach (UNREACHABLE). Written after a run of "built, tested, never wired"
failures (L6-14).

**Imported by (1):** `server/routes/betting-hub.js:720`, via
`await import('../services/system-connectivity.js')` — a **dynamic** import. Not orphaned.
(Also referenced in `docs/reference/architecture/domain-ownership.md:299` and
`folder-map.csv:624`, which proposes moving it to `server/platform/utils/`.)

### Defects

**[G13c-25] P2 — the audit only scans three of eleven `server/` subdirectories, so it can
report live modules as dead and recommend deleting them.** L29-30 and L63-65:

```js
const SERVICES = join(ROOT, 'services');
const ROUTES = join(ROOT, 'routes');
...
record(SERVICES, services);
record(ROUTES, routes);
if (existsSync(join(ROOT, 'index.js'))) record(ROOT, ['index.js']);
```

`server/` actually contains `betting/`, `data/`, `db/`, `draft/`, `migrations/`,
`modeling/`, `news/`, `platform/`, `routes/`, `scripts/`, `services/`. Importers living in
the seven unscanned code directories are invisible. Concretely: `date-util.js` is imported
by `server/betting/nfl/strategy/t60-runner.js` (the live T-60 runner) and `stats-util.js`
by `server/modeling/candidates.js` — neither import is counted.

The consequence is not just an inaccurate count. L110-111 emits:

```js
: `${unexpectedOrphans.length} module(s) nothing imports and nobody declared: ` +
  unexpectedOrphans.join(', ') + '. Wire them, list them as intentional, or delete them.'
```

A module used only from `server/betting/` gets named as dead weight with a
delete recommendation. The `note` at L112-114 claims the analysis "under-reports
connectivity rather than over-reporting it — the safe direction" — but under-reporting
connectivity is what *produces* a false "delete this" verdict.

**[G13c-26] P2 — `.pathname` on a `file:` URL is not a filesystem path, and the failure is
silent and reports "healthy".** L28:

```js
const ROOT = new URL('../', import.meta.url).pathname;
```

On Windows this yields `/C:/Users/...`; any path containing a space arrives
percent-encoded (`%20`) on every platform. Either way `existsSync(SERVICES)` returns false
→ `jsFiles()` returns `[]` (L42) → `services = []` → `orphans = []` →
`unexpectedOrphans.length === 0` → **`healthy: true`** with the verdict "Every service
module is either wired into the application or explicitly listed as deliberately unwired."
A check that cannot read its own source tree reports a clean bill of health. Use
`fileURLToPath` — which every other file in this repo already does
(`launcher.mjs:23`, `start.mjs:9`, `vite.config.ts:4`, …).

**[G13c-27] P3 — the import regex over- and under-matches.** L37-38. `from\s+['"]…['"]`
also fires inside comments and string literals, and misses side-effect imports
(`import './x.js'` with no `from`) — `scripts/fanduel-lines.mjs:15` uses exactly that form.
Basename-only keying (L37-39) also collides: `../db/index.js` and a hypothetical
`services/index.js` are the same key.

**[G13c-28] P3 — `walk()` is called with a fresh `seen` per route.** L76-78 — `walk(dep)`
defaults `seen = new Set()` on each call, so shared subtrees are re-walked once per route.
`reachable` still accumulates correctly; this is wasted I/O only.

**Verdict: messy.** The idea is excellent and the execution under-delivers on exactly the
guarantee it advertises.

---

## 9. `server/services/nfl-live.js` — 172 lines

**Purpose.** Live scoreboard + in-game win probability from ESPN's free public endpoint.
The model is stated in full at L10-28 and its limits are stated honestly (no possession,
down or timeout awareness).

**Imported by (3):** `server/routes/nfl-betting.js`, `server/services/nfl-espn-pbp.js`,
`server/services/nfl-sim-policy.js`.

### Defects

**[G13c-29] P2 — a live overtime game is reported as 100 % / 0 % win probability.**
`clockSeconds`, L94-95:

```js
if (!period) return GAME_SECONDS;
if (period > 4) return 0;
```

Overtime (period 5+) returns **0 seconds remaining**, which lands in `liveWinProbability`
L73:

```js
if (left <= 0) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;
```

So a game *currently being played* in overtime with a 3-point lead returns exactly `1.0`.
That directly contradicts the module's own reasoning 15 lines below, L84-88:

```js
// A game still being played is never 0% or 100%. The normal tail rounds to
// certainty long before football does … Clamping keeps it from asserting an
// impossibility it has no basis for.
const floor = 0.005;
```

— a floor the OT path never reaches, because it returns before it. The true figure for a
3-point OT lead is roughly 75-80 % (the trailing team gets a possession after a field
goal). The comment at L92-93 says OT is "treated as the dying seconds of a tied game", but
0 seconds is not the dying seconds — it is game over. Mitigation: `probability_reliable`
(L153) does evaluate to `false` for OT, so it is at least flagged.

**[G13c-30] P3 — `marginSigma()` uses the unconditional margin SD where the residual SD is
wanted, and computes it as a population (not sample) SD.** L51-57:

```js
const margins = g.map(x => x.team_score - x.opp_score);
const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
_sigma = Math.sqrt(margins.reduce((s, m) => s + (m - mean) ** 2, 0) / margins.length);
```

The model uses `sigma` as the SD of the *remaining* margin *given the pregame spread*
(L77-80), which is the residual SD around the spread (≈13.2-13.5), not the unconditional
margin SD (≈13.9-14.2) this computes — the latter includes the between-game spread
variance the drift term already accounts for. Net effect is slight under-confidence.
Divisor is `n` not `n-1` (contrast `stats-util.js:60`, which correctly uses `n-1`).

**[G13c-31] P3 — `_sigma` is memoised for the process lifetime.** L47-50. Never recomputed
as `game_lines` accumulates 2026 results on a server that has been up for days.

**[G13c-32] P3 — `normalCdf` is duplicated.** L39-45 is byte-for-byte the same algorithm as
`stats-util.js:248-254`, which this module does not import. `stats-util.js:218-219` makes a
point of saying its copula helpers exist "so there is exactly one implementation of it".
The two also disagree at the origin: stats-util uses `x >= 0`, here it is `x > 0` (L44) —
harmless since both give ≈0.5, but it is the same function twice with different edge
handling.

**Verdict: acceptable.**

---

## 10. Install / launch / packaging path

### 10.1 `scripts/launcher.mjs` — 150 lines · **THE PROCESS RUNNING THE LIVE SERVER**

I confirmed the live topology with `ps -axo pid,ppid,command` (read-only):

```
50918     1  node .../scripts/launcher.mjs                                  <- launchd service
86535     1  node .../scripts/launcher-tunnel.mjs                           <- launchd service
86537 86535  cloudflared tunnel --url http://127.0.0.1:5199 --no-autoupdate <- launcher's own tunnel
56651     1  node --env-file-if-exists=.env server/index.js                 <- THE LIVE APP (ppid 1)
50981 50971  cloudflared tunnel --url http://localhost:5177 --no-autoupdate <- ORPHANED (parent gone)
```

**Confirmed: PID 56651 was started by `launcher.mjs:75` and is NOT `node --watch`.**
`ppid 1` matches `spawn(..., { detached: true })` + `child.unref()` at L75-77. The
`--watch` form only appears in `package.json:21` (`dev:server`), which is not what is
running. Editing a file under `server/` will **not** reload the live process.

#### [G13c-33] P1 — the launcher cannot recover a dead tunnel, and an orphaned public tunnel is currently exposing port 5177 with the app unaware.

This is a live, present-tense failure. The chain:

1. `scripts/tunnel.mjs` is the only thing that registers the tunnel URL with the app, and
   it must keep doing so — `tunnel.mjs:62-64`:
   ```js
   // The app only remembers the address in memory, so re-announce it every
   // 30s — a server restart mid-evening must not blank Settings → Phone access.
   setInterval(() => register(match[0]), 30000).unref();
   ```
2. `tunnel.mjs` (PID **50971**) is **dead** — no such process exists, yet its `cloudflared`
   child (50981) is still running and still serving. `server/data/launcher-logs/tunnel.log`
   last changed at 01:36 (a 30 s interval would keep it current) and its tail is hundreds
   of consecutive lines of `could not register the tunnel with the app: fetch failed`.
3. `launcher.mjs:89` probes for the **child**, not the registrar:
   ```js
   if (processRunning(`cloudflared tunnel --url http://localhost:${APP_PORT}`)) return 'already running';
   ```
   I verified by direct execution that this predicate currently returns `true` (and that a
   control pattern returns `false`, so it is a genuine match on the orphan, not a
   self-match artefact of `execSync`).
4. Therefore `/start` reports "Tunnel: already running" forever and never respawns
   `tunnel.mjs`. `/api/auth/tunnel-url` stays null. **Phone access cannot be restored
   without manual intervention**, on NFL Week 1 weekend.

Two distinct consequences:
- **Availability:** the documented phone path is silently broken, and the launcher is
  structurally incapable of noticing.
- **Exposure:** a public `trycloudflare.com` hostname is still tunnelling to :5177 with no
  process managing it, and because registration failed, **nothing in the app's UI indicates
  the app is publicly reachable**. The app's own auth (pairing codes) still gates sign-in,
  so this is not an open door — but an unmanaged, unadvertised public ingress is the wrong
  default.

The irony is that L82-88 documents a *previous* attempt to fix this exact symptom:

```js
// Found 2026-09-07 chasing why /api/auth/tunnel-url stayed null despite
// /start reporting success.
```

The fix narrowed the pattern from `cloudflared tunnel` to the port-specific form. That
addressed a different cause (collision with the launcher's own tunnel) and leaves this one
untouched, because the real error is **using liveness of the child process as a proxy for
liveness of the parent that owns the registration**. The right check is either "is
`scripts/tunnel.mjs` running" or "does `GET /api/auth/tunnel-url` return a URL".

#### [G13c-34] P2 — `/status` still uses the generic pattern the code elsewhere documents as wrong.

L140:

```js
res.end(JSON.stringify({ server_up: portOpen(APP_PORT), tunnel_up: processRunning('cloudflared tunnel'), tunnel_url: tunnelUrl }));
```

`'cloudflared tunnel'` is precisely the substring L82-86 warns "also matches the launcher's
own permanent tunnel (a different port, started once by launchd and always up), so that
generic check always found *something*". `startTunnel` was fixed; `/status` was not. Since
the launcher's own tunnel (PID 86537) is a permanent launchd service, **`tunnel_up` is
hard-wired to `true`** and conveys no information.

#### [G13c-35] P3 — `/health` is served before authentication.

L108-111 returns `{ok:true}` to any unauthenticated caller, including over the public
tunnel, before the key check at L113. Low value to an attacker (pure liveness), but it does
confirm the endpoint exists to anyone who finds the hostname.

#### [G13c-36] P3 — the launcher key travels in query strings.

L106 `url.searchParams.get('key')`, L127 and L144 embed it in generated URLs. Query strings
land in browser history, in `Referer` headers on any outbound link, and in intermediary
logs. The constant-time compare at L44-47 is correct and the key is 24 random bytes with
`mode: 0o600` (L38-39) — the transport is the weak link, not the secret. A header or a
cookie set once would be strictly better. (Escaping is fine: `encodeURIComponent` escapes
`<`, `>` and `"`, so there is no XSS in the interpolation at L144.)

#### [G13c-37] P3 — `pgrep -f ${JSON.stringify(pattern)}` interpolates into a shell.

L54. `JSON.stringify` produces **double** quotes, inside which `sh` still expands `$`,
backticks and `\`. All current patterns are literals, so this is not exploitable — but
`execFileSync('pgrep', ['-f', pattern])` avoids the shell entirely and is no more code.

### 10.2 `scripts/tunnel.mjs` — 84 lines

**[G13c-38] P2 — on an unexpected `cloudflared` exit the app keeps advertising a dead URL.**
L84:

```js
child.on('exit', code => { console.log(`cloudflared exited (${code})`); register(''); process.exit(code ?? 0); });
```

`register('')` returns a promise that is **not awaited** before `process.exit()` runs
synchronously on the next line, so the clearing POST is aborted in flight. The deliberate
`shutdown()` path (L77-81) correctly does `await register('')` first — this path does not.
Result: Settings → Phone access shows an address that no longer resolves.

### 10.3 `scripts/launcher-tunnel.mjs` — 42 lines

Clean, and honest about the quick-tunnel hostname caveat (L8-14). One note: it writes the
URL file on *every* regex match (L35-38) rather than only on change, so a chatty
`cloudflared` rewrites the file repeatedly. Cosmetic.

### 10.4 `scripts/start.mjs` — 144 lines

**[G13c-39] P2 — `start.mjs` exits 0 when the app failed to come online.** L85-88 and
L134-139:

```js
server.on('exit', code => process.exit(code ?? 0));
...
if (!ready) {
  console.error(`\n  Gridiron HQ did not come online at ${URL}.\n`);
  server.kill('SIGTERM');
  process.exitCode = 1;
  return;
}
```

`server.kill('SIGTERM')` fires the `exit` handler with `code === null` and
`signal === 'SIGTERM'`. `code ?? 0` evaluates to **0**, and `process.exit(0)` runs
immediately — before the `process.exitCode = 1` on the previous line can take effect. So a
60-attempt startup failure is reported to the shell as success. Anything wrapping
`npm start` (the Desktop shortcuts, `mac/Start Gridiron HQ.command`,
`windows/Start Gridiron HQ.cmd`) cannot distinguish a failed launch from a good one. Fix:
`process.exit(code ?? (signal ? 1 : 0))`, or track the intentional kill.

**[G13c-40] P3 — the rebuild-staleness check misses two build inputs.** L66-71 hashes
`client/src`, `client/index.html`, `client/vite.config.ts` and the root `package.json`.
It does **not** include `client/tailwind.config.js` or `client/postcss.config.js`, both of
which materially change the build output (the `field: '#1a4d2e'` theme colour lives in the
former). Editing either leaves a stale `dist/` served silently. The walk itself (L47-62) is
correct and correctly skips `node_modules`.

### 10.5 `scripts/start-smoke.mjs` — 44 lines

Good. Isolated temp SQLite via `GRIDIRON_DB_PATH`, OS-safe port (`20000 + process.pid % 20000`
— precedence is right, range 20000-39999), checks `child.exitCode` inside the poll so a
crashed server fails fast rather than timing out, `finally` block escalates SIGTERM →
SIGKILL and removes the temp dir. No defects found.

### 10.6 `scripts/install.mjs` — 208 lines

**[G13c-41] P2 — the Anthropic API key is typed in cleartext with no masking.** L79-81:

```js
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
key = (await rl.question('  Paste your Anthropic API key (optional): ')).trim();
```

`readline/promises`' `question()` echoes. The key is visible on screen and persists in
terminal scrollback. A `sk-ant-` key is a billable credential.

**[G13c-42] P2 — `mode: 0o600` on `.env` is ignored when the file already exists.** L89:

```js
fs.writeFileSync(ENV, next, { mode: 0o600 });
```

`mode` applies only at **creation**. Re-running the installer against an existing
world-readable `.env` rewrites the contents and leaves the permissions alone, while
printing "Key saved to .env (git-ignored, never leaves this machine)" (L90). The live
`.env` happens to be `-rw-------`, so this is latent rather than active. An explicit
`fs.chmodSync(ENV, 0o600)` after the write closes it.

**[G13c-43] P2 — `npm ls --depth=0` as a hard gate will fail a perfectly good install.**
L63-64:

```js
res = spawnSync(npm, ['ls', '--depth=0'], { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
if (res.status !== 0) die('One or more required packages are missing. Scroll up for the npm report.');
```

`npm ls` exits non-zero for *extraneous* packages and unmet **peer** dependencies, not only
missing ones. With `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query` and
`@vitejs/plugin-react` all in `devDependencies`, a peer-range mismatch is an ordinary
occurrence — and it hard-`die()`s an install that would have worked. Downgrade to a warning
or check for the specific packages required.

**[G13c-44] P3 — `${ROOT}` is interpolated into generated shell/batch text unescaped.**
L172 (`cd /d "${ROOT}"`) and L185 (`cd "${ROOT}" || exit 1`). Spaces are handled by the
quoting; a `$`, a backtick or a `"` anywhere in the checkout path is not.

Good parts worth recording: the Node floor is checked before anything else (L41-48),
`npm ci` falls back to `npm install` with a stated reason (L53-61), the seed step degrades
to a warning rather than failing the install (L109), and `findDesktop()` (L194-208) handles
OneDrive redirection and non-English Windows via the registry.

### 10.7 `install.sh` (113) / `install.ps1` (115)

Both are good. Notably: they resolve the current LTS from `nodejs.org/dist/index.json`
rather than pinning a version that rots, with `v22.20.0` as a stated fallback
(`install.sh:63-66`, `install.ps1:58-64`); and **both verify the downloaded tarball/zip
against the official `SHASUMS256.txt` and abort on mismatch** (`install.sh:71-82`,
`install.ps1:78-83`). Node lands only in `~/.gridiron`, needs no admin, and uninstall is
`rm -rf`. `install.ps1:74-77` even explains why `-UseBasicParsing` is needed (avoiding a
scary prompt for a first-time installer). No defects found.

### 10.8 `mac/*` (48 lines) and `windows/*` (60 lines)

Thin, correct wrappers. `mac/Install Gridiron HQ.command:22` chmods the scripts before
`exec`ing `install.sh`; both Start scripts prepend `~/.gridiron/node` to `PATH` and give a
clear message if `npm` is still missing. `windows/Install Gridiron HQ.cmd:26-27` runs
`Unblock-File` recursively over the extracted folder and L29 uses `-ExecutionPolicy Bypass`
— both scoped to this folder / this process and both documented in the file header and in
the packaged read-me. Acceptable as designed.

### 10.9 `scripts/package-release.mjs` — 229 lines

#### [G13c-45] P1 — the non-git fallback would package the 11.3 GB live database and every private file under `server/`.

The header promises (L25-27):

> node_modules, .env, the database and .git are excluded. Beyond size, .env holds API keys
> and the database holds league data — shipping either would be handing them to whoever
> gets the file.

The git path honours that only because `git ls-files` respects `.gitignore` (L165-166 says
so explicitly). The fallback does not. L167-174:

```js
} catch {
  console.log('  ! Not a git checkout — falling back to a directory walk.');
  files = walk(ROOT).map(f => path.relative(ROOT, f));
}
```

and `walk()` (L222-228) filters only on exact basename against `EXCLUDE`:

```js
const EXCLUDE = new Set([
  'node_modules', '.git', 'dist', '.env', '.DS_Store',
  'data', 'coverage', '.vite', 'client/dist'
]);
...
for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (EXCLUDE.has(e.name)) continue;
```

`'data'` matches the *directory* `server/data`, but the database file is
**`server/data.sqlite`** — 11.3 GB, plus a 3.3 GB `-wal` and a 9.8 GB
`.pre-migration-….bak` — and none of those basenames are in `EXCLUDE`. The zip would carry
the live database, which per `.gitignore:4` "contains ESPN league cookies and your personal
rankings/drafts". Add `/^data\.sqlite/` (or better, make the fallback refuse to run).

#### [G13c-46] P2 — two `EXCLUDE` entries are dead in the git path, so the list is misleading.

L178-179:

```js
const top = rel.split('/')[0];
if (EXCLUDE.has(top) || EXCLUDE.has(rel)) continue;
```

`top` for `server/data/anything` is `'server'`, so the `'data'` entry never fires on the
path it was plainly written for. `'client/dist'` only matches a `rel` equal to the literal
string `client/dist`, which `git ls-files` never emits (it lists files, not directories).
Both are no-ops that make the exclude list look more protective than it is.

#### [G13c-47] P2 — a SQLite journal from a pre-migration backup of the live database is tracked in git.

`git ls-files` returns:

```
server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal
```

`.gitignore:53` has `*.pre-migration-*.bak`, which does not match the `-journal` suffix
(the sibling `.bak` at 9.8 GB *is* correctly ignored). The file is only 1024 bytes so the
data exposure is negligible, but: it is a live-database artefact committed to the repo, and
because the packaging copy is driven by `git ls-files`, **it also ships in every release
zip**. `.gitignore:8-11` and `:25-27` show this seatbelt has been patched twice already;
this is the third gap. Add `*.bak-journal`, `*.bak-shm`, `*.bak-wal`.

Everything else here is careful — `zip -X` with explicit `0755` on `.command`/`.sh` (L185,
L207-209) and the reasoning for it (L21-23), plain-ASCII help filenames for Windows unzip
tools (L202-204), and genuinely good end-user help text.

---

## 11. `scripts/lint.mjs` — 16 lines · **focus question**

The whole file:

```js
const roots = ['server', 'scripts', 'test'];
...
else if (/\.(?:js|mjs)$/.test(item.name)) files.push(full);
...
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax checked ${files.length} JavaScript files; TypeScript/TSX is covered by npm run typecheck.`);
```

**What it actually checks: nothing but parseability.** `node --check` parses a file and
exits; it performs no semantic analysis whatsoever. It will not catch an undefined
variable, an unused import, an unawaited promise, a shadowed binding, `==` vs `===`, an
unreachable branch, a typo'd property, or an unresolvable import specifier. It is a syntax
gate wearing the name `lint`, and the CI step at `.github/workflows/ci.yml:59-60` is called
"Lint".

`"type": "module"` in `package.json:5` does at least mean `--check` parses `.js` as ESM, so
top-level `await` and `import` are accepted correctly — the check is valid as far as it goes.

**[G13c-48] P2 — the name and the CI step overstate what is verified.** For a codebase with
261 tables, ~19 statistical estimators and money-adjacent output, "lint passes" currently
guarantees only that the files parse. Every defect in this report would pass it.

**[G13c-49] P3 — coverage gaps.** `roots` omits `client/src` entirely (deferred to
`typecheck`, reasonably), but also `research/` and `chrome-extension/`. `.jsx`/`.cjs` are
not matched by the regex. `visit()` (L7-13) has no `node_modules` guard — harmless for
these three roots today, but it would descend into one if it ever appeared.

**[G13c-50] P3 — it stops at the first failure and is slow.** `execFileSync` with
`stdio: 'inherit'` throws on the first bad file, so you fix-and-rerun one at a time instead
of seeing every error. And it spawns one Node process per file across all of
`server/ scripts/ test/` — hundreds of process launches for a parse check that
`new vm.Script()` or a single `node --check` per batch could do far faster.

---

## 12. `.github/workflows/ci.yml` — 96 lines · **focus question**

**What it does:** on PR and on push to `main`, single `ubuntu-latest` job, 20-minute
timeout, `concurrency` with `cancel-in-progress`, `permissions: contents: read`. Steps:
checkout → setup-node 22 (npm cache) → record runtime → `npm ci` → `npm run typecheck` →
`npm run lint` → `npm test` → `npm run build` → `npm run start:smoke`.

**Genuinely good:** both third-party Actions are pinned to full commit SHAs with the
released version in a trailing comment (L36, L39) and the reasoning is stated (L11-13) —
a tag can be moved, a hash cannot. Least-privilege token. And the test step does not merely
*assert* hermeticity, it **enforces** it (L79-82):

```yaml
env:
  SCHEDULER_DISABLED: '1'
  NODE_OPTIONS: '--import ./test/offline-guard.mjs'
  GRIDIRON_DB_PATH: '${{ runner.temp }}/gridiron-ci-fixture.sqlite'
```

`test/offline-guard.mjs` exists and, per the comment, throws on any non-localhost fetch and
names the host. That is the right design, and the comment at L68-73 is explicit that the
previous assertion-only version "was an assertion about the suite rather than a property of
the run".

### [G13c-51] P2 — the offline guard is missing from the one step that boots the real server.

L87-96:

```yaml
      - name: Fresh-install startup smoke test
        run: npm run start:smoke
        env:
          SCHEDULER_DISABLED: '1'
```

No `NODE_OPTIONS: '--import ./test/offline-guard.mjs'`. The test step gets the guard; the
step that starts the **actual application** — the one with collectors, feeds and boot-time
sync paths — does not. The workflow's own header (L7-9) states:

> It must never require provider credentials, call a paid data/LLM API, or activate real
> betting

`SCHEDULER_DISABLED=1` suppresses the scheduler, but that is a narrower guarantee than the
guard provides, and it is the same "assertion rather than property" the authors already
rejected once for `npm test`. Adding the one `NODE_OPTIONS` line closes it.

### [G13c-52] P3 — CI never exercises the Windows path.

The repo ships `install.ps1`, `windows/Install Gridiron HQ.cmd` and
`windows/Start Gridiron HQ.cmd`, and `install.mjs` has substantial Windows-only branches
(`npm.cmd`, `shell: IS_WIN`, registry Desktop lookup, `.cmd` shortcut generation). None of
it runs on `ubuntu-latest`. A `windows-latest` matrix leg running just `typecheck` +
`lint` + `start:smoke` would cover the bulk of it — and would immediately surface
**[G13c-26]** (`URL.pathname` on Windows).

### [G13c-53] P3 — no dependency audit step.

`npm ci` runs with the lockfile but nothing checks it for advisories; `install.mjs:56` even
passes `--no-audit`. A non-blocking `npm audit --audit-level=high` would cost seconds.

---

## 13. Focus-question answers, consolidated

**Q: What is running the live server, and is it `node --watch`?**
`scripts/launcher.mjs:75`, a launchd service (PID 50918) that spawned PID 56651 detached.
**Not** `--watch` — that form appears only in `package.json:21` (`dev:server`), which is not
running. Source edits under `server/` do not take effect without a restart.

**Q: What does the 16-line lint actually check?**
`node --check` (parse only) on every `.js`/`.mjs` under `server/`, `scripts/`, `test/`. No
semantic analysis of any kind. See §11.

**Q: The tunnel.**
Structurally broken right now — see **[G13c-33]** (P1). The registrar is dead, its
cloudflared child is orphaned and still publicly serving :5177, and the launcher's liveness
probe targets the child so it will never restart the registrar.

**Q: CI workflow.**
Well constructed; one real hole — the offline guard is absent from the smoke step
(**[G13c-51]**) — plus no Windows leg and no dependency audit.

**Q: Stats-util correctness (SE, Holm, bootstrap).**
Holm is **correct**, including tie handling. Probit, normal CDF, Cholesky and all samplers
are correct. There is **no SE helper and no bootstrap in this file** — the premise of the
question is wrong; those live in `backtest-significance.js` and the bootstrap tests, which
build on these primitives. Only P3 findings here.

**Q: Which scripts are one-off / stale?**
- `scripts/nfl-2022-2025-rebuild.mjs` — **stale**. Hard-codes `SEASONS = [2022…2025]`
  (L24) and `season BETWEEN 2022 AND 2025` (L213-214). It is now the 2026 season.
- `scripts/import-scottfree.mjs` — one-off vendor CSV importer. **Keep but fix** (P1 below).
- `scripts/import-alt-spreads.mjs` — one-off but clean, well-guarded, still useful.
- `scripts/fanduel-lines.mjs` — an operator tool, not stale; `--capture` writes to the
  quote tape.
- `scripts/sync-ffopportunity.mjs` (6 lines), `build-evidence-dataset.mjs`,
  `build-role-scenario-lab.mjs` — thin, current CLI wrappers over live services; keep.
- `scripts/bootstrap-data.mjs` — first-run data pull, current.

---

## 14. Remaining script notes

### `scripts/import-scottfree.mjs` — 137 lines

#### [G13c-54] P1 — this game's own outcome is written into `features_json`, and the guard that was supposed to prevent it is dead code.

`OUTCOME_COLUMNS` is declared at L42-44 with a careful provenance note (L38-41):

```js
// This game's own result. Kept in features_json for completeness (a training
// harness needs the label somewhere), but never promoted to a top-level
// pregame-feature column, and callers must exclude these explicitly …
const OUTCOME_COLUMNS = new Set(['total_points', …, 'home_total_points', 'away_total_points']);
```

I grepped the file: **`OUTCOME_COLUMNS` appears exactly twice — once in a comment (L10) and
once at its own declaration (L42). It is never read.** The actual filter at L111-115 uses a
different list entirely:

```js
for (const [k, v] of Object.entries(r)) {
  if (TOP_LEVEL.includes(k)) continue;
  featureRow[k] = …
}
```

I diffed the two lists programmatically. Two outcome columns are in `OUTCOME_COLUMNS` but
**not** in `TOP_LEVEL`, so they fall straight through into `features_json`:

```
home_total_points, away_total_points
```

Those are this game's own final scores. They now sit inside the `features_json` blob
alongside genuine pregame features, unmarked and indistinguishable. Any consumer that does
the obvious thing — treat the keys of `features_json` as the feature set — trains on the
label. The script's own closing reminder (L135-137) even names the pattern it failed to
enforce:

```js
console.log('Reminder: home_score/away_score/… /*_total_points are this game\'s '
  + 'own outcome. Never feed them into a pregame model as inputs …');
```

Fix: `if (TOP_LEVEL.includes(k) || OUTCOME_COLUMNS.has(k)) continue;` — or nest outcomes
under an explicit `features_json.outcome` sub-object so they cannot be swept in by a
key-enumerating consumer.

**[G13c-55] P3 — no transaction around the insert loop.** L117-130 runs one
`INSERT OR REPLACE` per CSV row outside any transaction. Slow, and a mid-run crash leaves a
partial import (mitigated by the deterministic `source_game_key` PK making a re-run
idempotent).

### `scripts/nfl-2022-2025-rebuild.mjs` — 257 lines

**[G13c-56] P2 — the `unrecoverable` regex can permanently seal an audit on a transient
error.** L237-239:

```js
const message = String(error?.message ?? error);
const unrecoverable = /no remaining weeks|already complete|sealed as|chain/i.test(message);
if (unrecoverable) failBlindAudit(auditId, error);
```

`/chain/i` matches the bare substring "chain" **anywhere** in any error message — "markov
chain", "chained promise", "certificate chain", a Node `ERR_...CHAIN` code from a TLS
failure. A transient network error whose message happens to contain it calls
`failBlindAudit()` and seals a preregistered audit that was designed to resume. The comment
directly above (L232-236) records that this exact class of mistake has already cost real
work:

```js
// … the audit is week-chained and resumes at
// next_ordinal, so the next invocation continues from the last sealed
// week (runs 9 and 10 lost 23 opened weeks to sealing here).
```

Anchor the patterns, or match on typed errors instead of message text.

**[G13c-57] P3 — `missing_team_vector_repair` is a byte-identical duplicate of
`team_feature_vectors`.** L149-157: same function, same `seasons`, same `startWeek`/
`endWeek`, differing only in the phase name passed to `recordProgress`. Either it is a
no-op second full pass, or it was meant to target only missing rows and does not.

**[G13c-58] P3 — two tables are created outside the migration system.** L37-45
`db.exec('CREATE TABLE IF NOT EXISTS nfl_rebuild_checkpoints …')` and
`nfl_rebuild_progress`. They exist in the 261-table database with no corresponding file in
`server/migrations/`, so schema tooling and a fresh install will not know about them.

**[G13c-59] P3 — hard-coded seasons drift from `SEASONS`.** L213-214 and L218-219 embed
`season BETWEEN 2022 AND 2025` rather than deriving from the `SEASONS` constant at L24, so
changing one silently desyncs the progress denominator from the work actually done.

**[G13c-60] P3 — `NFL_LEDGER_TRIALS` cannot be lowered below 80.** L33
`Math.max(80, Number(process.env.NFL_LEDGER_TRIALS) || 120)` — setting it to 50 yields 80.
Undocumented floor.

### `scripts/bootstrap-data.mjs` — 118 lines

Good design: drives syncs over HTTP against a throwaway server on an OS-assigned free port
(L29-35) so ordering constraints live in one place (the routes), tolerates per-step failure
(L66-83), and the ordering comments (L87-102) are substantive. `/api/auth/local-session`
(L60-64) with the recorded reason the steps used to 401 silently is a good fix.

**[G13c-61] P3 — `process.on('exit', stop)` cannot reliably kill the child.** L41-43. The
`exit` event permits only synchronous work; `server.kill()` is synchronous so it usually
lands, but an abnormal termination (SIGKILL, uncaught throw path) leaves the spawned server
holding the free port. The explicit SIGINT/SIGTERM handlers cover the common cases.

### `scripts/import-alt-spreads.mjs` — 204 lines

**No defects found.** The most disciplined script in the set: refuses partial captures by
default, has a real `--dry-run`, distinguishes "moved exactly six" from "find_pair()
substituted a neighbouring line" and prints the difference loudly (L174-178), and states
three separate times that these are not teaser prices and that `nfl_teaser_price_ledger` is
never written (L12-14, L60-61, L204) — backed by a database-level abort in migration 035.

### `scripts/fanduel-lines.mjs` (62) · `sync-ffopportunity.mjs` (6) · `build-evidence-dataset.mjs` (43) · `build-role-scenario-lab.mjs` (39)

Thin CLI wrappers, no defects found. `fanduel-lines.mjs` deliberately reuses the scheduler's
own parser (`__test.parseFanduel`, L16/L25) so the printed board matches what the shopping
board sees — good. `build-evidence-dataset.mjs:17-20` runs migrations first with a recorded
reason (a missing index turned a 15-minute run into seconds). Note `fanduel-lines.mjs:15`
uses a side-effect import (`import '../server/db/index.js';`) that
`system-connectivity.js`'s regex cannot see — see **[G13c-27]**.

---

## 15. Config files

| File | Lines | Notes |
|---|---|---|
| `package.json` | 58 | `"type": "module"`, `engines.node >=22.5` (matches `node:sqlite`'s `DatabaseSync`). `check` script chains typecheck → lint → test → build → smoke, mirroring CI. |
| `tsconfig.json` | 15 | `strict: true`, `noEmit`, `isolatedModules`, `moduleResolution: bundler`. `include: ["client/src"]` — **server and scripts are entirely untypechecked**, which is consistent with them being plain JS, but means `npm run check` covers the client only. |
| `client/vite.config.ts` | 17 | Correct `fileURLToPath` root resolution; port and API proxy both env-overridable for a second dev instance. |
| `client/tailwind.config.js` | 17 | Absolute `content` globs via `fileURLToPath`. Correct. |
| `client/postcss.config.js` | 11 | Passes an absolute `config` path to the tailwind plugin. Correct. |

**[G13c-62] P3 — `client/` has no `package.json`.** The client is built from the root
manifest, so `npm run build` from anywhere but the root will not resolve `vite`. Not a
defect so much as a constraint worth recording; `start.mjs` always passes `cwd: ROOT`.

---

## 16. Cross-cutting observations

1. **The recurring defect shape in this codebase is not bad code — it is a correct,
   well-argued docstring paired with an implementation that does not deliver it.**
   `import-scottfree.mjs` declares a leakage guard and never calls it. `package-release.mjs`
   promises the database is excluded and its fallback would ship it. `system-connectivity.js`
   promises to find dead code and reports "healthy" when it cannot read the tree.
   `football-first.js` promises to abstain when there is no football and no longer does.
   `nfl-live.js` promises never to assert 0 % or 100 % on a live game and does so in
   overtime. `compute-cache.js` documents a prohibition that `nfl-betting.js` violates.
   A doc-to-code assertion test would catch more here than any linter.

2. **`node --check` as "lint" is the enabling condition for most of the P3s.** Dead code
   (`OUTCOME_COLUMNS`), an unused import path, a detached docblock, `pct` flipped against a
   label — a real ESLint pass with `no-unused-vars` alone would have surfaced the P1 in
   `import-scottfree.mjs`.

3. **Process-liveness is checked by proxy in three places** (`launcher.mjs:73` port,
   `:89` and `:140` pgrep). The tunnel failure is exactly what happens when the proxy and
   the property diverge. Asking the app (`GET /api/auth/tunnel-url`, which the launcher
   already knows how to call at L58-70) is the authoritative check and is already written.

---

## 17. Suggested order of work

1. **[G13c-54]** — one-line fix, closes an active label leak into `features_json`.
2. **[G13c-33]** — restart `tunnel.mjs`; kill the orphaned cloudflared (PID 50981); change
   `startTunnel`'s probe to the registrar or to `/api/auth/tunnel-url`. Draft-night blocker.
3. **[G13c-18]** — swap `residualModel` for `peekResidualModel` in the GET handler at
   `nfl-betting.js:1752` and return 202 on a miss. Protects the live T-60 capture.
4. **[G13c-45]** / **[G13c-47]** — add `/^data\.sqlite/` to `walk()`'s exclusions and
   `*.bak-journal` to `.gitignore`; untrack the committed journal.
5. **[G13c-19]**, **[G13c-13]**, **[G13c-21]**, **[G13c-29]** — the wrong-number cluster.
6. **[G13c-51]**, **[G13c-39]**, **[G13c-43]**, **[G13c-41]**, **[G13c-42]** — CI and installer.
