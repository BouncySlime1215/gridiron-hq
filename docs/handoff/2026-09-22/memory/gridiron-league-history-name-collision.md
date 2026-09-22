---
name: gridiron-league-history-name-collision
description: PR #42 and PR #47 both create server/services/league-history.js as two different modules with one name — an add/add conflict that only a cross-branch sweep could find, open as of 2026-09-19 22:55Z.
metadata:
  type: project
  modified: 2026-09-19T22:55:00.000Z
---

Verified by merging the two heads: `CONFLICT (add/add) in
server/services/league-history.js`. Open and unresolved when this was written;
check whether one side has been renamed before relying on it.

**They are not two versions of one module. Two different modules, one name.**

- **#47** (chat-sync, `claude/project-thread-sytruo-lst`, 246 lines) — imports
  `{ db, rows }` from `db/index.js` plus `BROWSER_HEADERS`, fetches ESPN league
  history over HTTP and **writes** it into the app database (`historyLeagues`,
  `seasonsToFetch`, `fetchView`, `saveScores`, `saveTeams`,
  `backfillLeagueHistory`). Carries migration `064_league_history_tables.js`
  and a scheduler entry.
- **#42** (fantasy plan, `claude/project-thread-f921do-outlook-basis` at
  `e0268af`, 474 lines) — opens its own
  `new DatabaseSync(DB_PATH, { readOnly: true })` against the Sleeper history
  corpus and **reads** it (`historyStatus`, `weeklyPanel`,
  `varianceComponents`, `compsFor`, `excludedByDataQuality`).

No shared function names, different databases, opposite directions. **Resolving
the conflict by picking a side deletes a working module.** One of the two files
has to be renamed before either PR merges. The file allocation gives
`league-history.js` to chat-sync, which points at the fantasy-plan file as the
one to move; that was the coordinator's call, not a thread's.

Not a conflict, in case it looks like one: only #47 modifies
`scripts/backfill-league-history.mjs`. #42 imports it unmodified.

**Why this is the lesson and not just an incident.** Nick's founding ask for
the wiring thread was that the processes not write over each other. Neither
thread could see this from its own branch — both were green, both were
correct in isolation, and the only thing that surfaces it is merging branches
that nobody has a reason to merge yet. A per-branch gate cannot catch a
collision between branches, however good it is.

**So the practice is: sweep branch pairs, not just each branch against main.**
The cheap version is a detached worktree, `git merge` each open head in turn,
and read the exit code — the conflict is the finding, before the map is even
run. The full sweep on 2026-09-19 covered all 21 open PRs and found exactly
two collisions: this one, and `client/src/pages/Settings.tsx` between #46 and
#53 (one additive hunk, both the UI thread's own branches, so merge order is
the only decision). The other 19 merge onto main clean, so the
one-editor-per-file allocation held everywhere except the file nobody had
assigned before two threads reached for it. The same sweep confirmed the
fantasy-plan thread's unprompted prediction that `server/services/team-outlook.js`
would come back as a module reaching no surface.

Related: [[gridiron-wiring-map-blind-spot]] for what a single-tree run cannot
see, [[gridiron-author-is-the-worst-reviewer]] for why someone else's tree is
the one that finds things.
