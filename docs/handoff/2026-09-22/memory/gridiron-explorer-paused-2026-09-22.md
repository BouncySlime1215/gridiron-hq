---
name: gridiron-explorer-paused-2026-09-22
description: Explorer thread paused 2026-09-22 08:56Z on Nick's usage order; what is queued for the 11:11Z resume.
metadata:
  type: project
---

Nick, 2026-09-22 08:53:44Z (timeline): usage 78% with 2h20m to reset — finish
what is in flight, then pause the explorer loop and new thread spawns until the
7:11 local reset (11:11Z), essential checks only.

Explorer complied at 08:56Z: hourly self-trigger
`trig_01TmmVb3SUDjmL1ytumBjCMV` ("R&D circle") is **disabled, not deleted** —
re-enable it rather than recreating it, so the run history survives. The
coordinator's own resume routine `trig_012RN55qCnW2TAZnS3VTgmcL` fires 11:12Z.

**Done before stopping** (spec wording only, no runs): the three Planner
Plan 06 corrections to `/mnt/project-files/CONFORMAL-SPEC.md` — (1) weakness 3
was false, (2) the gate is "the repo's criteria on a different run" (repo:
300 draws / seed 20260826 / 2025; mine: 200 / 20260922 / 2023-2024), (3)
`server/services/conformal.js` already exists and arm D is a caller of
`buildConformal` with a different `edges` array. The same 2025 correction was
propagated to `A6-RECONCILE-SPEC.md`, `EFFW-SPEC.md` and
[[gridiron-offline-measuring-rig-2026-09-22]].

**2025 IS REACHABLE and is the PROTECTED HOLDOUT** — do not run on it; spending
it is the Auditor's call and then Nick's.

**PAUSE ORDER 13:02:32Z, Nick, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmTChJCHDt33Bs4w8XuVeCTt4, verbatim:** 'burn is too hot. 5hr meter is at 70% with 3hrs to reset — at this pace it hits 90% before reset and that's my cap for nick's morning work. pause every thread that isn't blocked-or-critical. no new thread spawns, no loops, no redundant reruns until you hear otherwise. keep only work that has to finish before nick wakes.' Explorer is IDLE and compliant. **The ONE exception, per the coordinator:** if Nick pastes the production-read output in this thread, applying the pre-registered rule to it is his morning work and proceeds. Everything else waits. No self-trigger armed.

**THE READ IS WITH NICK (morning-list item 17, posted 13:00Z).** Command `node read.mjs /data/data.sqlite`; files `/mnt/project-files/read.mjs` + `readdesign.mjs`; pre-registration `/mnt/project-files/READ-PREREG-2026-09-22.md`. **When the output arrives, apply the PRE-REGISTERED rule and nothing else:** re-classify each position on **production's own SE** against the **rig effect sizes held FIXED — 0.0591 pooled, 0.0540 WR, 0.0891 TE, 0.0530 RB, 0.0346 QB — never the observed gap**; threshold **ratio ≥ 1.78**; **report per-position first, n-weighted pooled beneath as derived**; QB and RB nulls are **UNRESOLVED, never "no difference"**. Three readings are pre-registered; do not invent a fourth. If the four table row counts read 0, the run was on a rig copy and says nothing. See [[gridiron-no-read-only-path-to-the-production-db]].

**STATE, after the 11:13Z reset (non-pushing work only; push authority still
revoked).** The resume queue below is **all done**: Unit A written up, the #20
re-runs re-reported at the repo's own 300 draws, partial pooling run and
published as a NULL. Everything since has been Auditor closeouts, all local:
the bin-cut-variable unit **stood down at gate 1.2** (oracle 0.0026 CRPS vs
0.0168 half-width, ratio 0.15) and bounding `CONFORMAL-SPEC.md` weakness 2 at
that 0.0026; the R14 text items (ceiling label — see
[[gridiron-four-ceilings-name-which-one]]; 88% → 86.79% in the early-week
record; the per-position ordering addendum on the pooling record). Memory
[[gridiron-mae-flat-changes-move-bias]] written. **Open with the Auditor:** may
a bootstrap CI half-width stand in for the PIT noise band as the gate-1
resolution when the unit's PRIMARY metric is CRPS rather than coverage? The
binvar stand-down does not depend on the answer; the next registration does.
**Nothing is queued for a push.** No self-trigger armed.

**Queued for resume, in order** (all now complete): Unit A write-up (measurement is DONE — m* came
out BELOW P for both non-Out buckets, 0.740 vs 0.7895 and 0.480 vs 0.6570, and
is indistinguishable from P out of sample, which cuts against the hypothesis's
sharp prediction; report it that way); then the #20 re-runs the Auditor asked
for; then hierarchical partial pooling for usage, rig-measured, incumbent and
held-out split stated before running.
