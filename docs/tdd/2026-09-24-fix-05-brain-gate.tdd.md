# FIX-05: the brain report and number health feed the plan

RED `0af6ba0` · GREEN follows · `test/campaign-brain-gate.test.js` (12).
Spec: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` section 8 (FIX-05), rows D6,
P14 and P15. Coordinator ruling: a missing, stale (>48 h) or errored report
forces BALANCED; SAFE is never raised.

## RED

The module `server/services/campaign/brain-gate.js` was a stub whose four exports
threw `not built yet (FIX-05 RED)`. 12/12 failed: 10 on the stub, 1 on
`view.brain_report` missing (the view still wrote the hard-coded `brain_check`
placeholder), and 1 on the producer source never calling the gate.

## What each test pins

| test | pins |
|---|---|
| all_in + failing E1 | effective mode `balanced`, Balanced's own sliders, testing tier off, `fell_back_to: 'balanced'`, `overall: 'failing'`, a block naming E1 and a block naming both modes; the section passes #238's `brainReport` validator |
| safe + failing | stays `safe`, no `fell_back_to` |
| missing report | `all_in` and `balanced` both -> `balanced`; E1-E7 shown as `not_run` |
| not_enough_data alone | each requested mode kept; all_in keeps its testing tier; `needs_text` is each check's `result` |
| stale / errored / grader error | fail closed to balanced; the reason is in `blocks`; a stale all-passing card is not `passing` overall |
| unchanged mode | the request's own tolerances are kept |
| readBrainReport | latest run from a real `brain_report` table (078); a missing table is an `error`, not a silent null |
| readNumberHealth | league-scoped rows worst first, no raw values; missing table / no rows -> `unknown` with reason; a throw -> `failed` |
| the entry | `destination.risk_mode` and the active `risk_modes` row are the effective mode; `brain_report` and `number_health` filled |
| same dice | all_in + failing plans exactly what balanced plans; all_in with no block still plans all_in |
| no brain read | `unknown` with a reason, never a placeholder result |
| producer wiring | `applyBrainReport` runs before `planLeague`; `brain_check` is gone |

## GREEN

Implementation fixed; one test assertion was wrong and changed. It looked for
"all in" in the fallback block, but the mode's display label is
`MODE_LABELS.all_in` ("Fuck it, let's go"). The test now checks both labels
from `MODE_LABELS`.

Targeted suites after GREEN: `campaign-brain-gate`, `campaign-producer`,
`refresh-loop-steps`, `brain-report-rule`, `brain-report-store`,
`eval-graders`, `number-audit`, `number-audit-collect`,
`warroom-plans-contract`: 123 pass, 0 fail.
