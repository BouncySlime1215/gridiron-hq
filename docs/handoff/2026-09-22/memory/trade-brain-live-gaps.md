---
name: trade-brain-live-gaps
description: No trade proposal can ever return — liveCaller hands proposalsFor an Anthropic message object where it wants the text — plus the model id and the shared budget bug (found 2026-09-19).
metadata:
  type: project
  modified: 2026-09-19T16:35:32.412Z
---

Audited 2026-09-19 against branch `claude/project-thread-3ldl77-docs`, whose
code matches the Fly deployment. 130 tests pass and none of them could reveal
this, because every one runs against fixtures.

**No trade proposal can ever return, and each attempt spends money.**
`liveCaller` (`server/services/trade-proposals.js:418-425`) returns what
`callClaude` returns, which is an Anthropic `Message` **object**
(`server/services/claude.js:246-248`). `proposalsFor` does
`typeof raw === 'string' ? JSON.parse(raw) : raw` (`:511`) then demands
`Array.isArray(parsed)` (`:516`). The array check always fails, so the route
returns `{proposals: [], refused: true, reason: 'the model response was not a
list of proposals'}`. The call is made, the money is spent, the answer is
thrown away. `claude.js:268` exports `parseJson`, which the sibling route
`server/routes/trades.js:986` uses correctly; `liveCaller` never calls it.
Refusals are deliberately not cached (`:506`, `:521-525`), so it re-spends on
every page load until the daily budget is gone.

Proved by driving the real path with a correctly shaped envelope. The existing
test stubs `callClaude` returning the **string** `'[]'`
(`test/trade-proposals.test.js:397-403`), which is why 38 green tests missed
it. Consequence: `verifyProposals` (100+ lines, 38 tests) has never once run
against real model output.

**Model id.** Proposals use `claude-sonnet-5` (`trade-proposals.js:421`, priced
in `server/services/llm-budget.js:34`). Do NOT read the model from
`/api/dev/status` — `server/routes/dev.js:26` hardcodes
`claude-haiku-4-5-20251001`, the `callClaude` default, not the proposals model.

**Budget.** `budgetKeyFor` (`llm-budget.js:126`) truncates the feature key at
the first colon, so `trade_proposals:league-1` … `league-5` all draw on ONE
$0.50/day pool rather than $0.50 each.

Fixed in the branch `claude/project-thread-3xqh5l-proposals-live`. Verify live
with `scripts/verify-trade-brain-live.mjs --proposals` (PR #18). See
[[trade-brain-never-runs]] and [[fly-deployment-outside-repo]].
