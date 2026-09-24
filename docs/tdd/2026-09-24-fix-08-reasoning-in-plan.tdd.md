# FIX-08: reasoning goes into the plan, one writer

Spec: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` sections 4d (R1-R7), 7 and
8 (FIX-08), on branch `claude/handoff-package-2026-09-22`.

Base: `origin/main` `ea947d4b` (has #238's contract) with three unmerged heads
merged in, in the merge-train order: #233 `6429dc23` (producer), #231
`cce5005e` (`warroom-flag.js#warRoomPlansPath`), #234 `4f59d2db` (REASON-01).
FIX-03 (producer writes the contract) has no PR yet, so this is built against
the contract fixture, not against #233's current output.

## RED

Tests and fixtures only, on the merge of the three heads (no FIX-08 code):

    node --test test/reasoning-panels.test.js
    # pass 0
    # fail 15        (every test: cards.js still reads cards[] / acq, so the contract deck gives no cards)
    node --test test/reasoning-in-plan.test.js
    # Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/reasoning/reason-plans.mjs'
    node --test test/warroom-plans-contract.test.js
    # pass 6
    # fail 5         (`partners` and `p_yes.n` are not in the contract yet; #234's reads do not resolve)

## GREEN

    node --test test/reasoning-panels.test.js test/reasoning-in-plan.test.js test/warroom-plans-contract.test.js
    # reasoning-panels 15/15, reasoning-in-plan 10/10, warroom-plans-contract 11/11

## What changed

| audit row | change |
|---|---|
| R1, R2 | `cards.js#cardsForLeague` reads `alternatives.value[]`; card id = `move_id`; head = rank 0. The deck cap is the contract's `MAX_ALTERNATIVES` (5), so "top card + 5" became "head + 4". |
| R3 | `partners` added to `plans-schema.js` as an optional league key `field(arr({team, p_responds, basis}, {edge, chat_labels, roster_holes, recent_moves, offers_logged, paper_values}))`. FIX-03 moves it into SECTIONS when the producer writes it. His side reads `partners.value[]` by `team`. |
| R4 | Calibration is `brain_report.value.checks[E1].status` (`calibrated` only when passing); the count is `steps[0].p_yes.n`. |
| R5 | Reply table and walk-away are read per step: `steps[0].reply_table.value.{accept,decline,counter,silence}`, `steps[0].walk_away.value.text`. Fact ids are now `reply.<key>.<field>`. |
| R6 | One writer: `scripts/campaign/produce-plans.mjs` calls `scripts/reasoning/reason-plans.mjs#reasonPlans` after planning and before its atomic write. It writes `move.reasoning` (the contract's typed field) into every deck move and `next_move`. `panels.json` is the reuse cache only. |
| R7 | `scripts/reasoning/run.mjs` defaults to `warRoomPlansPath()`, takes the producer's lock and rewrites the plans file through the same function. The cache sits next to the plans file, never under `server/data` (the `.gitignore` entry is gone). |
| section 7 | `server/services/reasoning-flag.js` is the only reader of `GRIDIRON_REASONING_ENABLED`, and preview mode turns it on too. The paid-run opt-in is a separate gate and is still required. |

Gates: with the flag off, every move gets `reasoning: {status:'unknown', reason:'Reasoning panels are off for this run.'}`. With the flag on and no paid run allowed: `'...need a paid run, and this run was not allowed to spend.'` Either way there are 0 calls, and the cache is neither read nor written.

Mapping a panel onto the contract slot (`plan-reasoning.js#panelToField`): each slot is that section's grounded claim texts. An omitted or hidden section puts its reason, in words, in the slot. `cites` is the union of claim cites, and `check_first` comes from the panel. If no model section got through: a failed call or an unreadable reply gives `failed`; a spent allowance, a dry run or a card left out gives `unknown`; all sections failing grounding gives `failed`.

News: the contract has no news section. `produceReasoning({ news })` takes news per league. A league with no list now gets `news_check` 'unknown' ("No news feed reached this run"), where before it got an ok with 0 checked. The producer does not pass a feed yet.

## What the tests pin

`test/reasoning-panels.test.js` holds the 14 REASON-01 tests, moved onto `test/fixtures/reasoning/plans.json`. That fixture is the #238 contract fixture plus a five-move deck, `partners`, `p_yes.n`, and a thin league 4 (no reply table, no partner row, no brain report). One extra test proves it validates.

`test/reasoning-in-plan.test.js`:
1. flag off by default, on for exactly "1", on under preview with `preview: true`
2. `reasoning-flag.js` is the only file naming `GRIDIRON_REASONING_ENABLED`
3. **gate off (flag) -> 0 calls**, 8 moves unknown with the reason, file validates, no cache
4. **gate off (paid) -> 0 calls**, unknown with the paid-run reason
5. both on: panels land in `move.reasoning`, `next_move` matches the head, file validates, cache next to the plans file
6. **unchanged move_id -> 0 calls** on the next run (6 reused, $0)
7. failed call -> `failed`; spent allowance -> `unknown`; both validate
8. a throwing reasoning step marks every move failed, reports the error, and the file validates
9. no news feed -> news_check says the check did not run
10. source order in the producer: plan -> reason -> atomic write -> cache; run.mjs goes through `reasonPlans`

## Wiring

The `reasoning/*` entries are removed from `docs/wiring/annotations.json`. `check:wiring` now reports the 8 reasoning modules as `module-reaches-no-surface`, the same finding #233's head already has for its 14 campaign modules. The map counts only routes, jobs and pages as surfaces. The producer is spawned by the refresh loop (`scripts/refresh-live-data.mjs`), which is neither, so the map cannot credit that edge. Both sets clear together once the producer is reached, or once they are accepted in one entry.
