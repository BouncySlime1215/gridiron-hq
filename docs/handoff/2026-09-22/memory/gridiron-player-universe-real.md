---
name: gridiron-player-universe-real
description: Live read on 2026-09-19 16:38Z proves the Fly player table is real — 965 players, 800 with ESPN ids — superseding the earlier 448-seed-row claim.
metadata:
  type: project
  modified: 2026-09-19T19:21:31.074Z
---

`GET /api/players` on gridiron-hq.fly.dev at **2026-09-19 16:38:05Z**, in a
window where the app was answering:

- **965 players**; 800 with `espn_id`, 751 with `sleeper_id`, 928 with `gsis_id`
- 805 `fantasy_relevant`, 800 of those carrying an ESPN id
- 265 WR, 199 RB, 134 TE, 117 QB, 58 K, 32 DEF

Spot-checked against the source rather than trusted: A.J. Brown comes back on
**New England**, which looks like a bad team mapping, and ESPN's own NE roster
endpoint confirms `4047646 A.J. Brown WR` on that roster. The sync is correct.

**This supersedes the "448 seed rows with no ids" figure** in
[[gridiron-live-data-state]], which was true at 15:20Z and was overtaken by the
ingestion sweep. Do not quote 448 again.

**Still true after the sweep:**
- `bye_week` is null on all 965 rows, and **no code anywhere in the repo writes
  `players.bye_week`** (`draft-assist.js:179` works around it via the schedule).
- `seedIfEmpty()` still runs on every boot (`server/index.js:59`).
- The 20-second `bootJobs` catch-up pass has twenty entries and **not one
  fantasy job**. That fact is right; the conclusion drawn from it here
  ("they get no attempt on a restart") was **wrong** and is corrected by the
  scheduler thread: eighteen of the twenty are tier `live`, and the live timer
  fires every 90 seconds independently of that list. `player_rosters` (live,
  3h), `league_rosters` (live, 60m) and `nfl_injuries` (live, 6h) are on it, so
  absence from `bootJobs` costs them seventy seconds after a restart, not their
  timer. `espn_rosters` is growth on a 24-hour budget and gains nothing from a
  boot pass. Adding them would cut against what the list is for.
- The apostrophe name-mismatch is largely spent: ESPN's spellings overwrote the
  seed's, so only L'Jarius Sneed (a cornerback) still carries a typographic
  apostrophe.

**Not yet read** (app went back down): `player_metrics` `fc_value` rows, which
decide whether the NEED 0% grid is actually on screen, and the weekly
projections, which decide the same for Start/Sit.

**App behaviour that afternoon:** answered in 0.39s, then 12s, then zero bytes
on nine attempts from 19:16Z. Up, unresponsive, up — consistent with the heavy
tier blocking the main thread every five minutes. See
[[gridiron-fantasy-audit-findings]].
