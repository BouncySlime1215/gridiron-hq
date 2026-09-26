# DATA QUALITY PANEL: one read of freshness, offer orphans, number-health trend and last-good fallbacks

2026-09-26. Batch D plan item 35. Off `main` `392e585c`. Flag `GRIDIRON_DATA_QUALITY` (off by default).

Item 35 asks for Settings -> Health to show four things: freshness per source, offer orphans, the
number-health trend, and the places a served number is running on a last-good fallback. Three of the
four already have a producer; none of them is on one screen, and the number audit keeps only what is
true now, so there is no trend to show. This unit adds one read-only report (`GET /api/data-quality`)
that composes the existing producers, plus the one missing piece of data: a daily count row per league
written next to the number audit.

| Section | Producer it reads (never a second copy) |
| --- | --- |
| Freshness per source | `data-freshness.js#dataFreshness`, the same call `GET /api/data-freshness` makes |
| Offer orphans | `eval/decided-offers.js#loadDecidedOffers` `.orphans` (answers whose offer was never collected), plus app offers Nick marked sent that no ESPN proposal has matched after 72 h |
| Number-health trend | new `number_health_daily` rows, written inside `number-audit.js#writeAuditRows`' transaction |
| Last-good fallbacks | the plans file via `war-room-view.js#loadPlans` and `campaign/plan-age.js#planAge`; the brain report's `fell_back_to`; stale fit stores from the freshness rows |

It serves no number that feeds a decision and changes no existing number. The only write is the daily
count row, which the refresh loop makes whether or not the flag is on, so the trend has history on the
day the panel is switched on.

<!-- The pre-registration below is committed with the RED tests, before any implementation. -->

## Pre-registration (written before the GREEN commit)

- **B1 (flag off is inert).** `GRIDIRON_DATA_QUALITY` unset: the route answers `{ enabled: false, reason }`
  and reads nothing. **Pass bar:** exact body, 0 reads. **Fails it:** any section served.
  `GRIDIRON_PREVIEW_UNCONFIRMED=1` alone does not switch it on.
- **B2 (one producer: freshness).** The freshness section's per-source statuses and counts equal
  `dataFreshness` on the same fixture, source for source. **Pass bar:** 100 % equal. **Fails it:** any
  source whose status differs or is missing.
- **B3 (orphans).** Fixture: 2 ESPN answers with no proposal row (1 in league 4, 1 in league 2), 1 answered
  offer with its proposal (not an orphan), 1 sent app offer unmatched for 80 h (orphan), 1 sent 10 h ago
  (not yet), 1 sent and matched (not). **Pass bar:** league 4 = 1 answer + 1 sent, league 2 = 1 answer,
  total 3; the answer count equals `loadDecidedOffers().orphans.length` exactly.
- **B4 (trend).** Three audits on three UTC days plus a second audit on day 3 give 3 daily points, the
  day-3 point equal to the second audit (last run of the day wins). Direction compares the latest point
  with the oldest point in the 14-day window: broken+warn up = `worse`, down = `better`, same = `flat`,
  one point = `too_new`. **Pass bar:** all four directions on fixtures. The `number_audit` rows
  themselves are byte-identical with and without the daily table (the audit's served rows do not move).
- **B5 (fallbacks).** Fixture plans file: league 4 planner error, league 2 plan kept from an earlier run
  (older than 24 h), league 3 fell back to Balanced, league 5 clean; plus one stale fit store. **Pass bar:**
  exactly those four items, each naming its league or source, and 0 for league 5. Missing plans file ->
  one plain "no plan has been run yet" item, not an error.
- **B6 (no dev text).** Every `headline` and `detail` string in the response carries no snake_case
  identifier, file path, env name, SQL or raw error text. **Pass bar:** 0 hits across all B2-B5 fixtures.
- **B7 (visible failure, no silent catch).** A section whose reader throws becomes
  `{ status: 'unknown', headline: 'Could not be read' }` and the other sections still serve; the raw
  error goes to the server log only. **Pass bar:** 4/4 sections, each forced to throw in turn.
- **B8 (cheap).** The whole report on the fixture in < 250 ms.

## RED

`test/data-quality.test.js` committed first (`5541d11b`); run on the RED commit:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/data-quality.js'
# tests 1
# pass 0
# fail 1
```

## GREEN

```
node --test test/data-quality.test.js
# report 10.2 ms; overall attention; freshness: 3 of 3 sources behind; offer_orphans: 3 offers not tied
#   to a record; number_health_trend: 1 league getting worse; fallbacks: 2 plans hidden, 1 other fallback
# tests 12
# pass 12
# fail 0
```

Two fixture inserts were corrected after the first GREEN run (named columns for `player_week_usage`, a
valid `model_basis` band on the `trade_outcomes` rows); no assertion or bar changed.

## Not covered

- The Settings -> Health card is not drawn. `GET /api/data-quality` is its whole source; the card layout
  is described in the PR body for the coordinator to wire with the design-system primitives.
- The trend starts empty: the first daily point is written by the first number audit after migration 118
  runs, so the panel shows "No history yet" on day one and a direction from day two.
- Unit 53 (OFFLINE / LAST-GOOD MODE, in progress) will add its own last-good served state; its fallback
  belongs in this section once it merges. This unit reads only what is on `main` today.
- Nothing here was run against the live database; see "Needs local measurement" in the PR.
