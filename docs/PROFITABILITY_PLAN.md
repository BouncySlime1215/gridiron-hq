# NFL Profitability Plan

**Version 1.0 · 2026-08-27**

This is the execution plan that follows from the completed model diagnostic.
It is not a promise of profit. Its purpose is to make a profitable result
possible to demonstrate without manufacturing one through hindsight,
multiple-testing, duplicated bets, or optimistic staking.

The governing distinction is:

1. **Prediction edge** — estimate an outcome more accurately than the market.
2. **Execution edge** — obtain a better number or price than the market
   consensus without needing to predict the game better.

Gridiron HQ has not demonstrated the first on NFL sides or totals. It has
demonstrated the second historically through line shopping and price-sensitive
Wong teasers. Player props remain open because real prices only started being
captured on 2026-08-27.

---

## 1. Current evidence

### What is green

- The shared player-week engine beats each player's walk-forward season-to-date
  baseline on passing yards, rushing yards, receiving yards, and receptions.
- Fantasy and props read the same constrained event state.
- Twenty-four player-history heads and 416 signal paths can run in shadow;
  none receives production authority merely for existing.
- Anytime-TD calibration is walk-forward and gradeable.
- Line shopping has a measured execution value: best available prices differ
  materially from median prices and NFL key numbers make some half-points much
  more valuable than others.
- Historical six-point Wong teaser legs crossing both 3 and 7 won 74.69% over
  1,391 legs. That is +6.50% expected value at -110 and negative at -130. The
  price, not a new prediction, is the edge.
- Prop capture now stores book-specific quotes, model and no-vig probability,
  kickoff, NFL week, closing quote, settlement, and one deduplicated shadow
  decision per event/player/market.

### What is not green

- Zero of 21 spread models beat 15,096 closing lines through the required gate.
- No NFL prop has settled in the new forward ledger yet. Prop profitability is
  unmeasured, not proven positive or negative.
- Only 406 of the first 529 fresh prop quotes matched a model distribution
  (76.7%). Identity/eligibility coverage must exceed 95% before missing players
  can be treated as harmless.
- Passing yards remains the weakest point market. Of attributable squared
  error, 56.4% comes from pass volume and 43.6% from efficiency.
- Reachable teaser prices have not been archived. A historical strategy priced
  at an unavailable -110 does not create a real bet.

### The blind-audit correction

The 2022–2025 seasons have been opened repeatedly for diagnostics, candidate
rejection, calibration, and ablation. A replay can still be chronological and
cutoff-safe, but those seasons are no longer untouched holdouts. They must not
be used to claim a newly discovered profit edge.

The true blind audit is the pre-registered 2026 forward ledger. Historical
replays remain useful for rejecting bad ideas and finding failure modes; they
are not promotion evidence for a strategy selected after viewing them.

---

## 2. Definition of success

No model, market, or staking rule is allowed to say “profitable” until all
applicable gates pass.

### Forecast gates

- Cutoff-safe predictions captured before the first actionable quote.
- Better than a named trivial baseline on identical observations.
- Improvement survives a week-clustered bootstrap confidence interval.
- Rank accuracy does not decline.
- Probability calibration improves or remains within tolerance.
- The change improves the complete shipped pipeline, not only an isolated
  submodel.
- Every tested sibling is included in multiplicity correction.

### Market-edge gates

- Real book, line, price, and capture timestamp exist.
- Both sides are recorded when available and vig is removed.
- One decision per event/player/market; repeated books and hourly snapshots do
  not inflate the sample.
- At least **200 settled independent shadow decisions overall** before reading
  aggregate CLV.
- At least **75 settled decisions in a market** before making a market-specific
  claim. A market under 75 remains “accumulating” even if pooled results win.
- Mean and median CLV are positive, with the 90% week-clustered interval on
  mean CLV excluding zero.
- Calibration error is at most 0.03 and calibration slope is between 0.85 and
  1.15 on forward observations.
- Positive CLV is present in more than one time window; one hot month cannot
  promote a model.
- Realized ROI is reported, but CLV and calibration decide promotion because
  short-run wins are much noisier.

### Real-money gates

- The market-edge gates pass on frozen forward decisions.
- The policy was unchanged for the promoted sample.
- Best available price was actually reachable at an approved book.
- Open correlated exposure is capped.
- A rollback version is stored before activation.
- The first activation is a limited pilot, never full Kelly.

---

## 3. Workstream A — make the forward ledger complete

This is the highest-value work because every profitability claim depends on it.

### A1. Raise model-to-quote matching above 95%

For every unmatched quote, assign exactly one reason:

- player identity mismatch;
- suffix/punctuation mismatch;
- rookie missing from current projection population;
- backup or role gate intentionally abstained;
- unsupported market;
- stale roster/team assignment;
- genuine feed error.

Add a weekly reconciliation report with counts and examples. Never solve
coverage by silently loosening eligibility after seeing outcomes.

**Gate:** at least 95% of supported-market quotes either match a model or carry
an explicit, correct abstention reason.

### A2. Preserve the two useful market horizons

- T-24h: actionable early number.
- T-1h: closing proxy after injury/inactive information is mostly absorbed.

The scheduler already enforces these windows and keeps a 50-credit reserve.
Add an alert if a due window is missed, rather than backfilling it after kickoff.

**Gate:** at least 90% capture coverage at each horizon across a full week.

### A3. Verify settlement

Automatically reconcile yardage, receptions, and anytime TD against nflverse
results. Distinguish:

- win/loss/push;
- void because the player did not participate;
- unresolved identity;
- game postponed/cancelled;
- feed not final.

**Gate:** at least 99% of final, supported props settle or receive a documented
void reason within 24 hours.

### A4. Record reachable teaser prices

The current odds feed does not establish the price for a two-team, six-point
teaser at the user's actual books. Add a small manual price-entry surface or a
verified feed if one becomes available. Save book, price, timestamp, leg rules,
and whether correlated legs are prohibited.

**Gate:** no teaser recommendation unless the real offered price is -115 or
better and the two legs are from different games.

---

## 4. Workstream B — improve passing yards at the component that is failing

Do not build another set of final-yardage recency blends. Those were tested and
rejected. Build specialists that answer distinct questions and reconcile them
into one passing distribution.

### B1. Team-play volume

Question: **How many offensive plays will this team run?**

Candidate evidence, all cutoff-safe:

- plays per drive;
- expected drives;
- no-huddle rate;
- pace proxy;
- opponent drive length only if it adds value after the betting total is
  removed or ablated;
- roof/weather as uncertainty, not an automatic directional adjustment.

### B2. Pass-rate intent

Question: **What share of those plays become called passes?**

Candidates:

- neutral pass rate;
- pass rate over expected;
- early-down pass rate;
- score-neutral shotgun/no-huddle usage;
- coaching/scheme changepoint;
- spread and total game script, already in production.

Opponent-strength-on-volume stays excluded: it previously double-counted the
market and increased MAE from 70.6 to 90.8.

### B3. Dropback-to-attempt conversion

Question: **How many called passes become official attempts?**

Candidates:

- quarterback sack rate;
- scramble rate;
- pressure rate and offensive-line continuity;
- throwaway rate if a verified cutoff-safe source is available;
- designed QB rush separation.

This layer prevents a pressure matchup from being applied twice—once as fewer
attempts and again as lower YPA—unless ablation proves both pathways help.

### B4. Quarterback participation

Question: **Which passer owns the game state, and for how much of the game?**

- confirmed starter and depth-chart state;
- injury/practice designation as typed state;
- recent starter continuity;
- explicit abstention for unresolved competitions.

Injury context does not receive a generic multiplier. The previous generic
injury adjustment degraded the shipped model. It may alter participation only
when the state itself is observable.

### B5. Passing efficiency

Question: **How many yards result per attempt?**

- opportunity-weighted YPA prior;
- clean-pocket and pressured efficiency as separate states;
- air-yards and completion-over-expected features when source coverage is
  verified;
- receiver-route participation and offensive-line continuity;
- weather/wind as a candidate on efficiency, not broad volume.

### B6. Reconciliation and promotion

Every component outputs a distribution, not a point guess. Team plays constrain
pass plus rush; dropbacks constrain attempts plus sacks plus scrambles; QB
attempts constrain completions and passing yards. Incoherent combinations are
rejected before scoring.

Each family runs through:

1. chronological discovery;
2. redundancy pruning;
3. paired significance test;
4. Holm correction across the family;
5. independent validation;
6. full-pipeline ablation;
7. 2026 forward monitoring.

**Gate:** passing-yards MAE improves significantly over the active engine,
rank accuracy does not decline, distribution coverage remains calibrated, and
the improvement repeats in the forward ledger. If no family passes, keep the
current model.

---

## 5. Workstream C — calibration and edge selection

Academic betting-model evidence favors calibration over raw classification
accuracy for selecting wagering systems. That matches this architecture:
profit depends on whether a quoted 58% event really occurs about 58% of the
time, not whether the model chose the winning side more often than 50%.

### C1. Calibrate each market separately

Maintain separate walk-forward calibrators for:

- passing yards;
- rushing yards;
- receiving yards;
- receptions;
- anytime TD.

No pooled calibrator may hide a weak market behind a strong TD market. Use
simple monotone or logistic candidates first; complexity must beat the simple
head out of sample.

### C2. Learn an abstention policy, not a pick factory

Shadow-score edge bands, model uncertainty, source freshness, and model-market
disagreement. The output is one of:

- bet candidate;
- monitor only;
- abstain because price is too efficient;
- abstain because evidence is stale/missing;
- abstain because model uncertainty exceeds the estimated edge.

The policy may become more selective. It may never lower a threshold merely
because the latest backtest lost.

### C3. Market-residual model

Only after enough real quotes exist, train a small residual model on:

`actual outcome - market-implied expectation`.

The structural player model remains the foundation. The residual head asks
where the market is systematically wrong; it does not relearn football from
scratch. Candidate features must be available at the recorded quote timestamp.

**Gate:** positive forward CLV after calibration and abstention, not merely a
lower historical MAE.

---

## 6. Workstream D — execution edges

This is the shorter path to profit because it does not require beating the
closing market's prediction.

### D1. Line shopping

- Compare number first, price second.
- Price moves through NFL 3 and 7 using the empirical margin distribution.
- Alert on middles where books straddle 3 or 7.
- Record which books are actually reachable.

**Gate:** the selected quote must be better than the median contemporaneous
quote after accounting for both line and price.

### D2. Wong teasers

- Six-point legs only for favorite -7.5/-8.5 or underdog +1.5/+2.5.
- Both 3 and 7 must be crossed.
- Different games only.
- Real two-team price no worse than -115.
- No recommendation if the price field is missing.

### D3. Research-only extensions

Pre-register before testing:

- 6.5-point and 7-point teaser schedules;
- home underdogs;
- divisional unders;
- book-to-book middles around 3 and 7.

These are separate experiment families. Test count and rejected variants stay
visible. None can borrow the existing Wong result as proof.

---

## 7. Workstream E — progressive learning without drift or hallucination

### Numeric learning

- Champion/challenger only.
- Immutable pregame snapshots.
- Fit on settled prior observations.
- Minimum 250 forward snapshots before automated review.
- Newest-window MAE must improve without damaging rank or calibration.
- Changepoints require sustained usage plus snap-share corroboration.
- Missing evidence lowers confidence; it never becomes a zero-valued feature.

### AI/LLM role

Use the LLM only to convert news into typed claims:

- player identity;
- injury/body part;
- practice status;
- starter/backup language;
- expected role change;
- source and timestamp;
- confidence and supporting text span.

The LLM never emits a projection, edge, or stake. A numeric candidate derived
from its structured output must pass the same ablation gate as every other
signal. Unsupported claims are discarded before reaching the model.

---

## 8. Staking and bankroll policy

Until a market clears the forward gates:

- model-derived stake = **0 units**;
- shadow decisions continue;
- execution edges may be displayed only at a real reachable price.

After promotion:

- begin at one-eighth or quarter Kelly, whichever is smaller under the model's
  probability-uncertainty interval;
- cap one bet at 0.5% of bankroll during the pilot;
- cap one game at 1.0% across correlated props;
- cap one week at 5% open risk;
- calculate stake from the worst plausible calibrated probability, not the
  point estimate;
- never increase stake to recover losses;
- automatically return to shadow mode if forward calibration or CLV gates fail.

Full Kelly is prohibited. It is optimal only when the estimated probability is
correct, which is exactly the uncertain quantity being tested.

---

## 9. Delivery order

### Now — before Week 1

1. Ship unmatched-prop reconciliation and explicit abstention reasons.
2. Add missed-horizon and settlement alerts.
3. Add reachable teaser-price entry and archive.
4. Freeze/hash the 2026 prop decision policy.
5. Display capture coverage, model-match coverage, and credit reserve in the
   NFL hub.

### Weeks 1–4

1. Accumulate T-24h/T-1h quotes and settlements.
2. Run passing component specialists in shadow.
3. Report calibration and CLV by market and edge band.
4. Audit every unresolved/void result.
5. Make no model-based real-money bets.

### Weeks 5–10

1. Review component candidates only after chronological gates run.
2. Promote no candidate without full-pipeline ablation.
3. Evaluate line-shopping and teaser availability using reachable prices.
4. Continue shadow decisions until overall and per-market sample gates pass.

### After 200+ settled shadow decisions

1. Run the frozen forward audit with week-clustered uncertainty.
2. Promote only markets with positive CLV and acceptable calibration.
3. Start a capped real-money pilot at no more than 0.5% bankroll per play.
4. Keep non-passing markets independent; a TD win cannot authorize passing
   yards, and pooled success cannot hide a losing market.

### After 1,000+ settled decisions

1. Treat realized ROI as interpretable rather than anecdotal.
2. Compare CLV, ROI, drawdown, and calibration by season segment.
3. Consider residual GBM or more advanced mixture-of-experts only if the
   structural and calibrated systems have plateaued.

---

## 10. Stop rules

Stop spending development time or money when any of these holds:

- A candidate fails full-pipeline ablation even if its isolated test passes.
- Forward CLV confidence interval includes zero after the minimum sample.
- Model-match coverage remains below 95% and missingness is not random.
- A supposed edge exists only at a book/price the user cannot access.
- Profit disappears when repeated quotes are deduplicated.
- A strategy works only after changing thresholds against the same opened
  sample.
- Calibration worsens while win rate rises; this is likely variance, not skill.
- API cost exceeds the expected information value of another snapshot.

The objective is not to force Gridiron HQ to make five bets every week. The
objective is to identify the small set of decisions whose evidence survives
the market, uncertainty, and execution costs—and to abstain everywhere else.

---

## Research basis

- Hubáček, Šourek and Železný, *Machine learning for sports betting: should
  model selection be based on accuracy or calibration?*
  <https://arxiv.org/abs/2303.06021>
- The Odds API v4 documentation, including live event/market behavior,
  historical availability, and request accounting:
  <https://the-odds-api.com/liveapi/guides/v4/>

These references support the emphasis on calibrated probabilities and exact
timestamped market evidence. They do not establish that this model has an edge;
only the forward gates above can do that.
