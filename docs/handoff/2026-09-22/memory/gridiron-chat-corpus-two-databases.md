---
name: gridiron-chat-corpus-two-databases
description: Gridiron HQ talks to TWO SQLite files — the app's and the league chat corpus — and confusing them made a tool report four healthy tables as broken on 2026-09-19.
metadata:
  type: project
  modified: 2026-09-19T20:35:27.820Z
---

Verified in code 2026-09-19 from two directions (the Trade Brain thread, then
independently by the wiring-map thread before it changed anything).

**The app's database** is reached through `db`, `rows`, `row` and `run`
exported by `server/db/index.js`, on `GRIDIRON_DB_PATH`.

**The league chat corpus is a SEPARATE FILE**, opened read-only with its own
handle: `manager-signals.js:82` `chatDbPath()` and `:95`
`new DatabaseSync(file, { readOnly: true })`; `league-chat-sync.js:34`
`messagesDbPath()`; `bluff-detector.js:31` imports `openChatDb`. Tables that
live there, NOT in the app's database:

`messages`, `jev_chat_signals`, `manager_chat_profile`,
`manager_player_sentiment`, `negotiation_profiles`.

**It has a real server-side writer:** `POST /api/league-chat/upload`
(`routes/league-chat.js:86`) receives the whole corpus, opens it at a temp path
first, and **refuses a corpus whose `messages` table is empty** rather than
replacing a good file with an empty one. The corpus is built on Nick's Mac and
delivered as a file; nothing inserts rows into these tables server-side and
nothing is supposed to. Both consuming surfaces already refuse and name the gap
when the corpus is absent, with tests around that.

**Why this is worth a memory.** Any tool or grep that pools both databases into
one namespace concludes "read by the app, written by nothing" and reports a
healthy layer as broken. That happened on 2026-09-19 and cost a hold on five
Trade Brain PRs for twenty minutes. Distinguish the handle before drawing any
conclusion about a table with no writer.

`manager_archetypes` is the trap next door: it IS in the app's database, read
on a surface reached from `/api/trades`, and its only writer is
`scripts/build-negotiation-profiles.mjs`. The two-database bug was hiding it.

See [[gridiron-wiring-map]] and [[gridiron-fantasy-audit-findings]].
