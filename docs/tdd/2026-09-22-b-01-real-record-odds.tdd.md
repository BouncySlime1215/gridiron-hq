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
edit. `tradeImpact`'s own `simStartWeek` call only labels `from_week` in its
response (it passes the resolved week on to `simulateSeason`, which would
resolve the same week anyway); it has no mutant row.

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
   Callers that pass a week (trade-engine `myPlayoffOdds`, tests) are unchanged.
5. **How it unifies:** four call sites that each chose week 1 now share one
   producer, which itself defers to the app's one league-week producer.

**Does not cover:** leagues in their playoffs. If the league week is past the
last regular-season week, `simulateSeason` returns its existing named error
`no remaining fixtures in this league schedule` instead of a week-1 answer.
**What would make it wrong:** a stale `leagues.current_week` (last sync long
ago) would start the sim too early and simulate already-played weeks.
