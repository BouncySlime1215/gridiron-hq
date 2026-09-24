#!/usr/bin/env python3
"""CLONE-01a population layer: waiver-choice conditional logit + MOTIVE-01, on Sleeper.

Pre-registered in docs/evidence/2026-09-23/clone-01-preregistration.md (committed first).

Fit seasons 2021-2023, graded season 2024. 2025 is never opened: every league query
filters season BETWEEN 2021 AND 2024. Prints AGGREGATES ONLY (no league, manager or
player identifiers), as JSON on stdout.

Inputs are local copies, never the live files:
  --sleeper  a sqlite3 .backup copy of data/derived/sleeper_history.sqlite
  --app      a sqlite3 .backup copy of the app DB (players.sleeper_id -> gsis_id and
             nfl_ffopportunity_weekly for per-player weekly points)

  python3 scripts/rnd/fit-clone-population.py --sleeper .local-db/sleeper.sqlite \
      --app .local-db/data.sqlite [--fit-events 6000] [--boot 1000]
"""
import argparse, json, sqlite3, sys, math, random
from collections import defaultdict
import numpy as np

FIT_SEASONS = (2021, 2022, 2023)
GRADE_SEASON = 2024
SKILL = ('QB', 'RB', 'WR', 'TE')
SEED = 20260923
MOTIVE = dict(seller_odds=0.03, seller_min_games=3, desperate_out=2, bye_crunch=2, buyer_multiple=1.5)

BASE = ['ppg', 'nogames', 'last', 'xfp', 'gshare', 'need', 'plays_next', 'is_rb', 'is_wr', 'is_te']
M1 = BASE + ['streak_x_last', 'byecrunch_x_plays']
STATES = ('seller', 'desperate_buyer', 'buyer')
M2 = M1 + [f'{s}_x_{f}' for s in STATES for f in ('ppg', 'last', 'plays_next')]
B0 = ['ppg']


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------- player data
def load_players(app):
    c = sqlite3.connect(f'file:{app}?mode=ro', uri=True)
    smap = {s: g for s, g in c.execute(
        'SELECT sleeper_id, gsis_id FROM players WHERE sleeper_id IS NOT NULL AND gsis_id IS NOT NULL')}
    weekly = defaultdict(dict)   # season -> gsis -> {week: (pts, xfp, team)}
    pos = {}
    teams_played = defaultdict(set)  # season -> {(team, week)}
    for season, week, g, team, p, xfp, act in c.execute(
            'SELECT season, week, player_gsis_id, team, position, expected_fantasy_points, actual_fantasy_points '
            'FROM nfl_ffopportunity_weekly WHERE season BETWEEN 2020 AND 2024'):
        if p not in SKILL:
            continue
        pos[g] = p
        weekly[season].setdefault(g, {})[week] = (act or 0.0, xfp or 0.0, team)
        teams_played[season].add((team, week))
    return smap, weekly, pos, teams_played


class SeasonIndex:
    """As-of player features for one season, weeks <= w only."""

    def __init__(self, season, weekly, pos, teams_played, smap):
        self.season = season
        self.w = weekly.get(season, {})
        self.prior = weekly.get(season - 1, {})
        self.played = teams_played.get(season, set())
        self.pos = pos
        self.sleeper_of = {g: s for s, g in smap.items()}
        self.cache = {}

    def team_asof(self, g, w):
        rec = self.w.get(g, {})
        ks = [k for k in rec if k <= w]
        if ks:
            return rec[max(ks)][2]
        pr = self.prior.get(g, {})
        return pr[max(pr)][2] if pr else None

    def eligible(self, w):
        """Skill players with a game this season through w, or last season."""
        if ('elig', w) in self.cache:
            return self.cache[('elig', w)]
        out = []
        for g in set(self.w) | set(self.prior):
            if g not in self.sleeper_of or self.pos.get(g) not in SKILL:
                continue
            if any(k <= w for k in self.w.get(g, {})) or g in self.prior:
                out.append(g)
        self.cache[('elig', w)] = out
        return out

    def feats(self, g, w):
        key = (g, w)
        if key in self.cache:
            return self.cache[key]
        rec = self.w.get(g, {})
        games = [rec[k][0] for k in rec if k <= w]
        if games:
            ppg, nog = sum(games) / len(games), 0.0
        else:
            pr = self.prior.get(g, {})
            ppg, nog = (sum(v[0] for v in pr.values()) / len(pr) if pr else 0.0), 1.0
        last = rec[w][0] if w in rec else 0.0
        xs = [rec[k][1] for k in (w - 1, w) if k in rec]
        xfp = sum(xs) / len(xs) if xs else 0.0
        team = self.team_asof(g, w)
        plays_next = 1.0 if team is not None and (team, w + 1) in self.played else 0.0
        p = self.pos.get(g)
        v = (ppg / 10, nog, last / 10, xfp / 10, len(games) / max(1, w), 0.0, plays_next,
             float(p == 'RB'), float(p == 'WR'), float(p == 'TE'))
        self.cache[key] = v
        return v

    def dead(self, g, w):
        """Did not play in week w while his team did."""
        team = self.team_asof(g, w)
        return team is not None and (team, w) in self.played and w not in self.w.get(g, {})

    def on_bye(self, g, w):
        team = self.team_asof(g, w)
        return team is not None and (team, w) not in self.played


# ----------------------------------------------------------------- league data
def league_rows(sc, season):
    return sc.execute('SELECT league_id, num_teams FROM sh_leagues WHERE season = ? AND season BETWEEN 2021 AND 2024',
                      (season,)).fetchall()


def team_weeks(sc, lid):
    out = defaultdict(dict)
    for rid, wk, pts, opp, st, pl in sc.execute(
            'SELECT roster_id, week, points, opponent_roster_id, starters_json, players_json '
            'FROM sh_team_weeks WHERE league_id = ?', (lid,)):
        out[rid][wk] = (pts or 0.0, opp, json.loads(st or '[]'), json.loads(pl or '[]'))
    return out


def standings(tw, rid, w):
    """Wins, games, loss streak and points-for through week w."""
    wins = games = streak = 0
    pf = 0.0
    for wk in sorted(k for k in tw[rid] if k <= w):
        pts, opp, _, _ = tw[rid][wk]
        if opp is None or opp not in tw or wk not in tw[opp]:
            continue
        o = tw[opp][wk][0]
        if pts == 0 and o == 0:
            continue
        games += 1
        pf += pts
        if pts > o:
            wins += 1
            streak = 0
        elif pts < o:
            streak += 1
        else:
            streak = 0
    return wins, games, streak, pf


def odds_feats(tw, w):
    """Per roster: (win share, games/14, pf z within league) through w."""
    st = {rid: standings(tw, rid, w) for rid in tw}
    pfs = [s[3] / max(1, s[1]) for s in st.values()]
    mu = sum(pfs) / len(pfs)
    sd = (sum((x - mu) ** 2 for x in pfs) / len(pfs)) ** 0.5 or 1.0
    return {rid: (s[0] / max(1, s[1]), s[1] / 14, (s[3] / max(1, s[1]) - mu) / sd, s[1], s[2])
            for rid, s in st.items()}


# ----------------------------------------------------------------- logistic (title odds)
def fit_logistic(X, y, iters=25):
    X = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ b))
        g = X.T @ (y - p)
        H = (X * (p * (1 - p))[:, None]).T @ X + 1e-6 * np.eye(len(b))
        b += np.linalg.solve(H, g)
    return b


def logistic_p(b, x):
    z = b[0] + sum(bi * xi for bi, xi in zip(b[1:], x))
    return 1 / (1 + math.exp(-z))


def odds_design(f, nt):
    ws, gs, pz = f[0], f[1], f[2]
    return (ws, gs, pz, ws * gs, pz * gs, math.log(nt))


def motive_state(odds, games, out, bye, nt):
    if odds < MOTIVE['seller_odds'] and games >= MOTIVE['seller_min_games']:
        return 'seller'
    if out >= MOTIVE['desperate_out'] and bye >= MOTIVE['bye_crunch']:
        return 'desperate_buyer'
    if odds >= MOTIVE['buyer_multiple'] / nt:
        return 'buyer'
    return 'hold'


# ----------------------------------------------------------------- events
POS_CODE = {p: i for i, p in enumerate(SKILL)}


def season_events(sc, season, idx, smap, odds_b, keep=1.0, rng=None):
    """Yields (cluster, chosen_index, X[M2 columns], info) per waiver claim.
    `keep` < 1 samples claims (seeded) BEFORE any matrix is built."""
    for lid, nt in league_rows(sc, season):
        claims = defaultdict(list)
        for wk, adds in sc.execute(
                "SELECT week, adds_json FROM sh_transactions WHERE league_id = ? "
                "AND type = 'waiver' AND status = 'complete' ORDER BY week, seq", (lid,)):
            a = json.loads(adds or '{}')
            if len(a) != 1 or not (1 <= wk <= 16):
                continue
            (sid, rid), = a.items()
            g = smap.get(sid)
            if g is None or idx.pos.get(g) not in SKILL:
                continue
            if keep < 1.0 and rng.random() >= keep:
                continue
            claims[wk].append((rid, g))
        if not claims:
            continue
        tw = team_weeks(sc, lid)
        if not tw:
            continue
        for w, evs in sorted(claims.items()):
            rostered = set()
            for rid in tw:
                if w in tw[rid]:
                    rostered.update(smap.get(s) for s in tw[rid][w][3])
            of = odds_feats(tw, w)
            base_pool = [g for g in idx.eligible(w) if g not in rostered]
            base_B = np.array([idx.feats(g, w) for g in base_pool], dtype=np.float32).reshape(-1, len(BASE))
            base_pc = np.array([POS_CODE[idx.pos[g]] for g in base_pool], dtype=np.int64)
            where = {g: i for i, g in enumerate(base_pool)}
            for rid, g in evs:
                if rid not in tw or w not in tw[rid] or rid not in of:
                    continue
                if g in where:
                    B, pc, ch = base_B, base_pc, where[g]
                else:
                    B = np.vstack([base_B, np.array([idx.feats(g, w)], dtype=np.float32)])
                    pc = np.append(base_pc, POS_CODE[idx.pos[g]])
                    ch = len(base_pool)
                _, _, starters, players = tw[rid][w]
                have = np.zeros(len(SKILL))
                for s in players:
                    gg = smap.get(s)
                    if gg and idx.pos.get(gg) in SKILL:
                        have[POS_CODE[idx.pos[gg]]] += 1
                sg = [smap.get(s) for s in starters if smap.get(s) and idx.pos.get(smap.get(s)) in SKILL]
                out = sum(1 for x in sg if idx.dead(x, w))
                bye = sum(1 for x in sg if idx.on_bye(x, w + 1))
                f = of[rid]
                odds = logistic_p(odds_b, odds_design(f, nt))
                state = motive_state(odds, f[3], out, bye, nt)
                streak = f[4]
                X = np.zeros((len(B), len(M2)), dtype=np.float32)
                X[:, :len(BASE)] = B
                X[:, 5] = 1.0 / (1 + have[pc])
                X[:, len(BASE)] = min(streak, 4) / 4 * B[:, 2]
                X[:, len(BASE) + 1] = min(bye, 3) / 3 * B[:, 6]
                if state in STATES:
                    j = len(M1) + 3 * STATES.index(state)
                    X[:, j], X[:, j + 1], X[:, j + 2] = B[:, 0], B[:, 2], B[:, 6]
                yield (f'{lid}:{rid}', ch, X, dict(state=state, odds=odds, games=f[3],
                                                   wins=round(f[0] * f[3]), out=out, bye=bye))


# ----------------------------------------------------------------- conditional logit
def cols(names):
    return [M2.index(n) for n in names]


def _clogit_eval(events, ci, b, ridge, derivs=True):
    k = len(ci)
    g = np.zeros(k)
    H = np.zeros((k, k))
    ll = 0.0
    for ch, X in events:
        Z = X[:, ci].astype(np.float64)
        u = Z @ b
        u -= u.max()
        e = np.exp(u)
        se = e.sum()
        ll += u[ch] - math.log(se)
        if derivs:
            p = e / se
            mz = p @ Z
            g += Z[ch] - mz
            H -= (Z * p[:, None]).T @ Z - np.outer(mz, mz)
    ll -= 0.5 * ridge * float(b @ b)
    return ll, g - ridge * b, H - ridge * np.eye(k)


def fit_clogit(events, names, iters=40, ridge=1e-3):
    """Damped Newton on the conditional-logit log likelihood (step halving)."""
    ci = cols(names)
    b = np.zeros(len(ci))
    ll, g, H = _clogit_eval(events, ci, b, ridge)
    for _ in range(iters):
        step = np.linalg.solve(H, g)
        t = 1.0
        while t > 1e-4:
            nb = b - t * step
            nll = _clogit_eval(events, ci, nb, ridge, derivs=False)[0]
            if nll >= ll:
                break
            t /= 2
        if t <= 1e-4:
            break
        b = nb
        conv = abs(nll - ll) < 1e-7 * len(events)
        ll, g, H = _clogit_eval(events, ci, b, ridge)
        if conv:
            break
    return b, ll / len(events)


def event_ll(b, names, ch, X):
    Z = X[:, cols(names)].astype(np.float64)
    u = Z @ b
    u -= u.max()
    lp = u - math.log(np.exp(u).sum())
    return -lp[ch], int(np.argmax(u) == ch)


def cluster_ci(cl, d, reps, seed):
    """90% CI of sum(d)/n by resampling clusters."""
    by = defaultdict(lambda: [0.0, 0])
    for c, x in zip(cl, d):
        by[c][0] += x
        by[c][1] += 1
    arr = np.array(list(by.values()))
    rng = np.random.default_rng(seed)
    k = len(arr)
    stats = []
    for _ in range(reps):
        s = arr[rng.integers(0, k, k)]
        stats.append(s[:, 0].sum() / s[:, 1].sum())
    point = arr[:, 0].sum() / arr[:, 1].sum()
    lo, hi = np.percentile(stats, [5, 95])
    return dict(delta=round(float(point), 5), ci90=[round(float(lo), 5), round(float(hi), 5)],
                se=round(float(np.std(stats)), 5), clusters=k, events=int(arr[:, 1].sum()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sleeper', required=True)
    ap.add_argument('--app', required=True)
    ap.add_argument('--fit-events', type=int, default=6000)
    ap.add_argument('--boot', type=int, default=1000)
    ap.add_argument('--fit-rate', type=float, default=0.07, help='share of 2021-23 claims kept for the fit')
    a = ap.parse_args()
    random.seed(SEED)

    smap, weekly, pos, played = load_players(a.app)
    sc = sqlite3.connect(f'file:{a.sleeper}?mode=ro', uri=True)
    idx = {s: SeasonIndex(s, weekly, pos, played, smap) for s in (*FIT_SEASONS, GRADE_SEASON)}
    log('players loaded', len(smap))

    # ---- title-odds proxy: champion ~ standings through w, fit 2021-23 team-weeks
    Xo, yo = [], []
    for season in FIT_SEASONS:
        champ = {(l, r): c for l, r, c in sc.execute(
            'SELECT ts.league_id, ts.roster_id, ts.champion FROM sh_team_seasons ts JOIN sh_leagues l '
            'USING (league_id) WHERE l.season = ?', (season,))}
        for lid, nt in league_rows(sc, season):
            tw = team_weeks(sc, lid)
            if not tw:
                continue
            for w in range(1, 14):
                for rid, f in odds_feats(tw, w).items():
                    if f[3] == 0:
                        continue
                    Xo.append(odds_design(f, nt))
                    yo.append(1.0 if champ.get((lid, rid)) else 0.0)
    odds_b = fit_logistic(np.array(Xo), np.array(yo))
    log('title-odds proxy fit on', len(yo), 'team-weeks')

    # ---- fit events: a seeded sample of 2021-23 claims
    fit = []
    rng = random.Random(SEED)
    for season in FIT_SEASONS:
        for cl, ch, X, _ in season_events(sc, season, idx[season], smap, odds_b, keep=a.fit_rate, rng=rng):
            fit.append((ch, X))
        idx[season].cache.clear()
        log('fit season', season, 'claims kept', len(fit))
    rng.shuffle(fit)
    fit = fit[:a.fit_events]
    fits = {}
    for name, names in (('B0', B0), ('M1', M1), ('M2', M2)):
        b, ll = fit_clogit(fit, names)
        fits[name] = (names, b, ll)
        log('fit', name, 'train ll', round(ll, 4))
    del fit

    # ---- grade 2024, full choice sets, every claim
    cl_ids, ll = [], {k: [] for k in fits}
    top1 = {k: [] for k in fits}
    pool_sizes, states = [], defaultdict(int)
    red = dict(zero_four=0, zero_four_seller=0, out2_bye2=0, out2_bye2_desperate=0)
    for cl, ch, X, info in season_events(sc, GRADE_SEASON, idx[GRADE_SEASON], smap, odds_b):
        cl_ids.append(cl)
        pool_sizes.append(len(X))
        states[info['state']] += 1
        if info['games'] == 4 and info['wins'] == 0:
            red['zero_four'] += 1
            red['zero_four_seller'] += info['state'] == 'seller'
        if info['out'] >= 2 and info['bye'] >= 2:
            red['out2_bye2'] += 1
            red['out2_bye2_desperate'] += info['state'] == 'desperate_buyer'
        for k, (names, b, _) in fits.items():
            l, t = event_ll(b, names, ch, X)
            ll[k].append(l)
            top1[k].append(t)
    n = len(cl_ids)
    log('graded 2024 claims', n)
    res = dict(
        split=dict(fit=list(FIT_SEASONS), graded=GRADE_SEASON, fit_events_sampled=a.fit_events,
                   graded_events=n, graded_clusters=len(set(cl_ids)),
                   median_pool=int(np.median(pool_sizes)), uniform_ll=round(float(np.mean(np.log(pool_sizes))), 4)),
        title_odds_proxy=dict(team_weeks=len(yo), coef=[round(float(x), 4) for x in odds_b],
                              design=['const', 'win_share', 'games/14', 'pf_z', 'ws*g', 'pfz*g', 'log(num_teams)']),
        models={k: dict(features=names, coef=[round(float(x), 4) for x in b], train_ll=round(tr, 4),
                        test_ll=round(float(np.mean(ll[k])), 4), top1=round(float(np.mean(top1[k])), 4))
                for k, (names, b, tr) in fits.items()},
        baseline_top1_highest_ppg=round(float(np.mean(top1['B0'])), 4),
        delta_M1_minus_B0=cluster_ci(cl_ids, np.array(ll['M1']) - np.array(ll['B0']), a.boot, SEED),
        delta_M2_minus_M1=cluster_ci(cl_ids, np.array(ll['M2']) - np.array(ll['M1']), a.boot, SEED + 1),
        delta_top1_M1_minus_B0=cluster_ci(cl_ids, np.array(top1['M1'], float) - np.array(top1['B0'], float), a.boot, SEED + 2),
        motive_states_2024_claims=dict(states),
        motive_red_offline=red,
    )
    d1, d2 = res['delta_M1_minus_B0'], res['delta_M2_minus_M1']
    res['verdict'] = dict(
        waiver_model_beats_baseline=d1['ci90'][1] < 0,
        motive_ships_as_feature=d2['ci90'][1] < 0,
        mde_80pct_M2_minus_M1=round(2.8 * d2['se'], 5),
    )
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
