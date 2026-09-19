"""TEST 1 -- luck vs skill. Build team-game luck balance from Jev play labels, test whether
the closing line overvalues teams whose recent turnover edge was lucky."""
import sqlite3, os, sys, json, math, re
import numpy as np
from collections import defaultdict

OUT = os.environ['OUT_DB']
P1 = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/line_history.sqlite'
P2 = '/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite'
SEED = int(os.environ.get('SEED', '0'))

c = sqlite3.connect(f'file:{P1}?mode=ro', uri=True)
c.execute(f"ATTACH DATABASE 'file:{P2}?mode=ro' AS nv")
o = sqlite3.connect(f'file:{OUT}?mode=ro', uri=True)

# ---------- games ----------
games = {}
for gid, s, w, ht, at, res, spr, espn in c.execute("""
  SELECT game_id,season,week,home_team,away_team,result,spread_line,CAST(espn AS TEXT)
  FROM nv.nfldata_games WHERE game_type='REG' AND season BETWEEN 2016 AND 2025
    AND result IS NOT NULL AND spread_line IS NOT NULL"""):
    games[gid] = dict(season=s, week=w, home=ht, away=at, result=res, spread=spr, espn=espn)
espn2gid = {g['espn']: k for k, g in games.items()}

# team id -> abbrev per event, from espn_events + nfldata_games
ev_team = {}
for ev, home, away in c.execute("SELECT event_id,home,away FROM espn_events"):
    gid = espn2gid.get(ev)
    if gid: ev_team[ev] = {str(home): games[gid]['home'], str(away): games[gid]['away']}

# ---------- jev labels ----------
lab = defaultdict(dict)
for ev, pid, q, v in o.execute("SELECT event_id,play_id,question,value FROM jev_luck WHERE question IN ('luck.mean','possession_lost')"):
    lab[(ev, pid)][q] = v
meta = {}
for ev, pid, t, st in o.execute("SELECT DISTINCT event_id,play_id,espn_type,start_team FROM jev_luck"):
    meta[(ev, pid)] = (t, st)

# ---------- nflverse structured match (attribution + validation) ----------
nvm = {}
try:
    cols = [r[1] for r in o.execute('PRAGMA table_info(nv_match)')]
    for r in o.execute('SELECT * FROM nv_match'):
        d = dict(zip(cols, r)); nvm[(d['event_id'], d['play_id'])] = d
except sqlite3.OperationalError:
    pass

INT_T = {'Pass Interception Return', 'Interception Return Touchdown'}
LOST_T = {'Fumble Recovery (Opponent)', 'Fumble Return Touchdown', 'Sack Opp Fumble Recovery',
          'Muffed Punt Recovery (Opponent)'}
KEPT_T = {'Fumble Recovery (Own)'}

events = []          # (gid, giveaway_team, takeaway_team, luck, source)
fallback = 0; unresolved = 0
for key, L in lab.items():
    if 'luck.mean' not in L: continue
    ev, pid = key
    gid = espn2gid.get(ev)
    if not gid: continue
    etype, st = meta[key]
    tmap = ev_team.get(ev, {})
    off = tmap.get(str(st))
    if off is None: continue
    other = games[gid]['home'] if off == games[gid]['away'] else games[gid]['away']
    m = nvm.get(key)
    give = take = None; src = None
    if m and m.get('posteam') and m.get('defteam'):
        pos, dfn = m['posteam'], m['defteam']
        if (m.get('interception') or 0) >= 1 or (m.get('fumble_lost') or 0) >= 1:
            give, take, src = pos, dfn, 'nv'
    else:
        if etype in INT_T or etype in LOST_T:
            give, take, src = off, other, 'espn'; fallback += 1
        elif etype in KEPT_T:
            src = 'espn_kept'; fallback += 1
        else:
            unresolved += 1
    if give is None: continue
    events.append((gid, give, take, L['luck.mean']))

print(f'turnover events used: {len(events)}   espn-fallback attributions: {fallback}   unresolved: {unresolved}', file=sys.stderr)

if SEED:  # PLACEBO: shuffle luck scores across plays
    rng = np.random.default_rng(SEED)
    lucks = np.array([e[3] for e in events]); rng.shuffle(lucks)
    events = [(e[0], e[1], e[2], float(lucks[i])) for i, e in enumerate(events)]

GLOBAL_MEAN = float(np.mean([e[3] for e in events]))

# ---------- team-game aggregates ----------
tg = defaultdict(lambda: dict(tk=0, gv=0, luck_tk=0.0, luck_gv=0.0))
for gid, give, take, lk in events:
    a = tg[(gid, take)]; a['tk'] += 1; a['luck_tk'] += lk
    b = tg[(gid, give)]; b['gv'] += 1; b['luck_gv'] += lk
for gid, g in games.items():
    for t in (g['home'], g['away']): tg[(gid, t)]

def feats(d):
    to_margin = d['tk'] - d['gv']
    # luck balance: how much of this team's turnover edge came from FORTUNE.
    # takeaways you got luckily (+), giveaways you suffered luckily (-)
    luck_bal = (d['luck_tk'] - GLOBAL_MEAN * d['tk']) - (d['luck_gv'] - GLOBAL_MEAN * d['gv'])
    return to_margin, luck_bal, (d['luck_tk'] - GLOBAL_MEAN * d['tk']), -(d['luck_gv'] - GLOBAL_MEAN * d['gv'])

# team -> ordered list of (season, week, gid, to_margin, luck_bal, lk_tk, lk_gv)
hist = defaultdict(list)
for (gid, t), d in tg.items():
    g = games[gid]
    hist[t].append((g['season'], g['week'], gid) + feats(d))
for t in hist: hist[t].sort()

def trailing(team, season, week, window):
    prior = [h for h in hist[team] if h[0] == season and h[1] < week]
    if window: prior = prior[-window:]
    if len(prior) < 3: return None
    arr = np.array([h[3:] for h in prior], dtype=float)
    return arr.mean(axis=0), len(prior)

FEAT_IDX = {'to_margin': 0, 'luck_bal': 1, 'luck_tk': 2, 'luck_gv': 3}

def build(window, feat):
    fi = FEAT_IDX[feat]; rows = []
    for gid, g in games.items():
        h = trailing(g['home'], g['season'], g['week'], window)
        a = trailing(g['away'], g['season'], g['week'], window)
        if h is None or a is None: continue
        me = g['result'] - g['spread']
        rows.append((gid, g['season'], g['week'], h[0][fi] - a[0][fi],
                     h[0][0] - a[0][0], me, g['result'], g['spread']))
    return rows

def ols_t(x, y):
    x = np.asarray(x, float); y = np.asarray(y, float)
    X = np.column_stack([np.ones_like(x), x])
    b, *_ = np.linalg.lstsq(X, y, rcond=None)
    r = y - X @ b; n = len(y)
    s2 = (r @ r) / (n - 2)
    se = math.sqrt(s2 * np.linalg.inv(X.T @ X)[1, 1])
    return b[1], se, b[1] / se, n

def ols2_t(x1, x2, y):
    X = np.column_stack([np.ones(len(y)), x1, x2]); y = np.asarray(y, float)
    b, *_ = np.linalg.lstsq(X, y, rcond=None)
    r = y - X @ b; n = len(y)
    s2 = (r @ r) / (n - 3); V = s2 * np.linalg.inv(X.T @ X)
    return [(b[i], math.sqrt(V[i, i]), b[i] / math.sqrt(V[i, i])) for i in (1, 2)], n

if __name__ == '__main__':
    res = {}
    grid = []
    for window in (3, 4, 6, 0):
        for feat in ('luck_bal', 'luck_tk', 'luck_gv', 'to_margin'):
            rows = build(window, feat)
            if len(rows) < 200: continue
            x = [r[3] for r in rows]; y = [r[5] for r in rows]
            b, se, t, n = ols_t(x, y)
            grid.append(dict(window=window or 'std', feat=feat, n=n,
                             beta=round(b, 4), se=round(se, 4), t=round(t, 3)))
    res['grid'] = grid
    # orthogonality: luck_bal controlling for to_margin
    for window in (4, 0):
        rl = build(window, 'luck_bal')
        if len(rl) < 200: continue
        (c1, c2), n = ols2_t([r[3] for r in rl], [r[4] for r in rl], [r[5] for r in rl])
        res[f'joint_w{window or "std"}'] = dict(n=n, luck_beta=round(c1[0],4), luck_t=round(c1[2],3),
                                                to_beta=round(c2[0],4), to_t=round(c2[2],3))
    print(json.dumps(res, indent=1))
