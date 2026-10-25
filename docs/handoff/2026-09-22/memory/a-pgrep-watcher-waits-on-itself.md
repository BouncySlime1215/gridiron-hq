---
name: a-pgrep-watcher-waits-on-itself
description: A background shell that polls `until ! pgrep -f "thing.sh"` matches its own command line, so it never exits and never fires - it looks like the watched job is still running when the job finished long ago.
metadata:
  type: feedback
  modified: 2026-09-20T03:04:23.976Z
---

**`until ! pgrep -f "probe.sh"; do sleep; done` never finishes.** The watcher's
own `bash -c` command line contains the string `probe.sh`, so `pgrep -f` finds
the watcher itself and the loop spins forever. Three background shells sat in
this state overnight on 2026-09-20 while the script they watched had already
exited, and the harness kept reporting them as running.

**Why it matters:** the failure is silent and it inverts. A watcher that should
say "the job is done" instead says nothing, which reads as "the job is still
going" — so a finished measurement looks unfinished and gets waited on, or
re-run.

**How to apply:**
- Wait on the **artifact**, not the process: `until [ -s out.tsv ] && ! …`, or
  poll the file's line count, or have the script itself `touch DONE` at the end.
- If a process check is really wanted, exclude self and the pattern:
  `pgrep -f '[p]robe\.sh'` (the bracket keeps the pattern from matching its own
  literal), or capture the PID at launch and test `kill -0 "$PID"`.
- Same trap applies to `ps aux | grep foo` without `grep -v grep`.
- Check for an already-running watcher before starting another — a duplicate
  spinner is invisible until someone lists background shells.

Related: [[anchored-probe-beats-a-fixed-poll]] — the probe these watchers were
meant to be watching.
