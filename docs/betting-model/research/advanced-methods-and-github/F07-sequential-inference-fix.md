# F07 — Always-valid p-values / confidence sequences done correctly

## The exact defect, located and confirmed by reading the code

`server/services/audit-registry.js` is Gridiron's "preregistration gate": `preregister()` locks a
threshold before the result exists; `runAudit()` seals a result exactly once; `auditHistory()`
reports a Šidák-corrected significance bar across every sealed audit. It already has a partial fix
in it (a comment block labelled "Codex correction C17," corroborated in
`server/services/backtest-significance.js:186-251`) for a real prior bug: a plug-in variance
estimate from the same sequence under test is not a martingale under H0, so `alwaysValidPValue()`
now returns **two distinct, differently-named fields** depending on whether `sigma` was declared in
advance:

- `p_always_valid` + `anytime_valid: true` — only when the caller supplies `sigma`/`tau` from a
  holdout, in which case Ville's inequality genuinely holds and the number is valid to re-check at
  any later sample size.
- `p_fixed_sample_only` + `anytime_valid: false` — when `sigma` is estimated from the very sequence
  under test (the *only* case any caller currently exercises — see below), valid at exactly one
  declared look.

That distinction is then destroyed one call site later, in `runAudit()`:

```js
// server/services/audit-registry.js:219
const alwaysValidP = alwaysValid ? (alwaysValid.p_always_valid ?? alwaysValid.p_fixed_sample_only) : null;
const alwaysValidSignificant = alwaysValid ? alwaysValidP < correctedAlpha : null;
...
// :230-241 — persisted to ONE column
run(`UPDATE audit_registry SET ... always_valid_p=?, always_valid_significant=?, always_valid_n=? ...`,
    ..., alwaysValidP, ...);
```

`server/db/schema/core-and-fantasy.js:400-402` backs this with a single `always_valid_p REAL`
column — no `variance_source`, no `anytime_valid` flag, no declared sigma/tau persisted. `grep -rln
"always_valid_tau\|always_valid_sigma" server/` returns only `audit-registry.js` itself: **no
production caller has ever declared sigma in advance.** Every real audit that will ever run through
this path gets `p_fixed_sample_only` collapsed into a column named as if it were the anytime-valid
quantity, and `auditHistory()` (`:313`) reprints that same collapsed `always_valid_p` with no way
for a reader to recover which statistical guarantee it actually carries.

The second half of the same defect: the Šidák-corrected bar itself is computed and used but **never
persisted**.

```js
// :197-200 — computed fresh every runAudit() call, from audits already SEALED at this instant
const priorTests = row(`SELECT COUNT(*) AS n FROM audit_registry WHERE status='sealed'`)?.n ?? 0;
const correctedAlpha = 1 - Math.pow(1 - 0.05, 1 / Math.max(1, priorTests + 1));
```

`priorTests` counts audits by **execution order** (`runAudit()` call order), not by
**preregistration order**. Two audits preregistered on the same day, A and B — if a researcher
happens to execute B before A, B gets the lenient `priorTests=0` bar and A gets whatever stricter
bar B's completion produced, for a reason that has nothing to do with either hypothesis. And because
`corrected_alpha` is only ever stored implicitly, baked into the frozen boolean `significant`/
`passed`, `auditHistory()` (`:286`) recomputes its **own**, different, `corrected` from *today's*
total sealed count and reports `survive_correction` against that — silently disagreeing with the
threshold the audit was actually sealed against, with no field anywhere recording that the two
numbers differ or why. This is precisely "a preregistration gate's significance threshold silently
depends on run order because a sequential and a fixed-sample p-value get collapsed into one field":
the *type* of statistical guarantee (anytime-valid vs. fixed-sample-only) and the *alpha it was
judged against* are both erased into single, order-sensitive scalars.

Test coverage in `test/audit-registry-always-valid.test.js` and
`test/always-valid-significance.test.js` verifies the *statistics* are right (the mSPRT construction
does control false positives under continuous peeking) but never exercises two audits run out of
registration order, and never asserts that a sealed audit's stored `passed` matches what
`auditHistory()` says about it later — so the schema bug has no regression test today.

## Primary sources read in full

### 1. Howard, Ramdas, McAuliffe, Sekhon (2021), *Time-uniform, nonparametric, nonasymptotic
confidence sequences*, Annals of Statistics 49(2):1055–1080; arXiv:1810.08240 (v9, Aug 2022).
Read: abstract, §1 intro/outline, §2 (sub-ψ processes, Definition 1/2), §3.1 (stitched boundary,
Theorem 1), §5 Simulations, §6 "Implications for sequential hypothesis testing" (the section that
answers this task directly), §7 summary, references, Appendix A.1 proof of Theorem 1.

- **The fix-relevant result (§6, Lemma 3 + surrounding text):** confidence sequences, always-valid
  p-values (Johari et al. 2015), and sequential tests are three *dual* views of the same object —
  `P(∪_t {θ_t ∉ CI_t}) ≤ α` ⇔ `P(A_τ) ≤ α` for every stopping time τ ⇔ an always-valid p-value
  process `p_t` with `P0(p_τ ≤ α) ≤ α` for every stopping time. Crucially, **the running minimum of
  an always-valid p-value process, `min_{s≤t} p_s`, is itself always-valid** — this is the exact
  mechanism Gridiron's schema is missing: an anytime-valid quantity is a *monotone floor over the
  whole path*, not a single scalar that can be silently swapped for a different-regime scalar
  computed at one arbitrary stopping point.
- **The nonasymptotic result validated empirically (Fig. 1, Rademacher r.v., 100,000 i.i.d. draws,
  10,000 replications):** a pointwise-CLT interval checked continuously has cumulative miscoverage
  rising to roughly 0.65 by t=10^5 against a nominal α=0.05 line; the curved (stitched) confidence
  sequence stays essentially flat at the nominal 0.05 across the same 5 orders of magnitude of t,
  and (§1, last paragraph) "stays within a factor of two of the fixed-sample CLT bounds over five
  orders of magnitude in time" — i.e. the cost of true anytime-validity is under 2x width, not the
  unbounded cost the repo's own hand-rolled mSPRT plug-in currently risks by mislabeling a
  fixed-sample number as reusable.
- **Practical guidance directly usable in the schema fix:** §3.1's closed-form polynomial-stitched
  boundary (eq. 10) needs only `η>1`, `m>0`, and an increasing `h` with `Σ1/h(k)≤1` chosen *in
  advance* — no library, ~15 lines of JS, and it is exactly the object that should replace the
  single collapsed p-value with a genuine, storable, re-checkable *interval*.

### 2. Waudby-Smith & Ramdas (2024), *Estimating means of bounded random variables by betting*,
JRSS-B 86(1):1–27; arXiv:2010.09686 (v7, Aug 2022). Read: abstract, TOC, §1 introduction (the
"betting against the mean" framing and the fair-game construction), Figure 1 and its caption.

- **Key result (Fig. 1, Beta(10,30) draws, sample sizes n = 10 to 10^4, 95% CIs/CSs):** the
  "Hedged"/betting confidence sequence is visibly tighter than both the sub-Gaussian (Hoeffding-type,
  "PrPl-H") and empirical-Bernstein ("PrPl-EB") constructions from Howard et al. (2020) at every n in
  that range, in both the time-uniform (CS) and fixed-time (CI) rows — the paper states these
  betting approaches are the new state of the art across four related problems (CI/CS, with and
  without replacement).
- **Relevance:** Gridiron's CLV/backtest values are *bounded* (a spread or CLV point differential
  has a practical bound), which is exactly the regime this method targets and beats the
  Howard-et-al. construction in; it is the natural upgrade path once the schema correctly separates
  anytime-valid from fixed-sample quantities (source #1 above), not a substitute for that separation.

### 3. Ramdas, Zrnic, Wainwright, Jordan (2018/2019), *SAFFRON: an adaptive algorithm for online
control of the false discovery rate*, arXiv:1802.09098 (v2, Jul 2019; ICML 2018). Read: abstract,
§1 introduction (through the worked "1000 tests in one week, 80 discoveries, 50 false, FDP=5/8"
example), Figure 1 and its caption.

- **Key result (Fig. 1, simulation: p-values drawn as `P_i = Φ(-Z_i)`, `Z_i ~ N(μ_i,1)`, nulls
  `μ_i=0`, non-nulls `μ_i=3`, target FDR α=0.05, fraction of non-nulls π₁ swept 0.1→0.8):** SAFFRON
  and its non-adaptive predecessor LORD both hold empirical FDR at or below the nominal 0.05 across
  the whole π₁ range while power rises from ≈0.3 to ≈0.85; SAFFRON strictly dominates LORD and
  alpha-investing in power at every π₁ tested, the online analogue of Storey-BH beating BH offline.
- **Direct relevance to the run-order defect:** this entire literature (Foster & Stine 2008;
  Javanmard & Montanari's LORD; Ramdas et al.'s LORD++/SAFFRON) exists to solve *exactly* Gridiron's
  problem — hypotheses arrive one at a time in a known order and each must get an irrevocable
  accept/reject decision *without knowing how many more will ever be filed*, guaranteeing FDR
  control regardless of when the sequence stops. It is the principled replacement for a Šidák
  correction that (as built here) implicitly assumes a fixed, already-known family size and computes
  its bar from *execution* order rather than *arrival* (preregistration) order.

### 4. Johari, Pekelis, Walsh (2015/2019), *Always Valid Inference: Continuous Monitoring of A/B
Tests*, arXiv:1512.04922 (v3, Jul 2019); published as *Operations Research* 70(3), 2022 — the paper
Gridiron's own code already cites by name in `backtest-significance.js`. Read: abstract, §1
introduction in full (through the definition of the challenge being solved).

- **Key result quoted directly from the paper, not the repo's paraphrase of it:** "Even with 10,000
  samples (a sample size which is quite common in online A/B testing), Type I error can easily
  increase fivefold" under naive continuous monitoring with no correction — the concrete number
  behind the abstract claim, and the same failure mode `test/always-valid-significance.test.js`
  reproduces synthetically (naive rejection rate ≫ 0.05 under peeking).
- **Deployment scale:** the always-valid methodology "has been implemented in a large-scale
  commercial A/B testing platform to analyze hundreds of thousands of experiments" — i.e. this is
  production-hardened methodology, not an academic curiosity, which matters for a "token cost is not
  a constraint tonight, but production correctness is" project.

## Repos

| repo | stars | license | last push | what it is | adopt |
|---|---|---|---|---|---|
| gostevehoward/confseq | 84 | MIT | 2026-01-07 | Reference C++/R/Python implementation of the exact Howard-Ramdas-McAuliffe-Sekhon (2021) boundaries (stitched, conjugate-mixture, discrete-mixture) | **borrow-idea, not port** — Gridiron's backend is Node.js and the closed-form stitched boundary (paper eq. 10) is ~15 lines of arithmetic with no external dependency; porting a C++/Python library for one formula is not worth the binding overhead. Read the R implementation as a correctness check against a hand-written JS port before trusting it in `backtest-significance.js`. |

## Candidates

(4 tagged `fix`, grounded in the exact collapsing/run-order defect above; 3 tagged `new`,
capabilities Gridiron has none of today.)

1. **Split the collapsed `always_valid_p` field into two never-conflated columns.** Add
   `always_valid_p_anytime REAL`, `always_valid_p_fixed_sample REAL`,
   `always_valid_variance_source TEXT`, `always_valid_anytime_valid INTEGER` to `audit_registry`
   (`server/db/schema/core-and-fantasy.js:379-402`, plus the migration loop at `:785-789`); change
   `runAudit()` (`audit-registry.js:219,230-241`) to write into the field matching
   `alwaysValid.anytime_valid` and leave the other `NULL`, instead of `p_always_valid ??
   p_fixed_sample_only` into one shared column. `auditHistory()` (`:307-317`) must print both
   columns by name so a reader can see which regime produced the number without re-deriving it.

2. **Persist the corrected alpha and prior-test count an audit was actually sealed against.** Add
   `corrected_alpha_at_seal REAL`, `prior_tests_at_seal INTEGER` to the same table; write them in the
   `runAudit()` UPDATE (`:230-233`) alongside `significant`. `auditHistory()`'s `survive_correction`
   list (`:302`) should report both the frozen seal-time verdict and, separately and explicitly
   labeled `would_survive_current_correction`, the recomputed one — never merge them into one
   `passed` field the way `significant` currently is.

3. **Index the Šidák/multiplicity correction by preregistration order, not execution order.**
   Change `priorTests` (`:197`) from `COUNT(*) WHERE status='sealed'` (execution-order-dependent) to
   a count of audits *preregistered* strictly before this one's `preregistered_at`
   (`COUNT(*) WHERE preregistered_at < a.preregistered_at`), so which of several already-preregistered
   audits a researcher happens to run first no longer decides who gets the lenient bar. This is the
   minimal fix that removes literal run-order dependence from the existing Šidák machinery, grounded
   in HRMS 2021 §6's insistence (Lemma 3) that an anytime-valid guarantee cannot depend on which of
   several valid inspection orders was realized.

4. **Add a regression test asserting seal-time and later-history agreement.** Extend
   `test/audit-registry-always-valid.test.js` with a case that preregisters two audits, runs them out
   of preregistration order, and asserts (a) the always-valid field type (`always_valid_p_anytime`
   vs. `_fixed_sample`) is never null-coalesced across regimes, and (b) `auditHistory()`'s reported
   `survive_correction` for a sealed audit matches its own stored `corrected_alpha_at_seal` unless
   explicitly flagged as `would_survive_current_correction`-only. This test is what would have caught
   the original collapsing bug.

5. **[new] Online FDR control (LORD++/SAFFRON, Ramdas et al. 2018) replacing the fixed-family Šidák
   block wholesale.** Gridiron has no online multiple-testing procedure today — the Šidák correction
   in `auditHistory()` is a fixed-family method retrofitted onto a stream of hypotheses that keeps
   growing, which is exactly the mismatch source #3 diagnoses. Implement `saffron.js` in
   `server/services/` taking the ordered stream of `audit_registry` rows (by `preregistered_at`) and
   an alpha-wealth budget, returning a per-audit adaptive threshold `α_k` computed only from audits
   filed *before* k — a strict superset of what candidate #3 does, with the SAFFRON paper's own
   simulation (π₁ swept 0.1–0.8, power 0.3→0.85 at FDR≤0.05) as the calibration target for choosing
   the wealth schedule. Cost: 2-3 days (algorithm + the `preregister`/`runAudit` wiring + tests
   against the paper's own worked example). Expected value: replaces an ad hoc, already-known-broken
   correction with a peer-reviewed, ICML-published procedure that provably controls FDR without ever
   needing to know the eventual number of audits in advance — directly serves tonight's "no trial
   registry exists with real preregistration + multiplicity correction" finding for the 21-model
   historical search. Exit test: re-run the 21 historical model audits (retroactively preregistered
   in arrival order) through both the old Šidák path and the new SAFFRON path; ship only if SAFFRON's
   rejected set on that specific 21-hypothesis family is provably conservative on synthetic
   known-null data (replicate the paper's own π₁=0 case: empirical FDR must stay at 0 on pure noise).

6. **[new] Genuine anytime-valid confidence SEQUENCES (not just a p-value) for CLV.** Nothing in
   Gridiron today reports an interval that is valid to re-check at every additional game all season;
   `backtest-significance.js` only produces one scalar per call. Implement the HRMS 2021 closed-form
   polynomial-stitched boundary (paper eq. 10, §3.1) as `alwaysValidConfidenceSequence(sequence,
   {sigma, tau, eta, m, s})` returning `[lo, hi]` at the current n, callable identically at any later
   n without a fresh correction — and wire it into whichever of the five disagreeing CLV
   implementations owns the canonical CLV table, replacing that table's ad hoc p-value with a genuine
   interval that visibly shrinks as the season accumulates games. Cost: 3-5 days including picking
   which of the five CLV call sites becomes canonical (a prerequisite this candidate does not itself
   solve — see do-not-do). Expected value: turns "is our CLV real" from a one-shot yes/no into a
   number that gets more precise all season and is honestly interpretable the day it's checked, not
   just at a single unstated endpoint. Exit test: reproduce paper Figure 1's qualitative shape on
   synthetic Rademacher data (cumulative miscoverage of the naive interval rising well past α;
   the stitched CS staying flat) as a unit test before trusting it on real CLV data.

7. **[new] Adopt the betting/Hedged confidence sequence (Waudby-Smith & Ramdas 2024) for bounded
   backtest metrics.** Once #6 exists, the tighter betting construction is a drop-in upgrade for any
   Gridiron metric with a known bound (CLV point differential, cover-rate residuals) — Gridiron has
   no betting-style estimator anywhere today. Cost: 1-2 days once #6's plumbing exists (this is a
   different boundary function, not new infrastructure). Expected value: per the paper's own Fig. 1
   comparison, materially tighter intervals than the HRMS stitched bound at the same sample sizes
   Gridiron actually has (dozens to low hundreds of games per season), which matters most exactly
   when Gridiron's sample sizes are smallest. Exit test: on the same synthetic Beta(10,30)-style
   bounded sequence the paper uses, confirm the betting CS's width is ≤ the stitched CS's width at
   matched n before switching any production metric to it.

## Do not do

- Do not ship any of the new-capability confidence-sequence work (#6, #7) before the schema fix
  (#1-#3) lands — a tighter interval built on top of a field that still silently mixes anytime-valid
  and fixed-sample-only meanings just makes the ambiguity harder to notice, not smaller.
- Do not let `alwaysValidPValue`'s plug-in branch (`variance_source:
  'plugin_from_evaluated_sequence'`) be the one anything gates on in production without a human
  reading `anytime_valid` first — it is currently the *only* branch any caller exercises (no
  production code passes `always_valid_tau`/`always_valid_sigma`), so "always-valid" is presently a
  misnomer for every real audit in this system, not an edge case.
- Do not pick which of the five disagreeing CLV implementations is canonical as part of this ticket
  — that consolidation is its own audit (a different finding tonight) and mixing it into the
  confidence-sequence work risks shipping a correct interval on top of a table everyone agrees is the
  wrong one.
- Do not implement online FDR (#5) as a bolt-on that runs *alongside* the existing Šidák block; it
  must replace it — running both and taking the union or intersection reintroduces exactly the
  "which gate do I trust" ambiguity this whole ticket exists to remove.
- Do not treat `test/always-valid-significance.test.js`'s passing status as evidence the schema bug
  is fixed — that suite tests `backtest-significance.js`'s math in isolation and does not touch
  `audit_registry.js`'s persistence layer at all, which is where the actual collapsing happens.
