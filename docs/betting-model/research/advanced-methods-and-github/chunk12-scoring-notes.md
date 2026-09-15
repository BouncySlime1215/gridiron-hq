# Chunk 12/21 Scoring Notes (N09-C2..C5, N10-C1..C6, N11-C1..C5)

Cross-checked against notes files (N09-generative-synthetic-augmentation.md,
N10-mixture-density-neural-forecasting.md, N11-automl-genetic-programming.md).

Key groundings that changed scores from the raw candidate text:
1. N09's own literature review explicitly argues AGAINST deep generative models at
   Gridiron's sample sizes and FOR exactly the simple bootstrap/comp-based (C2) and
   hierarchical/negative-binomial (C5) approaches these two candidates propose --
   this is self-consistent, evidence-grounded, raises confidence in both.
2. N10's repo-grounding section reveals nfl-preseason-blend.js ALREADY implements a
   principled normal-normal Bayesian blend as of 2026-09-10, per the notes file's
   own admission ("partially stale" FOUND bullet). This weakens N10-C6 (DeepAR over
   play-by-play for team strength) further: the "hand-tuned blend" problem it's
   framed against is largely already fixed; what's left (sequential/game-by-game
   modeling) is a 32-teams x 17-weeks panel, badly underpowered for an LSTM.
3. N11's repo-grounding confirms TPOT already runs in research/tree_lab.py with
   real leakage/effective-observations gates -- gplearn/PySR is a genuinely new,
   complementary tool, and the existing safety infrastructure (leakage.py,
   model_discipline.py) substantially de-risks the GP candidates' cost.
4. N09-C5 and N10-C4 target the same defect (props point-estimates, no
   distribution) from two different files/layers (calibration-head output vs.
   simulator-input volume params). Scored as complementary rather than pure
   duplicates, but flagged: don't fund both as parallel full builds -- build C5
   first (plugs into the already-scaffolded nfl-prop-player-heads.js challenger
   framework with an existing forward-CLV gate), then decide if C4's volume-layer
   recast is still needed.

Final verdicts:
- BUILD: N09-C2 (cold-start heads), N09-C5 (calibrated prop distributions),
  N10-C2 (standardized distribution contract), N10-C3 (split-conformal wrapper --
  best candidate in the batch: hours, distribution-free, fixes the single most-
  repeated FOUND defect using only existing data).
- TEST-FIRST: N09-C4 (cheap applicability checklist), N10-C1 (MDN head, minor
  neural shadow model), N10-C4 (prop volume NB/MDN, redundant-ish with C5),
  N11-C1 (GP features for game-level markets, low-N caveat self-admitted),
  N11-C2 (GP-searched ensemble blend, cheap and self-falsifying despite weak
  evidence), N11-C4 (GP features for fantasy, larger N, aligns with Nick's
  standing fantasy>betting priority).
- LATER: N09-C3 (TSTR governance gate -- build after there's more than one
  synthetic-data consumer to gate).
- REJECT: N10-C5 (normalizing flow for same-game correlation -- weeks of exotic
  architecture for a game-count regime far too small to fit a flow; a Gaussian
  copula or empirical joint would get 90% of the value at 5% of the cost),
  N10-C6 (DeepAR over play-by-play for team strength -- 32-series x 17-step panel
  is badly underpowered for deep sequence modeling, and the blend it targets is
  largely already fixed per N10's own repo-grounding), N11-C3 (GP patch for
  team-strength blend -- explicitly self-described as a stopgap when the real fix,
  a state-space rewrite, is already known and preferred), N11-C5 (GP over raw
  play-by-play for aggregate features -- weeks of speculative effort, weakest
  evidence in the GP set, no urgent defect attached).
