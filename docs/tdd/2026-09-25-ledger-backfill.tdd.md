# TDD pre-registration: LEDGER-BACKFILL, trade_outcomes settles from E1's own pairing

Batch B item 5 (coordinator data-gap comment on #384, 2026-09-24). Branch cut
from `origin/main` at `662b64c` (includes integration-7 `decf7eb`).

## What was wrong at `662b64c`

`trade-outcomes.js#settleObservedOutcomes` writes one `observed` row per ESPN
proposal the first time it sees it and never looks at the row again
(`if (existing) continue`). An offer collected while pending stays `proposed`
forever, even after its ACCEPT or DECLINE is collected. `decided-offers.js`
already documents this and counts it as `stale_outcome_row`. The settler also:
- reads an ACCEPT from the proposer's own team as the answer (E1 does not);
- never settles an offer ESPN closed with no answer (withdrawn, or expired by
  `TradeTaskProcessor`);
- pairs raw rows with its own loop, a second reading of what E1 pairs.

On the Mac (coordinator, read-only): 80 ledger rows carry an ESPN tx id and
only 37 are settled.

## Change

- `decided-offers.js#rawOfferGroups` is the pairing E1 already runs, moved into
  an exported function with no change in behaviour. `decidedOffers` calls it.
- `settleObservedOutcomes` reads its verdicts from it. It inserts missing rows as
  before, and it now also settles an existing observed row that is still
  `proposed`. It never touches a settled row or an app row.
- Status mapping (the 067 CHECK has no `vetoed` or `withdrawn`): answered gives
  `accepted` / `declined`; closed with no answer gives `expired`, and the
  reason says whether ESPN expired it or the proposer withdrew it; accepted
  then vetoed stays `accepted`, as E1 counts it, and the reason names the veto.
- Every row this settles carries `settle_reason` starting `backfill_observed:`.
  `model_basis` and `model_p_accept` stay NULL. An ESPN-only offer has no
  prediction, and a clone basis is never reused. No migration is needed.
- It runs where it already runs: `settleOfferLoop`, which the collector calls
  after each sync. There is no new producer.

## Metrics and bars

1. **Stale pending rows** (fixture): a row written while pending settles once
   the answer is collected. Bar: settled, with the answer time as
   `resolved_at` and the proposal time kept as `proposed_at`.
2. **Idempotent**: a second run gives `written 0`, `updated 0`, and rows that
   deep-equal the first run's.
3. **E1 invariance**: `loadDecidedOffers` gives identical offers before and
   after the settle. Bar: identical. (The raw rows already decide E1, so the
   backfill must not move the graded pool. It makes the ledger agree with it.)
4. **Needs the Mac**: settled observed rows per league and per week, before
   and after. Bar: no row whose raw offer has an answer is left `proposed`.

**Fails if** a settled row is re-settled, an app row changes, E1's offers
move, a clone basis or a prediction is written, or a second run changes
anything.
