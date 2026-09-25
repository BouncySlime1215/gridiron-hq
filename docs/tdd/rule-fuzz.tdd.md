# RULE-FUZZ: Nick's hard rules as property tests over random leagues

Unit 18. `test/rule-fuzz.test.js` (30 cases), with the generator
`test/fixtures/rule-fuzz-league.mjs`, the oracle `test/fixtures/nick-rules.mjs`
and the recorded seeds `test/fixtures/rule-fuzz-seeds.json`. Tests only: no
served code changes.

## Pre-registration

- **Metric:** violations per rule, per risk mode, counted by an oracle that
  reads only the planner's result, over seeds 1..300 (made-up leagues of 4-8
  teams, 7-14 players each) plus the recorded seeds.
- **Pass bar:** 0 violations of every rule the planner on `main` enforces, in
  every mode, and a non-vacuous sweep (at least half the leagues produce a
  deck). Each rule still waiting on a PR runs as a node:test `todo`: it runs
  in full and prints its count, but does not fail CI until its enforcement
  lands on `main` and the rule moves from `PENDING` to `ENFORCED`.
- **What would fail it:** any enforced-rule violation on any seed; the oracle
  missing a hand-built violation of any rule; the same seed giving a different
  league or different violations; a sweep with fewer than half its leagues
  producing a deck.

## The rules (the oracle's reading)

| rule | reading |
|---|---|
| never_give | Nico Collins (160) and Chase Brown (80) are never in a give |
| aj_brown | A.J. Brown (277) is given only when the same step gets a Blue chip (83+) who is a consistent weekly scorer |
| final_get | every player a plan leaves Nick holding that he did not start with scores 83+; flip leg-2 players and suggested targets count too |
| overpay | value given <= value got, except a depth-only 2-for-1 (no 83+ or pinned player in the give), at most +12%, carrying a confirmed rise in lineup points and title odds (`step.depth_premium.confirmed`) |
| no_olave | Chris Olave is never a get, a give, a target, a suggestion or a flip |
| no_reversal | no step moves back a player who moved between Nick and that manager in a trade this season |

Every surface Nick can see is checked: best plan, every deck card, each step's
opening, walk-away and ladder packages, backups, the risk-mode sheet, flip legs,
suggestions and targets.

## Measured on `main` 58ad700 (served env, no rule flags)

Leagues with at least one violation, of 300 (violation counts in brackets):

| rule | safe | balanced | all_in | status |
|---|---|---|---|---|
| never_give, notes read | 0 | 0 | 0 | ENFORCED |
| overpay | 0 | 0 | 0 | ENFORCED |
| never_give, notes missing | 144 (857) | 150 (1,406) | 142 (1,222) | todo: #381 pins by id |
| aj_brown | 112 (467) | 130 (906) | 141 (886) | todo: #381 pins 277 |
| final_get | 72 (157) | 75 (286) | 97 (441) | todo: #381, flag must be served |
| no_olave | 160 (1,286) | 162 (3,541) | 163 (2,785) | todo: no PR pins Olave by id |
| no_reversal | 170 (1,233) | 179 (3,001) | 191 (2,676) | todo: #379 covers part |

Sweep size per mode: 300 leagues, 1,785 rosters, 28,210 candidate plans. Gate
fuzz: 6,000 random offers through `rankPlans` (every mode) and 5,000 random
packages through `nickOverpays`. Whole file: 57 s on the cloud container.

## Reproduce a failure

```
node -e "import('./test/fixtures/rule-fuzz-league.mjs').then(m => console.log(m.makeFuzzLeague(6).draw))"
RULE_FUZZ_BASE=1 RULE_FUZZ_N=2000 npm test -- test/rule-fuzz.test.js   # a wider local sweep
```

The first failing seed per rule and mode is in `rule-fuzz-seeds.json`
(`recorded`) and is replayed on every run.
