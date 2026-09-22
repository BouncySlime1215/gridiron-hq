---
name: gridiron-news-post-fills-an-undrained-queue
description: A fantasy news POST enqueues betting-capture triggers that only scheduler jobs drain, so under SCHEDULER_DISABLED=1 they accumulate unprocessed while the response reports a queued count as though work started.
metadata:
  type: project
---

Verified on main 654ff93, 2026-09-22 (auditor §R30).

`routes/news.js:40` dynamically imports `nfl-capture-dispatch.js` inside the POST
handler and returns its result as `capture_triggers`.
`enqueueRecentNewsTriggers` (`:35-55`) INSERTs rows into `nfl_capture_triggers`
with `state='pending'` and returns `{reviewed, queued}`. **It never calls
`dispatchTriggeredCapture`.** The drain, `dispatchTriggeredCapture` (`:58`), is
called only from `polymarket-lines.js:271` and `nfl-espn-line-watch.js:129` —
both scheduler jobs, both in `scheduler.js`'s job table (`:1312-1373`).

**So with `SCHEDULER_DISABLED=1` on, nothing drains the queue.** Pending rows
accumulate and the caller is told a positive `queued` count, which reads as work
started. CLAUDE.md's "if a layer goes inert, the surface must say so", in its
reporting form. The design itself is deliberate and correct — `:1-4` says
triggers are durable so "a closed laptop or exhausted quota defers work instead
of silently losing the event" — but **deferral with no drain is indefinite.**

**No paid burn.** The metered odds call lives behind `snapshotLines`, past the
drain, so a fantasy request spends no credits. Checked before it was raised.

**Reach consequence:** only `nfl-capture-dispatch` and `odds-api` (its static
`:7` import) actually load on a news request. `line-shopping` (`:84`, inside
`dispatchTriggeredCapture`) and everything beneath it are **job reach**, not
request reach — import reach masquerading as call reach.

**BRAKE TRIGGER, one of four.** When `SCHEDULER_DISABLED=1` lifts, the
accumulated backlog drains at once. The other three: `stale_findings` goes live,
the snapshot read stops being safe to re-run, and the 46 job-reached files of the
60 start executing. Tell Nick these hang together.

Related: [[gridiron-deploy-step-2026-09-22]], [[gridiron-open-risks]].
