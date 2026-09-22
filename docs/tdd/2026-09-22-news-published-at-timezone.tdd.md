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

## 4. Consumers that compute freshness or latency (acceptance item 4)

<!-- filled after GREEN -->
