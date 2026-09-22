# Honest-inventory evidence — chat-sync's allocated files

Per `docs/inventory/CONTRACT.md` (Opportunity, commit `08be6e1`). **This file
supplies evidence only — no category.** §6: the author of a file gives the
counts, commands and entry points; a second thread (wiring map or the
Auditor) assigns the category. Nothing below is graded.

**Ref for every row**: `42478b1714605a42f51bef882757fb2e77e43542`
(`claude/project-thread-sytruo-asof-rebase`, pushed). A row measured here is a
reading of that tree, not a statement about `main`.

**The two-count command, run for every symbol below** (per §3 of the contract):
```
git grep -c "\bSYMBOL\b" <ref> -- server client scripts test           # used at all (with-defining-file)
git grep -c "\bSYMBOL\b" <ref> -- server client scripts \
  | grep -v "<defining file>"                                          # imported elsewhere, PRODUCTION ONLY (without)
```
Counted as line-matches summed across files, not file-count. A generic English
word as a symbol name (`status`, `freshness`) makes the raw count noise — noted
per-row where it applies, with a precise import-grep substituted as the real
evidence, per the contract's own warning in §3.

**Scope correction, after this file's first pass.** The "without" column
originally included `test` in its paths, same as "with." That put a
test-inclusive raw count next to a reachability verdict that (correctly, per
§2's `decoration` test: "Tests do not count as consumers") already excludes
tests — two different questions sharing one number, caught by the Evidence
Auditor. The "without" column now excludes `test` as well as the defining
file, so both halves of the pair answer the same question. The "with" column
is unchanged: it is the raw "used at all" count and still includes `test`
per the contract's own two-count command above. Where "with" and a
repo-wide, unrestricted grep (including `docs/`) disagree by more than the
defining-file/test difference already accounts for — as happened once,
`archetypesFor` read 21 here against a repo-wide 22 the Auditor ran without
excluding `docs/` — that is a scope difference in which paths were searched,
not an arithmetic error, and is noted on the row rather than chased further.

Files covered: `server/services/league-chat-sync.js`, `manager-archetypes.js`,
`league-history.js`, `bluff-detector.js`, and their migrations/scripts.

---

## server/services/league-chat-sync.js

Mounted path: `server/routes/league-chat.js` imports `{ status, pull,
corpusStats }` (line 30) → `server/index.js:128` mounts it at
`app.use('/api/league-chat', ...)` → `client/src/components/LeagueChatPull.tsx`
calls `/league-chat/status` and `/league-chat/pull`. Also reached over HTTP
(not a JS import) by `scripts/chat-sync.mjs` (`npm run chat:sync`), which
`fetch()`s `${HOST}/api/league-chat/status` and `/upload` against a running
server — a second, independent entry point onto the same route.

| symbol | file:line | consumers (with/without) | reached from | evidence |
|---|---|---|---|---|
| `status` | `:312` | 2621/2621 raw (word too generic — see note) | `routes/league-chat.js:30` import → mounted `/api/league-chat` (`server/index.js:128`) → `LeagueChatPull.tsx:41` `api('/league-chat/status')` | Raw count useless (`status` matches thousands of unrelated identifiers). Precise: `git grep -n "from '.*league-chat-sync" 42478b1 -- server client scripts` → exactly one hit, `routes/league-chat.js:30`, naming `status` explicitly. |
| `pull` | `:336` | 114/114 raw (generic word, same caveat) | same route import → `LeagueChatPull.tsx:47` `POST /league-chat/pull` | Same precise-import evidence as `status`, same line. |
| `corpusStats` | `:86` | 25/2 | (a) `routes/league-chat.js:30` import, called again directly at `:160` `corpus: corpusStats()`; (b) internally by `status()` (`:313`) and `pull()` (`:360`) | `git grep -n "\bcorpusStats\b" 42478b1 -- server client scripts` → `routes/league-chat.js:30,160`; `server/services/league-chat-sync.js:313,360` (defining file). |
| `freshness` | `:179` | 92/92 raw, but the word is used unrelated in betting code (`teaser-scan.js`, `props.js`, `source-registry.js`, etc.) — **not this function** | internal only: called once, inside `status()` at `:320` | `git grep -n "from '.*league-chat-sync" 42478b1 -- server client` does not name `freshness` — the route imports only `status, pull, corpusStats`. No production file imports `freshness` directly; it is reached only as a private step inside the wired `status()`. Directly imported and called by 6+ test files (`test/chat-block-wiring.test.js`, `test/chat-age.test.js`, `test/wiring-absent-states.test.js`, `test/league-chat-sync.test.js`, this thread's own tests), which are not consumers per §2's `decoration` test. |
| `extractionCapability` | `:47` | 5/0 | internal only: called inside `status()` (`:316`) and `pull()` (`:337`) | `git grep -n "\bextractionCapability\b" 42478b1 -- server client scripts` → 2 hits, both `server/services/league-chat-sync.js:316,337` (defining file). Zero outside it in production. |
| `lastPull` | `:73` | 3/0 | internal only: called inside `status()` (`:314`) | `git grep -n "\blastPull\b" 42478b1 -- server client scripts` → 1 hit outside test, `server/services/league-chat-sync.js:314` (defining file). |
| `messagesDbPath` | `:34` | 2/0 | internal only: called inside `extractionCapability()` (`:52`) | `git grep -n "\bmessagesDbPath\b" 42478b1 -- server client scripts` → 1 hit, `:52` (defining file). |
| `isoStamp` | `:161` | 9/0 | internal only: called 6 times inside `corpusStats()`/`freshness()`/`pull()` in the same file | `git grep -n "\bisoStamp\b" 42478b1 -- server client scripts` → all hits in `server/services/league-chat-sync.js` (defining file); zero elsewhere in production. |
| `CHAT_COLLECTOR` | `:145` | 2/0 | internal only: assigned into `corpusStats()`'s `out.collected_by` (`:135`) | `git grep -n "\bCHAT_COLLECTOR\b" 42478b1 -- server client scripts` → 1 hit, `:135` (defining file). |
| `STATE_MAPPING` | `:294` | 4/4, **all in test files** | **none found** — not read by `status()`, `freshness()`, or any other function in this file | `git grep -n "\bSTATE_MAPPING\b" 42478b1 -- server client scripts` → **zero** hits outside `test/`. `status()`'s full return object (`:312-320`) does not reference it. This is a documentation-shaped constant (maps internal state names to the badge vocabulary) that nothing in the running app reads. |

---

## server/services/manager-archetypes.js

Two independent reach paths exist for this file, and most symbols are private
to one or the other:

- **Path A (build)**: `scripts/build-manager-archetypes.mjs` (a `package.json`
  script, `build:manager-archetypes`) does `await import(...)` and is ALSO
  spawned automatically in production by `scheduler.js:719-721`
  (`refreshManagerArchetypes`, job `manager_archetypes`, tier `heavy`,
  `maxAgeMinutes: 1440`) via `execFile`. This is the only writer of
  `manager_archetypes` / `manager_archetype_jev` (see `docs/tdd/archetype-as-of.tdd.md`
  Part 8's header comment, verified there).
- **Path B (read)**: `server/routes/trades.js:501` does `await import(...)` →
  `archetypesFor` → mounted at `/api/trades` (`server/index.js:126`).

| symbol | file:line | consumers (with/without) | reached from | evidence |
|---|---|---|---|---|
| `buildManagerArchetypes` | `:617` | 13/2 | Path A: `scripts/build-manager-archetypes.mjs:60` → npm script `build:manager-archetypes` AND `scheduler.js:719-721`'s `execFile` spawn of that same script, job `manager_archetypes` | `git grep -n "\bbuildManagerArchetypes\b" 42478b1 -- server scripts` → `scripts/build-manager-archetypes.mjs:42,60`; `server/services/scheduler.js` does not name it directly (spawns the script as a subprocess, not a JS import) — traced via `scheduler.js:719-721`'s `execFile(process.execPath, [script, '--json'], ...)` where `script = 'scripts/build-manager-archetypes.mjs'`. |
| `archetypesFor` | `:1168` | 21/3 | Path B: `routes/trades.js:501-502` → mounted `/api/trades` | `git grep -n "\barchetypesFor\b" 42478b1 -- server client scripts` → `routes/trades.js:501,502` outside the defining file. |
| `archetypeEvidenceBuilt` | `:1074` | 20/0 | **not found reached from any route, job, or script** — every non-test, non-defining-file hit is inside `docs/tdd/*.md` prose | `git grep -n "\barchetypesBuilt\b" 42478b1 -- server client scripts` → zero hits (checked: the file has no `.md` under those paths, so this is empty). All 20 raw hits are in `test/archetype-as-of.test.js`, `test/league-history-absent.test.js`, `test/league-draft-picks-absent.test.js`, and `docs/tdd/archetype-as-of.tdd.md` (excluded from the grep paths, so not even counted above). **No production caller found — and the reason is now known, see note below, not left open.** |
| `managerProfile` | `:912` | 60/42 | **corrected mid-pass — see note below.** `archetypesFor()` (`:1183`) and `jevStateFor()` (`:1211`) both call it directly, and `archetypesFor` is Path B (`routes/trades.js:501`, mounted `/api/trades`) | First pass excluded the defining file and reported "no caller" — exactly the §3 trap the contract names, caught here by re-reading the excluded half. `grep -n "managerProfile(" server/services/manager-archetypes.js` → real call sites at `:1183` and `:1211`, both inside functions already confirmed wired. Corrected: **has a wired path**, transitively through `archetypesFor`. |
| `consensusFor` | `:158` | 3/3, all test | **corrected mid-pass, same trap.** Called at `:178` inside the private `consensus()` cache wrapper, which `draftSeason()` uses throughout, and `draftSeason()` runs inside `buildManagerArchetypes()` (Path A) | First pass reported "none in production" from the defining-file-excluded count alone. `grep -n "consensusFor(" server/services/manager-archetypes.js` → `:178`, `if (!consensusCache.has(season)) consensusCache.set(season, consensusFor(season));` inside `const consensus = season => {...}` (`:177`), which `draftSeason()` calls by that shorter name. Corrected: **has a wired path**, transitively through `buildManagerArchetypes`. |
| `leagueHistoryState` | `:277` | 13/0 | internal: called by `managerProfile()` (`:935`), `teamMembersState()` (`:295`), `archetypesFor()` (`:1179`, guard), `builtBlock` (Part 8b, `:1120`) — all within this file | `git grep -n "\bleagueHistoryState\b" 42478b1 -- server client scripts` → zero outside defining file in production. Reached in production transitively: `archetypesFor()` calls it directly at `:1179` and is itself wired (`routes/trades.js:501`), so this has a confirmed wired path — same correction as `managerProfile`/`consensusFor` below. |
| `teamMembersState` | `:294` | 4/4, all test + defining file | `teamMembers()` (`:241`) wraps it; `teamMembers()` is called inside `draftSeason()` (`:417`) and inside `buildManagerArchetypes()`'s `membersByTeam` closure (`:644`) — both Path A | `grep -n "teamMembers(" server/services/manager-archetypes.js` → `:417,644`, both reached from `buildManagerArchetypes()` (Path A, confirmed wired). **Has a wired path**, not directly imported anywhere. |
| `LEAGUE_HISTORY_TABLE` / `LEAGUE_HISTORY_SOURCE` | `:262` / `:264` | 4/4 each, all test + defining file | Read inside `leagueHistoryState()` itself (`:279-285`) and again inside `builtBlock()` (`:1122,1124`, the gap message) — `builtBlock()` is called from `archetypesFor()`, Path B | `grep -n "LEAGUE_HISTORY_TABLE\|LEAGUE_HISTORY_SOURCE" server/services/manager-archetypes.js` → real uses at `:279,280,283,285` (inside `leagueHistoryState()`) and `:1122,1124` (inside `builtBlock()`, wired via `archetypesFor()`). **Has a wired path.** |
| `leagueDraftPicksState` | `:598` | 6/6, test + defining file | Called at the top of `buildManagerArchetypes()` (`:623`, this thread's own fix, commit `daf579b`) | `grep -n "leagueDraftPicksState(" server/services/manager-archetypes.js` → `:623` (defining file). **Has a wired path**, through `buildManagerArchetypes` (Path A, confirmed wired above). |
| `LEAGUE_DRAFT_PICKS_TABLE` / `LEAGUE_DRAFT_PICKS_SOURCE` | `:589` / `:591` | 3/3 each | Read inside `leagueDraftPicksState()` (`:600-606`), same wired chain as above | `grep -n "LEAGUE_DRAFT_PICKS_TABLE\|LEAGUE_DRAFT_PICKS_SOURCE" server/services/manager-archetypes.js` → real uses at `:600,601,604,606`, inside `leagueDraftPicksState()`. **Has a wired path.** |
| `splitHalfReliability` | `:743` | 5/2 | Path A: `scripts/build-manager-archetypes.mjs:42,61` | `git grep -n "\bsplitHalfReliability\b" 42478b1 -- server scripts` → `:42,61`, called (`const reliability = splitHalfReliability(summary.detail)`). |
| `metricRepeatability` | `:808` | 6/2 | Path A: `scripts/build-manager-archetypes.mjs:42,62` | Same pattern — imported and called (`:62`). |
| `jevStateFor` | `:1210` | 5/3 | Path A: `scripts/build-manager-archetypes.mjs:43,129`, called | Same pattern — imported and called. |
| `JEV_QUESTIONS` | `:1291` | 6/4 | Path A: `scripts/build-manager-archetypes.mjs:43,154,204,220`, read (not just imported) | Confirmed a real read, not a dead import: `Object.entries(JEV_QUESTIONS)` at `:154`, `Object.keys(JEV_QUESTIONS)` at `:204`. |
| `storeJevAnswers` | `:1375` | 7/2 | Path A: `scripts/build-manager-archetypes.mjs:43,160`, called (`--jev` flag only — opt-in, needs `AI_GATEWAY_API_KEY`) | `git grep -n "\bstoreJevAnswers\b" 42478b1 -- server scripts` → `:43,160`. The call site is inside the `WANT_JEV` branch, so this path is wired but conditional on a flag most runs don't pass. |
| `MANAGER_ARCHETYPE_VERSION` | `:58` | 18/4 | Path A (`scripts/build-manager-archetypes.mjs`, 4 uses) + internal (used throughout the file as the row-version key) | `git grep -n "\bMANAGER_ARCHETYPE_VERSION\b" 42478b1 -- server scripts` → 4 hits in `scripts/build-manager-archetypes.mjs`, real reads (a `WHERE version = ?` bind and a console.log). |
| `ARCHETYPE_BUILDER` | `:959` | 3/3, all test + defining file | Used inside `builtBlock()` (`:1149`, `built_by: ARCHETYPE_BUILDER`), which `archetypesFor()` calls directly (Path B, wired) | Same trap as `managerProfile`/`consensusFor` above, caught the same way: `grep -n "ARCHETYPE_BUILDER" server/services/manager-archetypes.js` → real use at `:1149`, inside `builtBlock()`, which `archetypesFor()` calls with its own `ls/career/priced/stale` from `builtStamps()`. **Corrected: has a wired path.** |
| `PRICED_SOURCES` | `:978` | 7/0 | Used inside `builtStamps()` (`:1094-1095`, the `source IN (...)` filter) and `builtBlock()` (`:1138`, gap message) — both called from `archetypesFor()` (wired) | `grep -n "PRICED_SOURCES" server/services/manager-archetypes.js` → real uses at `:1094,1095,1138`, all inside functions `archetypesFor()` calls directly. **Corrected: has a wired path**, same family of miss as the three rows above it. |
| `WHY_UNSCHEDULED` | `:997` | 5/5, all test + defining file | **none — confirmed genuinely unused, not even internally** | `grep -n "WHY_UNSCHEDULED" server/services/manager-archetypes.js` → **only the `export const` line itself**, no second reference anywhere in the file. Unlike the four rows above, this one is not a trap artifact — it really is declared and never read, by anything, in or out of the defining file. |
| `RUN_SHEET_ONLY_METRICS` / `RUN_SHEET_ONLY_REASON` | `:1016` / `:1018` | 4/4, 3/3 | **none — same confirmed-unused status as `WHY_UNSCHEDULED`** | `grep -n "RUN_SHEET_ONLY_METRICS\|RUN_SHEET_ONLY_REASON" server/services/manager-archetypes.js` → only their own `export const` lines, no second reference in the file. |

---

## server/services/league-history.js

Single reach path: `backfillLeagueHistory` is the only externally-called
symbol. Everything else is a private step inside it.

| symbol | file:line | consumers (with/without) | reached from | evidence |
|---|---|---|---|---|
| `backfillLeagueHistory` | `:197` | 9/4 | (a) `scheduler.js:752`, job `league_history` (tier `growth`, `maxAgeMinutes: 720`) — **automatic, production, in-process**; (b) `scripts/backfill-league-history.mjs:26,34` — manual CLI, no `package.json` entry, run by hand per its own usage docstring | `git grep -n "\bbackfillLeagueHistory\b" 42478b1 -- server scripts` → `server/services/scheduler.js:752`, `scripts/backfill-league-history.mjs:26,34`. Scheduler path confirmed a real call, not just an import: `return backfillLeagueHistory();` at `:753`. |
| `seasonsToFetch` | `:81` | 9/1 | internal: called inside `backfillLeagueHistory()` | `git grep -n "\bseasonsToFetch\b" 42478b1 -- server scripts` → 1 hit outside test/defining-file: `test/league-history-schedule.test.js:31` (a test import, not production). |
| `historyLeagues` / `fetchView` / `saveScores` / `saveTeams` | `:59` / `:102` / `:113` / `:143` | 2/2 each | internal only, each called once inside `backfillLeagueHistory()`'s loop | `git grep -n "\bhistoryLeagues\b" 42478b1 -- server client scripts` (and same for the other three) → zero outside defining file. |
| `HISTORY_SEASON_WINDOW` | `:45` | 2/0 | internal only, used in `seasonsToFetch()` (`:84`) | `git grep -n "\bHISTORY_SEASON_WINDOW\b" 42478b1 -- server client scripts` → zero outside defining file. |
| `PACE_MS` | `:53` | 2/0 | internal only, default value for `backfillLeagueHistory`'s `paceMs` param (`:198`) | Same — zero outside defining file. |

**Note carried from `manager-archetypes.js`**: this file's own migration comment
(`server/migrations/064_league_history_tables.js:19`, verified earlier this
thread) says `league_draft_picks` is "owned by
`scripts/collect-league-transactions.mjs`'s sibling collector" — checked
independently and **wrong**: that script creates only `league_transactions_raw`.
No table-creation site for `league_draft_picks` exists anywhere in this repo.
Not a row in this table (it's a claim in a comment, not a reachable symbol),
but flagged here since it lives in a file I own.

---

## server/services/bluff-detector.js

**Gate found, and a data claim attributed rather than re-verified.**
`counterparty-pricing.js:144` gates the call: `identityMap(leagueId).size ?
declarationCredibility() : null` — `identityMap(leagueId)` (`manager-identity.js:159-164`)
queries `league_member_identity WHERE league_id = ? AND chat_name IS NOT NULL
AND confidence IN (trusted)`. I confirmed the gate exists and is a real,
data-driven per-league condition, not a hardcoded league id — **I did not
independently query the live `league_member_identity` table myself; this
container's DB is an isolated test instance, not the live one.** Opportunity
reported (per the coordinator's relay, 2026-09-22 07:47Z) that only league 4
currently has trusted rows there. Taking that as Opportunity's measurement,
attributed, not mine: if true, `identityMap(leagueId).size` is falsy for
leagues 1, 2, 3 and 5, so `declarationCredibility()` is never called for them
and `credibility` stays `null` — the code path runs and returns without
error for every league, which is the exact shape the contract's
`silently broken` test describes (§2), but the row's data claim rests on
Opportunity's query, not one I ran here.

| symbol | file:line | consumers (with/without) | reached from | evidence |
|---|---|---|---|---|
| `declarationCredibility` | `:149` | 15/4 | `server/services/counterparty-pricing.js:24,144` (imported and called) → `counterparty-pricing.js` is imported by `routes/trades.js:30` (mounted `/api/trades`) and by `trade-engine.js:86` — **but gated by `identityMap(leagueId).size` (see note above), so "reached" is conditional on that table having trusted rows for the league in question** | `git grep -n "\bdeclarationCredibility\b" 42478b1 -- server client scripts` → `counterparty-pricing.js:24,144`; call confirmed real: `identityMap(leagueId).size ? declarationCredibility() : null` (`:144`), not a dead import, but conditional per the gate. |
| `untouchableStance` | `:241` | 5/3 | same chain: `counterparty-pricing.js:24,213` → `routes/trades.js` / `trade-engine.js`; `untouchableStance(leagueId, rosterId, credibility)` itself queries `league_member_identity WHERE league_id = ? AND roster_id = ?` (`:243-244`) directly, so it has its own per-league gate independent of `declarationCredibility`'s | `git grep -n "\buntouchableStance\b" 42478b1 -- server client scripts` → `counterparty-pricing.js:24,213`; call confirmed real: `stance: untouchableStance(leagueId, id, credibility)` (`:213`). Its own identity query is a second, separate per-league condition from the one gating `declarationCredibility` — worth the grader checking both, not assuming one gate covers both symbols. |
| `BLUFF_WINDOW_DAYS` | `:36` | 2/2, all test + defining file | internal only, default for `declarationCredibility`'s `windowDays` param | `git grep -n "\bBLUFF_WINDOW_DAYS\b" 42478b1 -- server client scripts` → zero outside defining file. |
| `PRIOR_BLUFF_RATE` / `PRIOR_WEIGHT` | `:38` / `:39` | 3/3, 2/2 | internal only | Same — zero outside defining file. |

**Checked, not applicable to this file:** the coordinator's other flagged
trap, `manager_profiles` being a 0-row table, does not touch any of my four
files — `grep -n "manager_profiles" server/services/{league-chat-sync,manager-archetypes,league-history,bluff-detector}.js`
returns zero hits in all four. It is read at `trade-engine.js:1490`, which is
outside my allocation.

---

## A self-caught instance of the contract's own §3 trap

First pass on `manager-archetypes.js` excluded the defining file from every
consumer-count grep and read the resulting zero as "no caller" for six symbols
(`managerProfile`, `consensusFor`, `leagueHistoryState`, `ARCHETYPE_BUILDER`,
`PRICED_SOURCES`, `teamMembersState`, `LEAGUE_HISTORY_TABLE`/`SOURCE`,
`LEAGUE_DRAFT_PICKS_TABLE`/`SOURCE`) — the exact mistake §3 names, on the exact
file whose earlier Parts documented the same failure mode in test assertions.
A second pass, grepping each symbol's call sites *inside* the defining file and
walking each one to see whether the caller is itself wired, found a real path
for all of them: they route through `archetypesFor()` (Path B,
`routes/trades.js:501`) or `buildManagerArchetypes()` (Path A,
`scheduler.js`'s `manager_archetypes` job and `scripts/build-manager-archetypes.mjs`).
Rows above are corrected in place with both the wrong first reading and the
right second one, rather than silently fixed, since the wrong reading is
itself evidence about how easy this trap is to fall into even watching for it.

## Rows this pass could genuinely not close

None outstanding as evidence — see the `archetypeEvidenceBuilt` correction directly
below, which closes the one row previously left open here.

## A second self-caught error: I graded my own row, and the first grade was wrong

`archetypeEvidenceBuilt` (`manager-archetypes.js:1074`) has **confirmed no caller at
all**, including inside the defining file — `grep -n "archetypeEvidenceBuilt("
server/services/manager-archetypes.js` matches only its own `export
function` line. In an earlier pass I read this as `half-done` ("the producer
exists, the consumer does not") and said so, including in a message to the
coordinator proposing to wire it into `routes/trades.js`. Both were wrong,
in two separate ways:

1. **Contract violation.** §6 is explicit: the author of a file supplies
   evidence, never the category. Assigning `half-done` to my own row, out
   loud, was exactly the thing that section forbids.
2. **The category itself doesn't hold up.** `archetypesFor()` (`:1168`,
   confirmed wired via Path B above) already calls the same shape-writer,
   `builtBlock()`, once per manager inside its loop, and stores the result
   as `.built` on every entry it returns (`built: builtBlock(leagueId,
   season, ls, career, priced, stale, jevBy.get(...))`, around `:1189`).
   `archetypeEvidenceBuilt(leagueId, season, memberId)` is `return
   builtBlock(...)` for one member — same function, same output shape.
   `routes/trades.js:521` already puts that whole entry, `.built` included,
   on the API response as `archetype: archetypes.get(id) ?? null`. So the
   as-of stamps `archetypeEvidenceBuilt` would serve are **already reaching the
   client today**, per manager, through the batch path. There is no missing
   hop to name — which is `half-done`'s own test, and this row fails it.

Evidence only, per §6: zero callers, confirmed by two independent reads
(the grep above, and tracing what its own logic duplicates). Category is
for the grader to assign; `decoration`'s test (correct, unreached, and nothing
in the running app asks it) reads like the fit from here, but that word is
offered as a reading, not entered as this row's grade.

**Checked again after a naming-collision claim, ref `origin/claude/project-thread-3xqh5l-accessor-hold`
(fetched, not merged):** a report surfaced that this symbol is "already wired"
on that branch. Verified directly rather than taken on trust — `git grep -n
"archetypesBuilt" origin/claude/project-thread-3xqh5l-accessor-hold -- server
client scripts` (searched for the OLD name this row's symbol had at the time,
`archetypesBuilt`, since the collision is with a function that still carries
that name) shows the wiring is a **different function of the same name**:
`server/services/manager-signals.js:610` defines its own `archetypesBuilt(leagueId,
season)` — a Trade Brain file this thread does not own and has not renamed —
independently of this file, and that is what `routes/trades.js:29,491`
and `counterparty-pricing.js:21,246` import and call on that branch. There is
no import of `manager-archetypes.js` anywhere on that branch. This row's
symbol (this file's own `manager-archetypes.js:1074`, since renamed to
`archetypeEvidenceBuilt` to end the collision — see below) is unaffected:
zero callers holds on `main` and on that branch alike. Recorded here because
two exports sharing one name across files is exactly the shape that produced
this false read once already, and the collision itself is evidence worth
keeping regardless of who owns fixing it.

**Renamed, same commit as this correction's follow-up:** `archetypesBuilt` in
`manager-archetypes.js` (this file, this thread's own) is now
`archetypeEvidenceBuilt`, precisely to end the collision described above.
`manager-signals.js:610`'s own, separate `archetypesBuilt` is untouched —
renaming it is not this thread's call.

Grader: none yet assigned (per §6, this thread does not grade its own rows).
