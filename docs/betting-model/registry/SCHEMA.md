# Model registry — shared row schema (2026-09-16)

One row per model, component, expert, policy module, data table, scheduler job, or evaluation harness.
Columns (CSV, header exactly as below):

id,name,kind,domain,file,entry_point,predicts,inputs_tables,inputs_features,upstream_models,technique,evaluation_harness,tests,measured_results,known_failures,improvement_options,status,point_in_time_safe,reads_closing_market,last_verified

- kind: forecaster | component | combiner | expert | policy_module | calibration | data_table | ingestion | scheduler_job | evaluation | execution_policy | lookup
- domain: spread | total | props | fantasy | news | injury | live | refs | weather | roster | market | infra
- entry_point: `file:line` of the exported function or literal (must be verified by reading it)
- technique: rule | ols | ridge | logistic | gbm | neural | simulation | elo | bayes_eb | lookup | heuristic | none
- measured_results: a number WITH an evidence path (docs/evidence/…, experiment-results/…, or a LATEST-PLAN section title), else "unmeasured"
- status: live | challenger | shadow | retired | stub | unenforced | research_only
- point_in_time_safe: yes | no | partial — plus a 1-clause reason
- reads_closing_market: yes | no | n/a
- Unknown = write exactly "unknown (not found)". Never guess.
