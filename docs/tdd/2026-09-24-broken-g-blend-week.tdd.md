# BROKEN-G: one "this week" number (`blend.week`)

Row G of BROKEN-NUMBERS (handoff branch `docs/handoff/local/BROKEN-NUMBERS.md`),
ENGINE-ARCHITECTURE §10.2 G: "`blend.week` is the one number; horizon blends are
derived fields with their own names."

## Cause (origin/main 21c9da4)

| page | number | where |
|---|---|---|
| trade card (horizon, lineupSpan) | `current_week_ppg`, no betting-line lift; `adj_ppg = 0.25 x that + 0.75 x ros_ppg` | `trade-engine.js:432`, `:507`, `:1482` |
| Start/Sit | `current_week_ppg x` full `vegasLift`, own call | `lineup-brain.js:357-365` |
| League Hub lineup card | same construction, its own copy and its own call | `trade-engine.js:2965-2970` |

## Fix

`server/services/blend-week.js#blendWeek` is the one producer: served
`current_week_ppg` x the full lift (the Start/Sit construction), 0 on a bye with no
line read, null when there is no week number. `buildAssetUniverse` calls it once per
player and serves `blend_week` (+ `blend_week_vegas`, `week_basis`); `adj_ppg` is
derived from it (`horizonPpg`). Readers: `startSitWeekPoints`, `lineupDiffWeekPoints`,
`lineupSpan`'s this-week leg, `slim()` (trade card), `TradeCard.tsx` tooltip.
`waiver-brain.js` upgrades skip `horizonValueWithVegas` when `blend_week` is present,
because `adj_ppg` already carries the lift (it would otherwise count twice).

Flag: `GRIDIRON_BLEND_WEEK` (1 on, 0 off/vetoes preview), unset follows
`previewUnconfirmed()`. The flag is part of `assetInputsKey`, so a flip rebuilds the
cached universe. Off: every number is byte-identical to main (`0.75 === 1 - 0.25`).

## RED

Commit `test: RED for BROKEN-G ...` (producer module + test, no wiring):

```
ok 1 - flag: 1 on, 0 off, unset follows preview mode
ok 2 - blendWeek: no week number is null, a bye is 0 with no line read
ok 3 - control (flag off): the fixture really has a lift, and the three numbers disagree as on main
not ok 4 - RED (flag on): Start/Sit, the lineup card and the trade card read one blend.week
not ok 5 - RED (flag on): a bye is 0 on every page and a flag flip rebuilds the cached universe
# pass 3
# fail 2
```

## GREEN

```
ok 1 .. ok 5
# pass 5
# fail 0
```

One test assertion was wrong, not the code: `lineupSpan` rounds to 0.1 by design
(`trade-engine.js` `toFixed(1)`), so the test compares its leg at 0.1.

## Liveness: mutation sweep (test/blend-week.test.js, 7 tests)

Tests 6-7 were added after GREEN: 6 moves the mocked line after the universe is
built, so a page that re-lifts on its own call disagrees with the served number;
7 pins `waiver-brain.js#horizonAnnotate` (extracted from the upgrade solve).

| mutant | result |
|---|---|
| M1 `startSitWeekPoints` blend_week branch removed | dies (6) |
| M2 `lineupDiffWeekPoints` blend_week branch removed | dies (6) |
| M3 `lineupSpan` this-week leg back on `current_week_ppg` | dies (4) |
| M4 `adj_ppg` back on the unlifted week | dies (4) |
| M5 flag dropped from `assetInputsKey` | dies (4, 5, 6, 7) |
| M6 waiver horizon lifts blend.week again | dies (7) |
| M7 call site: `buildAssetUniverse` ignores the flag | dies (4, 5, 6, 7) |
| M8 bye reads a line | dies (2) |
| C1 surviving control: `BLEND_WEEK_REASON` text | survives (by design) |

Not-applied control: test 3 (flag off) passes under M1 and M2, because the branch
they remove is not reached when the asset has no `blend_week`.

## Not covered here

- `waiver-wire.js` (`:104`, `:111`, `:207`, `:273`) still solves on
  `current_week_ppg`; it is not one of row G's three pages. A follow-up if the
  coordinator wants the Waivers page on `blend.week` too.
- The live-DB diff (`scripts/blend-week-diff.mjs`) is run by the coordinator on a DB
  copy; its output lands on the PR.
