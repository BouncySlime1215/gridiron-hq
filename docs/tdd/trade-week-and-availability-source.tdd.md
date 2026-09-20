# TDD evidence (retroactive): the trade engine's week, and the source behind a price

**Change.** `claude/project-thread-5f9c3y-trade-week`, PR #57, two commits on top
of `791b131`: the week context, then `aca74f9` ("Carry the per-player availability
source onto the asset").

## Part 1 — the week came from the betting table, not the league

**Defect.** `tradeWeekContext()` (`server/services/trade-engine.js`) derived the
current week from `game_lines`:

```js
rows(`SELECT MIN(week) AS week FROM game_lines WHERE season=? AND team_score IS NULL`, SEASON)
```

— the first NFL game with no score yet. That is a fact about the betting feed's
freshness, not about the league being priced. If `game_lines` is empty, unsynced,
or already scored through, the fallback is `|| 1`: every trade in every league gets
priced for week 1. A league carries its own week (`leagueCurrentWeek(lg)`), and
eight call sites in this file had the league in hand and did not pass it.

The function now takes an optional league and prefers it, keeping the old
betting-table derivation only for the callers that genuinely have no league.
`assetInputsKey` (`:255`) already keys on `lg.id` and `target.week`, so this
fragments no cache.

### RED (`test/trade-week-context-league.test.js`, 6 tests, at `791b131`)

```
# tests 6
# pass 2
# fail 4
not ok 1 - with no lines loaded at all the league still knows what week it is
not ok 2 - the league outranks the betting table when the two disagree
not ok 3 - a league synced before the current_week column falls back to its payload
not ok 4 - the week is still clamped to the season
ok 5 - with no league in hand the old betting-table fallback is unchanged
ok 6 - the season is left alone
```

Tests 5 and 6 are controls and pass on both sides: no league means the old
behaviour, unchanged, and the season is not touched by any of this.

## Part 2 — the asset said how likely a player was to play, never who said so

**Defect.** An asset carried `active_probability` (`:504`) with no indication of
where the number came from. `weeklyAvailability(season, week)` returns a per-player
`source`, and the three sources are not interchangeable: a fitted role rate, a
pooled rate, and a bare constant are different claims about how much the number
knows. A constant and a fit rendered identically, so a page could present a
league-wide default as a per-player read.

The process-wide `availability_basis` already existed, but it answers a different
question — which layer the fit landed on for the whole run — and it is an object,
not a per-player string. It stays, and `availability_source` is added beside the
probability.

**Coverage, which the tests pin deliberately.** `weeklyAvailability` covers
QB/RB/WR/TE only; `projections.js:292`/`:300` produce no row for K or DEF. Test 3
holds that an uncovered position says so by saying nothing, rather than inheriting
a neighbour's source.

### RED (`test/asset-availability-source.test.js`, 4 tests, at `791b131`)

```
# tests 4
# pass 0
# fail 4
not ok 1 - the asset records which model priced that player
not ok 2 - two players in one process can carry different sources
not ok 3 - a position the weekly model does not cover says so by saying nothing
not ok 4 - the process basis is still served, and is still a different fact
```

## GREEN

At `aca74f9` all 10 pass, and the full suite is green.

## A trap worth recording, because it cost two rebuilds

`mock.module` on `trade-engine.js` **does not reach `waiver-brain.js`**, because
`trade-engine.js:73` imports `vegasLift` from it. Importing the real trade engine
first — to spread its exports into the mock — loads `waiver-brain` bound to the
unmocked module, and the symptom is silent: `assets.size === 0` inside
`freeAgents` while the mocked `assetUniverse` returns rows when called directly.
Both of these files' tests are therefore built on the real pipeline
(`seedIfEmpty()`, week-1 `schedule_games`, side-effect route imports,
`player_season_stats` with `kind='projected'`), not on module mocks.

## Injections

Tests 5 and 6 of the week-context file pass at `791b131`, so the RED run does not
prove them. Both were injected against the fixed code.

**Test 6** — the season shifted on the league branch:

```js
- if (lg) return { season: SEASON, week: leagueCurrentWeek(lg) };
+ if (lg) return { season: SEASON - 1, week: leagueCurrentWeek(lg) };
```
```
# pass 5  # fail 1
not ok 6 - the season is left alone
```

**Test 5, second attempt.** The first injection changed the no-league fallback
from `|| 1` to `|| 7` and the whole file stayed green. That is informative, not a
tooling failure: test 5 seeds two game lines and asserts week 6, so it pins the
`MIN(week)` read and never reaches the fallback. Re-aimed at the line it actually
guards:

```js
- rows(`SELECT MIN(week) AS week FROM game_lines
+ rows(`SELECT MAX(week) AS week FROM game_lines
```
```
# pass 5  # fail 1
not ok 5 - with no league in hand the old betting-table fallback is unchanged
```

**The `|| 1` fallback is pinned in the other file**, not this one:
`test/week-from-league-surfaces.test.js` test 1 asserts `tradeWeekContext().week`
is 1 with `game_lines` empty. That assertion was added *because* this injection
found nobody was making it — see that file's evidence.

## Is this well built

- **Well built:** yes. The week now comes from the thing being priced. The old
  derivation was not a worse estimate of the week, it was a fact about a different
  table.
- **Stats, or made up:** neither is estimated. `leagueCurrentWeek` reads ESPN's own
  `status.currentMatchupPeriod` (captured by migration 056), then the stored
  payload, then the schedule — a documented order of truth whose own docstring
  says "Never a hard-coded 1". `availability_source` is a label, not a number.
  The `0.92` default `active_probability` beside it **is** a hand-set constant and
  this PR does not touch it.
- **How we know:** no backtest, and none is owed — this is a wiring fact, and the
  seven tests are the proof. The availability half is a pass-through of a label
  `weeklyAvailability` already computes.
- **Pointed anywhere else:** `availability_source` should reach the surfaces that
  render `active_probability`, so a constant and a fitted rate stop rendering
  identically. That is the UI thread's side and is not in this PR.
- **How it unifies:** one definition of "what week is it" for a league, the one
  `league-week.js` already wrote and which had a single importer.
- **A held-out test would look like:** for availability, the fit's own gate —
  Brier or log loss of `active_probability` against whether the player actually
  played, on held-out seasons, scored separately for the `constants`, `pooled` and
  `role` sources. That gate exists (`scripts/fit-availability.mjs`) and is a deploy
  step, not this PR's.
