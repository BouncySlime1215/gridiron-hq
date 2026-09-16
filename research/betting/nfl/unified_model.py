"""One learned margin pipeline: ridge + shallow trees → learned blend → calibration.

The retained recipe uses separate chronological blocks for base fitting/tuning,
combination weights, and final calibration. No outer evaluation outcomes enter
any of them. Reuses Stage 3 estimators and the research lab's simplex ridge.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

import model_artifact as ma
import stage3_team_strength as stage3

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from expert_selector_lab import simplex_ridge, cluster_families

RECIPE = {
    'version': 'unified-margin-recipe-v1',
    'families': ['ridge', 'lightgbm'],
    'ridge_alphas': stage3.RIDGE_ALPHAS,
    'lightgbm_configs': stage3.LGB_CONFIGS,
    'combination_weeks': 24, 'calibration_weeks': 12,
    'combination_alpha': 10.0,
    'minimum_base_rows': 200, 'minimum_combination_rows': 100,
    'minimum_calibration_rows': 100,
    'combination': 'expert_selector_lab.simplex_ridge; nonnegative weights summing to one',
    'calibration': 'held-out residual distribution and split-conformal absolute-error interval',
    'outer_results_used_for_selection': False,
    'authority': 'research_only',
}


def row_id(r):
    return f"{r['season']}-w{r['week']:02d}-{r['home']}@{r['away']}"


def chronological_blocks(rows):
    ids = [row_id(r) for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate game identity in unified training data')
    weeks = sorted({(r['season'], r['week']) for r in rows})
    n_combo, n_cal = RECIPE['combination_weeks'], RECIPE['calibration_weeks']
    if len(weeks) <= n_combo + n_cal:
        raise ValueError('insufficient whole weeks for independent fitting, blending and calibration')
    base_weeks = set(weeks[:-(n_combo + n_cal)])
    combo_weeks = set(weeks[-(n_combo + n_cal):-n_cal])
    cal_weeks = set(weeks[-n_cal:])
    base = [r for r in rows if (r['season'], r['week']) in base_weeks]
    combo = [r for r in rows if (r['season'], r['week']) in combo_weeks]
    calibration = [r for r in rows if (r['season'], r['week']) in cal_weeks]
    base = ma.eligible_football_rows(base, min(ma.shared_dataset.stamp(r['decision_at']) for r in combo))
    combo = ma.eligible_football_rows(combo, min(ma.shared_dataset.stamp(r['decision_at']) for r in calibration))
    for name, block, minimum in [('base', base, RECIPE['minimum_base_rows']),
        ('combination', combo, RECIPE['minimum_combination_rows']),
        ('calibration', calibration, RECIPE['minimum_calibration_rows'])]:
        if len(block) < minimum:
            raise ValueError(f'insufficient {name} rows: {len(block)} < {minimum}')
    return base, combo, calibration


class UnifiedMarginModel:
    def __init__(self, models, weights, residuals, lineage):
        self.models = models
        self.weights = np.asarray(weights, dtype=float)
        self.residuals = np.asarray(residuals, dtype=float)
        self.lineage = lineage

    def components(self, X):
        return np.column_stack([model.predict(X) for model in self.models])

    def predict(self, X):
        return self.components(X) @ self.weights

    def describe(self, X):
        if len(X) != 1:
            raise ValueError('describe expects one game')
        components = self.components(X)[0]
        prediction = float(components @ self.weights)
        # Empirical integer support supplies coherent opposite-side/push
        # accounting. Its calibration still needs outer/forward evaluation.
        support, counts = np.unique(np.rint(prediction + self.residuals).astype(int), return_counts=True)
        margins = {str(int(m)): float(n / len(self.residuals)) for m, n in zip(support, counts)}
        absolute = np.sort(np.abs(self.residuals))
        rank = min(len(absolute), math.ceil((len(absolute) + 1) * .8))
        radius = float(absolute[rank - 1])
        return {
            'components': dict(zip(RECIPE['families'], map(float, components))),
            'learned_weights': dict(zip(RECIPE['families'], map(float, self.weights))),
            'margin_distribution': margins,
            'interval_80': [prediction - radius, prediction + radius],
            'calibration': {**self.lineage, 'sample_size': len(self.residuals),
                'status': 'research_calibration_requires_outer_validation',
                'coverage_guarantee': 'not established for dependent NFL games'},
        }


def fit_unified(rows, feature_names=None):
    if stage3.lgb is None:
        raise RuntimeError('unified recipe requires the already specified LightGBM dependency')
    names = list(feature_names) if feature_names is not None else list(stage3.FEATURE_NAMES)
    for r in rows:
        r['_features'] = stage3.row_features(r, feature_names=names)
    base, combo, calibration = chronological_blocks(rows)
    ridge, ridge_meta = ma.fit_ridge_artifact(base, feature_names=names)
    inner_train, inner_val = stage3._inner_split(base)
    inner_train = ma.eligible_football_rows(inner_train, min(ma.shared_dataset.stamp(r['decision_at']) for r in inner_val))
    Xtr = stage3.feature_matrix(inner_train, feature_names=names)
    ytr = np.array([r['actual_margin'] for r in inner_train])
    Xval = stage3.feature_matrix(inner_val, feature_names=names)
    yval = np.array([r['actual_margin'] for r in inner_val])
    trials = []
    for config in RECIPE['lightgbm_configs']:
        model = stage3._lgb_model(config['params']).fit(Xtr, ytr)
        trials.append({**config, 'inner_mae': float(np.mean(np.abs(model.predict(Xval) - yval)))})
    best = min(trials, key=lambda t: t['inner_mae'])
    lgb = stage3._lgb_model(best['params']).fit(
        stage3.feature_matrix(base, feature_names=names), np.array([r['actual_margin'] for r in base]))
    Xcombo = stage3.feature_matrix(combo, feature_names=names)
    P = np.column_stack([ridge.predict(Xcombo), lgb.predict(Xcombo)])
    ycombo = np.array([r['actual_margin'] for r in combo])
    weights, converged = simplex_ridge(P, ycombo, RECIPE['combination_alpha'])
    if not converged or not np.all(np.isfinite(weights)) or np.any(weights < 0) or abs(sum(weights) - 1) > 1e-9:
        raise ValueError('combination optimizer did not produce valid converged weights')
    groups, correlations = cluster_families(P, np.ones_like(P), RECIPE['families'])
    # After the weights are fixed, refit the selected base recipes on the
    # base+combination rows. Calibration outcomes still remain untouched.
    final_rows = ma.eligible_football_rows(base + combo,
        min(ma.shared_dataset.stamp(r['decision_at']) for r in calibration))
    Xfinal = stage3.feature_matrix(final_rows, feature_names=names)
    yfinal = np.array([r['actual_margin'] for r in final_rows])
    final_models = [stage3._ridge_pipeline(ridge_meta['hyperparameters']['alpha']).fit(Xfinal, yfinal),
                    stage3._lgb_model(best['params']).fit(Xfinal, yfinal)]
    Xcal = stage3.feature_matrix(calibration, feature_names=names)
    cal_components = np.column_stack([model.predict(Xcal) for model in final_models])
    residuals = np.array([r['actual_margin'] for r in calibration]) - cal_components @ weights
    lineage = {'base_selection_row_ids': list(map(row_id, base)),
        'combination_row_ids': list(map(row_id, combo)),
        'final_base_training_row_ids': list(map(row_id, final_rows)),
        'calibration_row_ids': list(map(row_id, calibration)),
        'calibration_weeks': len({(r['season'], r['week']) for r in calibration}),
        'dependent_family_groups': groups, 'component_correlations': correlations}
    model = UnifiedMarginModel(final_models, weights, residuals, lineage)
    training_hash = hashlib.sha256(json.dumps([
        {'game': row_id(r), 'features': r['_features'], 'target': r['actual_margin']} for r in rows
    ], sort_keys=True, allow_nan=False).encode()).hexdigest()
    calibration_id = hashlib.sha256(json.dumps({'rows': lineage['calibration_row_ids'],
        'residuals': residuals.tolist()}, sort_keys=True).encode()).hexdigest()
    combiner_id = hashlib.sha256(json.dumps({'rows': lineage['combination_row_ids'],
        'weights': weights.tolist(), 'recipe': RECIPE}, sort_keys=True).encode()).hexdigest()
    return model, {
        'algorithm': 'unified_margin', 'feature_names': names,
        'hyperparameters': {'recipe': RECIPE,
            'ridge_alpha': ridge_meta['hyperparameters']['alpha'], 'lightgbm': best['params'], 'weights': weights.tolist()},
        'preprocessing_steps': ['ridge: fold-fitted imputer and scaler', 'lightgbm: native missingness'],
        'seed': stage3.SEED, 'training_data_hash': training_hash,
        'ridge_selection_trials': ridge_meta['alpha_trials'], 'lightgbm_selection_trials': trials,
        'inner_training_row_ids': ridge_meta['inner_training_row_ids'],
        'inner_validation_row_ids': ridge_meta['inner_validation_row_ids'],
        'calibrator_id': calibration_id, 'combiner_id': combiner_id,
        'component_lineage': lineage,
    }
