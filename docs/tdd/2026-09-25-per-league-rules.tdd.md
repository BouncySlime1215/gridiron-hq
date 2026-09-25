# PER-LEAGUE RULES (plan item 36): Nick's rules per league, tighten-only

Plan: batch D item 36 ("Nick's rules config per league (untouchables, floor, overpay cap) in the
objectives, so leagues 1,2,3,5 get the same protections with their own ids").
Flag: `GRIDIRON_PER_LEAGUE_RULES=1` (off by default; off, every line runs as before).

## Pre-registration (written before the implementation commit)

- **Metric:** gate verdicts (`ruleGate().check`) and planner output on made-up leagues.
- **Pass bar:**
  1. Flag on with no `rules` block: league 4's gate verdicts over 14 idea shapes and the fixture plan
     are identical to the flag off (deep-equal).
  2. Flag off: a `rules` block is not read at all (verdicts and plan identical to no block).
  3. A block's own `never_give` / `never_get` ids are never given / got (gate and planner).
  4. `floor`, `overpay_cap`, `depth_premium_max` only tighten; league 4 is unaffected by league 1's block.
  5. A block that would loosen any rule (floor < 83, cap > 0, premium > +12% or < 0), has an unknown
     key, or does not read, fails closed: the gate drops everything, the planner plans nothing.
  6. The pins (160, 80, 277 never given; 290 never got) hold in every league.
- **What would fail it:** any deep-equal diff in (1) or (2); any served give/get of a blocked id;
  any accepted loosening value.

## RED -> GREEN

| stage | commit | what |
|---|---|---|
| RED | this commit | `test/per-league-rules.test.js` (new, 10 tests): 6 fail, 4 pass (tests 3, 4, 6, 8 are today's-behaviour guards and pass on main by design) |
| GREEN | next commit | `never-give.js` `resolveLeagueRules` / `leagueRulesOf` / flag; `ruleGate` and `ruleVerdict` read floor and caps; `withNeverGive` takes the league's ids; `planner.js` applies them; `objectives.js` carries the block |

RED run on main (`c060e0e7`):

```
not ok 1 - resolveLeagueRules: no block is league 4's rules exactly (83, cap 0, +12%)
not ok 2 - resolveLeagueRules: tighten-only; anything that would loosen or does not read is an error
ok 3 - gate: flag on with no block (or no file) gives league 4 exactly today's verdicts
ok 4 - gate: flag off ignores a rules block entirely (today's behaviour, untouchables still read)
not ok 5 - gate: league 1 gets its own ids, floor and caps; league 4 is untouched by league 1's block
ok 6 - gate: the pins hold in every league whatever the block says
not ok 7 - gate: a block that would loosen a rule, or a file that does not parse, drops everything (fails closed)
ok 8 - planner: flag on with no block is today's plan exactly; flag off ignores a block
not ok 9 - planner: the block's never-give and never-get ids are never served; an invalid block plans nothing
not ok 10 - planner: a tighter cap or floor never serves more than the default
# pass 4
# fail 6
```
