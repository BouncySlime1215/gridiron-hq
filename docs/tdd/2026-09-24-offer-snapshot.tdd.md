# OFFER-SNAPSHOT: keep the terms of every ESPN trade offer

**Every row in the tests is a fixture. This branch has not run against ESPN.**
The 38-of-82 figure comes from the brief. It has not been re-measured here,
because this container has no league cookies and no copy of the local database.

## What was wrong

38 of 82 decided trade offers had no proposal row. A decision row (accept,
decline, veto, close) points at its offer only through `related_tx_id`. With the
offer missing, nobody knows which players were offered, and the acceptance model
has no terms to learn from. Two ways in, both visible in the code:

1. **Offers that are never seen while pending.** The refresh loop runs one tick
   every 900 s, and a tick can take many minutes on top of that (its chat step
   has a 20-minute timeout). An offer made and answered inside that gap is never
   seen in `mPendingTransactions`.
2. **Terms overwritten after the offer is seen.** The raw upsert in
   `scripts/collect-league-transactions.mjs` sets `items_json=excluded.items_json`
   on every sighting. A resolved offer that ESPN returns with no items therefore
   loses the terms it had while pending. Test S2 reproduces this on the real
   upsert SQL.

Neither miss was ever counted. `settleObservedOutcomes` skipped the decision
with a free-text reason and returned it, and nothing stored that reason.

## What changed

- **Migration 084** adds two tables. Numbered by the MIGRATIONS.md registry
  (first built as 079, which main uses for served_numbers).
  - `trade_proposal_snapshots`: first write wins. `items_json` must be a
    non-empty JSON array (CHECK). `captured_from` is `pending`, `resolved` or
    `raw_backfill`. `resolution` records the outcome, ranked vetoed > accepted >
    declined > closed.
  - `trade_outcome_links`: one row per decision row. `link_state` is `linked` or
    `proposal_missing`. A missing link must carry a typed `missing_reason`
    (`no_related_tx_id`, `proposal_never_captured`, `proposal_items_empty`), and
    CHECK refuses a miss without one.
  - `down()` refuses while either table holds a row.
- **`server/services/trade-proposal-snapshots.js`** has two writers:
  - `captureProposalSnapshots` reads the ESPN response itself.
  - `linkTradeOutcomes` backfills snapshots from raw rows, then links every
    decision. Because it runs every collector pass, it is also the backfill.
- **The collector** calls both inside its existing transaction and runs
  migrations first. It also takes `--league <leagues.id>`. The per-league log
  line now reports offers captured and decisions linked or missing. It is exposed
  as `npm run collect:transactions`.
- **The refresh loop** polls the focus league between ticks through
  `createFocusPoller`: `FOCUS_LEAGUE_ID` (default 4) every
  `FOCUS_TRADES_POLL_SECONDS` (default 180; 0 turns it off). It only runs in
  `--loop` and never on the web server. A full tick resets its clock. It writes
  its own `sync_log` row, `league_transactions_focus`.

## Gates

- S1: a pending offer is captured once with its full items.
- S2 / S2b: a later decline links to the offer, and the terms survive the raw
  row's items being overwritten with `[]`. Resolution precedence is tested.
- S3 / S3b: all three missing reasons are typed, and CHECK refuses an untyped
  miss. Re-linking is idempotent, and a miss turns into a link once its offer
  arrives.
- S4 / S4b: backfill from raw rows, scoped to one league. The raw-table-absent
  state is named.
- S5 / S5b: the focus poll spawns the collector for league 4 only, and runs on
  its own cadence.

## Evidence

- RED `abe280e`: `ERR_MODULE_NOT_FOUND` for the service. 0 pass, 1 fail.
- GREEN: `test/trade-proposal-snapshots.test.js` 9/9.
- `npm run check` on the GREEN tree: see the PR body.
- First full run found three failures with one cause: 084 (then 079) had no `down()`.
  Fixed. After the fix, `migration-027-populated-upgrade` passed 16/16 and
  `model-registry-persistence` passed 22/22.
- Collector dry run with no leagues: `--league 4` exits 1 with "not an ESPN
  league with cookies here". Before that line was added, a missing focus league
  was logged as ok.

## Not confirmed

- Whether `mPendingTransactions` lists offers between two other teams, or only
  offers that involve the cookie owner. If it only lists the owner's, the focus
  poll catches the owner's offers and the league-wide miss rate falls less.
- The real miss rate after deploy. Read it off the collector's log line
  (`decisions N linked, M proposal_missing (...)`) after a few days of the loop.
- Whether a pending offer's `executionType` is `EXECUTE`. The capture treats
  every `TRADE_PROPOSAL` that is not `CANCEL` as an offer, so either way it is
  kept.
