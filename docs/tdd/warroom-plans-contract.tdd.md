# One shape for the War Room plans file

RED `428e77ee` "test: RED contract test for the War Room plans schema" · GREEN follows ·
`test/warroom-plans-contract.test.js`, 11 cases.

## The gap

The War Room has one producer and two consumers, and none of them shared a key list:

- **Producer.** The campaign producer is not pushed (no `claude/cloud-campaign-producer`
  branch or PR on 2026-09-24). The only plans file that exists is the ACQ-FLIP study
  output (PR #227), in the study's own names (`acq.best.steps[].p`, `flip.top[].a`).
- **UI, PR #231** (`cce5005`, `server/services/war-room-view.js`) reads the study names.
- **Coach, PR #230** (`6ac4758`, `client/src/components/warroom/coach/warroomCoach.ts`)
  reads a different shape again (`alternatives[].partner`, `flips`, `brain_check.checks`,
  bare `destination.goal.label`).

A key renamed on either side becomes "not computed yet" on the other, silently.

## What this adds

`server/services/campaign/plans-schema.js`: the plans file as one declared shape
(`warroom-plans/1`), a validator that returns every problem with its path, and
`schemaPaths()`, the list of every path a producer may write. Plain JS, no dependencies.
It also exports `tradeoffKey()`, the producer's copy of Coach's key grammar for
`stop_tradeoffs`, so the producer writes keys Coach will look up.

## RED

At `428e77ee` the test imports a module that does not exist:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/plans-schema.js'
```

Re-run after the GREEN-side assertion change (the `zero` status case below): the same failure.

## Liveness: mutation sweep on the schema (GREEN tree)

| mutant | tests failing |
|---|---|
| M1 an `unknown` field may carry a value | 1 |
| M2 an `unknown` field needs no reason | 1 |
| M3 keys outside the contract are allowed | 3 |
| M4 sections not required | 2 |
| M5 `next_move` need not be the deck head | 1 |
| M6 player ids not checked against `names` | 1 |
| M7 probability unbounded above | 1 |
| M8 `mode:<m>:until:<any number>` accepted | 1 |
| M9 `tradeoffKey` stops lower-casing labels | 1 |
| M10 a fourth status (`zero`) accepted | 1 (survived first; the test's `zero` case failed for a different reason, carrying a value. Fixed the test to send a well-formed `zero` field.) |
| M11 `flip_map` renamed back to `flips` | 6 |
| control: comment-only edit | 0 |

Registry mutants (`consumer-reads.js`): an injected read of `leagues[].bogus` fails
case 9; deleting the `fix` from Coach's `flips` read fails case 9. Case 11 (a recorded
read still appears in the consumer's file) skips on this tree because neither consumer
is merged. It was run on a tree with #231's and #230's files overlaid: 11/11 pass.

## Nick's five questions

1. **Well built?** One module, one fixture per party, one registry of reads with
   `file:line`. Every mismatch has a one-line fix. A new unmatched read fails the gate,
   and so does a mismatch that has started to resolve.
2. **Stats or made up?** No statistics. The producer fixture's numbers are illustrative
   and marked `contract fixture v1`. They are not engine output.
3. **How we know:** by test only (11 cases, 12 mutants above). No backtest applies.
4. **Pointed anywhere else?** Nothing imports the schema yet. The producer should call
   `validatePlans()` before it writes, and #231/#230 should read the paths in the
   mismatch list.
5. **How it unifies:** the three parties share one key list. The Coach action vocabulary
   (goals, risk modes, stop kinds, tolerance keys) is spelled here exactly as in #230's
   `warroom-actions/schema.js`.

**Not covered:** the producer's real output. It is not pushed. The day it is, its
output must pass `validatePlans()`, and this fixture should be replaced by a real run.
**What would make it wrong:** a consumer that reads a key through a path the registry
does not list. The registry is hand-written, and case 11 only checks that listed reads
still exist.
