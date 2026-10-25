---
name: gridiron-nflsavant-retired
description: Don't sync nflsavant — nflverse participation strictly dominates it on route type and coverage shell, and we already download participation.
metadata:
  type: project
---

Verdict 2026-09-22, measured by the integration thread, agreed by data &
techniques R&D (who built the nflsavant prototype and withdrew it).

nflsavant.com's open JSON API was prototyped as a route-tree and
coverage-splits source. **nflverse `pbp_participation` strictly dominates it:**

- **Route type:** 500 receivers against nflsavant's 106, and 78% more labelled
  routes.
- **Coverage shell:** 99.9% coverage. The sparse shells in nflsavant looked
  like a sourcing limit and were an nflsavant artifact.
- **Cost:** the repo ALREADY downloads participation every sync
  (`server/services/nfl-formations.js:56`). nflsavant would have been a new
  external dependency returning less.

**How to apply:** do not sync nflsavant, do not build the puller. The route
dimension is still worth pursuing, sourced from participation — see
[[gridiron-participation-not-dead-after-2023]] and
[[gridiron-yards-per-target-is-noise]]. The retired spec stays published as
`SPEC.md` in project files with a RETIRED header, as the record of a dead end.

**The standing intake rule this produced (integration thread, 2026-09-22):**
every new data-source package must state **what we already download that might
carry the same thing, and why the new source beats it.** The nflsavant package
never asked that question, which is exactly how it got built. Ask it first,
before any fetching.
