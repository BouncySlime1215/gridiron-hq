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
   offer went out, stored with the thread (migration 093), so a replan does not rewrite
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
| M10 | cancelled ESPN proposals counted as answers | reply-times test |

10 of 10 killed.

## Not measured here

- The 80 ms target: the rescore is timed per call (`ms` on every response) but the
  real league 4 world cannot be built in the cloud. `scripts/campaign/negotiate-bench.mjs`
  times the world build and N edits on a DB copy.
- Which ESPN rows carry a real answer time: the bench prints the `TRADE%` rows by
  type / execution_type / status with `processed_at` counts. An accepted trade's
  `processed_at` may include ESPN's review period; if so, accepted rows need dropping.
