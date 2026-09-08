"""Is this fold big enough to fit this model? Asked before the fit, recorded either way.

docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md part 3.1 names the gap this
fills: nothing in this project enforced a ratio between the rows a fold
actually has and the number of input columns a model is allowed to search
over. The proposal that prompted it wanted a flat 15:1 with automatic PCA/
Lasso compression above the line. Part 3.1 explicitly refuses to import that
constant blindly, and part 3.2 shows why with a real number: `tree_lab.py`'s
`min_child_samples=25` is 7.6% of the smallest training fold and 2.8% of the
largest, so a single constant is tightest exactly where it is needed least.

THE ONE IDEA THIS MODULE IS BUILT AROUND
----------------------------------------
`rows / feature_count` is the wrong numerator. What constrains a fit is not
how many rows exist but how many INDEPENDENT PIECES OF INFORMATION ABOUT THE
LABEL they carry, and that quantity is different for every target type this
research program fits. A cover/over fold with 660 rows and 40 positive labels
does not have 660 observations for this purpose; it has 40. The whole point of
the module is that `effective_observations` answers that question per target
type, and everything else is bookkeeping around it.

WHY EACH TARGET TYPE GETS A DIFFERENT NUMERATOR
-----------------------------------------------
`continuous_regression` -- opening-to-closing movement (`market_lab.py`,
    `tree_lab.run_movement`), next-move size (`book_lag_lab` target 1), the
    market residual the selector predicts. Effective N is the row count
    discounted ONLY for clustering (below). It is NOT discounted for how
    concentrated the label is, and that is a deliberate asymmetry with the
    classification case: the precision of a regression coefficient is driven
    by X'X and the residual variance, not by the label's own distribution, so
    a game whose line never moved is a real observation of "no move here" and
    constrains the fit exactly as much as a game that moved three points.
    (A constant label is the exception and is reported as zero effective
    observations -- there is nothing left to predict.) The concentration is
    still MEASURED and reported as `mass_at_mode`, because it matters for
    reading the result even though it does not change the bar.

`binary_classification` -- cover/over (`tree_lab.run_classification`), the
    market-anchored logit branch, next-move probability (`book_lag_lab`
    target 1). Effective N is the MINORITY CLASS COUNT, not the row count.
    The curvature of the logistic log-likelihood in any coefficient scales
    with p(1-p); rows from a class that is nearly absent contribute almost
    nothing to pinning a coefficient down, which is why the events-per-
    variable literature (Peduzzi et al. 1996, and every replication since)
    counts events rather than subjects. Consequence, stated because it is the
    concrete difference from a flat rule: this project's cover/over target is
    near 50/50 by construction -- the market prices it that way -- so
    requiring 10 events per column is requiring about 20 ROWS per column,
    which is STRICTER than the proposal's flat 15:1, not a loosening of it.
    On a genuinely rare target (a book moving its line in the next poll) the
    same rule demands many multiples of that, which is the entire point.

`discrete_time_hazard` -- `book_lag_lab`'s time-to-follow model. Its design
    matrix has one row per (move, follower, step-at-risk), so a single race
    that takes eight polls to resolve contributes eight rows and exactly one
    event. Effective N is the number of FOLLOW EVENTS, for the same reason a
    survival model's power is quoted in deaths and not in patient-years.
    Delegates to the classification rule once the events are counted.

`quantile_regression` -- `tree_lab.run_quantile`. The asymptotic variance of
    a tau-quantile estimate goes as tau(1-tau)/f(q_tau)^2: the information
    about the 10th percentile lives in the roughly 10% of rows near and below
    it, not in all of them. Effective N is therefore `n * min(tau, 1-tau)`,
    evaluated for every tau in the grid, and the BINDING tau (the most
    extreme one) decides the verdict, because this project fits one model per
    quantile and reports them as one coherent set. With QUANTILES =
    [.1,.25,.5,.75,.9] a 900-row fold has ~90 effective observations for its
    hardest quantile, not 900 -- a tenfold difference from the naive count,
    and the difference between a fit that is comfortably supported and one
    that is not.

`simplex_weights` -- `expert_selector_lab`'s non-negative sum-to-1 ridge.
    Two corrections to the naive count, in opposite directions. (1) The
    parameter count is J-1, not J: the sum-to-1 equality constraint removes
    one degree of freedom, so a seven-expert stack is fitting six free
    numbers. (2) The numerator is per-expert: an expert available on only 60
    of 831 rows has 60 rows with which to earn its own single weight, no
    matter how large the fold is. That is not hypothetical -- the lab's own
    `effective_weights` docstring documents `nfelo_line` covering only
    2022-2023 and being renormalized away on nearly every row it is scored
    against. This check catches that BEFORE the fit rather than explaining it
    afterwards, and names the specific experts.

`graded_ranking` -- `tree_lab.run_ranker`'s LGBMRanker. This is the weakest-
    grounded of the six and is labelled as such in its own output
    (`basis_confidence: 'analogy'`). LambdaRank's gradient comes from pairs
    within a query group, and the pair count is neither the row count nor
    obviously the right unit; by analogy with events-per-variable the count
    used here is the number of TOP-GRADE opportunities, since placing those
    correctly is what the objective is actually rewarded for. If a better
    justification appears, this is the branch to revisit first.

CLUSTERING, APPLIED TO ALL SIX
------------------------------
Whatever the count above produces is then divided by a design effect
`1 + (mbar - 1) * ICC`, with the intraclass correlation estimated from the
label itself by one-way ANOVA on the cluster key. This is not an extra
conservatism bolted on: every lab in this directory ALREADY declares that the
unit of independence is the week or the event, not the row --
`market_lab.cluster_interval` bootstraps over (season, week),
`expert_selector_lab.week_cluster_interval` over weeks,
`book_lag_lab.cluster_interval` over events, and the master plan's rejected
shortcut #4 says so in words. A ratio whose numerator counted rows as
independent would contradict the same lab's own uncertainty intervals two
functions later. The ICC is measured per fold, so a target where weeks move
together (whole-slate line moves) is discounted hard and one where they do
not is barely discounted at all.

THE TWO RATIO CONSTANTS, AND WHY THERE ARE ONLY TWO
---------------------------------------------------
`RATIO_CONTINUOUS = 15` is the proposal's own number, kept for the targets it
was plausibly derived for (continuous outcomes) and applied to the discounted
count rather than the raw one. `RATIO_EVENTS = 10` is the events-per-variable
convention, applied wherever the numerator is a count of events rather than
of rows. Every other difference between packages comes out of the DATA -- the
class balance, the ICC, the tail mass, the per-expert availability -- which is
what part 3.1 means by "sized to that package's actual label frequency rather
than a single imported constant". A caller may override `required_ratio` for a
declared reason; the override is recorded in the verdict so it cannot be a
silent loosening.

WHAT COUNTS AS A "FEATURE"
--------------------------
The denominator is the number of candidate INPUT COLUMNS the fit may search
over (including one-hot expansions -- `book_lag_lab`'s design matrix appends
one column per book, which is most of its width), not the fitted model's own
parameter count. A 150-tree GBM with 11 leaves has thousands of internal split
parameters and this ratio says nothing about them; that is what the depth and
min_child_weight guards in part 3.2 are for. The two guards are complements,
not substitutes, and neither makes the other redundant.

REFUSE AND REPORT, RATHER THAN COMPRESS -- AND WHY
--------------------------------------------------
The proposal pairs its ratio with automatic PCA/Lasso compression above the
line. This module deliberately does not compress, and the reason is specific
to how this project works rather than a general preference:

  1. Every lab writes `preregistered.json` -- the declared feature set,
     families and selection rule -- BEFORE anything is scored. Compression
     triggered by a fold's own size would silently change the declared model
     between folds: the 2025 fold (largest) would fit the full column set and
     the 2023 fold (smallest) eight principal components, and the report would
     still line them up in one table as if they were the same experiment. The
     comparison, not the fit, is what would break.
  2. Package F excluded TPOT as an expert for exactly this reason, in these
     words: "its selected pipeline is a different architecture in every fold,
     so it has no stable identity for a weight to attach to". Fold-dependent
     compression would reintroduce that instability into EVERY family, and
     `tree_lab.emit_oof`'s per-candidate predictions feed that stacker.
  3. The leakage scanner is per-column (`leakage.py` fits one model per named
     feature). Rotate the columns into components and the scan's output stops
     naming anything a human can trace back to a source field.
  4. Nothing downstream of these labs has staking authority. The cost of
     refusing is a recorded failure in a research report; the cost of
     compressing is an unrecorded change to a preregistered protocol. In a
     program whose product is honest negative results, "this fold was
     under-powered" is a finding worth keeping and a quietly different model
     is not.

So: `check_fold` RETURNS a verdict and never raises, because the labs need to
put the failure in their frozen JSON rather than crash out of a run that has
other folds to score. `enforce` raises `DisciplineError` for a caller that
wants part 3.1's literal "raises rather than silently proceeding"; each lab
exposes it as `--discipline strict`. Recording loudly in the frozen report is
not "silently proceeding", which is why report-and-continue is the default.

AUTHORITY: research only. Nothing here promotes a model, sizes a stake, or is
imported by anything under server/services/nfl-execution-*.

Tested in research/test_model_discipline.py, including the degenerate cases
(single class, single cluster, constant label, zero features, empty fold).
"""
from __future__ import annotations
import collections
import math

import numpy as np

DISCIPLINE_VERSION = 'model-discipline-v1'

# The proposal's own 15:1, kept for continuous outcomes and applied to the
# cluster-discounted row count rather than the raw one.
RATIO_CONTINUOUS = 15.0
# Events per variable. Applied wherever the numerator is a count of events
# (minority class, follow events, quantile-tail mass, top-grade items).
RATIO_EVENTS = 10.0

TARGET_TYPES = ('continuous_regression', 'binary_classification', 'discrete_time_hazard',
                'quantile_regression', 'simplex_weights', 'graded_ranking')

COMPRESSION_POLICY = (
    'refuse_and_report: no automatic PCA/Lasso compression. A fold-size-triggered '
    'compression would change the declared model between folds of the same preregistered '
    'experiment, break the per-column leakage scan, and give each family a different '
    'identity per fold -- the exact reason Package F excluded TPOT as an expert. An '
    'under-powered fold is recorded as a finding instead.')


class DisciplineError(RuntimeError):
    """Raised only by `enforce`; `check_fold` never raises."""


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def _icc_one_way(values, clusters):
    """One-way random-effects ICC of `values` across `clusters`.

    Returns a value in [0, 1], or None when it is not estimable. Used on
    binary labels too (a linear-probability ICC), which is a coarse but
    standard approximation and is only ever used to DISCOUNT a count.
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    if n == 0:
        return None
    groups = collections.defaultdict(list)
    for v, c in zip(values, clusters):
        groups[c].append(float(v))
    k = len(groups)
    if k < 2 or n == k:
        # k < 2: nothing to compare between clusters. n == k: every cluster is a
        # singleton, so there is no within-cluster replication to correlate.
        return None if k < 2 else 0.0
    sizes = np.array([len(v) for v in groups.values()], dtype=float)
    means = np.array([float(np.mean(v)) for v in groups.values()], dtype=float)
    grand = float(np.mean(values))
    msb = float(np.sum(sizes * (means - grand) ** 2) / (k - 1))
    msw = float(sum(float(np.sum((np.asarray(v, dtype=float) - m) ** 2))
                    for v, m in zip(groups.values(), means)) / (n - k))
    n0 = (n - float(np.sum(sizes ** 2)) / n) / (k - 1)
    denom = msb + (n0 - 1) * msw
    if denom <= 0 or not math.isfinite(denom):
        return 0.0
    return float(min(max((msb - msw) / denom, 0.0), 1.0))


def cluster_design_effect(y, clusters=None):
    """How much the row count overstates the independent information in `y`.

    `1 + (mean_cluster_size - 1) * ICC`, the standard Kish design effect, with
    the ICC measured from this fold's own label rather than assumed. With no
    cluster key the design effect is 1.0 and the result says so -- that is the
    OPTIMISTIC assumption, and a caller that omits the key is choosing it.
    A fold that is a single cluster is one dependent block: the design effect
    is the row count itself, i.e. one effective observation.
    """
    y = np.asarray(y, dtype=float)
    n = len(y)
    if clusters is None:
        return {'clusters': None, 'mean_cluster_size': None, 'icc': None, 'design_effect': 1.0,
                'note': 'no cluster key supplied; rows treated as independent (optimistic)'}
    clusters = list(clusters)
    if len(clusters) != n:
        raise ValueError('clusters must be the same length as y')
    if n == 0:
        return {'clusters': 0, 'mean_cluster_size': None, 'icc': None, 'design_effect': 1.0,
                'note': 'empty fold'}
    k = len(set(clusters))
    mbar = n / k
    if k < 2:
        return {'clusters': k, 'mean_cluster_size': mbar, 'icc': None, 'design_effect': float(n),
                'note': 'every row falls in one cluster; the whole fold is one dependent block'}
    icc = _icc_one_way(y, clusters)
    if icc is None:
        return {'clusters': k, 'mean_cluster_size': mbar, 'icc': None, 'design_effect': 1.0,
                'note': 'ICC not estimable; no clustering discount applied'}
    deff = 1.0 + (mbar - 1.0) * icc
    return {'clusters': k, 'mean_cluster_size': round(mbar, 4), 'icc': round(icc, 5),
            'design_effect': round(max(deff, 1.0), 4),
            'note': 'Kish design effect from a one-way ANOVA ICC of this fold\'s own label'}


# ---------------------------------------------------------------------------
# Effective observations, per target type
# ---------------------------------------------------------------------------

def effective_observations(y, *, target_type, clusters=None, quantiles=None,
                           availability=None, expert_names=None):
    """How many independent observations this fold actually has for this target.

    `y` is the label vector the model will be fit against (for
    `simplex_weights` it is the continuous target the blend predicts; for
    `discrete_time_hazard` it is the 0/1 event indicator per at-risk row).
    `clusters` is the dependence key the lab already uses for its own
    bootstrap -- (season, week) for the season labs, `event_key` for the book
    tape. `quantiles` is required for `quantile_regression`; `availability` is
    the (rows x experts) 0/1 mask required for `simplex_weights`.

    Returns a dict with `effective_n` (float), `rows`, `basis` (a sentence
    explaining the number), the design-effect block, and a `detail` dict whose
    contents differ per target type. Never raises on degenerate input: an
    all-one-class fold returns 0.0, which the caller's ratio check then fails
    with a readable reason.
    """
    if target_type not in TARGET_TYPES:
        raise ValueError(f'unknown target_type {target_type!r}; expected one of {TARGET_TYPES}')
    y = np.asarray(y, dtype=float)
    rows = int(len(y))
    deff_block = cluster_design_effect(y, clusters)
    deff = float(deff_block['design_effect']) or 1.0
    detail = {}

    if rows == 0:
        return {'version': DISCIPLINE_VERSION, 'target_type': target_type, 'rows': 0,
                'raw_count': 0.0, 'effective_n': 0.0, 'clustering': deff_block,
                'basis': 'the fold is empty', 'detail': detail}

    if target_type == 'continuous_regression':
        spread = float(np.std(y))
        counts = collections.Counter(np.round(y, 9).tolist())
        mode_value, mode_count = counts.most_common(1)[0]
        detail = {'label_std': round(spread, 6), 'distinct_values': len(counts),
                  'mode_value': float(mode_value), 'mass_at_mode': round(mode_count / rows, 4)}
        if spread <= 0:
            raw = 0.0
            basis = 'the label is constant across the fold; there is nothing to predict'
        else:
            raw = float(rows)
            basis = ('every row constrains a conditional mean, so the raw count is the row count; '
                     'the label\'s own concentration (mass_at_mode) is reported but not discounted, '
                     'because regression precision depends on the design matrix and the residual '
                     'variance rather than on how the label is distributed')

    elif target_type in ('binary_classification', 'discrete_time_hazard'):
        finite = y[np.isfinite(y)]
        positives = float(np.sum(finite > 0.5))
        negatives = float(len(finite) - positives)
        detail = {'positives': positives, 'negatives': negatives,
                  'base_rate': round(positives / len(finite), 6) if len(finite) else None}
        if target_type == 'discrete_time_hazard':
            raw = positives
            detail['at_risk_rows'] = rows
            basis = ('a discrete-time hazard fold is powered by the number of FOLLOW EVENTS, not by '
                     'the at-risk step rows: one race that takes eight polls to resolve is eight rows '
                     'and one event, the same reason survival power is quoted in deaths not patient-years')
        else:
            raw = min(positives, negatives)
            basis = ('the minority class count, not the row count: logistic information in a '
                     'coefficient scales with p(1-p), so rows from a nearly-absent class barely '
                     'constrain it (events-per-variable, Peduzzi et al. 1996)')

    elif target_type == 'quantile_regression':
        if not quantiles:
            raise ValueError('quantile_regression requires the quantile grid')
        per_q = []
        for q in quantiles:
            tail = float(rows) * float(min(q, 1.0 - q))
            per_q.append({'quantile': float(q), 'tail_rows': round(tail, 3)})
        binding = min(per_q, key=lambda item: item['tail_rows'])
        raw = float(binding['tail_rows'])
        detail = {'per_quantile': per_q, 'binding_quantile': binding['quantile']}
        basis = (f'the most extreme quantile in the grid binds: information about tau='
                 f'{binding["quantile"]} lives in the ~{min(binding["quantile"], 1 - binding["quantile"]):.0%} '
                 'of rows near that tail, since a quantile estimate\'s variance goes as tau(1-tau)/f(q)^2, '
                 'and this project fits one model per quantile and reports them as one coherent set')

    elif target_type == 'simplex_weights':
        if availability is None:
            raise ValueError('simplex_weights requires an availability mask')
        mask = np.asarray(availability, dtype=float)
        if mask.ndim != 2 or mask.shape[0] != rows:
            raise ValueError('availability must be a (rows x experts) mask')
        names = list(expert_names) if expert_names is not None else [f'expert_{j}' for j in range(mask.shape[1])]
        per_expert = [{'expert': names[j], 'available_rows': int(mask[:, j].sum()),
                       'effective_rows': round(float(mask[:, j].sum()) / deff, 3)}
                      for j in range(mask.shape[1])]
        raw = float(rows)
        detail = {'per_expert': per_expert, 'experts': len(names),
                  'free_parameters': max(len(names) - 1, 0),
                  'least_supported': min(per_expert, key=lambda e: e['available_rows']) if per_expert else None}
        basis = ('rows carry the blend as a whole, but each expert earns its OWN weight only from the '
                 'rows where it is available, so per-expert support is reported alongside and is part '
                 'of the verdict; the sum-to-1 constraint means the fit has experts-1 free parameters')

    else:  # graded_ranking
        top = float(np.sum(y >= (float(np.max(y)) - 1e-9))) if rows else 0.0
        raw = top
        detail = {'top_grade_items': top, 'max_grade': float(np.max(y)) if rows else None,
                  'basis_confidence': 'analogy'}
        basis = ('by analogy with events-per-variable: LambdaRank is rewarded for placing the '
                 'top-graded items correctly, so those items are counted rather than every listed '
                 'opportunity. This is the weakest-justified numerator in this module and is '
                 'labelled as such (basis_confidence: analogy)')

    effective = max(raw / deff, 0.0)
    return {'version': DISCIPLINE_VERSION, 'target_type': target_type, 'rows': rows,
            'raw_count': round(float(raw), 4), 'effective_n': round(float(effective), 4),
            'clustering': deff_block, 'basis': basis, 'detail': detail}


def required_ratio_for(target_type):
    """The per-parameter bar for a target type. Two constants, both cited in
    the module docstring; every other difference between packages comes from
    the data via `effective_observations`."""
    if target_type == 'continuous_regression' or target_type == 'simplex_weights':
        return RATIO_CONTINUOUS
    return RATIO_EVENTS


# ---------------------------------------------------------------------------
# The check itself
# ---------------------------------------------------------------------------

def check_fold(*, package, label, target_type, y, feature_count, clusters=None,
               quantiles=None, availability=None, expert_names=None,
               parameters=None, required_ratio=None, note=None):
    """Structured pass/fail verdict for one fold, computed BEFORE the fit.

    Returns a dict -- it never raises for an under-powered fold, because the
    lab has to record the failure in its frozen report rather than crash out
    of a run with other folds still to score. Pass the result to `enforce` for
    the raising behaviour.

    `feature_count` is the number of candidate input columns, one-hot
    expansions included. `parameters` overrides it where the fit's free
    parameter count is not the column count (the simplex stacker: experts-1).

    Statuses: 'pass', 'fail', 'not_applicable'. 'not_applicable' means there
    was nothing to check -- zero free parameters cannot overfit anything -- and
    counts as passing so it never blocks a run; an empty fold is a 'fail',
    since a fold with no rows is under-powered by any reading.
    """
    obs = effective_observations(y, target_type=target_type, clusters=clusters,
                                 quantiles=quantiles, availability=availability,
                                 expert_names=expert_names)
    if parameters is None:
        parameters = (obs['detail'].get('free_parameters', 0) if target_type == 'simplex_weights'
                      else int(feature_count))
    parameters = int(parameters)
    ratio = float(required_ratio) if required_ratio is not None else required_ratio_for(target_type)
    effective = float(obs['effective_n'])

    verdict = {
        'version': DISCIPLINE_VERSION, 'package': package, 'label': label,
        'target_type': target_type, 'rows': obs['rows'], 'features': int(feature_count),
        'parameters': parameters, 'effective_n': effective, 'raw_count': obs['raw_count'],
        'required_ratio': ratio,
        'required_ratio_source': ('caller override: ' + (note or 'no reason given')) if required_ratio is not None
            else ('RATIO_CONTINUOUS (the proposal\'s 15:1, on the discounted count)'
                  if ratio == RATIO_CONTINUOUS else 'RATIO_EVENTS (events per variable)'),
        'observed_ratio': None, 'max_parameters_supported': int(effective // ratio) if ratio > 0 else None,
        'clustering': obs['clustering'], 'basis': obs['basis'], 'detail': obs['detail'],
        'compression_policy': COMPRESSION_POLICY,
    }
    if note and required_ratio is None:
        verdict['note'] = note

    if obs['rows'] == 0:
        verdict.update(status='fail', passed=False,
                       reason='the fold has no rows; nothing can be fit against it')
        return verdict
    if parameters <= 0:
        verdict.update(status='not_applicable', passed=True,
                       reason='no free parameters to constrain, so the ratio does not apply')
        return verdict
    if effective <= 0:
        verdict.update(status='fail', passed=False,
                       reason=f'{obs["rows"]} rows carry 0 effective observations for a '
                              f'{target_type} target ({obs["basis"]})')
        return verdict

    verdict['observed_ratio'] = round(effective / parameters, 4)

    # Per-expert support is part of the simplex verdict: a fold can be large in
    # aggregate and still have an expert with far too few rows to earn its own
    # single weight, which is exactly the nfelo_line case the selector lab
    # documents after the fact in `effective_weights`.
    under_supported = []
    if target_type == 'simplex_weights':
        under_supported = [e['expert'] for e in obs['detail'].get('per_expert', [])
                           if e['effective_rows'] < ratio]
        verdict['under_supported_experts'] = under_supported

    if verdict['observed_ratio'] >= ratio and not under_supported:
        verdict.update(status='pass', passed=True,
                       reason=f'{effective:.1f} effective observations for {parameters} parameters '
                              f'({verdict["observed_ratio"]:.1f}:1, bar {ratio:.0f}:1)')
        return verdict

    parts = []
    if verdict['observed_ratio'] < ratio:
        parts.append(f'{obs["rows"]} rows reduce to {effective:.1f} effective observations '
                     f'({obs["basis"]}), which supports at most '
                     f'{verdict["max_parameters_supported"]} of the {parameters} parameters at '
                     f'{ratio:.0f}:1 (observed {verdict["observed_ratio"]:.1f}:1)')
    if under_supported:
        parts.append(f'{len(under_supported)} expert(s) have fewer than {ratio:.0f} effective rows to '
                     f'earn their own weight: {", ".join(sorted(under_supported)[:8])}')
    verdict.update(status='fail', passed=False, reason='; '.join(parts))
    return verdict


def enforce(verdicts, strict=True):
    """Part 3.1's literal "raises rather than silently proceeding".

    `strict=False` is a no-op, so a lab can wire this in at the fit site and
    let a CLI flag decide. Recording a failure in the frozen report is not
    "silently proceeding", which is why report-and-continue is every lab's
    default and this is opt-in.
    """
    if not strict:
        return
    if isinstance(verdicts, dict):
        verdicts = [verdicts]
    failed = [v for v in verdicts if not v.get('passed', True)]
    if failed:
        raise DisciplineError('; '.join(f'{v.get("label")}: {v.get("reason")}' for v in failed))


def record(sink, verdict, strict=False):
    """Append a verdict to a lab's report list, then optionally raise."""
    if sink is not None:
        sink.append(verdict)
    enforce(verdict, strict=strict)
    return verdict


def summarize(verdicts):
    """The compact block a lab puts at the top of its frozen report."""
    verdicts = list(verdicts or [])
    failures = [{'label': v.get('label'), 'target_type': v.get('target_type'),
                 'rows': v.get('rows'), 'effective_n': v.get('effective_n'),
                 'parameters': v.get('parameters'), 'observed_ratio': v.get('observed_ratio'),
                 'required_ratio': v.get('required_ratio'), 'reason': v.get('reason')}
                for v in verdicts if not v.get('passed', True)]
    counts = collections.Counter(v.get('status') for v in verdicts)
    return {
        'version': DISCIPLINE_VERSION, 'authority': 'research_only',
        'checks': len(verdicts), 'passed': not failures,
        'by_status': dict(counts), 'failures': failures,
        'ratio_constants': {'RATIO_CONTINUOUS': RATIO_CONTINUOUS, 'RATIO_EVENTS': RATIO_EVENTS},
        'compression_policy': COMPRESSION_POLICY,
        'statement': ('Every fold cleared its observation-to-parameter bar.' if not failures else
                      f'{len(failures)} of {len(verdicts)} fold checks were under-powered and are listed '
                      'in failures. The fits still ran and their numbers are reported; read them knowing '
                      'the fold could not support the parameter count.'),
    }
