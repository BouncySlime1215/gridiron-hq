# JEV-01a: the Jev gateway as a shadow engine stage

Unit JEV-01a (ENGINE-SPECS.md "JEV-01: Jev anchors the loop", with the coordinator rulings of
9/23 5:10 PM ET and TRADE-INSANE-RND.md "JEV ANCHORS THE LOOP"). Cut from origin/main `12a6de9`.
New files only, plus one PRICING row and four wiring annotations. **No migration.**

## 1. Audit

- **Call path.** `git grep -n "experimental_evaluate\|typesafe-ai/jev" -- server scripts` on `12a6de9`:
  0 server hits; scripts only (build-manager-archetypes.mjs:166-172, news-line/jev_*.mts,
  live-market/jev_live_plays.mts, luck/jev_luck.mts, model-lab/jev_research_auditor.mts). The
  gateway reuses that path: `ai`'s `experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })`,
  authenticated by `AI_GATEWAY_API_KEY` (presence read only).
- **Answer shape** (`node_modules/ai/dist/index.d.ts:7608-7640`, `ai@7.0.105`): boolean
  `{probability}`, choice `{choice, probabilities}`, `usage.inputTokens`.
- **Balance.** `@ai-sdk/gateway@4.0.85` exposes `gateway.getCredits()` → `{balance, totalUsed}` as
  strings (`dist/index.d.ts:143-148, :932`). The gateway feature-detects it and records `unsupported`
  if a later version drops it.
- **Cost ledger.** `recordUsage` (claude.js:90) prices through `costOfUsage` → `requirePrice`, which
  refuses unlisted models. Added `'typesafe-ai/jev'` to `PRICING` at $0.042/M input, $0 output — the
  rate the scripts already use (build-manager-archetypes.mjs:39 `USD_PER_MTOK`). `reserveBudget` is
  not called (no cap, Nick).
- **Engine spine.** ENGINE-00a (#216, `appendEvents` / `writeState`) is **not on main**. The stage takes
  an injected sink `{appendEvent, writeState}` and refuses to run without one; `guardSink` enforces the
  one-writer rule for `jev.*` locally until #216's registry does it.

## 2. Files

| file | what |
|---|---|
| `server/services/jev/gateway.js` | the one client: `ask`, `checkBalance`, runaway monitor, `jev_call` / `jev_runaway` events, ai_usage row |
| `server/services/jev/questions.js` | registry, v1 each: `plays_sunday`, `role_change`, `p_accept`, `sim_contradiction`; 2 phrasings (arms) each |
| `server/services/jev/state.js` | as-of pack from a snapshot view; managers → `MANAGER M<n>`, names scrubbed from values and text |
| `server/services/jev/stage.js` | `runJevStage`: pack → 2 arms → `jev.<qtype>.jev_<arm>` rows (weight 0, shadow) → {p, action, cited} |
| `server/services/llm-budget.js` | one PRICING row |
| `test/jev-01a-gateway.test.js` | 16 tests, gateway mocked |

## 3. RED → GREEN

RED commit `8245e35`: `ERR_MODULE_NOT_FOUND` for `server/services/jev/gateway.js` (0 pass, 1 fail).

GREEN: `node --test test/jev-01a-gateway.test.js test/llm-plumbing.test.js test/trade-proposals.test.js
test/coach-ask.test.js` → 118 pass, 0 fail. Spec RED items:

| spec RED | test |
|---|---|
| (1) only jev/gateway.js uses experimental_evaluate under server/ | `only server/services/jev/gateway.js imports experimental_evaluate` |
| (2) jev.* has producer 'jev' only | `a jev.* write under another producer throws…` |
| (3) snapshot at t has nothing after t | `the state pack built at t carries no row or event after t` |
| (4) 1 jev_call + 1 ai_usage at tokens × price; 5xx → ok=0, no state row | two tests |
| (5) 60 calls/min vs 2/h median raises jev_runaway, 61st not blocked | `60 calls in a minute…` (+ repeat-hash, balance-to-zero tests) |
| (6) no key → `jev.status='no_key'` with reason, no probability | `without AI_GATEWAY_API_KEY…` |
| (7) no real name in any logged payload | `no manager name appears in the prompt, the events or the state rows` |
| (8) no network | every test injects `evaluate`/`getCredits`; offline-guard.mjs is loaded by `npm test` |

Two GREEN-phase corrections, both in the open:
- The RED grep test caught a doc comment in `questions.js` naming `experimental_evaluate`; reworded.
- The RED output test expected every question to cite player p1's sim row #11. An offer question
  reads the counterparty's and team context, not p1's rows, so that expectation was wrong; it now
  asserts #11 is cited by the player questions and not by `p_accept`.

## 3b. Liveness: mutation sweep

`scratchpad/mut.sh` applies one perl substitution, runs `test/jev-01a-gateway.test.js`, restores the file.

| mutant | result |
|---|---|
| M1 state.js as-of row filter off | killed (2 fail) |
| M2 state.js as-of event filter off | killed |
| M3 state.js name scrub → identity | killed |
| M4 stage.js one-writer check off | killed |
| M5 stage.js no_key branch off | killed |
| M6 gateway.js ai_usage write skipped | killed |
| M7 gateway.js rate multiple 5 → 50 | killed |
| M8 gateway.js hourly alert dedupe off | killed |
| M9 stage.js disagreement 0.25 → 0.6 | killed |
| M10 stage.js as-of dedupe off | killed |
| M11 stage.js WEIGHT 0 → 1 | killed |
| M12 **call site**: stage passes `stateIds: []` to `gateway.ask` | **survived first**; added the "each jev_call names the state rows Jev read" assertion; now killed |
| C1 not-applied control (pattern absent) | NOT APPLIED, as designed |
| C2 surviving control (dead `const bool2 = null`) | survived (0 fail), as designed |

## 4. Not built here (by spec or dependency)

- Daemon registration (ENGINE-00b not built) and the real sink (ENGINE-00a #216 not merged).
- The non-Jev cross-check arm (ruling 1: Claude via claude.js, under the in-app daily cap). This unit
  builds Jev's two self-check arms only.
- `pitch_framing` and `startsit_tiebreak` question types (the task named four; both need OFFER-01 /
  the sim's paired SE as inputs).
- Trailing-7-day hourly median defaults to the process's own send log; swap in an engine_events reader
  once #216 lands.
