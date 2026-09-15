# G04 adversarial verification — lens: practice-truth

Question: is "refuse capture at/after kickoff or when a score exists; quarantine existing
post-kickoff rows via invalidation rows (no deletes)" a genuine, widely-held ledger/backtest
principle, or opinion dressed as a standard? Does it survive NFL sample sizes (272 games/season)?

Repo (read-only): /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard
Files read in full: server/services/shadow-ledger.js (122 lines), server/services/nfl-evidence.js
(179 lines), server/services/game-cutoff.js (24 lines). Partial reads cited by line elsewhere.
No web lookups (per run rules) — "widely held" is established from the repo's own frozen
contracts, its governance manual, and sibling implementations that already enforce the rule.

## Verdict: NOT refuted. The should-be is a standard this repo already declares and enforces elsewhere.

### 1. The repo declares the principle as its own frozen contract (not the auditor's opinion)

- docs/evidence/contracts/profitability-policy-v1.3.md:23 — Forecast gate #1:
  "Cutoff-safe predictions captured before the first actionable quote."
- same file :53 — Real-money gate: "The market-edge gates pass on frozen forward decisions."
- same file :36-37 — "One decision per event/player/market; repeated books and hourly
  snapshots do not inflate the sample."  (a row captured after the outcome is not a decision)
- server/services/nfl-evidence.js:61-62 — the forward-holdout window row seeded into
  nfl_validation_windows: `'Only decisions captured before kickoff under a version-pinned
  policy count as untouched evidence.'`
- server/services/nfl-evidence.js:175 — rule: `'Import timestamps do not prove that a quote
  existed before kickoff.'`
- docs/reference/model-governance-manual.md:1021-1023 — Evidence lifecycle:
  "3. Predictions, abstentions, model version, quote, and feature snapshot are recorded before
  the event. 4. Evaluation is chronological."
- same :1035 — "The daemon never backfills a past event."
- same :618 — "Its next test is the already-frozen forward ledger, with closing prices
  preserved before kickoff."
- same :630 — "Rows are append-only."
- same :267 — Phase A step 5: "Match closing prices captured before kickoff."; step 6:
  "Quarantine any row with ambiguous ... timestamp identity."
- docs/CLAUDE-NEXT-STEPS.md:506 — "If capture was missed, record a missing prospective
  observation; never reconstruct it with later receipts and call it prospective."

### 2. Sibling code in the same repo already implements exactly the should-be

- server/services/forward-ledger.js:71-75 (doc): "Refuses to record one for a game that has
  already been played. That is the whole integrity of the ledger: a 'forward' pick entered
  after kickoff is not evidence of anything, and nothing downstream could tell the difference."
- forward-ledger.js:96-105:
  ```js
  const game = row(`SELECT team_score, opp_score, gameday, gametime FROM game_lines ...`);
  ...
  const kickoff = nflKickoffDate(game?.gameday, game?.gametime);
  if (game?.team_score != null || (kickoff && now >= kickoff)) {
    return { error: 'that game has already been played',
      note: 'A forward pick recorded at or after kickoff is not forward. ...' };
  }
  ```
  — this is literally "refuse at/after kickoff OR when a score exists".
- forward-ledger.js:119-123 — UNIQUE violation returns "Append-only by design. Overwriting a
  recorded prediction would let a bad one be quietly replaced".
- forward-ledger.js:259 — "Append-only and timestamped before kickoff. This is the only
  evidence in the project that cannot be re-sliced after the fact".
- forward-ledger.js:272-279 — recordThisWeek selects `team_score IS NULL` only; "Picks are
  only recorded before kickoff, so a completed week produces nothing here by design."
- server/services/beat-the-close.js:172-177 — slateSignals: `const kickoff = gameCutoff(s, w,
  game.home); if (kickoff && kickoff <= now) continue;` — the OTHER writer into the same
  shadow_decisions table already guards kickoff at decision time.
- server/services/evidence-daemon.js:54-56 — planEvidenceWindows only plans windows for
  `team_score IS NULL` games and drops events older than 6h; :77-79 dueWindows requires
  `event_at >= now-5min`. The daemon itself never targets a finished game.
- server/services/game-cutoff.js:1-15 — "The one cutoff representation ... Every pregame
  evidence question is 'what was known before this game's kickoff'".
- test/forward-ledger.test.js:38-52 — "the forward ledger locks at kickoff even before a score
  is synced" (asserts refusal at exactly 17:00:00Z for a 13:00 ET kickoff).

### 3. In-repo precedent for "quarantine, never delete"

- server/services/nfl-auto-picks.js:22-25 — "A locked pick is a ledger entry and must never
  silently vanish, but a pick locked under a policy that no longer exists is not a live
  position either — that is what voided_at/void_reason are for: the row and its history
  stay, the standing drops it."  (:238-240 gradePick returns 'Void' before score lookup)
- docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:630 — "The correct unification is an append-only
  economic/decision history with mutable read projections, not 'make every table immutable'
  or 'delete the old tables.'"
- Implementation shape (separate invalidation row vs. a voided_at column) is a design choice;
  the principle — append-only identity, explicit invalidation, no deletes — is the standard
  and the repo's precedent is the column form.

### 4. The sample-size objection does not apply

The guard is a per-row VALIDITY condition (was the prediction fixed before the outcome was
knowable?), not a statistical-power condition. It holds at n=1. At 272 games/season the
pressure to inflate n is precisely why the guard matters: nfl-policy.js:63-65 gates on "200
settled independent decisions overall ... 75 in a market", and profitability-policy-v1.3.md:68-71
already concedes "a few hundred bets can still be insufficient to detect a small real edge" —
admitting post-outcome rows would spend scarce forward sample on non-evidence. Removing
post-kickoff rows shrinks n by (here) 2 of 8 settled rows; it never makes the rule inapplicable.

## Live-DB confirmation of the defect (read-only, node:sqlite)

game_lines 2026/1/SEA home=1: gameday 2026-09-09, gametime 20:20 (ET) => kickoff
2026-09-10T00:20:00Z (nflKickoffDate = zonedDateTime America/New_York, date-util.js:48-50);
team_score 13, opp_score 10, closing_spread -3, spread -3.

Post-kickoff shadow rows across ALL NFL model_versions (join on gameday/gametime + 4h): 2.
- id 200  nfl-ensemble-v2-shadow:champion:nfl-spread-v1@1.2.0:production-unchanged
  decision=abstain captured_at 2026-09-10T23:36:01.906Z quote_at '2026-09-10 23:02:55'
  line 3 price -102 settled 2026-09-11T04:12:55Z result Push clv 0
- id 216  ...:candidate:nfl-spread-v1@1.2.0:neutral-cold-start — identical timing/outcome.
Both are ~23h after kickoff and ~20h after the final.

Mechanism (confirmed from evidence_capture_windows):
- SEA:NE's own six windows are all captured/partial with due_at <= 00:15Z on 09-10; nothing
  for SEA:NE was due at 23:36Z.
- The window captured at 23:37:11Z is 2026:1:LAR:SF T-60m (event_at 00:35Z 09-11, due 23:35Z).
- evidence-daemon.js:95-101 groups due windows by `${season}:${week}`; :125 calls
  `recordNflShadowBoard(season, week)` for the WHOLE week.
- shadow-ledger.js:11-15 builds both boards for the whole week; :21-31 iterates every decision
  and the only skip is `exists` on (event_key, market, model_version).
- The policy bump 1.1.0 -> 1.2.0 changed model_version (shadow-ledger.js:24), so `exists`
  missed for all 16 week-1 games; 15 were still unplayed, SEA:NE was final.
- Batches: 1.1.0 wk1 @09-02T05:51Z (16), 1.1.0 wk2 @09-09T03:44Z (16), 1.2.0 wk2
  @09-10T20:09Z (16, fired by week-2 'open' windows), 1.2.0 wk1 @09-10T23:36Z (16).
- The stored line=3 came from game_lines.spread read at 23:02Z on 09-10 (nfl-auto-picks.js:98-100
  reads `spread, spread_odds, fetched_at` from game_lines); forward-ledger.js:150-151 warns
  syncCurrentLines "can overwrite with an in-game number after kickoff". line==closing_spread
  ==3, so clv=0 is tautological, not a measurement.
- settleNflShadowDecisions (shadow-ledger.js:57-105) has no kickoff/captured_at guard either;
  it labeled both rows Push at 04:12Z on 09-11.

## Where the gap's EVIDENCE line overstates (correction, not refutation)

- "validationFirewall().forward counts observe rows (nfl-evidence.js:114-123)" — true, but rows
  200/216 are decision='abstain'. nfl-evidence.js:115-118 counts only `decision='observe'`; the
  ensemble has 0 observe rows (live query). Live forward = {decisions: 61, settled: 0}, all 61
  from beat-the-close observe rows. So these two rows do NOT currently inflate the promotion
  gate. The realized contamination is:
  * shadow-ledger.js:117-118 `settled` (counts all rows with result; live = 8, 2 of them
    post-kickoff) and :113-114 `independent_examples`; surfaced via model-intelligence.js:117
    as "immutable NFL capture ledger".
  * server/services/nfl-signal-reliability.js:85-95 frozenExamples reads every settled spread
    row, dedupes by season|week|home taking the FIRST by (candidate-first, captured_at ASC);
    for SEA:NE the pre-kickoff id 31 (09-02) wins over id 216 (09-10) — the reliability
    controller is protected only by sort order, not by a guard.
- The harm to the forward gate is therefore LATENT: the identical code path will write
  decision='observe' post-kickoff rows the moment the ensemble is calibration-eligible
  (nfl-auto-picks.js:139 calibrationEligible), and nfl-evidence.js:115-118 would count them.

## Side observation (out of G04 scope, not investigated further)
beat-the-close rows 91/92 (2026:1:SEA:NE) were settled at 01:20Z on 09-10 — during the game —
with result NULL (score not yet present; beat-the-close.js:277-300 sets settled_at once and
never revisits). Their result stays NULL although the game is final. Separate gap candidate.
