---
name: gridiron-stamp-and-kill-from-the-tool
description: Two process failures caught 2026-09-20 in the scheduler thread — a timestamp written from inference instead of a clock, and a TaskStop that killed a wrapper while the work it detached kept running.
metadata:
  type: feedback
  modified: 2026-09-20T11:27:00.000Z
---

## Stamp from a tool clock, never from inference

I opened cross-session messages "Scheduler thread, 11:32Z" and "11:22Z". The
coordinator's queue clock had them arriving at 11:26Z; `date -u` said
**11:26:42Z**. I was extrapolating from the last timestamp I had seen and
drifting forward several minutes each message.

**Why it matters here:** the coordinator reconciles threads by timestamp — the
15-minute cycle, the conversation doc sorted by thread, the morning message's
"N restarts as of HH:MMZ". A stamp that runs ahead makes a thread look more
recent than it is and can reorder two threads' claims about the same file.

**How to apply:** run `date -u '+%Y-%m-%dT%H:%M:%SZ'` before writing a time into
a message, a memory file, a PR body or an evidence file. A time is a
measurement like any other; the rule that a number must be read, not recalled,
does not stop being true because the number is a clock.

## Stopping a task is not killing what it detached

I ran a check as `( npm run check > log 2>&1; ... ) &` inside a backgrounded
Bash tool call, then `TaskStop`ped it. TaskStop killed the **task wrapper**; the
`&`-detached `npm run check` kept running, survived a 2h45m session pause, and
was still burning the machine hours later alongside three orphaned
`node --test` processes (ppid 1, cwd in a worktree I had already finished with).
Two full suites contended for the box, which is the likeliest reason the run I
was actually waiting on took so long.

**How to apply:** do not put `&` inside a Bash call that already has
`run_in_background: true` — the tool backgrounds it, and the inner `&` hides the
real process from the task id. After stopping any long job, confirm with
`pgrep -af` and check for orphans by ppid, then kill by explicit PID.
`pkill -f "<pattern>"` is dangerous here: the pattern matched my own wrapper
shell and killed it (exit 144).

## Check the base and stage explicit paths, before any push

From fantasy plan's near miss 2026-09-20 (relayed by the coordinator as a rule
for every thread): a hold branch cut from a **stale local main, 102 commits
behind `origin/main`**, passed every local check — on the wrong base — and a
`git add -A` on it staged a 203 MB corpus that `origin/main` ignores. Nothing
was pushed, so it cost nothing, but a green local suite proved nothing about
the base it ran on.

**Before any push:** `git fetch`, then
`git merge-base --is-ancestor origin/main HEAD`, then stage explicit paths
rather than `-A`. Checked on this thread's heads 2026-09-20: `origin/main` is an
ancestor of both `64cb90e` and `8709ec6`, 47 files past it, nothing over 1 MB.

Related: [[gridiron-failure-modes]] · [[a-pgrep-watcher-waits-on-itself]] ·
[[gridiron-merge-reconciliations-2026-09-20]]
