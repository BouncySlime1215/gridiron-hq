# Chunk 17/21 scoring notes

Code verification performed against the read-only clone at
/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only, no edits/tests run).

## Key code findings that reshape several scores

1. **nfl-team-strength.js is NOT the preseason/in-season blend file.** It is a
   governance-gated (`blocked`), fantasy-only offseason feature contract whose
   own docstring says "the honest expected value of this whole exercise is
   zero" and explicitly forbids market-derived columns. It contains no
   in-season blending logic at all (grep for blend/in-season/dynamic returns
   nothing relevant).

2. **The real preseason/in-season blend lives in nfl-preseason-blend.js**, and
   it is already a principled Bayesian conjugate normal-normal posterior
   update: `weightOnPrior = sigma^2 / (sigma^2 + n*tau^2)`, with posterior_se
   reported alongside prior/in-season/blended numbers every time (never
   silently collapsed to one number). This is not a "hand-tuned blend" — it's
   the textbook Bayesian shrinkage estimator, already analytically exact,
   fast, and honestly uncertainty-quantified. GF04-2's stated defect
   ("hand-tuned... not a principled ... Bayesian update") is factually wrong
   about this codebase, and targets the wrong file.

3. **nfl-ensemble.js already has 6 non-market "Rating systems" family
   components** (massey, colley, pythagorean, point_diff, melo/Elo,
   dynamic_state) plus multiple EPA-efficiency components, all computed with
   zero reference to the market line. The diagnosed problem ("20 components
   collapse to ~3 independent signals") is a *correlation-among-components*
   problem, not an *absence-of-non-market-signal* problem. Adding a 7th
   correlated rating system (a Bayesian bivariate-Poisson state-space) very
   likely reproduces the same collapse rather than fixing it — this is
   exactly the "5-7 duplicate copies" pattern Nick asked to score down.

4. **teaser-leg-rates.js already rigorously resolved the same-game/same-week
   correlation question**, with two rounds of self-audit-corrected math:
   - Same-game legs are **structurally impossible** in this product: "the
     operational rule from `nfl-teasers.js` stands... legs must come from
     DIFFERENT GAMES. The family makes that automatic — a game's two sides
     can never both be candidates." `same_game_pairs` is asserted at 0, not
     assumed.
   - Same-week (cross-game) correlation was measured (rho -0.044), then
     re-examined and shown to be a week-size composition artifact, not
     dependence (permutation test p=0.116; bootstrap CI [-0.095, +0.008]
     includes zero). The file explicitly documents why NOT to add a
     correlation correction, and warns future editors: "Anyone tempted to add
     a correlation bonus should run this function first."
   - This directly and materially undercuts the shared premise behind
     GF04-4, GF06-1, GF06-2, GF06-3, GF06-4, and GF05-6 — all propose
     building copula/dependence machinery for same-game teaser legs that (a)
     cannot exist in this product by construction, and (b) has already had
     its only real analog (same-week correlation) measured out to
     statistical insignificance with unusually careful, already-published
     due diligence. Building this would contradict the codebase's own
     considered, well-documented decision.

5. **nfl-devig.js already implements two methods (proportional/multiplicative
   and Shin)**, with Shin explicitly noted as "the project's default no-vig
   method... as of this change" — i.e., a considered switch already
   happened, not zero comparison. GF05-2's premise ("one ad hoc approach")
   is overstated. Three other dedicated research files already exist for
   this same devig gap (F03, F16, GF03), so a 4th angle at the same problem
   scores lower for duplication risk even though the concrete
   penaltyblog-port mechanism itself is sound.

6. **player-week-engine.js's `explainPlayerWeek` already emits an explicit,
   human-readable cold-start message** ("No current-season games are
   available before this cutoff, so no weekly outcome update was applied.")
   rather than nothing — but this is a text-explanation function, not the
   persisted snapshot/learning-loop table the diagnostic's "heads is null
   week 1" finding is about, so the underlying silent-no-op claim in the
   learning loop itself is not contradicted by this. GF05-5 remains well
   supported and is very cheap (hours) — scored up, consistent with Nick's
   fantasy-over-betting priority.

7. **team-codes.js is a small (100-line), simple alias-canonicalization
   lookup**, not obviously broken ad hoc string matching; GF05-4's proposed
   fix is real infrastructure value (unlocking the 12.4M-row Polymarket
   tape) but at "weeks" cost with real risk of becoming yet another
   half-finished parallel table given how many tables already exist in this
   codebase.

## Scores

- GF04-2 (Stan dynamic biv-Poisson replaces team-strength blend): reject.
  Targets the wrong file; the actual blend (nfl-preseason-blend.js) is
  already a principled closed-form Bayesian update with reported posterior
  uncertainty. Replacing something already correct and fast with an MCMC
  sidecar for days of work is not justified by the (misattributed) evidence.

- GF04-3 (feed Bayesian rating into ensemble as "independent" signal):
  reject. The ensemble already has 6 non-market rating-system components;
  the diagnosed defect is correlation among components, not absence of
  non-market signal. A 7th correlated rating-system component is more
  duplicate machinery, not a fix.

- GF04-4 (biv-Poisson shared intercept for teaser/same-game correlation):
  reject. Same-game legs cannot occur in this product by construction; the
  applicable cross-game correlation has already been measured to
  statistical insignificance with unusually careful methodology, and the
  code explicitly warns against adding a correction.

- GF04-5 (export full posterior draws instead of assumed-normal SD): reject
  for this chunk. Real gap, but the proposed mechanism is contingent on the
  GF04-2 Stan pipeline being built (which is rejected above), and conformal
  calibration (a dedicated cluster, GF08, exists) reaches the same honest
  end-state at far lower cost with no new runtime dependency.

- GF04-6 (canonical posterior-export JSON schema): later. Cheap (hours) and
  reasonable hygiene, but has no real consumer in this chunk once GF04-2/3/4
  are rejected; worth doing only once an actual Bayesian integration is
  greenlit.

- GF05-1 (consolidate 5-7 CLV/audit engines into one Backtest+Account
  ledger): test-first (build-leaning). Confirmed in repo: at least 7 files
  implement CLV-like computations (nfl-clv.js, nfl-execution-clv.js,
  nfl-opening-lines.js, nfl-drive-sim.js, nfl-prop-clv.js,
  nfl-execution-clv-downsize.js, line-move-study.js). This is exactly the
  named, concrete duplication Nick asked to score up when fixed cleanly.
  Its own exit criterion (validate the new ledger against existing
  implementations before retiring any) is the right gate.

- GF05-2 (port penaltyblog 7-method devig dispatcher + benchmark): later.
  Sound mechanism, but nfl-devig.js already has 2 methods with a considered,
  documented default switch (not zero comparison as claimed), and 3 other
  dedicated research files already exist for this same gap — 4th angle at
  an already-worked area.

- GF05-3 (TimeSeriesSplit-gated backtest() + trial registry for the 21-model
  search): test-first. Real, important governance gap (matches "no trial
  registry / multiplicity correction" finding), sound mechanism (structural
  CV-type rejection), but a dedicated cluster (GF10-trial-registry) likely
  covers this need more specifically — treat this as a fallback/simpler
  version, not the primary vehicle.

- GF05-4 (unified odds/quote table replacing team-codes.js/nfl-contract-key.js
  string matching, unlocking the Polymarket tape): later. Real potential
  value (12.4M unused rows) but "weeks" cost, and the current team-codes.js
  is a small, simple, not-obviously-broken lookup — this is more "new
  capability" than "fix," and risks adding yet another parallel table absent
  strong sequencing discipline.

- GF05-5 (visible cold_start_skip status row for the fantasy weekly-learning
  loop): build. Directly serves Nick's explicit fantasy-over-betting
  priority, extremely cheap (hours), turns an invisible null into a queryable,
  alertable state. Best value/cost in this chunk.

- GF05-6 (complementary-events filter to block same-game double-sided
  teaser bets): reject. teaser-leg-rates.js already structurally guarantees
  legs come from different games ("a game's two sides can never both be
  candidates," asserted with same_game_pairs=0) — the failure mode this
  candidate defends against cannot occur in the current product.

- GF06-1 (empirical copula for same-game teaser legs): reject. Same-game
  legs cannot occur by construction; the analogous cross-game correlation
  has already been measured out to insignificance with real rigor. The
  candidate's own text half-admits this ("on today's data this may change
  nothing").

- GF06-2 (bvn_upper Gaussian-copula fallback): reject. Same underlying
  premise problem as GF06-1; a fallback for a correction that itself isn't
  justified by measured data.

- GF06-3 (Archimedean/Clayton/Gumbel offline fit): reject. Its own evidence
  is rated "weak" and is explicitly gated on GF06-1/GF06-2 showing a real,
  non-Gaussian effect first — which is unlikely given the codebase's own
  measured-to-zero finding.

- GF06-4 (vine copula, reference-only for 3+-leg parlays): reject for now.
  Explicitly not applicable to Gridiron's current two-leg teaser product by
  the candidate's own admission; correctly scoped as "revisit only if
  scope changes," i.e., no action today.
