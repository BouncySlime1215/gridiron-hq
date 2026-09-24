# TDD evidence: reasoning panels for flips and targets (FIX-234-1, 2026-09-24)

**Modules:** `server/services/reasoning/cards.js`, `produce.js`, `prompt.js`, `plan-reasoning.js`;
`scripts/reasoning/reason-plans.mjs`, `scripts/reasoning/run.mjs`;
contract reads in `test/fixtures/warroom-contract/consumer-reads.js`.
**Why:** REASON-01 (PR #234) and FIX-08 wrote a grounded panel into every deck move only. The
War Room's flip map and target picker also carry a `reasoning` field, but only the planner's
template text (`campaign/view.js`, source `plan.template`) ever filled it.

## Contract check
`plans-schema.js` already declares `reasoning: field(reasoning)` as an optional key on both `flip`
and `target`. It is the same typed shape as `move.reasoning`, so the schema needed no change.
`validatePlans()` passes on every plans file the new tests write.

## Behaviour shipped
- **Cards.** `cards.js#itemCardsForLeague` builds one card per `flip_map.value[]` item
  (id `flip:<player>:<buy_from>:<sell_to>`) and one per `targets.value[]` item
  (id `target:<player>:<owner>`). Each kind is capped at `MAX_ITEMS_PER_KIND` = 5 before any prompt
  is built. The ids come from the contract fields, so they stay the same across refreshes and a
  cached panel can be reused.
- **Facts.** A flip's panel can cite `flip.*` facts (spread with se/clears_2se, prices, p1/p2/p_both,
  nick_after, legs_why_not, the players' names), `his.*` for the team he buys from and `buyer.*` for
  the team he sells to. A target's panel can cite `target.*` facts (gain_if_landed, p_reach,
  mode_fit, why, approved, is_plan_target) and `his.*` for the owner. Chat still reaches the model
  only as labels.
- **Grounding.** Flip and target panels go through the same `ground.js` → `verify.js` checks as moves. A
  section with an invented number fails and its words are held back. Flips and targets have no
  reply table, so `counter` is `unknown` with its reason in words.
- **When a panel is written: "on open or when inputs change".** A flip or target panel is written
  again only when (a) its fingerprint is new or has changed against `panels.json`, or (b) its id is
  in `open` (`produceReasoning({ open })`, passed through `applyReasoning`, `reasonPlans`, and
  `run.mjs --open id,id`). An id can be scoped to one league as `<league>|<id>`. Anything else is
  reused for $0.
- **Cost.** Still **one call per league**. Changed moves, flips and targets go into the same prompt
  and draw on the same `trade_proposals:league-<id>` pot. `max_tokens` stays 12000 up to six panels
  and grows 1500 for each extra panel, up to a ceiling of 24000.
- **Deck fingerprints are unchanged.** Move cards and move facts are built exactly as before (same
  keys, same order). Existing `panels.json` entries for moves still match, so the change does not
  cause a one-off re-spend.
- **Writing into the plan.** `applyReasoning` writes each item's panel into `item.reasoning`
  (source `coach.text`). If a panel could not be written (capped, failed, dry run), the planner's
  `plan.template` text stays in place. With a gate off or the step failed, flips and targets are not
  touched.

## RED (commit 12996bf)
`test/reasoning-panels.test.js` + `test/reasoning-in-plan.test.js`: **32 tests, 24 pass, 8 fail**, all for
the missing feature:
- five grounded panels: no `flip` or `target` cards in the prompt (`[]` vs the five ids)
- item.reasoning: `Cannot read properties of undefined (reading 'status')` (the second flip has no panel)
- unchanged refresh: 0 item panels (expected 5)
- ungrounded flip number: no `flips[0]`
- changed target: 0 calls (expected 1)
- open: 0 calls (expected 1)
- in-plan, both gates on: the flip `counter` is still the fixture's hand-written text
- in-plan, reuse count: 6 (expected 10 = 6 deck + 2 flips + 2 targets)

## GREEN
`test/reasoning-panels.test.js`, `test/reasoning-in-plan.test.js`, `test/warroom-plans-contract.test.js`:
**45 tests, 45 pass, 0 fail, 0 skipped.** The contract test now also covers the 27 flip and target
paths that `cards.js` reads, and every one resolves to a path the producer writes.

Checks: `npm run typecheck` exit 0, `npm run lint` exit 0, `npm run check:wiring` exit 0.
Full `npm test` (after `npm ci`): **5252 tests, 5210 pass, 0 fail, 42 skipped**, exit 0.

## What the tests pin
| Test | Pins |
|---|---|
| 2 flips + 3 targets → 5 grounded panels | the deck is still in the prompt; still 2 calls (one per league); each item passes `panelErrors`, every grounding check is ok, `counter` is unknown |
| item.reasoning | all 5 items are `ok`/`coach.text` with cites; `validatePlans` passes |
| unchanged refresh (fake client, real `callClaude`) | client call counter stays at 2, `calls` is empty, $0, every item panel is reused |
| ungrounded flip number | `case_for` failed, no value, `ungrounded_number` '9'; the plan text never shows "9%" |
| changed target input | exactly 1 call, whose prompt carries exactly `['target:605:7']` |
| open | `open: ['target:701:2', '1\|flip:502:7:2']` → 1 call with exactly those two; an open scoped to another league → 0 calls |
| gate off | `flip_map` and `targets` are identical to the input |

## Not confirmed here
- Nothing in the War Room UI sends an "open" yet. For now `open` can only be set through
  `run.mjs --open` or code calling `reasonPlans`/`produceReasoning`. The producer
  (`produce-plans.mjs`) writes flip and target panels whenever their inputs change, and never
  passes `open`.
- No live producer run on the Mac. Whether real flip and target panels show up in the plans file
  there, and what they cost, has not been observed. No paid call was made.
