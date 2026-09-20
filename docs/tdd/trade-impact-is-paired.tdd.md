# The trade simulator's headline property had no test, and breaking it changed nothing

## What was untested

`season-sim.js#tradeImpact` plays the rest of a league's season twice — once as
it stands, once with the trade applied — and reports the difference in title
odds, playoff odds and expected wins. It advertises on its own payload that the
two runs are paired:

```
server/services/trade-engine.js → routes/trades.js:1132 → tradeImpact(lg, { ..., seed: 1 })
server/services/season-sim.js:384
  const pairedSeed = seed == null ? Math.floor(random() * 0xFFFFFFFF) : Number(seed);
  const before = withRandomSeed(pairedSeed, () => simulateSeason(...));
  const after  = withRandomSeed(pairedSeed, () => simulateSeason(..., overrides));
```

Common random numbers are the whole reason the output means anything. Without
them the reported delta is the trade's effect *plus* Monte Carlo noise, and at
any run count a page can wait for, the noise is the larger term.

Nothing in the suite executed this function. The only test naming it,
`test/trade-verify.test.js`, does not run a simulation.

## The claim, measured

Break the pairing — give the second run `pairedSeed + 1` — and run the whole
suite:

```
npm test (with test/trade-impact-is-paired.test.js removed, pairing broken)
  → 2,950 tests / 2,909 passed / 0 failed / 41 skipped · exit 0
```

**Nothing failed.** The property the function is built around could be deleted
and every test in the project still passed. That is the gap this fixture closes,
and it is stated as a measurement because "this is untested" is otherwise just an
assertion about a negative.

## The test

Five tests in `test/trade-impact-is-paired.test.js`, running `tradeImpact` end to
end on a seeded six-team league.

The central one is **a trade of nothing**. Give no players, get no players, and
every delta must be exactly zero — not small, zero. Under common random numbers
the two runs play the same seasons with the same rosters, so every difference
cancels exactly. A diverging seed, an unpaired source of randomness, or an
ordering that depends on iteration shows up here and nowhere else.

The others: the payload echoes the seed it was given rather than replacing it;
the same seed reproduces exactly; and a real trade moves the numbers, which is
what stops a function that returns zero for everything from satisfying the
null-trade test.

## Two things the fixture got wrong first, both recorded

### The league was degenerate, and the tests passed anyway

The first roster construction snaked three rounds of RBs and WRs across six
teams. Three rounds do not balance — the index sums came out `23 + i` and
`28 − i` — so one roster was strictly stronger and the simulation returned:

```
me:   title_before 1, title_after 1, title_delta 0
them: title_before 0, title_after 0, title_delta 0
```

Team 1 won the title in 100% of runs. Every delta was zero because the season was
never in doubt, so the null-trade test passed while proving nothing whatsoever
about pairing. It was caught by printing the payload rather than by an assertion,
which is the point: **a zero-valued assertion is satisfied by a broken world just
as happily as by a correct one.**

Fixed two ways. Four rounds balance where three do not —
`i + (11 − i) + (12 + i) + (23 − i)` is 46 for every `i` — and a
**non-degeneracy guard** now asserts `0 < title_before < 1` for both teams before
any delta is trusted. Measured on the current fixture: 0.20 and 0.29 against a
uniform 0.167, with playoff odds 0.77 and 0.79.

### Season totals are not what the projection model reads

The second version seeded `player_season_stats` and still produced a scoreless
league. `buildProjections` reads `player_week_usage` — per-week opportunity and
production — through `projections.js#history()`, and with no rows there it
returns an empty Map, every player scores zero every week, and the season becomes
a set of scoreless ties.

So the fixture now seeds a real 2025 usage log: seventeen weeks per player,
scaled by his rank within his position, for all 72 players. That is what makes
the simulation a simulation rather than a coin flip between zeroes.

## Injections

| # | Injection | Applied | Result |
|---|-----------|---------|--------|
| 1 | The two runs get different seeds — the pairing broken | APPLIED | 4 pass / **1 fail** (the null-trade test) |
| 2 | Projections rebuilt between the runs | APPLIED | 5 pass / 0 fail — **inert, see below** |
| 3 | The overrides dropped, so the trade never happens | APPLIED | 4 pass / **1 fail** |
| 4 | An explicit seed ignored and a random one used | APPLIED | 3 pass / **2 fail** |

### Injection 2 was inert, and it exposes a comment that is not accurate

`season-sim.js:378-380` says:

> One projection build shared by both runs — rebuilding would introduce noise
> that has nothing to do with the trade.

Rebuilding does not introduce noise. `buildProjections` reads rows and computes;
it draws no random numbers (`projections.js` uses `random()` only in the
samplers, e.g. `:898`), so a second build returns an identical Map and consumes
nothing from the seeded stream. The injection changed a line and changed no
behaviour, which is why the suite stayed green — the same shape as the inert
mutation in `docs/tdd/season-delta-counts-weeks-left.tdd.md`.

There are good reasons to share the build — it is expensive, and sharing it fixes
the inputs if the database were to change between the two calls — but "noise" is
not one of them. `season-sim.js` belongs to another editor, so the comment is
reported rather than changed.

## The five questions

**Is it well built?** It adds a test and touches no source. The fixture is
balanced by construction and the balance is asserted rather than assumed.

**Is it based on stats, or made up?** The usage log is synthetic and says so; it
exists to make the model run, not to make a claim about football. What is
measured is the simulator's own arithmetic property, and that is exact rather
than statistical — which is why the assertion is `=== 0` and not a tolerance.

**How do we know?** Four injections, each printed APPLIED, three caught and the
fourth shown to be inert rather than missed. Plus the whole-suite run above,
which shows the same break passing unnoticed before this file existed.

**Should this data point anywhere else?** Yes: `routes/trades.js:1132` passes
`seed: 1` from the live route, so every user-facing trade-impact call depends on
exactly this property. And the served-field sweep that motivated this can now be
run against `tradeImpact` at all.

**How does it unify?** Same idea as the `volume_tiebreak` guard: a check shaped
around one line cannot see the next problem. A test that never runs the function
cannot see any of them.

## Still open, and why

The task this closes had a second half: pin `projection_basis` and
`projection_fit` on `tradeImpact`'s payload. **Neither field exists on `main`** —
they arrive with the fantasy plan's #58 pins on hold `386ffe5`. The fixture that
makes pinning them possible is here; the pins themselves wait for that branch,
and the served-field mutation on those two fields stays open until then.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XL5WQkomfhtJ925G1wZ9yr
