# TDD evidence: beat reporter source map, injury_status slice (2026-09-22)

**Item:** Phase A, PART 5 approved additions — "BEAT REPORTER SOURCE MAP... Score sources
historically: whose reports actually predicted outcomes vs. who cried wolf." First slice
only (Composer protocol: prove a small slice before building on it). The other four
claim_types (`role_change`, `transaction`, `return_from_injury`, `suspension`) are not
attempted here — each needs its own ground-truth read, `transaction` has none available at
all (flagged, not built around).
**Files:** `server/services/beat-reporter-accuracy.js` (new, this thread's own file — no
shared file touched), `server/migrations/063_beat_reporter_claim_resolutions.js` (new);
test `test/beat-reporter-accuracy.test.js`.
**Reads only, never modified:** `server/news/twitter-ingest.js`, `server/services/
source-validation.js`, `server/services/nfl-news-events.js`, `server/routes/news.js`,
`client/src/features/news/NewsHub.tsx` — all UI-thread-owned. `server/services/
contingency.js` — scheduler/fantasy-plan-owned, read only for its `availabilityBasis()`
discipline (named reason over silent default), not imported.
**LLM spend:** $0. `classifyInjuryDirection` is a deterministic keyword read, not a model
call — the extractor (`nfl-news-events.js`) is already the one hallucination surface in
this pipeline and this does not add a second one on top of it.
**Environment:** cloud box. `server/data.sqlite` (checked into the repo) is an
empty/pre-migration fixture — no `nfl_news_events` rows, zero `schedule_games` and
`player_week_usage` rows, confirmed by direct query
(`node:sqlite` `DatabaseSync(path, {readOnly:true})`). `server/db/seed/` has no news/claim
seed data either. **No real historical claim, schedule, or snap data is reachable from
this session, so nothing below is a reading of production history.** This was the plan —
"hand-check 5-10 resolutions against real historical data" — before that fact was found;
see §6 for the honest revision.

## 1. What this slice does

`injury_status` is the one claim_type with a clean, already-collected ground truth:
`player_week_snaps.offense_snaps` says whether a player actually played. The slice:

1. `classifyInjuryDirection(text)` — reads a claim's `evidence_span`/`claim_text` for
   `'sidelined'` (ruled out, doubtful, inactive, IR, ...), `'clear'` (cleared, active,
   expected to play, ...), `'uncertain'` (questionable, day-to-day — a hedge, not a
   direction), or `null` (no injury-status language at all).
2. `resolveInjuryClaim(event, {asOf})` — for a `'sidelined'`/`'clear'` claim, finds the
   claimed team's next `schedule_games` row on or after the claim date, resolves the
   player by `normalizePlayerName` against that team's roster, and reads
   `player_week_snaps` for that season/week. `resolved_state` is `'confirmed'` or
   `'contradicted'` **only** when a played game's snap count is in hand; every other case
   (no direction, hedge, unrecognized team abbr, unresolved player name, game not yet
   played, no snap data yet) is `'unresolved'` with a specific printed
   `resolved_reason` — never a guess standing in for missing evidence, same discipline as
   `contingency.js`'s `availabilityDegradation()`.
3. `resolveInjuryClaims({limit, asOf})` — batches over `nfl_news_events` where
   `claim_type = 'injury_status'`, upserts one row per `event_id` into
   `beat_reporter_claim_resolutions` (migration 063). Idempotent: re-running does not
   duplicate rows, and an `'unresolved'` row upgrades to a real verdict once snap data for
   that week exists.
4. `sourceTrustScore(handle, {claimType})` — three explicit states, not a single number
   that collapses "never measured" into "measured and bad":
   - `'none'`: zero resolved claims. `score: null`.
   - `'pooled'`: fewer than 5 resolved claims (`MIN_SAMPLE`). The raw rate is shrunk toward
     the claim_type-wide baseline (`(raw*n + baseline*5) / (n+5)`), so one lucky/unlucky
     call is never reported as a measured 100%/0%.
   - `'measured'`: 5+ resolved claims. The raw confirmed/total rate stands.
5. `orderByTrust(items, {scoreOf})` — sorts only the items that have a score; an unscored
   item keeps its exact original index rather than being pushed to either end (the UI
   thread's explicit requirement — an unscored handle must never visually read as "measured
   and unreliable").

## 2. Gate

No statistical fit, so no numeric gate. The behavioural gate is the pre-registered rule
that `resolved_state` may only be `'confirmed'`/`'contradicted'` when a played game's real
snap row backs it — held by construction (every non-evidence path returns before the
snap-count comparison) and pinned by the eight `resolveInjuryClaim` cases in §4.

## 3. Regression

| suite | result |
|---|---|
| beat-reporter-accuracy (new) | 20/20 |
| `npm run lint` | clean, 915 files |
| full suite (`npm test`) | pending — background run, see follow-up |

## 4. Test specification

| # | Guarantee | Result |
|---|---|---|
| 1-3 | `classifyInjuryDirection` reads sidelined / clear / uncertain language correctly | PASS |
| 4 | `classifyInjuryDirection` returns `null` for text with no injury-status signal (not a coin flip) | PASS |
| 5 | sidelined claim, zero snaps in the resolved game → `confirmed` | PASS |
| 6 | sidelined claim, player actually played → `contradicted` | PASS |
| 7 | clear claim, player played → `confirmed` | PASS |
| 8 | clear claim, player did not play → `contradicted` | PASS |
| 9 | game not yet played (relative to `asOf`) → `unresolved`, reason names the game hasn't happened | PASS |
| 10 | hedge language (questionable/day-to-day) → `unresolved`, never forced to a direction | PASS |
| 11 | unrecognized team abbreviation → `unresolved`, reason names the team | PASS |
| 12 | player name does not resolve to a unique roster row → `unresolved`, reason names the player | PASS |
| 13 | `resolveInjuryClaims` upserts one row per event, re-run does not duplicate | PASS |
| 14 | zero resolved claims for a handle → `'none'`, `score: null` (never a low number) | PASS |
| 15 | 8 resolved claims (over the floor) → `'measured'`, raw rate (6/8 = 0.75) | PASS |
| 16 | 1 resolved claim (100% raw) with a lower pool baseline → `'pooled'`, score **below** 1 (non-tautological: the naive raw-rate bug would pass this test at score=1) | PASS |
| 17 | `claimType` filter scopes the sample independently per type for the same handle | PASS |
| 18 | an unscored item (`score: null`) keeps its exact original array index | PASS |
| 19 | scored items sort descending only within the slots that had a score | PASS |
| 20 | tied scores keep original relative order | PASS |

**RED → GREEN:**
- `df09341` RED: 20 tests, 0 pass / 20 fail (`server/services/beat-reporter-accuracy.js`
  did not exist, `ERR_MODULE_NOT_FOUND` on import).
- GREEN commit: this file's companion commit, 20/20.

**Command:** `node --test test/beat-reporter-accuracy.test.js`

## 5. File-ownership / Composer protocol

`server/services/beat-reporter-accuracy.js` and migration 063 are new files this thread
owns outright — nothing shared was edited. The cross-thread seam for the UI thread is
`sourceTrustScore` and `orderByTrust`, the same pattern as Coach's `conceptById` seam built
earlier for the UI thread's stat-lexicon panels: the UI thread imports these two functions
into its own `news`-owned files on its own schedule: this thread does not touch
`routes/news.js`, `NewsHub.tsx`, or `useNewsFeed.ts`.

## 6. Known limits — the honest revision of the original plan

1. **"Hand-check 5-10 resolutions against real historical data" is not possible from this
   session.** `server/data.sqlite` is an empty pre-migration fixture (confirmed by direct
   `node:sqlite` query, read-only), and no news/claim seed data exists anywhere in the
   repo. Every one of the 20 test cases above is a hand-constructed fixture exercising a
   named path through the resolver (both directions × confirmed/contradicted, and each of
   the five distinct `'unresolved'` reasons) — not a sample of real reporter claims. This
   is the same category of gap the project has hit before (§7 of
   `availability-honest-degradation.tdd.md`): a claim about production data that this box
   cannot verify. **A real hand-check — running `resolveInjuryClaims()` against the live
   `nfl_news_events` table and eyeballing 5-10 actual reporter claims against what actually
   happened — needs a session with the real database** (the Mac, or a thread reading the
   live Fly volume), not this one.
2. **`resolveInjuryClaim`'s "next game" lookup does not filter by season number**, only by
   date — a claim published in the last days of a season with no `schedule_games` row for
   the following season yet would find nothing (correctly `unresolved`, not wrong), but the
   query has not been exercised against a season boundary in a real schedule; flagged, not
   fixed, since no schedule data exists here to test it against.
3. **`sourceTrustScore`'s pool baseline is unscoped by team/position/season.** A handle's
   thin sample is blended toward a single claim_type-wide accuracy figure across every
   reporter and every season on file. Whether that is the right pool (vs., say, a
   per-position or recency-weighted baseline) is a modeling choice Nick has not been asked
   about; flagged for Phase B/C rather than decided here.
4. **The classifier is single-signal.** It has not been tested against compound sentences
   that name both a sidelined and a clear state in the same claim (rare in real wire
   copy, per the module's own comment, but unverified against real copy for the same
   reason as #1).
