"""The market-correction head: learn a correction to the closing spread.

Stage 3's own instruction (the detailed master specification, Stage 3
bullet): "For the betting head, learn the correction to the decision-time
market. Include chronological football-model predictions as features; their
training must precede each example too." Nothing in the repository has done
this. `stage3_team_strength.py` states outright that `market_spread` "NEVER
appear[s] as a candidate INPUT feature" for the football model -- correct
for that model, but it means the walk-forward audit that measured MAE 10.271
against a market MAE of 9.779 (`docs/betting-model/plans/LATEST-PLAN.md`,
2021-2026 run) compared a market-blind forecast to a forecast built FROM the
market. That is not evidence the model can't help; it is evidence a model
never allowed to see the market can't beat one that only sees the market.
This module is the actual test.

TARGET. `market_residual = actual_margin - market_prediction`, where
`market_prediction = -market_spread` (the same sign convention every other
comparison in this codebase already uses). Predicting the residual, not raw
margin, is what makes this a CORRECTION rather than a second, redundant
margin model.

THE STACKING DISCIPLINE, which is the one way this experiment could quietly
turn into leakage dressed as improvement. The football prediction fed to the
correction head must come from a football model that never saw the game
being corrected. This reuses `unified_model.chronological_blocks`'s existing
base/combination/calibration split unmodified:

  - `base` weeks fit the football model (frozen 14-feature ridge, same
    contract `stage3.FEATURE_NAMES` already uses -- deliberately NOT the
    unified margin/LightGBM blend, so this experiment isolates "does the
    market see something the football model doesn't" from "which football
    model is best," one question at a time).
  - `combination` weeks are scored by that base-only football model (a
    genuine out-of-fold prediction -- the model fitting on `combo` has never
    seen `combo`'s own outcomes) and used to fit the correction head.
  - `calibration` weeks: football model refit on base+combination (mirroring
    `unified_model.fit_unified`'s own final-refit step), scored, corrected,
    and used only to compute residuals/interval width -- never to select
    anything.

FEATURES for the correction head, deliberately small: the out-of-fold
football prediction, the closing market spread itself, and the
opening-to-closing movement. Three numbers, not a second 14-feature model --
the question this asks is narrow ("does the market encode something the
football model doesn't"), and a narrow question gets a narrow feature set,
gated on whether it even helps before anything bigger is justified.

WHAT THIS DOES NOT CLAIM. A game missing `market_spread` or `open_spread`
cannot be corrected and is left unscored, never defaulted. This has zero
betting authority and is not wired into `weekly_training.py`'s production
path -- Stage 3's own baselines-first discipline: the market alone and the
football-alone prediction must both be beaten on the SAME games before this
is anything but a measured research candidate.
"""
import numpy as np

import model_artifact as ma
import stage3_team_strength as stage3
from unified_model import RECIPE as UNIFIED_RECIPE
from unified_model import chronological_blocks, row_id

RECIPE_V1 = {
    'version': 'market-correction-recipe-v1',
    'football_family': 'ridge (frozen 14-feature contract, stage3.FEATURE_NAMES)',
    'correction_family': 'ridge',
    'correction_alpha_grid': [1.0, 10.0, 30.0, 100.0],
    'correction_feature_names': ['football_prediction', 'market_spread', 'market_movement'],
    'target': 'market_residual = actual_margin - market_prediction (market_prediction = -market_spread)',
    'combination_weeks': UNIFIED_RECIPE['combination_weeks'],
    'calibration_weeks': UNIFIED_RECIPE['calibration_weeks'],
    'minimum_base_rows': UNIFIED_RECIPE['minimum_base_rows'],
    'minimum_combination_rows': UNIFIED_RECIPE['minimum_combination_rows'],
    'minimum_calibration_rows': UNIFIED_RECIPE['minimum_calibration_rows'],
    'outer_results_used_for_selection': False,
    'authority': 'research_only',
}

# RUNBOOK §4.1 (Phase 3): adds the two player-weighted availability deficits
# -- `dataset.football_feature_row` puts these on a row only when its caller
# passed `build_football_dataset(..., availability_path=...)`; a row built
# without that path simply never carries the keys, so `_correction_matrix`
# reads them as missing (NaN), not zero, exactly as for a game with no
# admissible injury report. RECIPE_V2 is additive, not a replacement -- the
# first three columns are byte-identical to RECIPE_V1's, so a run with no
# availability evidence anywhere degenerates to RECIPE_V1's own fit (see
# test_market_correction.py's `RecipeVersioningTests`).
RECIPE_V2 = {
    **RECIPE_V1,
    'version': 'market-correction-recipe-v2',
    'correction_feature_names': RECIPE_V1['correction_feature_names']
        + ['home_availability_deficit', 'away_availability_deficit'],
    # A feature the combination block has barely seen cannot be fit on. The
    # first real run of v2 (2021 test weeks, whose combination block is mostly
    # 2020 -- before any injury row exists) had ~14 non-missing availability
    # values among ~350 rows: the imputer filled a near-constant, the scaler
    # divided by a near-zero spread, and an ordinary deficit at predict time
    # became a correction of +2,000 points. Any feature with fewer than this
    # many non-missing combination rows is dropped from THAT week's fit (and
    # recorded), so the week degrades to the features it can support rather
    # than extrapolating from a handful of values. The v1 three are never
    # affected: they are present wherever market evidence is.
    'minimum_feature_support': 100,
}

# RUNBOOK Sec4.1 (Phase 3 continued): the injury/availability measurement
# (RECIPE_V2) found no significant difference against v1 -- +0.030 CI
# [-0.006, 0.071] on the correction MAE -- most likely because only 43% of
# games carry any admissible injury evidence at all. Starting-QB quality is
# the next real signal: full coverage from 2021 (`nfl_depth`'s own coverage
# floor, not an injury-report-dependent one) and a large, undisputed driver
# of spread movement the frozen 14 football features cannot see (they carry
# team EPA over a multi-week trailing window, which embeds whoever played
# quarterback last month, not whoever plays this week). `home_qb_qbr` /
# `away_qb_qbr` are put on a row only by `dataset.football_feature_row` when
# the caller passed `build_football_dataset(..., qb_quality_path=...)`
# (`scripts/export-qb-quality-features.mjs`); absent that path the keys never
# appear and `_correction_matrix` reads them as missing (NaN), exactly like
# RECIPE_V2's availability columns for a dataset built without
# `availability_path`. RECIPE_V3 is additive on top of RECIPE_V2 -- the first
# five columns are byte-identical to RECIPE_V2's own -- so a run with no
# QB-quality evidence anywhere degenerates to RECIPE_V2's fit (see
# test_market_correction.py's `RecipeVersioningTests`), and one with no
# availability OR QB-quality evidence degenerates all the way to RECIPE_V1's.
RECIPE_V3 = {
    **RECIPE_V2,
    'version': 'market-correction-recipe-v3',
    'correction_feature_names': RECIPE_V2['correction_feature_names'] + ['home_qb_qbr', 'away_qb_qbr'],
}

RECIPE = RECIPE_V1  # default / backward-compatible name


def market_prediction(r):
    return -r['market_spread'] if r.get('market_spread') is not None else None


def has_market_evidence(r):
    return r.get('market_spread') is not None


def _correction_matrix(rows, football_preds, feature_names=None):
    """Build the correction ridge's input columns for `feature_names`
    (default: RECIPE_V1's three). `football_prediction` comes from the
    out-of-fold football model passed in; every other name is read straight
    off the row and left `NaN` -- never defaulted to zero -- when absent,
    so `stage3._ridge_pipeline`'s own median imputer is what handles missing
    evidence, not a silent assumption here.
    """
    names = feature_names or RECIPE_V1['correction_feature_names']
    return np.array([[
        football_preds[i] if name == 'football_prediction'
            else (r[name] if r.get(name) is not None else np.nan)
        for name in names
    ] for i, r in enumerate(rows)], dtype=float)


class MarketCorrectionModel:
    def __init__(self, football_model, correction_model, residuals, lineage, feature_names=None):
        self.football_model = football_model
        self.correction_model = correction_model
        self.residuals = np.asarray(residuals, dtype=float)
        self.lineage = lineage
        self.feature_names = feature_names or RECIPE_V1['correction_feature_names']

    def predict_rows(self, rows):
        """One prediction per row, or `None` for a row with no market evidence.

        `rows` must already carry `_features` (the frozen 14, via
        `stage3.row_features`). Never substitutes a football-only guess for a
        missing market prediction -- that would silently change what this
        model actually is.
        """
        out = []
        eligible_idx = [i for i, r in enumerate(rows) if has_market_evidence(r)]
        if eligible_idx:
            X = stage3.feature_matrix([rows[i] for i in eligible_idx])
            football_preds = self.football_model.predict(X)
            corr_X = _correction_matrix([rows[i] for i in eligible_idx], football_preds, self.feature_names)
            corrections = self.correction_model.predict(corr_X)
            by_idx = {i: market_prediction(rows[i]) + float(corrections[k])
                      for k, i in enumerate(eligible_idx)}
        else:
            by_idx = {}
        for i in range(len(rows)):
            out.append(by_idx.get(i))
        return out

    def describe(self, row):
        if not has_market_evidence(row):
            return {'available': False, 'reason': 'no_market_evidence_for_this_game'}
        [prediction] = self.predict_rows([row])
        absolute = np.sort(np.abs(self.residuals))
        rank = min(len(absolute), int(np.ceil((len(absolute) + 1) * .8)))
        radius = float(absolute[rank - 1]) if len(absolute) else None
        return {
            'available': True,
            'predicted_margin': prediction,
            'market_prediction': market_prediction(row),
            'correction': prediction - market_prediction(row),
            'interval_80': [prediction - radius, prediction + radius] if radius is not None else None,
            'calibration': {**self.lineage, 'sample_size': len(self.residuals),
                'status': 'research_calibration_requires_outer_validation'},
        }


def fit_market_correction(rows, alpha_grid=None, recipe=None):
    """Fit the correction head. `rows` must already be eligible/cutoff-filtered
    (same contract as `unified_model.fit_unified`); `stage3.row_features` is
    applied here with the frozen 14, matching the football model's own
    contract exactly regardless of what a caller upstream may have set on
    `_features` for a different model.

    `recipe` selects the correction feature set -- `RECIPE_V1` (default),
    `RECIPE_V2` (adds the two availability-deficit columns), or `RECIPE_V3`
    (adds the two starting-QB-quality columns on top of V2's own); see
    RUNBOOK §4.1. Only the correction head's own feature list changes; the
    football base model underneath is unaffected either way (still the
    frozen 14).
    """
    recipe = recipe or RECIPE_V1
    feature_names = recipe['correction_feature_names']
    alpha_grid = list(alpha_grid) if alpha_grid else list(recipe['correction_alpha_grid'])
    for r in rows:
        r['_features'] = stage3.row_features(r, feature_names=stage3.FEATURE_NAMES)
    base, combo, calibration = chronological_blocks(rows)

    football_model, football_meta = ma.fit_ridge_artifact(base, feature_names=stage3.FEATURE_NAMES)

    combo_with_market = [r for r in combo if has_market_evidence(r)]
    if len(combo_with_market) < 20:
        raise ValueError(
            f'insufficient market-evidenced combination rows: {len(combo_with_market)} < 20')
    Xcombo = stage3.feature_matrix(combo_with_market)
    football_pred_combo = football_model.predict(Xcombo)
    corr_Xcombo = _correction_matrix(combo_with_market, football_pred_combo, feature_names)
    # Per-feature minimum support (see RECIPE_V2['minimum_feature_support']):
    # a column with too few non-missing combination rows is dropped from this
    # fit entirely -- from the matrix AND from the model's own feature list,
    # so predict time builds the same columns the fit saw. Recorded, never
    # silent.
    min_support = int(recipe.get('minimum_feature_support', 0) or 0)
    dropped = []
    if min_support:
        support = np.sum(~np.isnan(corr_Xcombo), axis=0)
        dropped = [name for name, n in zip(feature_names, support) if n < min_support]
        if dropped:
            feature_names = [name for name in feature_names if name not in dropped]
            corr_Xcombo = _correction_matrix(combo_with_market, football_pred_combo, feature_names)
    y_residual = np.array([r['actual_margin'] - market_prediction(r) for r in combo_with_market])
    # Row dicts compare by VALUE, not identity, so `.index()` risks matching
    # the wrong row when two happen to be equal (sparse feature rows make
    # this a real, not theoretical, risk). Key by `row_id` instead.
    row_position = {row_id(r): i for i, r in enumerate(combo_with_market)}

    inner_train, inner_val = stage3._inner_split(combo_with_market)
    trials = []
    if inner_train and inner_val:
        idx_train = [row_position[row_id(r)] for r in inner_train]
        idx_val = [row_position[row_id(r)] for r in inner_val]
        Xtr, ytr = corr_Xcombo[idx_train], y_residual[idx_train]
        Xval, yval = corr_Xcombo[idx_val], y_residual[idx_val]
        for alpha in alpha_grid:
            model = stage3._ridge_pipeline(alpha).fit(Xtr, ytr)
            inner_mae = float(np.mean(np.abs(model.predict(Xval) - yval)))
            trials.append({'alpha': alpha, 'inner_mae': inner_mae})
        best = min(trials, key=lambda t: t['inner_mae'])
    else:
        trials = [{'alpha': a, 'inner_mae': None} for a in alpha_grid]
        best = trials[len(trials) // 2]

    correction_model = stage3._ridge_pipeline(best['alpha']).fit(corr_Xcombo, y_residual)

    # Final refit for calibration: football model on base+combo (mirroring
    # unified_model's own final-refit step), never touching calibration
    # outcomes.
    final_rows = ma.eligible_football_rows(base + combo,
        min(ma.shared_dataset.stamp(r['decision_at']) for r in calibration))
    Xfinal = stage3.feature_matrix(final_rows)
    yfinal = np.array([r['actual_margin'] for r in final_rows])
    final_football = stage3._ridge_pipeline(football_meta['hyperparameters']['alpha']).fit(Xfinal, yfinal)

    calibration_with_market = [r for r in calibration if has_market_evidence(r)]
    if len(calibration_with_market) < 20:
        raise ValueError(
            f'insufficient market-evidenced calibration rows: {len(calibration_with_market)} < 20')
    Xcal = stage3.feature_matrix(calibration_with_market)
    football_pred_cal = final_football.predict(Xcal)
    corr_Xcal = _correction_matrix(calibration_with_market, football_pred_cal, feature_names)
    correction_cal = correction_model.predict(corr_Xcal)
    predicted_margin_cal = np.array([market_prediction(r) for r in calibration_with_market]) + correction_cal
    residuals = np.array([r['actual_margin'] for r in calibration_with_market]) - predicted_margin_cal

    lineage = {
        'base_row_ids': list(map(row_id, base)),
        'combination_row_ids': list(map(row_id, combo_with_market)),
        'final_football_training_row_ids': list(map(row_id, final_rows)),
        'calibration_row_ids': list(map(row_id, calibration_with_market)),
        'combination_rows_dropped_no_market_evidence': len(combo) - len(combo_with_market),
        'calibration_rows_dropped_no_market_evidence': len(calibration) - len(calibration_with_market),
        'correction_features_used': list(feature_names),
        'correction_features_dropped_insufficient_support': dropped,
    }
    model = MarketCorrectionModel(final_football, correction_model, residuals, lineage,
                                   feature_names=feature_names)
    meta = {
        'algorithm': 'market_correction',
        'recipe': recipe,
        'hyperparameters': {
            'football_alpha': football_meta['hyperparameters']['alpha'],
            'correction_alpha': best['alpha'],
        },
        'correction_selection_trials': trials,
        'football_selection_trials': football_meta['alpha_trials'],
        'lineage': lineage,
    }
    return model, meta
