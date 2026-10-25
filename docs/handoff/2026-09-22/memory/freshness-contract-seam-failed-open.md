---
name: freshness-contract-seam-failed-open
description: MERGE GATE — PR #96's servedTables() and the UI thread's freshness consumer use different rule shapes, and the mismatch makes the banner read "fresh" on the exact stale data it was built to catch. Measured 2026-09-22 08:30Z.
metadata:
  type: project
---

> **DO NOT MERGE #96 ALONE.** Merging it by itself makes the freshness banner
> LESS honest than leaving it out. **Merge order: consumer first, or both
> together.**

**The two shapes.** `servedTables()` (mine, `server/services/source-registry.js`,
PR #96, branch `claude/project-thread-o3wt2p-servedtables` @ `a24692d`) emits
`current_rule.{sql, params, text}` — a whole query returning 1 or 0. The consumer
(the UI thread's `server/services/data-freshness.js` and
`server/routes/data-freshness.js`, branch
`claude/project-thread-xiezr0-data-freshness` @ `3d92ccb` — **note it moved from
the `7c289e8` other memories cite**) reads `current_rule.{predicate, bind,
description}` — a WHERE fragment. Neither field exists in the other's shape.

**Why it fails OPEN rather than loudly.** `predicate` → `undefined` → `''`;
`bind` → `undefined` → `[]`; the consumer's placeholder guard counts 0
placeholders against 0 binds and passes; an empty predicate falls through to
`currentCount = row_count`. Every verdict becomes "does this table have any rows
at all". Every guard on the path was individually reasonable; the composition was
a pass.

**Measured, not reasoned.** Tree = registry at `a24692d` + consumer's two files at
`3d92ccb`, real migrated DB, `player_week_usage` holding 2021-2025 and nothing
for 2026, asked about 2026 week 3 — the type specimen the feature exists for:

| registry in play | verdict | rule sentence |
| --- | --- | --- |
| consumer's one-entry fallback (#96 absent) | `stale` | shown |
| `servedTables()`, 17 entries (#96 present) | **`fresh`** | `current_rule: null` |

Same DB, opposite answers. All 17 rules read NULL, so **`stale` becomes
unreachable** — the status separating "the pipeline stopped" from "it never
started" cannot be produced at all.

**The fix, and why NOT the obvious one.** Fix = the consumer delegating to
`servedTableVerdicts`, exported from `source-registry.js` on **PR #104** (branch
`claude/project-thread-o3wt2p-freshness-evaluator` @ `e3a8676`, stacked on #96;
3004/2963/0/41, exit 0, guards clean). Signature:
`servedTableVerdicts({entries, season, week, database})` ->
`[{table, current: true|false|null, rule, grain, reader, error}]`, where
`current: null` + `error` means the check could not run and MUST be rendered,
never dropped. `evaluateServedTable(entry, {...})` is the single-entry form and
THROWS on any rule it cannot run. Signature sent to the UI thread 08:47Z; the
`data-freshness.js` edit is routed to UI (its file). Do **not** "just also emit a
predicate": two of the 17 rules are universals a fragment cannot carry —
`roster_players` `MIN(fetched_at) >= -1 day` and `gamescript_model`
`COUNT(DISTINCT target) >= 2`. A fragment matching one row says "at least one
team is fresh" (weaker than a row count) and "at least one target is fitted"
(which IS the half-fitted-model bug). Those two are the rules worth having.

`data-freshness.js` is the UI thread's file under the one-editor rule, so the
change is the coordinator's routing call, not the Scheduler thread's.

See [[servedtables-is-coverage-not-timestamps]],
[[measure-the-seam-do-not-read-it]], [[gridiron-test-harness-schema-facts]].
Write-up: `docs/tdd/2026-09-22-served-table-verdicts.md`.
