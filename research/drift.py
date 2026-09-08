"""A distributional-drift scan, run for real on every experiment, beside the leakage one.

research/leakage.py answers "is a feature secretly the label?". This module
answers the other half of the same question: "has the population this model
was fitted on stopped resembling the population it is now scoring?" A model
can be perfectly leak-free, perfectly cross-validated, and still be worthless
next season because the thing it learned about no longer exists -- a rule
change moved field position, a provider changed a stat definition, or a feed
went dark and every row now carries a zero-filled default.

Nothing in this project computed such a statistic before
(docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md part 1.2 names the gap, and
part 4 item 4 asks for exactly this). What follows is deliberately NOT a
textbook PSI gate, for reasons this docstring has to justify rather than
assume.

WHY THE CONVENTIONAL PSI THRESHOLDS ARE WRONG HERE, WITH THE ARITHMETIC
----------------------------------------------------------------------
PSI (population stability index) is the field-conventional statistic and the
assessment doc names it, so it is computed and reported here. Its familiar
decision rule -- "< 0.1 stable, 0.1-0.25 investigate, > 0.25 significant
shift" -- comes from retail credit scoring, where a scoring population is
hundreds of thousands of rows. It does not survive contact with this
project's sample sizes.

PSI between two samples drawn from the SAME distribution is not zero. It is
approximately distributed as (1/n_train + 1/n_score) * chi2 with (bins - 1)
degrees of freedom (Yurdakul 2018). Package C's actual frozen run has
per-market training folds of 219 / 474 / 717 rows and scoring seasons of
roughly 250 rows. At ten bins that gives:

    fold        n_train  n_score   E[PSI] under NO drift   95th pct    99th pct
    2023 test     219      250          0.077               0.145       0.186
    2024 test     474      250          0.055               0.103       0.132
    2025 test     717      250          0.049               0.091       0.117

The conventional "0.1 means investigate" line sits BELOW the 95th percentile
of pure sampling noise on two of the three folds, and within a hair of it on
the third. Applied to this project's 86 features it would raise four to nine
alarms per fold on data with no drift at all. Importing 0.1/0.25 as gospel
here would not be conservative; it would be noise-generating theatre. So the
noise floor is computed analytically from the fold's own row counts
(`psi_noise_reference`) and every verdict is stated relative to it.

PSI's other weaknesses, stated plainly rather than papered over:

  1. **Binning sensitivity.** PSI is a function of an arbitrary bin count and
     an arbitrary bin-edge rule. Rather than write that down and move on, this
     module recomputes PSI at 5, 10 and 20 bins and reports the spread
     (`psi_binning_spread`), so a reader can see for themselves how much of a
     given number is the statistic and how much is the binning choice.
  2. **Thresholds with no sampling theory.** 0.1 and 0.25 are conventions, not
     quantiles of anything. Replaced here by the analytic null above plus an
     empirical NFL reference (next section).
  3. **Blindness to changes that preserve marginals.** PSI is computed one
     feature at a time. A season in which every feature's marginal is
     unchanged but their joint relationship has rotated -- exactly what a
     changed upstream join or a re-keyed provider table looks like -- is
     invisible to PSI and to KS and to Wasserstein alike. That blind spot is
     covered separately by `joint_drift_classifier` below, which is the single
     most useful thing in this file and has nothing to do with PSI.

A second, better-behaved marginal statistic is reported alongside PSI:
**Wasserstein-1 distance normalized by the training window's own IQR**. It
needs no bins (so it has no binning artefact at all), it is a true metric, and
its units are interpretable and comparable across features -- "this feature's
distribution moved by 0.4 of its own typical spread" means the same thing for
EPA per play as for hours to kickoff, which is not true of PSI. It is reported
for information rather than used for the verdict, because unlike PSI it has no
convenient closed-form null at these sample sizes; a permutation null for it
per feature would cost more than it is worth when the joint check already
carries a permutation null.

WHAT COUNTS AS ABNORMAL FOR NFL DATA SPECIFICALLY
-------------------------------------------------
This project's folds are chronological and purged, so the training window and
the scoring window are DIFFERENT SEASONS by construction. Drift between season
N-1 and season N is not an anomaly in the NFL; it is the league. Rules change,
pace changes, the scoring environment changes, and the market re-prices all of
it every August. A drift check that fires on every season boundary tells you
nothing you did not already know.

So the reference distribution is not a constant. For every feature role
(below), this module measures how much features of that role ACTUALLY moved
across the season boundaries inside the training window itself -- every
consecutive season pair, every feature of that role, pooled -- and takes the
95th percentile of that pooled distribution as "what a normal NFL season
boundary does to a feature like this" (`league_reference`). A feature is only
called abnormal when its train-to-score drift exceeds both that empirical
league reference and the analytic noise floor, by a factor of
ABNORMAL_MULTIPLE.

That multiple is 2.0, and it is not arbitrary either. PSI is a scaled
chi-square, so doubling a 95th-percentile cut moves the per-feature tail
probability from 5% to roughly 1e-4 at nine degrees of freedom. Across ~86
features that is an expected false-alarm count under 0.01 per fold -- a
family-wise bar, which is the right kind of bar when the scan runs over every
column of every fold automatically and a single spurious red flag would teach
the reader to ignore all of them.

Two honest caveats on the league reference. It is computed from season pairs
that are individually smaller than the train/score comparison, so its own
noise floor is higher and it therefore runs slightly conservative (fewer
alarms, not more); the noise floor at those pair sizes is reported next to it
so the inflation is visible. And the earliest outer fold in a walk-forward
design has only one training season, hence no season pair at all -- in that
case the reference falls back to the analytic noise floor and is explicitly
marked `weak`, because a fold that cannot calibrate against league behaviour
should say so rather than borrow a number from a fold that could.

MARKET FEATURES AND MODELLING FEATURES ARE NOT THE SAME KIND OF THING
---------------------------------------------------------------------
A shifted closing-line distribution is INFORMATION. Totals climbed across the
2020s because scoring climbed; the market noticed and repriced. That is the
market doing its job, and a drift check that treats it as a fault is wrong. A
shifted "share of rows for which the play-by-play feed had anything to say"
is a different animal entirely: nothing about football changed, our ability to
observe it did.

Every feature is therefore classified into one of three roles
(`classify_feature_role`), and each role gets different treatment:

  - `market`   -- prices, lines, overrounds, key-number distances, time to
                  kickoff. Large drift is reported at full magnitude but
                  labelled `market_regime_shift`, never `abnormal`. The market
                  moving is evidence about the market, not a broken feed.
  - `availability` -- the `*_available` missingness flags and `*_age_days`
                  freshness columns this project attaches to every lagged
                  input. These get the TIGHTEST treatment, because they are
                  the direct instrument for "did a feed break". A collapse in
                  an availability rate is escalated to
                  `feed_break_suspected` on the rate itself, without waiting
                  for PSI, since a feed going from 95% coverage to 10% is not
                  a distributional subtlety.
  - `model`    -- everything else: team-week aggregates, the interaction
                  columns, schedule facts. Standard treatment.

REPORT, DO NOT REFUSE
---------------------
Nothing here raises, halts, or declines to fit. This project's discipline is
to record and surface. `detect_distribution_drift` returns a report; the
calling lab writes it into its manifest next to `leakage_scans`; the Research
Lab page renders it. A drifted feature is a fact a reader needs when
interpreting a result, not a reason to hide the result.

research/test_drift.py proves the whole thing the way test_tree_lab.py proves
the leakage scanner: against synthetic data with a deliberately injected
break, AND -- the direction that matters just as much here -- against a
synthetic ordinary season-over-season shift that it must NOT flag.
"""
from __future__ import annotations
import numpy as np
from scipy import stats
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.model_selection import GroupKFold, KFold
from sklearn.metrics import roc_auc_score

DRIFT_VERSION = 'drift-scan-v1'

# See the docstring's family-wise argument. Do not lower this without redoing
# that arithmetic: it is what keeps an 86-feature automatic scan from crying
# wolf once a fold and training the reader to ignore it.
ABNORMAL_MULTIPLE = 2.0
# Above the reference but below ABNORMAL_MULTIPLE: worth a reader's eye, not a
# claim that something is broken.
ELEVATED_MULTIPLE = 1.0

DEFAULT_BINS = 10
MIN_ROWS_PER_BIN = 20      # below this the chi-square approximation for the null degrades
MIN_BINS = 5
BINNING_SENSITIVITY_GRID = (5, 10, 20)

# An availability rate that more than halves AND drops by at least this much in
# absolute terms is called a suspected feed break on its own, before any PSI is
# consulted. Both conditions are required so that a rare flag going from 4% to
# 1% -- proportionally dramatic, practically nothing -- does not trip it.
AVAILABILITY_COLLAPSE_ABSOLUTE = 0.10
AVAILABILITY_COLLAPSE_RATIO = 0.5

_MARKET_TOKENS = ('opening_line', 'closing_line', 'opening_positive_price',
                  'opening_negative_price', 'overround', 'near_key_', 'hours_to_kickoff',
                  'market_prob', '_price', '_line')


def classify_feature_role(name):
    """Sort a feature name into `availability`, `market` or `model`.

    Order matters: `opening_overround_available` is an availability flag that
    happens to be about a market quantity, and it must be treated as the
    former -- it reports whether we could observe the price at all, which is a
    statement about our pipeline, not about the market.
    """
    n = str(name)
    if n.endswith('_available') or n.endswith('_age_days') or n.endswith('_prior_games'):
        return 'availability'
    if any(tok in n for tok in _MARKET_TOKENS):
        return 'market'
    return 'model'


def _finite(values):
    v = np.asarray(values, dtype=float)
    return v[np.isfinite(v)]


def choose_bins(n_train, n_score, requested=DEFAULT_BINS):
    """Shrink the bin count until the smaller sample still fills each bin.

    PSI's null approximation is a chi-square over bin counts, and chi-square
    over near-empty cells is not a usable approximation. Rather than let the
    caller pick a number that quietly breaks the calibration, the bin count is
    derived from the fold's own size and reported in the output.
    """
    smaller = min(int(n_train), int(n_score))
    if smaller <= 0:
        return MIN_BINS
    return int(max(MIN_BINS, min(requested, smaller // MIN_ROWS_PER_BIN)))


def population_stability_index(train_values, score_values, bins=DEFAULT_BINS, *, binary=False):
    """PSI between a training window and a scoring window.

    Bin edges are the TRAINING window's own quantiles -- the training
    distribution is the reference, which is the whole point: we are asking
    whether the new population looks like the one the model learned from, not
    whether two arbitrary samples differ.

    Zero cells are replaced by a half-count (0.5 / n) rather than a fixed
    epsilon. A fixed epsilon makes PSI depend on an invisible constant that
    can dominate the statistic on a small fold; a half-count is the standard
    continuity correction and keeps the chi-square null approximation honest.

    `binary` switches to exact category proportions. Quantile binning of a 0/1
    column produces degenerate edges and a meaningless number, and this project
    has one such column for every lagged input it consumes.
    """
    a, b = _finite(train_values), _finite(score_values)
    if a.size < 2 or b.size < 2:
        return None
    if binary or np.unique(a).size <= 2:
        cats = np.unique(np.concatenate([np.unique(a), np.unique(b)]))
        if cats.size < 2:
            return 0.0
        pa = np.array([np.mean(a == c) for c in cats])
        pb = np.array([np.mean(b == c) for c in cats])
    else:
        edges = np.unique(np.quantile(a, np.linspace(0, 1, bins + 1)))
        if edges.size < 3:
            return 0.0
        edges[0], edges[-1] = -np.inf, np.inf
        pa = np.histogram(a, bins=edges)[0] / a.size
        pb = np.histogram(b, bins=edges)[0] / b.size
    pa = np.where(pa <= 0, 0.5 / a.size, pa)
    pb = np.where(pb <= 0, 0.5 / b.size, pb)
    return float(np.sum((pb - pa) * np.log(pb / pa)))


def psi_noise_reference(n_train, n_score, bins):
    """What PSI looks like when NOTHING has drifted, at these row counts.

    PSI between two samples of the same distribution is approximately
    (1/n_a + 1/n_b) * chi2_{bins-1}. This function is the reason this module
    does not import 0.1/0.25: see the table in the module docstring for what
    those conventional numbers actually mean at Package C's fold sizes.
    """
    n_train, n_score = int(n_train), int(n_score)
    if n_train < 2 or n_score < 2 or bins < 2:
        return None
    scale = (1.0 / n_train) + (1.0 / n_score)
    df = bins - 1
    return {'bins': int(bins), 'n_train': n_train, 'n_score': n_score,
            'expected_under_no_drift': float(scale * df),
            'p95_under_no_drift': float(scale * stats.chi2.ppf(0.95, df)),
            'p99_under_no_drift': float(scale * stats.chi2.ppf(0.99, df)),
            'model': 'PSI ~ (1/n_train + 1/n_score) * chi2_{bins-1} (Yurdakul 2018)'}


def normalized_wasserstein(train_values, score_values):
    """Wasserstein-1 distance in units of the training window's own IQR.

    Binning-free, a true metric, and comparable across features of wildly
    different scale. Returned as None for a degenerate reference spread (a
    constant or near-constant training column), where "in units of its own
    spread" has no meaning -- reporting a huge number there would be an
    artefact of dividing by nearly zero, not a finding.
    """
    a, b = _finite(train_values), _finite(score_values)
    if a.size < 2 or b.size < 2:
        return None
    spread = float(np.subtract(*np.percentile(a, [75, 25])))
    if not np.isfinite(spread) or spread <= 1e-12:
        spread = float(np.std(a))
    if not np.isfinite(spread) or spread <= 1e-12:
        return None
    return float(stats.wasserstein_distance(a, b) / spread)


def season_boundary_reference(X, seasons, feature_names, roles, bins):
    """How much features of each role normally move across an NFL season line.

    Pools PSI over every consecutive season pair present in the TRAINING
    window and every feature of a given role, then takes the 95th percentile.
    That pooled distribution is the answer to "the league moved, as it always
    does" -- the null this check actually needs, rather than a credit-scoring
    constant.

    Pooling across features rather than per-feature is deliberate. With two or
    three training seasons a per-feature reference would rest on one or two
    observations; pooled across ~30 features of the same role it rests on
    dozens, which is the difference between a calibration and a guess. The cost
    is that a genuinely volatile feature is judged against its role's typical
    behaviour rather than its own, which will make this check slightly slow to
    flag a feature that was always erratic. That trade is stated rather than
    hidden.
    """
    X = np.asarray(X, dtype=float)
    seasons = np.asarray(seasons)
    ordered = sorted({int(s) for s in seasons})
    pairs = list(zip(ordered, ordered[1:]))
    pooled = {'market': [], 'availability': [], 'model': []}
    pair_sizes = []
    for earlier, later in pairs:
        ia = np.flatnonzero(seasons == earlier)
        ib = np.flatnonzero(seasons == later)
        if ia.size < 2 * MIN_ROWS_PER_BIN or ib.size < 2 * MIN_ROWS_PER_BIN:
            continue
        pair_bins = choose_bins(ia.size, ib.size, bins)
        pair_sizes.append((int(ia.size), int(ib.size), pair_bins))
        for i, name in enumerate(feature_names):
            value = population_stability_index(X[ia, i], X[ib, i], pair_bins)
            if value is not None:
                pooled[roles[name]].append(value)
    out = {}
    for role, values in pooled.items():
        if len(values) >= 8:
            floors = [psi_noise_reference(a, b, k) for a, b, k in pair_sizes]
            floors = [f['p95_under_no_drift'] for f in floors if f]
            out[role] = {'source': 'historical_season_pairs', 'weak': False,
                         'season_pairs': [[a, b] for a, b in pairs],
                         'observations': len(values),
                         'p50': float(np.percentile(values, 50)),
                         'p95': float(np.percentile(values, 95)),
                         'max': float(np.max(values)),
                         # Season pairs are individually smaller than the
                         # train/score comparison, so part of this reference is
                         # their own sampling noise. Shown, not netted out:
                         # leaving it in makes the check conservative, which is
                         # the safe direction for an automatic scan.
                         'noise_floor_at_pair_sizes_p95': float(np.mean(floors)) if floors else None}
        else:
            out[role] = {'source': 'noise_floor_fallback', 'weak': True,
                         'season_pairs': [[a, b] for a, b in pairs],
                         'observations': len(values), 'p50': None, 'p95': None, 'max': None,
                         'noise_floor_at_pair_sizes_p95': None,
                         'note': ('Fewer than two usable seasons in the training window, so this fold '
                                  'has no season boundary of its own to calibrate against. Verdicts '
                                  'fall back to the analytic sampling-noise floor and are marked weak.')}
    return out


def joint_drift_classifier(X_train, X_score, feature_names, *, groups_train=None,
                           groups_score=None, permutations=12, random_state=0, max_features=200):
    """Can a classifier tell the two windows apart at all? (PSI's blind spot.)

    Every marginal statistic in this file -- PSI, Wasserstein, a KS test if one
    were added -- looks at one column at a time. A change that leaves every
    marginal intact while rotating the relationship between columns is
    invisible to all of them, and that is precisely the shape of the failures
    worth catching automatically: an upstream join changed, a provider re-keyed
    a table, home and away got swapped for one source.

    A domain classifier catches it. Label training-window rows 0 and
    scoring-window rows 1, fit a small model, and score it out-of-fold. AUC
    near 0.5 means the two windows are statistically indistinguishable given
    these features. AUC well above 0.5 means they are not, whatever the
    marginals say.

    The classifier is a bounded ExtraTrees ensemble and NOT a logistic
    regression, and that choice is the difference between this check working
    and not working. A linear domain classifier can only find a shift in the
    features' means -- which is precisely what PSI already reports one column
    at a time, so it would add nothing. A change in the RELATIONSHIP between
    columns leaves the linear decision boundary at chance; research/
    test_drift.py contains that exact case (two columns whose marginals are
    identical across windows and whose correlation has been destroyed), and it
    was verified to defeat a logistic domain classifier before this was
    switched to a tree ensemble. Depth is capped so the model finds structure
    rather than memorizing rows.

    The null is not assumed to be 0.5. It is measured by permutation, and the
    permutation is done at the GROUP level (a week is reassigned whole) rather
    than per row: NFL games within a week share weather, injuries, schedule and
    a common market state, so shuffling rows would treat dependent observations
    as independent and give a null band that is far too tight. Cross-validation
    uses the same grouping, so no week is ever split across a fold boundary.

    Cheap by construction: one bounded ensemble per fold, times
    (1 + permutations). Nothing here is tuned, because a tuned domain
    classifier would report the tuner's capacity rather than the data's drift.
    """
    Xa, Xb = np.asarray(X_train, dtype=float), np.asarray(X_score, dtype=float)
    if Xa.shape[0] < 30 or Xb.shape[0] < 30 or Xa.shape[1] == 0:
        return {'skipped': True, 'reason': 'fewer than 30 rows on one side of the comparison'}
    X = np.vstack([Xa, Xb])
    y = np.r_[np.zeros(Xa.shape[0]), np.ones(Xb.shape[0])]
    # Non-finite entries become the training window's median for that column:
    # imputing from the scoring window would let the imputation itself carry
    # the drift signal and inflate the AUC.
    med = np.nanmedian(np.where(np.isfinite(Xa), Xa, np.nan), axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    X = np.where(np.isfinite(X), X, med)
    keep = np.flatnonzero(np.std(X, axis=0) > 1e-12)
    if keep.size == 0:
        return {'skipped': True, 'reason': 'every feature is constant across both windows'}
    keep = keep[:max_features]
    names = [feature_names[i] for i in keep]
    X = X[:, keep]

    if groups_train is not None and groups_score is not None:
        groups = np.asarray(list(groups_train) + list(groups_score), dtype=object)
    else:
        groups = np.arange(len(y), dtype=object)
    uniq = np.unique(groups)
    n_splits = 3 if uniq.size >= 6 else 2
    if uniq.size < 4:
        return {'skipped': True, 'reason': 'too few distinct week groups to cross-validate a domain classifier'}

    def _model():
        return ExtraTreesClassifier(n_estimators=120, max_depth=6, min_samples_leaf=15,
                                    max_features='sqrt', n_jobs=1, random_state=random_state)

    def _auc(labels):
        """Mean of the PER-FOLD AUCs, deliberately not a pooled out-of-fold AUC.

        Pooling held-out probabilities across folds and scoring them once is
        the obvious implementation and it is wrong here. GroupKFold balances
        folds by size, not by class, so with a chronological window split each
        fold sees a different train/score base rate and returns probabilities
        on a different scale. Ranking those pooled scores against each other
        measures the base-rate difference between folds as much as the drift,
        and the first live run of this module produced AUCs of 0.38 and 0.41 --
        confidently BELOW chance -- purely from that artefact. Scoring each
        fold on its own scale and averaging removes it.
        """
        splitter = GroupKFold(n_splits=n_splits) if uniq.size >= n_splits else KFold(n_splits=n_splits)
        per_fold = []
        for tr, va in splitter.split(X, labels, groups):
            if np.unique(labels[tr]).size < 2 or np.unique(labels[va]).size < 2:
                continue
            model = _model().fit(X[tr], labels[tr])
            per_fold.append(roc_auc_score(labels[va], model.predict_proba(X[va])[:, 1]))
        return float(np.mean(per_fold)) if per_fold else None

    observed = _auc(y)
    if observed is None:
        return {'skipped': True, 'reason': 'a cross-validation fold contained a single window'}
    # Permute at group level: reassign whole weeks to fake windows, preserving
    # both the class balance and the within-week dependence.
    rng = np.random.default_rng(random_state)
    group_label = {g: y[np.flatnonzero(groups == g)[0]] for g in uniq}
    truth = np.array([group_label[g] for g in uniq])
    null = []
    for _ in range(max(0, int(permutations))):
        shuffled = rng.permutation(truth)
        mapping = dict(zip(uniq, shuffled))
        fake = np.array([mapping[g] for g in groups])
        value = _auc(fake)
        if value is not None:
            null.append(value)
    # Floored at 0.5. Under the null a domain classifier cannot beat chance in
    # expectation, so a permutation ceiling that lands below 0.5 is finite-
    # sample noise from a small number of permutations -- and using it as the
    # bar would manufacture a "distinguishable" verdict out of an AUC of 0.51.
    raw_null_p95 = float(np.percentile(null, 95)) if len(null) >= 4 else None
    null_p95 = max(raw_null_p95, 0.5) if raw_null_p95 is not None else None

    # Which columns let the classifier tell the windows apart. Importance is
    # unsigned, so the training-to-scoring mean shift (in training SDs) is
    # carried alongside it -- "this column matters" is only half an answer
    # without "and it moved this way".
    full = _model().fit(X, y)
    importance = full.feature_importances_
    order = np.argsort(-importance)[:8]
    contributors = []
    for i in order:
        col_train, col_score = X[y == 0, i], X[y == 1, i]
        sd = float(np.std(col_train))
        contributors.append({'feature': names[i], 'importance': float(importance[i]),
                             'mean_shift_in_train_sd': float((col_score.mean() - col_train.mean()) / sd)
                             if sd > 1e-12 else None})

    if null_p95 is None:
        verdict = 'no_null_available'
    elif observed <= null_p95:
        verdict = 'windows_indistinguishable'
    elif observed <= null_p95 + 0.10:
        verdict = 'windows_weakly_distinguishable'
    else:
        verdict = 'windows_distinguishable'
    return {'skipped': False, 'auc': observed, 'permutation_null_p95': null_p95,
            'permutation_null_p95_unfloored': raw_null_p95,
            'permutations_run': len(null), 'cv_groups': int(uniq.size), 'cv_splits': int(n_splits),
            'features_used': int(keep.size), 'verdict': verdict, 'top_contributors': contributors,
            'note': ('AUC 0.5 means the training and scoring windows are indistinguishable given these '
                     'features. The null is measured by permuting whole weeks between windows, not '
                     'assumed to be 0.5, because chronologically adjacent weeks resemble each other.')}


def _verdict_for(psi, role, reference, noise, *, availability_break):
    """Turn one feature's numbers into a labelled verdict and its reason.

    Kept as a separate pure function so research/test_drift.py can exercise the
    decision boundaries directly, without standing up a whole scan.
    """
    if availability_break:
        return ('feed_break_suspected',
                'Availability rate collapsed between the windows. A feed that stops reporting is a '
                'pipeline fault, not a distributional subtlety, so this is escalated on the rate '
                'itself without waiting for PSI.')
    if psi is None:
        return ('not_computable', 'Too few finite values in one window to compute a statistic.')
    noise_p95 = noise['p95_under_no_drift'] if noise else None
    noise_p99 = noise['p99_under_no_drift'] if noise else None
    if noise_p95 is not None and psi <= noise_p95:
        return ('stable', 'At or below the sampling-noise floor for these row counts: indistinguishable '
                          'from two samples of the same distribution.')
    ref_p95 = (reference or {}).get('p95')
    weak = bool((reference or {}).get('weak'))
    baseline = ref_p95 if ref_p95 is not None else noise_p99
    if baseline is None:
        return ('not_computable', 'No usable reference distribution for this fold.')
    # A reference can never be TIGHTER than sampling noise. The availability
    # flags make this concrete: in the real dataset they are constant across
    # every historical season, so their pooled season-boundary reference is
    # exactly 0.0, and without this floor any movement at all past the noise
    # gate would jump straight to `abnormal` with no `elevated` band in
    # between. The feed-collapse rule above is the right instrument for a
    # genuinely dark feed; this keeps the PSI path from double-counting it.
    if noise_p95 is not None:
        baseline = max(baseline, noise_p95)
    if psi <= baseline * ELEVATED_MULTIPLE:
        return ('within_league_variation',
                ('Above sampling noise but inside what an ordinary NFL season boundary does to features '
                 'of this kind. The league moved, as it always does.') if not weak else
                ('Above sampling noise but inside the fallback noise reference. This fold has no season '
                 'boundary of its own to calibrate against, so the judgement is weak.'))
    if psi <= baseline * ABNORMAL_MULTIPLE:
        label = 'market_regime_shift' if role == 'market' else 'elevated'
        return (label, 'Beyond a normal season boundary for this role but short of the family-wise '
                       'abnormal bar. Worth a reader\'s attention; not a claim that anything is broken.')
    if role == 'market':
        return ('market_regime_shift',
                'A large shift in a priced quantity. Deliberately NOT escalated to abnormal: a market '
                'that reprices is information about the market, not evidence of a broken feed.')
    return ('abnormal',
            'Far beyond what a season boundary has ever done to features of this role in the training '
            'window. A changed source, definition or join is the leading explanation; a fitted model '
            'should not be trusted on this feature without checking why.')


def detect_distribution_drift(X_train, X_score, feature_names, *, train_seasons=None,
                              score_season=None, train_groups=None, score_groups=None,
                              bins=DEFAULT_BINS, permutations=12, random_state=0,
                              run_joint=True, label=None):
    """Compare the population a model was fitted on to the one it will score.

    `X_train` / `X_score` are 2D arrays over the SAME `feature_names`, in the
    same column order. `train_seasons` is the season of each training row and
    is what makes the NFL-specific calibration possible -- without it the check
    falls back to the analytic noise floor and says so. `train_groups` /
    `score_groups` are per-row week identifiers used to group the joint
    classifier's cross-validation and its permutation null.

    Returns a report. It never raises on drift, never modifies its inputs, and
    never tells the caller not to fit. Recording and surfacing is the whole
    contract; see the module docstring.
    """
    Xa = np.asarray(X_train, dtype=float)
    Xb = np.asarray(X_score, dtype=float)
    names = list(feature_names)
    base = {'version': DRIFT_VERSION, 'label': label, 'score_season': score_season,
            'n_train': int(Xa.shape[0]) if Xa.ndim == 2 else 0,
            'n_score': int(Xb.shape[0]) if Xb.ndim == 2 else 0}
    if Xa.ndim != 2 or Xb.ndim != 2 or Xa.shape[0] < 2 * MIN_ROWS_PER_BIN or Xb.shape[0] < 2 * MIN_ROWS_PER_BIN:
        return {**base, 'skipped': True,
                'reason': f'fewer than {2 * MIN_ROWS_PER_BIN} rows in one window', 'features': [],
                'flagged': [], 'market_regime_shifts': [], 'summary': 'Not enough rows to compare windows.'}
    if Xa.shape[1] != len(names) or Xb.shape[1] != len(names):
        return {**base, 'skipped': True, 'reason': 'feature-name count does not match the matrices',
                'features': [], 'flagged': [], 'market_regime_shifts': [],
                'summary': 'Drift scan skipped: mismatched feature columns.'}

    bins_used = choose_bins(Xa.shape[0], Xb.shape[0], bins)
    noise = psi_noise_reference(Xa.shape[0], Xb.shape[0], bins_used)
    roles = {n: classify_feature_role(n) for n in names}
    if train_seasons is not None and len({int(s) for s in train_seasons}) >= 2:
        reference = season_boundary_reference(Xa, train_seasons, names, roles, bins)
    else:
        reference = {role: {'source': 'noise_floor_fallback', 'weak': True, 'season_pairs': [],
                            'observations': 0, 'p50': None, 'p95': None, 'max': None,
                            'noise_floor_at_pair_sizes_p95': None,
                            'note': ('Only one season in the training window, so no NFL season boundary '
                                     'is available to calibrate against on this fold.')}
                     for role in ('market', 'availability', 'model')}

    features = []
    for i, name in enumerate(names):
        role = roles[name]
        a, b = _finite(Xa[:, i]), _finite(Xb[:, i])
        binary = a.size > 0 and np.unique(a).size <= 2
        psi = population_stability_index(Xa[:, i], Xb[:, i], bins_used, binary=binary)
        by_bins = {} if binary else {str(k): population_stability_index(Xa[:, i], Xb[:, i], k)
                                     for k in BINNING_SENSITIVITY_GRID}
        computed = [v for v in by_bins.values() if v is not None]
        spread = float(max(computed) - min(computed)) if len(computed) >= 2 else None
        sd = float(np.std(a)) if a.size else 0.0
        shift = float((np.mean(b) - np.mean(a)) / sd) if (a.size and b.size and sd > 1e-12) else None
        rate_train = float(np.mean(a > 0)) if (binary and a.size) else None
        rate_score = float(np.mean(b > 0)) if (binary and b.size) else None
        collapse = bool(role == 'availability' and rate_train is not None and rate_score is not None
                        and rate_train - rate_score >= AVAILABILITY_COLLAPSE_ABSOLUTE
                        and rate_score <= rate_train * AVAILABILITY_COLLAPSE_RATIO)
        verdict, reason = _verdict_for(psi, role, reference.get(role), noise, availability_break=collapse)
        features.append({'feature': name, 'role': role, 'psi': psi,
                         'psi_by_bin_count': by_bins, 'psi_binning_spread': spread,
                         'wasserstein_normalized': None if binary else normalized_wasserstein(Xa[:, i], Xb[:, i]),
                         'mean_shift_in_train_sd': shift,
                         'available_rate_train': rate_train, 'available_rate_score': rate_score,
                         'verdict': verdict, 'verdict_reason': reason})

    flagged = [f['feature'] for f in features if f['verdict'] in ('abnormal', 'feed_break_suspected')]
    elevated = [f['feature'] for f in features if f['verdict'] == 'elevated']
    regime = [f['feature'] for f in features if f['verdict'] == 'market_regime_shift']
    joint = joint_drift_classifier(Xa, Xb, names, groups_train=train_groups, groups_score=score_groups,
                                   permutations=permutations, random_state=random_state) \
        if run_joint else {'skipped': True, 'reason': 'joint check disabled by caller'}

    weak = all(bool(r.get('weak')) for r in reference.values())
    parts = [f'{Xa.shape[0]} training rows vs {Xb.shape[0]} scoring rows over {len(names)} features, '
             f'{bins_used} PSI bins.']
    parts.append(f'{len(flagged)} feature(s) drifted beyond what an NFL season boundary normally does '
                 f'to their kind' + (f': {", ".join(flagged[:6])}.' if flagged else '.'))
    if elevated:
        parts.append(f'{len(elevated)} elevated but under the abnormal bar.')
    if regime:
        parts.append(f'{len(regime)} market feature(s) repriced — reported as information, not fault.')
    if weak:
        parts.append('Calibration is WEAK on this fold: the training window holds fewer than two '
                     'seasons, so there is no season boundary to compare against.')
    if not joint.get('skipped'):
        parts.append(f'Joint check: AUC {joint["auc"]:.3f} against a permutation ceiling of '
                     f'{joint["permutation_null_p95"]:.3f} — {joint["verdict"].replace("_", " ")}.')
    parts.append('Reported only. Nothing here refused to fit or changed a model.')

    return {**base, 'skipped': False, 'bins_used': bins_used,
            'psi_noise_reference': noise, 'league_reference': reference,
            'abnormal_multiple': ABNORMAL_MULTIPLE,
            'conventional_psi_thresholds_rejected': {
                'values': [0.1, 0.25],
                'reason': ('The 0.1 "investigate" line sits at or below the 95th percentile of pure '
                           'sampling noise at this project\'s fold sizes (see psi_noise_reference), so '
                           'it would fire on undrifted data several times per fold. Verdicts here use '
                           'the analytic noise floor and an empirical NFL season-boundary reference '
                           'instead.')},
            'features': features, 'flagged': flagged, 'elevated': elevated,
            'market_regime_shifts': regime, 'joint': joint,
            'calibration_weak': weak, 'summary': ' '.join(parts)}


def scan_lab_fold(train_rows, score_rows, feature_names, *, label=None, market=None,
                  score_season=None, permutations=12, random_state=0):
    """Adapter for the labs' own row shape, so a lab gains this in two lines.

    market_lab.py and tree_lab.py both carry rows as dicts with a `features`
    dict, a `season` and a `week`. This lifts them into the matrices
    `detect_distribution_drift` wants, using the caller's `feature_names`
    ordering verbatim so the drift scan sees exactly the columns the model was
    fitted on -- not a re-derived or re-sorted set, which would let the two
    drift apart silently the way the two dataset extractors already can (see
    tree_lab.py's module docstring on that risk).

    `week` becomes the grouping for the joint check's cross-validation and its
    permutation null. Weeks, not rows: NFL games inside one week are not
    independent observations.

    Returns the drift report with `market` attached for the manifest. It never
    raises for a drifted feature -- a lab must not fail to produce a report
    because a diagnostic found something.
    """
    names = list(feature_names)

    def matrix(rows):
        return (np.array([[r['features'][k] for k in names] for r in rows], dtype=float)
                if rows else np.empty((0, len(names))))

    report = detect_distribution_drift(
        matrix(train_rows), matrix(score_rows), names,
        train_seasons=[r['season'] for r in train_rows],
        score_season=score_season,
        train_groups=[f"{r['season']}-{r['week']}" for r in train_rows],
        score_groups=[f"{r['season']}-{r['week']}" for r in score_rows],
        permutations=permutations, random_state=random_state, label=label)
    report['market'] = market
    return report
