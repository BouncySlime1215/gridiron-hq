---
name: archetype-card-provenance
description: The trades manager card is built from three stores with three different write passes and three different dates — and manager-archetypes.js does NOT read league_transactions_raw, despite the wiring map saying so.
metadata:
  type: project
  modified: 2026-09-20T03:17:14.870Z
---

**Correct the wiring map on this one.** `manager-archetypes.js` does **not**
read `league_transactions_raw`. `grep -rn` returns one line, `:20`, and it is
prose in the file header saying transaction-derived metrics are *deliberately
absent* (ESPN serves ~3 days, forward capture started 2026-09-17). Trade
Brain's `21b449a` already covers that table's only served consumer. Anyone
re-deriving "archetypes read transactions" from the map is reading a comment.

**What the manager card on the trades surface is actually built from.**
`archetypesFor(leagueId, season)` → `routes/trades.js:501` → `archetype:` on
every manager card. Three halves, three provenances, and one date would be
wrong for two of them:

| Half | Table and key | Written by |
|---|---|---|
| `this_season` | `manager_archetypes` (member, league, season) | `buildManagerArchetypes()` |
| `career` | the **same table**, keyed (member, **0**, **0**) — `CAREER_LEAGUE`/`CAREER_SEASON` at `:68-69` | the same build, but only for members it found draft picks for |
| `jev` | `manager_archetype_jev`, own `evaluated_at NOT NULL` column | `storeJevAnswers()`, a **separate** pass after a gateway call |

The career roll-up is not keyed by the league-season the card is in, so a build
can refresh one and not the other. The Jev answers are dated by a different
pass entirely.

**Neither table has a server writer.** `buildManagerArchetypes()` and
`storeJevAnswers()` are reached from one place: `scripts/build-manager-archetypes.mjs`
(`:60`, `:180`). No route, no scheduler job, no refresh tick. Same shape as
[[league-history-orphan-closed]] before #47.

**The silent-skip trap, and why `sync_log` is the wrong stamp here.**
`buildManagerArchetypes` takes its league-seasons from `SELECT DISTINCT
league_id, season FROM league_draft_picks` (`:526`). A league with no draft
picks on file is simply not in that list — skipped with no error, the job
succeeds, the job-level stamp moves, and that league-season's rows stay exactly
as old as they were. `MAX(computed_at)` **for that league-season** is the only
value meaning "the build reached it".

**No `table_missing` reason is possible** in this module: it runs `CREATE TABLE
IF NOT EXISTS` on both tables at import (`:78`, `:86`). Unlike
`league_transactions_raw`, the table cannot be absent where the reader runs.
Writing that branch would be a reason that can never fire.

**Still open, Trade Brain's file:** `counterparty-pricing.js:452-457` turns the
`outcome` half of this same hand-built store into `luck_self_view`, a term in
the trade price, and says nothing about its age.

Shipped as `archetypesBuilt()` / the per-card `built` block on branch
`claude/project-thread-sytruo-asof-hold`, head `6ceb5c7` (held, no PR, GitHub
freeze 2026-09-20). Evidence `docs/tdd/archetype-as-of.tdd.md`.
See [[gridiron-failure-modes]].
