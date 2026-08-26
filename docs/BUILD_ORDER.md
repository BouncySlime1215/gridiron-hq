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
- **Gate:** **fantasy MAE < 42.10** and Spearman ≥ 0.7791 on the same 382
  players. If we still lose to a 10-second average, stop and diagnose — do not
  proceed.

---

## STAGE 2 — Unify: one engine, delete the duplicate
*Only after Stage 1, or we'd propagate a broken engine to a second consumer.*

### 2.1 Extract the player-week engine
Hierarchical state estimator producing a joint distribution over underlying
events. Fantasy head becomes a thin scoring translator over it.
- **Effort:** ~2 weeks
- **Gate:** fantasy numbers unchanged or better after refactor (pure move)

### 2.2 Point props at the engine; delete `nfl-props.js:projectPlayer`
This deletes the crude `0.65/0.35` blend with no shrinkage, no priors, no
availability — replacing it with the good engine that already existed.
- **Effort:** ~1 week
- **Gate:** **props passing-yds MAE < 60** (from 70.14) on the same 4-season
  walk-forward. This is the single clearest predicted win in the plan.

### 2.3 Turn `betting-fantasy-link.js` into a test
It currently reconciles two models. Once there is one model, agreement is
structural.
- **Gate:** fantasy↔props disagreement ≈ 0 by construction

---

## STAGE 3 — Make it learn
*Closes the loop that is empty system-wide today.*

### 3.1 Scheduled retraining jobs
All 8 current jobs are ingestion. Add refit jobs to `scheduler.js`.
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
- **6.3** Open sealed seasons one at a time, chronologically, irreversibly logged
- **6.4** Report everything including failures, with permutation-null tests
- **6.5** Promotion gates: beat all baselines, calibration in tolerance,
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

### P3 — UI
Deferred by your call. `UI_REVAMP.md` has the plan; Codex already shipped the
design system and four-domain nav.

---

## The short version

```
0. Free wins (position backfill first)          ── days
1. Fit the stubbornness dial                    ── ~2 weeks   ← the core fix
2. One engine, delete the duplicate props model ── ~3 weeks   ← the big win
3. Make it learn on a schedule                  ── ~2 weeks
4. New signal                                   ── ~3 weeks
5. Advanced (optional)                          ── months
6. Blind audit                                  ── last, once
```

**Two hard rules**

1. **No step starts before the previous gate is green.** If fitted shrinkage
   doesn't beat hardcoded, we don't paper over it and move on.
2. **Never loosen a gate to let a model through.** If it can't pass
   `safeStakeFor`, the answer is a better model, not a lower bar. That
   discipline is currently the best thing in this codebase.
