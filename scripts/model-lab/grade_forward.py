#!/usr/bin/env python3
"""
Forward holdout grader (preregistration item #5). Applies the rules frozen on
2026-09-16 in docs/evidence/2026-09-16/model-lab/frozen-rules.json, unchanged,
to games the rules have never seen.

Inputs for season S:
  <run-dir>/games-S.jsonl   produced by scripts/opener-clv-measurement.mjs
                            (same harness, fit v15) against a database whose
                            openers are recorded before kickoff
  kalman-preds.jsonl        rerun scripts/model-lab/kalman.py first; its
                            hyperparameters are refit on 2016-2021 only, so
                            2026 predictions stay out of sample
Prints every pick with the opener taken and, once closes and scores exist,
CLV and result. Usage:
  python3 scripts/model-lab/grade_forward.py --season 2026 --run-dir <dir>
"""
import json, statistics as st, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LAB = REPO / "docs/evidence/2026-09-16/model-lab"


def arg(n, d=None):
    return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d


def main():
    season = int(arg("--season", "2026"))
    run_dir = Path(arg("--run-dir", str(REPO / "docs/evidence/2026-09-16/opener-clv-v15t")))
    rules = json.load(open(LAB / "frozen-rules.json"))["rules"]
    kal = {(r["season"], r["week"], r["home"]): r for r in map(json.loads, open(LAB / "kalman-preds.jsonl"))}
    path = run_dir / f"games-{season}.jsonl"
    if not path.exists():
        print(f"no {path}; run the harness for season {season} first"); return
    picks = []
    for r in map(json.loads, open(path)):
        k = kal.get((r["season"], r["week"], r["home"]))
        comps = {c["id"]: c["pred"] for c in r.get("components") or [] if c["pred"] is not None}
        extra = {"sim": (r.get("sim") or {}).get("pred")}
        if k:
            extra.update(kalman_score=k["kalman_score"], kalman_score_epa=k["kalman_score_epa"])
        # spreads champion: flat average of departures of the frozen selected set
        sp = rules.get("spreads")
        if sp and sp["strategy"].endswith("|G|pool") and r.get("open_spread") is not None:
            deps = [({**comps, **extra}.get(n)) for n in sp["spec"]["names"]]
            deps = [d - (-r["open_spread"]) for d in deps if d is not None]
            if deps and abs(sum(deps)) > 1e-9:
                home = sum(deps) > 0
                clv = None if r.get("close_spread") is None else ((r["open_spread"] - r["close_spread"]) if home else (r["close_spread"] - r["open_spread"]))
                picks.append(("spread", r["week"], r["home"], r["away"], "home" if home else "away", r["open_spread"], clv))
        tt = rules.get("totals")
        if tt and tt["strategy"] == "totals|C|kalman_total" and k and r.get("open_total") is not None:
            s = tt["spec"]
            v = s["a"] + s["b"] * (k["kalman_total"] - r["open_total"])
            if abs(v) > 1e-9:
                over = v > 0
                clv = None if r.get("close_total") is None else ((r["close_total"] - r["open_total"]) if over else (r["open_total"] - r["close_total"]))
                picks.append(("total", r["week"], r["home"], r["away"], "over" if over else "under", r["open_total"], clv))
    for p in picks:
        print(*p)
    for mkt in ("spread", "total"):
        c = [p[6] for p in picks if p[0] == mkt and p[6] is not None]
        if c:
            print(f"{mkt}: {len(c)} graded picks, mean raw CLV {st.mean(c):+.3f} pts")


if __name__ == "__main__":
    main()
