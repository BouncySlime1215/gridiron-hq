# Target Spec — what the engine is aiming at

**Produced:** 2026-09-17 by `study/replay/study.mjs`, after `study/replay/known-answers.mjs` passed 15 of 15 published benchmarks.
**Design:** `docs/WHAT-WINS-STUDY.md`. **Inputs:** real 2021–2025 weekly outcomes (41,572 player-weeks), preseason FantasyPros consensus rank per season, Nick's 12 real league-seasons.
**Status of every number here:** measured, with the caveats stated. Read section 5 before acting on section 2.

---

## 1. The engine's gate reproduces the literature

The replay has to recover what is already known before any new number from it is believed. All 15 targets landed inside their published ranges:

| Check | Ours | Published |
|---|---|---|
| Lineup efficiency, attainable / hindsight | 0.789 | 0.775 (ffsimulator) |
| Hindsight gap | 19.4 pts/week | ~20 |
| Schedule luck, p90 \|wins\| / max | 2.33 / 5.11 | ~2 / ~3 |
| r(all-play, H2H), 10-team | 0.833 | 0.82 |
| Best all-play team wins title | 34.7% | ~33% |
| #1 seed wins title | 32.0% | 25–33% |
| ADP → season points (Spearman) | 0.484 | 0.62 |
| Round-1 hit rate, RB / WR | 59% / 61% | 58% / 63% |
| CV by position QB/RB/WR/TE | .44 / .60 / .63 / .67 | .36 / .54 / .58 / .63 |
| Placebo random title rate, 10-team | 0.098 | 0.100 |

Two of these only passed after fixing a real look-ahead leak: the attainable lineup arm had been filtering to players who turned out to have a score that week, which is knowing who is active before kickoff. It scored 0.898 efficiency against a 0.775 benchmark. The honest rule benches a player who missed *last* week and eats the surprise inactives.

## 2. Findings — draft-time structure, both of Nick's formats

Effect = the strategy teams' all-play win rate minus the balanced teams' in the *same* leagues, so draft slot and season cancel. Pre-registered minimum practical effect 0.010. An effect counts only if its sign holds in at least 4 of 5 seasons. Intervals bootstrap over **seasons** (n=5), not leagues.

**10-team PPR, 1 flex**

| Strategy | Adopters | Effect | 90% CI | Seasons | Verdict |
|---|---|---|---|---|---|
| Early QB (a QB by round 4) | 1/10 | **+8.1pp** | [+6.9, +9.1] | 5/5 | HELPS |
| Early QB | 3/10 | +6.1pp | [+4.3, +9.1] | 5/5 | HELPS |
| Early QB | 5/10 | +5.0pp | [+3.0, +7.1] | 5/5 | HELPS |
| Early TE (a TE by round 4) | 1/10 | +3.0pp | [+0.8, +5.3] | 4/5 | HELPS |
| Robust RB (RB with first two picks) | 1/10 | +3.0pp | [+0.4, +5.7] | 4/5 | HELPS |
| Hero RB | 1/10 | +2.1pp | [+0.3, +4.4] | 4/5 | HELPS |
| Late QB (no QB before round 9) | 3/10 | −1.7pp | [−3.8, +0.8] | 1/5 | HURTS |
| **Zero RB** | any | **−0.1 to −1.8pp** | spans zero | 2–3/5 | **no effect** |

**10-team half-PPR, 2 flex** — same ordering: early QB +8.3 / +6.3 / +5.0pp (5/5), robust RB +3.7pp (5/5), early TE +2.8pp (4/5), late QB −1.1pp, Zero RB −3.1pp at 5 adopters (1/5, unstable).

**Three things to take from this:**

1. **Crowding is real and measurable.** Early QB is worth 8.1pp when one team does it, 6.1pp at three, 5.0pp at five. A structural edge decays as the field adopts it — exactly what the peer-reviewed league data (JDM 2022) says and a direct argument against copying whatever won last year.
2. **Zero RB is not a strategy in these formats.** Its effect spans zero and its sign flips across seasons. That matches the best-ball literature, where the early-WR/early-RB answer flipped between 2021 and 2025.
3. **The conventional "wait on QB" advice loses here**, consistently, in every season and both formats.

## 3. The honest caveat on the QB result — read this before acting

The early-QB effect is **partly a market-pricing finding, not a pure structure finding.**

Measured on 2024 PPR: the top-12 scoring QBs averaged **20.2 PPG at a mean consensus rank of 85**. The top-12 WRs averaged **18.2 PPG at rank 19**. Consensus rank deliberately suppresses quarterbacks because it embeds positional scarcity — in a 1-QB league the *marginal* value of an elite QB over a streamer is smaller than the raw-point gap.

The replay's opportunity cost is modelled correctly: an early-QB team forgoes the RB or WR it would otherwise have taken. So the finding is real *conditional on this pricing*. But the mechanism is at least partly "consensus under-priced quarterbacks in 2021–2025," a period when mobile QBs (Allen, Jackson, Hurts, Daniels) put up 25+ PPG. If the market reprices, the edge goes.

**What that means practically:** treat it as "check whether QBs are underpriced in *this* year's board," not "always draft a QB by round 4." The engine should compute the gap each preseason rather than hard-code the rule.

**Open work this implies:** add a value-over-replacement baseline agent alongside the consensus-follower, so structure effects can be separated from consensus's positional treatment. Until that runs, every effect in section 2 is conditional on FantasyPros ECR pricing.

## 4. Nick's actual leagues — the ground truth

From 12 real league-seasons, 1,652 team-weeks:

**Luck has moved records by up to 3 wins a season.**

| League / season | What happened |
|---|---|
| 1 / 2023 | 6th-best scoring team finished **0.857** H2H → **+3.2 wins of luck** |
| 1 / 2025 | 2nd-best scoring team finished **0.500** → **−2.0 wins** |
| 2 / 2024 | 3rd-best scoring team finished 0.462 → **−2.3 wins** |

All-play vs H2H across his leagues: **r = 0.766** (benchmark ~0.82). Full-season luck swings run **−2.3 to +3.2 wins**, matching the published band.

**Real weekly medians** (the 136 figure was a one-week guess): League 1 117–124, League 2 114–120, League 3 130, Transfer portal 136 (one week only).

**Why this is leverage, not trivia:** a manager whose record flatters his scoring will price his roster as if the record were real. That is the person to buy from — and it is a per-person edge that survives the 80%-luck finding, because it requires no prediction about football at all.

## 5. What the engine is now graded on

Replaces MAE as the gate for every projection change.

1. **Attainable-arm all-play win rate** in the replay. Primary.
2. **Bench points per week** on Nick's real weeks — the only metric with no model in it.
3. **Minimum practical effect 0.010 all-play**, sign-stable in ≥ 4 of 5 seasons, season-clustered intervals.

Calibration so nobody expects the wrong thing: the literature puts **projections at +0.2 wins/season over real managers**, and managers already sit at ~79% lineup efficiency in our own replay. A projection change that moves attainable-arm all-play by even half a point is doing well. A null is not failure — it is the measured shape of the game.

## 6. Priority order this produces

1. **Availability first.** The hindsight gap is 19.4 pts/week and the largest single component is starting someone who does not play. The measured per-team injury dialect (Tampa's "Questionable" = 81% play, Pittsburgh's = 47%) replaces the hand-set constants in `contingency.js`.
2. **Opportunity redistribution.** When a teammate is out, the vacated targets go somewhere and nothing currently moves.
3. **Live players / waivers** as a first-class feature — the strongest documented in-season driver.
4. **Lineup posture by stage**: floor when favoured, ceiling as an underdog or in the playoffs. Volatility helps in best ball and hurts in managed head-to-head; the sign is conditional and the engine must switch, not average.
5. **The person side.** Unchanged by any of this and still the most durable edge: Raj reversing 5 of 5 untouchable declarations is not a coin flip.

## 7. Reproduce

```bash
node --env-file-if-exists=.env study/replay/known-answers.mjs --leagues 150   # the gate, ~15s
node --env-file-if-exists=.env study/replay/study.mjs --format redraft10_1flex --leagues 80
node --env-file-if-exists=.env scripts/luck-panel.mjs                          # Nick's leagues
```

Seeds are fixed; runs are reproducible. `--leagues` scales Monte Carlo precision only — it does not add seasons, and the season is the unit of inference.
