---
name: gridiron-fly-ingestion-limits
description: Four blockers found on the live Fly app on 2026-09-19 and what became of each — memory RESOLVED by a 2GB resize, keys mostly set (one wrong name), AUTO_HEAVY_SYNC now on and causing re-saturation, score write left unfixed.
metadata:
  type: project
  modified: 2026-09-19T19:30:00.000Z
---

From a full ingestion sweep against gridiron-hq.fly.dev on 2026-09-19.
**Three of the four have since changed state — read the RESOLVED and STILL
OPEN markers, not just the diagnosis.**

**1. RESOLVED 2026-09-19 16:05Z. The Fly machine died on any sync that
parsed a large payload.** Every failure was a 502 with nothing written to
`sync_log`, the signature of the process being killed rather than throwing,
while the same pulls took about a second from a cloud session. The three that
died: ESPN `kona_player_info` at 17.6 MB (used by both `espn_players` and
`espn_season_stats`), Sleeper's player dump at 14.6 MB, and nfelo's four CSVs.
Everything small succeeded.

**Outcome:** Nick ran `fly scale memory 2048 -a gridiron-hq` and all of them
succeeded immediately after — 800 players in one call, Sleeper matched 752,
ffopportunity loaded 18,494 rows. The resize fixed the crashes and changed
nothing about the event-loop blocking in
[[gridiron-long-writes-block-the-app]]; they are different problems, easily
confused.

**2. MOSTLY RESOLVED, one still broken. Four API keys were absent from the app's own environment**, distinct from
the session environment (where `ODDS_API_KEY` and `CFBD_API_KEY` both work).
The app reports, in its own words: "no ODDS_API_KEY configured"
(`nfl_line_snapshots`, `nfl_prop_capture`, prop CLV, and `odds_feed: false`
in `/api/nfl-market/evidence/status`), "CFBD_API_KEY not configured"
(`cfbd_rookie_usage`, `nfl_rookie_college`), "no TWITTERAPI_IO_KEY
configured" (`twitter_insiders`), "no SPORTSGAMEODDS_API_KEY configured"
(`nfl_sgo_snapshot` — this one Nick does not have at all). The Anthropic key
is also unset (`/api/dev/status` -> `api_key.configured: false`).

**Outcome:** the odds and CFBD keys were set and both work — `odds_feed` went
`true`, `nfl_line_snapshots` captured 1,086 quotes, `cfbd_rookie_usage`
stored 5,508 rows. **STILL OPEN: the Twitter key went in under the wrong
name.** The app reads `TWITTERAPI_IO_KEY`
(`server/services/twitterapi-io.js:22`), but the command Nick was given set
`TWITTER_BEARER_TOKEN`, so `twitter_insiders` still reports "no
TWITTERAPI_IO_KEY configured". Same value, right name:
`fly secrets set TWITTERAPI_IO_KEY=... -a gridiron-hq`.

**3. CHANGED, AND IT BACKFIRED. `AUTO_HEAVY_SYNC` was not set to '1' on Fly**, and `scheduler.js` gates the
whole `tier: 'heavy'` class on it.

CORRECTED 2026-09-19 by the scheduler audit — see
[[gridiron-scheduler-outage-2026-09-19]]. This flag explains only the eleven
heavy jobs, NOT the bulk of the never-run sources. Most of them, including
every fantasy feed (the player crosswalk, weekly usage, snaps, depth charts,
projections, Sleeper), were in `source-registry.js`'s `MANUAL_SOURCES` and had
no timer of any kind, so the flag was irrelevant to them. And turning the flag
ON is what wedged the app: eleven minutes-long jobs on the main thread every
five minutes, with a TCP-only Fly health check that could not see it.

**4. STILL OPEN, deliberately. 2026 scores cannot land, so the betting board
stays blocked.** `syncCurrentLines` writes finals with an UPDATE-only
statement that can never create a row for a game that was already final, and
counts attempts rather than rows changed, so it reports false success. Nick
ruled the betting board out of scope, so it was left unfixed on purpose and
no PR was opened. Full diagnosis in [[gridiron-betting-bugs-unfixed]].

**Useful entry point:** `POST /api/mlb/sync/now?job=<name>` runs any
registered scheduler job by name (needs `model:train`, which the
`GRIDIRON_FLY_TOKEN` session has). It is the general-purpose way to force one
job without the monolith routes. See [[gridiron-live-data-state]].
