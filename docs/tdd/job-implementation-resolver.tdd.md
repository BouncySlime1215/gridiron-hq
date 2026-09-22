# 53 of 62 jobs said their implementing module was unresolved

RED `f4a9c8b`-series (three waves on this branch) · GREEN this commit · `scripts/wiring-map.mjs`, `scripts/inventory.mjs` (no change needed), `test/scheduler-job-modules.test.js`, `test/wiring-map.test.js`

## What was wrong

`schedulerJobs` filled `runModule` from one thing only: a dynamic
`import('…')` written INSIDE the job's own entry in the `JOBS` object. The
count of jobs written that way in this repository is **eight**. The other
fifty-four fell through to `null`, and the inventory printed

> tier growth; implementing module unresolved by the map

for each of them — a sentence about the code that was really a sentence about
the map. The same shape as `imported-by-nothing` being read as "unused", and
the third time this branch has caught it.

What is actually there, at `server/services/scheduler.js:1165`:

```js
async function refreshEspnDepthChart() {
  const { syncDepthChart } = await import('../routes/nfldata.js');
  return syncDepthChart();
}
…
espn_depth_chart: { run: refreshEspnDepthChart, … }
```

The job names a function defined in the scheduler, and that function holds the
import. The map was looking one level too shallow.

## Four ways work leaves the scheduler, and the order between them

| route | count | what it looks like |
| --- | --- | --- |
| `inline-import` | 8 | the job entry imports directly |
| `local-function` | 52 | `run:` names a local function whose body imports |
| `spawned-script` | 1 | `execFile(process.execPath, [script])` — `manager_archetypes` runs `scripts/build-manager-archetypes.mjs` |
| `worker-thread` | 1 | `new Worker(new URL('./report-worker.js'), { workerData: { module: './manager-signals.js' } })` |

`static-import` is a fifth route with no instances today; it is implemented
because `run:` may name an imported function and reading the exported name
instead of the local alias would silently miss it (injection J6).

**The order is the rule.** An import inside the job entry is the job's own
statement of what it runs, so it wins. A spawned child process beats anything
the body imports: `manager_archetypes` imports `node:child_process`,
`node:util`, `node:path` and `../platform/paths.js`, and none of those is the
work — reporting `paths.js` would be a wrong answer in the shape of a right
one. A worker's CARGO beats the worker: `report-worker.js` is a dispatcher, so
naming it tells a reader nothing.

**`local-body` is a real answer, not a failure.** A run function that imports
nothing does the work here, and the row says so with the scheduler as the
module. Only a `run:` name that matches nothing at all stays `null`.

**One local call is followed, two stop the walk.** `refreshManagerSignals`
holds no import, no spawn and no Worker: it awaits
`refreshManagerSignalsOffThread()` and shapes the result for a `sync_log` row.
Following one callee is a fact; choosing between two would be a guess about
which is the work, and a guess is what this rule exists to avoid.

## The defect it uncovered in a shared helper

`bodyRange` took the first `{` after the function name as the body. For

```js
export function refreshManagerSignalsOffThread({ leagueIds = null, timeoutMs = 120_000 } = {}) {
```

that brace is the **parameter object**, which closes immediately — so the
"body" was the signature and nothing else. Every options-bag function in the
repository read as empty, to every caller of `bodyRange`, not just this one.

It now walks the parameter list to its balancing paren first. The cost of that
fix is measured below and it is large.

A second, unrelated `bodyRange` trap was found the same way: it counts braces
on whatever view it is handed, and the production call hands it the `text`
view, where string bodies are intact. `refreshManagerArchetypes` contains
`stdout.indexOf('{')`, so the depth never returned to zero and the range ran
off the end of the file. The resolver now asks for the range on the
strings-blanked view and slices the intact view with it — `scan()` preserves
offsets, which is what makes that legal.

## Effect

All 62 jobs resolve. Every job row in the inventory now names a real
implementing module: `job:beat-the-close` reads *tier metered; implemented by
`server/services/beat-the-close.js`*, where it read *unresolved* before.

Their **status** is unchanged and deliberately so: a job is `unclassified`
until something shows it writes real rows, and that needs a run, not static
analysis. 880 rows, status counts identical.

The `bodyRange` fix is the larger change. `composed-key-never-read` went
**22 → 82**: sixty composed keys were invisible because the functions
returning them take options bags, so their bodies read as empty. Four of the
sixty were verified by hand — `ats_vs_closing_line`
(`nfl-drive-sim.js:1580`), `beat_close_rate` (`clv-core.js:409`),
`book_limit_units` (`nfl-execution-replay.js:120`) and
`availability_assumptions` (`nfl-execution-replay.js:181`, read only by its
own test). Findings 2388 → 2449, annotated both sides.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/wiring-map.mjs`.
Baseline green `84d6df26609fefbf`: 13 pass / 0 fail on
`test/scheduler-job-modules.test.js`, 90 pass / 0 fail on
`test/wiring-map.test.js`.

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| J1 | drop the parameter-list walk in `bodyRange` | `0c92ae9639dcdc67` | KILLED 12/1 | *every job in the real scheduler resolves to something* |
| J2 | ask `bodyRange` for the range on the intact view | `21f5f5644b2d4807` | KILLED 11/2 | *a brace inside a string does not swallow the run function body* |
| J3 | drop the spawned-script route | `ff07a6ed2a540485` | KILLED 11/2 | *a job that spawns a script resolves to the script, not to a path helper* |
| J4 | drop the worker cargo, keep the dispatcher | `aae1827ffe502e3f` | KILLED 10/3 | *a job that hands work to a worker thread resolves to the module the worker loads* |
| J5 | follow a local call even when there are several | `da5998057ee3b341` | KILLED 12/1 | *two local calls stop the hop rather than picking one* |
| J6 | read the imported name instead of the local alias | `8e515aa012012a98` | KILLED 12/1 | *an aliased import resolves under the LOCAL name, which is what run: writes* |
| J7 | let the inline-import route lose to the others | `89de498a7ae95eff` | KILLED 11/2 | *an import written inside the job entry still wins* |
| J8 | control, one word of the doc comment | `e112053ad3a19ba8` | SURVIVED 13/0 | — |

Against `test/wiring-map.test.js`, for the `bodyRange` fix itself:

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| B1 | drop the parameter-list walk | `0c92ae9639dcdc67` | KILLED 88/2 | *bodyRange skips a destructured parameter list*; *…walks the whole parameter list* |
| B2 | stop at the first `)` instead of the balancing one | `b856de72c0fcadf5` | **SURVIVED 89/0**, then KILLED 89/1 | *bodyRange walks the whole parameter list, not to the first close paren* |
| B3 | control, one word of the comment | `53f0de39bb8510bc` | SURVIVED 90/0 | — |

**B2 is the row worth reading.** It survived, which is a finding about the
TEST: the first fixture's signature holds no nested parens, so stopping early
and stopping correctly land in the same place. A default that calls something
— `function withCall(a = fn(), { b } = {})` — separates them, and the next
`{` after the first `)` is the destructured parameter rather than the body. A
test was added for that shape and B2 was re-run against it.

## The five questions

**Well built?** One resolver, five routes with a stated precedence, each a
test; and the helper defect it uncovered fixed separately with its own tests
rather than worked around at the call site.

**Stats or made up?** Measured. 62 jobs: 8 inline, 52 local-function, 1
spawned script, 1 worker cargo, 0 unresolved, from 53 unresolved before.
`composed-key-never-read` 22 → 82 with four of the sixty new ones verified by
hand. Findings 2388 → 2449. 880 inventory rows, status counts unchanged.

**How do we know?** `node --test test/scheduler-job-modules.test.js` 13/0,
`test/wiring-map.test.js` 90/0. Eight injections killed with the killing test
named, two controls, and one survivor recorded as a gap in the test and then
closed.

**Pointed anywhere else on the platform?** Yes, and that is the larger half.
`bodyRange` is used by the composed-key rule, the function-unit and
function-reach passes. Every one of them was blind inside any function taking
an options bag, which is most of this repository's service layer.

**How does it unify?** An inventory that answers "what is wired" has to be
able to say what a scheduled job actually runs. Fifty-three rows saying "the
map cannot tell" is the map reporting itself, and a reader cannot act on that.
