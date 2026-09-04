# Path to profit — a re-examination

## 2026-08-29 execution update

Phase 1's teaser executor is now shipped. The Edges → Wong teasers surface no
longer accepts one reference spread plus an assumed payout as an actionable
bet. It builds two-leg tickets only when both qualifying legs are posted at the
same book in different games, chooses the best recently verified teaser payout,
and rejects stale lines, stale prices, mathematically negative prices, and any
price worse than the stricter −115 operating gate.

Paper and manually placed tickets now enter a separate forward ledger with the
exact spread and teased number for both legs. Final scores grade legs and
tickets, report placed-only profit units, and keep the forward leg rate separate
from the frozen 1,391-leg historical result. Gridiron HQ records execution; it
does not transmit wagers.

The startup corruption risk is also closed: the API port is checked before any
SQLite module, migration, seed reconciliation, scheduler, or draft clock is
started. A second server exits with the owning PID and command.

Written 2026-08-27, after re-measuring the actual state of the system rather than trusting the prior write-ups. Every number below was pulled fresh from this database or a live API call today; where a figure disagrees with an older doc, the fresh number is the one to trust and the disagreement is called out.

---

## The finding that reorders everything

**The binding constraint on profitability right now is not the model. It is odds-data quota.**

```
Odds API credits:  336 used / 164 remaining   (free tier = 500/month)
```

That single number invalidates the current roadmap. Concretely:

- The prop-CLV capture job computes its own budget as `floor((remaining − 50 reserve) / 5 markets)` = **22 event-captures affordable**.
- One week of the protocol it was designed to run (16 games × two windows, T-24h and T-1h) needs **32 event-captures**.
- **It cannot afford to finish a single week**, and the honesty bar in `WORK_LOG.md` is ~200 *settled* bets before median CLV means anything.

The multi-book line capture has already died of this. Proof from our own snapshots:

| capture day | books | events | avg spread gap | max gap |
|---|---:|---:|---:|---:|
| 2026-08-05 | **8** | **272** | 0.289 pts | 3.0 pts |
| 2026-08-27 | **1** | **1** | — | — |

That is not a scheduling bug. That is the free tier running out.

**Every path to profit below requires odds volume.** Line shopping needs simultaneous multi-book prices. CLV needs a closing snapshot per graded bet. News-latency needs frequent polling. Prop edge needs settled samples. All of it is gated behind the same $30-ish/month line item, and none of it can be proven — in either direction — until that gate opens.

---

## What is actually settled, and what that implies

### Prediction is a dead end. Stop paying attention to it.

- 21 component models vs 15,096 closing lines: **0 clear the materiality gate**, verified three independent ways.

  **This is the academically expected result for a mature market, not a disappointing null.** Sauer
  (1998, *Journal of Economic Literature*, "The Economics of Wagering Markets") surveys evidence that
  point-spread markets are close to informationally efficient; Vandenbruaene, Vermeulen & Lambrechts
  (2022, *Journal of Sports Economics*) and Winkelmann, Deutscher & Ötting (2024, *Journal of Sports
  Economics*) both find closing lines remain very hard to beat with public information in more recent,
  higher-liquidity data. Zero of 21 models clearing the gate against 15,096 real closing lines,
  independently re-verified this session, is evidence the market IS efficient here — the same
  conclusion the published literature reaches — not evidence this project failed to look hard enough.
  Reframe accordingly: this is a correctly detected efficient market, not a failed search for edge.
- Nine signal families (age, injury, scheme, opponent strength, teammate competition, recency blends…) each passed isolated validation and then **degraded the shipped pipeline under ablation**.
- Fresh check today of the cover-probability calibration — the thing that would have to work for any model-derived bet to be sized:

```
walk-forward calibration slope : 0.33      (gate requires 0.7 – 1.3)
calibrated Brier               : 0.2504
market   Brier                 : 0.2497    ← the market is still better
```

The model's probabilities are not merely unproven, they are measurably worse than reading the price off the board. `stakeFor()`'s `source: 'model'` guardrail correctly returns **zero units** today, and that is the code behaving properly, not a bug to route around.

**Implication:** profit has to come from edges that do not require out-predicting the market. There are three, and this project has already found all of them — it just has never been able to *run* them.

---

## The three real edges

### Edge 1 — Execution. The largest, most certain, least exploited.

Measured today from our own Aug 5 snapshot: 8 books, 272 events, all captured **in the same instant** (verified 0.0 hours apart, so this is genuine simultaneous disagreement, not staleness across time).

Simultaneous spread disagreement:

| game | side | books | line range | gap |
|---|---|---:|---|---:|
| BUF / HOU | Bills | 8 | −1.5 → +1.0 | **2.5 pts** |
| GB / MIN | Packers | 8 | −1.5 → +1.0 | **2.5 pts** |
| ARI / LAC | Cardinals | 8 | +10.0 → +11.5 | 1.5 pts |
| NYJ / TEN | Jets | 8 | +2.0 → +3.0 | 1.0 pt |

Average gap across all 272 events is 0.289 points — *lower* than the 0.813 figure quoted in `WORK_LOG.md` §12, and worth correcting. But the mean is the wrong statistic. **Line-shopping value lives entirely in the tail**, and the tail here is 2.5–3.0 points.

The price dispersion is even more striking than the line dispersion. On the Jets, at the same moment across 8 books, the same side was available anywhere from `+2.0 at −120` to `+3.0 at +100` — a better number *and* a better price simultaneously. Run the EV at a true 52% win probability:

```
bet at −120 :  0.52 × (100/120) − 0.48  =  −4.7%   EV
bet at +100 :  0.52 × 1.00      − 0.48  =  +4.0%   EV
```

**The identical bet, same side, same instant, swings 8.7 points of EV based only on which book you use.** No forecast involved. This is arithmetic, and it is the single most reliable edge in the system.

*Constraint to be honest about:* Aug 5 is preseason. Dispersion compresses once real limits and sharp money arrive. The in-season number must be re-measured, which — again — needs quota.

### Edge 2 — Structural payout exploits (Wong teasers)

Already found and quantified: 1,391 qualifying legs, **74.69% win rate**, +6.50% EV at −110, z = 1.99. It predicts nothing; it exploits the fact that a 6-point teaser costs the same whether it crosses both key numbers (3 and 7) or neither.

The entire question is **price availability**, not analysis. At −110 it is +6.5%; at −130 it is −1.3%. Books have deliberately moved many 2-team 6-point teasers to −120+ precisely because this exploit is well known. `findTeaserLegs()` already enforces a −115 floor. This needs a live-price check, not more modelling.

### Edge 3 — Correlation mispricing in same-game parlays *(the genuinely new idea)*

This is the one real opportunity nobody here has pointed at, and we are unusually well-positioned for it.

We already have a **fitted Gaussian copula** (`server/services/correlation.js`) with archetype correlations estimated on large samples:

| archetype | correlation | pairs |
|---|---:|---:|
| QB ↔ WR, same team | **0.196** | 8,990 |
| QB ↔ TE, same team | 0.179 | 4,345 |
| QB ↔ opposing QB | 0.141 | 1,369 |
| QB ↔ RB, same team | 0.046 | 6,089 |

Why this matters: **sportsbooks price same-game parlays by applying a crude correlation haircut** — often a single blanket multiplier, or a rules table, rather than a real joint distribution. Our copula produces an actual joint probability. Wherever the book's haircut and our joint distribution disagree by more than the vig, that is a priced edge, in a market that is *far* softer than NFL sides.

Crucially, this edge does **not** require our marginal projections to beat the market. Even if every individual leg is priced perfectly fairly, a wrong *correlation* assumption is still exploitable. That sidesteps the exact wall that killed the prediction work.

Work required, honestly stated:
1. The existing correlations are fitted on **fantasy points**, not on prop-market stats. They must be refit on the pairs that actually trade (QB pass yds ↔ WR rec yds; RB rush yds ↔ team total; QB pass TD ↔ WR anytime TD). The source data (`player_week_usage`) is already there.
2. SGP prices must be pulled and compared. Credits again.
3. It goes through the **same gate as everything else** — walk-forward, Holm-corrected, ablated. "The copula said so" is not evidence.

---

## The unlock that makes a small budget workable

Blind polling is what bankrupted the credit budget. The fix is **event-driven capture**, and we already have the free trigger for it.

ESPN's public scoreboard endpoint returns a live DraftKings spread and total, with **no API key and no quota** (verified today against a real Week 1 game — returned `LAR −3.5, O/U 48.5`). `gamescript.js` already parses this feed.

So:

```
ESPN scoreboard  →  free, unlimited, high-frequency   →  MOVEMENT DETECTOR
The Odds API     →  paid, scarce, multi-book          →  spend only on a detected move
```

Poll ESPN as often as we like for free. When the reference line moves — or when the news pipeline fires a typed injury signal — *that* is when a paid multi-book snapshot is worth a credit. This converts the budget from "blind polling that dies in a week" into a targeted instrument, and it is the precondition for the news-latency edge below.

---

## The asset that is built and completely unused

The news→line pipeline is more complete than anyone has given it credit for:

- **1,164 news items, 100% with entities extracted** (`entities_json` populated on every row)
- 32 teams' verified beat-reporter Twitter handles, plus national insiders
- Typed signal extraction with verbatim evidence spans
- `nfl_tweet_line_watch` — 68 watches registered, **1 resolved**

That single resolved watch is a Ja'Marr Chase practice-scare tweet, followed by a **1.5-point spread move**. n = 1 proves nothing. But it is the correct shape of the thing, and the machinery to accumulate n is already written and running.

Right now this pipeline's entire output is *prose explanations on a picks page*. It has never been used to time a bet, and it has never been measured for latency — which is the only question that matters: **when a beat reporter tweets, how long until each book moves?** Any book with a consistent lag is a standing, repeatable edge, and measuring that lag costs nothing once the ESPN detector above is in place.

---

## The plan, ordered by value per unit of effort

The product now enforces this ordering in the interface: NFL opens at the
teaser execution gate, forecasting opens as a paper research board, and the AI
audit has a dedicated proof tab. "Blocked" is never presented as a KPI without
the failed condition, current measurement and next action.

### Phase 0 — Unblock (do this first; nothing else moves without it)

1. **Upgrade the Odds API tier.** This is a spending decision only you can make, so I am not making it — but the arithmetic is unambiguous: the free tier cannot finish one week of the capture protocol already written, and it has already killed multi-book snapshots. Check current pricing; the entry paid tier has historically been ~$30/month for 20,000 credits, which is roughly 40× current headroom and comfortably covers a full season of both capture jobs.
2. **Build the ESPN free-tier movement detector.** Poll the scoreboard on a tight interval, diff the reference line, and trigger paid multi-book capture only on a move or a news event. This is a small, self-contained service and it is what makes any budget — free or paid — go further.

### Phase 1 — Harvest the model-free edges

3. **Best-price execution surface.** We already store simultaneous multi-book quotes. Surface, per bet: best available line, best available price, and the EV delta versus the median book. The 8.7-point EV swing above is not a theory, it is in the data we already hold. Requires no forecast to be correct.
4. **Middle detector.** Our own snapshots show simultaneous 2.5-point gaps. `lineMoveValue()` already prices half-points against the real NFL margin distribution (a 3.5→3.0 move is worth **4.2×** a 5.5→5.0 move, because margin 3 alone is 15.12% of games). Pointing it at straddled pairs is mechanical reuse of a validated tool — the `WORK_LOG` itself lists middling as unexplored.
5. **Live teaser price check.** Answer the availability question and either activate or formally close the +6.5% teaser edge.

### Phase 2 — The correlation play

6. Refit correlations on **prop-market stat pairs** rather than fantasy points.
7. Price SGPs off the copula, compare to book prices, and run the result through the standard gate. This is the highest-ceiling item on the list and the only genuinely new modelling work I would endorse.

### Phase 3 — Time-based edge

8. **Measure book latency** against the news pipeline using the free ESPN detector. Produce a per-book lag distribution. A book with a reliable lag is an edge that compounds every week of the season.

### Phase 4 — Settle the props question

9. Let the CLV loop run to ~200 settled bets and read the answer honestly. It currently holds **876 quotes, 0 settled, 0 with closing lines** — the clock has not started, because Week 1 has not closed and the budget cannot cover it. Phase 0 starts this clock.

---

## Explicitly not doing

- Adding models or features to spread/total prediction. Settled negative, three ways, against 15,096 closing lines.
- Re-adding age / injury / scheme / opponent / teammate adjustments. Each passed isolated validation and then *hurt* the real pipeline.
- Forcing the cover-calibration gate open. Slope 0.33 means the signal genuinely is not there; opening the gate would just mean sizing real money on noise.
- Scraping OddsPortal, or scraping sportsbooks directly. `robots.txt` disallows the former; the latter is a terms-of-service problem, not a technical one. The paid API is the legitimate path and it is cheap.

---

## Honest expectations

If every phase above works, the realistic outcome is **a few percentage points of ROI on modest volume** — the same number PropsBot's own glossary quotes as the honest ceiling, and the same one this project reached independently. Not a money printer.

The realistic failure modes, in order of likelihood:

1. **Line-shopping edge is real but uncapturable in practice** — it requires accounts at 6+ books, funded, with fast manual execution before the number moves. That is an operational problem, not an analytical one, and it is the most common way this exact edge dies.
2. **Teaser prices are no longer available at −115 or better**, closing Edge 2 entirely.
3. **Props turn out to have no edge**, which the CLV loop will tell us honestly after ~200 settled bets.
4. **Books limit or restrict the account** once consistent line-shopping and steam-following behaviour is detected. This is the standard endgame for a winning execution-based bettor and should be planned for, not discovered.

The one thing I would not bet on is the prediction model suddenly starting to work. That question has been asked and answered more rigorously here than in any of the reference material, and the answer was no.

---

## Live readiness snapshot — 2026-08-29

The product now calculates this snapshot from the ledgers instead of relying on
the plan text:

- Historical blind audit: 70/70 opened, 157 bets, −10.43% ROI. Complete as a
  diagnostic and not untouched profit proof.
- Untouched forward proof: 0/250 settled decisions.
- AI outcome-blind review: 203 reviewed, 0 kept, 0u; research-only because the
  historical quote/snapshot timestamps needed for promotion were not preserved.
- Wong teasers: historical leg edge measured; zero forward tickets. The next
  concrete action is one reachable same-book payout check at −115 or better,
  followed by paper tracking and 100 graded forward legs.
- News latency: 1/68 registered watches resolved; at least 30 timestamped
  responses are required before estimating a lag edge.
- Props: 64 independent shadow decisions and 876 quotes, but 0/200 decisions
  with preserved closing-price evidence. Quote identity coverage is 95.43%; that
  is data hygiene, not profit evidence.
- Forecast-model staking: retired as a current path. It returns only after 250
  frozen forward decisions and positive CLV, not after another historical tune.

Therefore the honest answer to “how close are we?” is: one manual price check
away from starting the only measured-positive pilot, but still zero forward
proof away from claiming the system is profitable.

## Implementation closure — 2026-08-29

Every code-side phase in this plan is now connected to a measurable ledger:

- The free ESPN movement detector and typed-news triggers enqueue durable
  capture requests. The dispatcher collapses them into one paid multi-book
  snapshot only when credits exceed the protected reserve and the cooldown has
  expired. With one credit currently remaining, requests defer instead of
  silently exhausting the account.
- Best-price routing, line-value comparison, middle detection and per-book
  response-lag distributions are live in the execution workspace.
- Wong teaser candidates are paired only across different games at the same
  book. A ticket cannot be logged without a fresh quote and a manually verified
  reachable payout at the conservative price gate.
- Prop-market residual correlations now feed the copula SGP calculator. Offered
  candidate and closing prices can be preserved as paired evidence; sizing stays
  off until 50 paired quotes establish positive forward CLV.
- NFL props, spreads, teasers, SGPs and MLB picks all end in forward ledgers that
  distinguish paper, placed, settled, reconstructed and quarantined evidence.
- The blind AI review is visible in the NFL proof room. It reviewed 203
  historical candidates and kept zero. That result is not hidden or overridden.

What remains is external evidence, not another UI or model feature: verify one
reachable teaser payout, fund enough legitimate multi-book capture capacity to
collect the season, and let the forward ledgers settle. No software change can
truthfully manufacture the required 50, 100, 200 or 250 future observations.
