# META-01 "the Referee": one learner that weighs every source by past accuracy, argument and confidence; warm-started on history, live from day one
Coordinator's design memo, 2026-09-23 ~6:55 PM ET (Nick, Fable max: "shouldn't ML or Jev or AI reason through what each piece says, based off past accuracy but also the argument it's making, confidence in its pick; multiple testing models so one technique doesn't lock something out; tested on historicals then go live immediately; one unified system, one machine that pulls from several areas; anchor towards beating ESPN's projections").
Status: memo, to be stress-tested by the META-01 design workflow (3 independent designs + a historical probe + judges + 3 adversarial critics + revision). The revised design supersedes this memo.

## 1. What it is
For every question the engine answers (a player's points this week, P(plays Sunday), rest-of-season value, P(a manager accepts an offer)), several EXPERTS each give an answer as a distribution plus a reason chain. The Referee combines them into ONE served number:
- **Weights per expert per context**, learned walk-forward on 2021-24 and updated every week from graded outcomes (online learning with expert advice: exponential weights / Hedge), shrunk toward equal weights (the forecast-combination puzzle: estimated weights lose to equal weights when data is small).
- **A gate** that reads the context (position, week, blind-spot flags from the Mistake Map, freshness, news present, disagreement between experts) and each expert's CALIBRATED confidence, and moves the weights.
- **An argument reader** (Claude via the existing claude.js path; Jev for probabilities) that reads the experts' reason chains and the news text and emits: contradiction flags (stale input, missed injury, role change), "which expert to trust here and why", and its own estimate. All three are gate features, graded like any other expert. AI proposes, data decides.
- **Several combiners run side by side** (equal-weight, Hedge, stacking regression with shrinkage, Bayesian model averaging, an LLM-judge blend) with a meta-weight over combiners, so no single technique locks a source out. Champion-challenger: the served number is the champion; challengers run in shadow and are promoted on the rolling decision score.
- **Output = a calibrated distribution** (split conformal on the blend), with a reason chain that is the attribution: how much each expert and each gate feature moved the number.

## 2. Experts for player points (the ESPN-beating question)
ESPN's weekly projection (base, strongest single source), FantasyPros consensus (INTERNAL ONLY, never displayed or committed; Nick's ruling), Vegas-implied team total and game script (the one layer that helped BLEND-01), market price (FantasyCalc) as the rest-of-season anchor, our chain links (PROJ-02 exposes plays/pass rate/share/volume), the Mistake Map's proven blind-spot corrections (qb_change, blowout_underdog_rb), the availability model (ESPN-zero, injuries, spells), season-to-date and last-3-weeks, the LLM news reader (RL-6-2: an 8-cent web read caught injuries ESPN missed), and Jev.
Only experts with DIFFERENT information add value (Clemen 1989 review; Bates and Granger 1969). So the priority is markets, consensus and news text over more of our own models. Prior results to respect: BLEND-01 (#164) found ESPN's number beat ours; HX-01 (#165) found FantasyPros consensus beat our start/sit picks 2022-24; AI-01 found expected-points "true value" no better than season-to-date; three projection upgrades were declined today.

## 3. Learning rule (per question type)
- Initialize w[e, c] from walk-forward 2021-24 held-out losses, per context c with hierarchical shrinkage toward the global weight, then shrink toward 1/E.
- Weekly update: w <- w * exp(-eta * loss_e), loss = CRPS for points, log loss for probabilities; eta tuned on 2021-24. Regret guarantee: the blend does about as well as the best expert in hindsight, and better when experts carry different information.
- Confidence: each expert's spread or stated probability goes through a reliability map fit walk-forward; the calibrated confidence is what the gate sees. A miscalibrated expert is rescaled, not discarded.
- Cold-start experts (LLM reader, Jev, any new hypothesis) start at weight ~0 with a prior, are graded in shadow every week, and earn weight automatically. So numeric experts go live with historical weights (no waiting), and new experts earn in during the season.

## 4. Multiple testing models: nothing is locked out, only down-weighted
Every hypothesis or expert carries three verdicts at once:
1. strict held-out gate (may it be a HEADLINE number or a shown claim?),
2. Bayesian shrinkage estimate (how much weight does it get in the blend now?),
3. online shadow arm (is it earning on 2026 outcomes?).
Nothing is deleted; weights go to ~0 for useless experts. The dead-ends list still stops re-scouting the same claim. The strict gate governs what is SHOWN; the blend governs what CONTRIBUTES, and the blend itself must beat the incumbent to be served.

## 5. Serving, promotion, fallback
- Served number = champion blend. Challengers (other combiners, new experts) run in shadow on the same as-of inputs.
- Promote a challenger when it beats the champion on the rolling 4-week decision score (start/sit win rate vs "start ESPN's higher number"; CRPS and 80% coverage; log loss for P(accept)) AND on the historical backtest.
- Drift fallback: if the champion's live score falls below ESPN's for 3 consecutive weeks, ESPN becomes the served number and the status line says so (HEALTH-01).

## 6. Ship bar, pre-registered
Walk-forward on 2021-24: beat "start ESPN's higher number" on start/sit decisions in 2023 AND 2024 (win rate and points per decision, week-cluster CI), CRPS better than ESPN's point plus pooled sd, 80% coverage 77-83%. Then one ledgered 2025 confirmation. Ship at 2026 week 4/5 with the historical weights, behind a flag, then weekly online updates. Grade every served number (IDEA-001 serve-log).

## 7. Data available now for the warm start
ESPN weekly projections 2021-25 (local), FantasyPros consensus (local DB, internal), Vegas lines 2021-26, FantasyCalc (daily from now; Wayback 2023-24), nflverse actuals + pbp + participation 2021-25 (#218), weather, ESPN transactions/lineups/offers 2026, Sleeper 2021-24 (manager side).

## 8. Honest expectations
Combining forecasts typically cuts error 5-20% when sources hold different information; ESPN and consensus are already combinations, so expect a few percent MAE gain and a few points of start/sit decision accuracy on the points question. Bigger gains are likelier on availability (surprise inactives, news timing) and on P(accept), where our experts hold information the market lacks. If the Referee cannot beat ESPN on the 2023-24 backtest, ESPN stays the number and the Referee supplies ranges and flags: that is a result, not a failure.

## 9. Units (draft)
- META-01a: warm-start backtest and Hedge blend on 2021-24 (study; the probe in the workflow is its first pass).
- META-01b: the Referee service on the spine (producer 'referee', per question type, reason chain = attribution, conformal output).
- META-01c: the argument reader (claude.js / Jev) as a graded expert; routed to where text carries information (availability, role changes, motives).
- META-01d: multi-combiner + champion-challenger + drift fallback (with HEALTH-01).
- META-01e: the manager-side instantiation (P(accept): activity, clone price, tells, Jev, pitch reading).
