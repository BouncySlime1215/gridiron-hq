#!/usr/bin/env python3
"""
CLV + KELLY SCORECARD — the standard grading for every strategy (Nick,
2026-09-16: "everything should be based on CLV and kelly").

Every strategy the model lab, data wiring and earlier tests produced is
re-graded the same way, at two lines: the reference opener (Pinnacle's price
when its opener is valid, else -110) and the best line and price available
across books posted within 48 h of Pinnacle's opener.

Per bet:
  clv_points   our line minus the closing line, from the backed side.
  p_true       fair win probability of OUR bet: Pinnacle's no-vig closing
               probability for that side, shifted by the key-number
               probability of the points between our line and the close
               (2015-2021 residual distribution; pushes count half).
  clv_prob     p_true minus the no-vig closing probability (pp of CLV).
  ev           p_true * payout - (1 - p_true), per unit staked, at our price.
Kelly (quarter Kelly, the production DEFAULT_KELLY_FRACTION, capped at 5% of
bankroll per bet): the stake must be knowable before the bet, so a strategy's
estimated edge in season S is its OWN out-of-sample mean clv_prob from earlier
scored seasons (2023 for 2024; 2023-24 for 2025) added to the no-vig opening
probability of the side. 2023 has no track record, so Kelly stakes nothing
there. Growth is reported two ways: expected log growth with p_true as truth
(low variance) and realized log growth from actual results.

Seasons: nested as in lab.py (each season scored by fits on earlier seasons).
2023-24 = development; 2025 reported separately — it is no longer an untouched
holdout for strategies already examined on it tonight.
Significance: week-clustered z of mean ev over 2023-24 at the reference line,
Holm-corrected across every strategy and line variant scored (one-sided: positive EV).

Outputs: docs/evidence/2026-09-16/model-lab/clv-kelly-scorecard.csv and .json
Usage: python3 scripts/model-lab/clv_kelly.py
"""
import csv, json, math, sqlite3, statistics as st
from collections import defaultdict
from pathlib import Path
import numpy as np
import lab

lab.WITH_WIRED = lab.WITH_WIRED2 = True
KELLY_MULT, KELLY_CAP = 0.25, 0.05
SEASONS = (2023, 2024, 2025)


def payout(price):
    return price / 100 if price > 0 else 100 / -price


def novig(pa, pb):
    if pa is None or pb is None:
        return None
    ia, ib = 1 / (1 + payout(pa)), 1 / (1 + payout(pb))
    return ia / (ia + ib)


def load_prices():
    con = sqlite3.connect(f"file:{lab.LIVE}?mode=ro", uri=True)
    out = defaultdict(dict)
    for s, w, h, a, market, side, phase, line, price in con.execute(
            """SELECT season, week, home, away, market, side, phase, line, price FROM nfl_odds_archive
               WHERE book='pinnacle' AND market IN ('spreads','totals') AND season BETWEEN 2022 AND 2025"""):
        role = ("home" if side == h else "away") if market == "spreads" else side.lower()
        out[(s, w, h)][(market, role, phase)] = (line, price)
    return out


class Grader:
    def __init__(self, rows):
        self.prices = load_prices()
        self.pmf = {m: lab.keynumber_pmf(m) for m in ("spreads", "totals")}
        self.base = {m: lab.cover_prob(self.pmf[m], 0.0) for m in self.pmf}
        self.prov = {(g["season"], g["week"], g["home"]): g for g in
                     json.load(open(lab.EV / "opener-repair/repaired-openers.json"))["games"]}

    def sides(self, mk, pos):
        return ("home", "away") if mk.spread and pos else (("away", "home") if mk.spread else (("over", "under") if pos else ("under", "over")))

    def bet(self, mk, r, pos, variant):
        key = (r["season"], r["week"], r["home"])
        pr = self.prices.get(key, {})
        me, other = self.sides(mk, pos)
        m = mk.name
        p_close = novig((pr.get((m, me, "close")) or (None, None))[1], (pr.get((m, other, "close")) or (None, None))[1]) or 0.5
        p_open = novig((pr.get((m, me, "open")) or (None, None))[1], (pr.get((m, other, "open")) or (None, None))[1]) or 0.5
        if variant == "reference":
            our = r["open_spread"] if mk.spread else r["open_total"]
            pin_ok = (self.prov.get(key, {}).get("open_spread_source") == "pinnacle_archive_reopen_2022_2025") if mk.spread \
                else (self.prov.get(key, {}).get("open_total_source") is None)
            price = (pr.get((m, me, "open")) or (None, -110))[1] if pin_ok else -110
            price = price if price is not None else -110
        else:
            bk = (r.get("books") or {}).get(m) or {}
            best = bk.get({("spreads", True): "best_home", ("spreads", False): "best_away",
                           ("totals", True): "best_over", ("totals", False): "best_under"}[(m, pos)])
            if not best:
                return None
            our = (best["line"] if pos else -best["line"]) if mk.spread else best["line"]
            price = best["price"]
        v = mk.raw_clv(r, pos, our=our)
        gain = lab.cover_prob(self.pmf[m], -round(v * 2) / 2) - self.base[m]
        p_true = min(max(p_close + gain, 0.01), 0.99)
        b = payout(price)
        if mk.spread:
            d = r["actual_margin"] + our
        else:
            d = r["actual_total"] - our
        result = None if d == 0 else ((d > 0) == pos)
        return dict(clv=v, clv_prob=gain, p_true=p_true, p_open=p_open, b=b, price=price,
                    ev=p_true * b - (1 - p_true), result=result, week=(r["season"], r["week"]))


def strategies(rows):
    S = {}
    mks = {m: lab.Market(m) for m in ("spreads", "totals")}
    for m, mk in mks.items():
        names = sorted({n for r in rows for n in mk.preds(r)})
        for n in names:
            for method in "ABC":
                S[f"{m}|{method}|{n}"] = (mk, lambda tr, te, method=method, n=n, mk=mk: lab.per_forecaster(method, n, mk, tr, te)[0])
        for method in "DEFG":
            S[f"{m}|{method}|pool"] = (mk, lambda tr, te, method=method, mk=mk: lab.combo(method, mk, tr, te)[0])
        S[f"{m}|baseline|always_{'home' if mk.spread else 'over'}"] = (mk, lambda tr, te: [(r, True, 0) for r in te])
        S[f"{m}|baseline|always_{'away' if mk.spread else 'under'}"] = (mk, lambda tr, te: [(r, False, 0) for r in te])
    sp = mks["spreads"]
    S["spreads|baseline|always_favorite"] = (sp, lambda tr, te: [(r, r["open_spread"] < 0, 0) for r in te if r["open_spread"] != 0])
    S["spreads|baseline|always_underdog"] = (sp, lambda tr, te: [(r, r["open_spread"] > 0, 0) for r in te if r["open_spread"] != 0])

    SURV = ["second_half_eff", "opp_adjusted", "dynamic_state", "epa_net"]
    def comp(r):
        v = [r["F"].get(k) for k in SURV]
        return sum(v) / 4 if all(x is not None for x in v) else None
    def disp(r):
        v = [x for k, x in r["F"].items() if not k.startswith(("wired_", "kalman", "blend", "sim", "python", "lineup", "market_"))]
        return st.pstdev(v) if len(v) >= 10 else None
    def comp_bets(te, keep=lambda r: True):
        return [(r, comp(r) + r["open_spread"] > 0, abs(comp(r) + r["open_spread"])) for r in te
                if comp(r) is not None and abs(comp(r) + r["open_spread"]) > 1e-9 and keep(r)]
    S["spreads|filter|composite_all"] = (sp, lambda tr, te: comp_bets(te))
    S["spreads|filter|composite_spread_le_7"] = (sp, lambda tr, te: comp_bets(te, lambda r: abs(r["open_spread"]) <= 7))
    def low_disp(tr, te, extra=lambda r: True):
        vals = [disp(r) for r in tr if disp(r) is not None]
        med = float(np.median(vals)) if vals else float("inf")
        return comp_bets(te, lambda r: disp(r) is not None and disp(r) <= med and extra(r))
    S["spreads|filter|composite_low_disagreement"] = (sp, lambda tr, te: low_disp(tr, te))
    S["spreads|filter|composite_both_filters"] = (sp, lambda tr, te: low_disp(tr, te, lambda r: abs(r["open_spread"]) <= 7))

    from statistics import NormalDist
    Phi = NormalDist().cdf
    def kal_top(tr, te):
        conf = lambda r: abs(Phi((r["F"]["kalman_score"] + r["open_spread"]) / r["kalman_sd"]) - 0.5)
        thr = float(np.percentile([conf(r) for r in tr if "kalman_score" in r["F"] and r.get("kalman_sd")], 75))
        return [(r, r["F"]["kalman_score"] + r["open_spread"] > 0, 0) for r in te
                if "kalman_score" in r["F"] and r.get("kalman_sd") and conf(r) >= thr and abs(r["F"]["kalman_score"] + r["open_spread"]) > 1e-9]
    S["spreads|tier|kalman_cover_prob_top25"] = (sp, kal_top)
    def sim_top(tr, te):
        def conf(r):
            e = r.get("sim_extra") or {}
            return abs(r["F"]["sim"] + r["open_spread"]) / e["margin_sd"] if "sim" in r["F"] and e.get("margin_sd") else None
        vals = [conf(r) for r in tr if conf(r) is not None]
        thr = float(np.percentile(vals, 75)) if vals else float("inf")
        return [(r, r["F"]["sim"] + r["open_spread"] > 0, 0) for r in te if conf(r) is not None and conf(r) >= thr and conf(r) > 0]
    S["spreads|tier|sim_lean_over_sd_top25"] = (sp, sim_top)
    def stack_top(tr, te):
        bets, _, ptr = lab.combo("D", sp, tr, te)
        thr = float(np.percentile(ptr, 75)) if ptr else float("inf")
        return [(r, pos, x) for r, pos, x in bets if x >= thr]
    S["spreads|tier|stack_magnitude_top25"] = (sp, stack_top)
    return S


def stale(mk, rows_test):
    out = []
    for r in rows_test:
        stale_q = ((r.get("books") or {}).get(mk.name) or {}).get("stale") or []
        if not stale_q:
            continue
        ref = r["open_spread"] if mk.spread else r["open_total"]
        b = max(stale_q, key=lambda x: abs(x["line"] - ref))
        pos = (b["line"] > ref) if mk.spread else (b["line"] < ref)
        out.append((r, pos, b))
    return out


def clustered(vals_weeks):
    if len(vals_weeks) < 30:
        return None
    cl = defaultdict(list)
    for v, w in vals_weeks:
        cl[w].append(v)
    means = [st.mean(v) for v in cl.values()]
    se = st.stdev(means) / math.sqrt(len(means))
    m = st.mean(v for v, _ in vals_weeks)
    return m / se if se else None


def summarize(recs):
    if not recs:
        return dict(n=0)
    graded = [x for x in recs if x["result"] is not None]
    roi = st.mean((x["b"] if x["result"] else -1.0) if x["result"] is not None else 0.0 for x in recs)
    return dict(n=len(recs), clv=st.mean(x["clv"] for x in recs), clv_prob_pp=100 * st.mean(x["clv_prob"] for x in recs),
                ev_pct=100 * st.mean(x["ev"] for x in recs), win_pct=100 * sum(x["result"] for x in graded) / len(graded) if graded else None,
                flat_roi_pct=100 * roi, ev_z=clustered([(x["ev"], x["week"]) for x in recs]))


def kelly(by_season):
    """Quarter Kelly, stake from out-of-sample track record in earlier scored seasons."""
    track, exp_log, real_log, staked, bets = [], 0.0, 0.0, 0.0, 0
    per = {}
    for S in SEASONS:
        recs = by_season.get(S, [])
        gain = st.mean(x["clv_prob"] for x in track) if track else None
        e = rl = 0.0; nb = 0
        if gain is not None:
            for x in recs:
                p = min(max(x["p_open"] + gain, 0.01), 0.99)
                f = min(KELLY_CAP, KELLY_MULT * max(0.0, (p * x["b"] - (1 - p)) / x["b"]))
                if f <= 0:
                    continue
                nb += 1
                e += x["p_true"] * math.log(1 + f * x["b"]) + (1 - x["p_true"]) * math.log(1 - f)
                if x["result"] is not None:
                    rl += math.log(1 + f * x["b"]) if x["result"] else math.log(1 - f)
                staked += f
        per[S] = dict(track_gain_pp=None if gain is None else 100 * gain, kelly_bets=nb,
                      expected_growth_pct=100 * (math.exp(e) - 1), realized_growth_pct=100 * (math.exp(rl) - 1))
        track += recs
    return per


def main():
    rows = lab.load_table()
    g = Grader(rows)
    strat = strategies(rows)
    table = []
    for variant in ("reference", "best_book"):
        for key, (mk, fn) in strat.items():
            by = {}
            for S in SEASONS:
                train, test = lab.season_split(rows, S)
                test = [r for r in test if mk.ok(r)]
                recs = [g.bet(mk, r, pos, variant) for r, pos, _ in fn(train, test)]
                by[S] = [x for x in recs if x is not None]
            table.append((variant, key, mk, by))
    for mname in ("spreads", "totals"):
        mk = lab.Market(mname)
        by = {}
        for S in SEASONS:
            _, test = lab.season_split(rows, S)
            recs = []
            for r, pos, b in stale(mk, [r for r in test if mk.ok(r)]):
                x = g.bet(mk, r, pos, "reference")
                our = b["line"] if mk.spread else b["line"]
                v = mk.raw_clv(r, pos, our=our)
                gain = lab.cover_prob(g.pmf[mname], -round(v * 2) / 2) - g.base[mname]
                p_close = x["p_true"] - x["clv_prob"]
                p_true = min(max(p_close + gain, 0.01), 0.99)
                bb = payout(b["price"])
                d = (r["actual_margin"] + our) if mk.spread else (r["actual_total"] - our)
                recs.append(dict(clv=v, clv_prob=gain, p_true=p_true, p_open=x["p_open"], b=bb, price=b["price"],
                                 ev=p_true * bb - (1 - p_true), result=None if d == 0 else ((d > 0) == pos), week=x["week"]))
            by[S] = recs
        table.append(("stale_book", f"{mname}|market|stale_book", mk, by))

    out = []
    for variant, key, mk, by in table:
        dev = summarize(by[2023] + by[2024])
        hold = summarize(by[2025])
        k = kelly(by)
        tier = lab.tier(key.split("|")[2]) if key.split("|")[1] in "ABC" else "prior_week"
        out.append(dict(variant=variant, strategy=key, tier=tier,
                        dev_n=dev.get("n"), dev_clv_pts=dev.get("clv"), dev_clv_prob_pp=dev.get("clv_prob_pp"),
                        dev_ev_pct=dev.get("ev_pct"), dev_ev_z=dev.get("ev_z"), dev_win_pct=dev.get("win_pct"), dev_flat_roi_pct=dev.get("flat_roi_pct"),
                        y2025_n=hold.get("n"), y2025_clv_pts=hold.get("clv"), y2025_clv_prob_pp=hold.get("clv_prob_pp"),
                        y2025_ev_pct=hold.get("ev_pct"), y2025_flat_roi_pct=hold.get("flat_roi_pct"),
                        kelly_2024_track_pp=k[2024]["track_gain_pp"], kelly_2024_bets=k[2024]["kelly_bets"],
                        kelly_2024_expected_growth_pct=k[2024]["expected_growth_pct"], kelly_2024_realized_growth_pct=k[2024]["realized_growth_pct"],
                        kelly_2025_track_pp=k[2025]["track_gain_pp"], kelly_2025_bets=k[2025]["kelly_bets"],
                        kelly_2025_expected_growth_pct=k[2025]["expected_growth_pct"], kelly_2025_realized_growth_pct=k[2025]["realized_growth_pct"]))
    ref = {f'{o["variant"]}|{o["strategy"]}': o["dev_ev_z"] for o in out if o["dev_ev_z"] is not None}
    pz = {k: (math.erfc(z / math.sqrt(2)) if z > 0 else 1.0) for k, z in ref.items()}
    h = lab.holm(pz)
    for o in out:
        o["dev_ev_holm_pass"] = bool(h.get(f'{o["variant"]}|{o["strategy"]}', {}).get("passes"))
    out.sort(key=lambda o: -(o["kelly_2025_expected_growth_pct"] or 0) - (o["kelly_2024_expected_growth_pct"] or 0))
    path = lab.LAB / "clv-kelly-scorecard.csv"
    with open(path, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
        wr.writeheader()
        for o in out:
            wr.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in o.items()})
    (lab.LAB / "clv-kelly-scorecard.json").write_text(json.dumps(out, indent=1))
    print(f"{len(out)} strategy x line variants scored; Holm family {len(pz)}; wrote {path.relative_to(lab.REPO)}")


if __name__ == "__main__":
    main()
