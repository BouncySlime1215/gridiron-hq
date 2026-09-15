# G12-news — News ingestion, verification, extraction, and whether news reaches a forecast

Reader: G12-news. Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Date: 2026-09-12.
Files: 16, lines read: 3,084 (every line of every file; wc -l totals match). DB observed with node:sqlite readOnly only.

## 0. Executive answer to the focus questions

**Ingestion.** Four writers feed `news_items` (3,325 rows): ESPN RSS (`server/news/ingest.js`, one feed), twitterapi.io insider sweep (`server/news/twitter-ingest.js`, 108-handle pool, 5 handles per 4h), the ESPN transactions wire (`nfl-transactions.js`, via `normalize.js`/`store.js`), and the ESPN public news API (`routes/espn.js`, NOT through normalize/store — 1,796 rows with no `source_url`, no `source_type`, no `duplicate_group_id`). Only the first three go through provenance/dedup.

**Verification.** Two independent layers. (a) Source identity: `nfl-news-signal.js:37-56 newsSourceVerification()` — allowlisted publisher domains, or a social handle with a `news_source_validation` row `verdict='valid'` checked within 30 days. 108 handles validated on 2026-08-29 (107 valid, 1 questionable). **That check expires 2026-09-28 and nothing re-runs it automatically** (only `POST /news/sources/validate`). (b) Evidence: every LLM claim must contain a verbatim `evidence_span` substring of the story (`nfl-news-signal.js:296`, `nfl-news-events.js:181`). The 119,639-row `nfl_verified_events` table is **not news verification at all** — it is `nfl-event-archive.js`'s archive of nflverse weekly-roster observations (`event_type='weekly_roster_observation'`, `source='nflverse_weekly_rosters'`), read by `nfl-expert-council.js:255-262` only as a fallback when typed news is absent. None of the 16 files here read or write it.

**Extraction (Claude).** All calls go through `claude.js callClaude`, default and only model `claude-haiku-4-5-20251001` ($1/$5 per M). Three extractors: rules (`syncStructuredNewsSignals`, free, every 15-60 min), `syncAiNewsSignals` (hourly, `limit 20`, attempts table stops re-billing; 156 calls, 105K in/32K out ≈ $0.27 lifetime), and Package E `extractNewsEventsFromItems`/`extractPressConferenceRoleSignals` (manual only; 1 call each; content-hash cache). No global Anthropic spend cap exists; the guards are per-run `limit`, the attempts/cache tables, and the `getApiKey()` short-circuit. The largest Claude consumer downstream of news is `nfl-tweet-line-explain` (557 calls, ≈$0.42, 2026-08-27..09-01) in `nfl-tweet-line-correlation.js` (out of scope, fed by `twitter-ingest.js:221`).

**Twitter cost.** `twitterapi_io_usage`: 777 rows, $1.185 total ($1.1085 sweep over 370 calls / 7,390 tweets; $0.073 handle verification; $0.003 smoke). Hard budget $10, soft stop $9.50, DB-persisted and checked before every call (`twitterapi-io.js:47-52`). Run rate: 5 handles × 6 runs/day × $0.003 = ~$0.09/day. 369 of 370 sweep calls returned exactly 20 tweets (the page cap), i.e. every call re-reads and re-bills the same latest window because the query has no `since:` bound; URL dedup prevents duplicate rows but not the spend.

**Does news reach a numerical forecast?** Yes, but never a production decision, and never via the frozen T-60 packet:
1. `nfl-news-signal.js teamNewsSignals()` → `nfl-online-neural.js:147-154` as 8 scaled features (`state: 'active_shadow'`, 0 units).
2. `teamNewsSignals()` → `nfl-expert-council.js:234-262 newsFor()` → `news_reaction` expert forecast `= clamp(burdenEdge*0.75, ±4)`, authority `'historical_candidate_only'`.
3. `playerNewsSignal()` → `nfl-postgame-truth.js:514-520` overwrites carry-forward `unavailable_probability` with the news value → `gameInjuryCarryover` → council/unified engine `injury_carryover` head.
4. Fantasy: `player-week-engine.js:219` attaches `news_context` (display only, not applied to ppg); `news-fantasy-impact.js` computes a shadow scenario (`authority: 'shadow_scenario'`); **`news-lag-trader.js newsOpportunities()` emits concrete fantasy ACTIONS (claim_waiver / buy_beneficiary / buy_low) straight from `nfl_news_signals`** via `GET /trades/:leagueId/news-edge`.
5. Money: `nfl-capture-dispatch.js:35-56 enqueueRecentNewsTriggers()` turns any verified signal with `unavailable_probability>=0.5` into a paid Odds API capture trigger (37 news triggers already `captured`).
None of these consume the T-60 packet; all read live tables with a `before` cutoff. Codex required return #4 remains undelivered — confirmed from this group's side: the word "packet" does not appear in any of the 16 files.

**Health verdict: messy.** The provenance/verification scaffolding is thoughtful, but the rules extractor has a design bug that produces confidently wrong, "verified" claims (Lamar Jackson and Derrick Henry currently carry `status='released', unavailable_probability=1.0, verified`), those claims have already triggered paid captures and would drive the fantasy news-edge actions, team attribution is wrong on 193 RSS rows because "WAS" and "NO" are English words, the biggest news feed is quarantined for lacking a URL, and the press-conference keyword filter is a no-op.

## 1. Defects (ranked)

### D1 — P1 — Every player in a story inherits the story's first-matching status (nfl-news-signal.js:144-163)
```
for (const entity of players) {
  const key = normalizePlayerName(entity.name), team = teamForEntity(entity, item.team_id);
  for (const rule of STATUS_RULES) {
    const match = text.match(rule.re);
    if (!match) continue;
    insert.run(item.id, key, ..., 'availability', rule.status, bodyPart, rule.unavailable, null, ...
```
`text` is the whole headline+body (line 136); the regex is tested once per story, not per player sentence, and the same status is inserted for every resolved entity. Combined with `STATUS_RULES[0]` (line 69) `/\b(?:waived|released|cut|terminated)\b/` being first and matching "cut-down day", "released a statement", "waived LBs …" the result is wrong claims with the highest confidence in the table (0.95, capped by reliability).
Evidence (DB, read-only): 38 stories / 95 rows carry an identical availability status for 2+ players. `news_id 12471` "Ravens initial 53-man roster breakdown" → Lamar Jackson, Tyler Huntley, Joe Fagnano, Adam Randall, Chris Moore all `released`, span `waived`. `news_id 12473` → Derrick Henry, Justice Hill, Rasheen Ali, Devontez Walker `released`. Last 14 days of `status='released' AND verification_state='verified'` also include Dak Prescott, George Pickens, Sam Howell (DAL), Drake Maye (NE, span `cut`), Brandon Aiyuk (span `cut`), Chuba Hubbard/Jonathon Brooks (CAR), Jake Elliott/Tanner McKee (PHI), Zach Charbonnet, Javonte Williams. Lamar Jackson's and Derrick Henry's **latest** availability signal is `released` (2026-08-31 / 08-30).
Impact: (a) `nfl-capture-dispatch.js:36-39` queues paid Odds API captures for `unavailable_probability>=0.5` — `nfl_capture_triggers` shows `BAL availability: released` ×2 captured, `DAL` ×2 captured, `NE` ×3 captured, `NO` ×2 captured: real credits spent on fiction. (b) `news-lag-trader.js:145,162-177` treats `released` as NEGATIVE and recommends buying the depth-chart beneficiary of Lamar Jackson / Dak Prescott. (c) `teamNewsSignals('BAL').unavailable_burden` sums 1.0×0.75 for Jackson, Henry, Hill, Walker… → council `news_reaction` forecast pinned at −4 (its clamp) for BAL, and the online-neural `home_verified_news_burden` feature saturates. (d) `nfl-postgame-truth.js:514-520` would set Jackson's carry-forward unavailable probability to 1.0.
Fix: split text into sentences/clauses and require the player's name (or surname) inside the clause that matched; demote the transaction rule below injury rules and require an object pattern (`(waived|released|cut) (?:\w+ ){0,3}NAME`); never emit `released` for a player whose own team is the story's team and who is a starter without an explicit object match. Add a regression test using news_id 12471's text.

### D2 — P1 — Team abbreviations "WAS" and "NO" match the English words, misattributing 193 RSS/Twitter stories (normalize.js:19-24, ingest.js:73)
```
const match = entries => entries.filter(entity => (entity.aliases ?? [entity.name, entity.abbr]).filter(Boolean)
  .some(alias => haystack.includes(` ${normalizedHeadline(alias)} `)))
```
`loadIdentity()` (ingest.js:49) passes `abbr` for every team; `normalizedHeadline('WAS')` is `was`, `'NO'` is `no`. `ingest.js:73` then takes `entities.teams[0]` as `team_id`, and nfl_teams is ordered ARI..WAS by id, so any headline containing " no " lands on New Orleans (id 23) and any containing " was " on Washington (id 32).
Evidence: of 203 typed (source_type NOT NULL) rows attributed to WAS/NO, 193 do not mention the team (WAS 113, NO 80): "Packers RB Jacobs pleads no contest…"→NO, "Mahomes says he'll play without limitations…"→NO, "Panthers RB Brooks has no limitations against Bears"→NO. WAS is the single most-attributed team in the typed news set (120) purely from this. 67 `nfl_news_signals` rows inherited a team from these items via `teamForEntity`'s fallback (`nfl-news-signal.js:97-102`).
Impact: `GET /news?team=WAS|NO` is garbage; `nfl-expert-council.js:240-241 feedStories` counts `news_items` by `team_id` and uses `feedStories>=3` to decide `forecast=0` vs `null` (evidence_state), so WAS/NO games get a fabricated "feed present" state; the team card and desk ranking (`official`/team badges) are wrong for those rows. The test in `test/modeling-news.test.js:54` only covers aliases, never `abbr`.
Fix: drop `abbr` from the team alias list in `extractEntities` unless it is uppercase-matched against the raw (non-lowercased) text with a `#`/word-boundary rule; backfill `team_id` for `source_type IS NOT NULL AND team_id IN (23,32)`.

### D3 — P2 — The largest news source is quarantined for lacking a URL (nfl-news-signal.js:38-39 with routes/espn.js:197)
```
const host = sourceHost(item?.source_url);
if (!host) return { state: 'quarantined', reason: 'missing or invalid source URL' };
```
`routes/espn.js:197` inserts ESPN API stories without `source_url`; 1,796 `news_items` rows (54% of the table) have `source_url IS NULL`. Every typed claim from them is quarantined (89 of the 93 quarantined signals are `source='ESPN'` with no URL; the other 4 are 2 Garafolo/1 RapSheet tweets and 7 legacy 'source not evaluated'). Quarantined claims never reach `playerNewsSignal`, `teamNewsSignals`, `/news/signals`, `news-lag-trader`, or capture triggers. So the pipeline trusts a beat writer's tweet more than ESPN's own league feed. Fix: in `newsSourceVerification` treat `source='ESPN' AND source_type IS NULL AND source_url IS NULL` as the ESPN publisher (or have the ESPN route store `a.links?.web?.href`). Note the ESPN route already dedups by exact headline only (`routes/espn.js:179`), bypassing `duplicate_group_id`.

### D4 — P2 — Social-source verification silently expires on 2026-09-28; nothing re-validates (nfl-news-signal.js:48-50, source-validation.js:86-117)
```
const checkedAfter = new Date(Date.now() - 30 * 86400000).toISOString();
const source = rows(`SELECT verdict,checked_at FROM news_source_validation WHERE lower(handle)=lower(?) AND checked_at>=? LIMIT 1`, handle, checkedAfter)[0];
```
`MAX(checked_at)` in `news_source_validation` is 2026-08-29T20:40Z. `validateAllSources` is called only from `POST /news/sources/validate` (`routes/nfl-betting.js:1593`), not by any scheduler job (`scheduler.js` JOBS has no entry). On 09-28 the next `syncStructuredNewsSignals` run will flip every tweet-derived claim in its 14-day window to `quarantined` through the upsert's `verification_state=excluded.verification_state` (line 132) — a silent loss of the fastest fantasy signal source during Weeks 3-4. The 14-day `REVALIDATE_AFTER_DAYS` (source-validation.js:86) and the 30-day consumer window are two unrelated constants. Fix: add a `news_source_validation` scheduler job at 7-day cadence (≈$0.02/run), or have `refreshTwitterInsiders` call `validateAllSources()` when `MAX(checked_at)` is older than 21 days.

### D5 — P2 — Press-conference keyword filter is a no-op because 'ir' matches "first", "third", "fire" (press-conference.js:238-241, 270-273)
```
const INJURY_TERMS = ['injur', 'out for', ..., 'setback', 'ir', 'placed on'];
...
const term = INJURY_TERMS.find(t => lower.includes(t));
```
`lower.includes('ir')` is true for almost any sentence. DB: 113 of 171 `press_availability` rows have `keyword='ir'`, with quotes like "You and your girls and there's ticker tape along the ground" attributed to Hunter Long (surname "Long" matched "long" via the `>3` surname rule at line 275-278). These rows feed `pressAvailabilityFor` (UI) and `extractPressConferenceRoleSignals` (`nfl-news-events.js:220-226`), which billed a Claude call on 20 of them and stored 20 `role_change_unconfirmed` events marked `verified`. Fix: word-boundary regexes (`\bIR\b`, `\breturn(?:ed|ing)?\b`), surname match with `\b`, exclude common-word surnames, and require the roster from the current season.

### D6 — P2 — The twitter_insiders job is abandoned at its 120s budget on every recent run, but keeps spending in the background (twitter-ingest.js:193-225 with scheduler.js:937-972)
`sync_log`: `twitter_insiders last_status='error'` "exceeded its 120s budget and was abandoned so the rest of the tier could run", `runs: 76`; `press_conferences` same. `twitterapi_io_usage` shows the sweep calls landing at 03:56:41-59 after `last_run_at` 03:56:40 — the abandoned promise continues, so the cursor advances and money is spent while the registry records failure (confidence 0.1 via `source-registry.js:255`). Per stored tweet, line 221 calls `watchTweetForLineMove`, which inserts one row per (event, market, side) of the latest snapshot for the team (`nfl-tweet-line-correlation.js:59-67`) — `nfl_tweet_line_watch` is at 20,560 rows — and then `refreshTwitterInsiders` runs a full `syncStructuredNewsSignals({sinceDays:1})`. The result is a job whose reported status is meaningless. Fix: raise this job's budget override or move the line-watch fan-out and typing off the ingest path; make `ingestTwitterInsiders` check elapsed time between handles.

### D7 — P2 — The insider sweep re-reads and re-bills the same 20 tweets per handle, and reads the most valuable accounts no more often than the least (twitter-ingest.js:119, 128-139, 195)
```
const MAX_TWEETS_PER_RUN = 5;   // handles per sync call, cost-bounded
...
const result = await searchRecentTweets(`from:${handle} (injury OR questionable OR doubtful OR out OR starting OR benched OR practice)`, ...
```
No `since:`/`since_id` bound; 369/370 calls returned exactly 20 items, so every visit pays for a full page regardless of novelty. Pool = 12 national + 32 team + 64 beat = 108 handles at 5 per 4h → each handle every 3.6 days, Schefter included. For a prolific national insider the "latest 20 matching" window covers well under a day, so Week-1 breaking news from the accounts the file's header calls "the whole reason this exists" is structurally missed most of the time. Not a money bug ($0.09/day), an information-coverage bug. Fix: weight rotation (nationals every run), pass `since:` from the handle's last stored `published_at`.

### D8 — P2 — twitter-ingest.js ignores the validation verdicts it paid for (twitter-ingest.js:128-139; source-validation.js:191-199)
`TWITTER_SWEEP_HANDLES` is built from the three static lists; `trustedHandles()` ("Which handles the ingest should actually read", source-validation.js:191) is only used by `GET /news/sources`. One national handle is currently `questionable`; it is still swept and its tweets stored, then every claim from it is quarantined downstream. Cost is trivial; the defect is that the documented control is not wired.

### D9 — P3 — Package E novelty check cannot see same-batch claims (nfl-news-events.js:347-349)
`first_seen_time<?` with the batch's shared `now` (line 175) means two claims about the same player extracted in one call are both `novelty_label='new'` with no contradiction check. Also `computeNoveltyAndContradiction` runs after `ON CONFLICT DO NOTHING` (line 115) so a re-seen event gets its novelty recomputed against a "prior" that may be itself.

### D10 — P3 — preClaimVolatility compares ISO strings lexicographically (nfl-news-event-impact.js:119)
`q.snapshot_at <= pivotTime && q.snapshot_at >= since` while `reactionPairs` (line 92-93) uses `new Date()`. Works only while every `nfl_quote_tape.snapshot_at` shares the exact ISO shape; mixed precision would silently misorder. Impact model currently has 0 usable rows anyway (`server/data/news-event-impact/latest.json`: `claims_considered 24, skipped_no_quote_pair 24, insufficient_data true`).

### D11 — P3 — news-fantasy-impact tracker confirms "out" trivially and marks positives "missed" whenever usage rows are absent (news-fantasy-impact.js:45-53, 98-102)
`finished` is true once `team_score` is set even when `actual` is null; `opportunities` then is 0, so every availability claim with `unavailable_probability>=0.5` is "Report confirmed" and every `available_positive` is "Report missed" for any player without a `player_week_usage` row (kickers, defenders, healthy scratches, ingestion lag). The `tracker.confirmed/missed` counts on `/news/signals` are therefore not a calibration signal.

### D12 — P3 — espn-player-notes caches a null note for an hour after a transient failure (espn-player-notes.js:32-33)
`cache.set(espnId, { at: Date.now(), note })` runs on the catch path too; during a live draft one timeout hides a player's note for 60 min. Cache is also unbounded (Map keyed by espn id; bounded in practice by roster size).

### D13 — P3 — news-lag-trader fires `claim_waiver` on any positive note about any unrostered fantasy-relevant player (news-lag-trader.js:213-217)
"full participant" on a backup TE becomes an action row. Also `NEGATIVE` includes `'ir'` (line 35) which no rule emits; `datetime(?, '-45 days')` (line 102) yields `YYYY-MM-DD HH:MM:SS` compared against `T`-form ISO strings — boundary-day off-by-hours, cosmetic.

### D14 — P3 — discoverVideos counts a DO-NOTHING conflict as `stored++` (press-conference.js:179-182)
`videos` in the job summary equals feed length every run, not new rows.

### D15 — P3 — source-registry lists espn_news_general/espn_news_team as manual sources while the scheduler records `espn_news` (source-registry.js:123-136 vs scheduler.js:895)
Both names exist in `sync_log` (`espn_news` 452 runs, `espn_news_general` 465 runs) so the registry shows the same feed twice under different cadences — the exact duplication the file's own comment at 110-115 says was removed for injuries.

## 2. Per-file sections

### server/news/ingest.js (93 lines) — active
Purpose: ESPN NFL RSS → `parseRssItems` (regex, no XML lib) → `normalizeNewsItem` → `upsertNormalizedNewsItem`. `RSS_SOURCES` has exactly one feed (line 12-14). `loadIdentity()` (46-51) is the shared entity list (players with `fantasy_relevant=1`, all teams incl. abbr — see D2). `ingestAllSources` uses `Promise.allSettled`. Reads: `players`, `nfl_teams`, network. Writes: via store.js. Wiring: `routes/news.js:4` (POST /ingest, 60s cooldown), `scheduler.js:496` (`rss_news` every 15 min; sync_log 773 runs ok), `nfl-transactions.js:24` and `twitter-ingest.js:25` reuse `loadIdentity`. Tests: `test/news-ingest.test.js`. Defects: D2 (line 73 picks `teams[0]`). Verdict: sound apart from D2.

### server/news/normalize.js (65 lines) — active
Purpose: `canonicalUrl` (strip utm/fbclid/gclid, sort params), `extractEntities` (exact alias match on lowercased text), `normalizeNewsItem` (requires source/url/headline/published_at; rejects source "AI analysis"; `duplicate_group_id = sha256(canonical_url)[0:24]`), `clusterNews`. Wiring: ingest.js, twitter-ingest.js, nfl-transactions.js, `routes/espn.js:6` (extractEntities only). Tests: `test/modeling-news.test.js`, `test/news-ingest.test.js`. Defects: D2 (lines 19-24). Verdict: acceptable.

### server/news/store.js (49 lines) — active
Purpose: single upsert keyed on the partial unique index `idx_news_items_duplicate_group` (confirmed in sqlite_master). INSERT … DO NOTHING RETURNING, then UPDATE on the same key. Never touches `ai_analysis`/`fantasy_impact`, preserves `ingested_at`. DB: 3,325 rows, 1,525 distinct groups, 1,800 NULL groups (ESPN API + manual rows). Wiring: ingest.js, twitter-ingest.js, nfl-transactions.js. Verdict: good.

### server/news/twitter-ingest.js (230 lines) — active
Purpose: curated handle lists (12 national, 32 official, 64 beat), `twitterSweepHandles(cursor, 5)` rotation with the durable cursor = COUNT of successful sweep usage rows (187-188), `tweetToRawNews` (official accounts get `source_type='team_official'`, reliability 0.95; others `social` 0.75), store only tweets naming a tracked player (206), then `watchTweetForLineMove` (221). Reads: `twitterapi_io_usage`, `nfl_teams`, `players`. Writes: `news_items` (via store), `nfl_tweet_line_watch` (via correlation module). Wiring: `scheduler.js:482` (`twitter_insiders`, 4h, tier metered — currently erroring, D6), `source-validation.js:96` (handle lists), tests `test/news-ingest.test.js:25,78`. DB: 767 social + 75 team_official rows; 11 tweets dated 2022-2025 stored because "Latest" search on thin handles returns old tweets. Defects: D6, D7, D8. Verdict: messy — runs, but the job status is red and coverage of the accounts that matter is poor.

### server/services/twitterapi-io.js (102 lines) — active
Purpose: the only network client; `guardedFetch` checks `twitterSpendStatus().blocked` (spent ≥ $9.50) before every call, records actual item count × $0.15/1k (tweets) or $0.18/1k (profiles). Reads/writes `twitterapi_io_usage`. Wiring: twitter-ingest.js, source-validation.js (dynamic), scheduler.js:483, routes/news.js:262 (`/twitter-status`). Observed spend $1.185/$10. Open question: whether the provider bills a per-request minimum (a 0-result call is recorded as $0 here, line 59-61 falls back to `estimatedItems` only when the body has neither `tweets` nor `data`). Verdict: good; the cap is the best-engineered spend guard in this group.

### server/services/nfl-news-signal.js (319 lines) — active, the hub
Purpose: `newsSourceVerification` (37-56); `STATUS_RULES`/`ROLE_RULES` (61-89) with fixed `unavailable`/`delta` numbers; `syncStructuredNewsSignals` (116-170) rules extractor upserting `nfl_news_signals` on `(news_id,player_key,signal_type)`; `playerNewsSignal`/`playerWeekNewsSignal` (cutoff = kickoff from `game_lines`, via `nflKickoffDate`); `teamNewsSignals` (203-223) = Σ unavailable×confidence and Σ role_delta×confidence over the latest claim per player, `production_eligible:false`; `newsSignalCoverage`; `syncAiNewsSignals` (243-319) Haiku extraction with fixed enums + verbatim span + `nfl_news_extraction_attempts` guard. DB: 422 signals (301 verified, 93 quarantined), 148 in the last 7 days. Wiring (importers): scheduler.js (5 sites), routes/news.js, routes/nfl-betting.js:69, nfl-online-neural.js:19, nfl-unified-engine.js:16, nfl-reasoning.js:24, nfl-replay.js:34, nfl-expert-council.js:16, nfl-team-card.js:13, player-week-engine.js:25, nfl-postgame-truth.js:13, nfl-news-events.js:50, nfl-capture-dispatch (reads the table), news-lag-trader (reads the table), tests ×4. Defects: D1 (P1), D3, D4. Verdict: messy — the most-consumed module in the group and the source of the P1.

### server/services/nfl-news-events.js (421 lines) — active (manual/experimental)
Purpose: Package E typed events into `nfl_news_events` with two clocks (`published_at`, `first_seen_time`), content-hash cache (`nfl_news_event_extraction_cache`, 44 rows), Haiku extraction with enum + verbatim span + known-identity checks (176-198), press-conference role-scenario branch (217-316) that only marks `verified` when `yt_channels.verdict='valid'`, rule-based novelty/contradiction (344-376), provenance check (406-419). Prepares `insertEvent` at module scope (109) — hence the dynamic-import note in the script. DB: 30 events (24 verified incl. 20 press role, 6 quarantined). Wiring: `nfl-prospective-collection.js:37` (manual button), `scripts/run-news-event-impact.mjs`, `test/nfl-news-events.test.js`. Claude usage: 1 call each feature. Defects: D9; inherits D5 (press quotes are mostly noise). Verdict: acceptable, unproven (no data).

### server/services/nfl-news-event-impact.js (339 lines) — experimental, script-only
Purpose: reaction pairs around `first_seen_time` on `nfl_quote_tape`, price-only volatility baseline, hand-rolled ridge OLS, chronological holdout, three negative controls, frozen manifests under `server/data/news-event-impact/`. Wiring: only `scripts/run-news-event-impact.mjs` and `test/nfl-news-event-impact.test.js` — no server import. Latest run (2026-09-08): 24 claims, 0 paired with a post-claim quote → `insufficient_data`. Defects: D10. Verdict: good code, zero evidence produced yet; the quote tape (1.6M rows) and the 30 events do not overlap in time/team.

### server/services/news-fantasy-impact.js (152 lines) — active
Purpose: for each signal, find the next team game, build the player-week engine for that week (cached per season|week), compute baseline vs scenario distributions (`playerWeekDistribution`, 500 runs) with `activeProbability`/`roleMultiplier`, and grade against `player_week_usage` after the game. Reads: `game_lines`, `player_week_usage`, `player_week_snaps`. Writes: nothing. Wiring: `routes/news.js:9,246` (`GET /news/signals`). `authority: 'shadow_scenario'`. Defects: D11. Verdict: acceptable (display).

### server/services/news-lag-trader.js (248 lines) — active, decision surface
Purpose: last-72h verified signals → league actions (`claim_waiver`, `buy_beneficiary`, `already_held`, `hold_or_sell`, `buy_low`, `no_edge`) using `roster_players` depth chart and `trade-engine.js` asset values. Reads: `leagues`, `nfl_news_signals`, `roster_players`, `nfl_teams`. Writes: nothing. Wiring: `routes/trades.js:20,360` (`GET /trades/:leagueId/news-edge`). This is the one place news becomes a fantasy action; it inherits D1 wholesale (a `released` Lamar Jackson yields "buy his backup"). Defects: D1 (consumer), D13. Verdict: messy until D1 is fixed.

### server/services/press-conference.js (329 lines) — active
Purpose: resolve 32 team YouTube channels by reach+name (`yt_channels`, all 32 valid on 08-29), discover feed videos (`press_conferences`, 1,508 rows), transcribe with yt-dlp, `extractAvailability` (surname + keyword, `press_availability` 171 rows), `pressAvailabilityFor`, `pressStatus`. Wiring: scheduler `press_conferences` job (6h, tier heavy — erroring on the 120s budget), `routes/nfl-betting.js:1619-1660`, imported for side effects by nfl-news-events.js:53. Defects: D5, D14. Verdict: messy — the extractor's output is ~2/3 noise.

### server/services/page-explain-tools.js (147 lines) — active
Purpose: five read-only tools for the page-explain Claude loop (`expertCouncilGame`, cover/total calibration, pick-watch board, variable catalog, decay watch). No writes by construction. Wiring: `nfl-page-explain.js:17`, `test/page-explain.test.js:266`. No defects found. Not a news module despite the assignment; it does not expose news signals to the assistant. Verdict: good.

### server/services/source-registry.js (285 lines) — active
Purpose: `MANUAL_SOURCES` metadata (cadence/cutoff/failure mode/maxAge) + `confidence()` decay + `allSources()` merging scheduler JOBS. Wiring: `nfl-diagnostic.js:6`, `routes/dev.js:5`, `routes/model.js:41`, tests ×2. Defects: D15. Verdict: acceptable; note `nfl_prospective_collection` entry (212-218) correctly documents the Anthropic+Odds spend of the manual news-extraction button.

### server/services/source-validation.js (199 lines) — active (manual)
Purpose: `judgeSource` floors (national 50k, beat 5k, team 20k, data 20k), `validateAllSources` (14-day skip, 150ms pacing, stops on budget), `sourceStatus`, `trustedHandles`. Writes `news_source_validation` (108 rows). Wiring: `routes/nfl-betting.js:1593,1601` only. Defects: D4 (no schedule), D8 (`trustedHandles` unused by ingest). Verdict: acceptable but unscheduled.

### server/services/espn-player-notes.js (41 lines) — active
Purpose: ESPN athlete overview → Rotowire headline/story + draft rank, 1h in-memory cache, 4s timeout. Wiring: `routes/drafts.js:12,968` (draft advice shortlist). Defects: D12. Verdict: good.

### scripts/run-news-event-impact.mjs (65 lines) — entry point (npm `news:event-impact`)
Purpose: CLI for extract/press/impact/controls; runs migrations before dynamic import (correctly, because of the module-scope prepare). Bills Haiku on `extract`, `press`, and `controls` (the duplicate control runs the real extractor twice — the first pass bills). Wiring: `package.json:32`. Verdict: good.

## 3. Wiring summary (news → consumer)
- RSS/Twitter/Transactions → normalize/store → `news_items` → `syncStructuredNewsSignals` (15-60 min) / `syncAiNewsSignals` (hourly, Haiku) → `nfl_news_signals`
- ESPN API → `news_items` (no URL) → signals → quarantined (D3)
- `nfl_news_signals` → `teamNewsSignals` → online-neural features (shadow) / council `news_reaction` (candidate) / unified-engine `verified_news` (numeric_authority 0) / replay qualitative segments / team card
- `nfl_news_signals` → `playerNewsSignal` → postgame-truth carryover probability (numeric)
- `nfl_news_signals` → `playerWeekNewsSignal` → player-week-engine `news_context` (display)
- `nfl_news_signals` → `newsFantasyTracker` → `/news/signals` (shadow scenario)
- `nfl_news_signals` → `newsOpportunities` → `/trades/:id/news-edge` (fantasy actions)
- `nfl_news_signals` → `enqueueRecentNewsTriggers` → `nfl_capture_triggers` → paid Odds API snapshots
- tweets → `watchTweetForLineMove` → `nfl_tweet_line_watch` → Haiku explanations (557 calls)
- `news_items` → `extractNewsEventsFromItems` (manual) → `nfl_news_events` → impact model (no data yet)
- `press_availability` → `extractPressConferenceRoleSignals` (manual) → `nfl_news_events`
- No file in this group reads the T-60 packet; `nfl_verified_events` is a separate nflverse archive.

## 4. Dead / duplicate
- `INSIDER_HANDLES` alias (twitter-ingest.js:117) — back-compat export, no importer outside the same file; keep or delete.
- `trustedHandles()` (source-validation.js:191) — route-only; intended ingest consumer never wired (D8).
- `clusterNews` (normalize.js:52) — imported only by `test/modeling-news.test.js`; no server caller found. Keep (tested) or delete.
- `source-registry.js` `espn_news_general`/`espn_news_team` duplicate the scheduled `espn_news` job (D15) — merge.
- `nfl-news-event-impact.js` — no server importer; script + test only. Keep as experimental; it is the only Package E measurement.

## 5. Open questions
1. Does twitterapi.io bill a per-request minimum? If yes, `recordSpend` under-counts on empty pages.
2. Who consumes `gameInjuryCarryover`'s probability with authority — is `nfl-postgame-truth.js:514-520` numeric in any production path (pick board), or only in council/unified-engine heads?
3. Why did `nfl-tweet-line-explain` stop on 2026-09-01 after 557 calls — disabled deliberately, or did the watch queue drain?
4. Should ESPN API rows be migrated through `normalize.js` (giving them `source_url`, `duplicate_group_id`) rather than patched in `newsSourceVerification`?
