---
name: gridiron-failure-modes-3-2026-09-20
description: Page 3 of the gridiron-hq "healthy-looking and not working" catalogue and rules; entries from 06:43Z 2026-09-20 on that did not fit on page 2.
metadata:
  type: project
---

Continues [[gridiron-failure-modes-2-2026-09-20]] (page 1: [[gridiron-failure-modes]]).

**Catalogue (cont.):** (9) a test that mounts a router on its own app cannot see the real mount table, so a deleted mount stays green (test/decision-inbox.test.js:47 and test/legacy-route-security.test.js:75 mount the decision-inbox router themselves; server/index.js:46 is unread by tests; scheduler, 06:32Z). Rule: one test must go through server/index.js's mount; a mount removal and its route deletion land in one commit (wiring map carries index.js:46 and :137 as a stated two-line one-editor exception, 06:43Z).

**(10)-(12), fantasy plan's own tests, 06:33Z, all found only by mutations that changed no test:** (10) a test comparing a rounded number to an unrounded one can never fail; (11) a fixture that saturates every input (clamp01) or holds a feature constant (fourteen weeks everywhere, so weeks_left standardises to zero and its coefficient dies) puts a feature in the model with no effect; (12) a status.present check that cannot reject anything the load accepted. Rule: a mutation that changes no test is the only instrument that finds these; run it on every fixture-driven fit test.

**Rule (10), injection standard (06:57Z, project-wide; also in [[gridiron-evidence-file-form]]):** an injection row names its file hashes (SHA-256 before and after), its one named test that must go red, and a NO-OP control row whose pattern is absent; a full check measured under a tree being edited is void (Google sign-in 06:38Z voided its own first check for this).

**(13)-(14), Trade Brain 06:36Z (its own numbering 11-12):** (13) fixing one registry entry and not reading its neighbours (SIGNAL_SOURCES.chat.refreshed carried the same false "every refresh tick" cadence as tx; rule: a defect in a registry entry is a reason to read the others); (14) a "no rows" assertion against a fixture that has rows, so a branch hung off `available` changes nothing asserted (H6, after C3/T3: four occurrences in one night; rule: the fixture must put the test strictly inside the branch; memory [[unreachable-branch-no-assertion]]).

**(15)-(16), wiring map 06:41Z (coordinator's numbering 13-14):** (15) an outbound-call extractor that needs a marker (`}` or `://`) left of the path misses a leading literal path, and the miss pointed at deleting live code (nine routes dialled by bootstrap-data.mjs:97-113, league-chat upload, auth tunnel-url were on the dead list; rule: D3's hand grep of scripts/ and package.json per route before any cut is the backstop); (16) two wildcards sliding past each other in a route/call matcher (route parameter vs call interpolation in opposite positions) produce a false "called" verdict with no file named (rule: suppression must not happen before evidence is collected; reject the crossing only).

**(17)-(18), UI 06:41Z (coordinator's numbering 15-16):** (17) a hook's tests read the hook's own source and pass while nothing imports it (useNumberRoll; rule: one test asserts a use exists); (18) a threshold set in display units against a wire value scaled by 100 silently suppresses every event (formatValue scales percentages by 100; rule: state the unit of every threshold).

**(19), scheduler 06:42Z / coordinator 06:43Z (coordinator's numbering 17):** a literal API path in a docs or comment line read as a caller sends someone building a route nobody asked for (docs/tdd/llm-plumbing.tdd.md:104 names /api/dev/llm-budget with no route behind it). Rule: a string that looks like a call site is not one; only a dial inside a call expression or an executable command counts (DIALLED, not NAMED).

Continues (entries from 06:46Z on): [[gridiron-failure-modes-4-2026-09-20]].
