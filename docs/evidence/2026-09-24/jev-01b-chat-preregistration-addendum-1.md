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
isotonic does so most, so the weight fitted on it can pay a noise arm for fit
it does not have. Measured on the RED fixture for the spec's item 3 (a noise
arm beside an exactly-right incumbent, 400 units,
`test/jev-01b-calibrate.test.js`): weight 0.025 fitted on in-sample isotonic
output, 0 fitted out-of-fold. Both are under the 0.05 floor on that fixture,
so the test passes either way; the change is for real data, where the
difference is not known in advance.

Nothing else changes: units, outcomes, incumbents, floors, the 70/30 time
split and the decision rule are as pre-registered.
