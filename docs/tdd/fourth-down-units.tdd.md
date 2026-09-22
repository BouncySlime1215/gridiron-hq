# Fourth-down rate: a conversion rate that four consumers read as aggression

RED `94110be` · GREEN `ed108b6` · producer half only

## What was wrong

`nfl-pbp.js:215` drops every `play_type` that is not `pass` or `run` before the
accumulator sees it. Punts and field goals never arrive. So the counter at
`:247` — `if (down === 4) { side.fourth_att++; … }` — has go-for-it attempts in
its denominator, and `off_fourth_down_rate` at `:466` is a **conversion rate**.

One consumer reads it that way:

| where | what it says |
|---|---|
| `nfl-features.js:60` | `['fourth_down_rate', 'Fourth down conversion rate', 'rate']` — correct |

Four read it as an **aggression rate**:

| where | what it says |
|---|---|
| `nfl-sim-policy.js:503` | "`off_fourth_down_rate` is how often this team actually goes for it" |
| `nfl-sim-policy.js:510` | `leagueFourthDownRate = 0.20` |
| `nfl-sim-learn.js:52` | `off_fourth_down_rate: 0.20` as the league prior |
| `football-context.js:195` | trait label `'goes for it on fourth down'`, inverse `'punts and kicks'` |
| `td-features.js:262` | "a team that does not trust its kicker goes for it more" |

## How we know — measured, not argued

`docs/evidence/fourth-down-units.mjs`, run against a database populated by
`syncPbpSeason` for 2022–2025 (2,174 team-weeks, 1,602 with a finite value):

```
mean   0.5442
p10 0.000  p25 0.000  median 0.500  p75 1.000  p90 1.000
share >= 0.40: 63.2%
share <= 0.25: 31.0%
```

Against a prior of `0.20`. `coachAggression` computes
`clamp(-(own - 0.20) * 3.0, -0.6, 0.6)`, so:

```
mean ep_threshold_shift                         -0.2312   (0 = league average)
pinned at the -0.6 clamp floor                    63.2%   of team-weeks
labelled "more conservative than the league"      29.0%   of team-weeks
```

Nearly two thirds of every team-week in four seasons is handed to the simulator
as a maximally aggressive coaching staff, and the clamp is what hides it: the
number is wrong by a factor of two and a half and nothing throws, warns or
looks odd downstream. This is the shape CLAUDE.md warns about — a fault that
goes inert quietly instead of saying so.

The second defect is in the same numbers. `p25 0.000` and `p75 1.000` say this
is a rate over roughly one to three snaps a week. Even with the units fixed, a
single week of it is not a coaching trait, and `football-context.js` is
printing "punts and kicks" for a team that went 0-for-1.

## What changed

Producer only, additive:

```
off_fourth_down_go_rate      fourth_att / fourth_situations
off_fourth_down_attempts     fourth_att
off_fourth_down_situations   fourth_situations
```

`fourth_situations` is incremented above the `pass`/`run` filter, the only
point where punts and field goals are still in hand, for `play_type` in
`{pass, run, punt, field_goal}`. A fourth-down penalty is not a decision — the
down replays — and `no_play` has already returned by then. Both the offensive
and defensive slots are counted.

`off_fourth_down_rate` is untouched. Renaming it would silently change the
meaning of every stored row, and it is already labelled correctly in
`nfl-features.js`.

The two counts are published alongside the rate because a consumer cannot
otherwise tell a `0.000` that means "punted twice" from a `0.000` that means
"went for it once and missed".

## RED

Three of four assertions failed. The fourth — the conversion rate is `0.5` in a
week with one conversion in two attempts, and `0` in a week with none in three
— passed at RED and is a regression guard: that field is correct today and must
not move.

## Mutation testing — seven injected, seven caught

| # | injected | result |
|---|---|---|
| 1 | drop `punt` from the situation set | 3 fail |
| 2 | drop `field_goal` | 3 fail |
| 3 | drop the `down === 4` guard | 3 fail |
| 4 | conversion rate over situations instead of attempts | 1 fail |
| 5 | go rate inverted (`situations / attempts`) | 1 fail |
| 6 | defensive slot not counted | 1 fail |
| 7 | count fourth-down penalties as decisions | 2 fail |

## What is still broken

**The bug is still live.** All four consumers still read
`off_fourth_down_rate`. They are in `nfl-sim-policy.js`, `nfl-sim-learn.js`,
`football-context.js` and `td-features.js` — none of which this thread owns,
under the one-editor-per-file rule. The field they need now exists; switching
them over is routed up.

Two things to decide when it is switched:

1. `nfl-sim-learn.js:52`'s prior of `0.20` is roughly right *for the go rate*,
   so it does not need to move — but it should be re-measured, not assumed.
2. A single week's go rate should not drive a coaching trait. Whoever moves
   `coachAggression` should read a season-to-date or multi-week figure, and
   `off_fourth_down_situations` is now published so the sample size is visible.

## The five questions

**Well built?** Producer-side, additive, seven mutations caught, no stored row
changes meaning. Half a fix: the consumers are not ours to move.

**Stats or made up?** Measured. 1,602 team-weeks of 2022–2025, mean 0.5442
against an asserted prior of 0.20, 63.2% clamp-pinned. Script committed at
`docs/evidence/fourth-down-units.mjs`.

**How do we know?** Run the script against a `syncPbpSeason`-populated database
and the numbers above reproduce. The four consumer citations are line numbers
in the tree, and each quotes its own comment saying what it thinks the field
means.

**Pointed anywhere else on the platform?** Yes — the same class of defect is
any field whose name outlived its definition. The specific lesson is that a
`clamp` is a place faults go to hide, and this one hid a 2.5× error across four
seasons and four consumers.

**How does it unify?** Once the consumers move, the simulator's coach
aggression, the team-trait prose on the football-context surface and the
kicker-quality proxy in `td-features` will all be reading the same correctly
defined number instead of three different readings of the wrong one.
