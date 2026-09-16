#!/usr/bin/env python3
"""
DATA WIRING PART 2 (LATEST-PLAN "PREREGISTERED — DATA WIRING, PART 2"):
W8 player feature vectors, W9 weekly player tables, W10 last-season tables,
W11 preseason talent, W12 luck regression, W13 everything prior-week.
Same weekly walk-forward ridge as wired.py, on a precomputed feature matrix.
Reads the live database read-only.

Output: docs/evidence/2026-09-16/model-lab/wired2-preds.jsonl
"""
import json, math, sqlite3
from collections import defaultdict
from pathlib import Path
import numpy as np
import wired

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs/evidence/2026-09-16/model-lab/wired2-preds.jsonl"
ALIAS = {"LA": "LAR", "WSH": "WAS", "JAC": "JAX", "LVR": "LV", "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "SL": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR",
         # Pro-Football-Reference / fantasy-site codes, added before scoring after the first build reported them unmatched.
         "GNB": "GB", "GBP": "GB", "KAN": "KC", "KCC": "KC", "NWE": "NE", "NEP": "NE", "NOR": "NO", "NOS": "NO",
         "SFO": "SF", "TAM": "TB", "TBB": "TB", "LAR": "LAR"}
# Multi-team (2TM/3TM), free agents (FA) and blanks legitimately belong to no single team and stay unmatched.
unmatched = defaultdict(int)
VALID = set()


def norm(t):
    t = ALIAS.get((t or "").upper(), (t or "").upper())
    if t not in VALID:
        unmatched[t] += 1
    return t


def grp(pos):
    pos = (pos or "").upper()
    return pos if pos in ("QB", "RB", "WR", "TE") else "OTHER"


def nums(d):
    return {k: float(v) for k, v in d.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)}


def trailing(team_rows, half_life=12):
    """team_rows: team -> [(season, week, dict)] sorted. Returns agg(s, w, team)."""
    cache = {}
    def agg(s, w, t):
        k = (s, w, t)
        if k not in cache:
            hist = [d for (ss, ww, d) in team_rows.get(t, []) if (ss == s and ww < w) or ss == s - 1]
            out = None
            if hist:
                n = len(hist); acc, wt = defaultdict(float), defaultdict(float)
                for i, d in enumerate(hist):
                    wi = 0.5 ** ((n - 1 - i) / half_life)
                    for key, x in d.items():
                        acc[key] += wi * x; wt[key] += wi
                out = {key: acc[key] / wt[key] for key in acc}
            cache[k] = out
        return cache[k]
    return agg


def w8_player_vectors():
    acc = {}
    for s, w, t, pos, js in wired.con().execute(
            "SELECT season, week, team, position, vector_json FROM nfl_player_feature_vectors WHERE season BETWEEN 2022 AND 2025"):
        k = (s, w, norm(t))
        g = grp(pos)
        d = acc.setdefault(k, {})
        for key, v in nums(json.loads(js)).items():
            fk = f"{g}:{key}"
            a = d.get(fk)
            d[fk] = (v, 1) if a is None else (a[0] + v, a[1] + 1)
    return {k: {fk: sv / c for fk, (sv, c) in d.items()} for k, d in acc.items()}


def w9_weekly_player_tables():
    c = wired.con()
    tw = defaultdict(dict)
    cols = ["attempts", "carries", "targets", "receptions", "receiving_air_yards", "passing_air_yards", "passing_yards",
            "rushing_yards", "receiving_yards", "passing_tds", "rushing_tds", "receiving_tds", "interceptions",
            "fumbles_lost", "passing_epa", "rushing_epa", "receiving_epa", "first_downs"]
    top_qb = {}
    for row in c.execute(f"SELECT season, week, team, position, cpoe, {', '.join(cols)} FROM player_week_usage WHERE season BETWEEN 2021 AND 2025"):
        s, w, t, pos, cpoe = row[:5]
        k = (s, w, norm(t)); d = tw[k]
        for name, v in zip(cols, row[5:]):
            if v is not None:
                d[f"usage:{name}"] = d.get(f"usage:{name}", 0.0) + float(v)
        if (pos or "").upper() == "QB" and row[5] is not None and cpoe is not None:
            if k not in top_qb or row[5] > top_qb[k][0]:
                top_qb[k] = (row[5], cpoe)
    for k, (_, cp) in top_qb.items():
        tw[k]["usage:qb_cpoe"] = float(cp)
    best = {}
    for s, w, t, plays, qbr, pts, epa, raw in c.execute(
            "SELECT season, week, team, qb_plays, qbr_total, pts_added, epa_total, qbr_raw FROM nfl_qbr_weekly WHERE season BETWEEN 2021 AND 2025"):
        k = (s, w, norm(t))
        if plays is not None and (k not in best or plays > best[k][0]):
            best[k] = (plays, dict(qbr_total=qbr, pts_added=pts, epa_total=epa, qbr_raw=raw))
    for k, (_, d) in best.items():
        tw[k].update({f"qbr:{a}": float(b) for a, b in d.items() if b is not None})
    for s, w, t, efp, afp, ep, er, eru, ey, etd in c.execute(
            """SELECT season, week, team, expected_fantasy_points, actual_fantasy_points, expected_pass_points,
               expected_receive_points, expected_rush_points, expected_total_yards, expected_touchdowns
               FROM nfl_ffopportunity_weekly WHERE season BETWEEN 2021 AND 2025"""):
        d = tw[(s, w, norm(t))]
        for name, v in (("exp_fp", efp), ("act_fp", afp), ("exp_pass", ep), ("exp_rec", er), ("exp_rush", eru), ("exp_yards", ey), ("exp_td", etd)):
            if v is not None:
                d[f"ffo:{name}"] = d.get(f"ffo:{name}", 0.0) + float(v)
        if efp is not None and afp is not None:
            d["ffo:over_expected"] = d.get("ffo:over_expected", 0.0) + float(afp) - float(efp)
    ngs = defaultdict(lambda: defaultdict(list))
    for s, w, t, kind, stats in c.execute("SELECT season, week, team, kind, stats FROM nfl_ngs WHERE season BETWEEN 2021 AND 2025 AND week > 0"):
        for key, v in nums(json.loads(stats)).items():
            ngs[(s, w, norm(t))][f"ngs_{kind}:{key}"].append(v)
    for k, d in ngs.items():
        tw[k].update({a: float(np.mean(b)) for a, b in d.items()})
    team_rows = defaultdict(list)
    for (s, w, t), d in sorted(tw.items()):
        team_rows[t].append((s, w, d))
    return trailing(team_rows)


def w10_last_season():
    c = wired.con()
    out = defaultdict(dict)
    cols = [r[1] for r in c.execute("PRAGMA table_info(off_team_season_stats)") if r[1] not in ("season", "team")]
    for row in c.execute(f"SELECT season, team, {', '.join(cols)} FROM off_team_season_stats WHERE season BETWEEN 2021 AND 2024"):
        s, t = row[0], norm(row[1])
        out[(s + 1, t)].update({f"prev_stats:{k}": float(v) for k, v in zip(cols, row[2:]) if isinstance(v, (int, float))})
    best = {}
    for s, t, plays, qbr, pts, epa, raw in c.execute("SELECT season, team, qb_plays, qbr_total, pts_added, epa_total, qbr_raw FROM off_qbr_season WHERE season BETWEEN 2021 AND 2024"):
        k = (s + 1, norm(t))
        if plays is not None and (k not in best or plays > best[k][0]):
            best[k] = (plays, dict(qbr_total=qbr, pts_added=pts, epa_total=epa, qbr_raw=raw))
    for k, (_, d) in best.items():
        out[k].update({f"prev_qbr:{a}": float(b) for a, b in d.items() if b is not None})
    for table, excl in (("off_pfr_adv_season", ("season", "pfr_id", "kind", "player", "team", "position")),
                        ("off_ngs_season", ("season", "gsis_id", "kind", "team", "position"))):
        cols = [r[1] for r in c.execute(f"PRAGMA table_info({table})") if r[1] not in excl]
        tmp = defaultdict(lambda: defaultdict(list))
        for row in c.execute(f"SELECT season, team, kind, {', '.join(cols)} FROM {table} WHERE season BETWEEN 2021 AND 2024"):
            s, t, kind = row[0], norm(row[1]), row[2]
            for k, v in zip(cols, row[3:]):
                if isinstance(v, (int, float)) and math.isfinite(v):
                    tmp[(s + 1, t)][f"prev_{table}:{kind}:{k}"].append(float(v))
        for k, d in tmp.items():
            out[k].update({a: float(np.mean(b)) for a, b in d.items()})
    safe = [r[1] for r in c.execute("PRAGMA table_info(off_team_season)")
            if (r[1].endswith("_prior") and not r[1].startswith("qb_")) or r[1] in ("hc_change", "hc_tenure_years", "draft_picks_r1_3")]
    for row in c.execute(f"SELECT season, team, {', '.join(safe)} FROM off_team_season WHERE season BETWEEN 2022 AND 2025"):
        out[(row[0], norm(row[1]))].update({f"preseason:{k}": float(v) for k, v in zip(safe, row[2:]) if isinstance(v, (int, float))})
    return out, safe


def w11_preseason_talent():
    c = wired.con()
    out = defaultdict(lambda: defaultdict(float))
    latest = dict(c.execute("SELECT season, MAX(scrape_date) FROM nfl_historical_adp WHERE season BETWEEN 2022 AND 2025 GROUP BY season").fetchall())
    for s, t, pos, rank, sd in c.execute("SELECT season, team, position, ecr_rank, scrape_date FROM nfl_historical_adp WHERE season BETWEEN 2022 AND 2025"):
        if sd != latest[s] or rank is None or not t:
            continue
        v = max(0.0, 200.0 - float(rank)) / 200.0
        k = (s, norm(t))
        out[k]["adp:all"] += v
        out[k][f"adp:{grp(pos)}"] += v
    for s, t, pick in c.execute("SELECT season, team, pick FROM off_draft_picks WHERE season BETWEEN 2021 AND 2025"):
        if pick is None:
            continue
        v = math.exp(-(float(pick) - 1) / 40)
        out[(s, norm(t))]["draft:this_year"] += v
        out[(s + 1, norm(t))]["draft:last_year"] += v
    return out


def w12_luck():
    c = wired.con()
    opp = {(s, w, h): a for s, w, h, a in c.execute("SELECT season, week, team, opponent FROM game_lines WHERE home=1 AND season BETWEEN 2021 AND 2025")}
    team_rows = defaultdict(list)
    for s, w, h, vp, adj, raw in c.execute("SELECT season, week, home, variance_points, adjusted_residual, raw_residual FROM nfl_game_variance WHERE season BETWEEN 2021 AND 2025 ORDER BY season, week"):
        a = opp.get((s, w, h))
        if a is None:
            continue
        vals = dict(luck_points=vp, adjusted_residual=adj, raw_residual=raw)
        team_rows[norm(h)].append((s, w, {k: float(v) for k, v in vals.items() if v is not None}))
        team_rows[norm(a)].append((s, w, {k: -float(v) for k, v in vals.items() if v is not None}))
    for t in team_rows:
        team_rows[t].sort(key=lambda x: (x[0], x[1]))
    return trailing(team_rows)


def walk_forward_matrix(gs, feats, family):
    """feats: game key -> (margin dict or None, total dict or None). Precomputed matrix version of wired.walk_forward."""
    keys_of = lambda g: (g["season"], g["week"], g["home"])
    preds = {}
    for target, idx in (("margin", 0), ("total", 1)):
        rows = [g for g in gs if feats[keys_of(g)][idx] is not None]
        if not rows:
            continue
        allk = sorted({k for g in rows for k in feats[keys_of(g)][idx]})
        col = {k: i for i, k in enumerate(allk)}
        X = np.full((len(rows), len(allk)), np.nan, dtype=np.float64)
        for i, g in enumerate(rows):
            for k, v in feats[keys_of(g)][idx].items():
                X[i, col[k]] = v
        wk = np.array([(g["season"], g["week"]) for g in rows], dtype=[("s", int), ("w", int)])
        y = np.array([g[target] for g in rows], float)
        for (S, W) in sorted({(g["season"], g["week"]) for g in rows}):
            before = (wk["s"] < S) | ((wk["s"] == S) & (wk["w"] < W))
            now = (wk["s"] == S) & (wk["w"] == W)
            if before.sum() < wired.MIN_TRAIN or not now.any():
                continue
            A = X[before]
            keep = (~np.isnan(A)).mean(0) >= 0.8
            if not keep.any():
                continue
            A = A[:, keep]
            with np.errstate(all="ignore"):
                mu, sd = np.nanmean(A, 0), np.nanstd(A, 0)
            ok = sd > 1e-12
            A, mu, sd = A[:, ok], mu[ok], sd[ok]
            Z = np.nan_to_num((A - mu) / sd)
            Zt = np.nan_to_num((X[now][:, keep][:, ok] - mu) / sd)
            predict, _ = wired.dual_ridge_cv(Z, y[before], [tuple(x) for x in wk[before]])
            for g, v in zip([rows[i] for i in np.where(now)[0]], predict(Zt)):
                preds.setdefault(keys_of(g), {})[f"{family}_{target}"] = float(v)
    return preds


def main():
    gs = wired.games()
    VALID.update({g["home"] for g in gs} | {g["away"] for g in gs})
    k = lambda g: (g["season"], g["week"], g["home"])
    def pair(hd, ad):
        if not hd or not ad:
            return None, None
        ks = set(hd) & set(ad)
        return ({x: hd[x] - ad[x] for x in ks}, {x: hd[x] + ad[x] for x in ks})

    pv = w8_player_vectors()
    f8 = {k(g): pair(pv.get((g["season"], g["week"], g["home"])), pv.get((g["season"], g["week"], g["away"]))) for g in gs}
    agg9 = w9_weekly_player_tables()
    f9 = {k(g): pair(agg9(g["season"], g["week"], g["home"]), agg9(g["season"], g["week"], g["away"])) for g in gs}
    ls, safe = w10_last_season()
    print("W10 preseason-safe off_team_season fields:", safe)
    f10 = {k(g): pair(ls.get((g["season"], g["home"])), ls.get((g["season"], g["away"]))) for g in gs}
    tal = w11_preseason_talent()
    f11 = {k(g): pair(dict(tal.get((g["season"], g["home"]), {})) or None, dict(tal.get((g["season"], g["away"]), {})) or None) for g in gs}
    agg12 = w12_luck()
    f12 = {k(g): pair(agg12(g["season"], g["week"], g["home"]), agg12(g["season"], g["week"], g["away"])) for g in gs}
    fs, agg2, venue, coach = wired.w1_feature_store(), wired.w2_team_week(), wired.w3_venue(gs), wired.w4_coaching()
    def base_parts(g):
        p1 = pair(fs.get((g["season"], g["week"], g["home"])), fs.get((g["season"], g["week"], g["away"])))
        p2 = pair(agg2(g["season"], g["week"], g["home"]) or None, agg2(g["season"], g["week"], g["away"]) or None)
        v = venue.get(k(g)); p3 = (v, v)
        h, a = coach(g["season"], g["home"]), coach(g["season"], g["away"])
        p4 = (None, None) if h is None or a is None else (
            {"new_diff": h["new"] - a["new"], "tenure_diff": h["tenure"] - a["tenure"]}, {"new_sum": h["new"] + a["new"], "tenure_sum": h["tenure"] + a["tenure"]})
        return [("w1", p1), ("w2", p2), ("w3", p3), ("w4", p4)]
    f13 = {}
    for g in gs:
        m, t = {}, {}
        for p, (pm, pt) in base_parts(g) + [("w8", f8[k(g)]), ("w9", f9[k(g)]), ("w10", f10[k(g)]), ("w11", f11[k(g)]), ("w12", f12[k(g)])]:
            if pm: m.update({f"{p}:{x}": v for x, v in pm.items()})
            if pt: t.update({f"{p}:{x}": v for x, v in pt.items()})
        f13[k(g)] = (m or None, t or None)
    print("unmatched team codes (after aliasing):", dict(unmatched))

    truth = {k(g): g for g in gs}
    allp = defaultdict(dict)
    for fam, feats in (("wired_W8", f8), ("wired_W9", f9), ("wired_W10", f10), ("wired_W11", f11), ("wired_W12", f12), ("wired_W13", f13)):
        nfeat = max((len(v[0]) for v in feats.values() if v[0]), default=0)
        preds = walk_forward_matrix(gs, feats, fam)
        for key, v in preds.items():
            allp[key].update(v)
        m = [abs(truth[x]["margin"] - v[f"{fam}_margin"]) for x, v in preds.items() if f"{fam}_margin" in v]
        t = [abs(truth[x]["total"] - v[f"{fam}_total"]) for x, v in preds.items() if f"{fam}_total" in v]
        print(f"{fam}: features up to {nfeat} | margin preds {len(m)} MAE {np.mean(m) if m else float('nan'):.2f} | total preds {len(t)} MAE {np.mean(t) if t else float('nan'):.2f}")
    with open(OUT, "w") as fh:
        for (s, w, h), v in sorted(allp.items()):
            fh.write(json.dumps(dict(season=s, week=w, home=h, **v)) + "\n")
    print("wrote", OUT.relative_to(REPO))


if __name__ == "__main__":
    main()
