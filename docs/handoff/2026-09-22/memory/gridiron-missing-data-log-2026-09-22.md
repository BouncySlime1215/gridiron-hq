---
name: gridiron-missing-data-log-2026-09-22
description: Running list of data the project lacks and can't get free online, for Nick to decide on (his own access, Kaggle, buy data, etc.) — coordinator-maintained per [[gridiron-missing-data-workaround-rule]]; threads report gaps up, never add directly.
metadata:
  type: project
  modified: 2026-09-22T04:05:58.350Z
---

Seeded 2026-09-22T03:53:38Z per Nick's missing-data rule
([[gridiron-missing-data-workaround-rule]]). Coordinator appends;
threads report gaps up per [[threads-report-to-coordinator]].

**1. True per-player routes-run data — not free anywhere.** No route
column in any nflverse release (`pfr_advstats` earlier "yes" claim
retracted — instrument only checked HTTP 206, not headers). Nearest
free proxy: `pbp_participation` route-per-play, covers 2016-2025 only,
not 2026. Paid-only elsewhere (PFF, FantasyPoints Data, SIS); Kaggle Big
Data Bowl tracking needs Nick's own account/terms-read, no 2026 data
either. A feed excluding blocking snaps (RB/TE) would beat the proxy,
which currently conflates blocking with routes. **Result:** proxy
proven statistically redundant with snap-share data — routes-run
feature dropped. **Workaround (approved ~03:44Z, gated):** two-stage
estimator, real 2016-2025 history + labeled ESTIMATE for 2026 from live
snaps, gated on held-out lift check, auto-falls back to
red-zone-inside-10 if it fails. Detail:
[[gridiron-phase-a-0346-2026-09-22]]. **Status:** building; no ask for
Nick unless the check fails or he later wants a blocking-excluded feed
(needs his PFF/FantasyPoints/SIS/Kaggle access).

**2. Real 5-leagues payload — untestable in this container.**
`verifyLeagueConfig()` ran for real, but `leagues` table is empty here,
so only synthetic-but-real-code-path data was checked (ESPN 2/8,
Sleeper 4/8 settings). Detail: [[gridiron-phase-a-0346-2026-09-22]],
[[gridiron-state-record-2026-09-22]]. **Ask for Nick:** a DB copy with
real league rows, or his own check against live leagues.

**3. pbp_participation table — no migration/schema.** A wiring gap, not
a sourcing ask; read by td-features.js, nfl-formations.js. Detail:
[[gridiron-phase-a-0346-2026-09-22]]. **CORRECTED ~04:00Z:** also named
nfl-weekly-feature-store-v2.js — wrong mechanism, see
[[gridiron-satellite-tables-correction-2026-09-22]].

**4. Current-season (2026) participation data — structural ceiling.**
`pbp_participation_2026.csv` 404s; `snap_counts_2026` and
`stats_player_week_2026` live through week 2 only. Paid/Kaggle tracking
sources don't have 2026 either — not buyable. No action for Nick;
remember before proposing any feature needing 2026 participation
detail.

---
Add new entries above this line, numbered: what's missing, sources
checked/ruled out, workaround + validation if built, ask for Nick if
any. Keep this file under 2.8 KB — split into a new dated file (linked
from here) if it grows past that.
