---
name: gridiron-wiring-map-blind-spot
description: The wiring map cannot catch a value-level mismatch inside a correctly wired graph — the waiver-brain 'DST' bug is the worked example, found by reading, not by the gate.
metadata:
  type: project
  modified: 2026-09-19T22:30:00.000Z
---

Established 2026-09-19 while verifying a lead from the fantasy-plan thread.
Record this wherever the wiring gate is described, so nobody reads a green
`scripts/wiring-map.mjs` as "everything is connected".

**What the map checks:** structure. Is the module imported, is the route
registered, is the column written by someone and read by someone, does a
producer have a caller, does a page reach a surface. All of it is derived from
source — ESM imports, SQL in string literals, express registrations, scheduler
`JOBS`, client `api()` calls.

**What it cannot check:** whether the VALUES flowing through a correctly wired
edge match. The worked example, all on origin/main at 791b131:

`server/services/waiver-brain.js:45` sets
`SCORED = new Set(['QB','RB','WR','TE','K','DST'])` and filters the free-agent
pool with it at `:178`. Every writer of `players.position` writes `'DEF'`, never
`'DST'` — `db/seed/index.js:113`, `routes/espn.js:110` via its `ESPN_POS` map at
`:35`, and `espn-draft.js:172` via its own at `:69`. So that filter silently
drops every defense. Kickers do pass it, then score a zero lineup delta because
`bestLineup` excludes K and DEF from both the player pool
(`trade-engine.js:615`) and the slot list (`:636`), so `waiverUpgrades` drops
them at `gain <= 0.05` (`waiver-brain.js:253`) and `byePatches` at
`recovered > 0.25` (`roster-risk.js:179`).

Net: no kicker or defense can be recommended on the waiver or bye-risk
surfaces, in five leagues that all start both. Nick sees an empty patch list
and no explanation — the exact failure shape CLAUDE.md names ("if a layer goes
inert, the surface must say so").

**The map is green on every one of those files**, correctly. waiver-brain.js is
imported, its route is registered, its columns are read and written, its
producers have callers. The defect is one string literal that matches no row.

**Do not try to build a rule for this.** It was considered and declined, for the
same reason the "constant that should be a fitted row" rule was: a static tool
cannot distinguish a set literal that is deliberately narrow from one that is
accidentally wrong, and enum-value alignment across three writers and a
consumer would false-positive on ordinary correct code. The honest move is to
state the limit on the published page, not to imply coverage that is not there.

This is the same family as [[gridiron-availability-constant-0-92]]: a widening
written on purpose that the layer underneath cannot serve. Found by reading the
consumer, which is the standing rule in
[[gridiron-author-is-the-worst-reviewer]].
