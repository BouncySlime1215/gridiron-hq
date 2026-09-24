# TDD evidence: serve-log sweep fixes (FIX-243-1, FIX-243-2)

Follow-up to IDEA-001 / RL-20-1 (#243, merged). #243's own evidence file is
`docs/tdd/2026-09-24-idea-001-serve-log.tdd.md`.

## What changed
- **FIX-243-1:** the weekly snapshot (`served_numbers_weekly`, `snapshotServedNumbers`) adds the surface
  `lineup_spread`: one row per team per field, `lineup_p10` / `lineup_p50` / `lineup_p90`, entity
  `team:<roster>`. The range is the Self-scout one: `lineupSpread(weekLineup(team.players, slots))`.
  p50 is the mean, because lineupSpread is a normal approximation.
- **FIX-243-2:** every row carries `seed` and `input_hash` (migration `100_served_numbers_replay`, which
  only adds two nullable columns). `input_hash` is the sha256 of `leagues.payload`, hashed at flush time
  and not on the request.
  - `/simulate` with no seed now generates one, simulates under it and serves it as `seed`.
  - title-trades rows record `tradeImpactSeed(lg)`.
  - The weekly title odds run under a generated seed, and that seed is recorded.
  - The finder and the lineup range draw nothing, so they record `seed` NULL.
  - The weekly capture is refused (`refused_slate_started`) once the week has outcomes or its first kickoff
    has passed. It uses `pregameWeekGuard`, which is taken out of `captureWeeklyPredictions` so the two
    share one rule (spec c).

## RED
`a23d8293` test: RED. `test/serve-log.test.js` gave 19 pass / 9 fail. Each of the 9 fails on the missing
behaviour: no `seed` or `input_hash` column, no `lineup_spread` surface, no `seed` in the `/simulate`
response, and a weekly capture that is not refused.

## GREEN
28/28 on `test/serve-log.test.js`. Neighbouring suites that mock season-sim (rl-19-2, rl-19-3, rl-6-3,
scoring-call-sites*) plus the weekly and migration suites: 181/181.

## Mutation sweep (scratch script, 10 mutants + 2 controls)
| id | mutant | result |
|---|---|---|
| M1 | weekly drops `lineup_spread` | killed |
| M2 | `/simulate` serves no seed | killed |
| M3 | `/simulate` generated seed not passed to the rng | killed (the replay test's draw differs) |
| M4 | weekly skips the pregame guard | killed |
| M5 | `input_hash` null | killed |
| M6 | title-trades route drops the seed | killed |
| M7 | weekly title odds seed not recorded | killed |
| M8 | `lineup_p50` read from floor | killed |
| M9 | guard ignores first kickoff | killed |
| M10 | guard ignores outcomes | killed |
| C1 | reword a comment | survived (control) |
| C2 | pattern absent | not applied (control) |

## Five questions
1. Well built? One extractor and one helper in serve-log.js. The guard is shared, not copied.
2. Stats or made up? No new number. lineupSpread and simulateSeason are called as they are.
3. How we know: fixture tests with producers stubbed. The `/simulate` replay test checks that the served
   seed reproduces the shared rng draw.
4. Pointed anywhere else? `captureWeeklyPredictions` now calls `pregameWeekGuard`. Its behaviour is the
   same and its tests pass.
5. Unifies: one guard for both pregame captures, and one seed rule per surface.
