# HEALTH-01b + HEALTH-01c: fallback never fake, and Coach reads health

Units HEALTH-01b and HEALTH-01c (ENGINE-SPECS.md, section HEALTH-01; folded into EA-03 / EA-10
by the architecture rows). Built on PR #216's branch (`claude/local-engine-00a-engine-spine`,
tip 4eb6caa), which carries HEALTH-01a (checks in `writeState`, failed rows never served by
`getState`). Not statistical: no model, no model number, no holdout read.

## 1. Audit: extend or build

| Question | Where | Result |
|---|---|---|
| Is there a served reader with fallback? | `server/routes/engine.js` | Only the monitor fallback (`engine_fallback`, set by `setFallback`). A failed row silently fell back to the last good row with no label; a declared `fallbackField` was stored in `engine_fields` and never read. |
| Does Coach read the engine? | `server/services/coach/tools.js`, `catalog.js` | No. `engine_state` is not in the catalog, so `sql_select` cannot reach it. No engine tool existed. |
| What did a thrown tool error do? | `ask.js#runOne` | Re-thrown: `askCoach` rejected, the route answered 500 (an HTML error page in the RED run). |
| Migration needed? | | No. Health lives in `engine_state.health` (JSON) and `engine_fields.fallback_field`, both from 075. No new migration number used. |

Decision: **extend**. One reader (`readServed`) in `engine/state.js`, used by the route and by
a new Coach tool `engine_read`; two violations in `verify.js`; the fault path in `ask.js`.

## 2. RED / GREEN

All runs: `GRIDIRON_DB_PATH=$(mktemp -u).sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 test/engine-health-fallback.test.js test/coach-health.test.js`

| Step | Commit | Result |
|---|---|---|
| RED | 9d82193 `test: RED for HEALTH-01b fallback reader and HEALTH-01c Coach health checks` | 11 tests, 0 pass, 11 fail. c1 fails on the real bug: the refusal echoed the failed number, `"Coach could not trace one number (137) back to anything it retrieved..."`. c3 fails with `Unexpected token '<', "<!DOCTYPE "...` (a 500 page). b1-b5 fail on `readServed` missing; b6 on `the engine route does not serve through readServed`. |
| GREEN | the `feat:` commit after 9d82193 | 11 / 11 pass; engine-spine + all coach suites 210 / 210; full `npm test` 4828 tests, 0 fail |

Changed alongside GREEN, and why:
- `test/coach-ask.test.js` "a fault that is not a refusal ends the question": it pinned the
  old contract (the question rejects). HEALTH-01c replaces that contract with "a plain
  'I couldn't check X because Y', HTTP 200". The test's reason is kept intact: the model is
  still not asked to carry on past a real fault (`client.sent.length === 1`), and no claim
  ships. Only the rejection became an answer with the refusal and a `tool_error` trace event.
- `test/coach-health.test.js` c3 tightened after RED to pin the same thing: one model call,
  no claims.

## 3. RED rows, as built

| Spec row | Test |
|---|---|
| 01b: failed field -> reader serves fallback, `fallback_used=true`, reason | b1 (declared fallbackField), b2 (last good row), b3 (nothing healthy: value null, status `failed`), b4 (degraded) |
| 01b: no page renders a failed value | b5: the route's whole JSON body never contains the failed value (check details are stripped from the served health; the audit copy stays in `engine_state`). b6: grep over `client/src` (any file calling `/api/engine/` must read `fallback_used` and never ask for failed rows; today no client file calls it) and over `server/routes` (no raw `FROM engine_state`, no `includeFailed: true`; the engine route uses `readServed`). |
| 01c: failed field -> no digit from the failed row, reason named | c1 |
| 01c: degraded -> answer names the fallback | c2 (first draft states 0.51 bare -> `degraded_unstated`, retried; shipped claim names `test.ch_market`) |
| 01c: thrown tool error -> plain explanation, HTTP 200 | c3 |
| 01c: HEALTH_MISSING / DEGRADED_UNSTATED | `verify:` unit test |
| 01c: as-of + "checks passed" line | "a healthy engine number ships with..." |

## 4. Limits

- `answer.health` (the as-of and checks line) is written by `ask.js`, not by the model, so it
  cannot be wrong; `HEALTH_MISSING` therefore fires on an engine cell recorded without health
  (any `engine_*` table reached another way) or an answer object built without the line.
- `DEGRADED_UNSTATED` is a word test (`fallback|degraded|failed|last good|stale|stand-in`, or
  the fallback field's name). A claim can pass it while phrasing the caveat badly.
- The UI health chip (UI-ENG-6 / EA-03) is not built here; no client file reads the engine yet.

## 5. FIX-250-1: one fallback reader (PR sweep, 2026-09-24)

ENGINE-SPECS.md:653 folds HEALTH-01b into EA-03, so the one reader is #257's
`server/services/engine/views.js`. #257's branch (`claude/cloud-ea-04-hprk33`, `ccb1de3`) is
merged into this branch (`494146f`); this PR now carries #257 and must land with it or after it.

| Step | Commit | Result |
|---|---|---|
| RED | `8721234` `test: RED for FIX-250-1` | engine-health-fallback 6 of 10 fail (`engine/views.js#readServed does not exist`, and the one-reader grep), engine-views RED (3) and (5) fail (`'unknown'` vs `'failed'`, `failed` not in `ROW_STATUSES`) |
| GREEN | the `fix:` commit after it | engine-* + coach-* 244 / 244; lint, typecheck, check:wiring exit 0 |

What moved:
- `views.js#healthServe` is the one HEALTH-01b rule. `resolveRow` (a snapshot's cut and
  versions) and the new `views.js#readServed` (as of a time: `/api/engine/state`, Coach
  `engine_read`) both call it with their own row fetch. `state.js#readServed` is deleted;
  `state.js` keeps the raw `getState`, whose `okOnly` became `healthyOnly` (neither failed
  nor degraded).
- The monitor fallback for `/state` moved out of the route into `readServed`.
- One set of words for both reads: `fallback` (declared field), `last_good` ("last good, N
  min old"), `degraded` (nothing healthy, labelled), `failed` (nothing healthy, no value).
  `failed` joins `ROW_STATUSES` and the client's `EngineStatusWord`.
- `health` is always the served row's; the field's own failed/degraded row is reported as
  `problem: {status, failed_checks, state_id}`. So no response hands out a failed health.

Test edits, and why each is a contract change rather than a weakened test:
- b1: `s.health.status === 'failed'` became `s.problem.status === 'failed'` plus
  `s.health.status === 'ok'`. #257 RED (3) pins that no served row carries a failed health;
  the two could not both hold, and the stricter one wins.
- b2: `status 'fallback'` became `'last_good'`, the word `/view` and `EngineValue` already use.
- engine-views RED (3): the failed-with-nothing row is `'failed'` (was `'unknown'`), #250's
  guarantee. RED (5): `ROW_STATUSES` gains `failed`.
- b6: client files are grepped with comments stripped. `EngineStatusStrip.tsx` names
  `/api/engine/status` in its header comment and reads no engine value.
- Behaviour change on `/view`: a *degraded* row now gets a stand-in like a failed one (the
  HEALTH-01b row: "degraded/failed fields serve the fallback, labelled"). Before, `/view`
  served it as itself with status `degraded`.
