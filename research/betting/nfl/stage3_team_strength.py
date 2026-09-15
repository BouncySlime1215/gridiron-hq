"""Stage 3 of the master plan / Slice 6 ("Freeze simple comparison") of
docs/CLAUDE-NEXT-STEPS.md: the first real modeling milestone on
`build_football_dataset`'s broad, price-agnostic history.

THIS IS A PREDECLARED EXPERIMENT. Every choice below -- the feature list, the
fold scheme, the two candidate hyperparameter grids, the metrics reported --
was written down BEFORE this script was ever run against the real database.
Per the master plan's "Overfitting controls" section and CLAUDE-NEXT-STEPS.md
section 9.4: "No useful incremental effect at the declared endpoint ->
simplify or reject that family/policy. Do not keep adding features until the
same sample looks profitable." If the candidates do not beat the market, or
barely beat the zero-information baseline, that is the reported finding, not
a reason to widen the search.

WHAT THIS DOES NOT DO. It does not touch `dataset.py`, `market_lab.py` or
`tree_lab.py` -- those already have production evaluation infrastructure of
their own, tested separately. It does not train totals (`actual_total` is
explicitly out of scope; see the module docstring's "spreads/margin only").
It does not wire anything into the live app -- this is a research report.

FEATURE SET (predeclared, restrained, documented here so a later reader does
not need to reverse-engineer it from the code):

  * home_rest, away_rest, rest_diff = home_rest - away_rest.
  * div_game (0/1).
  * Recent-form margin/total: the mean of each team's own last-5 PRIOR games'
    margin/total, from `home_prior_games`/`away_prior_games` -- already
    strictly-before-kickoff by `build_football_dataset`'s construction (see
    that function's docstring: `history_before`/`features_before` enforce
    "strictly before," this script does not re-derive that guarantee, only
    consumes it). `margin` in those entries is signed from THAT team's own
    perspective in that prior game -- confirmed by reading
    `dataset.build_chronology`: for each game row it appends
    `(g['team'], +margin)` and `(g['opponent'], -margin)` to `history`, so a
    team's own history entries are always "how much I won/lost by," home or
    away, never "how much the home team of that prior game won by." Getting
    this backwards for the away team would silently flip the sign of the
    single most informative feature in this file; `test_row_features_*` in
    the companion test module checks it against a hand-computed value.
  * home_form_count / away_form_count: how many prior games (0-5) that mean
    was actually computed over -- evidence of small-sample unreliability
    early in a team's history, exactly as instructed.
  * pbp_available (0/1) and, only where true for BOTH teams, three home-minus-
    away differentials from `nfl_team_week_features`: `off_epa_per_play`,
    `def_epa_per_play`, `off_success_rate`. Chosen (not the ~140 other keys
    that table carries) because they are the three most standard, widely
    understood efficiency numbers in public football analytics -- points
    added per offensive play, points conceded per defensive play, and the
    rate of "successful" plays -- and because a 3-field addition keeps this a
    small, restrained feature set rather than a second unrestrained search
    over ~140 engineered columns. Where `pbp_available` is false (pre-2016,
    or one side missing a prior week), these three features are null/NaN,
    never zero-filled and never dropped from the row.
  * Home-field advantage is NOT a literal feature -- it is the model
    intercept (ridge) / the tree ensemble's implicit prior (LightGBM), and
    for Baseline A it IS the entire model (see below).

`market_spread`/`market_total` NEVER appear as a candidate INPUT feature --
only as the reference `-market_spread` implied-margin baseline.

FOLD SCHEME (predeclared). Expanding, whole-season, outer folds: train on
every available season strictly before S, score season S, for S from
`first_test_season` through the dataset's last complete season. Whole seasons
never split a game's home/away perspective across folds because
`build_football_dataset` already emits exactly one row per game (confirmed by
reading `load_games`: `WHERE home=1`, so there is no separate away-perspective
row to leak across folds in the first place -- the predeclared spec's "keep
both rows together" concern does not apply to this dataset shape, and this
script does not need to enforce it).

`first_test_season = min_season + MIN_TRAIN_SEASONS`. `MIN_TRAIN_SEASONS = 3`
or ~750-800 games of history: chosen because it is comfortably larger than
this file's 14-feature vector (so neither candidate is data-starved even in
its very first fold), while still leaving the large majority of the 1999-2025
span (23 of 27 seasons) available to evaluate rather than burned as warm-up.
Two more extreme choices were considered and rejected: starting at
`min_season + 1` gives the first ridge/LightGBM fit only ~260 games against
14 features, plausibly still fittable but a needlessly thin start when
history is this cheap to include; starting at 2016 (the first pbp season)
alone would have discarded 17 seasons this project explicitly wants era-
compared (pre-pbp vs pbp-available), which is one of the two predeclared
breakdowns below.

Inner selection, strictly inside each outer training block: the block's
weeks, sorted chronologically, are split at the 80% mark -- the earliest 80%
of weeks train, the most recent 20% validate the 3 ridge alphas and the 3
LightGBM configs. The outer test season S is NEVER part of this split. The
winning configuration (lowest inner MAE) is then refit on the FULL outer
training block (not just the inner-train slice) before scoring season S --
using the inner-validation weeks' games for the final fit is standard
practice once the config is already chosen and does not touch season S.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

try:
    import lightgbm as lgb
    LIGHTGBM_IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - exercised only if the venv lacks it
    lgb = None
    LIGHTGBM_IMPORT_ERROR = f'{type(exc).__name__}: {exc}'

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dataset as shared_dataset  # noqa: E402

SCHEMA = 'stage3-team-strength-v1'
SEED = 30717  # fixed before this script was ever run against the real database

# --- Predeclared feature list -----------------------------------------------
PBP_FIELDS = ['off_epa_per_play', 'def_epa_per_play', 'off_success_rate']
FEATURE_NAMES = [
    'home_rest', 'away_rest', 'rest_diff', 'div_game',
    'home_form_margin', 'away_form_margin',
    'home_form_count', 'away_form_count',
    'home_form_total', 'away_form_total',
    'pbp_available',
] + [f'pbp_diff_{k}' for k in PBP_FIELDS]

# --- Predeclared hyperparameter grids ---------------------------------------
# Features are standardized (mean 0, unit variance) before Ridge sees them, so
# alpha is directly comparable to the number of standardized-feature-units of
# shrinkage. 1.0 is light (close to OLS on 14 features), 100.0 is heavy
# shrinkage (the same order of magnitude market_lab.py already uses for a
# similarly-sized standardized feature set, `Ridge(alpha=100)`), 10.0 sits
# between the two. Three points spanning two orders of magnitude give the
# inner-fold selection room to actually distinguish under- from over-fitting.
RIDGE_ALPHAS = [1.0, 10.0, 100.0]

# Outer training blocks range from ~750 games (first fold) to ~6,500 games
# (last fold) against 14 features -- generous relative to feature count, but
# an NFL season's within-season variance is high, so trees deep enough to
# memorize matchup-specific noise are the real risk, not underfitting.
# max_depth 2-3 (4-8 leaves) keeps every leaf statistically meaningful even in
# the smallest fold; min_child_samples 15-40 guards the same thing directly.
# The three configs vary "how many shallow trees, how slow" rather than tree
# depth, since depth is the dimension most likely to memorize noise here.
LGB_CONFIGS = [
    {'name': 'few_shallow', 'params': {
        'n_estimators': 40, 'max_depth': 2, 'num_leaves': 4,
        'min_child_samples': 40, 'learning_rate': 0.08}},
    {'name': 'mid_shallow', 'params': {
        'n_estimators': 80, 'max_depth': 3, 'num_leaves': 7,
        'min_child_samples': 25, 'learning_rate': 0.05}},
    {'name': 'many_shallow_slow', 'params': {
        'n_estimators': 150, 'max_depth': 3, 'num_leaves': 8,
        'min_child_samples': 15, 'learning_rate': 0.03}},
]

MIN_TRAIN_SEASONS = 3
INNER_VALIDATION_FRACTION = 0.2
PBP_ERA_SPLIT_SEASON = 2016  # first season nfl_team_week_features exists


def row_features(row):
    """The predeclared 14-feature vector for one dataset row, as a dict.

    Missing values are `None` (not zero, not dropped) -- the caller decides
    how each candidate handles that (Ridge imputes per training fold;
    LightGBM's native missing-value handling consumes NaN directly).
    """
    home_hist = row.get('home_prior_games') or []
    away_hist = row.get('away_prior_games') or []

    def mean_of(entries, key):
        values = [e[key] for e in entries]
        return float(np.mean(values)) if values else None

    home_rest, away_rest = row.get('home_rest'), row.get('away_rest')
    feat = {
        'home_rest': home_rest,
        'away_rest': away_rest,
        'rest_diff': (home_rest - away_rest) if (home_rest is not None and away_rest is not None) else None,
        'div_game': 1.0 if row.get('div_game') else 0.0,
        'home_form_margin': mean_of(home_hist, 'margin'),
        'away_form_margin': mean_of(away_hist, 'margin'),
        'home_form_count': float(len(home_hist)),
        'away_form_count': float(len(away_hist)),
        'home_form_total': mean_of(home_hist, 'total'),
        'away_form_total': mean_of(away_hist, 'total'),
        'pbp_available': 1.0 if row.get('pbp_available') else 0.0,
    }
    hp, ap = row.get('home_pbp_features'), row.get('away_pbp_features')
    for key in PBP_FIELDS:
        value = None
        if row.get('pbp_available') and isinstance(hp, dict) and isinstance(ap, dict):
            hv, av = hp.get(key), ap.get(key)
            if isinstance(hv, (int, float)) and isinstance(av, (int, float)) \
                    and np.isfinite(hv) and np.isfinite(av):
                value = float(hv) - float(av)
        feat[f'pbp_diff_{key}'] = value
    return feat


def feature_matrix(rows):
    """rows (each must already carry `_features`) -> an (n, len(FEATURE_NAMES)) float array, NaN for missing."""
    return np.array(
        [[(r['_features'][name] if r['_features'][name] is not None else np.nan) for name in FEATURE_NAMES]
         for r in rows], dtype=float)


def paired_metrics(rows, actual_key, pred_key):
    """MAE / RMSE / signed bias (mean pred - actual) over rows where both keys are present."""
    pairs = [(r[actual_key], r[pred_key]) for r in rows
             if r.get(pred_key) is not None and r.get(actual_key) is not None]
    n = len(pairs)
    if n == 0:
        return {'n': 0, 'mae': None, 'rmse': None, 'bias': None}
    errors = np.array([pred - actual for actual, pred in pairs], dtype=float)
    return {
        'n': n,
        'mae': float(np.mean(np.abs(errors))),
        'rmse': float(np.sqrt(np.mean(errors ** 2))),
        'bias': float(np.mean(errors)),
    }


def _ridge_pipeline(alpha):
    return make_pipeline(
        SimpleImputer(strategy='median'),
        StandardScaler(),
        Ridge(alpha=alpha, random_state=SEED),
    )


def _lgb_model(params):
    return lgb.LGBMRegressor(
        objective='regression', random_state=SEED, n_jobs=1, verbosity=-1,
        deterministic=True, force_row_wise=True, **params,
    )


def _inner_split(train_rows, val_fraction=INNER_VALIDATION_FRACTION):
    """Earliest (1 - val_fraction) of weeks train, the most recent `val_fraction` validate.

    Whole-week splitting, never mid-week, matching the outer fold's own
    granularity. Falls back to holding out exactly the last week if the
    fraction would otherwise produce an empty validation set (possible only
    in a very small first fold).
    """
    weeks = sorted({(r['season'], r['week']) for r in train_rows})
    cut = int(round(len(weeks) * (1 - val_fraction)))
    cut = min(max(cut, 1), len(weeks) - 1) if len(weeks) > 1 else 0
    train_weeks = set(weeks[:cut])
    val_weeks = set(weeks[cut:])
    inner_train = [r for r in train_rows if (r['season'], r['week']) in train_weeks]
    inner_val = [r for r in train_rows if (r['season'], r['week']) in val_weeks]
    return inner_train, inner_val


def run_expanding_folds(rows, min_train_seasons=MIN_TRAIN_SEASONS,
                         ridge_alphas=RIDGE_ALPHAS, lgb_configs=LGB_CONFIGS, seed=SEED):
    """The whole predeclared experiment, decoupled from any database.

    Takes `build_football_dataset(...)['rows']` (or an equivalent list of row
    dicts with the same shape) and returns `(folds, all_predicted_rows)`:
    `folds` is one dict per outer test season with its inner-fold trial
    record and per-fold metrics; `all_predicted_rows` is every scored row
    (across every fold) carrying its predictions, for the pooled/era tables.

    Deterministic given `rows` and `seed`: no randomness anywhere touches the
    outer test season before it is scored, and both candidate families are
    seeded.
    """
    if lgb is None:
        raise RuntimeError(
            f'lightgbm is not importable in this interpreter ({LIGHTGBM_IMPORT_ERROR}); '
            'per the predeclared spec, fall back to reporting ridge alone rather than '
            'installing a new dependency.')

    for r in rows:
        if '_features' not in r:
            r['_features'] = row_features(r)
        r.setdefault('_market_pred', (-r['market_spread']) if r.get('market_spread') is not None else None)

    seasons = sorted({r['season'] for r in rows})
    if not seasons:
        return [], []
    first_test_season = seasons[0] + min_train_seasons
    test_seasons = [s for s in seasons if s >= first_test_season]

    folds = []
    all_predicted_rows = []
    for season in test_seasons:
        train_rows = [r for r in rows if r['season'] < season]
        test_rows = [r for r in rows if r['season'] == season]
        if not train_rows or not test_rows:
            continue
        inner_train, inner_val = _inner_split(train_rows)
        Xtr_inner, ytr_inner = feature_matrix(inner_train), np.array([r['actual_margin'] for r in inner_train])
        Xval_inner, yval_inner = feature_matrix(inner_val), np.array([r['actual_margin'] for r in inner_val])

        ridge_trials = []
        for alpha in ridge_alphas:
            model = _ridge_pipeline(alpha).fit(Xtr_inner, ytr_inner)
            inner_mae = float(mean_absolute_error(yval_inner, model.predict(Xval_inner)))
            ridge_trials.append({'alpha': alpha, 'inner_mae': inner_mae})
        best_ridge = min(ridge_trials, key=lambda t: t['inner_mae'])

        lgb_trials = []
        for cfg in lgb_configs:
            model = _lgb_model(cfg['params']).fit(Xtr_inner, ytr_inner)
            inner_mae = float(mean_absolute_error(yval_inner, model.predict(Xval_inner)))
            lgb_trials.append({'name': cfg['name'], 'params': cfg['params'], 'inner_mae': inner_mae})
        best_lgb = min(lgb_trials, key=lambda t: t['inner_mae'])

        Xtr_full = feature_matrix(train_rows)
        ytr_full = np.array([r['actual_margin'] for r in train_rows])
        Xtest = feature_matrix(test_rows)

        ridge_final = _ridge_pipeline(best_ridge['alpha']).fit(Xtr_full, ytr_full)
        lgb_final = _lgb_model(next(c['params'] for c in lgb_configs if c['name'] == best_lgb['name'])) \
            .fit(Xtr_full, ytr_full)
        baseline_a_constant = float(np.mean(ytr_full))

        ridge_pred = ridge_final.predict(Xtest)
        lgb_pred = lgb_final.predict(Xtest)
        for r, rp, lp in zip(test_rows, ridge_pred, lgb_pred):
            r['_baseline_a_pred'] = baseline_a_constant
            r['_ridge_pred'] = float(rp)
            r['_lgb_pred'] = float(lp)

        def fold_metrics(pred_key, support_rows=test_rows):
            full = paired_metrics(support_rows, 'actual_margin', pred_key)
            common = paired_metrics(
                [r for r in support_rows if r.get('_market_pred') is not None],
                'actual_margin', pred_key)
            return {'full_coverage': full, 'common_support_with_market': common}

        fold = {
            'season': season,
            'n_train_games': len(train_rows),
            'n_test_games': len(test_rows),
            'inner_train_weeks': len({(r['season'], r['week']) for r in inner_train}),
            'inner_val_weeks': len({(r['season'], r['week']) for r in inner_val}),
            'ridge_trials': ridge_trials, 'ridge_selected_alpha': best_ridge['alpha'],
            'lgb_trials': lgb_trials, 'lgb_selected_config': best_lgb['name'],
            'baseline_a_constant': baseline_a_constant,
            'metrics': {
                'baseline_zero_info': fold_metrics('_baseline_a_pred'),
                'baseline_market': fold_metrics('_market_pred'),
                'ridge': fold_metrics('_ridge_pred'),
                'lightgbm': fold_metrics('_lgb_pred'),
            },
        }
        folds.append(fold)
        all_predicted_rows.extend(test_rows)
    return folds, all_predicted_rows


def era_breakdown(all_predicted_rows):
    eras = {
        'pre_2016_no_pbp': [r for r in all_predicted_rows if r['season'] < PBP_ERA_SPLIT_SEASON],
        f'{PBP_ERA_SPLIT_SEASON}_plus_pbp_available': [r for r in all_predicted_rows if r['season'] >= PBP_ERA_SPLIT_SEASON],
    }
    out = {}
    for era_name, era_rows in eras.items():
        out[era_name] = {
            'n_games': len(era_rows),
            'n_seasons': len({r['season'] for r in era_rows}),
            'baseline_zero_info': paired_metrics(era_rows, 'actual_margin', '_baseline_a_pred'),
            'baseline_market': paired_metrics(era_rows, 'actual_margin', '_market_pred'),
            'ridge': paired_metrics(era_rows, 'actual_margin', '_ridge_pred'),
            'lightgbm': paired_metrics(era_rows, 'actual_margin', '_lgb_pred'),
        }
    return out


def build_verdict(overall, era):
    def fmt(m):
        return f"MAE {m['mae']:.3f} / RMSE {m['rmse']:.3f} / bias {m['bias']:+.3f} (n={m['n']})" if m['n'] else 'no coverage'

    market_mae = overall['baseline_market']['mae']
    zero_mae = overall['baseline_zero_info']['mae']
    ridge_mae = overall['ridge']['mae']
    lgb_mae = overall['lightgbm']['mae']
    lines = [
        f"Zero-information baseline (train-fold mean home margin): {fmt(overall['baseline_zero_info'])}.",
        f"Market baseline (-market_spread): {fmt(overall['baseline_market'])}.",
        f"Ridge (alpha selected per fold via inner chronological validation): {fmt(overall['ridge'])}.",
        f"LightGBM (config selected per fold via inner chronological validation): {fmt(overall['lightgbm'])}.",
    ]
    if market_mae is not None:
        beats_market = [name for name, mae in (('ridge', ridge_mae), ('lightgbm', lgb_mae)) if mae is not None and mae < market_mae]
        if not beats_market:
            lines.append(
                'Neither candidate beat the market baseline on pooled MAE across all outer folds. '
                'Per the predeclared decision rule, this is reported as the finding: the market baseline wins, '
                'and no further feature or model search was performed to try to change that.')
        else:
            margin = market_mae - min(ridge_mae if ridge_mae is not None else float('inf'),
                                       lgb_mae if lgb_mae is not None else float('inf'))
            lines.append(
                f"{' and '.join(beats_market)} beat the market baseline on pooled MAE by {margin:.3f} points/game. "
                'This is a descriptive comparison on development data (previously inspected history), not a '
                'confirmed edge -- no untouched future evaluation or price-qualified paper trading has been run.')
    if zero_mae is not None and ridge_mae is not None and lgb_mae is not None:
        vs_zero = min(zero_mae - ridge_mae, zero_mae - lgb_mae)
        if vs_zero < 0.05:
            lines.append(
                'The gap between the best learned candidate and the zero-information constant baseline is small '
                '(under 0.05 points/game MAE); most of the achievable reduction in error is already captured by '
                'simply knowing the historical mean home-field margin, not by the additional features.')
    pre = era.get('pre_2016_no_pbp', {})
    post = era.get('2016_plus_pbp_available', {})
    if pre.get('n_games') and post.get('n_games'):
        lines.append(
            f"Era split: pre-2016 (no pbp features, n={pre['n_games']} games) ridge MAE "
            f"{pre['ridge']['mae']:.3f} vs 2016+ (pbp available, n={post['n_games']} games) ridge MAE "
            f"{post['ridge']['mae']:.3f}; the same comparison for LightGBM is "
            f"{pre['lightgbm']['mae']:.3f} vs {post['lightgbm']['mae']:.3f}.")
    return ' '.join(lines)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False, default=str))
    tmp.replace(path)


def run(args):
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    dataset = shared_dataset.build_football_dataset(
        args.db, min_season=args.min_season, through_season=args.through_season)
    rows = dataset['rows']
    code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + code_hash[:8]

    folds, all_predicted_rows = run_expanding_folds(rows, min_train_seasons=args.min_train_seasons)
    overall = {
        'n_games': len(all_predicted_rows),
        'n_folds': len(folds),
        'baseline_zero_info': paired_metrics(all_predicted_rows, 'actual_margin', '_baseline_a_pred'),
        'baseline_market': paired_metrics(all_predicted_rows, 'actual_margin', '_market_pred'),
        'ridge': paired_metrics(all_predicted_rows, 'actual_margin', '_ridge_pred'),
        'lightgbm': paired_metrics(all_predicted_rows, 'actual_margin', '_lgb_pred'),
    }
    era = era_breakdown(all_predicted_rows)
    # season -> row-level pooled metrics (one row per season, not per fold object,
    # so a thin season's sample size is visible right next to its own error).
    season_table = []
    for season in sorted({r['season'] for r in all_predicted_rows}):
        season_rows = [r for r in all_predicted_rows if r['season'] == season]
        season_table.append({
            'season': season,
            'n_games': len(season_rows),
            'baseline_zero_info': paired_metrics(season_rows, 'actual_margin', '_baseline_a_pred'),
            'baseline_market': paired_metrics(season_rows, 'actual_margin', '_market_pred'),
            'ridge': paired_metrics(season_rows, 'actual_margin', '_ridge_pred'),
            'lightgbm': paired_metrics(season_rows, 'actual_margin', '_lgb_pred'),
        })

    import importlib.metadata
    packages = {p: importlib.metadata.version(p) for p in ('scikit-learn', 'numpy', 'lightgbm')}

    report = {
        'schema': SCHEMA,
        'run_id': run_id,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'authority': 'research_only',
        'production_changed': False,
        'db_path': str(Path(args.db).resolve()),
        'dataset_version': dataset['dataset_version'],
        'min_season': args.min_season, 'through_season': args.through_season,
        'rows_total_in_dataset': len(rows),
        'quarantine_counts': {
            'games_excluded_count': len(dataset['quarantine'].get('games_excluded', [])),
            'team_week_features_excluded_count': len(dataset['quarantine'].get('team_week_features_excluded', [])),
        },
        'target': 'actual_margin (home score - away score); totals are out of scope for this experiment',
        'feature_list': FEATURE_NAMES,
        'pbp_fields_used': PBP_FIELDS,
        'seed': SEED,
        'fold_scheme': {
            'kind': 'expanding whole-season outer folds; chronological 80/20 inner week split for hyperparameter selection',
            'min_train_seasons': args.min_train_seasons,
            'first_test_season': (min(r['season'] for r in rows) + args.min_train_seasons) if rows else None,
            'test_seasons': [f['season'] for f in folds],
            'inner_validation_fraction': INNER_VALIDATION_FRACTION,
            'pbp_era_split_season': PBP_ERA_SPLIT_SEASON,
        },
        'hyperparameter_grids': {
            'ridge_alpha': RIDGE_ALPHAS,
            'lightgbm_configs': LGB_CONFIGS,
        },
        'folds': folds,
        'overall': overall,
        'per_era': era,
        'per_season': season_table,
        'packages': packages,
        'limitations': [
            'This is development data: the 1999-2025 outcomes evaluated here have been repeatedly inspected '
            'across this project\'s prior audits. Rearranging them into chronological folds tests algorithmic '
            'chronology; it does not make them an untouched holdout. A positive result here is exploratory, '
            'not confirmed, until scored again on genuinely new, previously-unseen games.',
            'The market baseline (-market_spread) has essentially complete coverage in this database for every '
            'season 1999-2025 (confirmed: 0 null spreads among home rows), so the "common support with market" '
            'and "full coverage" metrics reported here are expected to coincide almost exactly; both are still '
            'reported per the predeclared spec rather than assumed equal.',
            'Totals (actual_total) were explicitly out of scope for this experiment and were not modeled.',
            'No price/odds-qualified paper betting return is computed here -- this experiment scores prediction '
            'error against the actual margin and the market\'s implied margin, not staked profit; that is a '
            'separate, later question per the master plan\'s stage sequencing.',
        ],
    }
    report['verdict'] = build_verdict(overall, era)

    atomic_json(out_dir / f'{run_id}.json', report)
    atomic_json(out_dir / 'latest.json', report)
    print(json.dumps({'run_id': run_id, 'rows': len(rows), 'folds': len(folds),
                       'overall': overall, 'verdict': report['verdict']}, indent=2), flush=True)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--min-season', type=int, default=1999)
    p.add_argument('--through-season', type=int, default=2025)
    p.add_argument('--min-train-seasons', type=int, default=MIN_TRAIN_SEASONS)
    run(p.parse_args())
