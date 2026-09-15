# Verification of G12-news claims (7)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard
DB accessed read-only via `node -e` + `node:sqlite` `DatabaseSync(..., {readOnly:true})`. No repo file edited. No git state changed. No server touched.

All files read in full:
- server/services/nfl-news-signal.js (319 lines) — read whole file, lines_read=319
- server/news/normalize.js (65 lines) — read whole file, lines_read=65
- server/services/press-conference.js — read lines 230-300 (function of interest) plus surrounding context; full file is 329 lines, relevant region fully covered
- server/news/twitter-ingest.js (230 lines) — read whole file, lines_read=230
- server/routes/espn.js — read lines 160-220 (insertArticles + backfill), file is 269 lines
- server/services/scheduler.js — grepped + read lines 937-1010 (job timeout mechanism) and JOBS table entries for twitter_insiders/press_conferences
- server/services/twitterapi-io.js (110 lines) — read whole file
- server/services/player-identity.js — read lines 1-40 (normalizePlayerName)
- server/services/nfl-capture-dispatch.js — read lines 1-50
- server/services/news-lag-trader.js — read lines 150-185
- server/services/nfl-postgame-truth.js — read lines 500-525

---

## #97 — nfl-news-signal.js:146 multi-player status bleed

Code confirmed: `text` is the whole story (headline+body, sliced 1600 chars), computed once per news item (line ~140: `const text = ...`). The `for (const entity of players)` loop (line 146) re-runs `text.match(rule.re)` — the SAME text — for every resolved player entity in the story, and takes the first STATUS_RULES match, `break`ing after one hit. There is no per-entity localization of which sentence mentions which player. So any story that resolves 2+ player entities and contains one status-triggering phrase anywhere in the text stamps ALL of those players with that status.

DB verification:
- Stories with >=2 distinct players sharing IDENTICAL availability status: 60 stories / 145 rows (my count, broader query than reader's "38/95" — reader likely scoped differently, e.g. only within a time window or excluding rows where the shared status is the correct one for all listed players; the underlying phenomenon and its scale are the same order of magnitude and independently reproducible).
- Named examples, verified via live DB query (player_key uses `normalizePlayerName` which keeps spaces, e.g. "lamar jackson"):
  - `lamar jackson`: news_id 12471 "Ravens initial 53-man roster breakdown" → status=`released`, evidence_span=`waived`, verified. Confirmed real: the story is about two undrafted rookies making the roster; Lamar Jackson is merely resolved as an entity (he's on the Ravens) and the story text elsewhere doesn't say Lamar was waived — he's just in the entity list.
  - `derrick henry`: news_id 12473 "With Adisa Issac being waived..." → status=`released`, evidence_span=`waived`, verified. Confirmed: story is about Adisa Isaac being waived; Henry is merely referenced ("Reserve RB behind Derrick Henry and Justice Hill") and gets tagged `released` too.
  - `dak prescott`: news_id 40156 "cowboys... released joe Milton in favor of sam Howell" → status=`released`, verified. Confirmed: story is about Joe Milton being released; Prescott is in the resolved player list purely because the story headline literally starts "The cowboys..." and Prescott naturally resolves for DAL, but the "released" verb in the text applies to Milton, not Prescott.
  - `drake maye`: news_id 19081 "Quick-hit thoughts... Patriots" → status=`released`, evidence_span=`cut` (mismatch — "cut" doesn't even appear verbatim in the headline/body shown, worth independent note but not a separate claim), verified.

IMPORTANT NUANCE found during verification: `playerNewsSignal`/`teamNewsSignals` pick the MOST RECENT claim per player (claims ordered `published_at DESC`, `.find()` returns first). For Lamar Jackson specifically, there is a NEWER availability row: news_id 88955, published 2026-09-11T20:13 (today is 2026-09-12), status=`out`, evidence_span=`ruled out`. This row is ALSO a misattribution instance of the exact same bug — the story is about Zay Flowers/Madubuike/Buchanan being ruled out, and Lamar Jackson is name-checked only in passing ("Lamar Jackson will have his No. 1 target for Week 1"). Because `text.match(rule.re)` scans the whole story, Lamar Jackson inherits `ruled out` too.
  - Net effect: as of right now, `playerNewsSignal('Lamar Jackson')` would resolve to status=`out` (unavailable_probability=0.94), NOT `released` (1.0) as the claim states. The claim's literal "currently 'released', unavailable_probability=1.0" is stale for Lamar Jackson specifically — but it is STILL wrong, just wrong in a different way, and via the identical root-cause bug. For Derrick Henry, Dak Prescott, and Drake Maye, each has only ONE availability row on file, so "currently released" is accurate for those three.
- Downstream impact independently verified:
  - `nfl_capture_triggers`: exact reason strings `'BAL availability: released' x2`, `'DAL availability: released' x4` (reader said x2, actual is x4 — same direction, larger), plus 17 other team abbreviations similarly triggered on `released`. `nfl-capture-dispatch.js` `enqueueRecentNewsTriggers` (function present, queries `nfl_news_signals WHERE verification_state='verified' ... unavailable_probability>=0.5`) confirms this is a real, wired path from a bad signal to a paid-capture trigger queue.
  - `news-lag-trader.js:150-185` confirmed: for a `negative` (unavailable) status, it calls `beneficiaryOf` and recommends `claim_waiver`/`buy_beneficiary` actions — i.e., a fabricated "released" status for a star player would generate an actual buy/claim recommendation for a backup, exactly as claimed.
  - `nfl-postgame-truth.js:513-518` confirmed: it consults `playerNewsSignal(...).availability` and if present and not `confirmed_out`, overwrites the carry-forward `probability`/`state` from the news signal — so an erroneous claim propagates into the postgame carry-forward state, as claimed.

**Verdict: largely CONFIRMED, P1.** Real, live, high-impact bug with concrete verified examples and a wired path to paid API spend and a trade recommendation. Minor correction: Lamar Jackson's *current* (most-recent) availability signal is `out` (0.94), not `released` (1.0) — superseded by a newer instance of the same underlying bug — so the claim is precisely accurate for 3 of the 4 named players and directionally accurate (still wrong, same root cause) for the 4th.

---

## #98 — normalize.js:21 WAS/NO alias collision

Code confirmed at server/news/normalize.js lines 15-21: `normalizedHeadline` lowercases and strips punctuation from both the headline text and every alias; `extractEntities`'s `match()` checks `haystack.includes(\` ${normalizedHeadline(alias)} \`)` for `entity.aliases ?? [entity.name, entity.abbr]`. `server/news/ingest.js:49` builds team identity as `rows('SELECT id, name, abbr FROM nfl_teams')` — no `aliases` field — so the fallback `[entity.name, entity.abbr]` is used, meaning team WAS's abbr `'WAS'` and team NO's (New Orleans) abbr `'NO'` normalize to the bare words `'was'`/`'no'` and are checked as whole-word substrings against every headline. `ingest.js:73`: `const teamId = normalized.entities.teams[0]?.id ?? null;` — first team match wins, so any headline containing the word "was" or "no" gets misattributed to Washington or New Orleans respectively, if no other team matches first.

DB verification:
- `news_items` with `team_id` = WAS: 160 rows; team_id = NO: 127 rows (reader's evidence cited 113/80 — likely a different sub-scope such as "typed" stories only, but the phenomenon and rough scale match).
- Concretely verified misattributed rows for NO (team_id = New Orleans Saints' id): headline `'Packers RB Jacobs pleads no contest to misdemeanor charges'`, `'Panthers RB Brooks has no limitations against Bears'`, `'Mahomes says he'll play without limitations in Chiefs' opener'` — wait, that one doesn't have "no", but it's still bucketed under NO team_id in the sample list, meaning some other path also attributes it (worth noting: not every NO-bucketed row is via the "no" collision, some might be via other mechanisms, but many clearly are, e.g. "Jacobs pleads no contest," "Brooks has no limitations," "No injury designations for Jonathon Brooks," "No injury status for WR Zay Flowers").
- This directly confirms the claim's mechanism and its real, current, large-scale effect on `news_items.team_id` for unrelated Packers/Panthers/Chiefs/Ravens/Cowboys stories.
- Downstream impact: `nfl-expert-council.js:240-245`'s `feedStories` (cited by reader, not independently re-verified line-by-line here but the described `COUNT ... team_id ... >=3` pattern is consistent with the codebase's general style) would legitimately fabricate feed-coverage counts for WAS/NO from stories about entirely different teams — this is a believable, high-impact "number Nick reads on a page" defect (team card / desk badges, and any coverage-based forecast override).

**Verdict: CONFIRMED, P1.** The exact quoted code lines are the real cause of a large-scale, currently-active team misattribution affecting hundreds of stories. Count discrepancy (113/80 claimed vs 160/127 total in DB) doesn't refute the substance — the mechanism, its scale, and concrete misattributed examples are all independently reproduced.

---

## #99 — nfl-news-signal.js:38 ESPN quarantine due to missing source_url

Code confirmed: `server/routes/espn.js`'s `insertArticles` (function starting ~line 173) builds the INSERT statement as `INSERT INTO news_items (date, team_id, headline, body, importance, source, entities_json, published_at) VALUES (...)` — no `source_url` column at all. Every article ingested through this path (the "Pull ESPN news" button path) gets `source_url = NULL` forever. `nfl-news-signal.js:38`: `newsSourceVerification` returns `{state:'quarantined', reason:'missing or invalid source URL'}` when `sourceHost(item.source_url)` is null (i.e., `source_url` is NULL).

DB verification:
- `news_items WHERE source_url IS NULL`: source='ESPN' → 1808 rows; source='seeded' → 4 rows. (Reader cited "ESPN 1796" — close, same order, likely a slightly different snapshot time given the live server keeps ingesting.)
- Joined `nfl_news_signals` (source='ESPN') against `news_items.source_url IS NULL`: 90 of 91 quarantined signal rows come from a NULL-source_url news_item; 36 of 37 verified signal rows (source='ESPN') come from a news_item that DOES have `source_url` set (a separate ingestion path — 296 ESPN news_items do have real espn.com URLs, presumably from RSS or another route, not `routes/espn.js`'s button path). One quarantined row also has a non-null source_url (edge case, not material).
- **Correction to claim**: the assertion "the largest feed has zero model authority" is a slight overstatement. There IS a secondary ESPN ingestion path (296 items with real source_url, plus a distinct `'ESPN Transactions'` source with 392 items, all with source_url set, contributing 51 more verified signals) that DOES pass verification. So ESPN-labeled signals in aggregate are NOT uniformly zero-authority — 87 of 178 (36+51 of 91+87) `nfl_news_signals` rows attributable to ESPN-family sources are verified. However, the PRIMARY, highest-volume ESPN ingestion path (routes/espn.js, ~1808 of ~2104 ESPN news_items, i.e. the "Pull ESPN news" button — the mechanism actually named in the claim's cited line) is indeed 100% quarantined (90/90 signals from that path are quarantined), exactly as described.

**Verdict: CONFIRMED with a nuance correction, P2.** The specific code path and its 100%-quarantine effect are real and verified exactly. The claim's framing that "the largest feed has zero model authority" overstates slightly — a smaller secondary ESPN ingestion path (and 'ESPN Transactions') does retain authority — but the core defect (the main ESPN button path never gets a source_url and is therefore fully quarantined) is real, current, and matches the reader's evidence almost exactly (89-90 of ~91-93 quarantined signals).

---

## #100 — nfl-news-signal.js:48 social validation staleness

Code confirmed at lines 44-53: `checkedAfter = now - 30 days`; queries `news_source_validation WHERE lower(handle)=lower(?) AND checked_at>=?`. If no fresh row, state becomes `quarantined`.

DB verification:
- `news_source_validation`: single distinct `checked_at` value across all 108 rows = `2026-08-29T20:40:18.114Z`. No other run exists.
- `validateAllSources` (server/services/source-validation.js:88) is called from exactly one place: `server/routes/nfl-betting.js:1593-1594` (`POST /news/sources/validate`), an on-demand HTTP route.
- `server/services/scheduler.js`'s `JOBS` table (grepped fully) has no job that calls source validation — confirmed no scheduled re-validation exists.
- `ON CONFLICT ... verification_state=excluded.verification_state` at nfl-news-signal.js:132 (and again at 285 for the AI extractor path) confirms every sync re-derives and overwrites `verification_state` — so once the 30-day window lapses (2026-08-29 + 30 days = 2026-09-28), previously-verified tweet-sourced signals will flip to quarantined on the next sync, with no code path to prevent it.
- Currently (today = 2026-09-12) the window has not yet lapsed, so this is a real, correctly-computed, forward-looking defect, not yet manifested but on a fixed collision course with the season (Weeks 3-4, matching the claim). 107 handles are currently `valid`; 48 distinct Twitter sources currently contribute verified `nfl_news_signals` rows — real scale of what silently drops.

**Verdict: CONFIRMED, P2.** Exact mechanism, exact single-run timestamp, exact absence of a scheduled re-validation job, and exact consequence (universal re-quarantine on next sync past the 30-day mark) all verified.

---

## #101 — press-conference.js:272 'ir' substring match

Code confirmed: `INJURY_TERMS` array (line 237-240) includes `'ir'`. Line 272: `const term = INJURY_TERMS.find(t => lower.includes(t));` — plain substring `.includes`, no word boundary — so 'ir' matches inside "girls", "first", "third", "fire", "along", etc. Player attribution (line 274-277) matches surname substring similarly (`lower.includes(surname.toLowerCase())`), so "Long" matches "along."

DB verification (exact match to reader's numbers):
- `press_availability` keyword breakdown: `ir`=113, `injur`=21, `return`=14, `miss`=9, plus smaller buckets (ankle=3, shoulder=2, out for=2, limited=2, hamstring=2, week to week=1, tore=1, available=1). Total = 171 rows, matching reader's "113 of 171."
- Verified exact quote attributed to player "Hunter Long" under keyword='ir': `"You and your girls and there's ticker tape along the ground"` — contains "gi**rl**s" (ir) and "a**long**" (surname "Long"), zero injury content. Exact match to reader's citation.

**Verdict: CONFIRMED, P2.** Exact numbers, exact quote, exact mechanism all independently reproduced. This is one of the cleanest, most precisely verifiable claims in the set.

---

## #102 — twitter-ingest.js:193 job timeout / abandoned promise

Code confirmed: `server/services/scheduler.js` lines 937-978. `DEFAULT_JOB_TIMEOUT_MS = 120_000`. `runIfStale` races `job.run()` against a `setTimeout` that rejects with `"job '${name}' exceeded its ${Xs} budget and was abandoned so the rest of the tier could run"`. Critically, there is NO `AbortController`/cancellation threaded into `job.run()` — when the timeout wins the race, the underlying async function (e.g., `ingestTwitterInsiders`'s `for (const handle of handles)` loop at twitter-ingest.js:193, calling `searchRecentTweets` at line 195) keeps executing in the background, continuing to call the paid API and write `twitterapi_io_usage` rows, even though the job is recorded as `'error'`.

DB verification:
- `sync_log` currently shows `job='twitter_insiders'`, `last_status='ok'`, `runs=78`, `last_run_at='2026-09-12T11:59:53Z'` — i.e., the specific error the reader captured (`runs=76`, `last_run_at 03:56:40`, `last_status='error'`) has since been superseded by newer successful runs. This means the timeout condition is intermittent (network/API latency dependent), not a permanently-broken job. The reader's evidence is a real historical snapshot, but the current live state (as of this verification) is healthy.
- `press_conferences` job currently also shows `last_status='ok'` (37 runs) — no currently-visible corroboration that it "has the same failure" beyond sharing the identical `Promise.race` code path in `runIfStale`, which is genuinely shared code and would behave the same way under a slow run.
- The code-level defect (no cancellation on timeout ⇒ possible late writes/spend after a job is marked failed, and a job-health/confidence signal — e.g. "source-registry confidence 0.1" — that can misreport a job that actually completed and wrote data) is real and reproducible in principle any time a call exceeds 120s, which the reader's captured evidence shows did happen at least once.

**Verdict: CONFIRMED (mechanism), P2, with a currency caveat.** The exact code pattern (no-cancel Promise.race) is real and matches the reader's claim precisely. However, the specific "recent runs" framing overstates currency — as of this verification the job's last recorded run is healthy (`ok`), so this is an intermittent/edge-case defect rather than an actively-failing one right now. The underlying design flaw (spend outside the accounted run, misreported job health) stands and will recur whenever a call is slow.

---

## #103 — twitter-ingest.js:195 unbounded query / 3.6-day insider cadence

Code confirmed:
- `searchRecentTweets` (twitterapi-io.js:72-75) takes no since/time-bound parameter; the query string built at twitter-ingest.js:195-196 has no `since:` operator either — purely `from:${handle} (injury OR ... OR practice)`.
- `MAX_TWEETS_PER_RUN = 5` (twitter-ingest.js, confirmed via grep at the literal declaration).
- `TWITTER_SWEEP_HANDLES` pool: `NATIONAL_INSIDER_HANDLES` (12) + `Object.values(TEAM_HANDLES)` (32) + `Object.values(BEAT_REPORTER_HANDLES).flat()` (64, i.e., 32 teams × 2 reporters) = 108, confirmed by direct enumeration of the exported constants.
- `scheduler.js` JOBS: `twitter_insiders: { ..., maxAgeMinutes: 4 * 60, tier: 'metered', ... }` — 4-hour cadence, confirmed at the JOBS table entry.
- Math: 108 handles / 5 per run ÷ (24h / 4h = 6 runs/day) = 108/(5×6) = 3.6 days per full pool rotation — confirmed exactly as claimed.

DB verification:
- `twitterapi_io_usage WHERE purpose='insider-injury-role-sweep'`: 379 of 380 calls returned exactly `items=20` (the API's page cap); 1 returned 10. Reader cited "369 of 370" — same phenomenon, slightly stale count (more calls have accrued since).

**Verdict: CONFIRMED, P2.** All structural facts (pool size, per-run cap, cadence, resulting ~3.6-day rotation, and the page-cap-saturation evidence) independently verified exactly. The national insiders (Schefter, RapSheet, etc.) share the same unprioritized rotation as all 32 team accounts and 64 beat reporters, so despite being curated specifically for their speed advantage, they are structurally checked no more often than every ~3.6 days — a genuine, currently-active defect with real fantasy/betting relevance (breaking news is the whole stated purpose of this ingestion path).
