# TDD evidence: review-fixes-2 (2026-09-18)

**Item:** WA, "review fixes" — the eight findings from the two review lenses
(silent-failure-hunter, mle-reviewer) on 9a7a809..8813066, re-checked at HEAD 5299ea9.
**Gate:** `wa/review-fixes-2/GATE.md`, written before any fix ran. Its one rule: no fix
in this item may move a served number (G-identity below); anything that would move one
is deferred with its gate and step.
**LLM spend:** $0.00. No Anthropic calls were made (no `ai_usage` rows).

## G-identity — the same numbers, on a production copy

`wa/review-fixes-2/identity.mjs` on a VACUUM INTO copy of `server/data.sqlite`
(2026 W2, leagues 1-5): every asset's `current_week_ppg`, `active_probability`,
`ros_ppg`, `adj_ppg`, `floor`, `ceiling`, plus `lineupCall()`'s projected points and
started players.

| after | assets compared | assets changed | lineups changed |
|---|---|---|---|
| finding 1 (availability loader) | 43,200 | 0 | 0 of 5 |
| finding 5 (cache stamps) | 43,200 | 0 | 0 of 5 |
| finding 8 (prediction log) | 43,200 | 0 | 0 of 5 |

## What each finding got, most severe first

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | Play-chance loader swallows every read error; no one says which model is live | **Fixed** (code) + **deferred** (the production write) | `test/availability-fit-loader.test.js` 7/7 |
| 2 | ESPN OUT / IR never reach `active_probability` | **Rejected — already fixed** at HEAD by `f60c0d2`/`d8d9e22` | probe on the copy: 8 of 8 rostered ESPN OUT/IR players read 0.001 |
| 3 | Failed chat classifications parked for good; classifier exits 0 | **Fixed** (retry) | `test/league-chat-classifier-retry.test.js` 3/3, `scripts/chat/test_extract_league_chat.py` 20/20 |
| 4 | A promotion that fails its own check stays live | **Fixed** | `test/weekly-promotion-rollback.test.js` 4/4 |
| 5 | Asset cache cannot see in-place injury / stat / line updates | **Fixed** | `test/asset-cache-stamps.test.js` 5/5 |
| 6 | Coordinator served on a different basis than it was fit on | **Deferred — WO**, needs its own gate | still live at `trade-engine.js:298` |
| 7 | Vegas game-script lift is the shared Start/Sit basis and was never graded | **Deferred — WO** (+ posture refit in WD) | still live at `lineup-brain.js:280` |
| 8 | Prediction log and evidence block name the wrong model | **Fixed** (mode + wording); snapshot identity **deferred — WD** | `test/prediction-log-served-model.test.js` 3/3 |

## 1. Availability loader (high) — `server/services/contingency.js`

**Audit.** `fittedAvailability()` read both fit tables inside bare `catch {}` blocks, so a
missing table, a missing column and a locked database were the same thing: "no role
layer", every player on the pooled path. Production has run that way since
2026-09-18 00:07 (`nfl_availability_rates` 139 rows, no `nfl_availability_role_rates`),
with no log line, no flag on the asset universe and no note on any page.

**Fix.** `no such table` becomes a named state — `availabilityBasis()` returns
`{ basis: 'role' | 'pooled' | 'constants', missing, stamp }`, warned once per
`availabilityFitStamp()` and carried on `assetUniverse().context.availability_basis`
and `lineupCall().availability_basis`. Every other read error throws. The stamp is
cached only after both reads succeed, so a failed read can no longer be remembered as
"no fit".

| RED | GREEN |
|---|---|
| `2688ecf` — 7 of 7 fail (no `availabilityBasis`, no exception for a role table without its `config` column, no basis on the universe or Start/Sit, no warning) | `0a657f6` — 7/7; neighbours availability-role 17/17, play-chance-live 19/19, player-availability 15/15, asset-universe-fingerprint 5/5, model-integrity 94/94 |

**Root cause, deferred with its step.** The role table is missing from production
because the fit was held for the WA integration restart, with a measured reason
(`docs/tdd/play-chance-live.tdd.md` §6: the running server, started 06:08, has the old
code, and old code + new rates fails G4 — it would start three ESPN-Questionable
players). The production copy now reports `basis: 'pooled', missing:
['nfl_availability_role_rates']`. **Step: WA integration restart**, in this order:
restart on this code with `SCHEDULER_DISABLED=1`, run
`node --env-file-if-exists=.env scripts/fit-availability.mjs`, expect `DECISION: PASS`
and 871 role rows, then confirm `availabilityBasis().basis === 'role'`.

## 2. ESPN OUT / IR (high) — rejected, already fixed

At HEAD `weekDesignation()` merges ESPN's live status into the week's designation.
Probe on the copy (no role table, so the pooled path — the worst case):

| player | ESPN | active_probability | basis |
|---|---|---|---|
| Zach Charbonnet | OUT | **0.001** | `out/none x SEA` |
| A.J. Brown, Jordan Mason, Jordyn Tyson, Isiah Pacheco, Ja'Kobi Lane, Jayden Higgins | INJURY_RESERVE | **0.001** each | `out/none x <team>` |
| De'Zhaun Stribling | OUT | **0.001** | `out/dnp x SF` |

The reverse disagreement flag the finding asks for ("ESPN lists him out; our model says
X%") cannot fire any more: ESPN's designation now *is* the number for the live week.
The live server still shows the old numbers because it runs pre-restart code — the same
WA integration item as finding 1.

## 3. Chat classifier retry (medium) — `scripts/news-line/jev_league_chat.mts`, `scripts/chat/extract_league_chat.py`

**Audit.** infra-essentials (`bdfafda`) already made parked rows visible (sync_log
`partial`, a WARNING every tick, 18 rows outstanding). What remained: a failed row was
never re-sent, so a gateway outage would park every row it touched for good.

**Fix.** `jev_chat_done.attempts` (added by guard on the live table, whose rows read as
one attempt used); the classifier re-sends a failed row while `attempts < 3`; a row that
exhausts its attempts is given up once, loudly, with a non-zero exit (the refresh loop
turns that tick into `error`, later ticks into `partial`). `unlabeled_backlog()` counts
exactly the rows the classifier selects — one predicate, so the two cannot disagree
again. The classifier takes `LEAGUE_CHAT_OUT` / `GRIDIRON_DB_PATH` and a test-only
`evaluate` seam (`NODE_ENV=test`), so the retry is proven against a fixture with no
message leaving the machine.

| RED | GREEN |
|---|---|
| `de9ba72` — node 3/3 fail (no fixture seam: the retry could not be tested without sending real messages), python 5 of 20 fail | `6771df8` — node 3/3, python 20/20 |

Cost of the policy: at most 2 extra sends per failed message, ~500 input tokens each at
$0.042/M — under $0.001 for all 18 live rows. Those 18 count as one attempt already
used (the column's default on the live table), so they get two more tries at the next
ticks; if they fail again they are given up once, loudly, and never re-sent.

## 4. Promotion rollback (medium) — `server/services/weekly-weight-store.js`

`promoteWeeklyFitChecked(input, verify)` saves the fit promoted, runs the caller's
read-back checks against the stored row, and on any failure (or a throw) demotes it
with `rejection_reason` and proves it is no longer served before returning. Both
promotion scripts go through it; `promote-weekly-ensemble.mjs` now also checks that the
new row *itself* is served, not merely that some adaptive fit is. The checks are
deliberately not wrapped in one transaction: the harness replay would hold the write
lock past the server's 15 s `busy_timeout`.

| RED | GREEN |
|---|---|
| `3632429` — 4 of 4 fail | `f403e7a` — 4/4; pinned-baselines 3/3, weekly-retrain-early-carry 4/4, weekly-early-week-blend 19/19, weekly-retrain-coverage 6/6 |

## 5. Asset cache stamps (medium) — `server/services/trade-engine.js`, `server/services/compute-cache.js`

`nfl_injuries` was stamped on `id`, a column that does not exist, and `compute-cache`
swallowed the error into a row count; `syncInjuries` upserts in place and 2026 rows
carry no `modified_at`, so a Friday Questionable → Out never invalidated the cached
`active_probability`. `game_lines` (MAX(week) = 22), `player_week_usage` and
`player_week_snaps` (MAX(week) = 18) were constant stamps for the same reason.

Now: the served week's injury report and the served season's usage/snap totals are
digested into the asset-universe and findTrades keys (+1.75 ms on a 7.65 ms
fingerprint); `nfl_injuries` is stamped on `modified_at`, `game_lines` on `fetched_at`;
a stamp or read error is reported once and marked (`stamp-error` / `read-error`) instead
of swallowed; a test walks every `ASSET_INPUT_TABLES` stamp on the migrated schema.

Live check on the production copy (inside a rolled-back transaction): Zay Flowers' W2
row set to `Out` in place → the universe rebuilds, `active_probability` 0.388 → 0.001,
`current_week_ppg` → 0.01. Before, the fingerprint was byte-identical.

| RED | GREEN |
|---|---|
| `56621e5` — 5 of 5 fail | `9fa4b2c` — 5/5; asset-universe-fingerprint 5/5, find-trades 3/3 |

## 8. Prediction log (medium) — `server/services/weekly-learning.js`, `server/services/player-week-engine.js`

Fixed here: the snapshot stores `engine.mode` (so a week-2 row priced on early bucket 1
is labelled `early_week_bucket_1`, not `position_ensemble`), and the evidence block the
Coach will cite names the served weight set and blend — "The WR ensemble (weight set
fit-2, early-week bucket 1) …" — instead of calling every fit "frozen".
`test/weekly-prediction-snapshot-mode-migration.test.js`'s label list was widened to the
engine's own modes.

| RED | GREEN |
|---|---|
| `c5aaa47` — 3 of 3 fail | `3b2bc9b` — 3/3 |

**Deferred, WD (weekly learning loop / accuracy scoreboard):** making `weight_fit` part
of the snapshot identity (a PK change plus a re-capture rule) and writing the week-2
as-served replay tagged fit-2. Both change the dataset the retrain grades on and the
second is a production write, so they need the accuracy-scoreboard gate: re-captured
rows must not change the retrain's champion/candidate comparison on settled weeks, and
the replay must be written under its own version column, not over the pregame row.

## 6 and 7 — deferred, WO, each with its own gate

- **Coordinator basis** (`trade-engine.js:298` passes `weeklyPpg`, the ensemble number,
  to a correction fit on the gap to the *structural* projection; `boom_bust_signal` is
  always null at serve, so every player gets the learned −0.78 missing-value offset).
  Gate: refit without the boom-bust column, build examples with the served weight set
  pinned by id, then walk-forward on 2024 and 2025 against today's served
  `current_week_ppg`, player-clustered `pairedBootstrapDiff`; ship only if the interval
  excludes zero. It moves every `current_week_ppg`, so it cannot ride this item.
- **Vegas game-script lift** (`lineup-brain.js:280`, shared by Start/Sit, the posture
  card and the League Hub card). mle-reviewer's replay: MAE +0.0131 [+0.0040, +0.0227]
  in 2024 and +0.0125 [+0.0031, +0.0225] in 2025, no ordering gain. Gate: the
  matchups.js rule — `replaySeasonWeekly`, fit 2023-24, validate 2025 once, held at 1
  unless it passes; then re-run `fit-posture-calibration.mjs` on whichever basis ships
  (**WD**, `SPREAD_SCALE` 1.63 vs the 1.45 measured under the new chance to play).

## Test specification

| # | What is guaranteed | Test | Result |
|---|---|---|---|
| 1 | A missing fit table is a named basis, warned once per fit stamp | `availability-fit-loader` (3 tests) | PASS |
| 2 | A fit table that cannot be read throws instead of quietly downgrading | `availability-fit-loader` (2) | PASS |
| 3 | The universe and Start/Sit carry the availability basis | `availability-fit-loader` (2) | PASS |
| 4 | An in-place injury / stat / line change rebuilds the universe | `asset-cache-stamps` (3) | PASS |
| 5 | Every asset-input stamp resolves; a broken stamp is reported once | `asset-cache-stamps` (2) | PASS |
| 6 | A promotion that fails or throws in its check is demoted and not served | `weekly-promotion-rollback` (3) | PASS |
| 7 | Both promotion scripts promote only through the checked path | `weekly-promotion-rollback` (1) | PASS |
| 8 | The snapshot records the mode that priced the row | `prediction-log-served-model` (1) | PASS |
| 9 | The evidence block names the served weight set and blend | `prediction-log-served-model` (2) | PASS |
| 10 | A failed classification is retried, then given up loudly with a non-zero exit; a row parked before the column existed keeps the retries it has left | `league-chat-classifier-retry` (4) | PASS |
| 11 | The backlog counts exactly the rows the classifier re-sends | `test_extract_league_chat.py` (4) | PASS |

Commands: the repo runner for the node files; `python3 -m unittest discover -s scripts/chat -p 'test_*.py'`.

## New work found while doing this (not done here)

1. **`test/refresh-loop-steps.test.js` G6 is an open RED** from `66cdac0`:
   `nfl_model_growth` and `ffopportunity` are still not in `FANTASY_LIVE_JOBS`, so with
   the scheduler off `player_week_usage` stops advancing and the role layer's "missed
   last game" signal reads every player as never having missed a game from week 3 on.
   Two allowlist lines plus that test. **Step: WA integration.**
2. **`football-first.js#residualModel`** stamps `nfl_injuries` on MAX(week) — the same
   blind spot, on the betting side only (the fit is on prior seasons, so it is cosmetic
   today). **Step: WD.**
3. **The 18 parked chat rows** get two retries each at the next ticks. Their error is
   the gateway's own answer-validation failure (`did not select a highest-probability
   option`: the model's chosen option is not the argmax of the probabilities it
   returned, and the SDK's check ignores the declared rounding). If they fail again,
   the root cause is in the provider's answer, not in us — the options are a rounding
   tolerance or dropping the `tone`/`topic` choice for those rows. **Step: WB, with the
   negotiation-profile rebuild that reads these labels.**
