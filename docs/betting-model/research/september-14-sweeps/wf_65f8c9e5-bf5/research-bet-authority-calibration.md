# Bet authority: deciding whether and how much to bet as a continuous function of evidence

## Building on prior research
I relied on these earlier reports and did not repeat their work:
- **F11**: split conformal, CQR and NexCP for drifting residuals.
- **GF03**: Shin devig; `staking.js` already has quarter Kelly and a risk-constrained Kelly slate check.
- **F07**: anytime-valid confidence sequences.
- **F17**: the margin distribution and key-number mass.
- **Memory note `gridiron-nfl-betting-model`**: `stakeFor({source:'model'})` returns zero units, and the ensemble has −2.28 pts CLV. That zero-unit rule is the binary gate this report replaces.

## 1. Calibrating cover probability with about 270 games a season
- **Isotonic regression is the wrong tool at this sample size.** Niculescu-Mizil & Caruana (ICML 2005): "When the calibration set is small (less than about 200-1000 cases), Platt Scaling outperforms Isotonic Regression with all nine learning methods." https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf. One NFL season is at the bottom of that range.
- **Beta calibration** (Kull, Silva Filho & Flach, AISTATS 2017) is a 3-parameter logistic fit on ln s and ln(1−s). It includes the identity map, so it cannot make well-scaled scores worse the way Platt can when scores are too extreme. https://proceedings.mlr.press/v54/kull17a.html
- **Venn-Abers** (Vovk & Petej, UAI 2014) fits isotonic regression twice, once with the test point labelled 0 and once labelled 1. This gives a pair (p0, p1) with a calibration guarantee under IID data. The gap between p0 and p1 honestly shows small-sample uncertainty. The log-loss minimax merge is p = p1/(1−p0+p1), which I derived from the regret equation in the paper. https://arxiv.org/abs/1211.0025
- **Conformal predictive distributions** (Vovk, Shen, Manokhin & Xie, *Machine Learning* 108, 2019) turn a margin regression into a full predictive CDF with a validity guarantee. Cover probability is that CDF evaluated at the line. https://link.springer.com/article/10.1007/s10994-018-5755-8. Seasons drift, so weight by recency with NexCP (F11) rather than pooling 1999–2025 as if exchangeable.
- **Pushes and key numbers matter.** On an integer spread, Kelly has three outcomes: f = (b·p_w − p_l) / (b·(p_w + p_l)). I derived this from maximising expected log wealth. p_push has to come from a margin PMF with key-number mass (F17), not a normal CDF.
- **Calibration matters more than accuracy for betting.** Walsh & Joshi (*Machine Learning with Applications*, 2024; NBA data) found that selecting models on calibration gave much better ROI, and that Kelly only worked with a well-calibrated model. https://arxiv.org/abs/2303.06021. A 2025 corrigendum reports feature-engineering errors but says the conclusion holds, so don't quote their ROI figures. https://www.sciencedirect.com/science/article/pii/S2666827025000106

## 2. Shrinking the model toward the market based on its track record
- **Benter (1994)** is the standard professional approach. He combines log(fundamental probability) and log(public probability) in a multinomial logit, c_i ∝ exp(α·f_i + β·π_i), and fits α and β by maximum likelihood on out-of-sample fundamental estimates. Reported R²: public 0.1218, fundamental 0.1245, combined 0.1396. I got these through an annotated reproduction (https://actamachina.com/posts/annotated-benter-paper); the original is https://gwern.net/doc/statistics/decision/1994-benter.pdf, a scanned image I could not machine-read. **The weight on the model is learned from held-out performance, not assumed.**
- **Decorrelating from the bookmaker helps, but it is not enough on its own.** Hubáček, Šourek & Železný (*IJF* 35(2), 2019): with accuracy held constant, "increasing the correlation between the model and the bookmaker consistently decreased the profit." https://ida.felk.cvut.cz/papers/hubacek2019exploiting.html. Hubáček & Šír (arXiv:2010.12508) go further and argue an inferior model can still profit.
  - Gridiron already shows the failure mode: its decorrelated signal is a fade of informed line moves (78% adverse moves). Decorrelation has to be graded against CLV and outcomes.
- **Bayes vs. frequentist shrinkage.** Baker & McHale (*IJSP* 5(3), 2016) show that with a correct model and a frequentist-correct prior, the Bayes decision needs no further rescaling. Extra bet shrinkage helps when the prior or model is wrong. http://dx.doi.org/10.5539/ijsp.v5n3p80
  - For a single binary bet with log utility, expected log wealth is linear in p, so Kelly on the **posterior-mean** probability is already Bayes-optimal.
  - So the main tool is a posterior-mean cover probability shrunk toward the market. Frequentist shrinkage is a robustness layer on top.

## 3. Expected value net of vig
- EV = p·(1+b) − 1. At −110, b = 0.909 and break-even is 52.38%. With line shopping it is 51.38% (memory note).
- A fixed "minimum edge" threshold is a hidden gate. With Kelly on the posterior mean, the threshold is automatic: stake goes to zero as posterior EV goes to zero, smoothly.
- The only floors worth keeping are operational: minimum ticket size and price quality (the −115 floor already used for teasers).

## 4. Kelly with parameter uncertainty
- **Baker & McHale (2013)** (*Decision Analysis* 10(3):189–199; https://pubsonline.informs.org/doi/abs/10.1287/deca.2013.0271) shrink the Kelly bet by k. The approximation below is quoted from their 2016 follow-up (eq. 3):
  - λ = δ² / (δ² + ((b+1)/b)²·σ²)
  - δ is the Kelly fraction and σ² is the sampling variance of the estimated win probability. In words: **authority = signal² / (signal² + noise²)**.
  - In their simulation the shrinkage cost almost nothing when the prior was correct (E[U] 29.23 vs 29.17). It helped when the prior was wrong (Beta(3,3): 5.63 → 5.93).
- **MacLean, Thorp & Ziemba** (*Quantitative Finance* 10(7), 2010): Kelly maximises long-run growth but is risky in the short run. https://www.tandfonline.com/doi/abs/10.1080/14697688.2010.506108
- **Fractional-Kelly trade-off** (my quadratic approximation, not from a paper): a fraction c of Kelly keeps about c(2−c) of the maximum growth. Half Kelly keeps about 75%.
- **Uhrín, Šourek, Hubáček & Železný** (arXiv:2107.08827; *IMA J. Management Math.*, 2021) tested strategies on horse racing, basketball and soccer.
  - Plain Kelly and max-Sharpe strategies "often led to ruin."
  - Tuned fractional Kelly was best or near-best overall.
  - A drawdown constraint performed about the same as fractional Kelly.
  - Maximum bet limits were inconclusive.
- **Beggy et al. (2023)** is a Wharton student journal, so weak evidence. It found full Kelly went bankrupt in 100% of scenarios.

## 5. How professionals set bet authority (practitioner evidence, weaker)
- **CLV is a faster skill signal than win/loss.** Buchdahl, as reported by Pinnacle Odds Dropper (not peer-reviewed): the SD of CLV per bet is about 0.1, against about 1.0 for even-money P&L. Significance might come in "as few as just 50" bets, against several thousand bets on results. https://www.pinnacleoddsdropper.com/blog/closing-line-value--clv-demystified-by-expert-joseph-buchdahl
- **Consensus odds as the reference.** Kaunitz, Zhong & Kreiner (arXiv:1710.02824) treated consensus odds as truth, bet on outliers, and profited in simulation and with real money. Books then restricted their accounts. https://arxiv.org/abs/1710.02824
- **Testing by betting.** Shafer (*JRSS A* 184, 2021): report evidence as the wealth of a bet against the null. A paper-trading Kelly bankroll is a natural anytime-valid monitor. https://rss.onlinelibrary.wiley.com/doi/10.1111/rssa.12647

## 6. Toy simulation (mine)
Code: `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/bet-auth/sim.py`

Setup:
- 6 seasons × 270 games; season 1 is warm-up only.
- Signal s = model logit minus market logit, SD 0.2.
- Walk-forward MAP logistic fit of the slope c with prior N(0, τ²).
- Stake = quarter Kelly × Baker–McHale λ on the posterior-mean probability, capped at 2% per bet.
- 400 runs per row.

| True c | τ | Bets/season | Bankroll staked/season | Mean log wealth | P(drawdown > 20%) |
|---|---|---|---|---|---|
| 0 (no edge) | 0.3 | 4 | 0.3% | −0.001 | 0.00 |
| 0 (no edge) | 1.0 | 31 | 9.2% | −0.021 | 0.06 |
| 1.0 | 0.3 | 63 | — | +0.168 | 0.01 |
| 1.0 | 1.0 | 144 | — | +0.553 | 0.35 |

With no real edge, a skeptical prior shuts betting down almost completely on its own, with no gate. With a real edge, stakes grow as evidence accumulates. A loose prior earns more but carries much more drawdown risk. The simulation assumes independent games, no line movement and no correlation within a slate.

---

## (A) Key findings
1. With log utility, Kelly on a posterior-mean probability shrunk toward the market is Bayes-optimal. Extra shrinkage λ = δ²/(δ² + ((b+1)/b)²σ²) guards against a wrong prior or model (Baker & McHale 2013, 2016).
2. The weight on the model should be learned on held-out data in a logit combination with the market (Benter 1994).
3. At about 270 games a season, use Platt, beta or Venn-Abers calibration, not isotonic (Niculescu-Mizil & Caruana 2005; Kull et al. 2017; Vovk & Petej 2014).
4. Tuned fractional Kelly is the robust practical choice. Full Kelly ruins (Uhrín et al. 2021).
5. CLV carries about 10× less noise per bet than P&L (Buchdahl; practitioner source). Decorrelation from the market helps only when it is not fading informed money (Hubáček et al. 2019 plus Gridiron's −2.28 CLV).

## (B) Recommended bet-authority rule (point-in-time, pure JS, no ML libraries)
For each candidate bet at decision time t:
1. **Market probability p_m**: Shin-devigged (existing `nfl-devig.js`) from the quote actually available at t. Never use the close.
2. **Model signal** s = logit(p_model) − logit(p_m). p_model comes from a NexCP-weighted conformal margin CDF at the line (F11), with key-number PMF for pushes (F17).
3. **Authority model**: logit(p) = a + b·logit(p_m) + c·s.
   - Priors: a ~ N(0, 0.05²), b ~ N(1, 0.05²), c ~ half-normal(τ = 0.3). c must be non-negative: negative CLV should not trigger contrarian bets.
   - Fit by Laplace approximation with a Newton solver (about 40 lines of JS), refit weekly.
   - Use only games that kicked off and were graded before t, with rows read "as known at t" (F05).
   - Fix τ in the trial registry before seeing results. Deflate it for the number of specifications searched (F06; Harvey & Liu's backtest haircut).
4. **Second likelihood for c when quote tape exists**: regress (closing logit − taken logit) on s. Combine by multiplying the Gaussian approximations, but inflate the CLV variance because the close is only a proxy for the outcome.
5. **Posterior-mean probability**: p̄ = σ(m_lin / √(1 + π·v_lin/8)), where m_lin and v_lin are the posterior mean and variance of the linear predictor.
6. **Stake**: f = min(cap, κ · λ · f_Kelly3(p̄_w, p̄_push, p̄_l, b)), with κ = 0.25 and cap = 2% per bet.
   - Replace `stakeFor({source:'model'}) → 0` with this rule. When the posterior on c sits near 0, stakes shrink toward zero on their own.
   - Keep `slateRiskCheck`'s weekly correlation and drawdown limit, and add a Grossman–Zhou drawdown cushion (GF03).
7. **Decision tape**: log (t, quote, p_m, s, posterior m and v of c, λ, f, model hash). Grade CLV against a declared reference close (F04). Monitor with an anytime-valid confidence sequence on CLV plus a paper-trading Kelly wealth series (F07; Shafer 2021) as a dashboard, not a gate.

## (C) Adoptable code and repos
- **ip200/venn-abers** (MIT, 207 stars, active): port the IVAP p0/p1 isotonic trick, about 60 lines.
- **ptocca/VennABERS** (MIT, 79 stars): a fast O(n log n) cross-check.
- **betacal/python** (MIT): the beta calibration fit is a 2-feature logistic regression, trivial to port.
- **aangelopoulos/conformal-prediction** (MIT): conformal predictive CDF snippets.
- **marcopeix/conformal-ts** (BSD-3, per F11): NexCP weighted quantile.
- **Lisandro79/BeatTheBookie**: consensus-odds reference. I did not check its license; verify before borrowing anything.
- Do not copy cvxgrp/kelly_code (GPL-3.0).
- No new installs are needed: everything above is under 300 lines of JS.

## (D) Open questions and risks
- **Choice of τ** drives how many bets get placed (see the simulation). It must be pre-registered, and the simulation's independence assumptions flatter every row.
- **Historical data is close-only** (no timestamped quotes before recent seasons), so outcome-based fits estimate edge against the close. That is conservative but mismatched with bets placed Tuesday. The CLV likelihood needs the forward quote tape, which is thin today.
- **The non-negative constraint on c** throws away real contrarian information. That is intentional, but it is a judgement call.
- **Venn-Abers and conformal guarantees assume exchangeability.** NFL drift violates it, and NexCP only reduces the damage.
- **Benter's R² figures** come from a secondary annotation; the original PDF could not be machine-read. The Buchdahl CLV numbers are practitioner claims, not peer-reviewed.
- **Account limits** (Kaunitz et al.) cap how much a real edge can be scaled, whatever the rule says.