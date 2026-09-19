# TDD evidence: LLM plumbing (2026-09-18, WA)

**Modules:** `server/services/claude.js` (every Claude call), new `server/services/llm-budget.js` (prices, spend, daily budgets), new `server/migrations/057_ai_usage_cost_and_cache.js`. Tests: `test/llm-plumbing.test.js`.
**Why:** the Coach and the trade-proposal pass (WA phase 2, WB) will call Sonnet 5 with a large, repeated context. Before this change the app could not price Sonnet, could not cache that context, and had no spending cap:
- `PRICING` knew only Haiku 4.5. Any other model fell back to Haiku rates, so the 35 Sonnet 5 `negotiation_profile` calls were reported at about half their cost.
- `ai_usage` had no cost column and no cache-token columns.
- Nothing stopped a feature from spending.

## Audit and decision (Discover → Audit → Decide)
- **Discovered.** `claude.js#callClaude` is the single entry point for server calls. It has 20 call sites across routes, services and one script (`scripts/build-negotiation-profiles.mjs`). `usageSummary` feeds the Dev Hub through `routes/dev.js`. `costOf` is imported by `nfl-ai-replay.js`, and `PRICING` by `dev.js`. `ai_usage` is created in the frozen schema fragment, so new columns need a numbered migration.
- **Defects found.**
  1. `usageSummary` priced the "by feature" and "today" totals with `costOf('default', …)`, which is Haiku, whatever the row's model.
  2. `daily` looked up `PRICING[model]`, which is undefined for Sonnet, so it also used Haiku.
  3. Unknown models were priced silently instead of being refused.
- **Decision: extend** `claude.js`; do not add a second client.
  - Prices, spend and budgets move into one new module, `llm-budget.js`. `claude.js` re-exports `PRICING` and `costOf`, so no importer changes.
  - The schema change is a numbered migration (057), per `server/db/schema/README.md`.
  - Budget settings live in the existing `app_settings` table, so they need no schema change.

## User journeys
- J1: As Nick, I want the Dev Hub to show what each AI feature really costs, at each model's own price.
- J2: As the Coach and trade-proposal builders, we want the stable system prompt and the situation brief or trade context cached, so repeat questions cost about 10% of the input price. We also want each call's cache reads and writes logged.
- J3: As Nick, I want the Coach capped at $1 a day and trade proposals at $0.50 a day, with a plain message when the cap is reached ("Today's Coach budget is used …"). I want to be able to change the cap in Settings.
- J4: As Nick, I want the costs already logged corrected, with a backup taken first.

## Gate (pre-registered in scratch `wa/llm-plumbing/GATE.md` before any code, test or production write)
| Check | Pass rule | Result |
|---|---|---|
| G1 | every unit and integration test in `test/llm-plumbing.test.js` passes (mocked client, no network) | **PASS**, 29/29 |
| G2 | the existing tests that load `claude.js` or the migrations still pass | **PASS**: page-explain 7/7, espn-connect 19/19, espn-draft-sync 12/12, draft-reconcile 16/16, nfl-news-events 8/8, nfl-prospective-collection 9/9, espn-connect-auth 6/6, migration-027 16/16, opener-placeholder 11/11, weekly-snapshot-mode 3/3, decision-inbox 17/17, model-registry-persistence 22/22 (rolls 057 back and forward); lint clean; `tsc --noEmit` clean |
| G3 | backup first and equal to the live table; afterwards Sonnet 5 = $2.2602 ± 0.0001 and Haiku = $0.0113 ± 0.0001; no row left without a cost | **PASS**: backup 47 rows, 499,731 input / 128,331 output tokens, same as the live table; Sonnet $2.260166; Haiku $0.011303; 0 rows without a cost |
| G4 | live cache check (spend cap $0.02): call 2 reads from the cache and costs less than call 1 | **PASS**: call 1 wrote 5,432 tokens to the cache ($0.013644); call 2 read 5,432 from it ($0.001150); total $0.0148 |

## Prices (verified on platform.claude.com/docs/en/about-claude/pricing, 2026-09-18), $ per million tokens
| Model | Input | 5-min cache write | 1-hour cache write | Cache read | Output |
|---|---|---|---|---|---|
| claude-sonnet-5 | 2.00 | 2.50 | 4.00 | 0.20 | 10.00 |
| claude-haiku-4-5(-20251001) | 1.00 | 1.25 | 2.00 | 0.10 | 5.00 |

The pricing page says Sonnet 5's $2/$10 is now its standard price: the increase to $3/$15 that had been planned for 1 September is cancelled.

## True spend to date (production `ai_usage`, after the correction)
| Feature | Model | Calls | Cost |
|---|---|---|---|
| negotiation_profile | Sonnet 5 | 35 | $2.2602 |
| nfl-news-typed-extraction | Haiku 4.5 | 11 | $0.0109 |
| player-verdict | Haiku 4.5 | 1 | $0.0004 |
| llm-plumbing:cache-check (this item, G4) | Sonnet 5 | 2 | $0.0148 |
| **Total** | | 49 | **$2.2863** |

The old reporting showed $1.1414 for the first 47 rows. Their true cost is $2.2715.

## Task report
1. **Prices and cost logging.** `PRICING` now covers Sonnet 5 and Haiku 4.5, with cache rates. An unpriced model is refused before the call. `recordUsage` writes `cost_usd`, `cache_read_input_tokens` and `cache_creation_input_tokens`. When the API reports the 5-minute/1-hour split of cache writes, each part is priced at its own rate. The message returned by `callClaude` carries `cost_usd`.
2. **Prompt caching.** Three options, all opt-in, so existing callers send exactly what they sent before (tested):
   - `cacheSystem: true` marks the system prompt as a cache breakpoint.
   - `cachedPrefix` is placed first in the first user turn with its own breakpoint; the question follows it. The caller's array is not mutated.
   - `cacheTtl` is `'5m'` or `'1h'`.

   A bad TTL, more than 4 breakpoints, or a first turn that isn't the user's all throw before the call.
3. **Budgets** (`llm-budget.js`).
   - **Budget key:** the feature name up to the first colon, so `coach:answer` counts against `coach`.
   - **Day:** Nick's local calendar day; the budget resets at his midnight.
   - **Defaults:** `coach` $1.00 and `trade_proposals` $0.50. Other features have no budget.
   - **Check before each call:** today's spend, plus calls still in flight, plus this call's estimated cost. The estimate is at the upper end: its whole request at the cache-write rate, plus `maxTokens` of output.
   - **Refusal:** throws `LlmBudgetError` (status 429, code `LLM_BUDGET_EXHAUSTED`) with a message the page can show as is. A failed call releases its reservation.
   - **Settings hook:** `setDailyBudget(key, usd|null)`, `getDailyBudget`, `budgetStatus`, `listBudgets`. A value of 0 blocks the feature; null returns it to its default; anything outside $0–100 is rejected with a 400. The values are stored in `app_settings`.
4. **Correction.** `recomputeUsageCosts({ backupTable })`:
   - backs the table up once and never replaces an existing backup;
   - reprices every row that has a price;
   - lists rows with no price instead of guessing.

   In production it ran after `ai_usage_backup_20260918` had been created on the original schema, and after migration 057 had been applied through `migrate()`, which records it in `schema_migrations`. Script and output: scratch `wa/llm-plumbing/correct-ai-usage.mjs` and `correction-output.txt`.

## RED / GREEN
| Commit | Stage | Evidence |
|---|---|---|
| f438724 | RED | 29 of 29 fail. `llm-budget.js` is missing, and with an empty stub every test fails on `claude.setAnthropicClientForTesting is not a function` |
| 76b9da3 | GREEN | 28/28, plus the G2 regression set |
| 409cd66 | RED | 1 of 29 fails. The live G4 call billed 5,444 input tokens (~12,650 characters, 2.3 characters per token: a number-dense brief). At 3 characters per token the pre-call estimate was $0.0108 against $0.0136 billed, so a budget that was nearly used up could be overrun by one call |
| 91c0780 | GREEN | 29/29. The estimate now uses 2 characters per token and gives $0.0162 for that request (the commit message says $0.0158; recomputed, it is $0.016235) |
| (this commit) | refactor | `requirePrice` exported and used by `callClaude`; still 29/29, page-explain, nfl-news-events and espn-connect green |

## Test specification
| # | Guarantee | Test |
|---|---|---|
| 1 | Published Sonnet 5 and Haiku 4.5 rates, cache writes and reads included; one table | `PRICING carries the published …` |
| 2 | Cache reads and 5-minute/1-hour writes are priced at the model's rates | `costOfUsage prices …` (2 tests) |
| 3 | The `(model, in, out)` signature is kept; Sonnet is not priced at Haiku rates; an unpriced model throws | `costOf keeps …`, `an unpriced model throws …` |
| 4 | Every call logs its cost and cache tokens; an unpriced model is refused before the client is called | `every call logs …`, `an unpriced model is refused …` |
| 5 | Caching is opt-in; the system prompt and a cached prefix are placed correctly; `'1h'` is passed through; bad requests fail before the call | 6 caching tests |
| 6 | Budget defaults, the key rule and today's spend (local day, own namespace only) | 3 tests |
| 7 | Refused before any money is spent; the worst-case estimate counts; the two budgets are separate; unbudgeted features are not limited; calls in flight hold their share; a failure releases its hold | 6 tests |
| 8 | The estimate does not undershoot a number-dense brief (measured live) | `the pre-call estimate does not undershoot …` |
| 9 | Settings hook: raise, zero, reset, per-feature, validation (400s), list | 4 tests |
| 10 | `usageSummary` prices each model at its own rate, including legacy rows with no stored cost | `usageSummary prices …` |
| 11 | The correction backs up first, corrects every priced row, leaves unpriced rows alone and never overwrites the backup | `recomputeUsageCosts …` |

## Known gaps and hand-offs
- **Not live until restart.** The web server and `scripts/refresh-live-data.mjs --loop` still run the old `claude.js` from memory. Until the integration pass restarts them:
  - the Dev Hub shows Haiku-rate costs;
  - the loop's hourly news-extraction rows are written without a cost (the new `usageSummary` and budgets price such rows by model when reading them).
  Migration 057 is already applied to production, so the restart does no schema work.
- **Settings UI and route.** `dev.js` and the Settings page are not in this item. The service hook is ready: `setDailyBudget`, `listBudgets`, and `usageSummary().budgets`. **WB** should wire a `PUT /api/dev/llm-budget/:key` route and a Settings control, and show the 429 message in the Coach.
- **Caching minimum.** The API skips caching silently for a prefix under 1,024 tokens on Sonnet 5 or 4,096 on Haiku 4.5. The Coach's ~1.5k-token situation brief caches on Sonnet 5 only together with the system prompt ahead of it. Check `cache_read_input_tokens` in `ai_usage`.
- **What the $0.50 trade-proposal budget covers.** A Sonnet 5 pass with a 15k-token context and `maxTokens` 8,000 reserves about $0.12–0.14 before the call. The past `negotiation_profile` calls averaged $0.065 each. Five leagues a day fits under $0.50 only if the builder caches the shared context and sizes `maxTokens` to the answer (WA phase 2).
- **Unexplained part of the past spend.** About $0.39 of the $2.26 went to 8 calls on 09-17 that stopped at exactly 3,000 output tokens (the script's old cap). Four of the 09-18 calls repeat an earlier call's exact input size, which looks like the script's retries. Worth knowing when the proposal pass is built.
