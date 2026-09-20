# Release train — 2026-09-19

Twenty-nine pull requests were opened against this repository on 2026-09-19 by
eight threads. None of it was deployed when this was written: `gridiron-hq.fly.dev` was running a build
that predates all of them. This file is the ordered sequence for landing them,
the evidence that the sequence works, and the deploy plan that follows it.

**The train is landed. `main` is `791b131f24824b8c3eb7dd2172165b5ab55c2b04`,
tree `1b2341aa116031e40c9b10abf1ff9270e150a347`** — pushed by Nick at 21:22Z
after verifying that tree hash on his own terminal, and verified again here
against `origin/main`. It is byte for byte the tree the suite ran green on:
2,950 tests, 2,909 passed, 0 failed, 41 skipped, plus a clean `npm ci`,
typecheck, lint, client build and start-up smoke test.

**Not deployed yet, and no database has been written.** Everything from section
6 onward is still ahead. The proved tree also remains published as
`claude/release-train-2yv3x6-proof` for anyone who needs to diff against it.

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

> **Note on PR numbers, added after the train landed.** #15's release content is
> in `main` at `9db53ff`. The branch was then retargeted to `main` and **reused**
> for follow-up work (completeness script and blast-radius probe, still draft),
> so **"#15" now means the follow-up, not the merge-order item**. Every "#15" in
> the order below refers to `9db53ff`, which shipped. The same applies to any PR
> a thread reuses rather than closes: the tree is the authority, and
> `git merge-base --is-ancestor <head> origin/main` is the check. GitHub shows
> the twenty landed pull requests as "closed without merging" because `main`
> moved by direct push; that is a UI artifact, not a statement about what
> shipped.

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

**That separation now has a measured size, and it is large.** The wiring map
thread reports that #40's `from_week` fix alone moves playoff odds by **9.5
points mean absolute across ten teams**, with nothing else changed. That is an
order of magnitude above anything tonight's availability fit will produce, and
far above the 0.01 drift floor the after-reads are scored against. Tonight's
readings are taken on `791b131`, which does not carry #40, so the two are
separated by accident of ordering rather than by design — **and the next train
must keep them separated on purpose. #40 needs its own before-and-after odds
reading, taken on its own deploy, with no database write between them.** If it
ships alongside anything else that touches the sim, a 9.5 point move will
absorb every smaller effect in the release and none of them will be
attributable afterwards.

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
before deploying. Do not look for a way to skip the snapshot — and in
particular, **if `df` shows a `.bak` beside the database, that file is not
debris and deleting it is not how you make room.** See below: it is the only
row-level rollback this deploy has. If one is there at all it means a previous
attempt already reached the migration step, which is itself worth knowing before
you do anything else.

Where that number comes from, read off the shipping tree rather than reasoned
about. The build that was deployed before tonight carries 52 migration files and
the tree being deployed carries 63, so **about 11 new migrations land in this
deploy** (`053` through `062`, with two files sharing the number `062`).
`runMigrations` computes `pendingCount` by counting migration files that have no
row in the live database's `schema_migrations`, so the exact number is a
property of the machine rather than of either tree — and the deployed binary was
branch work rather than `main`, so it could have applied something outside the
63. **That is why the count is written as "about 11": what the disk gate turns
on is only that it is greater than zero, which nothing about tonight puts in
doubt.** Being greater than zero, it calls `backupBeforeMigration` — a `VACUUM INTO`
snapshot of the live database taken before anything changes. That function calls
`assertRoomForSnapshot` first, and `SNAPSHOT_HEADROOM_BYTES = 2 * 1024 ** 3`
(`server/db/index.js`), so it demands **the database's full size plus 2 GB**.
The database is 445 MB. All of it runs inside `await runMigrations()`, which is
**before `app.listen`**.

So on a volume under roughly 3 GB the new machine throws on start, never
listens, and the deploy fails. **The database fails in the safe direction** —
nothing is written and the snapshot is declined rather than half-taken, because
`assertRoomForSnapshot` is called at `server/db/index.js:123` and the
`VACUUM INTO` is at `:129`, so the refusal is strictly before the copy begins.
The error is nonetheless about disk and says nothing about any of the 26 pull
requests, which is a bad thing to be reading for the first time at midnight.

**What is not safe in the same way is the serving app, and an earlier draft of
this section said it was.** It claimed Fly keeps the previous release. This app
runs a single machine, `84ed41eae1dd68`, which `fly deploy` updates in place —
so the previous release is not standing beside the new one waiting to take over.
Whether anything serves after a failed boot depends on whether the deploy rolled
the image back, which is not something to assume from here. Read
`fly status` and `fly releases` rather than trusting this paragraph. The
database claim above stands on its own and does not depend on this one.

### 3a. The health check's grace period is shorter than this boot

This is a second candidate for a failed deploy, independent of disk, and it
would have bitten even on a volume with room.

`fly.toml` sets `grace_period = "60s"` on the `/api/health` check
(`[[services.http_checks]]`, with `interval = "15s"`). The measured cold start
for this app **before** tonight is 60 to 180 seconds, and tonight's boot adds
eleven migrations and a `VACUUM INTO` of a 445 MB database ahead of
`app.listen`. So the check starts counting failures while a perfectly healthy
machine is still doing exactly what it is supposed to be doing.

The comment sitting above that value makes the argument against it: it says the
grace period exists because boot runs migrations and seed reconciliation before
`app.listen`, and that a restart loop caused by an impatient check would be
worse than the bug being fixed. The number chosen does not match the reasoning
written beside it.

**Why this produces the same symptom as a crash loop and is not one.** A failing
health check never restarts a machine — only a process exit does. It removes the
machine from routing, and Fly's edge then answers a 502 with an empty body,
which is indistinguishable over HTTP from having no instance at all. On a
multi-machine app that would be a transient window that heals when the app
finally listens. On a single machine updated in place there is nothing else to
route to, and if the deploy gave up on the unhealthy machine, nothing comes back
on its own.

**Consequence for the run sheet: this wants raising before the next deploy
attempt is made, whatever the log says the first one died of.** If it is the
cause, the deploy cannot succeed without it. If the disk gate is the cause,
extending the volume makes the boot *longer* — the snapshot then actually runs —
so a 60 second grace period is if anything more likely to fail on the retry than
it was on the first attempt. It is one line of configuration touching no product
code.

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

**The snapshot stays on the volume forever, and that is deliberate.** It lands
beside the database as `/data/data.sqlite.pre-migration-<stamp>.bak`, roughly
445 MB, and **nothing ever deletes it automatically** — the code says why, in
its own words: choosing which recovery point to give up is a judgement about
what history is worth keeping, and it belongs to someone who knows what is in
it.

Two consequences. First, **that file is tonight's real database rollback**, more
directly than any image reference: the image rolls back code, the `.bak` rolls
back rows. Do not tidy it away tonight or this week. Second, every future deploy
carrying migrations adds another one, so `/data` needs sweeping occasionally or
the headroom check above starts failing for a reason that has nothing to do with
the deploy being attempted.

The 20:58Z probe listed `/data` and found **no `.bak` files at all** — only
`data.sqlite`, its `-shm` and `-wal`, and `lost+found`. So tonight's will be the
first, and the volume is starting clean.

**And it is the only snapshot of the live rows that will ever exist on that
volume.** `scripts/nightly-backup.sh` looks like it covers this and does not: it
runs from a LaunchAgent on Nick's Mac at 04:30, its `SRC` is
`$REPO/server/data.sqlite` — his local clone — and its `DEST` is
`$HOME/Documents/gridiron-db-backups`. It never touches `/data` and never
touches the Fly machine. There is no backup job in `scheduler.js` either;
`grep -i backup` over the scheduler and the source registry returns nothing. So
the Fly volume has no scheduled snapshot of any kind, and the pre-migration
`.bak` is not one restore point among several — it is the only one.

Two consequences follow, and they run opposite ways, so keep them apart.
**Pruning old snapshots is the right advice in general and is not available
tonight**: it needs old snapshots, and the 20:58Z probe says there are none. On
this volume the only `.bak` that can exist is the one this deploy writes, so
"free up space by pruning" resolves to "delete the rollback". Tonight the fix
for a tight `df` is `fly volumes extend` and nothing else. From the *second*
migration deploy onward there will be a genuine choice, and then the rule is the
ordinary one: keep the newest, and keep any taken before a migration whose undo
needs rows rather than code.

The second is a latent hazard rather than tonight's problem. If anyone ever
points `nightly-backup.sh` at `/data`, its prune glob is
`"$DEST/$NAME."*.bak` with `NAME=data`, and a shell `*` matches across dots — so
`data.sqlite.pre-migration-<stamp>.bak` matches it. A script written to protect
the database would delete the migration rollbacks on a seven-file rotation. It
is safe today only because `DEST` is a directory on a laptop.

If `assertRoomForSnapshot` does refuse, it prints the three numbers that decide
it — snapshot size, space needed, space available, all in GB — so the error
answers its own question. Read it rather than guessing at the volume size.

### 4. Watch the first boot, not the settled machine

The first boot is when the concurrency bug #33 fixes used to fire hardest: an
eighteen-job boot pass still running when the live timer starts the same jobs
behind it, two synchronous SQLite transactions writing the same tables.

```
fly logs -a gridiron-hq
```

What good looks like: no `still running when its next pass was due` warnings
stacking up, and `/api/health` answering within the grace period.

### 4b. If it does not come back: reading a persistent 502

**Observed on the night, 21:26Z to at least 21:47Z.** `GET /api/health` returned
**502 with an empty body after 64 seconds**. Written down here because the
reasoning is reusable and the instinct it corrects is strong.

**An edge 502 with an empty body is not a slow boot.** It is Fly saying no
machine is serving. A machine that is up but still migrating refuses the
connection or hangs — it does not produce an edge 502. So the machine is either
not running or dying on start, and the 300-second cold-start rule has stopped
being the explanation.

One command answers it:

```
fly logs -a gridiron-hq
```

What to look for, most likely first:

1. **`Refusing to migrate: a pre-migration snapshot of 0.4 GB needs about
   2.4 GB free, and X GB is available of Y GB.`** `assertRoomForSnapshot` throws
   inside `await runMigrations()`, which is **before `app.listen`**, so the
   process exits, Fly restarts it, and it exits again. **A crash loop presents
   as a persistent edge 502**, which is exactly this symptom. Fix is
   `fly volumes extend`, then redeploy — never a way to skip the snapshot, and
   never by deleting a `.bak` to free the space the snapshot needs. If one is
   on the volume it is a rollback point from an attempt that got further than
   this one.
2. **A migration throwing.** Each runs in its own `BEGIN IMMEDIATE`, so the
   failure rolls back cleanly, but it still exits before `app.listen`. The log
   names it. The snapshot was already taken by then, so
   `/data/data.sqlite.pre-migration-<stamp>.bak` is the restore point.
3. **Still building.** If the build were the answer, the *previous* release
   should still be serving. A 502 argues against it.
4. **OOM.** The machine is 2 GB and has been OOM-killed at 1 GB historically.
   The log says `Out of memory` plainly.
5. **The port guard.** `server/index.js:9-14` wraps `assertPortAvailable(PORT)`
   in a try/catch that prints `error.message` and calls `process.exit(1)` —
   before migrations, before anything. One line in the log and the process is
   gone, which is a crash loop with almost nothing in it to read.
6. **The grace period, covered in 3a.** This one is not a crash and leaves a
   *different* signature: the log reaches
   `Gridiron HQ listening on http://0.0.0.0:5177` and then stops, with no error
   after it. A machine that got that far and is still 502 was removed from
   routing rather than killed.

**Read the log for the last marker it reached, in this order**, because each one
names a different failure and they are mutually exclusive:

| Last thing in the log | What died | Fix |
| --- | --- | --- |
| `Refusing to migrate: a pre-migration snapshot of …` | the disk gate | `fly volumes extend` |
| `[db] backing up … before …` and nothing after | the `VACUUM INTO` itself, mid-write | read `df` again; the partial file is not a rollback |
| `[db] backup complete in <n>ms`, then a stack trace | one of the migrations | name it before retrying anything |
| `Gridiron HQ listening on …`, then nothing | nothing — it booted | routing, not boot; see 3a |
| one line about a port, then nothing | `assertPortAvailable` | read the message; it names the port |

**Do not redeploy to try to clear it.** If it is a crash loop, a second deploy
loops the same way and buries the first error further up the log. Read the log
first. This is the one place where the bias to action is wrong: the failure is
already recorded and re-running it only makes it harder to read.

**What is safe while this is happening:** nothing has been written to the
database beyond the migrations, because every database-write step in this plan
comes after a green health check. If the snapshot was taken it is on the volume.
Nothing is lost by waiting to read the log.

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

**Read the `nfl_qbr_weekly` coverage line as a second gate, not as context.**
It must show **2025 and 2026 only**. The 20:58Z probe found 0 rows for
2021-2024, 540 for 2025 and 34 for 2026, and the vector's blast-radius numbers
were re-run against a rebuild matching exactly that coverage (+4.75 ppg
startable, MAE 5.22 → 2.32 — unchanged from the fuller rebuild, which is the
reassuring part).

**If 2021-2024 comes back populated, stop.** It means something filled that
table between the probe and the gate, and a 2021-2024 QBR backfill is known to
flip this gate from pass to fail. Nothing in tonight's train backfills it, so a
populated 2021-2024 is not an expected state and needs explaining before
anything is promoted — not after.

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

#### Restart after THIS write. Do not restart around the availability fit.

```
fly apps restart gridiron-hq
```

Two threads disagreed about this step and **both were half right**. The memo
keys on `791b131` settle it, and the answer is different for the two writes.

**Restart is required here, at step 8, and a seed will not save you.** The
promotion changes `buildProjections` output, and those results are memoised
under `proj:${through}:${scoring}` (`routes/model.js:404`, `:426`) and
`player-week:${SEASON}:${week}:${scoring}` (`:443`). **Neither key contains the
seed.** The promote scripts run as their own processes over `ssh` and cannot
invalidate an in-process `Map`, so without a restart the after-reading is the
before-reading, byte for byte, and the promotion reads as "changed nothing".

**Do NOT restart around the availability fit at step 10.** Nothing there needs
it, and a restart actively damages the reading:

- `fittedAvailability()` self-invalidates on row count and `fitted_at`
  (`contingency.js:543`), so it is fresh immediately.
- `trade-engine.js:224-225` puts both tables in its cache **fingerprint**
  stamped on `fitted_at`, so it self-heals.
- The simulate route's memo key **does** carry the seed
  (`${key}:seed:${seed}`, `:527`), so an unused seed bypasses it for free.
- `GET /api/model/availability?week=2` and `/api/model/player/<id>?week=2` call
  `weeklyAvailability()` directly with no memo wrapper.

And the harm: a restart re-runs `bootJobs`, which can refresh `nfl_injuries`,
which `weeklyAvailability` reads — so it moves the very numbers the fit is being
measured on. Restarting to defeat a cache that is already self-invalidating buys
nothing and costs attribution.

**If a restart happens anyway, re-baseline.** Take a fresh capture after the
restart and before the next write, so the before/after pair straddles the write
alone and not the restart.

**Never use `POST /api/leagues/:id/sync` or `/api/dev/refresh-all` as the cache
bust.** Both re-sync `dynasty_values`, which is the control variable this whole
measurement depends on being identical before and after (step 10). Busting the
cache with the one call that moves the control destroys the attribution you are
protecting.

Take the step 8 after-reading promptly once the app is back, for the same
`bootJobs` reason that argues against restarting at step 10.

#### The split this write makes visible, and what Nick will see

**Measured end to end by the opportunity thread on a scratch `VACUUM INTO` copy,
nothing written anywhere real.** This is the most important reading note in the
whole sheet, because the surprise arrives the same night and looks exactly like
a bug.

The promoted vector reaches **exactly one code path**. `activeKVectorFor`
(`shrinkage-fit.js:515-521`) returns it whole only under `WEEKLY_ROLE_RECENCY`,
and the only production caller passing that is `player-week-engine.js`. Every
other `buildProjections` caller — draft-assist, season-sim, ros-projection,
preseason-model, ceiling-lineup, week-postmortem, `routes/model.js` — runs on
default recency and has the volume entries withheld, which measures out to no
change at all. The file says why in its own words: evidence accumulated under a
different recency weighting would be a units error moved to the apply side, so
those callers keep the constants they were validated with, "not claimed to be
right, only untested with the fitted k".

**That guard is already in the deployed build — it is not something this deploy
introduces**, and #15 can be reordered without touching it.

**But the divergence still arrives tonight, and the distinction matters.** The
guard is live; what it gates is not. `activeKVectorFor` begins
`const v = cutoffSafeKVector(predictingSeason); if (!v || …) return v;` — with
no active row, `v` is `null` and *every* caller gets `null`, weekly and
season-long alike. Both paths run the hand-picked constants today, so there is
nothing to be split. Step 8 writes the active row, and that is the moment the
two paths start answering differently.

So "the split is live today" is true of the code and false of the numbers. Read
it the second way, because it is the numbers Nick will be looking at.

What that measures out to: **0 of 1,130 season-long projections move; 1,155 of
1,174 weekly projections move.** At a week-2 cutoff with zero 2026 usage rows,
startable players move **+4.71 to +4.75 ppg on average** (the two rebuilds agree) (151 of 156 upward, max +15.39),
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

   **READ THIS PLAYER FIRST IN THE DRY RUN: Puka Nacua.** The designated band —
   Questionable, Doubtful, Out — is where the fit moves furthest and the only
   band that moves *downward*. It is **occupied tonight**, it is being priced by
   the hardcoded constants right now, and it sits on a top-thirty asset on
   another manager's roster in **all five of Nick's leagues**.

   Captured against the live app, not inferred:

   - `injury_status`: `"Questionable (ESPN)"`
   - `practice_status`: `"Did Not Participate In Practice"`
   - `active_probability`: **0.324**, against 0.805 for the healthy target
   - basis `constants`, `missing: [nfl_availability_rates,
     nfl_availability_role_rates]`, stamp `absent|absent`

   The arithmetic identifies the exact code path, which is what makes this more
   than an observation. In the constants branch (`contingency.js:679-688` on the
   shipping tree): questionable gives
   `Math.min(0.75, Math.max(0.45, active * 0.70))`, which **floors at 0.45**;
   then "did not participate" gives `active *= 0.72`. `0.45 * 0.72 = 0.324`,
   matching the live reading to three decimals. When the fit lands,
   `fitted.lookup(...)` at `:667` replaces that number wholesale.

   **Where to look:** his `current_week_ppg` (4.18 against an `adj_ppg` of 10.3)
   is where the change shows undamped. Which way questionable-plus-DNP moves, and
   by how much, is **not predicted here** — the dry run prints it, and that is the
   number to read.

   **A previous draft of this section said the opposite, and the error is worth
   keeping visible because it is the exact shape this project keeps failing in.**
   It said no player on any roster carries an `nfl_injuries` row, therefore the
   designated band had nothing to land on tonight, therefore nobody should hunt
   for it. The premise may well be true. **The conclusion does not follow**, and
   the Trade Brain thread caught it: an `nfl_injuries` row is not the only way a
   player gets a designation. `weekDesignation` (`contingency.js:202-213`) reads
   the NFL report *and* an ESPN status, and **ESPN wins when it is more severe**
   — it synthesises a report from the ESPN label even when the NFL row is null.
   So a roster with zero `nfl_injuries` rows can be full of designated players.

   A sheet that says "nothing to land on" tells the reader not to look. If the
   fit's largest single effect then lands on a designated player and nobody
   checks, it reads as noise or goes unnoticed — a thing looking healthy because
   nobody looked at what it should have produced. That is the house failure mode
   arriving through the documentation rather than the code.

   Also withdrawn, from the same capture: **0.833 and 0.823 are not
   injured-player readings.** The script stringified the roster payload's
   `injury` field and tested it for emptiness, but `injury` is a 0/1 flag
   (`trade-engine.js:440`) and `String(0)` is `"0"`, which is truthy. Every
   player matched, so the "injured" target was the next most valuable healthy
   one. The tell was that those readings came back priced *above* the healthy
   target, which is the one result an injured-player reading cannot produce. Do
   not carry either number into any comparison tonight.


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

   **The drift floor is now measured, not guessed: 0.01.** The Trade Brain
   thread held the control variables identical across a fifteen-minute window
   and found movement of one rounding unit — `toFixed(2)` on the response, so
   0.01 is the smallest value the reading can express at all. Baseline capture
   at `62c0c8f` on #41.

   So the rule tightens: **a single-league odds move of 0.01 is indistinguishable
   from rounding and means nothing. 0.02 is the smallest move worth a second
   look, and only alongside the other four leagues.** League 2 read 0.64 against
   a 0.63 baseline at the same seed with no deploy in between, which is exactly
   this. The sim is seeded but its *inputs* are not frozen: `weeklyAvailability`
   reads `nfl_injuries`, which the live tier can refresh underneath a sweep that
   takes twenty minutes across five leagues. Take the floor from the spread
   across all five rather than from one repeat, and take the three readings
   promptly rather than at leisure.

   **The mid-window capture is confirmed necessary, not belt-and-braces.** The
   three readings are: before the deploy, **after the deploy and before any
   write**, and after the fit. Without the middle one, the deploy's 26 merged
   pull requests and the two database writes land in the same measurement window
   and nothing separates them. That is the whole attribution: if the numbers move
   and only the first and last readings exist, the honest answer is "something in
   tonight changed it", which is not worth taking a reading for.


   **Do not check kickers and defences at all. There is nothing there to check,
   and three drafts of this section said otherwise.** The short version: their
   hardcoded `0.92` is multiplied by zero, so it cannot move any number on any
   surface, before or after the fit.

   Verified on `791b131`, and this is the chain that settles it:

   - `sched` is gated on `SCORED.has(p.position)` (`trade-engine.js:334`), so a
     K or DEF takes the fallback at `:336-337`, which carries `games: []`.
   - `thisGame` is `sched.games?.find(...)` at `:348`, and `[].find()` is
     `undefined`, so `thisGame` is `null`.
   - `currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult *
     activeProbability : 0` at `:359`. For a K or DEF that branch is **always
     `0`**.

   So `activeProbability` is never applied to a kicker's points. `decisionPpg`
   at `:385` sees a zero current-week term, and `lineup-brain.js:279` uses
   `p.current_week_ppg ?? …` where `0` is not nullish, so it takes the zero too.
   The constant is real, reachable and **inert**.

   Earlier drafts of this sheet claimed kickers were over-valued by about eleven
   points today and would flip to under-valued by three after the fit. **That was
   wrong in both directions**, and it was derived by reasoning about where the
   constant is read rather than by following what is done with it. "K and DEF
   stay at 0.92" is true and meaningless. Removed as an after-read; do not
   reinstate it.

   What survives, and is what the after-reads actually rest on: the skill-position
   figures, ~0.805 under constants today against ~0.952 fitted.

   **The simulator is a separate matter and also excludes them.** `SCORED` holds
   only QB/RB/WR/TE (`season-sim.js:32`, `:96`, `:106`, `:202`), so no kicker or
   defence is simulated. Its `?? 0.92` at `:226` is the *missing-row* fallback for
   a fantasy-position player the fit did not cover, which is worth knowing for a
   different reason. There is also a second `?? 0.92` in `trade-engine.js` at
   `:2827`, in swap/gap logic nobody has traced.

   Both the skill-only lineup and the skill-only simulator are a **deliberate
   modelling scope with the reason in the code** — `trade-engine.js:123`, "K and
   D/ST are near-random week to week", restated at `:2781-2782`. Not a defect
   anyone forgot, and not something to file.

   **A corollary worth knowing, because it turns a non-check into a real one:**
   since `currentWeekPpg` is 0 for a kicker, `week_points` is 0 too, so **a
   kicker cannot appear on the Start/Sit bench list at all** (it requires
   `week_points > 0`). If one shows up there, that is a finding. And K/DEF trade
   values not moving after the fit is not evidence of failure — it is the only
   thing that can happen.

   **THE COUNTABLE CHECK. Three things must happen together, and an earlier
   draft of this sheet predicted the opposite of one of them.**

   Nick's own rosters carry **thirteen Start/Sit warnings** right now, all on
   basis `constants`, captured live: **3 / 2 / 4 / 3 / 1** across leagues 1 to 5.
   League 1 De'Von Achane 74%, Kyren Williams 70%, Javonte Williams 75%; league 2
   Harold Fannin Jr. 64%, Chase Brown 75%; league 3 Jayden Daniels 57%, Achane
   74%, Brown 75%, Bucky Irving 65%; league 4 Daniels 57%, Jonathan Taylor 74%,
   Tyler Warren 67%; league 5 Taylor 74%. QB, RB, TE and FLEX starters — the
   surface he actually opens.

   **Most of those are not injuries. They are the durability prior showing
   through**, and the arithmetic proves it rather than suggesting it.

   `active` starts as the prior (`contingency.js:638`), and the prior is itself
   bounded: `prior` is `base.get(p.id)?.available ?? 0.92` (`contingency.js:901`) and
   `available` is `+Math.max(0.05, Math.min(0.99, rate * penalty)).toFixed(3)`
   (`:80`), so
   **`active` enters the branch at 0.99 or below**. The questionable branch is
   `Math.min(0.75, Math.max(0.45, active * 0.70))`, so its output runs from
   `Math.max(0.45, …)` at the bottom to `0.99 * 0.70 = 0.693` at the top. The
   practice block then applies: DNP `* 0.72`, limited `* 0.92`, or full
   `Math.max(active, 0.96)` — the full-practice guard excludes only doubtful, so
   it fires for questionable too.

   **The questionable path therefore yields `[0.324, 0.693]`, plus the single
   value `0.96`.** The 0.75 cap can never bind, and **`(0.693, 0.96)` is
   unreachable** — which rules out 0.70, 0.74 and 0.75 outright, most of the
   list. Those are durability priors on players carrying no report at all.

   Do not shorten this to "questionable implies ≤ 0.70". It is wrong twice: the
   bound is 0.693, and 0.96 is reachable. Somebody will try to use the loose
   version as a general rule.

   0.57, 0.64, 0.65 and 0.67 sit inside `[0.324, 0.693]` and so are reachable
   through questionable, but only on an implausibly high prior — do not claim
   them either way without a per-player read. The file says as much itself at
   `:620-625`: "a hand-set constant and a career durability prior, not a measured
   rate", and "a known-low placeholder, not as a reason to sit anybody".

   **And 0.324 is the FLOOR of that set, which is exactly Nacua's number.** He is
   not merely low; he is at the worst value the constants can express for a
   questionable player — `Math.max(0.45, …)` bottoming out at 0.45, then DNP's
   0.72. So **there is no constants path that can produce a lower number for
   him.** "Nacua drops below 0.324" is a check the current code structurally
   cannot satisfy, which makes any drop at all unambiguously the fit rather than
   something else moving underneath. That is the cleanest single test in this
   document.

   So expect **two opposite movements in the same dry run**, both landing on his
   screen:

   1. **The placeholder warnings clear.** Healthy-prior starters go up hard —
      `contingency.js:652-657` records the documented case, "Healthy starters
      actually played 94.5%; the old path said 0.708, this 0.952". **The counts
      should fall — but not from 3 / 2 / 4 / 3 / 1.** Those were taken before
      the deploy and the deploy itself moved the set: league 1 already reads 2,
      and Achane dropped off before any fit ran. **Re-baseline the counts off
      the mid-window capture and treat the pre-deploy figures as history rather
      than as a target.** This is the third number in this document that was
      measured once and then carried forward as though it were fixed — see the
      condition on 0.324 below, and the withdrawn claim that the designated band
      was empty. The pattern is worth naming: **a measurement is only a baseline
      while nothing has changed underneath it, and something always has.**
   2. **The genuine designation gets worse.** Puka Nacua should drop **below
      0.324** — `lineup-brain.js:628-633` says the fitted event overstates
      availability least for exactly those players, "the band where the fit moves
      furthest, and the only one that moves DOWN".
   3. **Any new chip must be a designated player.** A new warning on a
      healthy-prior starter is a finding, not the fit working.

   **Removed from this sheet: "expect more warning chips after the write."** That
   was the prediction before anyone counted what is on his rosters, and it is
   backwards for twelve of the thirteen. Magnitudes are still the dry run's to
   print; the directions are not guesses and are cited above.

   **If the counts do not fall and Nacua does not drop, the role rates did not
   land.** That is a countable check rather than a judgement call, which is the
   point: a write that leaves the flagged set identical is the one outcome it
   cannot plausibly produce.

   **The one condition this test carries, which was missing until the Trade
   Brain thread pointed it out: 0.324 is not a fixed property of Nacua.** It is
   what the constants produce for *questionable plus did-not-participate*, and
   his designation tracks a live ESPN report. If he practises full before step
   10 the same constants give `Math.max(active, 0.96)` and he reads **0.96**; if
   he is ruled out he reads **0.01**. Either is the code reading a changed world
   correctly, and in either case "did he drop below 0.324" is no longer a
   question about the fit at all. **So re-read his designation immediately
   before step 10 rather than carrying 0.324 forward from this document.**

   The argument survives the re-read, because it was never really about him. It
   is about the floor of the questionable band, and it re-anchors in one line:
   take whatever constants value his *current* status and practice string
   produce from the table above, and if that value is the floor of the set his
   status can reach, a drop below it is still unambiguously the fit. If his
   designation has cleared entirely, run the same check on another
   questionable-plus-DNP player rather than concluding nothing landed. **The
   failure this guards against is a false negative on the most load-bearing
   check in the document**, read at the exact moment when the alternative
   explanation — that the write did nothing — is the one everybody is braced
   for.

   **What is genuinely invariant before step 10, and is the control to rely on
   instead**: `basis: constants`, stamp `absent|absent`, and both
   `nfl_availability_rates` and `nfl_availability_role_rates` reported missing.
   Checked rather than assumed — those two names appear in exactly five files on
   `791b131` (`fit-availability.mjs`, `capture-availability-baseline.mjs`,
   `availability-decision-calibration.mjs`, `contingency.js`,
   `trade-engine.js`) and **no file under `server/migrations/` mentions either**,
   so the eleven migrations cannot create them empty and the basis cannot flip
   as a side effect of the deploy. It breaks only when `fit-availability.mjs`
   writes. Read that as pass or fail; read any player's number as an
   observation with their status and practice string printed beside it.

   **Everything reading unchanged is the result to distrust, not the reassuring
   one.** Four ways this verification could have produced a convincing null, all
   now closed:

   1. A cached simulate reading (step 2a, and the mandatory restart after step 8).
   2. An attenuated trade reading taken as the headline (above).
   3. A reading taken on `GET /api/model/availability` with no `?week`, which
      serves the durability prior and reads *neither* fitted table, so it is
      identical after the write however hard you clear the cache (above).
   4. **Being told the designated band was empty and therefore not looking.**
      This sheet said that until 21:25Z and it was wrong — Puka Nacua is
      Questionable-plus-DNP at 0.324 on another roster in all five leagues. The
      only one of the four that lived in the documentation rather than the code,
      and the hardest kind to catch, because a plan that tells you where not to
      look leaves no failing check behind.

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

   **One thing about its output will be uninformative, and it is not a reason to
   wait.** The script's `league_week_scores` block reports a cross-check — the
   pooled within-team SD of real ESPN team-week scores, the 24.1 and CV 0.20
   that `lineup-posture.js:131` and `trade-horizon.js:47` cite as corroboration.
   `league_week_scores` has had **no automatic writer** until #47's job, so that
   corroboration was computed against whatever happened to be in the table, and
   the re-fit's will be too until #47's `league_history` job has run once —
   which, being in the 300-second background tier, cannot happen before step 6
   passes. **The fit itself does not depend on it.** Read
   `fit-posture-calibration.mjs:499-517`: the block writes
   `result.league_week_scores` and prints it, and nothing downstream reads it —
   not the winner selection, not the gate, not a shipped parameter. So run the
   re-fit when the chain reaches it and treat that one number as pending.
   *Raised by the chat-sync thread as a reason to wait; checked here, and the
   waiting part does not hold.*

### 10a. Put the heavy tier back — last, and only after every after-read

```
fly secrets set AUTO_HEAVY_SYNC=1 -a gridiron-hq
```

**Read this before running it. As of 02:25Z one of the two fixes it waits on
exists and the other does not, so the instruction is still: do not run this
command.**

`fantasy_coordinator_refit` is tier `heavy` (`scheduler.js:1339`) and the heavy
tier is empty unless `AUTO_HEAVY_SYNC` is `'1'` (`:1759`). **Both verified on
`791b131`.** Whether the flag is set on the live app right now is *not* verified
here — reading it needs `flyctl`, which is out of bounds overnight — and it does
not need to be, because **run sheet step 8 unsets it before any database write**.
So by the time you reach this command the heavy tier is empty for certain, and
this command is the moment it first runs on the fixed build.

**The one thing that turns on the flag's present value is whether the damage is
already done, and step 3 of the morning block answers it**: the
`SELECT id, created_at FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1;`
row. No row means the refit has never run and nothing wrong-base has been
written. A row means it has, and its `created_at` says when — in which case this
step is not the first exposure and the fix is more urgent, not less.

**What it would refit against, and why that is wrong — verified here on
`791b131` rather than taken on report.** The defect is one argument at two call
sites, `trade-engine.js:354` (feature-audit's file) and
`fantasy-coordinator.js:571` (the fantasy plan's). Three lines settle it, and
they are worth reading because the defect is invisible in the output:

- `fantasy-coordinator.js:324` — the correction is trained as
  `target: actualPoints - projection.structural_ppg`, a residual on the
  **structural** projection.
- `:519` — it is graded the same way, `coordinateFantasy(fit, e.experts, 0)`,
  with the source's own comment: *"structuralPpg=0: correction alone is what's
  being graded"*.
- `:32-34` — one of its three experts **is** `ensemble_shift`, defined as
  `projection.ppg - projection.structural_ppg`.

Production passed `weeklyPpg`, the ensemble. So it served the ensemble plus a
correction trained and graded on structural — a sum nothing ever scored — and
applied the ensemble calibration twice, once in the base and again inside the
correction. *The exposure figures (352 of 1,169 startable players carrying a
non-zero ensemble shift, mean 2.09 points, p90 5.21) are feature-audit's
measurement on a scratch rebuild and are not re-measured here.*

**The asymmetry is what decides it.** Leaving the flag alone leaves the defect
exactly where it has been all along, latent and written nowhere. Running the
command with no fix merged writes a wrong-base fit into the database, which is
the one direction that is not free to undo. So:

- **If both call sites are fixed and merged by the time you reach this step**,
  run the command. Both fixes now exist and are verified; what remains is
  merging them.
- **If either is not, skip this step entirely and leave `AUTO_HEAVY_SYNC`
  unset.** Nothing else in the run sheet depends on it. The heavy tier stays
  empty, which is the state the app has been in since the deploy, and the refit
  waits for a morning when both fixes exist.

**The `trade-engine.js` half is PR #57, verified here at head `7c27517`.** The
call now reads
`coordinateFantasy(fantasyFit, expertValues, coordinatorBase(weekProjection))`,
and `coordinatorBase` returns `weekProjection?.structural_ppg ?? null` — null
rather than a silent fall back to the ensemble, which is the right shape for a
fix whose failure mode was a plausible wrong number. #57 also carries the
fantasy-week fix, a season-horizon fix and an availability-source label, so
merging it for this reason brings three other changes with it; its body
describes all four.

**The `fantasy-coordinator.js` half is verified too, at `42bbbc3` on
`claude/project-thread-f921do-coordinator-head-hold`**, which has no PR yet —
it is held back by the same freeze. `weeklyProjectionFor` now passes
`projection.structural_ppg`, and `corrected_ppg` is **null** when no fit is
persisted rather than the ensemble number wearing the corrected field's name;
`ensemble_ppg` publishes that number under its own.

Its one consumer was widened to match: `routes/drafts.js:1050` now reads
`corrected_ppg ?? ensemble_ppg ?? structural_ppg`, so **the printed draft-sheet
number is identical to today's in every state**. Without `ensemble_ppg` in that
chain the sheet would have silently dropped to the uncalibrated structural
figure the moment the field stopped being the ensemble in disguise.

*One thing checked here that the branch's own report does not mention, and it is
not a problem.* `weeklyProjectionFor` has **two** callers, not one —
`draft-assist.js:976` and **`routes/players.js:94`**, which serves
`weekly_projection` in an API response and is untouched by this branch. So on the
player route `corrected_ppg` becomes null where it used to carry the ensemble
number. **Nothing reads it**: a search for `corrected_ppg` across `server/`,
`client/` and `scripts/` finds only `drafts.js` (fixed) and `trade-engine.js`
(its own field, unrelated). So no surface changes, and the served payload stops
labelling an uncorrected number "corrected", which is the point of the fix
rather than a side effect of it.

**So both halves exist and both are verified. The skip is lifted on this
condition and no other: both must be merged before the command runs.** #57 at
`7c27517`, and the PR the fantasy plan opens from `42bbbc3` after the go. If
only one lands, the skip is back — half the fix still refits against a wrong
base on the other call site.

*A note on how #57 was checked, because an earlier read of it was wrong and the
way it was wrong will recur.* At 02:05Z its pushed head was `aca74f9`, which did
not touch `coordinateFantasy` at all — the fix existed only as unpushed local
commits, held back by the same GitHub-email freeze holding these branches. On
that head the call had moved from line 354 to line 379 purely from lines added
above it, which reads exactly like a fix if you check the line number rather
than the content. **Verify any PR named here by its content, never by its number
or a line reference:**
`git diff origin/main...<branch> -- <file> | grep -c <symbol>`.

Nothing else about this step changes: it is still last.

**The scheduler thread is right that the flag is no longer the hazard it was,
and this sheet is right to keep it off until the measuring is done. Those are
two different reasons and both hold.**

*Why re-enabling is now safe*, verified on `791b131`: `scheduler.js:1605` reads
`const offThread = job.offThread ?? job.tier === 'heavy'`. **The heavy tier
defaults to off-thread** — no job needs to declare it, and none of the twelve
does. That is #17's change, and it removes the original hazard, which was
eleven long jobs parsing megabytes on the HTTP thread. #33's per-tier
re-entrancy guard (`if (inFlight) … skipping this one`) closes the second.

*Why it still stays off until the end*, and this is a different argument: the
reason to unset it tonight is **not** the request thread, it is that those jobs
**change data underneath the readings**. Off-thread is not free — `node:sqlite`
is synchronous and single-writer, so a worker doing a large batch still takes
the write lock, and more to the point a refreshed `nfl_injuries` moves
`weeklyAvailability` and therefore moves the exact numbers being attributed to
the fit. Same objection as restarting at step 10, arriving by a different route.

**So: re-enable only after every after-read is captured. Never inside the
capture window.** Note that `fly secrets set` **restarts the machines again** —
harmless once the measuring is done, and it clears the memo caches on the way
out, but it is a restart and it must not land mid-capture.

If anything about the deploy still looks unsettled, leave it off and set it
tomorrow. Nothing degrades while it is unset; the jobs simply run on their next
pass once it is back.

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

**An earlier version of this paragraph said the eleven migrations are additive
and drop nothing, so an older image boots against the migrated volume without a
schema rollback. That was asserted rather than checked, and it is wrong.** Three
of them write in `up()`, read off `origin/main` at `791b131`:

| Migration | What `up()` does beyond adding |
| --- | --- |
| `053_nfl_news_signals_versioning.js:55` | rebuilds the table — `DROP TABLE nfl_news_signals`, then renames a newly built one into its place |
| `055_repair_pinnacle_placeholder_openers.js:84` | `UPDATE game_lines SET open_spread …` and `… open_total …` over existing rows — a data repair |
| `061_sync_log_consecutive_failures.js:19` | `UPDATE sync_log SET consecutive_failures = 1 WHERE last_status = 'error'` |

**So the image reference rolls back code and does not roll back rows**, and the
two `UPDATE`s are not recoverable by running the migration's own `down()`
either: `055`'s `down()` drops the `open_*_source` columns it added but leaves
the overwritten `open_spread` and `open_total` values in place, and `061`'s
drops its column. A `down()` undoes a schema change; it cannot remember what a
value was before it was overwritten.

What that means in practice, and it is narrower than it sounds. An older image
booting against the migrated volume is fine for `053`, since the rebuilt table
keeps its old columns and only adds to them, and for `061`, since `sync_log`
counters are operational rather than meaningful. The one that genuinely loses
something is `055`, which overwrites opener values that were there before — and
those are betting rows, out of scope for this project by Nick's instruction,
which is the only reason this is a footnote rather than a blocker.

**The complete rollback is therefore the image plus the pre-migration snapshot**,
`/data/data.sqlite.pre-migration-<stamp>.bak`, and that half is destructive: it
discards everything written since the snapshot was taken. It is a decision for
Nick with the specific migration named, not a command to have ready. If a
migration throws, get its name out of the log first — the answer for one named
migration is a much smaller question than the general case, and for most of the
eleven the image alone is enough.

If a single migration does need undoing, `npm run db:rollback` takes one at a
time, newest first — and pass the name explicitly, because bare it takes the
last-sorted file, which is now `062_league_payload_season`.

### 11a. What the first deploy attempt actually did, 21:2xZ

Recorded because the next person will want to know whether anything was left
half-done. Nick's paste of the deploy output, 21:59Z:

```
image: registry.fly.io/gridiron-hq:deployment-01M2XRT9094HFEB29SXRG1NMSD
image size: 85 MB
Updating existing machines in 'gridiron-hq' with rolling strategy
✔ Cleared lease for 84ed41eae1dd68
Error: failed to update machine 84ed41eae1dd68: Unrecoverable error: timeout
reached waiting for health checks to pass for machine 84ed41eae1dd68
```

Four things this settles and one it does not.

It settles that **the build succeeded and the image reached the machine**, so no
theory about the 26 pull requests failing to compile survives. It settles that
**the machine was updated in place**, which is why nothing is serving at all —
there is no previous release beside it, exactly as 3 now says. It settles that
`deployment-01M2XRT9094HFEB29SXRG1NMSD` is **not a rollback target**: it is the
tag of a release that never became healthy. The rollback target is still
`01M2VZ9JRYSXVHCRWJ83V360QH`. And the trailing
`net/http: request canceled` on flyctl's final GET to the machines API is
**flyctl's own in-flight poll being cancelled when its wait deadline expired** —
the tail of the same timeout, not a second failure, not an API outage, and not a
machine stuck mid-update. Do not chase it.

What it did not settle was which of the boot causes in 4b fired, because every
one of them ends in health checks never passing. The error is downstream of all
four and discriminates between none.

**The machine log settled it at 22:00Z: it was the disk gate.** Verbatim from
the log, `Refusing to migrate: a pre-migration snapshot of 0.4 GB needs about
2.4 GB free, and 0.4 GB is available of 1.0 GB`, with the stack running
`assertRoomForSnapshot` (`server/db/index.js:163`) → `backupBeforeMigration`
(`:123`) → `runMigrations` (`migrate.js:43`) → `index.js:23`. Then
`Main child exited normally with code: 1`, repeatedly, until
`machine has reached its max restart count of 10`.

**The volume is 1 GB.** Nobody had looked, and the plan's own precondition —
`df -h /data`, needs about 2.5 GB — would have caught it before the deploy
rather than after it. It was written and then not run, which is its own lesson
and a more ordinary one than any of the failure modes in this document.

What the log also settles, and this is the part worth keeping: **no migration
ran and no `.bak` was written.** The refusal is at `:123` and the `VACUUM INTO`
at `:129`, so nothing was even started. The database is exactly as it was
before the deploy, `schema_migrations` included. There is nothing to undo, and
the retry is a clean first attempt rather than a resumption.

**The fix, and the free verification nobody has to run.** `fly volumes extend
vol_40oxk076jmqlelm4 -s 5 -a gridiron-hq`, then `fly deploy`. There is no step
between them: Fly's init resizes the filesystem to the volume's current size
when it mounts `/data` on boot, and the deploy boots the machine. The log proves
this about itself — `Resized /data to 1056964608 bytes` at 22:01:54Z is that
init doing exactly this on a restart, and 1,056,964,608 bytes is the 1 GB
volume. **So the same line on the next boot should read about five times that,
and if it still reads 1056964608 the extend did not take.** It is the first line
of the next paste that says whether this worked.

**Two things on the retry that look like failure and are not.** The boot is now
longer than any previous one, because the snapshot actually runs: a `VACUUM
INTO` of 445 MB plus eleven migrations, all before `app.listen`. And the app
answers 502 for that whole window, because it is out of routing until it
listens. So flyctl may report the same health-check timeout against a perfectly
healthy boot. **The log decides, not the clock, and neither is a reason to
redeploy.** 3a is the real fix for that and is deferred to the next train as
PR #49; it is a second ask and a second deploy, and tonight's cause is now
known to be something else.

**One thing does move the ranking, against what 3a argues.** The app answered a
502 with an empty body for more than thirty minutes. A merely slow boot heals:
if the app had listened at 90 or 150 seconds, the next check at a 15-second
interval passes and routing resumes without anyone doing anything. It did not.
So the app is most likely not listening at all, which puts the disk gate and a
migration throw back in front of the grace period. **3a is still worth pulling
before the retry** — for the reason that has not changed, that extending the
volume makes the next boot *longer* because the snapshot then actually runs —
but it is probably not what killed this attempt. That fix is PR #49.

The branch to keep open either way: the app can be listening and still answer
502 if `/api/health` itself returns non-200, since it makes a synchronous SQLite
read. In the log that looks like the listening line present and nothing after
it.

## 7. The run sheet

Every command in order, for the moment the decision is made. Nothing here is a
description; each line is meant to be pasted. Steps 1-2 are read-only. **Step 3
is the first irreversible action in the whole plan.**

### 7.0 Who can run what, once the app is up

The deploy landed at 22:09Z and Nick went to bed at 22:08Z. From here the sheet
divides in two, and the division is not by importance — it is by whether a step
needs a terminal on Nick's machine.

**Runnable tonight, by a thread, read-only over HTTP with the bearer token.**
None of these writes anything, none needs a decision at the time, and all of
them are the baseline the morning's after-reads are compared against:

| Step | What it reads | Thread |
| --- | --- | --- |
| the three deterministic reads | `?seed=1&runs=2000&from_week=2`, with the 2026 usage count beside each | Trade Brain |
| mid-window capture | the full pre-fit availability picture | Trade Brain |
| the deploy marker | `GET /api/trades/3/managers/signals` | Trade Brain |
| scheduler status | `scheduled_now`, `due_after_minutes` over HTTP | scheduler |
| chat status | whether the corpus is present | chat sync |
| `heavy_enabled` | whether the unset was run | Trade Brain |

**Needs Nick's terminal, so it waits for the morning.** Anything running a
script on the machine, touching secrets, or restarting it: the step 7 dry run
(`--report=/tmp/fit.json`), the step 8 promotion and the ensemble re-fit, the
restart that follows it, the step 10 availability fit, the completeness script,
`npm run chat:sync`, the `COUNT(*)` reads that need `fly ssh console`, and
putting `AUTO_HEAVY_SYNC` back last. **No database write happens tonight.**

### 7.0b What actually happened after the deploy: the machine will not stay up

**Written at 22:20Z, while it was still happening.** The deploy succeeded, the
migrations applied, and the app serves correct answers — and it restarts every
two to three minutes.

**The most important thing in this section, and it is not the fault: the 26
pull requests did not cause this.** Team memory's `fly-app-stalls-in-bursts`
records the same wedge on the **old** build earlier the same day, between 16:08Z
and 19:25Z — the app accepting connections and then writing nothing for minutes
at a time, one clear serving window in twelve probes. What changed at 22:09Z is
that #29's watchdog now **kills** a process whose event loop has stopped turning,
where the old build let it hang silently. **This release did not break the app;
it made a pre-existing stall visible.** Found by the wiring map thread, and it
is the first line anyone should be told, because "the release broke it" and "the
release exposed something already broken" are very different things to be handed
on waking. Four process starts observed from HTTP alone, no terminal
required:

| Start (derived from `uptime_s`) | Start to next start |
| --- | --- |
| ~22:09:00Z | ~187 s |
| 22:12:07Z | ~164 s |
| 22:14:51Z | ~252 s |
| 22:19:03Z | — |

**Those are start-to-start figures and they overstate how long the app works.**
Twelve samples at twenty-second spacing separate the two halves: serving at
`uptime_s` 81 and 101, then **four consecutive requests returning zero bytes**
from 22:16:53Z to 22:18:53Z, then serving again at `uptime_s` 30. So each cycle
is **about 105 to 120 seconds of normal service, then roughly two minutes
wedged** — 60 seconds of watchdog threshold plus the exit and the boot, matching
the design exactly.

**Three cycles have wedged at essentially the same age, between 101 and 121
seconds of uptime.** That regularity is the strongest clue here, and it argues
against contention, which would be ragged. Something fires at a fixed offset
after boot and blocks. It is not the five-minute scheduler tick, so it has
either a shorter timer or a fixed amount of setup before it starts writing.

**The window is predictable, which keeps the one-request reads possible.** Read
`uptime_s` first: under about 60 means roughly a minute of good app left, enough
for `heavy_enabled` or the deploy marker. Not enough for anything that iterates
over five leagues.

**The signature that names the cause, measured at 22:18:23Z.**
`GET /api/health` returned **503** — not 502 — with **35.3 seconds to first
byte**, TCP connecting in under a millisecond. The distinction is the whole
diagnosis:

- **502 with an empty body** is Fly's edge answering with no instance behind it.
  That was the disk-gate failure earlier tonight.
- **503** comes from `healthHandler`'s own `catch` (`server/platform/health.js`),
  which is reached only when `db.prepare('SELECT 1').get()` **throws**.
- **A hang with zero bytes received** — connection accepted, nothing answered —
  is the kernel taking it onto the listen backlog while the event loop is
  blocked. This is the majority of what the wedge looks like from outside, and
  it is precisely the scenario the TCP-check comment in `fly.toml` was written
  about. **Treat a reported "502" during a wedge as suspect until the raw
  output is shown**; the three are different faults and only one of them is the
  edge.

**An earlier version of this section read that 503 as lock contention from a
long write, and that was wrong.** `db/index.js:24-26` sets
`PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 15000` and
`PRAGMA journal_size_limit = 67108864`. **In WAL mode readers do not block on a
writer** — that is what WAL is for — so no ordinary write, however long, can
make `SELECT 1` throw. Only an exclusive-lock operation can, and the candidates
are closed rather than open: the single `wal_checkpoint` in `server/` is
`report-cache.js:113`, which sets `busy_timeout = 250`, catches the busy failure
and restores in a `finally`; the single `VACUUM INTO` is
`backupBeforeMigration`, which runs only when migrations are pending, and they
are not any more.

So **the 503 is a symptom of the cycle rather than its cause.** The arithmetic
that fits is roughly 20 seconds queued behind a blocked event loop plus the
15-second `busy_timeout`, with the brief exclusive lock most plausibly coming
from WAL-index recovery after the previous process was killed mid-write. That
last step needs the machine log to confirm and nothing turns on it. Caught by
the Trade Brain thread, from two lines nobody else had opened.

**The loop, and why it does not settle.** Boot, serve normally for a minute or
two, something begins a long write, every request queues behind it, health
throws and answers 503, Fly evicts the machine from routing, the #29 watchdog
exits the process after 60 seconds of a blocked loop, Fly restarts it — **and
whatever runs at boot starts the same write again.** Every restart re-runs
`bootJobs`, which is what makes it self-sustaining rather than self-correcting.

**The agreed cause, from the scheduler thread, verified on `791b131`.** The
scheduler's boot pass fires about 20 seconds after start and runs its jobs
sequentially, nearly all on the main thread. Fly's own `/api/health` probe arms
the #29 watchdog within 15 seconds of listen, because `server/index.js:63`
mounts the arming middleware above the health route at `:86` and `fly.toml`
probes every 15 seconds. The watchdog exits the process after 60 seconds of a
blocked loop (`loop-watchdog.js:58`). And **every restart re-runs the same boot
pass.** Two individually correct changes forming a loop, which is why nothing
about it settles.

**`heavy_enabled` reads true** (22:19:26Z, `uptime_s` 23 beside it), so Nick
never ran the unset and the first reset was not his either.

**And `fly secrets unset AUTO_HEAVY_SYNC` is therefore not the fix.**
`scheduler.js:1759` gates only the *heavy* tier on that variable, and the
blocking work is the boot pass. Unsetting it removes twelve jobs' worth of work
and leaves the loop intact. It is still worth running, because the run sheet
wanted it anyway — but presenting it as the fix and watching the app keep
cycling costs more than it saves.

**Three things to be clear about, because two of them look like new faults and
are not.** The 503 and the watchdog are the *detection*, working exactly as
designed against a real wedge — see the rationale in `fly.toml` and in
`health.js` for why a TCP check would have shown a healthy machine throughout.
The deploy itself is not what failed: the tree is correct, the migrations
applied, and the answers between wedges are real. And **no data is at risk** —
nothing has written, and the database is as it was.

**What it costs.** Tonight's baseline cannot be taken: a twenty-minute capture
cannot complete inside a hundred-second life, and a partial one would stitch
several processes together with the seams falling mid-list, where they read as
effects. **And the two database writes must not be attempted until this is
understood** — a fit running against a process that may exit mid-write is the
one genuinely unsafe thing on this sheet. **Step 7 is no longer the morning's
first item. Stabilising the app is.**

One clock on it: Fly caps restarts, and this machine already hit
`max restart count of 10` earlier tonight. If it hits the cap again it stops and
stays stopped, and nothing can be read until someone is at a terminal.

### 7.0c The morning, in order

The app has been restarting in a loop since the deploy — but the stalling
underneath it was already happening in the afternoon on the old build, measured
between 16:08 and 19:25Z. **In practice it answers normally for about the first
95 seconds of each life and then goes silent until it is restarted**, so the
site works in windows rather than being down. What the release added is a watchdog that kills a
stuck process so the host restarts it, which very likely explains why a problem
that used to be invisible is now obvious. In the meantime the app is serving in
short windows between restarts rather than steadily, so opening the site may
land on a stall.

**How often, counted rather than estimated.** Polling every 60 seconds from
22:53:10Z to 01:44:27Z, 173 reads: **58 process starts, one every 180 seconds.**
The gaps between consecutive starts run 171 to 196 seconds, mean 180, median
180. That is a metronome, not a scatter, and **the rate is the durable fact
here, not the total** — the count was 58 at 01:44Z and 75 at 02:35Z, and by the
time anyone reads this it will be higher again. For the current figure:

```
bash /mnt/project-files/restart-count.sh
```

It clusters starts within 5 seconds, and it refuses to add the pre-22:49Z
300-second stretch (a floor) to the 60-second one (a count), which is the
distinction every number in this section rests on.

**If you see "79 restarts" or "376 seconds" anywhere, both are mine and both
are withdrawn.** 79 was a naive count of distinct start times, which
double-counts every process read twice, because `uptime_s` is whole seconds;
clustering gives 58. 376 is not in the data at all. Worked through in 7.0c-0.

**Ignore any claim that the app dies after 72 seconds. It is false, and it was
ours.** The 60-second poll against a 180-second cycle is exactly three polls per
cycle, so the reads were phase-locked — 41 of 54 clean reads caught the process
at an age of 55 to 58 seconds, and not one read all night saw an age between 73
and 170. 72 was the edge of where we looked.

**What the app actually does, measured on eight consecutive lives between
01:50Z and 02:13Z.** An anchored probe — lock onto a clean read, derive that
process's start, then time reads to land at chosen ages of that same process —
walked straight through the window the poll cannot see, once per life.
`/mnt/project-files/blind-window-probe.tsv`. One life in full, anchor
01:50:28Z:

```
age  19   200  0.144s   uptime_s 19   anchor
age  78   200  0.458s   uptime_s 78   answered
age  86   200  0.156s   uptime_s 86   answered
age  94   200  0.173s   uptime_s 94   answered
age 102   000  12.00s   no answer     blocked
age 114   000  12.00s   no answer     blocked
age 126   000  12.00s   no answer     blocked
age 138   000  12.00s   no answer     blocked
age 150   000  12.00s   no answer     blocked
age 165   000  12.00s   no answer     blocked
--- next process starts 01:53:20Z ---
age  13   200  7.866s   uptime_s 13   anchor (new life)
```

`uptime_s` matches the age on every answered row, so it is the anchored process
replying throughout, not a new one wearing its number.

**All eight lives, as the last age that answered and the first that did not:**

```
01:50:28Z   94 -> 102      01:58:58Z  102 -> 110      02:07:37Z  102 -> 110
01:53:20Z   94 -> 102      02:01:54Z   94 -> 102      02:10:36Z   94 -> 102
01:56:09Z   94 -> 102      02:04:41Z  102 -> 110
```

**The onset is inside (94, 110] on every one of them**, and inside (94, 102] on
five of the eight. The two brackets differ only because a blocked read costs the
probe 12 seconds, which shifts the rest of that life's ladder — not because the
app behaved differently.

**And it does not slow down first. It stops.** Twenty-nine reads landed at an
age of 78 or more across the eight lives, and **the slowest of them took 0.46
seconds**. On the other side of the boundary, **41 reads were issued at an age
of 110 or more and not one of them answered** — so "it might recover at 120 or
140" is not merely unobserved, it is 41 attempts without an exception. There is no ramp, no creeping latency, no degradation to watch for:
the app is fully healthy and then, within one eight-second step, answers
nothing at all. That is the signature of a single synchronous operation seizing
the event loop, and it is not the signature of memory pressure, connection
exhaustion or gradual lock contention — which is worth knowing because those
would each call for a different fix.

**Confirmed by a second instrument that was not looking for it.** The Trade
Brain thread's ordinary 60-second health log walked out of its phase-lock on
its own — its logger sleeps the *remainder* of each interval, so every hang
shifts its phase — and drifted into the same blind window. On the life starting
**02:04:41Z** the two samplers landed one second apart:

```
their log   02:06:24Z   200  0.43s   uptime 103   derived start 02:04:41Z
this probe  02:06:23Z   200  0.21s   age    102
this probe  02:06:31Z   000  12.0s   age    110   no answer
```

Different code, different cadence, no shared state. Both got a fast 200 at
102-103 seconds of age, and the probe got silence eight seconds later. **That
life's onset is bracketed to (103, 110] by two independent readings**, and a
fast answer at 103 was predicted by the ladder rather than contradicting it —
it is one of the three lives in the (102, 110] group above.

**Healthy and fast at 94 seconds. Silent at 102. That is the diagnosis, and it
is now an observation rather than an inference.** The boot pass schedules
`runIfStale('nfl_model_growth')` at boot + 90 seconds (`scheduler.js:1751`).

**Why the onset varies by about 16 seconds across lives while the timer is
flat, which is the obvious objection and has an answer in the code.** The timer
fires at exactly 90 seconds every time, but the first thing the job does is
**download**, and a download does not hold an event loop. The synchronous
SQLite write that follows it is what blocks. So the onset is 90 seconds plus
however long that fetch took, and a 16-second spread in fetch time over a
network is unremarkable. **The flat timer and the variable onset are consistent,
and the gap between them is precisely the part of the job that does not block.**
It also means the brake is not merely early enough — it returns before the timer
is scheduled, so neither the download nor the write ever begins.

**The rest of the cycle, now that two of its three terms are measured.** The
probe timed all eight cycles start to start: **172, 169, 169, 176, 167, 176,
179, 168 seconds** — a range of 167 to 179. Onset at 94 to 110, plus the
watchdog's 60-second fuse (`loop-watchdog.js:58`, `60_000` unless overridden),
leaves **roughly 5 to 20 seconds for the restart itself**. An earlier version of
this section put the boot at 30 seconds and wrote 90 + 60 + 30 = 180; that
matched the median by luck and the third term was never measured. It is the
small one.

*One discrepancy stated rather than smoothed:* the probe's directly timed cycles
run 167-179 seconds, while the passive 60-second log's clustered gaps run
171-196. Both are reported with their method. I have not established why they
differ and am not going to guess; nothing in this block turns on the difference.

**What this means for Nick before he touches anything: the app is not sick for
most of its life. It is healthy for about 95 seconds, then one scheduled job
takes the event loop and never gives it back.** Opening the site will work, in
windows, and then stop mid-click. That is worth knowing before the first
command, because "it loaded fine for me" is not evidence the loop is fixed.

That is also why the first command is a brake rather than an investigation, and
the brake is now a test with a prediction attached: `SCHEDULER_DISABLED=1`
returns before that 90-second timer is ever scheduled, so **if this reading is
right the cycle stops dead on the first command.** If the app still dies around
three minutes with the scheduler off, this whole section is wrong and something
outside the scheduler holds the loop — go to the six baseline reads, not to a
second guess at which job it is.

**Two things about the inbox before anything else, so the rest reads
straight.** CI is off deliberately and gates none of the merges below — the
detail sits with step 5, where it matters. And **no PR number beyond the six
listed there should have appeared overnight unless it is code that ships**, so
one you do not recognise is worth a second look.

**The run sheet's step 7 is not the first item. Stabilising the app is.**
Everything numbered below is this block's own list, not the run sheet's — the
two both reach a step 7 and they are different steps.

**There is a purpose-built brake for this already in the code, and it is the
first command.** `scheduler.js:1732`:

```
if (process.env.SCHEDULER_DISABLED === '1') {
  console.log('Scheduler disabled via SCHEDULER_DISABLED=1 — no background jobs will run.');
  return { disabled: true };
}
```

It returns **before** the boot pass is scheduled, so there is no `bootJobs`
chain, no 90-second timer and **no tiers at all** — which matters more than it
did an hour ago, because it means this one command stops both of the things
that start at 90 seconds, whichever of them is the culprit.

**The comment above it, `scheduler.js:1721-1731`, was written on 2026-09-07,
hours before the Matta-Kodsi draft, and it describes tonight exactly.** Quoted
in full rather than trimmed, because two clauses this document previously cut
are the important ones:

> "after the betting-side live tier's 90-second polling of a **6GB+**
> synchronous SQLite database (**`node:sqlite` has no worker thread; a slow
> query blocks the whole HTTP server, not just the caller**) was found to be the
> actual cause of the app going periodically unresponsive for several seconds at
> a time. None of the fantasy pages depend on live NFL/MLB odds staying fresh,
> so the safe move for a night that has to work is to stop paying that cost
> rather than **chase which of a dozen 3-to-5-minute jobs is the one currently
> holding the lock**."

**Three things to take from it.** The parenthetical is the structural fact
under the whole night: a slow query blocks the server, not the caller, so any
synchronous read on the main thread is a whole-app outage rather than one slow
request. The "dozen 3-to-5-minute jobs" are the live tier described above, and
the sentence is about the same 90-second timer. And **someone stood exactly
where this document stands, chose the brake over the attribution, and wrote the
brake** — which is the best argument in the plan for running it first, and it is
in the source rather than in anyone's prose.

*One figure in it does not reconcile and is left open:* the comment says
**6GB+**, while the live database is recorded at 445 MB with a WAL of similar
size. Either the file shrank, or the figure was loose when written. It is not
checkable from here, it changes nothing about the brake, and it is worth a
glance at `ls -la /data` in the morning — which step 3 already runs.

1. ```
   fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq
   ```
   **Not `fly secrets unset AUTO_HEAVY_SYNC`**, which gates only the heavy tier
   (`:1759`) and would leave the boot pass running. Setting a secret restarts
   the machine, which is wanted. Fully reversible by unsetting it, and it stops
   the heavy tier too, so it supersedes that step for stability purposes.

2. Proof, one command, run twice a few minutes apart:
   ```
   curl -s https://gridiron-hq.fly.dev/api/health
   ```
   **`uptime_s` past 600 and still climbing on the second read is the pass.**
   Anything under 200 on a later read means it restarted again.

3. **One read confirms the job by evidence rather than by timing**, and it is
   read-only, so it can be done while the app is quiet:
   ```
   fly ssh console -a gridiron-hq -C "sqlite3 /data/data.sqlite 'SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;'"
   fly ssh console -a gridiron-hq -C "ls -la /data"
   ```
   `nfl-model-growth.js:164-166` INSERTs a row with `status: 'running'` **before
   any work starts**, so a process killed mid-job leaves that row behind.
   **One `'running'` row roughly 90 seconds after each process start confirms
   it; no `'running'` rows kills the diagnosis** and sends the search back to
   the boot pass. The job is already named from the live app (7.0c-i), so this
   is the check that would have caught us being wrong, not the thing the
   diagnosis rests on. The `ls` is the separate question of what `.bak` files are on the
   volume — there should be exactly one, from the 22:09Z boot, and it is the
   only copy of the pre-migration rows.

   **And while the terminal is open, one row settles a separate question the
   model audit raised:**
   ```
   fly ssh console -a gridiron-hq -C "sqlite3 /data/data.sqlite 'SELECT id, created_at FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1;'"
   ```
   **A row means the audit's ensemble-plus-correction double count is live** —
   their figure is a mean 2.09 points on about 30% of startable players.
   **No row means it is latent**, and the fix still has to land in the order
   below either way. This needs the terminal because `/api/model/setup-status`
   computes the same thing (`routes/model.js:665`) but sits behind
   `legacyAuthenticated` (`index.js:126`), which is why nobody could read it
   tonight.

4. **Then take the baseline**, which turns last night's loss into a delay rather
   than a write-off. A scheduler-disabled app is not a degraded one for this
   purpose — it is a *quiet* one, which is the ideal condition for a capture
   that has to be compared against something taken twenty minutes later. Threads
   only, read-only, no terminal needed.
   **The order matters and the failure looks like a bug.** The capture script
   (#41) now reads `/api/health` at both ends and refuses a run that spanned a
   restart, exiting non-zero with *the app restarted mid-capture*. Run before
   step 2 passes, that is what it will do, every time, correctly. Stabilise,
   prove `uptime_s` past 600, then capture — never the other way round.

**About the checks on these six, before the list: CI is off deliberately and
none of them is red for a reason of its own.** The month's GitHub Actions
allowance is spent — 2,000 of 2,000 minutes, resetting **1 October** — which
from about 01:00Z on 2026-09-20 made every run fail two seconds after starting,
on four branches at once, having checked out nothing and run no test. The
workflow is now `disabled_manually`, so a push triggers nothing at all.

**What that means for merging: nothing.** This is a private repository on the
Free plan, so no required-check rule can exist on `main` and no merge is gated
on a green check. **A red or missing check on any of these PRs is not a
statement about its contents.** The evidence that stands in for CI is in each
PR's own body: every one carries its owner's full local run — suite count,
failures, lint, typecheck and smoke — taken before the allowance ran out.

**Do not re-enable the workflow and do not re-run anything**, including from
the Actions tab, until the allowance resets. A re-run spends the thing that is
exhausted and fails in two seconds regardless. The full evidence — which runs,
which branches, the two-second durations — is in a comment on this pull
request.

**And the emails overnight were bookkeeping, not work.** Every new pull request
sends one. From 01:31Z no thread opens a documentation-only pull request,
comments on one, or closes one; work continues as commits on branches that
already exist. That is why an unfamiliar PR number is worth a second look.

5. Ship the fix. **Six PRs, in this order:** **#56** (the arming fix),
   **#59** (takes the boot path off the request thread), **#61** (backs a job
   off after it has killed the process, instead of handing it the process
   again next boot), **#63** (keeps that job off-thread on the timer path as
   well), **#52** (the one-line `fly.toml` setting `NFL_SEASON`) and **#49**
   (raises the health-check grace period). Then:
   ```
   fly deploy -a gridiron-hq
   ```
   **All six are open as drafts, and GitHub will not merge a draft** — each
   needs marking ready for review first. One click each, and it is the kind of
   thing that reads as a broken merge button at seven in the morning.

   **#59, #61 and #63 are a stack, retargeted to `main` at 01:02Z**, so there
   is nothing to do by hand — an earlier version of this step said there was.
   Each branch already contains the commits below it, so each diff is
   cumulative and merging them in the order above lands each one on `main`.
   **Check that each PR shows base `main` before merging** and no more than
   that. Verified here by containment rather than by what GitHub displays:
   `#59 ⊃ #56`, `#61 ⊃ #59`, `#63 ⊃ #61`. The same fact is the fallback if a
   merge goes wrong partway — **#63's branch contains all four**, so merging
   it alone lands the whole stack.

   **One thing that looks like an omission and is not:** the TDD evidence file
   for this work, `docs/tdd/boot-restart-cycle.tdd.md`, arrives with #61 and
   covers #56 and #59 retrospectively. The first two merges are not
   undocumented; the document just lands third.

   **The other PRs open tonight are not part of this and can go any time, with
   two orders that do matter.** **#60 after #57**, and the reason is worse
   than a build error. `tradeWeekContext()` takes no parameters on `main`
   (`trade-engine.js:172`), so #60's `tradeWeekContext(lg)` calls **compile,
   lint and typecheck cleanly** — JavaScript discards the extra argument. The
   league is silently ignored and every league gets the NFL's week instead of
   its own. Three of #60's seven tests catch that; nothing static does. The UI
   order is **#57 → #43 → #60**. And **#46 before #53**. Nothing else among
   them is ordered.

6. Turn the scheduler back on and prove it holds:
   ```
   fly secrets unset SCHEDULER_DISABLED -a gridiron-hq
   ```
   then step 2's `curl` again — but **the bar here is `uptime_s` past 900, not
   600**, and it is worth knowing what those 900 seconds are buying. Step 2's
   600 is measured with the scheduler off, where there is no boot pass, no
   timer and no tier at all. With the stack in, the boot pass and both delayed
   timers are off the request thread, so **the risky moment is t+300 s: the
   first background tier pass.** Nineteen jobs that have never run on this
   build — 13 growth and 6 metered — come due at once there and run in series
   on the request thread. 900 covers that pass twice. The count is **22**, verified
   here: 26 jobs are in the background tier (20 growth, 6 metered), less
   `beat_the_close` and `nfl_prop_feeds`, which are in `bootJobs`, and
   `nfl_model_growth` and `nfl_reports`, which have their own timers — leaving
   18 growth and 4 metered. Twelve more are gated off by `AUTO_HEAVY_SYNC`, so
   **34 of the app's 62 scheduled jobs have never run on this build.**
   **In that window the app
   will be busy and still answering** — a slow response is the fixed state, a
   dark one is not. **One of the 22 is worth naming, because it is the
   biggest single cost and it is on the request thread:**
   `trade_asset_universe_warm` (`scheduler.js:1347`, tier `growth`) rebuilds
   the asset universe for every league, which the scheduler thread measures at
   five to six seconds per league. With five leagues that is most of the first
   pass on its own, and it cannot be moved off-thread because what it warms is
   a module-level `Map` in this process (`compute-cache.js:24`). **And if it does die between 300 and 900 seconds, the cause
   is in those 22, not in the boot fix**, which is a different
   investigation and not a reason to doubt the merge. **Only after this passes does the run sheet resume at step 7.**
   Re-enabling without re-proving is how a fix that half-works gets believed.

7. Then, and only then, the run sheet's own step:
   ```
   fly secrets unset AUTO_HEAVY_SYNC -a gridiron-hq
   ```

**One thing to read rather than run, and it is not part of the sequence
above.** [Model evidence audit](https://claude.ai/artifact/WVQqxZwa1FsvXyzir2fsLr)
(PR #68). It
answers, for the Model surface, the question this whole block answers for the
deploy — which numbers are measured and which are guessed. It is separate work
by another thread, it blocks nothing here, and it is listed so it is not
discovered a week later.

**And one finding that is not about tonight's deploy at all, verified here on
`791b131` rather than relayed: the league transaction history on the live app
is a snapshot from a laptop, and nothing on Fly has ever refreshed it.** The
chain is short enough to check in full:

- The only writer of `league_transactions_raw` outside the test suite is
  `scripts/collect-league-transactions.mjs:34`.
- The only thing that invokes it is `scripts/refresh-live-data.mjs:99`, which
  spawns it as a child process.
- Nothing in `server/` invokes `refresh-live-data.mjs`. It appears in
  `report-cache.js:210` and `scheduler.js:1371` **in comments only**; every
  other reference is a test or its own usage line, which is a manual
  command-line invocation.
- The Dockerfile's only entry point is `CMD ["node", "server/index.js"]`, and
  **`fly.toml` has no `processes` section at all** — so there is no second
  process on Fly that could be running it.

Six server files read that table — `bluff-detector.js`,
`counterparty-pricing.js`, `manager-archetypes.js`, `manager-signals.js`,
`trade-engine.js`, `trade-tactics.js` — and all six read only. So every manager
read, archetype and counterparty price on the live app is computed from
whatever rows were last collected by hand, with no indication on any surface
that the data has an age. **Nothing here needs doing tonight and it is not a
deploy risk**; it is a morning decision about where that collector should run,
a scheduled worker on Fly or a cron job on his own machine, and the scheduler
thread has the recommendation.

**Why three scheduler PRs rather than one**, since each fixes a different link
and none of them is sufficient alone. **#56** stops the host's own health probe
arming the watchdog mid-boot; on its own the same jobs still wedge once it is
legitimately armed, so the cycle re-forms at a slower period. **#59** moves the
boot pass, the 90-second timer at `:1751` and the 150-second one at `:1754` off
the request thread, per job and behind a structural allow-list, with a test that
fails if main-thread boot work can exceed the watchdog threshold — which is what
stops this re-forming the next time somebody adds a job. **#61** stops the job
being handed the process again on the next boot. **#63** flags `offThread` on
the job's own entry, because #59's override reaches the boot path only: the
background tier calls `runIfStale` with no override, so on a box that stays up
the job would go back onto the request thread at its next six-hour tick and
block the loop again — roughly six hours after a deploy that looked like it had
worked, which is the worst possible time to see it. **Take out any one of the
four and the loop has a path back.**

**The root cause that #59 addresses, in one sentence, because it is the part
that will look already-handled to a reader.** The scheduler *does* have a job
budget — `DEFAULT_JOB_TIMEOUT_MS = 120_000` at `scheduler.js:1438` — but it is
applied as a `Promise.race`, and **a race cannot interrupt synchronous work**:
nothing else runs to notice the timer, so a blocking job burns straight through
its own 120-second budget while the watchdog's fuse is 60. The budget is not a
second line of defence here; it is a number that never gets read.

**And the fix does not depend on settling which of the two blockers lands the
kill**, because `nfl-model-growth.js` holds no module-level state, so it moves
off-thread cleanly whichever reading is right.

**What to expect after the deploy, so it is not misread as the cycle
continuing.** #59 stops the boot path blocking the event loop, and off the
request thread that work is CPU and a database lock rather than a kill — **so
the app will be busy for a minute or two after a boot and will answer the whole
time. Slow is the fixed state here; dark is not.**

**And that window is bounded rather than permanent, which is #61's job.**
`record()` stamps only after `run()` returns, so a job killed mid-run writes
nothing at all and its `sync_log` row survives exactly as the previous attempt
left it — which is why `last_run_at` has been frozen at 21:17:44Z with
`consecutive_failures: 1` across every life tonight. That is not a job failing
repeatedly; it is a job whose failure was never recorded once. #61 marks the
attempt before it runs and rewrites the leftover row at the next boot, so one
kill buys the ordinary five-minute backoff and the second boot does not re-run
it. Without #61 the busy window recurs on every boot forever; with it, it
recurs once and then backs off.

**Do not set `LOOP_WATCHDOG_THRESHOLD_MS`, and do not set
`LOOP_WATCHDOG_DISABLED=1`.** Both are read from the environment, both would
stop the restarts, and both would restore the silent stall of 16:08Z-19:25Z —
turning a machine that recovers into one that hangs and stays hung. The watchdog
is the only thing recovering this app.

**The trap, and it is a nasty one: the code recommends this wrong fix in its own
error text.** `loop-watchdog-worker.js:32-33` writes, as part of the kill
message, "If this is not a hung job, raise `LOOP_WATCHDOG_THRESHOLD_MS` or set
`LOOP_WATCHDOG_DISABLED=1`." That line will be the most authoritative-looking
thing in the log, and it is addressed to a case that is not this one — **this is
a hung job.** The answer is still no.

**Rolling back to the old image is a last resort, not an option to offer.** It
stops all 26 pull requests serving, it does not undo the migrations, and the
previous build had its own faults.

**Does the cycle endanger the database? Checked, not assumed.**

- **No corruption.** SQLite transactions are atomic, and a killed process's open
  transaction is rolled back by WAL recovery when the next one opens the file.
  A `SIGKILL` mid-write is exactly the case that is designed for.
- **Disk does not grow per restart.** `backupBeforeMigration` runs only when
  `pendingCount > 0`, and the migrations applied on the 22:09Z boot, so it is 0.
  The WAL is capped at 64 MB by `journal_size_limit`.
- **One `.bak` now exists**, written by that boot, roughly 445 MB on the 5 GB
  volume. It is the row-level rollback and must not be tidied.
- **The qualifier: job output can be incomplete.** A job writing many rows
  across separate transactions, killed halfway, leaves partial data rather than
  corruption. So: nothing is corrupted and no data is at risk; **that is not
  the same as nothing having been affected.**
- **And the counters understate it.** Seven jobs sit at exactly
  `consecutive_failures: 1` — one each, never two. An earlier version of this
  section read that as a counter reset by each restart. It is not: `record()`
  runs only after `run()` returns, so a job killed mid-run never reaches the
  line that would increment anything, and the row simply stays as the last
  completed attempt left it. **The counters are not a reset tally, they are a
  tally that stopped being written**, so **the failure counters are a floor on
  abandoned attempts, for the same reason as the restart count** in 7.0c-i —
  two numbers in front of you tonight, both understating, both because the
  thing that would have recorded the event never ran. #61 is the fix and the
  same reading is why.

### 7.0c-0 Where every claim in the block above comes from

Written because the block is going to be acted on by one person with a
terminal, and the difference between "measured on the live app" and "read off
the code and reasoned about" decides what he does when a step does not behave.
**Nothing here is a hedge on the plan; it is the plan saying which of its
sentences would survive being wrong about something else.**

| Claim | How we know | Who |
| --- | --- | --- |
| Actions allowance spent, 2,000/2,000, resets 1 Oct | Nick's own billing screenshot | Nick |
| The CI workflow is off, so a push triggers nothing | **Verified here**: one workflow, `state: disabled_manually` | this thread |
| No merge is gated on a check | Platform rule — private repo on Free has no branch protection. **Not verified against this repo's settings**, which no session can read | inferred |
| Each PR's suite numbers | Each PR body, its own author's local run before the allowance ran out | per thread |
| `#59 ⊃ #56`, `#61 ⊃ #59`, `#63 ⊃ #61` | **Verified here** by `git merge-base --is-ancestor`, not by the base GitHub shows | this thread |
| The blocking job is `nfl_model_growth` on the 90 s timer | **Measured on the live app**: last `uptime_s` before each dark window 95/97/93/91/94/88 across six lives, never near 66 | scheduler |
| The boot pass blocks ~23 s, under the fuse | **Measured**: request at 41 s answered at 64 s, control at 22 s answered in 0.35 s | Trade Brain |
| The two blocking steps, and only one can cause the 503 | **Read off `791b131`** and checked here — `nfl-advanced.js:199-200` has `BEGIN`, `nfl-event-archive.js` has none | this thread |
| `SCHEDULER_DISABLED=1` stops everything | **Read off `791b131`**: `scheduler.js:1732` returns before the boot pass and every timer | this thread |
| Step 6's 900 s bar | **Derived**, not measured: `intervalMinutes: 5` → a 300 s tier, doubled. No one has watched a stable box on the fixed build | inferred |
| What each of #56/#59/#61/#63 does | Their PR bodies, plus #59's diff read here | scheduler + this thread |
| 58 restarts, one per 180 s | **Counted here** at 01:45Z: a 60 s poll is below the cycle, so it is a count, not a floor. Clustered within 5 s; stable at every tolerance 1-5 s | this thread |
| The earlier "79 starts" and "171-376 s" | **Withdrawn.** 79 was the naive count `restart-count.sh` exists to prevent; 376 is not in the data, the widest gap is 196 s | this thread |
| Reads are phase-locked, so "72 s" means nothing | **Measured here**: 60 s poll into a 180 s cycle is 3 polls per cycle; 41 of 54 clean reads caught an age of 55-58 s, and none between 73 and 170 s | this thread |
| The loop blocks between age 94 and 110 | **Measured here** on eight consecutive lives, 01:50-02:13Z: onset inside (94, 110] on all eight, (94, 102] on five. `uptime_s` = age on every answered row, so each is one process throughout. `blind-window-probe.tsv` | this thread |
| It stops dead rather than slowing down | **Measured here**: 29 reads at age 78 or more across the eight lives, slowest 0.46 s. No ramp, so not memory pressure or gradual contention | this thread |
| The 02:04:41Z life's onset is (103, 110] | **Measured twice, independently**: their 60 s log read 103 at 0.43 s, this probe read 102 at 0.21 s one second earlier and nothing at 110. Different code, no shared state | Trade Brain + this thread |
| The onset varies ~16 s while the timer is flat | **Read off `791b131`**: the job downloads before it writes and a download does not hold the loop, so onset = 90 s + fetch time | this thread |
| The block is the 90 s timer at `scheduler.js:1751` | **Read off `791b131`** and now matched to the measured onset: the timer fires at 90, the job downloads (non-blocking) and then writes synchronously | this thread |
| Restart itself takes ~5-20 s | **Derived** from the eight measured cycles (167-179 s) minus onset 94-110 minus the 60 s fuse. The earlier "~30 s boot" was never measured and 90 + 60 + 30 = 180 matched the median by luck | this thread |
| Both wrong-base call sites are fixed | **Verified here** by content, not by PR number: #57 `7c27517` passes `coordinatorBase(weekProjection)`; `42bbbc3` passes `projection.structural_ppg` and nulls `corrected_ppg` when unfitted. Neither is merged yet | this thread |
| No surface changes when `corrected_ppg` goes null | **Verified here**: `drafts.js` widened to `?? ensemble_ppg ??`; a tree-wide search finds no other reader, including the untouched `routes/players.js:94` caller | this thread |
| TWO things start at t+90 s, not one | **Verified here on `791b131`**: `:1751`'s timer AND `tier('live', live, 90_000)` at `:1800` — `liveIntervalSeconds` is 90 and `index.js:75` passes only `intervalMinutes: 5`; `setInterval`, no leading call. 21 of 24 live jobs are on the request thread. **The onset cannot distinguish them** | this thread |
| No merged PR moves the live tier | **Verified here** by reading #59's and #63's diffs: #63 sets `offThread: true` on `nfl_model_growth`, the boot pass and the two timers only. So the deploy may not be sufficient | this thread |
| 22 background jobs have never run, not 19 | **Verified here**: 26 in the background tier, less 2 in `bootJobs` and 2 on their own timers = 18 growth + 4 metered. With 12 heavy gated off, 34 of 62 | scheduler + this thread |
| Nothing on Fly writes `league_transactions_raw` | **Verified here on `791b131`**: sole writer `collect-league-transactions.mjs:34`, reached only by `refresh-live-data.mjs:99`; no `server/` code invokes that script; Dockerfile CMD is `node server/index.js` and `fly.toml` declares no processes | scheduler + this thread |
| Any restart count taken before 22:49Z | A 300 s poll against a ~180 s cycle — **a floor, never a count** | Trade Brain |

**Three things below are not measured, and each has somewhere to go if it
turns out wrong.** If a merge turns out to be gated on a check after all, that is
the first one and the answer is Nick's settings page, not the code. If the app
dies between 300 and 900 seconds after step 6, that is the 900 s bar and the
answer is in the 22 never-run background jobs, not in the boot fix. If
the brake goes on and the restarts continue, it is not a row here that failed
but the diagnosis itself: the onset at 94-102 seconds is measured, and if
stopping the scheduler does not stop it then something outside the scheduler
holds the loop — at which point the six baseline reads below are the next
instrument, not another guess at which job it is.

### 7.0c-i Which job, and how it stopped being arithmetic

`bootJobs` at `scheduler.js:1740-1744` is exactly twenty jobs, **awaited in
series** at `:1746`, starting at `bootDelayMs` — default 20000 at `:1717`.

**An earlier version of this section said the chain stops between its
eighteenth and nineteenth job, at the wedge. That is refuted and withdrawn.**
In the 22:14:51Z life the chain **completed** — position 20 stamped
22:15:57.583, about 66 seconds in — and that process went on to live 255
seconds. So the serial chain is not what killed it. `beat_the_close` is also
not the blocker: it has a `last_run_at`, and `record()` only stamps after
`job.run()` returns.

**The candidate that replaces it, and the reasoning that had excluded it was
unsound.** `nfl_model_growth` fires on a fixed 90-second timer at `:1751`, is
tier `growth`, and resolves `off_thread` to **false** — a model fit on the main
thread. It was excluded on the grounds that it read `stale: false`, but that is
the wrong gate: the status payload's `stale` is `age >= maxAgeMinutes`
(`:1831`), while `runIfStale` gates on `age < nextDueMinutes` (`:1566-1567`),
and for `last_status === 'error'` that is
`min(RETRY_BASE_MINUTES * 2 ** (failures - 1), cadence)` with
`RETRY_BASE_MINUTES = 5` (`:141`, `:171-173`). With `consecutive_failures` 1 and
an age of 112 minutes, **it is due on every boot.** All verified on `791b131`.

**The chain it runs, read off the shipping tree, because "a model fit" is too
vague to act on.** `runNflModelGrowthCycle` (`nfl-model-growth.js:160`) checks
its required sources, and `weekly_player_usage` — table `player_week_usage`,
`required: true` (`:82-83`) — **has no 2026 rows on the live database**, so
`coreLag` at `:181` is true, opening the ingest branch at `:186`.

**The play-by-play parse is not the blocking step, and that correction is
Trade Brain's own.** `syncPbpSeason` at `:188` streams — gunzip piped into
`for await (const chunk of source)` at `nfl-pbp.js:410-415` — so the loop turns
between chunks; and in week 2 the 2026 file is one or two weeks of plays, not a
season. **The blocking steps are the two deliberate prior-season re-reads
further down the same branch**, both on `[season - 1, season]` — that is 2025
as well as 2026, every time:

- `snap_counts` at `:194` calls `syncSnaps([2025, 2026])`, and
  `nfl-advanced.js:199-200` writes a whole season in **one synchronous
  transaction** — `db.exec('BEGIN')`, then `for (const b of batch) stmt.run(…)`,
  then `COMMIT`, with no yield anywhere in the loop, on the order of 30,000
  statement runs.
- `verified_event_archive` at `:197-198` calls `syncVerifiedEventArchive({
  seasons: [2025, 2026], includeWeeklyRosters: true })`, and
  `nfl-event-archive.js:204-210` runs injuries, materialisation, trades and
  then weekly roster events across both seasons.

**One distinction inside that, which matters for the 503, and it runs the
opposite way to the intuition.** The snap-counts write is a single long
*exclusive* transaction. The weekly-roster writer is not: `syncWeeklyRosterEvents`
(`nfl-event-archive.js:150-199`) calls `insertEvent` per row in a tight
synchronous loop with **no `BEGIN`/`COMMIT` anywhere in the file**
(`grep -c` returns 0), so each row autocommits — and per-row autocommit is the
**slower** of the two for the same row count, because every commit is its own
fsync. So **the writer that holds no lock blocks the thread for longer, and the
writer that blocks for less wall time is the only one that can make `SELECT 1`
exceed the 15-second `busy_timeout` and throw.** Both matter and they fail
differently: the roster loop is the worse cause of the queueing, the snap-counts
transaction is the only candidate for the 503. A fix that moved only the archive
off-thread would leave the 503 exactly where it is.

**Why it never finishes and never gives up.** Both writers use
`ON CONFLICT … DO UPDATE`, so each restart rewrites the same 2025 rows and makes
no progress toward clearing `coreLag`. The 2026 rows that *would* clear it come
from `syncNflverse` at `:187`, first in the branch, which is the step that
errored at 21:17:44.

**And the stamping fix alone may not clear the gate either — a hedge from the
scheduler thread, checked here.** `coreLag` (`:181`) is
`sources.some(s => s.required && !s.current)`, and **four sources are
`required: true`** (`:76-:83`): `game_lines`, `nfl_team_week_features`,
`nfl_player_week_features` and `player_week_usage`. So a fix that makes the
usage stamp honest clears the gate **only if the other three are current on the
live box**, which nobody has read. The `/status` source view answers it in one
request on the morning after the app is stable. **Do not read the fix as
closing this.**

**And a second reason it would not converge even without the kills, found by
the fantasy plan in their RED/GREEN work and verified here on `791b131`.**
`syncNflverse` is `syncAll` (`nfl-model-growth.js:16`), and `syncAll`
(`nflverse.js:303`) stamps `recordSync('nflverse_weekly_usage', usage.error ?
'error' : 'ok', usage)` at `:312` — **`'ok'` whenever nothing threw, with no
reference to whether anything was inserted.** `syncWeeklyUsage` returns
`{ season, inserted }` (`:299`) and does not throw on zero. So a season that
downloads its file and writes no rows is recorded as a successful sync, which
is this project's whole failure mode in one line.

**One refinement on that, because the two halves apply to different callers.**
The same `:312` sits inside `for (const s of seasons)` at `:309`, so a
multi-season call stamps once per season and the last one wins — that is real,
and it is `POST /api/model/sync`'s problem, not the boot path's, which passes
`[season]`, one season (`:187`). **On the boot path the live defect is the
ok-with-nothing-inserted, not last-season-wins.** And the cause is *not* the
hardcoded `2021…2025` list in `routes/nfl-betting.js`: those defaults are off
the boot path entirely. The job is therefore due on every boot, does the expensive
part every boot, and is killed before the part that would end the cycle.


`setTimeout` at `:1751` is independent of the chain, which is fire-and-forget at
`:1746`, so the two overlap. And `record()` only stamps after `job.run()`
returns, so a process killed mid-job leaves `last_run_at` frozen — which is
exactly what `21:17:44.903Z` with failures stuck at 1 across four lives looks
like.

**This section said until 22:4xZ that naming the job needed the machine log. It
did not — it needed one field read across enough lives, and the scheduler thread
read it.** The last `uptime_s` served before each dark window was **95, 97, 93,
91, 94, 88** across six lives, and never near 66 seconds, where the boot chain
ends.

**That reading said the job was `nfl_model_growth` because "the only thing
scheduled at boot plus 90 seconds is `:1751`". Checked at 02:50Z on `791b131`,
that premise is false, and this is the most consequential correction in the
document.** Two things start at t+90 s, not one:

- `setTimeout(() => runIfStale('nfl_model_growth'), 90_000)` at `:1751`.
- `liveTimer = tier('live', live, liveIntervalSeconds * 1000)` at `:1800`.
  `liveIntervalSeconds` defaults to 90 and `index.js:75` does not override it
  (it passes `intervalMinutes: 5` and nothing else), and `tier()` is a plain
  `setInterval` with **no leading call** — so the live tier's first pass is at
  t+90 s exactly, alongside the timer.

**The live tier is 24 jobs, and 21 of them run on the request thread.** Only
`player_rosters`, `nfl_book_feeds_extra` and `evidence_daemon` declare
`offThread`, and `:1605` resolves the rest to false because
`job.offThread ?? job.tier === 'heavy'` is false for a live job. Several have
three- to five-minute cadences (`polymarket_line_watch`, `nfl_play_by_play`,
`prediction_markets`, `polymarket` at 3; `nfl_book_feeds_fast`,
`nfl_pick_watch`, `nfl_t60_runner` at 5), so they are due on essentially every
boot.

**And the scheduler's own comment at `:1732`, quoted earlier in this block,
names that tier as the previously-found cause of this exact symptom** — the
live tier's polling of a synchronous SQLite database "was found to be the
actual cause of the app going periodically unresponsive", written 2026-09-07.

**So the measured onset at 94-110 seconds is consistent with either, and the
evidence gathered tonight cannot tell them apart.** Both are due at 90. Both
are on the main thread. Both pre-date this release, which is why the stall was
already visible on the old build between 16:08 and 19:25Z. Nothing here
withdraws the measurement — the block, the bracket and the cliff all stand —
but the *attribution* to one named job does not follow from it.

**What this changes, and it is a real consequence for the morning: none of
#56, #59, #61 or #63 moves the live tier.** #63 sets `offThread: true` on
`nfl_model_growth`, on the boot pass and on the two named timers; verified by
reading its diff, neither it nor #59 alters `tier('live', ...)`,
`liveIntervalSeconds`, or any live job's flags. **So if the live tier is the
blocker, the deploy will not stop the cycle.**

**Read step 6 accordingly. If the app still dies around three minutes after the
brake comes off, that is NOT evidence the boot fix failed and it is not a
reason to roll back.** It means the other thing that starts at 90 seconds is
the one holding the loop, and the next move is to put the brake back on
(`SCHEDULER_DISABLED=1` returns before both, which is why step 1 works either
way) and take the live tier off the request thread as a follow-up. The four PRs
are still correct and still worth merging; what is not established is that they
are *sufficient*.

*The `nfl_model_growth_runs` query in step 3 becomes more useful under this
reading, not less: it is now a discriminator. A `running` row stamped about 90
seconds into a life says that job did start; the absence of one across several
lives points at the tier instead.*

**Two main-thread blockers stack in every life, and conflating them is what cost
the evening.** Trade Brain's own health log caught the earlier one directly: a
request issued 41 seconds into a life was not answered until about 64 seconds
in — the loop did not turn for at least 23 seconds — against a control 22
seconds into the next life answered in 0.35 s. `bootDelayMs` is 20000, so that
is the **boot pass**, and 23 seconds is under the 60-second fuse: it stutters,
it does not kill. The **90-second timer** is what kills. Both are on the request
thread and PR 2 covers both, plus `:1754`.

**What the variable part was.** A fixed 90-second timer cannot by itself produce
lives of 161, 178 and 255 seconds. A download of variable length in front of a
fixed block can: fire at 90, download for roughly 100, block from about 190,
killed near 250 against 252 observed. That is one arithmetic fit among several
the numbers admit, offered as the reason the spread is not evidence against the
timer rather than as proof of it.

**Restart timeline, start to start**, assembled from `uptime_s` alone with no
terminal: 22:09:00, 22:12:07, 22:14:51, 22:19:03, 22:27:34, 22:33:17, and
~22:39:15 — the last read here, from a request issued at 22:38:59Z that came
back with `uptime_s: 13` after 29.1 seconds.

**Every count taken this way is a floor, and the overnight figure must be
reported as one.** The only continuous observer is a poll every 300 seconds
against a cycle of roughly 160, so it misses restarts by construction: eight
starts were observed between 22:09:00 and 22:44:08 where the true figure is
nearer thirteen. Gaps that look out of family — the 511-second one above — are
more likely a missed sample than a stopped machine, and the honest phrasing in
the morning is **"at least N restarts"**, never N.

**A read that crossed a restart is void as a capture and useful as a clock.**
Its content cannot be attributed to the process that received the request, so a
capture must discard it — but the `uptime_s` on the response is the *new*
process's uptime at the moment it answered, so the derived start is sound, and
it pins a restart inside a known window. That makes a crossed read better
evidence for this timeline than a clean one.

**None of this changes the fix**, which is the point worth holding: the command
below stops the boot chain, both fixed timers and every tier at once, so it does
not depend on the job being named.

**A prediction this section carried until 22:4xZ is withdrawn, and the reason
it was wrong is the same reason the job was excluded in the first place.** It
said `nfl_model_growth` becomes stale at about 03:17Z and that the cycle would
therefore get worse in the small hours. That reads staleness off
`maxAgeMinutes`, and `runIfStale` does not use it: the gate is
`age < nextDueMinutes` (`:1566-1567`), which for a job whose last status is
`error` is five minutes. **The fit is already due on every boot and has been
since about 21:23Z.** Nothing changes overnight, and nothing about it needs
waking anybody. The general form is worth keeping: *two fields named for the
same idea, one of them not the one the code branches on.*

**What does not change either way:** the machine may still stop for good on
Fly's restart cap, which it has hit once already tonight. That is a stopped
machine rather than a damaged one, and the first command below starts it.

### 7.0d Found while looking at something else: two jobs that have never run

`manager_signals` (growth) and `manager_archetypes` (heavy) report
`scheduled_now: true` with **`last_run_at: never`** on the deployed build. Every
other job in the scheduler has a `last_run_at`. These are #26's two build jobs.

**This turned out to be a symptom of the cycle rather than a separate defect,
and the correction is worth more than the finding.** `scheduler.js:1801`
registers the background tier — growth, metered and heavy together — on
`intervalMinutes * 60000`, and `server/index.js:75` passes `intervalMinutes: 5`.
So the background tier fires at **300 seconds**, and no process on this build
has lived that long (160 to 255 seconds). **It has never fired once.** Every
growth, metered and heavy job outside the boot list has therefore run zero
times, which is exactly what Trade Brain saw.

So the manager layer is not broken; it has never had a chance to start. Once the
app stays up past five minutes these jobs should run on their own. Found by the
scheduler thread. **Worth checking once after the app is stable rather than
assuming either way** — "it will fix itself" is the kind of claim this document
exists to distrust.

### 7.0a Bracket every read with `uptime_s`, and void it if the machine restarted

`GET /api/health` is unauthenticated and returns `{"ok":true,"uptime_s":<n>}`.
Read it immediately before and immediately after every capture.

**If `uptime_s` at the end is smaller than the number of seconds the capture
took, the machine restarted during it and the read is void.** Re-run it. This
replaces believing that nothing restarted with detecting it after the fact, and
it costs one request.

**A single read can bracket itself, which is better still, and it was measured
rather than reasoned at 22:39Z.** A `curl` issued at 22:38:59Z returned 200 with
`uptime_s: 13` after **29.1 seconds**. A process 13 seconds old cannot have
received a request issued 29 seconds earlier, so that request was held at the
edge and replayed into a process that started *after it was sent*. **Whenever
`uptime_s` is smaller than that same request's own elapsed time, the read
crossed a restart** — no before-read needed, and `curl -w "%{time_total}"` is
the whole instrument. The read immediately before it, at 22:38:14Z, was a
**503 after 35.4 seconds**: the app's own catch (`health.js`), a live process
that could not answer. So the two signatures sit either side of one restart —
503-slow is the wedge, 200-with-impossible-`uptime_s` is the replay across it —
and neither is the empty-body 502 that means no instance at all.

It is not hypothetical. **The machine restarted at 22:12:07Z**, three minutes
after the app was first seen up at 22:09Z — read off `uptime_s: 53` at
22:13:00Z, with the transition caught directly as a 36.6-second empty-body 502
at 22:11:35Z followed by 200s in 0.15s. `fly secrets unset AUTO_HEAVY_SYNC`
restarts the machine and the timing fits, so it is almost certainly Nick's own
step rather than a fault.

**Why a restart is worse here than the usual lost warm cache.**
`routes/model.js` memoises `proj:` at `:404` and `:426` and `player-week:` at
`:443` under keys carrying **no seed and no fit id**. A restart busts them. So a
capture spanning a restart serves its early rows from one memo generation and
its later rows from another, with nothing in the file marking the seam — and
because the seam falls in the middle of a player list rather than at its edges,
it reads as a real effect rather than as damage. This matters most tomorrow,
when the step 8 restart is deliberate and every after-read must sit wholly on
one side of it.

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
#     Fix is `fly volumes extend`, not skipping the snapshot, and NEVER by
#     deleting a .bak to make room: that file is the row-level rollback, and
#     its presence means an earlier attempt already reached the migrations.
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
# 18. NO RESTART HERE. Use an unused seed instead. The simulate memo key
#     carries the seed (routes/model.js:527), so a fresh seed is computed
#     rather than served; fittedAvailability self-invalidates on row count
#     and fitted_at; trade-engine fingerprints on fitted_at; and the ?week=
#     routes call weeklyAvailability directly with no memo. A restart here
#     would re-run bootJobs, refresh nfl_injuries, and move the very numbers
#     the fit is being measured on. (Step 8 is the opposite case: proj: and
#     player-week: do NOT carry the seed, so that one needs the restart.)
#
#     Seeds 4 and 5 have never been used, so nothing can be served stale.
for S in 4 5; do
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://gridiron-hq.fly.dev/api/model/1/simulate?seed=$S&runs=2000&from_week=2" > ~/sim-after-fit-s$S.json
done

# 19. The two reads that actually show the fit, neither of them memoised.
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gridiron-hq.fly.dev/api/model/availability?week=2" > ~/avail-after-fit.json
#     Puka Nacua is the cleanest test in the plan: 0.324 is the FLOOR of the
#     constants' questionable range, so no constants path can go lower. Any
#     drop at all is unambiguously the fit.

# 20. Count the Start/Sit warnings again, per league. Before: 3 / 2 / 4 / 3 / 1.
#     They should FALL. A new chip on a healthy-prior starter is a finding.

# 21. LAST. Put the heavy tier back, only once every read above is captured.
#     fly secrets set restarts the machines again, so it must not land
#     mid-capture. If anything still looks unsettled, leave it and do it
#     tomorrow; nothing degrades while it is unset.
#     READ 10a FIRST. If no PR fixing the coordinator base has merged, SKIP
#     this line entirely. Leaving it unset changes nothing; running it starts
#     the refit, and a wrong-base fit written to the database is the one part
#     of this sheet that is not free to undo.
fly secrets set AUTO_HEAVY_SYNC=1 -a gridiron-hq
```

### Undo

```sql
-- Write 2. DROP, not DELETE: these tables do not exist on live today.
DROP TABLE nfl_availability_rates;
DROP TABLE nfl_availability_role_rates;

-- Write 1.
DELETE FROM shrinkage_k; DELETE FROM shrinkage_fits;   -- true undo: both empty before step 8
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
