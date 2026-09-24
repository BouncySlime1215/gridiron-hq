#!/usr/bin/env python3
"""
TELLS-01a: the Tells Factory, ported from R&D r18-internal (arm A) and r18-external arm B.

Pre-registration: docs/evidence/2026-09-23/tells-01a-preregistration.md (committed first).

Arm A  ~1,500 auto-generated this-season manager tells (weeks 1-6) screened against weeks 7-12
       adds, checkout and trade, beyond a timed league-demeaned activity baseline (B2). FIT
       2021-22, frozen, CONFIRM 2023-24 (one look). BH from scripts/model-lab/mass_test_harness.py.
Arm B  prior-season trade tells for next-week trades: fit 2022, replicate 2023, grade 2024.

Reads the Sleeper history DB through an env/arg path, opened immutable (point it at a
`sqlite3 .backup` copy). Seasons 2021-2024 only: 2025 is never opened (SQL filter + asserts).
Writes one aggregates-only artifact (no league ids, no names, no player ids).

Usage:
  TELLS_SLEEPER_DB=<copy> TELLS_PLAYERIDS_CSV=<db_playerids.csv> \
    python3 scripts/rnd/tells-factory.py --out server/data/tells-screen.json
  python3 scripts/rnd/tells-factory.py --golden test/fixtures/tells-golden-fixture.json <out.json>

The generator (`build_arm_a`, `build_prev_season`) runs on canonical records, the same shape the
JS library (server/services/tells/library.js) builds from engine_events; --golden runs it on the
3-team synthetic fixture so the JS values can be pinned to these.
"""
import argparse
import csv
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy import stats
from scipy.stats import norm
from sklearn.linear_model import LinearRegression, Ridge

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts' / 'model-lab'))
from mass_test_harness import benjamini_hochberg  # noqa: E402  (the canonical BH, :74)

FACTORY_VERSION = 'tells-01a.1'
SEASONS = (2021, 2024)
FIT_SEASONS = (2021, 2022)
CONFIRM_SEASONS = (2023, 2024)
Q = 0.10
SUPPORT_CHAINS = 30
PRUNE_CORR = 0.8
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


# ------------------------------------------------------------------ canonical definitions
FAMS_BASE = ['ADD_FA', 'CLAIM_WON', 'CLAIM_FAIL', 'CLAIM_ALL', 'DROP', 'ADD_ANY']
POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
ALL_FAMS = sorted([f'{f}:{p}' for f in FAMS_BASE for p in ['ALL'] + POSITIONS] + ['TRADE:ALL'])
WIN = {'w13': [1, 2, 3], 'w46': [4, 5, 6], 'w16': [1, 2, 3, 4, 5, 6], 'odd': [1, 3, 5], 'even': [2, 4, 6]}
CAND_WINDOWS = ('w13', 'w46', 'w16', 'w26')
LINEUP_STATS = ['lu_changed', 'lu_empty', 'lu_kdef_stream', 'ro_QB', 'ro_RB', 'ro_WR', 'ro_TE', 'ro_K', 'ro_DEF',
                'ro_bench']
PREV_TELLS = ['n_trades', 'n_trade_partners', 'trades_with_picks', 'uneven_trades', 'players_recv', 'players_sent',
              'n_start_trade', 'trades_early', 'trades_late', 'any_trade', 'n_adds', 'n_fail_claims', 'win_pct',
              'drops']


def pos_fn(pos_of):
    def pos(pid):
        pid = str(pid)
        if pid.isalpha():
            return 'DEF'
        p = pos_of.get(pid)
        if p in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF'):
            return p
        if p == 'PK':
            return 'K'
        return None
    return pos


def et_hour_dow(ms):
    et = np.asarray(ms, float) / 1000 - 4 * 3600  # fixed UTC-4 (prereg honesty note)
    return (et % 86400) / 3600, ((et // 86400 + 3) % 7).astype(int)  # Mon = 0


# ------------------------------------------------------------------ arm A generator
def events_from_tx(tx, pos):
    """Transactions (canonical) -> move events and trade sides, exactly as r18i_tells_build."""
    ev, trades = [], []
    for r in tx.itertuples(index=False):
        adds = r.adds or {}
        drops = r.drops or {}
        if r.type == 'trade':
            if r.status != 'complete':
                continue
            for rid in r.roster_ids or []:
                nr = sum(1 for v in adds.values() if v == rid)
                ns = sum(1 for v in drops.values() if v == rid)
                partners = [x for x in (r.roster_ids or []) if x != rid]
                trades.append((r.lg, rid, r.week, nr, ns, 1 if (r.picks or 0) > 0 else 0, r.ms, tuple(partners)))
            continue
        lat = r.lat if r.type == 'waiver' else None
        bid = r.bid if r.type == 'waiver' else None
        if r.type == 'free_agent' and r.status == 'complete':
            fam_add = 'ADD_FA'
        elif r.type == 'waiver' and r.status == 'complete':
            fam_add = 'CLAIM_WON'
        elif r.type == 'waiver' and r.status == 'failed':
            fam_add = 'CLAIM_FAIL'
        else:
            continue
        for p, rid in adds.items():
            ev.append((r.lg, rid, r.week, fam_add, pos(p), r.ms, lat, bid, str(p)))
        if fam_add != 'CLAIM_FAIL':
            for p, rid in drops.items():
                ev.append((r.lg, rid, r.week, 'DROP', pos(p), r.ms, lat, None, str(p)))
    ev = pd.DataFrame(ev, columns=['lg', 'roster', 'week', 'fam', 'pos', 'ms', 'lat', 'bid', 'player'])
    ev['lat'] = pd.to_numeric(ev.lat, errors='coerce').astype(float)
    ev['bid'] = pd.to_numeric(ev.bid, errors='coerce').astype(float)
    trades = pd.DataFrame(trades, columns=['lg', 'roster', 'week', 'nr', 'ns', 'picks', 'ms', 'partners'])
    return ev, trades


def expand_events(ev, trades):
    cl = ev[ev.fam.isin(['CLAIM_WON', 'CLAIM_FAIL'])]
    med = cl.groupby(['lg', 'week', 'player']).bid.median().rename('bid_med')
    ev = ev.merge(med, left_on=['lg', 'week', 'player'], right_index=True, how='left')
    ev['prem'] = np.where((ev.bid_med > 0) & ev.bid.notna(), np.log1p(ev.bid) - np.log1p(ev.bid_med), np.nan)
    ev.loc[ev.fam == 'DROP', 'prem'] = np.nan
    ev['hour'], ev['dow'] = et_hour_dow(ev.ms)
    ev['lat_h'] = ev.lat / 3.6e6
    u1 = ev[ev.fam.isin(['ADD_FA', 'CLAIM_WON'])].assign(fam='ADD_ANY')
    u2 = ev[ev.fam.isin(['CLAIM_WON', 'CLAIM_FAIL'])].assign(fam='CLAIM_ALL')
    ev = pd.concat([ev, u1, u2], ignore_index=True)
    evall = ev.assign(pos='ALL')
    ev = pd.concat([evall, ev[ev.pos.notna()]], ignore_index=True)
    ev['fam'] = ev.fam + ':' + ev.pos
    ev = ev.drop(columns=['pos'])
    tr = trades.copy()
    tr['fam'] = 'TRADE:ALL'
    tr['lat_h'] = np.nan
    tr['bid'] = np.nan
    tr['prem'] = np.nan
    tr['player'] = None
    tr['hour'], tr['dow'] = et_hour_dow(tr.ms) if len(tr) else (np.array([]), np.array([], int))
    cols = ['lg', 'roster', 'week', 'fam', 'hour', 'dow', 'lat_h', 'bid', 'prem', 'player']
    return pd.concat([ev[cols], tr[cols]], ignore_index=True)


def lineup_frame(tw, pos):
    tw = tw.copy()
    opp = tw[['lg', 'week', 'roster', 'points']].rename(columns={'roster': 'opp', 'points': 'opp_pts'})
    tw = tw.merge(opp, on=['lg', 'week', 'opp'], how='left')
    tw['win'] = np.where(tw.opp_pts.isna(), np.nan, (tw.points > tw.opp_pts).astype(float))
    tw['loss'] = np.where(tw.opp_pts.isna(), np.nan, (tw.points < tw.opp_pts).astype(float))
    tw = tw.sort_values(['lg', 'roster', 'week']).reset_index(drop=True)
    prev = tw.groupby(['lg', 'roster']).st.shift(1)

    def changed(a, b):
        return np.nan if not isinstance(b, list) else len(set(a) - set(b))

    tw['lu_changed'] = [changed(a, b) for a, b in zip(tw.st, prev)]
    tw['lu_empty'] = tw.st.map(lambda s: sum(1 for x in s if x == '0'))

    def kd(s):
        return tuple(sorted(x for x in s if x != '0' and pos(x) in ('K', 'DEF')))

    tw['lu_kdef_stream'] = [np.nan if not isinstance(b, list) else float(kd(a) != kd(b)) for a, b in zip(tw.st, prev)]
    for P in POSITIONS:
        tw['ro_' + P] = tw.pl.map(lambda s, P=P: sum(1 for x in s if pos(x) == P))
    tw['ro_bench'] = tw.pl.map(len) - tw.st.map(lambda s: sum(1 for x in s if x != '0'))
    return tw


def build_arm_a(tx, tw, pos, fams=None):
    """Canonical records -> (keys index, Y, B, X). tw: lg, roster, week, points, opp, st, pl (weeks 1-12)."""
    ev, trades = events_from_tx(tx, pos)
    ev = expand_events(ev, trades)
    tw = lineup_frame(tw, pos)
    K = pd.MultiIndex.from_frame(tw[['lg', 'roster']].drop_duplicates().sort_values(['lg', 'roster']))
    late = ev[ev.week >= 7]
    Y = pd.DataFrame(index=K)
    Y['Y_trade'] = trades[trades.week >= 7].groupby(['lg', 'roster']).size().reindex(K).fillna(0).gt(0).astype(float)
    Y['Y_adds'] = np.log1p(late[late.fam == 'ADD_ANY:ALL'].groupby(['lg', 'roster']).size().reindex(K).fillna(0))
    tl = tw[tw.week >= 7]
    Y['Y_checkout'] = tl.groupby(['lg', 'roster']).lu_empty.max().reindex(K).gt(0).astype(float)
    Y['late_weeks'] = tl.groupby(['lg', 'roster']).size().reindex(K)
    early = ev[ev.week <= 6]
    twe = tw[tw.week <= 6]
    B = pd.DataFrame(index=K)
    B['b_adds'] = np.log1p(early[early.fam == 'ADD_ANY:ALL'].groupby(['lg', 'roster']).size().reindex(K).fillna(0))
    B['b_trade'] = trades[trades.week <= 6].groupby(['lg', 'roster']).size().reindex(K).fillna(0).gt(0).astype(float)
    B['b_winpct'] = twe.groupby(['lg', 'roster']).win.mean().reindex(K)
    pf = twe.groupby(['lg', 'roster']).points.sum().reindex(K)
    B['b_pfz'] = pf.groupby(level=0).transform(lambda s: (s - s.mean()) / (s.std() or 1))
    B['early_weeks'] = twe.groupby(['lg', 'roster']).size().reindex(K)

    cols = {}
    e6 = early.copy()
    e6['night'] = (e6.hour < 6).astype(float)
    e6['sun'] = (e6.dow == 6).astype(float)
    e6['montue'] = e6.dow.isin([0, 1]).astype(float)
    e6['wedthu'] = e6.dow.isin([2, 3]).astype(float)
    e6['frisat'] = e6.dow.isin([4, 5]).astype(float)
    e6['lastlat'] = np.where(e6.lat_h.notna(), (e6.lat_h < 1).astype(float), np.nan)
    e6['loglat'] = np.log1p(e6.lat_h.clip(lower=0))
    fams = sorted(e6.fam.unique()) if fams is None else fams
    wkc = e6.groupby(['lg', 'roster', 'fam', 'week']).size().rename('c').reset_index()
    for wname, wks in WIN.items():
        sub = e6[e6.week.isin(wks)]
        g = sub.groupby(['lg', 'roster', 'fam'])
        agg = g.agg(n=('hour', 'size'), night=('night', 'mean'), sun=('sun', 'mean'), montue=('montue', 'mean'),
                    wedthu=('wedthu', 'mean'), frisat=('frisat', 'mean'), medhour=('hour', 'median'),
                    loglat=('loglat', 'median'), lastlat=('lastlat', 'mean'), bid=('bid', 'median'),
                    prem=('prem', 'median'))
        wc = wkc[wkc.week.isin(wks)].groupby(['lg', 'roster', 'fam']).c.agg(['size', 'max', 'sum'])
        agg['active'] = wc['size'] / len(wks)
        agg['burst'] = np.where(wc['sum'] >= 2, wc['max'] / wc['sum'], np.nan)
        present = set(agg.index.get_level_values(2)) if len(agg) else set()
        for f in fams:
            a = agg.xs(f, level=2) if f in present else pd.DataFrame()
            base = f'{f}|'
            cols[f'{base}rate|{wname}'] = (a['n'].reindex(K).fillna(0) / len(wks)) if len(a) else pd.Series(0.0, index=K)
            cols[f'{base}active|{wname}'] = a['active'].reindex(K).fillna(0) if len(a) else pd.Series(0.0, index=K)
            if not len(a):
                continue
            for s in ('night', 'sun', 'montue', 'wedthu', 'frisat', 'medhour', 'burst'):
                cols[f'{base}{s}|{wname}'] = a[s].reindex(K)
            if f.startswith('CLAIM'):
                for s in ('loglat', 'lastlat', 'bid', 'prem'):
                    cols[f'{base}{s}|{wname}'] = a[s].reindex(K)
    res = tw[['lg', 'roster', 'week', 'loss', 'win']].copy()
    res['week'] = res.week + 1
    grid = res[res.week.between(2, 6)]
    for f in fams:
        wf = wkc[wkc.fam == f][['lg', 'roster', 'week', 'c']]
        m = grid.merge(wf, on=['lg', 'roster', 'week'], how='left').fillna({'c': 0})
        for wname, wks in (('w26', [2, 3, 4, 5, 6]), ('odd', [3, 5]), ('even', [2, 4, 6])):
            mm = m[m.week.isin(wks)]
            al = mm[mm.loss == 1].groupby(['lg', 'roster']).c.mean()
            aw = mm[mm.win == 1].groupby(['lg', 'roster']).c.mean()
            cols[f'{f}|afterloss|{wname}'] = (al - aw).reindex(K)
    for wname, wks in WIN.items():
        sub = twe[twe.week.isin(wks)].groupby(['lg', 'roster'])
        for c in LINEUP_STATS:
            cols[f'LINEUP|{c}|{wname}'] = sub[c].mean().reindex(K)
    for wname in ('w16', 'odd', 'even'):
        t6 = trades[trades.week.isin(WIN[wname])].copy()
        t6['uneven'] = (t6.nr != t6.ns).astype(float)
        g = t6.groupby(['lg', 'roster'])
        cols[f'TRADESHAPE|recv|{wname}'] = g.nr.mean().reindex(K)
        cols[f'TRADESHAPE|sent|{wname}'] = g.ns.mean().reindex(K)
        cols[f'TRADESHAPE|uneven|{wname}'] = g.uneven.mean().reindex(K)
        cols[f'TRADESHAPE|picks|{wname}'] = g.picks.mean().reindex(K)
    ad = e6[e6.fam == 'ADD_ANY:ALL'][['lg', 'roster', 'week', 'player']]
    first_add = ad.groupby(['lg', 'roster', 'player']).week.min().rename('aw')
    dr = e6[e6.fam.str.startswith('DROP:')].copy()
    dr['P'] = dr.fam.str.split(':').str[1]
    dr = dr.merge(first_add, left_on=['lg', 'roster', 'player'], right_index=True, how='left')
    dr['ten'] = np.where(dr.aw.notna() & (dr.aw <= dr.week), dr.week - dr.aw, np.nan)
    dr['orig'] = dr.aw.isna().astype(float)
    for wname in ('w16', 'odd', 'even'):
        d = dr[dr.week.isin(WIN[wname])]
        for P in ['ALL'] + POSITIONS:
            dd = d[d.P == P].groupby(['lg', 'roster'])
            cols[f'DROPTEN:{P}|tenure|{wname}'] = dd.ten.median().reindex(K)
            cols[f'DROPTEN:{P}|origshare|{wname}'] = dd.orig.mean().reindex(K)
    X = pd.DataFrame(cols)
    return K, Y, B, X, trades


# ------------------------------------------------------------------ arm B generator
def build_prev_season(tx, tw, pos, pws_of):
    """Prior-season trade tells per (lg, roster) of THAT season, regular season weeks 1..pws-1."""
    ev, trades = events_from_tx(tx, pos)
    tw = lineup_frame(tw, pos) if len(tw) else tw
    reg = lambda df: df[df.week < df.lg.map(pws_of)]  # noqa: E731
    trades, ev = reg(trades), reg(ev)
    tw = reg(tw) if len(tw) else tw
    K = pd.MultiIndex.from_frame(tw[['lg', 'roster']].drop_duplicates().sort_values(['lg', 'roster']))
    g = trades.groupby(['lg', 'roster'])
    out = pd.DataFrame(index=K)
    out['n_trades'] = g.size().reindex(K).fillna(0)
    out['n_trade_partners'] = g.partners.agg(lambda s: len(set(x for t in s for x in t))).reindex(K).fillna(0)
    out['trades_with_picks'] = g.picks.sum().reindex(K).fillna(0)
    out['uneven_trades'] = trades.assign(u=(trades.nr != trades.ns).astype(float)).groupby(['lg', 'roster']).u.sum() \
        .reindex(K).fillna(0)
    out['players_recv'] = g.nr.sum().reindex(K).fillna(0)
    out['players_sent'] = g.ns.sum().reindex(K).fillna(0)
    out['trades_early'] = trades[trades.week <= 6].groupby(['lg', 'roster']).size().reindex(K).fillna(0)
    out['trades_late'] = trades[trades.week >= 7].groupby(['lg', 'roster']).size().reindex(K).fillna(0)
    out['any_trade'] = (out.n_trades > 0).astype(float)
    out['n_adds'] = ev[ev.fam.isin(['ADD_FA', 'CLAIM_WON'])].groupby(['lg', 'roster']).size().reindex(K).fillna(0)
    out['n_fail_claims'] = ev[ev.fam == 'CLAIM_FAIL'].groupby(['lg', 'roster']).size().reindex(K).fillna(0)
    out['drops'] = ev[ev.fam == 'DROP'].groupby(['lg', 'roster']).size().reindex(K).fillna(0)
    out['win_pct'] = tw.groupby(['lg', 'roster']).win.mean().reindex(K)
    # starts by players this roster received in a trade, in weeks after that trade
    acq = {}
    for r in tx.itertuples(index=False):
        if r.type != 'trade' or r.status != 'complete' or r.week >= pws_of.get(r.lg, 99):
            continue
        for p, rid in (r.adds or {}).items():
            k = (r.lg, rid, str(p))
            acq[k] = min(acq.get(k, 99), r.week)
    ns = {}
    for r in tw.itertuples(index=False):
        n = sum(1 for x in r.st if x != '0' and acq.get((r.lg, r.roster, str(x)), 99) < r.week)
        ns[(r.lg, r.roster)] = ns.get((r.lg, r.roster), 0) + n
    out['n_start_trade'] = pd.Series(ns).reindex(K).fillna(0) if ns else 0.0
    return out[PREV_TELLS]


# ------------------------------------------------------------------ Sleeper loader
def load_sleeper(path, playerids_csv):
    con = sqlite3.connect(f'file:{path}?immutable=1', uri=True)
    pos_of = {}
    for r in csv.DictReader(open(playerids_csv)):
        if r.get('sleeper_id') and r.get('position'):
            pos_of[r['sleeper_id']] = r['position']
    lg = pd.read_sql(f"""select league_id, season, num_teams, playoff_week_start, previous_league_id from sh_leagues
        where season between {SEASONS[0]} and {SEASONS[1]}""", con)
    assert lg.season.max() <= 2024 and lg.season.min() >= 2021, 'season filter broken: 2025 must never be opened'
    lg = lg.reset_index(drop=True)  # natural row order, as r18i (placebo permutation order)
    lg['lg'] = np.arange(len(lg))
    lgmap = dict(zip(lg.league_id, lg.lg))
    tx = pd.read_sql(f"""select t.league_id, week, type, status, roster_ids_json, adds_json, drops_json, waiver_bid,
        draft_picks, created_ms, latency_ms from sh_transactions t join sh_leagues l using(league_id)
        where l.season between {SEASONS[0]} and {SEASONS[1]} and week between 1 and 18
        and type in ('free_agent','waiver','trade')""", con)
    tx = pd.DataFrame({
        'lg': tx.league_id.map(lgmap), 'week': tx.week, 'type': tx.type, 'status': tx.status,
        'roster_ids': tx.roster_ids_json.map(lambda s: json.loads(s) if s else []),
        'adds': tx.adds_json.map(lambda s: (json.loads(s) if s else {}) or {}),
        'drops': tx.drops_json.map(lambda s: (json.loads(s) if s else {}) or {}),
        'bid': tx.waiver_bid, 'picks': tx.draft_picks, 'ms': tx.created_ms, 'lat': tx.latency_ms})
    tw = pd.read_sql(f"""select w.league_id, roster_id, week, points, opponent_roster_id, starters_json, players_json
        from sh_team_weeks w join sh_leagues l using(league_id) where l.season between {SEASONS[0]} and {SEASONS[1]}
        and week between 1 and 18""", con)
    tw = pd.DataFrame({'lg': tw.league_id.map(lgmap), 'roster': tw.roster_id, 'week': tw.week, 'points': tw.points,
                       'opp': tw.opponent_roster_id,
                       'st': tw.starters_json.map(lambda s: json.loads(s) if s else []),
                       'pl': tw.players_json.map(lambda s: json.loads(s) if s else [])})
    # chains: previous_league_id followed to its root (inside 2021-24)
    prev = dict(zip(lg.league_id, lg.previous_league_id))
    root = {}
    for lid in lg.league_id:
        r, seen = lid, 0
        while prev.get(r) in lgmap and seen < 10:
            r, seen = prev[r], seen + 1
        root[lgmap[lid]] = lgmap[r]
    lg['root'] = lg.lg.map(root)
    lg['prev_lg'] = lg.previous_league_id.map(lgmap)
    con.close()
    return lg, tx, tw, pos_fn(pos_of)


# ------------------------------------------------------------------ stats helpers
def bh_q(p):
    p = np.asarray(p, float)
    n = len(p)
    o = np.argsort(p)
    q = np.empty(n)
    q[o] = np.minimum.accumulate((p[o] * n / np.arange(1, n + 1))[::-1])[::-1]
    return np.minimum(q, 1)


def harness_bh(p, q=Q):
    keep, _ = benjamini_hochberg(list(map(float, p)), q)
    out = np.zeros(len(p), bool)
    out[list(keep)] = True
    return out


def by_reject(p, q=Q):
    p = np.asarray(p, float)
    n = len(p)
    cm = np.sum(1.0 / np.arange(1, n + 1))
    o = np.argsort(p)
    ok = p[o] <= np.arange(1, n + 1) * q / (n * cm)
    k = (np.max(np.where(ok)[0]) + 1) if ok.any() else 0
    r = np.zeros(n, bool)
    r[o[:k]] = True
    return r


def demean(v, g):
    s = pd.Series(np.asarray(v, float))
    return (s - s.groupby(g).transform('mean')).values


def league_auc_parts(score, y, g):
    df = pd.DataFrame({'s': score, 'y': y, 'g': g})
    df['r'] = df.groupby('g').s.rank()
    agg = df.groupby('g').agg(n1=('y', 'sum'), n=('y', 'size'))
    agg['rs'] = df[df.y == 1].groupby('g').r.sum().reindex(agg.index).fillna(0)
    agg['num'] = agg.rs - agg.n1 * (agg.n1 + 1) / 2
    agg['den'] = agg.n1 * (agg.n - agg.n1)
    return agg[['num', 'den']]


# ------------------------------------------------------------------ arm A screen
def arm_a(lg, tx, tw, pos):
    tw12 = tw[tw.week.between(1, 12)]
    tx12 = tx[tx.week.between(1, 12)]
    K, Y, B, X, _ = build_arm_a(tx12, tw12, pos)
    X = X.astype('float32')
    log('arm A tell columns', X.shape)
    season_of = dict(zip(lg.lg, lg.season))
    root_of = dict(zip(lg.lg, lg.root))
    nteams = dict(zip(lg.lg, lg.num_teams))
    ok = ((B.early_weeks == 6) & (Y.late_weeks == 6) & B.b_winpct.notna()).values
    Y, B, X = Y[ok], B[ok], X[ok]
    lgid = np.asarray(Y.index.get_level_values(0))
    roster = np.asarray(Y.index.get_level_values(1))
    season = pd.Series(lgid).map(season_of).values
    assert season.max() <= 2024
    chain = pd.Series(list(zip(pd.Series(lgid).map(root_of), roster))).astype(str).values
    fit = np.isin(season, FIT_SEASONS)
    conf = np.isin(season, CONFIRM_SEASONS)
    log('manager-seasons', int(ok.sum()), 'fit', int(fit.sum()), 'confirm', int(conf.sum()))
    OUTS = ['Y_trade', 'Y_adds', 'Y_checkout']

    def rk(v):
        return pd.Series(np.asarray(v, float)).groupby(lgid).rank(pct=True).values

    a13, a46 = rk(X['ADD_ANY:ALL|rate|w13']), rk(X['ADD_ANY:ALL|rate|w46'])
    BF2 = np.column_stack([demean(f, lgid) for f in [a13, a46, rk(X['CLAIM_ALL:ALL|rate|w16']),
                                                      rk(X['DROP:ALL|rate|w16']), rk(B.b_trade), rk(B.b_winpct),
                                                      rk(B.b_pfz), a13 ** 2, a46 ** 2]])
    Yd = {o: demean(Y[o].values, lgid) for o in OUTS}
    resid = {}
    for o in OUTS:
        m = LinearRegression().fit(BF2[fit], Yd[o][fit])
        resid[o] = Yd[o] - m.predict(BF2)

    cands = [c for c in X.columns if c.rsplit('|', 1)[1] in CAND_WINDOWS]
    templates = sorted(set(c.rsplit('|', 1)[0] for c in cands))
    log('candidate tells', len(cands), 'templates', len(templates), 'tests', len(cands) * len(OUTS))
    Xf, lgf, seas_f, chain_f = X[fit], lgid[fit], season[fit], chain[fit]

    # support floor: non-zero, defined, in >= 30 distinct FIT chains
    support = {}
    for c in cands:
        v = Xf[c].values
        nz = ~np.isnan(v) & (v != 0)
        support[c] = int(len(set(chain_f[nz])))

    # repeatability (template level, odd vs even)
    rep = {}
    for t in templates:
        a, b = Xf.get(t + '|odd'), Xf.get(t + '|even')
        if a is None or b is None:
            rep[t] = (np.nan, 1.0)
            continue
        m = a.notna().values & b.notna().values
        if m.sum() < 200 or a[m].nunique() < 3 or b[m].nunique() < 3:
            rep[t] = (np.nan, 1.0)
            continue
        rho, p2 = stats.spearmanr(a[m], b[m])
        rep[t] = (rho, p2 / 2 if rho > 0 else 1 - p2 / 2)
    tq = bh_q([rep[t][1] for t in templates])
    rep_pass = {t: bool(rep[t][0] >= 0.10 and q <= Q) for t, q in zip(templates, tq)}
    log('repeatable templates', sum(rep_pass.values()), 'of', len(templates))

    def lift(v, r, groups, seasons=None):
        m = ~np.isnan(v)
        if m.sum() < 2000:
            return None
        vv, rr, gg = v[m], r[m], groups[m]
        cnt = pd.Series(gg).map(pd.Series(gg).value_counts()).values
        k = cnt >= 3
        vv, rr, gg = vv[k], rr[k], gg[k]
        if len(np.unique(vv)) < 3:
            return None
        rkv = pd.Series(vv).groupby(gg).rank(pct=True).values
        x, y = demean(rkv, gg), demean(rr, gg)
        if x.std() == 0:
            return None
        c = np.corrcoef(x, y)[0, 1]
        df = len(x) - len(np.unique(gg)) - 1
        tstat = c * np.sqrt(df / max(1e-12, 1 - c * c))
        out = {'r': c, 'p': 2 * stats.t.sf(abs(tstat), df), 'n': int(len(x))}
        if seasons is not None:
            ss = seasons[m][k]
            for s in np.unique(ss):
                out[f'r_{s}'] = np.corrcoef(x[ss == s], y[ss == s])[0, 1]
        return out

    rng = np.random.default_rng(18)
    rows, prow = [], []
    for c in cands:
        v = Xf[c].values.astype(float)
        vp = v.copy()
        m = ~np.isnan(v)
        if m.sum() >= 2000:
            idx = np.where(m)[0]
            sh = pd.Series(idx).groupby(lgf[idx]).transform(lambda s: rng.permutation(s.values)).values
            vp[idx] = v[sh]
        for o in OUTS:
            r = lift(v, resid[o][fit], lgf, seas_f)
            if r is None:
                continue
            rows.append({'tell': c, 'template': c.rsplit('|', 1)[0], 'outcome': o, **r})
            pr = lift(vp, resid[o][fit], lgf, seas_f)
            prow.append({'tell': c, 'template': c.rsplit('|', 1)[0], 'outcome': o,
                         **(pr if pr else {'r': 0.0, 'p': 1.0, 'n': 0, 'r_2021': 0.0, 'r_2022': 0.0})})
    R = pd.DataFrame(rows)
    R['q'] = bh_q(R.p.values)
    R['bh'] = harness_bh(R.p.values)
    assert (R.bh == (R.q <= Q)).all(), 'harness BH and q-values disagree'
    R['by'] = by_reject(R.p.values)
    R['rep_pass'] = R.template.map(rep_pass)
    R['stable'] = np.sign(R.r_2021) == np.sign(R.r_2022)
    R['support'] = R.tell.map(support)
    R['supported'] = R.support >= SUPPORT_CHAINS
    R['fit_survivor'] = R.rep_pass & R.bh & R.stable & R.supported
    PR = pd.DataFrame(prow)
    PR['bh'] = harness_bh(PR.p.values)
    PR['rep_pass'] = PR.template.map(rep_pass)
    PR['stable'] = np.sign(PR.r_2021) == np.sign(PR.r_2022)
    PR['supported'] = PR.tell.map(support) >= SUPPORT_CHAINS
    placebo_bh = int(PR.bh.sum())
    placebo_full = int((PR.bh & PR.rep_pass & PR.stable & PR.supported).sum())
    log(f'FIT tests {len(R)} | BH {int(R.bh.sum())} | BY {int(R.by.sum())} | +repeatable+stable '
        f'{int((R.bh & R.rep_pass & R.stable).sum())} | +support (survivors) {int(R.fit_survivor.sum())}')
    log(f'placebo: BH {placebo_bh} of {len(PR)} | full rule {placebo_full}')
    ctrl = rep.get('ADD_ANY:ALL|rate', (np.nan,))[0]
    log('control ADD_ANY:ALL|rate repeatability rho', round(float(ctrl), 3), 'pass', rep_pass.get('ADD_ANY:ALL|rate'))

    def tell_feat(c):
        v = X[c].values.astype(float)
        miss = np.isnan(v)
        r = pd.Series(v).groupby(lgid).rank(pct=True).values
        r = np.where(miss, np.nan, r)
        x = r - pd.Series(r).groupby(lgid).transform('mean').values
        return np.where(miss, 0.0, x), miss

    # prune within outcome, greedy by FIT p, |corr| of league-centred ranks on FIT rows
    R['pruned_by'] = None
    feats = {}
    for o in OUTS:
        s = R[R.fit_survivor & (R.outcome == o)].sort_values('p')
        kept = []
        for i, row in s.iterrows():
            x = feats.setdefault(row.tell, tell_feat(row.tell)[0])
            hit = next((k for k in kept if abs(np.corrcoef(x[fit], feats[k][fit])[0, 1]) >= PRUNE_CORR), None)
            if hit is None:
                kept.append(row.tell)
            else:
                R.at[i, 'pruned_by'] = hit
    R['frozen'] = R.fit_survivor & R.pruned_by.isna()
    frozen = R[R.frozen].sort_values(['outcome', 'p'])[['tell', 'outcome', 'r', 'p', 'q', 'n']]
    frozen_js = json.dumps(frozen.to_dict(orient='records'), default=float, sort_keys=True)
    frozen_sha = hashlib.sha256(frozen_js.encode()).hexdigest()
    log(f'FROZEN before CONFIRM: {len(frozen)} tells (pruned {int(R.pruned_by.notna().sum())}) sha256 {frozen_sha}')
    for o in OUTS:
        log(f'  frozen {o}: {int((R.frozen & (R.outcome == o)).sum())}')

    # ---- CONFIRM 2023-24, one look ----
    def ctest(c, o, mask):
        x, miss = tell_feat(c)
        mm = mask & ~miss
        xx = demean(np.where(miss, np.nan, x)[mm], lgid[mm])
        yy = demean(resid[o][mm], lgid[mm])
        r = np.corrcoef(xx, yy)[0, 1]
        df = mm.sum() - len(np.unique(lgid[mm])) - 1
        return r, r * np.sqrt(df / (1 - r * r)), df, int(mm.sum())

    crow = []
    for rec in frozen.itertuples(index=False):
        r, t, df, n = ctest(rec.tell, rec.outcome, conf)
        crow.append({'tell': rec.tell, 'outcome': rec.outcome, 'r_conf': r, 'p1': stats.t.sf(t * np.sign(rec.r), df),
                     'n_conf': n, 'r_2023': ctest(rec.tell, rec.outcome, conf & (season == 2023))[0],
                     'r_2024': ctest(rec.tell, rec.outcome, conf & (season == 2024))[0], 'r_fit': rec.r})
    C = pd.DataFrame(crow)
    C['q_conf'] = bh_q(C.p1.values)
    C['confirmed'] = (C.q_conf < 0.05) & (np.sign(C.r_2023) == np.sign(C.r_fit)) & (np.sign(C.r_2024) == np.sign(C.r_fit))
    for o in OUTS:
        cc = C[C.outcome == o]
        log(f'CONFIRM {o}: frozen {len(cc)}, sign kept {int((np.sign(cc.r_conf) == np.sign(cc.r_fit)).sum())}, '
            f'CONFIRMED {int(cc.confirmed.sum())}')

    models = {}
    for label, pick in (('confirmed', C[C.confirmed]), ('all_frozen', C)):
        for o in OUTS:
            tl = sorted(set(pick[pick.outcome == o].tell))
            F = [BF2]
            for c in tl:
                x, miss = tell_feat(c)
                F.append(x[:, None])
                if miss.any():
                    F.append(demean(miss.astype(float), lgid)[:, None])
            XF = np.hstack(F)
            s0 = Ridge(alpha=1.0).fit(BF2[fit], Yd[o][fit]).predict(BF2)
            s1 = Ridge(alpha=1.0).fit(XF[fit], Yd[o][fit]).predict(XF)
            brng = np.random.default_rng(18)
            gl = lgid[conf]
            if o == 'Y_adds':
                y = Yd[o][conf]
                parts = pd.DataFrame({'g': gl, 'e0': (y - s0[conf]) ** 2, 'e1': (y - s1[conf]) ** 2, 'st': y ** 2}) \
                    .groupby('g').sum()
                stat = lambda P: (P.e0.sum() - P.e1.sum()) / P.st.sum()  # noqa: E731
                base, full, name = 1 - parts.e0.sum() / parts.st.sum(), 1 - parts.e1.sum() / parts.st.sum(), 'R2'
            else:
                y = Y[o].values[conf]
                p0, p1_ = league_auc_parts(s0[conf], y, gl), league_auc_parts(s1[conf], y, gl)
                parts = pd.DataFrame({'n0': p0.num, 'n1': p1_.num, 'den': p0.den})
                stat = lambda P: (P.n1.sum() - P.n0.sum()) / P.den.sum()  # noqa: E731
                base, full, name = parts.n0.sum() / parts.den.sum(), parts.n1.sum() / parts.den.sum(), 'AUC'
            idx = parts.index.values
            boots = [stat(parts.loc[brng.choice(idx, len(idx), replace=True)]) for _ in range(1000)]
            lo, hi = np.percentile(boots, [5, 95])
            models[f'{label}:{o}'] = {'tells': len(tl), 'metric': name, 'baseline': round(float(base), 4),
                                      'with_tells': round(float(full), 4), 'delta': round(float(full - base), 4),
                                      'ci90': [round(float(lo), 4), round(float(hi), 4)]}
            log(f'MODEL[{label}] {o}: {len(tl)} tells | {name} {base:.4f} -> {full:.4f} | delta {full - base:+.4f} '
                f'[{lo:+.4f}, {hi:+.4f}] 90% league bootstrap')
    trade_ci = models['confirmed:Y_trade']['ci90']
    trade_kill = not (trade_ci[0] > 0)

    # ---- EB prior per tell (FIT population): shrunk = (n v + k m) / (n + k), n = weeks observed ----
    def eb(c):
        t, w = c.rsplit('|', 1)
        v = Xf[c].values.astype(float)
        mean = float(np.nanmean(v)) if np.isfinite(v).any() else None
        a, b = Xf.get(t + '|odd'), Xf.get(t + '|even')
        nw = 5 if w == 'w26' else len(WIN[w])
        if a is None or b is None or mean is None:
            return mean, None
        m = a.notna().values & b.notna().values & ~np.isnan(v)
        if m.sum() < 200:
            return mean, None
        tau2 = float(np.cov(a.values[m].astype(float), b.values[m].astype(float))[0, 1])
        var_w = float(np.var(v[m]))
        if not (tau2 > 0) or not np.isfinite(var_w):
            return mean, None
        return mean, round(nw * max(var_w - tau2, 0.0) / tau2, 4)

    # ---- verdicts ----
    Cmap = {(r.tell, r.outcome): r for r in C.itertuples(index=False)}
    out = []
    for r in R.itertuples(index=False):
        c = Cmap.get((r.tell, r.outcome))
        if not r.supported:
            verdict, why = 'dead', 'support'
        elif not r.bh:
            verdict, why = 'dead', 'fdr'
        elif not r.rep_pass:
            verdict, why = 'dead', 'not_repeatable'
        elif not r.stable:
            verdict, why = 'dead', 'unstable_fit'
        elif r.pruned_by is not None:
            verdict, why = 'dead', 'redundant'
        elif c is None or not c.confirmed:
            verdict, why = 'dead', 'not_confirmed'
        elif r.outcome == 'Y_trade' and trade_kill:
            verdict, why = 'dead', 'trade_kill'
        else:
            verdict, why = 'confirmed', None
        e = {'id': r.tell, 'arm': 'A', 'family': r.tell.split('|')[0], 'outcome': r.outcome[2:],
             'effect_fit': round(float(r.r), 4), 'p_fit': float(f'{r.p:.3g}'), 'q_fit': float(f'{r.q:.3g}'),
             'by_fit': bool(r.by), 'support_chains': int(r.support), 'n_fit': int(r.n),
             'rep_rho': None if np.isnan(rep[r.template][0]) else round(float(rep[r.template][0]), 4),
             'verdict': verdict, 'dead_reason': why, 'espn_observable': espn_observable(r.tell),
             'p_accept_eligible': False}
        if r.pruned_by is not None:
            e['pruned_by'] = r.pruned_by
        if c is not None:
            e.update({'effect_confirm': round(float(c.r_conf), 4), 'q_confirm': float(f'{c.q_conf:.3g}'),
                      'effect_2023': round(float(c.r_2023), 4), 'effect_2024': round(float(c.r_2024), 4)})
        if verdict == 'confirmed':
            m_, k_ = eb(r.tell)
            e['prior'] = {'mean': None if m_ is None else round(m_, 6), 'k_weeks': k_}
        out.append(e)
    tested = set(R.tell)
    for c in cands:  # never testable (gate 1): listed so nobody re-tests them
        if c not in tested:
            out.append({'id': c, 'arm': 'A', 'family': c.split('|')[0], 'outcome': None, 'verdict': 'dead',
                        'dead_reason': 'undefined', 'support_chains': support[c],
                        'espn_observable': espn_observable(c), 'p_accept_eligible': False})
    summary = {
        'manager_seasons': {'fit': int(fit.sum()), 'confirm': int(conf.sum())},
        'candidates': len(cands), 'templates': len(templates), 'tests': int(len(R)),
        'fit_bh': int(R.bh.sum()), 'fit_by': int(R.by.sum()), 'fit_survivors': int(R.fit_survivor.sum()),
        'fit_survivors_without_support_floor': int((R.bh & R.rep_pass & R.stable).sum()),
        'pruned': int(R.pruned_by.notna().sum()), 'frozen': int(R.frozen.sum()), 'frozen_sha256': frozen_sha,
        'confirmed': {o[2:]: int(C[(C.outcome == o) & C.confirmed].shape[0]) for o in OUTS},
        'placebo': {'bh': placebo_bh, 'full_rule': placebo_full, 'tests': int(len(PR))},
        'models': models, 'trade_kill': bool(trade_kill),
    }
    return out, summary


def espn_observable(t):
    """r18i_espn_tell_coverage.py#espn_ok, verbatim rule."""
    fam, stat = t.split('|')[0], t.split('|')[1]
    if fam.startswith('LINEUP') or fam.startswith('TRADE'):
        if t.startswith('LINEUP|lu_empty'):
            return 'no: ESPN has no empty-slot rows; checkout on ESPN is dead starts (dead-starters.js deadReason)'
        return 'yes'
    if stat in ('bid', 'prem'):
        return 'no: ESPN leagues are traditional waivers (bid_amount 0 on every row)'
    if fam.startswith('CLAIM') and stat in ('wedthu', 'montue', 'sun', 'night', 'frisat', 'medhour', 'lastlat', 'loglat'):
        return 'no: ESPN stamps executed claims at processing time'
    if fam.startswith('CLAIM_FAIL') or fam.startswith('CLAIM_ALL'):
        return 'partial: ESPN shows won claims, failed claims rarely'
    if stat == 'afterloss':
        return 'partial: needs weekly results, not in engine_events yet'
    return 'yes'


# ------------------------------------------------------------------ arm B screen
def arm_b(lg, tx, tw, pos):
    pws_of = dict(zip(lg.lg, lg.playoff_week_start.fillna(15).astype(int)))
    season_of = dict(zip(lg.lg, lg.season))
    nteams = dict(zip(lg.lg, lg.num_teams))
    prev_of = {a: int(b) for a, b in zip(lg.lg, lg.prev_lg) if b == b and b is not None}
    root_of = dict(zip(lg.lg, lg.root))
    PV = build_prev_season(tx, tw, pos, pws_of)
    log('arm B prev-season tells', PV.shape)
    # current-season weekly panel
    ev, trades = events_from_tx(tx, pos)
    adds = ev[ev.fam.isin(['ADD_FA', 'CLAIM_WON'])].groupby(['lg', 'roster', 'week']).size()
    trw = trades.groupby(['lg', 'roster', 'week']).size()
    tw2 = tw[tw.points.notna()].copy()
    opp = tw2[['lg', 'week', 'roster', 'points']].rename(columns={'roster': 'opp', 'points': 'opp_pts'})
    tw2 = tw2.merge(opp, on=['lg', 'week', 'opp'], how='inner')
    tw2 = tw2[tw2.lg.map(season_of).between(2022, 2024)]
    tw2 = tw2[tw2.lg.map(prev_of).notna()]
    tw2['plg'] = tw2.lg.map(prev_of).astype(int)
    tw2 = tw2[tw2.lg.map(nteams).values == tw2.plg.map(nteams).values]
    tw2 = tw2[(tw2.week >= 3) & (tw2.week + 1 <= tw2.lg.map(pws_of) - 1)]
    rows = []
    cum = {}
    for key, g in pd.concat([adds.rename('a'), trw.rename('t')], axis=1).fillna(0).groupby(level=[0, 1]):
        wk = g.index.get_level_values(2).values
        cum[key] = (wk, g.a.values, g.t.values)
    for r in tw2.itertuples(index=False):
        wk, a, t = cum.get((r.lg, r.roster), (np.array([]), np.array([]), np.array([])))
        upto = wk <= r.week
        nxt = t[wk == r.week + 1].sum() if len(wk) else 0
        rows.append((r.lg, r.roster, r.week, r.plg, a[upto].sum() / r.week, float(t[upto].sum() > 0), float(nxt > 0)))
    d = pd.DataFrame(rows, columns=['lg', 'roster', 'w', 'plg', 'adds_rate', 'prior_trade', 'y'])
    d['season'] = d.lg.map(season_of)
    d['lw'] = d.lg * 100 + d.w
    d = d[d.groupby('lw').y.transform('sum') >= 1].reset_index(drop=True)
    d['chain'] = pd.Series(list(zip(d.lg.map(root_of), d.roster))).astype(str).values
    assert d.season.max() <= 2024
    XB = PV.reindex(pd.MultiIndex.from_arrays([d.plg.values, d.roster.values])).values.astype(float)
    linked = ~np.isnan(XB).all(1)
    d, XB = d[linked].reset_index(drop=True), XB[linked]
    Bm = d[['adds_rate', 'prior_trade']].values
    log('arm B rows', len(d), 'league-weeks', d.lw.nunique(), 'y=1', int(d.y.sum()),
        d.groupby('season').y.agg(['size', 'sum']).to_dict())

    def G_of(codes):
        u, inv = np.unique(codes, return_inverse=True)
        return sp.csr_matrix((np.ones(len(codes)), (np.arange(len(codes)), inv)), shape=(len(codes), len(u))), inv

    def impute_demean(Xs, codes):
        G, inv = G_of(codes)
        Xs = np.asarray(Xs, float)
        nanm = np.isnan(Xs)
        X0 = np.where(nanm, 0, Xs)
        cnt, sm = G.T @ (~nanm).astype(float), G.T @ X0
        mu = np.where(cnt > 0, sm / np.maximum(cnt, 1), 0)
        Xs = np.where(nanm, mu[inv], Xs)
        n_ = np.asarray(G.sum(0)).ravel()
        return Xs - (G.T @ Xs / n_[:, None])[inv]

    def screen(idx, Xd_all):
        codes = d.lw.values[idx]
        Bd = impute_demean(Bm[idx], codes)
        yd = impute_demean(d.y.values[idx][:, None], codes)[:, 0]
        Xd = Xd_all[idx]
        rt = Xd - Bd @ np.linalg.lstsq(Bd, Xd, rcond=None)[0]
        ry = yd - Bd @ np.linalg.lstsq(Bd, yd, rcond=None)[0]
        den = (rt ** 2).sum(0)
        b = (rt * ry[:, None]).sum(0) / np.where(den > 0, den, np.nan)
        e = ry[:, None] - rt * b
        C, _ = G_of(d.chain.values[idx])
        S = np.asarray(C.T @ (rt * e))
        se = np.sqrt((S ** 2).sum(0)) / den
        z = b / se
        return b, z, 2 * norm.sf(np.abs(z))

    fitB = np.where(d.season.values == 2022)[0]
    repB = np.where(d.season.values == 2023)[0]
    fit3 = np.where(np.isin(d.season.values, [2022, 2023]))[0]
    testB = np.where(d.season.values == 2024)[0]
    Xd = impute_demean(XB, d.lw.values)
    sd = Xd[fitB].std(0)
    keep = sd > 1e-9
    kb = np.where(keep)[0]
    Xd = Xd[:, kb] / sd[kb]
    names = [PREV_TELLS[j] for j in kb]
    b1, z1, p1 = screen(fitB, Xd)
    bh1, by1 = harness_bh(p1), by_reject(p1)
    b2, z2, p2 = screen(repB, Xd)
    p2one = np.where(np.sign(z2) == np.sign(z1), norm.sf(np.abs(z2)), 1 - norm.sf(np.abs(z2)))
    surv = bh1 & (np.sign(z2) == np.sign(z1)) & (p2one < 0.05)
    log(f'arm B FIT 2022: tested {len(p1)}, BH {int(bh1.sum())}, BY {int(by1.sum())}; replicated 2023 {int(surv.sum())}')
    rng = np.random.default_rng(1818)
    fl = d.lw.values[fitB]
    perm = np.arange(len(fitB))
    for code in np.unique(fl):
        seg = np.where(fl == code)[0]
        perm[seg] = seg[rng.permutation(len(seg))]
    Xp = np.zeros_like(Xd)
    Xp[fitB] = Xd[fitB][perm]
    _, _, pp = screen(fitB, Xp)
    placebo = int(harness_bh(pp).sum())
    log(f'arm B placebo: BH {placebo} of {len(pp)} (BY {int(by_reject(pp).sum())})')
    sidx = [j for j in np.argsort(-np.abs(z1)) if surv[j]]
    kept = []
    for j in sidx:
        if all(abs(np.corrcoef(Xd[fit3, j], Xd[fit3, k])[0, 1]) < PRUNE_CORR for k in kept):
            kept.append(j)
    log('arm B kept', [names[j] for j in kept])
    Bd_all = impute_demean(Bm, d.lw.values)
    yd_all = impute_demean(d.y.values[:, None], d.lw.values)[:, 0]

    def lpm(idx, Xk, pen_baseline=True):
        A = np.column_stack([Bd_all[idx]] + ([Xk[idx]] if Xk is not None else []))
        s = A.std(0)
        A = A / s
        pen = np.ones(A.shape[1])
        if not pen_baseline:
            pen[:2] = 0.0
        beta = np.linalg.solve(A.T @ A + 1.0 * len(idx) * np.diag(pen), A.T @ yd_all[idx])
        return beta / s

    def auc_parts(sc, idx):
        df = pd.DataFrame({'lw': d.lw.values[idx], 'y': d.y.values[idx], 's': sc, 'ch': d.chain.values[idx]})
        out = []
        for _, g in df.groupby('lw'):
            pos_, neg = g.s.values[g.y.values == 1], g.s.values[g.y.values == 0]
            if len(pos_) and len(neg):
                num = (pos_[:, None] > neg[None, :]).sum() + 0.5 * (pos_[:, None] == neg[None, :]).sum()
                out.append((g.ch.values[0], num, len(pos_) * len(neg)))
        return pd.DataFrame(out, columns=['ch', 'num', 'den'])

    result = {'rows': int(len(d)), 'rows_by_season': {int(k): int(v) for k, v in d.season.value_counts().items()},
              'tested': len(p1), 'fit_bh': int(bh1.sum()), 'fit_by': int(by1.sum()), 'replicated': int(surv.sum()),
              'placebo_bh': placebo, 'kept': [names[j] for j in kept]}
    if kept:
        bA = lpm(fit3, None)
        pa = auc_parts(Bd_all[testB] @ bA, testB)
        XK = Xd[:, kept]
        bB = lpm(fit3, XK)
        pb = auc_parts(np.column_stack([Bd_all[testB], XK[testB]]) @ bB, testB)
        aA, aB = pa.num.sum() / pa.den.sum(), pb.num.sum() / pb.den.sum()
        ca = pa.groupby('ch')[['num', 'den']].sum()
        cb = pb.groupby('ch')[['num', 'den']].sum().reindex(ca.index)
        rng = np.random.default_rng(1818)
        diffs = []
        for _ in range(2000):
            pk = rng.choice(len(ca), len(ca))
            A_, B_ = ca.values[pk].sum(0), cb.values[pk].sum(0)
            diffs.append(B_[0] / B_[1] - A_[0] / A_[1])
        lo, hi = np.percentile(diffs, [5, 95])
        # descriptive, as r18x: the baseline-unpenalised variant (no verdict) and 2024 per-tell z
        bA0, bB0 = lpm(fit3, None, False), lpm(fit3, XK, False)
        pa0 = auc_parts(Bd_all[testB] @ bA0, testB)
        pb0 = auc_parts(np.column_stack([Bd_all[testB], XK[testB]]) @ bB0, testB)
        variant = round(float(pb0.num.sum() / pb0.den.sum() - pa0.num.sum() / pa0.den.sum()), 4)
        b4, z4, _ = screen(testB, XK)
        log(f'arm B variant (baseline unpenalised, no verdict): delta {variant:+.4f}; 2024 z per kept tell',
            {names[j]: round(float(z4[n]), 2) for n, j in enumerate(kept)})
        result['descriptive'] = {'variant_baseline_unpenalised_delta': variant,
                                 'z_2024': {names[j]: round(float(z4[n]), 2) for n, j in enumerate(kept)}}
        result.update({'auc_baseline': round(float(aA), 4), 'auc_with_tells': round(float(aB), 4),
                       'delta': round(float(aB - aA), 4), 'ci90': [round(float(lo), 4), round(float(hi), 4)],
                       'league_weeks_graded': int(len(pa))})
        log(f'arm B 2024: AUC {aA:.4f} -> {aB:.4f} delta {aB - aA:+.4f} [90% {lo:+.4f}, {hi:+.4f}]')
    passed = bool(kept) and result.get('ci90', [0])[0] > 0
    result['pass'] = passed
    tells = []
    fit_mean = np.nanmean(XB[fitB], 0)
    for j, nm in enumerate(PREV_TELLS):
        jj = names.index(nm) if nm in names else None
        e = {'id': f'PREV|{nm}', 'arm': 'B', 'family': 'PREV', 'outcome': 'trade_next_week',
             'espn_observable': 'partial: ESPN transactionCounter.trades (count only)' if nm in ('n_trades', 'any_trade')
             else 'no: prior-season partners and shapes are Sleeper-only in local data'}
        if jj is None:
            e.update({'verdict': 'dead', 'dead_reason': 'zero_variance', 'p_accept_eligible': False})
        else:
            e.update({'effect_fit': round(float(b1[jj]), 4), 'z_fit': round(float(z1[jj]), 2),
                      'p_fit': float(f'{p1[jj]:.3g}'), 'bh_fit': bool(bh1[jj]), 'by_fit': bool(by1[jj]),
                      'z_2023': round(float(z2[jj]), 2)})
            if jj in kept:
                v, why = ('confirmed', None) if passed else ('lead', 'arm_b_ci_not_clear')
            elif surv[jj]:
                v, why = 'dead', 'redundant'
            elif bh1[jj]:
                v, why = 'dead', 'not_replicated'
            else:
                v, why = 'dead', 'fdr'
            e.update({'verdict': v, 'dead_reason': why, 'p_accept_eligible': v == 'confirmed',
                      'prior': {'mean': round(float(fit_mean[j]), 6), 'k_weeks': None}})
        tells.append(e)
    return tells, result


# ------------------------------------------------------------------ golden fixture
def fixture_frames(fx):
    tx = pd.DataFrame([{'lg': t['lg'], 'week': t['week'], 'type': t['type'], 'status': t['status'],
                        'roster_ids': t.get('roster_ids', []), 'adds': t.get('adds') or {}, 'drops': t.get('drops') or {},
                        'bid': t.get('bid'), 'picks': t.get('picks', 0), 'ms': t['ms'], 'lat': t.get('lat_ms')}
                       for t in fx['transactions']])
    tw = pd.DataFrame([{'lg': w['lg'], 'roster': w['roster'], 'week': w['week'], 'points': w.get('points'),
                        'opp': w.get('opp'), 'st': w['starters'], 'pl': w['players']} for w in fx['team_weeks']])
    tw['points'] = pd.to_numeric(tw.points, errors='coerce').astype(float)
    return tx, tw


def golden(fixture_path, out_path):
    fx = json.load(open(fixture_path))
    pos = pos_fn(fx['positions'])
    tx, tw = fixture_frames(fx)
    cur = fx['current']
    ctx, ctw = tx[tx.lg == cur['lg']], tw[tw.lg == cur['lg']]
    K, Y, B, X, _ = build_arm_a(ctx, ctw, pos, fams=ALL_FAMS)
    cands = [c for c in X.columns if c.rsplit('|', 1)[1] in CAND_WINDOWS]
    prev = fx['previous']
    ptx, ptw = tx[tx.lg == prev['lg']], tw[tw.lg == prev['lg']]
    PV = build_prev_season(ptx, ptw, pos, {prev['lg']: prev['playoff_week_start']})
    teams = {}
    for (lgv, rid) in K:
        vals = {}
        for c in cands:
            v = X.loc[(lgv, rid), c]
            vals[c] = None if pd.isna(v) else float(v)
        for nm in PREV_TELLS:
            v = PV.loc[(prev['lg'], rid), nm] if (prev['lg'], rid) in PV.index else np.nan
            vals[f'PREV|{nm}'] = None if pd.isna(v) else float(v)
        teams[str(rid)] = vals
    json.dump({'generator': FACTORY_VERSION, 'fixture': Path(fixture_path).name, 'tells': len(cands) + len(PREV_TELLS),
               'teams': teams}, open(out_path, 'w'), indent=0, sort_keys=True)
    print('golden', out_path, 'teams', len(teams), 'tells per team', len(cands) + len(PREV_TELLS))


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(REPO / 'server/data/tells-screen.json'))
    ap.add_argument('--golden', nargs=2, metavar=('FIXTURE', 'OUT'))
    a = ap.parse_args()
    if a.golden:
        return golden(*a.golden)
    path = os.environ.get('TELLS_SLEEPER_DB')
    ids = os.environ.get('TELLS_PLAYERIDS_CSV')
    if not path or not ids:
        sys.exit('set TELLS_SLEEPER_DB (a .backup copy of sleeper_history.sqlite) and TELLS_PLAYERIDS_CSV')
    lg, tx, tw, pos = load_sleeper(path, ids)
    log('leagues', len(lg), 'transactions', len(tx), 'team-weeks', len(tw))
    tells_a, sum_a = arm_a(lg, tx, tw, pos)
    tells_b, sum_b = arm_b(lg, tx, tw, pos)
    prereg = REPO / 'docs/evidence/2026-09-23/tells-01a-preregistration.md'
    artifact = {
        'artifact': 'tells-screen', 'version': FACTORY_VERSION,
        'fit_stamp': {'arm_a': {'fit': list(FIT_SEASONS), 'confirm': list(CONFIRM_SEASONS)},
                      'arm_b': {'fit': [2022], 'replicate': [2023], 'grade': [2024]},
                      'source': 'Sleeper history 2021-24, aggregates only; 2025 not opened',
                      'prereg_sha256': hashlib.sha256(prereg.read_bytes()).hexdigest(),
                      'factory_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      'rules': {'bh_q': Q, 'support_chains': SUPPORT_CHAINS, 'prune_abs_corr': PRUNE_CORR,
                                'confirm_q': 0.05, 'ci': 0.90}},
        'summary': {'arm_a': sum_a, 'arm_b': sum_b},
        'tells': tells_a + tells_b,
    }
    Path(a.out).write_text(json.dumps(artifact, separators=(',', ':'), sort_keys=True, default=float) + '\n')
    n_conf = sum(1 for t in artifact['tells'] if t['verdict'] == 'confirmed')
    log('wrote', a.out, 'tells', len(artifact['tells']), 'confirmed', n_conf)


if __name__ == '__main__':
    main()
