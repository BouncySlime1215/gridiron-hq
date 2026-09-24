# FIX-03: the campaign producer writes the War Room contract (2026-09-24)

Source: `docs/handoff/local/INTEGRATION-AUDIT-0923.md` (branch
`claude/handoff-package-2026-09-22`), section 4a rows P1-P25 and defects D2, D3, D7.
Built on the heads of #233 (`claude/cloud-campaign-producer` 6429dc2) and #238
(`claude/cloud-warroom-contract-sj7zjt` a08c49e), merged without conflicts, because
neither is on `main` yet.

## 0. Audit (extend or build)

- The contract already existed (#238 `plans-schema.js`) and had no caller. The
  producer (#233 `view.js`) wrote its own shape and checked it with its own
  `validateEntry`. Decision: **extend**. `view.js` is rewritten to emit the contract;
  `validateEntry` is deleted; the per-league loop moves out of `main()` into an
  exported `buildPlansFile()` in the same script so the fixture is written by the
  code that writes the live file.
- #238 is extended only where the producer has real data: FIELD_META `unit` and
  `guess`, SOURCE_IDS `plan.template` / `chat.labels` / `asset.ros`, sections
  `number_health`, `risk_modes`, `partners`, league-level `_run`, step
  `p_yes_band {low, high}`, shared `SKIP_REASONS` / `DECLINE_REASONS`, and `UNITS`.
- `consumer-reads.js` is unchanged (FIX-04/06/08 own it).

## 1. Tests (RED first)

`test/fix-03-producer-contract.test.js` (17 tests), the rewritten contract tests in
`test/campaign-producer.test.js`, and two additions to
`test/warroom-plans-contract.test.js` (a `PENDING` list and a test that each pending
path is still unwritten).

RED (commit `c1f43a8`, implementation absent):

```
not ok 7 - points objective runs end to end on the fixture
not ok 21 - the plans JSON matches the War Room contract (plans-schema.js, warroom-plans/1)
not ok 22 - a failed league carries only its error, never a guess
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/produce.js'
not ok 2 - test/fix-03-producer-contract.test.js
not ok 27 - each pending path is declared and still not written
# pass 30
# fail 5
```

(The loop later moved from the planned `server/services/campaign/produce.js` into
`scripts/campaign/produce-plans.mjs#buildPlansFile`: a new server module that only a
spawned script reaches would have added one `module-reaches-no-surface` finding to
the wiring check. The test imports were moved with it.)

Two test edits after RED, both in `warroom-plans-contract.test.js`: its `META`
pattern gains `unit|guess` (they are typed-field metadata now, like `se`), and a
recorded mismatch whose `fix.to` sits on a PENDING path counts as declared (Coach's
`brain_report.value.checks` read, owned by FIX-05). The fixture generator gained a
second refresh and a fifth league (no move clears) so `ground_lost`, `previous_key`
and `next_move.reason` are real output.

GREEN: the three files above plus `refresh-loop-steps.test.js`, 74 tests, 73 pass,
1 skipped (#238's "consumer file is in this tree" test skips until #230/#231 merge).

## 2. What each row became

| row | now |
|---|---|
| P1 | head `{schema, generated_at, producer, producer_version}`; `study`, `labels`, file-level `attention` and `pushes` gone (pushes stay in `pushes.jsonl`) |
| P2/P3 | sections at the entry top level; `view`, `acq`, `flip` and the prototype keys gone; bookkeeping under `_run` |
| P4 | only ok / unknown / failed; `catch_up` with nothing is `ok []` |
| P5 | per-field `producer` / `preview` gone; `unit` and `guess` are contract keys |
| P7 | a number that is not finite (or a probability outside 0..1) is `unknown` with a reason |
| P8/P9 | `alternatives.value` is the whole deck, head included; `next_move.value` is the head move (D3 fixed at the source) |
| P10/P11 | per step `title_odds_delta`, `title_after`, `message`, `opening` (+ `get`), `walk_away`, `send_when`, `reply_table` keyed accept/decline/counter/silence; the decline row names the next card's `move_id` |
| P12/P13 | `targets` (typed `mode_fit`, `why`, `is_plan_target`), `flip_map` (typed `legs.p_both`; the chat hint moves into `reasoning.his_side`) |
| P14/P15 | `brain_report` and `number_health` are `unknown` naming FIX-05 (the hard-coded 'not_run' verdict is gone) |
| P16 | `risk_modes`, `partners` (labels and counts only) added to the contract; `confirm` folded into `_run` |
| P17 | points objective writes the contract shape; other goals `unknown` "points objective not set" |
| P18 | `goal` typed (`get_player` + `player_id`), `risk_mode {mode, until_week?}`, tolerances, `arrive_by`, `eta_week`, `path`, `ground_lost` typed |
| P19/P20 | itinerary exactly the contract keys; `stop_tradeoffs` keyed by `tradeoffKey()` for Nick's priced stops and for each other risk mode |
| P21 | per-league `attention {rank, of, reason}` |
| P22 | `finder_best_expected` from the adapter's `finderBest()` (the study's baseline), or `unknown` with why |
| P23 | `validateLeague` per league; a failing league is `{league, me, names, error}`; `validatePlans` on the whole file before the write |
| P24 | every id is a string and every player id is a key of `names` (the validator enforces it) |
| P25 | step `p_yes_band {low, high}` from the adapter's acceptance band |

## 3. Pending contract paths

The fixture is now the real producer's output, so #238's "producer writes every
declared path" test lists what the producer cannot write yet, each with its owner:
`brain_report.value.*` and `number_health.value.*` (FIX-05), and the
`reputation_budget` / `ai_spend` tolerances (no planner rule reads them). The next
test fails when any of them starts being written.
