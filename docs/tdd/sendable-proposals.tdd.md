# TDD evidence: sendable-proposals (WA Trade Brain, stage 5 of 5)

Source: `docs/FANTASY-ENGINE-MASTER-PLAN.md` D4, the **AI pass** paragraph:

> **AI pass (cheap):** once per league per day, Sonnet 5 turns the top ~12
> numeric ideas into 5-8 **sendable proposals**: the package, the one-line
> why-they-say-yes in their terms, the opening message in Nick's voice, ask /
> fair / floor, send now or wait-until with the reason, the one risk, and the
> data it leaned on. It may drop or merge ideas; it may not invent players or
> numbers (verified after the call). Cached per league-day.

Built in a Claude Code cloud session, 2026-09-19, on top of `value-and-acceptance`
(`32faf5f`/`180b3a9`). Same environment limits as that stage: **no database and no
Anthropic key in this box**, so the live Sonnet call is never exercised here and
the model's output quality is not evidenced by anything below. What IS evidenced
is everything around the call — the verifier, the budget gate, the cache, and
every refusal path — because those are pure functions or fixture-backed and are
where a bad call actually becomes a wrong number in front of Nick.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      --test-concurrency=1 test/trade-proposals.test.js

LLM spend: $0 — the caller is injected in every test.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `llm-budget.js` | **Already ships `trade_proposals: 0.50`** in `DEFAULT_DAILY_BUDGETS_USD` (`:39`) with a documented `trade_proposals:league-<id>` key convention (`:11-14`), enforced once at `claude.js:241` via `reserveBudget`. It has **no production consumer** — built for this stage and dead until now. | **Use it as-is.** Pass `feature: 'trade_proposals:league-<id>'` and the per-league daily cap is enforced for free. No new budget code. |
| `compute-cache.js` | An in-memory `Map` keyed on a data fingerprint. Correct for recomputable answers; wrong here, because a restart would re-spend real money against a $0.50/day cap. | **Do not use** for this. |
| Migration `057_ai_usage_cost_and_cache` | Despite the name there is **no response-cache table** — its "cache" is prompt-cache *token accounting* (`cache_read_input_tokens`). | Noted so the next reader does not go looking for a table that was never there. |
| `nfl_news_event_extraction_cache` (migration 019, read/written `nfl-news-events.js:78,83`) | A real persisted LLM cache already in this codebase, keyed `(content_hash, extractor_version)`. | **Follow this pattern** rather than inventing a second one. Content-keyed beats day-keyed: an unchanged slate does not re-spend, and a changed prompt invalidates by construction instead of by someone remembering to bump a date. |
| `trade-verify.js#proposeVerifyRetryTrade` | A propose/verify/retry loop with a structural two-call cap, but its judge (`judgeTradeVerdict`) is verdict-vs-simulation specific. | **Reuse the shape, not the code.** This stage's verifier answers a different question: did the model invent anything. |
| `trade-engine.js#tradeIdeas` | The one entry point; everything it returns has already passed the edge test, and now carries `acceptance` from the previous stage. | **Consume it. Do not extend it.** This stage adds no field to the idea object and does not touch `trade-engine.js`. |

## Gates, pre-registered before any test or implementation was written

- **G1 nothing invented.** Every player named in a proposal must appear in the
  source ideas, and every number must be one the source ideas contain. A proposal
  that fails is **rejected whole**, never silently repaired — a repaired proposal
  is a fabrication with the evidence filed off.
- **G2 the call is bounded.** At most one model call per league per slate. The
  budget key is `trade_proposals:league-<id>`; a refusal from `reserveBudget`
  propagates as a refusal, never as a silent skip or an uncached retry.
- **G3 the cache is persisted and content-keyed.** An unchanged slate returns the
  stored answer and spends nothing. A changed slate, or a changed prompt version,
  is a miss. A process restart does not re-spend.
- **G4 honest degradation.** No ideas, no API key, a malformed response, or a
  response with the wrong shape each produce a stated reason and no proposals —
  never a partial parse presented as a result.
- **G5 the edge test survives the AI pass.** Every returned proposal traces to at
  least one source idea by id, so the model cannot merge in, or invent, a package
  that never passed the edge filter.
- **G6 the shape D4 asks for.** Each proposal carries package, why-they-say-yes,
  opener, ask/fair/floor, send-now-or-wait with its reason, the one risk, and the
  data it leaned on. A missing required field rejects that proposal.

## RED -> GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | (pending) | |
| GREEN | (pending) | |

## What this does NOT establish

The model call itself is never made here. Nothing below is evidence that Sonnet
writes a good opener, picks the right five ideas, or phrases a why-they-say-yes
that lands with a real manager. It is evidence that **if it invents a player, a
number, or a package, that output does not reach Nick** — and that the cost of
finding out is capped and does not repeat on a restart. The live pass belongs to
the Mac session, with the rest of the list in `TASKS.md`.
