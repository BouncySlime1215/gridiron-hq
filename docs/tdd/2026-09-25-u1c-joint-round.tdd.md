# U1c JOINT-ROUND + STEP-REGRET: evidence (2026-09-25 19:47 EDT)

Pre-registration: `docs/tdd/U1C-JOINT-ROUND-PREREG.md`, which discloses that the synthetic bar 3 printed
once before it was committed. Stacked on #475 (U1b), which sits on #472.

## Changes

1. **6 decimals** (`season-sim.js#TITLE_DP`): title odds, title deltas, their SEs and the shadow fields.
   Playoff numbers stay at 4.
2. **Joint rounds** (`rb-title.js#conditionalTitle`): the probability of each pattern of winners in a
   round is counted over the same runs, word by word on run bitsets.
   - One recursion prices the full pool and all 20 SE batches (`probsAll`).
   - Bracket subtrees are memoised across fields.
   - Results on independent synthetic games are identical to U1b (r50 harness unchanged: 0.488 / 0.318).
3. **STEP-REGRET** (`planner.js#stepRegretIndex`, in `priceOnConfirm`): on the confirm dice, every step
   of a path must gain on its own (its cumulative delta minus the previous step's must be > 0).
   - A failing path is dropped whole, which counts as not beating doing nothing.
   - It is not truncated: the prefix would leave Nick holding a flip leg that the Blue chip floor never
     cleared as a final get.
   - Counted as `confirm.step_regret`. `GRIDIRON_STEP_REGRET=0` is a kill switch; the rule is on by default.
   - RULE-FUZZ has the new enforced rule `step_regret` (oracle: best + every deck card), plus a hand-built test.
   - A free-agent claim step (FLIP-CLAIMS) is exempt: it is a flip piece, and `claim_stranded` already judges
     it. The trade step after a claim must still gain on its own. Without this exemption, all 13 claim paths
     in the flip-claims test were dropped.
   - Knock-on effect: the committed producer contract fixture (`test/fixtures/warroom-contract/producer-plans.json`)
     is regenerated. The fixture league's stop tradeoffs and backups change because paths with a non-gaining
     step no longer count as beating doing nothing.
4. The Title-impact tab (`title-odds-trades.js`) carries title deltas at 6 decimals too, so it matches the card.

## Bars

| bar | result | verdict |
|---|---|---|
| 1. Bar 3, pre-registered seeds, 0/20 past 2 SE and pooled \|z\| < 2 | deltas 0/20, pooled -0.01. Levels 1/20, pooled 3.02 | deltas PASS, levels FAIL |
| 2. League 4, same 12 deals, plain MC at 20k runs in the served world, >= 11/12 | 11/12, pooled z -0.65. Level z 0.75 | PASS |
| 3. Rules | RULE-FUZZ 48/48 with the flag on and off (step_regret enforced); rules-everywhere 10/10; flag-on deck 0 breaks | PASS |
| 4. Runtime, flag-on producer vs off | wall clock, 2 passes each: on 79.2 / 76.7 s, off 52.1 / 66.0 s. Mean ratio 1.32x; pairwise 1.16x-1.52x. CPU user 1.5x | borderline PASS on the mean |

**League 4, deal by deal.** Deal 8 now agrees: at 6 decimals it reads 0.0056% +/- 0.0084% against
0.025% +/- 0.013%. Deal 5 still does not agree: RB gives 0.035% +/- 0.022%, plain gives 0.135% +/- 0.040%,
z -2.21. The joint rounds barely moved it (U1b: 0.03%). So same-round independence was **not** its cause;
the cause is still open.

**Levels.** The fuzz leagues' games are independent, so joint rounds cannot change them. The level lean
measured in U1b (about 0.1-0.2 SE per league) is still there.

## League 4 (DB copy 19:10, live env, objective set back to title on the copy)

| | off | on |
|---|---|---|
| title_now | 0.0833% +/- 0.0833% | 0.1771% +/- 0.0232% |
| Balanced confirm (7 checked) | 2 failed, 3 dropped by step_regret, 2 served | 0 failed, 6 dropped by step_regret, 1 served |
| next move | 288+379 to team 9 for 7, then 366+7 to team 12 for 108 | 366+379 to team 2 for 329, then 367+329 to team 12 for 40 |
| own gain per step | +0.167%, +0.167% (neither clears 2 SE on its own) | +0.0067%, +0.0125% (neither clears 2 SE) |
| rule breaks | 0 | 0 |

With step_regret on, U1b's flag-on next move (step 2 at -0.31%) is gone. The move that replaces it
gains on both steps, but by less than 2 SE on each.

## Deltas-only split (RB for deltas, plain MC for levels)

- **Nick's rules only read deltas.** "Beats doing nothing", step_regret and clears-2-SE all read the sign
  or SE of a delta, never a level. RB deltas pass bar 3 (0/20, pooled -0.01), league 4 (11/12), and
  coverage (true sd / SE 0.89-1.01).
- **Levels.** Levels feed title_now, `behind`, other managers' odds in catch-up, the trajectory, and
  `title_after = level + delta`. Plain levels are unbiased and only noisy (0.08% +/- 0.08%).
- **The one open risk is deal 5.** RB understated a real gain by about 1 point in 1,000 (2.2 SE). If the
  same unexplained mechanism can understate a loss, a step could pass step_regret on RB that fails on
  plain MC.

The split is safe enough to run in **shadow** (compute both, serve plain, log both on every served
step) for one Tuesday. Serve it only if no served step flips sign between RB and plain. It is not
built here: it would be a third flag value (`GRIDIRON_RB_TITLE=deltas`), about 1 hour.
