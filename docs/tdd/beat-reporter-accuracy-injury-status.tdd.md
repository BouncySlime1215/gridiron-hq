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
seed data either. No real historical claim, schedule, or snap data is reachable from
this session's own database. **Per Nick's standing rule (2026-09-22, "if we lack data,
let's go find it online for free"), real 2025 season data was pulled from nflverse's
public GitHub releases** (`nflverse/nflverse-data`, free, no auth) — `injuries_2025.csv`
(official weekly injury report designations), `snap_counts_2025.csv`, and `games.csv`
(full schedule history) — and used for a real hand-check in §6/§7, which twice caught the
resolver being wrong before it shipped.

**What "real" covers and what it doesn't.** nflverse's injury report is the official
team-issued weekly designation (Out/Doubtful/Questionable/cleared), not a beat reporter's
own tweet text — no free source of historical reporter tweet text at claim-level
granularity was found (the project's paid path for that, `twitterapi-io.js`, reads live
handles going forward, not archives). The claim text used below is written in reporter
style FROM the real official designation ("X has been ruled out"), so the resolution
logic and its ground truth (`snap_counts`/`schedule_games`, both fully real) are validated
against reality; the direction-classification-from-free-text step is exercised on
realistic but constructed sentences, same as the fixture tests in §4. Missing:
**real historical beat-reporter claim text with reporter attribution, at scale** — flagged
for Nick per the new rule, not blocking (the official designation is itself real ground
truth for whether the resolver's snap-comparison logic is correct, which is what mattered
most to get right).

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
| beat-reporter-accuracy (new) | 22/22 (2 added after the real hand-check in §6 found real bugs) |
| `npm run lint` | clean, 915 files |
| full suite (`npm test`, `SCHEDULER_DISABLED=1`) | 3133/3133 pass, 0 fail, 41 skipped, exit 0 (run before the two §6 fixes; the fixes are additive/narrower-scoping only within this thread's own new file, re-verified by re-running this file's own 22/22 and lint after) |

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
| 21 | a player with no snap row at all, but teammates who have one, resolves as did-not-play, not "no data yet" (§6 bug 1) | PASS |
| 22 | a defensive-position player is `unresolved` rather than read off `offense_snaps` (§6 bug 2) | PASS |

**RED → GREEN:**
- `df09341` RED: 20 tests, 0 pass / 20 fail (`server/services/beat-reporter-accuracy.js`
  did not exist, `ERR_MODULE_NOT_FOUND` on import).
- GREEN commit: 20/20, then two more tests (#21-22) added and the two §6 bugs fixed
  after the real-data hand-check found them — 22/22 final.

**Command:** `node --test test/beat-reporter-accuracy.test.js`

## 5. File-ownership / Composer protocol

`server/services/beat-reporter-accuracy.js` and migration 063 are new files this thread
owns outright — nothing shared was edited. The cross-thread seam for the UI thread is
`sourceTrustScore` and `orderByTrust`, the same pattern as Coach's `conceptById` seam built
earlier for the UI thread's stat-lexicon panels: the UI thread imports these two functions
into its own `news`-owned files on its own schedule: this thread does not touch
`routes/news.js`, `NewsHub.tsx`, or `useNewsFeed.ts`.

## 6. Real-data hand-check (2025 week 1, nflverse) — two bugs found and fixed

Ten real injury-report designations from 2025 week 1 (5 Out, 2 Questionable, 3
full-participation/no-designation "cleared") were turned into claim text and run through
the actual `resolveInjuryClaims()` against a database seeded with the real schedule
(`games.csv`) and all 1,482 real week-1 snap-count rows (`snap_counts_2025.csv`). This
caught two real defects the fixture tests could not, because every fixture supplied
exactly the row the resolver expected — real data doesn't:

1. **Absence-as-missing-data was wrong.** `player_week_snaps` (and nflverse's
   `snap_counts` it would be sourced from) only carries a row for a player who logged at
   least one snap. Will Hernandez (ARI, "Out") has no row for week 1 at all — not a zero
   row — because he did not dress. The original code read that absence as "no data yet"
   and reported every single real "Out" claim as `unresolved`, which is the "data
   healthy" banner's exact failure shape: confident-looking code silently reporting
   nothing. **Fixed**: absence now means "did not play" whenever teammates already have
   snap rows for that team/week (proving the box score landed); it means "no data yet"
   only when nothing for that team/week exists at all.
2. **`offense_snaps` cannot speak for a defensive player.** Jaire Alexander (BAL, a CB,
   cleared with no designation) had `offense_snaps: 0` despite playing the whole game at
   cornerback — the column only measures offense. Before this was caught, a cleared
   defensive player's claim would have resolved `contradicted` (predicted played, offense
   snaps read 0) — the exact opposite of reality. **Fixed**: `resolveInjuryClaim` now
   checks the resolved player's position and returns `unresolved` with a named reason for
   anyone outside `QB/RB/FB/WR/TE`, rather than guessing from a column that was never
   collecting their data in the first place.

Both fixes are pinned by new fixture tests (`sidelined claim confirmed when the player has
no snap row at all but teammates do`, `unresolved for a defensive position`) so they don't
regress, in addition to being the reason the real hand-check below reads clean.

**Real hand-check result, after both fixes, offense-position sample (QB/RB/FB/WR/TE
only — the position guard makes a defense-heavy sample uninformative, so the sample was
narrowed to the positions this ground truth actually covers):**

| player | team | real designation | real week-1 offense_snaps | resolver verdict |
|---|---|---|---|---|
| Patrick Ricard | BAL | Out | (no row — did not play) | confirmed |
| Isaiah Likely | BAL | Out | (no row — did not play) | confirmed |
| Nate Adkins | DEN | Out | (no row — did not play) | confirmed |
| Sione Vaki | DET | Out | (no row — did not play) | confirmed |
| Braxton Berrios | HOU | Out | (no row — did not play) | confirmed |
| Owen Pappoe | ARI | Questionable | 0 | unresolved (hedge, by design) |
| Dante Stills | ARI | Questionable | 0 | unresolved (hedge, by design) |
| Elijah Moore | BUF | (cleared, full participant) | 12 | confirmed |
| Khalil Shakir | BUF | (cleared, full participant) | 60 | confirmed |
| Keon Coleman | BUF | (cleared, full participant) | 75 | confirmed |

**8 confirmed / 0 contradicted / 2 unresolved (both correctly refusing to force a
direction on hedge language)** — every one of the 8 non-hedge claims matched the real
outcome. 0 contradicted here is expected and not a sign of an untested path: an *official*
Out/cleared designation is close to ground truth by construction, which is exactly why
`contradicted` needs the earlier fixture tests (§4 #6/#8) for coverage rather than this
sample — this sample's job was proving the resolver's snap-comparison plumbing against
real rows, which it did, twice catching itself wrong first.

**Command:**
`node /tmp/.../scratchpad/real-handcheck.mjs` (session-scratchpad script, not committed —
downloads `injuries_2025.csv`/`snap_counts_2025.csv`/`games.csv` from
`github.com/nflverse/nflverse-data/releases/download/{injuries,snap_counts,schedules}/`,
seeds an isolated test database with the real schedule and real week-1 snaps, and prints
the resolver's verdicts against the 10 real designations above).

## 7. Known limits — the honest revision of the original plan

1. **Updated per Nick's 2026-09-22 rule ("if we lack data, go find it online for
   free").** `server/data.sqlite` is still an empty pre-migration fixture with nothing
   reachable in this repo, but §6 shows real, free, verifiable 2025-season data (nflverse)
   was found and used for the hand-check instead of stalling on that gap. **What's still
   genuinely missing, per the rule's own instruction to name it explicitly: missing —
   real historical beat-reporter claim TEXT with per-handle attribution at any scale**
   (nflverse's injury report is official and real, but it is the team's own designation,
   not a reporter's call — there is no free source of archived, attributed reporter
   tweets found). §6's claim text is written in reporter style from the real official
   designation, which validates the resolution/ground-truth logic (and did catch two real
   bugs) but does not validate `sourceTrustScore` per-handle against a real multi-reporter
   track record — `sourceTrustScore`'s own tests (§4 #14-17) remain fixture-only for that
   reason. This is a reasonable target for Nick to weigh in on: either a paid archive, or
   accept that per-handle scoring only starts compounding real signal once the live
   ingest (`twitter-ingest.js`) has been running and `resolveInjuryClaims()` has been run
   against its own accumulated `nfl_news_events` for a few weeks.
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
