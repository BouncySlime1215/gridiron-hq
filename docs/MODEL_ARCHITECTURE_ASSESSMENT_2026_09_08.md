# Gridiron HQ vs. a proposed quant architecture: line-by-line assessment

Prepared 2026-09-08. Audience: an advanced model (or engineer) picking up this
codebase next. Purpose: a second AI ("Gemini") produced a from-scratch NFL
spread-prediction architecture — a stacked multi-modal ensemble, an automated
audit engine, and an overfitting/bias-control protocol. This document checks
every specific claim in that proposal against what actually exists in this
repository today, cites the file and mechanism, and gives a single
reorganization recommendation. It does **not** propose abandoning
`docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md` or its lettered packages (A–I).
Every actionable idea below is phrased as a graft onto an existing package,
not a new initiative competing with them.

Read `docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md` and `CLAUDE_FEEDBACK.md`
first if you haven't — this document assumes familiarity with both and with
the "independent conclusions" section's eight rejected shortcuts.

## Verdict, in one paragraph

The proposed architecture describes, at a textbook level of detail, a
discipline this project has already implemented in most of the places that
matter — chronological purged folds, out-of-fold-only calibration, residual
targets instead of raw scores, devigging, key-number modeling — and it is
weaker than this project in two specific areas: leakage detection is a design
principle in the proposal and a *tested, code-verified* property here
(`research/leakage.py` proves it against a synthetic injected leak); and the
"is this a mispriced instrument or a joint-price identity" distinction is
handled here with the rigor the master plan's own rejected-shortcuts list
demands, while the proposal doesn't address it at all. The proposal is
stronger in exactly two places worth taking seriously: it has **no engineered
distributional-drift check** (this project doesn't either — a real gap), and
its **non-negative, sum-to-1 ridge meta-learner constraint** is more precise
than this project's own Package F description ("ridge/logistic stacking") and
was adopted verbatim. (F has since been built with it and **lost to the market
on every substrate** — see Part 2.6, which also corrects a wrong claim in this
document's first draft about C/D/E's out-of-fold outputs already existing.)
The GNN/player-tracking stream and
the "Public Action Coefficient" market-hype feature are real ideas with no
supporting data source currently identified in this project's data-acquisition
plan — they are parked as speculative, not rejected.

---

## Part 0 — what "ours" actually is, with citations

Before comparing, here is the concrete, checkable state of this repository as
of this document, so every claim below can be verified by reading the named
file rather than trusting a summary.

| Package | State | Where |
|---|---|---|
| A — exact-contract keys, bitemporal store, quarantine-reported dataset | Built, tested, committed | `server/services/nfl-contract-key.js`, `nfl-bitemporal.js`, `nfl-evidence-dataset.js`; `test/evidence-dataset.test.js` |
| B — book lead/lag, no hardcoded sharp book | Built, unit-tested; full historical run not yet executed | `research/book_lag_lab.py`, `research/test_book_lag_lab.py` (13 tests) |
| C — extended tree/TPOT factory | Built, executed against real data, frozen result | `research/tree_lab.py`, `research/leakage.py`; `server/data/tree-lab/latest.json` (gitignored, local) |
| D — player-role scenarios with conservation | Built, executed against real data, frozen result (mixed) | `server/services/role-scenario-engine.js`, `role-scenario-lab.js`; `test/role-scenario-engine.test.js` |
| E — typed news events, impact/timing model | Built, unit-tested (18 tests incl. 3 negative controls); no historical LLM extraction run executed (real API cost) | `server/services/nfl-news-events.js`, `nfl-news-event-impact.js`; `test/nfl-news-events.test.js` |
| H — execution simulator (offered→observed→decision→accepted→settled) | In progress at time of writing | `server/services/nfl-execution.js` (pre-existing baseline: book-hold routing, the project's one measured positive) |
| Decision Inbox (Codex audit item) | Built, tested, wired into 2 real engines | `server/routes/decision-inbox.js`, `server/migrations/020_decision_recommendations.js` |
| Schema centralization | Phase 1 (lift, prove equivalence) done; phase 2 (remove ad-hoc DDL from 122 files) not started | `server/migrations/000_legacy_schema.js`, `server/db/schema/*.js`, `scripts/schema-snapshot.mjs` |
| Production betting model, baseline reality | Already measured: **zero edge vs. closing lines** on the side-picking task, twice, per `betting-fantasy-link.js:158` and `nfl-shopping-board.js:267` (spreads underperform the closing line by a measured MAE). The only measured positive in the entire betting stack is book-hold routing (~1.22 points), per `nfl-execution.js`'s own file header. | multiple |

That last row matters for reading everything below: this project has already
run the honest backtest the proposed architecture recommends building, on the
side-picking task, and it lost. That is not evidence the new packages (B–E,
H) are pointless — they target different things (market *response* and
*timing*, not "who wins," and player-role *distributions*, not point
totals) — but any comparison that implies this project hasn't yet done
rigorous quant backtesting starts from a wrong premise. It has, honestly,
and reported the negative.

---

## Part 1 — Audit engine

The proposal's model: four hardcoded runtime gates between the meta-learner
and capital allocation — Population Stability Index (PSI) drift, a Market
Line Corridor sanity check, a Target Leakage Sandbox, and a post-game Closing
Line Value (CLV) Z-test that downsizes Kelly on failure.

### 1.1 Leakage detection — proposal describes it, this project proved it

The proposal's "Target Leakage Sandbox Test" is a design description: run
mock real-time predictions locked to historical timestamps, and if live
sandbox accuracy diverges from backtest accuracy by some margin, halt
capital and trace the pipeline.

This project has the stronger version of this in two independent layers:

1. **Structural, not procedural.** `nfl-bitemporal.js`'s `valueAsKnown(entity,
   feature, decisionAt)` refuses to return a fact unless
   `published_at + availability_delay_ms <= decisionAt` *and*
   `observed_at <= decisionAt`. This isn't a sandbox that runs periodically
   and might have its own bugs — it is the only way to read a point-in-time
   fact at all in code that uses it. `nfl-evidence-dataset.js`'s
   `buildEvidenceDataset()` does the same for market quotes, with **four
   named, counted quarantine reasons** (`future_snapshot`, `after_kickoff`,
   `book_ahead_of_snapshot`, `duplicate_contract_conflict`) that appear in
   every dataset's manifest, not just as a pass/fail gate.
2. **Proven, not assumed.** `research/leakage.py` fits a single-feature model
   per column per chronological fold and flags any feature whose
   out-of-fold skill is implausibly close to perfect. `research/test_tree_lab.py`
   proves this actually catches a leak by injecting a synthetic one and
   asserting the scanner flags it. The proposal never specifies *how* its
   sandbox would distinguish a real leak from a strong legitimate feature;
   this project's scanner does, and the proof is a runnable test, not a
   design claim.

**Verdict: this project's leakage control is more rigorous, because it's
enforced at the data-access layer and independently proven, not run as a
periodic external check.**

### 1.2 Population Stability Index (distribution drift) — genuine gap, adopt it

Nothing in this project computes a distributional-drift statistic between a
model's training population and the population it's currently scoring. The
closest existing thing, `source-registry.js`'s staleness/confidence tracking
(surfaced on the new `/data-health` page), measures whether a *feed* is
current — it says nothing about whether the *feature distributions* have
shifted (e.g., because the 2026 kickoff-rule change altered field-position
distributions, which the master plan's data-acquisition table already flags
as a known discontinuity for the participation-data feed).

**Recommendation:** add a PSI (or simpler: a KS-statistic) check to the
research-lab pipeline shared by C and D — compute it between the fit season(s)
and the current scoring season for every model feature, log it in the
experiment manifest next to the leakage scan, and treat a breach the way the
proposal does (log, don't auto-halt capital, because nothing here has capital
authority yet). This is a Package I integration task (the research lifecycle
already has a manifest to extend), not a new package.

### 1.3 Market Line Corridor (sanity check against Vegas) — partially covered, formalize it

The proposal's rule — flag any prediction more than 4.5 points from the
opening line as more likely an internal bug than found alpha — is philosophically
identical to something already stated as a design principle in the master
plan's Package H section: *"Stored extreme prices should be challenged
first, because they often represent bad joins or stale feeds."* But that's a
principle, not a wired check. Package H (in progress at time of writing) is
the right place to encode it literally: any model output whose gap from the
market's own no-vig line exceeds a threshold gets logged as `needs_review`
before it's allowed into the paper ledger, with the threshold itself
calibrated from this project's *own* history of how large a legitimate
divergence has ever been (rather than adopting Gemini's illustrative 4.5
uncritically — that number was chosen for a generic NFL model with no
knowledge of this project's actual residual distributions; `tree_lab.py`'s
frozen results already contain the empirical residual distribution needed to
pick a real threshold).

### 1.4 CLV Z-test with automatic Kelly downsizing — the right idea, wrong layer to enforce it alone

The proposal ties long-term viability to whether the model's picks move the
closing line in the predicted direction more than 53.5% of the time over a
rolling 30-game window, downsizing Kelly by half on failure. This project
already measures CLV as a first-class concept (`sharp-lag.js`, `beat-the-close.js`,
and now `research/book_lag_lab.py`'s survival/hazard model), but nothing
currently *automates a staking consequence* from a CLV miss — because nothing
in this project has staking authority yet. Package H's staking comparison
(fixed paper stakes vs. uncertainty-shrunk fractional Kelly) is exactly where
this belongs: add the CLV-miss-triggers-downsize rule as one of Package H's
required stress tests, not as a standalone audit module. The master plan's
existing rule — "don't automatically stop on two losing weeks or refit until
a backtest wins... both are selection policies that must be tested" —
applies here too: a hardcoded 53.5%/30-game/50%-downsize rule is itself a
policy that needs the same purged-fold validation everything else in this
project gets, not an exception because it's framed as "risk management"
rather than "alpha."

### 1.5 What the proposal doesn't cover that this project already treats seriously

The proposal's audit section is entirely about statistical/ML validity. It
says nothing about the software layer underneath the models, which is where
most real production incidents actually happen. This project's recent work
(this session) added, independent of anything in the proposal:

- **Schema equivalence proof.** `scripts/schema-snapshot.mjs` builds a
  database three ways (legacy scattered DDL, centralized migration-only,
  centralized+legacy-imports) and diffs `sqlite_master` + `PRAGMA table_info`
  byte-for-byte. Any future schema refactor is provably a no-op before it
  ships, not "should be fine, we ran the tests."
- **Pre-migration backups gated on real history.** `backupBeforeMigration()`
  in `server/db/index.js` takes a `VACUUM INTO` snapshot (not a raw file
  copy — WAL-mode databases can have committed pages sitting in the `-wal`
  file that a raw copy would miss) before any new migration touches a
  database that already has migration history, and skips the cost entirely
  on a fresh database (every test's temp DB).
- **Periodic integrity checks** (`PRAGMA quick_check`/`integrity_check`,
  interval-gated so a 6GB+ database doesn't pay the full scan cost on every
  boot) already existed before this session.

None of this appears in the proposed architecture, and none of it should be
skipped just because it's "infrastructure, not modeling" — a leakage-free
model trained against a database that silently corrupted a table is not
safe.

---

## Part 2 — Model architecture

The proposal: three parallel Level-0 streams (tabular tree ensemble, spatial
GNN over player-tracking coordinates, transformer over text/injury reports)
feeding a non-negative-ridge Level-1 meta-learner, with EPA-EWMA feature
engineering, synthetic-WAR injury adjustment, and a full execution pipeline
(devigging, key numbers, fractional Kelly).

### 2.1 Target transformation (predict the residual, not the score) — already done, independently

The proposal's central modeling insight — *"model the Residual Error
relative to the Market Opening Line... rather than trying to out-predict
Vegas on standard variables"* — is exactly what `research/market_lab.py`
(the original pilot) and `research/tree_lab.py` (Package C's extension)
already do. `tree_lab.py`'s three targets are: opening-to-closing movement
regression, cover/over classification against the market line, and quantile
regression of the market residual. None of the three predicts a raw score.
This was arrived at independently (the master plan's package descriptions
predate seeing the proposal) and is already validated with real chronological
folds and a genuine market-only baseline in every comparison — the proposal
describes the idea; this project has a tested implementation and a frozen
result.

### 2.2 Tabular tree ensemble — broader target surface than proposed, comparable family choice

The proposal specifies XGBoost/LightGBM with `max_depth` 3–4,
`min_child_weight >= 15`, `subsample`/`colsample_bytree` at 0.7. This
project's `tree_lab.py` uses LightGBM, XGBoost, and CatBoost (a third family
the proposal doesn't include, chosen because it handles the categorical team/
book/market features here without manual one-hot encoding) across three
targets rather than one, plus a genuine market-only baseline and a
`coin_flip` sanity check in every single comparison the proposal doesn't
specify. Whether this project's specific hyperparameter bounds match the
proposal's exact numbers (`max_depth` 2–4, `min_child_weight` ≥ 3% of
training rows) was **not independently reconfirmed while writing this
document** — that is a concrete, cheap thing to check against
`tree_lab.py`'s actual `param_grid` before trusting either project's numbers
blindly, and is called out as a to-do in Part 3.1 below.

### 2.3 Market-anchored logit — this project's version is more leakage-precise than the proposal's meta-learner

The proposal's meta-learner constraint (non-negative coefficients, sum to
1.0) prevents the *combination* of Level-0 models from inventing artificial
relationships. It does not, on its own, prevent leakage in *how a single
model's own shrinkage or calibration parameter gets chosen* — a real and
separate risk. `tree_lab.py`'s market-anchored branch,
`logit(p) = logit(p_market) + shrinkage · (logit(p̂) − logit(p_market))`,
selects `shrinkage` by **inner chronological cross-validation log-loss,
before the outer test season is ever scored** — the master plan calls this
exact risk out by name in Package C's brief. This is a narrower, more
precise guard against a specific leakage vector the proposal's broader
meta-learner constraint doesn't address at all. The two ideas are
complementary, not competing — see Part 2.6.

### 2.4 Player-role / injury-driven value shifts — built, tested, and it found the proposal's blind spot

The proposal's "Synthetic WAR" idea — convert a ruled-out player's value
directly into a spread-point deduction via a position-based matrix, assuming
his value flows cleanly to the backup — is conceptually what Package D's
`role-scenario-engine.js` does (`conservedTeamVolume`: redistribute an absent
player's expected opportunity to teammates under a fixed team-volume pool).
Package D went further than the proposal asks and **ran a self-audit on
exactly this reallocation mechanism** (`cascade_conservation_audit` in
`server/data/role-scenario-lab/latest.json`): checked against 110 real
starters, **27.3% of cases had total beneficiary gain exceeding the outgoing
player's own opportunity** — meaning naive multi-beneficiary reallocation
(the exact mechanism both this project's and the proposal's "instant spread
shift" idea depend on) measurably overshoots more than a quarter of the
time. The proposal presents synthetic-WAR injury adjustment as settled
architecture; this project's own evidence says the reallocation math it
depends on needs more constraint work before it's trustworthy at that rate.
Package D's declared, bootstrap-validated result on the actual forecasting
question (does knowing a teammate is out improve the touches/yards forecast)
was a genuine, honest **mixed** finding: touches improved significantly on
both the 2024 discovery and 2025 holdout seasons (90% CI excludes zero both
times); yards did not (CI straddles zero both times). Report this precisely
if it comes up — not as "Package D succeeded" or "Package D failed," but as
what it actually found.

### 2.5 Spatial/tracking GNN and transformer text stream — real ideas, no supporting data source identified

Two of the proposal's three Level-0 streams have no counterpart here, and
the honest reason is a data problem, not an architecture problem:

- **Player-tracking coordinates** (the GNN stream) require an NGS-grade
  positional feed. The master plan's data-acquisition table lists nflverse
  play-by-play/NGS/PFF-advanced sources, none of which include raw per-frame
  player coordinates — that data is not part of the public nflverse release
  set at the granularity the proposal assumes (full broadcast-grade tracking
  is largely a proprietary NFL/AWS product). Before writing a single line of
  GNN code, the actual gate is: does an accessible feed exist. If Nick has
  access to one, this becomes a real Package (call it a K), but it does not
  exist as stated in the current data plan.
- **Transformer text embeddings** (the injury-report/press-conference
  stream) is the one stream this project *does* have a working counterpart
  for, just via a different technique: Package E's typed extraction (LLM
  structured output → typed claims with evidence spans, novelty, certainty)
  rather than a dense transformer embedding fed into a downstream network.
  For the sample sizes this project actually has (thousands of games, not
  millions), structured extraction with an explicit schema is very likely
  the better-calibrated choice — a fine-tuned or even frozen transformer
  embedding space is much higher-variance to validate at this scale, and
  Package E's three negative controls (irrelevant-team news, duplicate
  article, time-shifted future news — all implemented and passing per
  `test/nfl-news-events.test.js`) are a concrete way to catch exactly the
  kind of silent timing leak a black-box embedding pipeline would hide.

**Recommendation:** don't build the GNN stream speculatively. Flag it as
blocked on a data source, and revisit only if Nick identifies an actual
accessible tracking feed. Keep Package E's structured-extraction approach
over a transformer-embedding rebuild — it's already built, already tested
against the exact failure mode (timing leakage) that matters most here, and
better suited to the sample size this project actually has.

### 2.6 Meta-learner stacking (Package F) — adopted verbatim, built, and it lost

**Correction to this document's first draft.** That draft said Package F was
blocked on "C/D/E producing frozen out-of-fold outputs" and that "**C, D, and
E are all done**," so F was unblocked. Package F's own build checked the disk
before trusting that sentence and found it **overstated**: C had trained
models and a dataset but **no per-row predictions** persisted anywhere; D had
only a manifest; E had never been run at all. A stacker has nothing to stack
without per-row held-out predictions, and this document asserted their
existence from the existence of the packages that would have produced them.
The claim is corrected here rather than quietly edited away, because the
failure mode — inferring an artifact from the pipeline that should have made
it — is exactly what the rest of this document argues against.

F was still built, because the fix was cheap: `research/tree_lab.py` was
already computing per-candidate held-out predictions and discarding them
after reducing each to scalars, so `emit_oof()` now persists them
(`tree-lab-oof-v1`). Those predictions carry a **stronger** guarantee than
the shuffled k-fold OOF the proposal assumes — each candidate is fit only on
seasons strictly earlier than the test season, under a seven-day
settled-label cutoff — which in turn obligates the stacker to be fit
chronologically across seasons too.

The proposal's constraint was adopted verbatim:

```
min_β Σ(yᵢ − Σⱼ βⱼ ŷᵢⱼ)² + α Σⱼ βⱼ²   subject to βⱼ ≥ 0, Σⱼ βⱼ = 1
```

It is a sound constraint and it does what it claims: the stacker can only
produce a bounded weighted average, never a leveraged sign-flipping
combination, and a market-only expert competes on equal terms and may take
all the weight. **It also did not work.** Across three substrates and seven
gate configurations:

| substrate | rows | experts | selector MAE | market MAE |
|---|---|---|---|---|
| council | 831 | 18 | 9.63 | 9.49 |
| tree:spreads:move | 660 | 7 | 9.30 | 9.29 |
| tree:totals:move | 685 | 7 | 9.97 | 9.99 |

No configuration met the pre-declared bar (positive mean gain over *both*
baselines, week-clustered 95% interval excluding zero, on a majority of
walk-forward test seasons). Seven trial/season combinations were
significantly *worse* than the market. The declared metric was MAE while the
meta-learner minimizes squared error; MSE was added as a secondary metric
afterward, which can only flatter the method's own objective, and it failed
on both.

The diagnostic worth keeping is not the MAE gap, which is small. It is that
**the selector essentially never chose to abstain**: `market_only` carried
weight 0.000 / 0.068 / 0.000 across the three substrates even though taking
the market outright was the better answer on two of them. The correct action
was available in the action set and the fitting procedure did not find it.
That is a statement about how little signal is in the expert pool at this
sample size, not a bug in the constraint — and it is a sharper negative
result than "the numbers came out slightly worse."

Four experts (`boosted_tree`, `deep_residual`, `rulebook`, `specialist_team`)
took zero weight in every fold. Recorded as a finding about this evidence,
not as grounds for deletion: a weak standalone forecast can still carry
conditional information that a larger sample surfaces.

So 2.6 remains the cleanest point of *alignment* between the two plans — the
proposal specified the right constraint and this project adopted it exactly —
while being a caution about what alignment buys. A well-specified stacker
over experts that do not beat the market produces a well-specified forecast
that does not beat the market. The binding constraint here is the evidence,
not the combination rule. Reported in the app as `built_result_negative`,
with research-only authority; full report at
`server/data/expert-selector-lab/latest.json` and on the Research Lab page.

One follow-on is explicitly recommended **against**: contextual bandits. NFL
delivers full information on every game — every expert's error is observable
whether or not that expert was chosen — so supervised updates are strictly
more sample-efficient than bandit exploration. Sample size is the binding
constraint, and exploration spends exactly that.

---

## Part 3 — Overfitting, bias, and "Frankenstein" control

The proposal: a strict 15:1 observation-to-feature ratio with automatic PCA/
Lasso compression above it; hardcoded `max_depth` 2–4 and
`min_child_weight` ≥ 3% of training rows; three named bias-eradication
rules (public-hype tax, human-grader Z-normalization, win-loss/Pythagorean
substitution); strict zero-cross-contamination between Level-0 streams;
sequential OOF generation; the non-negative-ridge meta-constraint (covered
in 2.6).

### 3.1 Data-to-feature ratio cap — genuinely missing, cheap, adopt it

Nothing in this project enforces an explicit ratio between training rows and
feature count before a model is allowed to fit. This is a real, concrete,
low-cost gap. The proposal's specific numbers (15:1, derived from a 6-season/
1,632-game NFL history) are a reasonable starting point but should be
recomputed against *this project's actual per-package sample sizes* rather
than imported blindly — Package D's discovery season alone had 1,624
player-weeks (a different unit than games), and Package C's per-market,
per-season folds are smaller than a full 6-season pool. **Recommendation:**
add a shared assertion (a small new module, e.g.
`research/model_discipline.py`, importable by both `tree_lab.py` and any
future Python research script) that computes `rows / feature_count` for the
actual fold being fit and raises rather than silently proceeding if it falls
below a threshold set per-package based on that package's actual label
frequency — not a single global 15:1 constant, since a classification
target with a 50/50 base rate needs a different bar than a rare-event
target. This is exactly the kind of "hardcode a threshold, then let the
purged-CV discipline this project already has decide whether the threshold
itself was right" pattern the master plan's own acceptance criteria call
for.

### 3.2 Shallow-tree / min_child_weight discipline — checked directly; matches on depth, likely thinner than the proposal's floor on child weight

Read directly from `research/tree_lab.py` rather than assumed: every family
is hardcoded to `max_depth` 3 or 4 across all three targets (movement,
cover/over, quantile) and the ranker — `LGBMRegressor`/`LGBMClassifier`/
`LGBMRanker` at `max_depth=4, num_leaves=11, min_child_samples=25`;
`XGBRegressor`/`XGBClassifier` at `max_depth=3, min_child_weight=10`;
`ExtraTrees` at `max_depth=4, min_samples_leaf=30`. `subsample`/
`colsample_bytree` are 0.7–0.8 throughout. On depth and column/row
subsampling this matches the proposal's numbers closely (2–4 vs. 3–4; 0.7
vs. 0.7–0.8).

On the child-weight floor, checked against the actual frozen run
(`server/data/tree-lab/latest.json`): the whole dataset is 1,795
observations across 2 markets × 3 outer season-folds, so a per-market
training fold is roughly in the low hundreds to ~900 rows depending on
which outer season is held out (later outer seasons train on more prior
years). At the small end of that range, `min_child_weight=10` /
`min_child_samples=25` sits at or above the proposal's 3% floor (25 of
~330 ≈ 7.6%); at the large end, it's below it (25 of ~900 ≈ 2.8%, close to
but under 3%). So: not a clear violation, not a clear match either — the
guard is tightest exactly where it's needed least (the biggest fold) and
loosest on the smallest one, which is the wrong direction if the proposal's
underlying logic (protect small folds more, not less) is right. A ratio
computed per-fold rather than a single constant across all folds — the
same fix as Part 3.1's shared model-discipline module — would resolve this
directly instead of leaving it to a fixed number that's only sometimes
enough.

### 3.3 Public-hype "tax" and human-grader normalization — real ideas, no data source, no need yet

Neither technique has an ingestible data source in this project today (no
public-bet-percentage feed, no PFF-grade ingestion service exist per the
current file inventory). Two caveats worth stating plainly rather than
treating this as an obvious future win: (1) public-fade strategies in
sports betting are widely known and arguably crowded/priced-in by
sportsbooks over the last decade — the proposal presents it as a clean bias
to strip, but the actual edge from doing so is contested in practice, not
settled; (2) this project's spread/cover targets are already point-
differential-based by construction (a spread bet is a proposition on
margin, not on win/loss), which is the specific bias the proposal's
"strip win-loss, use Pythagorean expectation" rule exists to correct —
that correction is structurally already true here, not something to
retrofit. Both public-tax and grader-normalization are legitimate future
Package-E-adjacent extensions *if* a supporting feed is ever added, not
gaps in the current architecture.

### 3.4 Stream cross-contamination — not a risk yet, by architecture rather than by rule

The proposal's "zero cross-contamination at Level 0" rule protects against
a specific failure mode (a single dense network blending tabular, spatial,
and text features loses interpretability and overfits to spurious
cross-stream correlations). This project has no dense multi-stream network
at all — Package C's trees are tabular-only, Package E's impact model
consumes typed extraction output as its own separate model, and Package D's
scenario engine is roster/usage-based. There is currently nothing to
cross-contaminate. This should be written down explicitly as an
architectural constraint (a short paragraph in the master plan, not a new
module) so that if a future package *does* try to blend streams directly
into one model, the reason not to is on record rather than rediscovered.

### 3.5 OOF isolation — already true everywhere, worth consolidating into one shared statement

Every package's declared `split_policy` (per the master plan's "Agent
operating contract," every experiment must declare this before evaluation)
independently states some version of "chronological, grouped, calibrator/
shrinkage fit only on prior out-of-fold predictions." This is functionally
identical to the proposal's OOF-wall concept, but it currently lives as N
separate re-derivations (once per package's declaration) rather than one
canonical rule every package's declaration references. **Recommendation:**
add a short, single canonical statement of this rule to the master plan
(near the "Acceptance and release" section) and have future package
declarations cite it rather than restate it — reduces the chance a future
package states a subtly weaker version by accident.

---

## Part 4 — Reorganization recommendation

Every actionable item above is a graft onto a package that already exists in
`docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md`. Nothing here proposes a new
top-level initiative, a new phase ordering, or stopping any in-flight
package. In priority order:

1. ~~**Package F, now unblocked**~~ — **done, and the answer was no.** Built
   with the proposal's exact non-negative sum-to-1 ridge constraint, run on
   three substrates, beat the market on none of them (Part 2.6). The premise
   of this line as originally written was also wrong: C, D and E did *not*
   all have frozen out-of-fold outputs on disk, and F had to make them before
   it could run. The remaining adoption value from the proposal is now items
   2–5, not this one; the highest-leverage next move on the modelling side is
   better evidence, not a better combination rule.
2. **Package H's stress-test list gains two concrete rules**: the Market
   Line Corridor check (Part 1.3, threshold derived from this project's own
   residual distributions, not imported blindly) and the CLV-miss-triggers-
   Kelly-downsize rule (Part 1.4), tested with the same purged-fold
   discipline as everything else — not exempted as "risk management."
3. **A shared model-discipline module** (Part 3.1) that every Python
   research script imports: per-package, per-fold data-to-feature ratio
   assertions, sized to that package's actual label frequency rather than a
   single imported constant.
4. **A distributional-drift check** (Part 1.2) added to the research-lab
   manifest schema (Package I's territory), logged alongside the existing
   leakage scan — genuinely new capability, not present in either project
   today in this project's form.
5. **A canonical OOF-isolation statement** (Part 3.5) added to the master
   plan once, referenced by future package declarations instead of
   re-derived each time.
6. **Parked, not rejected**: player-tracking GNN stream (blocked on an
   actual accessible data source — revisit only if one is identified),
   public-action-coefficient bias correction (blocked on a public-bet-
   percentage feed, and contested in practice even with one), human-grader
   Z-normalization (blocked on a PFF/referee-grade ingestion service that
   doesn't exist yet).

The overall shape of this project — canonical contracts, bitemporal
point-in-time correctness, purged chronological folds, market-residual
targets, honest negative results kept and reported rather than discarded —
is not what the proposed architecture would replace. It's what the proposed
architecture is, in places, still describing as an aspiration.
