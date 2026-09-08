# NFL market research lab

Read `docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md` first. This is an offline research worker, independent of the web server and production model registry.

Use an isolated Python 3.11–3.13 environment, install `research/requirements.txt`, then:

```sh
python research/market_lab.py --db /absolute/path/to/server/data.sqlite --output /absolute/path/to/server/data/market-lab --tpot-minutes 0.5
```

The TPOT limit is **per outer fold and market** (six searches; three minutes requested search time for 0.5). Training, imports and final refits add overhead. Omit TPOT for a quick four-baseline run. Do not run concurrent workers against the same output directory. The worker opens SQLite read-only, extracts a consistent dataset, then releases it before fitting.

Every run keeps `preregistered.json`, `dataset.json`, report, per-fold predictions, selected model files and attempted TPOT pipelines. `latest.json` is the UI pointer. No files are loaded as executable models by the server, and no production pointers or bets are written. Joblib artifacts are local trusted research outputs only; never load untrusted model files.

The current dataset is reconstructed from past closing/opening quotes and conservatively lagged outcomes/play-by-play. Publication revisions, real fills and access are not known. ROI is an indicative historical paper simulation at archived prices. All 2022–2025 seasons have previously been explored and are permanently labeled development data.

The initial runner tests a small generic feature set and selects on inner MAE. It does not implement the full book-response, role-state, news-impact or execution-model program. See the master plan for those bounded agent assignments.
