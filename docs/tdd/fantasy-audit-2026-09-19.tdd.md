# TDD evidence index: the week-2 fantasy audit (2026-09-19/20)

Six changes came out of a feature-by-feature sense-check of the fantasy side of
the live app at week 2 of the 2026 season, spot-checked against the underlying
feeds rather than against the app's own output. Each has its own evidence file
below. All six branch from `791b131`.

| # | Change | Evidence | RED (at its parent) |
|---|--------|----------|---------------------|
| 55 | Last season's ESPN ADP stops voting on this season's draft board | [consensus-season](consensus-season.tdd.md) | 4 of 5 |
| 57 | The trade engine's week comes from the league, and an asset says which model priced it | [trade-week-and-availability-source](trade-week-and-availability-source.tdd.md) | 4 of 6, and 4 of 4 |
| 62 | No kicker or defense could ever be recommended on the waiver board | [waiver-kicker-defense](waiver-kicker-defense.tdd.md) | 4 of 7 |
| 64 | Seven more surfaces priced for the league's week, not the betting feed's | [week-from-league-surfaces](week-from-league-surfaces.tdd.md) | 6 of 7 |
| 67 | Bye risk says what it never scored, instead of calling it a verdict | [bye-risk-not-modelled](bye-risk-not-modelled.tdd.md) | 2 of 4 |
| — | The contention window's age axis is dynasty-only | ships with its own change | 3 of 7 |

**How the RED column was produced.** Each test file was checked out into a
detached worktree at the commit its change is based on — `791b131` for five of
them, `25d911c` for #67 — and run there. The counts above are that run, not a
recollection of one.

**And every test that passes at the parent was injected against**, because the RED
run says nothing about those. Fourteen injections across the six files. **Three
tests survived an injection that broke what they claimed to guard, and all three
were rewritten:**

| Test | What it claimed | What the injection showed |
|------|-----------------|---------------------------|
| #64 test 1 | "the old path would answer week 1" | asserted only that `game_lines` was empty — changing the fallback from 1 to 7 left the file green |
| #67 test 3 | "a kicker or defense never appears as a patch" | looped over candidate lists that were empty by construction, so it asserted nothing |
| #67 test 4 | "the underlying outlook is unchanged" | a `typeof` and an `Array.isArray` — nudging every week's `points_lost` by one left it green |

Two more injections did not bite and are recorded in their own files rather than
retried until they flattered the tests: widening only `waiver-brain.js`'s own
`LINEUP_MODELLED` does not make a kicker rank, because `bestLineup` is what
declines to score him; and the `|| 1` week fallback is pinned in #64's file, not
in #57's, which is how #64's weak premise came to light.

The tests that legitimately pass on both sides are premise assertions (proving the
fixture can fail at all) and regression pins (proving the change takes nothing
away), and each file names which of its own tests are which.

**One theme runs through five of the six.** The app was not producing wrong
numbers so much as producing *confident* numbers from searches it had not run:
a draft board ranking on a stale ESPN row at double weight, a waiver page calling
an unsearched position "a good sign about your roster", a bye page calling a
search it never ran "nothing on the wire fixes it", a trade priced for week 1 in
week 2, and a redraft league told to trade for a future it does not have. The
fixes mostly do not change what the model scores. They change what the surface
claims about what it scored.

**A fixture trap that invalidated two early attempts**, recorded here because it
would silently invalidate a future one. A roster payload of
`{ playerPoolEntry: { player: { fullName } } }` makes `loadRosters` match nobody,
without error: `me.players` comes back empty, `bestLineup` scores 0, and *every*
free agent then shows a positive gain — so an assertion as strong-sounding as "a
real upgrade is still found" passes against a completely broken fixture. Roster
entries need `id` and `defaultPositionId` (QB 1, RB 2, WR 3, TE 4, K 5, DEF 16).

**And a mocking trap.** `mock.module` on `trade-engine.js` does not reach
`waiver-brain.js`, because `trade-engine.js:73` imports `vegasLift` from it:
importing the real trade engine first, to spread its exports into the mock, loads
`waiver-brain` bound to the unmocked module. The symptom is silent —
`assets.size === 0` inside `freeAgents` while the mocked `assetUniverse` returns
rows when called directly. These files are therefore built on the real pipeline.

## On the missing check runs

None of these six carries a green GitHub check. The account's Actions minutes
were exhausted at 2026-09-20 01:04Z (2,000 of 2,000, resetting October 1) and the
repository's one workflow was disabled afterwards, so every run from 01:00:24Z
died in about two seconds with no runner allocated, no steps recorded and empty
output — on the base branch equally. A red or absent check on any of these
branches is that, and not the diff. Each change's proof is the full local
`npm run check` run recorded in its pull request body, with its numbers.

## Is this well built — read the six together

Asked of the audit as a whole, since each file answers it for its own change.

- **Almost nothing in this half of the app is fitted.** Across the six changes the
  numbers that decide what Nick sees are hand-set literals with no citation:
  `YOUNG = 25.5` and `OLD = 27.5` and the ±5% capital band in the contention
  window; `recovered > 0.25` and `points_lost >= 5` on bye risk; `gain <= 0.05` on
  the waiver board; the ESPN rank's weight of `2` against FantasyFootballCalculator
  and Sleeper's `1` each on the draft board; `0.92` as a default chance to play.
  Each is a reasonable judgement. None has been measured, and the pages present
  all of them in the same voice as the things that have been.
- **What IS measured** sits underneath them: the projection engine, the VOR board,
  the availability fit (which reports its own basis), and the lineup solve, which
  re-optimises rather than counting. The hand-set layer is the advice on top.
- **So the honest summary is structural**: the model's outputs are better than its
  copy. Five of these six changes are copy and wiring fixes for exactly that gap —
  a surface claiming more than the thing under it knows.
- **What would unify it:** one place that declares every hand-set constant with
  its rationale, the way `matchups.js` already declares `MATCHUP_EVIDENCE` and
  refuses to tilt a number until a walk-forward test passes. That pattern exists
  in this repository and is the right one; it is simply not applied to the fantasy
  advice layer.
- **The single highest-value held-out test** is the same one for four of these
  six: weekly fantasy scores per league-season, which nothing in the app database
  holds today. `routes/leagues.js:125` already requests `view=mMatchup` and `:160`
  persists the whole response into `leagues.payload`, so
  `schedule[].home.totalPoints` per `matchupPeriodId` is sitting there unparsed.
  Parsing it is what would let any of these thresholds be fitted rather than
  argued about.
