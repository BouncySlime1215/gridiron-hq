# Release train — 2026-09-19

Twenty-nine pull requests were opened against this repository on 2026-09-19 by
eight threads. None of it is deployed: `gridiron-hq.fly.dev` is running a build
that predates all of them. This file is the ordered sequence for landing them,
the evidence that the sequence works, and the deploy plan that follows it.

**Nothing here has been merged or deployed by this session.** Everything below
was proved by merging the twenty-six branches onto a scratch branch built from
`main` and running the repository's own checks against the result.

**The proved tree is published as `claude/release-train-2yv3x6-proof`** so it
can be landed without re-merging anything: commit
`791b131f24824b8c3eb7dd2172165b5ab55c2b04`, tree
`1b2341aa116031e40c9b10abf1ff9270e150a347`. That tree hash is the whole proof —
the merge commits can be rebuilt and will differ, the tree will not, and the
tree is what gets built and deployed. Check it before pushing, and treat a
mismatch as a stop.

## How to read the code references in this file

**Every `file.js:NNN` in this document is read from the tree that ships**, not
from any working checkout. Verify with `git show <proof-ref>:<path>`, and after
the train lands with `origin/main`.

This is not pedantry. The branch carrying *this document* has `main`'s `server/`
— the code being replaced. On the evening this was written its
`contingency.js` was **323 lines**, against **1,093** on the merged tree, so
every offset past the first few hundred lines was wrong by hundreds of lines
while still landing on plausible-looking code. Four line numbers went into
circulation that way in one hour, and one session confidently told another its
correct numbers were stale.

A wrong line number is worse than no line number, because it sends the reader to
real code that reads closely enough to be believed, and nothing errors. So:
**cite the ref alongside the line**, prefer function names in prose, and when two
readings disagree, establish which tree each was read from before deciding which
is wrong. The larger file is usually the merged one.

## Summary

Twenty-six pull requests go in, in the order in section 1. Three are excluded:
one is betting work, one is in-scope work sitting on a betting base, and one is
tooling that arrived after the sequence was proved.

**Merging all twenty-six, against every branch's current head, produces no
conflicts and needs no hand-applied fixes, and the merged tree is green:
2950 tests, 2909 passed, 0 failed, 41 skipped**, plus a clean
`npm ci`, typecheck, lint, client build and start-up smoke test — the same five
steps the CI job runs. That was not true two hours ago. The first run of this
sequence hit one textual conflict and seven failing tests, neither of which any
individual pull request could show, because each needed two green branches
present at once. Both are now fixed in their own source branches by the threads
that own them, which is section 3.

One thing worth saying before the sequencing: **deploying is not only a risk to
be managed, it is a cure.** Part of what makes the machine feel dangerous to
touch is running on it right now — a scheduler with no per-job concurrency guard
(#33), eleven heavy jobs on the request thread (#17), and a TCP health check that
cannot see a wedged process (#9). The instinct with a wedging production app is
to touch it as little as possible. Here the opposite is true.

## 1. The order

Twenty-six pull requests, merged bottom-first. Each line is a merge into the
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
| 22 | `…-3xqh5l-brain-ui` | The Trade Brain page. **ON HOLD** — see below. |
| 18 | `…-3xqh5l` | Live check that says whether the Trade Brain works |
| 37 | `…-f921do-gate-v2` | The restructured availability gate, cherry-picked alone onto the stack base so it lands without #34. **Before #15**, because it decides what deploy step 10 writes. |
| 15 | `…-w45mur` | Opportunity model. Carries the promotion script and runbook that deploy step 7 uses. |
| 14 | `…-n4052e` | Google sign-in and per-user scoping. **Last, and it must come after #17.** |

**#22 was held for about ten minutes and ships.** The wiring-map tool (PR #36)
reported that the counterparty read depends on four tables nothing on the server
fills, which would have meant every trade-partner screen formatting emptiness
into something that reads like an answer — the exact defect class this whole
deploy is about. Checked rather than taken, and the conclusion was wrong while
its first half was right. Those four tables are not in the app's database at
all: they live in a separate SQLite file opened through `chatDbPath` and
`messagesDbPath`, and nothing is *supposed* to insert rows into them, because
they arrive as a whole file — Nick's corpus, extracted on his Mac.
`POST /api/league-chat/upload` is the server-side writer, and it refuses a file
whose `messages` table is empty, keeps the previous copy under a timestamped
name, and renames the new one into place atomically. So "nothing writes these
tables" is true row-by-row and misleading as a conclusion.

And on the question that actually decided it: both surfaces already guard, in
#30's pattern and written that way deliberately rather than retrofitted.
`ManagerRead` gates on a `counterparty_data` flag and prints a line saying the
deal is priced on our numbers only, and that this is not the same as the manager
looking neutral. `ManagerBoard` has four named states including a sentence for a
404. The live capture reads `counterparty_data: false` on every league right
now, which is exactly the state that triggers those lines. Thirteen of thirteen
and twenty of twenty tests re-run on each branch's current head, several named
for this precise failure. **#22 sits where it always did, behind #25.**

Worth keeping from the exercise: the tool can tell whether code fills a table,
not whether the rows in it are any good. A clean report from it is not a working
feature, and the post-deploy checks in section 6 must not start treating it as a
substitute for counting rows.

Positions 19, 20, 28, 29, 31, 32, 33 and 27, 30 are forced: each is stacked on
the one above it in git. Positions 8, 24, 23, 18, 15 are free — placed for
readability, not necessity.

### The three constraints that are real

**#17 before #14.** This was the train's sharpest edge and it is now closed in
the branches rather than in this document; the history is in section 3 because
it is the best argument in the plan for proving an order instead of reasoning
about one. Both branches independently invented `GET /api/health`, git merged
them without conflict because they landed in different places in
`server/index.js`, and the merged file registered the route twice — with #14's
unconditional `res.json({ ok: true })` one reordering away from becoming Fly's
liveness check, which is exactly the TCP-check failure `fly.toml` was changed to
fix. #14 has since merged #17's extracted handler and deleted its own route, so
the merged tree now registers `/api/health` once, at `server/index.js:86`,
delegating to `healthHandler()`. The ordering constraint itself stands: #14
takes #17's handler, so #17 merges first.

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

**One commit on it is now being extracted, and only that one.** `0bd4041`, the
restructured availability gate Nick authorised tonight, is in
`server/services/contingency.js` on this branch and nowhere else. Step 10 needs
it, because `fit-availability.mjs` imports the gate rather than carrying it, so
whether the role table ships is decided by which `contingency.js` is in the
image. The owning thread is cherry-picking that change — one module, one TDD
document, one test file — onto a fresh branch off `…-3ldl77-docs` and opening it
as its own pull request, so none of #6 travels with it. When it exists and is
green it joins the train immediately before #15 and the train is re-proved with
it. The rest of #34 stays excluded on the base problem. **As of 20:19Z no such
branch has been pushed**, and the rest of this plan reads as if it will not
arrive; step 10 says what happens in each case.

**PR #36 — the wiring map.** Opened after this sequence was proved. It is
tooling rather than product (one script, one test, two `package.json` entries and
generated output under `docs/wiring/`), it has already earned its keep by finding
the #22 hold, and it goes in the next train. Adding it to this one for tidiness
is precisely the collision this train exists to avoid.

Nothing else in the train is betting work. #28 and #32 move betting jobs
(`nfl_prop_feeds`, `beat_the_close`, `evidence_daemon`, `nfl_reports`) off the
request thread, which is in scope because those jobs pin the machine the fantasy
app runs on.

## 3. What broke when it was proved, and what fixes it

**Both breaks in this section are now closed in the source branches, and the
current train merges with no conflicts and no hand-applied fixes at all.** The
section is kept in full because it is the argument for this whole exercise: each
break involved two pull requests that were green on their own, and neither could
be seen from either one.

The branches were merged in the order above onto a scratch branch from `main`,
and the repository's own checks were run on the result: typecheck, lint, the
full test suite, the client build, and the start-up smoke test.

**On the first run, before the fixes: 2,921 tests, 2,873 passed, 7 failed**,
with one textual conflict. Typecheck, lint and build were clean.

### Break 1 — `scripts/start-smoke.mjs`, the only merge conflict

#17 and #14 both rewrote the start-up probe to poll `/api/health`. #17's checks
`probe.ok` and the response body and keeps waiting on a 503; #14's treats any
response at all, including a 503 or a 404, as the app being up.

**Closed in the branches, in three pieces by two threads.**

1. **The handler's body.** The scheduler thread found that #17's failure path
   returned the raw SQLite error — `unable to open database file: /data/…` —
   unauthenticated on a public host, at the one moment the endpoint has
   something worth disclosing. That is what #14's route had been protecting
   against: its comment records that the probes used to poll
   `GET /api/model/status`, which answers with row counts, so #14 authenticated
   that endpoint and added a health route that deliberately says nothing.
   `63e0886` makes the 503 body exactly `{ ok: false }` and sends the cause to
   the process log, and moves the handler to `server/platform/health.js` so the
   failure path can be tested at all — inline in `server/index.js` it could not
   be, because that file binds a port on import.
2. **A tripwire, and it is not where this document first put it.** The test
   asserting a single registration went to the **top of the scheduler stack**
   (`…-o3wt2p-reentry`, `0cf7cb3`), not into #14. The reasoning is better than
   mine was: a test written by the same change that deletes the second route can
   never fail, and would have been green from the moment it existed. On the
   scheduler stack it stands in the tree *before* the collision arrives, and
   because #14 takes that branch it is the test #14's own CI runs — red while
   #14 carried its route, green the moment it was deleted. It was verified to
   fire rather than assumed: with #14's line inserted where the real merge puts
   it, the assertion fails with the registration count named. Three assertions,
   because the collision has more than one shape — exactly one
   `app.get('/api/health'`, the survivor delegating to `healthHandler()` (one
   route that cannot return a non-200 is the TCP check again), and no
   `/health` endpoint defined under `server/routes/` either.
3. **Deleting #14's route**, which only #14 could do, and it has: `d7c9beb`
   merges the extracted handler and drops its own line. The re-proved merge now
   registers `/api/health` exactly once, at `server/index.js:86`, and
   `scripts/start-smoke.mjs` no longer conflicts. There is nothing left in this
   break to apply by hand.

**#17's version won**, and #14 stopped adding a health route of its own. What
was asked for on `claude/project-thread-n4052e`, all of it now done:

1. Delete the one-line `app.get('/api/health', (_req, res) => res.json({ ok: true }));`
   and its comment block from `server/index.js`.
2. Take #17's `scripts/start-smoke.mjs` probe verbatim.
3. Retarget PR #14's base from `…-3ldl77-docs` to `…-o3wt2p-reentry`, so #14 still
   has a health route to probe when its own CI runs. #14 is last in the train, so
   this costs nothing.
4. Add a test in #14 asserting the mounted app registers `/api/health` **exactly
   once**.

**There are now two single-registration tests, and that is fine.** The scheduler
thread's `test/health-endpoint.test.js` tripwire sits on `…-o3wt2p-reentry`, and
#14 wrote `test/health-route-single.test.js` of its own, which also asserts that
`fly.toml`'s check probes that path and that it is not behind authentication.
Both read the source rather than the route table, for the same correct reason:
`server/index.js` binds a port on import and cannot be loaded from a test, and a
request only ever reaches the first registration, so a duplicate is invisible
over HTTP and visible only in the file. A merge is a textual event, so a textual
assertion is the matched instrument. The redundancy costs one file. **Do not
delete either as a tidy-up** — the scheduler's fires on any branch that stacks
on it, #14's travels with the sign-in work, and between them the duplicate
cannot come back through either door.

### Break 2 — seven failing tests in `test/manager-signals-api.test.js`

Every request in that file returned **403 instead of 200**. #26 adds
`GET /api/trades/:leagueId/managers/signals`; #14 puts `assertLeagueMember` in
front of every `/api/trades/:leagueId` route. #26's fixture creates two users and
two sessions but no `league_memberships` rows, because when it was written
nothing required them.

**Fixed in source, 20:12Z — `f12bedd` on `claude/project-thread-3xqh5l-signals-api`.**
The Trade Brain thread reproduced the seven failures on its own merged worktree
before touching anything, and checked which side was wrong rather than assuming
the fixture was: the measured manager layer is per-league private data partly
derived from a private message corpus, so a session alone must not be enough to
read one league's copy of it. The route is right to be guarded. The re-proof
below merges that commit and the seven failures do not appear, so this break is
closed and nothing here needs applying by hand any more.

What it did, kept for the record, and safe on #26's own base because
`league_memberships` has existed since migration 006 — after the last
`insertLeague` call:

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

### Not a break: the migration numbering, which has since half-fixed itself

The base stack ends at `060`. Three branches each added an `061_*.js`; #21 and
#14 have both since renumbered to `062`, so the merged tree now carries one
`061_sync_log_consecutive_failures.js` (#19) and two 062s,
`062_google_identity_and_invites.js` (#14) and `062_league_payload_season.js`
(#21).

Still survivable, and for the same reason it always was: `server/db/migrate.js`
keys `schema_migrations` on the **full filename**, not the number, and applies
files in `.sort()` order, so every one is applied exactly once and none blocks
another. They touch unrelated tables, so the order between them does not matter.
None of these files has run anywhere, so every renumber has been a rename rather
than a schema change.

Swept on the merged tree rather than pairwise, because a pairwise check is how
this happened: **63 migration files, 11 of them added by the train, exactly one
duplicated number (062) and zero duplicated keys.** The key is what decides it.
`migrate.js` uses `mod.name ?? filename`, and all 63 files declare a distinct
`name` export, so every migration gets its own `schema_migrations` row and runs
exactly once. Two files sharing a *number* is cosmetic; two sharing a *name*
would be silent data loss, because the second would be recorded as already
applied and skipped with no error anywhere. That is the check worth keeping, and
it is not the one anyone was running.

The one sharp edge moved rather than closing: `npm run db:rollback` with no
argument rolls back the *last-sorted* file, which is now
`062_league_payload_season`, not whichever was conceptually last. Pass the name
explicitly if it ever comes to that.

**RENAME NOTHING DURING THE MERGE, and it is the one hard rule in this
section.** `server/db/migrate.js` computes `pendingCount` from the **filename**
(`:37-40`, `f.replace(/\.js$/, '')`) but applies each migration under the
module's **`name` export** (`:47-51`, `mod.name ?? file…`). All 63 files agree
today, which is why this has never fired. If someone renames a file during the
merge and changes the filename without the `name` export — in the direction
where the basename is already in `schema_migrations` and `mod.name` is not —
then `pendingCount` is zero, so `backupBeforeMigration` is **skipped**, while
`migrate()` still runs `up()`. That is a schema change against the live volume
with no snapshot taken, and nothing in the output says so. If a rename is ever
genuinely needed, change the filename and the `name` export together in one
commit.

**Decided: ship as is, do not renumber.** Renumbering branches minutes before a
proved train merges adds risk and fixes nothing, because the next pick collides
just as blindly. A timestamp prefix and a CI duplicate check go in as a follow-up
pull request after the stack lands. Treat the collision as a known and verified
condition, not an open question to improvise on mid-merge.

**The structural cause, which renumbering does not fix.** `origin/main` is at
`052`. The train numbers into `053`-`062` from eight parallel branches, and each
author picks the next free number from merged history plus their own branch,
because nothing shows them the others. That is what produced three `061`s; two
of them renumbered to `062` and landed on each other. Renumbering is a re-roll,
not a fix. Closing it properly needs a rule — number from position in the merge
sequence, or drop the numeric prefix and let the `name` export be the only key,
which it already effectively is. Not in this train; worth deciding before the
next one, because a repository that merges hand-numbered migrations from eight
branches will produce this again, and the day it bites is the day two duplicates
touch the same table.

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
| 34 | Green, wrong base — **and it now carries something the deploy needs** | Still sitting on PR #6's branch: `claude/project-thread-f921do` at `0bd4041`, and `git merge-base --is-ancestor` still places #6's tip inside it as of 20:19Z. See section 2 for why that excludes it, and step 10 for why one commit on it now matters more than it did an hour ago. |

Everything else that was on this list has resolved itself, and both resolutions
are worth recording because each was a claim that would have been wrong to carry
forward:

- **#8 is green.** Its thread found a genuine change to push — three claims in
  its own `CLAUDE.md` that were wrong or about to be — and pushed it as
  `d9cb4fd`, so #8 has its own check rather than merging on this train's proof.
  The run took **4m50s**, 20:15:16Z to 20:20:06Z, against the 20m16s and 20m14s
  timeouts it hit on `main`. That measures the diagnosis in section 4's earlier
  draft rather than only reasoning about it: the old base was the problem, the
  retarget onto #7 fixed it, and nobody had to manufacture a commit to get a
  green check. The one constraint stands — it sits on #7's branch, so #7 merges
  first or #8's base moves with it.
- **#33's single failure did not reproduce.** It was not re-run into a verdict
  so much as overtaken: the scheduler thread pushed its `/api/health` security
  fix up the whole eight-branch stack at 20:15-20:17Z, and the re-proof below
  merges those new tips. The failure does not appear there. Its signature was
  the known repo-wide one — a test file whose every test passes but whose `after`
  hook throws `ENOTEMPTY` on `fs.rmSync`, because a worker thread re-runs
  `server/db/index.js` and re-creates the database directory mid-removal — which
  predates this whole stack.

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

**It has been run, at 20:58Z, and here is what it said.** Kept because every step
below rests on one of these lines, and because one of them overturned something
this document believed all evening.

```
/app/.git: absent                    package.json version: 1.0.0
promote-volume-shrinkage.mjs: present     promote-weekly-ensemble.mjs: present
fit-availability.mjs: present             fit-posture-calibration.mjs: present
refresh-live-data.mjs: present            verify-trade-brain-live.mjs: MISSING
nfl_qbr_weekly:           2025=540/18wk  2026=34/2wk
nfl_ffopportunity_weekly: 2021-2025 ≈5,650/22wk each, 2026=331/2wk
player_week_usage:        2021-2025 7,659→8,857/18wk each, NO 2026 LINE
nfl_availability_rates:      ERROR no such table
nfl_availability_role_rates: ERROR no such table
shrinkage_k: 0     manager_profiles: 0     shrinkage_fits: 0 rows, 0 active
```

**`fit-availability.mjs` is on the machine.** This document, and everyone working
on it, had assumed the fit was a post-deploy step *because the script was not
deployed*. That was wrong; it is there, and so are both promotion scripts. **The
order does not change and the reason is now a better one:** the gate that decides
whether the role table ships lives in `server/services/contingency.js`, not in
the script (step 10), and the running build predates the whole train including
#37. Running the fit today would fit under gate v1, write the pooled table alone,
and do it with none of the merged code present — a live write whose result nobody
could interpret. Deploy first, then fit. Now that someone *could* run it early,
that has to be said rather than assumed.

**`shrinkage_fits: 0 rows, 0 active` is the premise holding, not a missing
prerequisite.** `promote-volume-shrinkage.mjs` fits *and* activates in one run —
its header says "nothing it produced was ever persisted, so production has always
run the hand-picked values", and "on a pass, the production vector is fit on
seasons ≤ 2025 and activated". `shrinkage_k: 0` says the same from the other
side. Steps 7 and 8 are unchanged.

**Three more premises confirmed from inside the machine** rather than inferred:
`nfl_qbr_weekly` holds 2025-2026 and nothing earlier, which is exactly the
configuration in which the #15 gate passes; `nfl_ffopportunity_weekly` is full,
so #28 is a no-op on this data; and both availability tables answer *no such
table*, which is the missing-table state — so step 11's `DROP TABLE` is right and
there is genuinely nothing to back up. `player_week_usage` has no 2026 line at
all, which is the gap #20 and #31 close and what post-deploy check 3 compares
against.

**`verify-trade-brain-live.mjs: MISSING`** is expected — it arrives with #18 — and
means post-deploy check 7 cannot run until after the deploy.

**`/app/.git: absent` is expected** (the Dockerfile copies the tree without it)
and `version: 1.0.0` is uninformative. Neither falsifies the commit window in
step 1, which rests on the three route probes.

What each line decides:

- **`GRIDIRON_DB_PATH` and what is on `/data`** — which database file the scripts
  in steps 7-10 will actually open. Both resolve their target through that
  variable, and run against any copy other than the live volume they fit and
  activate a vector *for that copy* and leave the app untouched. That is a silent
  no-op, not an error, which makes it the most dangerous line here.
- **`/app/.git` and the package version** — the only direct evidence about the
  running build. The probe-based placement (step 1) now agrees with itself, so
  this is confirmation rather than the tie-breaker it was written as. Keep it:
  it costs nothing and it is the one line that could still falsify the window.
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

**The deployed build is an ordinary clean commit, in an eleven-commit window —
corrected, and the correction is worth reading.** For most of the evening this
document said the provenance was unknown, because two read-only probes placed
the build in positions on the branch stack that no single commit could occupy:
the live lineup response carries a top-level `availability_basis` but no
`availability_note`, and on the stack both arrive together in `cfa0e6f`.

**The contradiction was an artefact of running the archaeology against the
squashed stack.** On the original lineage,
`cursor/betting-model-audit-fixes-1c85`, those are two commits, not one:
`0a657f6` adds the top-level `availability_basis` and `unavailable` and adds no
`availability_note` at all; `78811b1`, twenty-four hours later, adds the note
and the per-warning basis. Verified here rather than taken: `git show 0a657f6`
adds zero `availability_note` lines, `78811b1` adds seven, `cfa0e6f` adds both,
and the three are in the order `0a657f6` → `20a10a5` → `78811b1` on that branch.

The window is **after `20a10a5`** — which mounts `/api/league-chat`, explaining
the live 401 on that route — and **before `78811b1`**, whose parent already
carries the retirement body that explains the live 410 on `/brain/plan`. All
three probes now agree on one window, and only eleven commits in it touch
`server/`.

**The general lesson, which cost this project several hours tonight: when
commit archaeology produces a contradiction, check which branch it ran against.
A squash makes two commits look like one, and then any build between them reads
as impossible.**

**The rollback below still redeploys a captured *image*, not a commit**, and that
does not change. "Somewhere in an eleven-commit window" is not a build, and
narrowing it further costs live probes against a machine that answers in
two-minute windows. What changes is the confidence: the running image is a clean
checkout of some commit in that window, not something possibly built from a
dirty tree.

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

**One read-only check first, and it can fail the deploy outright if it is
skipped.**

```
fly ssh console -a gridiron-hq -C "df -h /data"
```

**Needs about 2.5 GB in `Avail`.** If it has less, stop and extend the volume
before deploying. Do not look for a way to skip the snapshot.

Where that number comes from, read off the shipping tree rather than reasoned
about. `main` carries 52 migration files and the proved tree carries 63, so
**11 new migrations land in this deploy** (`053` through `062`, with two files
sharing the number `062`). `runMigrations` computes `pendingCount = 11`, which
is greater than zero, so it calls `backupBeforeMigration` — a `VACUUM INTO`
snapshot of the live database taken before anything changes. That function calls
`assertRoomForSnapshot` first, and `SNAPSHOT_HEADROOM_BYTES = 2 * 1024 ** 3`
(`server/db/index.js`), so it demands **the database's full size plus 2 GB**.
The database is 445 MB. All of it runs inside `await runMigrations()`, which is
**before `app.listen`**.

So on a volume under roughly 3 GB the new machine throws on start, never
listens, and the deploy fails. It fails in the safe direction — nothing is
written, the snapshot is declined rather than half-taken, Fly keeps the previous
release — but the error is about disk and says nothing about any of the 26 pull
requests, which is a bad thing to be reading for the first time at midnight.

```
fly deploy -a gridiron-hq
```

Migrations run automatically at boot, before `app.listen` — there is no separate
release command.

**Expect a slow first boot, and expect it to look like a hang.** In order:

1. The build: two `npm ci` runs (full, then `--omit=dev`) plus the Vite client
   build. No measured figure for this app — assume several minutes.
2. The new image tag prints when the build pushes. **Copy it.** It is the
   rollback target for the *next* deploy, the way
   `deployment-01M2VZ9JRYSXVHCRWJ83V360QH` is tonight's. Step 11 still points at
   tonight's, which is correct.
3. The snapshot, which is the slow part and the reassuring one:

       [db] backing up /data/data.sqlite to /data/data.sqlite.pre-migration-<stamp>.bak before new migrations…
       [db] backup complete in <n>ms

   A `VACUUM INTO` of 445 MB on a 2 GB machine, with health checks failing the
   whole time because nothing is listening yet. **This is the shape of a good
   deploy.** Then the 11 migrations, each in its own `BEGIN IMMEDIATE`.
4. `Gridiron HQ listening on http://localhost:5177`, then
   `Evidence layers warm in <n>ms` — or `Evidence warm-up skipped: …`, which is
   logged, never fatal, and not a failure signal.
5. Health green, plus the usual 60-180s cold start on top. A failing Fly health
   check does **not** restart the machine, so a red check is information rather
   than a loop. Conclude nothing under 300 seconds.

Do not run `fly deploy` a second time because the first looks slow, and do not
`fly apps restart` mid-migration.

**The snapshot will genuinely be taken, checked rather than assumed.** Team
memory carries a real hazard here: `migrate.js` computes `pendingCount` from the
*filename* but applies under `mod.name ?? basename`, so a file whose `name`
export diverges from its basename leaves `pendingCount` at 0, skips the
snapshot, and still runs `up()` against the live database with nothing in the
output saying the snapshot was skipped. All 11 new files were read: every one
exports a `name` equal to its basename. The hazard is latent tonight, not live.
That also makes the duplicated `062` harmless — duplicate *numbers* are
cosmetic, duplicate `name` exports are the silent-data-loss case, and there are
none.

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

   **Read those counts out of the database, not off any `/api/model/…` page, or
   restart first.** `server/routes/model.js` memoises three values under
   *constant* keys in the same fingerprint-free `Map` as the simulator:
   `memo('handcuffs')` at `:569`, `memo('cascades')` at `:575`, and
   `memo('avail')` at `:589`. A constant key means the first answer a process
   computes is served until that process ends. `'avail'` is the one that bites
   here — it memoises `availability()`, built from `player_week_usage`, which
   holds zero rows for 2026 today, and #20 and #31 are in this train precisely
   to start filling it. A machine that serves that route once before the backfill
   lands keeps serving the pre-backfill answer for the life of the process, and
   the natural reading of that is "the backfill did not work". `clearModelCache()`
   runs on a league sync, `/api/dev/refresh-all` and the big nfldata sync — a
   scheduled feed job is none of those. `memo(\`acc:${season}\`)` at `:479` has the
   same shape, keyed only on season. `leagues.js:217-222` is the precedent and its
   comment explains the hazard in the simulator's case; whoever fixes these three
   should follow it. **Not a change for tonight** — this is a reading instruction,
   not a pull request.
4. **`nfl_ffopportunity_weekly` has plausible week counts per season**, not merely
   rows. Compare against the before-reading from section 5. A season showing one
   or two weeks is half-ingested and will never be completed, because the guard
   asks whether a season is present rather than complete. Fixing that guard is a
   follow-up pull request, not part of this train.
5. **Migrations applied.** `schema_migrations` contains all three new rows:
   `061_sync_log_consecutive_failures`, `062_google_identity_and_invites` and
   `062_league_payload_season`. Three rows, not two — the two `062`s are
   different files with different `name` exports, and seeing only one of them
   means a key collided. Section 3 has the sweep.
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

**Build the negotiation profiles before uploading, not after.**
`negotiation_profiles` is built *into the chat database* by
`scripts/build-negotiation-profiles.mjs`, and the upload route replaces that
whole file atomically rather than inserting rows into it. So a corpus uploaded
before the profiles are built arrives without the negotiation layer, and the
acceptance band loses an input it would otherwise have. Everything degrades
honestly if it is missing — nothing fabricates a profile — so this is an
ordering note rather than a risk, but it is the kind of ordering that is
expensive to notice a week later.

### 7. Database write 1, dry run — the opportunity promotion gate

```
fly ssh console -a gridiron-hq
cd /app && node scripts/promote-volume-shrinkage.mjs --dry-run
```

**Read the gate's own `n` before you read its verdict.** The production vector
was validated against a rebuild of 5,801 / 5,864 / 6,037 usage rows and
577 / 589 / 610 distinct players for 2023 / 2024 / 2025 — the opportunity thread
downloaded the nflverse source files and counted, so that is the ceiling the
source itself allows, not an estimate. Live cannot exceed it.

The reason live's raw `player_week_usage` count looks larger is benign and now
settled: `syncWeeklyUsage` (`nflverse.js:228`, insert loop `:255-262`) writes
every REG row whose `gsis_id` matches a `players` row with **no position
filter**, while `history()` (`projections.js:285`) filters to `QB/RB/WR/TE` at
`:292` and `:300`. The surplus is defenders and linemen, and the grader drops
them. So the question is never "why are there extra rows" — it is whether the
*graded* population is the size the vector was fit for.

Read the printed `n` against the ceiling:

- **At or just below it** — proceed. This is the expected reading.
- **Materially below it** — stop and understand it first. That means live's
  `players` table is missing fantasy players, and a gate can pass cleanly on a
  thinner population than the one it was written for.
- **Above it** — stop. A premise is wrong, because the source files do not
  contain that many graded rows.

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
`weekly_ensemble_fits`.

**Run both in the same sitting, and treat the second as mandatory rather than a
follow-up.** The weekly ensemble weights were fitted against the old head's
scale. Running the first without the second leaves the app in a configuration
the gate never validated — not merely a smaller improvement, an unvalidated one.
If anything fails between them, roll back from that state (see step 11) rather
than sit in it overnight.

**Rollback for this write, cleaner than an `UPDATE`.** Both tables are empty
today, so the exact prior state is restored by
`DELETE FROM shrinkage_k; DELETE FROM shrinkage_fits;` — no value has to be
remembered or restored, and there is no "previous active row" to reinstate.

#### The split this write makes visible, and what Nick will see

**Measured end to end by the opportunity thread on a scratch `VACUUM INTO` copy,
nothing written anywhere real.** This is the most important reading note in the
whole sheet, because the surprise arrives the same night and looks exactly like
a bug.

The promoted vector reaches **exactly one code path**. `activeKVectorFor` returns
it only under `WEEKLY_ROLE_RECENCY`, and the only production caller passing that
is `player-week-engine.js`. Every other `buildProjections` caller — draft-assist,
season-sim, ros-projection, preseason-model, ceiling-lineup, week-postmortem,
`routes/model.js` — runs on default recency, gets `null`, and keeps the old
hand-picked constants.

What that measures out to: **0 of 1,130 season-long projections move; 1,155 of
1,174 weekly projections move.** At a week-2 cutoff with zero 2026 usage rows,
startable players move **+4.71 ppg on average** (151 of 156 upward, max +15.39),
with top-N churn of 5/24 QB, 6/48 RB, 3/60 WR, 2/24 TE. Against 2025 actuals the
level check is startable MAE **5.22 → 2.32** and bias **−5.18 → −0.90**: the old
constants under-project every startable player by about five points a week.

**So Start/Sit will show a player at ~29 while the draft board, the ROS list, the
season sim and the playoff odds keep showing ~13 for the same player, the same
night.** That split is not introduced by this write — the season-long path runs
the old constants today and carries on doing so — but this is when it becomes
visible. Anyone who sees it without this paragraph will reasonably report it as
a regression caused by the deploy.

The options, and they are Nick's to pick:

1. Promote as planned, accept the split, fix the season-long path next train.
2. The same, plus the season-long surfaces get labelled so the number is not
   read as authoritative.
3. Hold this write until the season-long path can take the fit. That is new
   modelling work, not a configuration change.

**Recommended: 1 with 2.** The weekly numbers are measurably much better and
holding them back to preserve consistency would be preferring a uniformly wrong
app to a partly fixed one. But the labelling is not optional garnish — an
unexplained 29-versus-13 is exactly the kind of thing that costs trust in every
other number on the page.

### 9. Database write 2, dry run — the availability fit

```
node scripts/fit-availability.mjs --dry-run --report=/tmp/fit.json
```

**This step cannot be skipped, and it is the one that will look skippable.** It
will be late, the deploy will have gone well, and the script will have been run
successfully somewhere else already. Run it anyway, for a reason that is not
caution: after step 10 there is no dry run, and the dry run is the *only* place
anyone sees the size of this change before it is live. Skipping it turns
approving a number into approving a direction. Every previous run was against a
local rebuild of the history, not against this database, so none of them tells
you what this one will do.

Writes nothing, produces every gate number and the full ship/no-ship decision,
and puts the verdict on file rather than only in a terminal. This exists so step
10 is reading a result rather than making a judgement call.

**Read one thing before reading any of the numbers: the fitted rate is not a
chance of playing.** Its event is *recorded usage* — a target, a carry, an
attempt. `fit-availability.mjs` says so in its own header at `:16-21`:
"Deliberately not 'dressed'. A player who suits up and touches the ball zero
times scores zero, and the number this model feeds is a fantasy projection, so
the fantasy-relevant event is the right one." The header then warns, in its own
words, that this "makes the absolute levels lower than published 'percent who
played' figures".

That matters most where the movement is largest. The constants hold a Doubtful
player at 0.15 against a measured **0.004**, and an Out player at 0.01 against
**0.001**. Those are not claims that a Doubtful player dresses 0.4% of the time.
Without this paragraph beside them, the biggest single movement the fit produces
reads like the model having gone mad. It also means the two arms are not quite
the same quantity — the constants were hand-set as chances of playing, the
fitted rates are usage rates — so the gate's comparison is valid as a
forecasting question, but a reviewer eyeballing "0.15 became 0.004" is not
looking at the same thing twice. The app's own label said "likely to play" and
was wrong in exactly this way; #27 and #21 have fixed it to "likely to suit up
and see the ball", which is true on every basis and so does not go stale when
the tables are written.

Expect the main gate to pass decisively — log loss 0.558 → 0.397, bootstrap CI90
[-0.176, -0.147], calibration error 0.082 → 0.017 on 8,663 held-out rows. What
to expect on the role table depends on which gate is in the deployed build, and
that is step 10's first paragraph.

**This is the most carefully staged step in the plan, and it is bigger than its
runbook implies.** Only `contingency.js` reads the two tables, and the honest
statement is: **running this script changes every trade and lineup surface, with
no code deploy and no pull request.** `season-sim.js:226` reads it once per
simulated week, which is what prices playoff and title odds;
`trade-engine.js:304` multiplies this week's ppg by `active_probability`
outright and seeds the player-week distribution with it; the trade horizon
inherits it again through `simulateSeason` at `trade-engine.js:1317`;
`role-scenario-engine.js:123`, `news-fantasy-impact.js:85` and
`server/routes/model.js:448` and `:585` read it directly.

**Corrected, and worth recording because it was the strongest claim in this
document.** An earlier draft said this reaches `player-week-engine.js:190`, the
shared projection engine. It does not, on a served request. That read is inside
`applyRedistribution`, called at `:381` behind `if (redistributeVolume)`; the
parameter defaults to `false` at `:262`, and a grep of the merged tree returns
six hits in total — three inside `player-week-engine.js` itself and two in
`scripts/eval-redistribution.mjs`, which passes both values to compare them.
Nothing under `server/` passes it. The module's own header says it is "shipped
off because the evidence says off". So six modules import `weeklyAvailability`;
five of those reads execute on a served request and one never does. The Trade
Brain thread caught this and it was checked in the tree before this paragraph
was rewritten. It is the same shape as the defect class this whole deploy is
about: a line of code that looks like it runs and does not.

If that flag is ever turned on, note that redistribution conserves the team
total — pricing a starter as more likely to play means his backup absorbs less
and projects lower, so the effect is not uniformly upward and a handcuff falling
in value on fit day would be correct rather than a regression. Moot today.

### 10. Database write 2 — the availability fit

```
node scripts/fit-availability.mjs
```

Creates and fills `nfl_availability_rates` (~139 rows). Whether it also fills
`nfl_availability_role_rates` (~871 rows) depends on one thing, and it is a
property of the **build on the machine**, not of the command:

**The gate is code, and it is imported, not carried.** `fit-availability.mjs`
imports `roleGateDecision` and `designationRoleGate` from
`server/services/contingency.js` (`:44-45`, and `const gate =
roleGateDecision(gateRows)` at `:339`). So whichever version of that module the
deployed image contains is the gate that runs, and the script itself is
identical in both cases.

- **Gate v1 — what every branch in this train currently carries.** One 60-row
  `none/unknown` cell fails a per-cell check and the script refuses to ship the
  role layer. Sixty rows veto a table fitted on 8,663. `availability_basis.basis`
  lands on `pooled`. **This is a correct, expected outcome under v1, not an
  error**, and it is what to expect unless the pull request below has landed.
- **Gate v2 — PR #37, which Nick authorised tonight.** It changes exactly one
  condition: a gated cell vetoes on log loss only when its own data can
  distinguish a real degradation from noise, using the bootstrap the main gate
  already uses. `minCell` is not raised, the 0.02 slack is not widened, no cell
  is exempted, calibration is byte-identical, and `logLossBootstrap: false`
  reproduces v1 cell for cell — which is how the diff is proved confined. The
  rule was written out in full in `docs/tdd/play-chance-gate-v2.md` and committed
  **before** the fit was re-run under it, which is the only order in which a
  restructured gate means anything. Under v2 the role table ships and
  `basis` lands on `role`.

**Gate v2 arrived as PR #37 and is in the train.** For most of the evening it
existed only as `0bd4041` on `claude/project-thread-f921do`, which is #34's
branch and sits on #6, so it could not be merged without dragging 375 commits of
the betting monolith with it. The fantasy plan thread cherry-picked that one
change onto a fresh branch off `…-3ldl77-docs` — three files, nothing of #6 —
and the train has been re-proved with it in, immediately before #15. **So expect
the role table to ship: 870 role rates alongside the 139 pooled ones**, and
`basis` to land on `role`.

If #37 does not land for any reason, this step ships the main table only and the
role layer becomes the next deploy; that is a legitimate outcome and the `pooled`
stamp is then correct rather than a failure. Either way, read the dry run in step
9 for which gate answered — every cell reports `log_loss_basis`, its interval and
its point verdict, so the report says which rule decided rather than leaving it
to be assumed.

How narrow the change turned out to be, measured rather than argued: of 21 gated
cells **exactly one verdict moved**, `none/unknown` from fail to pass, and no
cell that passed under v1 fails under v2. That cell's measured log-loss penalty
was +0.0240 with a 90% interval of [-0.1093, +0.1568] — eleven times wider than
the effect it was vetoing on, containing both zero and a substantial
improvement.

Then:

1. **Confirm it landed.** `availability_basis.stamp` goes `absent|absent` →
   `139:<ts>|…`. No restart needed for this one: `contingency.js:543` re-reads
   when the row count or `fitted_at` changes.

   **Two reads that work, and one that looks like it should and does not.**
   Use `GET /api/model/availability?week=2` and
   `GET /api/model/player/<id>?week=2`. Both go through
   `weeklyAvailability(season, week)` — `model.js:585` and `:448` — which is
   called directly with no memo wrapper, and `fittedAvailability()` invalidates
   itself on the stamp (`contingency.js:559-561`). So both are fresh
   immediately, with no restart. On the player route the surrounding projection
   *is* memoised, but the `weeklyAvail` field beside it is not, so that number
   is live even when the rest of the payload is cached.

   **Do not use `GET /api/model/availability` without a week parameter.** It
   takes a different branch entirely (`model.js:589`) and serves
   `memo('avail', () => availability())` — and `availability()`
   (`contingency.js:40-44`) reads `player_week_usage` and `player_metrics` to
   build the career **durability prior**. It never touches either fitted table.
   So that endpoint returns the same numbers after the write **even on a fresh
   restart**: it is not a stale read, it is the wrong quantity. Two threads
   found this from different directions — one that it caches under a constant
   key, one that it reads the prior — and both are right; the second is the
   reason a restart would not have rescued it. Using it as a verification read
   would have said the fit failed when it succeeded, which is how a good deploy
   gets rolled back. `basis` lands on `pooled` under
   gate v1 and `role` under v2 — both are legitimate; which one you get was
   decided by the build, and the step-9 report already said which.
2. **Spot-check three players, not one, and expect them to move by different
   amounts.** A single headline figure is the wrong instrument here: the
   corrections are per designation and, under v2, per role as well, so a
   differentiated change read through one number looks like noise. Take a
   healthy starter with no injury report, a starter carrying a designation, and
   a rotation player.

   **Do not write down a single expected per-player number, including the ones
   below.** Two threads measured this against the live app tonight and got
   different answers that are both correct, which is the whole point. A healthy
   RB with no injury of any kind reads `active_probability` **0.805** (Jahmyr
   Gibbs, five leagues). The three players Start/Sit actually surfaces as
   chance-to-play warnings carry the low end of the spread. The complete
   baseline, captured across all five leagues and committed at
   `docs/evidence/2026-09-19/availability-baseline.json` on #18, found
   **thirteen warnings spanning 57% to 75%**: Jayden Daniels 57% with no injury
   designation of any kind, Harold Fannin Jr. 64%, Bucky Irving 65%, Tyler
   Warren 67%, Kyren Williams 70%, De'Von Achane 74%. Both readings are true
   because they are different populations: the warning list is *selected* for the low end,
   since Start/Sit only raises a warning below a threshold. The 69.5% in the
   constants table is a cohort mean and is not what any individual player is
   served.

   So: expect the **cohort** to move about twenty-five points (69.5% → 94.5%),
   expect individual players to vary, and expect **the players shown as warnings
   to move the most** — which is also the change Nick is most likely to see,
   because those are the lines on the screen. The shipped constants they are replacing
   are wrong by different margins — `noreport/starter/g0` 69.5% against an
   actual 94.5%, `noreport/rotation/g0` 63.6% against 83.4%,
   `none/starter/g0` 83.5% against 96.6% — so **two players moving by different
   amounts is the fix working, not something going wrong.** Say that to whoever
   reads the after-numbers, because the natural reading of an uneven move is
   that something broke.

   **Take the before-and-after through the capture script rather than by hand.**
   `node scripts/capture-availability-baseline.mjs --out=~/avail-before.json
   --find` before the write, `--compare=~/avail-before.json --find` after it. It
   arrives on #18. It re-reads the same players by id, so the after-run is a diff
   rather than an argument, and it goes through the trade path, whose cache is
   fingerprinted on both tables' `fitted_at` (`trade-engine.js:224-225`) — so it
   cannot return a stale answer and needs no restart. It prints its own "how to
   read the above" block saying in the output what this step says here, including
   that a deal can gain or lose its `acceptance` band from the fit alone, because
   `acceptanceBand` gates first on `edge.passes` (`trade-acceptance.js:142`) and
   the edge test is ppg-derived. That is the fit and not the Trade Brain:
   `manager-signals.js`, `counterparty-pricing.js` and `trade-acceptance.js` hold
   no reference to availability at any remove.

   **The role layer will be running on last season's roles, and the gate cannot
   see it.** Verified on the shipping tree: `roleStates(season, week)`
   (`contingency.js:324`) reads
   `(season = 2025 OR (season = 2026 AND week < 2))`. With `player_week_usage`
   empty for 2026 — which it is, and which #20/#31 are what fill it — that window
   is **2025 alone**. So:

   - A player healthy at the end of 2025 reads `g0` even if he has missed both
     2026 games.
   - A player whose last 2025 appearance was week 14 or earlier gets `gap >= 4`,
     no role cell, and non-role pricing — while `availability_basis` still
     reports `role`.
   - Rookies are not in the map at all.

   The gate is scored on 2025 with *that* season's in-season roles, so **a clean
   gate pass is entirely consistent with a weaker role layer in production**.
   This is not a reason to hold the write; it is a reason not to read a passing
   gate as a statement about live.

   Two concrete consequences for the sheet, and the second one is a sequencing
   constraint rather than a note:

   1. **Record the 2026 `player_week_usage` row count beside every reading.**
      Without it, a reading cannot be placed on either side of the backfill.
   2. **Take all three readings on the same side of that backfill** — either all
      three before any 2026 usage lands, or land the usage first and take the
      before-reads after it. One either side and the backfill and the fit produce
      the same direction of change with nothing to separate them. `_roleCache` is
      keyed on the row counts of exactly this window (`contingency.js:327-331`),
      so it self-invalidates the moment usage lands and gives no warning that the
      ground moved.

   The fit itself is unaffected: `FIT_SEASONS = [2021, 2022, 2023, 2024]`
   (`scripts/fit-availability.mjs:48`) and `TEST_SEASON = 2025` (`:49`), so an
   empty 2026 table can neither block the fit nor move the gate.

   Baseline captured live tonight, every league reading basis `constants` and
   stamp `absent|absent`: playoff odds 0.62 (league 1), 0.63 (league 2), 0.26
   (league 3), 0.24 (league 4), 0.90 (league 5), all on Gibbs at 0.805.

   **The simulator scores no kickers and no defences, and that matters more for
   the point totals than for the odds.** `SCORED` holds only QB/RB/WR/TE
   (`season-sim.js:32`, `:96`, `:106`, `:202`), while all five leagues start a K
   and a D/ST. So every simulated weekly total is short two starters. Two
   consequences, and they are not the same size:

   - **Any projected points TOTAL the simulator reports is unambiguously wrong**,
     low by whatever K and D/ST would have contributed — typically two slots a
     side. Distrust those outright; do not quote them anywhere.
   - **The odds are approximate rather than wrong.** The omission is symmetric
     across both sides of a matchup and K/DEF are low-variance, so the margin
     distribution shifts little. The direction is unquantified and there is no
     number for it here, so treat 0.62 / 0.63 / 0.26 / 0.24 / 0.90 as a
     comparison baseline rather than as the leagues' real playoff probabilities.

   Neither weakens tonight's delta: the same simulator runs before and after, so
   whatever it omits, it omits identically on both readings.

   **Read the three instruments in this order, because they are not equally
   sensitive.** The simulate reading first, `current_week_ppg` second, the trade
   value last.

   - `season-sim.js:226` applies `weeklyAvailability` per simulated week to every
     player across every remaining week, with nothing damping it, so the effect
     compounds. **Strongest instrument.**
   - `current_week_ppg` (on the trade response at `trade-engine.js:449`) is the
     one place the effect appears undamped: `:359` multiplies the current-week
     projection by `active_probability` outright, so a player going 0.70 → 0.95
     moves that number by the full ratio, about **+36%**. Capture it explicitly.
   - **The per-week decision number is the weak instrument and will look
     disappointing.** `trade-engine.js:385` is `decisionPpg = 0.25 *
     currentWeekPpg + 0.75 * rosPpg`, and `rosPpg` carries no availability term
     at all — the comment at `:360` says so. **Only the first term carries it**,
     so `adj_ppg` is attenuated roughly fivefold: at `currentWeekPpg ≈ rosPpg`, a
     player going 0.70 → 0.95 moves it about **+7%** where his percentage moved
     twenty-five points. Expect single digits and write that down before the run,
     because a reviewer who sees 25 against 7 will reach for a bug.

     **Say "the per-week numbers move less than the odds do", not "trade values
     move less."** The attenuation above is measured; the *trade value's* own
     sensitivity is not, and stays unmeasured until the second capture. A point
     estimate here would be checkable and wrong against any individual player,
     because the ratio depends on how his current-week rate compares to his
     rest-of-season one — at `c/r` of 0.5, 1.0, 1.5 and 2.0 the same 0.70 → 0.95
     gives +3.7%, +6.8%, +9.3% and +11.4%. If anyone wants a per-player
     expectation on the night, both inputs are already on the trade response
     (`trade-engine.js:449` and `:456`).

   **One thing will be unobservable tonight, and it is the biggest effect the
   script has.** The designated band — Doubtful, Out — is where the fit moves
   furthest and the only band that moves *downward*. **No player on any of the
   five rosters currently carries an `nfl_injuries` row**, because an ESPN roster
   flag is not an injury-report row and takes the no-report path. So the largest
   single movement will have nothing to land on in this baseline. Expected, and
   named here so nobody spends the evening hunting for it.

   **An earlier draft of this section cited two numbers as an injured-player
   reading, 0.833 and 0.823. They are withdrawn, and the reason is worth keeping
   because it is the house failure mode in miniature.** The capture script
   stringified the roster payload's `injury` field and tested it for emptiness,
   but `injury` is a 0/1 flag (`trade-engine.js:440` on the shipping tree:
   `injured.has(p.id) || !!(report_status && !/probable/i) ? 1 : 0`), and
   `String(0)` is `"0"`, which is truthy. So *every* player matched and the
   "injured" target was simply the next most valuable healthy one — which is why
   those readings came back priced **above** the healthy target rather than
   below, the one result an injured-player reading cannot produce. The Trade
   Brain thread caught it and re-captured; the corrected script now reports "no
   player on another roster carries an injury designation" instead of silently
   substituting a healthy player.

   The conclusion is unchanged and is now better supported, but **do not carry
   0.833 or 0.823 into any comparison tonight.** A check that returns a
   plausible-looking number for the wrong population is worse than one that
   returns nothing.

   **Use `value` as a control variable — this is the check that tells you
   whether the measurement itself is sound.** A trade's `value` is
   `m?.value ?? 0` off the `dynasty_values` table (`trade-engine.js:419`, loaded
   at `:307-309`) — the FantasyCalc market price. The fit writes only the two
   availability tables, and that path never reads them. So `value`,
   `give_value`, `get_value` and `ratio` **must be byte-identical before and
   after**. If they move, attribution is broken — something else changed under
   the reading — and nothing else in it should be trusted. What *should* move:
   `current_week_ppg` undamped, `adj_ppg` through the quarter weight, floor and
   ceiling, `horizon_value`, `playoff_odds`, `acceptance` via `edge.passes`, and
   efficiency (its numerator moves, its denominator cannot).

   **Ignore single-league odds moves under about 0.02 until the drift floor is
   known.** League 2 read 0.64 against a 0.63 baseline at the same seed with no
   deploy in between. The sim is seeded but its *inputs* are not frozen:
   `weeklyAvailability` reads `nfl_injuries`, which the live tier can refresh
   underneath a sweep that takes twenty minutes across five leagues. Take the
   floor from the spread across all five rather than from one repeat, and take
   the three readings promptly rather than at leisure.

   **Kickers and defences will not move, and the surface where you could see it
   is narrower than three drafts of this section claimed.**
   `weeklyAvailability` (`contingency.js:885` on the shipping tree) selects
   `WHERE p.position IN ('QB','RB','WR','TE')` at `:889`, so K and DEF are never
   in the map it returns and every consumer falls back to a typed-in `0.92`.

   Where that constant can actually be seen, narrowed by the UI thread and
   confirmed here on the merged tree:

   - **Not in any lineup decision.** `lineupSlots` (`trade-engine.js:539`)
     filters `roster_positions` to `SCORED` at `:542`, and `bestLineup` (`:611`)
     filters candidates to `SCORED` at `:615` and slots again at `:636`. A
     kicker is never placed, so the constant cannot move a Start/Sit call.
   - **Not in the playoff odds.** The simulator excludes K and DEF entirely
     (below).
   - **It survives in exactly two places:** the Start/Sit *bench list* display,
     where a kicker's `week_points` is built on `0.92` beside fitted numbers,
     and kicker/DEF **trade value** through `decisionPpg`.

   And the skill-only lineup and skill-only simulator are a **deliberate
   modelling scope with the reason written in the code** — `trade-engine.js:123`,
   "K and D/ST are near-random week to week", restated at `:2781-2782` — not a
   defect somebody forgot. Do not file it as one.

   **`season-sim.js:226` is not a K/DEF site, and an earlier draft of this
   section said it was.** The simulator never sees a kicker or a defence:
   `SCORED = new Set(['QB','RB','WR','TE'])` at `:32`, non-SCORED lineup slots
   skipped at `:106`, and the player pool filtered at `:96` and `:202`. Its
   `?? 0.92` is the *missing-row* fallback for a fantasy-position player the fit
   did not cover — worth knowing for a different reason, and not the same defect.
   There is also a second `?? 0.92` in `trade-engine.js` at **:2827**, in
   swap/gap logic nobody has traced; "the only reachable 0.92" is not a settled
   claim and should not travel as one.

   **And the constant reverses direction at the deploy, which is the part worth
   warning about.** Today a healthy RB reads 0.805 against a typed-in 0.92, so in
   Trade Lab kickers and defences are over-valued by about eleven points relative
   to everyone around them. After the fit a healthy starter reads ~0.952 and they
   are under-valued by about three. The constant does not merely fail to move —
   **it flips sign**. Not a blocker, and exactly the sentence that stops an hour
   of hunting for a bug that is not there. It touches neither the playoff odds
   nor any lineup ranking, for the reasons above.

   **The strongest post-write check is not a percentage — it is which players get
   flagged.** Two thresholds read `active_probability` directly, on the shipping
   tree: `< 0.75` in `lineup-brain.js:553` (Start/Sit's "check before kickoff"
   list) and `< 0.6` in `role-scenario-engine.js:141`. Healthy starters move up
   (0.805 → ~0.952) and go silent; the designated band moves down and furthest.
   So the **set** of flagged players should visibly change, shifting toward
   players who warrant the flag.

   Expect *more* warnings immediately after the write, not fewer, and read that
   as the fit working rather than as a regression. No count is predicted here —
   the dry run's distribution is the real number. **A write that leaves the
   flagged set identical deserves a second look**, because that is the one
   outcome the write cannot plausibly produce.

   **Everything reading unchanged is the result to distrust, not the reassuring
   one.** Three ways this verification could have produced a convincing null, all
   now closed: a cached simulate reading (step 2a), an attenuated trade reading
   taken as the headline (above), and an absent designated band (above).
3. **Restart first. This is a requirement of the reading, not a precaution.**
   `fly apps restart gridiron-hq` before you read anything. The fit is written
   from an ssh process, which cannot clear the app process's in-memory `Map`, so
   without the restart the simulate route returns its cached post-deploy answer —
   **byte-identical, not approximately similar** — and the only available reading
   of that is that the fit did nothing. It is the most convincing wrong answer in
   this whole plan, because it looks like a clean negative result. Step 2a has
   the mechanism. Then read
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

**Cleaner still, and the one to prefer:** both tables are empty before step 8,
so `DELETE FROM shrinkage_k; DELETE FROM shrinkage_fits;` restores the exact
prior state — nothing to remember, and no "previous active row" to reinstate.
The `UPDATE` form above is correct and keeps the fit rows for inspection; the
`DELETE` form is the true undo. Either works.

**The deploy. The reference is captured, so this is one paste and not a search:**

```
fly deploy --image registry.fly.io/gridiron-hq:deployment-01M2VZ9JRYSXVHCRWJ83V360QH -a gridiron-hq
```

The immutable form of the same image, if the tag is ever in doubt:

```
fly deploy --image registry.fly.io/gridiron-hq@sha256:caf1b40b59eeed6318c24363c607400dbf723dde50d40d8d3e9fd8bd097d0d36 -a gridiron-hq
```

Both were read off `fly image show -a gridiron-hq` before the deploy (machine
`84ed41eae1dd68`). The shapes check out — a 26-character Crockford ULID and a
64-character hex digest — but **copy the tag from your own terminal rather than
from this document if you still have that output**, because a transcribed
character is the one thing that would make the rollback fail at the moment you
need it.

Redeploying the captured image rather than rebuilding from a commit. The running
build is now known to be a clean checkout somewhere in an eleven-commit window
(step 1), but a window is not a build, so the image is what gets redeployed.
Migrations are additive and the eleven new ones drop nothing, so an older image
boots against the migrated volume without a schema rollback. If a migration does
need undoing, `npm run db:rollback` takes one at a time, newest first — and pass
the name explicitly, because bare it takes the last-sorted file, which is now
`062_league_payload_season`.

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
> it can.** Step 3 writes to the deployment branch; step 5 publishes it.
>
> Two gates, and they guard different steps. **Step 4 green gates the push in
> step 5** — never push a red tree. **The image reference from step 1 gates the
> deploy**, not the merge: landing the train on `main` deploys nothing, and if
> `fly image show` comes back with nothing usable, the right answer is a merged
> `main` and no deploy, because that reference is the only rollback that exists.
> Do not let a missing image reference stop the merge, and do not let a merged
> `main` imply the deploy is cleared.

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
         3xqh5l-brain-ui 3xqh5l f921do-gate-v2 w45mur n4052e; do
  git merge --no-edit "origin/claude/project-thread-$b" || { echo "STOPPED at $b"; break; }
done
```

Three notes on that loop.

It **stops at the first conflict** rather than carrying on, because a half-merged
deployment branch is worse than a stopped one.

It expects nothing to be fixed by hand, and as of the final proof that is true:
both section-3 breaks landed in their own source branches, so the loop runs
clean end to end with no conflict and no patch. If you somehow hit the
`start-smoke.mjs` conflict, that means a branch regressed — resolve in favour of
the `HEAD` side (#17's probe, the one that checks `probe.ok`) and say so.

`f921do-gate-v2` is **PR #37** and sits between `3xqh5l` and `w45mur`. It is the
one branch in the loop that is not named after a project thread, and it is the
one that decides whether deploy step 10 writes the role table. Leaving it out is
a silent downgrade, not a smaller merge.

```
# 4a. Prove you landed the tree that was tested. One second, and it is a
#     stronger guarantee than re-running anything.
git rev-parse HEAD^{tree}
#     Must print: 1b2341aa116031e40c9b10abf1ff9270e150a347

# 4. Verify before pushing. This is the same five checks CI runs.
npm ci && npm run check
```

**Step 4a is the important one.** That hash is the tree the suite ran green on.
The merge loop re-merges, so its commit SHAs will differ from the proof run's —
the *tree* will not, and the tree is what gets built and deployed. A match means
you are holding byte-for-byte what was tested and step 4 is a formality. A
mismatch does not mean anything is broken; it means a branch moved after the
proof and the proof no longer describes what you are holding, which is exactly
when step 4 stops being a formality.

**Do not push on a red result.** Section 8 carries the proved count and the 22
head SHAs it belongs to. Anything else means a branch moved after the proof —
which happened six times on the evening this was written — and needs looking at
rather than pushing through.

```
# 5. Push.
git push origin main
```

### Deploy

```
# 5a. HARD PRECONDITION, read-only. 11 new migrations means migrate.js takes a
#     VACUUM INTO snapshot at boot, and assertRoomForSnapshot demands the
#     database's size + 2 GB. The database is 445 MB, so this needs ~2.5 GB
#     in Avail. Under that, the machine throws before app.listen and the
#     deploy fails on disk, saying nothing about any of the 26 pull requests.
#     Fix is `fly volumes extend`, not skipping the snapshot.
fly ssh console -a gridiron-hq -C "df -h /data"

# 6. Deploy. Migrations run at boot, before app.listen. Expect a slow first
#    boot: the snapshot of a 445 MB file runs before anything listens, so
#    health checks fail throughout it. Watch for
#    "[db] backup complete in <n>ms" — that is the good path, not a stall.
#    Copy the new deployment- tag it prints; it is the NEXT deploy's rollback.
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

# 15. Gate, read-only, verdict on file. DO NOT SKIP THIS ONE. After step 16
#     there is no dry run, and this is the only place anyone sees the size of
#     the change before it is live. With PR #37 in the train, expect the role
#     table to SHIP -- 870 role rates beside the 139 pooled. See step 10.
node scripts/fit-availability.mjs --dry-run --report=/tmp/fit.json

# 16. Write 2, after READING step 15 -- not after running it.
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

The sequence was proved four times tonight — five started — because the branches
kept moving and a proof that describes a stack which no longer exists is worth
nothing. Each
run was a scratch branch built from `main` at `ffe4e72`, the merges done in the
order in section 1, then `npm ci`, `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build`, `npm run start:smoke` — the same five steps the CI
job runs.

**Run 1** — 25 merges. One conflict, in `scripts/start-smoke.mjs`. 2,921 tests,
2,873 passed, **7 failed**, all in `test/manager-signals-api.test.js`. With both
section-3 fixes applied by hand: 2,928 tests, 2,887 passed, 0 failed.

**Run 2** — 21 merges against the scheduler stack's eight new tips, #8 at
`d9cb4fd`, #26 at `f12bedd`, #15 at `9db53ff`, #18 at `11391cd`. Break 2 was
gone: #26 had fixed the fixture in source. Break 1 survived exactly as predicted,
so #14's route was still deleted by hand. **2,933 tests, 2,892 passed, 0 failed,
41 skipped.** Exit 0 on all five steps.

**Run 3** — 22 merges, PR #37 in and #14's own fix present, merged tip
`6f473ec`. **No conflicts and no hand-applied fixes of any kind**, and
**2,950 tests, 2,909 passed, 0 failed, 41 skipped**, all five steps exit 0.
Superseded within minutes: four branches moved while it ran.

**Run 4** — killed eight minutes from finishing, because #18 and #14 had already
moved under it. Recorded because the honest cost of the treadmill belongs in the
evidence: a proof is only worth the SHAs it names.

**Run 5, the one that counts.** 22 merges, every branch at the head listed below.
Merged tip `791b131`, **merged tree
`1b2341aa116031e40c9b10abf1ff9270e150a347`**.

- **2,950 tests, 2,909 passed, 0 failed, 41 skipped.**
- `npm ci`, typecheck, lint, client build and start-up smoke all exit 0.
- **Zero conflicts. Nothing fixed by hand.**

Heads proved in run 5: #12 `d9b4a90`, #8 `d9cb4fd`, #24 `7da5974`, #17
`63e0886`, #19 `5f955fe`, #20 `e0c0659`, #28 `5adb6fe`, #29 `15625f3`, #31
`b07f179`, #32 `56a85af`, #33 `0cf7cb3`, #21 `de5f570`, #27 `94c4b38`, #30
`ab907e4`, #25 `356f166`, #26 `f12bedd`, #23 `dff747f`, #22 `3bb6d07`, #18
`0dabe36`, #37 `c2f93c8`, #15 `9db53ff`, #14 `bef686d`.

**This number describes those exact commits and nothing else.** If a branch
moves it needs re-running — that is not pedantry, it is why runs 2 through 5
exist. **The tree hash is the cheap version of that check**, and it is why step
4a is in the run sheet: whoever runs the merge can prove in one second that they
landed what was tested, without re-running anything.

Each scratch branch is a test fixture and has been thrown away. Nothing was
pushed to any branch but this document's own.
