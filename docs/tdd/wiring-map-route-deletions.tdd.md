# Route deletions, and two bugs that made the list wrong

2026-09-20. Branch `claude/wiring-map-8f96ur`.

**The five questions, answered first.**

1. **Is it well built?** The deletions are twenty-four routes across two files, each one
   checked by hand against the whole tree before it was cut. The two checker fixes are
   both RED-proved by injecting the old rule and watching a named test fail.
2. **Is it stats or made up?** Every row here is a grep or a test run, quoted with the
   file and line. No count in this file was carried over from an earlier message.
3. **How do we know?** By running the old rule and the new one on the same tree and
   diffing the findings, and by injecting each defect back and confirming the test
   goes red. Both diffs are reproduced below.
4. **Is it pointed anywhere else on the platform?** Yes, and that is the important
   part: the second bug had nine live routes on the dead list, in four other threads'
   files. Every thread's deletion list was wrong until this landed.
5. **How does it unify?** One matcher and one outbound scan now answer "does anything
   call this route" for every owner, so a route is cut from one list instead of from
   each owner's memory.

---

## 1. The bug that would have deleted live code

`route-no-caller` had nine routes on it that a script in this repository dials over
HTTP on every fresh install.

`scripts/bootstrap-data.mjs:104`:

```js
await run(`Weekly boxscores ${s}`, `/api/edge/gamelogs/sync?season=${s}&limit=400`);
```

`outboundUrlPaths` had two patterns and both needed a marker to the LEFT of the path —
a `}` closing an interpolation (`${origin}/api/x`) or a `://` (`https://host/api/x`).
Here the literal comes first and the interpolation is in the query string, so neither
fired and the route read as dead.

Retracted, with the line that dials each one:

| route | dialled at |
|---|---|
| `POST /api/nfl/sync-all` | `scripts/bootstrap-data.mjs:97` |
| `POST /api/stats/sync` | `:101` |
| `POST /api/aggregates/refresh-all` | `:102` |
| `POST /api/edge/gamelogs/sync` | `:104` |
| `POST /api/tradelab/trending/sync` | `:106` |
| `POST /api/nfl-betting/roster/rookies/sync` | `:110` |
| `POST /api/nfl-betting/roster/rookies/college-sync` | `:113` |
| `POST /api/league-chat/upload` | another script |
| `GET`+`POST /api/auth/tunnel-url` | another script |

`POST /api/aggregates/refresh-all` is in another thread's file and was on the delete
list because this map put it there. Deleting it stops a fresh install loading ADP,
market values and news.

**What actually caught it was not the checker.** It was the deletion rule's own
"unless a repo script calls it" clause, run by hand on each route before cutting. The
clause is the backstop, not a formality.

**The fix, and what it deliberately does not do.** The new scan reads only string
LITERAL bodies, and only in the script tree. A path spelled out in a comment, a
runbook or a test asserting a 404 is somebody *naming* a route, not dialling it, and
suppressing a real finding on a sentence would be the same silent over-reach that
`accepted_orphan_modules` was being used for. Verified: `/api/dev/llm-budget` appears
once in the tree, at `docs/tdd/llm-plumbing.tdd.md:104`, as a recommendation that
someone *should* wire a route — and `GET /api/dev/usage` and its three siblings are
still reported dead after the fix, exactly as they should be.

RED proof: delete the six-line scan, and `test/wiring-map.test.js` test 62
("outboundUrlPaths sees a path that starts the string, not only one that follows a
marker") fails; 61 pass. Restore it: 62 pass.

## 2. The bug that named the wrong endpoint

`GET /api/model/ask/:capability` was reported as called. Nothing calls it. The map
said something did, and named no file, because suppression happens before evidence is
collected — so the endpoint simply vanished from the report with nothing to check.

The suppressor was `client/src/components/TradeCard.tsx:179`, which calls
`/api/model/:p/trade-impact`. The old matcher excused a segment if EITHER side was a
wildcard:

```
route  /api  /model  /ask   /:capability
call   /api  /model  /:p    /trade-impact
              same    ↑ excused by the call's :p
                             ↑ excused by the route's :capability
```

Two wildcards sliding past each other in opposite directions, matching two endpoints
that have nothing to do with one another.

They are not the same kind of wildcard, which is the whole fix. A route's `:id` is a
declared parameter. A call's `:p` is an interpolation the extractor could not read.
Either one being looser than the other is ordinary and correct — a call may pass `DAL`
where the route declares `:abbr`, and a call may interpolate where the route has a
literal. When BOTH happen in one comparison the two paths disagree about where the
variable part of the endpoint is, and no substitution makes them the same URL. Only
that crossing is rejected.

It costs nothing: `client-call-without-route` and `destination-without-route` are both
still **0**, so no honest match was broken.

RED proof: replace the return with `return true` (the old rule) and test 61 fails; 60
pass. Restore: 61 pass.

Five routes it revealed, each verified by direct grep as having zero references in any
tree:

```
GET /api/model/projections/:playerId   server/routes/model.js:418
GET /api/model/cascade/:playerId       server/routes/model.js:573
GET /api/model/game-script/:team       server/routes/model.js:691
GET /api/model/ask/:capability         server/routes/model.js:739
GET /api/trades/splits/:playerId       server/routes/trades.js:992   (Trade Brain's file)
```

## 3. The counts, and why they moved four times

| count | why it changed |
|---|---|
| 77 | before this branch |
| 80 | unrouted pages stopped counting as callers — a page nothing imports cannot call anything |
| 85 | the crossing rejection stopped a route being excused by a different endpoint |
| **63** | the leading-literal scan gave nine routes their real callers back |

`route-no-caller`: **388 total, 63 in-scope**. `route-called-from-outside-the-app`:
**11**. Both read off `docs/wiring/wiring-map.json` at this head.

## 4. What was deleted

**`server/routes/model.js`, 33 routes to 15, and 30 imports went with them.**

Sixteen were the read endpoints of `client/src/pages/Model.tsx` — a page no file
imports and no `<Route>` declares. `/accuracy`, `/correlations`, `/gamescript`,
`/handcuffs`, `/availability`, `/status` were its callers. The rest had no caller in
any tree: `/state`, `/map`, `/ask/:capability`, `/heads`, `/consensus`,
`/game-script`, `/game-script/:team`, `/game-script-fit`, `/cascade/:playerId`,
`/projections/:playerId`, and both `/weekly-learning` routes.

No capability was removed. The weekly learning cycle still runs from
`scheduler.js:499`; the model heads are still read by `nfl-unified-engine.js`. What
went is HTTP surface.

**`server/routes/edge.js`, 13 routes to 7.** `/movers`, `/volatility`,
`/schedule-edge` and `/efficiency` were read only by `client/src/pages/Edge.tsx`,
also unrouted; `/board` and `/sparklines` had no reader anywhere. `vorBoard()`,
`volatility()` and `scheduleEdge()` are untouched.

**`server/index.js`, two lines** — the decision-inbox import and mount. This is a
one-editor exception, taken deliberately: the file belongs to the scheduler thread,
whose stack merges first, and splitting these two lines from the route deletion would
leave a window with the mount gone and the routes present that no test would catch,
because both decision-inbox test files mount the router on an app they build
themselves. `test/decision-inbox-retired.test.js` now closes all three ways it could
rot — a route coming back, the import being left behind, or the module being deleted
and breaking `waiver-brain.js:38` and `trade-engine.js:59`.

### Kept on purpose, with the row left visible

`route-no-caller` is report-only, so these stay in the report rather than going into
`annotations.json`. "Nothing calls this" is true of all of them and a reader should
see the row and the reason together.

- **`GET /api/model/projections`** — its caller is a person following
  `docs/RUNBOOK-promote-volume-shrinkage.md:233`, which says to read it before and
  after the promotion and compare. A runbook step is a caller with someone at the
  keyboard, and that runbook is scheduled to run.
- **The eight `/registry` write routes** — the whole HTTP surface of the model
  registry: register a dataset, declare a feature set, open an experiment, record a
  backtest, open a holdout, promote, roll back. The orphan is the PANEL
  (`client/src/features/model-lab/ModelRegistryPanel.tsx`, imported by nothing), not
  the API. Deleting a governed promote/rollback pair because its admin page lost its
  `<Route>` would remove a capability to tidy a report. The fix is to route the panel,
  which is a client change.
- **`POST /api/edge/trade`** — a deliberate 410 tombstone that names the endpoint to
  use instead. Deleting it turns a 410 that explains itself into a bare 404.

## 5. Two things the deletions surfaced that are worth more than the deletions

**A silent behaviour loss, caught and fixed.** `expireStale()` in
`decision-inbox.js` was called before every read, and the reads were the four deleted
routes. Without a new caller nothing would ever mark a row expired again and every
lapsed recommendation would read as `open` forever — to Coach, which reads that table
directly. The sweep now hangs off `publishRecommendation`, which the two wired-in
engines call on every lineup and waiver recompute, so it fires at least as often as
the reads it used to hang off. RED proof: remove the call and
`test/decision-inbox.test.js` test 7 fails.

Said plainly, because the deletion did not cause it but did expose it: `POST
/:id/resolve` was the only thing that could set `status`, `resolved_at` or `outcome`,
and nothing called it either. No row has ever been resolved. Rows leave `open` only by
expiring. Whoever gives this table a reader owns giving it a way to drain.

**One name, two sources, different argument orders.** Deleting the three
`/game-script*` routes orphaned `server/services/vegas-fantasy.js` entirely — they
were its only importers. It is real measured work (implied team total against skill
fantasy output, r = 0.41 over 2,106 team-weeks since 2022, monotone across every
bucket), so it is listed rather than deleted: throwing away a fitted model to close a
report is not a wiring cleanup's call.

The hazard found on the way: `server/services/gamescript.js` exports `fitGameScript`,
`gameScriptFor` and `clearGameScriptCache` **too**, and `gameScriptFor` takes
`(team, season, week)` there against `(season, week, team, opts)` here.
`routes/model.js` imported from both files at once. Anyone wiring this up by
autocompleting the name gets silently wrong answers and no error.

**A third thing, small.** `accepted_orphan_modules` had no check that its entries name
files that exist, while `_PERMANENT_ORPHAN_REASONS._why` already said a listed module
past its retirement condition "is a defect in this file". `--check` now reports
entries naming a missing path. Report-only, never gating: an entry can legitimately
run ahead of a branch, and failing a build on a merge-order accident would teach
people to delete the entry instead of landing the file.

## 6. Corrections to things this thread said earlier tonight

- **`/api/edge/gamelogs/sync` was on my own delete list.** It is dialled by
  `bootstrap-data.mjs:104`. Withdrawn.
- **`GET /api/aggregates` and `POST /api/aggregates/refresh-all` were sent to the
  feature-audit thread as dead.** `refresh-all` is dialled by `bootstrap-data.mjs:102`.
  Withdrawn; `GET /api/aggregates` stands.
- **"Delete `server/routes/edge.js`"**, which came in as an instruction, was wrong and
  was not done. Four live consumers import from it: `trade-engine.js:55`,
  `draft-survival.js:24`, `server/scripts/sync-history.js:8`, `tradelab.js:4`.

## 7. The gate

`npm run check` exit 0 · `test/wiring-map.test.js` 62/62 ·
`test/decision-inbox.test.js` 11/11 · `test/decision-inbox-retired.test.js` 3/3 ·
full suite 0 fail · `npm run start:smoke` passed on an isolated database ·
`node scripts/wiring-map.mjs --check` reports no missing-feed findings.

---

## 8. Two more rule fixes, from other threads' checks

### A column DEFAULT is a writer, and this rule GATES

`column-read-never-written` read INSERT and UPDATE column lists. A DEFAULT appears in
neither, so two columns that every insert stamps automatically were reported as null
on every row forever:

- `draft_pick_quarantine.first_seen_at` — `TEXT DEFAULT (datetime('now'))`,
  `server/db/schema/core-and-fantasy.js:562`, read at `draft-reconcile.js:168`
- `draft_pick_corrections.applied_at` — same shape, `:579`, read at `:173`

Both false, on a rule that can fail a build. Fixed by counting a non-null DEFAULT, and
a generated column, as a writer. `DEFAULT NULL` is deliberately excluded: it writes the
same nothing the rule is complaining about, so counting it would silence a true
finding. Triggers needed no case — a trigger body is SQL inside the same string
literal as its `CREATE TRIGGER`, so its `INSERT INTO t(a,b,c)` was already read as a
write.

`column-read-never-written` goes **3 → 1**. The survivor is `players.bye_week`
(`core-and-fantasy.js:94`, `bye_week INTEGER`, no default), read at
`draft-assist.js:202` and `:885`. It is real and it stands.

RED proof: make the scan count `DEFAULT NULL` too and test 63 fails.

### One name, two modules — the inverse of `two-names-different-sources`

`two-names-different-sources` catches two names in one file answering the same
question from different sources. The mirror image was not caught at all: the same
exported name in two modules meaning different things. There is nothing to notice at
the call site — the import line looks ordinary, the call compiles, the answer is
wrong, and no error is raised.

New rule `same-name-two-modules`. **31 in-scope rows, 46 total.** It independently
reproduces both cases that prompted it:

```
gameScriptFor()   gamescript.js:389  vs  vegas-fantasy.js:124    (team,season,week) vs (season,week,team,opts)
fitGameScript()   gamescript.js:331  vs  vegas-fantasy.js:58
buildSeasonRows() opportunity-model.js:135 vs preseason-model.js:595
```

**The filter is the rule.** Written without it, it produced **1,895 rows**: `down()`
in forty migrations, `alters()` in every schema file, `cacheStatus()` in three caches.
Those are interface conventions a family implements on purpose, and nobody reaching
for `down` is confused about which module they mean. A name in exactly two modules is
the opposite — nothing declares it a family, so nobody is warned. Reporting only those,
and only when the two take different arguments or read different tables, and only when
neither imports the other, takes it to 31 readable rows. That single line is the
difference between a rule and a wall of text, and this checker has already died of the
second once. `test/wiring-map.test.js` test 64 asserts all three guards are still in
the source.

### A row withdrawn rather than defended

`drafts.js:1221`, "`draft_advice` never scheduled", is not a defect: the table is read
at `drafts.js:996`, keyed `(draft_id, pick_number)` with `ON CONFLICT UPDATE`, and
bounded by the number of picks. Withdrawn.
