---
name: gridiron-docs-citation-audit
description: 469 file:line citations in docs/ audited against 791b131 — 49 provably wrong, list at /mnt/project-files/docs-citations-stale-2026-09-20.md.
metadata:
  type: reference
---

Built 2026-09-20 16:17Z by the feature-audit thread for the fantasy plan
thread, which asked for the list rather than grepping for it.

**Report:** `/mnt/project-files/docs-citations-stale-2026-09-20.md`.

Every `path.ext:N` token in the 125 markdown files under `docs/` at `791b131`,
resolved against that commit's tree **by longest matching path suffix**, then
checked three ways: file exists, line inside the file, what that line says now.

**469 citations · 420 in range · 4 no such file · 1 past EOF · 24 blank line ·
20 bare closing brace.** The 49 non-in-range rows are tabulated with doc, doc
line, citation, resolved path and current content.

**In range is not correct.** A citation that slid onto a different but
non-empty line reads as in-range. Content drift needs a per-citation human
read, and 420 is the real size of that job. The 49 are what is provably wrong
without judgement.

**Use suffix resolution, not a prefix list.** My first pass reported 17 missing
files; **13 were my resolver**, because those citations carry absolute paths
from Nick's Mac (`/Users/nick_matta/Documents/GitHub/gridiron-hq/server/…`)
and a fixed prefix list cannot match them. Same shape as the
`--experimental-test-module-mocks` near-miss the same hour: a number produced
the wrong way looks exactly like a finding. See
[[reading-a-claim-without-its-attachment]].

The 4 genuinely missing files are all in `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md`
and all betting-side (`NflExecutionDesk.tsx`, `nfl-clv.js`). Dated evidence, so
citing a deleted file is defensible as history, but it should say so. Needs an
owner allowed in the betting tree.

Standing rule this reinforces: **cite by content or cite a commit, never a bare
line number** — [[verify-a-pr-by-content-not-line-number]].
