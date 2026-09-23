# Trade Brain proposals: room to answer after Sonnet 5 thinking (2026-09-23)

## Audit (extend, not build)
- Producer: `server/services/trade-proposals.js` `liveCaller` → `server/services/claude.js` `callClaude`. There is one call site for the proposals model call and no other producer.
- Live defect on the local copy (not production): ai_usage row `trade_proposals:league-4 | claude-sonnet-5 | in 7996 | out 4000 | $0.056`. The page showed "the model ran out of output room before it wrote any proposals". Sonnet 5 thinks by default, and thinking counts toward `max_tokens` (4,000).

## RED / GREEN
- RED `bae91f67` "test: RED liveCaller has no room to answer after Sonnet 5 thinking": `not ok 40 - G2b` (sent.effort undefined, maxTokens 4000) and `not ok 41 - G2c` (claude.js has no output_config). 55 pass, 2 fail.
- GREEN `a69df806` "fix: GREEN proposals get low effort and room to answer after thinking": `callClaude` takes an optional `effort` and sends `output_config: { effort }`. `liveCaller` sends `effort: 'low'`, `maxTokens: 12000`. trade-proposals + llm-budget-per-league + trade-brain-surface: 81/81 pass.
- Mutants (tests at GREEN): M1 drop the output_config spread in claude.js → fail 1 (killed). M2 drop `effort: 'low'` in liveCaller → fail 1 (killed).
- API probe: `claude-sonnet-5`, `output_config.effort: 'low'`, max_tokens 600 → stop end_turn, 9 output tokens, text block. The field is accepted.

## Cost
The budget reserve rises from about $0.04+input to about $0.12+input per call (maxTokens × $10/M output). The per-league cap stays $0.50/day, which allows about 3 fresh writes a day per league; the cache is free.

## Nick's five questions
1. Well built? Yes: 2-line change on the one call path, pinned by 2 tests that kill both mutants.
2. Stats or made up? Not statistical. 12,000 is a guess sized for thinking plus about 1-2K of JSON; low effort is the documented control.
3. How we know: the live usage row plus the RED tests. Forward check: the next click on "Write them" should return proposals with stop_reason end_turn.
4. Pointed anywhere else? `effort` is opt-in, so other callClaude callers are unchanged.
5. How it unifies: one call path, one budget (llm-budget per-league key unchanged).
