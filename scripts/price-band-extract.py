#!/usr/bin/env python3
"""
PRICE-BAND-01 step 1 of 2: turn executed Sleeper trades into one clearing price per trade.

Output: a CSV of (season, league_key, week, r, r_ros, n_get, n_give), one row per usable trade.
  r      = consensus value the SELLER receives / value the seller gives (ECR -> ROS-points proxy).
  r_ros  = the same ratio on realized rest-of-season points (sensitivity only).
  league_key = first 12 hex chars of sha256(league_id), so the file carries no raw ids.
Step 2 (scripts/price-band-calibrate.mjs) fits the band on 2021-22 and grades 2023-24 from it.

The trade filter and the ECR proxy are the C2-BASE / IDEA-110 ones, unchanged:
  2-team, no picks, fresh window weeks 3-12, every player mapped to gsis and priced by an as-of
  FantasyPros ECR scrape (<= trade date, within 8 days). The ECR -> ROS-ppg proxy is calibrated
  on 2021-22 only. Buyer = the side that receives the single highest-value player; seller = the other.
  That matches the engine's ladder, where ratio = what I give (seller receives) / the target's value.

Seasons: SQL is bounded to 2021-2024. 2025 is never selected.

    /usr/local/bin/python3 scripts/price-band-extract.py \
        --sleeper <sleeper_history.sqlite> --nflverse <nflverse.sqlite> \
        --ids <db_playerids.csv> --ecr <fpecr_redraft_rp.parquet> --out <trades.csv>

All inputs are opened read-only. Prints aggregate counts only.
"""
import argparse, collections, csv, datetime as dt, hashlib, json, sqlite3, sys

import pandas as pd

SEASONS = (2021, 2024)          # inclusive; 2025 is out of bounds by construction
FIT_SEASONS = (2021, 2022)      # proxy calibration only


def ro(path):
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for k in ('sleeper', 'nflverse', 'ids', 'ecr', 'out'):
        ap.add_argument(f'--{k}', required=True)
    a = ap.parse_args(argv)

    nfl, sh = ro(a.nflverse), ro(a.sleeper)
    ids = list(csv.DictReader(open(a.ids)))
    bad = ('', 'NA')
    sl2g = {r['sleeper_id']: r['gsis_id'] for r in ids if r['sleeper_id'] not in bad and r['gsis_id'] not in bad}
    fp2g = {r['fantasypros_id']: r['gsis_id'] for r in ids if r['fantasypros_id'] and r['gsis_id'] not in bad}

    pts = collections.defaultdict(dict)
    for pid, s, w, f in nfl.execute(
            "select player_id,season,week,fantasy_points_ppr from stats_player_week where season_type='REG' "
            "and season between ? and ? and position in ('QB','RB','WR','TE')", SEASONS):
        pts[pid][(s, w)] = f or 0.0
    sunday = {}
    for s, w, gd, wd in nfl.execute(
            "select season,week,gameday,weekday from games where game_type='REG' and season between ? and ?", SEASONS):
        if wd == 'Sunday':
            d = dt.date.fromisoformat(gd)
            sunday[(s, w)] = min(sunday.get((s, w), d), d)

    def utc(d, h):
        return dt.datetime(d.year, d.month, d.day, h, tzinfo=dt.timezone.utc).timestamp() * 1000
    win = [(utc(d + dt.timedelta(days=2), 8), utc(sunday[(s, w + 1)], 17), s, w)
           for (s, w), d in sunday.items() if (s, w + 1) in sunday]

    def fresh_week(s, ms):
        for lo, hi, ss, w in win:
            if ss == s and lo <= ms < hi:
                return w
        return None

    e = pd.read_parquet(a.ecr)
    e = e[e.page_type.isin(['redraft-qb', 'redraft-rb', 'redraft-wr', 'redraft-te'])].copy()
    e['pos'] = e.page_type.str[-2:].str.upper()
    e['d'] = pd.to_datetime(e.scrape_date.astype(str)).dt.date
    e['g'] = e.id.astype(str).map(fp2g)
    e = e[e.g.notna()]
    scr = sorted(e.d.unique())
    ecr = {(r.d, r.g): (r.pos, r.ecr) for r in e.itertuples()}

    acc = collections.defaultdict(list)
    for s in FIT_SEASONS:
        for w in range(3, 13):
            sd = sunday[(s, w)]
            ds = [d for d in scr if sd - dt.timedelta(days=6) <= d <= sd]
            if not ds:
                continue
            m = max(ds)
            for (d, g), (p, rk) in ecr.items():
                if d != m:
                    continue
                fut = sum(pts[g].get((s, k), 0.0) for k in range(w + 1, 18))
                acc[(p, int((rk - 1) // 4))].append(fut / (17 - w))
    proxy = {k: sum(v) / len(v) for k, v in acc.items()}
    pmin = min(proxy.values())

    q = """select t.league_id,l.season,t.adds_json,t.roster_ids_json,t.draft_picks,t.created_ms
           from sh_transactions t join sh_leagues l using(league_id)
           where t.type='trade' and t.status='complete' and l.season between ? and ?"""
    out, why = [], collections.Counter()
    for lg, s, adds, rids, dp, ms in sh.execute(q, SEASONS):
        assert SEASONS[0] <= s <= SEASONS[1]
        am = json.loads(adds or '{}')
        rr = json.loads(rids or '[]')
        if dp or len(rr) != 2 or len(set(am.values())) != 2:
            why['picks/not 2-team'] += 1; continue
        w = fresh_week(s, ms)
        if w is None or not 3 <= w <= 12:
            why['outside fresh window w3-12'] += 1; continue
        gs = {k: sl2g.get(k) for k in am}
        if None in gs.values():
            why['unmapped player'] += 1; continue
        d = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).date()
        ds = [x for x in scr if d - dt.timedelta(days=8) <= x <= d]
        if not ds:
            why['no ecr scrape'] += 1; continue
        m = max(ds)
        side, ok = collections.defaultdict(list), True
        for k, g in gs.items():
            er = ecr.get((m, g))
            if er is None:
                ok = False; break
            v = max(0.0, proxy.get((er[0], int((er[1] - 1) // 4)), pmin) * (17 - w))
            ros = sum(pts[g].get((s, k2), 0.0) for k2 in range(w + 1, 18))
            side[am[k]].append((v, ros))
        if not ok:
            why['player without ECR'] += 1; continue
        sides = list(side.values())
        buyer = max(sides, key=lambda L: max(x[0] for x in L))
        seller = [L for L in sides if L is not buyer][0]   # adds are keyed to the receiver
        s_get, s_give = sum(x[0] for x in seller), sum(x[0] for x in buyer)
        s_get_r, s_give_r = sum(x[1] for x in seller), sum(x[1] for x in buyer)
        if s_give <= 0:
            why['target valued 0'] += 1; continue
        out.append(dict(season=s, league_key=hashlib.sha256(str(lg).encode()).hexdigest()[:12], week=w,
                        r=round(s_get / s_give, 6),
                        r_ros=round(s_get_r / s_give_r, 6) if s_give_r > 0 else '',
                        n_get=len(seller), n_give=len(buyer)))

    with open(a.out, 'w', newline='') as f:
        wr = csv.DictWriter(f, fieldnames=['season', 'league_key', 'week', 'r', 'r_ros', 'n_get', 'n_give'])
        wr.writeheader(); wr.writerows(out)
    by = collections.Counter(r['season'] for r in out)
    print(json.dumps({'usable_by_season': dict(sorted(by.items())), 'dropped': dict(why), 'out_rows': len(out)}),
          file=sys.stderr)


if __name__ == '__main__':
    main()
