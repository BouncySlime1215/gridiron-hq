---
name: nflverse-usage-stamp-lies
description: The live 2026 player_week_usage gap is not a hardcoded season list; syncAll stamped nflverse_weekly_usage 'ok' once per season with the last one winning.
metadata:
  type: project
  modified: 2026-09-20T01:10:26.713Z
---

**Corrects the standing note** that said `nflverse.js:312` stamps
`nflverse_weekly_usage` 'ok' "for a hardcoded season list ending 2025 (six
occurrences), so 2026 usage is never fetched". Verified against `origin/main` at
`791b131` on 2026-09-20 by reading the code, not the relay:

- **2026 IS requested, every boot.** `nfl-model-growth.js:187` calls
  `syncAll([availableSeason()])` (= `NFL_SEASON`, else `MAX(season) FROM
  game_lines`), gated on `before.finalized_week > 0 && (force || coreLag)`.
  `coreLag` is `sources.some(s => s.required && !s.current)`, and
  `weekly_player_usage` on `player_week_usage` is `required: true` with
  `current = finalizedWeek === 0 || through_week >= finalizedWeek`. Zero 2026
  rows ⇒ `through_week` 0 ⇒ coreLag true. **The missing rows are themselves the
  trigger**, which is why the heavy ingestion runs on every boot
  ([[gridiron-restart-cycle-2026-09-19]]).
- **The six hardcoded `'2021,2022,2023,2024,2025'` defaults are all in
  `server/routes/nfl-betting.js`** (`:706 :721 :733 :746 :1130 :1316`) — the
  betting board, off this path. `nflverse.js` has no hardcoded list at all; it
  takes `seasons` from its caller.
- **A third instance was already fixed in `routes/model.js`**, and its own
  comment at `:607` names the residual in its own words: the list used to be
  `[SEASON-5 … SEASON-1]`, so the sync "genuinely succeeded, at fetching seasons
  that had not changed", **"while the sources themselves reported `ok`"**.

**The actual defect, two halves.** (1) `syncAll` called `recordSync` inside its
season loop; `sync_log` holds one row per `job`, so the last season overwrote
every earlier verdict, and `record()` (`scheduler.js:79`) resets
`consecutive_failures` on any status that is not `'error'` — five failures then
one success read as fresh with no backoff. (2) `syncWeeklyUsage` throws only on a
fetch or schema failure; a season that downloaded cleanly but matched no player
in the crosswalk returns `{ rows: N, inserted: 0, unmatched: N }` with no `error`
key, and `usage.error ? 'error' : 'ok'` stamped that green.

**Why it matters beyond this feed:** `statusFromDetail`'s own header
(`scheduler.js:96-115`) records two earlier instances of the same class in that
file. A feed that is **lying** rather than stale has no representation in any
freshness surface — they all read `sync_log`, which is a claim the last run made
about itself. See [[gridiron-failure-modes]].

**How to apply:** never read a feed's health from `sync_log` alone. Ask the table
what it holds. Fix built on 2026-09-20 in commits `5044317` (RED) / `989baf2`
(GREEN) on `claude/project-thread-f921do-season-list`, evidence in
`docs/tdd/nflverse-usage-truth.tdd.md`; **unpushed, held by the 01:04Z Actions
freeze** ([[gridiron-actions-freeze-2026-09-20]]).
