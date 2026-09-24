# BROKEN-01a+b: broken numbers, visible in the app

RED `c9ea3ef6` · GREEN follows · `test/number-audit.test.js` (14 cases), `test/number-audit-collect.test.js` (1 case).

## What it answers

"Which numbers on my screen are wrong right now, and what do I trust meanwhile?" Until
now the only answer was a hand-kept inventory (BROKEN-NUMBERS.md rows A-Q). This puts
rows A-E and H, plus invariant checks, into the app, per league.

## Shape

- `server/services/number-audit.js`: `collectLeagueSnapshot` calls the app's own
  producers exactly as their pages do (three title-odds paths, four weekly-range
  samplers, three week producers, two chance-to-play callers, two "checked out"
  signals, source timestamps). `evaluateSnapshot` is pure over that snapshot.
  A producer that throws or returns `{ error }` becomes a `warn` row that says so.
- `number_audit` (migration 077): one row per (league, check), upserted. Holds the
  current verdict, not a history, so the loop cannot grow it.
- `scripts/refresh-live-data.mjs`: step 5, after manager signals. At most once per
  league sync, and at most hourly. Never in the web server.
- `GET /api/number-audit`: reads the table. The route imports only `readNumberAudit`,
  and the service has no static import of any producer (source-guarded in the test).
- Settings "Number health" card + a red dot on the Settings nav icon for the selected
  league. Nothing is broken, so nothing renders.

## RED

Run with the implementation removed (tests committed alone):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/number-audit.js' imported from .../test/number-audit.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/number-audit.js' imported from .../test/number-audit-collect.test.js
ℹ tests 2 · pass 0 · fail 2
```

## GREEN

All 15 pass. The acceptance cases:

| case | result |
|---|---|
| two title-odds paths 5 pts apart | `broken`, "My team and Trade Lab title impact disagree on your title odds: 31% vs 26% (5.0 pts apart; limit 4 pts)", pages list both |
| NaN weekly range | `inv_no_nan` `broken`, names `Ceiling lineup.ceiling`; not double-reported as out of order |
| stale ESPN sync (24 h, max 3 h) | `source_age` `warn`, 0 broken |
| clean fixture | 0 broken, 0 warn, all 11 checks present |
| route | returns stored rows; a read writes nothing; `league_id=abc` is 400 |
| card | renders the broken row's what / pages / "Meanwhile"; passing checks counted, not listed |
| dot | empty markup at 0 broken and with no data; red dot with an aria label at 2 |

The collector test runs every real producer on a six-team fixture league: all three
week producers answer 6, both full title-odds paths serve all six teams, and the two
producers that cannot run on a league with no weekly projections (ceiling lineup,
lineup posture) return named errors, which the check turns into `warn`.

## Tolerances (first cut, `TOLERANCES` in the service)

Title odds 4 pts, playoff odds 5 pts, Spearman >= 0.9, weekly range 10 pts on p10 or
p90, chance-to-play gap 0.10, title sum within 0.02 of 1, playoff sum within 0.05 of the
spots. Monte Carlo alone moves two independent 1,200-1,500-run title odds by ~1.8 pts
(sd of the difference at p = 0.3), so 4 pts is ~2.3 sd; tune from live rows.

## Not confirmed

The known-nonzero control (row A shows up on a copy of the live DB) is not run here:
it needs the local database. Run it on a copy (see the PR body).
