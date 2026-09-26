---
name: editing-a-running-shell-script-kills-it
description: On 2026-09-20 the shared restart-count logger died silently for an hour because its script file was edited while bash was still executing it — bash reads a script by byte offset as it runs.
metadata:
  type: feedback
  modified: 2026-09-20T11:01:45.405Z
---

**Bash reads a script incrementally, by byte offset, while it executes it.**
Editing the file underneath a running instance corrupts the running program from
whatever offset it has reached. It does not re-read from the top and it does not
fail cleanly.

**What it cost.** `/tmp/claude-0/health-log.sh` was the 60-second `/api/health`
logger feeding `/mnt/project-files/restart-health-log.tsv`, which
`restart-count.sh` reads and which the morning message's restart figure is quoted
from. It was edited mid-run and died at 2026-09-20T09:54:26Z with
`line 54: t: command not found` and a syntax error at a `done` that is perfectly
valid — `bash -n` on the same file exits 0. It was not out of iterations: 428 of
its planned 660 reads had landed. Nobody noticed for an hour, and nothing in
`restart-count.sh`'s output says how old its newest row is.

**How to apply.**

1. **Launch a long-running shell script from a copy nothing will edit**
   (`cp health-log.sh health-log-run.sh && nohup bash health-log-run.sh &`). Edit
   the original freely; the running copy is immutable by convention.
2. **Errors that make no sense against the file as it stands** — a syntax error at
   a construct that is plainly correct, a fragment of a word reported as a command
   — are this, not a bug in the script. Check `bash -n` before debugging the
   logic.
3. **A collector feeding a number other people quote needs a liveness check in the
   consumer.** `restart-count.sh` prints a count with no statement of how old its
   newest row is, so a dead logger reads exactly like a quiet one. That is the
   same defect the whole as-of night was about: [[gridiron-as-of-rule]] — a served
   value carries the stamp of the process that measured it, and an absence must
   say which absence it is.

Related: [[a-pgrep-watcher-waits-on-itself]], [[fixed-cadence-poll-cannot-bound-a-maximum]].
