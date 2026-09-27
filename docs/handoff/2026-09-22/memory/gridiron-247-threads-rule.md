---
name: gridiron-247-threads-rule
description: Nick's 07:34Z 2026-09-22 rule — the Auditor and BOTH R&D threads run 24/7, never idle; each arms an hourly self-trigger and pulls its own next unit.
metadata:
  type: feedback
  modified: 2026-09-22T07:58:36.841Z
---

**Nick, 2026-09-22 07:34:09Z + 07:34:28Z:** *"pls make sure the auditor andn R&D are working 24/7"* / *"both R&D"*. Server-verified message id `cmsg_01YAsw8AnFv4ioRMQw8dfPmT5cqaWo187zNcbUvaVH2gam` (relayed to all three threads 07:36Z).

**Why:** their value is continuous, not deliverable-shaped; all three had parked on an empty queue.

**How to apply:** each thread arms its own hourly `create_trigger` self-wake and pulls from a self-refilling backlog, reporting its pick in one line rather than asking. Ids in [[gridiron-threads-directory]].

- **Auditor** — spot-check rotation when the gated queue empties: (a) projections.js decay-weighted-to-raw denominator **ratio AND spread** — highest-value open measurement; no efficiency constant moves until it exists; measure and rule only, Fantasy plan owns edits to that file (CLOSED 07:43Z — see [[gridiron-denominator-correction-2026-09-22]]); (b) CLAUDE.md claim sweep vs origin/main 654ff93 (:61 already proved false; every false claim loads into every session); (c) push verification on any branch pushed in the last hour — green figure measured on the tree actually pushed.
- **Data & techniques R&D** — trigger `trig_01TmmVb3SUDjmL1ytumBjCMV`, hourly, next fire 08:13Z. Backlog: K.yards_per=34 submission to the Auditor, then BDB notebooks. **Nothing paid, ever.**
- **R&D integration & cleanup** — was the idle one. Push its three held commits (ce75775 RED / 1f37be6 GREEN / b6934cc measurements), arm a trigger, then sweep for a 4th feed-zero instance — off projections.js and nfl-weekly-feature-store.js per [[gridiron-file-allocation]].

**Second auditor: ADDED 07:52Z 2026-09-22** (coordinator's call, gated units were past three and four builder units were parked on gate-1 criteria). **Evidence Auditor** — thread `cmsg_01YAsw8AnFv4ioRMQw8dfPmT3qmhahWyZnNu4SCfUGc16M`, session `cse_012mT7CaxQcWsGgGqaj6PCqF`, claude-opus-5. Owns EVIDENCE INTEGRITY: the three untested `docs/evidence/` generators, the fixed-window pattern sweep, push-verification spot checks (rotation c), the CLAUDE.md claim sweep (rotation b). The first Auditor keeps everything statistical (models, projections, trade logic, k=34, the four parked Model-evidence-audit units). Statistical findings route Evidence Auditor → coordinator → first Auditor, never direct. Same three gates, same independence, never posts to Nick. Also under the 24/7 rule: arms its own hourly trigger.

Related: [[gridiron-chat-reserved-for-his-word-or-milestone]].
