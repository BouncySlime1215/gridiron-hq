# Edge test registry

Every edge hypothesis tested, and how it came out. Append-only.

**Why this exists.** Searching until something looks significant is how you manufacture a false
positive. If twenty independent hypotheses are tested at the 5% level, one is expected to look
significant by pure chance. This project has already lost time to edges that evaporated —
the confidence-tier work failed five ways on clean data, and the top-10% conviction tier only
looked good because of 127 placeholder openers.

So the count matters. Every test run against this data goes in this table whether it worked or
not, and the multiple-testing burden is the running total of that column. A survivor is only
interesting if it clears a bar corrected for how many things were tried before it.

**The bar.** A result counts as an edge only if it:
1. is positive on **closing-line value**, not just win rate;
2. shows positive **quarter-Kelly log growth** at real prices including vig/fees;
3. holds **out of sample** (fit ≤2024, tested on 2025 and 2026 separately);
4. survives **adversarial refutation** by independent skeptics; and
5. clears a **Bonferroni-corrected** threshold given the running test count below.

---

## Running count

| | |
|---|---|
| Hypotheses tested | see table |
| Surviving after refutation | see table |
| Implied Bonferroni α at 0.05 | 0.05 / (tests run) |

---

## Tests

| # | Date | Hypothesis | Data | n | Result | Verdict | Killed by |
|---|---|---|---|---|---|---|---|
| 1 | 2026-09-17 | Wong teaser: 6-pt teaser legs crossing 3 and 7 (fav −7.5/−8.5, dog +1.5/+2.5) | game_lines closing spread, 1999–2025 | 1,391 legs | **74.69%** [72.41, 76.98] | **price-dependent** | beats −110 by +2.32pp (+1.99 SE); does NOT beat −120 (+0.72 SE) or −130 (−0.42 SE) |
| 2 | 2026-09-17 | …has it decayed as books wised up? | same, split by era | 475 / 427 / 489 | 73.26% → 75.41% → 75.46% | **no decay** | — (stable or slightly improving) |
| 3 | 2026-09-17 | …stronger on low totals (pre-existing hypothesis) | same, 5 total buckets | 417 / 318 / 313 / 211 / 132 | ≤41: 74.82%; best was 44.5–47 at 77.64% | **not supported** | ≤41 no better than mid; best bucket is 1-of-5 cherry-pick at +1.61 SE |
| 4 | 2026-09-17 | …stronger on a particular side | same, 4 side buckets | 128–503 | home_fav worst 72.18%, home_dog best 75.82% | **not significant** | no bucket clears +1.96 SE vs −120 |

**Test 1 blocker:** we hold **no teaser price data at all** — `nfl_teaser_price_ledger` is empty and
the Odds API tape carries only `spreads`. The entire claim hinges on whether −110 is obtainable, and
that cannot be answered from data we have. Capturing book teaser charts is the missing piece.

**Multiple-testing note:** tests 1–4 are four comparisons on one dataset. Test 1's +1.99 SE
(p≈0.047) does not survive correction for them, let alone for the wider night's testing.

---

### Test 5 — the preregistered shadow tape (best evidence found so far)

`shadow_decisions` holds 56 decisions written at **2026-09-03T21:01Z, days before week 1 kicked
off**, each with side, book, exact line, price, opener and the signal that produced it, recorded at
zero units and explicitly "graded by CLV". The database was deleted on 09-16 before they were ever
scored. Nothing here can be tuned after the fact — the timestamps predate the games — which makes
this the only genuinely out-of-sample forward test in the project.

Graded 2026-09-17 by `scripts/model-lab/grade_shadow_tape.py` against nflverse closing lines.

| Cut | n | CLV | t | Win rate | Notional P&L |
|---|---|---|---|---|---|
| All decisions (naive) | 52 | +1.12pp | +2.61 | 40.4% | −23.3% |
| **Clustered by game (honest)** | **15 games** | **+0.94pp** | **+2.04** | — | — |
| Clustered by game × market | 29 | +1.13pp | +2.97 | — | — |
| `ratings_vs_open_total` | 14 games | +1.36pp | +2.12 | 50.0% | −5.1% |
| `teamrankings_vs_open` | 11 games | +1.71pp | +1.31 | 45.5% | −13.8% |
| `nfelo_pre_vs_open` | 13 games | +0.78pp | +1.12 | 38.5% | −27.8% |
| `ratings_vs_open` | 14 games | +0.71pp | +0.82 | 28.6% | −44.8% |

**Verdict: positive CLV, not yet proof.** t=+2.04 clustered is p≈0.06 two-tailed on 15 games. No
individual signal clears significance alone. The 40.4% win rate has a 95% CI of 27–54%, so results
carry no information at this n — CLV is the only readable quantity.

**Consistent with its own stated prior:** the decisions recorded a basis of "+0.58 CLV, 57.7%,
n 570 held out". The forward week came in at +0.94pp, same sign, slightly better.

**A sign-convention bug nearly ruined this.** `shadow_decisions.line` is standard betting notation
(negative = home favoured); nflverse `spread_line` is a margin (positive = home favoured). They are
negatives of each other. The first grader treated them alike and produced +18.5 points of CLV on an
NFL spread — impossible, which is what caught it. Any future join between these two sources must
normalise first.

**The actionable conclusion:** this tape is the most valuable asset in the project and it stopped
recording when the database died. Restarting the shadow-decision writer so it logs week 2 onward is
worth more than any further backtest, because each week adds genuinely out-of-sample n.

---

### Test 6 — historical backtest of `teamrankings_vs_open` (and the look-ahead that nearly faked it)

`scripts/model-lab/beat_close_backtest.py`, 2022–2025, teamrankings ratings vs the quotable line,
graded on CLV, clustered by game.

**First run said CLV +2.24pp, t=+7.71, n=795. It was wrong.** The openers came from the rebuilt
`nfl_odds_archive`, whose opener is `MIN(ts_utc)` from Covers — a median **11–12 days** before
kickoff, tail to 276 days, and a 134-day median for 2026 (spring lookahead lines). Pricing a
week-W rating against a line posted ~week W−2 hands the rating two weeks of information the market
had not yet seen, at a price no longer quotable. The 2025 season showing +5.53pp against 2022's
+0.60pp was the tell.

Repriced at a realistic decision point (Wednesday of game week, last quote at or before it —
median lag now 3 days, matching the live tape's 23-second opener-to-decision gap):

| Season | bets | CLV | t | Win rate |
|---|---:|---:|---:|---:|
| 2022 | 203 | +0.06pp | +0.29 | 47.5% |
| 2023 | 202 | +0.45pp | +2.20 | 54.4% |
| 2024 | 214 | +0.61pp | +3.17 | 52.6% |
| 2025 | 204 | +0.02pp | +0.10 | 50.7% |
| **All** | **823** | **+0.29pp** | **+2.71** | **51.3%** |

**Verdict: real but not profitable.** Removing the look-ahead cut the effect by 87%. What survives
is statistically detectable and economically useless: +0.29pp of CLV against ~4.5pp of vig, a 51.3%
win rate against the 52.38% needed at −110, and two of four seasons at zero. Not a bet.

**Reading this against Test 5:** the forward tape's +0.94pp on 15 games is consistent with a small
real effect of roughly this size — and with noise. It is not consistent with the "+0.58 CLV, 57.7%"
prior basis the decisions cite, whose 57.7% win rate this backtest does not reproduce anywhere.

---

### Tests 7–11 — predictive edge hunt (workflow `wf_67444914-e81`, 8 agents, 336 tool calls)

All five graded on CLV and Kelly, out of sample, with adversarial refutation on anything positive.
**All five returned `no_edge`. Zero survivors.**

| # | Hypothesis | n | CLV | Kelly | Win rate | Why it failed |
|---|---|---:|---:|---:|---:|---|
| 7 | Kalshi per-minute quotes lead sportsbook lines | 14 games | +0.08pp | 0 | — | **No lead at any lag.** 227,810 minute-bars but only 306 nonzero Kalshi bars and 67 nonzero book bars. The only thing resembling an edge was line shopping |
| 8 | Injury news → line movement, and who moves first | 185 | +0.39pp | 0 | 55.1% | Timestamps are genuinely real (`nfl_injuries.modified_at`, second-precision, 77% land Friday 17:00–21:00 UTC = the NFL final-report window) — but **2025 and 2026 have no injury timestamps at all**, so there is no holdout |
| 9 | 55 advanced features vs the closing line | 923 | **−0.30pp** | 0 | 50.2% | "The features are real football signal and the market has already priced all of it." Fit 2022–24, tested on 2025 (237 games) |
| 10 | Cross-venue divergence (books / Kalshi / Polymarket) | 558 | +0.09pp | 0.067 | — | **The three-venue test cannot be run**: zero regular-season games have all three. Kalshi candles start 2026-05-15, Polymarket winner history ends 2026-08-28 — the 42-game overlap is entirely preseason |
| 11 | Kalshi order-book microstructure (spread widening, OI jumps) | 64 games | −0.01pp | 0.01 | 45.8% | No signal survived the placebo and disjoint-book controls, which were specified before grading |

**Holdout burn — log this.** Test 11 consumed part of the 2026 season, which was the project's last
clean holdout. Its own agent flagged it. 2026 is no longer virgin for Kalshi microstructure work.

**The pattern across all five, and it matters more than any individual result:** every time
something looked positive, tracing it back landed on **line shopping**, not on prediction. The
scorecard review found the same thing independently — at the honest reference line the median 2025
quarter-Kelly growth is −0.065% and only 242 of 740 strategy variants are positive, but the
best-book line-shopped variant shows median 2025 CLV **+2.50pp** and median expected growth
**+0.527%**. That is the same conclusion the pre-loss audit reached (~+4 pts EV per bet from
shopping, models adding ≤1). Three independent lines of evidence now agree: **the edge in this
project is execution, not forecasting.**

*Tests 12–15 below then measured that execution claim directly, and it does not survive.*

---

### Tests 12–15 — execution edge hunt (workflow `wf_b4f2cdc3-89a`, 5 agents, 119 tool calls)

Arbitrage, line shopping, stale books and middles, measured with real money math on the 11-book
tape, Kalshi per-minute bid/ask and Covers. **All four returned `no_edge`.**

#### Test 13 is the headline of the night, and it overturns the project's founding assumption.

**Line shopping is a cost reduction, not an edge.** N = 561,746 pre-kickoff opportunities, 260 games:

| Strategy | EV per bet |
|---|---:|
| Best book | **−1.82%** |
| Best price on the consensus number | −4.01% |
| Consensus | −4.88% |
| Random book | −5.05% |
| Worst book | −8.42% |

Shopping is worth **+3.23 points vs a random book** (median +2.63) — real, large, and worth doing.
But the agent's own headline: *"the ~+4 points claim is overstated by roughly 60%. The real number
is +2.5 to +2.6 points of return per bet, and it is a cost reduction, not an edge."*

**Perfect line shopping still loses 1.82% per bet.** It does not reach break-even, so it cannot be
the foundation a model "adds the rest" on top of. The prior belief — shopping gets to roughly
break-even, models supply the edge — is wrong at the first step.

#### The other three

| # | Edge | n | Result | Why |
|---|---|---:|---:|---|
| 12 | Stale-book: bet the laggard after consensus moves | 293 opps / 32 games | +0.71% | The lag is **real and large** (DraftKings median 2,302 min behind; the stale number sits up a median of 675 min), so availability is not the constraint — it simply does not pay |
| 14 | Cross-venue arbitrage (books / Kalshi / Polymarket) | 110 opps / 275,238 minutes | **no real arb** | The cheapest two-sided round trip anywhere costs a **median 1.0375** — you pay 3.75% to own both sides. Only 3 minutes beat fees in six weeks and all three were data errors. Windows median 2 minutes |
| 15 | Middles and key-number straddles | 56,120 opps / 1,757 games | **−2.62%** | Model predicted −2.48%, realized −2.40% out of sample; game-clustered **t = −8.99**. Middles hit 1.67% of the time against a vig that costs far more |

**Caveat on Test 13:** measured on 2026-09-01 → 09-17, spreads only (the Odds API tape carries no
h2h and no totals), 260 games. One window, one market. It should be re-measured on a second season
before being treated as settled — but it is the most direct measurement of the claim ever made here,
and it points the opposite way to the assumption.

**A useful null:** the tape contains **no stale books at all** in the "quote left up by mistake"
sense — max quote age across 1.91M rows is 884 seconds, zero rows older than an hour. The
stale-quote-masquerading-as-arb risk does not exist in this dataset.

---

### Test 16 — line-shopping replication on a second sample (2019–2025, Covers, 4 books)

`scripts/model-lab/line_shopping_replication.py`. Closing quote per book, both sides of every game,
realised returns, clustered by game.

| Season | best-book EV | consensus | random | worst | gain (best−random) |
|---|---:|---:|---:|---:|---:|
| 2020 | −4.87% | −4.01% | −5.39% | −7.10% | +0.52 |
| 2021 | −5.31% | −3.94% | −5.33% | −6.46% | +0.02 |
| 2022 | −5.96% | −3.79% | −5.57% | −5.79% | −0.39 |
| 2023 | −5.35% | −3.84% | −4.83% | −4.29% | −0.52 |
| 2024 | −4.47% | −3.68% | −4.93% | −5.27% | +0.46 |
| 2025 | −4.32% | −3.94% | −5.20% | −6.38% | +0.88 |
| **2019–25 (4 books)** | **−4.61%** | −4.00% | −5.26% | −6.45% | **+0.66** |
| *2026 (11 books)* | *−1.82%* | *−4.88%* | *−5.05%* | *−8.42%* | *+3.23* |

**Confirms the headline and explains its size.** Best-book EV is negative in **every season
measured**. The shopping gain scales with how many books you can reach: +0.66 pts across 4 books
versus +3.23 across 11, because 4 books disagree by only 0.52 points on average. Book count *is*
the mechanism — and even 11 books only gets you to −1.82%.

**A data-quality gate was required, and it mattered.** Covers' early spreads are corrupted: mean
cross-book disagreement is **7.97 pts in 2019** (p90 18.5, max 44.0) and 1.32 in 2020, against
0.51–0.90 in 2021–2025. Books do not disagree by eight points on a closing spread. Left in, those
rows produced a fake **+32.6-point** shopping gain and a +26% best-book EV for 2019. 452
side-observations above 3 pts dispersion are dropped (330 of them 2019).

**Honest limit:** "best" came out *worse* than "consensus" in 2021–2023. At 0.52-pt dispersion the
two are usually the same offer and the gap sits within a couple of standard errors, so this 4-book
sample cannot resolve the shopping gain. The 11-book 2026 measurement is the better instrument;
this one establishes the sign and the season-by-season consistency, not the magnitude.

---

### Forward tape restarted — 2026-09-17, with a caveat that must travel with it

The shadow-decision writer was dark from the 09-16 deletion until 2026-09-17T05:36Z. It is now
recording again: **176 signals written, 38 decisions frozen for 2026 week 2** (ids 57+).

**Why it was dark, and what fixed it.** Nothing was wrong with the logic. `snapshotSignals` returned
0 and `decideBeatTheClose` froze 0 because the line they read — `nfl_line_snapshots` with
`provider='free:pinnacle'` — stopped at **2026-09-03**, before week 1. The replacement collector
writes to `pinnacle_quotes` in a *different* database, so nothing read it. Three things were needed:

1. `game_lines` 2026 had **no scores and null gamedays**, so `gameCutoff` returned null and every
   decision sat in `waiting`. Backfilled 16 games from nflverse (one needed `LA`→`LAR`).
2. `scripts/line-history/pinnacle_to_snapshots.py` bridges captured quotes into the table the models
   read, filtering to `is_alternate=0` and `period=0` — Pinnacle publishes a full alternate ladder
   (one matchup carried −4.0, −3.5, −2.0, −1.5 simultaneously) and copying that in would let a model
   pick whichever number flattered it.
3. A capture loop every 10 minutes, because the launchd agent is blocked by macOS TCC (a LaunchAgent
   does not inherit Full Disk Access to `~/Documents` and dies with "Operation not permitted").

**THE CAVEAT.** These 38 decisions are **not** comparable to week 1's 56. Their recorded
`opener_at` is `2026-09-17T03:18:24` — the first Pinnacle capture, not week 2's true opener, which
posted around 09-14. Every one has `opener == line`, so the signal reduces to *rating vs the current
line*, not *rating vs the opener*. That is a legitimate "can we beat the close from here" test, but
it is a **different strategy** from the preregistered one, and the "+0.58 CLV, 57.7%, n 570" basis
recorded in the rules does not apply to it. Grade this cohort separately.

Week 1's decisions did not have this problem — `opener_at` and `captured_at` were 23 seconds apart.
From **week 3 onward** the capture loop will have been running continuously, so the true opener will
be caught and the tape returns to the preregistered rule.

**Week 1 can never be settled by its own rule.** `settleBeatTheClose` grades against Pinnacle's last
pre-kickoff line, and Pinnacle's week-1 closes were never captured — the collector died first. The
+0.94pp CLV in Test 5 comes from an independent grader against nflverse closing lines, which is a
substitute for the preregistered metric, not the metric itself.

### Tests 17–20 — venue cost and the markets the spreads-only tape could not reach

#### Test 17 — Kalshi as a cheaper venue (the most mechanically interesting result of the night)

**Kalshi is cheaper for favourites and more expensive for dogs, crossing at p ≈ 0.57.** Regular
season, n = 78,604 minute-sides / 31 games. Price paid per $1 of payout, in cents — no fair-value
assumption needed:

| bucket | n | games | best-of-4 books | Kalshi | Kalshi − books | t | Kalshi cheaper |
|---|---:|---:|---:|---:|---:|---:|---:|
| heavy fav ≥.75 | 5,074 | 7 | 82.63 | 81.53 | **−1.094pp** | −4.70 | **92.3%** |
| fav .60–.75 | 21,174 | 20 | 69.04 | 68.76 | −0.287 | −2.27 | 64.9% |
| pick-em .40–.60 | 26,257 | 11 | 51.72 | 52.11 | +0.383 | +7.75 | 28.6% |
| dog .25–.40 | 21,069 | 19 | 34.19 | 35.25 | +1.063 | +6.51 | 13.8% |
| heavy dog <.25 | 5,030 | 6 | 19.84 | 21.23 | +1.387 | +2.58 | 12.5% |

**The mechanism is structural, not a sample quirk.** A book's share of the overround is
`i·(1 − 1/S)` — mechanically *proportional to the probability*. Kalshi's cost is half the bid-ask
(flat ~0.63c at every price) plus a fee of `0.07·p·(1−p)` that is *humped at the money and near
zero at the extremes*. Proportional versus flat-plus-hump cross near p ≈ 0.57. Measured book
overround runs 4.11% (heavy fav) down to 0.95% (heavy dog); Kalshi's runs 1.40% / 2.17% / 1.59%.

**But it is still not an edge.** Kalshi's best bucket is **−1.88% EV**, which is *worse* than the
−1.82% already available by shopping spreads. Moneyline is simply a worse market to start in.

**The agent correctly rejected a fake edge:** a maker version (resting a bid instead of lifting the
ask) prints +2.5% EV in every bucket — that is an unfilled limit order, not a trade.

#### Tests 18–20

| # | Test | n | Result |
|---|---|---:|---|
| 18 | Totals line shopping (first time measured) | 509,038 / 1,936 games | best **−3.03%**, gain +1.77pp, t=−7.46 — same shape as spreads, worse |
| 19 | Moneyline shopping, incl. underdogs | 3,892 / 1,946 games | best **−3.35%**, 95% CI [−5.35, −1.31], P(EV>0)=0.001. Dispersion *does* scale with price (+4.69pp gain at p≤20% vs +0.90pp at p>80%) and still loses |
| 20 | Closing-line efficiency across 39 buckets | 5,292 games | **Zero of 39 survive** Bonferroni (α=0.00128, \|t\|≥3.220). 7 nominal p<0.05 against 2.0 expected; omnibus spreads χ²=21.18 p=0.012, totals p=0.067, moneyline p=0.174 |

Test 20 is the cleanest statement of the whole night: the closing line was probed 39 different ways
— home dogs, big road favourites, divisional, primetime, low and high totals, key numbers 3 and 7 —
and **nothing survives correction for having looked 39 times.**

### Test 21 — in-game: Kalshi live price vs ESPN win probability

`scripts/model-lab/ingame_kalshi_vs_espn.py`. Kalshi per-minute bid/ask aligned to ESPN's per-play
win probability through `espn_plays.wallclock` (a real UTC timestamp; `espn_probabilities.last_modified`
is an *edit* time and would misalign everything). Bet the side ESPN favours at Kalshi's ask, paying
the spread and the `0.07·p·(1−p)` fee.

| cut | n | games | hit | ROI | t |
|---|---:|---:|---:|---:|---:|
| all | 560 | 14 | 50.2% | +1.02% | +0.04 |
| edge 5–10pp | 424 | 14 | 43.2% | +9.46% | +0.30 |
| edge 10–20pp | 131 | 8 | 74.0% | −9.90% | −0.23 |

**Inconclusive, and cannot be powered this season.** 14 games, SE 28.71. Only 16 games have been
played in 2026, so that is the ceiling until more weeks land. Logged so it is re-run later, not
re-invented.

---

### Test 22 — public betting % and sharp money (Action Network splits, 2018–2026)

`scripts/model-lab/public_money_splits.py`. 2,112 completed games with both the share of BETS and
the share of MONEY per side — the standard construction of "sharp money". 22 thresholds tested.

| signal | best cell | win rate | EV | t |
|---|---|---:|---:|---:|
| Fade the public (spreads) | public ≤40% | 52.37% | +0.18% | +0.05 |
| Fade the public (totals) | public ≤50% | 51.49% | −1.50% | −0.57 |
| Follow the money (spreads) | gap ≥15pp | 52.66% | +0.99% | +0.21 |
| Follow the money (totals) | gap ≥20pp | 55.44% | +5.98% | +1.22 |
| **Baseline: every side** | — | 50.00% | **−4.27% / −4.38%** | — |

**No edge. Zero of 22 thresholds clear the corrected bar (|t| ≥ 2.81); the largest is 1.77.**
Fading *extreme* public sentiment is actively bad: at ≤20% public the return is −21.50%.

**The baseline is the proof the pipeline is right.** Betting every side of every game returns
−4.27% and −4.38% — precisely the vig. A first run returned **+567%** on that same baseline, which
exposed a naming trap: in `an_public_splits`, `spread_home` is the POINT SPREAD and
`spread_home_line` is the PRICE, the opposite of what the names imply. Read the intuitive way, a
spread of 1.0 is parsed as American odds worth a 33× payout. The bet-everything control caught it
immediately, which is why it is in the script.

---

### Test 23 — STEAM MOVES at a lagging book — **REFUTED, fatally, three independent ways**

`scripts/model-lab/steam_moves.py`. When ≥`min_books` of the 4 Covers books move the home spread the
same way inside `window` minutes by ≥0.5 pts aggregate, bet the side the market moved **toward**, at
a book that has not yet moved and still shows a number on the wrong side of the movers.

**This is the only positive-EV result of the night, which is exactly the profile of a false positive.**

| min_books | window | n | games | win | CLV | EV@−110 |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 120 | 18,667 | 1,659 | 54.31% | +0.73 (t=+36.94) | **+3.67% (t=+2.63)** |
| 2 | 60 | 16,501 | 1,642 | 53.93% | +0.73 (t=+36.63) | +2.96% (t=+2.07) |
| 2 | 30 | 14,525 | 1,621 | 53.46% | +0.73 (t=+36.39) | +2.06% (t=+1.39) |
| 3 | 60 | 3,115 | 897 | 54.19% | +0.93 (t=+24.86) | +3.45% (t=+1.36) |
| 3 | 120 | 3,752 | 958 | 54.32% | +0.91 (t=+25.41) | +3.70% (t=+1.52) |

Stable across all six settings tried — win 53.46–54.32%, EV +2.06 to +3.70% — so it is not a
threshold cherry-pick. Break-even is 52.38%; the bet-everything baseline is −4.3%.

**Reasons for suspicion, stated before any defence of it:**
1. **It does not clear the corrected bar.** 6 settings + 22 prior tests = 28 comparisons →
   Bonferroni α = 0.0018, needing |t| ≥ 3.12. The best is **+2.63**.
2. **The CLV t of +36 is partly mechanical.** The rule *selects* books offering a better number than
   the movers, so beating the movers is true by construction. Worse, the "close" is the median of
   each book's last line and **includes the laggard book being bet**.
3. **A directional bug was already found here.** The first run bet the wrong side and returned CLV
   −0.93 at t=−24.86; the mirror-image magnitude is what exposed it. `home_line` is standard
   notation, so a *rising* home line means money on the *away* side.
4. **Seasons are unstable:** 2022 −4.28% and 2026 −2.05% against 2023 +7.66%.
5. **Corrupt early data is not filtered.** 2019–2020 Covers spreads carry 7.97 / 1.32 pt cross-book
   disagreement and the script does not exclude them.
6. **A close cousin already failed.** The oddsapi stale-book test found a real, large lag and
   returned only +0.71% on results. These two should agree and currently do not.

**Independent replication on the 11-book Odds API tape** (`steam_moves_oddsapi.py`) — a different
source, different books, different sampling (regular 15-min grid where "has this book moved" is
*observed* rather than inferred from the absence of a change row):

| source | books | games | win | CLV | EV |
|---|---:|---:|---:|---:|---:|
| Covers (change-triggered, UK) | 4 | 897–1,659 | 54.19% | +0.93 pts | +3.45% |
| Odds API (15-min grid, US) | 11 | 15 | 58.90% | +1.06 pts | +7.81% (t=+0.93) |

Same sign, similar magnitude. **15 games cannot confirm anything** (t=+0.93), but it rules out
"artifact of Covers' change-triggered sampling", which was the leading alternative explanation.

Two join bugs were found and fixed getting there, both of which silently returned *zero* rows
rather than wrong ones: nflverse writes the Rams as `LA` while the full-name map yields `LAR`, and
`oddsapi_snapshots.side` is literally `'home'`/`'away'` — **unlike `nfl_line_snapshots`, where
`side` holds the full team name.**

**Second replication — TOTALS, same books, same logic, different market.** A grading bug surfaced
first and is worth recording because it was caught the same way as the spread one: totals initially
returned CLV **−0.98 at t=−40.53**, a near-exact mirror of the spread's +0.93, which is a bug
signature rather than a finding. The cause: a total is graded `points > line` for the over (so a
*lower* line is better), not `points + line > 0` like a spread (where a *higher* line is better).
CLV therefore flips sign for the over side. After correcting it — and confirming the spread control
was unchanged at +0.93 / +3.45% — the full sweep:

| market | mb=2 w30/60/120 | mb=3 w30/60/120 |
|---|---|---|
| spreads | +2.06% / +2.96% / +3.67% | +3.38% / +3.45% / +3.70% |
| totals | +0.59% / +0.30% / **+0.01%** | **+5.04% / +5.57% / +4.94%** |

**Requiring 3 of 4 books is positive in both markets at every window** (+3.38% to +5.57%, CLV +0.90
to +0.98). Requiring only 2 of 4 collapses to zero on totals, which is mechanically sensible: two of
four books moving together happens by chance.

**Multiple-testing status: it still does not clear.** 22 prior hypotheses + 12 steam settings = 34
comparisons → Bonferroni α = 0.0015, needing |t| ≥ 3.17. The best observed is **+2.64**. The 12
settings are one hypothesis at different parameters rather than 12 independent hypotheses, so the
strict correction is arguably harsh — but the honest position is that this is *suggestive and
consistent*, not established.

---

## VERDICT: REFUTED. Three of three attacks returned `fatal`.

**1. A bug in my own script (fatal).** `steam_moves.py` selects `home_price` into `hp` and then
**never uses it** — EV is hardcoded at `100/110`. The premise of the whole test is that you bet at
a book that has not repriced, and a stale book protects itself with JUICE rather than by moving the
line. The laggard's actual posted price averages **−112.4**, and **46.9% of laggard quotes are worse
than −110**. Re-graded at the price the script had already fetched (and counting the 211 pushes that
`if v == 0: continue` silently dropped):

| cell | reported at −110 | at the REAL posted price |
|---|---:|---:|
| mb=2 w=30 | +2.06% (t=+1.39) | −0.54% (t=−0.38) |
| mb=2 w=60 | +2.96% (t=+2.07) | +0.27% (t=+0.19) |
| **mb=2 w=120** | **+3.67% (t=+2.63)** | **+0.33% (t=+0.25)** |

Bootstrap (2,000 reps) 95% CI **[−2.34%, +3.00%]**, one-sided p = 0.403. Best of all six cells at
real prices: t = +1.02.

**2. The direction placebo (fatal, and decisive).** 200 shuffles randomising the steam DIRECTION
reproduce the result exactly:

| cell | null EV (200 shuffles) | real | percentile |
|---|---|---|---|
| mb=2 w=120 | +2.78% (sd 1.02), CLV +0.752 | +3.21%, CLV +0.75 | 65th (z=+0.42) |
| mb=3 w=60 | +5.16% (sd 2.09), CLV +0.966 | +4.20%, CLV +0.94 | 32nd (**z=−0.46**) |

At mb=3 a **random** direction does BETTER than the real signal. The steam direction carries zero
information. And note what the null itself implies: naming a random direction yields +0.97 CLV and
+5% EV, which would be an arbitrage against simultaneously-available prices. It is only possible
because the quotes are NOT simultaneous. **The rule is a cross-book-dispersion harvester, and
dispersion in this tape is largely scrape staleness.** Priced at the movers' number instead of the
laggard's, the same side/time bets win 51.06% and 51.41% — below break-even.

**3. Execution (fatal).** The laggard's price is worse than the movers' price on the same side
**71.1%** of the time (median 5 cents worse), and the juice scales with the apparent free points:
mean price −102.3 at CLV 0.0, −119.6 at CLV +6.0. The book charges precisely for the stale number.
Collapsing 3.5 bets per game to one bet per game: **+0.34%**.

**4. The data-artifact attack (major) found the same bug independently — and cleared the data.**
Notably, three of its four assigned checks the claim SURVIVED: corrupt-line filtering, the
minute-resolution ordering concern, the outcome join, and the sign convention were all clean. Its
stacked correction, with a game-clustered bootstrap (4,000 reps):

| correction | n | EV | 95% CI |
|---|---:|---:|---|
| as published (flat −110) | 18,667 / 1,659 g | +3.67% | [+0.93, +6.37], P(EV≤0)=0.005 |
| + laggard's actual price, 2021+, dispersion ≤3pts, gap ≤1.5pts | 8,329 / 972 g | **+1.41%** | [−2.10, +4.90], P(EV≤0)=0.213 |
| + 30-minute executability requirement | 5,926 / 943 g | **+0.80%** | [−3.14, +4.82] |

On the bets actually placed, **46.9% are priced worse than −110 and only 11.8% better**; mean
decimal payout at the laggard is **0.8841 versus 0.9091 at −110** — 2.5 points of EV handed back
before a single bet is graded.

**THE RECONCILIATION.** The fully corrected +0.80% matches the earlier stale-book test's **+0.71%**.
The two cousins agree once the price is honoured. That was the open contradiction, and this closes it.

**CORRECTION — an earlier draft of this entry said "the CLV is real and correctly signed". The
judge explicitly overruled that, and the judge is right.** The 200-shuffle placebo reproduces the
CLV **to three decimals** (null +0.729 vs real +0.730, z=+0.10). CLV here is an artifact of the
selection rule — the laggard is *chosen* for sitting on the good side of the movers while the close
is the median of lines that follow them. The script's own docstring admits it: "positive CLV by
construction". A t of +36.94 measures the selection rule, not an edge. Retaining it under a softer
name would let a dead result back in.

**Final judge verdict: nothing survives.** Fully corrected end to end — real posted price, dropping
16 phantom season-mislabeled games and the corrupt 2019/2020 seasons, dropping >1.5pt cross-book
gaps, one bet per game:

| stage | n | EV |
|---|---:|---:|
| as published | 18,661 / 1,659 g | +3.66% (t=+2.62) |
| + laggard's real price | 18,661 | +1.94% (t=+1.41) |
| + drop phantom + corrupt seasons | 15,078 / 1,229 g | +0.88% (t=+0.57) |
| + drop >1.5pt cross-book gaps | 12,914 / 1,218 g | +0.45% (t=+0.28) |
| **+ one bet per game** | **1,218 g** | **−2.35% (t=−0.87)** |

**And the multiplicity was far worse than I reported.** At the headline setting it is not 3.5 bets
per game but **11.25** (median 7, max **443 bets on a single game**), and at mb=3, 57.7% of games
have every bet on the same side. Those were never independent opportunities.

**The good numbers are the ones you cannot catch.** Median time to the laggard's next line change is
33 minutes at mb=3 (23% gone within five minutes), not the 675 minutes the stale-book test
described. The highest-CLV bets are the fastest to vanish and return +0.00% / −0.59% at real prices.

**It leaned on the corrupt data.** At real prices the two best seasons in the entire sample are
2019 (+4.37%) and 2020 (+5.39%) — precisely the seasons with 7.97 and 1.32 points of cross-book
disagreement. Restricted to 2021+, it is **−1.59%**.

**Reconciliation, confirmed:** the ~3-point gap versus the stale-book test's +0.71% is almost
exactly the price correction (−1.7 to −2.1 pts) plus the bet-multiplicity correction (−1.6 pts).
The two never disagreed. **The lag is real, large, and fully priced.**

**What this cost and what it bought.** The apparent edge was: a hardcoded price I never applied,
multiplied by non-simultaneous quotes, dressed up by a directional story that a coin flip matches.
Both "replications" I ran — the 11-book tape and the totals market — were replicating the
dispersion artifact, not a signal, which is exactly why they agreed. Consistency across markets and
sources is not evidence when the confound is present in all of them.

**The lesson worth keeping:** a placebo that randomises the signal should be run BEFORE any
parameter sweep, not after. The sweep made the result look robust; the placebo showed there was
nothing there to be robust about.

---

### Self-audit prompted by Test 23 — applies to Tests 5 and 6

The steam bug was "fetch a price, never use it". Auditing the night's other scripts for the same
class of error found no second instance of the bug, but it did surface a shared **limitation** that
the steam result makes newly important:

**Tests 5 and 6 measure LINE-ONLY CLV.** `grade_shadow_tape.py` and `beat_close_backtest.py` both
derive CLV from the empirical margin/total distribution applied to the LINE
(`cover_prob(pmf, line)`), with no price term. `beat_close_backtest.py` does not read a price column
at all.

Why that now matters: Test 23 established that a book which has not moved its line **defends the
number with juice instead** — the laggard's price averages −112.4 and worsens monotonically with the
apparent free points (−102.3 at 0 CLV, −119.6 at +6 pts). Any CLV measured on lines alone will
therefore **overstate** the realisable edge wherever the bet is placed at a book that is off
consensus, which is precisely when these signals fire.

So read both with that discount:
- Test 5 (shadow tape, +0.94pp CLV on 15 games) — line-only; true price-aware CLV is lower by an
  unmeasured amount.
- Test 6 (beat-the-close, +0.32pp CLV, 823 bets) — line-only; and it was already economically
  useless at +0.32pp against ~4.5pp of vig, so this can only make it worse.

Neither conclusion changes — both were already "not a bet" — but the numbers should not be quoted
as if they were net of price.

**Direct check on Test 5.** All 56 week-1 shadow decisions were matched to a Covers closing price
and the probability paid compared against the no-vig closing probability:

```
mean price paid -104.8 | mean closing price -106.0
paid-vs-no-vig-close   -2.62pp over 16 games (t=-8.57)
line-only CLV reported  +0.94pp (t=+2.04)
```

**Read this carefully — it is not a refutation.** The two quantities are not commensurable: the
price paid carries vig while the closing probability has vig removed, so the −2.62pp is dominated by
the ~2.4pp of half-vig paid, not by the signal. `shadow_decisions` stores only our own side's price,
so a genuine two-way de-vig at bet time cannot be computed from it.

What it does establish, and it is the same conclusion reached three other ways tonight: **+0.94pp of
line CLV does not cover the vig paid to obtain it.** For the tape to indicate profit rather than
merely skill, it would need to record the two-way price at decision time. Worth adding to the
writer, since the tape is now recording again.

---

### Test 24 — Kalshi price calibration / favourite-longshot bias — INCONCLUSIVE, re-run later

`scripts/model-lab/kalshi_calibration.py`. 88,631 minute-quotes on KXNFLGAME markets that resolved
to a completed 2026 game, bucketed by no-vig mid price against the realised outcome.

| bucket | quotes | games | mid | realised | error | t (by game) |
|---|---:|---:|---:|---:|---:|---:|
| 0.10–0.20 | 2,938 | 15 | 0.153 | 0.133 | −0.020 | −0.22 |
| 0.20–0.30 | 5,108 | 15 | 0.257 | 0.200 | −0.057 | −0.53 |
| 0.30–0.40 | 21,774 | 15 | 0.358 | 0.267 | −0.091 | −0.78 |
| 0.40–0.50 | 12,551 | 14 | 0.443 | 0.357 | −0.086 | −0.65 |
| 0.60–0.70 | 21,132 | 15 | 0.643 | 0.867 | +0.224 | +2.44 |
| 0.70–0.80 | 5,749 | 15 | 0.745 | 0.867 | +0.121 | +1.32 |

**The shape is textbook favourite-longshot bias** — longshots win less often than their price
implies, favourites more — which is the best-documented anomaly in prediction markets and would be
exploitable without forecasting anything, by simply selling longshots. Kalshi's fee structure even
helps: `0.07·p·(1−p)` is near zero at the extremes where the bias would live.

**But it rests on 15 games and settles nothing.** Minutes inside a game are near-perfectly
dependent — a 30–3 blowout contributes hundreds of minutes all pointing the same way — so the
effective sample is the GAME count, not the 88,631 quotes. Every t is below 1 except two, and the
0.90–0.98 cell's t=+19.94 is degenerate (all 14 games won, so variance collapses). The ±65% buy/sell
EV swings are a handful of games moving everything.

**Do not act on this. Do re-run it** — `python3 scripts/model-lab/kalshi_calibration.py` — once
2026 has 60+ completed games with Kalshi coverage. It is the cheapest open question left, it needs
no new data collection beyond the Kalshi backfill already running, and unlike the twenty-three
failures it is a property of the venue rather than a forecast.

---

### Tests 25+ — a REGISTERED FAMILY of 5,940 correlation tests with FDR control

`scripts/model-lab/mass_test_harness.py`. 165 lagged features (advanced team-week differentials,
off/def/matchup) × 4 targets (ATS cover, total over, margin error, total error) × 9 splits, on
1,646 games 2016–2025. Enumerated mechanically in advance so nothing could be dropped for being
inconvenient; every test recorded.

```
family size                5,940
nominal p<0.05               393   (expected under a pure null: 297)
Bonferroni threshold      8.42e-06 -> survivors 0
Benjamini-Hochberg q=0.10          -> survivors 0
```

**Zero survivors.** Strongest single result was `matchup_redzone_epa -> margin_error [fav>7]` at
r=−0.196, p=7.0e−05 — still 8× short of the Bonferroni bar.

#### But the FAMILY carries a signal the individual tests do not

The nominal hits are overwhelmingly **negative**, and a sign test is far more powerful than any one
correlation. Run on the `all` split only (the nine splits are nine views of the same games and are
heavily dependent; the 84 features are not — measured effective rank **39.7 entropy / 24.5
participation**, mean |r| between features just 0.104):

| target | negative | binomial p | mean r |
|---|---|---|---:|
| `margin_error` | 123/165 (74.5%) | **4.7e−10** | **−0.0170** |
| `ats_cover` | 113/165 (68.5%) | **3.0e−06** | −0.0144 |
| `total_over` | 69/165 (41.8%) | 0.043 | +0.0016 |
| `total_error` | 91/165 (55.2%) | 0.21 | −0.0041 |

**Teams that look stronger on recent advanced metrics systematically underperform the closing
spread** — the market prices recent form and overshoots slightly. Overwhelming on spreads, absent
on totals. This is a real property of the market, not a fluke.

#### And it is still not bettable — three checks killed it

1. **Magnitude.** Mean r = −0.017. A 1-SD feature move shifts cover probability under 1pp against
   the 2.38pp needed at −110.
2. **Asymmetry.** A walk-forward composite (signs and scaling fitted on prior seasons only, 1,150
   games 2019–2025) gave top-quintile→HOME 54.78% but bottom-quintile→AWAY only 49.57%. A real
   signal works in both tails. Home base rate in this sample is 49.83%, so the excess is +4.95pp at
   SE 3.30pp — about 1.5 SE.
3. **Monotonicity — decisive.** Cover rate across composite quintiles: **50.43 / 42.17 / 52.61 /
   49.13 / 54.78**. Not monotonic; Q2 is the worst bucket by eight points. If the composite ordered
   games by expected cover that is impossible. The Q5 spike is noise.

**Verdict: a real directional property of the market that does not produce a usable ordering.**
Worth knowing — it says recent-form features are priced and slightly over-priced — and worth not
betting.

**Correction to a prior belief recorded here:** the audit's "effective rank ≈2.5" applies to the
ensemble's 35 *forecast signals* (predictions of one target, collinear by construction), NOT to raw
descriptive features, which measure ~40 independent directions out of 84. Those are different
claims and were being conflated.

---

## Standing after 24 hypotheses + a 5,940-test registered family

**Zero edges found.** Twenty-four hypotheses, out of sample, graded on CLV and Kelly, with adversarial
refutation on anything positive. The only positives were: the preregistered shadow tape at +0.94pp
CLV on 15 games (Test 5, too small to conclude), and line shopping as a **cost reduction** that
still leaves every bet negative in every market and every season.

With 24 tests run, a Bonferroni-corrected α at the 0.05 level is **0.0021**, requiring roughly
±3.08 SE. Nothing tonight clears that bar. Test 20 tested 39 sub-buckets of its own and reported
zero survivors against its own correction.

### Best-book EV, every market measured

| market | books | sample | best-book EV |
|---|---:|---|---:|
| spreads | 11 | 2026, 260 games | **−1.82%** |
| spreads | 4 | 2019–25, 1,525 games | −4.61% |
| totals | 4 | 2019–26, 1,936 games | −3.03% |
| moneyline | 4 | 2019–26, 1,946 games | −3.35% |
| moneyline (Kalshi, heavy favs) | — | 2026, 7 games | −1.88% |

**Not one cell is positive.** The best number available anywhere — perfect line shopping across 11
books on spreads — still loses 1.82% per bet. Everything else is worse. There is no venue, market,
bucket or season in this data where a bet has non-negative expectation before a model is applied,
and every model tested subtracts rather than adds.

---

## Prior results carried forward (from the 2026-09-16 audit, before the data loss)

These were measured and are not being re-litigated. They are recorded here so nothing
re-tests them and counts a rediscovery as a new finding.

| Hypothesis | Result | Note |
|---|---|---|
| Weekly ridge stacker over ~35 signals | No edge | Effective rank ≈2.5; ridge gives the market line 35–52% of the weight |
| Confidence tiers / conviction sizing | Failed 5 ways | edge-size vs correctness r = −0.01; component agreement sign-flipped; meta-model AUC 0.489 on held-out 2024 |
| Top-10% conviction tier at 60% | Artifact | Caused by 127 fake Pinnacle placeholder openers; repaired → 52.9%, and a preset rule lost in both 2024 and 2025 |
| Line shopping | **Real, ~+4 pts EV/bet** | The only measured positive. Gets to roughly break-even. Models add ≤1 pt on top, which went negative in 2025 |
| Opener move direction | Predictable but not profitable | Direction predictable at the open; does not survive costs |
| Kalshi leads books | Open | 36 games observed with a 2–3 h lead; preregistered test waits for 150 |
| Props model (week 1 2026) | No edge | 1,149 bets, 50.0%, zero CLV, badly uncalibrated (70% bucket hit 48%, 99% bucket hit 63%) |

**Reproducibility note (2026-09-17):** the props result above can no longer be reproduced. The
deleted database held the model's side selection (`model_probability`) and the Underdog closing
lines (`closing_line`); both are empty in the surviving copy, and 442 of the 443 surviving props
carry both Over and Under, so re-settling them returns ~50% mechanically regardless of skill.
The conclusion stands as recorded, but it is no longer checkable against data.

---

# Session 2026-09-17 — Polymarket coherence, structural profit hunt, Jev

Every test run this session, positive or null. Recorded so nothing is retested by accident.

## A. Polymarket option-chain coherence — BOTH FINDINGS WITHDRAWN

Tested whether Polymarket's NFL chain contradicts itself, which needs no forecasting model:
monotonicity (`P(over L)` must fall with `L` — a violation is a riskless box) and additivity
(`E[1H]+E[2H] = E[game]` by linearity of expectation, no independence assumed).

| Test | Unfiltered | After volume gate |
|---|---|---|
| Monotonicity violations | 23.3% of adjacent pairs, median 11c, max 43c | **0 of 29 pairs** |
| 1H+2H vs GAME additivity | −2.73 pts, t=−4.55 | untestable |

**Both were artifacts.** 85% of NFL total markets on Polymarket have traded **exactly zero
dollars**; median volume $0, p90 $28, and the median game has no strike above $5k. The "boxes"
were resting market-maker quotes parked at 0.500 sitting beside real quotes. The additivity gap
has the same cause with a sign: untraded quotes drift toward 0.50, which drags the survival
integral toward the ladder centre, and the quarter/half ladders are precisely the illiquid ones —
so "the parts" were biased low by construction.

Gated on >$5k volume the chain is **perfectly monotone**. Polymarket's 70.1M price points are
~169 liquid markets wrapped in ~5,000 untraded quotes that look like depth.

**Rule added: check volume BEFORE coherence. An untraded resting quote is not a price.**
Script: `scripts/model-lab/polymarket_ladder_coherence.py`

## B. Structural profit hunt — 6 hunts, 0 survivors after 3 refuters each

Premise: prediction is dead, so look for money that exists because of how a product is *priced or
settled*, not because we forecast better.

| Hunt | Result | The number that kills it |
|---|---|---|
| Wong teasers | **blocked** | Break-even −120.2 (CI −132.6/−109.4). EV +4.16% at −110, t=1.82. Pinnacle's own implied price for the teased leg is **72.30%** vs a 72.37% break-even. Blocked on a price never recorded. |
| Cross-book middles | dead | +0.562% ROI, t=0.41. Needs 9,820 bets; 7 seasons give 2,883. True arb: 22 of 2,224,042 pairs (0.00099%). |
| Exchange vs book | dead | Routing to Kalshi costs **−1.362pp ± 0.161** MORE than best-of-11 books. At p=0.5 Kalshi takes 2.41c vs 2.08c. Fees kill 619 of 623 raw cross-venue locks. |
| Correlated products | dead | Pinnacle's alternate TOTAL ladder is genuinely mispriced by 1.76pp/rung, but overround is 4.34% so you need 2.17pp. Correction < toll. Placebo p=0.114. |
| Graveyard revival | dead | **The headline number of the whole project:** revivable signal across everything ever killed = **+0.64%/bet (t=2.84)** — real and significant — against a **5.66%** cost to extract. |
| Promo conversion | refuted 3/3 | Mechanism survives (arithmetic), magnitudes do not. See below. |

### Promo conversion — corrected numbers
A free bet is a credit in **one** book, so its leg cannot be shopped; only the hedge can.
The original `h=3.05%` was the both-sides-shopped overround, unobtainable by any free-bet ticket.

- Executable `h` = **4.11–5.33%** → `c* = (1−√h)² = 60.9%`, not 68.1%
- Best-of-slate conversion **60.0% median**, not 65.2%; optimal strike ≈ **+300 to +400**
- Line-shopping gain in conversion = +1.51pp, and **exactly 0.00pp when only two books quote**
- **Boosts are book-locked**: +18.4% was graded at a best-of-4-books price the token can never
  reach. At the issuing book: **+12.7% ± 8.0, t=1.59**, fails Bonferroni over its own 32-cell family.
- **Recommendation was inverted.** Realized book-locked κ=1.33: favourite +4.8%, **+100–200 +17.5%**,
  +200–400 +12.7%. Boost EV is **non-monotone**, peaking ~+180–260 — not on the longest price.
- Correction to a premise I asserted: a −110 → +100 boost on a true 50% event is EV **exactly 0.00%**,
  not a large gain. It refunds the vig. A boost is only +EV once the boosted price beats fair.
- Supply, not EV, is the real limit: **n\* = 347 tokens** to be 2σ from zero; realistic supply
  60–100/yr → P(profit) 80–86%, never statistically clean in a season.

## C. Presser event study — can Jev help? Tested BEFORE paying for Jev

Text classification can only add value if pressers mark abnormal line movement at all. Ran the
event study with **no text**: every presser an event at time T, placebo at the same game, same
weekday and hour, one week earlier.

```
after-window |move|   presser 1.438 pts  vs  placebo 1.259 pts
                      diff +0.179,  t = +1.10   NOT SIGNIFICANT
before/after ratio    1.13  → symmetric, no event signature
```

**Underpowered, not a kill**: 482 of 10,670 rows timestamped; at the same effect size the full
corpus reaches t≈4.9. **Hard ceiling found**: YouTube stops exposing exact timestamps past ~6 weeks
(2026-09: 156 fixed / 0 failed; 2026-08: 326/21; 2026-07: **0/59**). yt-dlp cannot go further —
unblocking needs a YouTube Data API v3 key (~214 quota units of a 10,000/day free allowance).

Script: `scripts/model-lab/presser_event_study.py`

## D. Infrastructure defects fixed

- `backfill_presser_timestamps.py` recorded **transient DNS failures as permanent** in its resume
  table. One network blip would have burned all 10,670 rows into do-not-retry while reporting
  success. Now distinguishes transient from final and aborts the run, not the row.
- `teaser_fair_value.py` hardcoded a narrow Wong window and silently dropped **−7 and +3**; +3 alone
  is 39% of historical Wong legs. Now uses the module's own `CROSS_BOTH_LINES`.
- Jev questions were **six booleans**. `starter_doubtful` and `starter_returning` are mutually
  exclusive states of one variable asked independently (Jev could return 0.7 and 0.6 on the same
  transcript); `net_negative_for_team` was a magnitude as a yes/no; and nothing separated
  "not discussed" from "no" — opposite market signals scoring identically. Now one `choice` over
  six states plus a `score`. Schema corrected against SDK types: `choice` takes `criteria` as a
  name→description map, `score` takes an **ordered array**, and only `boolean` answers carry a bare
  `.probability` — the old writer would have stored NULL for every choice and score answer.
- `npx tsx` does **not** load `.env.local`: 8,475 rows failed with "No authentication provided" and
  zero tokens. Run as `set -a; . ./.env.local; set +a; npx tsx …`.
- Type bug: `strftime('%s',…)` returns a **string**, `kalshi_candles.ts` is an **integer** — SQLite
  type ordering made a BETWEEN silently always-false, reporting "0 of 482 pressers overlap" when
  the true answer is 482 of 482.

## E. Jev — live and paid

Smoke test discriminates correctly on the same transcript: `qb_hedged` 0.96, `qb_plays` 0.17,
`lt_plays` 0.93. Cost $0.042/1M input tokens, output free.

**Best target found: `espn_transactions`, not pressers.**

| | Pressers | ESPN transactions |
|---|---|---|
| Usable events | 482 | **12,268 in-season** |
| Span | ~6 weeks | **2016–2026** |
| Teams | 20 | **32** |
| Content | hedged coach-speak | hard dated facts |
| Cost | $1.00 | **$0.025** |

Label quality verified by hand — "Placed G Landon Dickerson on IR" → impact 0.41 / starter 0.80;
"Released WR from the practice squad" → impact 1.13 / starter 0.18. Scale and gradient both correct.
Scripts: `scripts/news-line/jev_transactions.mts`, `scripts/news-line/jev_presser_signals.mts`

## F. Running at time of writing

1. **Player-level model** — lineup-adjusted strength from 487k plays / 479k participation / 255k
   snap counts. Every feature ever tested here was a team-week aggregate; effective rank was ~2.5.
   Key diagnostic: does the player-level matrix have materially higher rank?
2. **Live in-game Jev** — 586k play texts classified for event class, injury severity and
   **surprise**, against 3.27M one-minute Kalshi candles with real bid/ask and per-play ESPN win
   probability as referee. Two hard gates checked first: play-feed lag, and median in-game spread.
3. **Ten unique Jev tests** — luck-vs-skill, garbage time, play-call aggression, narrative salience,
   corpus triage, research auditor, absence duration, weather, officiating crews, market structure.


## G. Transaction event study — NULL, and it fails the same way pressers did

10,519 in-season roster moves (2019–2026, all 32 teams) Jev-scored for availability impact,
event-studied against the covers spread tape. Panel: 7,699 transaction-game pairs, 1,473 games.

```
CONTROL   mean delta over ALL transactions  +0.0035 pts, SE 0.0133, t=+0.26     PASS

impact bucket          n    mean delta       t
starter out (<1)     738      +0.0718     +1.14
depth out           1094      +0.0347     +0.75
neutral              897      +0.0078     +0.16
depth in            2890      +0.0003     +0.01
starter in (>3)     2080      -0.0346     -1.17
correlation(impact, delta) = -0.0215
```

The bucket ordering is **perfectly monotone** in the predicted direction — a real signature in
shape. By position, only quarterback separates: **+0.66 pts, t=1.82**, roughly 20× every other
group, and nowhere near the Bonferroni bar of |t|>2.81 across 7 positions.

**PLACEBO KILLS IT.** Reassigning each transaction to a random team: band [−0.118, +0.114].
The real starter-out effect of +0.0718 is **inside** it. No event signal.

### The structural lesson, which matters more than the null
Both news-based event studies now fail the same way:

| Study | Result | Timestamp used |
|---|---|---|
| Pressers | t=+1.10 vs placebo | YouTube **upload** time |
| Transactions | inside placebo band | **official transaction** date |

Each timestamps the *official record*, which lags the information. An injury is reported Sunday;
the IR paperwork posts Tuesday. We are measuring the echo, not the event. This is a structural
ceiling on news-based work in this repo, not a bug — and no amount of better classification fixes
a clock that is already late. Script: `scripts/model-lab/transaction_event_study.py`

## H. "Questionable" is thirty-two dialects — GATES 1 AND 2 PASS

The first test in this project to pass a persistence gate. Makes no claim about which team is
better; claims the market mis-reads an institutional signal.

```
GATE 1 DISPERSION   chi-square 343.9 on 31 df, p = 1.1e-48
   TB   382/473  80.76%  [76.97, 84.06]   +16.70pp vs league
   NYJ  384/496  77.42%  [73.54, 80.88]   +13.35pp
   HOU  230/461  49.89%  [45.35, 54.44]   -14.17pp
   PIT  100/213  46.95%  [40.36, 53.65]   -17.12pp
   -> 34-point spread, Wilson intervals nowhere near overlapping

GATE 2 PERSISTENCE  cross-season r = +0.4018 (p<0.0001)
   split-half reliability ceiling (odd vs even weeks, same season) r = +0.5652
   -> captures 71% of achievable signal. The dialect REPEATS.
```

Join validated by the ranking itself: P(play|Out) 0.02%, Doubtful 0.83%, Questionable 64.06%
(n=26,871). Ground truth is snap_counts, so "active but zero snaps" counts as did-not-play — the
right definition for a market question.

NE lists 63.3% of its injury-report entries as Questionable against 40.5% for the next team, which
is the documented information-suppression practice showing up in data.

**GATE 3 — does the closing line price the team-specific rate or a league average? — is untested
and is the one that decides whether this is money.** Script: `scripts/model-lab/questionable_dialect.py`

## I. Operational

- **Storage**: `line_history.sqlite-wal` reached 8.3 GB against an 18 GB database (repo 33 GB).
  Long analysis reads block WAL checkpointing while collectors append. PASSIVE+TRUNCATE checkpoint
  reclaimed **9 GB** (repo → 24 GB, free 57 → 65 GB). `scripts/line-history/storage_watch.sh` now
  runs from the maintenance loop for any WAL over 512 MB.
- **Concurrency**: three simultaneous workflows drove load average to **34 on 8 cores** (4.25×
  oversubscribed), slowing everything including the UI. Jev was NOT the cause — it is network-bound
  at 70–500ms per call. The expensive resource is CPU against the 18 GB file, not Jev tokens.
  Workflows must be serialized, not stacked.
- **Jev spend**: $0.63 of $10 for 10,519 transactions + 2,276 pressers. Classification is
  effectively free; analysis on top of it is not.


## J. Live in-game markets — DEAD at the foundation gate, before any hunting

Premise: live markets reprice in seconds on thin books, so a classifier reading play text might
beat a crowd watching a broadcast. Three gates were checked before any edge-hunting; all three
failed, which is why the workflow was stopped rather than run to completion.

1. **NO SPEED EDGE.** The ESPN play feed is synchronous with the Kalshi market to **within 15
   seconds**. There is no window in which we know something the market does not. This alone ends
   the premise.
2. **SAMPLE.** Overlap is 63 games — **47 preseason, 16 regular season**. Per-bucket cluster SEs
   are 0.08–0.10 in probability units, so no reliability bucket can resolve a market-vs-model
   calibration gap smaller than ~8pp. Reaching t=2 needs ~380 games (~1.4 seasons of coverage).
3. **PLACEBO.** An outcome-shuffle placebo reproduces +0.00701 of the +0.00955 Brier gap and
   **exceeds the observed P&L** in the gated cut.

Control passed: buy-home-at-ask every minute returns −0.0497 ± 0.0483 against a theoretical
−(half-spread + fee) = −0.0169, 0.68 SD.

**Worth keeping — ESPN win probability is a sound referee** and is reusable anywhere a benchmark
is needed: Brier 0.15235 ± 0.00239, LogLoss 0.45690, Brier skill 0.3862 over 579,050 play-rows and
3,295 games; **ECE 0.0098**; global recalibration slope 1.029 with CI containing 1.0; only 1 of 10
reliability bins off by |z|>2.

This is the cheapest kill of the session: the gate design caught it in one agent instead of ten.


## K. Two operational mistakes worth not repeating

**1. GATES MUST BE SEQUENTIAL WITH THE SPEND, NOT PARALLEL TO IT.**
The live-game workflow put its feasibility gates and its expensive labeling in the SAME phase, so
they ran concurrently. The benchmark agent found the play feed is synchronous with the market to
within 15 seconds — killing the premise — while a sibling agent was already spending **$3.26**
classifying 68,413 plays for that premise. Gate-first worked inside an agent and failed across the
workflow. A gate that can kill a hypothesis must complete BEFORE the work it gates.

**2. STOPPING A WORKFLOW DOES NOT KILL WHAT ITS AGENTS SPAWNED.**
After `TaskStop` on two workflows, three orphaned Jev jobs (`jev_live_plays`, `jev_yt_triage`,
`jev_luck`) were still running at 20–35% CPU each and still spending credits on abandoned lines of
inquiry. Always `pkill` the child scripts after stopping a workflow, and check with
`ps aux | grep tsx`.

**Cost of the two together:** $4.51 of a $10 budget, 87% of total spend, on hypotheses that were
dead or abandoned. Load average hit **34 on 8 cores** (4.25× oversubscribed), slowing the UI.
After serializing workflows and killing orphans: **17.5**.

**Artifacts survived the hypotheses**, and are reusable:
- `jev_live_plays.sqlite` — **68,414 plays** labelled for event_class (12 categories),
  injury_severity, star_player_involved and surprise. Usable by the luck-vs-skill and garbage-time
  tests, neither of which needs a speed edge.
- `jev_yt_triage.sqlite` — **39,163 YouTube titles** classified for content type and injury
  relevance. This is the corpus-expansion map for the 20-of-32-teams coverage gap.


## L. "Questionable" dialects — GATE 3 FAILS. The market already prices it.

Gates 1 and 2 passed convincingly (section H): teams differ by 34 points, and the difference
persists across seasons at 71% of the reliability ceiling. Gate 3 asks the only question that
pays — does the closing line price each team's own rate, or a league average?

Construction: `residual = n_Q * (rate_team − rate_league)`, i.e. how many more players than a
league-average reading implies are actually available. Team rates fitted on **prior seasons only**;
1,232 games dropped rather than backfilled where a side lacked 60 prior Questionable entries.

```
CONTROL  mean margin_error over all games  +0.0248 pts, SE 0.2776, t=+0.09     PASS

correlation  +0.0095    slope +0.286 pts/unit    p = 0.6627    n = 2,120 games

quintile   mean margin_error      t
Q1              +0.1792        +0.28
Q2              -0.5377        -0.91
Q3              +0.1403        +0.24
Q4              +0.5566        +0.88
Q5              -0.2146        -0.33
```

Not monotone, not significant, nowhere near the ~1.5 points of edge a spread bet needs to clear
4.25% vig. **The dialect is real, it persists, and the closing line has already absorbed it.**

This is the most common shape of finding in this project and it deserves naming: *real signal,
zero edge*. Gates 1 and 2 measure information; only gate 3 measures money, and information the
market already holds is worth nothing. Running gates in that order cost one afternoon instead of
a season. Script: `scripts/model-lab/questionable_gate3.py`

## M. Presser timestamps — SOLVED via the YouTube Data API

yt-dlp capped at 482 of 10,670 because YouTube stops exposing exact publication times past ~6
weeks. `videos.list(part=snippet)` has no such limit and costs **1 quota unit per CALL** (50 ids
per call), so the whole corpus is 204 units against a 10,000/day free allowance — about 2% of one
free day, no billing.

Result: **0 missing, 0 date-mismatches** across every batch. This takes the presser event study
from 482 events (t=+1.10, underpowered) to the full corpus — roughly 20x the statistical power,
and the difference between a shrug and a verdict.

Script: `scripts/line-history/youtube_api_timestamps.py` (reads the key from the environment only;
never prints, logs, or stores it, and strips query strings from error messages).


## N. Presser event study at FULL POWER — no event signature. The news line is closed.

The YouTube Data API repaired all 10,670 timestamps (0 missing, 0 mismatches), taking the event
study from 482 events to **2,957 matched presser-game pairs** — ~6× the pairs, ~20× the power.

```
                        n      mean |move|    se
BEFORE upload        2957        0.624      0.025
AFTER  upload        2957        0.506      0.025
placebo BEFORE        451        0.918      0.068
placebo AFTER         451        0.680      0.066

after-window, presser vs placebo:  −0.1735 pts,  t = −2.45
before/after ratio: 1.23  → symmetric
```

**No positive event signature.** The negative t is not "pressers calm the market" — an information
event raises volatility, it never lowers it. It is a placebo-selection artifact: the control is
"same game, one week earlier", and only **451 of 2,957** games had quotes two weeks out. Those are
marquee/primetime games with livelier lines, so the control is biased high. (The script's verdict
branch treated any |t|>2 as "abnormal movement"; fixed to read a negative t correctly.)

With the power question settled, the news line is closed on three independent studies:

| Study | n | Result | Why |
|---|---|---|---|
| Pressers (yt-dlp) | 482 | t=+1.10 | underpowered |
| Pressers (API) | 2,957 | t=−2.45, wrong sign | placebo-selection artifact; no positive signal |
| Transactions | 7,699 | inside placebo band | official record lags the news |

Same structural cause each time: **we timestamp the record, not the information.** Beat writers
post from the room; the upload and the IR paperwork land afterwards. Jev classified 3,746 pressers
and 10,519 transactions accurately, and accurate classification of stale news is worth nothing.

## O. Practice pattern beneath the designation — REAL, INCREMENTAL, and ALREADY PRICED

Third injury finding with the identical shape. Within an **identical** "Questionable" tag:

```
practice_status    n      P(play)   95% Wilson
Full            2,957     0.7995    [0.7846, 0.8135]
Limited         8,978     0.6860    [0.6763, 0.6955]
DNP             2,268     0.4475    [0.4272, 0.4681]
→ 35.2-point spread, monotone, intervals nowhere near overlapping
```

And it is **genuinely incremental information, out of sample**: walk-forward log-loss
0.31282 → 0.29964 (**+4.21% lift**, n=48,403), positive in 8 of 10 test seasons. The practice
field predicts play beyond the designation. The model never sees its own season.

**And the market has it.** Every money specification nulls:

```
snap-weighted      rho +0.0101   t +0.500   n=2,391
QB starters only   rho +0.0149   t +0.768
betting sim, all four thresholds NEGATIVE: ROI −0.9% to −6.4%
real |t| = 0.500 sits BELOW the placebo median |t| of 0.682
```

A 1-SD move in the residual shifts margin **+0.129 pts** against ~1.5 needed — **11.6× short**.

### The pattern, now confirmed three times on injuries alone
| Layer | Information real? | Persists? | Market prices it? |
|---|---|---|---|
| Questionable designation by team | yes, 34-pt spread | yes, r=+0.40 | **yes** (gate 3 null) |
| Practice pattern under the tag | yes, 35-pt spread | yes, 8/10 seasons | **yes** (t=0.50) |
| Official transactions | monotone ordering | — | **yes** (inside placebo) |

**Real signal, zero edge** is not an occasional outcome here — it is the *default* outcome for
any public-data signal, and injuries are the most-watched public data in the sport. The
information gates pass; the money gate fails; the market is the thing that already asked.


## P. THE ORACLE TEST — perfect lineup knowledge is worth zero against the closing line

The headline result of the session. The player-level workflow built a genuinely working player
value model, then the lineup-adjusted model came back `no_edge` — and the agent ran the one test
that settles the personnel question permanently rather than leaving it to "maybe with better data."

### The player value model works (this is not the failure)
Regularised APM from 487k plays + 479k participation rows, per-player per-week, out of sample
2022–2025 against a 200-draw role-preserving placebo:

```
pass  r=0.416   placebo 0.102 ± 0.068   p<0.001   n=147 QB-seasons
rec   r=0.202   placebo 0.017           p<0.001   n=707
rush  r=0.174   placebo 0.001           p=0.005   n=275
def   r=0.129   placebo 0.010           p<0.001   n=2,114
```

Honest failures stated: **defence is a team rating in disguise** (prior-season team defence
predicts a defender's next season at r=0.134, as well as his own value at r=0.129 — the top-8
defenders of 2025 week 1 are seven Eagles). Credited skill players reproduce only 48% of team
offensive EPA variance; the other 52% is O-line, scheme and coach, none of which get a column.

### The lineup model: NO EDGE
22 lineup/player features + 13 team controls, pre-kickoff projected lineup gated by the
timestamped injury report, target = residual vs the close, season-blocked walk-forward ridge.

```
                 train R²    test R² vs close     gap
total            +0.0359        −0.0126          +0.0485
spread           +0.0262        −0.0078          +0.0340
CLV +0.165pp   EV −4.651%   n_test 1,399   moneyline CLV t = −4.27
placebo: real sits at the 40th–50th percentile of 20 shuffled refits
```

Adding the lineup block **doubles** the train/test gap without improving test. Strictly worse
than betting nothing.

### THE ORACLE — the result that matters
Re-run with look-ahead **deliberately on**: the projected lineup replaced by the **actual week-t
snap counts**. Perfect foreknowledge of who played and how much.

```
                 test R² vs close    slope       t
total               −0.0025         −1.339    −1.56
spread              +0.0004         +0.442    +1.13
+ team aggregates   −0.0094 / +0.0005
```

**A perfect lineup forecast buys nothing against the closing line.** This is a ceiling argument:
it is not that our projection is bad, it is that the best possible projection is worth zero. It
kills the obvious next iteration in advance — better injury scraping, depth charts, beat-reporter
feeds, faster news — because the ceiling with perfect information is already flat.

### Why: the market already prices personnel
```
corr(personnel sum, closing TOTAL)          +0.544
corr(personnel differential, closing SPREAD) −0.228
personnel → OUTCOME RESIDUAL               t=+0.28 (total), t=+1.45 (spread)
```
The line moves with personnel. What is left after the line does not.

### Two other things the run established
- **Totals are 90.9% efficiency, 4.6% pace.** var(log pts/play) dominates; plays/game has sd 9.0
  on a mean of 124.6 and correlates 0.344 with the total vs 0.968 for points-per-play. The entire
  "lineup-adjusted pace" idea aimed at 4.6% of the variance. It cannot move the total.
- The model was **least bad on the spread** (+0.150% ± 2.547) and **worst on the moneyline**
  (−5.056% ± 3.490) — the opposite of the "softer target" prior.

### What this closes
Every injury/personnel finding of the session, now under one roof:

| Signal | Real? | Persists? | Market prices it? |
|---|---|---|---|
| Questionable designation by team | 34-pt spread | r=+0.40 | yes |
| Practice pattern under the tag | 35-pt spread | 8/10 seasons | yes |
| Official transactions | monotone | — | yes |
| **Perfect week-t lineup (oracle)** | **by definition** | — | **yes, R²≈0** |

The personnel axis was the last untested source of team-strength information. It is now tested
to its ceiling. **The market prices who plays. Completely.**


## Q. THE SYSTEMATIC-ERROR AUDIT — why the models fail, in three numbers

The first workflow of the session (rebuild-and-audit, 6 agents, 2.3 hours) finished last. It was
the direct answer to "use audits to find our systematic errors," and it found them precisely.

### 1. The confidence carries zero information — calibration slope 0.00, not merely under 1

```
model               calibration slope    se       z(slope=1)     z(slope=0)
kmulti_full            0.0004           0.0896     −11.15         +0.00
kalman_score          −0.0015           0.091      −11.05
live ensemble blend    0.026            0.176       −5.55
market (control)       0.477            0.451       −1.16   ← passes
```

Decile 10 of the model (predicted P(cover)=0.677) **realises 0.470**. Decile 1 (predicted 0.313)
realises 0.478. The reliability diagram is flat-to-inverted. Intercepts are within 0.03 of zero,
so the miscalibration is *entirely* slope: the model's level is fine, its *disagreement with the
line* carries no information at all. Optimal shrinkage toward the market: **0.00** in logit space.

This is the measured answer to "rank 100 ML models by confidence": **our confidence has slope
zero. Ranking by it ranks by noise.** Replicated independently by the F11 calibration agent on a
different window and construction (slope +0.056, se 0.108).

**The ceiling, bounded:** at the most generous end of the 95% CI, at most 16% of the model's mean
2.39-point disagreement with the line is real → 0.39 pts → **1.20pp of cover probability**,
against the **~2.2pp** that −110 vig demands. Full-sample bound 1.95pp. Both short.

### 2. Level shrinkage — every model pulls toward the mean (β < 1), and it explains the dog/over skew

```
                    spread β (se)          total β (se)
kmulti_full         0.845 (0.013)          0.538 → 0.468 on 2022-25
kalman              0.783 (0.011)          0.726
live blend          0.788 (0.018)
```

Model RMSE 13.04 vs the line's 12.70 (+2.7%), widening to +4.0% on 2022–25. **Totals are twice
as bad as spreads.** The dog/over pick skew (live blend 70.5% dogs, 82% on |line|≥7) is the
mechanical consequence: a model that pulls every number toward pick'em lands on the dog by
construction. F16's diagnosis confirmed. Fixable by an affine rescale — which is *invariant* to the
informativeness t-stat, so **fixing it moves picks, not profit.**

### 3. The parameter budget — THREE, and the stacker spends FORTY

The sharpest single diagnosis of the session:

> Break-even needs R² = 0.558% (0.313% honouring key numbers). Each signal in the ridge costs
> ~1/n = 0.19% of R² in fitting noise at n=530. **The entire budget is three free parameters.
> The stacker spends forty.** A budget overrun of 13.5× before a single football insight is tested.

```
effective rank                    2.61 of 30 columns
PC1 (the market anchor)           60.3% of variance; 43.2% of all signal variance
leave-one-signal-out              37 of 40 signals inert (median marginal 0.037 pts)
bias² / variance / irreducible    2.68% / 0.55% / 97.32%
stacker contribution              a 0.64-pt wobble on a 5.63-pt anchor vs a 14-pt outcome
```

The ridge, left alone, shrank to λ=10,000 — its own way of saying "nothing here worth fitting."
Not bad signals, not bad shrinkage, not bias, not variance. **Irreducible: 97.32%.**

Prescription from the audit: a **1–3 parameter model, pre-registered, on the 2–3 PCs that exist**
— not a 40-signal stacker. Not built, because finding 1 already bounds even a perfect 3-parameter
model at 1.20pp vs 2.2pp needed.

### Also from this workflow
- **Modern ML rebuild** (GBM + elastic net, residual + level, spread + total, 2020–25
  walk-forward, n=1,693): **0 of 16 money tests survive**; best is 0.74 SE from zero. Residual
  models *tie* the line (RMSE 12.665 vs 12.663); level models are 1.39 pts *worse*.
- **Calibration + conformal (F11)**: quarter-Kelly log growth negative in **all 21** model ×
  calibrator runs; ~−5%/year at the best (Platt). Calibration cannot manufacture edge.
- **Cross-venue** (books/Kalshi/Polymarket same-minute panel, 67,993 rows, 62 resolved games):
  no_edge. Kalshi mids already sum to 1.0002 — cost is purely spread + fee.
- **Polymarket audit**: "70M price points" overstates content by **~39×** — it is a uniform
  60-second bar series, 1.8M actual fills. `outcome0` is **NOT reliably away**: 9.2% of events
  list home first; assuming away-first silently inverts 1 game in 11. Verdict: stop treating PM as
  an edge source, use it as a **free consensus prior** — as calibrated as the 4-book consensus
  (Brier gap −0.00006), printing every 60s where covers is a median 79 min stale.

### What section Q means, together with section P
| Question | Answer | Where |
|---|---|---|
| Can better features help? | No — 37/40 inert, rank 2.61, budget is 3 | Q.3 |
| Can a smarter combiner help? | No — confidence slope 0.00 | Q.1 |
| Can personnel data help? | No — oracle R²≈0 | P |
| Can calibration/Kelly help? | No — negative in 21/21 | Q |
| Can a different ML family help? | No — 0/16, ties the line at best | Q |

The market is not slightly ahead of the models. **It is the sufficient statistic, and the models
are noise around it.** Any remaining edge is in what the market *is*, not in what the game will be.


## R. Personnel-delta and a SECOND oracle — the player-level workflow, complete: 6 of 6 no_edge

### Personnel-delta: "the market prices a QB change crudely" — FALSIFIED
The hypothesis the entire player-level workflow was built on. Put a plain "QB changed" dummy and
the player-level QB *quality* delta in the same regression on the closing line:

```
                          coef on closing line     t
QB-changed dummy              +0.366             +3.24
player-level QB delta         +0.605             +3.40
on material QB changes only (n=333):
QB-changed dummy                                 +0.93   ← drops out
player-level QB delta                            +2.69   ← holds
```

**The market prices replacement *quality*, not just the event.** Under-reaction (outcome minus
market) = −0.252 ± 0.362, t=−0.69, p=0.47. Sign-flip placebo p=0.46. Per position, Holm-corrected
over 9 groups: nothing tradeable. Safeties reached nominal significance and are the wrong way round
(the outcome runs opposite to the rating; market coefficient −0.012, t=−0.03 — the market is not
over-reacting, the rating is wrong). Train/test gap on the betting model: +7 to +15pp. Textbook.

### The second oracle — independently reproduced
A different agent, different construction, same experiment: rebuild the lineup rating from the
game's **actual** week-t snap counts.

```
corr(oracle lineup, actual margin)     +0.3015    ← the personnel axis is REAL
corr(oracle lineup, closing line)      +0.7257    ← and the market has it
corr(oracle lineup, RESIDUAL)          +0.0007    ← nothing left over
n=1,121; clustered t on both components 0.72 and −1.02
```

Two agents, two constructions, one answer: **perfect usage foreknowledge adds nothing.**

### A resolved null, not an underpowered one
This matters, because "not significant" is usually "not enough data." Here it is not:

```
ROI space:  SE 2.845pp, MDE 7.08pp → resolving a 0.64% edge needs ~137,000 bets (~490 seasons)
CLV space:  SE 0.0234 pts, MDE 0.058 pts  <  0.077 pts the graveyard bar requires
            → ADEQUATELY POWERED to detect a graveyard-sized edge. Returns −0.058. Resolved.
```

The model's net CLV is −0.0582 ± 0.0234 pts, t=−2.49: it sits on the **wrong side of the line's
own move**, 5.8 SEs below the graveyard bar.

### NEW RULE — the drift placebo
The agent's v1 reported "+0.17 pts CLV, t=2.6" and killed it itself:

> Blindly betting the **favourite** earns +0.150 pts of T−1440-to-close CLV at **t=+7.31** with
> no model at all. v1's predictions correlated +0.74 with the favourite. v1's CLV was line drift.

**Lines drift toward favourites in the final 24 hours.** Any model whose picks correlate with the
favourite side will show positive CLV that is drift, not information. Every CLV number must be
tested against the always-favourite baseline. Added to the rules.


## S. Player props — DEAD on liquidity, and a correction to an earlier recommendation

Earlier tonight I told Nick props were "the softest market available" and the best remaining
target. The data says otherwise, in two independent ways.

### 1. There are no prices — an infrastructure gate
`0 of 7,634` prop markets have a single traded price in this repo. The collector gates history on
`pm_markets.is_core`, and every prop is `is_core=0`: 4 have any price point (0.05%), 0 have any
trade row. The calibration hypothesis — "are props worse calibrated than game markets" — is
**unmeasurable on local data**, and no fallback exists: Kalshi has no player series, covers and
oddsapi and Pinnacle carry only game markets. Flipping the gate and backfilling would fix this.

### 2. But it would not matter — the liquidity kills it independently
```
prop volume, all-time         $2,026,187     (41.6% of it is ONE Super Bowl)
core game-market volume    $1,320,156,114
props as share of NFL flow        0.15%

volume distribution over 7,637 props:  p50 $0   p90 $298   p99 $2,624
traded exactly $0                          58.6%
top 10 markets                             46.9% of all prop volume

per slate-week (ex Super Bowl):  >= $500   median 29    >= $1,000  median 7
                                 >= $5,000 median 0, mean 1.4
```
And that is **lifetime two-sided notional, not depth**. Roughly **one prop per week** outside the
Super Bowl is liquid enough to carry a real stake. Not income even if the edge were real.

### 3. The one price-free test available died on placebo
P(Over) on the posted line = 0.3991 (n=4,428, t=−3.52) — an apparent Under bias. The
same-player-different-week placebo returns 0.4308 (t=−3.16); the threshold-shuffle placebo
0.4236 (t=−3.73). **Reproduced by both placebos: a line-setting artifact, not an inefficiency.**

### Data-quality finding worth keeping
Question text is corrupt for a subset of QB markets — passing lines labelled "Rushing Yards"
(305 rushing lines above 60; above 120 the threshold sits a median 79.5 yds from the passing
line). Any future prop join must screen for this. Parse-and-grade otherwise worked: 6,094 of
7,637 matched to a settled stat line.

**Verdict: props are not "the softest market." On Polymarket they are barely a market.** If Nick
wants props, the data has to come from a sportsbook prop feed, not from here — and the liquidity
question would have to be re-asked there.

## T. Operational — the orphan scan was blind
`pgrep python3` returns 0 while four `Python.framework/.../Python` processes run at 60–93% CPU.
Workflow agents' scripts run under the framework binary, not `python3`, and their names are
generic (`model.py`, `ortho.py`, `build.py`). The reliable attribution is **cwd** via
`lsof -a -p PID -d cwd` — orphans from a completed workflow sit in `analysis/<workflow-dir>`.
Two `model.py` refits in `analysis/lineup_ml` were still running at 93% after the player-level
workflow had returned all 6 results; killed. Load had reached **41.87**.

Rule: after any workflow completes or is stopped, scan `ps -eo pid,pcpu,args | grep
Python.framework` and attribute by cwd before assuming the machine is free.


## U. Load 234 — diagnosis, and a rule I have now broken twice

1-minute load average reached **234.75** on 8 cores (5-min 88, 15-min 42). Diagnosed rather than
guessed: 496 total processes (normal), **3** Python.framework processes, no fork tree. It was three
things landing in one minute, none of them a steady-state agent:

- The order-flow agent's **multiprocessing pool** spun up a burst of short-lived parquet workers
  (`build.py NN plNN.parquet` per week) that finished inside the window. The load average counts
  runnable processes; thirty workers for twenty seconds blows the 1-minute figure.
- **ChatGPT's Sparkle auto-updater** (`com.openai.codex`) at 44.7% — external, not ours.
- **`corespotlightd` at 14.7%** — Spotlight re-indexing 18 GB of SQLite because the WAL checkpoint
  had just moved 7.5 GB through the file. Self-inflicted and recurring on every checkpoint.

**Fixes:** `.metadata_never_index` in `data/line-history/` (corespotlightd → 1.5%). The
multiprocessing burst is legitimate and brief; nothing to fix, but it means a 1-minute load spike
during a parquet build is expected and is not a reason to stop the workflow. I stopped the
orthogonal-data workflow at 2/4 on the spike before diagnosing it — order-flow and OI, the two
highest-value hunts, were lost mid-run and must be re-run. Diagnose first; the spawner can wait
sixty seconds.

**The rule, stated because I have violated it twice tonight: ONE WORKFLOW AT A TIME.** Load 34 the
first time, 41 the second, both from stacking a second workflow on a running one. Each agent scans
the same 18 GB file; two workflows are 8–10 concurrent full-table scans on 8 cores. Serializing is
strictly faster at that level of oversubscription, and the machine stays usable for Nick. Resume
order: orthogonal-data (order-flow, OI) → unasked-questions (six market-process questions).


## V. A journal with all its results is not a finished workflow

The player-level workflow returned all 6 scheduled results to its journal and I treated it as
done. It was not: the workflow process was still alive, and an agent inside it kept launching
`placebo.py` in `analysis/lineup_ml` — a fresh one appeared within two seconds of each kill,
at 60–98% CPU. Killing children was whack-a-mole; `TaskStop` on the workflow ended it.

**The tell:** a completed workflow sends a task-notification. This one never did. Two of tonight's
seven workflows completed by notification (rebuild-audit, profit-hunt); the other five were stopped
explicitly. Journal result count is not a completion signal.

**Rule:** before declaring a workflow done — (1) confirm the completion notification, not the
journal count; (2) if absent, `TaskStop` it; (3) then scan `ps -eo pcpu,args | grep
Python.framework`, attribute by cwd, and kill residue; (4) re-check three seconds later for
respawn. In that order — kill-then-stop respawns, stop-then-kill sticks.


## W. Reusable artifacts from tonight, and where they live

Untracked (gitignored) but kept on disk. Reproducible from the scripts, expensive to rebuild.

| Artifact | Path | What it is |
|---|---|---|
| Player value table | `data/derived/player_value.sqlite` → `player_value_weekly` | Regularised APM per (season, week, player_id): `value`, `se`, `value_epa` (rescaled for lineup sums). QB r=0.416 OOS. Defence is a team rating in disguise — treat `def` as near-worthless alone. |
| Grading panel | `data/grading_panel.sqlite` → `grading_panel`, `panel_book_quotes` | Per game: opener, strictly-pre-kickoff close, best-of-4 price, outcome. **Bet-everything control passes** (spread −4.185% vs theory −4.245%). Built by `research/betting/nfl/audit_grading_panel.py`. |
| Live tape | `data/live-tape/live_tape.sqlite` | Kalshi minute candles mapped to ESPN events. The premise it served is dead (feed synchronous within 15s) but the mapping is done. |
| Labelled plays | `data/line-history/jev_live_plays.sqlite` → `jev_play_labels` | 68,413 plays × event_class/injury_severity/star/surprise. $3.26. |
| Labelled transactions | `line_history.sqlite` → `jev_transaction_signals` | 10,519 in-season roster moves, 2019–26. $0.39. |
| Triaged titles | `data/line-history/jev_yt_triage.sqlite` | 39,163 YouTube titles by content type / injury relevance. $1.25. |
| Agent scratch | `analysis/{availability,lineup,lineup_delta,lineup_ml,totals-lineup}/` | Per-workflow working code. Ignored, not deleted. |

`scripts/player-value-model.py` now carries its validated RESULTS in its own docstring — the
model that works, documented where it lives.


## X. Q26 — the key-number atoms HAVE drifted, and it does not rescue the teaser

Run directly (not delegated), regular-season games 1999–2026, `scripts/model-lab/atom_drift.py`
and `scripts/model-lab/teaser_era_reprice.py`.

### The atoms are not stationary — 8 BH survivors of 30 tests
```
  k    chi2   p_homog  trend z  p_trend   pooled  modern   delta
  5   11.47    0.0216    +2.80   0.0051    3.57%   4.54%   +0.97pp
  6   14.26    0.0067    +2.56   0.0106    5.96%   6.81%   +0.85pp
  8    5.16    0.2706    +2.04   0.0415    3.79%   4.54%   +0.74pp
  7    6.90    0.1399    -1.50   0.1326    9.09%   7.66%   -1.43pp
 10    6.96    0.1366    -2.26   0.0237    5.58%   4.97%   -0.62pp
 13   14.69    0.0056    -3.04   0.0024    2.75%   1.84%   -0.91pp
  3    4.89    0.2984    -1.27   0.2054   14.99%  14.53%   -0.46pp   ← STABLE
nominal p<0.05: 10 (expected 1.5) | BH q=0.10: 8 survivors | Bonferroni: 0
```

**The mechanism is the 2015 extra-point move**, and the data matches the mechanical prediction:
mass moved **off 7 and onto 6 and 8**. A 33-yard XP is missed often enough, and two-point tries
taken often enough, that games which used to land on a 7-point margin now land on 6 or 8. 13 and
10 shrank; 2 and 5 grew. **The atom at 3 is stable** (z=−1.27, p=0.21) — which is the one that
matters most.

### It does NOT move the teaser, and the reason is geometric
A 6-point tease on a −7.5 favourite converts a loss to a win exactly when |margin| ∈ {2..7}.
```
window mass P(|margin| 2..7)   pooled 42.62%   modern 43.65%   +1.04pp, z=+0.97, p=0.3336
ACTUAL Wong leg rate           pooled 73.77%   modern 73.53%   −0.24pp, z=−0.17, p=0.8630
                               (n=2,882 pooled / 748 modern decided legs)
```
Losing 7 (−1.43, **inside** the window) is cancelled by gaining 6 (+0.85, inside); the gain at
8 (+0.74) falls **outside** the window entirely. Statistically real drift, economically inert here.

### Break-even, re-derived on modern data — confirms −120.2 independently
```
  price   need/leg        pooled              modern
  -110     72.37%    +1.39pp (+1.70 SE)   +1.15pp (+0.72 SE)
  -115     73.14%    +0.63pp (+0.77 SE)   +0.39pp (+0.24 SE)
  -120     73.85%    -0.09pp (-0.11 SE)   -0.33pp (-0.20 SE)
  -125     74.54%    -0.77pp (-0.94 SE)   -1.01pp (-0.62 SE)
```
Per era: 2015–19 **75.93%**, 2020–24 **74.66%**, 2025–26 **69.08%** (n=152, wide).

### Not a finding, but worth knowing
Per line, pooled: **+3 supplies 1,109 of 2,882 legs (38%) and returns 72.77%** — barely over the
−110 break-even of 72.37%. The headline is carried by +1.5 (78.17%, n=197) and −7 (75.05%,
n=457). Selecting the best of 8 lines after seeing them is the multiplicity trap, so this is
recorded as a caution about uniformity, **not** as a narrower strategy.

**Verdict: a genuinely new question, rigorously answered, and the answer is no.** The pooled model
is fitted to an era that is partly over, but the correction does not move the product that depends
on it. Teaser verdict unchanged: needs −110 to −115; dead at −120. Still blocked on a price nobody
has recorded.


## Y. Q33/Q36 — the favourite drift is real, seven-sigma, and NOT tradeable

Run directly. `scripts/model-lab/favourite_drift.py`. covers spread tape, strictly pre-kickoff,
game-clustered.

### The drift is real and large in t, tiny in points
Measured as the change in `|home_line|`, which is sign-convention-proof: whoever is favoured, a
bigger `|line|` means the market moved further toward them.
```
horizon    n       d|line|      t
  168h   2,090     +0.3103   +7.99
   24h   2,498     +0.1005   +5.37
    6h   2,502     +0.0522   +3.30
home-favoured +0.0944 (t=+4.06) | away-favoured +0.1101 (t=+3.50)
```
Holds on both sides and every horizon. Independently confirms the lineup agent's control.

### It does not convert
```
bet the favourite at T-24h, real posted prices:  ROI -6.830% +/- 2.322,  win 48.99%
control, both sides at close:                    ROI -5.603% +/- 0.093
```
Within half an SE of the control — i.e. you pay the vig and nothing else.

**THE CONVERSION, which is the transferable lesson.** Points of CLV are not percent of EV. The
factor is the local density of the margin residual, ~0.035/point:
```
+0.1005 pts x 0.035/pt = +0.35pp of cover probability
-110 needs                +2.2pp
                          -> 6x short
```
**A seven-sigma property of the market is worth a third of a percentage point.** The drift moves
the NUMBER YOU GET without moving the PROBABILITY YOU WIN, so it shows up in CLV and vanishes in
ROI. This is why rule 3 exists, and it generalises: any future CLV claim must be multiplied by
0.035/point before being compared to a vig measured in percent.

### Two errors of mine, recorded because both are instructive
1. **False FAIL on the control.** I hardcoded a −5.5% to −3.0% band, which assumes best-of-4
   shopping. This script does not shop — it takes the last quote from whichever book — so the
   right comparison is the SINGLE-BOOK vig (grading panel: −5.564% ± 0.087 vs theory −5.491%).
   Measured −5.603% ± 0.093: a match. **Match the control band to the grading, not to an
   assumption.**
2. **Sign-and-magnitude bug in the drift calculation.** Branching on `fav_is_home` and
   differencing signed lines returned −0.018 where `|close| − |early|` on the *identical* 2,498
   games returns +0.1005. Caught by a direct raw-data sanity check, not by the script. **Prefer
   `abs()` formulations that cannot express a sign error.**


## Z. Q1/Q2 — permanent vs transitory: most "line movement" is quote noise

Run directly. `scripts/model-lab/permanent_transitory.py`, covers spread tape resampled onto an
hourly grid (LOCF, games under 60% coverage dropped), 2,452 games.

### The raw result looked like massive mean reversion — and half of it was my sampling
```
                 VR(2)   VR(6)  VR(24)   var(1h)
ALL BOOKS mixed  0.745   0.458   0.271    0.15672
betvictor        0.809   0.624   0.514    0.08651
betway           0.857   0.667   0.527    0.06050
williamhill      0.897   0.781   0.668    0.04401
bet365           0.814   0.481   0.298    0.10691
```
Taking "the last quote from whichever book" makes the series alternate between books quoting −7
and −7.5 — the bid-ask-bounce artifact. **Restricting to a single book cuts hourly variance by
30–72% and roughly doubles VR(24).** A large share of apparent movement is not movement.

### Genuine reversion remains, and it is still not the market being wrong
Single-book VR(24) of 0.51–0.67 is well below 1. But the money arm points the other way:
```
CONTROL both sides at close:  -5.605% +/- 0.093   (single-book theory -5.49%)  PASS
FOLLOW the last-24h move   :  -2.456% +/- 3.061   n=984, t=-0.80
FADE the last-24h move     :  -8.571% +/- 2.975   n=984, t=-2.88
```
If the line genuinely reverted, FADE would profit. It loses 6.1pp to FOLLOW. FOLLOW beats the
control by 3.15pp but at ~1.03 SE — not significant, and not a strategy.

**Resolution: the residual reversion is each book's own quote jitter (shading juice, posting −7
then −7.5 then back), not the fair line reverting.** The tape is noisy; the fair value is not
wrong.

### Persistence regression — the primary, model-free view
regress (close − line_T) on (line_T − line_{T−h}); coef 0 = persisted, −1 = fully reverted:
```
T=72h  coef -0.09 to -0.20   permanent 80-91%
T=24h  coef -0.20 to -0.33   permanent 67-80%
T= 3h  coef -0.24 to -0.40   permanent 60-76%
```
**58–91% of a move is permanent.** Reversion grows as kickoff approaches — consistent with late
quotes being noisier, not with late information being wrong.

### What this reframes
Every strategy touching line movement — steam, follow-the-sharp-money, fade-the-public, buy-the-
bounce — is trading a series that is **substantially quote noise on a mixed-book tape**. This
retroactively explains why both directions died in the graveyard: there was never a stable regime
to exploit, and much of the measured "movement" was an artifact of how the tape is assembled.

**Operational rule added: any line-movement study must fix the book.** A mixed-book series has
~2x the hourly variance of a single-book series and half its variance ratio.


## AA. THE TEASER PRICE — the blocker is gone, and at +106 the strategy clears

Nick read the price off the DraftKings slip: **2-team 6-point teaser on two underdogs, +106.**
That single number, missing all session, resolves a strategy measured to four decimals everywhere
else. `nfl_teaser_price_ledger` now has its first row and `teaser-scan.js` is unblocked.

### At +106 it clears, and not marginally
```
break-even at +106            69.673% per leg
pooled Wong leg rate          73.77%  (n=2,882)   →  +4.09pp,  5.00 SE
dogs only                     73.72%  (n=1,967)   →  +4.04pp,  4.07 SE
modern dogs (2020+)           74.76%  (n=523)     →  +5.09pp,  2.68 SE

EV on a 2-leg ticket, rho = -0.044 (measured):    +10.34%,  t = +4.10
adverse rho = +0.05:                              +14.09%
```

### Why the price is credible rather than a typo
```
Pinnacle's devigged price for a RANDOM teased leg:  69.13%
Break-even at +106:                                 69.67%
```
**Identical.** The book prices the teaser at fair value for the population that buys it — people
who tease whatever games they like, whose legs run ~69%. The edge is not a generous price. It is
that legs crossing BOTH 3 and 7 run 73.8%, and that window is structural (it is the set of lines
from which +6 crosses both key numbers), not fitted after the fact.

This is the same correlated-product mispricing the whole session pointed at. It survived a night
in which every forecasting approach died **because it is not a forecast.**

### A selection error of mine, caught before it reached a stake
The first scanner ranked pairs by the PER-LINE historical rate, which picks +1.5 — the best of
eight lines on the smallest sample (n=197) — and reported **+24.33% EV**. That is choosing the
best of eight after seeing all eight: the same multiplicity trap that makes a 5,940-test harness
produce fake winners, and which I had flagged an hour earlier. Pricing with the POOLED rate gives
**+10.35%**. The scanner now defaults to pooled; `--per-line-rates` is opt-in and documented as
biased. It also deduped by (game, side) — the same bet at two books is one opportunity — and
limited the horizon to the current slate, which cut 12,874 phantom "pairs" to 27 real ones.

### The scanner
`scripts/model-lab/wong_scanner.py`. **No sportsbook scraper was needed**: the repo already
ingests The Odds API, which carries DraftKings (589k rows) and FanDuel (83k) plus nine other US
books, continuously. That beats scraping — no ToS exposure, no breakage on markup changes, and it
is already historical. What no odds feed exposes is the teaser price itself, which is a bet-slip
computation; hence the ledger.

Current slate: 8 qualifying legs, 27 distinct pairs, quarter-Kelly **2.44%** of bankroll.

### What would falsify it
1. Push rule is not `stake_back` — `graded_loss` moves break-even to about −116.8 equivalent.
2. The +106 does not apply to these specific lines (books vary teaser pricing by spread).
3. 2025-26 ran **69.08% on n=152**, the weakest of five eras. If the modern rate is truly ~69%,
   the edge at +106 is zero. This is the live statistical risk and it is worth tracking per ticket.
4. Limits: teaser maxima are typically low, so this is a small-stakes line, not a business.

