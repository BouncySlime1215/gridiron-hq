---
name: gridiron-league-season-teams-is-not-a-core-table
description: In gridiron-hq, league_season_teams is created only by scripts/backfill-league-history.mjs, so any read through it throws "no such table" on a database where that backfill never ran — use league_member_identity for roster to ESPN member id.
metadata:
  type: project
---

**`league_season_teams` looks like a core table and is not one.** Nothing in
`server/db/` creates it and no migration adds it. Its only `CREATE TABLE` is in
`scripts/backfill-league-history.mjs:48`, an off-server history backfill. On any
database where that script has never run — a fresh clone, a test fixture, a new
deploy volume — the table is simply absent, and a read through it **throws
`no such table` rather than returning an absence**, which is the opposite of
what the whole as-of family is for ([[gridiron-as-of-rule]]).

Found 2026-09-20 while writing `jevEvaluated()`: the first draft joined it, and
`test/valuation-map.test.js` failed with `no such table: league_season_teams`
despite running `runMigrations()` and importing the real
`manager-archetypes.js` DDL.

**`manager-archetypes.js` reads through it at three sites** — `teamMembers()`
(:243), `managerProfile()` (:819) and `archetypesFor()` (:831) — so all three
throw on such a database. That file belongs to the chat-sync thread; the finding
is written up in `docs/tdd/jev-model-read.tdd.md` §7, not patched.

**How to apply.** For roster_id to ESPN member id, join
**`league_member_identity`** instead. `matchIdentities()` in
`server/services/manager-identity.js` writes it on every league sync, so it is
present wherever a league is, and it is keyed `(league_id, roster_id)` with an
`espn_member_id` column.

Do **not** filter that join on its `confidence` column. That gate governs
attributing CHAT to a roster (`likely` and `uncertain` are the matches that go
wrong). An ESPN member id is an ESPN fact: a manager whose chat name Nick never
confirmed still has one, and filtering on confidence would silently drop him
from a read that has nothing to do with chat.

Related: [[archetype-as-of-accessor]], [[gridiron-test-fixture-traps]].
