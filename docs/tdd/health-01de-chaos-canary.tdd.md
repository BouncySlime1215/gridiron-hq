# HEALTH-01d chaos drills and HEALTH-01e Coach canary

RED `00ba016` (test: RED for HEALTH-01d chaos drills and HEALTH-01e Coach canary) · GREEN `97b0d4a` · `test/chaos-drills.test.js` (15 cases: 8 baseline, 7 pending),
`test/coach-canary.test.js` (14 cases), `test/refresh-loop-steps.test.js` (1 changed expectation).

Spec: `ENGINE-SPECS.md` §HEALTH-01, rows d and e (branch `claude/handoff-package-2026-09-22`).

## What main has, and what it does not

HEALTH-01d depends on HEALTH-01a–c. None of them is on main:
`server/services/engine/` does not exist (it arrives with #216 / EA-00), and
`coach/verify.js` has no `HEALTH_MISSING` or `DEGRADED_UNSTATED`. So the drills
are written in two kinds:

- **Baseline** tests pin today's behaviour. They pass. They are the floor: a
  change that makes one of these faults silent fails them.
- **Pending** tests (`{ todo: '<reason>' }`) state the HEALTH-01 target as a real
  assertion. They run and fail today; node:test reports them as TODO. Each
  reason names the missing unit. Dropping `todo` turns them into gates.

| Drill | Baseline (passes today) | Pending (TODO until) |
|---|---|---|
| 1 ESPN feed stale | `allSources()` marks `espn_players` stale, confidence decays to 0.2–1; Coach still answers, verified | engine health "stale" + labelled fallback (01a/b); `DEGRADED_UNSTATED` (01c) |
| 2 shares sum 1.3 | Coach answers HTTP 200, and ships the 0.6 unflagged: nothing checks the invariant | write marked failed, last good served (01a); Coach declines the number (01c) |
| 3 sim throws | `/simulate` returns 500 with the reason, no half-built body; Coach unaffected; a throwing Coach tool ends the stream with an `error` event naming the fault | `fallback_used: true` (01b); tool fault becomes "I couldn't check X", HTTP 200 (01c) |
| 4 AI gateway timeout | Coach returns 500 `Request timed out.` and releases its budget hold; no route imports the Vercel AI gateway (`ai`), so a Jev timeout cannot reach a page | Coach answers 200 with a plain explanation (01c) |

## RED

Run in a clean worktree of `main` @ `12a6de9` with only the three test files added:

- `coach-canary.test.js`: `ERR_MODULE_NOT_FOUND scripts/lib/coach-canary-golden.mjs` — 0 pass, 1 fail.
- `chaos-drills.test.js`: same missing module (the drills reuse the canary fixture) — 0 pass, 1 fail.
- `refresh-loop-steps.test.js`: 19 pass, 1 fail — the tick does not spawn `coach-canary.mjs`.

## GREEN

- `chaos-drills.test.js`: 8 pass, 0 fail, 7 todo.
- `coach-canary.test.js`: 14 pass, 0 fail.
- `refresh-loop-steps.test.js`: 20 pass, 0 fail.
- `node scripts/coach-canary.mjs --dry-run`: 12/12, exit 0.
- `node scripts/coach-canary.mjs --dry-run --inject-wrong G03`: status `error`, failure G03 drift, exit 1.

## Canary design, briefly

- The fixture league is invented (`Fixture Alphas`, five `Fixture …` players,
  three weeks, one injury, one league row). Golden answers are facts about that
  file, so a failure is Coach drifting, not the season moving.
- Coach runs against a throwaway fixture DB. Only the verdict (`sync_log
  'coach_canary'`: ok / error = the alert / partial / skipped) and the spend
  (`ai_usage` under `coach:canary`, inside the Coach budget) reach the real DB.
- Cost guard: allowance = min(`CANARY_MAX_USD`, Coach budget left today), set as
  the fixture DB's Coach budget, so the app's own `reserveBudget` enforces it.
  A budget stop is `partial`, not drift. Questions start at a daily-rotating
  offset so a small allowance still covers all twelve across days.
- The refresh loop runs it as step 5, at most once per 20 h, off the web server.

## Flag: the $0.10/day figure

One Coach round reserves up to ~$0.108 before it runs (8,000 output tokens at
$10/M plus the request, from `estimateCallCostUsd`). At $0.10 the first call is
refused and the canary asks nothing. `CANARY_MAX_USD` is $0.15: one to three
questions a day live, all twelve across the rotation. The dry run's upper-bound
estimate for all twelve live is $2.49 (23 calls); real spend will be far below
that, since output is billed as produced. That figure is not measured.
