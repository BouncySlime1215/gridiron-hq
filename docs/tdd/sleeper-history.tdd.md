# TDD evidence — real public-league history (Sleeper) — 2026-09-18

**Why:** plan section 00, parts D2-D3. The Team Outlook, trade horizon, waiver and posture calibration, and the Coach's "teams like yours" need real league history beyond Nick's 12 league-seasons.

**Files:** `server/services/sleeper-history.js` (pure parsing), `scripts/collect-sleeper-history.mjs` (crawler + CLI), `test/sleeper-history.test.js`, `test/sleeper-crawl.test.js`. Output DB `data/derived/sleeper_history.sqlite` (git-ignored).

| Stage | Commit | Evidence |
|---|---|---|
| RED (parsing) | `cb0c240` | module missing; 5 tests pin eligibility, scoring, bracket playoffs and champion, all-play, team-seasons without owner ids |
| GREEN (parsing) | `fd6bdbd` | 7/7; lines 100%, branches 88.6%, functions 100%. RED caught a real bug: a missing score read as 0 (`Number(null) === 0`) |
| RED (crawler) | `e48be41` | script missing; 3 tests pin eligible-only, per-season quota, resume without duplicates, retries then `failed` (never half-stored), no user id anywhere after a crawl |
| GREEN (crawler) | this commit | 14/14 across both files; crawler lines 92.4%, branches 85.3%, functions 90%; the only uncovered lines are the CLI's `isMain` block (network) |

**Privacy, tested:** no user ids, display names, team names or owner ids are written; the crawl queue's user ids are purged when a crawl completes (a paused crawl keeps them only to resume).

**Politeness:** 12 requests/second default (Sleeper asks for under 1,000/minute), retries with backoff on 429/5xx, 404s not retried.
