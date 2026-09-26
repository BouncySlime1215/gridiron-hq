---
name: gridiron-throughweek-two-conventions
description: throughWeek means INCLUSIVE in projections.history() and EXCLUSIVE in efficiencyGap/learnedProfiles; copying a call site across modules leaks the predicted week into its own features.
metadata:
  type: project
---

Read on origin/main **654ff93**, 2026-09-22.

**The same parameter name has two opposite meanings in this repo, and both
call sites are correct.**

- **INCLUSIVE.** `projections.js` `history()` :295-300 filters
  `(u.season < ? OR (u.season = ? AND u.week <= ?))`. So callers must pass
  `week - 1` to project `week`. They do: `player-week-engine.js:272` and
  `ceiling-lineup.js:62` both pass `throughWeek: week - 1`.
  `shrinkage-fit.js:89-95` and `nfl-qbr.js:129-136` follow the same inclusive
  convention, which is what makes them cutoff-safe against `history()`.
- **EXCLUSIVE.** `nfl-spread-context.js:126-130` `efficiencyGap()` filters
  `week < ?`, and `nfl-sim-learn.js:111-118` `learnedProfiles()` likewise.
  So their callers pass `week` itself: `football-first.js:186-190`,
  `nfl-drive-sim.js:814, 916, 1283`.

**Why it matters.** Both families are internally consistent, so nothing is
broken today. The hazard is new code that copies a call site from the wrong
module: pass `week` to `history()` and you train on the week you are
predicting; pass `week - 1` to `efficiencyGap()` and you silently drop a week.
The first is leakage and will look like a model that suddenly got good.

**Audit result, so nobody re-runs it:** the FANTASY projection path has NO
leak. Every `history()` caller passes `week - 1`, and every `week < ?` caller
passes `week`. Checked by grepping all `throughWeek` sites across
`server/`, `scripts/`, `routes/`.

**How to apply.** Before adding a `throughWeek` argument anywhere, read the
callee's SQL and confirm `<` against `<=` — do not infer it from a neighbouring
call. If you add a new one, prefer the inclusive convention (it matches
`history()`, the module most things hang off) and say so in the signature's
comment. Same shape as [[verify-the-consumer-not-the-producer]].
