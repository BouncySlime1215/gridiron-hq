# CURRENT: the single pickup file

Both sides (local Claude and the cloud coordinator) rewrite this file before stopping. Read docs/handoff/2026-09-22/START-HERE.md first if you have no context.

## Last written by

Local coordinator (Claude Code desktop, Nick's Mac), 2026-09-22 ~19:55Z. Nick's standing order: work alone, keep working, never stop; order of phases doesn't matter; one number one producer; no unwired data; log every merge; synergy review at each major pass; keep the plan board current.

## Where everything is

- **Plan board (live, private to Nick):** https://claude.ai/artifact/X2bB1Mnn7Bg19N9tJtBS56. Snapshot: `docs/handoff/local/PLAN-BOARD.md` (render with `~/gridiron-local/bin/render-board.py` after an ArtifactData list of `units`, `items` and `phases` into `~/gridiron-local/board-snapshot`).
- **Work queue:** `docs/handoff/local/WORK-QUEUE.md` (94 units plus R-, RD-, S- and OPS- units added since).
- **Merge log:** `docs/handoff/local/WORKLOG.jsonl` (one line per merged PR; `gate-merge.sh` appends).
- **Local app:** `~/gridiron-local/run.sh` (launch.json "gridiron-local", port 5177): latest main against a COPY of the app DB (`~/gridiron-local/data.sqlite`). Paid keys are always blanked. Set `~/gridiron-local/.scheduler` to 1 to turn the scheduler on (currently on, refreshing data).
- **Scripts:** `~/gridiron-local/bin/`: `update-pr.sh N` merges main into a PR and pushes; `wait-ci.sh N`; `gate-merge.sh N` refuses unless CI passed on a head that contains main and the body has merge-gate sections 1-5, then merges and logs; `data-census.sh`; `log-merge.sh`.
- **Workflows:** `~/gridiron-local/wf/build-unit.js` (builder, then up to 4 skeptics (claims, wiring, liveness, structure), fix loop, one locked guard run, PR). `~/gridiron-local/wf/synergy-review.js` (major-pass review: link, merge, hole/stale).
- **R&D:** `~/gridiron-local/rnd/` (EXPLORER-LOG, VALIDATOR-LOG, packages/, moonshots/, MOONSHOT-LOG).

## State of main

Tip d6d7bd5a (#116). Deployed tree still c5ee3b54 (#99): deploy is Nick's word only. Merged this session: #118, #146, #128, #116. Closed snapshots #140-#143.

## In flight at writing

Build batch 1: F-05 (land #94 trade outcome ledger) and R-02 (formations ingest 404 + backfill). Structure map, R&D round 2, moonshot lab and the local data refresh (OPS-01) are running.

## Next units

S-00 statistical method contract, C-01 start/sit baseline gate, C-10 decision win rate + sealed holdout (moved up by Nick's "order doesn't matter"). Then F-02, F-07, F-08, and R-01 with D-01. Then the A-units.

## Nick decisions still owed

Brake on/off before any deploy; delete Model.tsx and Edge.tsx; keep or close #66, #79, #80, #83, #144, #145; the ESPN cookie for real trade-outcome rows; FTN charting needs a CC BY-SA credit (folded into F-08).

## Rules in one breath

Merge gate v2 via gate-merge.sh; verify once; no secrets; no destructive migrations or data deletion; nothing paid; licence first; every model result must hold on 2026 weeks as well; declines state their MDE; one number, one producer.
