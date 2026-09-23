# "Chase the ceiling" stops printing a win rate it never measured (RL-3-4, C-18 / S-08)

Unit RL-3-4. Tree: branched from origin/main `89f69b3b`. Not a statistical unit: it removes a number and a label; it
adds no model number, so no pre-registration and no 2025 held-out look (no `HOLDOUT-LEDGER.md` row).

## 1. Audit (written before the first test): extend, not build

What exists on origin/main `89f69b3b`:

- `server/services/lineup-brain.js:576` `margin = p[key] - alt[key]`, where `key` is the objective actually solved on
  (`:470-496`). Under "Chase the ceiling" `key = 'ceiling'`, the player's weekly p90 (`trade-engine.js` asset
  `ceiling`), so `margin` is a gap between two p90s.
- `:578-582` labels that p90 gap Clear / Lean / Coin flip with `CLEAR_THRESHOLD` / `TIE_THRESHOLD` (`:328,339`),
  thresholds measured on week_points margins.
- `:585` `winRate = decisionWinRate(margin)`: the curve at `:268-302` whose source is
  `docs/evidence/2026-09-22/start-sit-decision-curve.md`, measured on mean-projection gaps.
- `:630-636` the `why` sentence prints "At a gap this size the higher projection has won about X% of the time"
  (or, for a gap under 1.5, "below 1.5 points the higher projection has won 53% of the time").
- `:674-675` the server already tags the response `confidence_basis: 'uncalibrated_for_<objective>'`.
- Reader check: `git grep -n "confidence_basis\|uncalibrated_for" -- client/src` returns nothing (control: the same
  grep over `server` returns `lineup-brain.js:674`). The page renders `c.why` verbatim (`Lineup.tsx:307`) and the chip
  from `c.confidence` (`Lineup.tsx:271`). So the tag exists and nobody reads it.
- One producer: `git grep -n "won about\|decisionWinRate" -- server client/src` returns only `lineup-brain.js:302`
  (definition), `:585` and `:635`. No second producer of this win rate or wording.
- Tests: `git grep -ln "objective: 'ceiling'\|objective: 'floor'" -- test` returns `test/eval-lineup-objectives.test.js`
  and `test/lineup-floor-objective.test.js`; neither asserts on `confidence_win_rate`, the label or the `why` text
  under a non-mean objective.

Decision: extend `lineupCall` (`:578-641` only; RL-4-2 owns `:446,481`) and `Lineup.tsx`. The R3 package's larger fix
(one "maximise my chance to win" solve on `lineup-posture.js`) and the hero "sum of good-week ceilings" are not in this
unit; see Known defects.

## 2. RED / GREEN

- RED: `test: ceiling/floor objective must not print a week_points win rate or label (RED)` `574ea155`
  (`test/start-sit-ceiling-uncalibrated.test.js`, new). Failing assertion on origin/main `89f69b3b` code:
  `QB Star Quarterback: margin 15 is a ceiling gap; decisionWinRate was measured on week_points` / `0.9 !== null`
  (floor: `margin 7 is a floor gap` / `0.772 !== null`); the page test failed on `the lineup page reads the basis tag`.
  The week_points control passed on RED.
- GREEN: `fix: ceiling/floor lineups carry no week_points win rate or label; page reads confidence_basis (GREEN)`
  `ea4493b3`. 4/4 pass.
- Strengthened after the mutation sweep: `test: pin the fallback basis and the page's rendered basis line (mutants M6, M8)`
  `7e9e1acb`. 5/5 pass on HEAD; the final file re-run against origin/main's `lineup-brain.js` + `Lineup.tsx` fails 3
  (ceiling, floor, page) and passes 2 (both controls).
- Skeptic round (test liveness): the page test was a source grep, so it passed when the hero-line condition was
  inverted (C1) or the `'not measured'` chip was relabelled `'Lean'` (C2), both 5/5 on `afc3d673`. Replaced with a
  real render test (`test: render the Start/Sit page on lineupCall output instead of grepping its source` `c6953571`): the TSX
  is compiled with the repo's TypeScript, every import but React is stubbed, the data hook returns lineupCall's own
  output JSON-round-tripped as `res.json` sends it (`server/routes/trades.js:220`), and `renderToStaticMarkup`
  renders it. Three render tests: ceiling and floor must show the "no call is graded" hero line and one "Not graded"
  chip per compared slot and no Clear/Lean/Coin flip chip; mean (control) must show Clear and Coin flip chips and the
  tie line, and neither the ungraded line nor a "Not graded" chip. 7/7 pass on the new HEAD (same command).
  The same file against origin/main's `Lineup.tsx` (server code at HEAD) fails 2 (ceiling render, floor render) and
  passes 5.
- Command (each run): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gt-XXXX).sqlite
  NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap
  test/start-sit-ceiling-uncalibrated.test.js`.
- Neighbours re-run on `ea4493b3`, all pass: lineup-floor-objective 3/3, start-sit-decision-curve 12/12,
  eval-lineup-objectives 5/5, decision-leftovers-lineup 10/10, lineup-evidence 16/16, lineup-surfaces-agree 2/2,
  availability-honest-degradation 8/8, page-explain 7/7.

## 3. What it does

- `server/services/lineup-brain.js:583` `calibrated = objectiveUsed === 'week_points'` (the objective actually solved
  on, not the one requested, so a ceiling request that fell back to week_points keeps its measured rate).
- `:586` a compared call on a ceiling/floor solve is labelled `'not measured'` instead of clear/lean/coin flip.
- `:593` `confidence_win_rate` is null unless calibrated.
- `:636-640` the `why` says "N points ahead of X on good-week ceilings (bad-week floors), not projections. No win rate
  has been measured for a gap like this, so none is shown." No "has won" sentence, including the coin-flip band's 53%.
- `:687` `confidence_basis` unchanged (`uncalibrated_for_<objective>`). `coin_flips` falls to 0 on a ceiling solve
  because no call is labelled a tie, so the response `note` no longer calls ceiling gaps ties.
- `client/src/pages/Lineup.tsx:127` reads `confidence_basis`: when it starts `uncalibrated_for_`, the hero line says
  the gaps are between ceilings/floors and no call is graded. `:31` a "Not graded" chip for `'not measured'` (it used to
  fall back to Lean via `CONF[c.confidence] ?? CONF.lean`). `:74` the basis is passed to the page assistant.
- The lineup itself is unchanged: the solve (`:470-496`) is not touched.

## 4. Numbers (local copy, not production)

Copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"` (and a second copy for the
before run, since lineupCall writes Decision Inbox rows). Script: counts per objective over every league in `leagues`
(5 leagues, 36 calls each). Run: `NFL_SEASON=2026 SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy>
GRIDIRON_DB_INTEGRITY_CHECK=off NODE_OPTIONS='--import ./test/offline-guard.mjs' nice -n 10 node .local-db/count.mjs`.
Before = origin/main `lineup-brain.js` swapped into the tree; after = HEAD `7e9e1acb`. 2026 W3 served state.

| objective -> used | tree | clear | lean | coin flip | not measured | numeric win rates | "has won" sentences |
|---|---|---|---|---|---|---|---|
| mean -> week_points | before | 6 | 16 | 9 | 0 | 22 | 31 |
| mean -> week_points | after | 6 | 16 | 9 | 0 | 22 | 31 |
| ceiling -> ceiling | before | 13 | 15 | 3 | 0 | 28 | 31 |
| ceiling -> ceiling | after | 0 | 0 | 0 | 31 | 0 | 0 |
| floor -> week_points | both | 6 | 16 | 9 | 0 | 22 | 31 |

- Known-nonzero control: "before" reproduces the R3 package's counts (ceiling clear 13 vs mean 6; rate sentences 28 vs
  22). The mean rows are identical before and after, so nothing calibrated was removed.
- Floor fell back to week_points in 5/5 (every floor 0 on the pooled chance to play; already recorded in
  `decision-leftovers.tdd.md:158`), so the floor rule is exercised by the fixture test only on real data this week.
- Decision grade: not applicable. The unit changes wording and labels, not which player starts, so its decision win rate
  equals the baseline's by construction. No model number, no pre-registration, no ship rule, no MDE (not a decline).

## 5. Mutation sweep (on `7e9e1acb`, test file above)

| mutant | result |
|---|---|
| M1 unit: `calibrated = true` | killed (ceiling, floor) |
| M2 unit: win rate unconditional | killed (ceiling, floor) |
| M3 unit: label ignores basis | killed (ceiling, floor) |
| M4 unit: `why` ignores basis | killed (ceiling, floor) |
| M5 call site: predicate on `key` instead of `objectiveUsed` (designed survivor) | survived: equivalent, `objectiveUsed = key` (`:496`) and `key` is not reassigned after |
| M6 call site: predicate on `requestedKey` | survived on `ea4493b3`, then killed by the fallback test added in `7e9e1acb` |
| M7 call site: predicate inverted | killed (all four behaviour tests) |
| M8 page: basis not read in the hero line | survived on `ea4493b3` (the old regex matched the page-assistant line), killed after `7e9e1acb` |
| M9 not-applied control: target string absent | not applied (target count 0), not run |
| C1 page: hero-line predicate inverted (skeptic) | survived on `afc3d673` (grep test); killed by the render test: fails ceiling, floor and mean renders (3) |
| C2 page: `'not measured'` chip label `'Not graded'` -> `'Lean'` (skeptic) | survived on `afc3d673`; killed: fails ceiling and floor renders (2) |
| C3 page: hero-line predicate replaced by `false` (basis never read) | killed: fails ceiling and floor renders (2) |
| C4 page: `'not measured'` row deleted (chip falls back to Lean) | killed: fails ceiling and floor renders (2) |

C1-C4 were applied with `sed -i ''` to `client/src/pages/Lineup.tsx`, run with the command in section 2, and reverted
with `git checkout -- client/src/pages/Lineup.tsx`; `git diff --stat` showed exactly one changed file for each.

## 6. Holdout looks

None. 2025 not opened; 2026 W3 served calls only (predictions, no outcomes graded). No `HOLDOUT-LEDGER.md` row.

## 7. Known defects / not covered

- The hero number under "Chase the ceiling" is still a sum of starters' p90s (`lineup-brain.js:699`,
  `Lineup.tsx:121-122`), 1.53-1.61x the lineup p90 per the R3 package. Labelled as a sum of ceilings, but inflated.
  Follow-up (S-08 / package fix item 2c).
- The ceiling solve still ranks players on their own p90, which `lineup-posture.js:116-120` found carries no
  information beyond position and projection; on 2 of 5 W3 rosters it lowered the posture model's P(win) (R3 package
  numbers, not re-run here). The real fix is one "maximise my chance to win" solve (S-08 / GT-01).
- `scripts/eval-lineup-objectives.mjs:28-41` still passes this behaviour; the package's P(win) eval rule is not added.
- The page change is verified by a source-level test and `tsc` was not run here (Gate runs it); not browser-checked on
  this tree (the running preview server serves the repo clone's main).
- What would make it wrong: a measured win-rate curve for ceiling gaps (S-08). When that lands, `calibrated` should key
  on the curve's basis, not on `week_points` alone.

## 8. Nick's five questions

1. Well built? Yes: one predicate (`:583`) on the objective actually solved, gating the label, the rate and the
   sentence; the page reads the tag the server already served. 5 tests, 9 mutants (7 killed on HEAD, 2 of them only after the test fix; 1 designed survivor;
   1 not-applied control).
2. Stats or made up? Removes a made-up number. Nothing new is estimated.
3. How we know: fixture tests + local-copy counts above (tree `7e9e1acb` vs origin/main `89f69b3b`). No backtest:
   nothing to backtest, the lineup is unchanged.
4. Pointed anywhere else? `GET /trades/:id/lineup` (`server/routes/trades.js:220`) -> `Lineup.tsx`; the page assistant
   gets `confidence_basis` (`Lineup.tsx:74`). `git grep confidence_win_rate` finds no other reader.
5. How it unifies: `decisionWinRate` stays the only producer of the start/sit win rate, and now only speaks about the
   margin it measured. `confidence_basis` gains its first reader.
