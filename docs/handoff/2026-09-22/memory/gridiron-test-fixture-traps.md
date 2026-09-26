---
name: gridiron-test-fixture-traps
description: Gridiron HQ test fixtures that look correct and assert nothing — bye weeks from a week-1-only schedule, and identical projections collapsing VOR to zero.
metadata:
  type: reference
  modified: 2026-09-20T02:50:00.000Z
---

Each of these cost a cycle on 2026-09-19/20. Companion to
[[gridiron-injections-that-did-not-bite]].

## Two fixture traps that make a bye-week test vacuous

- **`players.bye_week` is never populated and nothing on these paths reads it.**
  Writing it changes nothing. `matchupModel` calls the first week from 4 to 14
  with no scheduled game a team's bye (`matchups.js:324`).
- **So a fixture that seeds only week 1 gives EVERY team a bye in week 4** — the
  roster and the whole wire together — and every free agent is dropped by
  `fa.bye !== bad.week` before anything scores him. Seed a week-4 game for every
  team except the ones under test.
- **And the injection can be self-defeating**: widening `SCORED` gives K and DEF a
  real `scheduleOutlook` where they previously fell to the `bye: null` fallback
  (`trade-engine.js:336`), so it *creates* the bye that then filters them out.

- **Identical projections across teams collapse VOR to zero.** VOR is
  `proj - replacementLevel`, and with one starter per team in an N-team league
  the replacement level IS the Nth-best player. Four teams with the same QB
  projection give every QB a VOR of exactly 0, so `starter_value` is 0 for
  everyone and the league average is 0 too — a PRICED position silently reads as
  an unpriced one. Make projections descend across teams, and assert the VOR
  board actually holds the positions you meant it to.

- **A roster payload entry without `id` and `defaultPositionId`** resolves to
  nothing, so **every** free agent shows a positive gain and a strong-sounding
  assertion passes against a fixture that is broken. See
  [[mocking-trade-engine-in-tests]] for the other half of this family.
