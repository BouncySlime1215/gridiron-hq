"""Package C, extended: LightGBM/XGBoost/CatBoost across three targets.

Read research/README.md and docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md first.
This script is a SIBLING to market_lab.py, not a replacement. market_lab.py's
pilot (opening-to-closing movement regression, four sklearn-ish families) is
untouched, still runs, and still writes server/data/market-lab/. This script
extends the research program with:

  - Three targets instead of one: opening-to-closing MOVEMENT regression
    (market_lab's original target, reproduced here for a fair same-features
    comparison), COVER/OVER classification, and QUANTILE regression of the
    market residual.
  - Three new bounded model families per target: LightGBM, XGBoost, CatBoost,
    alongside the existing ridge/HistGB/ExtraTrees baselines and a genuine
    market-only baseline in every comparison.
  - The five specified residual interaction features, missingness flags and
    age-of-information features (see `build_dataset` below).
  - A market-anchored probability branch: logit(p) = logit(p_market) +
    shrinkage * residual(features), shrinkage chosen only on earlier folds.
  - A quantile-coherence check and a key-number push-mass diagnostic.
  - An LGBMRanker branch over per-game opportunities, evaluated by REAL paper
    ROI on top-K picks -- never by NDCG alone.
  - A leakage scan (research/leakage.py) run against the real dataset, plus
    research/test_tree_lab.py's synthetic leak that proves the scan works.

The dataset builder below is a close relative of market_lab.build_dataset,
not an import of it: it needs several team-week fields and time windows
market_lab's leaner pilot never extracts (off_qb_hit_rate, def_pressure_epa,
off_pass_rate, off_epa_volatility, a second recent-form window, per-team rest
days, stadium roof). Reusing market_lab's build_dataset was tried and would
have meant re-deriving the internal per-team history/pbp sequences from an
already-reduced dict, which is worse than writing a second, closely-mirrored
extractor. THE CHRONOLOGY-CRITICAL LINES -- the archive join, the timestamp
validation, the decision-time computation -- are copied verbatim from
market_lab.build_dataset on purpose, to avoid inventing a second, subtly
different chronology rule. If you change one, check the other.

This duplication is a real, named risk (see the master plan's Package C
section and this run's final report): two extractors that are meant to agree
on "what a decision-time-safe row looks like" can drift apart silently. A
follow-up worth doing is factoring the shared chronology block into one
importable function both scripts call.
"""
from __future__ import annotations
import argparse, collections, hashlib, itertools, json, math, sqlite3, time
from pathlib import Path
from datetime import datetime, timezone, timedelta
import numpy as np
from sklearn.base import clone
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import (ExtraTreesRegressor, HistGradientBoostingRegressor,
    ExtraTreesClassifier, HistGradientBoostingClassifier, GradientBoostingRegressor)
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, log_loss, brier_score_loss, ndcg_score
import joblib

from market_lab import stamp, digest, atomic_json, american_profit, settlement, time_folds, FrozenTimeCV, cluster_interval
from leakage import detect_feature_leakage

VERSION = 'tree-lab-v1'
SEED = 83017
THRESHOLD = 0.5          # movement-target abstention, points -- same convention as market_lab
PROB_EDGE = 0.02         # classification/logit paper-bet trigger: model must beat market prob by this much
QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]
SHRINKAGE_GRID = [0.0, 0.25, 0.5, 0.75, 1.0]
KEY_NUMBERS = [3, 7, 10, 4, 6, 14, 1, 2]

# Base team-week aggregates market_lab already averages, plus the ones the
# five specified interactions need. Adding fields here only widens the
# feature set; it does not change how any of them is computed.
BASE_PB_KEYS = ['off_epa_per_play', 'def_epa_per_play', 'off_success_rate',
    'def_success_rate', 'off_proe', 'off_seconds_per_drive', 'off_sack_rate']
EXTRA_PB_KEYS = ['off_qb_hit_rate', 'def_pressure_epa', 'off_pass_rate', 'off_epa_volatility']
PB_KEYS = BASE_PB_KEYS + EXTRA_PB_KEYS


def american_implied_prob(price):
    if price is None or not math.isfinite(price) or abs(price) < 100:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)


def market_no_vig_prob(positive_price, negative_price):
    """The market's own probability the 'positive' side (home/Over) wins.

    De-vigged by normalizing both implied probabilities to sum to 1. This is
    the market-only baseline for the classification and logit branches: it
    uses nothing but the two opening prices themselves.
    """
    p, n = american_implied_prob(positive_price), american_implied_prob(negative_price)
    if p is None or n is None or p + n <= 0:
        return None
    return p / (p + n)


def logit(p, eps=1e-6):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def mean(a):
    return float(np.mean(a)) if len(a) else 0.0


def build_dataset(db_path):
    """Extended, decision-time-safe extraction. See module docstring.

    Returns (rows, dropped) with the SAME row shape as market_lab.build_dataset
    plus: a wider `features` dict (interactions, missingness flags, age-of-
    information), and `outcome` -- how many points the pregame favorite/Over
    side beat the OPENING number by (actual_margin+opening_line for spreads,
    actual_total-opening_line for totals). `outcome` is the shared basis for
    both new targets: sign(outcome) is the cover/over label (push excluded),
    outcome itself is the quantile-regression target.
    """
    con = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    con.execute('BEGIN')
    games = [dict(x) for x in con.execute('''SELECT season,week,team,opponent,spread,total,
        team_score,opp_score,gameday,rest_days,div_game,roof FROM game_lines WHERE home=1 AND season<=2025 ORDER BY season,week''')]
    # Every team's OWN rest_days, keyed by (season,week,team) -- the home-only
    # query above only carries the home team's rest, and the away team's rest
    # comes from its own row in the same table.
    rest_by_team_week = {(r['season'], r['week'], r['team']): r['rest_days']
        for r in con.execute('SELECT season,week,team,rest_days FROM game_lines')}
    history = collections.defaultdict(list)
    week_end = {}
    game_map = {}
    for g in games:
        game_map[(g['season'], g['week'], g['team'])] = g
        d = stamp(g['gameday'])
        if d is None or g['team_score'] is None or g['opp_score'] is None:
            continue
        ready = d + timedelta(days=3)  # conservative publication proxy, unchanged from market_lab
        k = (g['season'], g['week'])
        week_end[k] = max(week_end.get(k, ready), ready)
        m = g['team_score'] - g['opp_score']
        total = g['team_score'] + g['opp_score']
        for team, margin in [(g['team'], m), (g['opponent'], -m)]:
            history[team].append((ready, margin, total))
    pbp = collections.defaultdict(list)
    for r in con.execute('SELECT season,week,team,features FROM nfl_team_week_features WHERE season<=2025'):
        ready = week_end.get((r['season'], r['week']))
        if ready is None:
            continue
        try:
            f = json.loads(r['features'])
        except (TypeError, ValueError):
            continue
        pbp[r['team']].append((ready, f))
    for v in history.values():
        v.sort(key=lambda z: z[0])
    for v in pbp.values():
        v.sort(key=lambda z: z[0])
    # --- everything above this line mirrors market_lab.build_dataset's setup ---
    archive = [dict(x) for x in con.execute('''SELECT eid,season,week,home,away,commence_time,
       market,side,phase,line,price,book_updated_at,source FROM nfl_odds_archive
       WHERE book='pinnacle' AND market IN ('spreads','totals') AND season BETWEEN 2022 AND 2025''')]
    con.close()
    by_game = collections.defaultdict(dict)
    for q in archive:
        by_game[(q['eid'], q['market'])][(q['phase'], q['side'])] = q
    dropped = collections.Counter()
    out = []
    for (eid, market), qs in by_game.items():
        sample = next(iter(qs.values()))
        pos = sample['home'] if market == 'spreads' else 'Over'
        neg = sample['away'] if market == 'spreads' else 'Under'
        o = qs.get(('open', pos)); opposite = qs.get(('open', neg)); c = qs.get(('close', pos))
        g = game_map.get((sample['season'], sample['week'], sample['home']))
        if not all([o, opposite, c, g]):
            dropped['missing_pair_or_result'] += 1; continue
        ot, nt, ct, kick = [stamp(v) for v in [o['book_updated_at'], opposite['book_updated_at'], c['book_updated_at'], sample['commence_time']]]
        if any(t is None for t in [ot, nt, ct, kick]) or not (ot <= ct < kick) or abs((nt - ot).total_seconds()) > 60:
            dropped['invalid_or_unpaired_timestamps'] += 1; continue
        decision = max(ot, nt)
        if not decision < ct or decision >= kick or g['team_score'] is None or g['opp_score'] is None:
            dropped['no_future_close_or_score'] += 1; continue
        if any(american_profit(q['price']) is None for q in [o, opposite]):
            dropped['missing_real_prices'] += 1; continue
        if not all(isinstance(q['line'], (int, float)) and math.isfinite(q['line']) for q in [o, opposite, c]):
            dropped['bad_line'] += 1; continue
        if (market == 'spreads' and abs(o['line'] + opposite['line']) > 1e-9) or (market == 'totals' and o['line'] != opposite['line']):
            dropped['different_contracts'] += 1; continue
        # --- chronology guard block ends; feature construction begins ---

        p_pos, p_neg = american_implied_prob(o['price']), american_implied_prob(opposite['price'])
        overround = (p_pos + p_neg - 1) if (p_pos is not None and p_neg is not None) else None

        features = {'opening_line': o['line'], 'opening_positive_price': o['price'],
            'opening_negative_price': opposite['price'], 'hours_to_kickoff': (kick - decision).total_seconds() / 3600,
            'week': g['week'], 'division_game': g['div_game'] or 0,
            'near_key_three': min(abs(abs(o['line']) - 3), 20),
            'near_key_seven': min(abs(abs(o['line']) - 7), 20),
            'opening_overround': overround if overround is not None else 0.0,
            'opening_overround_available': int(overround is not None)}

        roof = (g.get('roof') or '').strip().lower()
        outdoor_flag = 1 if roof == 'outdoors' else 0
        features['outdoor_stadium'] = outdoor_flag
        features['roof_available'] = int(bool(roof))

        home_rest = rest_by_team_week.get((g['season'], g['week'], sample['home']))
        away_rest = rest_by_team_week.get((g['season'], g['week'], sample['away']))
        rest_known = home_rest is not None and away_rest is not None
        rest_diff = (home_rest - away_rest) if rest_known else 0
        features['rest_days_diff'] = rest_diff
        features['rest_days_diff_available'] = int(rest_known)

        # Approximate US game-time slot from the kickoff instant alone (always
        # known well pre-game; not a measured post-kickoff condition). Sunday/
        # Monday/Thursday primetime games kick off in this UTC window across
        # the relevant DST regimes; this is a schedule-slot PROXY, not a
        # verified broadcast-window lookup.
        primetime_flag = 1 if (kick.hour >= 23 or kick.hour <= 2) else 0
        features['primetime_flag'] = primetime_flag

        team_agg = {}
        for side, team in [('home', sample['home']), ('away', sample['away'])]:
            recent = [h for h in history[team] if h[0] < decision][-8:]
            recent3 = recent[-3:]
            features[side + '_prior_games'] = len(recent)
            for idx, name in [(1, 'margin'), (2, 'total')]:
                features[side + '_recent_' + name] = mean([v[idx] for v in recent]) if recent else 0.0
                features[side + '_recent_' + name + '_available'] = int(bool(recent))
            margin3 = mean([v[1] for v in recent3]) if recent3 else 0.0
            features[side + '_recent_margin_3'] = margin3
            features[side + '_recent_margin_3_available'] = int(bool(recent3))
            history_age_days = (decision - recent[-1][0]).total_seconds() / 86400 if recent else None
            features[side + '_history_age_days'] = history_age_days if history_age_days is not None else -1.0
            features[side + '_history_age_available'] = int(history_age_days is not None)

            fprior = [(ready, f) for ready, f in pbp[team] if ready < decision][-8:]
            for key in PB_KEYS:
                vals = [f[key] for _, f in fprior if isinstance(f.get(key), (int, float)) and math.isfinite(f[key])]
                features[side + '_' + key] = mean(vals) if vals else 0.0
                features[side + '_' + key + '_available'] = int(bool(vals))
            pbp_age_days = (decision - fprior[-1][0]).total_seconds() / 86400 if fprior else None
            features[side + '_pbp_age_days'] = pbp_age_days if pbp_age_days is not None else -1.0
            features[side + '_pbp_age_available'] = int(pbp_age_days is not None)
            team_agg[side] = {'margin3': margin3, 'margin8': features[side + '_recent_margin'],
                'qb_hit': features[side + '_off_qb_hit_rate'], 'pressure': features[side + '_def_pressure_epa'],
                'pass_rate': features[side + '_off_pass_rate'], 'seconds_per_drive': features[side + '_off_seconds_per_drive'],
                'epa_vol': features[side + '_off_epa_volatility']}

        # --- the five specified residual interactions ---
        # 1. market movement (already visible in the priced overround) x QB
        #    uncertainty (proxied by recent offensive EPA volatility -- this
        #    project has no per-play QB-identity feed, so "uncertainty" here
        #    means "how erratic this offense's efficiency has been lately",
        #    not confirmed QB injury/backup status).
        features['int_market_move_x_qb_uncertainty'] = features['opening_overround'] * mean(
            [team_agg['home']['epa_vol'], team_agg['away']['epa_vol']])
        # 2. offensive-line continuity x opponent pressure. No snap-level OL
        #    roster data is extracted here either, so continuity is proxied by
        #    how much pressure/QB-hits the offense has recently ALLOWED
        #    (off_qb_hit_rate); pressure is the opponent's recent pressure EPA
        #    generated (def_pressure_epa). Both sides' cross terms are summed.
        features['int_oline_continuity_x_pressure'] = (
            team_agg['home']['qb_hit'] * team_agg['away']['pressure'] +
            team_agg['away']['qb_hit'] * team_agg['home']['pressure'])
        # 3. pace x available pass catchers. No receiver-availability feed
        #    exists here either; pass-rate stands in for "how much this
        #    offense uses its pass catchers" rather than confirmed roster
        #    availability. Pace is inverted seconds/drive (higher = faster).
        pace = -mean([team_agg['home']['seconds_per_drive'], team_agg['away']['seconds_per_drive']])
        features['int_pace_x_pass_catchers'] = pace * mean([team_agg['home']['pass_rate'], team_agg['away']['pass_rate']])
        # 4. forecast revision x stadium exposure. Revision is proxied by the
        #    gap between a 3-game and an 8-game recent-margin average (how
        #    much recent form has moved from longer-run form) -- an nfelo- or
        #    power-rating-based revision was considered and rejected: this
        #    project's nfelo vintages are not verified as true opening-time
        #    snapshots (see the master plan's Package A audit), and building
        #    that verification was out of scope for this pass. Stadium
        #    exposure is the roof type, a static, always-known-pregame fact.
        revision = mean([team_agg['home']['margin3'] - team_agg['home']['margin8'],
            team_agg['away']['margin3'] - team_agg['away']['margin8']])
        features['int_forecast_revision_x_stadium'] = revision * outdoor_flag
        # 5. rest/travel x game time.
        features['int_rest_travel_x_game_time'] = rest_diff * primetime_flag

        outcome = (g['team_score'] - g['opp_score'] + o['line']) if market == 'spreads' \
            else ((g['team_score'] + g['opp_score']) - o['line'])
        y = o['line'] - c['line'] if market == 'spreads' else c['line'] - o['line']
        out.append({'event_id': str(eid), 'market': market, 'season': g['season'], 'week': g['week'],
            'home': sample['home'], 'away': sample['away'], 'decision_at': decision.isoformat(),
            'label_at': ct.isoformat(), 'opening_line': o['line'], 'closing_line': c['line'],
            'positive_price': o['price'], 'negative_price': opposite['price'],
            'actual_margin': g['team_score'] - g['opp_score'], 'actual_total': g['team_score'] + g['opp_score'],
            'y': y, 'outcome': outcome, 'features': features})
    out.sort(key=lambda r: (r['decision_at'], r['event_id'], r['market']))
    return out, dict(dropped)


# ---------------------------------------------------------------------------
# Model families
# ---------------------------------------------------------------------------

def regression_candidates():
    return {
        'no_move': DummyRegressor(strategy='constant', constant=0),
        'ridge': make_pipeline(StandardScaler(), Ridge(alpha=100)),
        'hist_gb': HistGradientBoostingRegressor(max_iter=100, max_leaf_nodes=7,
            min_samples_leaf=35, l2_regularization=20, learning_rate=.04, early_stopping=False, random_state=SEED),
        'extra_trees': ExtraTreesRegressor(n_estimators=100, max_depth=4, min_samples_leaf=30,
            max_features=.7, n_jobs=1, random_state=SEED),
        'lightgbm': _lgbm_regressor(),
        'xgboost': _xgb_regressor(),
        'catboost': _catboost_regressor(),
    }


def _lgbm_regressor():
    from lightgbm import LGBMRegressor
    return LGBMRegressor(n_estimators=150, max_depth=4, num_leaves=11, min_child_samples=25,
        learning_rate=.04, reg_lambda=5, subsample=.8, colsample_bytree=.7, random_state=SEED, verbose=-1)


def _xgb_regressor():
    from xgboost import XGBRegressor
    return XGBRegressor(n_estimators=150, max_depth=3, min_child_weight=10, learning_rate=.04,
        reg_lambda=5, subsample=.8, colsample_bytree=.7, random_state=SEED, verbosity=0)


def _catboost_regressor():
    from catboost import CatBoostRegressor
    return CatBoostRegressor(iterations=150, depth=4, l2_leaf_reg=8, learning_rate=.04,
        random_seed=SEED, verbose=False, allow_writing_files=False)


def classification_market_only():
    """No fitting: predicts the de-vigged opening price probability itself."""
    class MarketOnly:
        def fit(self, X, y, **kw):
            return self
        def predict_proba(self, X):
            p = np.clip(X[:, -1], 1e-3, 1 - 1e-3)  # market_prob is appended as the last column; see run()
            return np.column_stack([1 - p, p])
    return MarketOnly()


def classification_coin_flip():
    class CoinFlip:
        def fit(self, X, y, **kw):
            return self
        def predict_proba(self, X):
            return np.column_stack([np.full(len(X), .5), np.full(len(X), .5)])
    return CoinFlip()


def classification_candidates():
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier
    from catboost import CatBoostClassifier
    return {
        'coin_flip': classification_coin_flip(),
        'market_only': classification_market_only(),
        'logistic': make_pipeline(StandardScaler(), LogisticRegression(C=.05, max_iter=500)),
        'hist_gb': HistGradientBoostingClassifier(max_iter=100, max_leaf_nodes=7, min_samples_leaf=35,
            l2_regularization=20, learning_rate=.04, early_stopping=False, random_state=SEED),
        'extra_trees': ExtraTreesClassifier(n_estimators=100, max_depth=4, min_samples_leaf=30,
            max_features=.7, n_jobs=1, random_state=SEED),
        'lightgbm': LGBMClassifier(n_estimators=150, max_depth=4, num_leaves=11, min_child_samples=25,
            learning_rate=.04, reg_lambda=5, subsample=.8, colsample_bytree=.7, random_state=SEED, verbose=-1),
        'xgboost': XGBClassifier(n_estimators=150, max_depth=3, min_child_weight=10, learning_rate=.04,
            reg_lambda=5, subsample=.8, colsample_bytree=.7, random_state=SEED, verbosity=0),
        'catboost': CatBoostClassifier(iterations=150, depth=4, l2_leaf_reg=8, learning_rate=.04,
            random_seed=SEED, verbose=False, allow_writing_files=False),
    }


class MarketOnlyQuantile:
    """Predicts the TRAINING set's unconditional empirical quantiles for
    every row -- the market-agnostic baseline every quantile comparison
    needs: 'games cluster near the market's expectation with this much
    spread', using no per-game information at all."""
    def __init__(self, quantiles):
        self.quantiles = quantiles
        self.values_ = None

    def fit(self, X, y):
        self.values_ = np.quantile(y, self.quantiles)
        return self

    def predict(self, X):
        return np.tile(self.values_, (len(X), 1))


def quantile_family_fits(name, X, y, quantiles):
    """Returns an array (n_rows, n_quantiles) for one family."""
    if name == 'market_only':
        m = MarketOnlyQuantile(quantiles).fit(X, y)
        return m, m.predict(X)
    if name == 'sklearn_gbr':
        models = [GradientBoostingRegressor(loss='quantile', alpha=q, n_estimators=80, max_depth=3,
            min_samples_leaf=30, learning_rate=.05, random_state=SEED).fit(X, y) for q in quantiles]
        return models, np.column_stack([m.predict(X) for m in models])
    if name == 'lightgbm':
        from lightgbm import LGBMRegressor
        models = [LGBMRegressor(objective='quantile', alpha=q, n_estimators=120, max_depth=4, num_leaves=11,
            min_child_samples=25, learning_rate=.05, random_state=SEED, verbose=-1).fit(X, y) for q in quantiles]
        return models, np.column_stack([m.predict(X) for m in models])
    if name == 'catboost':
        from catboost import CatBoostRegressor
        models = [CatBoostRegressor(loss_function=f'Quantile:alpha={q}', iterations=120, depth=4,
            learning_rate=.05, random_seed=SEED, verbose=False, allow_writing_files=False).fit(X, y) for q in quantiles]
        return models, np.column_stack([m.predict(X) for m in models])
    if name == 'xgboost':
        from xgboost import XGBRegressor
        model = XGBRegressor(objective='reg:quantileerror', quantile_alpha=quantiles, n_estimators=120,
            max_depth=3, min_child_weight=10, learning_rate=.05, random_state=SEED, verbosity=0).fit(X, y)
        return model, model.predict(X)
    raise ValueError(name)


def quantile_predict(name, model, X):
    if name == 'market_only':
        return model.predict(X)
    if name == 'xgboost':
        return model.predict(X)
    return np.column_stack([m.predict(X) for m in model])


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate_movement(rows, pred):
    """Identical semantics to market_lab.evaluate -- reproduced here (not
    imported) only because it is short and this module's row dicts carry an
    extra `outcome` field market_lab's don't; the movement math itself is
    unchanged."""
    y = np.array([r['y'] for r in rows]); pred = np.asarray(pred)
    bets = []; clv = []; profits = []
    for r, p in zip(rows, pred):
        if abs(p) < THRESHOLD:
            continue
        positive = p > 0
        price = r['positive_price'] if positive else r['negative_price']
        bets.append(r); clv.append(r['y'] * (1 if positive else -1))
        profits.append(settlement(r['market'], positive, r['opening_line'], r['actual_margin'], r['actual_total'], price))
    path = np.cumsum(profits); high = np.maximum.accumulate(np.r_[0, path])
    return {'games': len(rows), 'weeks': len(set((r['season'], r['week']) for r in rows)),
        'mae': float(mean_absolute_error(y, pred)), 'no_move_mae': float(np.mean(abs(y))),
        'mae_gain_interval': cluster_interval(rows, abs(y) - abs(y - pred)),
        'paper_bets': len(bets), 'mean_clv': float(np.mean(clv)) if clv else None,
        'roi': float(np.mean(profits)) if profits else None, 'roi_interval': cluster_interval(bets, profits),
        'profit_units': float(sum(profits)) if profits else 0.0,
        'wins': sum(p > 0 for p in profits), 'losses': sum(p < 0 for p in profits), 'pushes': sum(p == 0 for p in profits)}


def evaluate_classification(rows, proba, market_prob):
    """proba: model's estimate that the positive side (home/Over) covers.
    Bets only when the model disagrees with the market by more than PROB_EDGE
    -- betting whenever proba>0.5 would just be re-discovering favorite-vs-dog
    parity, not a claim of finding anything the market missed."""
    y = np.array([1 if r['outcome'] > 0 else 0 for r in rows])
    proba = np.clip(np.asarray(proba), 1e-6, 1 - 1e-6)
    ll = float(log_loss(y, proba, labels=[0, 1]))
    market_ll = float(log_loss(y, np.clip(market_prob, 1e-6, 1 - 1e-6), labels=[0, 1]))
    brier = float(brier_score_loss(y, proba))
    market_brier = float(brier_score_loss(y, market_prob))
    bets, clv, profits = [], [], []
    for r, p, mp in zip(rows, proba, market_prob):
        edge = p - mp
        if abs(edge) < PROB_EDGE:
            continue
        positive = edge > 0  # model thinks the positive side is MORE likely than the market prices it
        price = r['positive_price'] if positive else r['negative_price']
        bets.append(r); clv.append(edge if positive else -edge)
        profits.append(settlement(r['market'], positive, r['opening_line'], r['actual_margin'], r['actual_total'], price))
    return {'games': len(rows), 'weeks': len(set((r['season'], r['week']) for r in rows)),
        'log_loss': ll, 'market_log_loss': market_ll, 'brier': brier, 'market_brier': market_brier,
        'beats_market_log_loss': ll < market_ll, 'paper_bets': len(bets),
        'mean_edge': float(np.mean(clv)) if clv else None,
        'roi': float(np.mean(profits)) if profits else None, 'roi_interval': cluster_interval(bets, profits),
        'profit_units': float(sum(profits)) if profits else 0.0,
        'wins': sum(p > 0 for p in profits), 'losses': sum(p < 0 for p in profits), 'pushes': sum(p == 0 for p in profits)}


def pinball_loss(y, q_pred, quantiles):
    y = np.asarray(y)
    losses = []
    for i, q in enumerate(quantiles):
        diff = y - q_pred[:, i]
        losses.append(np.mean(np.maximum(q * diff, (q - 1) * diff)))
    return float(np.mean(losses))


def quantile_coherence_report(q_pred, quantiles):
    """Explicit test: a higher quantile must never predict a lower value.
    Reports the raw (pre-fix) violation rate, then the post-fix (sorted)
    pinball loss so a family that only 'works' after silently sorting is
    visible as such."""
    diffs = np.diff(q_pred, axis=1)
    violated_rows = int(np.any(diffs < -1e-9, axis=1).sum())
    return {'quantiles': quantiles, 'rows': len(q_pred), 'violated_rows': violated_rows,
        'violation_rate': violated_rows / len(q_pred) if len(q_pred) else None}


def calibration_coverage(y, q_pred, quantiles):
    """Held-out DISTRIBUTION calibration, not just point accuracy: for each
    predicted quantile, what fraction of actual outcomes actually fell below
    it? A well-calibrated q=0.75 model should see about 75% of held-out
    outcomes below its q=0.75 prediction."""
    y = np.asarray(y)
    return [{'quantile': q, 'target_coverage': q,
        'observed_coverage': float(np.mean(y <= q_pred[:, i]))} for i, q in enumerate(quantiles)]


def key_number_push_mass(rows):
    """Empirical spike at key margins, computed from TRAIN rows only (the
    caller passes only prior-season rows in). Compares each key number's
    share of |actual margin| against the average share of its two immediate
    neighbors -- a 'spike ratio' well above 1 is the discrete push mass a
    smooth quantile model cannot represent."""
    margins = [abs(r['actual_margin']) for r in rows]
    if not margins:
        return {'games': 0, 'keys': []}
    counts = collections.Counter(margins)
    n = len(margins)
    keys = []
    for k in KEY_NUMBERS:
        neighbor_share = mean([counts.get(k - 1, 0) / n, counts.get(k + 1, 0) / n])
        share = counts.get(k, 0) / n
        keys.append({'margin': k, 'share': share, 'neighbor_share': neighbor_share,
            'spike_ratio': (share / neighbor_share) if neighbor_share > 0 else None})
    return {'games': n, 'keys': keys}


# ---------------------------------------------------------------------------
# Ranker branch
# ---------------------------------------------------------------------------

def run_ranker(train_rows, test_rows, names, run_dir, market, season):
    """LGBMRanker over per-(game,side) opportunities. Relevance grades come
    from REALIZED profit on the training rows only (bucketed into 5 grades
    per week so LightGBM's ranking objective has integer targets); the
    downstream number that matters is real paper ROI on the top-K ranked
    opportunities per week in the TEST season, not the ranking metric.
    """
    from lightgbm import LGBMRanker

    def opportunities(rows):
        opp = []
        for r in rows:
            for side_name, positive, price in [('positive', True, r['positive_price']), ('negative', False, r['negative_price'])]:
                profit = settlement(r['market'], positive, r['opening_line'], r['actual_margin'], r['actual_total'], price)
                opp.append({'row': r, 'positive': positive, 'price': price, 'profit': profit,
                    'group': (r['season'], r['week']), 'x': [r['features'][k] for k in names] + [1.0 if positive else 0.0]})
        return opp

    train_opp = opportunities(train_rows)
    if len(train_opp) < 40:
        return {'skipped': True, 'reason': 'not enough training opportunities'}
    by_week = collections.defaultdict(list)
    for o in train_opp:
        by_week[o['group']].append(o)
    for week_opps in by_week.values():
        profits = np.array([o['profit'] for o in week_opps])
        grades = np.clip((np.argsort(np.argsort(profits)) * 5 // max(len(profits), 1)), 0, 4)
        for o, gr in zip(week_opps, grades):
            o['grade'] = int(gr)
    train_opp.sort(key=lambda o: o['group'])
    X = np.array([o['x'] for o in train_opp])
    y = np.array([o['grade'] for o in train_opp])
    group_sizes = [len(list(g)) for _, g in itertools.groupby(train_opp, key=lambda o: o['group'])]
    model = LGBMRanker(n_estimators=100, max_depth=4, num_leaves=11, min_child_samples=10,
        learning_rate=.05, random_state=SEED, verbose=-1)
    model.fit(X, y, group=group_sizes)

    test_opp = opportunities(test_rows)
    by_test_week = collections.defaultdict(list)
    for o in test_opp:
        by_test_week[o['group']].append(o)
    top_k = 3
    picked, ndcg_scores = [], []
    for week, opps in by_test_week.items():
        scores = model.predict(np.array([o['x'] for o in opps]))
        order = np.argsort(-scores)
        picked += [opps[i] for i in order[:top_k]]
        true_rel = np.array([[max(0.0, o['profit']) for o in opps]])
        pred_rel = np.array([scores])
        if true_rel.shape[1] >= 2 and np.any(true_rel):
            ndcg_scores.append(float(ndcg_score(true_rel, pred_rel)))
    profits = [o['profit'] for o in picked]
    return {'skipped': False, 'top_k_per_week': top_k, 'weeks': len(by_test_week), 'picks': len(picked),
        'roi': float(np.mean(profits)) if profits else None,
        'roi_interval': cluster_interval([o['row'] for o in picked], profits) if profits else None,
        'profit_units': float(sum(profits)) if profits else 0.0,
        'wins': sum(p > 0 for p in profits), 'losses': sum(p < 0 for p in profits),
        'mean_ndcg_informational_only': float(np.mean(ndcg_scores)) if ndcg_scores else None,
        'note': 'mean_ndcg_informational_only is a ranking-quality diagnostic. It is NOT evidence of '
            'profitability by itself; roi/profit_units above (real settlement at archived prices on the '
            'top-K picks per week) is the actual downstream evaluation.'}


# ---------------------------------------------------------------------------
# Market-anchored logit branch
# ---------------------------------------------------------------------------

def run_market_anchored_logit(train, test, names, cv, market_prob_train, market_prob_test):
    """logit(p) = logit(p_market) + shrinkage * (logit(p_hat) - logit(p_market)).

    p_hat comes from a HistGradientBoostingClassifier fit on features alone.
    shrinkage is chosen by inner chronological CV log-loss BEFORE the outer
    test season is touched -- the leakage risk the master plan calls out
    explicitly is picking shrinkage using the very data it will be judged on;
    this grid search only ever sees `cv`, which is built from rows strictly
    before the outer test season.
    """
    Xtr = np.array([[r['features'][k] for k in names] for r in train])
    ytr = np.array([1 if r['outcome'] > 0 else 0 for r in train])
    Xte = np.array([[r['features'][k] for k in names] for r in test])

    inner_scores = {s: [] for s in SHRINKAGE_GRID}
    for tr_idx, va_idx in cv:
        y_va = ytr[va_idx]
        if np.unique(y_va).size < 2:
            continue
        g = HistGradientBoostingClassifier(max_iter=80, max_leaf_nodes=7, min_samples_leaf=30,
            random_state=SEED).fit(Xtr[tr_idx], ytr[tr_idx])
        p_hat_va = np.clip(g.predict_proba(Xtr[va_idx])[:, 1], 1e-6, 1 - 1e-6)
        p_mkt_va = market_prob_train[va_idx]
        for s in SHRINKAGE_GRID:
            p_combined = sigmoid(logit(p_mkt_va) + s * (logit(p_hat_va) - logit(p_mkt_va)))
            inner_scores[s].append(log_loss(y_va, p_combined, labels=[0, 1]))
    means = {s: float(np.mean(v)) for s, v in inner_scores.items() if v}
    if not means:
        return {'skipped': True, 'reason': 'no inner fold had both classes'}
    shrinkage = min(means, key=means.get)  # frozen before the outer season is scored

    final_model = HistGradientBoostingClassifier(max_iter=80, max_leaf_nodes=7, min_samples_leaf=30,
        random_state=SEED).fit(Xtr, ytr)
    p_hat_test = np.clip(final_model.predict_proba(Xte)[:, 1], 1e-6, 1 - 1e-6)
    p_combined = sigmoid(logit(market_prob_test) + shrinkage * (logit(p_hat_test) - logit(market_prob_test)))
    evaluation = evaluate_classification(test, p_combined, market_prob_test)
    return {'skipped': False, 'shrinkage_selected': shrinkage, 'inner_log_loss_by_shrinkage': means, **evaluation}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _fit_tpot_regressor(X, y, cv, minutes, seed=SEED):
    from tpot import TPOTRegressor
    automl = TPOTRegressor(search_space='linear-light', cv=FrozenTimeCV(cv),
        scorers=['neg_mean_absolute_error'], scorers_weights=[1], validation_strategy='none',
        preprocessing=False, max_time_mins=minutes, max_eval_time_mins=.3, population_size=8,
        initial_population_size=8, n_jobs=1, random_state=seed, verbose=0, memory_limit='2GB')
    automl.fit(X, y)
    return automl


def _fit_tpot_classifier(X, y, cv, minutes, seed=SEED):
    from tpot import TPOTClassifier
    automl = TPOTClassifier(search_space='linear-light', cv=FrozenTimeCV(cv),
        scorers=['neg_log_loss'], scorers_weights=[1], validation_strategy='none',
        preprocessing=False, max_time_mins=minutes, max_eval_time_mins=.3, population_size=8,
        initial_population_size=8, n_jobs=1, random_state=seed, verbose=0, memory_limit='2GB')
    automl.fit(X, y)
    return automl


def run_movement(data, names, market, season, run_dir, tpot_minutes, errors):
    test = [r for r in data if r['market'] == market and r['season'] == season]
    if not test:
        return None
    outer_cutoff = min(stamp(r['decision_at']) for r in test) - timedelta(days=7)
    train = [r for r in data if r['market'] == market and r['season'] < season and stamp(r['label_at']) < outer_cutoff]
    cv = time_folds(train)
    if len(cv) < 2:
        errors.append(f'{market}/{season}/move: insufficient temporal training folds')
        return None
    X = np.array([[r['features'][k] for k in names] for r in train]); y = np.array([r['y'] for r in train])
    Xt = np.array([[r['features'][k] for k in names] for r in test])
    models = regression_candidates(); scores = {}; trials = 0
    for name, model in models.items():
        losses = [mean_absolute_error(y[va], clone(model).fit(X[tr], y[tr]).predict(X[va])) for tr, va in cv]
        scores[name] = float(np.mean(losses))
    if tpot_minutes > 0:
        try:
            automl = _fit_tpot_regressor(X, y, cv, tpot_minutes)
            models['tpot'] = automl.fitted_pipeline_
            losses = [mean_absolute_error(y[va], clone(models['tpot']).fit(X[tr], y[tr]).predict(X[va])) for tr, va in cv]
            scores['tpot'] = float(np.mean(losses))
            trials = len(automl.evaluated_individuals)
            atomic_json(run_dir / f'{market}-{season}-move-tpot-trials.json',
                [{'candidate': str(i), 'inner_score': float(r['neg_mean_absolute_error']) if np.isfinite(r.get('neg_mean_absolute_error', np.nan)) else None}
                    for i, r in automl.evaluated_individuals.iterrows()])
        except Exception as e:
            errors.append(f'{market}/{season}/move TPOT failed: {type(e).__name__}: {str(e)[:300]}')
    selected = min(scores, key=scores.get)
    model = clone(models[selected]).fit(X, y); pred = model.predict(Xt)
    joblib.dump(model, run_dir / f'{market}-{season}-move.joblib')
    candidate_rows = [{'name': n, 'inner_mae': scores[n], **evaluate_movement(test, clone(m).fit(X, y).predict(Xt))}
        for n, m in models.items()]
    return {'season': season, 'target': 'move', 'train_games': len(train), 'inner_folds': len(cv),
        'selected': selected, 'tpot_trials': trials, 'candidates': candidate_rows, **evaluate_movement(test, pred)}


def run_classification(data, names, market, season, run_dir, tpot_minutes, errors, leakage_reports):
    all_rows = [r for r in data if r['market'] == market and abs(r['outcome']) > 1e-9]
    test = [r for r in all_rows if r['season'] == season]
    if not test:
        return None
    outer_cutoff = min(stamp(r['decision_at']) for r in test) - timedelta(days=7)
    train = [r for r in all_rows if r['season'] < season and stamp(r['label_at']) < outer_cutoff]
    cv = time_folds(train)
    if len(cv) < 2:
        errors.append(f'{market}/{season}/cover: insufficient temporal training folds')
        return None
    mp_train = np.array([market_no_vig_prob(r['positive_price'], r['negative_price']) or 0.5 for r in train])
    mp_test = np.array([market_no_vig_prob(r['positive_price'], r['negative_price']) or 0.5 for r in test])
    X = np.array([[r['features'][k] for k in names] for r in train])
    Xmo = np.column_stack([X, mp_train])  # market_only reads the appended last column; see classification_market_only
    Xt = np.array([[r['features'][k] for k in names] for r in test])
    Xt_mo = np.column_stack([Xt, mp_test])
    y = np.array([1 if r['outcome'] > 0 else 0 for r in train])

    if len(cv) >= 2:
        leak = detect_feature_leakage(X, y, cv, names, task='classification')
        leakage_reports.append({'market': market, 'season': season, 'target': 'cover', **leak})

    models = classification_candidates(); scores = {}; trials = 0
    for name, model in models.items():
        losses = []
        for tr, va in cv:
            xtr, xva = (Xmo[tr], Xmo[va]) if name == 'market_only' else (X[tr], X[va])
            if np.unique(y[tr]).size < 2 and name not in ('coin_flip', 'market_only'):
                continue
            fitted = clone(model).fit(xtr, y[tr]) if name not in ('coin_flip', 'market_only') else model
            proba = fitted.predict_proba(xva)[:, 1]
            if np.unique(y[va]).size < 2:
                continue
            losses.append(log_loss(y[va], np.clip(proba, 1e-6, 1 - 1e-6), labels=[0, 1]))
        scores[name] = float(np.mean(losses)) if losses else float('inf')
    if tpot_minutes > 0:
        try:
            automl = _fit_tpot_classifier(X, y, cv, tpot_minutes)
            models['tpot'] = automl.fitted_pipeline_
            losses = []
            for tr, va in cv:
                fitted = clone(models['tpot']).fit(X[tr], y[tr])
                proba = fitted.predict_proba(X[va])[:, 1]
                losses.append(log_loss(y[va], np.clip(proba, 1e-6, 1 - 1e-6), labels=[0, 1]))
            scores['tpot'] = float(np.mean(losses))
            trials = len(automl.evaluated_individuals)
            atomic_json(run_dir / f'{market}-{season}-cover-tpot-trials.json',
                [{'candidate': str(i), 'inner_score': float(r['neg_log_loss']) if np.isfinite(r.get('neg_log_loss', np.nan)) else None}
                    for i, r in automl.evaluated_individuals.iterrows()])
        except Exception as e:
            errors.append(f'{market}/{season}/cover TPOT failed: {type(e).__name__}: {str(e)[:300]}')
    selected = min(scores, key=scores.get)
    fit_x, fit_xt = (Xmo, Xt_mo) if selected == 'market_only' else (X, Xt)
    model = models[selected] if selected in ('coin_flip', 'market_only') else clone(models[selected]).fit(fit_x, y)
    pred = model.predict_proba(fit_xt)[:, 1]
    if selected not in ('coin_flip', 'market_only'):
        joblib.dump(model, run_dir / f'{market}-{season}-cover.joblib')
    candidate_rows = []
    for n, m in models.items():
        cx, cxt = (Xmo, Xt_mo) if n == 'market_only' else (X, Xt)
        fitted = m if n in ('coin_flip', 'market_only') else clone(m).fit(cx, y)
        proba = fitted.predict_proba(cxt)[:, 1]
        candidate_rows.append({'name': n, 'inner_log_loss': scores[n], **evaluate_classification(test, proba, mp_test)})
    return {'season': season, 'target': 'cover', 'train_games': len(train), 'inner_folds': len(cv),
        'selected': selected, 'tpot_trials': trials, 'candidates': candidate_rows,
        **evaluate_classification(test, pred, mp_test)}


def run_quantile(data, names, market, season, run_dir, errors):
    """No TPOT here: TPOT's regressor/classifier search spaces do not cover
    multi-quantile objectives, and building a bespoke TPOT config for pinball
    loss was out of scope for this pass -- stated plainly rather than
    skipped silently."""
    test = [r for r in data if r['market'] == market and r['season'] == season]
    if not test:
        return None
    outer_cutoff = min(stamp(r['decision_at']) for r in test) - timedelta(days=7)
    train = [r for r in data if r['market'] == market and r['season'] < season and stamp(r['label_at']) < outer_cutoff]
    cv = time_folds(train)
    if len(cv) < 2:
        errors.append(f'{market}/{season}/quantile: insufficient temporal training folds')
        return None
    X = np.array([[r['features'][k] for k in names] for r in train]); y = np.array([r['outcome'] for r in train])
    Xt = np.array([[r['features'][k] for k in names] for r in test]); yt = np.array([r['outcome'] for r in test])

    families = ['market_only', 'sklearn_gbr', 'lightgbm', 'catboost', 'xgboost']
    inner_scores = {}
    for name in families:
        losses = []
        for tr, va in cv:
            try:
                model, _ = quantile_family_fits(name, X[tr], y[tr], QUANTILES)
                pred_va = quantile_predict(name, model, X[va])
            except Exception as e:
                errors.append(f'{market}/{season}/quantile {name} inner fold failed: {type(e).__name__}: {str(e)[:200]}')
                continue
            losses.append(pinball_loss(y[va], pred_va, QUANTILES))
        inner_scores[name] = float(np.mean(losses)) if losses else float('inf')
    selected = min(inner_scores, key=inner_scores.get)
    model, _ = quantile_family_fits(selected, X, y, QUANTILES)
    pred_test_raw = quantile_predict(selected, model, Xt)
    coherence = quantile_coherence_report(pred_test_raw, QUANTILES)
    pred_test_sorted = np.sort(pred_test_raw, axis=1)
    key_mass = key_number_push_mass(train)
    candidate_rows = []
    for name in families:
        try:
            m, _ = quantile_family_fits(name, X, y, QUANTILES)
            pred = quantile_predict(name, m, Xt)
        except Exception as e:
            errors.append(f'{market}/{season}/quantile {name} final fit failed: {type(e).__name__}: {str(e)[:200]}')
            continue
        coh = quantile_coherence_report(pred, QUANTILES)
        pred_sorted = np.sort(pred, axis=1)
        candidate_rows.append({'name': name, 'inner_pinball': inner_scores[name],
            'pinball_raw': pinball_loss(yt, pred, QUANTILES), 'pinball_sorted': pinball_loss(yt, pred_sorted, QUANTILES),
            'coherence': coh, 'calibration': calibration_coverage(yt, pred_sorted, QUANTILES)})
    return {'season': season, 'target': 'quantile', 'train_games': len(train), 'inner_folds': len(cv),
        'selected': selected, 'candidates': candidate_rows,
        'pinball_raw': pinball_loss(yt, pred_test_raw, QUANTILES), 'pinball_sorted': pinball_loss(yt, pred_test_sorted, QUANTILES),
        'coherence': coherence, 'calibration': calibration_coverage(yt, pred_test_sorted, QUANTILES),
        'key_number_push_mass_train': key_mass}


def run(args):
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    data, dropped = build_dataset(args.db)
    names = sorted(data[0]['features']) if data else []
    if len(data) < 200:
        raise ValueError('Not enough valid historical opening/closing pairs')
    code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + code_hash[:8]
    run_dir = out / run_id; run_dir.mkdir()
    dataset_hash = digest(data)
    errors, leakage_reports = [], []

    report = {'schema': VERSION, 'run_id': run_id, 'status': 'running', 'created_at': datetime.now(timezone.utc).isoformat(),
        'authority': 'research_only', 'production_changed': False, 'untouched_holdout': False,
        'dataset_hash': dataset_hash, 'code_hash': code_hash, 'rows': len(data), 'features': names, 'dropped': dropped,
        'protocol': {'targets': ['move (opening-to-closing regression)', 'cover (spread/total outcome classification)',
            'quantile (residual quantile regression)'], 'outer_seasons': [2023, 2024, 2025],
            'inner_validation': 'expanding whole-week folds; seven-day label embargo',
            'selection': 'minimum inner-fold loss, evaluated before any outer-season scoring',
            'families': ['ridge/logistic', 'hist_gb', 'extra_trees', 'lightgbm', 'xgboost', 'catboost',
                'market_only/coin_flip/no_move baselines', 'bounded TPOT (move, cover only)'],
            'tpot_minutes_per_combination': args.tpot_minutes, 'seed': SEED,
            'classification_paper_bet_trigger': f'model probability vs de-vigged market probability edge >= {PROB_EDGE}',
            'movement_paper_bet_trigger': f'|predicted movement| >= {THRESHOLD} points'},
        'limitations': ['Previously opened seasons are development data, not an untouched holdout.',
            'Archived opening prices are indicative; access, limits, delay and fills are unverified.',
            'Interaction features 1-3 use available team-week aggregates as PROXIES for QB uncertainty, '
                'offensive-line continuity, and pass-catcher availability -- this project has no per-player '
                'roster/snap feed wired into this extractor. See build_dataset() docstring for the exact proxy.',
            'The forecast-revision interaction deliberately avoids nfelo: its historical vintages are not yet '
                'verified as true opening-time snapshots (see the master plan Package A audit).',
            'The quantile branch has no TPOT search: TPOT has no built-in multi-quantile pinball objective.',
            'This dataset builder duplicates (rather than imports) market_lab.build_dataset\'s chronology '
                'block to extract a wider feature set; the two extractors must be kept in agreement by hand. '
                'See the module docstring.',
            'Points of CLV/log-loss gain are not dollars of edge. Positive historical ROI cannot authorize staking.'],
        'markets': [], 'ranker': [], 'market_anchored_logit': [], 'leakage_scans': leakage_reports, 'errors': errors}
    atomic_json(run_dir / 'dataset.json', data)
    atomic_json(run_dir / 'preregistered.json', report)

    def save():
        atomic_json(run_dir / 'report.json', report); atomic_json(out / 'latest.json', report)
    save()

    for market in ['spreads', 'totals']:
        market_block = {'market': market, 'move': [], 'cover': [], 'quantile': []}
        for season in [2023, 2024, 2025]:
            move = run_movement(data, names, market, season, run_dir, args.tpot_minutes, errors)
            if move:
                market_block['move'].append(move)
            cover = run_classification(data, names, market, season, run_dir, args.tpot_minutes, errors, leakage_reports)
            if cover:
                market_block['cover'].append(cover)
            quant = run_quantile(data, names, market, season, run_dir, errors)
            if quant:
                market_block['quantile'].append(quant)
            print(f'{market} {season}: move={move["selected"] if move else "skipped"} '
                  f'cover={cover["selected"] if cover else "skipped"} quantile={quant["selected"] if quant else "skipped"}', flush=True)
            report['progress'] = f'{market} {season} complete'; save()

        # Ranker + market-anchored logit: fit once per market on all pre-2025
        # training data, evaluate on 2025 -- these are bonus branches, not the
        # primary per-season comparison, so they run once per market rather
        # than once per outer season.
        rows_market = [r for r in data if r['market'] == market]
        test_final = [r for r in rows_market if r['season'] == 2025]
        train_final = [r for r in rows_market if r['season'] < 2025]
        if test_final and train_final:
            try:
                ranker_result = run_ranker(train_final, test_final, names, run_dir, market, 2025)
            except Exception as e:
                ranker_result = {'skipped': True, 'reason': f'{type(e).__name__}: {str(e)[:300]}'}
            report['ranker'].append({'market': market, 'test_season': 2025, **ranker_result})

            cover_rows = [r for r in rows_market if abs(r['outcome']) > 1e-9]
            train_c = [r for r in cover_rows if r['season'] < 2025]
            test_c = [r for r in cover_rows if r['season'] == 2025]
            cv_c = time_folds(train_c)
            if test_c and len(cv_c) >= 2:
                mp_tr = np.array([market_no_vig_prob(r['positive_price'], r['negative_price']) or 0.5 for r in train_c])
                mp_te = np.array([market_no_vig_prob(r['positive_price'], r['negative_price']) or 0.5 for r in test_c])
                try:
                    logit_result = run_market_anchored_logit(train_c, test_c, names, cv_c, mp_tr, mp_te)
                except Exception as e:
                    logit_result = {'skipped': True, 'reason': f'{type(e).__name__}: {str(e)[:300]}'}
                report['market_anchored_logit'].append({'market': market, 'test_season': 2025, **logit_result})
        save()

        report['markets'].append(market_block); save()

    # Leakage scan on the REAL dataset (not just the synthetic test), for the
    # movement target on the fullest training set available, so a genuine
    # leak in the real feature set would surface here too.
    full_move_rows = [r for r in data if r['market'] == 'spreads' and r['season'] < 2025]
    cv_full = time_folds(full_move_rows)
    if len(cv_full) >= 2:
        Xf = np.array([[r['features'][k] for k in names] for r in full_move_rows])
        yf = np.array([r['y'] for r in full_move_rows])
        leak = detect_feature_leakage(Xf, yf, cv_full, names, task='regression')
        leakage_reports.append({'market': 'spreads', 'season': '<2025 pooled', 'target': 'move', **leak})
    save()

    report['status'] = ('complete_with_errors' if errors else 'complete') if report['markets'] else 'failed'
    report['completed_at'] = datetime.now(timezone.utc).isoformat()
    report['wall_clock_seconds'] = round(time.time() - started, 1)
    report['progress'] = 'Finished; no model promoted'
    report['verdict'] = 'Research complete. Review predictive skill, calibration, execution assumptions and forward evidence separately.'
    import importlib.metadata
    report['packages'] = {p: importlib.metadata.version(p) for p in
        ['scikit-learn', 'numpy', 'lightgbm', 'xgboost', 'catboost'] + (['tpot'] if args.tpot_minutes > 0 else [])}
    save()
    print(json.dumps({'run_id': run_id, 'status': report['status'], 'errors': len(errors),
        'wall_clock_seconds': report['wall_clock_seconds']}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--tpot-minutes', type=float, default=0, help='Per market/season/target (move, cover only) budget')
    args = p.parse_args()
    if not 0 <= args.tpot_minutes <= 10:
        p.error('--tpot-minutes must be between 0 and 10')
    run(args)
