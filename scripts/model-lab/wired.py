#!/usr/bin/env python3
"""
DATA WIRING (LATEST-PLAN "PREREGISTERED — DATA WIRING"). Builds six families
of per-game features from unwired datasets and turns each into a margin and a
total forecaster by weekly walk-forward ridge regression on final scores.

Every family forecast for week (S, W) is fit only on 2022+ games from weeks
before (S, W); standardization, key selection and the CV-chosen lambda all
come from those training rows. Reads the live database read-only.

Champion candidates when these enter lab.py (decided before any result was
seen): the pools D-G plus method C of every new prior_week forecaster, i.e.
the Kalman models and W1-W4, W7.

Output: docs/evidence/2026-09-16/model-lab/wired-preds.jsonl
Usage: python3 scripts/model-lab/wired.py
"""
import os
import json, math, sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np

REPO = Path(__file__).resolve().parents[2]
LIVE = os.environ.get("GRIDIRON_DB") or str(Path(__file__).resolve().parents[2] / "server/data.sqlite")
OUT = REPO / "docs/evidence/2026-09-16/model-lab/wired-preds.jsonl"
MIN_TRAIN = 150
LAMBDAS = (1, 10, 100, 1000, 10000, 100000)


def con():
    return sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)


def games():
    return [dict(season=s, week=w, home=h, away=a, margin=hs - as_, total=hs + as_, gameday=gd,
                 surface=(sf or "").strip().lower(), roof=(rf or "").strip().lower())
            for s, w, h, a, hs, as_, gd, sf, rf in con().execute(
                """SELECT season, week, team, opponent, team_score, opp_score, gameday, surface, roof
                   FROM game_lines WHERE home=1 AND team_score IS NOT NULL AND season BETWEEN 2022 AND 2025
                   AND COALESCE(neutral_site,0)=0 ORDER BY season, week, team""")]


# ------------------------------------------------------------- families
def w1_feature_store():
    v = {}
    for s, w, t, js in con().execute("SELECT season, week, team, vector_json FROM nfl_team_feature_vectors WHERE season BETWEEN 2022 AND 2025"):
        d = json.loads(js)
        v[(s, w, t)] = {k: float(x) for k, x in d.items() if isinstance(x, (int, float)) and math.isfinite(x)}
    return v


def w2_team_week():
    rows = defaultdict(list)
    for s, w, t, f in con().execute("SELECT season, week, team, features FROM nfl_team_week_features WHERE season BETWEEN 2021 AND 2025 AND team <> 'LA' ORDER BY season, week"):
        d = json.loads(f)
        rows[t].append((s, w, {k: float(x) for k, x in d.items() if isinstance(x, (int, float)) and math.isfinite(x)}))
    cache = {}
    def agg(s, w, t):
        k = (s, w, t)
        if k not in cache:
            hist = [d for (ss, ww, d) in rows.get(t, []) if (ss == s and ww < w) or ss == s - 1]
            out = {}
            if hist:
                n = len(hist)
                acc, wt = defaultdict(float), defaultdict(float)
                for i, d in enumerate(hist):
                    wi = 0.5 ** ((n - 1 - i) / 12)
                    for key, x in d.items():
                        acc[key] += wi * x; wt[key] += wi
                out = {key: acc[key] / wt[key] for key in acc}
            cache[k] = out
        return cache[k]
    return agg


def w3_venue(gs):
    c = con()
    stad = {sid: dict(lat=lat, lon=lon, alt=alt or 0.0, tz=tz, surface=(sf or "").lower())
            for sid, lat, lon, alt, tz, sf in c.execute("SELECT stadium_id, lat, lon, altitude, tz, surface_type FROM nfl_stadiums")}
    ts = defaultdict(list)
    for t, sid, a, b in c.execute("SELECT team, stadium_id, first_game_date, last_game_date FROM nfl_team_stadiums"):
        ts[t].append((a, b, sid))
    def home_stadium(team, day):
        for a, b, sid in ts.get(team, []):
            if a <= day <= b and sid in stad:
                return stad[sid]
        return None
    def hav(p, q):
        r = 6371.0
        la1, la2 = math.radians(p["lat"]), math.radians(q["lat"])
        dla, dlo = la2 - la1, math.radians(q["lon"] - p["lon"])
        h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
        return 2 * r * math.asin(math.sqrt(h))
    out = {}
    for g in gs:
        venue, away_home = home_stadium(g["home"], g["gameday"]), home_stadium(g["away"], g["gameday"])
        if not venue or not away_home or not venue["tz"] or not away_home["tz"]:
            continue
        day = datetime.fromisoformat(g["gameday"] + "T13:00:00")
        off = lambda tz: ZoneInfo(tz).utcoffset(day).total_seconds() / 3600
        shift = off(venue["tz"]) - off(away_home["tz"])
        turf = 0.0 if "grass" in g["surface"] else (1.0 if g["surface"] else 0.5)
        away_turf = 0.0 if "grass" in away_home["surface"] else 1.0
        out[(g["season"], g["week"], g["home"])] = {
            "travel_km_thousands": hav(away_home, venue) / 1000, "tz_shift_hours": shift, "tz_shift_abs": abs(shift),
            "venue_altitude_km": venue["alt"] / 1000, "turf": turf,
            "dome_or_closed": 1.0 if g["roof"] in ("dome", "closed") else 0.0,
            "away_surface_mismatch": abs(turf - away_turf)}
    return out


def w4_coaching():
    by = {}
    for s, t, coach in con().execute("SELECT season, team, coach FROM nfl_team_coaches"):
        by[(s, t)] = coach
    def feats(s, t):
        c = by.get((s, t))
        if c is None:
            return None
        tenure, y = 1, s - 1
        while by.get((y, t)) == c:
            tenure += 1; y -= 1
        prev = by.get((s - 1, t))
        return dict(new=1.0 if prev is not None and prev != c else 0.0, tenure=float(min(tenure, 10)))
    return feats


def w5_weather():
    best = {}
    for s, w, h, lead, wind, gust, precip, temp in con().execute(
            "SELECT season, week, home, lead_days, wind_kmh, gust_kmh, precip_mm, temp_c FROM nfl_game_weather_forecast_history WHERE season BETWEEN 2022 AND 2025"):
        k = (s, w, h)
        if k not in best or lead > best[k][0]:
            best[k] = (lead, dict(wind_kmh=wind, gust_kmh=gust, precip_mm=precip, temp_c=temp))
    return {k: {a: b for a, b in v[1].items() if b is not None} for k, v in best.items()}


def w6_injury_return():
    out_by = defaultdict(set)
    listed = defaultdict(dict)
    for s, w, t, pid, rs in con().execute(
            "SELECT season, week, team, gsis_id, report_status FROM nfl_injuries WHERE season BETWEEN 2022 AND 2025 AND gsis_id IS NOT NULL"):
        listed[(s, w, t)][pid] = (rs or "").strip().lower()
        if (rs or "").strip().lower() == "out":
            out_by[(s, w, t)].add(pid)
    def returning(s, w, t):
        prev = out_by.get((s, w - 1, t), set())
        now = listed.get((s, w, t), {})
        return float(sum(1 for pid in prev if now.get(pid, "") != "out"))
    return returning


# ------------------------------------------------------------- model fit
def dual_ridge_cv(X, y, weeks):
    """Ridge in dual form (n << p safe). Returns predictor closure."""
    n = X.shape[0]
    ym = y.mean()
    yc = y - ym
    uw = sorted(set(weeks))
    fold = np.array([{w: i % 5 for i, w in enumerate(uw)}[w] for w in weeks])
    errs = np.zeros(len(LAMBDAS))
    for k in range(5):
        tr, te = fold != k, fold == k
        if te.sum() == 0 or tr.sum() < 30:
            continue
        Xt = X[tr]
        e, V = np.linalg.eigh(Xt @ Xt.T)
        b = V.T @ (y[tr] - y[tr].mean())
        Kte = X[te] @ Xt.T
        for j, lam in enumerate(LAMBDAS):
            alpha = V @ (b / (np.maximum(e, 0) + lam))
            errs[j] += float(((Kte @ alpha + y[tr].mean() - y[te]) ** 2).sum())
    lam = LAMBDAS[int(np.argmin(errs))]
    e, V = np.linalg.eigh(X @ X.T)
    alpha = V @ ((V.T @ yc) / (np.maximum(e, 0) + lam))
    return (lambda Xn: Xn @ (X.T @ alpha) + ym), lam


def walk_forward(gs, featfn, family, min_presence=0.8):
    """featfn(game) -> (margin_features dict or None, total_features dict or None)."""
    feats = {}
    for g in gs:
        feats[(g["season"], g["week"], g["home"])] = featfn(g)
    weeks = sorted({(g["season"], g["week"]) for g in gs})
    preds, lams = {}, []
    for target, idx in (("margin", 0), ("total", 1)):
        for (S, W) in weeks:
            train = [g for g in gs if (g["season"], g["week"]) < (S, W) and feats[(g["season"], g["week"], g["home"])][idx] is not None]
            test = [g for g in gs if (g["season"], g["week"]) == (S, W) and feats[(g["season"], g["week"], g["home"])][idx] is not None]
            if len(train) < MIN_TRAIN or not test:
                continue
            fd = lambda g: feats[(g["season"], g["week"], g["home"])][idx]
            counts = defaultdict(int)
            for g in train:
                for k in fd(g):
                    counts[k] += 1
            keys = sorted(k for k, c in counts.items() if c >= min_presence * len(train))
            if not keys:
                continue
            A = np.array([[fd(g).get(k, np.nan) for k in keys] for g in train], float)
            mu = np.nanmean(A, 0); sd = np.nanstd(A, 0)
            keep = sd > 1e-12
            A, mu, sd = A[:, keep], mu[keep], sd[keep]
            Z = np.nan_to_num((A - mu) / sd)
            B = np.array([[fd(g).get(k, np.nan) for k in np.array(keys)[keep]] for g in test], float)
            Zt = np.nan_to_num((B - mu) / sd)
            y = np.array([g[target] for g in train], float)
            predict, lam = dual_ridge_cv(Z, y, [(g["season"], g["week"]) for g in train])
            lams.append(lam)
            for g, v in zip(test, predict(Zt)):
                preds.setdefault((g["season"], g["week"], g["home"]), {})[f"{family}_{target}"] = float(v)
    return preds, lams


def main():
    gs = games()
    print(len(gs), "games 2022-2025")
    fs = w1_feature_store()
    agg = w2_team_week()
    venue = w3_venue(gs)
    coach = w4_coaching()
    weather = w5_weather()
    inj = w6_injury_return()

    def pair(hd, ad):
        if hd is None or ad is None:
            return None, None
        keys = set(hd) & set(ad)
        return ({k: hd[k] - ad[k] for k in keys}, {k: hd[k] + ad[k] for k in keys})

    def f1(g):
        return pair(fs.get((g["season"], g["week"], g["home"])), fs.get((g["season"], g["week"], g["away"])))

    def f2(g):
        h, a = agg(g["season"], g["week"], g["home"]), agg(g["season"], g["week"], g["away"])
        return pair(h or None, a or None)

    def f3(g):
        v = venue.get((g["season"], g["week"], g["home"]))
        return (v, v)

    def f4(g):
        h, a = coach(g["season"], g["home"]), coach(g["season"], g["away"])
        if h is None or a is None:
            return None, None
        return ({"new_diff": h["new"] - a["new"], "tenure_diff": h["tenure"] - a["tenure"], "home_new": h["new"], "away_new": a["new"]},
                {"new_sum": h["new"] + a["new"], "tenure_sum": h["tenure"] + a["tenure"]})

    def f5(g):
        v = weather.get((g["season"], g["week"], g["home"]))
        v = dict(v) if v else {}
        v["has_forecast"] = 1.0 if v else 0.0
        return (v, v)

    def f6(g):
        h, a = inj(g["season"], g["week"], g["home"]), inj(g["season"], g["week"], g["away"])
        return ({"return_diff": h - a, "home_returning": h, "away_returning": a}, {"return_sum": h + a})

    def f7(g):
        parts = [(p, fn(g)) for p, fn in (("w1", f1), ("w2", f2), ("w3", f3), ("w4", f4))]
        m, t = {}, {}
        for p, (pm, pt) in parts:
            if pm:
                m.update({f"{p}:{k}": v for k, v in pm.items()})
            if pt:
                t.update({f"{p}:{k}": v for k, v in pt.items()})
        return (m or None, t or None)

    all_preds = defaultdict(dict)
    for fam, fn, presence in (("wired_W1", f1, 0.8), ("wired_W2", f2, 0.8), ("wired_W3", f3, 0.8), ("wired_W4", f4, 0.8),
                              ("wired_W5", f5, 0.0), ("wired_W6", f6, 0.8), ("wired_W7", f7, 0.8)):
        preds, lams = walk_forward(gs, fn, fam, presence)
        for k, v in preds.items():
            all_preds[k].update(v)
        n_m = sum(1 for v in preds.values() if f"{fam}_margin" in v)
        truth = {(g["season"], g["week"], g["home"]): g for g in gs}
        mae = np.mean([abs(truth[k]["margin"] - v[f"{fam}_margin"]) for k, v in preds.items() if f"{fam}_margin" in v]) if n_m else float("nan")
        n_t = sum(1 for v in preds.values() if f"{fam}_total" in v)
        mae_t = np.mean([abs(truth[k]["total"] - v[f"{fam}_total"]) for k, v in preds.items() if f"{fam}_total" in v]) if n_t else float("nan")
        lam_mode = max(set(lams), key=lams.count) if lams else None
        print(f"{fam}: margin preds {n_m} MAE {mae:.2f} | total preds {n_t} MAE {mae_t:.2f} | most common lambda {lam_mode}")
    with open(OUT, "w") as fh:
        for (s, w, h), v in sorted(all_preds.items()):
            fh.write(json.dumps(dict(season=s, week=w, home=h, **v)) + "\n")
    print("wrote", OUT.relative_to(REPO))


if __name__ == "__main__":
    main()
