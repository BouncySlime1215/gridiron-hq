# TEAMS-V2 — NFL teams page redesign (design only)

Fable, 2026-09-26 11:50. Read-only pass over the repo and a copy of data.sqlite (copy deleted).

## 0. Data inventory (what we really have)

| Data | Table / file | Rows | Seasons | Verdict |
|---|---|---|---|---|
| Play-by-play (text, down, distance, clock) | `nfl_play_by_play` | 160 | 2026 wk 2 only | **Effectively empty.** No EPA, WPA or player ids. |
| nflverse play-by-play (desc, epa, wpa, wp, air_yards, yards_after_catch, yardline_100, qtr, time, passer/rusher/receiver ids) | `~/gridiron-local/rnd/data/pbp-redzone-4thdown/play_by_play_2025.csv` | 48,771 plays | 2025 only | **On disk, not in the DB.** Everything "key moments" needs. |
| FTN charting (motion, play action, RPO, screen, pressure, catchable, drop) | `nfl_play_charting` | 190,389 | 2022–2026 | Have. Keyed by game_id + play_id, joins to nflverse pbp. |
| Formations / personnel / coverage | `nfl_play_formations` | 187,421 | 2022–2025 | Have. |
| Per-play participation | `nfl_play_participation_players` | 0 | – | Missing. |
| Weekly usage (targets, carries, target share, WOPR, EPA by phase) | `player_week_usage` | 42,624 | 2021–2026 wk 2 | Have. |
| Volume indicators (snap share, routes, TPRR, RZ/GL/EZ targets & carries) | `nfl_volume_indicators` | 62,069 | 2016–**2025** | Have, but no 2026 rows yet. |
| Snaps | `nfl_snaps`, `player_week_snaps` | 129,555 / 40,890 | 2021–2026 wk 2 | Have. |
| Expected fantasy points (ffopportunity) | `nfl_ffopportunity_weekly` | 28,941 | 2021–2026 wk 3 | Have. |
| Depth charts | `nfl_depth` | 180,153 | 2021–2026 wk 3 | Have (`off_depth_chart` is empty). |
| Injuries | `nfl_injuries` | 28,716 | 2021–2026 wk 3 | Have. |
| Lines, totals, implied points, open/close, weather | `game_lines` (+ `nfl_line_snapshots`, `nfl_odds_archive`) | 15,096 | 1999–2026 | Have. |
| News with entities and fantasy impact | `news_items` | 1,785 | 2026 | Have. |
| NGS / PFR advanced | `nfl_ngs`, `nfl_pfr_adv` | 12,136 / 25,846 | 2021–26 / 2024–26 | Have (stats as JSON). |
| ESPN market (% owned, week and season proj) | `espn_player_market_weekly`, `espn_weekly_projection_snapshots` | 1,042 / 3,312 | 2026 | Have. Our projections: `server/services/projections.js`. |
| Radar events | `server/services/opportunity-radar.js` | 14 event types | fitted 2021–23 | Have, behind `GRIDIRON_OPP_RADAR`. |
| League-mate rosters | `league_roster_snapshots` | 2,337 | 2026 | Have (espn_player_id, team_id, on_roster). |
| Players and headshots | `players` (8,479 of 8,640 with espn_id) | – | – | Have. Headshots: `headshotUrl()` in `client/src/api.ts` (ESPN CDN). |
| Team colours | `nfl_teams.primary_color / secondary_color` | 32 | – | Have. **No logo table**; today an abbr in a coloured circle. |
| Clips / YouTube | `yt_channels` | 0 | – | Empty; used as the official-channel allowlist (section 2.3). No video is hosted or scraped. |

Not found: `server/services/proj-duel/` does not exist. "ESPN vs our model" is a join of `espn_weekly_projection_snapshots` and `projections.js`, not a service. Buy-low lives in `td-regression.js` and `talk-vs-model.js`.

## 1. Concept and IA

**Concept.** The Teams page stops being an encyclopedia and becomes Nick's scouting map: 32 NFL teams drawn as X's and O's where every X and O is priced. Each player on the diagram carries three facts at a glance — who in Nick's league rosters him, whether his opportunity is rising or falling, and whether the market (ESPN) is under- or over-paying him versus our model. One tap turns any of them into a trade idea. It is the same design system, the same area, one more reason to open it.

**IA (no new top-level page).** Players area → tab "NFL teams" (`/players?view=teams`) → team page (`/players?view=teams&team=KC`) → player card (the existing PlayerCard overlay, expanded with tabs). Breadcrumb: `Players / NFL teams / Chiefs`.

**The weekly hook.** Tuesday morning the grid re-sorts itself by "what changed": the league-wide movers strip at the top lists the five biggest opportunity shifts (radar events, snap trends, injuries) with an owner badge on each. Nick opens it to see who just got more valuable and which league-mate has not noticed yet.

## 2. Screens

### 2.1 Teams grid (`?view=teams`)
- **Movers strip** (Card, 5 Chips, horizontal scroll on phone): "Rashee Rice · snaps +14 pts · they: J.D." Tap → player card, Market tab. Source: radar + `nfl_snaps` + `nfl_injuries`. Empty: "No movers yet this week — box scores land Tuesday." Loading: 5 skeleton chips.
- **Sort control** (Chip group): Division (default) · Implied points this week · Most movement · Most owned by league-mates.
- **Team tiles** (32, grouped by division at 1440 in a 4x2 division grid; single column at 375 with division headers): logo or coloured monogram, name, this week's opponent and implied points (`game_lines`), a 3-dot ownership row (Nick / they / free), a small up/down arrow count (movers on this team). Tap → team page.
- Error: PageError with retry, tiles never half-render.

### 2.2 Team page (`&team=ABBR`)
Phase is a segmented Chip group inside the page (Offense · Defense · Special teams · Schedule), not a second tab row.

1. **Team strip.** Logo, coaches, this week's line: spread, total, implied points, open→now move, roof and weather, last five results as W/L dots. Tap the line → Sheet with the line history (`nfl_line_snapshots`).
2. **Formation v2 (the X's and O's).** Keep `FormationView` geometry and the strength/weak-spot pulse. Every slot gets: headshot, name, and a **layer** chosen by a Chip row: *Ownership* (Nick's colour, league-mate initials, or hollow for free agent), *Trend* (arrow from snap share last 3 vs season), *Health* (injury status), *Value* (ours vs ESPN: green under-priced, red over-priced). Desktop shows the diagram at full width with the layer legend right of it; phone stacks the legend under it and the diagram scales to 343 px. Tap any player → player card. Tap the unit (OL, secondary) → the unit Sheet with grade and analysis, as today.
3. **Usage board.** Table of the team's skill players: snap %, route %, target share, RZ touches, expected vs actual FP, each as a 6-week sparkline plus "last 3 vs season" delta. Owner column. Sort by any column. Phone: cards, two stats visible, "Show more". Source: `nfl_snaps`, `player_week_usage`, `nfl_ffopportunity_weekly`, `league_roster_snapshots`.
4. **Trade lane.** Up to five ideas: "Buy: Isiah Pacheco — 4th in RZ carries, 0 TDs (TD regression due), they: M.K., Coach thinks he is attached." Built from `td-regression.js`, expected-vs-actual gap, radar, `talk-vs-model.js`. Rule-filtered by never-give; shows "N ideas hidden by your rules". Tap → Trades area with the counterparty and target prefilled. Empty: "Nothing worth chasing on this roster this week."
5. **Radar events** for this team (Chips with evidence; "watch" items greyed).
6. **Measured identity** (tendencies, keep as is).
7. **Schedule** with implied points and opponent defence-vs-position per week.
8. **News** (existing NewsList, max 8).

### 2.3 Player sheet — the ONE player overlay app-wide
Tapping any player anywhere (Teams, ESPN vs our model, Trades, Coach, Players board, Today) opens the same Sheet: the existing `PlayerCard` (`usePlayerCard`, already imported in 7 places) grows into it; `PlayerDetail.tsx` becomes a redirect to the Sheet. No second player overlay is ever added.

**Header:** headshot, name, position, team logo, depth slot, injury status Chip, owner badge (Nick / they-initials / free).
**Tabs:** **News · Role · Moments · Market.** News is first and is what opens by default.

- **News (ESPN, latest first).** Each row: headline, relative time plus timestamp ("2h ago · Thu 14:05"), source Chip ("ESPN" / "ESPN Transactions"), injury status Chip when the story is an injury item, and an external link to the ESPN story (`source_url`, new tab). Up to 6 rows, then "All his news" → Players → News filtered to him. Loading: 3 skeleton rows at final size. Empty: "No ESPN stories about him in the last 30 days." Error: inline retry.
  - *What we hold today:* `news_items` (1,785 rows, 2026) from ESPN's team feed (`site.api.espn.com/.../nfl/news?team=`, pulled by the scheduler's `espn_news` job every 30 min, plus `rss_news`). Fields: headline, body, published_at, source, source_url, injury_entities_json, transaction_type, fantasy_impact, and `entities_json` with player ids (830 of 1,785 stories are tagged to a player, by alias match). Attribution to a player is produced once, in `server/news/player-news.js`, and the card already renders `p.news`. So the first version needs no ingestion.
  - *Gap and ingestion:* team feeds miss player-specific notes (returns, snap-count notes, contract items). Add a per-player pull to the `espn_news` job: `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{espn_id}/overview` (already used by `server/services/espn-player-notes.js`), whose `news` array carries headline, published, description, and `links.web.href`; injury status comes from the same payload. Poll only `fantasy_relevant` players (864) on a rolling cursor, about 100 per run, and upsert into `news_items` with `entities_json` pre-set to that player (dedupe on canonical_url). Field names to be confirmed on the first live pull.
- **Role:** depth slot and pos rank, injury line, six-week sparklines (snap %, routes, target share, RZ), radar events with evidence, NGS and PFR chips (separation, YAC over expected, pressure rate).
- **Moments:** his five highest-|WPA| plays of the season. Each: quarter and clock, down and distance, the official play description, win-probability swing (`wp` before → after), EPA, and an animated diagram on our own field graphic drawn from `yardline_100`, `air_yards`, `yards_after_catch`, `pass_location`/`run_gap` (transform/opacity only, reduced-motion shows the static end state). Under it: "Watch highlights" → external YouTube search `"{player} {team} vs {opp} week {n} highlights"`, no embed. Footer: "Play data: nflverse (CC BY 4.0)". Empty: "No graded plays yet this season."
- **Clips (inside Moments, above the play list).** The official game-highlight video for each of his games, embedded with the standard iframe on `youtube-nocookie.com`, official channels only, embed-allowed videos only. When a player-specific official clip exists (for example the team channel's "Every X catch" video), embed that instead and use `?start=` to jump to his moment. A game selector Chip row (Wk 1 … Wk N) above the player; the current week's game first. States: loading skeleton at 16:9; no key → the "Watch highlights" link-out only; no match → link-out only with "No official video found yet"; embed refused → link-out.
  - *Auto-matching design.* YouTube Data API v3 `search.list` with `type=video`, `videoEmbeddable=true`, `channelId` restricted to an allowlist (NFL's official channel plus the 32 team channels, stored in the empty `yt_channels` table), `q="<away> vs <home> week N <season> highlights"`, `publishedAfter=` game kickoff, `publishedBefore=` kickoff + 3 days. Accept the top hit only if its channelId is on the allowlist and the title contains both team names; then `videos.list` with `part=status` to confirm `embeddable`. Player-specific clip: a second search with `q="<player name> highlights week N"`, same allowlist, same date window; optional.
  - *Cache.* New table `yt_game_videos` (season, week, game_id, video_id, channel_id, title, published_at, kind game|player, player_id nullable, start_seconds nullable, matched_at, checked_embeddable). One row per game; refresh in the scheduler after the game's final (game_lines has scores), retry up to 3 times over 48 h, never re-search a matched game.
  - *Key and quota.* This needs a YouTube Data API key that Nick creates himself in Google Cloud (free tier, 10,000 units a day). It is entered in Settings > AI & developer like the other keys; without it the Moments tab shows the link-out and says "Add a YouTube key in Settings to embed highlights". Quota: about 16 games a week × 100 units per search = 1,600 units, plus 1 unit per `videos.list` check; player-specific searches add 100 each, so cap them at 30 a week. Retries stay under 5,000 units. Well inside the daily free quota.
- **Market:** our projection vs ESPN, ROS, FantasyCalc value and 30-day trend, % owned, **who rosters him in each of Nick's leagues** ("they: J.D. — 3rd in standings"), buy-low / sell-high verdict with the reason, "Start a trade" button.
- **News:** existing list filtered to him.

## 3. Creative features, ranked by value to trading and title odds

| # | Feature | Source | Feasibility | Size |
|---|---|---|---|---|
| 0 | One player sheet, ESPN news first, opened from everywhere | `news_items` + `server/news/player-news.js`; per-player pull later | have (v1), need-a-join (per-player pull) | 1 |
| 1 | Ownership layer on the X's and O's (Nick / they / free) | `league_roster_snapshots` ↔ `players.espn_id` | need-a-join (one query) | 1 |
| 2 | Trend and value layers (snap trend, ours vs ESPN) | `nfl_snaps`, `projections.js`, `espn_weekly_projection_snapshots` | have | 1 |
| 3 | Movers strip and "most movement" sort | radar + snaps + injuries | have (radar flag must be on) | 1 |
| 4 | Trade lane on the team page | `td-regression.js`, ffopportunity gap, `talk-vs-model.js`, never-give | need-a-join (one composer) | 2 |
| 5 | Usage board with sparklines | usage, snaps, ffopportunity | have (2026 volume indicators missing, use snaps + usage) | 1 |
| 6 | Key moments with animated play diagrams | nflverse pbp 2025 CSV; 2026 needs ingestion | need-a-join (load CSV → table) | 2 |
| 7 | Line strip and line-history Sheet | `game_lines`, `nfl_line_snapshots` | have | 0.5 |
| 8 | Team logos | ESPN CDN by abbr, same pattern as headshots | need-a-join (one helper) | 0.25 |
| 9 | Charting chips per moment (play action, motion, pressure) | `nfl_play_charting` join on play_id | have | 0.5 |
| 10 | "Watch highlights" link-out | none (URL template) | have | 0.25 |
| 11 | Embedded official highlights, auto-matched | YouTube Data API v3 + `yt_channels` allowlist + new `yt_game_videos` | missing (needs Nick's API key) | 1.5 |

## 4. Data gaps and ingestion

1. **nflverse play-by-play into the DB.** New table `nfl_pbp_plays` (season, week, game_id, play_id, posteam, defteam, qtr, time, down, ydstogo, yardline_100, desc, play_type, passer/rusher/receiver gsis ids, air_yards, yards_after_catch, pass_location, run_gap, epa, wpa, wp, success, touchdown). Load 2025 from the CSV on disk today; add a weekly fetch of `play_by_play_2026` from nflverse releases (same source `nfl_play_charting` already uses). About 50k rows per season, roughly 40 MB. Keep the CC BY attribution string in the served payload.
2. **2026 volume indicators.** `nfl_volume_indicators` stops at 2025; either run its builder for 2026 or derive route % and RZ shares from the new pbp table.
3. **Team logos.** Not stored; use the ESPN CDN URL helper next to `headshotUrl()`.
4. **Per-player ESPN news.** Team feed only today; add the athlete overview pull to `espn_news` (section 2.3). No new table, `news_items` upserts.
5. **YouTube.** Fill `yt_channels` with the 33 official channel ids; add `yt_game_videos`; scheduler job `yt_highlights` after finals; API key from Nick in Settings.
6. **Participation** stays missing; nothing above needs it.
7. Nothing to ingest for ownership, lines, injuries, depth, ESPN projections.

## 5. Build plan (each unit ships alone)

**Unit 1 — The one player sheet, ESPN news first (buildable now).** Grow `PlayerCard` into the tabbed Sheet (News · Role · Moments · Market) with the News tab from `p.news`; every opener app-wide (Teams, ESPN vs our model, Trades, Coach, Players, Today, `PlayerDetail` redirect) uses it. Accept: one component opens from all 7 call sites; news rows show headline, timestamp, source Chip, injury Chip and an ESPN link in a new tab; loading, empty and error states at 375 and 1440, light and dark; no dev text; per-player ESPN pull added to `espn_news` behind the same job (no new table).

**Unit 2 — Priced X's and O's (data we have).** Logo helper; ownership, trend, health and value layers on `FormationView`; team strip with this week's line; teams grid sorted by implied points. Accept: every slot shows a layer badge with a label; tapping any player opens the Unit 1 sheet; no overflow at 375/1440 light and dark; no league-mate names in fixtures (initials only); one producer per number (projections from `projections.js`, ownership from the roster snapshot route).

**Unit 3 — Usage board + movers strip.** Sparklines from snaps and usage; movers strip on the grid; "most movement" sort. Accept: sparklines skeleton at final size; empty state before Tuesday; radar off → strip shows snap-trend movers only, labelled as such.

**Unit 4 — Trade lane + Market tab.** Composer joins td-regression, ffopportunity gap, radar and talk-vs-model into ≤5 rule-filtered ideas; Market tab with "Start a trade" prefill. Accept: hidden-by-rules count shown; no idea where Nick gives more FantasyCalc value than he gets (cap 0); every idea names its evidence.

**Unit 5 — Key moments.** Ingest nflverse pbp (2025 now, 2026 weekly); `/players/:id/moments` route; Moments tab with field diagram, WP swing, charting chips and the YouTube link-out. Accept: top-5 by |WPA| matches a hand check on the CSV for two players; reduced-motion static; attribution visible; external link opens in a new tab.

**Unit 6 — Embedded official highlights.** `yt_channels` allowlist, `yt_game_videos` cache, `yt_highlights` scheduler job, Settings key entry, embed in the Moments tab with the link-out fallback. Accept: with no key the tab renders the link-out and the Settings hint; with a key, 16 games match on the first Tuesday with under 2,000 units spent (logged); every embedded video's channel id is on the allowlist and `embeddable` is true; the game selector never overflows at 375.

**Unit 7 (optional) — Line history Sheet and schedule implied points.**

Rough total: about 8.5 units.

## 6. Privacy

Public repo: league-mate identity is rendered as initials from `league_member_identity` at request time and never committed; fixtures and tests use "Team A/B". Ownership badges in committed screenshots are replaced by the "they" glyph. Screenshots stay under `~/gridiron-local/evidence/`. No ESPN cookies or league ids in URLs beyond the existing league picker.
