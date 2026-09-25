#!/usr/bin/env python3
"""ML-TESTBENCH section A: acceptance models, P(yes), prequential (docs/tdd/ML-TESTBENCH-PREREG.md).

Input: a_export_offers.mjs's JSON (arms 1-4 already computed as of each offer by the production
modules) and the DB copy (features). Adds arm 5 (hierarchical Bayesian logistic, Laplace, tau grid
averaged by evidence) and arm 6 (heavily regularised LightGBM), each refit before every offer on
offers RESOLVED strictly before it was PROPOSED. Scores all six.

Usage: python a_acceptance.py --offers a-offers.json --db <copy.sqlite> --out a-results.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.optimize import minimize

sys.path.insert(0, __import__('os').path.dirname(__file__))
from tb_common import (SEED, auc, boot_indices, brier_each, ci, clip, log_loss_each, murphy,  # noqa: E402
                       n_for_power, open_copy, r, verdict)

ARMS = ['base', 'baseline', 'clone', 'blend', 'hier_bayes', 'lgbm']
LABEL = {'base': '1 base rate', 'baseline': '2 activity baseline', 'clone': '3 clone (trade-acceptance band mid)',
         'blend': '4 live blend (as served)', 'hier_bayes': '5 hierarchical Bayes logistic (new)',
         'lgbm': '6 LightGBM, regularised (new)'}
REF = {'baseline': 'base', 'clone': 'baseline', 'blend': 'baseline', 'hier_bayes': 'baseline', 'lgbm': 'baseline'}
FEATURES = ['value_gap', 'need_fit', 'package_size', 'activity']
TAUS = (0.25, 0.5, 1.0)
A_SD, B_SD = 1.5, 1.0


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None


# ---------------------------------------------------------------- features
class FeatureSource:
    def __init__(self, con):
        fmt = {str(i): ('rd_sf1_t8_ppr1' if int(tc) == 8 else 'rd_sf1_t10_ppr1')
               for i, tc in con.execute('SELECT id, team_count FROM leagues')}
        self.fmt = fmt
        self.value = defaultdict(dict)
        for f, e, v in con.execute("""SELECT d.format_key, p.espn_id, d.value FROM dynasty_values d
                                      JOIN players p ON p.id = d.player_id
                                      WHERE p.espn_id IS NOT NULL AND d.retired_at IS NULL"""):
            self.value[f][int(e)] = float(v or 0)
        self.pos = {int(e): p for e, p in con.execute('SELECT espn_id, position FROM players WHERE espn_id IS NOT NULL')}
        for e, p in con.execute('SELECT DISTINCT espn_player_id, position FROM league_roster_snapshots'):
            self.pos.setdefault(int(e), p)
        # week w has started once its first game day's late-evening kickoff (UTC next day 00:15) passed
        self.week_start = {}
        for w, d in con.execute('SELECT week, MIN(date) FROM schedule_games WHERE season = 2026 GROUP BY week'):
            self.week_start[int(w)] = datetime.fromisoformat(d).replace(tzinfo=timezone.utc) + timedelta(hours=24, minutes=15)
        self.rosters = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # (league, period) -> team -> pos -> n
        for lg, per, team, pos in con.execute("""SELECT league_id, scoring_period_id, team_id, position
                                                FROM league_roster_snapshots WHERE season = 2026 AND on_roster = 1"""):
            self.rosters[(str(lg), int(per))][str(team)][pos] += 1
        self.periods = defaultdict(list)
        for lg, per in self.rosters:
            self.periods[lg].append(per)
        self.proposals = defaultdict(list)  # league -> [(time, {teams})]
        for lg, tid, at, items in con.execute("""SELECT league_id, team_id, proposed_at, items_json FROM league_transactions_raw
                                                WHERE type = 'TRADE_PROPOSAL' AND execution_type = 'EXECUTE'"""):
            teams = {str(tid)}
            try:
                for i in json.loads(items or '[]'):
                    for k in ('fromTeamId', 'toTeamId'):
                        if i.get(k) is not None and int(i[k]) > 0:
                            teams.add(str(int(i[k])))
            except (ValueError, TypeError):
                pass
            if at:
                self.proposals[str(lg)].append((ts(at), teams))

    def period_for(self, league, when):
        started = [w for w, s in self.week_start.items() if s <= when]
        want = max(started) if started else 1
        have = sorted(self.periods.get(league, []))
        le = [p for p in have if p <= want]
        return (le[-1] if le else (have[0] if have else None)), not started

    def row(self, o):
        lg, resp, when = o['league_id'], o['counterparty_team_id'], ts(o['proposed_at'])
        items = o.get('items') or []
        flags = []
        if not items:
            flags.append('no_terms')
            gap, need, size = 0.0, 0.0, math.log(2)
        else:
            vals = self.value.get(self.fmt.get(lg, 'rd_sf1_t10_ppr1'), {})
            recv = sum(vals.get(i['playerId'], 0.0) for i in items if str(i['toTeamId']) == resp)
            give = sum(vals.get(i['playerId'], 0.0) for i in items if str(i['fromTeamId']) == resp)
            gap = (recv - give) / 1000.0
            size = math.log(len(items))
            per, preseason = self.period_for(lg, when)
            if preseason:
                flags.append('preseason_roster_week1')
            need = 0.0
            if per is not None:
                teams = self.rosters[(lg, per)]
                got = [self.pos.get(i['playerId']) for i in items if str(i['toTeamId']) == resp]
                got = [g for g in got if g]
                if got and teams:
                    diffs = []
                    for g in got:
                        mean = np.mean([t.get(g, 0) for t in teams.values()])
                        diffs.append(mean - teams.get(resp, {}).get(g, 0))
                    need = float(np.mean(diffs))
        act = sum(1 for at, teams in self.proposals.get(lg, []) if at < when and resp in teams)
        return [gap, need, size, math.log1p(act)], flags


# ---------------------------------------------------------------- arm 5: hierarchical Bayes (Laplace)
def _design(X, groups_l, groups_m, lev_l, lev_m):
    n = len(X)
    Z = np.zeros((n, 1 + X.shape[1] + len(lev_l) + len(lev_m)))
    Z[:, 0] = 1
    Z[:, 1:1 + X.shape[1]] = X
    off = 1 + X.shape[1]
    for i, (gl, gm) in enumerate(zip(groups_l, groups_m)):
        if gl in lev_l:
            Z[i, off + lev_l[gl]] = 1
        if gm in lev_m:
            Z[i, off + len(lev_l) + lev_m[gm]] = 1
    return Z


def _laplace_fit(Z, y, prior_sd):
    prec = 1.0 / prior_sd ** 2

    def f(th):
        eta = Z @ th
        ll = np.sum(y * eta - np.logaddexp(0, eta))
        return -(ll - 0.5 * np.sum(prec * th ** 2))

    def g(th):
        p = 1 / (1 + np.exp(-(Z @ th)))
        return -(Z.T @ (y - p) - prec * th)

    res = minimize(f, np.zeros(Z.shape[1]), jac=g, method='L-BFGS-B')
    th = res.x
    p = 1 / (1 + np.exp(-(Z @ th)))
    H = (Z * (p * (1 - p))[:, None]).T @ Z + np.diag(prec)
    sign, logdet = np.linalg.slogdet(H)
    # log evidence ~ log lik + log prior at the mode + d/2 log 2pi - 1/2 log|H|
    log_prior = -0.5 * np.sum(prec * th ** 2) - 0.5 * np.sum(np.log(2 * np.pi * prior_sd ** 2))
    ev = -f(th) + 0.5 * np.sum(prec * th ** 2) + log_prior + 0.5 * len(th) * np.log(2 * np.pi) - 0.5 * logdet
    return th, np.linalg.inv(H), float(ev)


def hier_predict(Xtr, ytr, gl_tr, gm_tr, x, gl, gm):
    lev_l = {g: i for i, g in enumerate(sorted(set(gl_tr)))}
    lev_m = {g: i for i, g in enumerate(sorted(set(gm_tr)))}
    k = Xtr.shape[1] if len(Xtr) else len(x)
    Ztr = _design(Xtr.reshape(-1, k), gl_tr, gm_tr, lev_l, lev_m)
    z = _design(np.asarray([x]), [gl], [gm], lev_l, lev_m)[0]
    ps, evs = [], []
    for tau in TAUS:
        prior_sd = np.concatenate([[A_SD], np.full(k, B_SD), np.full(len(lev_l) + len(lev_m), tau)])
        th, cov, ev = _laplace_fit(Ztr, np.asarray(ytr, float), prior_sd)
        mu = float(z @ th)
        s2 = float(z @ cov @ z) + (tau ** 2 if gl not in lev_l else 0) + (tau ** 2 if gm not in lev_m else 0)
        ps.append(1 / (1 + math.exp(-mu / math.sqrt(1 + math.pi * s2 / 8))))
        evs.append(ev)
    w = np.exp(np.asarray(evs) - max(evs))
    w /= w.sum()
    return float(np.dot(w, ps)), dict(zip([str(t) for t in TAUS], [round(float(v), 3) for v in w]))


# ---------------------------------------------------------------- arm 6: LightGBM
def lgbm_predict(Xtr, ytr, x, fallback):
    ytr = np.asarray(ytr)
    if len(ytr) < 10 or len(set(ytr.tolist())) < 2:
        return fallback, True
    import lightgbm as lgb
    m = lgb.LGBMClassifier(objective='binary', n_estimators=50, learning_rate=0.05, num_leaves=3, max_depth=2,
                           min_child_samples=5, reg_lambda=10, min_split_gain=0, subsample=1.0,
                           random_state=SEED, n_jobs=1, verbose=-1)
    m.fit(Xtr, ytr)
    return float(m.predict_proba(np.asarray([x]))[0, 1]), False


# ---------------------------------------------------------------- prequential run
def run_set(offers, fs):
    feats, flags = zip(*[fs.row(o) for o in offers]) if offers else ([], [])
    F = np.asarray(feats, float)
    y = np.asarray([o['y'] for o in offers], int)
    prop = [ts(o['proposed_at']) for o in offers]
    resv = [ts(o['resolved_at']) or ts(o['proposed_at']) for o in offers]
    gl = [o['league_id'] for o in offers]
    gm = [f"{o['league_id']}:{o['counterparty_team_id']}" for o in offers]
    P = {a: np.asarray([o['p'][a] for o in offers], float) for a in ('base', 'baseline', 'clone', 'blend')}
    P['hier_bayes'] = np.zeros(len(offers))
    P['lgbm'] = np.zeros(len(offers))
    fallbacks, tau_w = 0, []
    for i in range(len(offers)):
        tr = [j for j in range(len(offers)) if j != i and resv[j] < prop[i]]
        Xtr = F[tr] if tr else np.zeros((0, F.shape[1]))
        mu = Xtr.mean(0) if len(tr) >= 2 else np.zeros(F.shape[1])
        sd = Xtr.std(0) if len(tr) >= 2 else np.ones(F.shape[1])
        sd = np.where(sd > 1e-9, sd, 1.0)
        S = lambda A: (A - mu) / sd  # noqa: E731
        p5, w = hier_predict(S(Xtr), y[tr], [gl[j] for j in tr], [gm[j] for j in tr], S(F[i]), gl[i], gm[i])
        P['hier_bayes'][i] = p5
        tau_w.append(w)
        p6, fb = lgbm_predict(S(Xtr), y[tr], S(F[i]), P['base'][i])
        P['lgbm'][i] = p6
        fallbacks += fb
    return F, y, gm, P, list(flags), fallbacks, tau_w


def score(y, P, clusters):
    n = len(y)
    iid = boot_indices(n)
    clu = boot_indices(n, clusters)
    ll = {a: log_loss_each(P[a], y) for a in ARMS}
    br = {a: brier_each(clip(P[a]), y) for a in ARMS}
    enough_auc = y.sum() >= 5 and (n - y.sum()) >= 5
    out = {}
    for a in ARMS:
        m = murphy(clip(P[a]), y)
        row = {'label': LABEL[a], 'log_loss': r(ll[a].mean()), 'log_loss_ci': r(ci(np.mean, iid, ll[a])),
               'brier': r(br[a].mean()), 'brier_ci': r(ci(np.mean, iid, br[a])),
               'reliability': r(m['reliability']), 'resolution': r(m['resolution']), 'uncertainty': r(m['uncertainty']),
               'calibration_bins': m['bins'], 'mean_p': r(float(np.mean(P[a])))}
        if enough_auc:
            row['auc'] = r(auc(P[a], y))
            row['auc_ci'] = r(ci(lambda p, yy: auc(p, yy), iid, P[a], y))
        if a in REF:
            d = ll[a] - ll[REF[a]]
            lo, hi = ci(np.mean, iid, d)
            clo, chi = ci(np.mean, clu, d)
            row.update({'vs': REF[a], 'log_loss_diff': r(d.mean()), 'diff_ci': r([lo, hi]),
                        'diff_ci_manager_clustered': r([clo, chi]), 'verdict': verdict(lo, hi),
                        'offers_needed_80pct_power': n_for_power(d.mean(), d.std(ddof=1)),
                        'brier_diff': r((br[a] - br[REF[a]]).mean()),
                        'brier_diff_ci': r(ci(np.mean, iid, br[a] - br[REF[a]]))})
        out[a] = row
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--offers', required=True)
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    data = json.load(open(a.offers))
    con = open_copy(a.db)
    fs = FeatureSource(con)
    result = {'summary': data['summary']}
    for name in ('primary', 'sensitivity'):
        offers = data[name]
        F, y, gm, P, flags, fb, tau_w = run_set(offers, fs)
        res = {'n': len(y), 'accepted': int(y.sum()), 'managers': len(set(gm)),
               'leagues': len(set(o['league_id'] for o in offers)),
               'lgbm_fallback_to_base': fb,
               'feature_flags': {k: sum(k in f for f in flags) for k in ('no_terms', 'preseason_roster_week1')},
               'feature_means': dict(zip(FEATURES, r(F.mean(0).tolist()))),
               'value_gap_nonzero': int((F[:, 0] != 0).sum()),
               'hier_tau_weight_last': tau_w[-1] if tau_w else None,
               'arms': score(y, P, gm)}
        # univariate check of the value-gap feature on the full set (descriptive, not prequential)
        res['descriptive_accept_rate_by_value_gap_sign'] = {
            'gap>0': [int(((F[:, 0] > 0) & (y == 1)).sum()), int((F[:, 0] > 0).sum())],
            'gap<=0': [int(((F[:, 0] <= 0) & (y == 1)).sum()), int((F[:, 0] <= 0).sum())]}
        result[name] = res
        print(json.dumps({name: {k: (v['log_loss'], v['log_loss_ci'], v.get('verdict')) for k, v in res['arms'].items()}}), flush=True)
    json.dump(result, open(a.out, 'w'), indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
