---
name: gridiron-phase-a-0346-2026-09-22
description: Fantasy plan item1 real verifyLeagueConfig() results + Model audit item2 routes-run retraction and two-stage-estimator decision, as of the 03:46Z check-in.
metadata:
  type: project
  modified: 2026-09-22T04:06:09.094Z
---

Linked from [[gridiron-state-record-2026-09-22]]. Item text/citation for
both items: [[gridiron-phase-a-start-2026-09-22]].

**Fantasy plan — Phase A item1, 03:46Z: built and RAN verifyLeagueConfig()
for real (not a plan).** RED commit 39bdf62; GREEN pending a full check.
Real output on synthetic-but-real-code-path data (cannot test against the
actual 5 leagues from this container — leagues table empty — said so
honestly rather than fabricating):
- ESPN league: 2/8 settings confirmed. scoring confirmed; lineup_slots
  defaulted, dropping 8/17 slots; bench_ir/waiver_type/faab_budget/
  trade_deadline all unavailable; playoff_structure confirmed;
  keeper_dynasty best_effort heuristic.
- Sleeper league: 4/8 confirmed. scoring defaulted — Sleeper's per-stat
  detail never read at all; lineup_slots/bench_ir/playoff_structure/
  keeper_dynasty confirmed; waiver_type/faab_budget/trade_deadline
  best_effort.

13/13 mutation tests caught. Now also owns scoring.js and format.js
(assigned 03:32Z, no other claimant). Still holding 2 container-only
commits (4061604, 2709263) needing Nick's push decision — unchanged from
03:31Z.

**Model audit — Phase A item2, 03:46Z: RETRACTED its earlier claim that
pfr_advstats has a routes-run column.** False — it had checked only the
HTTP 206 response, not the actual header content; same fault class as an
earlier retraction tonight (the instrument-fault; see
[[gridiron-thread-detail-2026-09-22]]). True routes-run does not exist
anywhere in free nflverse data. The near-miss proxy — pbp_participation's
route-per-play field — only covers 2016-2025, not 2026, so a history-only
feature built on it would fail the "pointed anywhere else on the platform"
test.

**Coordinator decision:** build a two-stage estimator — learn on 2016-2025
real history, serve a labeled ESTIMATE for 2026 from live snap data — gated
on a held-out accuracy/lift check; if that check fails, falls back
automatically to a different feature (red-zone-inside-10), no further
asking.

Also found two stale wrong comments (comment-only, no logic change, no
other owner) — approved to fix directly:
- nfl-formations.js: "participation ends after 2023" — false, 2024 and
  2025 both have complete data.
- nfl-advanced.js: "PFR data begins 2024" — false, 2018-2025 all have real
  rows.

Also flags: pbp_participation is read by 3 files but created by no
migration/schema anywhere — a new item5-shaped inventory finding. Told to
log it or hand it to Wiring map (see
[[gridiron-phase-a-0346-b-2026-09-22]] for Wiring map's own related blind
spot). **CORRECTED ~04:00Z:** one of those 3 readers,
nfl-weekly-feature-store-v2.js, was misattributed — its tables are
satellite-DB-backed, not never-created; see
[[gridiron-satellite-tables-correction-2026-09-22]].
