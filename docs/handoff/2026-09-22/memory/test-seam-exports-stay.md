---
name: test-seam-exports-stay
description: Project-wide ruling 2026-09-20 — an export only tests import is kept when the code behind it is live; only dead-in-both-places exports go, with their tests.
metadata:
  type: project
  modified: 2026-09-20T06:51:15.723Z
---

The wiring map's `module-exports-only-tested` finding proposed "delete export
and test together". Coordinator ruled project-wide at 06:39Z on 2026-09-20:
**a test seam over live code stays; only a dead-code export goes, and then its
tests go with it.**

**Why:** the remedy as written trades real coverage for a tidier export list.
In `contingency.js` seven exports have zero production importers, but six of
them are live internal code with unit tests on it — `resetAvailabilityCache`
(12 test call sites, exists to stop one test's fit leaking into the next),
`roleTier` and `gapBucket` (threshold boundaries pinned one at a time in
`availability-role.test.js`), `weekDesignation`, `liveEspnStatuses`,
`ROLE_MAX_GAP`. Deleting those exports deletes roughly forty assertions over
code that still runs. Only `ESPN_DESIGNATION_LABEL` was dead in both places,
and the right fix there was un-exporting, not deleting: the mapping is live
inside the file, only its visibility was wrong.

**How to apply:** before acting on an export-only-tested finding, check whether
the symbol is referenced inside its own module. Live internally → un-export it
only if no test needs it; otherwise leave it and say so. Dead in both
production and tests → delete export and tests together. Never delete a test to
satisfy a wiring finding. Narrowing the export surface repo-wide (a test-only
accessor convention) is Nick's call, not a thread's.

The wiring map counted eleven for contingency.js; I could only find seven.
Four names were never produced. Treat a count you cannot reproduce as
unverified — see [[gridiron-failure-modes]] on verifying the consumer, not the
producer.

Related: [[contingency-durability-prior-flag]].
