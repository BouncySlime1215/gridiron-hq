# COACH-CHAT: real conversations with context, and the Coach 502

## Unit
COACH-CHAT. Nick: "I want Coach to allow a real conversation rather than yes/no. Keep some
context of a conversation." Scope update the same night: the API is on, and a live Coach
turn answered 502.

## The 502 (root cause)
A live turn on `claude-sonnet-5` ("In one sentence, what is the biggest weakness on my
roster right now?", league 4) spent rounds 1-5 on `catalog_lookup` / `sql_select`. Round 6
is sent with `tool_choice: none`; the model returned `[thinking]` only, `stop_reason:
end_turn`, no text block. `parseJson` read the first text block, found none, and the route
answered 502 "AI response contained no JSON text block".

## RED (origin/main `claude.js#parseJson`, recorded response shapes, no text from the call)
```
thinking-only final round (the live 502) THROWS: AI response contained no JSON text block
answer split over two text blocks THROWS: Unexpected end of JSON input
object inside a sentence THROWS: Unexpected token 'H', "Here: {"a":1}" is not valid JSON
```

## GREEN
- Every Coach round asks for the answer schema (structured outputs, `output_config.format`
  json_schema), so the answer text cannot come back as prose, a fence or nothing.
- `parseJson` reads every text block after thinking, strips fences, finds the object inside
  a sentence, and says what came back (block types, stop_reason) when there is no text.
- A turn that ends on thinking alone gets one answer-only round; a second empty turn is a
  502 that says what came back.
- Live, same question, same DB copy: HTTP 200, verification ok, an honest refusal (the
  table it needed has no rows on that copy), $0.054.

Tests: `test/coach-chat-model.test.js` (parse shapes, schema on every round, the extra
round, chat context carry, model routing, cost under the Coach budget, spent budget),
`test/coach-chat.test.js` (threads, retention, focus, $0 follow-ups, rules, reopen/new),
`test/coach-chat-drawer.test.js` (the drawer rendered: bubbles, chips, action cards,
thinking, remount, "I sent it", New).
