#!/usr/bin/env python3
"""
MULTI-CHANNEL KALMAN (LATEST-PLAN "PREREGISTERED — MULTI-CHANNEL KALMAN").

Every channel is a matchup-adjusted pair filter: for a game, the home team's
observed stat = level + off_home + def_away (+ home bump), the away team's =
level + off_away + def_home (- bump). States drift between weeks (q_week),
shrink and reset between seasons (rho, q_season); the league level drifts
(q_mu). Hyperparameters per channel maximise the likelihood of that channel's
own next-game observation on 2016-2021 and are then frozen. QB is a
per-player filter on qbr_raw; the expected starter for a game is the team's
previous game's most-played QB, so it is knowable before kickoff.

Readouts (ridge on 2016-2021 one-step-ahead predictions, frozen): margin and
total, full and single-channel ablations. Outputs:
  docs/evidence/2026-09-16/model-lab/kmulti-preds.jsonl   per game, 2016-2025
  docs/evidence/2026-09-16/model-lab/kmulti-profiles.jsonl per team-week state vector
  docs/evidence/2026-09-16/model-lab/kmulti-fit.json
Usage: python3 scripts/model-lab/kalman_multi.py
"""
import json, math, sqlite3
from collections import defaultdict
from pathlib import Path
import numpy as np
import kalman as K

REPO = Path(__file__).resolve().parents[2]
LAB = REPO / "docs/evidence/2026-09-16/model-lab"
FIT_FROM, FIT_TO, START = 2016, 2021, 2016
CHANNELS = {
    "drives": "drives", "tempo": "seconds_per_drive", "drive_scoring": "drive_scoring_rate",
    "pass_epa": "pass_epa_per_play", "rush_epa": "rush_epa_per_play", "explosive": "explosive_play_rate",
    "success": "success_rate", "turnover": "turnover_rate", "field_position": "avg_drive_start",
}
LOG2PI = math.log(2 * math.pi)


def load_stats():
    con = sqlite3.connect(f"file:{K.LIVE}?mode=ro", uri=True)
    stats = {}
    for s, w, t, f in con.execute("SELECT season, week, team, features FROM nfl_team_week_features WHERE season >= ? AND team <> 'LA'", (START,)):
        stats[(s, w, t)] = json.loads(f)
    qb = defaultdict(list)
    for s, w, t, pid, plays, raw in con.execute("SELECT season, week, team, player_id, qb_plays, qbr_raw FROM nfl_qbr_weekly WHERE season >= ? AND qb_plays IS NOT NULL AND qbr_raw IS NOT NULL", (START,)):
        qb[(s, w, t)].append((plays, pid, raw))
    starters = {k: max(v)[1:] for k, v in qb.items()}          # (player_id, qbr_raw) of the most-played QB
    return stats, starters


def run_pair(games, obs, p, record=False, future=None):
    """Pair filter on a per-team stat. obs(g, team) -> value or None."""
    q_week, q_season, rho, sigma, hb, p0, q_mu = p
    o, d = defaultdict(float), defaultdict(float)
    Po, Pd = defaultdict(lambda: p0), defaultdict(lambda: p0)
    first = [v for g in games[:200] for v in (obs(g, g["home"]), obs(g, g["away"])) if v is not None]
    mu, Pmu = float(np.mean(first)), float(np.var(first))
    season, nll, out, states = None, 0.0, [], {}
    for (s, w), slate in K.weeks_of(games):
        if s != season:
            if season is not None:
                for t in list(Po):
                    o[t] *= rho; d[t] *= rho
                    Po[t] = rho * rho * Po[t] + q_season; Pd[t] = rho * rho * Pd[t] + q_season
            season = s
        Pmu += q_mu
        for t in {x for g in slate for x in (g["home"], g["away"])}:
            Po[t] += q_week; Pd[t] += q_week
        for g in slate:
            b = 0.0 if g["neutral"] else hb
            ph = mu + o[g["home"]] + d[g["away"]] + b
            pa = mu + o[g["away"]] + d[g["home"]] - b
            if record:
                out.append((s, w, g["home"], ph, pa))
                states[(s, w, g["home"])] = (o[g["home"]], d[g["home"]]); states[(s, w, g["away"])] = (o[g["away"]], d[g["away"]])
            if FIT_FROM <= s <= FIT_TO:
                for y, m, V in ((obs(g, g["home"]), ph, Pmu + Po[g["home"]] + Pd[g["away"]] + sigma ** 2),
                                (obs(g, g["away"]), pa, Pmu + Po[g["away"]] + Pd[g["home"]] + sigma ** 2)):
                    if y is not None:
                        nll += 0.5 * (LOG2PI + math.log(V) + (y - m) ** 2 / V)
        for g in slate:
            b = 0.0 if g["neutral"] else hb
            for y, ot, dt, sign in ((obs(g, g["home"]), g["home"], g["away"], 1), (obs(g, g["away"]), g["away"], g["home"], -1)):
                if y is None:
                    continue
                m = mu + o[ot] + d[dt] + sign * b
                S = Pmu + Po[ot] + Pd[dt] + sigma ** 2
                inn = y - m
                mu += Pmu / S * inn; o[ot] += Po[ot] / S * inn; d[dt] += Pd[dt] / S * inn
                Pmu *= 1 - Pmu / S; Po[ot] *= 1 - Po[ot] / S; Pd[dt] *= 1 - Pd[dt] / S
    if record and future:
        for g in future:
            if g["season"] != season:
                for t in list(Po):
                    o[t] *= rho; d[t] *= rho; Po[t] = rho * rho * Po[t] + q_season; Pd[t] = rho * rho * Pd[t] + q_season
                season = g["season"]
            b = 0.0 if g["neutral"] else hb
            out.append((g["season"], g["week"], g["home"], mu + o[g["home"]] + d[g["away"]] + b, mu + o[g["away"]] + d[g["home"]] - b))
            for t in (g["home"], g["away"]):
                states[(g["season"], g["week"], t)] = (o[t], d[t])
    return nll, out, states


def fit_channel(games, obs, scale):
    tp = lambda x: [math.exp(x[0]), math.exp(x[1]), 1 / (1 + math.exp(-x[2])), math.exp(x[3]), x[4], math.exp(x[5]), math.exp(x[6])]
    x0 = [math.log(0.02 * scale ** 2), math.log(0.2 * scale ** 2), 1.0, math.log(scale), 0.0, math.log(0.3 * scale ** 2), math.log(0.001 * scale ** 2)]
    x, v = K.nelder_mead(lambda x: run_pair(games, obs, tp(x))[0], x0, [0.5] * 7, iters=300)
    return tp(x), v


def run_qb(games, starters, p, record=False, future=None):
    """Per-player filter on qbr_raw; predicted value for a game uses last game's starter."""
    q_week, q_season, rho, sigma, p0 = p
    r, P = {}, {}
    last_starter, season, nll, out = {}, None, 0.0, {}
    mu = 50.0
    for (s, w), slate in K.weeks_of(games):
        if s != season:
            if season is not None:
                for pid in r:
                    r[pid] = mu + rho * (r[pid] - mu); P[pid] = rho * rho * P[pid] + q_season
            season = s
        for pid in P:
            P[pid] += q_week
        for g in slate:
            for t in (g["home"], g["away"]):
                pid = last_starter.get(t)
                pred = r.get(pid, mu) if pid else mu
                if record:
                    out[(s, w, t)] = pred
                st = starters.get((s, w, t))
                if st and FIT_FROM <= s <= FIT_TO and pid == st[0]:
                    V = P.get(pid, p0) + sigma ** 2
                    nll += 0.5 * (LOG2PI + math.log(V) + (st[1] - pred) ** 2 / V)
        for g in slate:
            for t in (g["home"], g["away"]):
                st = starters.get((s, w, t))
                if not st:
                    continue
                pid, y = st
                if pid not in r:
                    r[pid], P[pid] = mu, p0
                S = P[pid] + sigma ** 2
                r[pid] += P[pid] / S * (y - r[pid]); P[pid] *= 1 - P[pid] / S
                last_starter[t] = pid
    if record and future:
        for g in future:
            for t in (g["home"], g["away"]):
                pid = last_starter.get(t)
                out[(g["season"], g["week"], t)] = r.get(pid, mu) if pid else mu
    return nll, out


def ridge(X, y, lam=1.0):
    X = np.asarray(X, float); y = np.asarray(y, float)
    mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1
    Z = (X - mu) / sd
    A = np.column_stack([np.ones(len(Z)), Z]); Pm = np.eye(A.shape[1]) * lam; Pm[0, 0] = 0
    w = np.linalg.solve(A.T @ A + Pm, A.T @ y)
    return dict(w=w.tolist(), mu=mu.tolist(), sd=sd.tolist())


def apply(model, X):
    Z = (np.asarray(X, float) - np.array(model["mu"])) / np.array(model["sd"])
    return np.column_stack([np.ones(len(Z)), Z]) @ np.array(model["w"])


def main():
    games, _ = K.load(K.LIVE)
    games = [g for g in games if g["season"] >= START]
    fut = K.upcoming(K.LIVE)
    stats, starters = load_stats()
    fit, chan_pred, profiles = {}, {}, defaultdict(dict)
    for name, key in CHANNELS.items():
        obs = lambda g, t, key=key: (stats.get((g["season"], g["week"], t)) or {}).get(f"off_{key}")
        vals = [v for g in games[:400] for v in (obs(g, g["home"]), obs(g, g["away"])) if v is not None]
        p, nll = fit_channel(games, obs, float(np.std(vals)) or 1.0)
        fit[name] = dict(params=p, nll=nll)
        _, out, states = run_pair(games, obs, p, record=True, future=fut)
        for s, w, h, ph, pa in out:
            chan_pred.setdefault((s, w, h), {})[name] = (ph, pa)
        for (s, w, t), (o, d) in states.items():
            profiles[(s, w, t)][f"{name}_off"] = o; profiles[(s, w, t)][f"{name}_def"] = d
        print(f"{name:14s} nll {nll:10.1f} params {[round(x, 4) for x in p]}", flush=True)
    tq = lambda x: [math.exp(x[0]), math.exp(x[1]), 1 / (1 + math.exp(-x[2])), math.exp(x[3]), math.exp(x[4])]
    xq, vq = K.nelder_mead(lambda x: run_qb(games, starters, tq(x))[0], [math.log(2), math.log(20), 1.0, math.log(15), math.log(100)], [0.5] * 5, iters=300)
    fit["qb"] = dict(params=tq(xq), nll=vq)
    _, qb_pred = run_qb(games, starters, tq(xq), record=True, future=fut)
    print(f"{'qb':14s} nll {vq:10.1f} params {[round(x, 4) for x in tq(xq)]}", flush=True)
    kfit = json.load(open(LAB / "kalman-fit.json"))["fits"]
    _, k1 = K.run_margin(games, {}, kfit["K1"]["params"], False, record=True, future=fut)
    _, k2 = K.run_total(games, kfit["K2"]["params"], record=True, future=fut)
    k1 = {(r["season"], r["week"], r["home"]): r for r in k1}; k2 = {(r["season"], r["week"], r["home"]): r for r in k2}

    names = list(CHANNELS)
    def feats(g):
        k = (g["season"], g["week"], g["home"]); cp = chan_pred.get(k, {})
        if len(cp) < len(names) or k not in k1 or k not in k2:
            return None
        diff = [cp[n][0] - cp[n][1] for n in names]; summ = [cp[n][0] + cp[n][1] for n in names]
        qb = qb_pred.get((g["season"], g["week"], g["home"]), 50.0) - qb_pred.get((g["season"], g["week"], g["away"]), 50.0)
        return dict(margin=diff + [k1[k]["pred"], qb], total=summ + [k2[k]["total"]])
    rows = [(g, feats(g)) for g in games + fut]; rows = [(g, f) for g, f in rows if f]
    train = [(g, f) for g, f in rows if FIT_FROM <= g["season"] <= FIT_TO]
    mnames, tnames = names + ["k1", "qb"], names + ["k2"]
    readouts = {}
    for target, fn, cols in (("margin", lambda g: g["hs"] - g["as_"], mnames), ("total", lambda g: g["hs"] + g["as_"], tnames)):
        X = [f[target] for _, f in train]; y = [fn(g) for g, _ in train]
        readouts[f"full_{target}"] = dict(cols=list(range(len(cols))), model=ridge(X, y))
        for i, c in enumerate(cols):
            readouts[f"{c}_{target}"] = dict(cols=[i], model=ridge([[x[i]] for x in X], y))
            keep = [j for j in range(len(cols)) if j != i]
            readouts[f"minus_{c}_{target}"] = dict(cols=keep, model=ridge([[x[j] for j in keep] for x in X], y))
    with open(LAB / "kmulti-preds.jsonl", "w") as fh:
        for g, f in rows:
            rec = dict(season=g["season"], week=g["week"], home=g["home"], away=g["away"], upcoming=g["hs"] is None)
            for name, ro in readouts.items():
                target = name.rsplit("_", 1)[1]
                rec[f"kmulti_{name}"] = float(apply(ro["model"], [[f[target][j] for j in ro["cols"]]])[0])
            fh.write(json.dumps(rec) + "\n")
    with open(LAB / "kmulti-profiles.jsonl", "w") as fh:
        for (s, w, t), v in sorted(profiles.items()):
            fh.write(json.dumps(dict(season=s, week=w, team=t, qb_expected=qb_pred.get((s, w, t)), **v)) + "\n")
    (LAB / "kmulti-fit.json").write_text(json.dumps(dict(fit_seasons=[FIT_FROM, FIT_TO], channels=CHANNELS, fits=fit,
                                                          readouts={k: dict(cols=v["cols"], w=v["model"]["w"]) for k, v in readouts.items()},
                                                          margin_cols=mnames, total_cols=tnames), indent=1))
    ev = [(g, f) for g, f in rows if g["season"] >= 2022 and g["hs"] is not None]
    for target, fn in (("margin", lambda g: g["hs"] - g["as_"]), ("total", lambda g: g["hs"] + g["as_"])):
        preds = apply(readouts[f"full_{target}"]["model"], [f[target] for _, f in ev])
        base = [k1[(g["season"], g["week"], g["home"])]["pred"] if target == "margin" else k2[(g["season"], g["week"], g["home"])]["total"] for g, _ in ev]
        print(f"2022-25 {target} MAE: full {np.mean([abs(fn(g) - p) for (g, _), p in zip(ev, preds)]):.2f} vs {'K1' if target == 'margin' else 'K2'} {np.mean([abs(fn(g) - b) for (g, _), b in zip(ev, base)]):.2f}")
    print("wrote", LAB / "kmulti-preds.jsonl")


if __name__ == "__main__":
    main()
