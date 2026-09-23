"""RL-8-2: consensus vs humans in executed Sleeper trades, graded in LINEUP points.

Pre-registration (committed before this script existed):
  docs/evidence/2026-09-23/consensus-vs-humans-lineup-preregistration.md
Reference implementation re-used: ~/gridiron-local/rnd/loop/scripts/r8x_consensus_vs_humans.py (R&D round 8), whose
sample, orientation (rng seed 7), consensus curve and season-to-date features are reproduced here unchanged for
1-for-1 trades, then extended to 2-for-1 trades and joined to real lineup outcomes.

Lineup outcomes (read-only; aggregates printed, no league or manager names):
  trade_sides.net_started_pts  rnd/skill/team_seasons.sqlite, writer rnd/skill/build_03_leagues.py:386-398
                               (points A started from received players minus points B started from A's given players,
                               from each team's real weekly starters, the same starters that build team_weeks)
  sides_ext.n_h_weeks, L_frozen  rnd/skill/trades/trades_ext.sqlite, writer rnd/skill/trades/tr_01_sides.py:150-196
  team_weeks.pts_trade         linkage control only (weekly lineup table)
2025 is never opened: every SQL read filters season <= 2024 and ECR scrapes after 2024 are dropped.

Run (about 2 minutes, one process):
  nice -n 10 python3 scripts/rnd/consensus_vs_humans_lineup.py --local-db .local-db/data.sqlite
"""
import collections
import os
import random

MDE_Z = 1.6449 + 0.8416          # same constant as server/services/gates/baseline-gate.js:32
SKILL = ('QB', 'RB', 'WR', 'TE')
REPL_RANK = {'QB': 13, 'RB': 30, 'WR': 36, 'TE': 13}   # replacement positional ECR rank (convention, a guess)
# Test fixture only. main() derives replacement PPG from the fitted curve at REPL_RANK and always passes it in.
REPL_PPG_DEFAULT = {'QB': 15.0, 'RB': 8.0, 'WR': 8.0, 'TE': 6.0}


def orient(rids, adds, drops, rng, rng2):
    """Pick side A of a 2-team trade. Returns (a, recv, give, shape) or None.

    1-for-1 trades draw A with rng.choice(rids), exactly as r8 (so seed 7 reproduces its orientation); 2-for-1 trades
    draw with rng2 so the r8 stream is not disturbed. Every moved player must also be dropped by the other side.
    """
    if len(rids) != 2 or set(adds) != set(drops):
        return None
    if len(adds) == 2:
        a = rng.choice(rids)
        shape = '1for1'
    elif len(adds) == 3:
        a = rng2.choice(rids)
        shape = '2for1'
    else:
        return None
    recv = [p for p, r in adds.items() if r == a]
    give = [p for p, r in drops.items() if r == a]
    sizes = sorted([len(recv), len(give)])
    if (shape == '1for1' and sizes != [1, 1]) or (shape == '2for1' and sizes != [1, 2]):
        return None
    return a, recv, give, shape


def value_diff(recv, give, shape, repl=None):
    """recv/give = [(value, pos)]. 1-for-1: raw difference (r8). 2-for-1: difference in value above replacement."""
    if shape == '1for1':
        return recv[0][0] - give[0][0]
    if repl is None:
        raise ValueError('2-for-1 value needs replacement PPG per position')
    return sum(v - repl[p] for v, p in recv) - sum(v - repl[p] for v, p in give)


def is_disagreement(x_con, x_std):
    return x_con != 0 and x_std != 0 and (x_con > 0) != (x_std > 0)


def _sign(x):
    return int(x > 0) - int(x < 0)


def win_rate(pairs):
    """pairs = [(x_con, y)]. Share of y != 0 where sign(y) == sign(x_con). Returns (rate or None, n_nonzero, tie_share)."""
    if not pairs:
        return None, 0, None
    q = [(x, y) for x, y in pairs if y != 0]
    ties = 1 - len(q) / len(pairs)
    if not q:
        return None, 0, ties
    return sum(1 for x, y in q if _sign(x) == _sign(y)) / len(q), len(q), ties


def signed_mean(pairs):
    """Mean of y * sign(x_con): points per week to the consensus-favoured side."""
    return sum(y * _sign(x) for x, y in pairs) / len(pairs) if pairs else None


def per_week(total, weeks):
    if total is None or not weeks or weeks <= 0:
        return None
    return total / weeks


def cluster_boot(rows, stat, key, reps=2000, seed=11):
    """Percentile bootstrap resampling whole clusters (rows[key]). Returns (est, lo5, hi95, se, n_clusters)."""
    import numpy as np
    by = collections.defaultdict(list)
    for r in rows:
        by[r[key]].append(r)
    keys = list(by)
    rg = np.random.default_rng(seed)
    d = []
    for _ in range(reps):
        v = stat([r for i in rg.integers(0, len(keys), len(keys)) for r in by[keys[i]]])
        if v is not None:
            d.append(v)
    return stat(rows), float(np.percentile(d, 5)), float(np.percentile(d, 95)), float(np.std(d, ddof=1)), len(keys)


def mde80(se):
    return MDE_Z * se


def gate_verdict(rate, lo_chain, lo_week, pts_lo_chain):
    """Pre-registered TM-01 gate (prereg item 10)."""
    if rate is None or lo_chain is None or lo_week is None or pts_lo_chain is None:
        return 'FAIL'
    return 'PASS' if (rate >= 0.55 and lo_chain > 0.50 and lo_week > 0.50 and pts_lo_chain > 0) else 'FAIL'


# ---------------------------------------------------------------------------------------------------------- study
def main():  # noqa: C901 (one linear study script)
    import argparse
    import csv
    import datetime as dt
    import json
    import sqlite3
    import numpy as np
    import pandas as pd

    os.environ.setdefault('OMP_NUM_THREADS', '1')
    ap = argparse.ArgumentParser()
    ap.add_argument('--local-db', required=True, help='a .backup copy of data.sqlite (never the live file)')
    ap.add_argument('--repo-data', default='/Users/nick_matta/Documents/GitHub/gridiron-hq/data')
    ap.add_argument('--gl', default='/Users/nick_matta/gridiron-local')
    args = ap.parse_args()
    if os.path.realpath(args.local_db) == os.path.realpath(os.path.join(args.gl, 'data.sqlite')):
        raise SystemExit('refusing to read the live data.sqlite; pass a .backup copy')
    GL = args.gl
    SP = GL + '/rnd/moonshots/spike/'
    X = json.load(open(SP + 'sleeper_to_gsis.json'))
    POS = json.load(open(SP + 'sleeper_positions.json'))
    sh = sqlite3.connect(f'file:{args.repo_data}/derived/sleeper_history.sqlite?immutable=1', uri=True)
    nv = sqlite3.connect(f'file:{args.repo_data}/line-history/nflverse.sqlite?mode=ro', uri=True)
    lo = sqlite3.connect(f'file:{args.local_db}?mode=ro', uri=True)
    ts = sqlite3.connect(f'file:{GL}/rnd/skill/team_seasons.sqlite?mode=ro', uri=True)
    tx = sqlite3.connect(f'file:{GL}/rnd/skill/trades/trades_ext.sqlite?mode=ro', uri=True)
    print('local copy, not production (nfl_ffopportunity_weekly read from a .backup of data.sqlite)')

    # --- r8 inputs, unchanged -----------------------------------------------------------------------------------
    LEAGUES = {l: (s, sc) for l, s, sc in sh.execute(
        "select league_id, season, scoring from sh_leagues where season between ? and ?", (2021, 2024))}
    PTS = collections.defaultdict(dict)
    for g, s, w, fs, fp in nv.execute(
            "select player_id, season, week, fantasy_points, fantasy_points_ppr from stats_player_week "
            "where season between ? and ? and season_type='REG' and week<=18", (2021, 2024)):
        PTS[(g, s)][w] = (fs or 0.0, fp or 0.0)
    FF = collections.defaultdict(dict)
    for g, s, w, x, a in lo.execute(
            "select player_gsis_id, season, week, expected_fantasy_points, actual_fantasy_points "
            "from nfl_ffopportunity_weekly where season between ? and ? and expected_fantasy_points is not null",
            (2021, 2024)):
        FF[(g, s)][w] = (x, a or 0.0)

    def score(t, sc):
        return t[1] if sc == 'ppr' else t[0] if sc == 'std' else (t[0] + t[1]) / 2

    def feats(g, s, w, sc):
        wk = PTS.get((g, s), {})
        pre = [score(wk[k], sc) for k in sorted(wk) if k < w]
        if len(pre) < 3:
            return None
        f = [FF[(g, s)][k] for k in sorted(FF.get((g, s), {})) if k < w]
        if len(f) < 2:
            return None
        rw = range(w + 1, 18)
        std = sum(pre) / len(pre)
        return dict(std=std, form=sum(pre[-3:]) / 3 - std,
                    ros=sum(score(wk[k], sc) for k in rw if k in wk) / len(rw))

    ids = list(csv.DictReader(open(GL + '/rnd/loop/data/dp/db_playerids.csv')))
    g2fp = {r['gsis_id']: r['fantasypros_id'] for r in ids if r['fantasypros_id'] and r['gsis_id'] not in ('', 'NA')}
    e = pd.read_parquet(GL + '/rnd/loop/data/dp/fpecr_redraft_rp.parquet')
    e['d'] = pd.to_datetime(e.scrape_date.astype(str)).dt.date
    e = e[pd.to_datetime(e.scrape_date.astype(str)).dt.year <= 2024]
    e = e[e.page_type.isin(['redraft-qb', 'redraft-rb', 'redraft-wr', 'redraft-te'])].copy()
    sun = collections.defaultdict(lambda: dt.date.min)
    for s_, w_, gd in nv.execute("select season,week,gameday from games where game_type='REG' and season between ? and ?",
                                 (2021, 2024)):
        sun[(s_, w_)] = max(sun[(s_, w_)], dt.date.fromisoformat(gd))
    BOARD = {}
    for (s_, w_), sd_ in list(sun.items()):
        cand = e[(e.d <= sd_) & (e.d >= sd_ - dt.timedelta(days=6))]
        if cand.empty:
            continue
        cand = cand[cand.d == cand.d.max()]
        BOARD[(s_, w_)] = {str(i): float(x) for i, x in zip(cand.id, cand.ecr)}
    R6 = pd.read_csv(GL + '/rnd/loop/data/r6x/schedule_rows.csv')
    R6 = R6[R6.s <= 2022].copy()
    R6['v'] = R6.tgt_ros / R6.slots_ros
    R6['b'] = ((R6.ecr - 1) // 3).astype(int)
    CURVE = {}
    for pos, g in R6.groupby('pos'):
        m = g.groupby('b').v.mean().sort_index()
        vals = list(m.values)
        for k in range(1, len(vals)):
            vals[k] = min(vals[k], vals[k - 1])
        CURVE[pos] = dict(zip(m.index, vals))

    def curve_at(pos, k):
        cv = CURVE[pos]
        return cv.get(k, cv[max(cv)] if k > max(cv) else None)

    REPL = {p: float(curve_at(p, (REPL_RANK[p] - 1) // 3)) for p in SKILL}
    print('replacement PPG from the 2021-22 curve at ranks', REPL_RANK, '->', {p: round(v, 2) for p, v in REPL.items()})

    def v(pid, s, w):
        g = X[pid]
        b = BOARD.get((s, w))
        fp = g2fp.get(g)
        if not b or fp not in b:
            return None
        return curve_at(POS[pid], int((b[fp] - 1) // 3))

    # --- sample: r8's 1-for-1 rows (same query, same rng) plus 2-for-1 rows ------------------------------------------
    rng = random.Random(7)
    rng2 = random.Random(8)
    rows = []
    for lid, w, rids, adds, drops, picks in sh.execute(
            "select t.league_id, t.week, t.roster_ids_json, t.adds_json, t.drops_json, t.draft_picks from sh_transactions t "
            "join sh_leagues l on l.league_id=t.league_id where l.season between 2021 and 2024 and t.type='trade' and t.status='complete'"):
        s, sc = LEAGUES[lid]
        rids = json.loads(rids)
        adds = json.loads(adds or '{}')
        drops = json.loads(drops or '{}')
        if len(rids) != 2 or (picks and picks not in ('[]', 'null')):
            continue
        if set(adds) != set(drops) or len(adds) not in (2, 3) or not (4 <= w <= 14):
            continue
        o = orient(rids, adds, drops, rng, rng2)
        if o is None:
            continue
        a, recv, give, shape = o
        players = recv + give
        if any(POS.get(p) not in SKILL or p not in X for p in players):
            continue
        F = {p: feats(X[p], s, w, sc) for p in players}
        if not all(F.values()):
            continue
        vals = {p: v(p, s, w) for p in players}
        if any(x is None for x in vals.values()):
            continue
        x_con = value_diff([(vals[p], POS[p]) for p in recv], [(vals[p], POS[p]) for p in give], shape, REPL)
        x_std = value_diff([(F[p]['std'], POS[p]) for p in recv], [(F[p]['std'], POS[p]) for p in give], shape, REPL)
        y_player = sum(F[p]['ros'] for p in recv) - sum(F[p]['ros'] for p in give)
        rows.append(dict(lid=lid, s=s, w=w, a=a, b=[r for r in rids if r != a][0], recv=recv, give=give, shape=shape,
                         x_con=x_con, x_std=x_std, y_player=y_player))
    n11 = sum(r['shape'] == '1for1' for r in rows)
    print(f'trades on the board: 1-for-1 n={n11}, 2-for-1 n={len(rows) - n11}, leagues={len({r["lid"] for r in rows})}')

    # --- reproduction control: r8's primary (player points, 1-for-1, league-clustered) -----------------------------------
    r8 = [r for r in rows if r['shape'] == '1for1' and r['s'] >= 2023]
    D8 = [r for r in r8 if is_disagreement(r['x_con'], r['x_std'])]
    wr = lambda q, k: win_rate([(r['x_con'], r[k]) for r in q])[0]
    est, l5, h95, _, nl = cluster_boot(D8, lambda q: wr(q, 'y_player'), 'lid')
    print(f'== CONTROL r8 reproduction (1-for-1, 2023-24, player ROS points, league-clustered): n={len(D8)} of {len(r8)}, '
          f'leagues={nl}: {est:.3f} [{l5:.3f}, {h95:.3f}]  (r8 printed n=210 of 723, 0.576 [0.515, 0.633])')
    if len(D8) != 210 or round(est, 3) != 0.576:
        raise SystemExit('reproduction control failed; stopping before any lineup number (prereg item 2)')

    # --- link to lineup outcomes ------------------------------------------------------------------------------------
    LG = {lid: i for i, (lid,) in enumerate(sh.execute('select league_id from sh_leagues order by league_id'), 1)}
    TS = collections.defaultdict(list)
    for lg, s, idx, rid, prid, lw, rp, gp, rs, gs, ns in ts.execute(
            "select lg, season, trade_idx, roster_id, partner_roster_id, leg_week, recv_players, give_players, "
            "recv_started_pts, give_started_by_partner_pts, net_started_pts from trade_sides "
            "where season between ? and ? and n_partners = 1 and has_picks = 0", (2021, 2024)):
        key = (lg, rid, lw, frozenset(rp.split(',')) if rp else frozenset(), frozenset(gp.split(',')) if gp else frozenset())
        TS[key].append(dict(s=s, idx=idx, prid=prid, recv_started=rs, give_started=gs, net_started=ns))
    SX = {}
    for lg, s, idx, rid, nh, lf in tx.execute(
            "select lg, season, trade_idx, roster_id, n_h_weeks, L_frozen from sides_ext where season between ? and ?",
            (2021, 2024)):
        SX[(lg, s, idx, rid)] = (nh, lf)
    CH = {tsid: ch for tsid, ch in ts.execute("select ts_id, chain from team_seasons where season between ? and ?",
                                               (2021, 2024))}
    PT = {(lg, rid): p for lg, rid, p in ts.execute(
        "select lg, roster_id, sum(pts_trade) from team_weeks where season between ? and ? group by lg, roster_id",
        (2021, 2024))}
    miss = collections.Counter()
    linked = []
    tw_ok = tw_n = 0
    for r in rows:
        lg = LG[r['lid']]
        hits = TS.get((lg, r['a'], r['w'], frozenset(r['recv']), frozenset(r['give'])), [])
        if len(hits) != 1:
            miss['trade_sides ' + ('none' if not hits else 'ambiguous')] += 1
            continue
        t = hits[0]
        if t['s'] != r['s'] or t['prid'] != r['b']:
            miss['trade_sides season/partner mismatch'] += 1
            continue
        sa, sb = SX.get((lg, r['s'], t['idx'], r['a'])), SX.get((lg, r['s'], t['idx'], r['b']))
        if not sa or not sb or not sa[0]:
            miss['sides_ext missing or no horizon week'] += 1
            continue
        nh = sa[0]
        if t['recv_started'] > 0:
            tw_n += 1
            tw_ok += (PT.get((lg, r['a'])) or 0) >= t['recv_started'] - 0.5
        r.update(lg=lg, chain=CH.get(lg * 100 + r['a']), sw=(r['s'], r['w']), nh=nh,
                 y_L=per_week(t['net_started'], nh), y_F=per_week(sa[1] - sb[1], nh),
                 recv_pw=per_week(t['recv_started'], nh), give_pw=per_week(t['give_started'], nh),
                 y_player_pw=r['y_player'])
        linked.append(r)
    print(f'== LINKAGE: linked {len(linked)} of {len(rows)} sides; unlinked {dict(miss)}')
    print(f'== LINKAGE control team_weeks.pts_trade >= recv_started_pts: {tw_ok} of {tw_n} sides with starts '
          f'({tw_ok / tw_n:.3f})')
    if any(r['chain'] is None for r in linked):
        raise SystemExit('chain missing for a linked side')

    # --- analysis -------------------------------------------------------------------------------------------------
    def block(lab, sub, ykey, gate=False):
        D = [r for r in sub if is_disagreement(r['x_con'], r['x_std'])]
        if not D:
            print(f'   {lab}: no disagreement trades')
            return None
        wrs = lambda q: win_rate([(r['x_con'], r[ykey]) for r in q])[0]
        sm = lambda q: signed_mean([(r['x_con'], r[ykey]) for r in q])
        rate, nnz, ties = win_rate([(r['x_con'], r[ykey]) for r in D])
        c = cluster_boot(D, wrs, 'chain')
        wk = cluster_boot(D, wrs, 'sw')
        lgb = cluster_boot(D, wrs, 'lid')
        pc = cluster_boot(D, sm, 'chain')
        pw = cluster_boot(D, sm, 'sw')
        print(f'   {lab} [{ykey}]: disagreement n={len(D)} of {len(sub)} (nonzero {nnz}, ties {ties:.3f}), chains={c[4]}')
        print(f'      consensus side wins {rate:.3f}  chain [{c[1]:.3f}, {c[2]:.3f}]  week [{wk[1]:.3f}, {wk[2]:.3f}]  '
              f'league [{lgb[1]:.3f}, {lgb[2]:.3f}]  MDE80 {mde80(c[3]):.3f} (chain SE {c[3]:.3f})')
        print(f'      pts/week to consensus side {pc[0]:+.3f}  chain [{pc[1]:+.3f}, {pc[2]:+.3f}]  '
              f'week [{pw[1]:+.3f}, {pw[2]:+.3f}]  MDE80 {mde80(pc[3]):.3f}')
        if gate:
            verdict = gate_verdict(rate, c[1], wk[1], pc[1])
            print(f'== GATE (prereg item 10): {verdict}  (rate {rate:.3f} >= 0.55; chain lo {c[1]:.3f} > 0.50; '
                  f'week lo {wk[1]:.3f} > 0.50; pts chain lo {pc[1]:+.3f} > 0)')
        return D

    G = [r for r in linked if r['s'] >= 2023]
    print('== PRIMARY 2023-24 pooled 1-for-1 + 2-for-1, real lineups (y_L = net_started_pts / n_h_weeks)')
    DG = block('2023-24 pooled', G, 'y_L', gate=True)
    print('== SECONDARY S1 counterfactual lineup gain (L_frozen(A) - L_frozen(B)) / n_h_weeks')
    block('2023-24 pooled', G, 'y_F')
    print('== SECONDARY S2 strata and seasons (y_L; descriptive)')
    for lab, sub in (('2023-24 1-for-1', [r for r in G if r['shape'] == '1for1']),
                     ('2023-24 2-for-1', [r for r in G if r['shape'] == '2for1']),
                     ('2021-22 pooled (curve years)', [r for r in linked if r['s'] <= 2022]),
                     ('2021-24 pooled', linked)):
        block(lab, sub, 'y_L')
    print('== DESCRIPTIVE same linked trades in PLAYER ROS points/week (r8 outcome)')
    block('2023-24 pooled', G, 'y_player_pw')

    # P1 placebo: random same-position 1-for-1 received player in the same season-week, his own real lineup starts
    pool = collections.defaultdict(list)
    for r in linked:
        if r['shape'] == '1for1':
            pool[(r['s'], r['w'], POS[r['recv'][0]])].append(r)
    prng = random.Random(3)
    plc = []
    for r in G:
        if r['shape'] != '1for1':
            continue
        cand = [c for c in pool[(r['s'], r['w'], POS[r['recv'][0]])] if c['recv'][0] != r['recv'][0]]
        if not cand:
            continue
        c = prng.choice(cand)
        sid, gv = c['recv'][0], r['give'][0]
        va, vb = v(sid, r['s'], r['w']), v(gv, r['s'], r['w'])
        sc = LEAGUES[r['lid']][1]
        fa, fb = feats(X[sid], r['s'], r['w'], sc), feats(X[gv], r['s'], r['w'], sc)
        if va is None or vb is None or not fa or not fb:
            continue
        plc.append(dict(r, x_con=va - vb, x_std=fa['std'] - fb['std'], y_L=c['recv_pw'] - r['give_pw']))
    print(f'== PLACEBO P1 (1-for-1, 2023-24, random same-position traded player, his real starts): pairs={len(plc)}')
    block('placebo', plc, 'y_L')

    # P2 null: permute x_con across graded trades within season
    prm = np.random.default_rng(5)
    by_s = collections.defaultdict(list)
    for r in G:
        by_s[r['s']].append(r)
    null = []
    for _ in range(1000):
        pairs = []
        for s_, q in by_s.items():
            xs = prm.permutation([r['x_con'] for r in q])
            pairs += [(x, r['y_L']) for x, r in zip(xs, q) if is_disagreement(x, r['x_std'])]
        null.append(win_rate(pairs)[0])
    null = np.array(null, dtype=float)
    ok = 0.47 <= null.mean() <= 0.53
    print(f'== PLACEBO P2 permutation null (1000, seed 5): mean {null.mean():.3f}, 95th pct {np.percentile(null, 95):.3f} '
          f'-> harness {"unbiased" if ok else "BIASED: result void"}')
    print(f'n disagreement graded = {len(DG) if DG else 0}; 2025 not opened (season <= 2024 in every query)')

    # POST-HOC (added after the first run's output, 2026-09-23; descriptive, never decides the gate).
    # P2 as pre-registered permutes x_con, so inside the "disagreement" set a consensus win is a season-to-date loss:
    # its null centres at 1 - P(season-to-date right), not 0.50. P2b permutes the OUTCOME within season instead,
    # which is the null that should centre at 0.50 if the harness itself is unbiased.
    print('== POST-HOC (after first output; descriptive only)')
    null_b = []
    for _ in range(1000):
        pairs = []
        for s_, q in by_s.items():
            ys = prm.permutation([r['y_L'] for r in q])
            pairs += [(r['x_con'], y) for y, r in zip(ys, q) if is_disagreement(r['x_con'], r['x_std'])]
        null_b.append(win_rate(pairs)[0])
    null_b = np.array(null_b, dtype=float)
    print(f'   P2b outcome-permutation null (1000): mean {null_b.mean():.3f}, 5th {np.percentile(null_b, 5):.3f}, '
          f'95th {np.percentile(null_b, 95):.3f}')
    std_right = win_rate([(-r['x_con'], r['y_L']) for r in G if is_disagreement(r['x_con'], r['x_std'])])[0]
    print(f'   season-to-date side wins on the real 2023-24 disagreement trades = {std_right:.3f} (= 1 - primary rate)')
    for lab, sub in (('2023-24', [r for r in G if r['shape'] == '2for1']),
                     ('2021-22', [r for r in linked if r['s'] <= 2022 and r['shape'] == '2for1'])):
        D2 = [r for r in sub if is_disagreement(r['x_con'], r['x_std'])]
        two = [r for r in D2 if (len(r['recv']) == 2) == (r['x_con'] > 0)]   # consensus favours the 2-player side
        one = [r for r in D2 if r not in two]
        f = lambda q: win_rate([(r['x_con'], r['y_L']) for r in q])
        print(f'   2-for-1 {lab}: consensus favours the 2-player side in {len(two)} of {len(D2)} disagreement trades; '
              f'consensus wins {f(two)[0]:.3f} there vs {f(one)[0] if one else float("nan"):.3f} when it favours the 1-player side '
              f'(n={len(one)})')
    for lab, sub, k in (('2021-22 1-for-1', [r for r in linked if r['s'] <= 2022 and r['shape'] == '1for1'], 'y_L'),
                        ('2021-22 2-for-1', [r for r in linked if r['s'] <= 2022 and r['shape'] == '2for1'], 'y_L'),
                        ('2023-24 1-for-1 player ROS pts', [r for r in G if r['shape'] == '1for1'], 'y_player_pw')):
        block(lab, sub, k)


if __name__ == '__main__':
    main()
