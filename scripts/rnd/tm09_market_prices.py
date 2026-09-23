"""TM-09: market prices from real Sleeper trades, and a hype index.

Pre-registration: docs/tdd/2026-09-23-tm-09-market-prices.prereg.md (committed before this ran).

Reads (all local, read-only, never committed):
  ~/gridiron-local/rnd/skill/team_seasons.sqlite   trade_sides, team_seasons
  ~/gridiron-local/rnd/skill/cache/points.pkl      weekly player points, kickoffs, positions
  ~/gridiron-local/rnd/skill/cache/adp_ev.pkl      ADP pools, leave-one-season-out ADP->ppg curves, k
  gridiron-hq/data/derived/sleeper_history.sqlite  sh_leagues.league_id order only (lg -> league id)

Writes:
  --out-json  aggregate table for the repo (cells + per player-week rows with n >= MIN_N + results).
              No league id, roster id, username or league name is written.
  --obs-csv   (optional) per-observation rows for local checks; LOCAL ONLY, never commit.

Seasons 2021-2024 only. 2025 is the held-out season and is never read (SQL filter season <= 2024).

The value helpers below are copied from rnd/skill/build_03_leagues.py (week_pts :45-60, kickoff :40-42,
adp :63-75, ev :78-80, exante :346-365) so our value is the same consensus forecast trade_sides.exante_* holds.

Run: nice -n 10 python3 scripts/rnd/tm09_market_prices.py --out-json server/data/trade-market/tm09-market-prices.json
"""
import argparse, collections, csv, json, math, os, pickle, sqlite3, sys
import numpy as np

HOME = os.path.expanduser('~')
SKILL = HOME + '/gridiron-local/rnd/skill/'
SH = 'file:' + HOME + '/Documents/GitHub/gridiron-hq/data/derived/sleeper_history.sqlite?mode=ro&immutable=1'
TS_DB = 'file:' + SKILL + 'team_seasons.sqlite?mode=ro&immutable=1'
SKILL_POS = ('QB', 'RB', 'WR', 'TE')
RECW = {'ppr': 1.0, 'half': 0.5, 'std': 0.0}
MAX_SEASON = 2024          # 2025 held out: never read
TRAIN = (2021, 2022, 2023)  # H1 fit
TEST = 2024                 # H1 test
MIN_CELL = 30
MIN_N = 3                   # per player-week rows are published only as aggregates of >= 3 trades
HORIZON = 4
N_BOOT = 1000
SEED = 7331


def week_bin(w):
    return '1-4' if w <= 4 else '5-8' if w <= 8 else '9-12' if w <= 12 else '13+'


def size_bin(n):
    return 'le10' if n <= 10 else '12' if n <= 13 else 'ge14'


class Values:
    """Our value at trade time: the study's consensus forecast minus the league's replacement ppg."""

    def __init__(self, C, A):
        self.P, self.POS, self.MAPT, self.KICK = C['P'], C['pos'], C['SLEEPER_TO_NV_TEAM'], C['kick']
        self.POOL, self.EV, self.K = A['POOL'], A['EV'], A['K_BY_SEASON']

    def team(self, sid, season, w):
        d = self.P.get(sid, {}).get(season)
        return d['team'][w] if d is not None and 0 <= w < 19 else None

    def kickoff(self, sid, season, w):
        t = self.team(sid, season, w)
        return self.KICK.get((season, w, t)) if t else None

    def week_pts(self, sid, season, w, sc, intw=-1):
        d = self.P.get(sid, {}).get(season)
        if d is None or not d['played'][w]:
            return None
        return float(d['base'][w] + (2 + intw) * d['ints'][w] - (1 - RECW[sc]) * d['rec'][w])

    def adp(self, pid, season, sf, exclude):
        pool = self.POOL.get((season, sf))
        if pool is None or pool['D'] == 0:
            return None
        D, T, a = pool['D'], pool['T'], pool['adj'].get(pid, 0.0)
        if exclude is not None and exclude in pool['own']:
            n1, own = pool['own'][exclude]
            D -= 1; T -= n1
            if pid in own:
                a -= own[pid] - n1
        return (T + a) / D if D > 0 else None

    def pred_ppg(self, p, season, sc, sf, lid, t, repl_pos):
        pre = []
        for w in range(1, 19):
            ko = self.kickoff(p, season, w)
            if ko is None or ko >= t:
                continue
            v = self.week_pts(p, season, w, sc)
            if v is not None:
                pre.append(v)
        n = len(pre); std = sum(pre) / n if n else 0.0
        x = self.adp(p, season, sf, lid)
        if x is not None:
            e = self.EV[(season, sf, sc)]
            prior = float(np.interp(x, e['x'], e['ppg']))
        else:
            prior = repl_pos
        k = self.K[season]
        return (n * std + k * prior) / (n + k)

    def future(self, p, season, sc, t, weeks, h):
        """Points per team game over the player's next h team games that kick off after t (no stat row = 0).
        None when fewer than h team games remain in the league's regular season."""
        tot, g = 0.0, 0
        for w in weeks:
            ko = self.kickoff(p, season, w)
            if ko is None or ko <= t:
                continue
            v = self.week_pts(p, season, w, sc)
            tot += v if v is not None else 0.0
            g += 1
            if g == h:
                return tot / h
        return None


def build_observations(limit=None):
    C = pickle.load(open(SKILL + 'cache/points.pkl', 'rb'))
    A = pickle.load(open(SKILL + 'cache/adp_ev.pkl', 'rb'))
    V = Values(C, A)
    sh = sqlite3.connect(SH, uri=True)
    lids = [r[0] for r in sh.execute('select league_id from sh_leagues order by league_id')]
    sh.close()
    lid_of = {i + 1: lid for i, lid in enumerate(lids)}   # lg = 1-based rank (build_03_leagues.py:97)
    db = sqlite3.connect(TS_DB, uri=True)
    q = ('select s.lg, s.season, s.trade_id, s.leg_week, s.t_done_ms, s.recv_players, s.give_players, '
         't.num_teams, t.scoring, t.superflex, t.repl_qb, t.repl_rb, t.repl_wr, t.repl_te, t.chain, '
         't.first_active_week, t.playoff_week_start '
         'from trade_sides s join team_seasons t on t.ts_id = s.ts_id '
         'where s.season <= ? and s.n_partners = 1 and s.has_picks = 0 and t.source = ? '
         'order by s.lg, s.trade_id, s.roster_id')
    rows = db.execute(q, (MAX_SEASON, 'sleeper')).fetchall()
    db.close()
    if limit:
        rows = rows[:limit]
    counts = collections.Counter(sides=len(rows))
    obs = []
    cache = {}
    for (lg, season, trade_id, wk, t, recv, give, nt, sc, sf, rq, rr, rw, rt, chain, fw, pws) in rows:
        recv = [p for p in (recv or '').split(',') if p]
        give = [p for p in (give or '').split(',') if p]
        if not recv or not give:
            counts['empty_side'] += 1
            continue
        if any(V.POS.get(p) not in SKILL_POS for p in recv + give):
            counts['non_skill_side'] += 1
            continue
        repl = {'QB': rq or 0.0, 'RB': rr or 0.0, 'WR': rw or 0.0, 'TE': rt or 0.0}
        lid = lid_of.get(lg)
        sc = sc if sc in RECW else 'ppr'
        weeks = list(range(fw or 1, pws or 15))

        def val(p):
            key = (lg, t, p)
            if key not in cache:
                pos = V.POS[p]
                cache[key] = V.pred_ppg(p, season, sc, sf, lid, t, repl[pos]) - repl[pos]
            return cache[key]

        vr = [max(val(p), 0.0) for p in recv]
        vg = {p: val(p) for p in give}
        denom = sum(max(v, 0.0) for v in vg.values())
        if denom <= 0:
            counts['give_side_zero_value'] += 1
            continue
        pkg = sum(vr)
        for p, v in vg.items():
            if v <= 0:
                counts['player_below_replacement'] += 1
                continue
            pos = V.POS[p]
            price = pkg * v / denom
            f4 = V.future(p, season, sc, t, weeks, HORIZON)
            f2 = V.future(p, season, sc, t, weeks, 2)
            obs.append(dict(
                season=season, week=int(wk), sleeper_id=p, pos=pos, num_teams=int(nt), chain=int(chain),
                trade_id=int(trade_id), one_for_one=int(len(recv) == 1 and len(give) == 1),
                value=v, price=price, hype=price - v,
                real4=None if f4 is None else f4 - repl[pos],
                real2=None if f2 is None else f2 - repl[pos]))
    counts['observations'] = len(obs)
    return obs, counts


# ---------------------------------------------------------------- statistics
def fit_cells(obs):
    by_cell, by_pos = collections.defaultdict(list), collections.defaultdict(list)
    for o in obs:
        r = o['price'] / o['value']
        by_cell[(o['pos'], week_bin(o['week']), size_bin(o['num_teams']))].append(r)
        by_pos[o['pos']].append(r)
    pos_r = {p: float(np.median(v)) for p, v in by_pos.items()}
    cells = {}
    for k, v in by_cell.items():
        cells[k] = dict(r=float(np.median(v)) if len(v) >= MIN_CELL else None, n=len(v))
    return cells, pos_r


def premium(cells, pos_r, pos, wk, nt):
    c = cells.get((pos, week_bin(wk), size_bin(nt)))
    if c and c['r'] is not None:
        return c['r'], 'cell'
    if pos in pos_r:
        return pos_r[pos], 'position'
    return 1.0, 'none'


def boot_chains(obs, stat, n_boot=N_BOOT, seed=SEED):
    by = collections.defaultdict(list)
    for o in obs:
        by[o['chain']].append(o)
    keys = list(by)
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(keys), len(keys))
        sample = [o for i in pick for o in by[keys[i]]]
        s = stat(sample)
        if s is not None and not (isinstance(s, float) and math.isnan(s)):
            out.append(s)
    a = np.array(out)
    return dict(lo=float(np.percentile(a, 5)), hi=float(np.percentile(a, 95)), se=float(a.std(ddof=1)),
                mde80=float(2.487 * a.std(ddof=1)), n_boot=len(a))


def h1(obs):
    train = [o for o in obs if o['season'] in TRAIN]
    test = [o for o in obs if o['season'] == TEST]
    cells, pos_r = fit_cells(train)
    for o in test:
        r, src = premium(cells, pos_r, o['pos'], o['week'], o['num_teams'])
        o['_model'] = o['value'] * r
        o['_src'] = src

    def mae_gain(s):
        if not s:
            return None
        return float(np.mean([abs(o['price'] - o['value']) - abs(o['price'] - o['_model']) for o in s]))

    def win(s):
        w = [abs(o['price'] - o['_model']) < abs(o['price'] - o['value']) for o in s
             if abs(o['price'] - o['_model']) != abs(o['price'] - o['value'])]
        return float(np.mean(w)) if w else None

    base_mae = float(np.mean([abs(o['price'] - o['value']) for o in test]))
    model_mae = float(np.mean([abs(o['price'] - o['_model']) for o in test]))
    g, wr = mae_gain(test), win(test)
    gci, wci = boot_chains(test, mae_gain), boot_chains(test, win)
    passed = g > 0 and gci['lo'] > 0 and wr > 0.5 and wci['lo'] > 0.5
    return dict(n_train=len(train), n_test=len(test), n_test_chains=len({o['chain'] for o in test}),
                baseline_mae=base_mae, model_mae=model_mae, mae_gain=g, mae_gain_ci=gci,
                decision_win_rate=wr, decision_win_rate_ci=wci,
                fallback_share={s: sum(o['_src'] == s for o in test) / len(test) for s in ('cell', 'position', 'none')},
                passed=bool(passed))


def ols_slope(s, key):
    xs = np.array([o['hype'] for o in s if o[key] is not None])
    ys = np.array([o[key] - o['value'] for o in s if o[key] is not None])
    if len(xs) < 3 or xs.var() == 0:
        return None
    c = float(np.cov(xs, ys, ddof=1)[0, 1] / xs.var(ddof=1))
    return c


def h2(obs):
    out = {}
    for key, label in (('real4', 'next4'), ('real2', 'next2')):
        s = [o for o in obs if o[key] is not None]
        xs = np.array([o['hype'] for o in s]); ys = np.array([o[key] - o['value'] for o in s])
        c = ols_slope(s, key)
        a = float(ys.mean() - c * xs.mean())
        ci = boot_chains(s, lambda z: ols_slope(z, key))
        per = {}
        for season in sorted({o['season'] for o in s}):
            ss = [o for o in s if o['season'] == season]
            per[str(season)] = dict(n=len(ss), c=ols_slope(ss, key))
        # MDE80 for the test of c against 1 is 2.487 x SE of c.
        out[label] = dict(n=len(s), n_chains=len({o['chain'] for o in s}), intercept=a, c=c, c_ci=ci, per_season=per,
                          decay_confirmed=bool(ci['hi'] < 1 and sum(1 for v in per.values() if v['c'] is not None and v['c'] < 1) >= 3),
                          market_informative=bool(ci['lo'] > 0))
    # decision grade: 1-for-1 trades, both players above replacement
    by_trade = collections.defaultdict(list)
    for o in obs:
        if o['one_for_one'] and o['real4'] is not None:
            by_trade[o['trade_id']].append(o)
    pairs = [v for v in by_trade.values() if len(v) == 2 and v[0]['value'] != v[1]['value']]

    def winrate(pp):
        w = []
        for a_, b_ in pp:
            hi, lo = (a_, b_) if a_['value'] > b_['value'] else (b_, a_)
            if hi['real4'] != lo['real4']:
                w.append(hi['real4'] > lo['real4'])
        return float(np.mean(w)) if w else None

    pair_obs = [dict(chain=p[0]['chain'], pair=p) for p in pairs]
    wr = winrate(pairs)
    wci = boot_chains(pair_obs, lambda z: winrate([x['pair'] for x in z]))
    out['decision_1for1'] = dict(n_pairs=len(pairs), consensus_favored_win_rate=wr, ci=wci)
    return out


def aggregates(obs):
    cells, pos_r = fit_cells(obs)   # served table: all non-holdout seasons 2021-2024
    cell_rows = []
    for (pos, wb, sb), c in sorted(cells.items()):
        hs = [o['hype'] for o in obs if o['pos'] == pos and week_bin(o['week']) == wb and size_bin(o['num_teams']) == sb]
        cell_rows.append(dict(pos=pos, week_bin=wb, size_bin=sb, n=c['n'], price_to_value=c['r'],
                              median_hype=float(np.median(hs)) if hs else None))
    pw = collections.defaultdict(list)
    for o in obs:
        pw[(o['season'], o['week'], o['sleeper_id'], o['pos'])].append(o)
    rows, suppressed = [], 0
    for (season, week, sid, pos), v in sorted(pw.items()):
        if len(v) < MIN_N:
            suppressed += 1
            continue
        rows.append(dict(season=season, week=week, sleeper_id=sid, pos=pos, n=len(v),
                         price=round(float(np.median([o['price'] for o in v])), 3),
                         value=round(float(np.median([o['value'] for o in v])), 3),
                         hype=round(float(np.median([o['hype'] for o in v])), 3)))
    return cell_rows, {k: round(v, 4) for k, v in pos_r.items()}, rows, suppressed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-json')
    ap.add_argument('--obs-csv')
    ap.add_argument('--limit', type=int)
    a = ap.parse_args()
    obs, counts = build_observations(a.limit)
    print('counts', dict(counts))
    if a.obs_csv:
        with open(a.obs_csv, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(obs[0].keys()))
            w.writeheader(); w.writerows(obs)
    res1 = h1(obs)
    res2 = h2(obs)
    print('H1', json.dumps(res1, indent=1))
    print('H2', json.dumps(res2, indent=1))
    cells, pos_r, pw_rows, suppressed = aggregates(obs)
    print('aggregates', dict(cells=len(cells), player_weeks=len(pw_rows), suppressed_under_min_n=suppressed))
    if a.out_json:
        doc = dict(
            meta=dict(unit='TM-09', prereg='docs/tdd/2026-09-23-tm-09-market-prices.prereg.md',
                      source='Sleeper public-league trades (local corpus), 2-team no-pick trade sides, QB/RB/WR/TE',
                      seasons=[2021, 2022, 2023, 2024], holdout_season_read=False,
                      units='points above replacement per game, league scoring',
                      sign='hype = price - value; positive = the market paid more than our value',
                      value_definition='consensus forecast (n*season ppg + k*ADP ppg)/(n+k) minus league replacement ppg',
                      min_trades_per_player_week=MIN_N, cells_fit_on='2021-2024', min_cell_n=MIN_CELL,
                      forward_status='unconfirmed forward', counts=dict(counts)),
            results=dict(h1=res1, h2=res2),
            position_price_to_value=pos_r,
            cells=cells,
            player_weeks=pw_rows)
        os.makedirs(os.path.dirname(a.out_json), exist_ok=True)
        with open(a.out_json, 'w') as f:
            json.dump(doc, f, separators=(',', ':'))
        print('wrote', a.out_json, os.path.getsize(a.out_json), 'bytes')


if __name__ == '__main__':
    sys.exit(main())
