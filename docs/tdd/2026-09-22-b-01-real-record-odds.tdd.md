# B-01 — season sims start from the real record

Branch `claude/cloud-b-01-real-record-odds`, base `origin/main` at `a3e2bf3`.

## Audit (on `a3e2bf3`)

| Call site | What it passed | Effect |
|---|---|---|
| `server/routes/model.js:458` GET `/:leagueId/simulate` | `Number(req.query.from_week) \|\| 1` | week 1 unless the page sends `from_week` |
| `server/routes/model.js:475` POST `/:leagueId/trade-impact` | `Number(req.body?.from_week) \|\| 1` | same |
| `server/services/title-odds-trades.js:66` `tradeImpact(...)` | nothing → `fromWeek = 1` | week 1 always |
| `server/routes/trades.js:1155` sense-check `tradeImpact(...)` | nothing → `fromWeek = 1` | week 1 always |

`initialRecords()` (`server/services/season-sim.js:120-122`) returns an empty
record when `fromWeek <= 1`, so every one of these simulated a 5-0 team as 0-0.

The incumbent week producer is `leagueCurrentWeek(lg)`
(`server/services/league-week.js`): `leagues.current_week` from the last sync,
then the payload's `status.currentMatchupPeriod`, then the NFL-schedule week.

Not touched, reported: `myPlayoffOdds()` in `server/services/trade-engine.js:1365`
already passes a week, but from `tradeWeekContext()` (the NFL week), not the
league week. Same value in a normal season; a different producer.

## Change

`simStartWeek(lg, requested)` in `server/services/season-sim.js` is the one
producer: an explicit integer week ≥ 1 wins; a payload whose `payload_season`
differs from `season` (the pre-draft fallback) starts at week 1, because its
scored weeks are last season's games; otherwise `leagueCurrentWeek(lg)`.
`simulateSeason` and `tradeImpact` both resolve through it when no week is
passed, so the two service call sites change with no edit. `routes/model.js`
stops pinning `|| 1` and keys its memo on the resolved week.

`client/src/components/TradeCard.tsx` does not assume week 1 (its only week
reference is `p.matchup?.week` in a tooltip); not edited.

## RED

`b8bfaf5` — `test: RED — season sims ignore a team's real record (B-01)`

Run against the unfixed source (the final test file, re-run after the last
assertion change): 4 of 4 fail. The first failing assertion:

```
not ok 1 - B-01: with no fromWeek, a 5-0 team in week 6 is simulated as 5-0
  expected: 6
  actual: 1
```

## GREEN

`20a5c49` — `fix: season sims start from the league's current week with its real record (B-01)`

`test/b-01-real-record-odds.test.js`: 4 pass, 0 fail.

The fixture has no weekly projection history, so every simulated week is a
0-0 tie and the simulated standings are exactly the carried-in record. Team 1
is listed last so it loses 0-0 tie-breaks: from week 1 its playoff odds are 0
(the fixture's control, asserted ≤ 0.1), from week 6 at 5-0 they are ≥ 0.9.

## Mutation sweep (on the GREEN tree)

| Mutant | Where | Result |
|---|---|---|
| M1 `simStartWeek` returns 1 instead of `leagueCurrentWeek(lg)` | unit | **killed** (tests 1, 2) |
| M2 `simulateSeason` uses `requestedWeek ?? 1` instead of the helper | call site | **killed** (test 1) |
| M3 GET `/simulate` back to `Number(req.query.from_week) \|\| 1` | route call site | **killed** (test 4) |
| M4 drop the `payload_season` guard | unit | **killed** (test 3) |
| M5 `explicit >= 1` → `explicit >= 0 && explicit !== 0` | unit | survived — designed control, equivalent mutant |

Not-applied control: M5 changes the text and no behaviour, and the suite
stays green on it, which shows a pass here is not the suite passing on any
edit.

Correction (review round 1): the claim that `tradeImpact`'s `simStartWeek`
call "only labels `from_week`" was wrong. A mutant there that resolves to 1
passes 1 on to `simulateSeason`, so the real record is dropped. Round 1 below
adds a test that kills it.

## Review round 1 (2026-09-23, local fixer)

The skeptics found two problems. First, `myPlayoffOdds` in trade-engine.js,
which feeds the Trades page's horizon weights and `ideaContext.playoff_odds`,
passed `fromWeek: tradeWeekContext().week`. That is the NFL `game_lines` week,
a second producer for the start week. It beat `simStartWeek` and its
`payload_season` guard. Second, the route and `tradeImpact` call sites were
covered only by a text grep.

Fix: `myPlayoffOdds` now uses `simStartWeek(lg)`, keys its cache on that week
and reports `sim.from_week` in its source. `tradeWeekContext()` is still used,
but only for the asset fingerprint. After the fix, none of the callers of
`simulateSeason` or `tradeImpact` in `server/` passes an explicit week
(checked with `grep -rn "simulateSeason(\|tradeImpact(" server`). The two
routes pass `?from_week` through `simStartWeek`.

RED at 101e7136: test 8 failed (`'season simulation, 1000 runs from week 6'`
on a league whose `current_week` is 4, with `NFL_WEEK=6`). GREEN at 6992cde7:
8/8 pass.

New tests in `test/b-01-real-record-odds.test.js`, numbered 5 to 8:
5. `tradeImpact` with no week on the week-6 fixture: `from_week` is 6 and
   `me.playoff_before` is at least 0.9.
6. GET `/:id/simulate` over HTTP as a league member: `from_week` is 6 and team
   1's odds are at least 0.9. After `current_week` changes to 7, the same
   request returns `from_week` 7, which is the memo-key check.
7. POST `/:id/trade-impact` over HTTP: `from_week` is 6 and
   `me.playoff_before` is at least 0.9.
8. `myPlayoffOdds` on a league with `current_week` 4 and `NFL_WEEK` 6: the
   source ends "from week 4", and the value equals `simulateSeason` directly
   (seed 20260918, 1000 runs). A league whose `payload_season` is 2025 gets
   "from week 1".

Mutation sweep on 6992cde7 (the skeptics' mutants; run with
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<tmp> node --experimental-test-module-mocks --test --test-reporter=tap test/b-01-real-record-odds.test.js`,
reverting after each one):

| Mutant | Where | Result |
|---|---|---|
| baseline, no edit | none | 8/8 pass |
| R1 `tradeImpact`: `Number(requestedWeek) \|\| 1` | season-sim.js tradeImpact | **killed** (test 5) |
| R2 POST `/trade-impact` `fromWeek: 1` | model.js | **killed** (test 7) |
| R4 `/simulate` memo key `req.query.from_week ?? 1` | model.js | **killed** (test 6) |
| R5 GET `/simulate` `fromWeek: 1` | model.js | **killed** (test 6) |
| R6 `myPlayoffOdds` back to `fromWeek: target.week` | trade-engine.js | **killed** (test 8) |

Related suites on 6992cde7: trade-engine-correctness 15/15,
decision-leftovers-home-away 5/5, trade-verify 24/24. The first of these
mocks trade-engine's season-sim imports and asserts "from week 2"; it still
passes.

## Nick's five questions

1. **Well built?** One helper, two default parameters, one route edit. No new
   week source; it reuses `leagueCurrentWeek`.
2. **Stats or made up?** Neither: this is bookkeeping. The completed games'
   results are read from the league payload by the existing `initialRecords()`.
3. **How we know:** the fixture test above (a 5-0 team goes from 0 to ≥ 0.9
   playoff odds). No backtest; nothing here is fitted.
4. **Pointed anywhere else?** Yes, every caller of `simulateSeason` /
   `tradeImpact` that passes no week now starts at the league week
   (title-odds-trades, trade sense-check, and others that pass nothing).
   The trade engine's `myPlayoffOdds` (Trades page, Coach, Trade Lab) used to
   pass the NFL week. Since review round 1 it uses `simStartWeek` too.
5. **How it unifies:** four call sites that each chose week 1, plus the trade
   engine's own NFL-week choice, now share one producer, which itself defers to the app's one league-week producer.

**Does not cover:** leagues in their playoffs. If the league week is past the
last regular-season week, `simulateSeason` returns its existing named error
`no remaining fixtures in this league schedule` instead of a week-1 answer.
**What would make it wrong:** a stale `leagues.current_week` (last sync long
ago) would start the sim too early and simulate already-played weeks.
