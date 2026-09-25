# PLANS-EXPIRE: kept War Room plans go out of date after 24 h

2026-09-25. Batch D item 3. Off `main` `b9372b8`.

A `--leagues 4` run (the refresh loop's `GRIDIRON_WARROOM_LEAGUES=4`) copies every
other league's previous entry into the new plans file (`mergeKept`). Those kept
entries (leagues 1, 2, 3, 5) are served with the new file's `generated_at`, so a
plan that is days old reads as fresh and its next move stays actionable.

## Pre-registration (written before the GREEN commit)

- **Metric 1 (the rule).** Over plans files built from made-up leagues with a fixed
  clock: the share of entries planned more than 24 h before `now` (or kept with no
  plan time at all) that the War Room view serves with an actionable section
  (any section with `status: 'ok'`).
  **Pass bar:** 0 of N. **Fails it:** any such entry with an `ok` next move, deck,
  flip map, target or stop, or a view with no `plan_out_of_date` block.
- **Metric 2 (no collateral).** Entries planned 24 h ago or less, files with no plan
  times at all (every committed fixture), and every entry with
  `GRIDIRON_PLANS_EXPIRE=0`: the served view is deep-equal to today's view.
  **Pass bar:** 100 %. **Fails it:** any difference other than the pass-through
  `planned_at` head key.
- **Metric 3 (the UI).** A view marked out of date renders "Plan out of date" with
  the reason in both layouts (classic and v2), and no send action ("I sent it",
  "Copy message") for that league. **Pass bar:** both layouts. A fresh view renders
  no such notice.
- **Metric 4 (nightly).** With `GRIDIRON_WARROOM_NIGHTLY_ALL=1` and
  `GRIDIRON_WARROOM_LEAGUES=4`, the loop launches the producer without `--leagues`
  exactly once per local day, on the first tick at or after 03:00 local, and with
  `--leagues 4` on every other tick. Unset, the launch args are byte-identical to
  today's. **Fails it:** a second all-league run the same day, one before 03:00, or
  any change with the variable unset.
- **Served numbers.** None move. Expiry only hides; it never computes a number.
  The contract fixture (`producer-plans.json`) stays byte-identical: `buildPlansFile`
  is unchanged and the plan time is stamped in the producer's `main()` only.

## RED

`c584c39`: `test/plans-expire.test.js` fails with `ERR_MODULE_NOT_FOUND` for
`server/services/campaign/plan-age.js` (1 file, 0 of 1 pass).

## GREEN

`node --test test/plans-expire.test.js`: 17 of 17 pass.

- Metric 1: 0 of N stale entries served with an `ok` section (30 h old; kept with no
  time; kept in a `--leagues 4` merge over a stamped and over a legacy previous file,
  leagues 1, 3, 5, 8). Pass.
- Metric 2: fresh at 0 / 1 / 23.5 / 24 h, every fixture league with no plan times at
  now + 400 days, and `GRIDIRON_PLANS_EXPIRE=0`: deep-equal to the incumbent view. Pass.
- Metric 3: both layouts (classic `WarRoom`, `WarRoomV2`) render "Plan out of date ...
  last planned 30 h ago" through the existing hidden-section reasons, with no
  "I sent it" / "Copy message". A fresh view renders no such text. Pass. (No client file
  changed: Nick's 2026-09-25 rule keeps `warroom/*` for the coordinator's cleanup.)
- Metric 4: nightly all-league launch once per local day at the first tick at or after
  03:00; `--leagues 4` otherwise; unset is byte-identical at 00:05, 03:05, 12:05. Pass.

Test corrections after RED (test facts, not rules): the fixture's league 2 is a failed
planner entry, so the "kept, no time" case uses league 3 and the merge case asserts that
league 2 stays `failed`; the fixture also has a league 8, now in the merge order.
Guard tests updated with this unit: `war-room-view.test.js` import allowlist gains the
pure `plan-age.js`; `warroom-plans-contract.test.js` lists `planned_at` as written by
`main()` only.
