# Independent conformal cross-check (Giant Plan §7.3 / FIX #26)

An outside opinion on the hand-rolled conformal code in
`server/services/model-intelligence.js`.

The reason for doing this at all is narrow and worth stating plainly: this
codebase recently had **six hand-rolled numeric bugs found in a single file**.
A hand-rolled split-conformal implementation is exactly the kind of code where
a wrong answer looks completely reasonable — the intervals come out the right
order of magnitude, the coverage number lands near nominal, and nothing throws.
So it gets checked against [MAPIE](https://github.com/scikit-learn-contrib/MAPIE),
a conformal-prediction library many people have reviewed.

## This is research-only

- It lives in `research/.venv`, which is gitignored.
- **Nothing in `package.json` depends on Python.** The Node app does not import,
  shell out to, or require anything here. Deleting this whole directory would
  not change a single byte the server returns.
- It calls no paid API and opens no production database.

## Running it

```sh
python3 -m venv research/.venv
research/.venv/bin/pip install mapie numpy scikit-learn

# 1. Export the residual panel + the shipped JS conformal output.
#    The export script REFUSES to run unless GRIDIRON_DB_PATH is a fresh
#    /tmp path, so it cannot be pointed at server/data.sqlite by accident.
GRIDIRON_DB_PATH=/tmp/conformal-check.sqlite \
SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node research/conformal/export-residuals.mjs /tmp/conformal-out

# 2. Re-derive the intervals with MAPIE on the identical rows.
research/.venv/bin/python research/conformal/mapie_crosscheck.py \
  --panel /tmp/conformal-out/panel.json \
  --js    /tmp/conformal-out/js-uncertainty.json \
  --out   /tmp/conformal-out/mapie-crosscheck.json
```

`export-residuals.mjs` seeds the deterministic fixture league from
`test/helpers/seed-league-history.js` and then runs the **real** shipped code
path (`nestedEvaluationRows()` → `uncertainty()`). It does not re-implement the
conformal maths; if the shipped code has a bug, the export carries the bug,
which is the entire point.

## What it found (2026-09-12)

`uncertainty()` was taking the **plain linear-interpolated empirical
p-quantile** of the calibration residuals. Split conformal requires the
`ceil((n+1)(1-alpha))`-th order statistic. Dropping the `(n+1)` term is the
anti-conservative variant: it produces intervals with **no coverage guarantee**
while the surrounding `method` string called them "conformal".

MAPIE's half-width reproduced the correct order statistic **exactly on all 12
fold × level cells**, which is what allowed the gap to be attributed to that one
formula rather than written off as a library difference. On the fixture panel
the shipped intervals were 0.6%–4.4% too narrow, worst at the 95% level and
worst on the smallest calibration fold — precisely where an under-wide interval
is most misleading.

The fix is in `model-intelligence.js` (`conformalHalfWidth`) and is pinned by
`test/conformal-finite-sample.test.js`, so the Node suite guards it without
anyone needing to re-run Python.

### An honest caveat about what the fix bought

The correction restores a **lower bound** — coverage ≥ 1 − alpha in expectation.
It does **not** make measured coverage land closer to nominal on any particular
sample, and on this fixture panel it did not: mean |coverage − nominal| across
the four reported metrics moved from 0.0180 to 0.0207, i.e. slightly worse.
Widening an interval that was already over-covering pushes it further over.

The change is here because the code claims to be conformal and now is, not
because it scored better. Anyone quoting these coverage figures should also
note that the panel is the **deterministic fixture league, not real NFL
history** — the real database was out of scope for the worktree this was built
in. The numbers characterise the implementations, not the league.
