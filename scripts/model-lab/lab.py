#!/usr/bin/env python3
"""
MODEL LAB — executes LATEST-PLAN "PREREGISTERED — MODEL LAB" exactly.

Inputs (all produced before this script was run):
  docs/evidence/2026-09-16/opener-clv-v15t/games-<season>.jsonl  fit v15, repaired openers, totals
  docs/evidence/2026-09-16/opener-clv/games-pass2[b]-<season>.jsonl  python models, lineup model
  docs/evidence/2026-09-16/model-lab/kalman-preds.jsonl  K1, K1b, K2
  docs/evidence/2026-09-16/model-lab/books.jsonl  sportsbook openers
  docs/evidence/2026-09-16/opener-repair/repaired-openers.json  opener provenance
  live DB read-only: 2015-2021 margins/totals for the key-number table (C3)

Outputs: docs/evidence/2026-09-16/model-lab/results.json, frozen-rules.json
Usage: python3 scripts/model-lab/lab.py
"""
import os
import json, math, random, sqlite3, statistics as st, sys
from collections import defaultdict
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
EV = REPO / "docs/evidence/2026-09-16"
LAB = EV / "model-lab"
LIVE = os.environ.get("GRIDIRON_DB") or str(Path(__file__).resolve().parents[2] / "server/data.sqlite")
SUSPECT = "suspect_pinnacle_placeholder_unresolved_2022_2025"
DEV = (2023, 2024)
HOLDOUT = 2025
TIER = {"availability": "in_week", "roster_strength": "in_week", "weather_total": "in_week",
        "nfelo_rating": "third_party_bulk", "nfelo_qb_adjustment": "third_party_bulk",
        "teamrankings_predictive": "third_party_bulk", "market_anchor": "opener", "market_regression": "opener",
        "blend": "mixed", "blend_total": "mixed", "lineup_roster": "in_week",
        "wired_W5": "in_week", "wired_W5_total": "in_week", "wired_W6": "in_week", "wired_W6_total": "in_week"}
WITH_WIRED2 = "--with-wired2" in sys.argv
WITH_WIRED = "--with-wired" in sys.argv or WITH_WIRED2
PART2 = ("wired_W8", "wired_W9", "wired_W10", "wired_W11", "wired_W12", "wired_W13")
EXTRA_PREDS = [x for x in os.environ.get("EXTRA_PREDS", "").split(",") if x]   # extra jsonl files with <name>_margin/_total keys
EXTRA_FAMILY = os.environ.get("EXTRA_FAMILY")                                     # prefix: only these tests form the Holm family
CONTAMINATED = {"market_correction_research", "python_correction"}
RNG = random.Random(20260916)


# ------------------------------------------------------------------ data
def load_table():
    key = lambda r: (r["season"], r["week"], r["home"])
    prov = {(g["season"], g["week"], g["home"]): g for g in json.load(open(EV / "opener-repair/repaired-openers.json"))["games"]}
    kal = {key(r): r for r in map(json.loads, open(LAB / "kalman-preds.jsonl"))}
    wired = {key(r): r for r in map(json.loads, open(LAB / "wired-preds.jsonl"))} if WITH_WIRED else {}
    if WITH_WIRED2:
        for r in map(json.loads, open(LAB / "wired2-preds.jsonl")):
            wired.setdefault(key(r), {}).update(r)
    for path in EXTRA_PREDS:
        for r in map(json.loads, open(path)):
            wired.setdefault(key(r), {}).update({k: v for k, v in r.items() if k.endswith(("_margin", "_total"))})
    books = {key(r): r for r in map(json.loads, open(LAB / "books.jsonl"))}
    p2, p2b = {}, {}
    for s in range(2021, 2026):
        for r in map(json.loads, open(EV / f"opener-clv/games-pass2-{s}.jsonl")):
            p2[key(r)] = r["models"]
        for r in map(json.loads, open(EV / f"opener-clv/games-pass2b-{s}.jsonl")):
            p2b[key(r)] = r["models"]
    rows = []
    for s in range(2021, 2026):
        for r in map(json.loads, open(EV / f"opener-clv-v15t/games-{s}.jsonl")):
            k = key(r)
            pv = prov.get(k)
            r["spread_ok"] = s >= 2022 and pv is not None and pv["open_spread_source"] != SUSPECT
            r["total_ok"] = s >= 2022 and r.get("open_total") is not None and r.get("close_total") is not None
            f, t = {}, {}
            for c in r.get("components") or []:
                if c["id"] in CONTAMINATED:
                    continue
                if c["pred"] is not None:
                    f[c["id"]] = c["pred"]
                if c.get("total") is not None:
                    t[c["id"]] = c["total"]
            if r.get("ensemble"):
                f["blend"] = r["ensemble"]["pred"]
            if r.get("ensemble_total") is not None:
                t["blend_total"] = r["ensemble_total"]
            if r.get("sim"):
                f["sim"] = r["sim"]["pred"]
            se = r.get("sim_extra") or {}
            if se.get("total") is not None:
                t["sim_total"] = se["total"]
            for mname, v in (p2.get(k) or {}).items():
                if mname not in CONTAMINATED and v is not None:
                    f[mname] = v
            if (p2b.get(k) or {}).get("lineup_roster") is not None:
                f["lineup_roster"] = p2b[k]["lineup_roster"]
            kr = kal.get(k)
            if kr:
                f["kalman_score"], f["kalman_score_epa"], t["kalman_total"] = kr["kalman_score"], kr["kalman_score_epa"], kr["kalman_total"]
                r["kalman_sd"] = kr["kalman_score_sd"]
            for wk, wv in (wired.get(k) or {}).items():
                if wk.endswith("_margin"):
                    f[wk[:-len("_margin")]] = wv
                elif wk.endswith("_total"):
                    t[wk] = wv
            r["F"], r["T"], r["books"] = f, t, books.get(k)
            rows.append(r)
    return rows


def tier(name):
    return TIER.get(name, "prior_week")


# ------------------------------------------------------------ market views
class Market:
    def __init__(self, name):
        self.name = name
        self.spread = name == "spreads"

    def ok(self, r):
        return r["spread_ok"] if self.spread else r["total_ok"]

    def preds(self, r):
        return r["F"] if self.spread else r["T"]

    def open_level(self, r):          # opener in forecast units
        return -r["open_spread"] if self.spread else r["open_total"]

    def close_level(self, r):
        return -r["close_spread"] if self.spread else r["close_total"]

    def actual(self, r):
        return r["actual_margin"] if self.spread else r["actual_total"]

    def line_move(self, r):
        return self.close_level(r) - self.open_level(r)

    def miss(self, r):
        return self.actual(r) - self.open_level(r)

    def raw_clv(self, r, pos, our=None):
        """pos=True: home (spreads) / over (totals). `our` = line actually taken in
        book terms (home spread or total); defaults to the reference opener."""
        if self.spread:
            o = r["open_spread"] if our is None else our
            c = r["close_spread"]
            return (o - c) if pos else (c - o)
        o = r["open_total"] if our is None else our
        c = r["close_total"]
        return (c - o) if pos else (o - c)

    def role(self, r, pos):
        if not self.spread:
            return "over" if pos else "under"
        o = r["open_spread"]
        fav = (pos and o < 0) or ((not pos) and o > 0)
        return ("home" if pos else "away") + ("_fav" if fav else "_dog")

    def baseline(self, train):
        out = {}
        if self.spread:
            for pos in (True, False):
                for fav in (True, False):
                    v = [self.raw_clv(r, pos) for r in train if r["open_spread"] != 0 and
                         (((pos and r["open_spread"] < 0) or ((not pos) and r["open_spread"] > 0)) == fav)]
                    out[("home" if pos else "away") + ("_fav" if fav else "_dog")] = st.mean(v) if v else 0.0
        else:
            v = [self.raw_clv(r, True) for r in train]
            out["over"], out["under"] = st.mean(v), -st.mean(v)
        return out

    def result(self, r, pos):
        if self.spread:
            m = r["actual_margin"] + r["open_spread"]
            return None if m == 0 else ((m > 0) == pos)
        d = r["actual_total"] - r["open_total"]
        return None if d == 0 else ((d > 0) == pos)


# ------------------------------------------------------------------ fits
def ols(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 100 or np.std(x) == 0:
        return None
    X = np.column_stack([np.ones_like(x), x])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = resid @ resid / (len(x) - 2)
    cov = s2 * np.linalg.inv(X.T @ X)
    return dict(a=float(beta[0]), b=float(beta[1]), t=float(beta[1] / math.sqrt(cov[1, 1])), n=len(x))


def ridge_cv(X, y, weeks):
    X, y = np.asarray(X, float), np.asarray(y, float)
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1
    Z = (X - mu) / sd
    uw = sorted(set(weeks))
    fold = {w: i % 5 for i, w in enumerate(uw)}
    folds = np.array([fold[w] for w in weeks])
    def fit(Zt, yt, lam):
        A = np.column_stack([np.ones(len(Zt)), Zt])
        P = np.eye(A.shape[1]) * lam
        P[0, 0] = 0
        return np.linalg.solve(A.T @ A + P, A.T @ yt)
    best = None
    for lam in (0.1, 1, 10, 100, 1000, 10000):
        err = 0.0
        for k in range(5):
            tr, te = folds != k, folds == k
            if te.sum() == 0 or tr.sum() < 50:
                continue
            w = fit(Z[tr], y[tr], lam)
            err += float(((np.column_stack([np.ones(te.sum()), Z[te]]) @ w - y[te]) ** 2).sum())
        if best is None or err < best[0]:
            best = (err, lam)
    w = fit(Z, y, best[1])
    return dict(w=w.tolist(), mu=mu.tolist(), sd=sd.tolist(), lam=best[1])


def ridge_predict(model, X):
    Z = (np.asarray(X, float) - np.array(model["mu"])) / np.array(model["sd"])
    return np.column_stack([np.ones(len(Z)), Z]) @ np.array(model["w"])


# ------------------------------------------------------------- strategies
def per_forecaster(method, name, mk, train, test):
    """Methods A (conversion), B (market's mistake), C (line move). Returns bets, spec."""
    tr = [r for r in train if name in mk.preds(r)]
    if method == "A":
        tr = [r for r in tr if r["season"] >= 2021]
        fit = ols([mk.preds(r)[name] for r in tr], [mk.actual(r) for r in tr])
    else:
        target = mk.miss if method == "B" else mk.line_move
        tr = [r for r in tr if mk.ok(r)]
        fit = ols([mk.preds(r)[name] - mk.open_level(r) for r in tr], [target(r) for r in tr])
    if fit is None:
        return [], None
    bets = []
    for r in test:
        if name not in mk.preds(r):
            continue
        f = mk.preds(r)[name]
        v = (fit["a"] + fit["b"] * f - mk.open_level(r)) if method == "A" else (fit["a"] + fit["b"] * (f - mk.open_level(r)))
        if abs(v) > 1e-9:
            bets.append((r, v > 0, abs(v)))
    return bets, fit


def pool_names(mk, rows):
    names = sorted({n for r in rows for n in mk.preds(r)})
    return [n for n in names if tier(n) == "prior_week"]


def design(mk, rows, names):
    return [[(mk.preds(r)[n] - mk.open_level(r)) if n in mk.preds(r) else 0.0 for n in names] for r in rows]


def combo(method, mk, train, test):
    tr = [r for r in train if mk.ok(r)]
    names = pool_names(mk, tr)
    if method == "E" or method == "G":
        keep = []
        for n in names:
            sub = [r for r in tr if n in mk.preds(r)]
            fit = ols([mk.preds(r)[n] - mk.open_level(r) for r in sub], [mk.line_move(r) for r in sub])
            if fit and fit["t"] > 2:
                keep.append(n)
        names = keep
    if not names:
        return [], dict(names=[], abstain=True), []
    if method == "G":
        bets = []
        for r in test:
            d = [mk.preds(r)[n] - mk.open_level(r) for n in names if n in mk.preds(r)]
            if d and abs(sum(d)) > 1e-9:
                bets.append((r, sum(d) > 0, abs(st.mean(d))))
        return bets, dict(names=names), []
    target = mk.miss if method == "F" else mk.line_move
    model = ridge_cv(design(mk, tr, names), [target(r) for r in tr], [(r["season"], r["week"]) for r in tr])
    pt = ridge_predict(model, design(mk, test, names)) if test else []
    ptr = ridge_predict(model, design(mk, tr, names))
    bets = [(r, v > 0, abs(v)) for r, v in zip(test, pt) if abs(v) > 1e-9]
    return bets, dict(names=names, **model), [abs(v) for v in ptr]


# ---------------------------------------------------------------- scoring
def adjusted(mk, bets, base):
    return [(r, pos, mk.raw_clv(r, pos) - base[mk.role(r, pos)], extra) for r, pos, extra in bets]


def clustered_z(scored):
    if len(scored) < 30:
        return dict(n=len(scored), mean=None, z=None, p=None)
    cl = defaultdict(list)
    for r, _, a, _ in scored:
        cl[(r["season"], r["week"])].append(a)
    means = [st.mean(v) for v in cl.values()]
    se = st.stdev(means) / math.sqrt(len(means))
    m = st.mean(a for _, _, a, _ in scored)
    z = m / se if se else None
    return dict(n=len(scored), mean=m, z=z, p=math.erfc(abs(z) / math.sqrt(2)) if z is not None else None)


def ats(mk, scored):
    res = [mk.result(r, pos) for r, pos, _, _ in scored]
    res = [x for x in res if x is not None]
    return (sum(res) / len(res), len(res)) if res else (None, 0)


def diff_bootstrap(top, rest, reps=2000):
    """Week-cluster bootstrap p-value for mean(top) - mean(rest)."""
    if len(top) < 30 or len(rest) < 30:
        return None, None
    weeks = sorted({(r["season"], r["week"]) for r, *_ in top + rest})
    bt, br = defaultdict(list), defaultdict(list)
    for r, _, a, _ in top:
        bt[(r["season"], r["week"])].append(a)
    for r, _, a, _ in rest:
        br[(r["season"], r["week"])].append(a)
    obs = st.mean(a for *_, a, _ in top) - st.mean(a for *_, a, _ in rest)
    draws = []
    for _ in range(reps):
        sample = [RNG.choice(weeks) for _ in weeks]
        t = [a for w in sample for a in bt[w]]
        s = [a for w in sample for a in br[w]]
        if t and s:
            draws.append(st.mean(t) - st.mean(s))
    sd = st.pstdev(draws)
    z = obs / sd if sd else None
    return obs, (math.erfc(abs(z) / math.sqrt(2)) if z is not None else None)


def holm(tests):
    live = sorted([(k, v) for k, v in tests.items() if v is not None], key=lambda kv: kv[1])
    m, out, blocked = len(live), {}, False
    for i, (k, p) in enumerate(live):
        a = 0.05 / (m - i)
        ok = (p <= a) and not blocked
        blocked = blocked or not ok
        out[k] = dict(p=p, alpha=a, passes=ok)
    return out


def season_split(rows, S):
    return [r for r in rows if r["season"] < S], [r for r in rows if r["season"] == S]


def run_dev(strategy, mk, rows):
    """Score a strategy on 2023 and 2024, each trained on earlier seasons only."""
    scored = []
    for S in DEV:
        train, test = season_split(rows, S)
        test = [r for r in test if mk.ok(r)]
        base = mk.baseline([r for r in train if mk.ok(r)])
        scored += adjusted(mk, strategy(train, test), base)
    return scored


# --------------------------------------------------------------- key numbers
def keynumber_pmf(market):
    con = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    counts = defaultdict(int)
    if market == "spreads":
        q = "SELECT team_score - opp_score + spread FROM game_lines WHERE home=1 AND season BETWEEN 2015 AND 2021 AND team_score IS NOT NULL AND spread IS NOT NULL"
        for (v,) in con.execute(q):
            counts[round(v * 2) / 2] += 1
            counts[round(-v * 2) / 2] += 1
    else:
        q = "SELECT team_score + opp_score - total FROM game_lines WHERE home=1 AND season BETWEEN 2015 AND 2021 AND team_score IS NOT NULL AND total IS NOT NULL"
        for (v,) in con.execute(q):
            counts[round(v * 2) / 2] += 1
            counts[round(-v * 2) / 2] += 1
    n = sum(counts.values())
    return {k: c / n for k, c in counts.items()}


def cover_prob(pmf, shift):
    """P(win) + half P(push) when the result residual vs close must exceed `shift`."""
    return sum(p for k, p in pmf.items() if k > shift) + 0.5 * pmf.get(shift, 0.0)


def prob_clv(pmf, scored):
    """Points of CLV -> win probability, honouring key numbers."""
    base = cover_prob(pmf, 0.0)
    vals = [cover_prob(pmf, -round(mk_raw * 2) / 2) - base for mk_raw in scored]
    return st.mean(vals) if vals else None


# ------------------------------------------------------------------- main
def main():
    rows = load_table()
    res = dict(n_rows=len(rows), dev=list(DEV), holdout=HOLDOUT, tests={}, strategies={})
    tests = {}
    markets = {m: Market(m) for m in ("spreads", "totals")}
    strategies = {}

    for mname, mk in markets.items():
        names = sorted({n for r in rows for n in mk.preds(r)})
        for n in names:
            for method in "ABC":
                strat = (lambda train, test, method=method, n=n, mk=mk: per_forecaster(method, n, mk, train, test)[0])
                sc = run_dev(strat, mk, rows)
                cz = clustered_z(sc)
                rate, nres = ats(mk, sc)
                key = f"{mname}|{method}|{n}"
                res["strategies"][key] = dict(tier=tier(n), ats=rate, ats_n=nres, **cz)
                if cz["p"] is not None:
                    tests[key] = cz["p"]
        for method in "DEFG":
            strat = (lambda train, test, method=method, mk=mk: combo(method, mk, train, test)[0])
            sc = run_dev(strat, mk, rows)
            cz = clustered_z(sc)
            rate, nres = ats(mk, sc)
            key = f"{mname}|{method}|pool"
            res["strategies"][key] = dict(tier="prior_week", ats=rate, ats_n=nres, **cz)
            strategies[key] = strat
            if cz["p"] is not None:
                tests[key] = cz["p"]
        for n in names:
            if n.startswith("kalman") or n.startswith("wired_") or (EXTRA_FAMILY and n.startswith(EXTRA_FAMILY)):
                strategies[f"{mname}|C|{n}"] = (lambda train, test, n=n, mk=mk: per_forecaster("C", n, mk, train, test)[0])

    # ----- H tests (spreads)
    mk = markets["spreads"]
    tier_fns = {}
    def tiered(name, conf_fn, bet_fn, seasons=DEV, record=True):
        tier_fns[name] = bet_fn
        top, rest = [], []
        for S in seasons:
            train, test = season_split(rows, S)
            tr = [r for r in train if mk.ok(r)]
            te = [r for r in test if mk.ok(r)]
            base = mk.baseline(tr)
            thr, bets = bet_fn(tr, te)
            for r, pos, a, extra in adjusted(mk, bets, base):
                (top if extra >= thr else rest).append((r, pos, a, extra))
        if not record:
            return top, rest
        d, p = diff_bootstrap(top, rest)
        res["tests"][name] = dict(top=clustered_z(top), rest=clustered_z(rest), diff=d, p=p)
        if p is not None:
            tests[name] = p
        return top, rest

    from statistics import NormalDist
    Phi = NormalDist().cdf
    def h1(tr, te):
        conf = lambda r: abs(Phi((r["F"]["kalman_score"] + r["open_spread"]) / r["kalman_sd"]) - 0.5)
        thr = float(np.percentile([conf(r) for r in tr if "kalman_score" in r["F"]], 75))
        bets = [(r, r["F"]["kalman_score"] + r["open_spread"] > 0, conf(r)) for r in te if "kalman_score" in r["F"] and abs(r["F"]["kalman_score"] + r["open_spread"]) > 1e-9]
        return thr, bets
    tiered("H1_kalman_cover_prob", None, h1)
    cal_x, cal_y = [], []
    for r in rows:
        if r["season"] in DEV and mk.ok(r) and "kalman_score" in r["F"]:
            p = min(max(Phi((r["F"]["kalman_score"] + r["open_spread"]) / r["kalman_sd"]), 1e-6), 1 - 1e-6)
            y = mk.result(r, True)
            if y is not None:
                cal_x.append(math.log(p / (1 - p))); cal_y.append(1.0 if y else 0.0)
    X = np.column_stack([np.ones(len(cal_x)), cal_x]); w = np.zeros(2)
    for _ in range(50):
        pr = 1 / (1 + np.exp(-(X @ w))); W = pr * (1 - pr)
        H = X.T @ (X * W[:, None]); w += np.linalg.solve(H, X.T @ (np.array(cal_y) - pr))
    se = math.sqrt(np.linalg.inv(H)[1, 1])
    res["tests"]["H1_kalman_cover_prob"]["calibration_slope"] = dict(slope=float(w[1]), se=se, n=len(cal_x))

    def h2(tr, te):
        bets, _, ptr = combo("D", mk, tr, te)
        return (float(np.percentile(ptr, 75)) if ptr else float("inf")), bets
    tiered("H2_stack_magnitude", None, h2)

    def h3(tr, te):
        def conf(r):
            se_ = r.get("sim_extra") or {}
            if "sim" not in r["F"] or not se_.get("margin_sd"):
                return None
            return abs(r["F"]["sim"] + r["open_spread"]) / se_["margin_sd"]
        vals = [conf(r) for r in tr if conf(r) is not None]
        thr = float(np.percentile(vals, 75)) if vals else float("inf")
        bets = [(r, r["F"]["sim"] + r["open_spread"] > 0, conf(r)) for r in te if conf(r) is not None and conf(r) > 0]
        return thr, bets
    tiered("H3_sim_lean_over_sd", None, h3)

    def h4(tr, te):
        disp = lambda r: ((r.get("books") or {}).get("spreads") or {}).get("dispersion")
        vals = [disp(r) for r in tr if disp(r) is not None]
        thr = float(np.median(vals)) if vals else float("inf")
        bets, _, _ = combo("D", mk, tr, te)
        return thr, [(r, pos, disp(r)) for r, pos, _ in bets if disp(r) is not None]
    tiered("H4_book_dispersion", None, h4)

    # ----- C2 stale-book, both markets
    for mname, mk2 in markets.items():
        scored = []
        for S in DEV:
            train, test = season_split(rows, S)
            base = mk2.baseline([r for r in train if mk2.ok(r)])
            for r in test:
                if not mk2.ok(r):
                    continue
                stale = ((r.get("books") or {}).get(mname) or {}).get("stale") or []
                ref = r["open_spread"] if mk2.spread else r["open_total"]
                if not stale:
                    continue
                b = max(stale, key=lambda x: abs(x["line"] - ref))
                pos = (b["line"] > ref) if mk2.spread else (b["line"] < ref)
                a = mk2.raw_clv(r, pos, our=b["line"]) - base[mk2.role(r, pos)]
                scored.append((r, pos, a, b["price"]))
        cz = clustered_z(scored)
        res["tests"][f"C2_stale_book|{mname}"] = dict(**cz, mean_price=st.mean(x[3] for x in scored) if scored else None)
        if cz["p"] is not None:
            tests[f"C2_stale_book|{mname}"] = cz["p"]

    # ----- Holm over the development family
    if EXTRA_FAMILY:
        tests = {k: v for k, v in tests.items() if f"|{EXTRA_FAMILY}" in k or k.endswith("|pool")}
    elif WITH_WIRED:
        part2 = lambda k: any(f"|{p}" in k for p in PART2)
        tests = {k: v for k, v in tests.items() if (part2(k) if WITH_WIRED2 else "wired_" in k) or k.endswith("|pool")}
    res["holm_dev"] = holm(tests)
    res["dev_family_size"] = len(tests)
    res["dev_holm_passes"] = sorted(k for k, v in res["holm_dev"].items() if v["passes"])

    # ----- champions
    champs = {}
    for mname in markets:
        cands = {k: v for k, v in res["strategies"].items() if k.startswith(mname + "|") and
                 (k.endswith("|pool") or (k.split("|")[1] == "C" and (k.split("|")[2].startswith("kalman") or
                  (WITH_WIRED and k.split("|")[2].startswith("wired_") and tier(k.split("|")[2]) == "prior_week")
                  or (EXTRA_FAMILY and k.split("|")[2].startswith(EXTRA_FAMILY)))))}
        best = max((k for k in cands if cands[k]["z"] is not None), key=lambda k: cands[k]["z"])
        champs[mname] = best
    res["champions"] = champs

    # ----- confirmatory 2025 for champions only
    conf_p = {}
    pmfs = {m: keynumber_pmf(m) for m in markets}
    for mname, key in champs.items():
        mk2 = markets[mname]
        _, method, name = key.split("|")
        strat = strategies.get(key) or (lambda train, test, method=method, name=name, mk2=mk2: per_forecaster(method, name, mk2, train, test)[0])
        train, test = season_split(rows, HOLDOUT)
        test = [r for r in test if mk2.ok(r)]
        base = mk2.baseline([r for r in train if mk2.ok(r)])
        sc = adjusted(mk2, strat(train, test), base)
        cz = clustered_z(sc)
        rate, nres = ats(mk2, sc)
        raw = [mk2.raw_clv(r, pos) for r, pos, _, _ in sc]
        res.setdefault("holdout_results", {})[mname] = dict(strategy=key, ats=rate, ats_n=nres, prob_clv=prob_clv(pmfs[mname], raw), **cz)
        dev_sc = run_dev(strat, mk2, rows)
        res["holdout_results"][mname]["dev_prob_clv"] = prob_clv(pmfs[mname], [mk2.raw_clv(r, pos) for r, pos, _, _ in dev_sc])
        conf_p[mname] = cz["p"] if cz["z"] is not None and cz["z"] > 0 else 1.0
        # C1 line shopping on the champion's 2025 bets
        extra, shop_clv = [], []
        for r, pos, _, _ in sc:
            bk = (r.get("books") or {}).get(mname) or {}
            best = bk.get("best_home" if pos else "best_away") if mk2.spread else bk.get("best_over" if pos else "best_under")
            if not best:
                continue
            if mk2.spread:
                ours = best["line"] if pos else -best["line"]
                ref = r["open_spread"]
                extra.append((ours - ref) if pos else (ref - ours))
                shop_clv.append(mk2.raw_clv(r, pos, our=ours))
            else:
                ref = r["open_total"]
                extra.append((ref - best["line"]) if pos else (best["line"] - ref))
                shop_clv.append(mk2.raw_clv(r, pos, our=best["line"]))
        res["holdout_results"][mname]["line_shopping"] = dict(n=len(extra), mean_extra_points=st.mean(extra) if extra else None,
                                                     mean_raw_clv_best_line=st.mean(shop_clv) if shop_clv else None,
                                                     mean_raw_clv_reference=st.mean(raw) if raw else None)
    res["holm_confirmatory"] = holm(conf_p)

    # ----- confidence-tier criterion
    tier_verdicts = {}
    for name in ("H1_kalman_cover_prob", "H2_stack_magnitude", "H3_sim_lean_over_sd", "H4_book_dispersion"):
        passes_dev = res["holm_dev"].get(name, {}).get("passes", False)
        slope_ok = name != "H1_kalman_cover_prob" or res["tests"][name]["calibration_slope"]["slope"] >= 0.5
        v = dict(dev_holm=passes_dev, slope_floor=slope_ok, holdout_top=None, passes=False)
        if passes_dev and slope_ok:
            top, _ = tiered(name, None, tier_fns[name], seasons=(HOLDOUT,), record=False)
            v["holdout_top"] = clustered_z(top)
            v["passes"] = bool(v["holdout_top"]["mean"] is not None and v["holdout_top"]["mean"] > 0)
        tier_verdicts[name] = v
    res["confidence_verdicts"] = tier_verdicts

    # ----- frozen rules: champions refit on 2022-2025
    frozen = {}
    for mname, key in champs.items():
        mk2 = markets[mname]
        _, method, name = key.split("|")
        allrows = [r for r in rows]
        if name == "pool":
            _, spec, _ = combo(method, mk2, allrows, [])
        else:
            _, spec = per_forecaster(method, name, mk2, allrows, [])
        frozen[mname] = dict(strategy=key, trained_on="2021-2025 (2021 only for score conversions)", spec=spec)
    suffix = f"-{EXTRA_FAMILY.rstrip('_')}" if EXTRA_FAMILY else ("-wired2" if WITH_WIRED2 else ("-wired" if WITH_WIRED else ""))
    (LAB / f"frozen-rules{suffix}.json").write_text(json.dumps(dict(frozen_at="2026-09-16", rules=frozen), indent=1, default=float))
    (LAB / f"results{suffix}.json").write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps(dict(family=res["dev_family_size"], dev_holm_passes=res["dev_holm_passes"], champions=champs,
                          holdout=res["holdout_results"], holm_confirmatory=res["holm_confirmatory"],
                          confidence=res["confidence_verdicts"]), indent=1, default=float))


if __name__ == "__main__":
    main()
