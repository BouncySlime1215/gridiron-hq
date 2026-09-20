# TDD evidence: the Coach answering loop and its endpoint (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "Make sure coach is valid and doesn't hallucinate …
Also any question should be able to be asked … Coach Ui should be smooth. Give a cool
thinking/loading animation."
**Slice:** 4 of the Coach rebuild — the loop that turns a question into a verified
answer, the endpoint that serves it, and the trace the UI animates.
**Files:** `server/services/coach/ask.js`, `server/services/coach/audit.js`,
`server/routes/coach.js`, `client/src/components/coach/coach.types.ts`; tests
`test/coach-ask.test.js`, `test/coach-route.test.js`.
**Commits:** RED `a18996e` and `45cb1b0`, GREEN `31680f9`, mutation-driven tests
`78ce279` and `56ced08`, this file after them.
**LLM spend:** $0. Every Claude call in both suites goes through a stand-in client
(`claude.js#setAnthropicClientForTesting`, `server/services/claude.js:132`). No network,
no key, no spend.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0). No live read, no live write.

## 1. Audit: what "doesn't hallucinate" has to mean mechanically

Slices 2 and 3 built the two halves — a ledger of everything retrieved, and tools that
put real service answers into it. This slice is where they bite, and the design question
is what happens when the model writes a number anyway.

There are three answers available and only one of them is honest.

1. **Soften it.** Hedge the sentence, add a disclaimer, ship it. This is what most
   assistants do and it is worse than useless: the reader still sees the number.
2. **Ask the model again and hope.** A bare re-roll. `nfl-page-explain.js` does not even
   do this — it ships the first draft (`nfl-page-explain.js:88-133`).
3. **Name every failure, give it one chance to fix them, and if it cannot, do not show
   the claims at all.** Say which numbers could not be traced.

This slice does the third. The correction turn is not "try again" — it lists each
violation with the number, the sentence it appeared in, and what would fix it, so the
retry is actionable rather than a dice roll. M34 replaced it with a bare re-roll to
confirm the distinction is tested.

The second failure is not softened either: the claims are dropped and replaced with a
refusal naming the numbers. M36 shipped the claims alongside the refusal and two tests
caught it.

## 2. What was built

**`ask.js` — `askCoach({question, context, leagueId, onEvent, model})`.** Up to six tool
rounds against `claude-sonnet-5`, 1,500 output tokens, the catalog summarised one line
per table into a cached system prompt (`cacheSystem: true`, feature `coach:answer`). On
the last round `tools` is omitted so the model must answer in text rather than ending on
a lookup that will never run — M37 left the tools in place and a test caught it.

The answer shape is `{claims: [{text, cites}], refusals: [...], as_of}`. It goes to
`verifyAnswer` from slice 2. If it passes, it ships. If not, one correction turn. If the
second attempt fails too, the claims are discarded and `refusalFor(verification)` says
what could not be traced:

> Coach could not trace 2 numbers (14, 41) back to anything it retrieved, so it is not
> showing the answer. Ask again more narrowly, or ask what Coach does read about this.

**Errors are sorted into two kinds and this is the load-bearing line.** A refusal from
the query layer, a SQL error, a bad tool argument and a ledger error all go back to the
model as a `tool_result` with `is_error`, because each is information it can act on —
the boundary is worth knowing and hiding it would make the next round guess again.
Anything else throws. A missing table means a layer has gone inert, and handing that to
the model as "here is an error, carry on" is how this app has twice shipped a page that
kept printing numbers after its data layer died. M39 widened the expected set to
everything; the test that now kills it drops the view `who_plays` reads, asserts the
question fails, and puts the view back.

**The trace is the animation.** `onEvent` emits `understood`, `planning`,
`query{running|done}`, `computing`, `refused`, `drafting`, `checking`, `rejected`,
`answer` — what actually happened, in order, with row counts, tables and timings. Nick
asked for a thinking animation; this is a real trace rather than a decorative spinner,
and a test asserts the order and content.

**`audit.js`** writes every answer to `coach_answers`, verified or not. The rejected ones
are the point: `coachGroundingRate()` turns "doesn't hallucinate" into a number that can
be watched over time rather than a claim made once in this document.

**`routes/coach.js`** — POST `/ask` behind a signed-in session and 12 requests a minute,
2,000-character question, 16,000-character page context. With `Accept:
text/event-stream` the trace streams and the stream ends with a `result` event carrying
the same JSON the plain POST returns. Once the stream is open an error is an event, not
a status code, because a stream that simply stops is the silent failure this app keeps
finding. GET `/catalog`, `/answers` and `/grounding` expose what Coach can see and how
often the check has stopped something.

**`coach.types.ts`** is types only — the shape of every event, the ledger, the verdict,
and `resolveCite(ledger, cite)`. Everything else under `client/src/components/coach/` is
the UI thread's, so this slice ships the contract and not the component.

## 3. RED and GREEN

RED `a18996e` (loop) and `45cb1b0` (route): both suites written against modules that do
not exist; 0 pass.
GREEN `31680f9`: 21 tests pass, 0 fail. The mutation runs below forced two more and the
suites stand at **23 pass, 0 fail** (13 loop, 10 route).

## 4. Mutation table — every injection APPLIED, by hash

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/ask.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. **The literal text of every
row's injection is quoted in `docs/tdd/sweeps/EDITS.md`**, generated from those same spec
files with a staleness gate in the suite, so the quotation cannot describe an injection
nobody ran. The
SHA-256 pair is the point of the row: a diffstat says something changed, a hash pair says
exactly which bytes the suite was run against, so the row can be reproduced without
guessing at the injection. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — that happened once in this sweep (M12's
anchor had the wrong punctuation) and is the failure mode the control below exists for.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M34 | the correction turn is a bare re-roll that names no violation *(survived the first pass; the test in the last column was written for it)* | `ask.js` | `6ee760aa` → `12573e86` | 1 | `coach-ask.test.js` — the retry prompt names the exact numbers that failed, so it is actionable |
| M35 | the first draft ships whether or not it verified | `ask.js` | `6ee760aa` → `6a1cc159` | 5 | `coach-ask.test.js` — an ungrounded number is rejected, named back to the model, and fixed on the retry |
| M36 | a second failed check still ships the claims, with the refusal beside them | `ask.js` | `6ee760aa` → `c6bdb57d` | 2 | `coach-ask.test.js` — a sentence Coach cannot stand up twice does not ship |
| M37 | the last round still offers tools, so Coach can end on a lookup it will never run | `ask.js` | `6ee760aa` → `c641a501` | 1 | `coach-ask.test.js` — the loop is capped, and the last round is asked for an answer rather than another lookup |
| M38 | a refusal from the query layer ends the question instead of going back as a result | `ask.js` | `6ee760aa` → `d30c53e4` | 1 | `coach-ask.test.js` — a refused tool call is fed back to the model rather than failing the question |
| M39 | any error at all is swallowed into a tool result *(survived the first pass; the test in the last column was written for it)* | `ask.js` | `6ee760aa` → `d58d9016` | 1 | `coach-ask.test.js` — a fault that is not a refusal ends the question instead of becoming a tool result |
| M40 | the ask route stops requiring a signed-in user | `coach.js` | `acda2c01` → `ca2abef7` | 1 | `coach-route.test.js` — an unauthenticated request is refused before anything is spent |
| M41 | the ask route stops rate limiting *(survived the first pass; the test in the last column was written for it)* | `coach.js` | `acda2c01` → `bc8ed7a5` | 1 | `coach-route.test.js` — the ask route is rate limited, and says so before it spends anything |
| M42 | the route's own 400 falls through to the error handler instead of answering in JSON *(survived the first pass; the test in the last column was written for it)* | `coach.js` | `acda2c01` → `e59fe440` | 1 | `coach-route.test.js` — a question that is missing, empty or not a string is refused with 400 |
| M110 | the answer ships with an empty ledger, so no cite in it resolves | `ask.js` | `6ee760aa` → `dbdf6145` | 4 | `coach-ask.test.js` — a question answered from one query comes back verified, with the ledger behind it — and with it the route's "every cite in the answer resolves into the ledger that travels with it" |
| M111 | the trace reports no rows for a query that returned rows | `ask.js` | `6ee760aa` → `c0405605` | 1 | `coach-ask.test.js` — the events describe what actually happened, in order |
| M112 | the trace is streamed but never kept, so the answer carries no plan | `ask.js` | `6ee760aa` → `0b08933c` | 2 | `coach-ask.test.js` — the events describe what actually happened, in order — the returned plan is compared against the streamed one |
| M113 | an answer that is only a refusal is sent back for a retry it does not need | `ask.js` | `6ee760aa` → `7e0980d0` | 3 | `coach-ask.test.js` — a refusal with no claims is a valid answer and is not retried |
| M114 | Coach's spend is booked against the page-explain budget line | `ask.js` | `6ee760aa` → `7f138fb6` | 1 | `coach-ask.test.js` — spend is booked against the coach budget, and the model is one the price table knows |
| M115 | only a verified answer is written to the audit, so the rejections vanish | `ask.js` | `6ee760aa` → `7b66bd50` | 2 | `coach-ask.test.js` — every answer is written to the audit, verified or not |
| M116 | the system prompt no longer lists the tables Coach may read | `ask.js` | `6ee760aa` → `4d3b75b3` | 1 | `coach-ask.test.js` — the system prompt tells the model what it may read and how to cite |
| M117 | a question past the length ceiling is sent to Claude instead of refused | `coach.js` | `acda2c01` → `e54d5be3` | 1 | `coach-route.test.js` — an over-long question or context is refused with 413 rather than sent to Claude |
| M118 | the catalog route stops reporting how much of the catalog is in the database | `coach.js` | `acda2c01` → `3d395261` | 1 | `coach-route.test.js` — the catalog is readable, so the UI can say what Coach can and cannot see |
| M119 | the audit route answers with an empty list rather than the answers | `coach.js` | `acda2c01` → `20b27db2` | 1 | `coach-route.test.js` — the audit is readable, and the grounding rate with it |
| M120 | the stream ends with a result event that carries no result | `coach.js` | `acda2c01` → `ad655f42` | 1 | `coach-route.test.js` — asking for the event stream streams the trace and ends with the result |
| NC-ask | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `ask.js` | `6ee760aa` → `26a51cf7` | **0** | none — and that is the assertion |

**M34 and M42, the first two survivors.** The retry test asserted against the whole
message history, which contains the assistant's own rejected draft — so text naming the
violation was present whether or not the correction turn named it. The test now asserts
against the correction turn alone. M42 survived because the route's own 400 and the
error handler's 400 have the same status code; the test asserted the status and not the
body, so a JSON error silently becoming an HTML error page passed. It now asserts the
body. Both commit `78ce279`.

**M110 to M120, found by the union check.** A sweep that kills all of its own
injections proves only that those injections were well chosen; the question worth
answering is which tests would notice nothing if the code beneath them changed. The union
of the red titles across the first nine rows covered 11 of the 23 tests these two suites
run. Eleven more rows were written for the other twelve — the ledger that travels with
the answer, the trace and the plan being the same trace, a refusal-only answer not being
retried, the budget line, the audit write, the catalog in the system prompt, the 413, the
coverage on `/catalog`, `/answers`, and the `result` event that ends the stream. The
union now covers all 23, measured by:

```
python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/ask.json
python3 docs/tdd/sweeps/mutation-sweep.py --baseline \
  'test/coach-ask.test.js test/coach-route.test.js'
```

None of the eleven survived, so this pass produced no new tests — which is the result
worth having, since it means the twelve uncovered tests were asserting real properties
and simply had nothing aimed at them.

**M39 and M41, found in the second pass.** Nothing distinguished a refusal from a real
fault, so the whole "two kinds of error" design was untested — M39 made every error a
tool result and the suite was happy. Nothing exercised the rate limit either, so M41
removed it entirely with no effect. Both tests are in `56ced08`; the rate-limit test is
deliberately last in its file because it spends the minute bucket every other test in
that file shares.

## 5. The five questions

**Is this well built?** The loop is the app's own proven shape (`trades.js:705-887`:
produce, check, retry once) with the check made deterministic and the second failure made
honest. Two things are worth arguing about. The round cap of six is a guess bounded by
cost, not a measurement — nothing yet says how many lookups a hard question actually
needs, and `coach_answers` will answer that within a week of use. And the model is
`claude-sonnet-5` rather than the cheaper Haiku, chosen because the job is writing
correct cites under a strict schema, which is where a smaller model fails expensively;
that is a cost decision that should be re-taken once there is grounding-rate data on
both.

**Is it based on stats, or made up?** The loop computes nothing. Every number in an
answer came from `sql_select`, a service tool, or the ledger's eight operations, and the
verifier proves it before the answer leaves the process. The one number this slice
produces about itself, `coachGroundingRate()`, is a count over `coach_answers` rather
than an estimate.

**How do we know?** 23 tests, and 20 injections each stated above with the file's SHA-256
before and after it, all now killed, beside a no-op control that moves the hash and kills
nothing; four survived the first pass and produced four tests. Every one of the 23 tests
is red under at least one injection, measured rather than asserted. No test in either suite touches
the network — every Claude reply is scripted, which is also why the spend line is $0
rather than "small".

**Should this data be pointed anywhere else on the platform?** Two things, and one of
them is a correction to another thread. (a) The scheduler thread reported that the
`trade_proposals: 0.50` budget line (`server/services/llm-budget.js:43`) has no
production consumer. That is wrong and should not be acted on. The chain, each link
read in this container: `server/routes/trades.js:864-866` passes `liveCaller(callClaude)`
into `proposalsFor`, which sets `feature: trade_proposals:league-<id>` at
`server/services/trade-proposals.js:515`; `client/src/pages/TradeBrain.tsx:126` renders
`<ProposalSlate leagueId={activeId} />`; and that component fetches
`/trades/<id>/proposals` at `client/src/components/brain/ProposalSlate.tsx:242`. The
budget line is live. (b) Coach's own budget is `coach: 1.00` a day, which was set before Coach existed.
A Sonnet answer with a cached catalog prompt and a few tool rounds is not free; the
recommendation is **$3.00 a day**, which is Nick's call and is on his list rather than
changed here.

**How does it unify?** This is the slice where the three previous ones become one thing
the rest of the platform can call: a question in, an answer out, every number in it
traceable to a row, and the whole chain travelling with the response so the client never
has to decide whether to trust a sentence. The endpoint is deliberately separate from the
betting desk's `/explain/page` rather than a widening of it — that one explains the
screen, this one answers from the database, and they have different inputs, outputs and
failure modes — but they share the limits and the discipline.

## 6. What this slice does not do

`server/routes/coach.js` is **not mounted**. `server/index.js` belongs to the scheduler
thread under the one-editor-per-file rule, so the single `app.use('/api/coach', …)` line
has to come from them; until it does, the endpoint exists and is tested and no running
process serves it. There is no UI: the types are written and the component is the UI
thread's. The person-profile tools from slices 5 and 6 are not wired into the tool list
yet. And the round cap, the model choice and the budget are all provisional numbers that
`coach_answers` is designed to settle with evidence.
