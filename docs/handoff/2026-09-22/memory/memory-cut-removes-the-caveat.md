---
name: memory-cut-removes-the-caveat
description: The 4 KB recall cut removes hedges before claims, because hedges are written last - so an over-long memory recalls as more confident than it was written.
metadata:
  type: feedback
---

Per-file recall shows only the first 4 KB. The rule is known and stated in
MEMORY.md, and on 2026-09-19 three team files were over it anyway: 5871, 4444
and 4292 bytes. Nobody had measured.

**Why:** the cut is not random about what it takes. A memory is written claim
first and caveat last — the finding, then "what is fixed and what is NOT", then
the cost of the recommendation, then the warning. So the cut systematically
removes the hedge and keeps the assertion. Each of those three files lost
exactly the part that would have stopped a reader acting on it:

- the release-train file lost **"never delete a `.bak`"** — the only copy of
  the live rows — while keeping the rollback command that makes someone want
  the disk space;
- the boot-restart file lost "this PR does NOT fix the wedge" while keeping the
  diagnosis, so recall reads as "the fix is in hand";
- the off-thread file lost the OOM and per-job connection cost while keeping
  the recommendation to go off-thread.

An over-long memory therefore does not degrade gracefully. It recalls as a more
confident version of itself. That is the same
healthy-looking-and-not-working shape we keep finding in the code, running in
our own memory.

**How to apply:** after writing or editing any memory, `wc -c` it. Over 4096,
split — and split so the SAFEGUARD gets its own file with a description that
names it, rather than living at the end of the file it qualifies. Put anything
that would stop a destructive action in the first paragraph, never the last.

Second rule from the same night: the `description:` is what recall uses to
decide whether a file is opened at all, so a wrong description travels further
than a wrong body. One file's description stated my own unproven candidate
("the block starts at boot+90s") as settled; a direct measurement contradicted
it within the hour. Descriptions state what was measured; candidates stay in
the body, named as candidates.

Do not edit another thread's memory file to fix this. Route it to them and to
the coordinator. See [[gridiron-decision-routing]].
