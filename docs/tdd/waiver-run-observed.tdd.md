# The next waiver run comes from a real time before a guess (RL-16-2)

`nextWaiverRun()` read `acquisitionSettings.waiverProcessHour` as an hour in US
Eastern and nothing else. On the local copy that named the wrong run on 9 of 9
checked claims: 8 about 7-8 hours late, 1 on the wrong day
(WORK-QUEUE.md row RL-16-2; BROKEN-NUMBERS.md row N). No pipeline stored a real
run time, so the fix is new capture plus a new order of sources.

## Order of sources

1. `espn_scheduled`: `payload.status.waiverNextExecutionDate` (epoch ms), when it
   is still ahead of `now`.
2. `observed`: the league's past runs. Weekdays a run was seen on are the only
   candidates, each at the clock time of its latest run on that weekday. A day
   the settings list but the league never ran on is not named, and is returned
   in `settings_days_never_observed` so the disagreement is visible.
3. `unconfirmed_guess`: the old settings reading, unchanged, with
   `confirmed: false` and a `label` that says it failed 9 of 9.

Every result carries `basis`, `confirmed`, `label` and `at` (the exact instant).
`command-center.js#waiverDeadline` now prefers `at` and flags `confirmed: false`
as a guess; `WaiverWire.tsx#runLabel` prints the clock time and the label.

## Capture

- `server/migrations/081_league_waiver_runs.js`: one new table, append-only.
- `routes/leagues.js#syncEspnLeague` adds `view=mTransactions2` to the one sync
  request and calls `waiver-runs.js#recordWaiverRuns`: the `processDate` of every
  `EXECUTED` `WAIVER` transaction, plus `status.waiverLastExecutionDate`. The
  transactions list is not kept in `leagues.payload`. Skipped when the sync fell
  back to last season. A capture failure does not fail the roster sync: it is
  logged and returned as `waiver_runs_error`, and the next run falls back to the
  labelled guess.
- `waiver-runs.js#observedWaiverRuns` also reads
  `league_transactions_raw.processed_at` (same filter) when the collector has
  created that table.
- Claims more than 30 minutes apart are separate runs (`RUN_GAP_MS`).

## RED -> GREEN

`test/waiver-run-observed.test.js`, commit `3f8d968` (RED): 6 of 6 failed.

| test | RED | GREEN |
|---|---|---|
| RED 1: observed runs -> observed time (Wed 2026-10-07 03:32 ET), not hour 11 | fail (`basis` undefined, hour 11) | pass |
| RED 2: no runs, no schedule -> guess labelled `unconfirmed` | fail (no `basis`/`label`) | pass |
| RED 3: Sunday, settings list MONDAY, history has none -> Wednesday | fail (named MONDAY) | pass |
| ESPN scheduled wins; a past scheduled time falls through | fail | pass |
| sync response -> league_waiver_runs, failed/free-agent rows excluded, idempotent | fail (module missing) | pass |
| league_transactions_raw rows merged and clustered | fail (module missing) | pass |

## Not confirmed

- `status.waiverNextExecutionDate` and `status.waiverLastExecutionDate` are the
  field names this code expects on ESPN's league `status`; no stored payload in
  this repository shows them. If either is absent the tier is inert and the next
  one is used.
- The 9/9 baseline was measured on the local database, which this cloud session
  does not have; the after-number on those 9 claims is not re-measured here.
