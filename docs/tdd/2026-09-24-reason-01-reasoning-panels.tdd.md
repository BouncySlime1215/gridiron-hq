# REASON-01: reasoning panels for the War Room top card + deck

Spec: ENGINE-SPECS.md REASON-01, WAR-ROOM-UI.md v2 section 4 and 2.2 (typed
fields), on branch `claude/handoff-package-2026-09-22` under `docs/handoff/local/`.

## RED — `13be403`

`test/reasoning-panels.test.js` plus `test/fixtures/reasoning/plans.json`, with no
implementation in the tree:

    # Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/reasoning/produce.js'
    # tests 1
    # pass 0

## GREEN — the next commit

    node --test test/reasoning-panels.test.js
    # tests 14
    # pass 14
    # fail 0

## What the 14 tests pin

| # | test | what fails if it breaks |
|---|---|---|
| 1 | top card + 5-card deck only, one call per league | 8 cards in league 1 → 6 in the prompt, 2 dropped, 2 calls for 2 leagues |
| 2 | every panel is schema valid | `panelErrors` empty on all 8 panels; no reply table / no partner data → `unknown`, never faked |
| 3 | schema catches a failed section carrying a value | the WAR-ROOM-UI 2.2 rule "no value on failed/unknown" |
| 4 | grounding rejects an invented number | "64%" against `card.p_yes` = 0.38 → `ungrounded_number` `64`, section `failed`, no words, reason has no digits, rest of the panel ships |
| 5 | cite to a fact not in the plan | `bad_cite` |
| 6 | his side: labels only, never quotes | a quote-shaped chat label never reaches the prompt; a quoted span in `his_side` → `quote_in_his_side` |
| 7 | news check, 48 h window | only `n-recent` is sent (old and unrelated news are not); card marked `check_first` with its quote id |
| 8 | news id outside the window | `unknown_news_id`, and the card still says check first |
| 9 | confidence from fields | n=3 → `thin (n=3)`, calibration status "E1 pending", source `clone.accept` |
| 10 | unchanged card reuses its panel | 0 calls on an unchanged refresh; one changed card → one call with only that card |
| 11 | dry run | 0 calls, sections `unknown` with "Dry run" |
| 12 | cost logged per call (real callClaude, fake client) | one `ai_usage` row per league under `trade_proposals:league-<id>:reasoning`; run total = sum of rows |
| 13 | cost guard stops at the cap (real callClaude) | league 1's pot spent by refresh 1 → refresh 2 makes no call, logs `capped`, cards say the allowance is spent |
| 14 | zero budget | 0 client calls, both leagues `capped`, $0 |

## Design choices worth checking

- **Pot.** Calls are held against the existing per-league pot `trade_proposals:league-<id>`
  (`llm-budget.js budgetScopeFor`), the one Nick approved for Trade Brain-style
  reasoning. They share it with Trade Lab proposals. A separate `reasoning` pot
  would be a one-line change in `PER_SCOPE_BUDGET_FAMILIES` plus a default, and is
  Nick's call.
- **Confidence (section 5) never goes through the model.** It is assembled from
  `p_yes`, `p_yes_n` and the `clone.accept` calibration status, so it cannot be
  ungrounded.
- **Unchecked news counts against the card.** If the call is capped or failed and
  48 h news exists for a card player, `check_first` is true with those ids.
- **Grounding is verify.js, unchanged.** `factLedger` gives it the two methods it
  calls (`cell`, `handCollected`) over the card's flat fact map.

## Liveness: mutation sweep (tree `a58b9ea`)

Each mutant applied with `sed`, the suite run, the file restored with `git checkout`.

| mutant | result | tests that caught it |
|---|---|---|
| M1 unit: `verifyClaims` skips verify.js | KILLED (2) | invented number; bad cite |
| M2 call site: producer ignores the grounding verdict | KILLED (3) | invented number; his-side quote; news id outside window |
| M3 deck cap widened to 8 | KILLED (2) | top card + deck; schema valid |
| M4 budget refusal not recognised | KILLED (2) | stops at the cap; zero budget |
| M5 quote-shaped chat labels accepted | KILLED (1) | his side: labels only (first attempt was a syntax-error mutant and is not counted; re-run as a valid mutation) |
| M6 48 h news window dropped | KILLED (2) | 48 h news; news id outside window |
| M7 his-side quote rule off | KILLED (1) | his side: labels only |
| M8 panel reuse off | KILLED (2) | unchanged card reuses; stops at the cap |
| M9 unchecked news no longer counts against the card | KILLED (1) | news id outside window |
| C1 designed survivor: `THIN_OFFERS` 5 → 4 | SURVIVED, as designed | the fixture's n=3 and n=12 sit on both sides of either threshold, so the exact threshold is not pinned; it is a hand-set constant |
| C2 designed not-applied control | NOT-APPLIED, as designed | the sed pattern is absent; the sweep reports it rather than calling it a kill |

## Nick's five questions

1. **Well built?** Six small modules (largest `cards.js`, 173 lines), verify.js reused unchanged, typed fields per WAR-ROOM-UI 2.2, schema checked before anything is written, `npm run check` exit 0.
2. **Stats or made up?** Neither: this layer states no new number. Every digit in the words must sit in a cited field from the plans JSON (verify.js); confidence is copied from the fields, not written by the model.
3. **How we know:** the 14 tests and the mutation sweep above, on fixtures with a mocked model. Not run against a real plans file or a real model call: the campaign producer is not on main, and nothing paid was run. `THIN_OFFERS = 5` is a hand-set constant (guess).
4. **Pointed anywhere else?** No route, job or page reads the panels yet (wiring accept-list entries with a retirement condition). The only shared thing it touches is the `trade_proposals:league-<id>` daily pot.
5. **How it unifies:** it reads the campaign producer's plans JSON, writes panels keyed by league and card id for the War Room read path, and uses the same grounding (verify.js) and the same budget (llm-budget.js) as Coach and Trade Lab.

- Gap filled: ENGINE-SPECS REASON-01 had no producer on main (`d861c11`).
- Incumbent: none. `git grep -li "reasoning panel\|REASON-01" d861c11 -- server` returns nothing; control: `git grep -li trade_proposals d861c11 -- server/services` returns llm-budget.js and trade-proposals.js.
- Not covered: grading the panels' claims on what happened (spec "Grading"); Jev cross-checking probabilities; flips and targets (only the top card + deck); panels for cards opened later ("others on open").
- What would make it wrong: the campaign producer landing with a different plans shape than the two read here (`cards[]` or `acq.best/alternatives`); then `cardsForLeague` returns no cards and every league writes zero panels.
