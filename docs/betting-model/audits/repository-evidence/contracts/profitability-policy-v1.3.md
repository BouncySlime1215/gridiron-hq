# Profitability policy v1.3 — frozen gate definitions

**Status:** frozen historical contract, extracted verbatim (Section 2,
"Definition of success") from the now-superseded `docs/PROFITABILITY_PLAN.md`
on 2026-09-10, per Codex's `CLAUDE-NEXT-STEPS.md` / `FOLDER-REORGANIZATION.md`
disposition (row: `docs/PROFITABILITY_PLAN.md` → "Migrate content then
delete"). `server/services/nfl-policy.js` cites this document by name and
section as the source of its **200 / 75** market-edge sample-size thresholds
and its promotion discipline — those numeric values are unchanged from the
original; only their documentation location moved. Do not edit the numbers
below to reflect newer thinking — a genuinely revised policy is a new,
separately versioned contract (v1.4+), not an edit to this one, so that
historical runs which cite "v1.3" keep meaning exactly what they meant when
they ran.

## Definition of success

No model, market, or staking rule is allowed to say "profitable" until all
applicable gates pass.

### Forecast gates

- Cutoff-safe predictions captured before the first actionable quote.
- Better than a named trivial baseline on identical observations.
- Improvement survives a week-clustered bootstrap confidence interval.
- Rank accuracy does not decline.
- Probability calibration improves or remains within tolerance.
- The change improves the complete shipped pipeline, not only an isolated
  submodel.
- Every tested sibling is included in multiplicity correction.

### Market-edge gates

- Real book, line, price, and capture timestamp exist.
- Both sides are recorded when available and vig is removed.
- One decision per event/player/market; repeated books and hourly snapshots do
  not inflate the sample.
- At least **200 settled independent shadow decisions overall** before reading
  aggregate CLV.
- At least **75 settled decisions in a market** before making a market-specific
  claim. A market under 75 remains "accumulating" even if pooled results win.
- Mean and median CLV are positive, with the 90% week-clustered interval on
  mean CLV excluding zero.
- Calibration error is at most 0.03 and calibration slope is between 0.85 and
  1.15 on forward observations.
- Positive CLV is present in more than one time window; one hot month cannot
  promote a model.
- Realized ROI is reported, but CLV and calibration decide promotion because
  short-run wins are much noisier.

### Real-money gates

- The market-edge gates pass on frozen forward decisions.
- The policy was unchanged for the promoted sample.
- Best available price was actually reachable at an approved book.
- Open correlated exposure is capped.
- A rollback version is stored before activation.
- The first activation is a limited pilot, never full Kelly.

## Provenance

- Original source: `docs/PROFITABILITY_PLAN.md`, section "2. Definition of
  success" (lines 663–706 as of the audited commit
  `969d501e5d318f8ff650d7e239d8647f8b75eb84`).
- Extracted and frozen: 2026-09-10.
- Cited by: `server/services/nfl-policy.js` (the 200/75 sample-size floors
  and the CLV/calibration-before-ROI promotion discipline).
- The 200/75 counts are **declared operational minimums**, not a universal
  statistical proof of profitability threshold — see
  `docs/CLAUDE-NEXT-STEPS.md` section 11 ("Evidence feasibility and the
  experiment budget") for the fuller caveat: a few hundred bets can still be
  insufficient to detect a small real edge.
