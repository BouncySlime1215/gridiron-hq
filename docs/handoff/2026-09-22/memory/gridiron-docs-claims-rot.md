---
name: gridiron-docs-claims-rot
description: A "currently dead code" / "not yet wired" / "no production consumer" claim inside a gridiron-hq docs file is an assertion about a PAST tree and ages into a false statement silently — re-verify against the code before repeating it.
metadata:
  type: feedback
  modified: 2026-09-20T07:10:00.000Z
---

**Made this mistake 2026-09-20 07:05Z and it is worth one file.**
`docs/FANTASY-ENGINE-MASTER-PLAN.md:157` says `llm-budget.js` "already ships
`trade_proposals: 0.50` ... pre-built for that stage and **currently dead
code**". I read it, and relayed it to the coordinator as a finding — an
attached-and-never-read — without checking the consumer.

It is consumed, and has been for some time. Verified end to end:
`llm-budget.js:43` (not `:39`, which was the doc's number too) ->
`routes/trades.js:844` `GET /:leagueId/proposals` -> `:864-866`
`proposalsFor(lg.id, { call: liveCaller(callClaude), cache: dbCache(lg.id) })`
-> `trade-proposals.js:515` `feature: trade_proposals:league-<id>` ->
`ProposalSlate.tsx:242` `api('/trades/<id>/proposals')` ->
`TradeBrain.tsx:8` import, `:126` render. Page to budget key, unbroken.

**The general form.** "Currently dead", "not yet wired", "no production
consumer", "nothing calls this yet" carry a timestamp the sentence does not
state. Each was presumably true when written; the consumer gets built
afterwards and nobody goes back to amend the doc. So the claim rots into a
false statement with nothing to mark it — the same silent failure as a stale
line number ([[gridiron-cite-the-shipping-tree]]), and the same shape as a
stale offset on a corrected findings list.

**How to apply.** Treat any such phrase in a docs or evidence file as a
POINTER to check, never as a citation to repeat. Verifying costs one grep for
the symbol plus one for its caller. Repeating it un-checked puts your name on
someone else's expired claim — and, on this project, risks somebody deleting
live code on the strength of it ([[gridiron-import-graph-orphans-are-not-dead]]).

The corollary already in use: **verify the consumer, not the producer.** A doc
saying a thing is unconsumed is a claim about consumers, so it is checked by
looking for consumers, not by re-reading the doc.
