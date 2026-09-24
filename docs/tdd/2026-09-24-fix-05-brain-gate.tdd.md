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

## Sweep fixes FIX-274-1 / FIX-274-2 (2026-09-24)

- **Base.** `origin/main` is merged in. #236 RL-16-1, #240 RL-19-3 and #241 RL-17-3 are
  on main, and their readers did not exist on this branch before the merge. In the
  conflicts, the plans-schema, contract fixture and contract test from #238's squash are
  byte-identical to FIX-03's pre-squash parent `a1ec7ff8`, so FIX-05's side is kept.
  `refresh-live-data.mjs` keeps FIX-05's side, which already carries main's brain_report step.
- **FIX-274-1, the fallback is real.** When the gate has a blocking check (fell back to
  balanced, or kept safe/balanced with testing-tier off), the producer builds the league's
  adapter and plans it inside `preview-mode.js#withUnconfirmedForwardOff`. Inside it:
  - `trade-horizon.js#playoffImportance` (RL-16-1) reads unmeasured.
  - `title-mutual.js#titleMutualMode` (RL-19-3) reads off.
  - `season-sim.js#rosBasisFlag` (RL-17-3) has its preview path off.

  This holds whatever preview mode or the sites' own default-off flags say. An explicit
  `GRIDIRON_RL17_3_ENABLED=1` stays on, since #241 shipped it as a fix. The gate now runs
  before the adapter is built, because the world reads these sites too.
  `_run.inputs.brain.unconfirmed_off` = `{ applied, sites, switched_off }` records the
  sites that read ON without the gate. It is `null` when no site reader is passed, as in
  the contract fixture.
- **FIX-274-2.** `plans-schema.js` `brain_report.overall` accepts `stale`. For a report
  older than 48 h, or one with no readable timestamp, `brain-gate.js` now emits `stale`
  where it used to emit `not_enough_data`. A failing check still reads `failing`. A report
  47 h old still reads `not_enough_data`.
- **RED** (amended before push): on the pre-fix code, 4 of 15 fail. Test 13 shows the leak:
  all_in + failing E1 with preview on planned partner 2 first (`p_responds` 0.9). Balanced
  with preview off planned partner 3 first (0.65).
- **GREEN**: 15/15 in `campaign-brain-gate.test.js`. The contract fixture was regenerated
  (`node test/fixtures/warroom-contract/make-producer-plans.mjs`), which adds
  `unconfirmed_off` under `_run.inputs.brain` and nothing else. Also run and passing:
  warroom-plans-contract, fix-03-producer-contract, campaign-producer, refresh-loop-steps,
  preview-mode, trade-horizon*, title-mutual* and rl-17-3.
- **Mutants:** (M1) `unconfirmedForwardOff` always false → 2 fail. (M2) trigger on
  `fell_back` instead of any blocking check → 1 fail. This mutant survived until the
  balanced + failing case was added. (M3) the title-mutual guard removed → 2 fail.
  (M4) `stale` ranked above `failing` → 1 fail. All four killed.
- **Not done here:** BrainCheckCard's label for `stale` lives on #231 and #287
  (`client/src/components/warroom/BrainCheckCard.tsx` and `types.ts`), not on this branch.
  The PR comment carries the patch.
