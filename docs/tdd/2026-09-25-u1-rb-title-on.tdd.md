# U1 RB-TITLE-ON: evidence (2026-09-25 18:13 EDT)

Pre-registration: `docs/tdd/U1-RB-TITLE-ON-PREREG.md` (committed first, unchanged).
RED: `test/u1-rb-title-on.test.js`, `test/rl-19-2-fast-rescore.test.js` (U1 case).
GREEN: `season-sim.js#tradeImpact` (each arm's `title_before_se` / `title_after_se`,
`title_estimator`), `planner.js` (`now.title_se`), `view.js` (`destination.title_now.se`).

## What was already there

`GRIDIRON_RB_TITLE=1` already served the conditional estimate everywhere a title number is
made: `playSeasons` serves `title_odds` from `rb-title.js`, its per-run title arrays hold the
conditional probabilities, so `tradeImpact`'s paired `title_delta_se` and every planner rescore
(search, confirm dice, `beatsNoTrade`) read it with no further change. The world cache key and
the rescore cache hash both carry the flag. Preview never turns it on. What was missing was the
SE of the level: `title_now` had none. U1 adds it (flag on or off; off it is the binomial SE).

## Pre-registered bars

| bar | result | verdict |
|---|---|---|
| 1. league-4 paired-delta SE ratio, median <= 0.5 | reported 0.125 (IQR 0.118-0.158, 134 deals; 18 deals had plain SE 0). True ratio (sd over 8 independent seeds, 23 deals): 0.172 | PASS |
| 2. no rule violations | RULE-FUZZ 44/44 flag on and off; rules-everywhere league 4: 10/10 surfaces pass both arms; War Room deck (flag on, title goal): 10/10 steps give <= get on fc_value, no 160/80/277 given, no 290 got | PASS |
| 3. unbiased on 20 fuzz leagues vs 20k plain MC | deltas: 0/20 past 2 SE, pooled z 0.04. Levels: 2/20 past 2 SE but pooled z 3.62 | FAIL (levels) |

### Why bar 3 fails, and what it means

The run-to-run SE of the conditional estimate (`rb-title.js#meanInterval`) treats each run's
probability as independent. They are not: every run's probability is computed from the same
pooled playoff-week score distribution, whose sampling error is shared. 30 independent
replicates of 1,200 runs on four fuzz leagues:

| league (bracket) | level: true sd / reported SE | delta: true sd / reported SE | true SE ratio vs plain (level, delta) |
|---|---|---|---|
| 4 (4 teams) | 1.0 | 1.0 | 0.33, 0.40 |
| 12 (4 teams) | 1.25 | 1.1 | 0.43, 0.37 |
| 18 (8, reseed) | 1.4 | 2.0 | 0.33, 0.31 |
| 8 (8 teams) | 2.75 | 2.6 | 0.30, 0.25 |

League 4 itself (6-team bracket, 8 seeds, 24 deals): reported delta SE understates by a median
1.12x (max 1.85x); level 1.6x (true sd 0.00029 vs reported 0.00018). A small upward level bias
may also be present (fuzz 18: RB 0.0340 vs plain 0.0321 over 36,000 runs each, z ~2.5).

The precision gain is real (true SE 0.17-0.43x of plain). The reported SE is too small, most on
8-team brackets. Nick's "beats doing nothing" gate reads the sign of the confirm-dice expected
gain, not its SE, and the delta bias check passes, so the gate itself is not fooled. The SE feeds
`clears_2se` flags, `confirmVerdict`'s holds/shrank split and the served "+/-".

## League 4 (DB copy 17:57, live refresh env, one run per arm)

Nick's live objective on the copy is "Make the playoffs" (request set 21:48Z). Planned on
playoff odds, the flag moves only `title_now`: same deck, same next move, same confirm counts.
The title-goal numbers below are from the same copies with that one request set back to title.

| | off | on (GRIDIRON_RB_TITLE=1) |
|---|---|---|
| title_now | 0.08% +/- 0.08% | 0.19% +/- 0.02% (true sd ~0.03%) |
| confirm dice (Balanced, 7 checked) | 7 failed (expected <= 0) | 0 failed, 7 beat doing nothing |
| deck cards | 0 | 5 (confirmed expected +0.015% to +0.044% title) |
| next move | none: keep the roster | 408+367 to team 8 for 239, then 239+379 to team 12 for 108 |
| steps clearing 2 SE (deck) | 0/0 | 9/10 (on the understated SE) |
| rule breaks | 0 | 0 |
| producer runtime (no cache, playoff goal) | 70 s | 94 s (+34%) |
| peak RSS | 0.71 GB | 1.01 GB |

The on arm's next move is the same shape the off arm serves under the playoff goal (the same
first step, 408+367 for 239); its intermediate flip legs (239 = 79, 83 = 74 ...) sit under the
Blue chip floor and are flipped on in step 2, exactly as main already serves under playoffs.

## Not confirmed

- An SE that includes the pooled-score error (independent-batch or bootstrap SE, A3 §3).
- A 20k-run plain reference on league 4 itself (only synthetic fuzz leagues).
- The event-keyed draw test from NEXT-LEAP U1 (draws keyed by run, week, player, not sequence);
  the fast rescore reads both arms off one world's draws, which pairs them by construction.
- The parity Tuesdays (NEXT-LEAP: shadow for 2 Tuesdays before on).
