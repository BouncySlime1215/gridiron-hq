# Player-outcome variance in the draft lookahead

**2026-09-07.** `server/services/draft-lookahead.js` now draws each candidate roster's
season outcome through the Gaussian copula in `correlation.js`, with per-player marginals
from `preseason-model.js`'s p20/p80 band. Before this it scored every simulated roster on
deterministic `projected_points`.

This is a variance-realism fix to a tool that already shipped, not a new predictive claim.
The deterministic ranking (`rankTargets`, VORP, the survival model) is untouched, and the
draft-order simulation is bit-identical to what it was — there is a regression test that
fails if it ever stops being.

## The bug

`docs/BETTING_CAPABILITY_AUDIT.md` (cluster 5) put it exactly right:

> `draft-lookahead.js` has no player-outcome draws *at all*. Its only stochastic element is
> draft order (`pickOpponent` sampling opponents by noisy market rank); every candidate
> roster is scored through `rosterValue(...)` on deterministic `projected_points`, and the
> `sd` it reports is the spread of *who else got drafted*, not of how anyone performed.

The feature is presented as "if you take him now, what roster do you end up with", over 200
simulated worlds. A user reads that as including how the players do. It did not. On a real
mid-draft board the old spread was **sd ≈ 20–25 points on a ~2,250-point roster (about 1%)**
— which is the spread of who else got drafted, and nothing else.

## What was wired together

Nothing here is new machinery. Three proven components, joined:

| Component | Role | Already used by |
|---|---|---|
| `correlation.js` `correlationMatrix` + `cholesky`/`correlatedNormals` | joint dependence (Gaussian copula) | `season-sim.js`, 10,000-season sim |
| `preseason-model.js` `preseasonProjections()` p20/p80 | per-player marginal spread | the board's range bars |
| the existing `pickOpponent` draft-order sim | second, independent variance source | unchanged |

Each Monte Carlo iteration now has **two** independent random elements: the draft order
(as before) and one simulated NFL season shared by every player on the board. The season is
drawn once per iteration, before the candidate loop, so candidates are compared inside the
*same* football season as well as the same draft order — common random numbers on both axes.

### Dependence

`correlationMatrix` is called with `opponent: null`, because this is season grain and there
is no single opponent. That leaves exactly the same-team archetypes firing:

| archetype | fitted | drawn (40k sims, measured) |
|---|---|---|
| QB ↔ WR, same team | 0.176 | 0.177 |
| QB ↔ TE, same team | 0.160 | 0.160 |
| RB ↔ WR, same team | 0.003 | 0.003 |
| QB ↔ WR, different teams | — | 0.001 |

Two honest limitations, both conservative:

- **The fitted table is a *weekly* correlation.** Season totals share more structure than
  single weeks do — an offense that busts, busts all year — so this *understates* the true
  season-level dependence. Using the proven table unscaled beats inventing a season
  multiplier nobody has validated.
- **`pairCorrelation()` scales QB↔catcher by target share when it has one.** The draft board
  does not carry target share, so the unscaled archetype is used and a genuine WR1 stack is
  treated like a WR4 stack.

### Marginals, and the two corrections the data forced

The band is a *ratio* band (`p20`/`p80` as multiples of the point estimate), so it transfers
onto whatever projection the board is using. A lognormal is fitted through the two quantiles,
which keeps the right skew realized ratios actually have and, being a monotone transform of
the latent normal, leaves the copula's rank dependence untouched.

Two things had to be corrected, and both were found by measuring rather than assumed:

**1. Recentring to E[multiplier] = 1.** Matching the band's quantiles literally was tried
first and rejected. A lognormal that reproduces p20 and p80 exactly has mean
`exp(mu + sigma^2/2)`, and the band widens fast with positional rank. On the shipped 2026
curve that mean is a well-behaved 1.02x for the top 12 at a position but reaches **4.76x**
in the deep tail, because a symmetric log scale extrapolates an upper tail the real ratio
distribution does not have. Left in, the lookahead would have preferred hoarding late-round
lottery tickets — a *changed recommendation produced by a fitting artifact*, in a change
whose whole premise is that it does not change recommendations.

**2. A measured spread calibration, `SPREAD_SD_CALIBRATION = 1.30`.** The band's *quantiles*
are well calibrated; its lognormal-implied *standard deviation* is not. Over 599 held-out
player-seasons (2023–2025, walk-forward fits, top 200, projection > 20 pts):

| positional rank | n | realized p20 | realized p80 | realized sd | band-implied lognormal sd | ratio |
|---|---|---|---|---|---|---|
| 1–6 | 72 | 0.718 | 1.344 | 0.354 | 0.428 | 1.20x |
| 7–12 | 72 | 0.732 | 1.281 | 0.361 | 0.463 | 1.27x |
| 13–24 | 144 | 0.688 | 1.369 | 0.411 | 0.541 | 1.37x |
| 25–48 | 161 | 0.488 | 1.437 | 0.511 | 0.636 | 1.22x |
| **all** | **599** | **0.569** | **1.419** | **0.485** | **0.628** | **1.30x** |

One constant covers the whole board, so sigma is solved to reproduce the measured standard
deviation rather than to hit the two quantiles exactly. This costs less than it sounds:
recentring to E=1 was already pulling the fat-tailed fit's quantiles down, and the corrected
draw lands *closer* to the realized band than the uncorrected one (posrank 1–6: drawn
p20 0.71 / p80 1.26 against realized 0.72 / 1.34, versus 0.65 / 1.30 uncorrected).

`SIGMA_CAP = 1.0` then bounds the tail past where the band was ever graded — coverage was
measured on the top 150/200, not on WR90.

**Re-measure both constants if the preseason band is refitted** — they are properties of that
fit, not universal ones.

Reproduction scripts are in `scratchpad/lookahead-variance/`:
`perplayer.mjs` (the two tables above and the roster permutation test), `historical.mjs` (the
snake-drafted real seasons), `decompose.mjs` (the simulated roster decomposition),
`marginal-check.mjs` (copula and marginal probes), `stability2.mjs` (stability and latency).

### Anti-hindsight

`buildLineup` still sets the starting lineup from `projected_points`; only the *scoring* uses
the draw. Letting the drawn season pick the starters would hand every simulated manager a
crystal ball and quietly reward bench depth that only pays off in hindsight — the same bug
`season-sim.js#lineupPoints` documents having already been fixed once.

## Sanity check 1 — does the spread match reality?

### Per player

With the calibration applied, the mixture standard deviation of the drawn marginals against
the realized standard deviation, on the identical 599 held-out rows:

| positional rank | n | model sd | realized sd | ratio |
|---|---|---|---|---|
| 1–6 | 72 | 0.336 | 0.354 | 0.95x |
| 7–12 | 72 | 0.364 | 0.361 | 1.01x |
| 13–24 | 144 | 0.429 | 0.411 | 1.04x |
| 25–48 | 161 | 0.515 | 0.511 | 1.01x |
| all | 599 | 0.533 | 0.485 | 1.10x |

Within 5% in every graded bucket. The pooled 1.10x is carried by rows past rank 48, where the
band is widest and least graded and `SIGMA_CAP` is doing the work.

### Per roster

The comparison that matters is the whole finished roster, since that is what the lookahead
reports. Two independent measurements of the real thing:

1. **Snake-drafted rosters on real seasons.** Fit walk-forward (train < *s*, score *s*) for
   2023/2024/2025, snake-draft the graded board in strict ECR order into 8 teams, and read
   `Σactual / Σprojected` over the starting lineup: **mean 0.987, sd 0.102, CV 10.4%**, range
   0.780–1.174 (n = 24). Using the lookahead's own value functional (starters + 0.25 × top-4
   bench VORP, replacement points per season from `docs/DRAFT_AUDIT_2021_2025.md`):
   **mean 1.004, sd 0.099, CV 9.9%**. This one is deflated — the 8 rosters partition the same
   top-128 players, so their ratios are pushed toward a common season mean.
2. **Synthetic 7-starter rosters built from the realized ratios**, drawing the real starting
   shape (QB / RB / RB / WR / WR / TE / FLEX) at realistic rank caps within each season, which
   removes the partition constraint: **mean 0.992, sd 0.136, CV 13.7%** over 4,000 rosters.

Simulated, on Nick's real 8-team board (draft 20), a plausible 16-man finished roster:

| | mean | sd | CV |
|---|---|---|---|
| starters only (incl. K/DEF, which are not drawn) | 2293.1 | 263.4 | 11.5% |
| skill starters only | ~1991 | 263.4 | **13.2%** |
| 0.25 × bench VORP | 53.6 | 47.8 | 89.2% |
| total (`rosterValue`) | 2346.7 | 266.1 | 11.3% |

**13.2% simulated against 13.7% realized.** Before the calibration the same roster simulated
at 17.2% — a 1.26x over-dispersion that matches the 1.30x per-player lognormal inflation, which
is what says the two corrections are one correction and not two fudge factors.

At the candidate level, one real board state (draft 22, pick 34, round 3, 200 sims):

| candidate | before: expected / sd | after: expected / sd / sd_order | after: p10–p90 | sniped |
|---|---|---|---|---|
| Zay Flowers (WR) | 2268.6 / 15.0 | 2291.3 / 270.4 / 15.0 | 1988–2683 | 14% |
| Davante Adams (WR) | 2260.1 / 13.0 | 2287.0 / 252.3 / 13.0 | 1969–2604 | 1% |
| Javonte Williams (RB) | 2280.1 / 12.8 | 2328.7 / 264.3 / 12.8 | 2010–2695 | 37% |
| Travis Etienne Jr. (RB) | 2275.6 / 16.0 | 2287.4 / 262.2 / 16.0 | 1982–2652 | 19% |

`sd` goes from 13–16 points to 250–270 on a ~2,290-point roster: **1% to about 11.5%**, which
is the number sanity check 1 says it should be. `sd_order` is retained so the two components
stay separable rather than being silently pooled into a number a reader cannot decompose.

`expected` drifts up 1–2% — the convexity of `max(0, points − replacement)` in the bench term,
which is real option value on bench upside, bounded by a regression test at < 6%.

### One correction the blocking surfaced

Javonte Williams above has the highest raw `expected` (2328.7) but ranks *fourth*. That is not
a bug, and it was a latent bug before. He is sniped in 37% of iterations, so his mean is taken
over the 63% of worlds where the RB run did not happen — which are also worlds where the rest
of his roster came out better. Ranking on raw means compares candidates over differently
selected sets of worlds and quietly rewards the ones that get sniped most. The blocked
comparison only uses iterations where a rival also survived, and re-anchoring it gives
`expected_paired` = 2284.6, in line with the field. **`expected_paired` is what the UI shows**,
so the number on screen and the order it sits in cannot disagree; `expected` is kept in the
API because it is still the right answer to "if I *do* get him, what does my roster look
like". There is a test asserting the two can never contradict each other.

## Sanity check 2 — is the recommendation stable at 200 sims?

**This is where the change earns its keep, and the answer is not the comfortable one.**

Six real mid-draft board states from Nick's 12-team league (draft 22, truncated to picks 9 /
33 / 57 / 81 / 105 / 140), 8 different seeds each, 6 candidates:

| pick | sims | top-1 agreement | distinct winners | gap (1st–2nd) | SE of that gap | gap/SE | median ms |
|---|---|---|---|---|---|---|---|
| 10 | 200 | 4/8 | 3 | 4.1 | 9.19 | 0.45 | 3086 |
| 10 | 400 | 5/8 | 3 | 5.7 | 5.73 | 1.00 | 6095 |
| 10 | 1000 | 4/8 | 3 | 2.2 | 3.82 | 0.57 | 10499 |
| 34 | 200 | 3/8 | 3 | 7.9 | 8.80 | 0.89 | 3044 |
| 34 | 1000 | 4/8 | 3 | 1.1 | 3.70 | 0.29 | 14683 |
| 58 | 200 | 4/8 | 5 | 9.1 | 7.64 | 1.19 | 1718 |
| 58 | 1000 | 4/8 | 4 | 3.4 | 6.68 | 0.50 | 10584 |
| 82 | 200 | 3/8 | 3 | 3.2 | 5.02 | 0.64 | 1756 |
| 82 | 1000 | 3/8 | 4 | 1.2 | 2.32 | 0.50 | 13066 |
| 106 | 200 | 3/8 | 5 | 2.4 | 4.98 | 0.48 | 1435 |
| 106 | 1000 | 7/8 | 2 | 0.6 | 2.15 | 0.28 | 6719 |
| 141 | 200 | 4/8 | 3 | 1.2 | 0.06 | 19.41 | 261 |

**Raising the sim count does not stabilise the top-1 recommendation, because the instability
is not sampling noise — the candidates are genuinely tied.** Going 200 → 1000 shrinks the
standard error roughly as 1/√n, exactly as it should, but the estimated gap shrinks with it
(pick 34: 7.9 ± 8.8 becomes 1.1 ± 3.7). `gap/SE` stays at or below 1 on every mid-draft board
at every sim count tried. There is no n at which a real 1-point difference on a 2,000-point
roster becomes a confident recommendation.

Two things had to change because of this:

1. **Ranking is done on the within-iteration (blocked) comparison, not on separate means.**
   Every candidate is scored inside the same simulated season and the same draft order, so
   subtracting each iteration's own mean removes the block effect that dominates the raw
   spread. This roughly halves the standard error of the gap at a fixed sim count — from
   ~19 (the raw `sd`/√200) to the 5–9 in the table. Without it the ordering is nearly a coin
   flip; with it, it is a coin flip that at least reports its own error.
2. **The API exposes `delta_se`, and the UI says "too close to call"** for any candidate
   inside 2 SE of the leader, instead of labelling one "best finish". A more realistic
   simulation that still manufactured a crisp winner would be worse than the version it
   replaced, not better.

**Recommended sim count: 200, unchanged.** 400 and 1000 buy no ordering stability and cost
3–7x the latency. The pick-141 row shows the other end — once the draft is nearly over the
remaining choices really are separated (gap/SE 19), and 200 sims resolves that fine.

What is *not* unstable: `sniped_pct`, `typical_build` and `likely_next` are draft-order
quantities, bit-identical to before this change, and they were arguably always the more
useful half of this panel.

### Latency

Old and new alternated in one warm process, median of 4 runs each, 200 sims, 6 candidates,
400-deep pool:

| pick | order only | + season draws | delta |
|---|---|---|---|
| 141 | 238 ms | 263 ms | +25 |
| 106 | 1137 ms | 1190 ms | +53 |
| 82 | 1568 ms | 1726 ms | +158 |
| 58 | 2024 ms | 1988 ms | −36 |
| 34 | 2339 ms | 2037 ms | −302 |
| 10 | 2927 ms | 3267 ms | +340 |

**The outcome draw costs roughly +50 to +350 ms, under 10% of the call, and is inside the
run-to-run noise on half the boards.** One Cholesky of the ~320-player skill universe and
`sims` correlated draws are amortised across all six candidates; the cost is dominated by the
draft playout, which is unchanged. Early-round boards are the slow ones because the pool is
deepest, and that was already true.

The repo's "~1s" figure for this endpoint is stale independently of this change: the
order-only path measures 1.1–2.9 s at picks 10–106 with `poolLimit: 400`. The endpoint is
memoised per (draft, pick) and the client fires it when the user is within 3 picks of the
clock, so against a 90-second pick timer this is comfortable either way — but the doc figure
should be read as ~2 s, not ~1 s.

Cold-start note: the first call in a process now also builds `preseasonProjections()` if
nothing has yet (walk-forward fit over 2022–2025). It is memoised, and during a live draft the
board and player pages have already warmed it.

## Sanity check 3 — nothing deterministic regressed

- `npm test`: 835 tests at the start of this work, 939 at the end, **0 failures at both ends**
  (1 skipped, unchanged). 11 of those are this change's
  `test/draft-lookahead-variance.test.js`; the rest arrived from concurrent unrelated work in
  the same tree (`trade-verify`), which is why the totals do not simply add. No existing test
  was modified by this change.
- `npm run typecheck`, `npm run build`: clean.
- The strongest guard is `adding outcome draws leaves the draft simulation itself
  bit-identical`: it runs the same board with `outcomeDraws: true` and `false` and asserts
  `sd_order`, `sniped_pct`, `sims`, `typical_build` and `likely_next` match exactly, for every
  candidate. Those are decided by the draft-order RNG alone, so if the outcome layer ever
  perturbs that stream — a shared RNG, a reordered draw — the test fails.
- `rankTargets` and `draft-assist.js`'s ranking/VORP logic were not touched, so the 2021–2025
  draft audit in `docs/DRAFT_AUDIT_2021_2025.md` still describes the shipped ranker unchanged.
  The only automated coverage of `rankTargets` is `test/draft-assist-bestball.test.js`, which
  passes unchanged. The audit itself has no re-runnable harness — it is a read-only study and
  the `scratchpad/audit/` scripts it cites are no longer in the tree — but its inputs
  (`nfl_historical_adp`, the graded season rows) and the code it graded are both untouched
  here, so re-running it could not produce a different result.

## API and UI

Added to each lookahead candidate: `p10`/`p90` (10th/90th of the finished-roster
distribution), `sd_order` (the draft-order-only spread, so the two components stay separable),
`delta_se` and `expected_paired`. Added to the response: `outcome_draws`, `drawn_players`.
`delta` is now the
blocked within-iteration gap rather than a difference of means — same units, same sign, a
lower-variance estimator of the same quantity.

Nothing was removed or renamed, so no client change was *required*. Three were made anyway,
because what was on screen had become a claim the numbers no longer supported:

- the caption says the season is drawn from the p20/p80 band, not merely that the draft was
  played out N times;
- each candidate shows its p10–p90 range, gated on `outcome_draws`;
- a candidate within 2 SE of the leader reads "too close to call" and shares the leader's
  highlight, instead of one row being labelled "best finish" on a coin flip;
- the points shown are `expected_paired`, so a heavily-sniped candidate's favourably selected
  raw mean cannot rank above the row it is printed below.

`lookahead()` also takes `outcomeDraws: false` (reverts to the pre-change behaviour, for
diffing on one board) and `bands` (inject the marginal, which keeps the call pure — the tests
use it).

## What this does not claim

- It does not change who the **board** recommends taking: `rankTargets`, VORP and the survival
  model are untouched, and they are what "Take one of these" is ordered by.
- It does, honestly, make the **lookahead panel** less decisive. Its top-1 ordering was
  never as stable as it looked; modelling outcome uncertainty exposes that rather than causing
  it, and the panel now reports the tie instead of hiding it.
- It does not claim the season-level correlation is right — it is a weekly correlation used
  at season grain, deliberately, and it understates.
- It is not walk-forward-validated as a *predictive* feature, because it is not one. What is
  validated is that the spread it reports now matches the spread the data actually shows,
  which it previously did not by a factor of roughly fifteen.
