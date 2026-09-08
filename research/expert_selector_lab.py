"""Package F: a selector that learns WHEN each expert is useful.

Read docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md (section F) and
docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md (part 2.6) first.

WHAT THIS IS
------------
A regularized CONDITIONAL selector over experts, replacing global yes/no
beliefs about them. The Level-1 meta-learner is the constrained form the
architecture assessment names as its single highest-leverage adoption:

    min_b  SUM_i (y_i - SUM_j b_j yhat_ij)^2 + alpha * SUM_j b_j^2
    subject to  b_j >= 0,  SUM_j b_j = 1

Non-negative and summing to one makes the stacker a bounded weighted average.
It cannot subtract one expert from another, and it cannot invent a
high-leverage coefficient, so a single expert going haywire on one game can
never drag the blend past the envelope of the experts themselves. A
market-only expert competes on equal terms and may take weight 1.0 -- "trust
nothing here, take the market" is a selectable outcome, not the absence of
one.

THE PREREQUISITE PROBLEM, AND WHAT WAS ACTUALLY DONE ABOUT IT
-------------------------------------------------------------
The master plan says F depends on "C/D/E producing frozen out-of-fold
outputs." Checked on disk rather than assumed, that was only partly true:
Package C (tree-lab) persisted models and a dataset but NO per-row
predictions; Package D (role-scenario-lab) persisted only a manifest;
Package E had never been run at all (a real run costs LLM API money).

Rather than score any model on rows it was trained on -- the exact leak this
whole research program exists to prevent -- this lab uses two substrates,
each with an explicitly different and separately reported guarantee:

  SUBSTRATE 1, "tree" (strong guarantee, small):
    research/tree_lab.py was extended (see its `emit_oof`) to PERSIST the
    per-row, per-candidate held-out predictions it already computed and then
    discarded. No model is refit here and no model is scored on its own
    training rows. Every expert was fit on seasons strictly earlier than the
    season it predicts, with a seven-day settled-label cutoff.

  SUBSTRATE 2, "council" (weaker guarantee, larger, and the one that
  actually answers Nick's question about his own expert council):
    `nfl_weekly_expert_examples`, 28,723 labeled rows, 20 experts, 831 games,
    2022-2025. These rows are RETROSPECTIVE BACKFILLS: every row was written
    on 2026-09-01/02 while its `evidence_cutoff` is the historical kickoff.
    They are cutoff-SIMULATED walk-forward, not frozen-at-decision-time. Any
    component whose own artifact was fitted on full history leaks here. This
    is reported as a declared limitation on every council result, never
    quietly.

  NOT USED, and why: `nfl_expert_forward_predictions` is the architecturally
    correct artifact -- append-only, immutability-triggered, captured before
    kickoff -- but it holds 672 rows from a single unplayed week with ZERO
    settlements. It can train nothing today. It is the right substrate for
    this lab the moment weeks settle.

RELATIONSHIP TO THE EXISTING COORDINATOR
----------------------------------------
`server/services/nfl-expert-coordinator.js` already does walk-forward
per-expert shrinkage, correlation-family clustering (FAMILY_CORRELATION=0.6)
and Shapley attribution. This lab does NOT duplicate it. The differentiator
is that the coordinator's `k` is ONE GLOBAL NUMBER per expert -- an expert
shrunk to zero contributes nothing in every context, forever -- while this
lab asks whether weight should change WITH the situation, and benchmarks
that conditional gate against the coordinator's own blend as a competing
expert.

AUTHORITY: research only. Nothing here promotes a model, touches a live pick
endpoint, or gains staking authority. The database is opened read-only.
"""
from __future__ import annotations
import argparse, collections, hashlib, json, math, sqlite3, time
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from scipy.optimize import minimize
from drift import detect_distribution_drift

# Bumped from expert-selector-lab-v1 when `drift_scans` was added per substrate.
# The reader in server/services/nfl-research-lab.js accepts both versions: the
# frozen v1 report on disk (a real run, and a negative result) is evidence and
# must keep rendering; it simply has no drift block.
VERSION = 'expert-selector-lab-v2'
SEED = 83017

# Correlation at or above this merges two experts into one family. Deliberately
# stricter than the coordinator's 0.6 so that FAMILY ABLATION (the plan's named
# failure criterion) removes genuinely near-duplicate experts rather than
# merely related ones. Both thresholds are reported.
FAMILY_CORRELATION = 0.90
ALPHA_GRID = [0.0, 0.001, 0.01, 0.1, 1.0, 10.0]
BOOTSTRAP = 2000


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, default=str))
    tmp.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:60]


# ---------------------------------------------------------------------------
# The Level-1 meta-learner: non-negative ridge, coefficients summing to 1
# ---------------------------------------------------------------------------

def simplex_ridge(P, y, alpha, mask=None):
    """Solve  min_b ||y - Pb||^2/n + alpha*||b||^2  s.t. b >= 0, sum(b) = 1.

    P is (n, J) expert predictions; y is (n,). `mask` is an optional (n, J)
    0/1 availability matrix: where an expert is unavailable for a row, the
    remaining weights are RENORMALIZED for that row rather than the missing
    expert silently contributing zero. That distinction matters -- treating an
    absent expert as predicting zero would quietly bias the blend toward the
    market every time coverage dropped, which would look like the selector
    learning to abstain when it is really just missing data.

    Both the squared-error objective and the simplex constraint set are
    convex, so the solution is a global optimum; the equal-weight start is
    sufficient and is used for reproducibility.
    """
    n, J = P.shape
    if mask is None:
        mask = np.ones_like(P, dtype=float)

    def blend(b):
        num = (P * mask) @ b
        den = mask @ b
        den = np.where(den <= 1e-12, 1.0, den)
        return num / den

    def objective(b):
        resid = y - blend(b)
        return float(np.mean(resid ** 2) + alpha * np.sum(b ** 2))

    start = np.full(J, 1.0 / J)
    result = minimize(objective, start, method='SLSQP',
        bounds=[(0.0, 1.0)] * J,
        constraints=[{'type': 'eq', 'fun': lambda b: float(np.sum(b) - 1.0)}],
        options={'maxiter': 500, 'ftol': 1e-10})
    b = np.clip(result.x, 0.0, None)
    total = b.sum()
    b = b / total if total > 1e-12 else start
    return b, bool(result.success)


def apply_weights(P, b, mask=None):
    if mask is None:
        mask = np.ones_like(P, dtype=float)
    num = (P * mask) @ b
    den = mask @ b
    den = np.where(den <= 1e-12, 1.0, den)
    return num / den


# ---------------------------------------------------------------------------
# Uncertainty: week-clustered, because games in a week are dependent
# ---------------------------------------------------------------------------

def week_cluster_interval(week_keys, values, seed=SEED, draws=BOOTSTRAP):
    """Bootstrap over WEEKS, not rows. The master plan's rejected shortcut #4
    ('more books means more independent evidence') applies to games too: two
    games in the same week share weather regimes, news cycles and a common
    model vintage. Resampling rows would understate the interval."""
    grouped = collections.defaultdict(list)
    for k, v in zip(week_keys, values):
        grouped[k].append(v)
    if len(grouped) < 8:
        return None
    blocks = list(grouped.values())
    sums = np.array([float(np.sum(b)) for b in blocks])
    counts = np.array([len(b) for b in blocks], dtype=float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(blocks), size=(draws, len(blocks)))
    means = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    return [float(v) for v in np.quantile(means, [0.025, 0.975])]


# ---------------------------------------------------------------------------
# Expert family clustering (the plan: "cluster duplicate/correlated families")
# ---------------------------------------------------------------------------

def cluster_families(P, mask, names, threshold=FAMILY_CORRELATION):
    """Single-linkage union-find over |pearson r| computed on TRAINING rows
    where both experts are available. Treating near-copies as independent
    evidence is the expert-side version of the plan's rejected shortcut #4."""
    J = len(names)
    parent = list(range(J))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    pairs = []
    for i in range(J):
        for j in range(i + 1, J):
            both = (mask[:, i] > 0) & (mask[:, j] > 0)
            if both.sum() < 50:
                continue
            a, b = P[both, i], P[both, j]
            if np.std(a) < 1e-9 or np.std(b) < 1e-9:
                continue
            r = float(np.corrcoef(a, b)[0, 1])
            if not math.isfinite(r):
                continue
            pairs.append({'a': names[i], 'b': names[j], 'r': round(r, 4), 'n': int(both.sum())})
            if abs(r) >= threshold:
                parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i in range(J):
        groups[find(i)].append(names[i])
    families = sorted([sorted(v) for v in groups.values()], key=lambda g: (-len(g), g[0]))
    pairs.sort(key=lambda p: -abs(p['r']))
    return families, pairs


# ---------------------------------------------------------------------------
# Substrate 1: the council's own persisted per-expert examples
# ---------------------------------------------------------------------------

def load_council(db_path):
    """Pivot nfl_weekly_expert_examples into a game x expert residual matrix.

    Deduplication: the table holds up to seven rows per (game, expert) across
    seven different audit runs, and different runs used different engine
    versions -- so the same expert_id is not necessarily the same code. The
    HIGHEST audit_run_id wins, which pins each expert to its newest available
    vintage; the run composition is reported so this choice is inspectable
    rather than buried.
    """
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT season, week, home, away, expert_id, audit_run_id, observed,
               forecast_residual, uncertainty, actual_residual
        FROM nfl_weekly_expert_examples
        WHERE actual_residual IS NOT NULL
        ORDER BY audit_run_id, id
    """).fetchall()
    runs = collections.Counter()
    for r in rows:
        runs[r['audit_run_id']] += 1
    conn.close()

    games = {}
    for r in rows:  # ascending audit_run_id => last write wins => newest vintage
        key = (r['season'], r['week'], r['home'], r['away'])
        g = games.setdefault(key, {'season': r['season'], 'week': r['week'], 'home': r['home'],
            'away': r['away'], 'y': r['actual_residual'], 'experts': {}, 'uncertainty': {}})
        if r['observed'] and r['forecast_residual'] is not None and math.isfinite(r['forecast_residual']):
            g['experts'][r['expert_id']] = float(r['forecast_residual'])
            if r['uncertainty'] is not None and math.isfinite(r['uncertainty']):
                g['uncertainty'][r['expert_id']] = float(r['uncertainty'])
        g['y'] = float(r['actual_residual'])

    ordered = sorted(games.values(), key=lambda g: (g['season'], g['week'], g['home']))
    names = sorted({e for g in ordered for e in g['experts']})
    return ordered, names, dict(runs)


def council_matrix(games, names):
    """Build P (predictions), mask (availability), y, and the context features
    the gate is allowed to condition on. The market-only expert is a CONSTANT
    ZERO residual column: on this substrate an expert's output is already
    'how far from the market line I think the truth is', so predicting zero
    residual IS taking the market, and it is always available."""
    J = len(names) + 1
    n = len(games)
    P = np.zeros((n, J)); mask = np.zeros((n, J))
    y = np.array([g['y'] for g in games], dtype=float)
    for i, g in enumerate(games):
        for j, name in enumerate(names):
            if name in g['experts']:
                P[i, j] = g['experts'][name]; mask[i, j] = 1.0
        P[i, -1] = 0.0; mask[i, -1] = 1.0        # market_only / abstain
    columns = list(names) + ['market_only']

    context = []
    for i, g in enumerate(games):
        vals = [v for k, v in g['experts'].items() if k != 'coordinator']
        unc = list(g['uncertainty'].values())
        context.append({
            'coverage': float(len(vals)),                                    # data availability
            'disagreement': float(np.std(vals)) if len(vals) > 1 else 0.0,   # uncertainty
            'mean_uncertainty': float(np.mean(unc)) if unc else 0.0,         # uncertainty
            'week': float(g['week'])})                                       # horizon
    return P, mask, y, columns, context


# ---------------------------------------------------------------------------
# Substrate 2: the frozen per-row OOF matrix tree_lab now emits
# ---------------------------------------------------------------------------

def load_tree_oof(run_dir, target='move'):
    files = sorted(Path(run_dir).glob(f'*-{target}-oof.json'))
    if not files:
        return None
    payloads = [json.loads(f.read_text()) for f in files]
    by_market = collections.defaultdict(list)
    for p in payloads:
        for row in p['predictions']:
            by_market[p['market']].append(row)
    out = {}
    for market, rows in by_market.items():
        rows.sort(key=lambda r: (r['season'], r['week'], r['event_id']))
        names = sorted({k for r in rows for k, v in r['experts'].items() if v is not None})
        n, J = len(rows), len(names)
        P = np.zeros((n, J)); mask = np.zeros((n, J))
        for i, r in enumerate(rows):
            for j, name in enumerate(names):
                v = r['experts'].get(name)
                if v is not None and math.isfinite(v):
                    P[i, j] = v; mask[i, j] = 1.0
        y = np.array([r['y'] for r in rows], dtype=float)
        context = [{'coverage': float(mask[i].sum()), 'disagreement': float(np.std(P[i][mask[i] > 0])),
            'mean_uncertainty': 0.0, 'week': float(rows[i]['week'])} for i in range(n)]
        out[market] = {'rows': rows, 'P': P, 'mask': mask, 'y': y, 'columns': names, 'context': context}
    return out


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def mae(y, pred):
    return float(np.mean(np.abs(y - pred)))


def mse(y, pred):
    return float(np.mean((y - pred) ** 2))


def effective_weights(b, mask, columns):
    """Reported weight adjusted for availability.

    A raw weight is misleading for an expert that is absent from most rows in
    a fold: `nfelo_line` covers only 2022-2023, so a raw 0.24 on a 2025 fold
    describes a coefficient that `apply_weights` renormalizes away on nearly
    every row it is scored against. The effective weight is the mean, over
    rows, of that expert's share of the renormalized blend -- i.e. how much of
    the prediction it actually accounted for."""
    b = np.asarray(b, dtype=float)
    contrib = mask * b[None, :]
    den = contrib.sum(axis=1)
    den = np.where(den <= 1e-12, 1.0, den)
    share = contrib / den[:, None]
    return {c: round(float(v), 5) for c, v in zip(columns, share.mean(axis=0))}


def select_alpha(P, mask, y, seasons, train_seasons, gate_key=None, context=None, bins=1):
    """Choose alpha on an INNER chronological split of the training seasons
    only: fit on all but the last training season, validate on the last. The
    outer test season is never touched. If there is only one training season
    there is no honest inner split, and alpha falls back to the grid's
    smallest non-zero value rather than being tuned on the test set."""
    if len(train_seasons) < 2:
        return 0.001, 'no inner split available (single training season); alpha not tuned'
    inner_fit = train_seasons[:-1]; inner_val = train_seasons[-1:]
    fit_idx = np.array([i for i, s in enumerate(seasons) if s in inner_fit])
    val_idx = np.array([i for i, s in enumerate(seasons) if s in inner_val])
    if len(fit_idx) < 30 or len(val_idx) < 15:
        return 0.001, 'inner split too small; alpha not tuned'
    best, best_loss = 0.001, float('inf')
    for alpha in ALPHA_GRID:
        pred = fit_and_predict(P, mask, y, fit_idx, val_idx, alpha, gate_key, context, bins)[0]
        loss = mae(y[val_idx], pred)
        if loss < best_loss:
            best, best_loss = alpha, loss
    return best, f'selected on inner chronological split (fit {inner_fit}, validate {inner_val})'


def fit_and_predict(P, mask, y, fit_idx, test_idx, alpha, gate_key=None, context=None, bins=1):
    """Fit the simplex-constrained stacker on fit_idx and predict test_idx.

    With bins > 1 this becomes the mixture-of-experts GATE: training rows are
    partitioned by a context variable at quantiles computed on TRAINING rows
    only, a separate weight vector is fitted per bin, and a test row is routed
    by the same training-derived edges. A bin with too few rows falls back to
    the global weights instead of fitting noise."""
    if bins <= 1 or gate_key is None:
        b, ok = simplex_ridge(P[fit_idx], y[fit_idx], alpha, mask[fit_idx])
        return apply_weights(P[test_idx], b, mask[test_idx]), {'global': b.tolist()}, ok

    values = np.array([c[gate_key] for c in context], dtype=float)
    edges = np.quantile(values[fit_idx], np.linspace(0, 1, bins + 1)[1:-1])
    fit_bin = np.digitize(values[fit_idx], edges)
    test_bin = np.digitize(values[test_idx], edges)
    global_b, ok = simplex_ridge(P[fit_idx], y[fit_idx], alpha, mask[fit_idx])
    weights = {}; pred = np.zeros(len(test_idx))
    for bi in range(bins):
        sel = fit_idx[fit_bin == bi]
        if len(sel) >= 40:
            b, sub_ok = simplex_ridge(P[sel], y[sel], alpha, mask[sel])
            ok = ok and sub_ok
        else:
            b = global_b
        weights[f'bin_{bi}'] = b.tolist()
        target = test_bin == bi
        if target.any():
            rows = test_idx[target]
            pred[target] = apply_weights(P[rows], b, mask[rows])
    return pred, {'gate_key': gate_key, 'bins': bins, 'edges': edges.tolist(), **weights}, ok


def baselines(P, mask, y, columns, test_idx):
    """The two baselines the plan says the selector must beat, plus the
    existing coordinator where that substrate has one."""
    out = {}
    market_j = columns.index('market_only') if 'market_only' in columns else None
    if market_j is not None:
        b = np.zeros(len(columns)); b[market_j] = 1.0
        out['market_only'] = apply_weights(P[test_idx], b, mask[test_idx])
    elif 'no_move' in columns:
        b = np.zeros(len(columns)); b[columns.index('no_move')] = 1.0
        out['market_only'] = apply_weights(P[test_idx], b, mask[test_idx])
    equal = np.full(len(columns), 1.0 / len(columns))
    out['static_equal_weight'] = apply_weights(P[test_idx], equal, mask[test_idx])
    if 'coordinator' in columns:
        b = np.zeros(len(columns)); b[columns.index('coordinator')] = 1.0
        out['existing_coordinator'] = apply_weights(P[test_idx], b, mask[test_idx])
    return out


def walk_forward(P, mask, y, columns, context, seasons, week_keys, gate_key=None, bins=1, label='global'):
    """Chronological walk-forward over seasons: fit the stacker on all earlier
    seasons, test on the next one. Never fits on the season it scores."""
    unique = sorted(set(seasons))
    folds = []
    for k in range(1, len(unique)):
        train_seasons, test_season = unique[:k], unique[k]
        fit_idx = np.array([i for i, s in enumerate(seasons) if s in train_seasons])
        test_idx = np.array([i for i, s in enumerate(seasons) if s == test_season])
        if len(fit_idx) < 60 or len(test_idx) < 20:
            continue
        alpha, alpha_note = select_alpha(P, mask, y, seasons, train_seasons, gate_key, context, bins)
        pred, weights, ok = fit_and_predict(P, mask, y, fit_idx, test_idx, alpha, gate_key, context, bins)
        base = baselines(P, mask, y, columns, test_idx)
        yt = y[test_idx]; wk = [week_keys[i] for i in test_idx]
        entry = {'test_season': int(test_season), 'train_seasons': [int(s) for s in train_seasons],
            'train_rows': int(len(fit_idx)), 'test_rows': int(len(test_idx)),
            'alpha': alpha, 'alpha_note': alpha_note, 'converged': ok,
            'selector_mae': mae(yt, pred), 'selector_mse': mse(yt, pred),
            'weights': weights, 'baselines': {}}
        if 'global' in weights:
            entry['effective_weights'] = effective_weights(weights['global'], mask[test_idx], columns)
        for name, bp in base.items():
            gain = np.abs(yt - bp) - np.abs(yt - pred)          # positive => selector better (MAE)
            sq_gain = (yt - bp) ** 2 - (yt - pred) ** 2         # positive => selector better (MSE)
            entry['baselines'][name] = {'mae': mae(yt, bp), 'mean_gain': float(np.mean(gain)),
                'gain_interval_week_clustered': week_cluster_interval(wk, gain),
                'beats': bool(np.mean(gain) > 0),
                # Secondary, added after the first run as a fairness check on the
                # DECLARED objective: the meta-learner minimizes squared error, so
                # scoring it only on MAE would judge it on a loss it never optimized.
                # The primary declared metric remains MAE; both are reported.
                'mse': mse(yt, bp), 'mean_gain_mse': float(np.mean(sq_gain)),
                'gain_interval_mse_week_clustered': week_cluster_interval(wk, sq_gain),
                'beats_mse': bool(np.mean(sq_gain) > 0)}
        folds.append(entry)
    return {'label': label, 'gate_key': gate_key, 'bins': bins, 'folds': folds}


def family_ablation(P, mask, y, columns, context, seasons, week_keys, families):
    """The plan's named failure criterion: do gains survive dropping whole
    correlated families? Each family is removed entirely and the selector is
    refit from scratch on the reduced expert set."""
    out = []
    for family in families:
        if set(family) >= {'market_only'} and len(family) == 1 and family[0] == 'market_only':
            continue
        keep = [j for j, c in enumerate(columns) if c not in family]
        if len(keep) < 2 or 'market_only' not in [columns[j] for j in keep]:
            continue
        sub = walk_forward(P[:, keep], mask[:, keep], y, [columns[j] for j in keep], context,
            seasons, week_keys, label=f'ablate:{"+".join(family)}')
        seasons_out = [{'test_season': f['test_season'], 'selector_mae': f['selector_mae'],
            'vs_market_gain': f['baselines'].get('market_only', {}).get('mean_gain'),
            'vs_equal_gain': f['baselines'].get('static_equal_weight', {}).get('mean_gain')}
            for f in sub['folds']]
        out.append({'family_removed': family, 'folds': seasons_out})
    return out


def contribution(P, mask, y, columns, context, seasons, week_keys):
    """Per-expert conditional usefulness: the weight each expert receives in
    each fold and each gate bin, plus a leave-one-out refit. 'Never useful' is
    a real, reportable answer -- a weight of zero in every fold and every bin
    is exactly the finding the plan wants surfaced, not a reason to delete the
    expert from the codebase."""
    base = walk_forward(P, mask, y, columns, context, seasons, week_keys, label='contribution_base')
    rows = []
    for j, name in enumerate(columns):
        keep = [k for k in range(len(columns)) if k != j]
        if 'market_only' not in [columns[k] for k in keep]:
            rows.append({'expert': name, 'leave_one_out': 'skipped: removing it would remove the market baseline'})
            continue
        loo = walk_forward(P[:, keep], mask[:, keep], y, [columns[k] for k in keep], context,
            seasons, week_keys, label=f'loo:{name}')
        weights = []
        for f in base['folds']:
            w = f['weights'].get('global')
            weights.append(round(float(w[j]), 5) if w else None)
        deltas = []
        for a, b in zip(base['folds'], loo['folds']):
            deltas.append(round(b['selector_mae'] - a['selector_mae'], 5))  # positive => expert helped
        rows.append({'expert': name, 'weight_by_fold': weights,
            'mae_increase_when_removed_by_fold': deltas,
            'mean_weight': round(float(np.mean([w for w in weights if w is not None])), 5) if any(
                w is not None for w in weights) else None,
            'never_selected': all((w or 0.0) < 1e-4 for w in weights)})
    return {'base': base, 'experts': rows}


# ---------------------------------------------------------------------------
# Declaration -- written to disk BEFORE anything is scored
# ---------------------------------------------------------------------------

def declaration(substrates):
    return {
        'schema': VERSION, 'package': 'F', 'authority': 'research_only',
        'production_changed': False, 'staking_authority': 'none',
        'declared_at': datetime.now(timezone.utc).isoformat(),
        'economic_hypothesis':
            'A regularized selector whose expert weights are CONDITIONAL on situation '
            '(expert disagreement, coverage, week) predicts the market residual with lower '
            'absolute error than (a) taking the market alone, and (b) a static equal-weight '
            'stack of the same experts. Economic relevance is indirect and is NOT claimed here: '
            'a lower residual MAE is a predictive result, not an executable edge, and no ROI '
            'claim is made from it.',
        'scope': {
            'markets': ['NFL spreads (market residual, points)', 'NFL totals (opening-to-closing movement, points)'],
            'sides': 'home/favorite side residual on the council substrate; signed movement on the tree substrate',
            'horizons': 'pregame only; the council substrate mixes open and scheduled horizons as persisted',
            'seasons': '2022-2025, all previously opened and therefore permanently research data'},
        'decision_horizon': 'pregame, at each substrate\'s own persisted evidence cutoff; no in-game rows',
        'baselines_that_must_be_beaten': [
            'market_only (zero residual / no_move) -- the market alone',
            'static_equal_weight -- an unweighted average of every available expert',
            'existing_coordinator (council substrate only) -- the production blend, as a competing expert'],
        'level_1_meta_learner':
            'non-negative ridge with coefficients summing to 1: min_b sum(y - Pb)^2 + alpha*sum(b^2) '
            's.t. b >= 0, sum(b) = 1. Adopted verbatim from '
            'docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md part 2.6.',
        'abstain_is_a_real_option':
            'market_only is a first-class column always available to every row; weight 1.0 on it is '
            'a valid, selectable outcome meaning "trust nothing here, take the market".',
        'split_policy':
            'Chronological walk-forward by SEASON: fit on all earlier seasons, test on the next; the '
            'stacker never sees the season it scores. alpha is chosen on an INNER chronological split '
            'of the training seasons only (fit all but last, validate on last). Gate bin edges are '
            'computed on training rows only. Uncertainty intervals bootstrap over WEEKS, not rows, '
            'because games within a week are dependent. Ordinary row splitting is NOT used anywhere.',
        'gate': {
            'form': 'mixture-of-experts: partition rows by one context variable at training quantiles, '
                    'fit a separate simplex-constrained weight vector per bin',
            'conditioning_variables': ['disagreement (uncertainty)', 'coverage (data availability)', 'week (horizon)'],
            'complexity_sensitivity': 'each gate is run at 2 and 3 bins; a gain that only survives at one '
                                      'bin count is reported as fragile, per the failure criterion'},
        'family_clustering': f'single-linkage union-find on |pearson r| >= {FAMILY_CORRELATION}, computed on '
                             'training rows where both experts are available. Whole families are ablated.',
        'selection_rule':
            'The conditional selector is declared an improvement ONLY if its mean gain over BOTH the '
            'market-only and static-equal-weight baselines is positive AND the week-clustered 95% '
            'interval on that gain excludes zero, on the majority of walk-forward test seasons, AND '
            'the gain survives family ablation and the 2-vs-3-bin complexity change. Any weaker '
            'pattern is reported as a negative result.',
        'failure_criteria': [
            'gains disappear under family ablation',
            'gains disappear on a new (later) season',
            'gains disappear under a small change to gate complexity (2 vs 3 bins)',
            'the selector simply puts weight 1.0 on market_only, i.e. no expert carries conditional '
            'information -- this is a COMPLETE and reportable result, not a failed run'],
        'substrates': substrates,
        'known_limitations': [
            'Package D (role-scenario-lab) persisted only a manifest, no per-row predictions, so its '
            'role-scenario expert is ABSENT from this stack.',
            'Package E (news events) has never been run -- a real run costs LLM API money -- so its '
            'news-impact expert is ABSENT from this stack.',
            'The council substrate is a retrospective backfill (rows written 2026-09-01/02 for 2022-2025 '
            'games), i.e. cutoff-simulated walk-forward, not frozen-at-decision-time. Any council '
            'component whose own artifact was fitted on full history leaks into these rows.',
            'nfl_expert_forward_predictions -- the architecturally correct frozen artifact -- has 672 '
            'rows and ZERO settlements, so it cannot train anything today.',
            'TPOT is excluded as an expert on the tree substrate: its selected pipeline is a different '
            'architecture in each fold, so it has no stable identity for a weight to attach to.',
            'Council expert rows are deduplicated by newest audit_run_id; the same expert_id across '
            'older runs may be a different engine version.',
            'A distributional-drift scan (research/drift.py, `drift_scans` per substrate) runs over the '
            'same season folds walk_forward fits on, scanning each expert\'s prediction distribution and '
            'its coverage rate. It REPORTS ONLY -- no fold is skipped and no expert is dropped because of '
            'what it finds. The earliest fold in each substrate has only one training season and so no '
            'season boundary of its own to calibrate against; its verdicts fall back to the analytic '
            'noise floor and are marked calibration_weak.'],
        'trials_planned': [
            'global simplex-ridge stacker (bins=1)',
            'gate on disagreement at 2 and 3 bins',
            'gate on coverage at 2 and 3 bins',
            'gate on week at 2 and 3 bins',
            'family ablation, one family at a time',
            'leave-one-expert-out contribution',
            'the same on the tree OOF substrate for movement and cover targets'],
        'metric_amendment_after_first_run': (
            'The primary declared metric is and remains MAE. After the first scored run, MSE was ADDED '
            'as a secondary metric because the declared meta-learner minimizes SQUARED error, so judging '
            'it only on MAE would score it on a loss it never optimized. This amendment can only make the '
            'selector look BETTER, not worse, so it cannot be a search for a flattering framing; both '
            'metrics are reported for every fold and both verdicts are stated. The hypothesis, scope, '
            'baselines, split policy and failure criteria are unchanged from the pre-scoring declaration.'),
        'costs': 'no paid feeds, no LLM calls, no wagers; CPU only',
        'artifacts': 'preregistered.json (this file, written before scoring), report.json, latest.json'}


# ---------------------------------------------------------------------------
# Distributional drift (research/drift.py), over exactly walk_forward's own folds
# ---------------------------------------------------------------------------

def expert_drift_scan(P, mask, columns, seasons, week_keys, label_prefix, random_state=SEED):
    """Has the population of expert predictions moved between the seasons a
    fold trains on and the season it scores? Run over the SAME chronological
    season folds `walk_forward` fits on (train on unique[:k], score on
    unique[k]), so the drift verdict describes exactly the comparison the
    selector's own accuracy numbers are made on -- not a re-derived window that
    could quietly drift from it, the same discipline market_lab.py and
    tree_lab.py use for their own drift scans.

    Two kinds of column are scanned side by side, because they answer two
    different questions that neither the selector's MAE nor the leakage scan
    can:

      - `{expert}_prediction` -- has this expert's own FORECAST distribution
        moved? Values are masked to NaN wherever `mask` says the expert did not
        fire that row, so a row where it was simply absent (imputed 0 in `P` by
        `council_matrix`/`load_tree_oof`) never masquerades as a real
        prediction of zero; `detect_distribution_drift`'s own finite-value
        filter then drops exactly those NaNs per column.
      - `{expert}_available` -- has this expert's COVERAGE collapsed? This is
        drift.py's own availability-role naming convention
        (`classify_feature_role`), so a coverage collapse here gets the same
        tightest treatment -- escalated on the rate itself, without waiting for
        PSI -- that a dead upstream feed gets in market_lab/tree_lab. This is
        the failure walk_forward's own accuracy metrics cannot see: an expert
        that rarely fires can still look fine on the rows it does cover while
        silently carrying near-zero weight everywhere else.

    `market_only` is excluded from both: it is a constant zero / always-
    available column by construction (see `council_matrix`), and a drift
    statistic on a constant is not a finding.

    Like every other drift scan in this project, this REPORTS ONLY: no fold is
    skipped and no expert is dropped because of what it finds.
    """
    experts = [c for c in columns if c != 'market_only']
    if not experts:
        return []
    cols = [columns.index(c) for c in experts]
    predictions = np.where(mask[:, cols] > 0, P[:, cols], np.nan)
    availability = mask[:, cols]
    X = np.column_stack([predictions, availability])
    names = [f'{c}_prediction' for c in experts] + [f'{c}_available' for c in experts]

    seasons_arr = np.asarray(seasons)
    unique = sorted({int(s) for s in seasons})
    scans = []
    for k in range(1, len(unique)):
        train_seasons, test_season = unique[:k], unique[k]
        tr = np.flatnonzero(np.isin(seasons_arr, train_seasons))
        te = np.flatnonzero(seasons_arr == test_season)
        # Same minimum fold size walk_forward itself requires before it fits
        # anything, so a drift scan is never reported for a season the selector
        # did not actually fit or score.
        if len(tr) < 60 or len(te) < 20:
            continue
        # `week_keys` entries are (season, week) TUPLES. joint_drift_classifier
        # builds its group array with np.asarray(groups, dtype=object), and
        # numpy silently collapses a list of same-length tuples into a 2D
        # array rather than an array of tuple objects -- np.unique then
        # operates element-wise across season and week instead of grouping by
        # game-week, which is exactly the row-independence bug OOF-1's group
        # unit rule exists to prevent. Stringifying each key first is the same
        # fix market_lab.py and tree_lab.py already use for their own drift
        # scans (f'{season}-{week}').
        group_key = lambda i: f'{week_keys[i][0]}-{week_keys[i][1]}'
        report = detect_distribution_drift(
            X[tr], X[te], names,
            train_seasons=seasons_arr[tr], score_season=int(test_season),
            train_groups=[group_key(i) for i in tr], score_groups=[group_key(i) for i in te],
            random_state=random_state, label=f'{label_prefix}/{test_season}')
        report['market'] = label_prefix
        scans.append(report)
    return scans


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_substrate(name, P, mask, y, columns, context, seasons, week_keys, guarantee, errors):
    result = {'substrate': name, 'guarantee': guarantee, 'rows': int(len(y)),
        'experts': columns, 'expert_count': len(columns),
        'seasons': sorted(int(s) for s in set(seasons))}
    train_mask = np.array([s != max(set(seasons)) for s in seasons])
    families, pairs = cluster_families(P[train_mask], mask[train_mask], columns)
    result['families'] = families
    result['top_correlations'] = pairs[:25]
    # Reported at the production coordinator's own threshold too, so the choice
    # of 0.90 here is visible as a choice rather than an unexamined default.
    loose, _ = cluster_families(P[train_mask], mask[train_mask], columns, threshold=0.6)
    result['families_at_coordinator_threshold_0_60'] = loose
    result['family_note'] = (
        f'{len(columns)} experts collapse to {len(families)} families at |r| >= {FAMILY_CORRELATION}, '
        f'and to {len(loose)} families at the production coordinator\'s own |r| >= 0.60 '
        f'(nfl-expert-coordinator.js FAMILY_CORRELATION). Correlations computed on training seasons only. '
        f'Where the strict threshold leaves every expert a singleton, family ablation below is '
        f'equivalent to leave-one-expert-out and is reported as such rather than as a stronger test.')

    trials = []
    try:
        trials.append(walk_forward(P, mask, y, columns, context, seasons, week_keys, label='global'))
    except Exception as e:
        errors.append(f'{name}/global failed: {type(e).__name__}: {str(e)[:200]}')
    for gate_key in ('disagreement', 'coverage', 'week'):
        for bins in (2, 3):
            try:
                trials.append(walk_forward(P, mask, y, columns, context, seasons, week_keys,
                    gate_key=gate_key, bins=bins, label=f'gate:{gate_key}:{bins}'))
            except Exception as e:
                errors.append(f'{name}/gate {gate_key} {bins} failed: {type(e).__name__}: {str(e)[:200]}')
    result['trials'] = trials

    try:
        result['family_ablation'] = family_ablation(P, mask, y, columns, context, seasons, week_keys, families)
    except Exception as e:
        errors.append(f'{name}/ablation failed: {type(e).__name__}: {str(e)[:200]}')
        result['family_ablation'] = None
    try:
        result['contribution'] = contribution(P, mask, y, columns, context, seasons, week_keys)
    except Exception as e:
        errors.append(f'{name}/contribution failed: {type(e).__name__}: {str(e)[:200]}')
        result['contribution'] = None
    result['verdict'] = verdict_for(result)
    try:
        result['drift_scans'] = expert_drift_scan(P, mask, columns, seasons, week_keys, name)
    except Exception as e:
        errors.append(f'{name}/drift scan failed: {type(e).__name__}: {str(e)[:200]}')
        result['drift_scans'] = []
    return result


def verdict_for(result):
    """Apply the PRE-DECLARED selection rule mechanically. No post-hoc framing:
    the rule was written to preregistered.json before any of this was scored."""
    trials = result.get('trials') or []

    def passing_for(gain_key, interval_key):
        out = []
        for trial in trials:
            folds = trial['folds']
            if not folds:
                continue
            ok = []
            for f in folds:
                m = f['baselines'].get('market_only'); e = f['baselines'].get('static_equal_weight')
                if not m or not e:
                    ok.append(False); continue
                mi = m.get(interval_key); ei = e.get(interval_key)
                ok.append(bool(m[gain_key] > 0 and e[gain_key] > 0
                    and mi and mi[0] > 0 and ei and ei[0] > 0))
            if sum(ok) > len(ok) / 2:
                out.append(trial['label'])
        return out

    passing = passing_for('mean_gain', 'gain_interval_week_clustered')
    passing_mse = passing_for('mean_gain_mse', 'gain_interval_mse_week_clustered')

    # Where the selector is SIGNIFICANTLY WORSE than simply taking the market,
    # that is a finding in its own right and is surfaced, not just omitted.
    harmed = []
    for trial in trials:
        for f in trial['folds']:
            m = f['baselines'].get('market_only') or {}
            ci = m.get('gain_interval_week_clustered')
            if ci and ci[1] < 0:
                harmed.append({'trial': trial['label'], 'test_season': f['test_season'],
                    'mean_gain_vs_market': round(m['mean_gain'], 4), 'interval': ci})
    return {
        'trials_meeting_declared_rule': passing,
        'any_trial_passed': bool(passing),
        'trials_meeting_rule_on_secondary_mse_metric': passing_mse,
        'significantly_worse_than_market': harmed,
        'statement': ('No configuration met the pre-declared bar (positive mean gain over BOTH baselines '
                      'with a week-clustered 95% interval excluding zero, on a majority of walk-forward '
                      'test seasons). Per the declaration, this is a complete result.') if not passing else
                     (f'Configurations meeting the pre-declared bar: {", ".join(passing)}. '
                      'Ablation and gate-complexity sensitivity below decide whether this survives.')}


def run(args):
    started = time.time()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + code_hash[:8]
    run_dir = out / run_id; run_dir.mkdir(parents=True, exist_ok=True)
    errors = []

    games, council_names, runs = load_council(args.db)
    tree = load_tree_oof(args.oof_dir, 'move') if args.oof_dir else None

    substrate_summary = {
        'council': {'source': 'nfl_weekly_expert_examples', 'games': len(games),
            'experts': council_names, 'audit_run_row_counts': {str(k): v for k, v in sorted(runs.items())},
            'guarantee': 'RETROSPECTIVE BACKFILL: cutoff-simulated walk-forward, not frozen at decision '
                         'time. Rows written 2026-09-01/02 for 2022-2025 games.'},
        'tree': {'source': 'research/tree_lab.py emit_oof (this session)',
            'markets': sorted(tree) if tree else [],
            'guarantee': 'Each expert fit on seasons strictly earlier than the season it predicts, with a '
                         'seven-day settled-label cutoff. No model scored on its own training rows.'
                         if tree else 'NOT AVAILABLE: no OOF files found'}}

    # ---- declaration to disk BEFORE any scoring ----
    decl = declaration(substrate_summary)
    atomic_json(run_dir / 'preregistered.json', decl)
    declaration_written_at = datetime.now(timezone.utc).isoformat()

    results = []
    P, mask, y, columns, context = council_matrix(games, council_names)
    seasons = [g['season'] for g in games]
    week_keys = [(g['season'], g['week']) for g in games]
    results.append(run_substrate('council', P, mask, y, columns, context, seasons, week_keys,
        substrate_summary['council']['guarantee'], errors))

    if tree:
        for market, bundle in sorted(tree.items()):
            s = [r['season'] for r in bundle['rows']]
            wk = [(r['season'], r['week']) for r in bundle['rows']]
            results.append(run_substrate(f'tree:{market}:move', bundle['P'], bundle['mask'], bundle['y'],
                bundle['columns'], bundle['context'], s, wk,
                substrate_summary['tree']['guarantee'], errors))

    report = {'schema': VERSION, 'run_id': run_id, 'status': 'complete', 'package': 'F',
        'authority': 'research_only', 'production_changed': False, 'staking_authority': 'none',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'declaration_written_at': declaration_written_at,
        'code_hash': code_hash, 'declaration': decl, 'substrates': substrate_summary,
        'results': results, 'errors': errors,
        'wall_clock_seconds': round(time.time() - started, 1)}
    report['dataset_hash'] = digest([substrate_summary, len(games)])
    atomic_json(run_dir / 'report.json', report)
    atomic_json(out / 'latest.json', report)
    print(json.dumps({'run_id': run_id, 'games': len(games), 'substrates': [r['substrate'] for r in results],
        'errors': errors, 'seconds': report['wall_clock_seconds'],
        'verdicts': {r['substrate']: r['verdict']['any_trial_passed'] for r in results}}, indent=2))
    return report


def main():
    ap = argparse.ArgumentParser(description='Package F: conditional expert selector (research only)')
    ap.add_argument('--db', required=True)
    ap.add_argument('--oof-dir', default=None, help='directory holding tree_lab *-oof.json files')
    ap.add_argument('--output', required=True)
    run(ap.parse_args())


if __name__ == '__main__':
    main()
