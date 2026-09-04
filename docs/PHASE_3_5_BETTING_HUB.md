# Phase 3.5 — NFL Betting Hub

Companion to `docs/HANDOFF.md`. **Read `docs/NFL_MODEL_STATUS.md` in full before
writing any code in this area.**

---

## 0. The constraint you are building inside

This project already ran the experiment. Sides and totals have **no edge against
closing lines**, established four independent ways:

| Test | Result |
|---|---|
| Margin RMSE | model **13.14** vs market **12.66** — market wins *all five seasons individually* |
| corr(model edge, ATS outcome) | **−0.005** over 1,424 games. By season: 0.007, 0.069, −0.011, −0.005, −0.096 |
| 15-specialist meta-model, out-of-sample R² | **−0.0167** vs shuffled-null **−0.0171** — identical to random |
| Realised P&L, 798 bets, 5 seasons | 398-386-14, **50.8%, −24.2 units** |

**Read this table as a correctly detected efficient market, not a disappointing failure to find
edge.** Sauer (1998, *Journal of Economic Literature*), Vandenbruaene et al. (2022, *Journal of
Sports Economics*) and Winkelmann et al. (2024, *Journal of Sports Economics*) all document
point-spread closing lines as close to informationally efficient and hard to beat with public
information — this project's own, independently re-verified 0-of-21 result matches that published
literature exactly.

After the governance branch (per-prediction weight refit, residual-skill
weighting, abstention gate) the model correctly bets *far* less — 203 bets
instead of 798 — and the remaining bets **still lose: 47.0%, −19.7 units**.

> Better engineering reduces volume. It does not manufacture edge.

Three rescues were tested and rejected:
- **Selectivity is backwards** — the top-3 picks per week went 45.1%, *worse*
  than the full slate's 51.0%.
- **Confidence buckets show no trend.**
- **Parlays break even at ~52.5%/leg regardless of leg count** — pure leverage.
  At 50% a 3-leg loses 12.5% vs 4.5% for singles; at 54% it gains 10.2% vs 3.1%.
  Revisit only *after* an edge exists.

### What this means for how you work
If you are asked to make this profitable, the honest answer is that the evidence
says you cannot on sides/totals, and **a model that starts looking profitable
after more tuning is overfitting, not improving.** Do not ship a number you
cannot defend out-of-sample. Say so plainly in the UI and in the report.

### Method rule (non-negotiable)
Never judge a change by backtested win rate. Use **out-of-sample R² against the
market residual, plus a permutation-null comparison**. The repo's old
`maxDisagreement = 4.5` filter was "holdout validated" and is still noise.

---

## 1. What is actually worth building

Ranked by expected value, highest first.

### 1.1 Closing Line Value as the primary scoreboard
CLV is the only fast, unbiased feedback signal in betting. Win/loss is ~50%
noise for hundreds of bets; CLV converges in dozens.

`services/nfl-clv.js` **already exists on main** and already handles the subtle
part correctly: a spread taken at +3 that closes at +1.5 is a *different bet*,
so line value must be priced against a distribution (σ ≈ 12.66 spreads / 13.08
totals), not by comparing prices. Existing tests assert this.

Build on top of it:
- Per-bet ledger with the number taken, the closing number, and CLV in
  points *and* in expected-value terms
- Running CLV distribution, not just a mean
- **Refuse to report a verdict below a minimum sample** (already implemented —
  keep it)
- Segment CLV by market, day-of-week, time-to-kickoff, and book

**Acceptance:** positive median CLV over ≥200 bets is the *only* evidence that
would justify claiming an edge exists. Nothing else counts.

### 1.2 Sharp-money / line-origination tracking
`services/nfl-sharp.js` **already exists on main**. Known detail worth
preserving: **Pinnacle lives in the `eu` odds region, not `us`.** Querying
`us,eu` surfaced 19 stale recreational numbers across 272 games.

Concepts to build out:
- **Line origination** — which book moved first, and did others follow
- **Steam detection** — synchronised movement across books in a short window
- **Reverse line movement** — line moves *against* public ticket %; the classic
  sharp indicator
- **Stale-line detection** — a recreational book lagging the sharp consensus.
  This is the one genuinely exploitable mechanism here, and it is a *speed and
  access* edge, not a modelling edge. Be honest about that.
- **Consensus fair line** — de-vigged Pinnacle as the reference price
  (`de-vigging removes the margin` is already tested)

Every divergence must be falsifiable against the CLV ledger. A "sharp signal"
that does not produce positive CLV is not a signal.

### 1.3 Player props — the one genuinely open lead
`services/nfl-props.js` exists. 52,231 player-weeks of results (2016-25). Live
props return 200 on the current tier; only historical lines are missing and can
be recorded free going forward.

**The blocker is calibration, not signal:**
- Passing yards **MAE 70.4** on a ~240 mean
- TD model **over-predicts by 10-13 points** mid-range

Both errors are **monotonic**, which is precisely the shape walk-forward
recalibration fixes (isotonic regression or Platt scaling on a rolling window).

Sequence:
1. Record live prop lines from week 1 forward — build the historical set you lack
2. Walk-forward recalibrate projections against realised outcomes
3. Validate out-of-sample vs permutation null
4. **Only then** surface anything as a recommendation

Why props are more promising than sides: prop markets are lower-limit, less
efficient, more numerous, and priced by a model rather than by sharp money. That
is a structural reason to expect inefficiency — unlike sides, where you are
betting against the most efficient market in sports.

**Do not surface a prop as a recommendation until it clears the bar.** Show
calibration and uncertainty, never a bare number.

### 1.4 Staking
Flat, **1 unit = 1% of bankroll**. Kelly only beats flat above ~55% win rate,
which has not been demonstrated here. `services/staking.js` already enforces
"safe stake sizing stays at zero until every evidence gate passes" — keep that.

---

## 2. Higher-order concepts

### 2.1 Market microstructure as the model
Stop modelling *games* and start modelling *the market*. The market is the
best available forecast; your edge, if any, lives in the gaps between books and
in the time dimension.

- **Fair value** = de-vigged sharp consensus
- **Edge** = your price vs fair value, not your opinion vs the line
- **Timing** = when in the week is a given market softest
- Model the *distribution of closing lines* given an opening line, and bet when
  the current number is in the tail

### 2.2 Correlated parlays / same-game
Only after an edge exists. But when it does, correlation is where the value is:
`services/correlation.js` already computes QB-WR correlations for fantasy — the
same structure prices same-game parlays, and books frequently misprice
correlation.

### 2.3 Bankroll simulation and risk of ruin
Given a measured (or assumed) edge and variance, simulate:
- Distribution of bankroll paths over a season
- Risk of ruin at various stake sizes
- Drawdown distribution — the number that actually makes people quit

This is honest expectation-setting and belongs in the UI.

### 2.4 The shadow ledger
`shadow_decisions` and `services/shadow-ledger.js` exist. Every model that is
*not* live should still record what it would have bet, so a candidate accrues a
real out-of-sample track record before risking money. Make this a first-class
promotion gate: **no model goes live without N shadow bets with positive CLV.**

---

## 3. UI — a betting hub that tells the truth

Light/minimal, consistent with the rest of the app. The hardest design problem
here is **making "no edge" a legible, non-embarrassing state** rather than an
empty page that looks broken.

### 3.1 Surfaces

**1. Ledger (the home screen of this hub)**
- Every bet: number taken, closing number, CLV, result, running P&L
- CLV distribution histogram with median called out
- Explicit "insufficient sample" state below the threshold — with *how many more
  bets* are needed, so it reads as a countdown rather than a failure
- Segmentable by market / book / timing

**2. Divergence Board**
- Live grid: your fair line vs each book's number, sorted by gap
- Flags: steam, reverse line movement, stale
- Each row links to the evidence: snapshots over time, which book moved first
- **Every flag shows its own historical CLV** — a signal type that has never
  produced positive CLV is displayed greyed, with its record, not hidden

**3. Line Movement Explorer**
- Time-series per game: every book's number over time, sharp books highlighted
- Overlay ticket% vs money% where available (RLM visualisation)
- Mark your entry point on the chart

**4. Prop Lab**
- Per-market calibration: reliability diagram, predicted vs realised
- Current MAE/bias vs target, prominently
- A clear gate indicator: **"NOT BETTABLE — calibration in progress"** until it
  passes. This is the single most important honest-UI element in the hub.
- Once passing: prop board with edge, calibrated probability, and interval

**5. Model Honesty Panel**
- The four disproofs from §0, rendered as charts, permanently visible
- The shadow ledger for candidate models
- "What would change our mind" — the explicit criteria (≥200 bets, positive
  median CLV) that would justify going live

### 3.2 Design rules specific to this hub
- **Never show a recommendation without its calibration state.**
- Distinguish *model output* from *market observation* from *LLM commentary*
  visually and permanently.
- Any "edge" number is accompanied by the sample size behind it.
- Losing periods are shown, not hidden. A P&L chart that only starts at the good
  part is a lie.
- No red/green as the only channel — use shape and label too.

---

## 4. Testing expectations

The existing betting tests are unusually good and set the bar. They already
assert things like:
- "closing line value prices the number taken, not the number the market closed on"
- "betting the closing number at standard juice costs exactly the vig"
- "totals value is symmetric: the over wants a lower number and the under a higher one"
- "the close is the last capture before kickoff, never one taken after it"
- "a bet without a real price is rejected rather than logged unpriceable"
- "CLV refuses to report a verdict on too few bets"
- "market movement requires preserved multi-timepoint quotes and does not invent a close"

Match that standard. In particular, **test the honest-failure paths**: that an
uncalibrated prop cannot be surfaced as a pick, that a model without shadow CLV
cannot be promoted, that stake sizing stays at zero until gates pass.

---

## 5. Sequence

1. CLV ledger UI on the existing `nfl-clv.js` — the scoreboard first.
2. Divergence board on the existing `nfl-sharp.js`, with per-flag CLV history.
3. Start recording live prop lines immediately (the historical set only accrues
   forward — every week you wait is a week lost).
4. Prop walk-forward recalibration + reliability diagrams.
5. Permutation-null validation. If it passes, prop board goes live behind the
   gate. **If it fails, ship the honest "not bettable" state** and say so.
6. Model Honesty Panel.
7. Bankroll/risk simulation.
8. Correlated parlays — only if 4-5 produced a real, CLV-confirmed edge.

`ODDS_API_KEY` must be set in `.env` for live odds; it is currently unset.
Budget: 500 requests/month on the free tier — the existing daemon takes 2 of 3
daily credits with 60 held in reserve. Respect that.
