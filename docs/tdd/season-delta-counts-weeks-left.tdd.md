# "Over the season" was a fixed ×17, in every week of the season

Model-audit item D11.

## The defect

```
server/services/trade-engine.js:119   const GAMES = 17;
server/services/trade-engine.js:1115  season_delta: +((post.points - before.points) * GAMES).toFixed(1),
```

`GAMES` is the length of an NFL regular season. It is not the length of what is
left of one, and `evaluate()` takes no league, so `side()` had no week to read.

Two surfaces print the result and both call it the season:

- `client/src/components/TradeCard.tsx:109` — "{season_delta} over the season"
- `server/routes/trades.js:1055`, inside the LLM prompt — "+{season_delta} over
  the season"

The second is the one worth pausing on. That string is what the model is told
about the deal, so a wrong magnitude does not merely mislead a reader; it
conditions the generated reasoning about whether the trade is worth making.

## Magnitude, measured rather than asserted

On a default league (regular season through week 14, playoffs 15-17):

| Week | Weeks actually left | ×17 overstates by |
|------|---------------------|-------------------|
| 1 | 17 | 0% — correct |
| 2 | 16 | 6% |
| 10 | 8 | 113% |
| 15 | 3 | 467% |

Nearly right when nobody is making desperate trades, and badly wrong in December
when everybody is. That shape is what makes it worth fixing rather than noting:
the number degrades in exactly the direction that flatters a bad deal, at
exactly the time of year a manager is most willing to believe it.

## RED

`test/season-delta-counts-weeks-left.test.js`, five tests, 5 of 5 failing.
Commit: `39a5a2a`.

The source change was written first and then removed to take the RED run, rather
than the run being taken before the design existed. That is stated plainly
because a RED taken after the fact proves less than one taken before, and the
injections below are what actually carry the weight here.

## GREEN

`seasonWeeksLeft(lg, week)`: the regular season's remaining weeks plus this
league's own playoff weeks, both from `leagueSchedule(lg)`, so a league with a
twelve-week regular season and a two-week final is counted as it really runs. It
returns 0 once the league is over — a trade made then buys nothing, and saying
zero is better than quietly falling back to a full season.

The count reaches `evaluate()` through `ctx.weeksLeft`, and is resolved **once
per evaluation** rather than once per side, because the two sides of one deal are
played out over the same weeks and computing it twice is how two halves of a
payload drift apart.

Served beside the number: `season_delta_weeks` (what was counted) and
`season_delta_basis` (`weeks_remaining`, or `full_season_default` when no caller
supplied one).

Wired at every internal call site that has a league: `findTrades` reads it once
per search, and `ladderInputs` resolves it once for both `offerFor` and
`offerForMany` so the two ladder entry points cannot disagree.

```
# tests 5
# pass 5
# fail 0
```

## Injections

Against the GREEN tree, each applied and reverted, `APPLIED` printed per run.

| # | Injection | Applied | Result |
|---|-----------|---------|--------|
| 1 | `season_delta` goes back to a flat ×17 | APPLIED | 3 pass / **2 fail** |
| 2 | The fallback stops admitting it is a fallback | APPLIED | 4 pass / **1 fail** |
| 3 | Playoff weeks dropped from the count | APPLIED | 3 pass / **2 fail** |
| 4 | The league's own schedule ignored for the default | APPLIED | 4 pass / **1 fail** |
| 5 | Each side derives its own count | APPLIED | **see below** |

### Injection 5 came back green, and that was the injection's fault

The first form of injection 5 was
`season_delta_weeks: gives.length ? weeksCounted : GAMES`. It ran APPLIED and the
suite stayed 5/5.

A green suite under an injection is a question, not a verdict, so it was worth
five minutes before writing "the assertion is weak". It was not weak — the
mutation was inert. Both sides of the fixture's deal give exactly one player, so
`gives.length` is truthy on both and no drift was created. The mutation changed a
line and changed no behaviour.

Replaced with one that actually differs per side —
`String(team.roster_id) === '1' ? weeksCounted : GAMES` — and it fails:

```
# pass 4
# fail 1
```

Recorded because "the test did not catch my mutation" and "my mutation did not
mutate anything" look identical from the outside, and only one of them is a
reason to change the test.

## One call site is not wired, and it is not mine

`server/routes/trades.js:934` — `POST /:leagueId/evaluate`, the Trade Lab
"evaluate this deal" surface — calls `evaluate()` without `ctx`, so it still
multiplies by 17. That file belongs to another editor, so the fallback is
deliberately unchanged there rather than crossed into: the route's behaviour does
not move, but it now serves `season_delta_basis: 'full_season_default'`, so the
assumption is visible instead of inferred from the number's size.

The handoff is one line. In `routes/trades.js:934`, pass
`{ weeksLeft: seasonWeeksLeft(lg, tradeWeekContext(lg).week) }` as `evaluate`'s
fourth argument, importing `seasonWeeksLeft` alongside the engine's other
exports. Test 4 in this file pins the current fallback, so it will need its
expectation moved in the same commit that wires the route — deliberately, so the
wiring cannot happen silently.

## The five questions

**Is it well built?** It reads the league's own schedule through the helper the
file already uses for its playoff weeks, resolves the count once, and changes no
gate. The fallback is preserved exactly so no surface moves without a decision.

**Is it based on stats, or made up?** Neither is fitted and neither needs to be:
this is counting weeks on a schedule the league publishes. What it removes is a
made-up number — 17 — standing in for a count that was always available.

**How do we know?** Five injections, each printed APPLIED; four caught
immediately, and the fifth caught once it was an injection rather than a no-op.

**Should this data point anywhere else?** Yes, and two are named rather than
guessed: the unwired route above, and `verdictFor` at `trade-engine.js:1030`,
which reads `ppg_delta` and `value_delta` and never `season_delta` — so the
verdict was never affected by this and is not changed here.

**How does it unify?** Same shape as D13 and as `volume_tiebreak`: a number that
looked measured because it stood where a measured one belongs. The basis now
travels with it, in the same vocabulary — the model says what it counted, and
when it did not know, it says that instead.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XL5WQkomfhtJ925G1wZ9yr
