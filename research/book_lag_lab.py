"""Package B: who moves the price, and who follows.

Research only. No production writes, promotions, model registry pointers, or
wagering. This reads a FROZEN evidence dataset already produced by Package A
(`server/services/nfl-evidence-dataset.js` via `npm run build:evidence-dataset`)
under `server/data/evidence-datasets/<hash>/` — it never opens data.sqlite
itself, so it inherits Package A's chronology guarantees (no future snapshot,
no post-kickoff capture, no book-timestamp-ahead-of-snapshot) instead of
re-deriving them.

Master plan section B (docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md) is the
governing brief. Its central instruction: do not hardcode a permanent "sharp"
book. Every book is scored, in turn, as both a possible mover and a possible
follower; leadership is an OUTPUT of this script (`lead_lag_matrix.json`), not
an input assumption. `server/services/sharp-lag.js` already answers a related,
narrower question — "how does Pinnacle lead the free-book feed" — and remains
correct for that question; this module answers the different, harder one the
plan actually asks for.

## What this file builds, per NFL week captured so far

1.  A per-event/market panel of every book's own posted line over time.
2.  A descriptive, symmetric book-relationship explorer: for every ordered
    pair of books, how often did A's move visibly precede B matching it, and
    by how long (`lead_lag_matrix.json`). No book is special-cased.
3.  Three learned targets, each compared across a declared, bounded model
    search (a "no-move" / marginal-hazard baseline, a regularized
    distributed-lag linear/logistic model, and boosted trees):
      - next-move probability and size, for a book acting as its own reference
      - time-to-follow, as a discrete-time hazard model
      - survival of a currently-quoted opportunity under an execution delay
4.  A delayed-execution replay that buckets every observed opportunity into
    watch / refresh / paper states under the plan's four delay horizons, plus
    disappearance, one-step price worsening, and an explicit "stake limits are
    not observable in this data" flag rather than a fabricated number.

## The data-resolution ceiling, stated before anything is evaluated

The quote tape currently held polls at a MEDIAN gap of roughly one hour (see
`native_step_seconds` in the written protocol — it is measured from the data,
not assumed). The plan asks for delay buckets of 5s/30s/2m/10m. All four are
finer than anything actually observed between two consecutive captures of the
same event. This script is honest about that split:

  - The one-poll-step survival number is MEASURED directly from the tape.
  - The four plan-requested short delays are produced by extrapolating a
    fitted continuous-time hazard (a constant-hazard / exponential
    inter-arrival assumption) down through that gap. They are a stated model
    assumption, not a replayed observation, and are labeled `extrapolated:
    true` everywhere they appear in the output. A future run against a tape
    with genuinely sub-minute polling would let this same protocol measure
    them directly instead.

## Why a Hawkes/marked-point-process model is NOT attempted here

The plan allows it only "after timestamps genuinely support it." Two things
in this specific tape argue against it right now, and both are checked and
reported by `hawkes_feasibility()` rather than asserted from memory:

  1. A visible minority of books stamp `book_updated_at` exactly equal to our
     own poll time on a meaningful share of rows — i.e., the aggregator is
     filling in ITS fetch time because that book does not expose its own
     update clock. Mixed into a marked point process, those rows would look
     like simultaneous cross-book excitement that is really just our own
     polling artifact.
  2. Even for books with genuine per-book timestamps, the current tape spans
     one NFL week. A multivariate Hawkes kernel has one decay/excitation
     parameter per ordered book pair at minimum (110 for 11 books); the
     number of genuine moves per book this week is in the single digits to
     low tens. Fitting that many parameters on that few events is exactly the
     overfitting the plan warns about ("common news arrivals can mimic
     book-to-book causation"), not evidence of causation.

This is a data-volume verdict, not a permanent one: `hawkes_feasibility()`
reruns this check every time and will say so the day it stops being true.

## Split policy limitation, declared before evaluation, not after

The plan asks for chronological, grouped, week-embargoed folds. The tape
currently held is a single NFL week (48 events, one capture window). There is
no second week to embargo yet. This run uses `GroupKFold` on `event_key`
instead — no game's snapshots appear in both a training and a test fold — and
declares plainly that this is a WEAKER guarantee than the plan's chronological
requirement: it prevents a specific game's own microstructure from leaking
across the split, but it cannot show these models generalize to a different
week, different injury news, or a different point in the season. The exact
same protocol should be re-run, unmodified, once several more weeks of tape
accumulate, and this run's numbers should be treated as superseded when it is.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import log_loss, mean_absolute_error
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

VERSION = 'book-lag-lab-v1'
SEED = 90210
MIN_MOVE = {'spreads': 0.5, 'totals': 0.5}
CANON_SIDE = {'spreads': 'home', 'totals': 'over'}
HORIZON_STEPS = (1, 3, 6)          # target-1 look-ahead, in native poll steps
DELAY_SECONDS = (5, 30, 120, 600)  # plan-requested execution delays (extrapolated; see module docstring)
MAX_FORWARD_FILL_STEPS = 3         # a cross-sectional "current value" older than this is treated as unknown
MAX_HAZARD_STEPS = 12              # ~ half a day of native steps; right-censor a follow race beyond this
N_FOLDS = 5
GATE_MIN_LABELS = 40               # below this, report "not yet readable" rather than a verdict


# --------------------------------------------------------------------- utils

def iso(value):
    if not value:
        return None
    try:
        v = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v
    except ValueError:
        return None


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False, default=str))
    tmp.replace(path)


def american_to_prob(price):
    if price is None or not math.isfinite(price) or abs(price) < 100:
        return None
    return 100 / (price + 100) if price > 0 else abs(price) / (abs(price) + 100)


def novig_probability(price_pos, price_neg):
    """Two-sided de-vig of a same-book, same-instant, mirrored pair."""
    p, q = american_to_prob(price_pos), american_to_prob(price_neg)
    if p is None or q is None or (p + q) <= 0:
        return None
    return p / (p + q)


def r4(v):
    return None if v is None or not math.isfinite(v) else round(float(v), 4)


def mean(xs):
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    return float(np.mean(xs)) if xs else None


def cluster_interval(group_ids, values, iters=1500):
    """Bootstrap a mean over resampled GROUPS (events), not resampled rows —
    snapshots of the same game share news, weather and a single market open,
    so treating them as independent rows would understate uncertainty."""
    grouped = collections.defaultdict(list)
    for g, v in zip(group_ids, values):
        if v is not None and math.isfinite(v):
            grouped[g].append(v)
    blocks = list(grouped.values())
    if len(blocks) < 6:
        return None
    rng = np.random.default_rng(SEED)
    sums = np.array([sum(b) for b in blocks])
    counts = np.array([len(b) for b in blocks])
    idx = rng.integers(0, len(blocks), size=(iters, len(blocks)))
    means = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    lo, hi = np.quantile(means, [0.025, 0.975])
    return [r4(lo), r4(hi)]


# ---------------------------------------------------------------- data load

def load_evidence_dataset(dataset_dir, dataset_hash=None):
    root = Path(dataset_dir)
    if dataset_hash:
        manifest = json.loads((root / dataset_hash / 'manifest.json').read_text())
    else:
        manifest = json.loads((root / 'latest.json').read_text())
        dataset_hash = manifest['dataset_hash']
    rows_path = root / dataset_hash / 'rows.jsonl'
    rows = [json.loads(line) for line in rows_path.read_text().splitlines() if line.strip()]
    return manifest, dataset_hash, rows


def canonical_rows(rows):
    """One side per market (home for spreads, over for totals) — the mirror
    side is the exact negative/complement by construction (nfl-contract-key.js
    `mirrorContract`) and adds no information to a lead/lag study, only noise
    from treating one real move as two."""
    return [r for r in rows if r.get('period') == 'full_game'
            and r.get('market') in CANON_SIDE and r.get('side') == CANON_SIDE[r['market']]]


def measure_native_step_seconds(panels):
    """The tape's actual median gap between consecutive polls of the same
    event — the empirical ceiling this whole module is honest about."""
    gaps = []
    for panel in panels.values():
        stamps = [iso(t) for t in panel.grid]
        for a, b in zip(stamps, stamps[1:]):
            if a and b:
                gaps.append((b - a).total_seconds())
    return float(np.median(gaps)) if gaps else None


# ------------------------------------------------------------- panel build

def build_panels(rows):
    panels = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        panels[(r['event_key'], r['market'])][r['book']].append(r)
    for books in panels.values():
        for lst in books.values():
            lst.sort(key=lambda r: r['snapshot_at'])
    return panels


class EventPanel:
    """One event/market's grid of snapshots and every book's state on it.

    `observed[book][i]` is the actual row at grid[i], or None if that book was
    not quoted at that instant (a real, occasionally meaningful gap — see the
    disappearance/suspension measurement below). `filled[book][i]` is the same
    thing carried forward for up to MAX_FORWARD_FILL_STEPS grid steps, for use
    only in cross-sectional FEATURES ("what do the other books show right
    now"), never to invent a move that was not actually observed.
    """

    def __init__(self, event_key, market, books):
        self.event_key, self.market = event_key, market
        self.books = sorted(books)
        self.grid = sorted({r['snapshot_at'] for lst in books.values() for r in lst})
        self.index = {t: i for i, t in enumerate(self.grid)}
        self.observed = {b: [None] * len(self.grid) for b in self.books}
        for b, lst in books.items():
            for r in lst:
                self.observed[b][self.index[r['snapshot_at']]] = r
        self.filled = {b: self._forward_fill(b) for b in self.books}
        self.moves = {b: self._moves(b) for b in self.books}

    def _forward_fill(self, book):
        out, last, age = [None] * len(self.grid), None, 0
        for i, row in enumerate(self.observed[book]):
            if row is not None:
                last, age = row, 0
            else:
                age += 1
            out[i] = last if last is not None and age <= MAX_FORWARD_FILL_STEPS else None
        return out

    def _moves(self, book):
        moves = []
        prev = None
        for i, row in enumerate(self.observed[book]):
            if row is None:
                continue
            if prev is not None and abs(row['line'] - prev['line']) >= MIN_MOVE[self.market]:
                moves.append({'grid_idx': i, 'from_line': prev['line'], 'to_line': row['line'],
                               'delta': round(row['line'] - prev['line'], 4)})
            prev = row
        return moves

    def hours_to_kickoff(self, i):
        row = self.observed_any(i)
        return row['minutes_to_kickoff'] / 60.0 if row else None

    def observed_any(self, i):
        for b in self.books:
            if self.observed[b][i] is not None:
                return self.observed[b][i]
        return None

    def coverage(self, i):
        return sum(1 for b in self.books if self.filled[b][i] is not None)

    def dispersion(self, i):
        lines = [self.filled[b][i]['line'] for b in self.books if self.filled[b][i] is not None]
        return (max(lines) - min(lines)) if len(lines) >= 2 else 0.0

    def other_move_stats(self, book, i, window=3):
        """Distributed-lag features: what have the OTHER books done lately."""
        deltas = []
        for b in self.books:
            if b == book:
                continue
            for mv in self.moves[b]:
                if i - window < mv['grid_idx'] <= i:
                    deltas.append(mv['delta'])
        if not deltas:
            return {'n_other_moves': 0, 'mean_abs_other_move': 0.0, 'signed_pressure': 0.0}
        return {'n_other_moves': len(deltas), 'mean_abs_other_move': float(np.mean(np.abs(deltas))),
                'signed_pressure': float(np.sum(deltas))}

    def steps_since_own_move(self, book, i):
        prior = [mv['grid_idx'] for mv in self.moves[book] if mv['grid_idx'] <= i]
        return (i - prior[-1]) if prior else i

    def last_own_move_size(self, book, i):
        prior = [mv for mv in self.moves[book] if mv['grid_idx'] <= i]
        return prior[-1]['delta'] if prior else 0.0


def build_all_panels(rows):
    grouped = build_panels(canonical_rows(rows))
    panels = {}
    for (event_key, market), books in grouped.items():
        if len(books) < 2:
            continue
        panel = EventPanel(event_key, market, books)
        if len(panel.grid) < 4:
            continue
        panels[(event_key, market)] = panel
    return panels


# ----------------------------------------------------- book relationship map

def lead_lag_matrix(panels):
    """Descriptive only — every book is scored symmetrically as both a
    possible leader and a possible follower. NOT used as a model feature (see
    module docstring): a matrix built from the whole dataset would leak into
    any fold that reused it as a predictor, so it is reported, not fed back
    in. `leader_share` is this book's fraction of matched-pair moves in which
    it moved first among ALL matched pairs it took part in — a data-derived
    ranking, not an assumed one.
    """
    pair_leads = collections.defaultdict(lambda: {'lead_count': 0, 'lag_minutes': []})
    book_participation = collections.defaultdict(lambda: {'led': 0, 'followed': 0})
    for panel in panels.values():
        for leader in panel.books:
            for mv in panel.moves[leader]:
                i0 = mv['grid_idx']
                t0 = iso(panel.grid[i0])
                direction = 1 if mv['delta'] > 0 else -1
                for follower in panel.books:
                    if follower == leader:
                        continue
                    before = panel.filled[follower][i0 - 1] if i0 > 0 else None
                    if before is None or direction * (before['line'] - mv['from_line']) > 1e-9:
                        continue  # follower was already past the leader's OLD line; not lagging it
                    followed_idx = None
                    for j in range(i0, min(i0 + MAX_HAZARD_STEPS, len(panel.grid))):
                        row = panel.observed[follower][j]
                        if row is not None and direction * (row['line'] - mv['to_line']) >= -1e-9:
                            followed_idx = j
                            break
                    if followed_idx is None:
                        continue  # right-censored: not a confirmed lead/lag pair
                    lag_minutes = (iso(panel.grid[followed_idx]) - t0).total_seconds() / 60.0
                    pair_leads[(leader, follower)]['lead_count'] += 1
                    pair_leads[(leader, follower)]['lag_minutes'].append(lag_minutes)
                    book_participation[leader]['led'] += 1
                    book_participation[follower]['followed'] += 1
    pairs = [{'leader': a, 'follower': b, 'confirmed_leads': v['lead_count'],
              'median_lag_minutes': r4(float(np.median(v['lag_minutes']))) if v['lag_minutes'] else None}
             for (a, b), v in pair_leads.items()]
    pairs.sort(key=lambda p: -p['confirmed_leads'])
    by_book = {}
    for book, v in book_participation.items():
        total = v['led'] + v['followed']
        by_book[book] = {'confirmed_leads': v['led'], 'confirmed_follows': v['followed'],
                          'leader_share': r4(v['led'] / total) if total else None,
                          'readable': total >= 20}
    return {'pairs': pairs, 'by_book': by_book,
            'note': 'Descriptive only; not used as a model input (see module docstring). '
                    '"leader_share" is this book\'s share of ITS OWN confirmed matched-pair '
                    'moves in which it moved first — no book is assumed sharp going in.'}


# ---------------------------------------------------------------- Target 1

BOOK_VOCAB = None  # filled at runtime from the dataset, never hardcoded

FEATURE_KEYS_T1 = ['own_line', 'own_steps_since_move', 'own_last_move_size', 'hours_to_kickoff',
                    'coverage', 'dispersion', 'n_other_moves_3', 'mean_abs_other_move_3', 'signed_pressure_3']


def target1_rows(panels, market):
    out = []
    for panel in panels.values():
        if panel.market != market:
            continue
        for book in panel.books:
            for i in range(1, len(panel.grid) - 1):
                own = panel.observed[book][i]
                if own is None:
                    continue
                other = panel.other_move_stats(book, i)
                base = {
                    'event_key': panel.event_key, 'book': book, 'grid_idx': i,
                    'own_line': own['line'],
                    'own_steps_since_move': panel.steps_since_own_move(book, i),
                    'own_last_move_size': panel.last_own_move_size(book, i),
                    'hours_to_kickoff': panel.hours_to_kickoff(i) or 0.0,
                    'coverage': panel.coverage(i), 'dispersion': panel.dispersion(i),
                    'n_other_moves_3': other['n_other_moves'],
                    'mean_abs_other_move_3': other['mean_abs_other_move'],
                    'signed_pressure_3': other['signed_pressure'],
                }
                for h in HORIZON_STEPS:
                    j = i + h
                    if j >= len(panel.grid):
                        continue
                    target = panel.filled[book][j]
                    if target is None:
                        continue
                    delta = target['line'] - own['line']
                    out.append({**base, 'horizon': h,
                                'moved': int(abs(delta) >= MIN_MOVE[market]),
                                'delta': delta})
    return out


def one_hot_books(rows, vocab):
    return np.array([[1.0 if r['book'] == b else 0.0 for b in vocab] for r in rows])


def design_matrix(rows, keys, vocab):
    numeric = np.array([[float(r[k]) for k in keys] for r in rows])
    return np.hstack([numeric, one_hot_books(rows, vocab)])


def binary_log_loss(y_true, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(log_loss(y_true, p, labels=[0, 1]))


def mae(y_true, p):
    return float(mean_absolute_error(y_true, p))


def group_kfold_eval(X, y, groups, fit_fn, predict_fn, loss_fn, n_splits=N_FOLDS):
    n_groups = len(set(groups))
    k = min(n_splits, n_groups)
    if k < 2:
        return None
    gkf = GroupKFold(n_splits=k)
    losses, oof = [], np.full(len(y), np.nan)
    for train_idx, test_idx in gkf.split(X, y, groups):
        if loss_fn is binary_log_loss and len(set(y[train_idx])) < 2:
            continue
        model = fit_fn(X[train_idx], y[train_idx])
        pred = predict_fn(model, X[test_idx])
        oof[test_idx] = pred
        losses.append(loss_fn(y[test_idx], pred))
    if not losses:
        return None
    return {'mean_loss': r4(float(np.mean(losses))), 'fold_losses': [r4(v) for v in losses], 'folds': len(losses)}


def run_target1(panels, market, trials):
    rows = target1_rows(panels, market)
    result = {}
    for h in HORIZON_STEPS:
        sub = [r for r in rows if r['horizon'] == h]
        if len(sub) < GATE_MIN_LABELS:
            result[str(h)] = {'readable': False, 'n': len(sub), 'reason': f'fewer than {GATE_MIN_LABELS} rows'}
            continue
        y_move = np.array([r['moved'] for r in sub], dtype=float)
        y_delta = np.array([r['delta'] for r in sub], dtype=float)
        groups = np.array([r['event_key'] for r in sub])
        X = design_matrix(sub, FEATURE_KEYS_T1, BOOK_VOCAB)

        base_rate = float(np.mean(y_move))
        base_pred = np.full(len(y_move), base_rate)
        baseline_prob = {'name': 'no_move_marginal_rate', 'mean_loss': r4(binary_log_loss(y_move, base_pred))}
        baseline_mag = {'name': 'zero_delta', 'mean_loss': r4(mae(y_delta, np.zeros_like(y_delta)))}
        trials.append({'target': 'next_move_probability', 'market': market, 'horizon': h, **baseline_prob})
        trials.append({'target': 'next_move_size', 'market': market, 'horizon': h, **baseline_mag})

        def fit_logit(Xtr, ytr):
            scaler = StandardScaler().fit(Xtr)
            if len(set(ytr)) < 2:
                return ('constant', float(np.mean(ytr)))
            model = LogisticRegression(penalty='l2', C=0.5, max_iter=2000).fit(scaler.transform(Xtr), ytr)
            return ('logit', scaler, model)

        def predict_logit(model, Xte):
            if model[0] == 'constant':
                return np.full(len(Xte), model[1])
            _, scaler, m = model
            return m.predict_proba(scaler.transform(Xte))[:, 1]

        def fit_hgb_cls(Xtr, ytr):
            if len(set(ytr)) < 2:
                return ('constant', float(np.mean(ytr)))
            m = HistGradientBoostingClassifier(max_iter=150, max_leaf_nodes=15, min_samples_leaf=20,
                                                l2_regularization=1.0, learning_rate=0.05, random_state=SEED)
            m.fit(Xtr, ytr)
            return ('hgb', m)

        def predict_hgb_cls(model, Xte):
            if model[0] == 'constant':
                return np.full(len(Xte), model[1])
            return model[1].predict_proba(Xte)[:, 1]

        logit_cv = group_kfold_eval(X, y_move, groups, fit_logit, predict_logit, binary_log_loss)
        hgb_cv = group_kfold_eval(X, y_move, groups, fit_hgb_cls, predict_hgb_cls, binary_log_loss)
        if logit_cv:
            trials.append({'target': 'next_move_probability', 'market': market, 'horizon': h,
                            'name': 'ridge_distributed_lag_logit', **logit_cv})
        if hgb_cv:
            trials.append({'target': 'next_move_probability', 'market': market, 'horizon': h,
                            'name': 'boosted_trees', **hgb_cv})

        def fit_ridge(Xtr, ytr):
            scaler = StandardScaler().fit(Xtr)
            return (scaler, Ridge(alpha=10.0).fit(scaler.transform(Xtr), ytr))

        def predict_ridge(model, Xte):
            scaler, m = model
            return m.predict(scaler.transform(Xte))

        def fit_hgb_reg(Xtr, ytr):
            m = HistGradientBoostingRegressor(max_iter=150, max_leaf_nodes=15, min_samples_leaf=20,
                                               l2_regularization=1.0, learning_rate=0.05, random_state=SEED)
            return m.fit(Xtr, ytr)

        def predict_hgb_reg(model, Xte):
            return model.predict(Xte)

        ridge_cv = group_kfold_eval(X, y_delta, groups, fit_ridge, predict_ridge, mae)
        hgbreg_cv = group_kfold_eval(X, y_delta, groups, fit_hgb_reg, predict_hgb_reg, mae)
        if ridge_cv:
            trials.append({'target': 'next_move_size', 'market': market, 'horizon': h,
                            'name': 'ridge_distributed_lag', **ridge_cv})
        if hgbreg_cv:
            trials.append({'target': 'next_move_size', 'market': market, 'horizon': h,
                            'name': 'boosted_trees', **hgbreg_cv})

        candidates_prob = {'no_move_marginal_rate': baseline_prob['mean_loss'],
                            **({'ridge_distributed_lag_logit': logit_cv['mean_loss']} if logit_cv else {}),
                            **({'boosted_trees': hgb_cv['mean_loss']} if hgb_cv else {})}
        candidates_mag = {'zero_delta': baseline_mag['mean_loss'],
                           **({'ridge_distributed_lag': ridge_cv['mean_loss']} if ridge_cv else {}),
                           **({'boosted_trees': hgbreg_cv['mean_loss']} if hgbreg_cv else {})}
        selected_prob = min(candidates_prob, key=candidates_prob.get)
        selected_mag = min(candidates_mag, key=candidates_mag.get)
        result[str(h)] = {
            'readable': len(sub) >= GATE_MIN_LABELS, 'n': len(sub), 'base_move_rate': r4(base_rate),
            'probability_model': {'selected': selected_prob, 'candidates': candidates_prob,
                                   'beats_baseline': candidates_prob[selected_prob] < candidates_prob['no_move_marginal_rate'] - 1e-9},
            'magnitude_model': {'selected': selected_mag, 'candidates': candidates_mag,
                                 'beats_baseline': candidates_mag[selected_mag] < candidates_mag['zero_delta'] - 1e-9},
        }
    return result


# ---------------------------------------------------------------- Target 2

FEATURE_KEYS_T2 = ['gap_at_start', 'steps_elapsed', 'follower_steps_since_move', 'hours_to_kickoff', 'coverage']


def hazard_rows(panels, market):
    """One row per (move, follower, step-at-risk). `event_key` groups by the
    underlying game so GroupKFold cannot see the same game's race on both
    sides of a split."""
    out = []
    for panel in panels.values():
        if panel.market != market:
            continue
        for leader in panel.books:
            for mv in panel.moves[leader]:
                i0 = mv['grid_idx']
                direction = 1 if mv['delta'] > 0 else -1
                for follower in panel.books:
                    if follower == leader:
                        continue
                    before = panel.filled[follower][i0 - 1] if i0 > 0 else None
                    if before is None or direction * (before['line'] - mv['from_line']) > 1e-9:
                        continue
                    gap0 = direction * (mv['to_line'] - before['line'])
                    last_step = min(i0 + MAX_HAZARD_STEPS, len(panel.grid) - 1)
                    followed_at = None
                    for j in range(i0, last_step + 1):
                        row = panel.observed[follower][j]
                        if row is not None and direction * (row['line'] - mv['to_line']) >= -1e-9:
                            followed_at = j
                            break
                    disappeared = all(panel.observed[follower][j] is None for j in range(i0 + 1, last_step + 1))
                    for k, j in enumerate(range(i0, last_step + 1)):
                        followed_here = int(followed_at == j)
                        out.append({
                            'event_key': panel.event_key, 'move_id': f'{panel.event_key}|{leader}|{i0}',
                            'leader': leader, 'follower': follower, 'step': k,
                            'gap_at_start': gap0, 'steps_elapsed': k,
                            'follower_steps_since_move': panel.steps_since_own_move(follower, i0),
                            'hours_to_kickoff': panel.hours_to_kickoff(i0) or 0.0,
                            'coverage': panel.coverage(i0),
                            'followed': followed_here, 'disappeared_censored': int(disappeared and followed_at is None),
                        })
                        if followed_here:
                            break
    return out


def run_target2(panels, market, trials):
    rows = hazard_rows(panels, market)
    if len(rows) < GATE_MIN_LABELS:
        return {'readable': False, 'n': len(rows), 'reason': f'fewer than {GATE_MIN_LABELS} at-risk step rows'}
    y = np.array([r['followed'] for r in rows], dtype=float)
    groups = np.array([r['event_key'] for r in rows])
    X = np.array([[float(r[k]) for k in FEATURE_KEYS_T2] for r in rows])

    by_step = collections.defaultdict(list)
    for r in rows:
        by_step[r['step']].append(r['followed'])
    marginal_hazard = {s: float(np.mean(v)) for s, v in by_step.items()}
    base_pred = np.array([marginal_hazard.get(r['step'], np.mean(y)) for r in rows])
    baseline = {'name': 'marginal_hazard_by_step', 'mean_loss': r4(binary_log_loss(y, base_pred))}
    trials.append({'target': 'time_to_follow', 'market': market, **baseline})

    def fit_logit(Xtr, ytr):
        scaler = StandardScaler().fit(Xtr)
        if len(set(ytr)) < 2:
            return ('constant', float(np.mean(ytr)))
        return ('logit', scaler, LogisticRegression(penalty='l2', C=0.5, max_iter=2000).fit(scaler.transform(Xtr), ytr))

    def predict_logit(model, Xte):
        if model[0] == 'constant':
            return np.full(len(Xte), model[1])
        _, scaler, m = model
        return m.predict_proba(scaler.transform(Xte))[:, 1]

    def fit_hgb(Xtr, ytr):
        if len(set(ytr)) < 2:
            return ('constant', float(np.mean(ytr)))
        m = HistGradientBoostingClassifier(max_iter=150, max_leaf_nodes=15, min_samples_leaf=20,
                                            l2_regularization=1.0, learning_rate=0.05, random_state=SEED)
        m.fit(Xtr, ytr)
        return ('hgb', m)

    def predict_hgb(model, Xte):
        if model[0] == 'constant':
            return np.full(len(Xte), model[1])
        return model[1].predict_proba(Xte)[:, 1]

    logit_cv = group_kfold_eval(X, y, groups, fit_logit, predict_logit, binary_log_loss)
    hgb_cv = group_kfold_eval(X, y, groups, fit_hgb, predict_hgb, binary_log_loss)
    if logit_cv:
        trials.append({'target': 'time_to_follow', 'market': market, 'name': 'ridge_distributed_lag_logit', **logit_cv})
    if hgb_cv:
        trials.append({'target': 'time_to_follow', 'market': market, 'name': 'boosted_trees_hazard', **hgb_cv})

    candidates = {'marginal_hazard_by_step': baseline['mean_loss'],
                  **({'ridge_distributed_lag_logit': logit_cv['mean_loss']} if logit_cv else {}),
                  **({'boosted_trees_hazard': hgb_cv['mean_loss']} if hgb_cv else {})}
    selected = min(candidates, key=candidates.get)
    disappearance_rate = mean([r['disappeared_censored'] for r in rows if r['step'] == 0])
    return {
        'readable': True, 'n': len(rows), 'moves_and_races': len({r['move_id'] for r in rows}),
        'marginal_hazard_by_step': {str(s): r4(v) for s, v in sorted(marginal_hazard.items())},
        'selected_model': selected, 'candidates': candidates,
        'beats_baseline': candidates[selected] < candidates['marginal_hazard_by_step'] - 1e-9,
        'disappearance_rate_at_move': r4(disappearance_rate),
        'disappearance_note': 'share of (move, follower) races where the follower stopped being quoted at all '
                               'before matching or kickoff — measured at native poll resolution only.',
    }


# ---------------------------------------------------------------- Target 3

def fit_exponential_hazard(marginal_hazard_by_step, native_step_seconds):
    """Constant-hazard (exponential inter-arrival) fit to the discrete
    per-step marginal hazard, used ONLY to extrapolate survival probability
    down to delays shorter than the tape's own polling resolution. This is a
    declared modeling assumption, not a measured shape — see module docstring.
    """
    if not marginal_hazard_by_step or native_step_seconds is None:
        return None
    h1 = marginal_hazard_by_step.get(0) or marginal_hazard_by_step.get('0')
    if not h1 or h1 <= 0 or h1 >= 1:
        return None
    return -math.log(1 - h1) / native_step_seconds


def survival_at(rate_per_second, seconds):
    if rate_per_second is None:
        return None
    return math.exp(-rate_per_second * seconds)


def run_target3(target2_by_market, native_step_seconds):
    out = {}
    for market, t2 in target2_by_market.items():
        if not t2.get('readable'):
            out[market] = {'readable': False, 'reason': t2.get('reason', 'time-to-follow model not readable')}
            continue
        rate = fit_exponential_hazard(t2['marginal_hazard_by_step'], native_step_seconds)
        delays = {}
        for d in DELAY_SECONDS:
            delays[str(d)] = {'survival_probability': r4(survival_at(rate, d)), 'extrapolated': True,
                               'basis': 'constant-hazard fit to the measured per-step marginal hazard; '
                                        f'the tape\'s own median poll gap is ~{r4(native_step_seconds)}s, '
                                        'so this delay is shorter than anything directly observed'}
        measured_step_survival = 1 - (t2['marginal_hazard_by_step'].get('0') or 0)
        delays[str(int(round(native_step_seconds)))] = {
            'survival_probability': r4(measured_step_survival), 'extrapolated': False,
            'basis': 'directly measured: share of opportunities still unfollowed by the very next poll'}
        out[market] = {
            'readable': True, 'exponential_rate_per_second': rate,
            'delay_survival': delays,
            'disappearance_rate_at_move': t2['disappearance_rate_at_move'],
            'stake_limits': {'measured': False,
                              'reason': 'nfl_quote_tape has no book depth/limit field; this is an open data '
                                        'gap (Package H), not a modeled zero. No number is assumed here.'},
        }
    return out


def route_opportunities(panels, target3_by_market):
    """The plan's watch/refresh/paper routing, applied to every currently
    open (move, follower) gap using the mid delay bucket (30s) as the
    decision point — a fixed, pre-declared choice, not tuned per result."""
    thresholds = {'paper_opportunity': 0.70, 'refresh': 0.30}
    routed = collections.Counter()
    examples = []
    for panel in panels.values():
        t3 = target3_by_market.get(panel.market)
        if not t3 or not t3.get('readable'):
            continue
        survival = t3['delay_survival'].get('30', {}).get('survival_probability')
        if survival is None:
            continue
        for leader in panel.books:
            for mv in panel.moves[leader]:
                i0 = mv['grid_idx']
                direction = 1 if mv['delta'] > 0 else -1
                for follower in panel.books:
                    if follower == leader:
                        continue
                    before = panel.filled[follower][i0 - 1] if i0 > 0 else None
                    if before is None or direction * (before['line'] - mv['from_line']) > 1e-9:
                        continue
                    gap = abs(direction * (mv['to_line'] - before['line']))
                    if gap < MIN_MOVE[panel.market]:
                        continue
                    state = ('paper_opportunity' if survival >= thresholds['paper_opportunity']
                             else 'refresh' if survival >= thresholds['refresh'] else 'watch')
                    routed[state] += 1
                    if len(examples) < 25:
                        examples.append({'event_key': panel.event_key, 'market': panel.market,
                                          'leader': leader, 'follower': follower, 'gap_points': r4(gap),
                                          'survival_at_30s': survival, 'state': state})
    return {'thresholds': thresholds, 'counts': dict(routed), 'examples': examples,
            'basis': 'routed using the 30-second extrapolated survival bucket; see delay_survival for '
                     'the other three plan-requested horizons and the one directly-measured point'}


# ---------------------------------------------------------- Hawkes go/no-go

def hawkes_feasibility(rows, panels):
    fallback_count, total_own_ts = 0, 0
    for r in rows:
        if r.get('period') != 'full_game' or r.get('market') not in CANON_SIDE:
            continue
        if not r.get('book_updated_at'):
            continue
        total_own_ts += 1
        if r['book_updated_at'] == r['snapshot_at']:
            fallback_count += 1
    fallback_share = (fallback_count / total_own_ts) if total_own_ts else None
    total_moves = sum(len(mv) for panel in panels.values() for mv in panel.moves.values())
    n_books = len({b for panel in panels.values() for b in panel.books})
    params_needed = n_books * (n_books - 1)
    verdict = (bool(params_needed) and total_moves > 0 and fallback_share is not None
               and fallback_share < 0.15 and total_moves >= 5 * params_needed)
    moves_per_param = r4(total_moves / params_needed) if params_needed else None
    return {
        'attempted': False,
        'fetch_time_fallback_share': r4(fallback_share),
        'total_confirmed_moves_all_books': total_moves,
        'books_observed': n_books,
        'pairwise_kernel_parameters_if_fit': params_needed,
        'moves_per_parameter_if_fit': moves_per_param,
        'would_be_feasible': verdict,
        'verdict': ('Not attempted. ' +
            f'{r4((fallback_share or 0) * 100)}% of book_updated_at stamps equal our own poll time exactly '
            '(the aggregator falling back to fetch time for books that do not expose their own update clock), '
            f'and the current tape only has {total_moves} confirmed moves across {n_books} books against '
            f'{params_needed} pairwise kernel parameters a multivariate Hawkes fit would need — '
            f'roughly {moves_per_param} moves per parameter. Fitting one now would overfit a single week of '
            'preseason/opening-week captures, exactly the "common news arrivals mimic book-to-book causation" '
            'risk the plan warns about. Re-run this check once several more weeks of tape exist.'),
    }


# --------------------------------------------------------------- protocol

def write_protocol(run_dir, dataset_hash, native_step_seconds, n_events, books):
    protocol = {
        'schema': VERSION, 'written_before_evaluation': True,
        'economic_hypothesis': (
            'When one book\'s posted NFL spread/total price moves, other books do not all reflect it '
            'instantly. (1) whether/how much a GIVEN book\'s own price moves in the near term is more '
            'predictable than "no move" using the recent moves of OTHER books polled in the same slate; '
            '(2) among books that eventually match a mover, the specific time each one takes is '
            'predictable better than an unconditional hazard; (3) a currently-quoted gap between a mover '
            'and a not-yet-followed book has an estimable survival probability that can route it into '
            'watch/refresh/paper states. No book is assumed sharp going in — leadership is measured, not assumed.'),
        'scope': {'league': 'nfl', 'markets': list(CANON_SIDE.keys()), 'period': 'full_game',
                  'sides': CANON_SIDE, 'books': books, 'events_in_scope': n_events,
                  'source_dataset_hash': dataset_hash},
        'decision_horizons': {'next_move_target': f'{HORIZON_STEPS} native poll steps ahead',
                               'time_to_follow_target': f'discrete hazard, right-censored at {MAX_HAZARD_STEPS} steps',
                               'delay_survival_target_seconds': list(DELAY_SECONDS),
                               'native_poll_step_seconds_measured': r4(native_step_seconds)},
        'data_publication_times_relied_on': ['snapshot_at (our receipt time)', 'book_updated_at (book\'s own '
            'claimed update time, only when not later than snapshot_at — enforced upstream by '
            'nfl-evidence-dataset.js book_ahead_of_snapshot quarantine)'],
        'target_label_time': 'target 1: the (i+h)-th poll of the same event; target 2/3: the poll at which a '
            'follower\'s line matches/crosses the leader\'s new line, or right-censored at the event\'s own '
            'last pre-kickoff poll or kickoff itself, whichever comes first',
        'baseline': {'next_move': 'no_move_marginal_rate (predict the empirical move rate; zero magnitude)',
                     'time_to_follow_and_survival': 'marginal_hazard_by_step (book/gap-agnostic empirical hazard)'},
        'model_search_budget': 'exactly two families beyond baseline per target: L2-regularized logistic/ridge '
            'distributed-lag, and HistGradientBoosting(Classifier|Regressor); no hyperparameter search beyond '
            'the single fixed configuration recorded in trials.json',
        'hawkes_model': 'assessed for go/no-go before any fitting; see hawkes_feasibility in report.json for '
            'the exact data-based reasons it is not attempted this run',
        'split_policy': {'method': 'GroupKFold on event_key', 'folds': N_FOLDS,
                          'declared_limitation': 'the tape currently spans one NFL week; there is no second '
                              'week yet to hold out chronologically as the plan asks. GroupKFold-by-event only '
                              'guarantees a game\'s own snapshots do not appear on both sides of a split — it '
                              'does NOT show these models generalize to a different week or news cycle. Re-run '
                              'this identical script, unmodified, once several more weeks of tape exist, and '
                              'treat this run\'s numbers as superseded when that run completes.'},
        'trials_declared': 'every candidate fit for every target/market/horizon is appended to trials.json, '
            'including any that fail to beat baseline; none are omitted after the fact',
        'selection_rule': 'lowest mean cross-validated loss (log-loss for probability/hazard targets, MAE for '
            'magnitude) on the GroupKFold splits, chosen before any economic/CLV-style metric is computed',
        'costs': 'none modeled here; this package predicts timing, not net-of-vig return',
        'failure_criteria': [
            'a target\'s selected model does not beat its baseline out-of-fold on the GroupKFold splits',
            'the apparent gain at target 3 collapses toward the baseline survival curve once the delay-adjusted '
            'receipt time is enforced (i.e., freshness/delay checks erase the effect)',
            f'fewer than {GATE_MIN_LABELS} labeled rows for a target/market/horizon cell -> reported as '
            '"not yet readable", not scored as a pass or fail'],
        'artifacts': ['preregistered.json (this file)', 'lead_lag_matrix.json', 'trials.json', 'report.json',
                      'panel_summary.json', 'latest.json'],
    }
    atomic_json(run_dir / 'preregistered.json', protocol)
    return protocol


# --------------------------------------------------------------------- main

def run(args):
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    manifest, dataset_hash, rows = load_evidence_dataset(args.dataset_dir, args.dataset_hash)

    code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + code_hash[:8]
    run_dir = out / run_id
    run_dir.mkdir()

    panels = build_all_panels(rows)
    global BOOK_VOCAB
    BOOK_VOCAB = sorted({b for panel in panels.values() for b in panel.books})
    native_step_seconds = measure_native_step_seconds(panels)
    n_events = len({k[0] for k in panels})

    protocol = write_protocol(run_dir, dataset_hash, native_step_seconds, n_events, BOOK_VOCAB)

    hawkes = hawkes_feasibility(rows, panels)
    matrix = lead_lag_matrix(panels)
    atomic_json(run_dir / 'lead_lag_matrix.json', matrix)

    trials = []
    target1 = {m: run_target1(panels, m, trials) for m in CANON_SIDE}
    target2 = {m: run_target2(panels, m, trials) for m in CANON_SIDE}
    target3 = run_target3(target2, native_step_seconds)
    routing = route_opportunities(panels, target3)
    atomic_json(run_dir / 'trials.json', trials)

    panel_summary = {
        'events': n_events, 'books': BOOK_VOCAB, 'native_step_seconds': r4(native_step_seconds),
        'markets': {m: {'events': sum(1 for k in panels if k[1] == m),
                         'total_confirmed_moves': sum(len(p.moves[b]) for k, p in panels.items() if k[1] == m for b in p.books)}
                    for m in CANON_SIDE},
    }
    atomic_json(run_dir / 'panel_summary.json', panel_summary)

    verdicts = []
    readable_cells, failing_cells = 0, 0
    for m in CANON_SIDE:
        for h, cell in target1[m].items():
            if cell.get('readable'):
                readable_cells += 1
                if not cell['probability_model']['beats_baseline'] and not cell['magnitude_model']['beats_baseline']:
                    failing_cells += 1
                    verdicts.append(f'{m}/next_move/{h}-step: neither model beat the no-move baseline')
        t2 = target2[m]
        if t2.get('readable'):
            readable_cells += 1
            if not t2['beats_baseline']:
                failing_cells += 1
                verdicts.append(f'{m}/time_to_follow: neither model beat the marginal hazard baseline')
    if readable_cells and failing_cells == readable_cells:
        overall_verdict = ('No lead/lag edge survived cross-validation on this dataset; every readable target/'
                            'market/horizon cell matched or lost to its baseline. This is a complete, honest '
                            'result on a one-week pilot, not a partial run.')
    elif readable_cells == 0:
        overall_verdict = 'No target/market/horizon cell had enough labeled rows yet to score; see next_move/time_to_follow for the exact counts.'
    else:
        overall_verdict = (f'{readable_cells - failing_cells} of {readable_cells} readable target/market/horizon '
                            'cells beat their baseline out-of-fold; see report.json for which, and treat every '
                            'number as a single-week pilot per the declared split-policy limitation.')

    report = {
        'schema': VERSION, 'run_id': run_id, 'status': 'complete', 'authority': 'research_only',
        'production_changed': False, 'created_at': datetime.now(timezone.utc).isoformat(),
        'dataset_hash': dataset_hash, 'evidence_dataset_built_at': manifest.get('built_at'),
        'evidence_dataset_accepted_rows': manifest.get('accepted'), 'code_hash': code_hash,
        'protocol': protocol, 'panel_summary': panel_summary, 'hawkes_feasibility': hawkes,
        'lead_lag_matrix': matrix, 'next_move': target1, 'time_to_follow': target2,
        'delay_survival': target3, 'opportunity_routing': routing,
        'verdict': overall_verdict, 'per_cell_baseline_failures': verdicts,
        'limitations': [
            'The tape spans one NFL week (48 events, one capture window). Every number here is a pilot, not '
            'a validated cross-season result — see protocol.split_policy.declared_limitation.',
            f'delay_survival for {list(DELAY_SECONDS)} seconds is an extrapolation of a constant-hazard fit '
            f'through the tape\'s own ~{r4(native_step_seconds)}s median poll gap, not a replayed observation; '
            'only the native-step number in each market\'s delay_survival is directly measured.',
            'Stake limits are not observable in nfl_quote_tape (no depth/limit field) and are not modeled or '
            'assumed here; see delay_survival[*].stake_limits.',
            'A Hawkes/marked-point-process model was assessed and explicitly not attempted this run; see '
            'hawkes_feasibility for the exact data-based reasons.',
            'Every quote in the source evidence dataset is a reconstructed/captured archive row, not a proof '
            'of an executable price — Package H replays that question separately.',
        ],
    }
    atomic_json(run_dir / 'report.json', report)
    atomic_json(out / 'latest.json', report)
    print(json.dumps({'run_id': run_id, 'status': report['status'], 'dataset_hash': dataset_hash,
                       'events': n_events, 'books': len(BOOK_VOCAB),
                       'verdict': overall_verdict}, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--dataset-dir', required=True, help='server/data/evidence-datasets directory')
    p.add_argument('--dataset-hash', default=None, help='defaults to that directory\'s latest.json pointer')
    p.add_argument('--output', required=True, help='server/data/book-lag-lab directory')
    args = p.parse_args()
    run(args)
