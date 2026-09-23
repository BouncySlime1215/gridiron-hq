"""RL-8-2b: one pre-registered look at Sleeper 2025 trades for the Trade Machine split.

Pre-registration (committed before this script existed, eea0a3bd):
  docs/evidence/2026-09-23/trade-split-2025-preregistration.md
  (a) 1-for-1: consensus-favoured side wins > 0.55 of disagreement trades, chain-clustered 90% lower bound > 0.50.
  (b) 2-for-1 + 2-for-2: PR #200's lineup value with the roster-spot charge names the lineup-points winner > 0.55,
      chain lower bound > 0.50, and summed consensus (RL-8-2's x_con) <= 0.50 on the same trades.

Reuses RL-8-2 (scripts/rnd/consensus_vs_humans_lineup.py, PR #196) unchanged: orientation, value_diff,
disagreement, win_rate, signed_mean, cluster_boot, mde80, and its data recipe (ECR board, 2021-22 curve, feats).
Lineup fill: rnd/skill/trades/tr_common.py fill_lineup / starting_slots (the skill study's solver).

Read-only sources (aggregates printed; no league or manager names):
  trade_sides   rnd/skill/team_seasons.sqlite, writer rnd/skill/build_03_leagues.py:386-398
  sides_ext     rnd/skill/trades/trades_ext.sqlite, writer rnd/skill/trades/tr_01_sides.py:150-196
  sh_*          data/derived/sleeper_history.sqlite (immutable)
  nfl_ffopportunity_weekly  a .backup copy of data.sqlite (never the live file)

Run once (about 3 minutes):
  nice -n 10 python3 scripts/rnd/trade_split_2025.py --local-db .local-db/data.sqlite
"""
import collections
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import consensus_vs_humans_lineup as C  # noqa: E402

SEASON = 2025
SKILL_SLOTS = ('QB', 'RB', 'WR', 'TE', 'WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPER_FLEX')


def orient_any(rids, adds, drops, rng, rng2, rng3):
    """RL-8-2's orient for 1-for-1 / 2-for-1; 2-for-2 draws side A with its own rng3 (other streams untouched)."""
    if len(adds) in (2, 3):
        return C.orient(rids, adds, drops, rng, rng2)
    if len(rids) != 2 or set(adds) != set(drops) or len(adds) != 4:
        return None
    a = rng3.choice(rids)
    recv = [p for p, r in adds.items() if r == a]
    give = [p for p, r in drops.items() if r == a]
    if (len(recv), len(give)) != (2, 2):
        return None
    return a, recv, give, '2for2'


def lineup_value(roster, gives, gets, rate, pos, points, wire):
    """PR #200's lineupValue (server/services/trade-engine.js) replayed on one historical side, per week.

    roster = the side's players before the trade; rate = {player: points per game} (missing -> 0, the product's
    `?? 0`); points(list) = best starting lineup points; wire = unrostered candidate players. Roster size is held:
    each freed spot is filled from the wire (best free agent per position, then the one that raises the lineup
    most; ties -> higher rate), each needed spot drops the player whose loss costs the lineup least (ties ->
    lower rate).
    """
    r = lambda p: rate.get(p) or 0.0  # noqa: E731
    before = points(roster)
    gv = set(gives)
    cur = [p for p in roster if p not in gv] + list(gets)
    spots = len(gets) - len(gives)
    replacement, dropped = [], []
    for _ in range(-spots):
        held = set(cur)
        best_at = {}
        for fa in wire:
            ps = pos.get(fa)
            if fa in held or ps not in C.SKILL:
                continue
            c = best_at.get(ps)
            if c is None or r(fa) > r(c):
                best_at[ps] = fa
        pick, pick_pts = None, float('-inf')
        for fa in best_at.values():
            pts = points(cur + [fa])
            if pts > pick_pts or (pts == pick_pts and r(fa) > r(pick)):
                pick, pick_pts = fa, pts
        if pick is None:
            break
        cur.append(pick)
        replacement.append(pick)
    for _ in range(spots):
        cut, cut_pts = None, float('-inf')
        for p in cur:
            pts = points([q for q in cur if q != p])
            if pts > cut_pts or (pts == cut_pts and r(p) < r(cut)):
                cut, cut_pts = p, pts
        if cut is None:
            break
        cur = [q for q in cur if q != cut]
        dropped.append(cut)
    return dict(per_week=round(points(cur) - before, 4), roster_spots=spots, replacement=replacement,
                dropped=dropped, unfilled_spots=max(0, -spots - len(replacement)))


def verdict_a(rate, lo):
    if rate is None or lo is None:
        return 'FAIL'
    return 'PASS' if rate > 0.55 and lo > 0.50 else 'FAIL'


def verdict_b(rate, lo, con_rate):
    if rate is None or lo is None or con_rate is None:
        return 'FAIL'
    return 'PASS' if rate > 0.55 and lo > 0.50 and con_rate <= 0.50 else 'FAIL'


def skill_slots(slots):
    if slots is None:
        return None
    return [s for s in slots if s in SKILL_SLOTS]


def pick_rate(rows, mkey, ykey):
    """Share of rows (model != 0, outcome != 0) where the model's side won. Returns (rate, n, tie_share)."""
    return C.win_rate([(r[mkey], r[ykey]) for r in rows if r[mkey] != 0])


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
    ap.add_argument('--season', type=int, default=SEASON)
    ap.add_argument('--smoke', action='store_true',
                    help='engineering check: run every step but print counts only, never a rate (no outcome read)')
    args = ap.parse_args()
    if os.path.realpath(args.local_db) == os.path.realpath(os.path.join(args.gl, 'data.sqlite')):
        raise SystemExit('refusing to read the live data.sqlite; pass a .backup copy')
    GL = args.gl
    sys.path.insert(0, GL + '/rnd/skill/trades')
    import tr_common as T
    SP = GL + '/rnd/moonshots/spike/'
    X = json.load(open(SP + 'sleeper_to_gsis.json'))
    POS = json.load(open(SP + 'sleeper_positions.json'))
    sh = sqlite3.connect(f'file:{args.repo_data}/derived/sleeper_history.sqlite?immutable=1', uri=True)
    nv = sqlite3.connect(f'file:{args.repo_data}/line-history/nflverse.sqlite?mode=ro', uri=True)
    lo = sqlite3.connect(f'file:{args.local_db}?mode=ro', uri=True)
    ts = sqlite3.connect(f'file:{GL}/rnd/skill/team_seasons.sqlite?mode=ro', uri=True)
    tx = sqlite3.connect(f'file:{GL}/rnd/skill/trades/trades_ext.sqlite?mode=ro', uri=True)
    print('local copy, not production (nfl_ffopportunity_weekly read from a .backup of data.sqlite)')
    S0, S1 = 2021, max(SEASON, args.season)
    SEA = args.season
    say = (lambda *a_, **k_: None) if args.smoke else print
    if args.smoke:
        print(f'SMOKE RUN on season {SEA}: counts only, no rate, CI or verdict is printed')

    # --- RL-8-2 inputs (its recipe, seasons extended to 2025) --------------------------------------------------------
    LEAGUES = {l: (s, sc) for l, s, sc in sh.execute(
        "select league_id, season, scoring from sh_leagues where season between ? and ?", (S0, S1))}
    PTS = collections.defaultdict(dict)
    for g, s, w, fs, fp in nv.execute(
            "select player_id, season, week, fantasy_points, fantasy_points_ppr from stats_player_week "
            "where season between ? and ? and season_type='REG' and week<=18", (S0, S1)):
        PTS[(g, s)][w] = (fs or 0.0, fp or 0.0)
    FF = collections.defaultdict(dict)
    for g, s, w, x, a in lo.execute(
            "select player_gsis_id, season, week, expected_fantasy_points, actual_fantasy_points "
            "from nfl_ffopportunity_weekly where season between ? and ? and expected_fantasy_points is not null",
            (S0, S1)):
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
        return dict(std=std, ros=sum(score(wk[k], sc) for k in rw if k in wk) / len(rw))

    ids = list(csv.DictReader(open(GL + '/rnd/loop/data/dp/db_playerids.csv')))
    g2fp = {r['gsis_id']: r['fantasypros_id'] for r in ids if r['fantasypros_id'] and r['gsis_id'] not in ('', 'NA')}
    e = pd.read_parquet(GL + '/rnd/loop/data/dp/fpecr_redraft_rp.parquet')
    e['d'] = pd.to_datetime(e.scrape_date.astype(str)).dt.date
    e = e[pd.to_datetime(e.scrape_date.astype(str)).dt.year <= S1]
    e = e[e.page_type.isin(['redraft-qb', 'redraft-rb', 'redraft-wr', 'redraft-te'])].copy()
    sun = collections.defaultdict(lambda: dt.date.min)
    for s_, w_, gd in nv.execute("select season,week,gameday from games where game_type='REG' and season between ? and ?",
                                 (S0, S1)):
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
    for pos_, g in R6.groupby('pos'):
        m = g.groupby('b').v.mean().sort_index()
        vals = list(m.values)
        for k in range(1, len(vals)):
            vals[k] = min(vals[k], vals[k - 1])
        CURVE[pos_] = dict(zip(m.index, vals))

    def curve_at(pos_, k):
        cv = CURVE[pos_]
        return cv.get(k, cv[max(cv)] if k > max(cv) else None)

    REPL = {p: float(curve_at(p, (C.REPL_RANK[p] - 1) // 3)) for p in C.SKILL}
    print('replacement PPG from the 2021-22 curve at ranks', C.REPL_RANK, '->', {p: round(v, 2) for p, v in REPL.items()})

    def v(pid, s, w):
        g = X.get(pid)
        b = BOARD.get((s, w))
        fp = g2fp.get(g)
        if not b or fp not in b or POS.get(pid) not in C.SKILL:
            return None
        return curve_at(POS[pid], int((b[fp] - 1) // 3))

    def build_rows(s_lo, s_hi, n_adds, seeds):
        rng, rng2, rng3 = (random.Random(x) for x in seeds)
        out = []
        for lid, w, rids, adds, drops, picks in sh.execute(
                "select t.league_id, t.week, t.roster_ids_json, t.adds_json, t.drops_json, t.draft_picks "
                "from sh_transactions t join sh_leagues l on l.league_id=t.league_id "
                "where l.season between ? and ? and t.type='trade' and t.status='complete'", (s_lo, s_hi)):
            s, sc = LEAGUES[lid]
            rids = json.loads(rids)
            adds = json.loads(adds or '{}')
            drops = json.loads(drops or '{}')
            if len(rids) != 2 or (picks and picks not in ('[]', 'null')):
                continue
            if set(adds) != set(drops) or len(adds) not in n_adds or not (4 <= w <= 14):
                continue
            o = orient_any(rids, adds, drops, rng, rng2, rng3)
            if o is None:
                continue
            a, recv, give, shape = o
            players = recv + give
            if any(POS.get(p) not in C.SKILL or p not in X for p in players):
                continue
            F = {p: feats(X[p], s, w, sc) for p in players}
            if not all(F.values()):
                continue
            vals = {p: v(p, s, w) for p in players}
            if any(x is None for x in vals.values()):
                continue
            x_con = C.value_diff([(vals[p], POS[p]) for p in recv], [(vals[p], POS[p]) for p in give], shape, REPL)
            x_std = C.value_diff([(F[p]['std'], POS[p]) for p in recv], [(F[p]['std'], POS[p]) for p in give], shape,
                                 REPL)
            out.append(dict(lid=lid, s=s, w=w, a=a, b=[r for r in rids if r != a][0], recv=recv, give=give,
                            shape=shape, x_con=x_con, x_std=x_std,
                            x_raw=sum(vals[p] for p in recv) - sum(vals[p] for p in give),
                            y_player=sum(F[p]['ros'] for p in recv) - sum(F[p]['ros'] for p in give)))
        return out

    # --- C1 reproduction control on used data (2021-24, RL-8-2's settings), before any 2025 number -------------------
    ctl = build_rows(2021, 2024, (2, 3), (7, 8, 9))
    r8 = [r for r in ctl if r['shape'] == '1for1' and r['s'] >= 2023]
    D8 = [r for r in r8 if C.is_disagreement(r['x_con'], r['x_std'])]
    est, l5, h95, _, nl = C.cluster_boot(D8, lambda q: C.win_rate([(r['x_con'], r['y_player']) for r in q])[0], 'lid')
    print(f'== C1 reproduction (1-for-1, 2023-24, player ROS points, league-clustered): n={len(D8)} of {len(r8)}, '
          f'leagues={nl}: {est:.3f} [{l5:.3f}, {h95:.3f}]  (r8 printed n=210 of 723, 0.576 [0.515, 0.633])')
    if len(D8) != 210 or round(est, 3) != 0.576:
        raise SystemExit('C1 reproduction control failed; stopping before any 2025 number')
    del ctl, r8, D8

    # --- 2025 sample ----------------------------------------------------------------------------------------------
    rows = build_rows(SEA, SEA, (2, 3, 4), (7, 8, 9))
    shp = collections.Counter(r['shape'] for r in rows)
    print(f'== {SEA} trades on the board: {dict(shp)}, leagues={len({r["lid"] for r in rows})}')

    LG = {lid: i for i, (lid,) in enumerate(sh.execute('select league_id from sh_leagues order by league_id'), 1)}
    TS = collections.defaultdict(list)
    for lg, s, idx, rid, prid, lw, rp, gp, rs, gs, ns in ts.execute(
            "select lg, season, trade_idx, roster_id, partner_roster_id, leg_week, recv_players, give_players, "
            "recv_started_pts, give_started_by_partner_pts, net_started_pts from trade_sides "
            "where season = ? and n_partners = 1 and has_picks = 0", (SEA,)):
        key = (lg, rid, lw, frozenset(rp.split(',')) if rp else frozenset(), frozenset(gp.split(',')) if gp else frozenset())
        TS[key].append(dict(s=s, idx=idx, prid=prid, recv_started=rs, give_started=gs, net_started=ns))
    SX = {}
    for lg, s, idx, rid, nh, w0, lr, el in tx.execute(
            "select lg, season, trade_idx, roster_id, n_h_weeks, w0, L_rule, E_L from sides_ext where season = ?",
            (SEA,)):
        SX[(lg, s, idx, rid)] = dict(nh=nh, w0=w0, L_rule=lr, E_L=el)
    CH = {tsid: ch for tsid, ch in ts.execute("select ts_id, chain from team_seasons where season = ?", (SEA,))}
    PT = {(lg, rid): p for lg, rid, p in ts.execute(
        "select lg, roster_id, sum(pts_trade) from team_weeks where season = ? group by lg, roster_id", (SEA,))}
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
        if not sa or not sb or not sa['nh']:
            miss['sides_ext missing or no horizon week'] += 1
            continue
        nh = sa['nh']
        if t['recv_started'] > 0:
            tw_n += 1
            tw_ok += (PT.get((lg, r['a'])) or 0) >= t['recv_started'] - 0.5
        r.update(lg=lg, chain=CH.get(lg * 100 + r['a']), sw=(r['s'], r['w']), nh=nh, w0=sa['w0'],
                 y_L=C.per_week(t['net_started'], nh), y_R=C.per_week(sa['L_rule'] - sb['L_rule'], nh),
                 d_EL=sa['E_L'] - sb['E_L'], recv_pw=C.per_week(t['recv_started'], nh),
                 give_pw=C.per_week(t['give_started'], nh))
        linked.append(r)
    print(f'== C2 linkage: linked {len(linked)} of {len(rows)}; unlinked {dict(miss)}')
    tw_share = tw_ok / tw_n if tw_n else 0.0
    print(f'== C2 team_weeks.pts_trade >= recv_started_pts: {tw_ok} of {tw_n} ({tw_share:.3f}); must be >= 0.95')
    if tw_share < 0.95 or any(r['chain'] is None for r in linked):
        raise SystemExit('C2 linkage control failed; stopping')

    def ci(rows_, stat, key):
        return C.cluster_boot(rows_, stat, key)

    def placebo_p2b(rows_, mkey, ykey, seed=5, reps=1000):
        if args.smoke:
            return 0.5, 0.0, 0.0
        prm = np.random.default_rng(seed)
        ys = [r[ykey] for r in rows_]
        null = []
        for _ in range(reps):
            yp = prm.permutation(ys)
            null.append(C.win_rate([(r[mkey], y) for r, y in zip(rows_, yp) if r[mkey] != 0])[0])
        null = np.array([x for x in null if x is not None], dtype=float)
        return null.mean(), np.percentile(null, 5), np.percentile(null, 95)

    def report(lab, rows_, mkey, ykey):
        rate, nnz, ties = pick_rate(rows_, mkey, ykey)
        if args.smoke:
            print(f'   {lab} [{mkey} -> {ykey}]: n={len(rows_)} (nonzero {nnz})')
            return 0.0, (0.0, 0.0, 0.0, 0.0, 0)
        wr = lambda q: pick_rate(q, mkey, ykey)[0]  # noqa: E731
        sm = lambda q: C.signed_mean([(r[mkey], r[ykey]) for r in q if r[mkey] != 0])  # noqa: E731
        c, wk, lgb, pc = ci(rows_, wr, 'chain'), ci(rows_, wr, 'sw'), ci(rows_, wr, 'lid'), ci(rows_, sm, 'chain')
        print(f'   {lab} [{mkey} -> {ykey}]: n={len(rows_)} (nonzero {nnz}, ties {ties:.3f}), chains={c[4]}')
        print(f'      model side wins {rate:.3f}  chain [{c[1]:.3f}, {c[2]:.3f}]  week [{wk[1]:.3f}, {wk[2]:.3f}]  '
              f'league [{lgb[1]:.3f}, {lgb[2]:.3f}]  MDE80 {C.mde80(c[3]):.3f} (chain SE {c[3]:.3f})')
        print(f'      pts/week to model side {pc[0]:+.3f}  chain [{pc[1]:+.3f}, {pc[2]:+.3f}]  MDE80 {C.mde80(pc[3]):.3f}')
        return rate, c

    # --- arm (a): 1-for-1 consensus edge ----------------------------------------------------------------------------
    one = [r for r in linked if r['shape'] == '1for1']
    DA = [r for r in one if C.is_disagreement(r['x_con'], r['x_std'])]
    print(f'== ARM (a) 1-for-1 {SEA}, disagreement trades {len(DA)} of {len(one)}')
    pm = placebo_p2b(DA, 'x_con', 'y_L')
    print(f'   P2b outcome-permutation null (1000, seed 5): mean {pm[0]:.3f}, 5th {pm[1]:.3f}, 95th {pm[2]:.3f}')
    void_a = not (0.47 <= pm[0] <= 0.53)
    rate_a, c_a = report('(a) PRIMARY', DA, 'x_con', 'y_L')
    va = 'VOID' if void_a else verdict_a(rate_a, c_a[1])
    say(f'== VERDICT (a): {va}  (rate {rate_a:.3f} > 0.55; chain lo {c_a[1]:.3f} > 0.50)')
    say(f'   decision win rate: consensus pick {rate_a:.3f} vs season-to-date pick {1 - rate_a:.3f} (same trades)')
    report('(a) S1 whole-roster rule lineups', DA, 'x_con', 'y_R')
    report('(a) S3 all 1-for-1 incl. agreement', one, 'x_con', 'y_L')
    pool = collections.defaultdict(list)
    for r in one:
        pool[(r['w'], POS[r['recv'][0]])].append(r)
    prng = random.Random(3)
    plc = []
    for r in DA:
        cand = [c for c in pool[(r['w'], POS[r['recv'][0]])] if c['recv'][0] != r['recv'][0]]
        if not cand:
            continue
        c = prng.choice(cand)
        sid, gv = c['recv'][0], r['give'][0]
        va_, vb_ = v(sid, r['s'], r['w']), v(gv, r['s'], r['w'])
        sc = LEAGUES[r['lid']][1]
        fa, fb = feats(X[sid], r['s'], r['w'], sc), feats(X[gv], r['s'], r['w'], sc)
        if va_ is None or vb_ is None or not fa or not fb:
            continue
        x_c, x_s = va_ - vb_, fa['std'] - fb['std']
        if C.is_disagreement(x_c, x_s):
            plc.append(dict(r, x_con=x_c, x_std=x_s, y_L=c['recv_pw'] - r['give_pw']))
    print(f'   P1 placebo (random same-position 1-for-1 received player, same week): pairs={len(plc)}')
    if plc:
        report('(a) P1 placebo', plc, 'x_con', 'y_L')

    # --- arm (b): lineup value with the roster-spot charge ------------------------------------------------------------
    lid_of = {i: lid for lid, i in LG.items()}
    SLOTS, ROST = {}, {}
    need = {(r['lid'], r['w0']) for r in linked if r['shape'] != '1for1'}
    for lid in {k[0] for k in need}:
        rp = json.loads(sh.execute("select roster_positions from sh_leagues where league_id=?", (lid,)).fetchone()[0]
                        or '[]')
        SLOTS[lid] = skill_slots(T.starting_slots(rp))
        wks = {k[1] for k in need if k[0] == lid}
        for rid, w, pj in sh.execute("select roster_id, week, players_json from sh_team_weeks where league_id=?", (lid,)):
            if w in wks:
                ROST[(lid, rid, w)] = [p for p in json.loads(pj or '[]') if p and p != '0']
    FP2S = collections.defaultdict(list)
    for sid, g in X.items():
        if POS.get(sid) in C.SKILL and g2fp.get(g):
            FP2S[g2fp[g]].append(sid)
    WIRE = {}

    def wire_for(s, w):
        if (s, w) not in WIRE:
            b = BOARD.get((s, w), {})
            WIRE[(s, w)] = sorted({sid for fp in b for sid in FP2S.get(fp, ())},
                                  key=lambda p: (-(v(p, s, w) or 0.0), p))
        return WIRE[(s, w)]

    skipb = collections.Counter()
    B = []
    fired = unfilled = 0
    wire_n = []
    for r in linked:
        if r['shape'] == '1for1':
            continue
        slots = SLOTS.get(r['lid'])
        pa, pb = ROST.get((r['lid'], r['a'], r['w0'])), ROST.get((r['lid'], r['b'], r['w0']))
        if not slots:
            skipb['IDP or unknown slots'] += 1
            continue
        if pa is None or pb is None:
            skipb['roster missing at w0'] += 1
            continue
        rostered = {p for (l_, _, w_), ps in ROST.items() if l_ == r['lid'] and w_ == r['w0'] for p in ps}
        wire = [p for p in wire_for(r['s'], r['w']) if p not in rostered]
        pre_a = [p for p in pa if p not in set(r['recv'])] + [p for p in r['give'] if p not in pa]
        pre_b = [p for p in pb if p not in set(r['give'])] + [p for p in r['recv'] if p not in pb]
        allp = set(pre_a) | set(pre_b) | set(r['recv']) | set(r['give']) | set(wire)
        rate = {p: (v(p, r['s'], r['w']) or 0.0) for p in allp}
        pos_of = {p: POS.get(p) for p in allp}

        def points(lst, slots=slots, rate=rate):
            ch = T.fill_lineup([p for p in lst if pos_of.get(p) in C.SKILL], slots, lambda p: rate.get(p, 0.0), POS)
            return sum(rate.get(p, 0.0) for p in ch if p is not None)
        la = lineup_value(pre_a, r['give'], r['recv'], rate, pos_of, points, wire)
        lb = lineup_value(pre_b, r['recv'], r['give'], rate, pos_of, points, wire)
        unfilled += la['unfilled_spots'] + lb['unfilled_spots']
        wire_n.append(len(wire))
        fired += bool(la['replacement'] or la['dropped']) + bool(lb['replacement'] or lb['dropped'])
        r['D_LV'] = la['per_week'] - lb['per_week']
        B.append(r)
    print(f'== ARM (b) 2-for-1 + 2-for-2 {SEA}: modelled {len(B)} of {sum(r["shape"] != "1for1" for r in linked)} '
          f'linked; skipped {dict(skipb)}')
    GB = [r for r in B if r['y_L'] != 0 and r['D_LV'] != 0 and r['x_con'] != 0]
    DEC = [r for r in GB if (r['D_LV'] > 0) != (r['x_con'] > 0)]
    print(f'== C3 model non-degenerate: graded {len(GB)} (y_L, D_LV, x_con all non-zero); LV and x_con picks differ '
          f'on {len(DEC)}; sides where the roster-spot charge fired (fill or drop) = {fired}; unfilled spots = {unfilled}; '
          f'wire size median {sorted(wire_n)[len(wire_n) // 2] if wire_n else 0}')
    if not DEC or not fired:
        raise SystemExit('C3 model control failed; stopping before any arm (b) rate')
    pm = placebo_p2b(GB, 'D_LV', 'y_L')
    print(f'   P2b outcome-permutation null (1000, seed 5): mean {pm[0]:.3f}, 5th {pm[1]:.3f}, 95th {pm[2]:.3f}')
    void_b = not (0.47 <= pm[0] <= 0.53)
    rate_b, c_b = report('(b) PRIMARY lineup value', GB, 'D_LV', 'y_L')
    con_b = pick_rate(GB, 'x_con', 'y_L')[0]
    report('(b) baseline summed consensus x_con', GB, 'x_con', 'y_L')
    vb = 'VOID' if void_b else verdict_b(rate_b, c_b[1], con_b)
    say(f'== VERDICT (b): {vb}  (LV rate {rate_b:.3f} > 0.55; chain lo {c_b[1]:.3f} > 0.50; '
          f'x_con rate {con_b:.3f} <= 0.50)')
    say(f'   decision win rate: LV pick {rate_b:.3f} vs x_con pick {con_b:.3f} (same {len(GB)} trades)')
    report('(b) decision subset (LV and x_con picks differ)', DEC, 'D_LV', 'y_L')
    for lab, sh_ in (('2-for-1', '2for1'), ('2-for-2', '2for2')):
        sub = [r for r in GB if r['shape'] == sh_]
        if sub:
            report(f'(b) {lab} only', sub, 'D_LV', 'y_L')
            say(f'      x_con on the same {lab}: {pick_rate(sub, "x_con", "y_L")[0]:.3f}')
    report('(b) S1 whole-roster rule lineups', GB, 'D_LV', 'y_R')
    say(f'   (b) S2 frozen-roster E_L pick (no spot charge): {pick_rate(GB, "d_EL", "y_L")[0]:.3f}; '
          f'raw summed consensus: {pick_rate(GB, "x_raw", "y_L")[0]:.3f}')
    say(f'== SUMMARY: (a) {va}; (b) {vb}. 2025 opened once by this run; 2026 forward check not run '
          f'(no 2026 Sleeper trade outcomes pulled). Season graded: {SEA}.')


if __name__ == '__main__':
    main()
