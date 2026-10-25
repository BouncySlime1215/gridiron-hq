---
name: lineup-pr-merge-order-57-43-60
description: PR #60 silently loses its whole effect unless #57 lands first; the #43/#60 conflict in lineup-brain.js has one correct resolution, verified 2026-09-20 01:20Z.
metadata:
  type: project
---

**#60 must not be rebased or merged onto #43.** Verified by building the merge
locally on 2026-09-20 and running the tests.

`tradeWeekContext` takes a league argument only on **#57**
(`claude/project-thread-5f9c3y-trade-week`, head aca74f9 — `tradeWeekContext(lg = null)`
at trade-engine.js:196). #43's branch is based on main at 791b131, where the
signature is still `tradeWeekContext()` at :172 and the argument is **ignored**.

So #60's two call sites — `lineup-brain.js:376` and `lineup-posture.js:209` —
compile, lint, typecheck and return a plausible week on a #43 base, and every
league gets the NFL's week instead of its own. Three of #60's seven tests go
red and name it: "league.current_week wins over NFL_WEEK=2 / 2 !== 7".
Nothing else catches it. This is the project's standing shape — a call that
looks wired because the function exists.

**Correct order: #57 → #43 → #60.** In that order the stack builds and
20/20 pass across lineup-reads-its-own-league, lineup-slots-not-modelled and
lineup-floor-objective.

**The #43/#60 conflict in `server/services/lineup-brain.js` is one hunk with
one correct resolution.** It is NOT a union:

- #60 hoisted `const availabilityBasis = assets.context?.availability_basis ?? null;`
  **above** the call map (to :574), because each call now reads the per-player
  basis and falls back to it. Its comment moved with it and gained a paragraph.
- #43's side of the hunk still declares the same `const` **below** the map.
  Keeping both is a duplicate `const` in one scope — a SyntaxError, not style.
- What exists only on #43's side is `const notModelled = slotsNotModelled(lg, slots);`
  and its comment, which feeds `slots_not_modelled` / `slots_not_modelled_reason`.
  **Dropping it silently removes the K/DEF disclosure** (flagged by the
  wiring-map thread).

Resolution: take #60's side, then re-add #43's `notModelled` declaration and
comment above the surviving `availabilityDegradation(availabilityBasis)` line.

**#46 before #53 on `client/src/pages/Settings.tsx`** is the other collision,
and that one is a plain union: keep #46's `<AccountPanel />` + deployment-aware
card + `{deployment?.local && <PhoneAccess />}` whole, and put `<DataBehindNumbers />`
between the card and the PhoneAccess comment. Verified: typecheck, build and
14/14 tests. See [[github-actions-limit-2026-09-20]] — nothing can be pushed
until Nick lifts the freeze.
