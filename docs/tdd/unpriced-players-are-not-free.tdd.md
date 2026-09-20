# A player the market cannot price left a roster for free

Model-audit item D13.

## The defect

`assetUniverse` builds each asset from two joins, a projection row and a market
row. When the market row is missing:

```
server/services/trade-engine.js:417-421
  vor: v?.vor ?? 0,
  adp: v?.adp ?? null,
  value: m?.value ?? 0,
  trend30: m?.trend30 ?? null,
  pos_rank: m?.pos_rank ?? null,
```

`adp` above it and `trend30`/`pos_rank` below it all resolve the same absent row
to `null`. Only `value` resolves it to `0`. So the file already knew the
difference between "the market says zero" and "the market said nothing", and one
field spent it.

Downstream, `evaluate`'s `side()` sums `Math.max(0, p.value)` into `value_out`
and `value_in`, and `fairnessLabel` divides the difference by the total. A player
with no market row therefore moves neither total. He leaves a roster for free.

Who is unpriced in practice: anyone FantasyCalc has no dynasty row for on this
league's format key — a late rookie, a practice-squad call-up who just got
carries, a kicker or defence in a format that prices neither. Those are exactly
the players a manager is most likely to be offered as a throw-in.

## What the RED run actually showed, which was worse than the premise

I went looking for a deal reported as "even money". The fixture returned
something worse.

Giving away team 1's unpriced WR1 for a priced WR from team 2:

```
fairness: 'lopsided my way'
```

Not a wash. The engine recommends the deal, and recommends it *because* it
cannot see what the deal costs. A manager reading that sends the offer with
confidence.

The evidence file says this rather than the tidier version because the premise I
wrote down first was not what the code did, and the difference is the whole
severity of the finding.

## RED

`test/unpriced-players-are-not-free.test.js`, four tests, 4 of 4 failing at
`791b131`. The fixture is a six-team league in which one rostered WR has a
projection row and no `dynasty_values` row — the real shape of the bug, not a
`value: null` written by hand onto an asset.

Commit: `799e83f`.

## GREEN

Three changes, none of which touches a gate that decides whether a deal is shown.

1. `value_priced: m?.value != null` on the asset. `value` itself is untouched and
   stays a number, because every consumer of the universe sums it.
2. `value_out_unpriced` and `value_in_unpriced` per side, each naming the total
   it breaks.
3. `fairnessLabel(delta, total, unpriced)` returns `partly unpriced` when any
   player in the deal has no price. It does **not** invent one from projections:
   putting a made-up number where a measured one belongs is the failure this
   project keeps finding, and the honest answer to "what is this worth" here is
   that nobody knows.

### A design error the test caught

The first version counted `[...gives, ...gets]` as one `value_unpriced` per side.
That is the same union for both sides of a two-party deal, so it returned 1 on
both sides and distinguished nothing — while its own comment claimed it showed
"who is being short-changed". The test asserted `them.value_unpriced === 0` and
failed, and the test was right about the intent and wrong about the field. Both
were corrected: the count splits per leg, and each number now maps to the one
total it explains.

Recording it because the reflex on a red test is to move the assertion.

```
# tests 4
# pass 4
# fail 0
```

## Injections

Against the GREEN tree, each applied and reverted, `APPLIED` printed before each
run so a green result cannot be a mutation that never landed.

| # | Injection | Applied | Result |
|---|-----------|---------|--------|
| 1 | The asset claims every player is priced (`value_priced: true`) | APPLIED | 1 pass / **3 fail** |
| 2 | The label stops refusing and guesses again | APPLIED | 3 pass / **1 fail** |
| 3 | The per-leg counts collapse back into one union | APPLIED | 3 pass / **1 fail** |
| 4 | `value_out` silently drops 1 from a priced deal (control) | APPLIED | 3 pass / **1 fail** |

Injection 4 is the control for the regression half: the fourth test asserts a
fully priced deal is unchanged, and an assertion like that is worthless if it
cannot fail. It fails.

## What is NOT fixed, deliberately, and where it is

`fairEnough` at `trade-engine.js:1146` gates on
`theirValuePct >= -8`, and `theirValuePct` is `B.value_delta / (B.value_out +
B.value_in)`. If the unpriced player is on THEIR side, their `value_out` is
understated, `B.value_delta` is overstated, and a package that takes more from
them than it should can clear a gate meant to stop exactly that.

That is real and it is not fixed here. Changing a gate changes which deals the
search returns, which is a behaviour change with a wide blast radius and no
measurement behind it at four in the morning; this change deliberately alters
only what a deal SAYS, never which deals exist. The gate is now visible to
anyone reading it — `value_out_unpriced` is on the side object the gate reads —
and it is on the follow-up list with this line number rather than silently left
or silently changed.

## The five questions

**Is it well built?** It adds one boolean derived at the same place and in the
same way as the three `null`s around it, and two counts that are each a filter
over a list already in scope. No new data source, no new arithmetic on prices.

**Is it based on stats, or made up?** Neither, and that is the point: the change
exists to stop a made-up number (`0`) from standing in for a missing measured one.
No price is invented anywhere in it.

**How do we know?** Four injections, each printed APPLIED, each caught; plus the
design error above, which the test caught before the code shipped.

**Should this data point anywhere else?** Yes, and two places are named rather
than guessed. The `fairEnough` gate above is the first. The second is every other
consumer that sums `value`: `routes/tradelab.js:125` (`starter_value` as
`sum(max(0, p.vor))`) is on VOR and unaffected, but `t.players_value` and
`t.market_capital` at `trade-engine.js` sum `p.value` across a whole roster, so an
unpriced player deflates a team's market capital too. `value_priced` is on the
asset, so those can read it without another pass over the database.

**How does it unify?** It is the same fix as the waiver board's hand-set `0.9`
published as a fitted confidence and as `volume_tiebreak`: a number that looks
like a measurement because it is standing where one belongs. The vocabulary is
now consistent across three of them — the basis travels with the number, and a
model that does not know says so instead of defaulting.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XL5WQkomfhtJ925G1wZ9yr
