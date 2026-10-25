---
name: gridiron-suite-figure-isolation-label
description: Full text of THE ISOLATION LABEL rule, split out of gridiron-suite-figure-rule.md for space (2026-09-22).
metadata:
  type: feedback
  modified: 2026-09-22T06:35:27.676Z
---

Moved out of [[gridiron-suite-figure-rule]] verbatim to keep that file
under 4KB. No content change.

**THE ISOLATION LABEL (project-wide).** Every figure states its isolation.
"Source-isolated" = own source tree, symlinked `node_modules`; "isolated"
= own dependency tree too. Most harnesses here are source-isolated; an
install anywhere in a container voids every source-isolated run in it at
once, none failing visibly. The model-evidence thread checked rather than
assumed: `node_modules` mtime 2026-09-20T01:51:35Z, `.package-lock.json`
01:12:19Z, every quoted run started after 11:00Z, so the dependency tree
was in fact constant — but that is luck, nobody happening to run an
install, not a property of the harness.
