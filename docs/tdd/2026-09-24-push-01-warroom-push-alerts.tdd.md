# PUSH-01: a push when the War Room's next move changes (2026-09-24)

Source: NORTH-STAR-PLAN row 7 and ENGINE-SPECS CAMPAIGN-01c (branch
`claude/handoff-package-2026-09-22`, `docs/handoff/local/`). Built on the head of
#272 (`claude/cloud-fix-03` d7736fe), which already holds #233 (the producer) and
#238 (the contract); neither producer PR is on `main` yet.

## 0. Audit (extend or build)

- **Existing notification path: none.** `git grep` across `server/`, `scripts/`,
  `mac/` and `client/src` on `main` and on every open-PR head for
  push/notify/ntfy/pushover/osascript/serviceWorker/Notification finds no sender.
  HEALTH-01e's "push to Nick" (#256) is a `sync_log` row, not a push.
- **The row's cause:** the producer already diffed next moves, then wrote them to
  `pushes.jsonl` (`scripts/campaign/produce-plans.mjs:216-218` on #272), and no
  file in the repo reads `pushes.jsonl`. A change was computed and dropped.
- **A second cause:** the diff compared against the previous plans file
  (`produce-plans.mjs:132`, `diffNextMove(prev?._run ?? null, …)`). A league whose
  previous run failed has no `_run`, so its recovery read as "first plan for this
  league" and was flagged as a change. Feasibility was never compared at all.
- Decision: **build** the smallest sender (ntfy topic URL, or a macOS banner) and
  a state-based diff in the app DB (migration 091), called from the producer.

## 1. Tests (RED first)

`test/push-01-warroom-push-alerts.test.js` (16 tests). RED, commit `e117fe3`:

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/services/campaign/push-alerts.js'
# pass 0
# fail 1
```

## 2. GREEN

- `server/migrations/091_warroom_push_alerts.js`: `warroom_push_state`
  (seen / announced value per league and kind) and `warroom_push_alerts` (outbox;
  a partial unique index keeps one queued alert per league and kind). Additive.
- `server/services/campaign/push-alerts.js`: `observedValues` (move_id or 'none';
  feasibility status), `recordRun` (baseline, supersede, queue), `dispatch`
  (quiet hours 1:00-7:59 AM America/New_York, one message per league, 3 attempts),
  `defaultSender`, `runPushAlerts` (flag, inert check, summary line).
- `scripts/campaign/produce-plans.mjs`: `pushesOf` and the `pushes.jsonl` append
  removed; `runPushAlerts` called after the plans file is renamed into place; its
  result goes on the `warroom_plans` summary line the refresh loop records in
  `sync_log`.

GREEN, commit `bd92d57e`. The five suites the change touches:

```
# pass 80
# fail 0
```

## 3. What the tests pin

| # | Behaviour |
|---|-----------|
| 1 | 091 is additive and idempotent; at most one queued alert per league and kind (UNIQUE) |
| 2 | first run baselines, pushes nothing |
| 3 | a changed `move_id` pushes once; a repeat run pushes nothing |
| 4 | "no move clears the bar" is a change; a failed league is not, nor is recovery to the same move |
| 5 | feasibility reachable -> out_of_reach pushes once |
| 6 | a move and a feasibility change in one run are one push |
| 7 | quiet hours (EDT and EST edges); night changes collapse to the one standing at 8 AM |
| 8 | a move that flips back before delivery sends nothing; after a sent push, moving back is news again |
| 9 | a failed send is retried and marked failed after 3, with its error |
| 10 | no channel: alert stays queued, summary says why |
| 11 | off by default; preview mode turns it on and labels the text; flag=0 vetoes preview |
| 12 | 091 missing reports INERT |
| 13 | no manager names in the push text |
| 14 | the producer calls `runPushAlerts` and no longer writes `pushes.jsonl` |
| 15 | sender selection |

## 4. Liveness: mutation sweep

Script: each mutant applied to the working tree, `test/push-01-warroom-push-alerts.test.js`
run, file restored. Unit mutants (M), call-site and migration mutants (C), and two
designed controls.

| Mutant | Result |
|---|---|
| M1 quiet end `h < 8` -> `h <= 8` | killed |
| M2 quiet start `h >= 1` -> `h > 1` | killed |
| M3 drop the flip-back check | killed |
| M4 drop the supersede | killed |
| M5 first sighting pushes | killed |
| M6 quiet hours ignored | killed |
| M7 announced value not updated on send | **survived** on the first sweep; test "after a push is sent, moving back…" added; now killed |
| M8 no retry cap | killed |
| M9 'no move' not watched | killed |
| M10 feasibility not watched | killed |
| M11 preview text not labelled | killed |
| M12 flag=0 does not veto preview | killed |
| M13 one message per alert, not per league | killed |
| M14 inert check skipped | killed |
| C1 producer passes `{ env: {} }` | killed |
| C2 producer skips the call | killed |
| C3 migration without the one-queued UNIQUE index | **survived** on the first sweep; UNIQUE assertion added to test 1; now killed |
| CTRL surviving: ntfy `Title` header text | survived (by design: cosmetic, untested) |
| CTRL not applied: absent pattern | not applied (sweep reports it, does not count it) |

## 5. Guard run (tree `763db19b`, GREEN head `bd92d57e`)

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run start:smoke`: exit 0.
  Tests 4868, pass 4825, fail 0, skipped 43. `git write-tree` identical before and after.
- `npm run check:wiring`: exit 1, 15 `module-reaches-no-surface` findings under
  `server/services/campaign/`. 14 are on the base (#272 head `d7736fe`, same command,
  same 14 lines); `push-alerts.js` is the 15th, same class. Cause, on the base:
  `scripts/refresh-live-data.mjs:219` launches the producer with
  `launch(process.execPath, [..., 'scripts/campaign/produce-plans.mjs'])`, which
  `scripts/wiring-map.mjs:1010-1011` (`entryPointScripts`) does not match, so the
  producer is not a root. Reported, not edited: neither file is this unit's.
