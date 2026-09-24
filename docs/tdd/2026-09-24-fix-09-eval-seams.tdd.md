# FIX-09: EVAL reads what the writers write

RED `2ff2c1d` · GREEN follows · stacked on PR #246 (`claude/cloud-e1-fix-pvd8q8`,
itself on #235).

`test/eval-seams.test.js` (14, new), `test/eval-graders.test.js` (E2 band
spelling, E6 row shape), `test/eval-e1-league.test.js` (the app row in the
ESPN-copy test is now sent), `test/brain-report-store.test.js` (E1 ledger test
rewritten for sent-only and no offer_log; E2 and E7 reasons). RED on #246's
graders: 13 failing, 42 passing, `eval-seams` failing at import (no 083).
GREEN: 68 of 68 across the eval and brain-report files.

**First GREEN push broke 7 unrelated tests** (full `npm test`: 4797 pass,
7 fail), all `error in view title_odds_snapshots: no such table:
main.served_numbers`. SQLite re-checks every view on `ALTER TABLE ... RENAME`,
so a view over a not-yet-created table breaks every later rename in the
database, and those tests rename `leagues` and friends to simulate absence. The
fix: 083 creates `served_numbers` IF NOT EXISTS with 079's DDL (#243) column
for column, so the view is valid whichever PR merges first. The first seams
test now pins the column list and does a rename probe.

## What changed

| grader | before (#235/#246) | after |
|---|---|---|
| E1 app arm | every `app_proposed` row, plus `offer_log` | `trade_outcomes` app_proposed rows with `sent_at` (CLONE-01b #239); `offer_log` read nowhere |
| E1 ESPN-copy dedup | any app row absorbed any observed row within 72 h, any number of them | `matched_tx_id` first; the 72 h fallback only for sent, resolved, unmatched app rows, one copy each (the earliest); an unsent row suppresses nothing |
| E2 | `offer_log` (never built), band `'at'` | `trade_outcomes` sent app rows with `price_band` (083), band `'at_point'`, send order |
| E3-live | `title_odds_snapshots` table (never built) | 083's VIEW over `served_numbers` (#243) weekly title-odds rows + league history outcomes |
| E5 | `campaign_steps` (never built) | 083's table; not-yet-realized steps counted in `detail.awaiting_realized` |
| E6 | `rec_ledger` JSON fields nothing writes (`outcome_json.followed`, `predicted_json.near_tie`) | `follow_ledger` (SELF-01a #245) JOIN `rec_ledger` (#174) on `inputs_hash = rec_ledger_hash`, same league; shortest graded horizon once per decision |
| E4 / E7 | reasons name a harness / "the Monday Autopsy producer" | reasons name the E4 planner replay harness (no unit yet) / PROJ-04-a |

`readSource` now reports a view whose underlying table is missing ("source
<view> reads <table>, which is not built yet") and rethrows any other error.

## What each test pins

| test | pins |
|---|---|
| 083 applied before siblings | served_numbers has 079's columns, the view reads empty, a table rename still works; E6, E1 (app arm), E2 each name the missing sibling source instead of throwing |
| readSource on a broken view | names the missing table; any other error rethrows |
| price_band / campaign_steps CHECKs | only `below`/`at_point`/`above`; realized gain needs realized_at; one row per (league, move, step) |
| 083 down | refuses while campaign_steps holds rows |
| **unsent app row** | an `app_proposed` row with no `sent_at` no longer hides the observed ESPN row; counted as `unsent_app_offer` |
| matched_tx_id dedup | drops exactly the matched copy (ledger or raw), keeps a second ESPN offer inside 72 h; fallback claims one copy |
| E1 load | 6 sent + 1 observed that the unsent row used to hide; `offer_log` present but not read |
| E2 load | 12 at_point + 1 below; unsent and unbanded rows excluded |
| E2 band | `'at'` is no longer graded |
| E3 view | pivot per team per weekly snapshot (page views and other surfaces out); outcomes NULL in season, NULL with final ranks but no playoff week scored, NULL with a playoff week scored but final ranks 0, then made_playoffs by seed <= playoffTeamCount and won_title by final_rank 1 |
| E5 load | 4 realized graded, 1 awaiting counted, "needs 11 more steps" |
| E6 load | follow + ignore only (no_action, unresolved, unjoined out); the h1 score, not h2 |
| E4 / E7 | reasons name their units |

## Mutations (each run against the eval + brain-report files)

| mutation | result |
|---|---|
| M1 unsent app rows not filtered in `mergeOffers` | 1 fail (unsent row hides the ESPN row) |
| M2 matched app rows also take part in the 72 h fallback | 1 fail (second ESPN offer swallowed) |
| M3 E6 joins every rec_ledger horizon | 1 fail (h2 score counted) |
| M4 view drops the final_rank > 0 gate | 1 fail after adding the "playoffs under way" step (it survived before) |
