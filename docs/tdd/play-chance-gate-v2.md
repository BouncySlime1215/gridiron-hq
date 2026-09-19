# G2-v2 — the restructured designation × role gate

**Written 2026-09-19, and committed before any 2025 number was recomputed under it.**
That order is the whole point of this document. The rule below was fixed first; only
then was the fit re-run. If the record shows otherwise, the rule is void.

Authorised by Nick on 2026-09-19 ("just do ur rec for everything"), after being shown
the measured effect of the blocked fit: for a healthy starter with no injury report at
all (n=1,839) the actual play rate is 94.5% and the shipped constants path says 69.5%.

---

## 1. What is wrong with G2-v1, structurally

G2-v1 (`DESIGNATION_ROLE_GATE` / `designationRoleGate`, `server/services/contingency.js`)
applies two conditions to every gated cell:

| condition | how it treats cell size | line |
|---|---|---|
| calibration | tolerance **scales with the cell's own sampling error**: `max(0.03, 2·√(p̂(1−p̂)/n))` | `contingency.js:806` |
| log loss | flat `candidate ≤ current + 0.02`, **identical for every cell** | `contingency.js:809` |

So the two halves of one rule disagree about whether cell size matters, and the half
that ignores it is the half that can veto the entire fit.

The consequence is backwards from what a gate should do. The smallest gated cell has
the noisiest log-loss estimate, so it is the **most** likely to cross a fixed threshold
by chance, while a large cell with a genuinely worse log loss crosses the same
threshold no more easily. A 50-row cell therefore holds the loosest evidentiary
standard for issuing a veto and the greatest power to issue one at random.

This is a defect in the rule's construction. It is stated here without reference to
which cell failed, because it would be true of a rule nobody had ever run.

## 2. The replacement — one condition changed, nothing else

**2.1 Minimum cell size: unchanged at n ≥ 50.** Cells below it stay ungated. Raising
it is the obvious way to make a thin cell stop vetoing, and it is exactly the
relaxation this document refuses: it would discard the cell's evidence rather than
weigh it.

**2.2 Pooling: unchanged, because it already exists.** Every row enters two cells —
its `designation|role` cell and its `designation|*` pooled row (`contingency.js:797`) —
and the pooled row is gated by the same rule. A thin cell's evidence is therefore
never discarded; it is also gated at the pooled level, where n is large enough for the
comparison to mean something.

**2.3 A pooled cell that fails, fails the gate.** No exception and no separate size
test beyond the same n ≥ 50. This is the answer to "what happens to a pooled cell that
still fails": it blocks the fit, and nothing is written.

**2.4 The log-loss condition becomes size-aware, matching its sibling.** For each gated
cell, bootstrap the per-row log-loss difference (candidate − current) using
`pairedBootstrapDiff`, clustered on `player_id`, 2,000 draws, seed 20260918 — the same
helper, the same clustering, the same draw count and the same seed the gate's existing
check 1 already uses, so no new statistical machinery is introduced.

The cell **fails** the log-loss condition if and only if the **lower** bound of the 90%
interval exceeds the slack:

```
fails  ⟺  ci90_low( mean per-row logloss_candidate − logloss_current ) > 0.02
```

That is: a cell vetoes only when its own data can distinguish a degradation larger than
0.02 from noise at 90%. A cell whose interval straddles 0.02 has not demonstrated a
degradation and does not veto.

A cell with fewer than 10 rows cannot be bootstrapped (`pairedBootstrapDiff` refuses
below 10) and falls back to the v1 point comparison. With `minCell` at 50 no gated cell
reaches that path; it exists so the function cannot silently pass a cell it failed to
evaluate.

**2.5 The calibration condition is unchanged**, byte for byte, including its floor of
0.03 and its `or no worse than current's` escape.

**2.6 Everything outside G2 is unchanged**: the main gate's three checks, the
population, the selection protocol, the held-out season, and the write-or-clear
behaviour on failure.

## 3. What this is, honestly

**This is a relaxation of the veto, and stating it plainly is part of the
pre-registration.** A cell whose point estimate sits just above 0.02 with an interval
straddling it used to fail and now passes. For a large cell the interval is tight
around the point estimate, so the two rules agree; the change bites only where the
estimate is noisy, which is precisely where a veto was never evidence of anything.

What it is **not**: `minCell` is not raised, the 0.02 slack is not widened, and no cell
is exempted. The same number is used; only the question asked of it changes, from *is
the point estimate above it* to *is the degradation above it beyond this cell's noise*.

## 4. The stopping rule

**If the restructured gate fails, that is the answer and it gets reported as one.**
There is no v3. The rule is not touched again, whatever the result, and no rates are
written.

## 5. Verification required before this rule may decide anything

- Unit tests that pin every branch of 2.4 against hand-built cells: a cell with a
  large real degradation still fails; a cell with a noisy estimate above 0.02 but a
  straddling interval passes; a cell below 10 rows takes the v1 path; and the
  calibration condition is unaffected.
- A test that G2-v1's behaviour is reproduced exactly when the bootstrap is disabled,
  so the diff is provably confined to the one condition.
