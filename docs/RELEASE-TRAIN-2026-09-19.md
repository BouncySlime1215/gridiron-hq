# Release train — 2026-09-19

Twenty-five pull requests were opened against this repository on 2026-09-19 by
six threads. None of it is deployed: `gridiron-hq.fly.dev` is running a build
that predates all of them. This file is the ordered sequence for landing them,
the evidence that the sequence works, and the deploy plan that follows it.

**Nothing here has been merged or deployed.** Everything below was proved on a
throwaway scratch branch built from `main`, which has been discarded.

## 1. The order

Twenty-four pull requests, merged bottom-first. Each line is a merge into the
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
| 17 | `…-o3wt2p` | Heavy scheduler tier off the main thread, plus a real `/api/health`. First of the scheduler chain because everything else in it is stacked on it, and because the health route it adds is what `fly.toml`'s HTTP check and #14 both need. |
| 19 | `…-o3wt2p-honesty` | Retry backoff, `sync_log.consecutive_failures` |
| 20 | `…-o3wt2p-fantasy` | The six fantasy feeds on timers |
| 28 | `…-o3wt2p-blocking` | Two always-on megabyte-parsing jobs off the request thread |
| 29 | `…-o3wt2p-watchdog` | Kill the process when the event loop stops turning |
| 31 | `…-o3wt2p-current-season` | `POST /api/model/sync` ingests the season being played |
| 32 | `…-o3wt2p-live-tier` | `evidence_daemon` and `nfl_reports` off the request thread |
| 21 | `…-5f9c3y-honesty` | League analysis unpriced-guard, waiver coverage |
| 27 | `…-5f9c3y-narration` | Start/Sit and the matchup card stop narrating zeros |
| 30 | `…-5f9c3y-drafts` | Draft room refuses to rank with no market |
| 25 | `…-3xqh5l-proposals-live` | Trade Lab proposals parse, per-league budget. **Before #22** — see below. |
| 26 | `…-3xqh5l-signals-api` | Serves the measured manager layer. **Before the chat sync is worth running** — see below. |
| 23 | `…-3xqh5l-manager-read` | Counterparty read on every trade card |
| 22 | `…-3xqh5l-brain-ui` | The Trade Brain page |
| 18 | `…-3xqh5l` | Live check that says whether the Trade Brain works |
| 15 | `…-w45mur` | Opportunity model. Carries the promotion script and runbook that deploy step 6 uses. |
| 14 | `…-n4052e` | Google sign-in and per-user scoping. **Last, and it must come after #17** — see below. |

Positions 19, 20, 28, 29, 31, 32 and 27, 30 are forced: each is stacked on the
one above it in git. Positions 8, 24, 23, 18, 15 are free — they are placed for
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
`scripts/start-smoke.mjs`, which is the only textual conflict in the whole train.
The fix is in section 3.

**#25 before #22.** #22 adds the Trade Brain page; #25 makes the proposal parse
read the model's answer and remembers an unanswerable slate for six hours
(`FAILED_SLATE_TTL_MS`) instead of paying for it again. Checked rather than
assumed: `ProposalSlate.tsx` uses `api()` and not `useApi()` specifically so it
does **not** fetch on mount, and `TradeBrain.tsx` says so in a comment. So the
cost is per click on "write proposals", not per page load. The ordering still
holds and costs nothing, but it is a smaller hazard than it has been described
as.

**#26 before the chat corpus sync.** The corpus binds to a league through
`league_member_identity` rows with `confidence = 'confirmed'`, and the only
writer of those is `matchIdentities`, reached from
`scripts/refresh-live-data.mjs` — which #26 changes. Without #26 an upload exits
zero and attaches to nothing. Verified: `manager-signals.js:449` and the
seeding path in #26's diff. This is a post-deploy constraint on Nick's
`npm run chat:sync`, not a merge-order one.

### Not an ordering constraint, though it looks like one

#14's per-user scoping and #26's new route break each other's tests, but
**in either order**. See section 3.

## 2. Deliberately excluded

**PR #6 — "Betting model: live audit, unified + master plan, and in-repo
research corpus."** 375 commits, 1,128 files, 1.2M added lines, described by its
own body as "docs/plan/corpus only; no product code changed yet." It is betting
work, which Nick ruled out of scope, and the parts of it that were not betting
were already split out into #7, #9, #10, #11 and #12 — which are in the train.
Merging it would re-add the 481-file research corpus that #12 exists to keep out.

Nothing else in the train is betting work. #28 and #32 move betting jobs
(`nfl_prop_feeds`, `beat_the_close`, `evidence_daemon`, `nfl_reports`) off the
request thread, which is in scope because those jobs pin the machine the fantasy
app runs on.

## 3. What broke when it was proved, and what fixes it

The twenty-four branches were merged in the order above onto a scratch branch
from `main`, and the repository's own `npm run check` was run on the result:
typecheck, lint, the full test suite, the client build, and the start-up smoke
test.

**Result of the first run: 2,921 tests, 2,873 passed, 7 failed.** Typecheck,
lint and build were clean. Twenty-three of the twenty-four merges were
conflict-free.

### Break 1 — `scripts/start-smoke.mjs`, the only merge conflict

#17 and #14 both rewrote the start-up probe to poll `/api/health`. #17's checks
`probe.ok` and the response body and keeps waiting on a 503; #14's treats any
response at all, including a 503 or a 404, as the app being up.

**#17's version wins**, and #14 should stop adding a health route of its own.
The fix, on `claude/project-thread-n4052e`:

1. Delete the one-line `app.get('/api/health', (_req, res) => res.json({ ok: true }));`
   and its comment block from `server/index.js`.
2. Take #17's `scripts/start-smoke.mjs` probe verbatim.
3. Retarget PR #14's base from `…-3ldl77-docs` to `…-o3wt2p-live-tier`, so #14
   still has a health route to probe when its own CI runs. #14 is last in the
   train, so this costs nothing.

### Break 2 — seven failing tests, `test/manager-signals-api.test.js`

Every request in that file returns **403 instead of 200**. #26 adds
`GET /api/trades/:leagueId/managers/signals`; #14 puts `assertLeagueMember` in
front of every `/api/trades/:leagueId` route. #26's fixture creates two users and
two sessions but no `league_memberships` rows, because when it was written
nothing required them.

Both pull requests are right. The route *should* be membership-guarded. The fix
is in #26's fixture, and it is safe on #26's own base too: `league_memberships`
has existed since migration 006, so seeding it is a no-op until #14 lands. On
`claude/project-thread-3xqh5l-signals-api`, after the last `insertLeague` call in
`test/manager-signals-api.test.js`:

```js
for (const id of [21, 22, 23, 24]) {
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7701, 'member')`, id);
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7702, 'commissioner')`, id);
}
```

League 999 is deliberately left out — it does not exist, and the 404 test needs
it not to.

Both fixes were applied to the scratch branch and the whole suite re-run. The
result is in section 6.

### Not a break: three migrations numbered 061

#14, #19 and #21 each add a `server/migrations/061_*.js`, on top of a base stack
that ends at 060. This is survivable rather than broken: `server/db/migrate.js`
keys `schema_migrations` on the **full filename**, not the number, and applies
files in `.sort()` order, so all three are applied exactly once and none blocks
another. They touch unrelated tables (`league_memberships`/identity, `sync_log`,
league payload season), so the order between them does not matter.

The one sharp edge: `npm run db:rollback` with no argument rolls back the
*last-sorted* of the three, which is `061_sync_log_consecutive_failures`, not
whichever was conceptually last. Renumbering to 061/062/063 would be tidier and
is a rename of files nothing has applied yet. It is not required and is not in
this plan.

### Verified, contrary to an earlier worry: nothing here backfills QBR

The #15 gate passes on the live database only because `nfl_qbr_weekly` holds
2025-2026 and nothing for 2021-2024. Nothing in the train changes that on
deploy. The only scheduled QBR job is `nfl_qbr_weather`
(`scheduler.js:1216`), which calls `syncQbr({ seasons: [season - 1, season] })`
— 2025 and 2026 only. `POST /api/model/sync` does not touch QBR at all, and
neither does `syncAllAdvanced`. A 2021-2024 backfill can only happen if somebody
runs one deliberately.

## 4. Not ready

| # | State | What it needs |
|---|---|---|
| 8 | CI **cancelled** at 15:58Z, never completed | A re-run, which has been queued. It changes only `CLAUDE.md` and `.claude/skills/`, so a green run is a formality — but it has never had one. |
| 15 | CI **in flight** at time of writing | Nothing but time. Its previous head was green; it was pushed again at 19:39Z. |

Every other pull request in the train has a completed, green
`typecheck, lint, test, build, smoke` run on its current head.

## 5. Deploy plan

Run in order. Steps 1-5 are the deploy; steps 6-9 are the two database writes
and the work that depends on them; step 10 is the rollback if any check fails.

Everything from step 6 onward needs `fly ssh console`, which needs a real Fly
platform token. `GRIDIRON_FLY_TOKEN` is an application bearer token and does not
grant it, so no session here can run any of it.

**Before anything: the deployed build is of unknown provenance.** Two read-only
probes of the running app place it in inconsistent positions on the branch
stack, which means it was not necessarily built from a clean commit. So the
rollback below redeploys a captured *image*, not a commit.

### 1. Capture what is running, before deploying over it

```
fly image show -a gridiron-hq
fly releases -a gridiron-hq
```

Write down the image reference (`registry.fly.io/gridiron-hq@sha256:…`) and the
current release number. **If neither command returns an image that can be
redeployed, stop and say so** — that changes how cautious step 3 should be, and
it is much better to learn it now than during a bad deploy.

### 2. Confirm what is actually on the machine

```
fly ssh console -a gridiron-hq -C "ls -l /app/scripts/"
```

One second, and it settles whether `promote-volume-shrinkage.mjs` and
`fit-availability.mjs` are already there. They will be after step 3 regardless;
this is worth doing because it is the only direct evidence of what the running
build contains.

### 3. Deploy

```
fly deploy -a gridiron-hq
```

Migrations run automatically at boot, before `app.listen` — there is no separate
release command. Expect the boot to take longer than usual: three new migrations
plus seed reconciliation against the volume. `fly.toml`'s health check has a
60-second grace period for exactly this.

### 4. Unset the heavy-sync flag

```
fly secrets unset AUTO_HEAVY_SYNC -a gridiron-hq
```

**This is now precautionary, not load-bearing.** After #17, `scheduler.js:1579`
runs every `tier: 'heavy'` job in a worker thread by default, so the flag no
longer wedges the request thread. It comes off anyway because steps 6 and 8 are
both long, read-heavy jobs on a 2 GB machine and there is no reason to have
eleven more competing with them. It can go back on after step 9.

### 5. Post-deploy checks — count rows, do not read statuses

Three separate things today report healthy and are not: a source registry that
says `ok` because someone swept it by hand, a scheduler job that has never once
completed, and a corpus upload that exits zero and binds to nothing. So each
check below asks whether the thing that was supposed to be produced now exists.

1. **The app is actually serving.** `GET /api/health` returns `{ok: true}` with
   an `uptime_s`. Allow up to 300 seconds for the first request — the machine
   cold starts and 60-180 seconds is normal, so a timeout under 300s is not an
   outage. Then poll it again a few minutes later: #17's route is the first one
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
   leagues and confirm none returns 403. This is the single highest-risk change
   in the train for existing behaviour.
5. **`evidence_daemon` is still failing, and that is expected.** It has run 29
   times and failed 29 times, always on its budget. #32 makes that failure cheap
   and therefore quiet. It is betting-side and nobody is fixing it. **Do not read
   a clean scheduler tier as evidence that it started working** — check its own
   `sync_log` row.

### 6. Database write 1, dry run — the opportunity promotion gate

```
fly ssh console -a gridiron-hq
cd /app && GRIDIRON_DB_PATH=/data/data.sqlite node scripts/promote-volume-shrinkage.mjs --dry-run
```

Writes nothing. Prints the fitted vector and five pre-registered conditions.
Takes about 90 seconds on a warm machine. **All five must read `true`.** If any
is false, stop; do not promote.

Record `SELECT season, COUNT(*) FROM nfl_qbr_weekly GROUP BY season` at the same
time. The gate's verdict depends on it: empty passes, 2025-2026 only passes,
2021-2026 fully backfilled **fails**. Today's live database is the middle case.
This is why the gate has to be re-read here rather than trusting tonight's
verdict, and why the promotion and a QBR backfill cannot both happen in the same
window without re-deciding.

### 7. Database write 1 — promote

```
node scripts/promote-volume-shrinkage.mjs
node scripts/promote-weekly-ensemble.mjs
```

The first writes one row to `shrinkage_fits` and six to `shrinkage_k`, in one
transaction, and sets `active = 1`. The second inserts one row into
`weekly_ensemble_fits`. Run both in the same sitting: the state between them is
measurably a wash, and the whole improvement comes from the second.

### 8. Database write 2, dry run — the availability fit

```
cd /app && GRIDIRON_DB_PATH=/data/data.sqlite node scripts/fit-availability.mjs --dry-run --report=/tmp/avail.json
```

Writes nothing and produces every gate number. This exists so the decision in
step 9 is reading a result rather than making a judgement call.

Expect the main gate to pass decisively — on a local full-history rebuild, log
loss 0.558 → 0.397 and calibration error 0.082 → 0.017 on 8,663 held-out rows.
The shipped constants are badly wrong in the common case: a starter with no
injury report is 94.5% to play and the app currently says 69.5%.

### 9. Database write 2 — and the one decision that is Nick's

```
node scripts/fit-availability.mjs
```

Fills `nfl_availability_rates`. It will **leave `nfl_availability_role_rates`
empty**, because one 60-row unknown-tier cell fails a per-cell check and the
script refuses to ship the role layer when that happens.

That is the judgement call:

- **Shape A (recommended, and what the command above does).** Ship the main
  table, leave the role table empty. Strictly better than today in every case
  the gate measured, and it needs no code change.
- **Shape B.** Also fill the role table, which requires loosening that per-cell
  gate — a code change to `scripts/fit-availability.mjs`, reviewed and tested
  like any other. Not something to do at a console.

Afterwards, re-fit the posture calibration, which goes stale once role rates
exist. If shape A is taken and the role table stays empty, this is a no-op.

### 10. Rollback

**Database, either write, instantly:**

```sql
UPDATE shrinkage_fits SET active = 0;                                -- undoes step 7
UPDATE weekly_ensemble_fits SET promoted = 0 WHERE id = <the new id>; -- undoes step 7's second half
DELETE FROM nfl_availability_rates;                                   -- undoes step 9
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
know which commit the running build was made from. Migrations are additive and
the three new ones do not drop anything, so an older image boots against the
migrated volume without a schema rollback. If a migration does need undoing,
`npm run db:rollback` takes one at a time, newest first.

## 6. Evidence

Scratch branch built from `main` at `ffe4e72`, 24 merges in the order in section
1, both fixes from section 3 applied.

- Merges: 23 of 24 conflict-free; one conflict, in `scripts/start-smoke.mjs`.
- First run, before the fixes: 2,921 tests, 2,873 passed, **7 failed**, all in
  `test/manager-signals-api.test.js`.
- Second run, with both fixes: recorded in the pull request that carries this
  file.
- Typecheck, lint, client build and start-up smoke were clean in both runs.

The scratch branch is a test fixture and has been thrown away. Every fix belongs
in its source pull request, and neither has been pushed there — both are other
threads' branches.
