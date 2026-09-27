---
name: scheduler-tier-is-not-the-thread
description: In gridiron's scheduler, only the 'heavy' tier goes off-thread by default, so a 'growth'/'live'/'metered' job needs offThread:true — avoiding the AUTO_HEAVY_SYNC gate silently puts a job on the request thread.
metadata:
  type: project
---

`resolveOffThread(job, override)` in `server/services/scheduler.js` (as PR #95
ships it) resolves to:

    if (mainThreadOnlyReason(job)) return false;   // allow-list wins
    if (override != null) return override;
    return job.offThread ?? job.tier === 'heavy';

**So the only tier that goes off-thread by default is `heavy`.** A job declared
`tier: 'growth'`, `'live'` or `'metered'` with no `offThread` flag runs **on the
request thread**, whatever its `timeoutMs`. `node:sqlite` is fully synchronous,
so such a job blocks every HTTP request for as long as it runs.

**Why:** the `heavy` tier is also the one behind the `AUTO_HEAVY_SYNC` gate. So
anyone choosing a lighter tier to avoid the gate — and avoiding it is often
correct, because a layer that only builds behind a flag is this project's
"silently never runs" failure — also leaves the worker. The two decisions are
coupled by one expression and nothing in `JOBS` says so at the point where a
job is written.

**Measured instance:** PR #89 (`claude/project-thread-sytruo-asof-rebase` @
`b04c1ad`) adds `league_history` with `tier: 'growth'`, `timeoutMs: 300_000`
and no flag, reasoning explicitly in its own comment that `'growth', not
'heavy'` keeps it clear of `AUTO_HEAVY_SYNC`. That reasoning is right about the
gate and silent about the thread. **The fix is one line in #89:
`offThread: true`** — not an `ON_REQUEST_THREAD` entry, because
`server/services/league-history.js` holds no state a worker would break (module
scope is two pure helpers at `:55,56`; pacing is a `sleep()` *within* a run, not
a `_lastCallAt` that must survive *between* runs, which is what forces
`sportsgameodds.js` and `odds-api.js` to stay inline; writes are parameterised
`INSERT ... ON CONFLICT` at `:117,148`).

**How to apply:** when reviewing or writing a scheduler job, read the tier and
the `offThread` flag as two separate decisions. Anything non-`heavy` that does
network or SQLite work needs `offThread: true`, an `ON_REQUEST_THREAD` entry
with a reason, or a `MAIN_THREAD_ONLY` entry if it genuinely cannot move —
#95's `test/growth-jobs-off-thread.test.js` refuses any job in none of the
three, and its failure message now states this coupling outright
(commit `9ebc48d`, local on the #95 branch).

Nothing can be pre-registered on #95's branch to absorb a job that does not
exist there: its test at `:85` rejects an `ON_REQUEST_THREAD` entry naming a
non-job, which is correct.

**Open proposal, deliberately not done:** flip the default to
off-thread-unless-listed. It would catch this without anyone reading a message,
but it re-decides the thread for all twenty-nine currently-inline jobs at once.
