# SS-01-F1 one dead-starter producer (plan item Diligence Engine structure)

Branch `claude/local-ss-01-f1-one-dead-starter-producer`, built on
`claude/local-ss-01-dead-starter-guard` at `8985e03c` (PR #185, **open, not merged**; this
branch stacks on it and must merge after it, or be retargeted).

## 1. Audit: extend or build (written before the first test)

Every producer of "a starter who will score zero this week", grepped on `8985e03c`
(`grep -rn "flagged_starters\|dead_starters\|lineup_dead_starters\|DEAD_ESPN_STATUS" server client/src`):

| Producer | file:line | Definition | Reaches |
|---|---|---|---|
| `deadStarters()` / `deadReason()` | server/services/dead-starters.js:65-150 | ESPN-set starter (any non-bench, non-IR slot) who is IR, season-ending, Out or Doubtful by contingency.js#weekDesignation, on bye, or inactive; not once his game has kicked off; with a bench replacement | Start/Sit `dead_starters` (lineup-brain.js:455, client/src/pages/Lineup.tsx:115) |
| `lineupDiff().flagged_starters` | server/services/trade-engine.js:2945-2949, 2970 | ESPN-set starter in `SCORED` positions with `available === false` or on IR only. No Out, no Doubtful, no bye | League Hub card, client/src/pages/MyTeam.tsx:329, 395 |
| `rosterSignals()` `lineup_dead_starters` | server/services/manager-signals.js:313-314, 324 | count of ESPN starters whose status is a key of `DEAD_ESPN_STATUS` (OUT, INJURY_RESERVE, DOUBTFUL). No SUSPENSION | table `manager_signals`, written by `buildManagerSignals()` manager-signals.js:366 (via `rosterSignals` :390) |

The two page surfaces disagree on the same input. Local copy, not production (backup of
`~/gridiron-local/data.sqlite` taken 2026-09-23 05:59), tree `8985e03c`, week 3:

`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node study/replay/ss-01-f1-surface-compare.mjs`

| league | League Hub flagged_starters | Start/Sit dead_starters |
|---|---|---|
| 1 | [] | [QB:doubtful] |
| 2 | [] | [] |
| 3 | [] | [QB:doubtful] |
| 4 | [] | [] |
| 5 | [] | [] |

Totals: hub 0, Start/Sit 2, 2 of 5 leagues disagree. This is the known-nonzero control for
the after-run below.

Decision: **extend**. `dead-starters.js` is the one producer. `lineupDiff()` calls
`deadStarters()` on the same roster (same `loadRosters()` players, its own week_points,
which are built to equal Start/Sit's) and serves its items as `flagged_starters`, keeping
the fields MyTeam.tsx reads (`id, name, position, reason, espn_status, espn_disagrees`) and
adding `dead_reason`, `slot`, `replacement`, `why`. `slotAccepts` moves from lineup-brain.js
into dead-starters.js so both callers use one slot rule. manager-signals.js stops reading
a status list and asks `espnDeadReason()` (dead-starters.js), which is `deadReason()` on
the ESPN status alone, so SUSPENSION (and any status weekDesignation maps to Out/Doubtful)
counts. That changes the stored `manager_signals.lineup_dead_starters` value for a roster
with a suspended starter (no schema change, no migration). The card text rounds the
replacement's week_points to one decimal.

What stays different on purpose: `lineupDiff`'s point totals (`submitted_points`, swaps)
still count only IR/season-ending starters as 0; a Doubtful starter is priced at his
week_points (already discounted by his chance to play). The list of who is dead is the
thing unified, not the solver's scoring.

File allocation: trade-engine.js#lineupDiff is also edited by open PR #171 (RL-4-2). This
unit touches only the `flagged_starters` block and adds the same `now = Date.now()` option
#171 adds, with the same signature, so the merge is mechanical.

Statistical? No. A deterministic rule, no fitted number; no pre-registration. No 2025
held-out data read, so no holdout row. Rule (e) does not apply: no start/sit accuracy claim
is made, only that two surfaces agree.
