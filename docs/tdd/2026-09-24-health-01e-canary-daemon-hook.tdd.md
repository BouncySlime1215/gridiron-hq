# HEALTH-01e sweep fixes: canary on the daemon's morning hook (FIX-256-1, FIX-256-2)

RED `b60abd42` "test: canary is the daemon's morning hook; error alerts reach a status row and a push; loop back to audit order (RED)" ·
GREEN `fcca5b46` "fix: run the Coach canary as the engine daemon's morning hook and route errors to a status row and a push" ·
`test/coach-canary.test.js`, `test/refresh-loop-steps.test.js`.

## FIX-256-1: out of the refresh loop, into the daemon

The spec (ENGINE-SPECS HEALTH-01e) says the canary runs "each morning by the
engine daemon". This PR had put it in `scripts/refresh-live-data.mjs` as step 8.

- `scripts/refresh-live-data.mjs` and `test/refresh-loop-steps.test.js` are back
  to `main`'s version (INTEGRATION-AUDIT-0923 §2 order: jobs → league_tx →
  roster_snapshots → league_chat → manager_signals → number_audit → brain_report
  → warroom_plans). A new test pins that order from the tick's log lines. It also
  checks that no spawn names `coach-canary`, and that the loop source never
  mentions the canary.
- `scripts/engine-daemon.mjs` `registerCoachCanaryHook` registers
  `coach-canary.mjs --hook` on the hook runner's `nightly` schedule. That schedule
  fires on the first tick after 03:00 America/New_York, once per local day
  (`hooks.js nightlyDue`). The lease is 20 min, longer than the child's own
  15 min timeout.
- Once-a-day guard kept: `--hook` returns status `fresh` before any key, budget
  or child while the last `sync_log 'coach_canary'` row is under 20 h old.
- Cost cap kept: `runLive` still caps at min(`CANARY_MAX_USD` = $0.15, what is
  left of today's Coach budget).
- The hook child writes nothing (role `engine-child`). It prints the verdict. The
  daemon's `onResult` (`recordCanaryResult`) records sync_log, the spend, and the
  status row.

## FIX-256-2: an error reaches the user

On status `error`, `recordCanaryResult`:

- writes **one engine status row**: `engine_runs`, producer `coach-canary`,
  scope `health`, `error` = the summary. An `ok` run writes the same row with
  `error` NULL, so the status line clears.
- makes **one push** through PUSH-01's sender (#293,
  `server/services/campaign/push-alerts.js` `defaultSender`). Until #293 merges,
  that module does not exist. `pushSender` then returns
  `{ send: null, why: 'PUSH-01 sender (#293) is not merged yet' }`, and the
  sync_log detail says so. Any other import error throws.
- **carries no chat text.** The status row and the push name question ids and
  failure kinds only (`G03 drift`). A failure's `reason` quotes Coach's answer,
  so it stays in sync_log.

Test (the real hook runner, a real dry-run verdict with G03 made wrong): one
status row matching `G03 drift` and one push call. Neither contains the failure
reason, the number Coach quoted, or "could not trace". Control: the reason does
quote a number.

## RED (tests at b60abd42, source at a45d6177)

```
refresh-loop-steps: not ok 1 (old order test, canary still spawned), not ok 2 (audit order) — 21/23
coach-canary: not ok 13-18 (runLive, registerCoachCanaryHook, recordCanaryResult, pushSender missing) — 12/18
```

## GREEN (fcca5b46)

refresh-loop-steps 23/0, coach-canary 18/0, engine-daemon 17/0,
chaos-drills 8 pass / 7 todo (unchanged). `npm run lint` clean,
`npm run check:wiring` exit 0.

## Not done: FIX-256-3

It is conditional on #216 and #250 (HEALTH-01a-c) merging. #216 landed through
#278. #250 is still open, so the 7 pending drill tests keep their `todo` flag.
