# JEV-01b (chat) pre-registration, addendum 1

Written before any graded run on real data (the first is the `LOCAL:` run on
this PR). It changes how the weight is fitted inside the training units, and
nothing else.

**Change.** The blend weight is fitted on **out-of-fold** calibrated claims:
the training units are split into 5 interleaved folds; each fold's claims are
calibrated by a map fitted on the other four, and the weight minimises log
loss over those out-of-fold values. The served calibration map is still
fitted on every training unit, as before.

**Why.** A map scored on its own fitting points flatters itself, and
isotonic does so most, so a weight fitted on it pays a noise arm for fit it
does not have. Measured on the noise-arm fixture in
`test/jev-01b-calibrate.test.js` (an exactly-right incumbent, claims drawn
uniformly, 70/30 time split), training-set weight in-sample vs out-of-fold:

| units | seed | in-sample | out-of-fold |
|---|---|---|---|
| 300 | 3 | 0.136 | 0.008 |
| 300 | 6 | 0.110 | 0.007 |
| 300 | 4 | 0.163 | 0.084 |
| 400 | 7 | 0.081 | 0.007 |
| 400 | 1 | 0.000 | 0 |

Over 24 fixtures (n = 300 and 400, seeds 1-12) the in-sample weight was over
the 0.05 floor on 11, the out-of-fold weight on 3.

**Also, Platt.** "Platt (logistic on the logit, small ridge)" is fitted on the
smooth logistic loss with a ridge of 1e-3 on the slope, by damped Newton, and
a fit that does not converge throws. Both details were forced by failing
fixtures (the evidence file `docs/tdd/2026-09-24-jev-01b-chat-grader.tdd.md`
has them); neither changes what is being estimated.

Nothing else changes: units, outcomes, incumbents, floors, the 70/30 time
split and the decision rule are as pre-registered.
