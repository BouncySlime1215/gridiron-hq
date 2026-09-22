# `off_fourth_down_rate` is neither quantity its labels claim, and it breaks coach aggression

Found 2026-09-22 while checking a suspected mislabel for Phase A. It is not a
mislabel. It is a unit mismatch with a measurable effect on the simulator, and
it makes one advertised capability unreachable.

**None of these files is mine to edit** (one editor per server file). This is a
report, not a change.

## What the code computes

`server/services/nfl-pbp.js:247`

```js
if (down === 4) { side.fourth_att++; if (num(rec, 'first_down') === 1) side.fourth_conv++; }
```

`server/services/nfl-pbp.js:461`

```js
[`${p}_fourth_down_rate`]: r3(div(a.fourth_conv, a.fourth_att)),
```

`fourth_att` increments on **every** fourth-down play, so punts and field goals
are in the denominator. `fourth_conv` requires a first down, which only a
go-for-it attempt (or a defensive penalty) produces. The ratio is therefore
*the share of all fourth downs that ended in a first down* — roughly
go-for-it rate × conversion rate. That is a coherent statistic. It is simply
not either of the two things the codebase says it is.

## The three quantities, measured from the same pbp the code reads

2024 regular season, 4,094 plays on down 4 — play types: punt 2,046,
field_goal 1,016, pass 459, run 305, no_play 267, qb_kneel 1.

| quantity | value | who claims this is what it is |
|---|---|---|
| **what the code computes**, `fourth_conv/fourth_att` | **0.1199** | — |
| go-for-it rate, `(run\|pass)/all 4th downs` | 0.1866 | `football-context.js:195` "goes for it on fourth down"; `nfl-sim-policy.js:503` "how often this team actually goes for it" |
| conversion rate, `converted/went for it` | 0.5681 | `nfl-features.js:60` "Fourth down conversion rate" |
| go-for-it × conversion | 0.1060 | what the computed value actually approximates |

Both labels are wrong, and wrong in opposite directions — one by a factor of
1.6, the other by 4.7.

## The consequence, replayed over 256 team-seasons

`server/services/nfl-sim-policy.js:509`

```js
export function coachAggression({ rates, leagueFourthDownRate = 0.20 }) {
  const own = rates.off_fourth_down_rate ?? leagueFourthDownRate;
  const delta = own - leagueFourthDownRate;
```

The default `0.20` is a **go-for-it** rate — it sits 0.0134 from the measured
go-for-it rate of 0.1866 and 0.0801 from the value actually being fed in.
`nfl-sim-learn.js:52` carries the same 0.20 as its prior. So `delta` subtracts
a go-for-it rate from a share-of-all-fourth-downs. Replaying the function over
every team-season 2018-2025:

```
team-seasons evaluated        256
  conservative (delta<-0.03)  235  (91.8%)
  neutral                      21   (8.2%)
  aggressive  (delta>0.03)      0   (0.0%)

ep_threshold_shift: mean +0.2716   min -0.0881   max +0.5516
```

Two defects follow, both provable:

1. **A league-wide conservative bias.** `ep_threshold_shift` averages **+0.2716
   expected points** across all 32 teams when a correctly-scaled comparison
   would average about zero. Every simulated staff is told it needs a quarter
   of a point more cushion than it really does before going for it.
2. **The aggressive branch is unreachable.** Being called aggressive requires
   the metric above 0.23. Its maximum across 256 team-seasons is 0.229, so
   **zero** team-seasons ever take that branch. The docstring says the module
   exists so "a simulated Ravens team can be correctly more aggressive than a
   simulated Steelers one". With real data it can never say that about anyone.

## A third consumer reasoning from the wrong reading

`server/services/td-features.js:263`

> off_fourth_down_rate doubles as the kicker-quality proxy the brief asks for: a
> team that does not trust its kicker goes for it more

That inference needs the go-for-it rate. The value supplied rises when a team
*converts*, so a team with a good offence reads as distrusting its kicker.

## Cheapest correct fix, for whoever owns these files

Emit the two quantities separately at `nfl-pbp.js:461` rather than overloading
one key — a `fourth_down_go_rate` (`went/fourth_att`) and a
`fourth_down_conv_rate` (`went_conv/went`) — then point `coachAggression` and
`td-features.js` at the go rate and `nfl-features.js:60` at the conversion
rate. Renaming alone would not fix `coachAggression`, because its 0.20 constant
and its measured input must be the same quantity for `delta` to mean anything.

Note this changes stored feature values, so anything fitted on
`off_fourth_down_rate` needs refitting, and the migration is not a pure rename.

## The five questions

- **Well built?** No, and the defect is in the seam between a producer and three
  consumers rather than in any one of them.
- **Stats or made up?** Measured: 4,094 fourth-down plays in 2024 for the three
  rates, 256 team-seasons for the replay.
- **How do we know?** The repo's own arithmetic was reproduced line for line
  from `nfl-pbp.js:247` and `:461` against the same nflverse pbp it ingests, and
  `coachAggression` was replayed as written.
- **Pointed anywhere else on the platform?** Yes, and that is the problem:
  `football-context.js` traits, `td-features.js` red-zone context,
  `nfl-sim-policy.js` module 16, `nfl-specialists.js:50`.
- **How does it unify?** It will once the two rates are separate keys.
