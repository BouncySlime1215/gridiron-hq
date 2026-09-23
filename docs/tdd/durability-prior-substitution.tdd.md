# A substituted durability prior says so

`server/services/contingency.js` · `test/durability-prior-substitution.test.js`

## The five questions

**Is this well built?** It is a three-line change and a named constant, on the
smallest surface that fixes the fault. No model, no fit, no new data.

**Is this based on stats, or made up?** Neither — it is a provenance flag, not
an estimate. The number it marks (0.92) was made up, in the sense that nobody
fitted it; that is precisely what the flag now admits. Nothing here changes any
value the app computes.

**How do we know?** A RED commit that fails on today's code and a GREEN commit
that passes, plus a third test that passes in both states and is the reason the
flag has to exist: it shows the measured row and the substituted row agree on
type, range and `source`, so no caller could have inferred the difference.

**Should this data be pointed anywhere else?** Yes, and it already is needed
elsewhere: the fantasy plan's served availability basis is one of `fitted`,
`durability_prior` or `default_durability`, and without this flag its accessor
cannot reach the third. That was the request this change answers.

**How does it unify?** It puts the substitution on the same footing as the rest
of this file's honesty rules — `availabilityDegradation` already says out loud
when a layer is inert, and `availabilityBasis` already names which rates priced
a week. A durability prior that is a constant was the one remaining place where
a default was served in a measurement's clothing.

## The fault

`weeklyAvailability` serves a `durability_prior` for every skill-position
player. It is read from `availability()`, which is built from
`player_week_usage`, so a player with no usage row in any season through the
cutoff has no measured prior. The old line:

```js
const prior = base.get(p.id)?.available ?? 0.92;
```

The substitution was silent. Three things made that worse than it sounds:

1. **0.92 is inside the range measured priors occupy.** The measured value is
   `shrink(games / (tenureSeasons * 17), positionRate, seasons, 1.2)` clamped to
   [0.05, 0.99], and a durable receiver lands near 0.92 honestly. So the value
   itself carries no signal about its own origin.
2. **The row is served to `+toFixed(3)`.** A caller trying to detect the
   default by comparing to 0.92 would also catch every player whose real
   measurement rounds to 0.920.
3. **`source` does not help.** It reports which formula priced the week —
   fitted rates versus the published designation curve — not where the prior
   came from. It is the same string for both cases.

Who it hits: every rookie before his first game, and everyone the usage table
has not caught up with. On the live database `player_week_usage` holds 2021-25
and no 2026 rows, so in the 2026 season this is not a corner case.

## RED

`test/durability-prior-substitution.test.js`, three tests on a temporary
database. The fixture is two receivers: 101 with four seasons of sixteen games,
102 with nothing.

```
# tests 3
# pass 2
# fail 1
```

The failure is `durability_prior_measured` coming back `undefined` where the
test asserts `true`. The two passing tests are load-bearing: the first pins that
the fixture really is the case under test (`availability()` has a row for 101
and none for 102), and the third pins the indistinguishability — it passes
before and after, and if it ever fails it means the two cases became separable
by something other than the flag, which would make the flag redundant rather
than wrong.

## GREEN

```js
// No availability() row means no games on file through the cutoff, so there
// is no measured durability prior to serve. The constant that stands in is
// inside the range measured priors occupy, so the substitution has to be
// stated on the row: a caller reading `durability_prior` alone cannot tell
// a career measurement from this default.
const measuredPrior = base.get(p.id)?.available ?? null;
const prior = measuredPrior ?? DEFAULT_DURABILITY_PRIOR;
```

and on the served row:

```js
durability_prior: +prior.toFixed(3),
durability_prior_measured: measuredPrior != null,
```

with `const DEFAULT_DURABILITY_PRIOR = 0.92;` declared beside `MIN_MISSED`. The
other `0.92` in the file, at the practice-status branch, is a different quantity
— a multiplier applied to an already-computed probability — and was left alone
deliberately. Naming it would have implied the two were one number.

## What this does not do

It does not change `active_probability`, `durability_prior`, or any other
served value. It is purely additive: one boolean field. The default's *value*
is unchanged and unjustified, and that is still open — 0.92 has no fit behind
it. The flag makes that visible to a caller rather than fixing it, which is the
right order: nothing can be fitted for a player with no games, so the honest end
state is a served default that admits what it is.

It also does not decide what a surface should display. A consumer that wants to
hide or caption a defaulted prior now can; none does yet.

## Evidence

- RED commit: `test: RED — a substituted durability prior is served as if it were measured`
- GREEN commit: this change
- Full suite at the GREEN commit: recorded in the commit message.
