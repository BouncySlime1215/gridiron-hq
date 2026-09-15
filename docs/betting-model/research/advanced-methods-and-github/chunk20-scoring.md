# Chunk 20/21 scoring notes

Skeptical-statistician framework: evidence 5 = replicated peer-reviewed OOS vs real
market/baseline; 3 = single paper; 2 = practitioner/repo README; 1 = theory/hype.
Penalize anything needing more data/seasons than Gridiron has. Nick's standing priority:
fantasy edge > betting edge; betting only through governance gates; token cost not a
constraint tonight.

Verified GN03 background (read GN03-transformer-pbp-code.md directly): Gridiron's
`nfl_play_by_play` table (server/db/schema/nfl-a-to-m.js:306-333) has no drive_id; drive
boundaries come from a heuristic in nfl-live-ledger.js. `ebrown-32/Deep-Learning-NFL-QB-Stat-
Predictor` (the source for the auxiliary-head pattern GN03-C3/C4/C5 build on) is a 0-star
university class project with **no evaluation numbers anywhere in the repo** — architecture-
only evidence. Critically, C3/C4/C5 all sit downstream of a not-yet-built "GN03-C1" transformer
(the Drive-Outcome Transformer / DOT) that is not itself in this chunk and has no confirmed
build/backtest status. That dependency caps near-term buildability for all three regardless of
each one's own merit.

## GN03-C3 — auxiliary next-play-type head as tendency/teaser-dependence feature
Evidence weak by the candidate's own label: pattern borrowed from a 0-star, unbenchmarked
class-project repo (ebrown-32), and the underlying DOT (GN03-C1) doesn't exist yet in this
codebase. Applicability is real if it ever ships — it's the first same-drive dependence
signal for teaser-leg-rates.js, an audited gap. But cost is understated ("hours") once you
count that a full sequence transformer must be trained and validated first. verdict: later —
revisit once/if GN03-C1 lands and clears its own exit bar (beat team-week base rate).

## GN03-C4 — SHAP surrogate audit over DOT embeddings
mpchang/uncovering-missed-tackle-opportunities is real, cloned, and read in full (XGBoost +
shap.TreeExplainer, verified), so the *technique* is well-precedented. But it is an audit
layer with nothing to audit until DOT exists. Same dependency problem as C3, lower intrinsic
priority (interpretability nice-to-have, not a gap tonight's audit flagged as urgent).
verdict: later.

## GN03-C5 — split-conformal calibration wrapper on DOT's softmax
Conformal prediction itself is a well-established, general statistical technique (evidence
higher than a repo README) and it directly targets the single most-repeated gap in tonight's
findings: "no conformal or otherwise honestly-calibrated uncertainty interval exists anywhere
in the pipeline." The calibration data it needs (nfl_live_possession_settlements) already
exists and is already queried by liveLedgerCalibration() — this part is real, not aspirational.
Still nominally gated on DOT's softmax existing, but the technique is portable to any
categorical-outcome head Gridiron already has (nfl-drive-sim's own outcome distribution), so
it need not wait on DOT specifically. verdict: test-first — build the conformal wrapper
against whatever categorical drive-outcome distribution exists today, verify empirical
coverage, then re-point it at DOT's softmax if/when DOT ships.

## GN04-C1 — correlation-aware DFS lineup simulator (reuses correlatedSampler)
Strongest evidence class available: the mechanism (Cholesky-factorized copula sampler) is
not a paper claim or repo README, it is **already running in Gridiron's own production code**
(season-sim.js, draft-lookahead.js). This is genuine infra reuse, near-zero incremental
modeling risk. Matches Nick's explicit standing priority (fantasy > betting) squarely — DFS
lineup construction is a fantasy surface. Cost is "days" only because of new plumbing, not new
modeling. verdict: build (backtest gate from the candidate's own exit criteria should still be
run before trusting percentile rankings for real money, but the build itself is low-risk).

## GN04-C2 — salary-cap MILP/greedy-ILP lineup selector with stacking constraints
Confirmed by repo grep: no salary-cap/lineup-optimization code exists anywhere in
fantasy-football-dashboard today, so this is genuinely net-new and load-bearing — GN04-C1 has
nothing to rank without it. pydfs-lineup-optimizer's stacking vocabulary is a well-established
practitioner pattern (widely used DFS tooling), not hype. Requires a new (free, non-paid) DK/FD
salary ingestion path. verdict: build — foundational piece, clear correctness exit test (valid
lineup, cap respected, stacks satisfied, hand-checked against 3 known-good historical lineups).

## GN04-C3 — multi-lineup GPP portfolio builder with ownership proxy
pangadfs's multi-objective portfolio approach is a reasonable, moderate-evidence pattern, but
the ownership term is explicitly a self-generated chalk proxy, not real field data — the
candidate itself flags this cap on value. It's also sequenced behind C1 and C2 both landing
first. Useful only for multi-entry GPP play, which is a narrower fantasy use case than season-
long lineups. verdict: later — worth doing once C1/C2 are proven, ship clearly labeled per the
candidate's own honesty requirement, not before.

## GN05-C1 — neg-risk complementary-set arbitrage scanner
Mechanism is verified against real code (Polymarket's NegRiskAdapter address confirmed in
clob-client source), and Gridiron already has the classification (kind='leader_prop' etc.) and
the 12.4M-row price-history table needed, so the detection pass truly costs zero new API calls.
But this is betting-execution, which is secondary to fantasy per Nick's standing priority, and
the candidate's own exit criteria concedes it may turn out to be "a monitoring tool, not an
execution edge" if depth data shows most flagged windows aren't fillable at $200. verdict:
test-first — the backtest pass is cheap (existing tape, no new infra) and should run before any
further investment; do not build execution logic until the fillability check clears.

## GN05-C2 — depth-aware executable price at capture time
Directly closes a gap polymarket.js's own code comment already names ("a quoted price you
cannot get filled at in size is not a price"). Mechanism (py_clob_client's full-ladder walk) is
verified production code from Polymarket's own client. Cost is hours: pure arithmetic on data
Gridiron's captureOrderBooks already fetches every sweep and currently discards. Feeds directly
into GN05-C1's scanner and nfl-execution-edge.js. verdict: build — cheap, low-risk, makes an
existing audited gap measurable with no new calls.

## GN05-C3 — tick-size-aware ladder crossing for polymarket-lines.js
tick_size is a real, verified market-structure field in the same /book payload GN05-C2 already
threads through — cheap to add. But the candidate's own exit criteria admits this may turn out
to be "a documentation-only fix, not a code change" if extrapolated crossings already cluster
near the ladder edge. It improves confidence calibration only, not model skill. verdict:
test-first — check the tick-distance distribution on existing extrapolated crossings before
writing any code; likely a quick empirical check settles whether this is worth shipping.

## GN06 — margin-distribution heads (nfl-ensemble.js predictiveDistribution() replacement)
Background: tonight's audit already confirmed nfl-ensemble.js's blend is a naive
shrinkage-to-market (forecast ≈ 0.68 + 0.632·market, 20 components -> ~3 independent signals,
-2.28 CLV). None of these three heads fix that core blend defect — they only replace how the
*distributional* output (quantiles/margin_interval) is computed downstream. They are additive
"do the calibration right" work, not a fix for the ensemble's demonstrated lack of edge.

### ngboost-normal-margin-head
NGBoost (Duan et al., published, peer-reviewed method) with a verified natural-gradient
implementation (ngboost/scores.py) — genuinely better evidence than a hobby repo, though still
single-paper-plus-library tier, not multiply-replicated in this exact sports-margin domain.
Offline training reuses existing teamWeeks()/hist rows; keeps the same return-object field
names (low integration risk). CRPS/log-likelihood give a real, scoreable exit criterion the
current bootstrap-resample approach structurally cannot provide. verdict: test-first — run the
held-out CRPS/log-likelihood comparison against the current bootstrap before promoting.

### pytorch-mdn-margin-head
Small, well-verified reference repo (tonyduan/mixture-density-network, read in full, not
skimmed) — legitimate multimodality story (competitive-game vs. blowout regimes) but the
candidate's own exit criterion sequences it strictly behind the NGBoost-Normal head (must beat
NGBoost's held-out log-likelihood to be worth the added complexity). Building both in parallel
wastes effort; NGBoost is the cheaper, more standard baseline to try first. verdict: later.

### zuko-nsf-conditional-flow-sidecar
Highest theoretical flexibility, verified code (LazyDistribution -> torch.distributions.Distribution,
monotonic rational-quadratic spline conditioner) — real, exact-density machinery. But the
candidate itself flags the central problem the skeptical-statistician framework specifically
penalizes: "the method itself is data-hungry and Gridiron's own diagnostics put total playable
NFL history at a few thousand games — real risk this overfits." Cost is weeks, requires a new
always-on local sidecar process, and must beat two simpler, cheaper heads before it's worth
keeping. Applicability is capped by the same small-sample problem the underlying data always
has (NFL games/season is bounded). verdict: reject — the honest self-assessment inside the
candidate description is itself the reason to not spend weeks here before the cheaper heads are
even tried, let alone beaten.

### pit-calibration-audit-from-exposed-cdf
This is the cheapest and highest-value item in the whole GN06 group: PIT + KS-test calibration
checking is a canonical, well-established statistical method (not a hype/repo claim), and it is
the *only* way to make "calibration_state: model_fit_pit_checked" mean something real instead
of aspirational — directly closes the single most-repeated audited gap ("no conformal or
otherwise honestly-calibrated uncertainty interval exists anywhere in the pipeline"). It is
gated on at least one head exposing a real cdf() (NGBoost is the cheapest path there). verdict:
test-first — trivial to build once NGBoost's Normal head (which exposes .cdf via scipy delegation
for free) ships; sequence it immediately behind that candidate, not the flow sidecar.

## GN07-c1 — real live in-game win-probability model (nfl-live-wp.js)
This is the strongest candidate in the chunk. It replaces nfl-drive-sim.js, a module tonight's
audit already found to have 6 concrete physics bugs (wrong-team turnovers, half/full-game-clock
mismatch, inverted kneel rule, non-decrementing timeouts letting a leading team burn a whole
half, away-team WP using the home spread, a flat 7-point post-OT HFA lump, no halftime/OT in
the season-remainder sim). The staged approach — a topfunky-style logistic GLM first, then an
nflfastR-architecture monotone-constrained GBM once GN07-c4's fields exist — mirrors a
widely-validated, production-grade public methodology (nflfastR's WP model has been externally
used and checked for years), which is stronger evidence than a typical single-paper or repo
claim. It trains offline against Gridiron's own 251,591-row play-by-play and existing
game_lines table with zero new data collection, and explicitly ships alongside (not replacing)
the buggy simulator so the two can be compared before cutover — respects the read-only/no-
disturb constraint on the live capture process. verdict: build.

## GN07-c2 — NFLWin KDE-based reliability-diagram calibration harness
Small, well-scoped, MIT-licensed, near-verbatim-portable (AndrewRook/NFLWin model.py:285-396).
Standard Gaussian-KDE reliability-diagram technique — the general method is well-established
even though this specific implementation is single-repo evidence. Directly usable to validate
GN07-c1's WP model, but it generalizes past WP to CLV and prop distributions too, which is
valuable given tonight's audit found five disagreeing CLV implementations and no honest
calibration checks anywhere. Its own exit criterion doubles as a self-test (must reproduce a
near-diagonal curve on nflverse's public, already-well-calibrated wp column) — good hygiene.
verdict: build.
