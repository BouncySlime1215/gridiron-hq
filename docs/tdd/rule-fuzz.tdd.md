# RULE-FUZZ: Nick's hard rules as property tests over random leagues

Unit 18. `test/rule-fuzz.test.js` (38 cases), with the generator
`test/fixtures/rule-fuzz-league.mjs`, the oracle `test/fixtures/nick-rules.mjs`
and the recorded seeds `test/fixtures/rule-fuzz-seeds.json`. Tests only: no
served code changes.

## Pre-registration

- **Metric:** violations per rule, per risk mode, counted by an oracle that
  reads only the planner's result, over seeds 1..300 (made-up leagues of 4-8
  teams, 7-14 players each) plus the recorded seeds.
- **Pass bar:** 0 violations of every rule the planner on `main` enforces, in
  every mode, and a non-vacuous sweep (at least half the leagues produce a
  deck or an explicit confirm-dice no-trade pick, and at least one mode
  serves decks in half the leagues). Each rule still waiting on a PR runs as a node:test `todo`: it runs
  in full and prints its count, but does not fail CI until its enforcement
  lands on `main` and the rule moves from `PENDING` to `ENFORCED`.
- **What would fail it:** any enforced-rule violation on any seed; the oracle
  missing a hand-built violation of any rule or any listed surface; the same
  seed giving a different league or different violations; a mode where fewer
  than half the leagues serve a deck or explicitly pick no trade; no mode
  serving decks in half the leagues.

## The rules (the oracle's reading)

| rule | reading |
|---|---|
| never_give | Nico Collins (160) and Chase Brown (80) are never in a give |
| aj_brown | A.J. Brown (277) is given only when the same step gets a Blue chip (83+) who is a consistent weekly scorer |
| final_get | every player a plan leaves Nick holding that he did not start with scores 83+; flip leg-2 players and suggested targets count too |
| overpay | value given <= value got, except a depth-only 2-for-1 (no 83+ or pinned player in the give), at most +12%, carrying a confirmed rise in lineup points and title odds (`step.depth_premium.confirmed`) |
| no_olave | Chris Olave (290, #394's pin) is never a get, a give, a target, a suggestion or a flip |
| no_buyback | no get, from any team, of a player Nick sent away in any trade this season (whole season, no price-fall exception) |
| no_undo | no step with a manager both takes back a player Nick sent him and gives back one he sent Nick, in one trade this season |
| beats_no_trade | every served deck card and backup: confirm verdict not failed, confirm-dice expected gain > 0 |

Surfaces checked: best plan; every deck card and each of its playbooks'
opening, walk-away, ladder packages, reply-table next moves and
`negotiation.alt_package` (#386); backups; the risk-mode sheet's first steps;
flip legs; catch-up items that name a deal (`plan_key`: desperate, swing);
LADDER-01 rungs and each rung's `on_no` (#394); suggestions and targets. A
surface not listed here is not checked.

## Measured on `main` 58ad700 (served env, no rule flags)

Leagues with at least one violation, of 300 (violation counts in brackets):

| rule | safe | balanced | all_in | status |
|---|---|---|---|---|
| never_give, notes read | 0 | 0 | 0 | ENFORCED |
| overpay | 0 | 0 | 0 | ENFORCED |
| never_give, notes missing | 144 (1,015) | 153 (1,826) | 141 (1,691) | todo |
| aj_brown | 114 (579) | 133 (1,140) | 140 (1,266) | todo |
| final_get | 72 (160) | 75 (287) | 97 (437) | todo |
| no_olave | 161 (1,428) | 163 (4,396) | 163 (3,694) | todo |
| no_buyback | 147 (1,228) | 148 (3,487) | 152 (3,065) | todo |
| no_undo | 47 (151) | 64 (499) | 77 (616) | todo |
| beats_no_trade | 1 (1) | 0 | 0 | todo |

Decks: safe 239, balanced 297, all_in 297 of 300. Each mode's sweep: 300
leagues, 1,785 rosters, 28,210 candidate plans. Gate fuzz: 6,000 random offers
through `rankPlans` (every mode) and 5,000 random packages through
`nickOverpays`. Whole file: 57 s on the cloud container.

## Measured on #398 (0e207db) merged with this branch, RULE_FUZZ_N=80

0 failures. Clean in every mode: never_give (with and without notes),
aj_brown, overpay, no_undo, beats_no_trade. Still broken: final_get (19 / 24 /
31 leagues; the floor is off on the served path), no_olave (18 in each mode),
no_buyback (13 in each mode; `BUYBACK_FALL` lets a sold player back after a 10%
fall). Safe serves a deck in 0 of 80 leagues and picks no trade in all 80;
balanced and all_in serve decks in 79.

## Reproduce a failure

```
node -e "import('./test/fixtures/rule-fuzz-league.mjs').then(m => console.log(m.makeFuzzLeague(6).draw))"
RULE_FUZZ_BASE=1 RULE_FUZZ_N=2000 npm test -- test/rule-fuzz.test.js   # a wider local sweep
```

The first failing seed per rule and mode is in `rule-fuzz-seeds.json`
(`recorded`) and is replayed on every run.
