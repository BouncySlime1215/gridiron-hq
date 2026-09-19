#!/usr/bin/env python3
"""
Kalman team-rating models K1, K1b, K2 (preregistered in LATEST-PLAN
"PREREGISTERED — MODEL LAB").

K1  margin model. Each team has a rating r (points) with variance P.
    Predicted home margin = r_home - r_away + h (h = 0 at neutral sites),
    predictive variance S = P_home + P_away + sigma^2.
    Before every week P += q_week; at each new season r *= rho and
    P = rho^2 P + q_season. After the week's games, a standard scalar
    Kalman update. Covariance between teams is ignored (standard
    simplification).
K1b K1 plus a second observation per game: the home side's net EPA per play
    for that game, modelled as k * (r_home - r_away) + h_e + noise tau^2, with
    the score and EPA noise CORRELATED (parameter c) and updated jointly.
    CORRECTED before scoring: the first version treated the two observations
    as independent; a game's EPA and score margin correlate at 0.93, so the
    fit simply switched the EPA channel off (h_e landed at -25 points).
    Hyperparameters still maximise the SCORE likelihood, so the EPA channel
    is kept only to the extent it improves score prediction.
K2  totals model. States: league scoring level mu, each team's offense o and
    defense-allowed d. Home points = mu + o_h + d_a + hh/2, away points =
    mu + o_a + d_h - hh/2. Both scores are observed.

Every prediction for week w is made before any week-w result is used.
Hyperparameters are fit by maximum likelihood on 2016-2021 (2015 is burn-in)
and then frozen for every later season. Reads the live database read-only.

Usage: python3 scripts/model-lab/kalman.py [--db path] [--out path]
"""
import os
import json, math, sqlite3, sys
from collections import defaultdict
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
LIVE = os.environ.get("GRIDIRON_DB") or str(Path(__file__).resolve().parents[2] / "server/data.sqlite")
FIT_FROM, FIT_TO, START = 2016, 2021, 2015
LOG2PI = math.log(2 * math.pi)


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def upcoming(db):
    """Unscored games of the latest scored season that already have a line: the next slate to predict."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    return [dict(season=s, week=w, home=h, away=a, hs=None, as_=None, neutral=bool(n))
            for s, w, h, a, n in con.execute("""SELECT season, week, team, opponent, COALESCE(neutral_site,0) FROM game_lines
                WHERE home=1 AND team_score IS NULL AND spread IS NOT NULL AND season=(SELECT MAX(season) FROM game_lines WHERE team_score IS NOT NULL)
                ORDER BY week, team""")]


def load(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    games = [dict(season=s, week=w, home=h, away=a, hs=hs, as_=as_, neutral=bool(n))
             for s, w, h, a, hs, as_, n in con.execute(
                 """SELECT season, week, team, opponent, team_score, opp_score, COALESCE(neutral_site,0)
                    FROM game_lines WHERE home=1 AND team_score IS NOT NULL AND season >= ?
                    ORDER BY season, week, team""", (START,))]
    epa = {}
    for s, w, t, f in con.execute("SELECT season, week, team, features FROM nfl_team_week_features WHERE season >= ?", (START,)):
        x = json.loads(f)
        if x.get("off_epa_per_play") is not None and x.get("def_epa_per_play") is not None:
            epa[(s, w, t)] = x["off_epa_per_play"] - x["def_epa_per_play"]
    return games, epa


def weeks_of(games):
    out = defaultdict(list)
    for g in games:
        out[(g["season"], g["week"])].append(g)
    return sorted(out.items())


def run_margin(games, epa, p, use_epa, record=False, future=None):
    q_week, q_season, rho, sigma, h, p0 = p[:6]
    k, tau, h_e, c = (p[6], p[7], p[8], p[9]) if use_epa else (0, 1, 0, 0)
    r = defaultdict(float)
    P = defaultdict(lambda: p0)
    season, nll, out = None, 0.0, []
    for (s, w), slate in weeks_of(games):
        if s != season:
            if season is not None:
                for t in list(P):
                    r[t] *= rho
                    P[t] = rho * rho * P[t] + q_season
            season = s
        for t in {x for g in slate for x in (g["home"], g["away"])}:
            P[t] += q_week
        preds = []
        for g in slate:
            hf = 0.0 if g["neutral"] else h
            m = r[g["home"]] - r[g["away"]] + hf
            S = P[g["home"]] + P[g["away"]] + sigma * sigma
            y = g["hs"] - g["as_"]
            if FIT_FROM <= s <= FIT_TO:
                nll += 0.5 * (LOG2PI + math.log(S) + (y - m) ** 2 / S)
            preds.append((g, m, S))
            if record:
                out.append(dict(season=s, week=w, home=g["home"], away=g["away"], pred=m, sd=math.sqrt(S)))
        for g, _, _ in preds:
            hm, aw = g["home"], g["away"]
            e = epa.get((s, w, hm)) if use_epa else None
            hf = 0.0 if g["neutral"] else h
            if e is None:
                y, m = g["hs"] - g["as_"], r[hm] - r[aw] + hf
                S = P[hm] + P[aw] + sigma * sigma
                inn = y - m
                gh, ga = P[hm] / S, P[aw] / S
                r[hm] += gh * inn; r[aw] -= ga * inn
                P[hm] *= 1 - gh; P[aw] *= 1 - ga
                continue
            # Joint update: score margin and EPA share correlated game noise.
            he = 0.0 if g["neutral"] else h_e
            H = np.array([[1.0, -1.0], [k, -k]])
            D = np.diag([P[hm], P[aw]])
            R = np.array([[sigma * sigma, c * sigma * tau], [c * sigma * tau, tau * tau]])
            S = H @ D @ H.T + R
            K = D @ H.T @ np.linalg.inv(S)
            inn = np.array([g["hs"] - g["as_"] - (r[hm] - r[aw] + hf), e - (k * (r[hm] - r[aw]) + he)])
            upd = K @ inn
            r[hm] += upd[0]; r[aw] += upd[1]
            Pn = (np.eye(2) - K @ H) @ D
            P[hm], P[aw] = max(Pn[0, 0], 1e-6), max(Pn[1, 1], 1e-6)
    if record and future:
        for g in future:
            if g["season"] != season:
                for t in list(P):
                    r[t] *= rho; P[t] = rho * rho * P[t] + q_season
                season = g["season"]
            hf = 0.0 if g["neutral"] else h
            out.append(dict(season=g["season"], week=g["week"], home=g["home"], away=g["away"], pred=r[g["home"]] - r[g["away"]] + hf,
                            sd=math.sqrt(P[g["home"]] + P[g["away"]] + 2 * q_week + sigma * sigma), upcoming=True))
    return nll, out


def run_total(games, p, record=False, future=None):
    q_week, q_season, rho, sigma, hh, p0, q_mu = p
    o, d = defaultdict(float), defaultdict(float)
    Po, Pd = defaultdict(lambda: p0), defaultdict(lambda: p0)
    mu, Pmu = 22.0, 4.0
    season, nll, out = None, 0.0, []
    for (s, w), slate in weeks_of(games):
        if s != season:
            if season is not None:
                for t in list(Po):
                    o[t] *= rho; d[t] *= rho
                    Po[t] = rho * rho * Po[t] + q_season
                    Pd[t] = rho * rho * Pd[t] + q_season
            season = s
        Pmu += q_mu
        for t in {x for g in slate for x in (g["home"], g["away"])}:
            Po[t] += q_week; Pd[t] += q_week
        for g in slate:
            hb = 0.0 if g["neutral"] else hh / 2
            mh = mu + o[g["home"]] + d[g["away"]] + hb
            ma = mu + o[g["away"]] + d[g["home"]] - hb
            Vh = Pmu + Po[g["home"]] + Pd[g["away"]] + sigma * sigma
            Va = Pmu + Po[g["away"]] + Pd[g["home"]] + sigma * sigma
            if FIT_FROM <= s <= FIT_TO:
                for y, m, V in ((g["hs"], mh, Vh), (g["as_"], ma, Va)):
                    nll += 0.5 * (LOG2PI + math.log(V) + (y - m) ** 2 / V)
            if record:
                out.append(dict(season=s, week=w, home=g["home"], away=g["away"],
                                total=mh + ma, total_sd=math.sqrt(Vh + Va), home_pts=mh, away_pts=ma))
        for g in slate:
            hb = 0.0 if g["neutral"] else hh / 2
            for y, off_t, def_t, sign in ((g["hs"], g["home"], g["away"], 1), (g["as_"], g["away"], g["home"], -1)):
                m = mu + o[off_t] + d[def_t] + sign * hb
                S = Pmu + Po[off_t] + Pd[def_t] + sigma * sigma
                inn = y - m
                mu += Pmu / S * inn; o[off_t] += Po[off_t] / S * inn; d[def_t] += Pd[def_t] / S * inn
                Pmu *= 1 - Pmu / S; Po[off_t] *= 1 - Po[off_t] / S; Pd[def_t] *= 1 - Pd[def_t] / S
    if record and future:
        for g in future:
            if g["season"] != season:
                for t in list(Po):
                    o[t] *= rho; d[t] *= rho; Po[t] = rho * rho * Po[t] + q_season; Pd[t] = rho * rho * Pd[t] + q_season
                season = g["season"]
            hb = 0.0 if g["neutral"] else hh / 2
            mh = mu + o[g["home"]] + d[g["away"]] + hb; ma = mu + o[g["away"]] + d[g["home"]] - hb
            V = 2 * (Pmu + q_mu) + Po[g["home"]] + Pd[g["away"]] + Po[g["away"]] + Pd[g["home"]] + 4 * q_week + 2 * sigma * sigma
            out.append(dict(season=g["season"], week=g["week"], home=g["home"], away=g["away"], total=mh + ma, total_sd=math.sqrt(V), home_pts=mh, away_pts=ma, upcoming=True))
    return nll, out


def nelder_mead(f, x0, step, iters=400):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + np.eye(n)[i] * step[i] for i in range(n)]
    vals = [f(x) for x in pts]
    for _ in range(iters):
        order = np.argsort(vals); pts = [pts[i] for i in order]; vals = [vals[i] for i in order]
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1]); fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1]); fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c); fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0] + 0.5 * (x - pts[0]) for x in pts]; vals = [f(x) for x in pts]
        if abs(vals[-1] - vals[0]) < 1e-4:
            break
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def main():
    db = arg("--db", LIVE)
    out_path = Path(arg("--out", str(REPO / "docs/evidence/2026-09-16/model-lab/kalman-preds.jsonl")))
    games, epa = load(db)
    # Parameters are optimised on transformed scales so they stay valid.
    def m_params(x, use_epa):
        base = [math.exp(x[0]), math.exp(x[1]), 1 / (1 + math.exp(-x[2])), math.exp(x[3]), x[4], math.exp(x[5])]
        return base + ([x[6], math.exp(x[7]), x[8], math.tanh(x[9])] if use_epa else [])
    fits = {}
    x1, v1 = nelder_mead(lambda x: run_margin(games, epa, m_params(x, False), False)[0],
                         [math.log(0.5), math.log(10), 1.0, math.log(13), 1.5, math.log(30)], [0.5, 0.5, 0.5, 0.1, 0.5, 0.5])
    fits["K1"] = dict(params=m_params(x1, False), nll=v1)
    x1b, v1b = nelder_mead(lambda x: run_margin(games, epa, m_params(x, True), True)[0],
                           list(x1) + [0.022, math.log(0.25), 0.0, math.atanh(0.8)], [0.5, 0.5, 0.5, 0.1, 0.5, 0.5, 0.01, 0.3, 0.02, 0.3], iters=800)
    fits["K1b"] = dict(params=m_params(x1b, True), nll=v1b)
    t_params = lambda x: [math.exp(x[0]), math.exp(x[1]), 1 / (1 + math.exp(-x[2])), math.exp(x[3]), x[4], math.exp(x[5]), math.exp(x[6])]
    x2, v2 = nelder_mead(lambda x: run_total(games, t_params(x))[0],
                         [math.log(0.3), math.log(5), 1.0, math.log(9), 2.0, math.log(10), math.log(0.05)], [0.5] * 7)
    fits["K2"] = dict(params=t_params(x2), nll=v2)
    for k, v in fits.items():
        print(k, "nll", round(v["nll"], 1), "params", [round(z, 4) for z in v["params"]])

    fut = upcoming(db)
    _, k1 = run_margin(games, epa, fits["K1"]["params"], False, record=True, future=fut)
    _, k1b = run_margin(games, epa, fits["K1b"]["params"], True, record=True, future=fut)
    _, k2 = run_total(games, fits["K2"]["params"], record=True, future=fut)
    kb = {(r["season"], r["week"], r["home"]): r for r in k1b if r.get("upcoming")}; kt = {(r["season"], r["week"], r["home"]): r for r in k2 if r.get("upcoming")}
    with open(out_path.parent / "kalman-upcoming.jsonl", "w") as fh:
        for r in k1:
            if r.get("upcoming"):
                k = (r["season"], r["week"], r["home"])
                fh.write(json.dumps(dict(season=r["season"], week=r["week"], home=r["home"], away=r["away"], kalman_score=r["pred"], kalman_score_sd=r["sd"],
                                         kalman_score_epa=kb[k]["pred"], kalman_total=kt[k]["total"], kalman_total_sd=kt[k]["total_sd"])) + "\n")
    k1 = [r for r in k1 if not r.get("upcoming")]; k1b = [r for r in k1b if not r.get("upcoming")]; k2 = [r for r in k2 if not r.get("upcoming")]
    key = lambda r: (r["season"], r["week"], r["home"])
    b = {key(r): r for r in k1b}; t = {key(r): r for r in k2}
    with open(out_path, "w") as fh:
        for r in k1:
            rb, rt = b[key(r)], t[key(r)]
            fh.write(json.dumps(dict(season=r["season"], week=r["week"], home=r["home"], away=r["away"],
                                     kalman_score=r["pred"], kalman_score_sd=r["sd"],
                                     kalman_score_epa=rb["pred"], kalman_score_epa_sd=rb["sd"],
                                     kalman_total=rt["total"], kalman_total_sd=rt["total_sd"])) + "\n")
    (out_path.parent / "kalman-fit.json").write_text(json.dumps(
        dict(fit_seasons=[FIT_FROM, FIT_TO], burn_in=START, fits=fits,
             param_names=dict(K1=["q_week", "q_season", "rho", "sigma", "h", "p0"],
                              K1b=["q_week", "q_season", "rho", "sigma", "h", "p0", "k", "tau", "h_e_epa_units", "noise_corr"],
                              K2=["q_week", "q_season", "rho", "sigma", "hh", "p0", "q_mu"])), indent=1))
    # Out-of-sample sanity: 2022-2025 score MAE and standardized-error spread.
    for name, col, sdcol in (("K1", "kalman_score", "kalman_score_sd"), ("K1b", "kalman_score_epa", "kalman_score_epa_sd")):
        rows = [json.loads(l) for l in open(out_path)]
        act = {key(g): g["hs"] - g["as_"] for g in games}
        ev = [r for r in rows if r["season"] >= 2022]
        errs = [act[key(r)] - r[col] for r in ev]
        z = [e / r[sdcol] for e, r in zip(errs, ev)]
        print(f"{name} 2022-25: MAE {np.mean(np.abs(errs)):.2f}  sd of standardized error {np.std(z):.3f} (1.0 = honest uncertainty)")
    print("wrote", out_path)


if __name__ == "__main__":
    main()
