---
name: usage-is-priority-one-2026-09-22
description: "Nick's 2026-09-22 18:16Z standing rule: monitoring usage efficiency is priority one, above all else, without losing accuracy or missing small things."
metadata:
  type: feedback
  modified: 2026-09-22T18:18:47.375Z
---

**Nick, 2026-09-22 18:16:07Z** (cmsg_01YAsw8AnFv4ioRMQw8dfPmTWxz7wC5vFLCTEe7cMso3FB):
*"i want u to monitor all of the usage and usage types pls - we have the 200/m
plan thats 20x usage ... YOUR #1 priority above all else is to monitor this ...
make sure that we are using our usgae limit efficiently while not killing
accuracy or missing small things. I want all my work done and mapped out
properly but also with this token montering. speed and efficney"*

**Why:** the fleet is being cut to five threads plus two auditors, and the
budget has to carry 24/7 operation for a week without hitting the weekly cap.
He asked for efficiency **and** thoroughness in the same breath — this is not
licence to cut corners on verification.

**How to apply (concrete, from what actually burned budget on 2026-09-22):**

- **CI is the gate; do not duplicate it locally.** A full `npm run check` is
  ~8 minutes and ~3,500 tests. Once #129 folded `check:wiring` into `check`,
  one CI run covers it. Run the local gate only when the **tree moves** in a
  way CI has not seen.
- **Never poll.** PR events, task notifications and coordinator relays all
  wake the session on their own. Ending the turn *is* how you wait. A `sleep`
  loop or a repeated status check spends tokens to learn nothing.
- **Batch the git work, then let CI fan out.** Rebasing/merging four branches
  and pushing all four costs one round of CI in parallel, not four in series.
- **One reply per milestone.** Progress goes in the status checklist, which
  costs a fraction of a reply and is what the user actually watches.
- **Do not re-read a file you just wrote** to confirm the write.
- **Read targeted, not whole.** `grep -n` with a line range beats dumping a
  2MB diff; one such mistake persisted 2.1MB to disk and taught nothing.

**What efficiency does NOT license**, because he asked for both:
- Skipping the contradiction test on a bespoke zero. Four defects in one day
  had that shape. [[falsy-return-read-as-a-real-negative]]
- Skipping the call-site mutant. It survived twice on the same file.
  [[injected-predicate-hides-the-wiring]]
- Quoting a figure without its tree. [[cite-the-subtree-not-the-write-tree]]

Those three cost minutes and each caught something a full re-run would not
have. The re-runs are what to cut.
