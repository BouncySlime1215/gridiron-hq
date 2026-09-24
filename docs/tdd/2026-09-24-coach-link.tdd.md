# TDD evidence: COACH-LINK, the COACH-ANCHOR extension (2026-09-24)

**Item:** COACH-LINK. Extends COACH-ANCHOR (`docs/handoff/local/COACH-ANCHOR.md` on
`claude/handoff-package-2026-09-22`, job 6 "MEMORY" and the grounding guardrail) with
(1) an entity map, (2) a `connect` tool and (3) answer memory with a `recall` tool.
**Base:** COACH-TOOLS PR #298 head, `claude/local-coach-tools-v3` at `c8beacbe`.
**Files:** `server/services/coach/entity-map.js`, `connect.js`, `recall.js`;
`server/migrations/098_coach_answer_memory.js`; wiring in `tools.js`, `verify.js`,
`ask.js`, `preview-mode.js` (header only); `scripts/coach-link-report.mjs`;
test `test/coach-link.test.js`.
**Commits:** RED `6f197b88`, GREEN (next commit), this file with it.
**LLM spend:** $0. Every Claude call in the test is `setAnthropicClientForTesting`.
**Environment:** cloud container, `npm ci` run (exit 0). Fixtures are invented; no real
league data. The real-DB numbers come from the `LOCAL:` lines in the PR body.

## RED

`node --test test/coach-link.test.js` on `6f197b88` (no entity-map/connect/recall):

```
COACH_LINK_METRIC answered=0/8 unverified_in_answers=0
  NOT  What has happened with C. Ruiz? -- connect: There is no tool called connect. ...
  NOT  What did Coach say about P(yes)? -- recall: There is no tool called recall. ...
# pass 0
# fail 1
# skipped 15
```

## GREEN

```
COACH_LINK_METRIC answered=8/8 unverified_in_answers=0
COACH_LINK_MAP entities=9 links=41 trusted=36
# pass 17
# fail 0
```

## What changed in the test between RED and GREEN, and why

The test was wrong in three places, found while going green. None loosens a check.

1. Two filters picked rows by `source`, which link rows share with event rows
   (`chat`, `screenshot`). They now filter `row_kind === 'event'`.
2. The stand-in model left `as_of` null on connect answers. verify.js rejected them with
   `missing_as_of`: connect reads `league_member_identity` and `nfl_news_events`, which
   the catalog marks hand-collected. That rejection is right. The stand-in now passes
   the entity row's `as_of`, which is what a real answer has to do.
3. The "fabricated answer is not kept" case asserted `verification.ok === false`. After
   the rejection the stand-in refuses, and a refusal-only answer verifies. The case now
   asserts that the 61% was rejected, that no claim shipped and that nothing was kept.

Added after GREEN, from a self-review: trade and pulse ids were matched against a set
mixing internal and ESPN ids, so a small ESPN id could match another player's internal
id. Fixed by resolving every trade id ESPN-first through `player-ids.js`
(`entity-map.js#tradePlayer`); covered by "a trade id is read as ESPN first".

## Rules this holds to

- **Labels only.** connect selects no text column: not `messages.text`, not
  `claim_text`, not `evidence_span`. The test puts `SECRET` in each and asserts it never
  reaches a row. Chat handles and person names never leave the module.
- **Attribution needs a trusted link.** A chat event is tied to a roster only through a
  `confirmed` or `exact` link (manager-identity.js#TRUSTED_CONFIDENCE).
- **Typed absence.** A missing chat DB, screenshot table or Sleeper league is
  `status: 'unknown'` with a reason, never zero.
- **Stale numbers do not restate.** recall serves a stale answer's words as
  `stale_claim_text` with no numbers, and verify.js grounds digits only from a fresh
  `claim_text` or a numeric served cell.
- **Flagged.** `GRIDIRON_COACH_LINK=1` or preview mode; `=0` vetoes preview. Off, Coach
  is offered exactly the tools it had and nothing is written to memory.
