---
name: espn-player-endpoint-limits
description: Measured 2026-09-19 — ESPN's anonymous player endpoint returns 1042 players, but gridiron-hq asks for only 800, so cookies are not what limits the player pool.
metadata:
  type: reference
  modified: 2026-09-19T21:01:12.688Z
---

`syncPlayersFromESPN` (`server/routes/espn.js:40`) hits
`lm-api-reads.fantasy.espn.com/.../leaguedefaults/3?view=kona_player_info`
with an `X-Fantasy-Filter` of `{players:{limit:800, sortPercOwned:...}}`.

Measured **with no cookies at all**, same browser headers, season 2026:

| filter limit | players returned |
|---|---|
| 800 (ours) | 800 |
| 1500 | 1042 |
| 3000 | 1042 |

So **1042 is ESPN's own anonymous ceiling for this endpoint, and our own
`limit: 800` is the binding constraint** — we ask for 242 fewer players than
anonymous access freely gives. Consistent with the database holding 965
players / 800 ESPN ids.

**Consequence:** the code comment claiming cookies "can only help it see a
fuller/more current player pool" does not describe what limits us. Dropping
cookies from this call cannot cost players while our filter binds below the
anonymous ceiling.

**Caveat, do not overstate:** this is one-sided. The local database has no
leagues and no cookie pair, so the with-cookies side was never run. It proves
the anonymous side saturates 1042; it does NOT prove cookies could not exceed
1042. If that turns out to matter, use the requesting user's own credentials.

Raising `limit` past 800 is a separate one-line change, deliberately NOT
folded into the cookie-ownership work. Worth a thought about what the extra
242 are (deep bench, rookies) before assuming more is better.

See also [[gridiron-multi-user-gaps]].
