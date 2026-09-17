#!/usr/bin/env python3
"""2025 confirmatory holdout for the multi-channel Kalman FULL model only (preregistered).
Each method trained on 2022-2024, scored on 2025; Holm over the 6 tests (3 methods x 2 markets)."""
import json, math, os
os.environ["EXTRA_PREDS"] = "../../docs/evidence/2026-09-16/model-lab/kmulti-preds.jsonl"; os.environ["EXTRA_FAMILY"] = "kmulti_"
import lab

rows = lab.load_table()
out, pvals = {}, {}
for mname, name in (("spreads", "kmulti_full"), ("totals", "kmulti_full_total")):
    mk = lab.Market(mname)
    for method in "ABC":
        train, test = lab.season_split(rows, 2025)
        test = [r for r in test if mk.ok(r)]
        base = mk.baseline([r for r in train if mk.ok(r)])
        sc = lab.adjusted(mk, lab.per_forecaster(method, name, mk, train, test)[0], base)
        cz = lab.clustered_z(sc); rate, n = lab.ats(mk, sc)
        dev = lab.clustered_z(lab.run_dev(lambda tr, te, m=method, n_=name, mk_=mk: lab.per_forecaster(m, n_, mk_, tr, te)[0], mk, rows))
        out[f"{mname}|{method}"] = dict(dev_mean=dev["mean"], dev_z=dev["z"], holdout_mean=cz["mean"], holdout_z=cz["z"], holdout_p=cz["p"], holdout_ats=rate, holdout_n=cz["n"])
        pvals[f"{mname}|{method}"] = cz["p"] if cz["z"] is not None and cz["z"] > 0 else 1.0
h = lab.holm(pvals)
for k, v in out.items():
    v["holm_pass"] = h[k]["passes"]
    print(f"{k:12s} dev {v['dev_mean']:+.3f} z {v['dev_z']:+.2f} | 2025 {v['holdout_mean']:+.3f} z {v['holdout_z']:+.2f} p {v['holdout_p']:.3f} ats {v['holdout_ats']*100:.1f}% n {v['holdout_n']} | Holm {'PASS' if v['holm_pass'] else 'fail'}")
json.dump(out, open("../../docs/evidence/2026-09-16/model-lab/kmulti-holdout.json", "w"), indent=1)
