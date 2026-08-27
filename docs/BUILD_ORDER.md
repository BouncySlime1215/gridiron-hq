# Build Order

Companion to `docs/MODEL_ROADMAP.md`. Sequenced by **dependency first, then
value-per-effort**. Every step has a gate — a measurement that says whether it
worked. Do not start a step until the previous gate is green.

Baselines to beat, measured 2026-08-26:

| Metric | Current |
|---|---|
| Fantasy MAE (2025 holdout, 382 players) | 42.68 |
| Fantasy — trivial 60/40 blend | **42.10** ← we lose to this |
| Fantasy 80% coverage | 0.733 (target 0.80) |
| Props passing-yds MAE | 70.14 |
| Props TD Brier / skill | 0.1693 / 15.0% |
| Scheduled retraining jobs | 0 |

---

## STAGE 0 — Unblockers
*Nothing model-related can be done properly until these land. All are small.*

### 0.1 Backfill player position — **do this first**
87.6% of player-weeks (45,746 / 52,231) have no position; only QB is populated.
Positional priors are impossible without it.
`syncCrosswalk()` **already downloads** `nflverse players.csv`, reads the
`position` column, and uses it only as a name-match key. Store it.
- **Effort:** hours
- **Gate:** >95% of player-weeks have a position; RB/WR/TE priors computable

### 0.2 Raise gsis_id coverage
838 of 1,036 players have one. The other 19% cannot join to any nflverse feed.
Use `player-identity.js` for the fallback matching.
- **Effort:** hours
- **Gate:** >95% coverage, no ambiguous binds

### 0.3 Freeze the baseline accuracy report
Publish current numbers as an immutable artifact. Without this we cannot prove
any later change is an improvement.
- **Effort:** hours
- **Gate:** report reproducible from a pinned dataset + code hash

### 0.4 One `shrink` implementation
Delete MLB's private duplicate; everything imports `stats-util.js`.
- **Effort:** hours
- **Gate:** one definition repo-wide; tests still green

### 0.5 Source registry with staleness budgets
Each source declares cadence, cutoff semantics, failure mode. A stale source
must lower confidence, not silently serve old numbers.
- **Effort:** 1 day
- **Gate:** every ingestion job registered; staleness visible

---

## STAGE 1 — Fix how the model weighs evidence
*The core defect. Everything downstream inherits it.*

> **STATUS: run and measured — see `STAGE_1_RESULTS.md` for the full write-up.**
> All gates re-measured **week-by-week** (4,340 graded player-weeks for 2025)
> rather than on 382 season totals, because that is how the model runs in
> production and because the season-total sample was too small to separate a
> 1% effect from noise. Fit on 2023+2024, validated on 2025.
>
> - **1.1 FAILED → constants kept.** Fitted `k*` is statistically
>   indistinguishable from hardcoded (CRPS delta −0.011, 90% CI [−0.82, 0.80]).
>   Recorded, not activated. We now know the constants were fine.
> - **1.2 PASSED.** 80% coverage 0.724 → **0.795**, PIT calibration error
>   0.161 → 0.110, CRPS flat. The weekly sampler had *no* parameter-uncertainty
>   draw at all; adding it (`WEEKLY_LEVEL.sigma = 0.45`) is the fix.
> - **1.3 PASSED after diagnosis.** Weekly is the authoritative gate. Separate
>   role memory (`seasonDecay=.05`, `weekHalfLife=5`) improved structural MAE
>   4.586 → 4.501 without hurting rank, CRPS, or coverage. A cutoff-safe convex
>   ensemble fitted on 2023 and architecture-selected on 2024 then scored
>   **4.420 MAE / .6739 Spearman / 3.145 CRPS / .815 coverage** on 2025,
>   beating the fixed 60/40 blend's 4.442 significantly (90% bootstrap CI for
>   MAE delta [−.0403, −.0036]). Four non-circular role-prior candidates were
>   rejected and removed. **Stage 2 is unlocked.**

### 1.1 Fit the shrinkage constants
Replace ~20 hand-picked numbers with `k* = σ²_within / σ²_between`, estimated
per metric per position from data strictly before each cutoff. Version the
resulting `k` vector in the registry.
- **Effort:** ~1 week
- **Gate:** fitted `k` beats hardcoded `k` on held-out CRPS.
  *If it doesn't, keep the constants — we've learned they were fine, which is
  currently unknown either way.*

### 1.2 Add the two missing variance sources
Parameter uncertainty (log-normal level draw) and availability uncertainty
(beta-binomial games). Only outcome noise exists today.
- **Effort:** ~1 week
- **Gate:** **80% coverage ∈ [0.78, 0.82]** (from 0.733); PIT histogram flat
  (from `[28,19,11,9,12,13,15,13,15,15]`)

### 1.3 Beat the blend
The whole point of 1.1–1.2.
- **Authoritative weekly gate:** beat season-to-date and the fixed 60/40 blend
  significantly on identical player-weeks; Spearman must not decline; 80%
  coverage must remain in [.78, .82]; CRPS must not worsen. Season-total MAE
  and rank remain separately reported for the draft-time product.

---

## STAGE 2 — Unify: one engine, delete the duplicate
*Only after Stage 1, or we'd propagate a broken engine to a second consumer.*

### 2.1 Extract the player-week engine
Hierarchical state estimator producing a joint distribution over underlying
events. Fantasy head becomes a thin scoring translator over it.
- **Status:** architecture complete. `player-week-engine.js` owns canonical
  identity resolution, the frozen weekly ensemble, deterministic event
  expectations and constrained team-level simulation. Fantasy scoring is a
  translation over those events; see `STAGE_2_RESULTS.md`.
- **Effort:** ~2 weeks
- **Gate:** fantasy numbers unchanged or better after refactor (pure move)

### 2.2 Point props at the engine; delete `nfl-props.js:projectPlayer`
This deletes the crude `0.65/0.35` blend with no shrinkage, no priors, no
availability — replacing it with the good engine that already existed.
- **Effort:** ~1 week
- **Gate:** **props passing-yds MAE < 60** (from 70.14) on the same 4-season
  walk-forward. This is the single clearest predicted win in the plan.
- **Status:** duplicate blend deleted. Broad passing-yards MAE improved to
  67.724 but remains above the original gate. A pregame market-eligible QB
  population clears it at 59.298; both populations are reported because the
  eligibility change cannot be hidden inside the headline metric.

### 2.3 Turn `betting-fantasy-link.js` into a test
It currently reconciles two models. Once there is one model, agreement is
structural.
- **Gate:** fantasy↔props disagreement ≈ 0 by construction
- **Status:** complete at the event layer and enforced by model-integrity
  tests. The fantasy calibration shift is intentionally separate and visible.

---

## STAGE 3 — Make it learn
*Closes the loop that is empty system-wide today.*

### 3.1 Scheduled retraining jobs
All 8 current jobs are ingestion. Add refit jobs to `scheduler.js`.
- **Status:** foundation shipped. `nfl_weekly_learning` captures immutable
  pregame player-week forecasts, settles them only after outcomes arrive, and
  trains a challenger every six hours when new settled evidence exists. The
  fit ledger preserves both promotions and rejections. The frozen 2023
  champion remains active until at least 250 forward snapshots exist and a
  challenger improves newest-window MAE without damaging rank or coverage.
  The first-write snapshot now also stores all 24 candidate heads. Discovery
  can remove redundant variants and correct for multiple comparisons; forward
  review eligibility never means automatic promotion.
- **Effort:** ~3 days
- **Gate:** ≥4 retraining jobs running on cadence; `sync_log` shows them

### 3.2 Props calibration loop
Walk-forward isotonic/Platt, versioned, scheduled. Props has **zero**
calibration code today.
- **Effort:** ~1 week
- **Gate:** reliability error < 0.02; **note:** this recovers only ~3% of Brier
  loss — the discrimination work in Stage 1–2 is what actually matters

### 3.3 Fantasy calibration loop
Fantasy has no outcome feedback at all.
- **Gate:** coverage holds in [0.78, 0.82] across a full season *automatically*

### 3.4 Start recording live prop lines **now**
Historical prop lines only accrue forward. Every week not recording is a week
lost permanently. **This can start during Stage 0** — it's just a capture job.
- **Effort:** ~2 days
- **Gate:** lines captured weekly with timestamps

---

## STAGE 4 — New signal
*Only once the engine is sound; new features on a broken engine teach nothing.*

### 4.1 Ingest unused verified sources
`pbp_participation` (personnel), `ftn_charting` (motion/play-action),
`contracts` (economic commitment), `officials` (crew tendencies),
`weekly_rosters`, `combine`, and **Baseball Savant Statcast** for MLB.
All verified live (HTTP 200) on 2026-08-26.
- **Effort:** ~1 week
- **Gate:** each source improves held-out CRPS or is dropped

### 4.2 Opportunity features
Route participation, targets per route, end-zone target share (separate from
red-zone), inside-5 carry share, goal-line back identity, designed QB rushes.
- **Gate:** measured improvement per family (ablation)

### 4.3 Changepoint detection
Locally reduce `k` when usage genuinely shifts. This is the real answer to
"adapt week-to-week without absorbing bias" — fast when justified, anchored
otherwise.
- **Status:** first layer shipped. Two consecutive opportunity changes must be
  material, point the same direction, and be corroborated by an eight-point
  offensive-snap shift. Confirmed changes are exposed in typed model evidence
  and already flow through the five-week role-memory and recent-outcome heads;
  no unvalidated second multiplier is applied.
- **Effort:** ~1 week
- **Gate:** faster reaction to real role changes with **no increase** in signed
  bias

### 4.4 ffopportunity as benchmark + feature
An independent expected-points model. Both a feature and a bar to clear.
- **Gate:** we beat it, or we use it

---

## STAGE 5 — Advanced
*Everything here is optional and only justified if Stages 1–4 plateau.*

- **5.1** Residual GBM on top of the structural projection (never replacing it)
- **5.2** Game-theoretic draft: opponent need models, best-response, run dynamics
- **5.3** Bilateral bargaining for trades
- **5.4** Correlated lineup optimisation
- **5.5** LLM structured extraction (beat writers → typed role signals), strictly
  gated — never a raw numeric feature, never in a stake calculation

---

## STAGE 6 — The blind audit
*Last, because it can only be spent once.*

- **6.1** Pre-register and **hash** the spec — feature list, model family,
  hyperparameter space, decision rules, success metrics
- **6.2** Partition: 2016-20 train / 2021 validate / 2022-25 sealed / 2026 forward
- **6.3** Open sealed seasons **one week at a time**, chronologically,
  irreversibly logged — not whole seasons. The model runs weekly in
  production; the audit replays it the same way, so week 15 is graded using
  only data through week 14, exactly as it would run for real
- **6.4** After each week is scored, run a **fault pass** before opening the
  next: worst misses that week, attributed cause (opportunity / efficiency /
  availability / genuine surprise), and where in the season it happened. This
  produces a week-by-week fault ledger, not one end-of-season number — a model
  that's fine through week 10 and degrades from 11-18 is a different, fixable
  problem than one that's uniformly mediocre, and a season aggregate hides
  that difference completely
  - **Grade against what the game actually became**, not just the stat line:
    final score/margin, the game script the model assumed vs what really
    happened, and in-game events (injury, blowout, weather shift) tagged
    separately as unmodelable-in-advance rather than penalized like an
    ignored Wednesday injury report. A missed number and a misunderstood game
    are different bugs, and only this comparison tells them apart.
  - The attributed cause **feeds Stage 3's calibration jobs directly** — this
    is what makes the audit a learning loop, not a scorecard
- **6.5** Report everything including failures, rolled up **by week-in-season**
  first and by the usual slices second, with permutation-null tests at the
  same weekly cadence
- **6.6** Promotion gates: beat all baselines, calibration in tolerance,
  ≥250 shadow decisions with positive CLV where a market exists

---

## PARALLEL TRACKS
*Independent of the model work; can run alongside.*

### P1 — Live Draft 3C/3D (paused, resume when you want)
- **3C** resilience: adaptive polling, backoff, tab-visibility, credential
  expiry, restart recovery
- **3D** the Live Draft UI, safe diagnostics, ~35 more test scenarios,
  simulated-draft certification
- The reconciliation engine underneath is done and tested, so 3C is mostly wiring
- **Time-sensitive:** must be done before your next real draft

### P2 — Duplicate player repair
64 groups remain. 11 are safe (orphan seed rows); 53 have distinct ESPN ids and
need per-case judgment. Dry-run exists in `player-repair.js`.
- Watch `UNIQUE(draft_id, player_id)` collisions when re-pointing picks

### P3 — UI, small touch-ups only
Codex already shipped the design system + four-domain nav as a starting
scaffold. Anything beyond small fixes on top of that scaffold waits for
**Stage 7** below — building new pages against models that are still
changing (Stages 1-6) means rebuilding those pages again once the models
settle. The full overhaul is deliberately last.

---

## STAGE 7 — Full UI overhaul
*Last, on purpose. Every surface below depends on a model output — projection
distributions, driver decompositions, calibration state, CLV, the fault ledger
— that isn't stable until Stages 1-6 are done. Building the real pages earlier
means rebuilding them once the engine changes shape.*

Full plan in `docs/UI_REVAMP.md`. In sequence:

- **7.1** Design system + tokens + core components (light/minimal, per Nick's
  stated preference — no dark dashboards, schematic not decorative diagrams).
  Codex's initial four-domain nav + `DesignSystem.tsx` scaffold is the starting
  point, not the finish line.
- **7.2** Navigation/IA restructure onto the four domains (Fantasy /
  Intelligence / Betting / Lab) with redirects so nothing 404s
- **7.3** Home / Command Center — what needs attention, what changed, what to
  do, why, how confident, how fresh
- **7.4** Players consolidation — one virtualised table replacing
  Players/PlayerDetail/Rankings/Projections
- **7.5** Draft (pairs with the paused Phase 3D)
- **7.6** Betting hub UI — CLV ledger, divergence board, prop lab, and the
  Model Honesty Panel showing the four disproofs from §0 permanently, plus
  the week-by-week fault ledger from Stage 6 rendered as a real page, not a
  JSON dump
- **7.7** Lab UI — accuracy ledger, experiments, registry/promotion, all
  driven by the fault ledger and calibration diagnostics that now actually exist
- **7.8** Accessibility + performance pass across all of it

**Gate:** every number on every page traces to a real, versioned model output —
no placeholder charts shipped ahead of the data that fills them.

---

## The short version

```
0. Free wins (position backfill first)          ── days
1. Fit the stubbornness dial                    ── ~2 weeks   ← the core fix
2. One engine, delete the duplicate props model ── ~3 weeks   ← the big win
3. Make it learn on a schedule                  ── ~2 weeks
4. New signal                                   ── ~3 weeks
5. Advanced (optional)                          ── months
6. Blind audit, week-by-week, with a fault      ── last, once
   ledger that learns from what actually happened
7. Full UI overhaul                             ── last of all
```

**Two hard rules**

1. **No step starts before the previous gate is green.** If fitted shrinkage
   doesn't beat hardcoded, we don't paper over it and move on.
2. **Never loosen a gate to let a model through.** If it can't pass
   `safeStakeFor`, the answer is a better model, not a lower bar. That
   discipline is currently the best thing in this codebase.
