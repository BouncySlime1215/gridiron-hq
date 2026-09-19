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
| 8 | CI cancelled twice — **structural, not flaky.** Cause found and fixed; a fresh run needs one push by its owning thread | Both runs died at exactly the 20-minute mark (20m16s and 20m14s): that is `timeout-minutes: 20` in `ci.yml:33`, not someone pressing cancel. This branch sat on `main`, which lacks #7's CI fixes, and `main`'s suite takes about 24 minutes — so it could never have gone green on its old base however many times it was re-run. **Base retargeted from `main` to `…-3ldl77` (#7)**; base change only, no commits touched. That does not by itself re-trigger CI, because `ci.yml` uses a bare `on: pull_request`, whose default types are `opened`, `synchronize` and `reopened` — a base change fires `edited`, which is not among them. So #8 still has no green run **of its own**, and getting one needs a single push to that branch by the thread that owns it. Its content is nonetheless proved: `5podec` was one of the twenty-five merged into the scratch branch, and that run was green. **If its owning thread has nothing genuine to push, #8 merges on the train's proof rather than on its own check** — do not stop at the missing check and improvise, and do not manufacture a commit to produce one, which would devalue every other green check in the train. |
| 33 | CI **failed** at 19:52Z: 2,808 tests, 1 failure | Probably nothing, and a re-run is queued to confirm. That single failure did **not** reproduce in the merged train, where the same code passed inside 2,928 green tests. It also matches a known repo-wide signature: a test file whose every test passes but whose `after` hook throws `ENOTEMPTY` on `fs.rmSync`, because a worker thread re-runs `server/db/index.js` and re-creates the database directory mid-removal. That is environmental and predates the whole stack. It is in the sequence on the strength of the train result; if the re-run fails differently, the owning thread should look before this lands. |
| 34 | Green, wrong base | Rebasing off PR #6's branch. See section 2. |

Every other pull request in the train has a completed, green
`typecheck, lint, test, build, smoke` run on its current head.

## 5. Before the deploy: one command for Nick

Several questions need a shell on the machine and no session here has one. This
answers all of them in one read-only paste.

```
fly image show -a gridiron-hq
fly ssh console -a gridiron-hq -C "node --no-warnings -e 'const f=require(\"node:fs\"),{DatabaseSync}=require(\"node:sqlite\"),S=\"/app/scripts/\";const P=process.env.GRIDIRON_DB_PATH||\"/data/data.sqlite\";console.log(\"== db in use ==\");console.log(\"GRIDIRON_DB_PATH=\"+(process.env.GRIDIRON_DB_PATH||\"(unset)\"));try{for(const n of f.readdirSync(\"/data\"))console.log(\"/data/\"+n+\" \"+f.statSync(\"/data/\"+n).size)}catch(e){console.log(\"/data: \"+e.message)}console.log(\"== build ==\");console.log(\"/app/.git: \"+(f.existsSync(\"/app/.git\")?\"present\":\"absent\"));try{console.log(\"package.json version: \"+JSON.parse(f.readFileSync(\"/app/package.json\",\"utf8\")).version)}catch(e){console.log(\"package.json: \"+e.message)}console.log(\"== scripts on disk ==\");for(const n of [\"promote-volume-shrinkage.mjs\",\"promote-weekly-ensemble.mjs\",\"fit-availability.mjs\",\"fit-posture-calibration.mjs\",\"refresh-live-data.mjs\",\"verify-trade-brain-live.mjs\"])console.log(n+\": \"+(f.existsSync(S+n)?\"present\":\"MISSING\"));const d=new DatabaseSync(P,{readOnly:true});console.log(\"== by season ==\");for(const t of [\"nfl_qbr_weekly\",\"nfl_ffopportunity_weekly\",\"player_week_usage\"]){try{console.log(t+\": \"+(d.prepare(\"SELECT season AS s,COUNT(*) AS n,COUNT(DISTINCT week) AS w FROM \"+t+\" GROUP BY season ORDER BY season\").all().map(r=>r.s+\"=\"+r.n+\"/\"+r.w+\"wk\").join(\" \")||\"EMPTY\"))}catch(e){console.log(t+\": ERROR \"+e.message)}}console.log(\"== counts ==\");for(const t of [\"nfl_availability_rates\",\"nfl_availability_role_rates\",\"shrinkage_k\",\"manager_profiles\"]){try{console.log(t+\": \"+d.prepare(\"SELECT COUNT(*) AS n FROM \"+t).get().n)}catch(e){console.log(t+\": ERROR \"+e.message)}}try{const r=d.prepare(\"SELECT COUNT(*) AS n,SUM(active) AS a FROM shrinkage_fits\").get();console.log(\"shrinkage_fits: \"+r.n+\" rows, \"+(r.a||0)+\" active\")}catch(e){console.log(\"shrinkage_fits: ERROR \"+e.message)}d.close();'"
```

It opens the database with `readOnly: true`, runs only `SELECT COUNT(*)`, and
calls `fs.existsSync` / `fs.readdirSync`. It cannot change anything.

Tested end to end, including through a shell with this exact quoting: it
degrades to a named `ERROR` line rather than crashing when a table is missing,
and `--no-warnings` keeps node's experimental-SQLite notice out of the output.
**The one thing that could not be tested from here is how `flyctl` splits the
`-C` argument**, since `flyctl` is not installed in a cloud session. If the
second line fails on quoting, run `fly ssh console -a gridiron-hq` and paste the
`node --no-warnings -e '…'` part at the container prompt.

What each line decides:

- **`GRIDIRON_DB_PATH` and what is on `/data`** — which database file the scripts
  in steps 7-10 will actually open. Both resolve their target through that
  variable, and run against any copy other than the live volume they fit and
  activate a vector *for that copy* and leave the app untouched. That is a silent
  no-op, not an error, which makes it the most dangerous line here.
- **`/app/.git` and the package version** — the only direct evidence about the
  running build. Commit archaeology has already produced a contradiction (see
  step 1), so this is what settles whether it means anything at all.
- **scripts on disk** — all six, not just the promotion one. If
  `promote-volume-shrinkage.mjs` is present and `promote-weekly-ensemble.mjs` is
  not, someone promotes, cannot re-fit, and leaves the app parked in the middle
  state indefinitely.
- **`nfl_qbr_weekly` by season** — which of the three #15 gate verdicts applies.
  Empty passes, 2025-2026 only passes, 2021-2026 fully backfilled **fails**.
- **`nfl_ffopportunity_weekly` by season *with week counts*** — a completed season
  should show roughly 18 weeks. A season showing one or two is half-ingested,
  which is what this afternoon's OOM-killed syncs leave behind, and #28's guard
  asks whether a season is *present* rather than *complete* — so a season with a
  handful of rows is treated as done and never completed.
- **`player_week_usage` by season** — the before-reading for post-deploy check 3.
- **`shrinkage_fits` rows and active count** — the promotion is written as a first
  write. If live already holds an active fit, it is an *overwrite* and every
  "before" number measured tonight describes a configuration Nick is not running.
- **the availability and `manager_profiles` counts** — expected to come back
  `ERROR no such table` and `0` respectively. Both are load-bearing: see step 11
  for why the availability rollback is `DROP TABLE` and not `DELETE`.

`sqlite3` is deliberately not used: the image is `node:22-slim` (see
`Dockerfile`), which does not carry it. `GRIDIRON_DB_PATH` is set in the image,
so it does not need supplying.

## 6. Deploy plan

Steps 1-6 are the deploy; 7-10 are the two database writes; 11 is the rollback.

Everything from step 7 onward needs `fly ssh console`, which needs a real Fly
platform token. `GRIDIRON_FLY_TOKEN` is an application bearer token and does not
grant it, so no session here can run any of it.

**The deployed build is of unknown provenance.** Two read-only probes place it in
inconsistent positions on the branch stack, which is impossible for a clean
deploy of one commit — so the image may not have been built from a clean commit
at all. So the rollback below redeploys a captured *image*, not a commit.

### 1. Run the command in section 5, and keep the output

Write down the image reference (`registry.fly.io/gridiron-hq@sha256:…`). **If
`fly image show` does not return an image that can be redeployed, stop and say
so** — that changes how cautious step 3 should be, and it is much better to learn
it now than during a bad deploy.

### 2. Take the baseline reading

```
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=1&runs=2000&from_week=2" > ~/sim-before-s1.json
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=2&runs=2000&from_week=2" > ~/sim-before-s2.json
```

**Two seeds, not one.** The spread between them is the Monte Carlo noise band,
which is what makes a later movement defensible rather than arguable.

Three separate changes move the same numbers — playoff odds, title odds, trade
horizon. Two further sim fixes are coming from the fantasy plan thread and are
**not** in this train. If they all landed together nobody could attribute how
much moved to what.

Two details that make this reading worth taking:

- **`seed=1` makes it deterministic.** `model.js:524` threads the query seed
  through `withRandomSeed`, so a repeated call with the same seed is the same
  answer. Without it every difference is confounded with Monte Carlo noise.
- **`from_week=2` is passed explicitly** because the route defaults it to 1, and
  that default is one of the two things the fantasy plan thread is about to
  change. Pinning it keeps this baseline comparable across that change too.

Allow up to 300 seconds for this first request — the machine cold starts and
60-180 seconds is normal. A timeout under 300s is not an outage.

**Expect the odds to rise**, in some leagues by a lot. That is the fix working,
not a regression. Say so to anyone who looks before they report it as one.

### 2a. The cache that would have made all of this say "no change"

**Read this before taking any of the three readings.** `model.js:107-111` memoises
the simulator in a bare `Map` with no TTL, no fingerprint and no invalidation,
under the key `sim:<league>:<runs>:<from_week>:seed:<seed>` (`model.js:525-527`).
Nothing in that key mentions the availability tables. The codebase already knows:
`leagues.js:222` says in its own words that the simulator is "cached in-process
with no TTL... a roster change never shows up... until the whole server restarts."

Exactly one of the three readings is poisoned by this, and it is the one that
matters most. Steps 2 and 12 are fine: `fly deploy` replaces the process, so the
post-deploy reading is computed in an empty cache. But the availability fit is
written **from a separate ssh process**, which cannot clear the app process's
`Map`. So a third reading at `seed=1` returns the cached post-deploy answer byte
for byte, the comparison shows zero change, and the natural reading is "the fit
did not move the odds" - which would be false.

So the third reading does two independent things, and passes if either works:

1. `fly apps restart gridiron-hq` first, which clears every in-process cache and
   writes no data.
2. Read at a **seed never used before** as well. An unused key cannot be cached,
   so it answers even if the restart silently did not happen.

**Do not** use `POST /api/leagues/:id/sync` as the cache clear even though it
calls `clearModelCache()` (`leagues.js:228`): it also rewrites the league payload,
which confounds the very comparison being made. Same objection to
`POST /api/model/sync`, the only other caller (`model.js:648`), which is a
multi-season ingest - exactly the heavy work step 5 exists to keep away from the
fit. There is no clean cache-clearing route; the restart is the clean mechanism.

**The asymmetry is the opposite of the intuitive one, and is worth knowing for
any future before-and-after.** The trade engine does *not* need any of this:
`trade-engine.js:223-224` puts `nfl_availability_rates` and
`nfl_availability_role_rates` into its cache fingerprint stamped on `fitted_at`,
so writing the fit invalidates it by itself. The surface with the explicit
fingerprint is safe; the one that merely memoises is not.

### 3. Deploy

```
fly deploy -a gridiron-hq
```

Migrations run automatically at boot, before `app.listen` — there is no separate
release command. Expect a longer boot than usual: three new migrations plus seed
reconciliation against the volume. `fly.toml`'s health check has a 60-second
grace period for exactly this.

### 4. Watch the first boot, not the settled machine

The first boot is when the concurrency bug #33 fixes used to fire hardest: an
eighteen-job boot pass still running when the live timer starts the same jobs
behind it, two synchronous SQLite transactions writing the same tables.

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
the request thread. It comes off anyway for two reasons: steps 7 and 9 are both
long, read-heavy jobs on a 2 GB machine and there is no reason to have eleven
more competing with them; and **#26 adds `manager_archetypes` to the heavy
tier** — a daily child process with a 10-minute timeout — so leaving the flag on
means the first deploy also starts a job nobody has watched before. (#26's other
new job, `manager_signals`, is growth tier and hourly, so it starts regardless;
it runs off-thread deliberately.)

The flag can go back on after step 10.

A caveat on what this proves: we have probably been attributing all of the
wedging to the heavy tier, and at least some of it was concurrent writers. Do not
read a quiet machine after this step as proof the heavy tier was the whole story.

### 6. Post-deploy checks — test scheduling, not status

Three separate things today report healthy and are not: a source registry that
says `ok` because someone forced it by hand, a scheduler job that has never once
completed, and a corpus upload that exits zero and binds to nothing. So each
check asks whether the thing that was supposed to be produced now exists.

1. **The app is actually serving.** `GET /api/health` returns `{ok: true}` with an
   `uptime_s`. Poll it again a few minutes later: #17's route is the first one
   that can tell a wedged process from a healthy one.
2. **The feeds are SCHEDULED, not merely `ok`.** `/api/dev/sources` reads healthy
   for 24 sources that have no timer at all — they say `ok` only because a human
   forced them this afternoon, so "everything reads ok" proves nothing. Check
   `GET /api/mlb/sync/status` instead and confirm each of the six fantasy sources
   has **`scheduled_now: true` and a `due_after_minutes`**. Those two fields are
   added by #19 and exist precisely so this question has an answer. The six are
   `nflverse_crosswalk`, `nflverse_weekly_usage`, `nflverse_snap_counts`,
   `espn_depth_chart`, `espn_season_stats`, `sleeper_players`.
3. **And that they actually wrote.** A day later, count `player_week_usage` and
   `player_week_snaps` rows **for season 2026** — both are zero today — and check
   that each scheduled source has a `last_run` newer than the deploy. A source
   without a timer still shows today's sweep.
4. **`nfl_ffopportunity_weekly` has plausible week counts per season**, not merely
   rows. Compare against the before-reading from section 5. A season showing one
   or two weeks is half-ingested and will never be completed, because the guard
   asks whether a season is present rather than complete. Fixing that guard is a
   follow-up pull request, not part of this train.
5. **Migrations applied.** `schema_migrations` contains all three 061 rows:
   `061_google_identity_and_invites`, `061_sync_log_consecutive_failures`,
   `061_league_payload_season`.
6. **Sign-in did not lock anyone out.** #14 puts `assertLeagueMember` in front of
   every `/api/trades/:leagueId` route. Load a trade page for each of the five
   leagues and confirm none returns 403. This is the single highest-risk change in
   the train for existing behaviour.
7. **The Trade Brain actually works.** #18 ships a script for exactly this:
   `node scripts/verify-trade-brain-live.mjs` with `GRIDIRON_FLY_TOKEN` set gives
   a per-league pass/fail, and exits 2 rather than 1 if the app never answers — so
   a stalled machine cannot be misread as a failed feature.
8. **`evidence_daemon` is still failing, and that is expected.** 29 runs, 29
   failures, every one timing out on its 120-second budget. #32 makes that failure
   cheap and therefore quiet. It is betting-side and nobody is fixing it. **Do not
   read a clean scheduler tier as evidence that it started working** — check its
   own `sync_log` row. Same for `nfl_prop_calibration`, which crashes on a null
   before it does anything. Both are known-dead, not newly broken.
9. **Take the reading again**, same command as step 2, to `~/sim-after-deploy.json`.
   This separates every code change in the train from the data write in step 10.

**What the first run will honestly look like**, so nobody reads it as breakage:
`manager_profiles` is empty in all five leagues, so the tier editor shows
"Default — assumed tradeable" everywhere. That is real; nothing has ever been set.

### 6a. The chat corpus, when Nick runs `npm run chat:sync`

Not a deploy step — it runs on Nick's Mac — but it belongs here because it has a
dependency that wastes the effort if it is missed. The corpus attaches to **no**
league until someone says who is who: which league owns it is derived from
`league_member_identity` rows with `confidence = 'confirmed'`, and those have
never been written on that machine. #26 adds the way in, said once:

```
POST /api/trades/managers/rebuild
{"league_ids":[3],"confirmations":{"3":{"<roster_id>":"<the name they post under>"}}}
```

Admin-only. Until that is done, Transfer portal will correctly report itself
chat-free even after a successful upload. Note it is **league 3**, not 4, and its
stored name has a trailing space that breaks exact-match lookups.

### 7. Database write 1, dry run — the opportunity promotion gate

```
fly ssh console -a gridiron-hq
cd /app && node scripts/promote-volume-shrinkage.mjs --dry-run
```

Writes nothing. Prints the fitted vector, the `nfl_qbr_weekly` coverage, and five
pre-registered conditions. About 90 seconds on a warm machine. **All five must
read `true`.** If any is false, stop; do not promote and do not argue with the
gate.

The gate is read-heavy, so it wants a machine responding steadily — not one good
response. That is why it comes after steps 3-5 rather than before them.

### 8. Database write 1 — promote

```
node scripts/promote-volume-shrinkage.mjs
node scripts/promote-weekly-ensemble.mjs
```

The first writes one row to `shrinkage_fits` and six to `shrinkage_k`, in one
transaction, and sets `active = 1`. The second inserts one row into
`weekly_ensemble_fits`. **Run both in the same sitting**: step 1 alone is a
measured wash, and the whole improvement comes from the second. Stopping between
them leaves the app parked in a middle state that delivers nothing.

### 9. Database write 2, dry run — the availability fit

```
node scripts/fit-availability.mjs --dry-run --report=/tmp/fit.json
```

Writes nothing, produces every gate number and the full ship/no-ship decision,
and puts the verdict on file rather than only in a terminal. This exists so step
10 is reading a result rather than making a judgement call. Do not skip it
because the fit has been run elsewhere — those runs were against a local rebuild,
not this database.

Expect the main gate to pass decisively — log loss 0.558 → 0.397, bootstrap CI90
[-0.176, -0.147], calibration error 0.082 → 0.017 on 8,663 held-out rows — and
expect `ship: false` on the role table. That is the *expected* outcome, not a
surprise on the night.

**This is the most carefully staged step in the plan, and it is bigger than its
runbook implies.** Only `contingency.js` reads the two tables, but eight modules
consume it, and one of them is `player-week-engine.js:190` — the shared
projection engine. So the honest statement is not "this changes Start/Sit". It is:
**running this script changes the projection engine every fantasy surface is
built on, with no code deploy and no pull request.** Start/Sit, the waiver board,
asset values, `season-sim.js:212` (once per simulated week, which is what prices
playoff and title odds), `trade-engine.js:304` and `:345`, and the trade horizon
via `trade-engine.js:1317` all move.

### 10. Database write 2 — and the one decision that is Nick's

```
node scripts/fit-availability.mjs
```

Creates and fills `nfl_availability_rates` (~139 rows). It will **leave
`nfl_availability_role_rates` empty**, because one 60-row `none/unknown` cell
fails a per-cell check and the script refuses to ship the role layer when that
happens. Sixty rows veto a table fitted on 8,663.

That is the decision:

- **Shape A (recommended, and what the command above does).** Ship the main table,
  leave the role table empty. It needs no code change.
- **Shape B.** Also fill the role table, which means restructuring the gate so an
  unknown-tier cell cannot veto it — a code change, reviewed and tested like any
  other. **Nobody loosens a pre-registered gate after seeing the result**, so this
  is a deliberate decision made in daylight, not something done at a console.

Then:

1. **Confirm it landed.** `availability_basis.stamp` goes `absent|absent` →
   `139:<ts>|…`. No restart needed: `contingency.js:543` re-reads when the row
   count or `fitted_at` changes. Landing on `pooled` rather than `role` means the
   gate declined to ship the role layer — a legitimate outcome, not an error.
2. **Spot-check a healthy starter**, who should move from ~0.70 to ~0.95.
3. **Restart, then take the reading a third time.** `fly apps restart
   gridiron-hq` first — the fit was written from an ssh process and cannot clear
   the app process's memo cache, so without this the reading returns the cached
   post-deploy answer and the fit looks like it did nothing (step 2a). Then read
   at seeds 1 and 2, which compare exactly against the post-deploy pair, and at
   seed 3, which has never been used and so answers even if the restart did not
   take. Take them promptly: the restart re-runs `bootJobs` and
   `weeklyAvailability` reads `nfl_injuries` (`contingency.js:837`), which the
   live tier may refresh underneath you. The difference is this write's effect on
   playoff odds, isolated from every code change in the train — and the baseline
   the fantasy plan thread's two sim fixes will be measured against.
4. **Re-fit the posture calibration:** `node scripts/fit-posture-calibration.mjs
   --rebuild`. This is a step, not advice. `SPREAD_SCALE = 1.63` in
   `lineup-posture.js` prices the matchup card's win probability and was fit under
   a different availability basis; leaving it silently degrades that number, which
   is the same defect class as everything else found tonight. The script refuses a
   cached dataset built under another availability fit, so it will say if it is
   stale rather than quietly using it.

### 11. Rollback

**The availability fit — and note this is `DROP`, not `DELETE`:**

```sql
DROP TABLE nfl_availability_rates;
DROP TABLE nfl_availability_role_rates;
```

Verified in the code rather than assumed: those two tables are created **only by
`scripts/fit-availability.mjs`** (lines 54-55, via `AVAILABILITY_RATES_DDL`), and
nothing else in `server/` executes that DDL. So on the live database they do not
exist at all — `absent` is the missing-table state, not the empty state, which is
why `contingency.js:553` maps `no such table` to it. There are no prior rows to
preserve and nothing to back up, and dropping them restores today's behaviour
exactly, without a restart. A `DELETE` would leave empty tables behind, which is a
state the app has never been in.

Say explicitly what this reverts, because anyone reading it will be thinking
about Start/Sit alone: **the playoff odds, the title odds, the trade horizon, the
trade values and every projection**, along with Start/Sit.

**The opportunity promotion:**

```sql
UPDATE shrinkage_fits SET active = 0;                                 -- undoes step 8
UPDATE weekly_ensemble_fits SET promoted = 0 WHERE id = <the new id>; -- undoes step 8's second half
```

One statement each. `activeKVector()` returns null with no active row and
`pickK()` falls through to the hand-picked literals. No fit row is destroyed, so
both are reversible in either direction.

**The deploy:**

```
fly deploy --image <the reference captured in step 1> -a gridiron-hq
```

Redeploying the captured image, not rebuilding from a commit — because we do not
know which commit the running build was made from. Migrations are additive and
the three new ones drop nothing, so an older image boots against the migrated
volume without a schema rollback. If a migration does need undoing,
`npm run db:rollback` takes one at a time, newest first — with the caveat above
about which of the three 061s it picks.

## 7. The run sheet

Every command in order, for the moment the decision is made. Nothing here is a
description; each line is meant to be pasted. Steps 1-2 are read-only. **Step 3
is the first irreversible action in the whole plan.**

### Read-only, safe to run now

```
# 1. What is on the machine, what the database holds, what image is running.
#    (The full command is in section 5.)
fly image show -a gridiron-hq
```

**Stop here if `fly image show` returns nothing usable.** That reference is the
only rollback there is; everything after step 3 assumes it exists. Do not
proceed on the hope that `fly releases` will have it later.

```
# 2. The baseline reading, seeded so it is comparable.
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=1&runs=2000&from_week=2" > ~/sim-before.json
```

### The merge — irreversible from here

> **STOP. Everything above this line can be run and undone freely. Nothing below
> it can.** Step 3 writes to the deployment branch; step 5 publishes it. Before
> pasting either, be sure of two things: the image reference from step 1 is in
> hand, and step 4 came back green.

```
# 3. Land the train. Same order, same branches, as the run that was proved.
git fetch origin --prune
git checkout main && git pull origin main
for b in 3ldl77 3ldl77-deploy 3ldl77-server 3ldl77-client 3ldl77-docs \
         5podec sytruo-stacked \
         o3wt2p o3wt2p-honesty o3wt2p-fantasy o3wt2p-blocking o3wt2p-watchdog \
         o3wt2p-current-season o3wt2p-live-tier o3wt2p-reentry \
         5f9c3y-honesty 5f9c3y-narration 5f9c3y-drafts \
         3xqh5l-proposals-live 3xqh5l-signals-api 3xqh5l-manager-read \
         3xqh5l-brain-ui 3xqh5l w45mur n4052e; do
  git merge --no-edit "origin/claude/project-thread-$b" || { echo "STOPPED at $b"; break; }
done
```

Two notes on that loop. It stops at the first conflict rather than carrying on,
because a half-merged deployment branch is worse than a stopped one. And it
expects the two fixes in section 3 to have landed in their source pull requests
first — without them it stops at `n4052e`, and the seven `manager-signals-api`
tests fail. If they have not landed, resolve `scripts/start-smoke.mjs` in favour
of the `HEAD` side (#17's probe, the one that checks `probe.ok`).

```
# 4. Verify before pushing. This is the same five checks CI runs.
npm ci && npm run check
```

**Do not push on a red result.** The proved run was 2,928 tests with 0 failures;
anything else means a branch moved after the proof and needs looking at.

```
# 5. Push.
git push origin main
```

### Deploy

```
# 6. Deploy. Migrations run at boot, before app.listen.
fly deploy -a gridiron-hq

# 7. Watch the first boot — this is when the concurrency bug used to fire hardest.
fly logs -a gridiron-hq

# 8. Take the heavy tier off while the database writes run.
fly secrets unset AUTO_HEAVY_SYNC -a gridiron-hq

# 9. Prove it came back. Allow 300s for the first request: the machine cold starts.
curl -sS --max-time 300 https://gridiron-hq.fly.dev/api/health

# 10. Prove the feeds are SCHEDULED, not just green.
curl -s -H "Authorization: Bearer $TOKEN" \
  https://gridiron-hq.fly.dev/api/mlb/sync/status | grep -A2 -E "nflverse_|espn_depth|espn_season|sleeper_players"

# 11. Prove the Trade Brain works, per league. Exits 2 if the app never answers.
GRIDIRON_FLY_TOKEN=... node scripts/verify-trade-brain-live.mjs

# 12. The reading again, for attribution. Fresh process after the deploy, so
#     these are computed rather than served from the memo cache.
for S in 1 2; do
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=$S&runs=2000&from_week=2" > ~/sim-after-deploy-s$S.json
done
```

### The two database writes

```
fly ssh console -a gridiron-hq
cd /app

# 13. Gate, read-only. All five conditions must read true. About 90 seconds.
node scripts/promote-volume-shrinkage.mjs --dry-run

# 14. Write 1, both halves, same sitting.
node scripts/promote-volume-shrinkage.mjs
node scripts/promote-weekly-ensemble.mjs

# 15. Gate, read-only, verdict on file. Expect ship:false on the role table.
node scripts/fit-availability.mjs --dry-run --report=/tmp/fit.json

# 16. Write 2, after reading step 15.
node scripts/fit-availability.mjs

# 17. Re-fit the posture calibration, which step 16 makes stale.
node scripts/fit-posture-calibration.mjs --rebuild
```

```
# 18. Clear the memo cache FIRST. The fit was written from an ssh process and
#     cannot clear the app process's Map, so without this step 19 returns step
#     12's cached answer and the fit looks like it did nothing. See step 2a.
fly apps restart gridiron-hq
curl -sS --max-time 300 https://gridiron-hq.fly.dev/api/health

# 19. The reading a third time. Seeds 1 and 2 compare exactly against step 12;
#     seed 3 has never been used, so it answers even if the restart did not take.
#     Take these promptly: the restart re-runs bootJobs, and weeklyAvailability
#     reads nfl_injuries (contingency.js:837), which the live tier may refresh.
for S in 1 2 3; do
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=$S&runs=2000&from_week=2" > ~/sim-after-fit-s$S.json
done
```

### Undo

```sql
-- Write 2. DROP, not DELETE: these tables do not exist on live today.
DROP TABLE nfl_availability_rates;
DROP TABLE nfl_availability_role_rates;

-- Write 1.
UPDATE shrinkage_fits SET active = 0;
UPDATE weekly_ensemble_fits SET promoted = 0 WHERE id = <the new id>;
```

```
# The deploy. The image reference from step 1, not a commit.
fly deploy --image <ref> -a gridiron-hq
```

## 8. Evidence

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
