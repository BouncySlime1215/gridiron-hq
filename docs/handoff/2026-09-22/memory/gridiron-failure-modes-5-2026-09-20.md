---
name: gridiron-failure-modes-5-2026-09-20
description: Page 5 of the gridiron-hq "healthy-looking and not working" catalogue and rules; entries from 07:03Z 2026-09-20 on that did not fit on page 4.
metadata:
  type: project
---

Continues [[gridiron-failure-modes-4-2026-09-20]] (earlier pages: [[gridiron-failure-modes]], [[gridiron-failure-modes-2-2026-09-20]], [[gridiron-failure-modes-3-2026-09-20]]).

**Catalogue (cont.):** (30) a route guard whose pattern is a double-escaped RegExp matches a literal backslash and nothing in the tree, so the "page is gone" test passes with the page re-added (UI b502852, third instance in one stack; rewritten as plain string checks over the whole client tree; rule: pin a guard with the thing it forbids present, and assert the walk found files so it cannot pass on an empty set); (31) a coordinator gate phrased at the heading level ("like everything else") reached a self-contained, tested deletion in an owner's own file and would have held a whole branch (collector job, migration 066, refreshLeagueRosters fix) behind an unrelated head (scheduler 06:58Z, /dev/usage; rule: state a gate's scope as the rows it applies to and the one change that spans files).

**(32)-(34), Trade Brain 07:02Z:** (32) counting fragment shapes instead of reading each row reported eleven ambiguous rows where two existed (fourth instance of the shape in one night; rule: the number in a status line is the number of rows read, not the number of rows scanned); (33) an orphan check that stops at one level keeps a chain alive (shoppingGuidance consumes positionLiquidity and nothing consumes shoppingGuidance; rule: consumers are counted transitively); (34) a user-facing string naming a route is a mention that becomes a lie on deletion (trend-watch.js:206 names "POST /trends/scan"; rule: grep the route's path in served strings before deleting it and edit them in the same commit).

**(35), Coach 07:05Z:** a "no production consumer" verdict on a budget line missed a consumer three hops away through a callback argument (llm-budget.js:43 trade_proposals: routes/trades.js:864-866 passes liveCaller(callClaude) into proposalsFor, which sets the feature name trade_proposals:league-<id> at trade-proposals.js:515, rendered by ProposalSlate.tsx:242). Rule: a feature key set from a string built at runtime is found by reading the call chain, not by grepping the key.

**(36), scheduler 07:06Z (corrects the claim behind (35); the 06:43Z "no consumer" verdict is CORRECTED, not deleted):** a docs sentence with a baked-in timestamp ("pre-built for that stage and currently dead code", docs/FANTASY-ENGINE-MASTER-PLAN.md:157) restated as a finding; the consumer had been built after the sentence (caught by Coach; the scheduler also took the line number from the doc, :39 for :43). Rule: a doc's claim is a pointer, not a citation; "currently", "not yet", "no consumer" in docs are re-verified against the tree before being repeated, including by the coordinator.

**(37), coordinator 07:08Z:** the coordinator stamped rulings by estimate a second time tonight (06:37Z and 07:08Z corrections, about 25 and 7 minutes ahead) and ran a cycle believing a reminder overdue when it had two minutes to run. Rule for the coordinator: read the clock from a tool result before stamping anything; list_triggers next_run_at is a fire time, not evidence that it passed.

Continues (entries from after 07:08Z on): [[gridiron-failure-modes-6-2026-09-20]].
