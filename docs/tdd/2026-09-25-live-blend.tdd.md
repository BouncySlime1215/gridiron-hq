# LIVE-BLEND — pre-registration (2026-09-25)

Scope: coordinator comment on #384 (2026-09-25 01:23 UTC), Nick's decision of 2026-09-24
("this will never be good if we don't put it live"). Builds on PYES-ONE (#384, `server/services/p-yes.js`),
the one P(yes) module. This record is written before the code.

## What changes

- Served P(yes) = w_baseline x (E1 activity baseline) + w_clone x (CLONE-01a/b band), per offer.
- Weights: Bayesian model averaging on log loss (exponential weights, eta = 1) over every settled
  offer in all 5 leagues, graded in the order answers became known, each offer carrying its as-of
  predictions from the E1 grader (`eval/e1-league.js#scoreAsOf`, `eval/e1.js#activityBaseline`).
  Clone prior 0.25. Clamp [0.05, 0.95]. Per-league shrinkage lambda = n / (n + 20) toward the pool.
- Default ON: `GRIDIRON_PYES_BLEND` unset = blend; `=0` = baseline only. No decided offer = the
  clone band (fail closed, #384 finding 2).
- Nick's hard rules read `p_gate` (the baseline p), never the blend: the confirm-dice "beats doing
  nothing" verdict (`planner.js#confirmGate`) and the all-in completion floor (`modes.js#gateComplete`).
  Every other rule (overpay cap, untouchables, never-give, floor, buy-backs) reads no p at all.
- plans.json: new optional section `p_yes_basis` (per model weight, prior, n, log loss, wins/losses
  vs baseline). New source id `blend.accept`.
- Probes: `probeEIG` (mutual information between the answer and the model, nats) on every step,
  shadow; a tie-breaker in `rankPlans` only with `GRIDIRON_PYES_PROBES=1`.
- ACTIVITY-01 (#334) is not on main, so its intensity term is not blended; the summary says so.

## Metrics and bars

1. **Served metric (needs local measurement).** Forward-only log loss of the blend vs the activity
   baseline over every settled offer, 5 leagues (`p-yes-blend.js#prequential`): each offer is
   scored with the weights as they stood when it was proposed. Per-offer gain = baseline log loss -
   blend log loss, with E1's 95% anytime-valid confidence sequence.
   - PASS: mean gain >= 0 and CS lower bound > -0.01 (E1 MIN_GAIN: not worse than coin-flip level).
   - FAIL: CS upper bound < 0 (the blend loses to the baseline at any n). Then set
     `GRIDIRON_PYES_BLEND=0` on the Mac and report.
   - Otherwise NOT DECIDED: stays on (Nick's call), reported with n and the CI every week.
2. **Hard rules outside the model (tests).** Under blends that disagree hard (w = 1, 0.95, 0.7,
   0.05), the set of planned moves, the overpay sink, every mode's kept/dropped plans with their
   reasons, the untouchables, and the confirm gate number of each shared deck plan are identical;
   the shown P(yes) differs. Fails if any differs.
3. **Weights behave as specified (tests).** Prior 0.25 with no data; one offer = hand-computed Bayes
   update; clamp holds after 200 one-sided offers; weights do not move with time or with answers
   after `now`, and do move with one new settled offer; lambda = n / (n + 20).
4. **Ledger safe (test).** The served acceptance keeps the clone band and basis on `challenger`,
   which `trade-outcomes.js#predictionOf` logs (migration 067 CHECK).

## What would fail it

Any rule outcome that changes with the weights; weights that move without a newly graded offer;
a served 0.5 with no data; `validateLeague` rejecting an entry with `p_yes_basis`; or the Mac run
showing the blend's CS wholly below 0.
