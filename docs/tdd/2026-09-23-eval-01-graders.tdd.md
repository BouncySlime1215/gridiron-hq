# EVAL-01: the brain's report card (E1-E7)

RED `ec71f368` · GREEN follows · `test/eval-graders.test.js` (29),
`test/brain-report-rule.test.js` (6), `test/brain-report-store.test.js` (6),
`test/refresh-loop-steps.test.js` (tick order now ends with `run-graders.mjs`).

## What each grader test pins

Every grader gets three seeded fixtures:

| check | known-good control -> passing | planted fault -> failing | threshold -> not_enough_data |
|---|---|---|---|
| E1 | honest informative P(accept), 400 offers | inverted P(accept) | 30 offers -> "needs 20 more offers"; 60 all-declined -> needs accepts |
| E2 | 50% predicted, ~50% accepted at the yes point | 85% accepted where 50% predicted; below-point offers mostly accepted | 12 at-point offers -> "needs 18 more offers" |
| E3 | stored Sleeper replay numbers; live honest odds beat standings-only | a stored negative gain; inverted live odds | 30 team-seasons -> "needs 10 more team-seasons" |
| E4 | planner beats finder and do-nothing | planner loses to finder | no file / 10 rows; a replay that invents accepts is never graded |
| E5 | realized ~ predicted > 0 | predicted 3, realized 1 | 9 rescored steps -> "needs 6 more steps" |
| E6 | following near-tie calls gains | following near-tie calls loses | naive-only gap never passes; 5 weeks -> "needs 3 more weeks" |
| E7 | unbiased luck | "luck" +12 every week (biased expected points) | 2 weeks -> "needs 2 more weeks" |

## Rule

`brainReportRule` is pure. Failing check -> BALANCED + testing tier off. Missing,
stale (> 48 h), future-dated or grader-errored report -> same (fail closed).
SAFE is never raised. not_enough_data alone never triggers it.
