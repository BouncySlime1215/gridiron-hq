# BROKEN-Q: news collector stamps and as-of news reads

Row Q of `docs/handoff/local/BROKEN-NUMBERS.md` (handoff branch): 1,014 of 1,582 `news_items`
have no `ingested_at`, 412 were ingested > 3 days after `published_at`, 159 were edited after
ingest. Branch `claude/cloud-broken-q`, cut from origin/main `21c9da41`. Not a statistical unit:
no model number, no held-out season opened. Not branched from EA-07 or the engine-spine PRs:
this change needs neither (it adds one column and one SQL clause on `news_items`).

## Cause (origin/main `21c9da41`, file:line before -> after)

| # | Cause | Before | After (flag on) |
|---|---|---|---|
| 1 | ESPN pull never stamped `ingested_at` (the default "Pull ESPN news" path, so most of the 1,014) | `server/routes/espn.js:197` INSERT without `ingested_at` | `server/routes/espn.js:199` INSERT with `ingested_at = insertIngestedAt()` |
| 2 | Manual entry never stamped it | `server/routes/news.js:133` | `server/routes/news.js:134` |
| 3 | `/api/news/analyze` never stamped it | `server/routes/news.js:172` | `server/routes/news.js:173` |
| 4 | A revision (any change to 19 columns, including our own `classification_version`, `confidence`, `reliability_json`) overwrote `ingested_at`, so a story re-classified days later reads as ingested days late, and the edit leaves no record | `server/news/store.js:66` `ingestedAt = contentChanged ? normalized.ingested_at : existing.ingested_at` | `server/news/store.js:74-76` first receipt kept; the revision's receipt goes to `edited_at` (migration 087), `COALESCE(?, edited_at)` at `:80` |
| 5 | As-of news reads required `ingested_at<=cut`, so every unstamped row was silently invisible to them, and they relied on cause 4 for the look-ahead guard | `server/services/nfl-player-state.js:62`, `server/services/nfl-expert-council.js:249` | one clause, `newsKnownAtSql` (`server/news/stamps.js`): `julianday(COALESCE(edited_at, ingested_at, created_at)) <= julianday(cut)`; `nfl-player-state.js:61,66`, `nfl-expert-council.js:251,253` |

Knowledge time follows ENGINE-SPECS "META-01": `max(published_at, ingested_at ?? created_at)`,
rows updated after the cut excluded. `created_at` is `datetime('now')` text (space, no `Z`), so
the clause compares through `julianday()`; a TEXT compare gets same-day rows wrong (mutant M6).

Writer: `upsertNormalizedNewsItem` (`server/news/store.js`), `insertArticles`
(`server/routes/espn.js`), `POST /api/news` and `/api/news/analyze` (`server/routes/news.js`).
Table: `news_items`. Column added: `edited_at` (`server/migrations/087_news_items_edited_at.js`, additive).

## Flag

`GRIDIRON_NEWS_STAMPS_ENABLED`: `1` on, `0` off (vetoes preview), unset = `previewUnconfirmed()`
(`server/services/preview-mode.js`). Flag off: every writer and reader is byte-for-byte the old
behaviour (tests 8 and 9, and the unchanged `test/news-ingest.test.js:331` revision test).

## RED / GREEN

- **RED** `448948e3` "test: RED news collector stamps and as-of news reads (BROKEN-Q)":
  `test/news-stamps.test.js` against unchanged writers and readers: `# pass 3 # fail 6`. Failing:
  - 3: `first receipt is kept` — actual `'2026-08-08T09:30:00.000Z'`, expected `'2026-08-06T12:00:00.000Z'`
  - 4, 9: `insertArticles` not reachable (no test hook on the ESPN writer)
  - 5: manual entry `ingested_at` — actual `null`, expected truthy
  - 6: `newsFor` feed_stories — actual `1`, expected `3`
  - 7: roster event for an unstamped wire inserted before the cut — actual `0`, expected `1`
- **GREEN** (see PR): 9/9 pass.

Command: `SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/news-stamps.test.js`

## Mutation sweep

`python3 docs/tdd/2026-09-24-broken-q-news-stamps/mutants.py` (unit and call-site mutants, one
designed survivor, one designed not-applied control):

| Mutant | Result |
|---|---|
| M1 store: revision overwrites ingested_at again | killed |
| M2 store: revision never stamps edited_at | killed |
| M3 store: a pure resend stamps edited_at | killed |
| M4 as-of: edited_at dropped from the knowledge clock | killed |
| M5 as-of: no created_at fallback | killed |
| M6 as-of: TEXT compare instead of julianday | killed |
| M7 flag: unset ignores preview | killed |
| M8 call site: nfl-player-state keeps the old clause | killed |
| M9 call site: nfl-expert-council keeps the old clause | killed |
| M10 call site: ESPN insert passes NULL | killed |
| M11 call site: manual POST passes NULL | killed |
| M12 call site: ESPN stamps with the flag off | killed |
| C1 designed survivor: preview-reason wording | survived (as designed) |
| C2 designed not-applied: absent text | not applied (as designed) |

Not covered by a mutant: the `/api/news/analyze` insert (`server/routes/news.js:173`) calls
Claude; it uses the same `insertIngestedAt()` as the two killed call sites (M10, M11).

## Full suite

`npm test` on the GREEN tree: `# tests 4842 # pass 4799 # fail 0 # skipped 43`, exit 0.
