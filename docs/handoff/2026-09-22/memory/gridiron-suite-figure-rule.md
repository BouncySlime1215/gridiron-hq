---
name: gridiron-suite-figure-rule
description: npm run check with its exit status is the only comparable suite figure — a bare node --test on fitted-model files reads the container DB and fakes regressions (2026-09-20).
metadata:
  type: feedback
---

**Correction 2026-09-22 ~06:23Z (Wiring map thread).** THE TREE-HASH RULE
below is incomplete: `git write-tree` alone hashes the git INDEX, not the
working tree — an unstaged edit is invisible to it (Wiring map proved this
by dirtying a tracked file unstaged and getting an identical hash both
times). **Corrected, both required:** `git status --porcelain` empty
before/after AND `git write-tree` stable before/after — neither alone is
sufficient. Weakens every thread tonight that cited write-tree alone as
full mid-run proof (conclusions likely still hold; none is known to have
had an uncaught mid-run edit). Detail: [[gridiron-tree-hash-rule-correction-2026-09-22]].

**The authoritative suite figure is `npm run check`, with its exit status read.** Quote no other number in a PR body, an evidence file or a report.

**A standalone `node --test` on any file touching fitted models is NOT comparable.** The harness sets `GRIDIRON_DB_PATH` to a fresh temp path; a bare run does not, so the suite falls back to the container's partially populated database. `realHistoryDisposition` then sees the tables present, declines a disposition, and the fitted-model assertions fail on incomplete data — the environment failing, not the code.

**Instance 2026-09-20.** Three false failures in `test/nfl-team-strength.test.js`, none regressions: team resolution from a pre-Week-1 source, the preseason projection column, the Rams QB1 alias. Through the harness the same six files give **68 tests, 61 passed, 0 failed, 7 skipped**.

**Telling a real red from this one: stash and re-run on the clean base.** Clean base red the same way = environmental; clean base green = the change owns it. Do that before calling anything environmental — or a regression.

**A run outside the harness is quotable only when it AGREES WITH THE HARNESS ON THE SAME TREE, verified by running it both ways** — not merely because it passed. The model evidence audit thread had run every wiring-map mutation bare; it re-ran the file both ways at d38a65c, each giving **78 tests, 78 passing, 0 failing, 0 skipped**, so its figures stand on a reading. The agreement held by luck, not design: that suite only scans source text, and one assertion reaching a fitted model would have diverged the two runs.

**A merged-tree run goes in a DEDICATED WORKTREE with its own install** — mechanism, tells, and the 2026-09-20 instance: [[gridiron-glob-at-start-open-later-trap]]. **NEVER quote 2978 / 2 fail.**

**THE TREE-HASH RULE (project-wide; corrected above).** Every suite run records `git write-tree` before and after plus the `node_modules` mtime either side, printing either "tree unchanged across the run; dependency tree unchanged" or "VOID" with both pairs shown. A tree that changed voids the run whatever the numbers say. Adopted by the model-evidence-audit thread after a commit landed inside one of its own run windows (pass B 12:34:23-~12:47, 2026-09-20; commit 12:42:26). That run was NOT void but not clean either: nothing under `test/` changed, the only two docs files any test opens at runtime were untouched, the total was EQUAL to expected rather than short, and two independent runs on stable trees gave the identical **2,950 / 2,909 / 0 fail / 41 skipped**. The figure stands on the second reading, not on the argument.

**THE ISOLATION LABEL (project-wide).** Full text moved for space: [[gridiron-suite-figure-isolation-label]]. Short version: "source-isolated" = own source tree, symlinked `node_modules`; "isolated" = own dependency tree too; an install anywhere in a container voids every source-isolated run in it at once, none failing visibly.

Same family as the npm ci rule: **a number measured the wrong way looks exactly like a regression.** See [[gridiron-failure-modes]], [[ci-disabled-local-checks-are-the-gate]].
