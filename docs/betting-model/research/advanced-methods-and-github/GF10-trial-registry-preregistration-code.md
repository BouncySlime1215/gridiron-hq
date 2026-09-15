# GF10 — Trial registry / preregistration code survey

Task: find real preregistration/experiment-registry code + deflated-Sharpe/PBO reference
implementations, and specify the exact schema for a new `research_trials` table that fixes
tonight's finding: **"No trial registry exists with real preregistration + multiplicity
correction (Holm/PBO/deflated-Sharpe) for the 21-model historical search that has already
been run."**

## What Gridiron already has (read-only recon, not part of the ask but required to design the
right attachment point)

- `server/migrations/004_model_lab.js` → `model_experiments` / `model_predictions` /
  `model_production_pointer`. Fantasy-projection walk-forward registry only. No trial count,
  no DSR/PBO, no multiplicity correction, no notion of "trials that compete for one alpha
  budget."
- `server/migrations/024_candidate_findings.js` → `nfl_candidate_findings` +
  `nfl_candidate_finding_seasons`. A state machine (`pending_confirmation → discovered →
  validating → validated → flagged_for_review → promoted/rejected`) with `code_hash`/`data_hash`
  and a DB-enforced rule that a season can never change role (discovery vs. holdout) once used.
  This is the closest existing analogue to "preregistration + no p-hacking," but it is scoped to
  one segment-bias finding at a time, not a registry of competing model/strategy trials.
- `server/migrations/027_decision_tape.js` → `nfl_decision_runs` / `nfl_decision_events`,
  append-only (triggers `RAISE(ABORT, …)` on UPDATE/DELETE), content-addressed by `board_hash`
  (hash of every decision + policy identity), plus `code_hash`/`data_hash`. This is Gridiron's
  house style for "immutable evidence tape," and the schema below follows it directly.
- `server/data/{book-lag-lab,expert-selector-lab,market-lab,role-scenario-lab,tree-lab}/` — five
  ad hoc research labs, each with its own `preregistered.json` (hypothesis, baselines, failure
  criteria, split policy, selection rule, declared_at) written **before** scoring, then
  `report.json` (adds `code_hash`, `dataset_hash`, results) and a `latest.json` pointer. This is
  a genuinely good, already-invented preregistration convention — it is just per-lab JSON on
  disk, not a queryable table, and nothing aggregates trial counts *across* labs for an honest
  multiplicity correction. The 21-model historical search this task is meant to fix is exactly
  the kind of cross-lab count that currently has nowhere to live.

Conclusion: Gridiron does not need to invent preregistration from scratch — it needs to (1)
promote the existing per-lab JSON convention into a real table, (2) add the trial-count /
multiplicity-correction layer that convention never had, and (3) let the count be honest about
correlated trials (an iterative model search is not independent draws).

## Repos read

### 1. quantskills/skill-backtest-overfit
- License: GPL-3.0. Stars: 34. Last commit: 2026-07-16 (pushed_at from `gh api`).
- What it is: a **Claude Skill package** (`SKILL.md` + `scripts/`), not a service — five
  standalone scripts: `deflated_sharpe.py`, `pbo_cscv.py`, `haircut.py`, `purged_kfold.py`,
  `overfit_report.py`. No database, no persistence, no registry — pure statistics.
- Verified by reading (not the README):
  - `scripts/deflated_sharpe.py` — textbook Bailey & Lopez de Prado (2014) DSR: `sharpe_ratio`
    (per-period, ddof=1), `_skew_kurt` (sample skew + non-excess kurtosis), `probabilistic_sharpe_ratio`
    (PSR via the Lopez de Prado (2012) SR-estimator standard error), `expected_max_sharpe` (the
    extreme-value E[max SR] formula using Euler–Mascheroni γ, requires
    `sr_variance_across_trials`), `deflated_sharpe_ratio(strategy_returns, n_trials,
    sr_variance_across_trials=None, all_trial_sharpes=None, threshold=0.95)` → `DSRResult`
    dataclass (`observed_sharpe, deflated_benchmark_sr0, psr_vs_zero, deflated_sharpe_ratio,
    n_obs, n_trials, skew, kurtosis, passed`). Falls back to a *lower-bound* variance estimate
    when `all_trial_sharpes` isn't supplied and says so in a comment — an honesty detail worth
    copying literally: DSR without real per-trial Sharpes is lenient, not conservative.
  - `scripts/pbo_cscv.py` — correct CSCV/PBO (Bailey, Borwein, Lopez de Prado, Zhu 2017):
    splits a `(T obs × N strategies)` performance matrix into `n_blocks` contiguous blocks,
    enumerates every way to pick half as in-sample, ranks strategies IS, finds the IS-winner's
    OOS relative rank, converts to a logit, and `PBO = fraction of splits where logit <= 0`.
    Self-test in `__main__` confirms PBO ≈ 0.5 on pure noise and drops sharply with one real
    edge column — i.e. the implementation was checked against its own known-answer case, not
    just asserted correct.
  - `scripts/haircut.py` — Harvey & Liu (2015) multiple-testing haircut: converts Sharpe → t-stat
    → p-value (`norm.sf`, not `1-cdf`, specifically to avoid p-value underflow to exactly 0 at
    large |t| — a numerically-aware detail), then implements **all three** adjustment methods
    Nick's notes call out as missing: `bonferroni` (`p*N`), `holm` (`p*(N-rank+1)`, rank-aware),
    and `bhy` (Benjamini-Hochberg-Yekutieli with the harmonic-number correction for dependence).
    Maps the adjusted p-value back to an adjusted Sharpe.
  - `scripts/overfit_report.py` — orchestrates all four (DSR, haircut, PBO, MinTRL) into one
    `verdict` string (`"PASS…" / "FAIL - likely overfit…: <flags>"`). This is the shape a
    `research_trials` "corrected result" row should hold, not the shape of the trial ledger
    itself — it takes a returns array in memory, it doesn't read or write a database.
- Adopt: **reference-only / borrow-idea** for the statistics; there is no persistence layer to
  port. Concrete Gridiron attachment: the math in `deflated_sharpe.py` + `haircut.py` +
  `pbo_cscv.py` is what should compute the values written into
  `research_trial_corrections` below (see schema). Do not call this package's code directly
  (it's a skill bundle, not an installable library) — reimplement the same formulas as a small
  `server/services/research-stats.js`/Python module; the formulas are short and public-domain
  academic results, and the file-level docstrings here are good enough to reimplement from
  without copying code verbatim (GPL-3.0 would otherwise require this to be released as
  GPL if linked, which is a real constraint were code copied wholesale into gridiron's proprietary
  server).

### 2. eslazarev/purged-cross-validation (`purgedcv`)
- License: MIT. Stars: 33. Last commit: 2026-09-04 (i.e. updated within the past week, by far the
  most actively maintained of the four).
- What it is: a real, tested, sklearn-compatible Python package (`src/purgedcv/`) — purging,
  embargo, `CombinatorialPurgedCV`, PBO, DSR, path-metrics, an Optuna integration. Has a `paper/`
  directory with figures and a citation file — this is closer to a small research software
  artifact than a toy script.
- Verified by reading:
  - `src/purgedcv/_pbo.py` — PBO built directly on top of `CombinatorialPurgedCV` (CSCV is just
    CPCV with `n_test_groups = n_splits // 2`), so purge/embargo boundaries are respected inside
    the PBO computation itself — the quantskills version above does *not* purge/embargo its CSCV
    blocks, so on serially-correlated data (all of Gridiron's game-level series) this repo's PBO
    is the more defensible one. Also computes a `slope` diagnostic (OLS slope of OOS-vs-IS
    performance for the IS-best config across combinations): slope > 0 means in-sample strength
    genuinely carries over, slope < 0 means in-sample strength *predicts* out-of-sample weakness
    — a sharper single-number overfitting signal than PBO alone.
  - `src/purgedcv/_metrics.py` — `deflated_sharpe_ratio` / `deflated_sharpe_ratio_full` /
    `effective_n_trials`. The standout: **`effective_n_trials(trial_sharpes, method="autocorr")`**
    — estimates the number of *independent* trials behind a correlated/sequential search (TPE,
    CMA-ES, or — directly relevant — Gridiron's own iterative 21-model historical search) via
    the integrated-autocorrelation-time heuristic (`n_eff = n / (1 + 2*sum rho_k)`, Geyer 1992
    initial-positive-sequence truncation). This is the single most important idea in this
    survey for Nick's exact situation: the 21 models in Gridiron's historical search were not
    21 independent draws (each was built informed by the last one's results), so feeding `21`
    directly into DSR/Holm as `n_trials` is *both* wrong directions at once — too small if you
    think of it as "should have been more trials really tried" and too literal if you assume
    independence that never held. `effective_n_trials` is the honest middle path and it has a
    runnable doctest confirming a correlated (cumulative-sum) series returns a smaller effective
    count than an independent one, on real numbers.
  - `src/purgedcv/optuna_integration.py` — `TrialSharpeRecorder`: an Optuna study callback that
    is, functionally, a minimal in-memory trial ledger — `n_trials()`, `n_effective()`,
    `var_sharpe()`, reading `trial.user_attrs["sharpe"]` off each trial. This is the shape a
    "trial" row needs at minimum (an id, a recorded per-trial performance value, in run order,
    plus whatever params produced it) — it's the direct precedent for `research_trials`'
    `per_trial_sharpe` / `trial_sequence` columns and for computing `n_effective_trials` at the
    study level rather than trusting the raw `COUNT(*)`.
  - `examples/optuna_dsr_cookbook.py` confirms the wiring end-to-end and calls out the two traps
    explicitly in its docstring: (1) annualized-vs-per-period Sharpe unit mismatches between what
    you record and what DSR expects, (2) correlated-trial inflation of the raw count. Both traps
    are exactly the kind of thing that produces "5 independent, disagreeing CLV implementations"
    — Gridiron's existing failure mode — if the schema doesn't pin the unit convention down as a
    column rather than a comment.
- Adopt: **port the concept, call the math**. `effective_n_trials` and `deflated_sharpe_ratio_full`
  are small, pure, dependency-light (numpy + scipy) functions — MIT-licensed, safe to port as-is
  into a Node/Python research-stats module. `TrialSharpeRecorder`'s *shape* (not its Optuna
  binding) is the direct template for `research_trials`. Concrete attachment: the
  `research_trial_corrections.effective_n_trials` column (below) should be computed by a ported
  version of `effective_n_trials`, fed the `per_trial_sharpe` sequence in the order each of the
  21 (or however many) trials in a study was actually run — not alphabetically, not by best-first.

### 3. Aliipou/backtest-audit
- License: none declared in the repo (no LICENSE file; GitHub API confirms `license: null`) —
  **all rights reserved by default; do not copy code without asking the author**, reference-idea
  only.
- Stars: 7. Last commit: 2026-05-17.
- What it is: a real installable package (`pyproject.toml`, Dockerfile, CI, `tests/` with 9 test
  files) that orchestrates DSR + PBO + Monte-Carlo permutation + sensitivity + walk-forward +
  regime + robustness into one `AuditReport`.
- Verified by reading:
  - `src/backtest_audit/auditor.py` — `AuditReport.overall_risk_score()`: maps each sub-test's
    categorical verdict (`PASS/WARN/FAIL`) to a continuous risk score (`0.0/0.4/0.8`), averages
    across whichever tests ran, and documents the intended consumer directly in the docstring:
    `position_size = base_size * (1 - risk_score)`. This is a genuinely useful pattern for
    Gridiron's *staking guardrail* (already flagged as existing in the betting model), but it is
    a naive equal-weight average of verdicts, not a principled combination — worth borrowing the
    idea (a single scalar the staking layer can read) without borrowing the specific averaging.
  - `src/backtest_audit/backup.py` — `export_json`/`export_csv`/`save_snapshot`: flattens a report
    to `(test, metric, value, verdict)` rows and writes timestamped JSON snapshots keyed by a
    `strategy_id` string to `~/.backtest_audit/backups/`. This is a file-based, single-user,
    non-queryable "registry" — exactly the failure mode Gridiron's own five `*-lab/` directories
    already have (JSON files, no SQL, nothing joins across strategies). Confirms (rather than
    contradicts) that a real DB table is the right fix, not more JSON.
  - No Holm/Bonferroni anywhere in this repo (confirmed via grep) — its "multiple testing"
    coverage is DSR + PBO + Monte-Carlo permutation only.
- Adopt: **reference-only** (no license to port code under) + **borrow-idea** for
  `overall_risk_score` → `research_trial_corrections.risk_score` as a convenience column derived
  from the DSR/PBO/Holm verdicts already stored, and for the `(test, metric, value, verdict)`
  flat-row shape as the audit trail for *how* a verdict was reached (kept in Gridiron's own
  `nfl_decision_events`-style append-only child table rather than a CSV export).

### 4. mnemox-ai/deflated-sharpe
- License: Apache-2.0. Stars: 7. Last commit: 2026-03-21.
- What it is: a small, pure-Python (no numpy/scipy dependency — hand-rolled `_norm_cdf`) DSR +
  FDR package: `gates.py` has `deflated_sharpe_ratio`, `min_backtest_length`,
  `benjamini_hochberg`.
- Verified by reading:
  - `deflated_sharpe_ratio(observed_sr, num_trials, num_obs, skewness=0, kurtosis=3)` — uses a
    **different** approximation for `E[max SR]` than quantskills'/eslazarev's: a closed-form
    Gumbel/extreme-value log approximation (`z = sqrt(2*ln(M))`, `E[Z_max] ≈ z -
    (ln(ln(M))+ln(4π))/(2z)`) rather than the empirical `sr_variance_across_trials`-based formula
    the other two use. Both are legitimate but **numerically different** on the same inputs —
    this repo assumes `num_trials` independent trials with unit-variance Sharpe estimates baked
    into the closed form, while quantskills/eslazarev take the actual cross-trial Sharpe variance
    as an input and are therefore more correct when trials are not homoskedastic (which Gridiron's
    aren't — different model families have very different Sharpe variance). This is a real,
    literature-level example of exactly the "5 disagreeing implementations, different math" problem
    Nick's notes flag for CLV — it exists for DSR too, one repo over. **Do not adopt this specific
    DSR formula**; adopt eslazarev's or quantskills' variance-based one, and pin the choice in
    code and in the schema (a `method` column, see below) so a second implementation can never
    silently coexist ungoverned the way the five CLV implementations did.
  - `benjamini_hochberg(p_values, alpha=0.05)` — standard BH-FDR, returns
    `(original_index, p_value, significant)` tuples sorted back to original order. Correct and
    simple; a clean second option alongside quantskills' `bhy` (Benjamini-Hochberg-Yekutieli,
    which additionally corrects for dependence among tests via the harmonic-number factor —
    the more conservative and more appropriate one for Gridiron since trials sharing training
    data/features are not independent tests).
- Adopt: **reference-only** (confirms which DSR formula variant to avoid) + the FDR function is
  a fine small reference for `benjamini_hochberg` if BH (rather than BHY or Holm) is ever wanted,
  but Holm (from quantskills, rank-aware, no independence assumption) is the right default for
  Gridiron given its trials are known to share data.

## The exact schema

Three tables, following Gridiron's own established conventions (content-addressed hash primary
keys / append-only evidence tables with `RAISE(ABORT,…)` triggers / `_json` blob columns / a
`method` column wherever more than one valid formula exists, per the mnemox-ai finding above).

```sql
-- One row per bounded multiplicity budget: a declared set of trials that
-- compete for the SAME "is there real edge here" question, so DSR/PBO/Holm
-- have a well-defined n_trials denominator. Mirrors *-lab/preregistered.json's
-- fields, promoted from per-lab JSON files into one queryable table across
-- fantasy, betting-model, props, and simulation work alike.
CREATE TABLE IF NOT EXISTS research_studies (
  id TEXT PRIMARY KEY,                    -- e.g. 'nfl-ensemble-2026-historical-search'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  domain TEXT NOT NULL CHECK(domain IN
    ('fantasy','betting-model','betting-execution','props','simulation','audit-method','infrastructure')),
  economic_hypothesis TEXT NOT NULL,      -- free text, required before any trial may attach
  baselines_json TEXT NOT NULL,           -- e.g. '["market_only","static_equal_weight","existing_coordinator"]'
  failure_criteria_json TEXT NOT NULL,    -- what counts as a negative result, stated up front
  selection_rule TEXT NOT NULL,           -- e.g. "declared an improvement only if DSR>=0.95 AND PBO<=0.5 AND ..."
  split_policy TEXT NOT NULL,             -- e.g. "chronological walk-forward by season, ..."
  return_unit TEXT NOT NULL CHECK(return_unit IN ('per_period','annualized')),
  periods_per_year INTEGER,               -- required when return_unit='annualized' (mnemox-ai trap #1)
  declared_at TEXT NOT NULL,              -- must be <= the first trial's declared_at (enforced in app code
                                           -- the same way *-lab/preregistered.json is written before scoring)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','closed_passed','closed_failed','closed_abandoned')),
  closed_at TEXT,
  note TEXT
);

-- One row per trial (one model config / one strategy variant / one feature
-- set) within a study. Append-only, like nfl_decision_events: a trial is
-- PREREGISTERED (declared_at, hypothesis-relevant fields set) before it is
-- ever scored; scored_at/result fields start NULL and are filled exactly
-- once. A changed trial is a NEW ROW, never an UPDATE to an old one -- this
-- is what makes "declared before scoring" independently checkable later
-- instead of just claimed in a doc comment.
CREATE TABLE IF NOT EXISTS research_trials (
  id TEXT PRIMARY KEY,                    -- content-addressed: hash(study_id + config_json + code_hash)
  study_id TEXT NOT NULL REFERENCES research_studies(id),
  trial_index INTEGER NOT NULL,           -- 1-based order this trial was actually run in, within the study;
                                           -- REQUIRED (not inferred from id/timestamp) because
                                           -- effective_n_trials (purgedcv._metrics) needs true run order,
                                           -- and a search that reruns/retries can otherwise reorder by clock
  config_json TEXT NOT NULL,              -- the model/strategy configuration this trial is
  code_hash TEXT NOT NULL,                -- hash of the code that produced it (nfl_decision_runs convention)
  dataset_hash TEXT NOT NULL,             -- hash of the exact data slice used (report.json convention)
  declared_at TEXT NOT NULL,              -- preregistration timestamp: BEFORE scored_at, enforced by CHECK below
  scored_at TEXT,                         -- NULL until scoring completes; set exactly once
  n_obs INTEGER,                          -- observations in the scored return series
  per_period_sharpe REAL,                 -- ALWAYS per-period (return_unit is fixed at the study level);
                                           -- annualized values are never stored raw, only derived on read
  skewness REAL,
  kurtosis REAL,                          -- non-excess (normal = 3), matches quantskills/eslazarev convention
  returns_ref TEXT,                       -- pointer to where the full per-period return series lives
                                           -- (a table:id or file path) -- summary stats alone can't be
                                           -- re-aggregated into a study-level variance later
  is_holdout INTEGER NOT NULL DEFAULT 0 CHECK(is_holdout IN (0,1)),
  status TEXT NOT NULL DEFAULT 'declared'
    CHECK(status IN ('declared','running','scored','failed','withdrawn')),
  note TEXT,
  UNIQUE(study_id, trial_index),
  CHECK (scored_at IS NULL OR scored_at >= declared_at)
);
CREATE INDEX IF NOT EXISTS idx_research_trials_study ON research_trials(study_id, trial_index);

CREATE TRIGGER IF NOT EXISTS research_trials_no_update
  BEFORE UPDATE OF config_json, code_hash, dataset_hash, declared_at, per_period_sharpe,
                   skewness, kurtosis, n_obs ON research_trials
  BEGIN SELECT RAISE(ABORT, 'a scored trial is immutable — declare a new trial instead'); END;
CREATE TRIGGER IF NOT EXISTS research_trials_no_delete
  BEFORE DELETE ON research_trials
  BEGIN SELECT RAISE(ABORT, 'trials are append-only evidence — withdraw via status instead'); END;

-- One row per (study, correction_method, computed_at): the actual
-- DSR/PBO/Holm verdict for the study AS OF that many trials. Append-only
-- and re-inserted (never updated) every time a new trial is added to an
-- open study, so the correction's history is itself an audit trail --
-- this is the concrete guard against "kept re-running the correction until
-- it passed and only kept the last one," which an UPDATE-in-place table
-- cannot detect after the fact and this can.
CREATE TABLE IF NOT EXISTS research_trial_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id TEXT NOT NULL REFERENCES research_studies(id),
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  selected_trial_id TEXT NOT NULL REFERENCES research_trials(id), -- the IS-best trial being judged
  raw_n_trials INTEGER NOT NULL,          -- COUNT(*) of trials in the study at computed_at
  effective_n_trials INTEGER NOT NULL,    -- purgedcv-style autocorrelation-corrected count;
                                           -- equals raw_n_trials when trials were run independently
  effective_n_method TEXT NOT NULL DEFAULT 'autocorr',
  dsr_method TEXT NOT NULL CHECK(dsr_method IN ('variance_based','gumbel_closed_form')),
                                           -- pins WHICH DSR formula (mnemox-ai vs quantskills/eslazarev
                                           -- disagree) was used, so two can never silently coexist ungoverned
  sr_variance_across_trials REAL,         -- required input when dsr_method='variance_based'
  deflated_sharpe REAL,                   -- DSR / PSR-vs-deflated-benchmark, in [0,1]
  dsr_pass INTEGER NOT NULL CHECK(dsr_pass IN (0,1)),
  pbo REAL,                               -- probability of backtest overfitting, in [0,1]; NULL if
                                           -- the study has < 2 comparable trials to run CSCV over
  pbo_n_blocks INTEGER,
  pbo_slope REAL,                         -- purgedcv's OOS-vs-IS slope diagnostic; sign matters more than PBO alone
  multiplicity_method TEXT NOT NULL CHECK(multiplicity_method IN ('bonferroni','holm','bhy','benjamini_hochberg')),
  raw_pvalue REAL,
  adjusted_pvalue REAL,
  adjusted_sharpe REAL,
  min_track_record_length REAL,           -- observations still needed to trust SR>0 at the study's confidence level
  risk_score REAL CHECK(risk_score BETWEEN 0.0 AND 1.0), -- for the staking guardrail: base_size*(1-risk_score)
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','inconclusive')),
  verdict_detail TEXT NOT NULL,           -- human-readable reasons, e.g. overfit_report.py's flags list
  code_hash TEXT NOT NULL                 -- hash of the research-stats module version that computed this row --
                                           -- a formula bug fix must show up as a NEW row, not a retroactively
                                           -- "corrected" old one
);
CREATE INDEX IF NOT EXISTS idx_research_trial_corrections_study
  ON research_trial_corrections(study_id, computed_at);

CREATE TRIGGER IF NOT EXISTS research_trial_corrections_no_update
  BEFORE UPDATE ON research_trial_corrections
  BEGIN SELECT RAISE(ABORT, 'corrections are append-only — recompute and insert a new row'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_corrections_no_delete
  BEFORE DELETE ON research_trial_corrections
  BEGIN SELECT RAISE(ABORT, 'corrections are append-only — recompute and insert a new row'); END;
```

Notes on the design decisions that matter:
- `research_studies.declared_at` + `research_trials.declared_at` + the
  `scored_at >= declared_at` CHECK is the actual enforcement of "preregistered before scoring" —
  a database constraint, not a comment, following `024_candidate_findings.js`'s
  `nfl_candidate_finding_seasons` precedent of putting the anti-p-hacking rule in the schema
  itself.
- `trial_index` (true run order) + `effective_n_trials`/`effective_n_method` exist specifically
  because Gridiron's 21-model search was iterative, not a parameter grid drawn independently —
  feeding raw `21` into DSR/Holm would be dishonest in the *lenient* direction if the models were
  actually more correlated than that suggests (as an iterative search typically is), and honest
  correction requires the autocorrelation-based effective count from purgedcv, computed over the
  trials in the order they were actually tried.
- `dsr_method` and `multiplicity_method` are both explicit enum columns, not implicit code
  choices, specifically because this survey found two different DSR formulas and three different
  multiplicity corrections across four small repos, mirroring the five disagreeing CLV
  implementations already flagged in Gridiron. The schema makes the choice visible and singular
  per row instead of letting a second formula creep in through a different code path later.
- `research_trial_corrections` is append-only and keyed by `computed_at`, not upserted per study,
  so that adding trial #22 after seeing #1-21's correction fail is visible forever as
  "correction #1 failed, correction #2 (after 22 trials) ___" rather than silently overwriting
  the unfavorable first result.
