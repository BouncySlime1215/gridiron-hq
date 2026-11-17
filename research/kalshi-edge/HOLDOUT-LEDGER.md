# Holdout ledger

Every run that computes any number from games starting 2026-10-01 or later with
outcomes attached gets a row here, in the same commit as its output. That
includes failed runs and smoke runs. An empty table means the holdout has not
been opened.

| # | when (UTC) | commit of frozen model | script | what was computed | result file |
|---|---|---|---|---|---|
| 1 | 2026-11-17 19:12:20 | fb396483f28e1aabe8ec64e60783d99020216611e73c4eb1756b17afc3167908 | scripts/run_holdout.py | primary P1-P4, A1-A2 and all secondaries | results/holdout.json |
| 2 | 2026-11-17 19:22:00 | fb396483f28e1aabe8ec64e60783d99020216611e73c4eb1756b17afc3167908 | inline diagnostic (session) | POST-HOC, not confirmatory: why A2 lost - A2 positions by sport and week; S11 static offer by sport; pooled S11 across splits | printed in session, summarised in the report |
