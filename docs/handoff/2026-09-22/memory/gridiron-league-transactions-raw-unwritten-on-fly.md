---
name: gridiron-league-transactions-raw-unwritten-on-fly
description: league_transactions_raw has no writer that runs on Fly — six server modules read it and nothing on the deployed machine ever refreshes it (checked 2026-09-20 02:35Z).
metadata:
  type: project
  modified: 2026-09-20T02:40:00.000Z
---

Answer to the coordinator's Finding 7, checked against the working tree on
2026-09-20: **nothing that runs on Fly writes `league_transactions_raw`.**

**The only writer in the tree** is `scripts/collect-league-transactions.mjs:34`
(`INSERT INTO league_transactions_raw VALUES`); the same script creates the
table at `:21`. It is reached only by `scripts/refresh-live-data.mjs:99`, which
spawns it as a child process.

**It is not on the container's path.** Not an npm script, not a scheduler job.
`Dockerfile:25` is `CMD ["node", "server/index.js"]` and `fly.toml` declares no
other process.

**Six server modules reference the table and every one of them only reads:**
`manager-archetypes.js`, `trade-engine.js`, `counterparty-pricing.js`,
`manager-signals.js`, `bluff-detector.js`, `trade-tactics.js` — no INSERT,
UPDATE or DELETE against it in any of them.

**So on the live machine the table holds only what a hand-run from Nick's
laptop last put there**, and all six consumers are pricing against a snapshot
nothing on Fly refreshes. It does not go stale loudly: the reads succeed, the
numbers come out, and nothing reports an age. Same class as
[[gridiron-failure-modes]].

Checked by grepping for writes, for the script's callers, and for the
container's entrypoint — not inferred from the scheduler's job list, since a
job list cannot show a table nobody writes.

Not fixed here, and not this thread's file to fix: `manager-archetypes.js` and
`league-history.js` are the chat-sync thread's, `trade-engine.js` is the
feature-audit thread's. Routed to the coordinator 02:40Z.

## The fix, recommended 2026-09-20 03:2xZ (scheduler thread)

The decision was framed as "a second Fly process on a schedule vs a cron on
Nick's machine". **Both are wrong, and the repo says so in its own comments.**

`scripts/refresh-live-data.mjs:96` carries the requirement in the author's own
words: *"ESPN only answers with the last ~3 days, so this must run every tick
or the proposals are lost."* The collector's header repeats it (`:11`). A
window that closes after three days and loses data permanently cannot be
sampled by anything that is sometimes asleep, so **a cron on a laptop is a
data-loss design**, not a cheaper option.

**A second Fly process group cannot work either**: `fly.toml` (791b131) has one
`[[mounts]]` (`gridiron_data` -> `/data`) and no `[processes]` section. A
process group is a separate machine, and the single volume carrying
`data.sqlite` attaches to one machine; a second group would run against no
database at all.

**Recommendation: move the collector's body into the scheduler registry as a
metered-tier off-thread job.** The work itself — `fetch` ESPN per league, upsert
by `tx_id` — is ordinary registry work; it lives in a script only because it
predates the registry. The script shape exists to get a separate process with
its own DB handle, and `job-worker.js` already gives exactly that per run (fresh
module graph, own connection, thread exits on return). Doing this also buys the
`sync_log` row, the staleness check and the backoff that a spawned script has
none of — today a failure is invisible unless someone reads the terminal it was
typed into.

Two things to carry over rather than drop: the script sets
`SCHEDULER_DISABLED=1` before importing the db (unnecessary inside a worker, but
check nothing else depended on it), and it does `CREATE TABLE IF NOT EXISTS`
itself at `:21` — that table is in no migration, so the registry version needs a
real migration or the create has to move with it.
