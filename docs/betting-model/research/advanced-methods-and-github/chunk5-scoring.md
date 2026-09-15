# Chunk 5/21 — Scoring notes (F10 copula/correlation, F11 conformal calibration, F12 cold-start/transfer)

Grounded by reading the three cited notes files in full (F10-copula-correlation.md,
F11-conformal-calibration.md, F12-cold-start-transfer.md) — no additional repo verification
performed this pass (fantasy-football-dashboard is read-only and these researchers already did
the grep/read work; their line citations are internally consistent and cross-referenced against
each other, e.g. F10 notes correctly identify that the FOUND bullet's literal wording about
"teaser legs sharing a game" is factually false for teaser-leg-rates.js's actual construction —
a sign of real code verification, not just literature summary).

Skeptical-statistician lens: evidence 5 = replicated peer-reviewed OOS vs a real market/baseline
benchmark; 3 = single paper; 2 = practitioner/repo README; 1 = theory/hype. None of the 15
candidates in this chunk have a replicated peer-reviewed NFL-specific OOS-vs-market result —
the strongest ones (conformal prediction, F11) rest on mathematical coverage guarantees (proven
theorems, not just single-study empirical claims) applied to non-NFL benchmark data, which I
score above "single paper" (evidence 4) but below "replicated on the actual target domain"
(evidence 5, reserved for none of these).

## F10 — copula/correlation

**F10/F2** (t-copula/Clayton option for sgpAnalysis): Aas et al. 2009 is a real peer-reviewed
result (29x tail-dependence understatement) but on financial data, not sports, and the
candidate's own design correctly refuses to default to it (K(z) goodness-of-fit gate first).
Real gap (stats-util.js only has Gaussian), cheap-ish addition, genuine uncertainty whether NFL
prop pairs show enough tail asymmetry to matter. TEST-FIRST.

**F10/F3** (consolidate teaser-leg independence assumption onto shared copula utility): the
researcher's own audit already shows true cross-game correlation is ~0 after a composition
correction (CI includes zero) — so direct EV here is explicitly small. What's real is a genuine
architectural inconsistency (two files answer "how do two probabilities combine" two different,
disconnected ways) with essentially no downside — hours-scale, additive, doesn't touch the
existing rho decision. BUILD.

**F10/N1** (vine-copula fit on play-by-play drive-level co-occurrence): genuinely new capability,
methodologically sound extension of Aas et al., but untested whether finer-grained PBP fitting
beats the existing weekly box-score-residual fit — explicitly could go either way per the
researcher. Days-scale new sidecar infra for an unproven data-granularity bet. LATER.

**F10/N2** (pyvinecopulib for 3+ leg SGP tickets): confirmed by the researcher's own GitHub
search that zero sports-betting codebases use vine copulas for parlays (even 0-1-star hobby
repos stop at Gaussian) — that's real negative evidence about maturity/payoff, not just absence
of prior art. Weeks-scale new Python sidecar service, must beat existing Gaussian net of added
complexity before adoption. LATER.

**F10/N3** (game-script-conditional copula parameter, GJRM-style): the one sports-specific
paper read (van der Wurp et al. 2019, World Cup goals) found context-conditioned copulas often
did NOT beat simpler equal-coefficient models for a comparable low-scoring team-sport dependence
problem — the researcher flags this candidate's evidence as explicitly "contested." Days-scale
work chasing a plausible null result that prior literature already partially previewed. REJECT.

## F11 — conformal calibration

All six are grounded in a real, precisely grepped defect
(`nfl-market.js`'s `normalCdf(r.predMargin/r.marginStd)` — one pooled global SD for every game)
and cite foundational, peer-reviewed, theorem-backed methods (Angelopoulos & Bates 2021/22;
Romano/Patterson/Candès 2019 NeurIPS; Barber/Candès/Ramdas/Tibshirani 2023 Annals of Statistics)
with concrete published numbers replicated across multiple datasets within each paper (CQR:
32% narrower at matched 90% coverage across 11 UCI datasets; NexCP: restores 90% coverage on
real non-exchangeable ELEC2 data). None of this is NFL-specific yet, but the guarantees are
mathematical (finite-sample, distribution-free), not single-study empirical claims, so I grade
evidence a notch above "single paper."

**F11-1** (split-conformal quantile replaces Gaussian in scoreAccuracy): exact line identified,
~15-line helper, turns an unverifiable assumption into a testable, proven-coverage number.
Hours-scale, no new risk (additive next to the existing normalCdf call until validated). BUILD.

**F11-2** (CQR for covariate-adaptive margin/total width): real gap (today's marginStd is
identical for a pick'em and a 17-point blowout); mechanism is a small linear pinball-loss fit,
explicitly scoped away from heavy ML by the researcher's own do-not-do list. Days-scale, feeds
directly into Nick's staking/abstention governance gate. BUILD.

**F11-3** (NexCP-weight the existing bootstrapProb resampler): the sharpest fix in this set —
bootstrapProb() already resamples real residuals (good instinct) but uniformly, while the same
file's fitModel() already fits a carryover/decay parameter because team strength drifts; this
candidate just makes the resampler consistent with an assumption the file already makes
elsewhere. Hours-scale, surgical, essentially no downside. BUILD.

**F11-4** (NexCP as standing calibration layer for the walk-forward eval loop): natural
extension of F11-3 to the season-loop level; well-cited, but days-scale and its value is
contingent on F11-1/F11-3 existing first. BUILD (sequence after F11-3).

**F11-5** (Mondrian/group-conditional conformal on player props): targets the codebase's one
area of genuine measured skill (2+ TD Brier skill +27%) and gives it calibrated intervals for
the first time — high-value target, but per-group (position x prop-type) coverage for the
smaller groups is a real open question the researcher's own exit criteria flags. BUILD, with
the group-size caveat already baked into the exit test.

**F11-6** (shared conformal-calibration.js primitives module): lowest risk item in the whole
chunk — <100 lines total, three pure functions, own exit test is literally "reproduce the
published paper numbers as regression tests before any production module calls it." Directly
also mitigates the separately-flagged "five disagreeing CLV implementations" failure pattern.
BUILD, and should land before F11-1/2/3/4/5 migrate onto it.

## F12 — cold-start / transfer learning (fantasy weekly-learning loop)

**F12/F1** (cross-season fallback in priorScores()): exact code chain traced end-to-end
(player-week-engine.js -> weekly-ensemble.js -> weekly-learning.js), reuses a season-decay
weight (SEASON_WEIGHT) Gridiron has already validated and shipped elsewhere in the same
codebase (projections.js), and the underlying statistical claim (shrink hard toward a
same-entity prior when current-period n=0) has the strongest, most replicated precedent in this
whole chunk — Brown 2008's empirical-Bayes-vs-naive comparison plus the classic Efron-Morris
James-Stein baseball demonstration (>3x error reduction). Hours-scale. BUILD.

**F12/F2** (always capture a cold-start snapshot instead of silently skipping): the fix pattern
this candidate wants already exists verbatim elsewhere in the repo
(player-head-registry.js:55's candidatePlayerHeads() already falls back to structural when
prior is empty) — it just isn't wired into the path that actually populates
weekly_prediction_snapshots. This is the precondition for retrainWeeklyWeights() and any
forward-evaluation of cold-start performance to exist at all; without it F12/F1's improvement
can never be measured going forward. Hours-scale, belt-and-suspenders to F1. BUILD.

**F12/F3** (props-informed head as a stronger cold-start prior than plain structural): sound
mechanism (FiveThirtyEight's w1=0/w2=1 external-market-prior rule for zero-history entities) but
the citation is a practitioner substack, not a peer-reviewed result, and the candidate's own exit
criteria correctly requires a 3-season backtest beating F2's simpler fallback by a pre-registered
margin before shipping. Real, but should not jump the queue ahead of F1/F2. TEST-FIRST.

**F12/N1** (Kalman/state-space latent skill filter replacing the frozen 5-weight ensemble):
methodologically the most ambitious item in the chunk — would subsume F1/F2 into a general
framework and produce calibrated interval widths as a byproduct (relevant to F11's gap too) —
but no NFL-specific citation is given for this specific architecture in the notes, it's a
weeks-scale rewrite of the ensemble's core weighting mechanism, and it depends on F1/F2 already
existing to have anything to filter over Week 1. LATER.
