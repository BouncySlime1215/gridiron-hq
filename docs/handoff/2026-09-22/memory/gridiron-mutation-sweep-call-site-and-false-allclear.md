---
name: gridiron-mutation-sweep-call-site-and-false-allclear
description: Two fleet lessons from the wiring-map mutation sweep — logic inside a CLI branch is unverified by construction, and a mutation that fails to apply reports as "survived".
metadata:
  type: feedback
---

Wiring map thread, 2026-09-22, building the unresolved-receiver ratchet
(PR branch `claude/wiring-map-8f96ur-receiver-ratchet`, head `6212253`).

**1. Every surviving mutation was at the call site, not in the unit.** Four
mutations inside `receiverRatchet` and `staleOrphanEntries` were all killed.
Two at the call site survived with all 13 tests green: passing `{}` instead of
`ann.accepted_unresolved_receivers` as the baseline, and `() => false` instead
of the pre-registered predicate. Either turns the checker off — one makes the
ratchet block on all 19 baselined sites, the other makes the stale report tell
a reader to delete a correct accept-list entry.

**Why:** `--check` is a CLI branch (`if (import.meta.url === …)`) that no unit
test runs, so anything decided inside it is unverified by construction, however
well tested the functions it calls are.

**How to apply:** mutate the call site, not only the unit. When a call-site
mutation survives, the fix is a smaller branch rather than a bigger test: lift
the decision into a pure exported function and pin what it decides — including
that it reads the key **by name**, since a near-miss key name is the mutation
that actually happens. Anyone with logic inside a CLI branch has this hole.

**2. A mutation that fails to apply reports as "survived".** The first attempt
at one of the two used a `sed` pattern that did not match the source. Nothing
was mutated, the suite came back 18/18, and that reads exactly like a surviving
mutation. Re-applied with an anchored replacement that asserts its anchor
exists, it killed immediately.

**How to apply:** confirm the mutation landed before reading its result — the
same discipline as [[gridiron-contradiction-test-rule]], applied to the sweep
itself. A sweep that silently no-ops is a false all-clear, which is worse than
no sweep.

Related: [[gridiron-gate-baselined-at-a-different-tip]],
[[gridiron-bespoke-tool-cross-check-rule]].
