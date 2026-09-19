#!/usr/bin/env python3
"""
Opener lab shared table: one row per game x market (spreads, totals),
2022-2025, every field known at the open plus the outcome fields used to grade.
Read-only against the live database. See LATEST-PLAN "PREREGISTERED — OPENER LAB".

move       signed toward HOME (spreads: open_spread - close_spread) / OVER (totals: close - open)
skew       Pinnacle opening no-vig probability of home/over minus 0.5
cons_gap   [LEAKY, kept for the record] Pinnacle opener minus other-book median opener (books posted within 48 h), in the
           same direction as `move` (positive = the other books lean further toward home/over)
kalman_dep Kalman forecast minus the opener, toward home/over
momentum   market move toward each team in its previous clean game this season, home minus away
Output: docs/evidence/2026-09-16/opener-lab/table.jsonl
"""
import os
import json, sqlite3, statistics as st
from collections import defaultdict
from datetime import datetime, date
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EV = REPO / "docs/evidence/2026-09-16"
LIVE = os.environ.get("GRIDIRON_DB") or str(Path(__file__).resolve().parents[2] / "server/data.sqlite")
SUSPECT = "suspect_pinnacle_placeholder_unresolved_2022_2025"


def ts(x):
    return datetime.fromisoformat(x.replace("Z", "+00:00")) if x else None


def payout(price):
    return price / 100 if price > 0 else 100 / -price


def novig(pa, pb):
    if pa is None or pb is None:
        return None
    a, b = 1 / (1 + payout(pa)), 1 / (1 + payout(pb))
    return a / (a + b)


def main():
    con = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    prov = {(g["season"], g["week"], g["home"]): g for g in json.load(open(EV / "opener-repair/repaired-openers.json"))["games"]}
    kal = {(r["season"], r["week"], r["home"]): r for r in map(json.loads, open(EV / "model-lab/kalman-preds.jsonl"))}
    gl = {}
    for s, w, h, a, sp, tot, hs, as_, gd, gt, div, rest in con.execute(
            """SELECT season, week, team, opponent, spread, total, team_score, opp_score, gameday, gametime, div_game, rest_days
               FROM game_lines WHERE home=1 AND season BETWEEN 2022 AND 2025 AND team_score IS NOT NULL AND COALESCE(neutral_site,0)=0"""):
        gl[(s, w, h)] = dict(away=a, close_spread=sp, close_total=tot, margin=hs - as_, total=hs + as_, gameday=gd, gametime=gt, div=div, home_rest=rest)
    away_rest = {(s, w, t): r for s, w, t, r in con.execute("SELECT season, week, team, rest_days FROM game_lines WHERE home=0 AND season BETWEEN 2022 AND 2025")}
    arch = defaultdict(dict)
    for s, w, h, a, ko, book, market, side, line, price, upd in con.execute(
            """SELECT season, week, home, away, commence_time, book, market, side, line, price, book_updated_at FROM nfl_odds_archive
               WHERE phase='open' AND market IN ('spreads','totals') AND season BETWEEN 2022 AND 2025 AND line IS NOT NULL"""):
        role = ("home" if side == h else "away") if market == "spreads" else side.lower()
        arch[(s, w, h)][(market, role, book)] = dict(line=line, price=price, t=ts(upd), ko=ts(ko))

    rows = []
    for key, g in sorted(gl.items()):
        s, w, h = key
        pv = prov.get(key)
        if pv is None:
            continue
        q = arch.get(key, {})
        k = kal.get(key, {})
        wd = date.fromisoformat(g["gameday"]).weekday() if g["gameday"] else None
        primetime = bool((g["gametime"] or "") >= "19:00" or wd in (0, 3))
        short = (g["home_rest"] is not None and g["home_rest"] <= 5) or (away_rest.get((s, w, g["away"])) is not None and away_rest[(s, w, g["away"])] <= 5)
        for market in ("spreads", "totals"):
            pos, neg = ("home", "away") if market == "spreads" else ("over", "under")
            if market == "spreads":
                if pv["open_spread_source"] == SUSPECT or pv["open_spread"] is None or g["close_spread"] is None:
                    continue
                open_, close = pv["open_spread"], g["close_spread"]
                move = open_ - close
                pin_valid = pv["open_spread_source"] == "pinnacle_archive_reopen_2022_2025"
                size = abs(open_)
                key_num = size in (3.0, 7.0)
                kdep = (k["kalman_score"] + open_) if "kalman_score" in k else None
            else:
                if pv["open_total"] is None or g["close_total"] is None:
                    continue
                open_, close = pv["open_total"], g["close_total"]
                move = close - open_
                pin_valid = pv["open_total_source"] is None
                size = open_
                key_num = open_ in (41.0, 44.0, 47.0, 51.0)
                kdep = (k["kalman_total"] - open_) if "kalman_total" in k else None
            pin = q.get((market, pos, "pinnacle"))
            pin_o = q.get((market, neg, "pinnacle"))
            skew = None
            if pin_valid and pin and pin_o:
                nv = novig(pin["price"], pin_o["price"])
                skew = None if nv is None else nv - 0.5
            lead_h = lookahead = None
            if pin and pin["t"] and pin["ko"]:
                lead_h = (pin["ko"] - pin["t"]).total_seconds() / 3600
                lookahead = lead_h > 8 * 24
            others = [v["line"] for (m, role, b), v in q.items() if m == market and role == pos and b != "pinnacle"
                      and pin and v["t"] and pin["t"] and abs((v["t"] - pin["t"]).total_seconds()) <= 48 * 3600]
            cons_gap = disp = None
            if len(others) >= 3:
                med = st.median(others)
                cons_gap = (open_ - med) if market == "spreads" else (med - open_)
                disp = st.pstdev(others + ([open_] if pin_valid else []))
            # LEAK FIX (found after the first scoring): the 48 h window includes books that
            # posted AFTER Pinnacle's opener, i.e. information not yet available when betting
            # it. The *_pre fields use only books posted at or before Pinnacle's opener.
            pre = [v["line"] for (m, role, b), v in q.items() if m == market and role == pos and b != "pinnacle"
                   and pin and v["t"] and pin["t"] and v["t"] <= pin["t"]]
            cons_gap_pre = disp_pre = None
            if len(pre) >= 3:
                medp = st.median(pre)
                cons_gap_pre = (open_ - medp) if market == "spreads" else (medp - open_)
                disp_pre = st.pstdev(pre + ([open_] if pin_valid else []))
            rows.append(dict(season=s, week=w, home=h, away=g["away"], market=market, open=open_, close=close,
                             move=move, abs_move=abs(move), size=size, key_number=key_num, pin_valid=pin_valid,
                             skew=skew, lead_hours=lead_h, lookahead=lookahead, cons_gap=cons_gap, dispersion=disp,
                             cons_gap_pre=cons_gap_pre, dispersion_pre=disp_pre,
                             div=bool(g["div"]), primetime=primetime, short_week=bool(short),
                             home_fav=(open_ < 0) if market == "spreads" else None, kalman_dep=kdep,
                             margin=g["margin"], total=g["total"]))
    # momentum: market move toward each team in its previous clean spread game this season
    by_team = defaultdict(list)
    for r in rows:
        if r["market"] == "spreads":
            by_team[(r["season"], r["home"])].append((r["week"], r["move"]))
            by_team[(r["season"], r["away"])].append((r["week"], -r["move"]))
    def prev_move(season, team, week):
        earlier = sorted((wk, m) for wk, m in by_team.get((season, team), []) if wk < week)
        return float(earlier[-1][1]) if earlier else None
    for r in rows:
        hm, am = prev_move(r["season"], r["home"], r["week"]), prev_move(r["season"], r["away"], r["week"])
        mom = (hm - am) if hm is not None and am is not None else None
        r["momentum"] = mom if r["market"] == "spreads" else None
    out = EV / "opener-lab/table.jsonl"
    with open(out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    n = defaultdict(int)
    for r in rows:
        n[r["market"]] += 1
    cov = {f: sum(r[f] is not None for r in rows) for f in ("skew", "lead_hours", "cons_gap", "dispersion", "cons_gap_pre", "dispersion_pre", "kalman_dep", "momentum")}
    print(dict(n), "coverage:", cov, "wrote", out.relative_to(REPO))


if __name__ == "__main__":
    main()
