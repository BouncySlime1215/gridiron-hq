# U1c JOINT-ROUND + STEP-REGRET: pre-registration

Stacked on #475 (U1b), itself on #472; neither is merged. The bars are the coordinator's and were
set before any U1c code. One disclosure: this file was committed after the U1c code's first
test run, which printed the synthetic bar 3 once (levels 1/20, pooled z 3.02; deltas 0/20,
pooled -0.01). No seed, threshold or bar was changed after seeing it, and none may be.

## Changes

1. Title odds, deltas and their SEs are carried at 6 decimals end to end (`season-sim.js#TITLE_DP`).
2. `rb-title.js#conditionalTitle` integrates each playoff round's games jointly: the probability of
   each pattern of winners is counted over the same runs. Rounds stay independent (different NFL weeks).
3. STEP-REGRET (Nick's "every move beats doing nothing", per step): on the confirm dice, every step
   of a path must gain on its own, given the steps before it (its cumulative delta minus the
   previous step's is > 0). A path that fails is dropped whole, not truncated: a truncated prefix
   would leave Nick holding a flip leg the Blue chip floor never cleared as a final get. It is on
   by default; `GRIDIRON_STEP_REGRET=0` is a kill switch for one release. RULE-FUZZ gets the rule
   `step_regret`.

## Bars

1. **Bar 3** (the pre-registered U1 seeds, no re-seeding): levels and deltas each 0/20 past 2 SE
   and pooled |z| < 2.
2. **League 4, 12 single-player deals, plain MC at 20,000 runs in the served world:** at least
   11/12 within 2 SE (U1b: 10/12). The same 12 deals, picked the same way.
3. **Rules:** RULE-FUZZ, with step_regret enforced, 0 violations flag on and off; rules-everywhere
   league 4 passes.
4. **Runtime:** flag-on producer within 1.5x of flag-off.

If levels fail but deltas and bar 2 pass, report whether serving RB for deltas only (levels from
plain MC) is a safe split.
