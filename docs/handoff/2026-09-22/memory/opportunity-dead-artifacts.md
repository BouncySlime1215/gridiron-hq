---
name: opportunity-dead-artifacts
description: Three things in gridiron-hq named "opportunity" reach no user-visible number, confirmed 2026-09-19 — don't mistake any of them for a working opportunity model.
metadata:
  type: reference
  modified: 2026-09-19T16:34:03.899Z
---

Confirmed by repo-wide audit on 2026-09-19. If a future session sees one of these
and assumes the opportunity model exists, it will build on nothing.

- **`playerOpportunity` in `nfl-expert-council.js`** — a 0.55/0.35/0.1
  recombination of a per-unit *injury-burden* differential, not usage, despite the
  name. The identifier appeared exactly once in the repository: its own
  declaration. Assigned, never read. **Removed in PR #15.**
- **The registered `player_opportunity` expert** — alive, but a scoreboard row on
  the betting side. `score: 'volume_mae'`, emits no forecast, and it *consumes*
  the fantasy engine rather than feeding it. No fantasy route, service or client
  reads it.
- **`priorFfOpportunity` / `nfl_ffopportunity_weekly`** — attached to every
  projection at `player-week-engine.js:358` and read by nothing, not even the
  client. Self-declares `authority: 0`, `status: 'external_shadow_benchmark'`.
  Write-only.
- **`opportunity-redistribution.js`** — complete, correct code behind
  `redistributeVolume = false` in `buildPlayerWeekEngine`. Its own header records
  all three variants measuring 9.5-12.6% worse. Only caller is
  `scripts/eval-redistribution.mjs`.
- **`role-scenario-engine.js`'s `conservedTeamVolume`** — research lab only.
- **`teamWeekEventExpectations`** — betting/props only; `reconciliationStrength`
  defaults to 0, which is a no-op, and the roster it allocates over ignores injury
  status entirely.

So before 2026-09-19 nothing in the fantasy projection responded to a teammate
being ruled out. `server/services/opportunity-model.js` (PR #15) is the first
fantasy-side opportunity module, and it is measurement only — nothing in it is
wired into a projection.

Also fixed in that PR: `syncDepthCharts` used to return
`{rows: 0, seasons_loaded: 6, failures: []}` when `game_lines` was empty, because
seasons through 2024 date their charts from the schedule — a source that stored
nothing while calling itself healthy. Sync the schedule before depth charts.

See [[opportunity-stage-findings]].
