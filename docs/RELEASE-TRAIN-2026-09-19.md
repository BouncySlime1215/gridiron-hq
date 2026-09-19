# Release train — 2026-09-19

Twenty-seven pull requests were opened against this repository on 2026-09-19 by
seven threads. None of it is deployed: `gridiron-hq.fly.dev` is running a build
that predates all of them. This file is the ordered sequence for landing them,
the evidence that the sequence works, and the deploy plan that follows it.

**Nothing here has been merged or deployed.** Everything below was proved on a
throwaway scratch branch built from `main`, which has been discarded.

## Summary

Twenty-five pull requests go in, in the order in section 1. Two are excluded:
one is betting work, one is in-scope work sitting on a betting base. Merging all
twenty-five produced **one** conflict and **seven** failing tests; both fixes are
written out in section 3 and neither has been pushed, because both belong to
other threads' branches. With both applied the merged tree is green:
**2,928 tests, 2,887 passed, 0 failed**, plus a clean typecheck, lint, client
build and start-up smoke test.

One thing worth saying before the sequencing: **deploying is not only a risk to
be managed, it is a cure.** Part of what makes the machine feel dangerous to
touch is running on it right now — a scheduler with no per-job concurrency guard
(#33), eleven heavy jobs on the request thread (#17), and a TCP health check that
cannot see a wedged process (#9). The instinct with a wedging production app is
to touch it as little as possible. Here the opposite is true.

## 1. The order

Twenty-five pull requests, merged bottom-first. Each line is a merge into the
deployment branch.

### Base stack — strictly linear, each is the next one's base

| # | Branch | What it is |
|---|---|---|
| 7 | `…-3ldl77` | CI: offline guard, fetch mock, report-cache worker |
| 9 | `…-3ldl77-deploy` | Dockerfile, fly.toml, the two things that stop a boot |
| 10 | `…-3ldl77-server` | The engine: league chat, Trade Brain, NFL model, tests |
| 11 | `…-3ldl77-client` | UI: nine tabs removed, every backend kept |
| 12 | `…-3ldl77-docs` | Plans, TDD records, audit documents |

These five are a chain in git — #12 contains #11 contains #10 and so on — so
merging #12 alone lands all five. They are listed separately because each is a
reviewable unit. **Everything else in the train depends on #12.**

### Then, in this order

| # | Branch | Why here |
|---|---|---|
| 8 | `…-5podec` | `CLAUDE.md` and the ADHD skill. Touches no product code; sits on `main` directly, so it can go anywhere. |
| 24 | `…-sytruo-stacked` | `npm run chat:sync`. Its base is #10, not #12, and it is the only branch off the middle of the stack. Early, so the odd base is resolved before anything stacks on it. |
| 17 | `…-o3wt2p` | Heavy tier off the main thread, plus a real `/api/health`. First of the scheduler chain: everything else in it is stacked on it, and the health route it adds is what `fly.toml`'s HTTP check and #14 both need. |
| 19 | `…-o3wt2p-honesty` | Retry backoff, `sync_log.consecutive_failures` |
| 20 | `…-o3wt2p-fantasy` | The six fantasy feeds on timers |
| 28 | `…-o3wt2p-blocking` | Two always-on megabyte-parsing jobs off the request thread |
| 29 | `…-o3wt2p-watchdog` | Kill the process when the event loop stops turning |
| 31 | `…-o3wt2p-current-season` | `POST /api/model/sync` ingests the season being played |
| 32 | `…-o3wt2p-live-tier` | `evidence_daemon` and `nfl_reports` off the request thread |
| 33 | `…-o3wt2p-reentry` | Stop a scheduler job running on top of itself |
| 21 | `…-5f9c3y-honesty` | League analysis unpriced-guard, waiver coverage |
| 27 | `…-5f9c3y-narration` | Start/Sit and the matchup card stop narrating zeros |
| 30 | `…-5f9c3y-drafts` | Draft room refuses to rank with no market |
| 25 | `…-3xqh5l-proposals-live` | Trade Lab proposals parse, per-league budget. **Before #22.** |
| 26 | `…-3xqh5l-signals-api` | Serves the measured manager layer. **Before the chat sync is worth running.** |
| 23 | `…-3xqh5l-manager-read` | Counterparty read on every trade card |
| 22 | `…-3xqh5l-brain-ui` | The Trade Brain page |
| 18 | `…-3xqh5l` | Live check that says whether the Trade Brain works |
| 15 | `…-w45mur` | Opportunity model. Carries the promotion script and runbook that deploy step 7 uses. |
| 14 | `…-n4052e` | Google sign-in and per-user scoping. **Last, and it must come after #17.** |

Positions 19, 20, 28, 29, 31, 32, 33 and 27, 30 are forced: each is stacked on
the one above it in git. Positions 8, 24, 23, 18, 15 are free — placed for
readability, not necessity.

### The three constraints that are real

**#17 before #14.** Both invent `GET /api/health`, independently. Git merges
them without conflict because they land in different places in
`server/index.js`, so the merged file registers the route twice. Express serves
whichever was registered first — #17's, which runs a synchronous SQLite read and
answers 503 when it cannot. #14's is `res.json({ ok: true })` and answers 200
unconditionally. One reordering of that file and Fly's liveness check silently
becomes a check that passes on a dead database, which is the TCP-check failure
`fly.toml` was just changed to fix. The two branches also conflict directly in
`scripts/start-smoke.mjs` — the only textual conflict in the whole train. Fix in
section 3.

**#25 before #22.** #22 adds the Trade Brain page; #25 makes the proposal parse
read the model's answer and remembers an unanswerable slate for six hours
(`FAILED_SLATE_TTL_MS`) instead of paying for it again. Checked rather than
assumed: `ProposalSlate.tsx` uses `api()` and not `useApi()` specifically so it
does **not** fetch on mount, and `TradeBrain.tsx` says so in a comment. So the
cost is per click on "write proposals", not per page load. The ordering holds and
costs nothing, but it is a smaller hazard than it has been described as.

**#26 before the chat corpus sync.** The corpus binds to a league through
`league_member_identity` rows with `confidence = 'confirmed'`, and the only
writer of those is `matchIdentities`, reached from
`scripts/refresh-live-data.mjs` — which #26 changes. Without #26 an upload exits
zero and attaches to nothing. Verified at `manager-signals.js:449` and in #26's
own diff. This is a post-deploy constraint on Nick's `npm run chat:sync`, not a
merge-order one.

### Two things that look like ordering constraints and are not

**#14 and #26 break each other's tests in either order.** Not an ordering
problem; a fixture problem. See section 3.

**ffopportunity coverage does not gate the #15 promotion.** The opportunity
thread measured the gate with `nfl_ffopportunity_weekly` full, with 2026 removed,
and completely empty. All five checks pass identically in all three. Dropped from
the ordering.

## 2. Deliberately excluded

**PR #6 — "Betting model: live audit, unified + master plan, and in-repo
research corpus."** 375 commits, 1,128 files, 1.2M added lines, described by its
own body as "docs/plan/corpus only; no product code changed yet." Betting work,
which is out of scope, and the parts of it that were not betting were already
split out into #7, #9, #10, #11 and #12 — which are all in the train. Merging it
would re-add the 481-file research corpus that #12 exists to keep out.

**PR #34 — "Price an injured player as injured: the availability term nothing
had."** This one is not excluded on its merits. Its own change is seven files and
is fantasy work — exactly the kind of thing this train is for. It is excluded
because **its base branch is `cursor/betting-model-audit-fixes-1c85`, which is
PR #6's branch.** `git merge-base --is-ancestor` confirms it contains all 375 of
#6's commits and none of the base stack. Merging it lands #6 with it. It needs
rebasing onto `…-3ldl77-docs` before it can join a train, which is the owning
thread's call, not this one's.

Nothing else in the train is betting work. #28 and #32 move betting jobs
(`nfl_prop_feeds`, `beat_the_close`, `evidence_daemon`, `nfl_reports`) off the
request thread, which is in scope because those jobs pin the machine the fantasy
app runs on.

## 3. What broke when it was proved, and what fixes it

The twenty-five branches were merged in the order above onto a scratch branch
from `main`, and the repository's own checks were run on the result: typecheck,
lint, the full test suite, the client build, and the start-up smoke test.

**Before the fixes: 2,921 tests, 2,873 passed, 7 failed.** Typecheck, lint and
build were clean. Twenty-four of the twenty-five merges were conflict-free.

### Break 1 — `scripts/start-smoke.mjs`, the only merge conflict

#17 and #14 both rewrote the start-up probe to poll `/api/health`. #17's checks
`probe.ok` and the response body and keeps waiting on a 503; #14's treats any
response at all, including a 503 or a 404, as the app being up.

**#17's version wins**, and #14 should stop adding a health route of its own. On
`claude/project-thread-n4052e`:

1. Delete the one-line `app.get('/api/health', (_req, res) => res.json({ ok: true }));`
   and its comment block from `server/index.js`.
2. Take #17's `scripts/start-smoke.mjs` probe verbatim.
3. Retarget PR #14's base from `…-3ldl77-docs` to `…-o3wt2p-reentry`, so #14 still
   has a health route to probe when its own CI runs. #14 is last in the train, so
   this costs nothing.

### Break 2 — seven failing tests in `test/manager-signals-api.test.js`

Every request in that file returned **403 instead of 200**. #26 adds
`GET /api/trades/:leagueId/managers/signals`; #14 puts `assertLeagueMember` in
front of every `/api/trades/:leagueId` route. #26's fixture creates two users and
two sessions but no `league_memberships` rows, because when it was written
nothing required them.

Both pull requests are right — the route *should* be membership-guarded. The fix
is in #26's fixture, and it is safe on #26's own base too: `league_memberships`
has existed since migration 006, so seeding it is a no-op until #14 lands. On
`claude/project-thread-3xqh5l-signals-api`, after the last `insertLeague` call:

```js
for (const id of [21, 22, 23, 24]) {
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7701, 'member')`, id);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7702, 'commissioner')`, id);
}
```

League 999 is deliberately left out — it does not exist, and the 404 test needs
it not to.

**With both fixes applied, the whole train is green: 2,928 tests, 2,887 passed,
0 failed, 41 skipped, and a clean typecheck, lint, build and smoke.**

### Not a break: three migrations numbered 061

#14, #19 and #21 each add a `server/migrations/061_*.js`, on a base stack that
ends at 060. Survivable rather than broken: `server/db/migrate.js` keys
`schema_migrations` on the **full filename**, not the number, and applies files in
`.sort()` order, so all three are applied exactly once and none blocks another.
They touch unrelated tables, so the order between them does not matter.

The one sharp edge: `npm run db:rollback` with no argument rolls back the
*last-sorted* of the three, which is `061_sync_log_consecutive_failures`, not
whichever was conceptually last. Renumbering to 061/062/063 would be tidier and
is a rename of files nothing has applied yet. Not required, not in this plan.

### Verified, contrary to an earlier worry: nothing here backfills QBR

The #15 gate passes on the live database only because `nfl_qbr_weekly` holds
2025-2026 and nothing for 2021-2024. Nothing in the train changes that on deploy.
The only scheduled QBR job is `nfl_qbr_weather` (`scheduler.js:1216`), which calls
`syncQbr({ seasons: [season - 1, season] })` — 2025 and 2026 only. `POST
/api/model/sync` does not touch QBR at all, and neither does `syncAllAdvanced`. A
2021-2024 backfill can only happen if somebody runs one deliberately.

## 4. Not ready

| # | State | What it needs |
|---|---|---|
| 8 | CI cancelled at 15:58Z, re-run queued | A green run. It changes only `CLAUDE.md` and `.claude/skills/`, so this is a formality — but it has never had one. |
| 33 | CI **failed** at 19:52Z: 2,808 tests, 1 failure | Resolution. That single failure did **not** reproduce in the merged train, where the same code passed as part of 2,928 green tests, so it is either a flake or something a later merge covers. A re-run has been queued. It is in the sequence on the strength of the train result, and if the re-run fails the same way the owning thread should look before this lands. |
| 34 | Green, wrong base | Rebasing off PR #6's branch. See section 2. |

Every other pull request in the train has a completed, green
`typecheck, lint, test, build, smoke` run on its current head.

## 5. Before the deploy: one command for Nick

Three questions need a shell on the machine and no session here has one:
what is actually in `/app/scripts`, what the live database holds, and what image
is running. This answers all of it in one read-only paste.

```
fly image show -a gridiron-hq
fly ssh console -a gridiron-hq -C "node --no-warnings -e 'const f=require(\"node:fs\"),{DatabaseSync}=require(\"node:sqlite\"),S=\"/app/scripts/\";console.log(\"== scripts on disk ==\");for(const n of [\"promote-volume-shrinkage.mjs\",\"promote-weekly-ensemble.mjs\",\"fit-availability.mjs\",\"refresh-live-data.mjs\"])console.log(n+\": \"+(f.existsSync(S+n)?\"present\":\"MISSING\"));const d=new DatabaseSync(process.env.GRIDIRON_DB_PATH,{readOnly:true});console.log(\"== row counts ==\");for(const t of [\"nfl_qbr_weekly\",\"nfl_ffopportunity_weekly\",\"player_week_usage\"]){try{console.log(t+\": \"+(d.prepare(\"SELECT season AS s,COUNT(*) AS n FROM \"+t+\" GROUP BY season ORDER BY season\").all().map(r=>r.s+\"=\"+r.n).join(\" \")||\"EMPTY\"))}catch(e){console.log(t+\": ERROR \"+e.message)}}for(const t of [\"nfl_availability_rates\",\"nfl_availability_role_rates\",\"shrinkage_fits\"]){try{console.log(t+\": \"+d.prepare(\"SELECT COUNT(*) AS n FROM \"+t).get().n)}catch(e){console.log(t+\": ERROR \"+e.message)}}d.close();'"
```

It opens the database with `readOnly: true`, runs only `SELECT COUNT(*)`, and
calls `fs.existsSync`. It cannot change anything.

The program was tested end to end, including through a shell with this exact
quoting: it degrades to a named `ERROR` line rather than crashing when a table is
missing, and `--no-warnings` keeps node's experimental-SQLite notice out of the
output. **The one thing that could not be tested from here is how `flyctl` itself
splits the `-C` argument**, since `flyctl` is not installed in a cloud session. If
the second line fails on quoting, run `fly ssh console -a gridiron-hq` and paste
the `node --no-warnings -e '…'` part at the container prompt, where the quoting is
an ordinary shell's.

What each line decides:

- **scripts on disk** — whether the deployed build carries the promotion and
  availability scripts, which is the only direct evidence of the running build's
  provenance (see step 1 below).
- **`nfl_qbr_weekly` by season** — which of the three #15 gate verdicts applies.
  Empty passes, 2025-2026 only passes, 2021-2026 fully backfilled **fails**.
- **`nfl_ffopportunity_weekly` by season** — whether #28's job is a no-op or a
  three-season backfill on first run.
- **`player_week_usage` by season** — the before-reading for post-deploy check 2.
- **the three table counts** — confirms the two availability tables and
  `shrinkage_fits` are empty, which is what makes steps 7 and 9 additions rather
  than overwrites, and what makes their rollbacks exact.

`sqlite3` is deliberately not used: the image is `node:22-slim` (see
`Dockerfile`), which does not carry it. `GRIDIRON_DB_PATH` is set in the image, so
it does not need supplying.

## 6. Deploy plan

Steps 1-6 are the deploy; 7-10 are the two database writes; 11 is the rollback.

Everything from step 7 onward needs `fly ssh console`, which needs a real Fly
platform token. `GRIDIRON_FLY_TOKEN` is an application bearer token and does not
grant it, so no session here can run any of it.

**The deployed build is of unknown provenance.** Two read-only probes of the
running app place it in inconsistent positions on the branch stack, which means it
was not necessarily built from a clean commit. So the rollback below redeploys a
captured *image*, not a commit.

### 1. Run the command in section 5, and keep the output

Write down the image reference (`registry.fly.io/gridiron-hq@sha256:…`). **If
`fly image show` does not return an image that can be redeployed, stop and say
so** — that changes how cautious step 3 should be, and it is much better to learn
it now than during a bad deploy.

### 2. Take the baseline reading

```
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=1&runs=2000&from_week=2" > ~/sim-before.json
```

Three separate changes in this deploy move the same numbers — playoff odds, title
odds, trade horizon. The availability fit moves them because season-sim calls
`contingency.js` once per simulated week and the trade engine calls the simulator
too. Two further sim fixes are coming from the fantasy plan thread and are **not**
in this train. If they all landed together nobody could attribute how much moved
to what.

Two details that make the reading worth taking:

- **`seed=1` makes it deterministic.** `model.js:524` threads the query seed
  through `withRandomSeed`, so a repeated call with the same seed is the same
  answer. Without it, every difference is confounded with Monte Carlo noise.
- **`from_week=2` is passed explicitly** because the route defaults it to 1, and
  that default is one of the two things the fantasy plan thread is about to
  change. Pinning it keeps this baseline comparable across that change too.

Allow up to 300 seconds for this first request — the machine cold starts and
60-180 seconds is normal. A timeout under 300s is not an outage.

**Expect the odds to rise**, in some leagues by a lot. That is the fix working,
not a regression. Say so to anyone who looks before they report it as one.

### 3. Deploy

```
fly deploy -a gridiron-hq
```

Migrations run automatically at boot, before `app.listen` — there is no separate
release command. Expect a longer boot than usual: three new migrations plus seed
reconciliation against the volume. `fly.toml`'s health check has a 60-second grace
period for exactly this.

### 4. Watch the first boot, not the settled machine

The first boot is the exact moment the concurrency bug #33 fixes used to fire
hardest: an eighteen-job boot pass still running when the live timer starts the
same jobs behind it, two synchronous SQLite transactions writing the same tables.
So watch it happen rather than sampling once things are quiet:

```
fly logs -a gridiron-hq
```

What good looks like: no `still running when its next pass was due` warnings
stacking up, and `/api/health` answering within the grace period.

### 5. Unset the heavy-sync flag

```
fly secrets unset AUTO_HEAVY_SYNC -a gridiron-hq
```

**Precautionary now, not load-bearing.** After #17, `scheduler.js:1579` runs every
`tier: 'heavy'` job in a worker thread by default, so the flag no longer wedges
the request thread. It comes off anyway because steps 7 and 9 are both long,
read-heavy jobs on a 2 GB machine and there is no reason to have eleven more
competing with them. It can go back on after step 10.

A caveat on what this proves: we have probably been attributing all of the
wedging to the heavy tier, and at least some of it was concurrent writers. Do not
read a quiet machine after this step as proof the heavy tier was the whole story.

### 6. Post-deploy checks — count rows, do not read statuses

Three separate things today report healthy and are not: a source registry that
says `ok` because someone swept it by hand, a scheduler job that has never once
completed, and a corpus upload that exits zero and binds to nothing. So each check
asks whether the thing that was supposed to be produced now exists.

1. **The app is actually serving.** `GET /api/health` returns `{ok: true}` with an
   `uptime_s`. Poll it again a few minutes later: #17's route is the first one
   that can tell a wedged process from a healthy one.
2. **The fantasy feeds are on timers and writing.** After about six hours, count
   `player_week_usage` and `player_week_snaps` rows **for season 2026**. Both are
   zero today. Non-zero is the proof that #20 and #31 worked; `/api/dev/sources`
   saying `ok` is not, and was not this morning either.
3. **Migrations applied.** `schema_migrations` contains all three 061 rows:
   `061_google_identity_and_invites`, `061_sync_log_consecutive_failures`,
   `061_league_payload_season`.
4. **Sign-in did not lock anyone out.** #14 puts `assertLeagueMember` in front of
   every `/api/trades/:leagueId` route. Load a trade page for each of the five
   leagues and confirm none returns 403. This is the single highest-risk change in
   the train for existing behaviour.
5. **`evidence_daemon` is still failing, and that is expected.** It has run 29
   times and failed 29 times, always on its budget. #32 makes that failure cheap
   and therefore quiet. It is betting-side and nobody is fixing it. **Do not read
   a clean scheduler tier as evidence that it started working** — check its own
   `sync_log` row.
6. **Take the reading again**, same command as step 2, to `~/sim-after-deploy.json`.
   This separates every code change in the train from the data write in step 9.

### 7. Database write 1, dry run — the opportunity promotion gate

```
fly ssh console -a gridiron-hq
cd /app && node scripts/promote-volume-shrinkage.mjs --dry-run
```

Writes nothing. Prints the fitted vector and five pre-registered conditions. About
90 seconds on a warm machine. **All five must read `true`.** If any is false, stop;
do not promote and do not argue with the gate.

The `nfl_qbr_weekly` counts from section 5 are what say which of the three gate
verdicts you are looking at. Record them next to the result, so a later reader
knows. This is also why the promotion and any QBR backfill cannot happen in the
same window without re-deciding.

### 8. Database write 1 — promote

```
node scripts/promote-volume-shrinkage.mjs
node scripts/promote-weekly-ensemble.mjs
```

The first writes one row to `shrinkage_fits` and six to `shrinkage_k`, in one
transaction, and sets `active = 1`. The second inserts one row into
`weekly_ensemble_fits`. Run both in the same sitting: the state between them is
measurably a wash, and the whole improvement comes from the second.

### 9. Database write 2, dry run — the availability fit

```
node scripts/fit-availability.mjs --dry-run --report=/tmp/avail.json
```

Writes nothing and produces every gate number and the full decision. This exists
so step 10 is reading a result rather than making a judgement call.

Expect the main gate to pass decisively — on a local full-history rebuild, log
loss 0.558 → 0.397 and calibration error 0.082 → 0.017 on 8,663 held-out rows. The
shipped constants are badly wrong in the common case: a starter with no injury
report is 94.5% to play and the app currently says 69.5%.

**This is the most carefully staged step in the plan**, because it is a live
behaviour change with no diff behind it, and it now reaches four surfaces rather
than the one its runbook was written for: Start/Sit, the matchup card, season-sim
playoff odds, and the trade engine's horizon.

### 10. Database write 2 — and the one decision that is Nick's

```
node scripts/fit-availability.mjs
```

Fills `nfl_availability_rates`. It will **leave `nfl_availability_role_rates`
empty**, because one 60-row unknown-tier cell fails a per-cell check and the script
refuses to ship the role layer when that happens.

That is the decision:

- **Shape A (recommended, and what the command above does).** Ship the main table,
  leave the role table empty. Strictly better than today in every case the gate
  measured, and it needs no code change.
- **Shape B.** Also fill the role table, which means loosening that per-cell gate —
  a code change to `scripts/fit-availability.mjs`, reviewed and tested like any
  other. Not something to do at a console.

Then take the reading a third time, to `~/sim-after-fit.json`. The difference
between it and `~/sim-after-deploy.json` is the availability fit's effect on
playoff odds, isolated from every code change in the train. That is the number to
keep, because the two sim fixes still to come from the fantasy plan thread will
move the same figures again, and this reading is their baseline.

Afterwards, re-fit the posture calibration, which goes stale once role rates
exist. Under shape A, with the role table empty, this is a no-op.

### 11. Rollback

**Database, either write, instantly:**

```sql
UPDATE shrinkage_fits SET active = 0;                                 -- undoes step 8
UPDATE weekly_ensemble_fits SET promoted = 0 WHERE id = <the new id>; -- undoes step 8's second half
DELETE FROM nfl_availability_rates;                                   -- undoes step 10
```

Each is one statement. `activeKVector()` returns null with no active row and
`pickK()` falls through to the hand-picked literals; an empty
`nfl_availability_rates` is exactly today's state, which is the constants. No fit
row is destroyed by any of these, so all three are reversible in both directions.

**The deploy:**

```
fly deploy --image <the reference captured in step 1> -a gridiron-hq
```

Redeploying the captured image, not rebuilding from a commit — because we do not
know which commit the running build was made from. Migrations are additive and the
three new ones drop nothing, so an older image boots against the migrated volume
without a schema rollback. If a migration does need undoing, `npm run db:rollback`
takes one at a time, newest first — and note the caveat about which of the three
061s it picks.

## 7. Evidence

Scratch branch built from `main` at `ffe4e72`, 25 merges in the order in section
1, both fixes from section 3 applied. Run with the repository's own scripts:
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run start:smoke` — the same five the CI job runs.

- Merges: 24 of 25 conflict-free; one conflict, in `scripts/start-smoke.mjs`.
- Before the fixes: 2,921 tests, 2,873 passed, **7 failed**, all in
  `test/manager-signals-api.test.js`.
- After the fixes: **2,928 tests, 2,887 passed, 0 failed, 41 skipped.**
  Typecheck, lint, client build and start-up smoke all clean. Exit 0.

The scratch branch is a test fixture and has been thrown away. Every fix belongs
in its source pull request, and neither has been pushed there — both are other
threads' branches.
