# A weekly projection range: the causal quantile-band algorithm

2026-09-22. `server/services/projection-range.js` (new), `test/projection-
range.test.js` (new). Off `main` `654ff93`, on branch `effk`.

## Where this came from

`docs/spec/projection-range.md`, built by the Model evidence audit thread on
branch `claude/project-thread-w0gpjt` (this unit reads it at pushed commit
`c58c20e`, not an earlier pasted draft — the two are identical in every
section that matters here; `c58c20e` additionally withdraws §4, the start/sit
decision table, which was never this thread's half). Nick's decision: keep
the point projection, add a range alongside it. The spec measures, on 25,323
out-of-sample WR/TE/RB predictions from a research-baseline walk-forward
2018-2025, that a fixed `±N` band is wrong two ways — residual spread scales
~2.56x from the bottom projection decile to the top, and fantasy points are
floored at zero with a long right tail, so a symmetric `mean ± k·sd` band
both undershoots the floor and understates the upside. The fix: causal
conditional empirical quantiles, read off history rather than derived from a
normal.

## Scope of this unit, stated plainly

The spec is explicit (§7) that its own calibration numbers — 80.74% coverage,
13.63 PPR mean width — were measured against a **research baseline**, not the
production model that would actually serve this. Tracing the wiring (the
spec's own correction, and this thread's read of the same code) found neither
model has an opponent-defence feature (`opp_adj_def_epa` reaches the betting
surface only, confirmed dead for fantasy); the real difference is that
production has `vegasLift` (`lineup-brain.js:275`) and the research baseline
doesn't. Which direction that cuts is not known. **§3's widths must be
re-measured against real production out-of-sample data before any number is
quoted to a user** — the spec's own words, not a caution this unit is adding.

So this unit builds **only the algorithm** (§2), as pure, tested code,
against synthetic fixtures with hand-computable answers — not R&D's own
25,323-row research dataset, and not any claim about what coverage the
algorithm achieves on real Gridiron HQ projections. Wiring it into
`buildProjections`'s actual output, sourced from a real causal walk-forward
over production's own history, is separate, larger work — reported as its
own scope question to the coordinator rather than assumed complete here.

## What this adds

Three functions in `server/services/projection-range.js`, translated from the
spec's own reference script (`intervals2.py`, delivered as message content
since nothing of Model evidence audit's is pushed to a branch other than the
docs) into this repo's style:

- `quantile(sorted, p)` — linear-interpolation quantile over a sorted array,
  same convention as the reference script.
- `fitProjectionRangeTable(history)` — bins each position into 8 equal-count
  projection bins; a position under `8 × 150` rows pools onto the full
  combined-population fit rather than fitting alone on too little data.
  Per bin: `lo` = floored empirical 10th percentile, `f_lo` = the actual
  fraction of prior outcomes below that floor, `hi` = the quantile that
  absorbs whatever the 20% miss the floor couldn't hold in the lower tail.
  A bin under 20 rows is `null` — no fabricated range.
- `projectionRangeFor(table, pos, yhat)` — looks up the band for one
  projection; `null` for a position never seen in the fitting history.

**Causality is the caller's job, not this module's.** `fitProjectionRangeTable`
has no notion of season/week ordering — it fits on whatever rows it's given.
The spec's requirement ("only strictly earlier season-weeks") has to be
enforced by whoever builds the `history` array from real data, which this
unit does not do.

## Mutations

Base `projection-range.js` = `cebeab8c0a8f`. Each row applied alone from a
clean base via the sweep runner, hashed before/after, file restored at the
end.

| # | mutation | result | first sweep | after rewrite |
|---|---|---|---|---|
| P1 | `quantile` stops interpolating (rounds down) | 1 fail | 1 fail | — |
| P2 | `quantile` returns `undefined` instead of `null` on empty input | 1 fail | 1 fail | — |
| P3 | pooling threshold check inverted | 1 fail | **survived, 0** | 1 fail |
| P4 | the 20-row minimum-to-serve gate removed | 1 fail | 1 fail | — |
| P5 | `lo`'s floor-at-0 removed | 1 fail | **survived, 0** | 1 fail |
| P6 | the `f_lo`-adjusted upper tail reverts to a naive symmetric quantile | 1 fail | **survived, 0** | 1 fail |
| P7 | `projectionRangeFor` stops checking whether the position exists at all | 1 fail | 1 fail | — |

**Three of seven rows survived the first sweep at 0 fail — every one a
fixture that happened not to exercise the guard it was meant to test, the
same recurring pattern this session (most recently four survivors on
`nfl-metric-reliability.test.js`, closed the same way):**

- **P3** (pooling threshold): the original fixture gave WR and TE the exact
  same data shape (`yhat = i % 50` for both), so whether each fit alone or
  both pooled onto a combined table, the results came out identical by
  coincidence — the test couldn't tell "pooled" from "happened to match."
  Closed by giving WR and TE non-overlapping `yhat` ranges (0-49 vs 100-149):
  now pooling is the only way their tables can match, and the assertion
  additionally checks the pooled edges span BOTH ranges, ruling out "matched
  by accident" a second way.
- **P5** (floor at 0): the fixture wrapped every `y` value in `Math.max(0,
  ...)` before it ever reached the fitter, so the *data itself* could never
  produce a negative quantile — the code's own floor was never exercised
  regardless of whether it existed. Closed by feeding genuinely unfloored
  values (`y` ranging roughly -10 to +10) so the raw quantile is
  demonstrably negative, and only the code's `Math.max(0, ...)` prevents a
  negative `lo`.
- **P6** (`f_lo`-adjusted upper tail): the original fixture was heavily
  right-skewed enough that a naive symmetric 90th-percentile upper tail and
  the correctly `f_lo`-adjusted one both landed "clearly wider than the lower
  gap" — a qualitative assertion (`upperGap > lowerGap`) that couldn't
  distinguish the right formula from a wrong-but-still-asymmetric-looking
  one. Closed with a fully hand-computable fixture (30 zeros + the integers
  1-70, 100 rows) where the correct formula gives `hi = 50.2` and the naive
  symmetric formula gives a different, specific wrong answer (`60.1`) —
  pinned to the exact expected value, not a direction.

Re-swept after the rewrite: 7/7 rows caught, 0 survivors.

## Numbers

RED (`bc3d0c3`): the whole test file failed to import (module didn't exist).
GREEN, before the mutation-driven fixture rewrite: 9 tests (one already
needed a second fixed test at write time — see P3's fix above, added before
the first GREEN run since the original assertion was self-evidently wrong,
not just weak). After closing the three survivors: **10 tests, 10 passed, 0
failed** in `projection-range.test.js`.

Full local check `npm run check` on `effk`, this commit (staged before the
run, `git write-tree` = `fd3bedda4a348e905c11c26f4a4c17c611c7e4e0` immediately
before `npm run check` started): exit 0 — **3,035 tests, 2,994 passed, 0
failed, 41 skipped**; typecheck, lint and build clean; `start:smoke` passed
on an isolated database (32 teams). Delta from the prior full-check baseline
(3,025/2,984/0/41, this branch's `73c0e11` commit): exactly **+10/+10/0/0**,
matching this unit's own new test count precisely.

**Isolation, stated rather than implied:** source-isolated — one working
tree, shared `node_modules`, no install during the run.

## The five questions

**Is this well built?** The algorithm matches the spec's own reference
script line for line in method, with the one honest gap — causality
enforcement — stated as the caller's responsibility rather than silently
assumed. Not yet wired to real data; that's stated as a separate step, not
hidden.

**Is this based on stats, or is it made up?** The *method* is exactly R&D's
own, hand-verified against their reference script. The *numbers* this test
suite exercises are synthetic and hand-computable, deliberately NOT the
spec's own 80.74%/13.63 PPR figures — those apply to a research baseline this
codebase doesn't run, and quoting them here would misrepresent what this
commit actually measured.

**How do we know?** Seven mutations, three survivors, each closed by
identifying exactly what the original fixture couldn't distinguish and
replacing it with a fixture that can — in P6's case, a fully hand-computed
exact expected value rather than a qualitative "wider" check.

**Should this data be pointed anywhere else on the platform?** Yes, per the
spec — the projection surface's serving contract (§5: `range_lo`, `range_hi`,
`range_coverage`, `range_basis`, `range_fitted_at`, `range_n`) and
`lineup-brain.js`'s start/sit margin labels (a separate file, and per the
spec's §6 not this thread's half). Neither is wired yet.

**How does it unify?** Same causal, no-fabrication discipline as every other
measurement this session has built — `unavailable`/`best_effort`/`confirmed`
for league config, `icc`/`k` for shrinkage, and now a range that refuses to
report on a bin thinner than 20 real rows rather than inventing one.
