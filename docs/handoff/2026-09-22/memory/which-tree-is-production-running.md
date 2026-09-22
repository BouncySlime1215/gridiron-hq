---
name: which-tree-is-production-running
description: origin/main is missing the whole model stack; the deployed build and the train both carry it. Test file content at a ref, never ancestry, against the squashed stack.
metadata:
  type: project
  modified: 2026-09-19T21:38:00.000Z
---

**`origin/main` is BEHIND both production and the release train.** It does not
contain `activeKVectorFor`, `isWeeklyRoleRecency`, `cutoffSafeKVector`,
`volumeKFits`, or `scripts/promote-volume-shrinkage.mjs`. On main,
`projections.js:369` resolves the fit with a bare `activeKVector()` and no recency
gate, so on that tree there is NO weekly/season-long path split. Anyone reasoning
about model behaviour from main tonight is reading the wrong tree.

On the train tree and on the **deployed build**, the same line is
`projections.js:461`: `activeKVectorFor(rr, { predictingSeason })`. Confirmed by
reading file content at both deploy-bracket commits, `20a10a5` and `78811b1` on
`cursor/betting-model-audit-fixes-1c85`. **So the path split is live on the machine
now; the deploy does not introduce it and no ordering constraint follows.**

**The shipping tree is `origin/claude/release-train-2yv3x6-proof` = `791b131`.**
Cite that, not a thread's own branch. On it: `projections.js:461` resolves through
`activeKVectorFor(rr, { predictingSeason })`; `shrinkage-fit.js:515-521` is the
guard; `player-week-engine.js:273` is the ONLY caller passing
`roleRecency: WEEKLY_ROLE_RECENCY`; and `season-sim.js`, `draft-assist.js`,
`ros-projection.js`, `routes/model.js`, `preseason-model.js` and
`ceiling-lineup.js` mention `roleRecency` zero times between them.

**The guard is NOT from #15.** The coordinator attributed `activeKVectorFor` /
`WEEKLY_ROLE_RECENCY` to #15 (`9db53ff`); `9db53ff` is a docs-only commit, 18 lines
in the promotion runbook, touching neither file. Proof that needs no archaeology:
the DEPLOYED build carries the guard and #15 is an unmerged draft. **So #15 can be
reordered or dropped without affecting the path split** — the opposite belief would
mean dropping #15 lets the promotion move the draft board and playoff odds.

**TEST FILE CONTENT AT THE REF, NEVER ANCESTRY.**
`git merge-base --is-ancestor <commit-that-added-it> <ref>` returned "no" for both
bracket commits and would have supported the opposite, alarming conclusion — that
the deployed build lacks the guard and that promoting before the deploy would move
the draft board and playoff odds. Wrong: against a SQUASHED stack the same code
lives under different commits on different branches. Use
`git show <ref>:<path> | grep <symbol>`. This is the second time tonight this trap
has fired; see [[gridiron-deployed-build-bracket]], [[detecting-branch-vs-deployed-drift]].

**Line numbers are the tell that two sessions are on different trees** (UI thread
had 332/168/166; this one 449/271/180). Settle WHICH TREE before arguing behaviour.

**Cache hazard on any after-read (UI thread's finding, verified sound).**
`memo()` at `routes/model.js:107-111` is an unbounded `Map` with no TTL, keyed
`proj:${through}:${scoring}` with **no fit id**, so a warm process serves
pre-change projections for the life of the process. The weekly engine caches
through an LRU (`MAX_ENGINE_CACHE = 32`) that evicts, so weekly entries recompute
and season-long ones never do. It does NOT bite tonight's season-long after-reads
(the guard makes stale and fresh identical there) but a cached answer reading as
"nothing changed" is this project's recurring failure.
- Clean bust is a **process restart**.
- **Do NOT use `POST /api/leagues/:id/sync`** as a cache-buster: it does call
  `clearModelCache()` (leagues.js:213) but also re-syncs `dynasty_values`, a
  control variable tonight. The other clearers (`POST /dev/refresh-all`, the full
  nfldata sync) are heavy repulls.

See [[shrinkage-promotion-blast-radius]], [[gridiron-migration-number-collisions]].
