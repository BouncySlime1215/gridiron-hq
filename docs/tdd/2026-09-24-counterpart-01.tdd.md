# COUNTERPART-01: profile reader (PEOPLE-01) + counterpart model in the campaign producer (2026-09-24)

Spec: PEOPLE-WIRING.md (handoff branch) sections "Target: one reader" and CAMPAIGN-PEOPLE
(steps 1-4, 6 and 10 of the ten), plus the task's numbers: wants_player prior log-lift 2.0,
shrunk, 7 d -> 21 d decay; M6 reply prior ignore .45 / counter .33 / decline .17 / accept .05.
Stacked on PR #233 (`claude/cloud-campaign-producer`).

## 0. Audit (extend or build)

- `counterparty-pricing.js#negotiationProfilesFor` is today's reader, but its schema check
  rejects any key it doesn't know, so every profile rebuilt with the 9/23 fields
  (`values_talk`, `deal_feelings`, `behaviour_vs_words`, `changes_since_0918`) would read
  as invalid. It also has no `as_of` and no typed-unknown for quiet managers. Decision:
  **build** `server/services/people/profile-reader.js`. It becomes the one reader, and
  moving the other five readers onto it is later PEOPLE-01 work (not in this PR).
- `manager_notes` has no schema in this repo and no reader (EXISTING-SYSTEMS-INVENTORY.md §H).
  The reader accepts two shapes: a `nick_override` column, or `kind='nick_override'` key/value
  rows. A LOCAL line prints the real table's column names (names only, no content).
- The campaign planner (#233) is pure over an adapter. The model goes in as
  `adapter.counterparts`. With it absent the planner runs exactly as it does today (tested).

## 1. Tests (RED first)

`test/people-profile-reader.test.js` (6) and `test/counterpart-model.test.js` (9), on
`test/fixtures/people-chat.mjs` (a fixture chat DB with made-up people) and the
existing made-up four-team league.

RED (commit `5226e91d`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/people/profile-reader.js'
# tests 2  # pass 0  # fail 2
```

GREEN (the commit that adds this file): 15/15 new, plus `campaign-producer`,
`refresh-loop-steps` and `counterparty*` at 59/59 together.

## 2. What each test pins

| test | pins |
|---|---|
| typed unknown | quiet (< 30 messages) and absent profiles read `unknown` with a reason and carry no field values |
| 9/23 fields | `values_talk` etc. are read even though the old validator rejects them |
| roster_read fallback | a 9/18-shape profile still answers the untouchable / shopping questions |
| as_of versioned | rows built after as_of are invisible; the newest visible version serves; older ones go to `history` |
| nick_override | both table shapes; exclude / deprioritize / toughen; no table -> unknown |
| flag off | no `counterparts` on the adapter -> plan byte-identical |
| all quiet | no chat feature fires; the plan is today's; only the M6 anchor moves P(responds) |
| wants_player | the lift equals the logit shift exactly; stale talk (22 d) is zero; P(responds), targets and steps name it |
| untouchable | credible (kept claim, 2/3) -> never a target, never asked for; broken claim (1/3) -> asked, x(1 - 1/3) |
| shop credibility | follow-through inside 14 d counts; a proposal before the claim does not; an open claim is the prior |
| override | exclude -> in no plan, P(responds) 0; deprioritize -> x0.5; toughen -> ladder never above fair on his screen |
| contract | the entry with the model on passes `validateEntry`; partners carry reason chains |
| no identity | a counterparty with no chat identity gets a typed-unknown model; the M6 prior applies league-wide |

## 3. Liveness (mutants, run on the GREEN tree with the two new test files)

| mutant | result |
|---|---|
| M1 `stepAdjust` drops the wants lift | killed (1 fail) |
| M2 call site: planner stops filtering excluded targets (`!tiltOf(pid).exclude` -> `true`) | killed after the wide-budget assertion was added (it survived first: the top-3 slice hid it) |
| M3 planner drops the price cap filter | killed |
| M4 reader ignores `as_of` | killed |
| M5 broken untouchable claims not counted | killed |
| M6 a credible untouchable ask is scaled, not zeroed | killed |
| control: name resolver lowercases instead of normalising (same on fixture names) | survived, as designed |
