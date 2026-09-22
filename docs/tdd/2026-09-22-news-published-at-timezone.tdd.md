# TDD evidence: ESPN RSS times read an hour late, so fresh stories looked like they came from the future

**Unit:** R-07 (plan items D21 pipeline fragility / C16 news latency). Branch
`claude/local-r-07-news-future-timestamps`, cut from `origin/main` d6d7bd5a.

**Table:** `news_items.published_at`. **Writer:** `ingestRssSource`
(`server/news/ingest.js:53`) → `normalizeNewsItem` (`server/news/normalize.js:48`, the parse
is `:57`) → `upsertNormalizedNewsItem` (`server/news/store.js:27`; INSERT `:41`, UPDATE
`:68`). Cites are on d6d7bd5a unless marked.

All database figures are from a **local copy, not production**: `sqlite3
~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"`, taken
2026-09-22T20:16:16Z.

---

## 1. Audit (written before the first test)

What already exists on this surface, d6d7bd5a:

| Piece | Where | State |
|---|---|---|
| RSS item extraction | `server/news/ingest.js:37` `parseRssItems` | passes `<pubDate>` through as a raw string |
| The parse | `server/news/normalize.js:57` `new Date(raw.published_at).toISOString()` | trusts the zone label in the string |
| Fetch clock | `server/news/ingest.js:59` `ingestedAt = new Date().toISOString()`, stored as `news_items.ingested_at` by `store.js:50/:77` | **already exists**, so "store fetched_at alongside" needs no new column |
| Wall-time-in-a-zone → UTC | `server/services/date-util.js:17` `zonedDateTime(date, time, timeZone)` | canonical helper (Intl, DST-aware, no dependency); used for nflverse kickoffs `:48` |
| A second copy of the same idea | `server/services/book-feeds-extra.js:84` `easternToIso` | Eastern-only duplicate; not touched here (named as a follow-up) |
| Other callers of the parse | `server/news/twitter-ingest.js:203` (tweet `createdAt`, numeric offset), `server/services/nfl-transactions.js:62` (ESPN API ISO `date`) | neither string carries a US zone letter |
| Other `news_items` writer | `server/routes/espn.js:197` `insertArticles` (ESPN JSON API, ISO with `Z`) | measured clean below |
| Existing tests | `test/news-ingest.test.js` uses `... EST` fixtures (`:60,:97,:111`) but never asserts the parsed instant | no test pins the zone |

**Decision: extend, not build.** Replace the one parse line with a small
`parsePublishedAt` in `normalize.js` that reads an `EST`/`EDT` label as US Eastern wall time
through the existing `zonedDateTime`, and falls back to the current `new Date()` for every
other spelling. No new column, table or migration. The fetch clock the unit asks for is
`ingested_at`, which is already stored beside every row. New tests go in a new file so the
shared `test/news-ingest.test.js` is not edited.

File ownership: `server/news/*` is listed under the UI thread in the 17:57Z allocation
memory. This unit was dispatched from the single work queue; the queue dispatch is taken
as the grant and the conflict is reported up rather than assumed away.

## 2. The census (acceptance item 1)

All on the local copy. Commands run in the worktree.

```
sqlite3 .local-db/data.sqlite "select strftime('%Y-%m-%dT%H:%M:%SZ','now'), count(*)
  from news_items where julianday(published_at) > julianday('now')"
```

| Question | Clock | Rows |
|---|---|---|
| `published_at` later than the census clock | 2026-09-22T20:20:24Z (Mac `date -u` 20:20:24Z) | **0** |
| control: same predicate one hour earlier, rows that existed then | 19:20:24Z | 14 |
| same predicate at the last ingest's own clock | 19:43:01.535Z | 13 |
| `published_at` later than the row's **own** fetch clock (`ingested_at`) | per row | **164** of 1,474 |

The 0 is real but misleading: the local server had not ingested for 37 minutes, which is
longer than the error, so every stamp had already "arrived". The right census is the
row's own fetch clock, where a story can never be published after we fetched it. The
controls show the predicate finds rows when they exist.

By writer (`source`, `source_type`):

| Writer | Rows | `published_at` > `ingested_at` | max minutes ahead of fetch |
|---|---|---|---|
| RSS (`ESPN`, `publisher`) — `ingest.js:53` | 196 | **164** | 375.4 (pre-09-14 rows, see below) |
| ESPN JSON API (`ESPN`, null) — `espn.js:197` | 936 | n/a (no `ingested_at`); vs `created_at`: 0 | −0.8 |
| ESPN transactions (`ESPN Transactions`) — `nfl-transactions.js:62` | 342 | 0 | −771.0 |

Only the RSS writer is affected. The >60-minute rows are all ingested 2026-09-03, before
994d32eb (2026-09-14, "news receipt-time overwrite") made the update path move
`ingested_at` on a revision; rows ingested since 2026-09-15:

| Rows since 09-15 | ahead of fetch | ahead of fetch **after subtracting 60 min** | max ahead |
|---|---|---|---|
| 161 | 146 | **0** | 57.89 min |

Every future-stamped row is less than 60 minutes ahead, and none survives a one-hour
correction. That is the signature of a fixed one-hour zone error, not a slow clock.

## 3. Stored value vs the raw feed field (acceptance item 2)

One GET of the feed the app already polls (`RSS_SOURCES[0]`,
`https://www.espn.com/espn/rss/nfl/news`) at 2026-09-22T20:16:56Z; HTTP `Date:
Tue, 22 Sep 2026 20:16:57 GMT` (our clock is within 1 s of ESPN's). Joined to the copy by
URL with the repo's own `parseRssItems` (scratch script, not committed): 29 feed items, 27
in the copy; 18 of 27 stored values equal `new Date(<raw pubDate>)` exactly, the other 9
were re-stamped by ESPN after our last fetch (19:43Z).

| id | raw `<pubDate>` | stored `published_at` | stored `ingested_at` | stored − fetch | true instant (Eastern daylight) |
|---|---|---|---|---|---|
| 11990 | `Tue, 22 Sep 2026 15:15:32 EST` | 2026-09-22T20:15:32.000Z | 2026-09-22T19:40:50.483Z | **+34.7 min** | 19:15:32Z (25.3 min before fetch) |
| 11293 | `Tue, 22 Sep 2026 09:22:52 EST` | 2026-09-22T14:22:52.000Z | 2026-09-22T13:29:41.198Z | **+53.2 min** | 13:22:52Z |
| 8010 | `Sun, 20 Sep 2026 13:17:41 EST` | 2026-09-20T18:17:41.000Z | 2026-09-20T17:24:49.499Z | **+52.9 min** | 17:17:41Z |

**Cause.** ESPN labels US Eastern *daylight* wall time `EST`. JavaScript reads `EST` as
the fixed offset −05:00 (RFC 822), so every stamp lands one hour late. The proof is in the
same response: `<lastBuildDate>Tue, 22 Sep 2026 20:15:36 GMT</lastBuildDate>` against a
newest item `<pubDate>Tue, 22 Sep 2026 16:07:30 EST</pubDate>`. Read literally that item
is 21:07:30Z, 51 minutes after the feed was built; read as Eastern daylight it is
20:07:30Z, 8 minutes before. The feed's wall clock is right and its zone letter is wrong,
so this is a parse/timezone bug on our side: RED on the parse path, GREEN fix.

Every RSS row in daylight time is an hour late, not only the 164 that are visibly in the
future: a story fetched more than an hour after it was published is stored an hour late
but still in the past, so it passes any "not in the future" check.

## 4. RED

`test/news-published-at-timezone.test.js` (new file; `test/news-ingest.test.js` is not
edited). Commit **167d9a6e** `test: ESPN RSS 'EST' stamps are Eastern daylight time,
stored an hour late (RED, R-07)`. On d6d7bd5a source, 5 of 6 fail:

```
not ok 1 - an ESPN "EST" stamp in September is Eastern daylight time (the three census rows)
  expected: '2026-09-22T19:15:32.000Z'
  actual: '2026-09-22T20:15:32.000Z'
ok 2 - spellings that were already right stay right (passes before and after by design)
not ok 3 - Eastern edge cases: the repeated autumn hour resolves to the earlier instant, never a later one
  expected: '2026-11-01T05:30:00.000Z'
  actual: '2026-11-01T06:30:00.000Z'
not ok 4 - the RSS writer stores the true instant, never later than its own fetch clock
  expected: '2026-09-22T19:15:32.000Z'
  actual: '2026-09-22T20:15:32.000Z'
not ok 5 - a feed stamp still ahead of the fetch clock is counted on the ingest result, not hidden
  expected: 2
not ok 6 - consumer: the news desk ages the story from the corrected time (25 min, not a clamped 0)
  expected: 25
  actual: 0
# tests 6  # pass 1  # fail 5
```

That listing is the **re-run** of the final test file (as of d3d1f8b1) against the
d6d7bd5a copies of `normalize.js` and `ingest.js`, in a detached worktree
(`git checkout d6d7bd5a -- server/news/normalize.js server/news/ingest.js`), so it proves
the tests as shipped are live, not only the first draft. Case 2 passes in both states on
purpose: it guards the spellings that were already right (winter `EST`, honest `EDT`,
`-0400`, `GMT`, ISO, `PST`, garbage refused) against the fix over-reaching.

Case 6 is the consumer: `GET /api/news/desk` with time frozen at the real fetch clock
(19:40:50.483Z). Before the fix the desk reports the story as 0 minutes old because
`routes/news.js:71` floors a negative age at 0, which is how the defect stayed hidden.

## 5. GREEN

Commit **6a3fbfde** `fix: read ESPN RSS 'EST' stamps as Eastern wall time and count
future stamps (GREEN, R-07)`, then **d3d1f8b1** `test: pin both sides of the 5-minute
future-stamp allowance (R-07)` after the first sweep found a surviving mutant (section 7).

- `server/news/normalize.js` `parsePublishedAt` (module-private): an RFC 822 date whose
  zone letter is `EST` or `EDT` is read as America/New_York wall time through
  `zonedDateTime` (`server/services/date-util.js:17`), which supplies that date's real
  offset. Every other spelling keeps `new Date(text).toISOString()`, the old behaviour. An
  impossible date (`31 Sep`) throws `RangeError`, which `ingestRssSource` already catches
  per item into its `failed` list (`ingest.js:83-86`). Both `published_at` and the
  defaulted `updated_at` use it.
- `server/news/ingest.js` `ingestRssSource`: counts `future_stamped`, items whose parsed
  stamp is still more than 5 minutes after this fetch's clock. The row keeps the feed's
  value; `published_at > ingested_at` on the row is the per-row label. `ingestAllSources`
  reports `future_stamped: null` (not checked) for a source it could not read.
  Reader: the ingest result is returned by `POST /api/news/ingest` (`routes/news.js:34-43`)
  and served again as the desk's `refresh.last_result` (`routes/news.js:100`), and it is
  the `rss_news` job's return (`scheduler.js:769-778`).

No schema change, no migration, no new column. Targeted runs at d3d1f8b1 (each with
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node
--experimental-test-module-mocks --test --test-reporter=tap <file>`):

| File | tests | pass | fail |
|---|---|---|---|
| `test/news-published-at-timezone.test.js` | 6 | 6 | 0 |
| `test/news-ingest.test.js` | 20 | 20 | 0 |
| `test/modeling-news.test.js` | 7 | 7 | 0 |
| `test/nfl-news-signal.test.js` | 10 | 10 | 0 |
| `test/nfl-expert-council-news-feed-cutoff.test.js` | 3 | 3 | 0 |
| `test/nfl-player-state-roster-events-cutoff.test.js` | 3 | 3 | 0 |

The last five were run on 6a3fbfde; d3d1f8b1 changed only the new test file.
`npm run check` was not run here (Gate phase runs it once, per the unit's CPU rule).

**The real feed through the fixed parse** (29 items from the 20:16:56Z fetch, all labelled
`EST`; scratch script, d3d1f8b1):

| | items after the fetch clock | items after the feed's own `lastBuildDate` | newest vs fetch |
|---|---|---|---|
| old literal parse | 11 | 11 | +50.6 min |
| fixed parse | **0** | **0** | −9.4 min |

## 6. Consumers that compute freshness or latency (acceptance item 4)

Grep (d3d1f8b1), with a control that must hit the known consumer first:

```
git grep -n "mean_ingest_lag_minutes" -- server          # control: routes/news.js:93
for f in $(git grep -l "news_items" -- server | grep -v -E "^server/(db/schema|migrations)/"); do
  grep -q published_at $f && echo $f; done
git grep -n -i -E "fresh|latency|lag|age_?minutes|datetime\('now'" -- <those files> | grep -i published
```

| Consumer | Where | Reads | After this change |
|---|---|---|---|
| Desk ranking: age, "published in the last 24h" | `routes/news.js:70-73,82` | `published_at` | corrected for new rows; RED case 6 proves it (25 min, was a clamped 0) |
| Desk stats: `fresh_24h`, `latest_published`, `mean_ingest_lag_minutes` | `routes/news.js:88-93` | `published_at`, `ingested_at` | reads the corrected field; no code change |
| Diagnostic: `fresh_24h`, `avg_lag_minutes_7d` | `services/nfl-diagnostic.js:20-24` | `published_at`, `ingested_at`, floored with `MAX(0, …)` | reads the corrected field; the floor is what hid negative lags |
| Season-ending window | `services/player-availability.js:149` | `COALESCE(published_at, date)` | corrected |
| Team page recent news (45 days) | `routes/teams.js:38` | `COALESCE(published_at, date)` | corrected |
| Typed signals copy the stamp | `services/nfl-news-signal.js:251,264,465` → `nfl_news_signals.published_at` | `item.published_at` | new signals corrected; **34 of 216** existing RSS-derived signals on the copy carry a stamp later than their story's fetch clock |
| News-lag trader | `services/news-lag-trader.js:70,121` | `nfl_news_signals*.published_at` | inherits through the signals |
| As-of cutoff | `services/nfl-expert-council.js:248` | `published_at<=? AND ingested_at<=?` | corrected; the `ingested_at` gate already kept it look-ahead safe |

Every consumer reads the stored `news_items.published_at` (or its copy in
`nfl_news_signals`); none parses the feed's raw `<pubDate>` itself. So there is one
producer, and fixing it at the writer corrects every consumer for new rows with no
consumer edit. `nfl_news_events` is **empty** on the copy (0 rows), so its
`observed_before_published` check (`nfl-news-events.js:412`) had nothing to see; that is
table-empty, not zero.

## 7. Mutation sweep

Harness: a Mac copy of `$H/mutate-run-v1.sh` written fresh as `mutate-run-mac-v2.sh` in
the session scratchpad (the shared v1 was not edited). Each mutant's anchor must match
exactly once or it reports NOT-APPLIED. Tests:
`news-published-at-timezone`, `news-ingest`, `modeling-news`.

First sweep on 6a3fbfde (guard test had one item 30 minutes ahead):

| id | mutant | expected | result |
|---|---|---|---|
| M9 | tolerance 5 → 10 min | SURVIVED | SURVIVED (6/6 pass) → test was too loose; fixed in d3d1f8b1 |
| C1 | comment-only edit | SURVIVED | SURVIVED |
| C2 | absent anchor | NOT-APPLIED | NOT-APPLIED (0 matches) |

Full sweep on d3d1f8b1, baseline 33 pass / 0 fail:

| id | where | mutant | result (pass/fail) |
|---|---|---|---|
| M1 | `normalize.js` call site | `published_at` back to `new Date(raw.published_at)` (the pre-fix line) | KILLED 29/4 |
| M2 | `normalize.js` call site | `updated_at` bypasses the parser | KILLED 32/1 |
| M3 | unit | `America/New_York` → `America/Chicago` | KILLED 28/5 |
| M4 | unit | regex stops matching `EST` (only `EDT`) | KILLED 29/4 |
| M5 | unit | impossible date falls back to Date rollover | KILLED 32/1 |
| M6 | unit | seconds dropped from the wall time | KILLED 28/5 |
| M7 | unit | day and month swapped | KILLED 27/6 |
| M8 | `ingest.js:67` writer call site | pre-parses `pubDate` before normalize sees it | KILLED 31/2 |
| M9 | guard | tolerance 5 → 10 min | KILLED 32/1 |
| M10 | guard | tolerance 5 → 3 min | KILLED 32/1 |
| M11 | guard | sign flipped (counts stale stamps) | KILLED 31/2 |
| M12 | guard | count computed, 0 reported | KILLED 32/1 |
| M13 | guard | reads `updated_at` instead of `published_at` | SURVIVED 33/0, **equivalent**: RSS never sends `updated_at`, so normalize defaults it to `published_at` |
| C1 | designed surviving control | comment-only edit | SURVIVED 33/0 |
| C2 | designed not-applied control | absent anchor | NOT-APPLIED (0 matches) |

12 of 12 non-equivalent mutants killed; both controls behave as designed.

## 8. Known defects and what this does not cover

1. **Historical rows are not rewritten.** All 196 RSS rows on the copy fall in daylight
   time and keep their one-hour-late stamp (164 visibly after their fetch). Correcting them
   is an UPDATE of stored values, which is a data change that needs Nick's word. The
   correction would be `published_at − 60 minutes` for `source='ESPN' AND
   source_type='publisher'` rows stamped in daylight time; for rows no longer in the feed
   that is an inference (strong: 0 of 161 post-09-15 rows stay ahead after it), because the
   raw label was never stored. Rows still in the feed (29 at a time) are corrected by the
   first post-deploy ingest through the existing update path, which also moves their
   `ingested_at` to that fetch (`store.js:63-66` treats a changed stamp as a revision), so
   up to 29 rows lose their first-seen time once.
2. **ESPN's RSS `<pubDate>` is a last-modified time, not first publication.** Row 8752 was
   created 2026-09-20 and carries `published_at` 2026-09-22T20:15:32Z (a "Fantasy buzz"
   page ESPN keeps editing). Freshness ranks re-edited old stories as new. Not changed here.
3. **`fresh_24h` compares text, not time.** `routes/news.js:89` and
   `nfl-diagnostic.js:21` compare ISO text (`…T…Z`) with `datetime('now','-24 hours')`
   (space-separated), so any story on the cutoff's calendar date counts as fresh: **268**
   as served vs **146** by `julianday` on the copy at 2026-09-22T20:21:58Z. Same class as
   the R2 note in `nfl-news-signal.js:290-300`. Follow-up.
4. **The floors that hid this are still there** (`routes/news.js:71` `Math.max(0, …)`,
   `nfl-diagnostic.js:24` `MAX(0, …)`). `future_stamped` now reports the cause at ingest.
5. **`mean_ingest_lag_minutes` is not a latency.** 3,248.9 minutes on the copy, dominated
   by the 342 ESPN transactions rows stamped at a date-only 07:00Z. Follow-up.
6. **Two Eastern converters exist**: `date-util.js:17` `zonedDateTime` (reused here) and
   `book-feeds-extra.js:84` `easternToIso`. Not unified here; named follow-up.
7. Other US zone letters (`CST`, `MST`, `PST` and daylight forms) keep JavaScript's fixed
   reading: not measured, and no current source sends them.
8. The repeated autumn hour (01:00-01:59 on the fall-back night) resolves to the daylight
   instant: at most an hour early, never in the future.
9. **What would make it wrong:** ESPN starting to send a true −05:00 `EST` in summer. The
   stamps would then be an hour early, and `future_stamped` cannot see early stamps. The
   check is the one in section 2: stamps should sit a few minutes before `ingested_at`.

## 9. Statistical discipline and holdout looks

Not a statistical unit: no model number, no projection, no pre-registration needed. No
look at the 2025 held-out season or the 2026 forward weeks (`docs/evidence/HOLDOUT-LEDGER.md`
is absent on `origin/main`: `git ls-tree origin/main docs/evidence/HOLDOUT-LEDGER.md`
prints nothing). Minimum detectable effect and decision win rate do not apply: nothing here
feeds a start/sit, waiver or trade call except through the news desk's ordering.

## 10. Nick's five questions

1. **Well built?** One parse line replaced by a small function that reuses the app's
   existing time-zone helper; no schema change. Tests cover the parser, the writer, the
   new counter and the news desk that reads it; 12 of 12 real mutants killed.
2. **Stats or made up?** No statistics. The one-hour correction comes from the feed's own
   GMT build time and the fetch clock on 161 rows. The 5-minute allowance is a hand-set
   number (clock skew; ESPN's clock was 1 second off ours).
3. **How we know:** measured, not backtested. Local copy: 164 RSS rows stamped after we
   fetched them, all under 60 minutes ahead, 0 of 161 still ahead after a one-hour
   correction. Live feed: 11 of 29 items after the fetch clock with the old parse, 0 with
   the new one.
4. **Pointed anywhere else?** Yes: every reader of `news_items.published_at` in section 6
   (news desk, diagnostics, availability window, team page, typed signals and the lag
   trader through them).
5. **How it unifies:** one parse in `normalizeNewsItem`, shared by the RSS, Twitter and
   transactions writers, built on the same `zonedDateTime` that converts nflverse
   kickoffs. No second copy of the publish time was added.
