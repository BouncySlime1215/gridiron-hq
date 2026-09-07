# Research: other fantasy platform integrations

Researched 2026-09-07. Scope: platforms beyond ESPN (whose REST-freezes-mid-draft
problem and reverse-engineered WebSocket protocol are already solved — see
`docs/RESEARCH_ADOPTABLE_CODE.md`). Verified live against GitHub (API + code
search) and direct calls to Sleeper/MFL/Fleaflicker/Yahoo endpoints, not just
READMEs.

## Repo table

| Repo | ★ | Last push | License | What it does | Adoptable? | Honest take |
|---|---|---|---|---|---|---|
| [dtsong/sleeper-api-wrapper](https://github.com/dtsong/sleeper-api-wrapper) (Py) | 101 | 2026-09-03 | MIT | Thin `requests` wrapper: `league.py`, `drafts.py`, `players.py`, `stats.py`, `user.py` | Endpoint map only | Alive but trivial — `base_api.py` is literally `requests.get(url)` + `raise_for_status`. Zero reason to port to JS; read it as a URL list, don't depend on it. |
| [whatadewitt/yahoo-fantasy-sports-api](https://github.com/whatadewitt/yahoo-fantasy-sports-api) (JS, npm `yahoo-fantasy@5.3.0`) | 227 | 2026-08-06 | MIT | Node OAuth2 + full resource/helper coverage incl. `draft_results` on team + league resources (verified via code search: `resources/leagueResource.mjs`, `helpers/teamHelper.mjs`) | **Yes — drop-in** | The only serious JS Yahoo client. npm publish is stale (2024-04) vs. repo (2026-08) — vendor from git, not npm. |
| [uberfastman/yfpy](https://github.com/uberfastman/yfpy) (Py) | 263 | 2026-04-21 | **GPL-3.0** | Best-documented Yahoo wrapper; models every resource | Reference only | GPL-3.0 — do not vendor into a closed app. Useful purely to learn Yahoo's XML→JSON shape quirks. |
| [mattdodge/yahoofantasy](https://github.com/mattdodge/yahoofantasy) (Py) | 86 | 2026-05-13 | **none** | Yahoo SDK w/ CLI OAuth login flow | No | `mattdodge/yahoo-fantasy-sports-api` **does not exist** (404); this is the repo you meant. No LICENSE file = legally unusable. |
| [edwarddistel/yahoo-fantasy-baseball-reader](https://github.com/edwarddistel/yahoo-fantasy-baseball-reader) (JS) | 92 | 2026-08-31 | **none** | Script, not a library; baseball-only | No | Active, but no license and wrong sport. Only value: a worked Yahoo OAuth2 token-refresh example. |
| [mkreiser/ESPN-Fantasy-Football-API](https://github.com/mkreiser/ESPN-Fantasy-Football-API) (JS) | 351 | **2025-01-04** | **LGPL-3.0** | JS ESPN client | No | ~20 months stale, and this app already beats it (real draft-room WS). LGPL is also awkward. |
| [ffverse/ffscrapr](https://github.com/ffverse/ffscrapr) (R) | 94 | **2024-11-01** | NOASSERTION (MIT in DESCRIPTION) | One R interface over MFL / Sleeper / Fleaflicker / ESPN | Design only | **Effectively dormant** (~22 months). The abstraction (`ff_connect()` → `ff_league/ff_rosters/ff_draft`) is worth copying; the code is not portable. |
| [joeyagreco/leeger](https://github.com/joeyagreco/leeger) (Py) | 86 | **2024-12-25** | MIT | Closest thing to ffscrapr outside R: `league_loader/{ESPN,Sleeper,Yahoo,MyFantasyLeague,Fleaflicker}LeagueLoader.py` | Model design | Dead ~21 months, but it proves 5-platform normalization is tractable and shows the seams. |

**There is no JS/TS ffscrapr analogue.** npm search returns only MCP wrappers
(`sleeper-mcp`, `@unclick/sleeper-mcp`), a 2019 `sleeper_fantasy`, and an unproven
`sleeper-sdk@1.0.0` (2025-11). The multi-platform JS repos that exist
(`Krool/FantasyFootballAnalyzer`, 6★) are apps, not libraries. **This is a genuine
gap worth filling, not duplicating.**

## Sleeper: no WebSocket, and none is needed

GitHub code search for `ws.sleeper.app` returns **one hit, in a markdown file** —
no repo anywhere implements a Sleeper draft socket. Confirmed the REST path live
against a real 2026 league draft (`draft_id 1368354515882889216`), unauthenticated,
no cookies, no key:

- `GET /v1/draft/{id}` → `draft_order` (user_id→slot), `slot_to_roster_id`,
  `settings.{rounds,teams,slots_*,pick_timer}`, `status`, `last_picked`
- `GET /v1/draft/{id}/picks` → picks, each **self-contained**: `pick_no`, `round`,
  `draft_slot`, `roster_id`, `picked_by`, plus a `metadata` blob with
  `first_name/last_name/position/team/injury_status/years_exp`. **No
  player-dictionary join required to render a board.**

The decisive difference from ESPN: Sleeper's picks endpoint reflects true live
state on every request, including mid-draft and mock rooms (mock `draft_id`s hit
the identical public endpoints; their `league_id` is `null`). ESPN's REST freezing
mid-draft is what forced the WS work here — **Sleeper has no such failure, so a
3-6s poll loop is the correct and complete implementation.** Two gotchas worth
stealing:
1. Autopick/bot picks can have `roster_id: null` and `picked_by: ""` — resolve
   team identity via `draft_slot` → `slot_to_roster_id`, never the pick's own
   `roster_id`.
2. Unmade picks are simply **absent** (no ESPN-style `playerId: -1` placeholders).

Sleeper exposes no ADP/draft-rank field — supply your own. Other endpoints:
`/league/{id}`, `/league/{id}/{rosters,users,matchups/{wk},transactions/{wk},traded_picks,winners_bracket}`,
`/user/{name}`, `/user/{id}/leagues/nfl/{season}`, `/user/{id}/drafts/nfl/{season}`,
`/league/{id}/drafts`, `/players/nfl` (multi-MB, cache daily), `/state/nfl`
(verified: week 1, 2026), `/players/nfl/trending/{add|drop}`. Rate limit is
soft/undocumented — treat ~1000 req/min per IP as a ceiling, not a promise.

## Yahoo, MFL, Fleaflicker

Yahoo is officially documented and **OAuth2 three-legged only** — a hard `401` on
an unauthenticated `game/nfl` call confirms it. Friction is real: register an app
at sports.yahoo.com/developer, ship a redirect URI, store a refresh token per
user, parse Yahoo's XML-shaped JSON (deeply nested numeric-keyed arrays — where
`yfpy`/`yahoo-fantasy` earn their keep). Rate limits undocumented; treat as
unknown. **No live draft socket is documented**, but Yahoo's own docs state
`draftresults` called *during* a draft returns picks made so far — Yahoo is also a
polling target, likely at a slower cadence than Sleeper.

MFL is fully open: `https://api.myfantasyleague.com/2026/export?TYPE=players&JSON=1`
returned **HTTP 200 with real data, no key** (a key is required only for
higher-volume/private-league calls). Fleaflicker's API is undocumented-but-public
and needs no auth — `FetchLeagueStandings?sport=NFL&league_id=1` returned a clean
JSON 404 (`"can't find league 1"`), i.e. the endpoint is live and just wanted a
real league id. Both are cheap wins; `leeger`'s loaders are the fastest reference
for their payload shapes.

## Recommendation

Build the ffscrapr-shaped adapter interface in TS (nobody has one in JS),
implement Sleeper first — pure polling, no auth, roughly one afternoon of work —
vendor `whatadewitt/yahoo-fantasy-sports-api` from git (not npm) for Yahoo, and
add MFL/Fleaflicker as low-cost extras. Avoid `yfpy` (GPL) and the two unlicensed
Yahoo repos.

**Not yet built.** This is prior-art research only — no code changes in this repo
came from this doc.
