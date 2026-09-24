# NEGOTIATE-UI: the War Room's negotiation mode

Spec: `docs/handoff/local/WAR-ROOM-UI.md` v3, "New modes" 1 (branch
`claude/handoff-package-2026-09-22`), with `COACH-ANCHOR.md` (what_if: rescore a
package edit -> title-odds change, P(yes) band, his yes-point), `PEOPLE-FLOW.md`
(yes-point price, reply-style mix) and `BUILD-PLAN.md` (NEGOTIATE-UI after FIX-04).
Base: `origin/claude/cloud-fix-03` (`d7736fe`) with `origin/claude/cloud-fix-04`
(`6870c26`) merged in.

## What it does

After "I sent it" the deck card becomes a live thread (`Negotiate.tsx`):

1. **Reply branches.** The step's `reply_table` as the plans file served it when the
   offer went out, stored with the thread (migration 102; the sent time is trade_outcomes.sent_at, the one "I sent it" store), so a replan does not rewrite
   what Nick sent against. "He did this" logs his reply; its branch goes live and shows
   its counter rules or ready message. Accept and decline close the thread; a counter
   carries his ask (picked in the builder).
2. **Countdown.** Follow up once he is past his slow reply time (90th percentile), move
   on at twice it, floors 60 min / 4 h (hand-set). His distribution comes from his
   answers to Nick's ESPN offers (>= 5), else his chat reply latency
   (`coach/people/variables.js` via the trusted identity map), else the playbook's
   24 h / 48 h with the reason there is no data. A counter Nick sends restarts it.
3. **Counter builder.** Tap players on either side; each edit (debounced 120 ms, stale
   answers dropped) is one server rescore: `tradeImpact` against a world built once
   per league sync (the RL-19-2 fast rescore), plus his side from the producer's own
   pricing (`readDeal` -> `acceptanceBand`). Shows Nick's title-odds change (+/- SE,
   noise flag), his chance of yes with its band, his yes-point, and the slider: the
   package, his yes-point and the red walk-away line on his market screen.
4. **Undo** "I sent it" for 10 minutes; **Walk away** closes the thread.

Yes-point: where the package breaks even on his own valuations, on the market screen
(`-perception_shift`); market-fair (0%) when nothing we know about him prices these
players, and it says so. Both it and P(yes) are labelled guesses (E1 pending).

## RED

`test/warroom-negotiate.test.js` first, against the base without the implementation:

```
SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test test/warroom-negotiate.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/routes/warroom-negotiate.js'
# tests 1  # fail 1
```

## GREEN

Same command: `# tests 20  # pass 20  # fail 0`.

## Liveness: mutation sweep

Each mutant applied alone, the suite re-run, the file restored.

| # | mutant | killed by |
|---|---|---|
| M1 | follow-up at his p50 instead of p90 | countdown test; thread render test |
| M2 | yes-point at +shift | his-side test |
| M3 | rescorer not cached per sync | one-world-per-sync test |
| M4 | accept leaves the thread open | replies test |
| M5 | route skips the flag | membership-before-flag test |
| M6 | opening lets the body override the step | "I sent it" stores the served step |
| M7 | deck never flips to the thread | sent-card test |
| M8 | a sent counter does not restart the clock | restart test |
| M9 | Undo never expires | Undo test; thread render test |
| M10 | the league's PROCESS row counted as his answer | reply-times test |
| M11 | declines dropped from his answers | reply-times test |

11 of 11 killed.

## Not measured here

- The 80 ms target: the rescore is timed per call (`ms` on every response) but the
  real league 4 world cannot be built in the cloud. `scripts/campaign/negotiate-bench.mjs`
  times the world build and N edits on a DB copy.
- ESPN answer times on league 4: the first LOCAL run showed `processed_at` sits on
  TRADE_ACCEPT rows, not on proposals, so the first version (proposal proposed ->
  processed) never fired. It now joins Nick's TRADE_PROPOSAL/EXECUTE to the partner's
  TRADE_ACCEPT/TRADE_DECLINE/EXECUTE by related_tx_id (the reading
  counterparty-pricing.js and manager-signals.js already use); the bench prints how
  many offers join and the per-team source. Expired offers leave no row, so the
  distribution is his time when he answers at all.

## NEGOTIATE-UI-FIX (2026-09-24)

- The rescorer moved to `server/services/campaign/negotiate-engine.js` and runs in one unref'd
  worker thread (the COACH-NEGOTIATE #327 pattern). The first call for a league sync starts the
  build and answers `status: 'building'`; each edit after that is one awaited message round trip,
  capped at 8 s. The Express thread never runs the world build or a rescore.
  Local copy, league 4: first call 24.6 s with 24.5 s event-loop lag -> 75-129 ms with 32-63 ms lag;
  10 edits p95 623 ms (614 ms lag) -> 314-957 ms (12-42 ms lag).
- "I sent it" has one store, `trade_outcomes.sent_at`. Opening a thread records it through
  `warroom-actions/store.js#recordRequest` (offer.sent, idempotent with the deck's own post) and the
  thread keeps `trade_outcome_id`; Undo is a retract request. Migration 102 (`negotiation_threads`,
  `negotiation_events`) replaces #309's 093, which carried its own `sent_at`.
- `client/src/components/warroom/negotiate.ts` -> `negotiateModel.ts` (it clashed with `Negotiate.tsx`
  on a case-insensitive disk).
- Flag: `GRIDIRON_NEGOTIATE_UI` (was `GRIDIRON_WARROOM_NEGOTIATE`), default off, preview turns it on.
- TODO: his yes-point should come from `server/services/people/counterpart.js` once the batch-4
  merge lands; until then the existing acceptance model.
