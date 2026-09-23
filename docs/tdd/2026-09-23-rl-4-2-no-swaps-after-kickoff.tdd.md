# RL-4-2: no lineup swaps on a player whose game already kicked off

Branch `claude/local-rl-4-2-no-swaps-after-kickoff`, base `origin/main` at `89f69b3b` (#161).
Plan items B11 / SS-01, B10 / ST-03 (late swap), ST-10; C13 / GR-01.

## Audit (on `89f69b3b`), written before the first test

What exists for this surface, by command:

| Question | Command | Answer |
|---|---|---|
| Do the live leagues lock per game? | `sqlite3 .local-db/data.sqlite "select id, json_extract(payload,'$.settings.rosterSettings.lineupLocktimeType'), platform from leagues"` (local copy, not production) | all 5: `INDIVIDUAL_GAME`, all `espn` |
| Does any lineup path read ESPN's lock flag? | `git grep -n "lineupLocked\|lineup_locked" -- server client/src scripts` | only `scripts/collect-roster-snapshots.mjs:91,131` and `server/migrations/058_league_roster_snapshots.js:43` (the snapshot collector). Control: the same grep finds those known hits, so the grep works. |
| Is there a kickoff producer? | `sed -n 1,25p server/services/game-cutoff.js` | yes, the one cutoff representation: `gameCutoff(season, week, team)` at `server/services/game-cutoff.js:19`, reading `game_lines.gameday/gametime` through `date-util.js:48 nflKickoffDate` |
| Are kickoff times on hand for the current weeks? | `sqlite3 .local-db/data.sqlite "select week, count(*), sum(gametime is not null and gametime<>'') from game_lines where season=2026 and week in (2,3,4) group by week"` | W2 32/32, W3 32/32, W4 32/32 |
| Start/Sit solve | `server/services/lineup-brain.js:446` pool = every non-IR player; `:481` `bestLineup` re-solves every slot; `:506-515` bench and "beat" alternatives from the same pool | no lock, no kickoff |
| League Hub card + Decision Inbox | `server/services/trade-engine.js:2814` `lineupDiff` solves the full lineup; `:2941` `expiresAt: Date.now() + 72 h` with the comment "No exact kickoff time is threaded into this module today" | no lock, flat 72 h |
| Inbox expiry | `server/routes/decision-inbox.js:65` `expireStale()` expires `open` rows with `expires_at <= now`, run on every `publishRecommendation` (`:100`) | a correct `expires_at` is honoured; nothing else needs to change there |
| Existing test pinning lock behaviour on a lineup solve | `git grep -n -i "lock" -- test \| grep -i lineup` | none on a lineup solve |

Baseline, the forward metric (local copy, not production). Command:

```
sqlite3 .local-db/data.sqlite "with r as (select id, league_id, expires_at, resolved_at, created_at,
  case when created_at < '2026-09-22 00:00' then 2 else 3 end wk, subject_ids from decision_recommendations where type='lineup'),
k as (select r.id, min(g.gameday||' '||g.gametime) first_ko from r, json_each(r.subject_ids) j join players p on p.id=j.value
  left join nfl_teams t on t.id=p.team_id left join game_lines g on g.season=2026 and g.week=r.wk and g.team=t.abbr group by r.id)
select r.league_id, r.wk, k.first_ko, r.expires_at, r.resolved_at from r join k on k.id=r.id order by r.created_at"
```

| Row | Week | First named kickoff (ET) | Closed at (min of expires, resolved) | Open after that kickoff |
|---|---|---|---|---|
| L4 | 2 | 2026-09-20 13:00 | 2026-09-22T01:01Z (expiry) | **32.0 h** |
| L5 | 2 | 2026-09-20 13:00 | 2026-09-18 10:09Z (superseded) | 0 |
| L1 | 2 | 2026-09-20 13:00 | 2026-09-18 10:08Z (superseded) | 0 |
| L2 | 2 | 2026-09-20 13:00 | 2026-09-21T10:09Z (expiry) | **17.2 h** |
| L3 | 2 | 2026-09-20 13:00 | 2026-09-18 10:09Z (superseded) | 0 |
| L1 | 3 | 2026-09-27 13:00 | open, expires 2026-09-25T19:08Z | 0 so far |

2 of 5 W2 rows stayed open after a named player locked (the queue's corrected figure; the R&D note's "2 of 6" counted the open W3 row). 13:00 ET on 2026-09-20 is 17:00Z. Caveat: teams are today's `players.team_id`, as in the R&D note.

### Extend or build

**Extend.** One producer each, reused:
- kickoff: `gameCutoff` (`game-cutoff.js:19`), no second clock;
- the lock flag: `playerPoolEntry.lineupLocked` from the payload the hourly `league_rosters` job already fetches (read today only by the snapshot collector);
- the solver: `bestLineup` (`trade-engine.js:637`) is not changed; a thin `pinnedBestLineup` removes locked starters and their slots, solves the rest with `bestLineup`, and puts them back.

**Build** only one leaf module, `server/services/lineup-lock.js` (lock state per rostered player), because `trade-engine.js` cannot import `lineup-brain.js` without a cycle (`test/lineup-surfaces-agree.test.js` header), and both surfaces must read the same lock. `trade-engine.js:340-362` (BLEND-01 / S-03) is not touched.

Not statistical: no projection, ranking or model number changes. The pinned solve is `bestLineup` itself whenever nobody is locked (tested). So no pre-registration and no 2025 holdout look.
