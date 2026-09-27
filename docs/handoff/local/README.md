# Local coordinator files (2026-09-22 onward)

Written by the local Claude Code coordinator working from Nick's Mac. They live here so the handoff carries them.

- `WORK-QUEUE.md`: the single execution queue. All 32 plan items with status and file:line, every open PR, every unit in order with its acceptance test, and the standing rules. Built 19:1x-19:4xZ; units get added as re-audits, R&D and structure reviews find work.
- `WORKLOG.jsonl`: one line per merged PR: time, PR, unit, title, merge sha, files, tables written and read (parsed from the diff, so expect a little noise such as `set`), exported symbols added. `~/gridiron-local/bin/log-merge.sh` appends it; `gate-merge.sh` calls it after every merge. This is the input for each major-pass synergy review: old work checked against new for holes, links (A should feed B), and duplicates (two Bs doing one job).
- Live status board (private to Nick): https://claude.ai/artifact/X2bB1Mnn7Bg19N9tJtBS56

No league names, manager names or secrets go in these files (public repo).
