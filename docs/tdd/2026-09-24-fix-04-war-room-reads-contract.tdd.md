# FIX-04: the War Room view reads the plans contract, and the best plan shows

Spec: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` (branch `claude/handoff-package-2026-09-22`),
section 4b rows U1-U7 and section 8 FIX-04. Branched from #231's head (`cce5005`) with
`origin/main` (`ea947d4`, which carries #238's contract) merged in. #230 and #233 are not
merged; nothing here imports them.

## RED (`b9e4af0`)

Tests changed first: `test/war-room-view.test.js`, `test/war-room-deck.test.js`,
`test/war-room-layout.test.js`. Run against #231's implementation:

```
SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --test test/war-room-view.test.js test/war-room-deck.test.js test/war-room-layout.test.js
# tests 31  # pass 13  # fail 18
```

The failures that carry the unit:

- `the deck is alternatives.value: a head that differs from alternatives[1] is card 1 (D3/U1)`
  and `the head of alternatives is card 1 ...` (render): #231 reads `acq.alternatives`, which
  the producer writes without its head, so card 1 was the second-best move.
- `each contract section passes through unchanged (U2, U3)`: destination, speed_curve,
  catch_up, brain_report and attention were hard-coded "not built".
- `the view is the league entry plus { enabled, preview, preview_reason, snapshot, sources, banner }` (U4).
- `a skip posts one deck.skip request ...` and `"I sent it" posts offer.sent once ...` (U6):
  the skip log lived in React state only.

## GREEN

Same command: `# tests 32  # pass 32  # fail 0` (one test added after RED: `Approve on a
suggested target posts one target.approve request`, plus a call-site assertion in the layout
test that WarRoom wires the route into the picker; both proved live by M8 below).
`test/warroom-plans-contract.test.js`: 11/11, with every #231 `fix` entry in
`test/fixtures/warroom-contract/consumer-reads.js` deleted and each read moved to the file
that now does it. The test fails on a stale `fix`, so none is left.

## Liveness: mutation sweep

Each mutant applied alone to the GREEN tree, then the four War Room test files run
(a scratch script, not committed: apply, run `node --test test/war-room-*.test.js test/warroom-plans-contract.test.js`, restore).

| mutant | where | result |
|---|---|---|
| baseline (no change) | | 0 fail |
| M1 deck drops its head (`field.value.slice(1)`) | NextMoveDeck.tsx | dies (4) |
| M2 no per-section contract check | war-room-view.js | dies (1) |
| M3 dismissing the reason posts nothing | deck.ts | dies (1) |
| M4 tapped reason not sent | deck.ts | dies (1) |
| M5 Do it posts offer.sent | deck.ts | dies (1) |
| M6 "I sent it" posts twice | deck.ts | dies (1) |
| M7 wrong route (`/request`) | requests.ts | dies (4) |
| M8 call site: WarRoom does not pass `onRequest` | WarRoom.tsx | dies (1) |
| M9 brain_report hard-coded "not built" again | war-room-view.js | dies (2) |
| M10 SOURCES keeps only the first 9 ids | war-room-view.js | **survives: equivalent on this tree.** main's `SOURCE_IDS` has exactly 9; the 3 extra labels are dead until FIX-03 adds those ids, and the `Object.keys(SOURCES) == SOURCE_IDS` test then covers them. |
| M11 no preview prefix | war-room-view.js | dies (1) |
| M12 Back posts the pending skip | deck.ts | dies (1) |
| C1 designed survivor: banner wording | war-room-view.js | survives (0), as designed |
| C2 designed not-applied: pattern absent | deck.ts | not applied, reported |

## What changed

| row | change |
|---|---|
| U1 | The deck is `alternatives.value`, served as written; the head is rank 1 and card 1. |
| U2 | `destination` passes through. |
| U3 | Every contract section passes through. A section the producer did not write is `unknown` ("The producer did not write X for this league."); a section that breaks the contract is `failed` with its first problem; `number_health` is `unknown` ("Not in the plans contract yet") until FIX-03 adds it to SECTIONS, then passes through with no code change. |
| U4 | View = the league entry (league, me, names, error, sanity flag, sections) + `{enabled, league_id, preview, preview_reason, snapshot, sources, banner}`. `types.ts` and the components use `alternatives`, `targets`, `flip_map`, `brain_report`, `next_move`; panel ids `flip_map`, `brain_report`. |
| U5 | Reasoning is `move.reasoning.value[slot]`. |
| U6 | `requests.ts` posts to `/api/warroom/:leagueId/requests`: `deck.skip` (one per skip, reason if tapped), `offer.sent` ("I sent it", once per move), `offer.reply` ("He did this" in the reply table, after Do it), `target.approve` (Approve in Suggested targets). Do it itself posts nothing: picking a card is not sending it. |
| U7 | `SOURCES` is built from `plans-schema.js#SOURCE_IDS`. |

Checks on this tree: `npm run typecheck` clean, `npm run lint` clean, `npm run check:wiring` exit 0,
`npm run build` ok.
