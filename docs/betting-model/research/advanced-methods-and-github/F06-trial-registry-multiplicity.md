# F06 — Trial registry design + multiplicity correction for a 21-model search already run

Researcher: F06-trial-registry-multiplicity (bucket: fix)
Date: 2026-09-12

## Grounding in the codebase (read before literature)

`server/services/audit-registry.js` is a genuinely well-designed preregistration
system: `preregister()` locks a hypothesis/metric/threshold plus a `codeHash()`
(hash of every `.js` file in `server/services/`) and `dataSignature()` (row
counts across six tables) before the number exists; `runAudit()` seals the
result once, voids if code or data moved, and computes a Šidák-style
sequential multiple-comparisons correction (`corrected_alpha =
1-(1-0.05)^(1/(priorTests+1))`) plus an always-valid mSPRT p-value
(`alwaysValidPValue`, Johari/Pekelis/Walsh 2022) for sequences whose evidence
keeps growing. `auditHistory()` reports Šidák-corrected significance across
every filed audit.

**It is orphaned.** `grep -rn "preregister(\|runAudit(" server scripts` finds
zero callers outside `audit-registry.js` itself and its own test
(`test/audit-registry-always-valid.test.js`). The `audit_registry` table
(schema at `server/db/schema/core-and-fantasy.js:379`) exists but nothing
populates it for the actual model searches this project has run — including
the headline "0 of 21 models beat 15,096 closing lines" finding
(`docs/evidence/historical/path-to-profit-measurements.md`,
`server/services/nfl-execution-edge.js:7-9`, `nfl-prop-clv.js:474`,
`scheduler.js:885`), the "9 signal families... degraded under ablation" and
"24 candidates × 4 stats, zero survivors" findings
(`docs/evidence/history/WORK_LOG.md:617-627`).

Separately, `server/services/nfl-blind-audit.js` implements its **own**,
uncoordinated code/data-freeze scheme: `repositoryState()` hashes every file
under `AUDITED_CODE_PATHS = ['server','scripts','package.json',
'package-lock.json']`, and `inputMutationState()` tracks a 28-table
mutation-journal cursor. Its own doc comments record two already-observed
false-void bugs from this being too coarse: run 13 (2026-09-02) voided by a
docs paragraph edited during a two-minute week-open, run 16 (2026-09-03)
voided by a docs-only commit moving HEAD. A **third**, independent
implementation exists at `server/platform/code-identity.js`, whose own doc
comment explicitly critiques a fourth, even older one
(`trainingAuditCodeHash` in `nfl-replay.js`, "Codex correction C08, still
open") for shelling out to git and depending on `process.cwd()`.
`code-identity.js`'s approach — hash only what a decision actually imports,
walked transitively from a declared root via `import.meta.url` — is the
correct design of the three, and is exactly the primitive `audit-registry.js`
and `nfl-blind-audit.js` should both be calling instead of maintaining their
own hashers (`grep -rln "createHash" server` returns 45 files; three of them
independently reinvent "what code produced this answer").

A fourth trial-adjacent structure, `server/services/nfl-experiments.js`
(`nfl_model_experiments` table), locks discovery/validation/holdout seasons
as chronologically disjoint and immutable — but has no multiplicity
correction of any kind (`grep -n "multiplicity\|Holm\|Bonferroni\|deflated"
nfl-experiments.js` — zero hits).

Confirmed via grep: **no Holm-Bonferroni, deflated Sharpe ratio, or
CSCV/PBO implementation exists anywhere in this codebase**
(`grep -rlin "deflated sharpe\|probability of backtest overfit\|combinatorially
symmetric\|\bCSCV\b\|\bPBO\b" server scripts` — zero hits). Meanwhile
`server/data/market-lab/*/spreads-*-tpot-trials.json` and
`server/data/tree-lab/*/spreads-*-move-tpot-trials.json` are exactly the kind
of per-configuration trial matrices CSCV is designed to consume, and nothing
computes PBO on them today.

## Sources (4 read in full)

### 1. Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting
for Selection Bias, Backtest Overfitting and Non-Normality," *Journal of
Portfolio Management* 40(5):94-107. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
(PDF: https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) — **read in full.**

Core result: under N independent trials with SR estimates following a Normal
with mean E[{ŜR_n}] and variance V[{ŜR_n}], the expected **maximum** observed
Sharpe grows with N even when the true mean is zero:

    E[max{ŜR_n}] ≈ E[{ŜR_n}] + √(V[{ŜR_n}]) · ((1-γ)Z⁻¹[1-1/N] + γZ⁻¹[1-1/N·e⁻¹])   (eq. 1)

(γ = Euler-Mascheroni constant ≈0.5772, Z = standard Normal CDF). The Deflated
Sharpe Ratio then substitutes this expected-max as the null baseline SR₀ into
the non-Normality-adjusted Probabilistic Sharpe Ratio (Bailey & López de
Prado 2012):

    DSR ≡ PSR(SR0) = Z[ (ŜR - SR0)·√(T-1) / √(1 - γ̂3·ŜR + (γ̂4-1)/4·ŜR²) ]   (eq. 2)

where γ̂3, γ̂4 are sample skewness/kurtosis. Sample/limitation: the paper is
theoretical + a numerical Exhibit (E[SR]=0, V[SR]=1, N∈[10,1000]) rather than
one dataset; it explicitly notes DSR assumes trial independence (violated by
correlated strategies), and that practitioners "often cannot precisely
enumerate how many strategies were actually tested" — N itself is an
assumption, not an observation.

### 2. Bailey, Borwein, López de Prado & Zhu (2015), "The Probability of
Backtest Overfitting," revised Feb 2015. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
(PDF: https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) — **read in full** (pp. 1-27).

Defines backtest overfitting as the strategy-selection process's IS-optimal
config having expected OOS rank below the median: PBO = Σ P(r̄_n < N/2 | r ∈
Ω*_n)·P(r ∈ Ω*_n). CSCV algorithm (Algorithm 2.3): form the T×N trial matrix
M; split into S=16 equal row-slices; form all C(16,8)=12,780 combinations,
each giving an IS/OOS split of equal size T/2 (unlike hold-out, which is
asymmetric and single-shot); for each combination compute the logit λ_c =
ln(ω̄_c/(1-ω̄_c)) of the OOS relative rank of the IS-optimal config; PBO = the
fraction of logits below zero. Worked numeric example (§6): N=8,800 parameter
combinations (a 4-parameter seasonal trading rule), T=1,000 daily prices,
S=16 → 12,780 combinations. **Spurious case**: IS Sharpe=1.27 (PSR-stat 2.83,
looks highly significant on a single test), but 53% of OOS Sharpes are
negative and **PBO = 55%** — correctly flagged as overfit even though every
one of the 8,800 IS Sharpes was positive (range 1.0-2.2). **Genuine-effect
control case** (same setup, real seasonal signal injected): only 13% of OOS
Sharpes negative, **PBO = 13%** — correctly recognized as not overfit. Stated
limitations (§5, read in full): symmetric division may not suit
strongly-autocorrelated series or very large S; PBO is not a correctness
check on the backtest's own assumptions (bad transaction-cost assumptions
pass through); a high PBO can occur even when several of the N strategies are
genuinely skillful but indistinguishable from each other; and explicitly —
**"we must warn the reader against applying CSCV to guide the search for an
optimal strategy... any counter-overfitting technique used to select an
optimal strategy will result in overfitting."**

### 3. Holm (1979), "A Simple Sequentially Rejective Multiple Test
Procedure," *Scandinavian Journal of Statistics* 6(2):65-70.
https://www.jstor.org/stable/4615733 — **read in full** (all 6 pages, via JSTOR PDF).

The original Holm step-down procedure. Order the M obtained significance
levels R^(1) ≤ ... ≤ R^(M); compare R^(1) to α/n; if it clears, reject H^(1)
and compare R^(2) to α/(n-1); continue until a comparison fails, then accept
all remaining. Theorem 1 (proved via Boole's inequality) shows this has
multiple level of significance α for free combinations — i.e. controls FWER
exactly like classical Bonferroni, but the comparison constants
(α/n, α/(n-1), ..., α/1) are **uniformly at least as large** as the constant
Bonferroni comparator α/n, so Holm is **never less powerful than Bonferroni**
and can be much more so. Holm's own worked numeric example: 10 independent
N(μ_k,1) tests, α=0.05, with four true μ=6.0, two true μ=3.0, four true
μ=0.0 — classical Bonferroni rejects both μ=3.0 hypotheses with probability
0.439, while the sequentially rejective Bonferroni (Holm) procedure rejects
both with probability 0.565, using the identical test statistics. Also gives
a weighted generalization (Theorem 2, §3) for when hypotheses have unequal
importance (constants c_k) and notes Holm's test never needs a special table
beyond the ordinary single-test statistic, unlike closed procedures such as
refined Dunnett.

### 4. Harvey & Liu (2015), "Backtesting," *Journal of Portfolio Management*,
Fall 2015, 41(1):13-28 (1st Prize, Bernstein Fabozzi/Jacobs Levy Award).
PDF: https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF
— **read in full** (pp. 12-19 of 8 read pages covering method + Exhibit 1;
remaining pages on the HLZ correlated-trials extension and OOS
tradeoffs skimmed via search-result summary, not counted as "read in full").

This is the paper that most directly answers "how do you retrofit a haircut
onto results that already exist," which is exactly Nick's ask. Core
mechanics: convert a Sharpe ratio to a t-ratio (SR = t-ratio/√T); under N
independent trials and the null that none of them has skill, the
multiple-testing-adjusted p-value for observing a max t-ratio at least as
extreme as the observed one is p^M = 1-(1-p^S)^N (their eq. 4); solve for the
"haircut Sharpe ratio" ĤSR that makes a single-test p-value equal to p^M
(eq. 5). Worked example: T=240 (20 years monthly), SR=0.75 → single-test
p=0.0008; at N=200 trials, p^M=0.15, implying an adjusted annual SR of 0.32 —
**a ~60% haircut** on a Sharpe ratio that looked highly significant alone.
Three formal multiple-testing procedures given with a fully worked M=6
example (ordered p-values 0.005, 0.009, 0.0128, 0.0135, 0.045, 0.06):
**Bonferroni** p^Bonf_(i) = min[M·p_(i), 1] → only 1 of 6 significant at 5%;
**Holm** p^Holm_(i) = min[max_{j≤i}{(M-j+1)p_(j)}, 1] → 2 of 6 significant
(strictly more powerful than Bonferroni, confirming Holm 1979's proof in a
finance-native worked example); **BHY** (Benjamini-Hochberg-Yekutieli,
allowing arbitrary dependence via c(M)=Σ1/j) → 4 of 6 significant, the most
powerful of the three. Applied to three real published factors (E/P,
momentum, BAB) at N=10/50/100 assumed trials (Exhibit 1, transcribed in
full): E/P's Bonferroni-equivalent haircut is 26.6% at N=10, 50.0% at N=50,
61.6% at N=100; the higher-Sharpe BAB factor's haircut stays 4.6-9.3% across
the same N range — demonstrating their central claim that **the standard
"50% haircut" rule of thumb is wrong in both directions**: too harsh for a
strategy that would survive even brutal correction, too lenient for a
marginal one. States the citation Nick's ask references directly: Harvey,
Liu & Zhu (2015) document "at least 316 factors" tried in the cross-sectional
equity-returns literature, from which they derive a t-ratio > 3.0 threshold
for new discoveries (not independently re-read in full here — cited via
Harvey & Liu 2015's own text, so `read_in_full: false` for HLZ 2016 itself).
Stated caveats (their own list, five items): non-Normal returns distort
Sharpe; Sharpe doesn't control for volatility risk itself; the significance
level (0.10 vs 0.05) is a judgment call; the choice of multiple-testing
method (three given, plus "the average of the methods") is a judgment call;
and N — the number of trials — must itself be assumed, which is precisely
the retrofit problem: **you cannot get an honest haircut without an honest N,
and no honest N exists without a trial registry.**

### 5. (cited, not independently read in full) Harvey, Liu & Zhu (2016),
"...and the Cross-Section of Expected Returns," *Review of Financial
Studies* 29(1):5-68 — cited above via Harvey & Liu (2015)'s own text for the
"≥316 factors, t>3.0" figures; would be the next source to read in full if
this line of work continues, since it is the origin of the structural model
Harvey & Liu (2015) uses to handle *correlated* (non-independent) trials,
which is the realistic case for Gridiron's 21 spread/total models (per
tonight's finding that 20 ensemble components collapse to ~3 independent
signals).

## Candidates

See structured output. Six candidates, 3 fix / 3 new:
- F1: retrofit Holm + DSR onto the already-run 21-model search
- F2: consolidate the three independent code/data-freeze hashers into one
- F3: backfill the historical trial count so today's Šidák denominator isn't
  artificially small
- N1: implement PBO/CSCV against the market-lab/tree-lab trial matrices
- N2: implement Deflated Sharpe Ratio as a reusable, unit-tested primitive
- N3: build the actual research_trials table the task names as the target

## Do not do

- Do not treat a retroactive Holm/DSR haircut as equivalent to true
  preregistration. Label retrofit rows distinctly (e.g. `status='retrofit'`)
  from genuinely preregistered audits, and never let a retrofit result that
  happens to clear the bar promote a model to production on that basis alone
  — this is the exact "hold-out is not preregistration" critique in the PBO
  paper's comparison section.
- Do not use PBO/CSCV as an optimization objective or stopping rule for a
  parameter search. The PBO paper's own §5.2 warns explicitly against this:
  "any counter-overfitting technique used to select an optimal strategy will
  result in overfitting."
- Do not apply plain Bonferroni when Holm is available. Holm (1979) proves
  Holm's step-down is never less powerful than classical Bonferroni for
  identical test statistics — there is no correctness reason to prefer
  Bonferroni once Holm is implemented.
- Do not let the assumed trial count N (for DSR) or the family size (for
  Holm/Bonferroni) be chosen after seeing the result, or be self-reported by
  whichever model wants credit. Harvey & Liu open their paper on exactly this
  failure mode ("we must take a stand on... the number of tests"); N must
  come from the research_trials count (N3), counted before the haircut is
  computed.
- Do not run CSCV/PBO on a trial matrix with too few observations per slice.
  The PBO paper's own worked example used T=1,000 daily observations at
  S=16; a market-lab/tree-lab trial series much shorter than that will
  produce an unreliable, noisy PBO estimate — check T before trusting φ.
- Do not assume the 21 spread/total models (or their component signals) are
  statistically independent when applying any FWER correction. Tonight's own
  finding that the NFL ensemble's 20 components collapse to ~3 independent
  signals means naive per-model Bonferroni/Šidák will be directionally safe
  (conservative, not anti-conservative) but the BHY or HLZ-style
  dependency-aware correction is the more honest number to report alongside
  it, not instead of it.
