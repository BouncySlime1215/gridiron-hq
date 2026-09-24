# EVAL-E4 export (spawned by scripts/eval/e4-planner-replay.mjs#exportLeagues): reads the external
# Sleeper history DB (sh_leagues, sh_team_weeks, sh_team_seasons: sleeper_history.sqlite, not the app DB)
# and the pickled caches. FIX-294-1: moved out of the .mjs so the wiring map does not file the external
# tables as app tables that nothing writes.
import sys, json, pickle, collections
import numpy as np
SRC, CACHE, S0, S1, OUT = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
assert 2021 <= S0 <= S1 <= 2024, 'seasons must lie in 2021-2024 (2025 is held out)'
import sqlite3
C = pickle.load(open(CACHE + '/points.pkl', 'rb')); A = pickle.load(open(CACHE + '/adp_ev.pkl', 'rb'))
P, POS, DEFP = C['P'], C['pos'], C['DEFP']; POOL, EV = A['POOL'], A['EV']
K = 3
RECW = {'ppr': 1.0, 'half': 0.5, 'std': 0.0}
SK = ('QB', 'RB', 'WR', 'TE')
IDP = ('DL', 'LB', 'DB', 'IDP_FLEX', 'DE', 'DT', 'CB', 'S')
OKS = ('QB', 'RB', 'WR', 'TE', 'FLEX', 'REC_FLEX', 'WRRB_FLEX', 'SUPER_FLEX')
sh = sqlite3.connect('file:%s?mode=ro' % SRC, uri=True)

def adp(pid, season, sf, lid):
    pool = POOL.get((season, sf))
    if pool is None or pool['D'] == 0: return None
    D, T, a = pool['D'], pool['T'], pool['adj'].get(pid, 0.0)
    if lid in pool['own']:
        n1, own = pool['own'][lid]; D -= 1; T -= n1
        if pid in own: a -= own[pid] - n1
    return (T + a) / D if D > 0 else None

def byes(season):
    out = {}
    for (s, team), arr in DEFP.items():
        if s != season: continue
        miss = [w for w in range(1, 19) if w < len(arr) and np.isnan(arr[w])]
        out[team] = miss[0] if miss else None
    return out

BYE = {}
def series(pid, season, sf, sc, lid):
    d = P.get(pid, {}).get(season)
    x = adp(pid, season, sf, lid)
    ev = EV.get((max(2021, season - 1), sf, sc))
    prior = float(np.interp(x, ev['x'], ev['ppg'])) if (x is not None and ev is not None) else None
    pred = [0.0] * 19; pts = [0.0] * 19; bye = None
    if d is None:
        pred = [round(prior, 2) if prior is not None else 0.0] * 19
        return pred, pts, bye
    raw = d['base'] + d['ints'] - (1 - RECW[sc]) * d['rec']
    pl = d['played'].astype(bool)
    s = n = 0.0
    for w in range(19):
        if w >= 1 and w < len(raw) and pl[w] and not np.isnan(raw[w]):
            s += raw[w]; n += 1
            pts[w] = round(float(raw[w]), 2)
        std = s / n if n else 0.0
        pred[w] = round(std if prior is None else (n * std + K * prior) / (n + K), 2)
    team = None
    for w in range(1, 7):
        if w < len(d['team']) and d['team'][w]: team = d['team'][w]
    if team is not None:
        if season not in BYE: BYE[season] = byes(season)
        bye = BYE[season].get(team)
    return pred, pts, bye

skip = collections.Counter(); n_out = 0
with open(OUT, 'w') as f:
    for lid, season, nt, pt, pws, sc, rp in sh.execute(
            'select league_id, season, num_teams, playoff_teams, playoff_week_start, scoring, roster_positions '
            'from sh_leagues where season between ? and ? order by league_id', (S0, S1)).fetchall():
        assert 2021 <= season <= 2024
        rp = json.loads(rp or '[]')
        if any(x in rp for x in IDP): skip['idp'] += 1; continue
        if sc not in RECW or not nt or nt < 8 or nt > 14: skip['fmt'] += 1; continue
        rounds = {4: 2, 6: 3, 8: 3}.get(pt)
        if rounds is None or pt >= nt or not pws or pws < 12 or pws > 16 or pws + rounds - 1 > 18: skip['bracket'] += 1; continue
        sf = int('SUPER_FLEX' in rp)
        if (max(2021, season - 1), sf, sc) not in EV: skip['ev'] += 1; continue
        tw = collections.defaultdict(dict)
        for rid, w, pts, opp, pj in sh.execute('select roster_id, week, points, opponent_roster_id, players_json from sh_team_weeks where league_id=?', (lid,)):
            if 1 <= w < pws: tw[rid][w] = [pts, opp, [p for p in json.loads(pj or '[]') if p]]
        rids = sorted(tw)
        if len(rids) != nt or any(any(w not in tw[r] or tw[r][w][0] is None or tw[r][w][1] is None for w in range(1, pws)) for r in rids):
            skip['incomplete'] += 1; continue
        st = {r: (m, c) for r, m, c in sh.execute('select roster_id, made_playoffs, champion from sh_team_seasons where league_id=?', (lid,))}
        if set(st) != set(rids): skip['no_outcome'] += 1; continue
        pids = set()
        for r in rids:
            for w in range(6, pws): pids.update(p for p in tw[r][w][2] if POS.get(str(p)) in SK)
        pl = {}
        for p in pids:
            pred, pts, bye = series(str(p), season, sf, sc, lid)
            pl[p] = [POS[str(p)], bye, pred, pts]
        f.write(json.dumps({'lid': lid, 'season': season, 'sc': sc, 'sf': sf, 'nt': nt, 'pt': pt, 'pws': pws,
                            'slots': [x for x in rp if x in OKS], 'rids': rids,
                            'tw': {r: [tw[r][w] for w in range(1, pws)] for r in rids},
                            'made': {r: st[r][0] for r in rids}, 'champ': {r: st[r][1] for r in rids}, 'pl': pl}) + '\n')
        n_out += 1
print(json.dumps({'leagues': n_out, 'skip': dict(skip)}))
