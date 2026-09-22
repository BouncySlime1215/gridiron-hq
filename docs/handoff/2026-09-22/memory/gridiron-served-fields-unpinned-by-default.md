---
name: gridiron-served-fields-unpinned-by-default
description: Every field a Gridiron HQ client reads is untested by default, because every test sits on the producer side of the join; the deletion sweep finds the category, confirmed by feature audit on PR #60.
metadata:
  type: project
---

**A producer's own unit test cannot see a defect in the consumer's contract.**
Confirmed 2026-09-20 by the feature-audit thread against their own PR #60, and it
is the stronger form of what `scripts/served-field-check.mjs` was built to measure.

The instrument: take a field a client actually renders, **delete it from the
response**, run the suite, and see whether anything goes red. Across ten branches
most did not. The real one:

- **#60 `week`** (`trade-engine.js:2591`), read at `MyTeam.tsx:233` as
  `scout?.week ?? 1`. Deleting it rendered **week 1 for the rest of the season**,
  with no error and no failing test. Pinned on their hold branch `eb55f1d`.

Other unpinned fields the sweep named: `#58` `fit_id`/`recency`/`volume_k`
(`projections.js:513-517`) and `through` (`season-sim.js:594`); `#61` `error` and
`reason` (`scheduler.js:165,168`); `#43` `availability_basis` (`news.js:252`) and
`slots_not_modelled` (`lineup-brain.js:641`).

**Four PRs — #52, #49, #46, #53 — touch modules that no test names at all.**
Every field they serve is unpinned by construction, which is a different fact from
"the new field is untested" and belongs in any coverage conversation.

**How to apply:**
- **Test the consumer, not the producer.** Producer coverage says nothing about
  whether a screen still works. This is the same lesson as
  [[gridiron-failure-modes]]' "verify the consumer" rule, arrived at from the
  test side.
- **A `?? default` on the client is what makes this silent.** The fallback turns a
  missing field into a plausible wrong number rather than an error, so the
  deletion has to be tried to be seen.
- **Treat it as a category, not a list of rows.** Every served field a client
  reads is unpinned unless something specifically pins it; the sweep enumerates
  which, it does not create the problem.

Related: [[gridiron-tdd-defect-injection]] · [[gridiron-failure-modes]] ·
[[gridiron-checker-unreadable-output]]
