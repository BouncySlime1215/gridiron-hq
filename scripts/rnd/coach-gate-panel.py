#!/usr/bin/env python3
"""
COACH-01a Step 0 (RL-18-3): build the separate-window panel the people-gate rerun scores.

For every team-season with all of weeks 1-12, compute each TELLS-01a template on an EARLY and a
LATE window that share no week and no event:

  split_70_30          the team-season's own weeks 1-12 cut 70/30 (weeks 1-8 vs 9-12)
  weeks_1_5_vs_6_11    sensitivity check

A lineup change is measured against the week before, so the first week of a window has none:
the change that straddles the cut belongs to neither window. Window rules mirror
server/services/coach/people/gate-rerun.js (teamSeasonWindows / splitEvents), which the JS
tests pin.

Templates are every TELLS-01a arm A template (`template_catalogue`, 542, the screen's count):
the per-family statistics (rate, active, night, sun, montue, wedthu, frisat, medhour, burst;
loglat, lastlat, bid, prem for claims), afterloss, the LINEUP means, TRADESHAPE and DROPTEN,
computed the way tells-factory.py's build_arm_a computes them, over the window's weeks instead of
weeks 1-6. Two recipes need more than one week, and both stay inside the window:

  afterloss   activity in week w after a loss in week w-1, minus after a win; the pair (w-1, w)
              must both be in the window, so the pair across the cut is used by neither
  DROPTEN     a drop's tenure counts from the player's first add INSIDE the window; a player
              added before the window counts as an original-roster drop (origshare)

Every catalogue template gets a panel row in every mode, with no clusters when no team-season
has a value, so the covered count is the catalogue's count on any input.

Output: gzip NDJSON, one line per (mode, template) with {cluster: [[early, late], ...]}. The
cluster is the factory's opaque league-season index (no league ids, no roster ids, no names).
LOCAL ONLY: it is derived from the private Sleeper copy and is never committed.

Usage (on the machine with the Sleeper copy):
  TELLS_SLEEPER_DB=<copy> TELLS_PLAYERIDS_CSV=<db_playerids.csv> \\
    python3 scripts/rnd/coach-gate-panel.py --out <local>/coach-gate-panel.ndjson.gz
  node scripts/coach-gate-rerun.mjs --panel <local>/coach-gate-panel.ndjson.gz
  python3 scripts/rnd/coach-gate-panel.py --fixture test/fixtures/tells-golden-fixture.json --out <tmp>
"""
import argparse
import gzip
import importlib.util
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('tells_factory', REPO / 'scripts/rnd/tells-factory.py')
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

MODES = {
    'split_70_30': lambda weeks: (weeks[:math.floor(len(weeks) * 0.7)], weeks[math.floor(len(weeks) * 0.7):]),
    'weeks_1_5_vs_6_11': lambda weeks: ([w for w in weeks if w <= 5], [w for w in weeks if 6 <= w <= 11]),
}
STATS = ('night', 'sun', 'montue', 'wedthu', 'frisat', 'medhour', 'burst')
CLAIM_STATS = ('loglat', 'lastlat', 'bid', 'prem')
TRADESHAPE_STATS = ('recv', 'sent', 'uneven', 'picks')
DROPTEN_STATS = ('tenure', 'origshare')


def template_catalogue():
    """Every arm A template build_arm_a writes, without its window suffix (the screen's universe)."""
    out = []
    for f in F.ALL_FAMS:
        out += [f'{f}|{s}' for s in ('rate', 'active') + STATS + ('afterloss',)]
        if f.startswith('CLAIM'):
            out += [f'{f}|{s}' for s in CLAIM_STATS]
    out += [f'LINEUP|{c}' for c in F.LINEUP_STATS]
    out += [f'TRADESHAPE|{s}' for s in TRADESHAPE_STATS]
    out += [f'DROPTEN:{P}|{s}' for P in ['ALL'] + F.POSITIONS for s in DROPTEN_STATS]
    return sorted(out)


def windowed_lineups(tw, pos, wks):
    """Lineup frame over the window only: week-over-week stats need the prior week IN the window."""
    sub = tw[tw.week.isin(wks)]
    return F.lineup_frame(sub, pos) if len(sub) else sub


def window_values(ev, trades, tw, pos, K, wks):
    """Template values over weeks `wks`, the build_arm_a recipes on an arbitrary window."""
    n_w = len(wks)
    e = ev[ev.week.isin(wks)].copy()
    e['night'] = (e.hour < 6).astype(float)
    e['sun'] = (e.dow == 6).astype(float)
    e['montue'] = e.dow.isin([0, 1]).astype(float)
    e['wedthu'] = e.dow.isin([2, 3]).astype(float)
    e['frisat'] = e.dow.isin([4, 5]).astype(float)
    e['lastlat'] = np.where(e.lat_h.notna(), (e.lat_h < 1).astype(float), np.nan)
    e['loglat'] = np.log1p(e.lat_h.clip(lower=0))
    cols = {}
    g = e.groupby(['lg', 'roster', 'fam'])
    agg = g.agg(n=('hour', 'size'), night=('night', 'mean'), sun=('sun', 'mean'), montue=('montue', 'mean'),
                wedthu=('wedthu', 'mean'), frisat=('frisat', 'mean'), medhour=('hour', 'median'),
                loglat=('loglat', 'median'), lastlat=('lastlat', 'mean'), bid=('bid', 'median'),
                prem=('prem', 'median'))
    wc = e.groupby(['lg', 'roster', 'fam', 'week']).size().rename('c').reset_index() \
        .groupby(['lg', 'roster', 'fam']).c.agg(['size', 'max', 'sum'])
    agg['active'] = wc['size'] / n_w
    agg['burst'] = np.where(wc['sum'] >= 2, wc['max'] / wc['sum'], np.nan)
    present = set(agg.index.get_level_values(2)) if len(agg) else set()
    for f in F.ALL_FAMS:
        if f not in present:
            cols[f'{f}|rate'] = pd.Series(0.0, index=K)
            cols[f'{f}|active'] = pd.Series(0.0, index=K)
            continue
        a = agg.xs(f, level=2)
        cols[f'{f}|rate'] = a['n'].reindex(K).fillna(0) / n_w
        cols[f'{f}|active'] = a['active'].reindex(K).fillna(0)
        for s in STATS:
            cols[f'{f}|{s}'] = a[s].reindex(K)
        if f.startswith('CLAIM'):
            for s in CLAIM_STATS:
                cols[f'{f}|{s}'] = a[s].reindex(K)
    lu = windowed_lineups(tw, pos, wks)
    if len(lu):
        grp = lu.groupby(['lg', 'roster'])
        for c in F.LINEUP_STATS:
            cols[f'LINEUP|{c}'] = grp[c].mean().reindex(K)
    cols.update(afterloss_values(e, lu, K, wks))
    cols.update(tradeshape_values(trades, K, wks))
    cols.update(dropten_values(e, K))
    return pd.DataFrame(cols).reindex(columns=template_catalogue())


def afterloss_values(e, lu, K, wks):
    """build_arm_a's afterloss: mean events in week w after a loss in w-1 minus after a win.
    Only pairs with both weeks in the window count, so no pair spans the cut."""
    cols = {}
    if not len(lu):
        return cols
    inside = set(wks)
    res = lu[['lg', 'roster', 'week', 'loss', 'win']].copy()
    res['week'] = res.week + 1
    grid = res[res.week.isin([w for w in wks if w - 1 in inside])]
    wkc = e.groupby(['lg', 'roster', 'fam', 'week']).size().rename('c').reset_index()
    for f in F.ALL_FAMS:
        wf = wkc[wkc.fam == f][['lg', 'roster', 'week', 'c']]
        m = grid.merge(wf, on=['lg', 'roster', 'week'], how='left').fillna({'c': 0})
        al = m[m.loss == 1].groupby(['lg', 'roster']).c.mean()
        aw = m[m.win == 1].groupby(['lg', 'roster']).c.mean()
        cols[f'{f}|afterloss'] = (al - aw).reindex(K)
    return cols


def tradeshape_values(trades, K, wks):
    """build_arm_a's TRADESHAPE means over the trades inside the window."""
    t = trades[trades.week.isin(wks)].copy()
    t['uneven'] = (t.nr != t.ns).astype(float)
    g = t.groupby(['lg', 'roster'])
    return {'TRADESHAPE|recv': g.nr.mean().reindex(K), 'TRADESHAPE|sent': g.ns.mean().reindex(K),
            'TRADESHAPE|uneven': g.uneven.mean().reindex(K), 'TRADESHAPE|picks': g.picks.mean().reindex(K)}


def dropten_values(e, K):
    """build_arm_a's DROPTEN over the window's events only (`e` is already cut to the window):
    tenure from the first add inside the window; no add inside it counts as original roster."""
    ad = e[e.fam == 'ADD_ANY:ALL'][['lg', 'roster', 'week', 'player']]
    first_add = ad.groupby(['lg', 'roster', 'player']).week.min().rename('aw')
    dr = e[e.fam.str.startswith('DROP:')].copy()
    dr['P'] = dr.fam.str.split(':').str[1]
    dr = dr.merge(first_add, left_on=['lg', 'roster', 'player'], right_index=True, how='left')
    dr['ten'] = np.where(dr.aw.notna() & (dr.aw <= dr.week), dr.week - dr.aw, np.nan)
    dr['orig'] = dr.aw.isna().astype(float)
    cols = {}
    for P in ['ALL'] + F.POSITIONS:
        dd = dr[dr.P == P].groupby(['lg', 'roster'])
        cols[f'DROPTEN:{P}|tenure'] = dd.ten.median().reindex(K)
        cols[f'DROPTEN:{P}|origshare'] = dd.orig.mean().reindex(K)
    return cols


def build(tx, tw, pos, lg_season=None):
    tx12 = tx[tx.week.between(1, 12)]
    tw12 = tw[tw.week.between(1, 12)]
    ev, trades = F.events_from_tx(tx12, pos)
    ev = F.expand_events(ev, trades)
    full = tw12.groupby(['lg', 'roster']).week.nunique()
    K = pd.MultiIndex.from_tuples(sorted(full[full == 12].index))
    weeks = list(range(1, 13))
    out = {}
    for mode, cut in MODES.items():
        early_w, late_w = cut(weeks)
        assert not set(early_w) & set(late_w), 'windows overlap'
        E = window_values(ev, trades, tw12, pos, K, early_w)
        L = window_values(ev, trades, tw12, pos, K, late_w)
        clusters = np.asarray(K.get_level_values(0))
        rows = {}
        for t in template_catalogue():
            a, b = E[t].to_numpy(float), L[t].to_numpy(float)
            ok = ~np.isnan(a) & ~np.isnan(b)
            by = {}
            for c, x, y in zip(clusters[ok], a[ok], b[ok]):
                by.setdefault(str(int(c)), []).append([round(float(x), 6), round(float(y), 6)])
            rows[t] = by
        out[mode] = {'early_weeks': early_w, 'late_weeks': late_w, 'templates': rows}
        F.log(mode, 'templates', len(rows), 'team-seasons', len(K))
    return out, len(K)


def parity(fixture_path):
    """On weeks 1-6 the panel must equal build_arm_a's w16 columns (w26 for afterloss)."""
    fx = json.load(open(fixture_path))
    pos = F.pos_fn(fx['positions'])
    tx, tw = F.fixture_frames(fx)
    tx, tw = tx[tx.week.between(1, 12)], tw[tw.week.between(1, 12)]
    K, _, _, X, _ = F.build_arm_a(tx, tw, pos, fams=F.ALL_FAMS)
    ev, trades = F.events_from_tx(tx, pos)
    W = window_values(F.expand_events(ev, trades), trades, tw, pos, K, [1, 2, 3, 4, 5, 6])
    compared, worst, nan_mismatch = [], 0.0, []
    for t in W.columns:
        c = f'{t}|w26' if t.endswith('|afterloss') else f'{t}|w16'
        if c not in X.columns:
            continue
        a, b = W[t].to_numpy(float), X[c].to_numpy(float)
        if (np.isnan(a) != np.isnan(b)).any():
            nan_mismatch.append(t)
        ok = ~np.isnan(a) & ~np.isnan(b)
        if ok.any():
            worst = max(worst, float(np.abs(a[ok] - b[ok]).max()))
        compared.append(t)
    fams = lambda ts: sorted({t.split('|')[1] if t.startswith(('LINEUP', 'TRADESHAPE')) else t.split('|')[-1]
                              if not t.startswith('DROPTEN') else 'DROPTEN' for t in ts})
    return {'compared': len(compared), 'max_abs_diff': worst, 'nan_mismatch': nan_mismatch,
            'stats_compared': fams(compared)}


def write(out, n_units, path, source):
    with gzip.open(path, 'wt') as fh:
        fh.write(json.dumps({'meta': {'unit': 'COACH-01a Step 0 panel', 'source': source,
                                      'team_seasons': n_units, 'factory': F.FACTORY_VERSION,
                                      'modes': {m: {'early': v['early_weeks'], 'late': v['late_weeks']}
                                                for m, v in out.items()}}}) + '\n')
        for mode, v in out.items():
            for t, by in v['templates'].items():
                fh.write(json.dumps({'mode': mode, 'template': t, 'clusters': by}, separators=(',', ':')) + '\n')
    F.log('wrote', path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--fixture')
    ap.add_argument('--list-templates', action='store_true', help='print the template catalogue as JSON and exit')
    ap.add_argument('--parity', metavar='FIXTURE', help='compare weeks 1-6 with build_arm_a on FIXTURE, print JSON')
    ap.add_argument('--seasons', default='2021-2024', help='e.g. 2021-2022; 2025 is never opened')
    a = ap.parse_args()
    if a.list_templates:
        return print(json.dumps(template_catalogue()))
    if a.parity:
        return print(json.dumps(parity(a.parity)))
    if not a.out:
        ap.error('--out is required')
    if a.fixture:
        fx = json.load(open(a.fixture))
        tx, tw = F.fixture_frames(fx)
        out, n = build(tx, tw, F.pos_fn(fx['positions']))
        return write(out, n, a.out, 'synthetic fixture')
    path, ids = os.environ.get('TELLS_SLEEPER_DB'), os.environ.get('TELLS_PLAYERIDS_CSV')
    if not path or not ids:
        sys.exit('set TELLS_SLEEPER_DB (a .backup copy of sleeper_history.sqlite) and TELLS_PLAYERIDS_CSV')
    lo, hi = (int(x) for x in a.seasons.split('-'))
    assert 2021 <= lo <= hi <= 2024, '2025 must never be opened'
    lg, tx, tw, pos = F.load_sleeper(path, ids)
    keep = set(lg[lg.season.between(lo, hi)].lg)
    tx, tw = tx[tx.lg.isin(keep)], tw[tw.lg.isin(keep)]
    out, n = build(tx, tw, pos)
    write(out, n, a.out, f'Sleeper history {lo}-{hi}, aggregates only')


if __name__ == '__main__':
    main()
