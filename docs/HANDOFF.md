# Gridiron HQ — engineering handoff

Written 2026-08-26. Everything below was verified against the code and the live
database at that date, not recalled. Where something is uncertain it says so.

Branch: `phase3-live-draft-reliability` (off `origin/main` @ `9abacd6`).
4 commits, **not pushed**. `npm test` = 177 passing, `npm run typecheck` clean.

---

## 0. Read this before touching anything

### The single most important fact
**A large amount of what the roadmap calls "Phase 4" and "Phase 5" is already
built on `main`.** Do not rebuild it. Verify and extend it. Specifically:

| Roadmap item | Actual state on `main` |
|---|---|
| Phase 4 projection engine | `server/services/projections.js` — `buildProjections`, `sampleWeek`, `weeklyDistribution`, `seasonDistribution` |
| Phase 4 accuracy measurement | `server/services/backtest.js` — `gradePoint`, `crps`, `gradeDistribution`, `baselines`, `compare`, `weeklyDecisionBacktest` |
| Phase 5 model registry | `server/routes/model.js` — datasets / features / experiments / backtests / sealed holdout / promote / rollback, all permissioned |
| Phase 5 walk-forward + leakage guards | `nfl-experiments.js`, `model-governance.js`, and tests in `test/model-registry-persistence.test.js` |
| Phase 3.5 "land the CLV code" | **Already on main**: `nfl-clv.js`, `nfl-sharp.js` |

Before starting any phase, run `ls server/services/` and grep for the thing you
are about to write. The service layer is ~55 files and most roadmap nouns
already have one.

### Conventions that will bite you
1. **Isolated DB in tests.** Set `process.env.GRIDIRON_DB_PATH` to a temp file
   *before* the first `await import('../server/db/index.js')`. Every existing
   test does this. Getting it wrong writes to the user's real league data.
2. **Schema is created at import time, scattered across ~40 files.** Tables you
   need may not exist until you import the module that creates them. Examples:
   `app_settings` comes from `services/claude.js`; `drafts.espn_league_id` and
   `draft_picks.espn_team_id` come from `services/espn-draft.js`. If a test dies
   with "no such table/column", import the owning module for its side effect.
   There is a real `migrate(name, fn)` helper in `db/index.js` + numbered files
   in `server/migrations/` — **use that for new schema**, not import-time DDL.
3. **`seedIfEmpty()` runs on every boot** (`server/index.js:38`) despite the
   name. It is a reconciler, not a first-run guard. Anything it does, it does
   every single boot.
4. **Foreign keys ARE enforced.** `node:sqlite` `DatabaseSync` enables them by
   default. The comment in `db/index.js` saying `PRAGMA foreign_keys = ON is NOT
   enabled here` is **stale and wrong** — the pragma reads `1`. Don't rely on
   that comment.
5. **Never judge a betting model change by backtested win rate.** See §4.

---

## 1. What I changed (4 commits)

1. **`Phase 3B: transactional live-draft reconciliation engine`**
   New `server/services/draft-reconcile.js`. One-transaction reconciliation of
   an ESPN snapshot vs local state; quarantine table for unresolvable
   players/teams; audit trail for every applied correction. Idempotent replay.
   Wired into `espn-draft.js`. Also fixed: `resolveEspnPlayers` fabricated
   position `'WR'` for unidentifiable players; `next_pick` came from the local
   mirrored count instead of ESPN's authoritative count.

2. **`Phase 3A: never guess the user's draft slot`**
   `ensureLiveDraft` used `Math.max(1, indexOf(...) + 1)`, silently turning
   "user's team not in pick order" into "slot 1". Now `my_slot` is NULL with
   `my_slot_confirmed = 0`, plus `POST /api/drafts/:id/confirm-slot`.

3. **`Make ESPN connection actually work, and work for other clones`**
   Two independent root causes, both fixed:
   - The minifier stripped `//` anywhere, including inside `http://…`, so the
     emitted bookmarklet was `fetch('http:` — **invalid JS, could never run**.
   - **Zero CORS headers**, so the browser rejected the cross-origin post before
     Express saw it. Now scoped to espn.com origins incl.
     `Access-Control-Allow-Private-Network`.
   Plus: bookmarklet origin is derived from the request (was hardcoded
   `localhost:5177`); credentials validated against ESPN *before* persisting;
   connecting account B no longer overwrites account A's league credentials.

4. **`Stop the seed from duplicating players on every boot`**
   New `server/services/player-identity.js`. See §3.1 — this one matters.

---

## 2. Finish this first (in progress, not committed)

### `DELETE /api/leagues/:id` silently orphans drafts
`server/routes/leagues.js:35` is a bare `DELETE FROM leagues WHERE id = ?`.

Verified in an isolated DB: the delete **succeeds and leaves orphaned drafts**
pointing at a league row that no longer exists. It does not error, and nothing
tells the user their draft history just became unreachable.

Why it doesn't hit a FK error: `migrations/006` declares
`league_row_id INTEGER REFERENCES leagues(id)`, but `services/espn-draft.js:30`
adds the same column as a plain `INTEGER` with no REFERENCES at import time —
and on a database where the import-time DDL ran first, that is the definition
that sticks. `PRAGMA foreign_key_list(drafts)` on such a DB shows only the
`ranking_sets` FK.

Live data as of writing: leagues 1, 3 and 4 have drafts; **330 draft picks** sit
under league-bound drafts.

**What to do** (matches the Phase 3 spec §8, "safe removal"):
- Make deletion explain what will be removed vs retained, and require
  confirmation.
- Default to *disconnecting* (clear `espn_s2`/`swid`, mark needs-reconnect) and
  keep the league row + draft history, rather than a hard delete.
- If a hard delete is genuinely wanted, either re-point or explicitly delete the
  dependent drafts in one transaction — never leave orphans.
- Reconcile the two conflicting definitions of `drafts.league_row_id` so the FK
  is actually declared. This needs a migration, and needs care on existing DBs.
- Test both: delete-with-drafts and delete-without.

---

## 3. Remaining loose ends

### 3.1 Existing duplicate players (data repair — NOT done)
My commit 4 stops *new* duplicates. The existing ones are still there.

Measured on the live DB: **64 duplicate groups** across 1036 players, and picks
for the same human split across two ids — `Ja'Marr Chase` had 16 picks over 2
rows, `D'Andre Swift` 12 over 2, `David Njoku` 11 over 2.

They split into two kinds, and **only one is safe to merge**:
- **11 groups**: one row is an orphan seed row (`espn_id IS NULL`,
  `fantasy_relevant = 0`) shadowing the real synced row. Safe to merge.
- **53 groups**: every row has a *distinct* `espn_id`. These may be genuinely
  different people (the NFL really does have same-name players) or ESPN
  duplicates. **Do not auto-merge these.** Needs a per-case judgment, ideally
  surfaced in Dev Hub for a human to confirm.

Build the merge as **dry-run first**, printing exactly what it would do.
Watch out: `draft_picks` has `UNIQUE(draft_id, player_id)` — if both rows appear
in the *same* draft, a naive re-point collides. Decide that case explicitly.

### 3.2 The bearer-token sign-in confuses new clones
`/api/leagues`, `/api/news`, `/api/dev` etc. sit behind `legacyAuthenticated`
and return 401 until you paste a token into the "Application sign-in" box on
Settings. Someone cloning the repo hits a wall of 401s with no explanation.
Either document it in the README's setup steps or make first-run provisioning
automatic for a local single-user install.

### 3.3 Phase 3C / 3D (paused by the user, resume later)
- **3C**: adaptive polling with capped backoff + jitter, pause on hidden tab,
  full reconcile on tab-visible, credential-expiry → single reconnect notice →
  auto-reconcile on success, restart recovery.
- **3D**: the Live Draft UI (10 states, 7 controls, keyboard + screen reader),
  safe diagnostics panel, ~35 more of the 56 spec test scenarios, and the
  long-running simulated-draft certification harness.
The reconciliation engine 3C/3D sit on is done and tested, so 3C is mostly
wiring.

---

## 4. Phase 3.5 — NFL betting hub

### Read `docs/NFL_MODEL_STATUS.md` before writing a line of code.

**Do not try to make sides/totals profitable. It has been tested to death and
the answer is no.** From that doc, measured on 798 bets over 5 seasons:

- Model margin RMSE **13.14** vs market **12.66** — the market wins in *all five
  seasons individually*.
- `corr(model edge, ATS outcome) = −0.005` over 1,424 games. That is zero.
- A 15-specialist meta-model scored out-of-sample R² **−0.0167** against a
  shuffled-null of **−0.0171** — statistically identical to random.
- Adding governance (abstention, residual weighting) cut 798 bets to 203. The
  remaining bets still lost: **47.0%, −19.7 units.** "Better engineering reduces
  volume. It does not manufacture edge."

If you are asked to make it profitable, the honest answer is that the evidence
says you cannot, and a model that *looks* profitable after more tuning is
overfitting. Say so; do not ship a number you cannot defend out-of-sample.

**Method rule (non-negotiable):** never judge a change by backtested win rate.
Use out-of-sample R² against the market residual, plus a permutation-null
comparison. The repo's old `maxDisagreement = 4.5` filter was "holdout
validated" and is still noise.

### What is actually worth building

1. **Sharp-money / CLV surface.** `nfl-sharp.js` and `nfl-clv.js` are already on
   `main` — this is *not* a rebase job. What's missing is the UI in
   `routes/betting-hub.js` + a client page. Show the CLV ledger and the
   divergence board. Every claim must be falsifiable against the ledger.
   Known detail worth preserving: Pinnacle lives in the `eu` odds region, not
   `us`; querying `us,eu` surfaced 19 stale recreational lines across 272 games.

2. **Player props — the one genuinely open lead.** `nfl-props.js` exists.
   Results exist (52,231 player-weeks, 2016-25). The blocker is calibration:
   passing yards MAE **70.4** on a ~240 mean, and the TD model over-predicts by
   **10-13 points** mid-range. Both errors are *monotonic*, which is exactly the
   shape walk-forward recalibration fixes. Do that, then validate out-of-sample
   against the permutation null. **Do not surface a prop as a recommendation
   until it clears that bar** — show calibration and uncertainty, not a bare
   number.

3. **Staking stays flat, 1u = 1% of bankroll.** Kelly only beats flat above
   ~55% win rate, which has not been demonstrated here.

4. If recalibration does not clear the bar, **say so plainly in the UI and the
   report**. An unvalidated number presented as a recommendation is the failure
   mode to avoid.

`ODDS_API_KEY` must be set in `.env` for live odds. It is currently unset.

---

## 5. Phase 4 — fantasy prediction engine

### Start by measuring what's already there
`buildProjections()` in `services/projections.js` already does volume ×
efficiency with regression, availability modelling and distributions.
`backtest.js` already computes MAE / R² / Spearman / CRPS / interval coverage
against baselines.

**First task is not to write a model. It is to run the existing backtest and
publish the current numbers**, so every later change has a baseline to beat.
Wire `GET /api/model/accuracy` (exists) into a page that states, per position:
MAE, R², Spearman, CRPS, 80% interval coverage, and the same for the naive
baselines — with the season held out and the training cutoff shown.

### Rules that must hold (these are correctness, not preferences)
- **Compare on an identical player set.** Differing sets previously made the
  model look *worse* than baseline on Spearman when it wasn't.
- **Availability is the highest-leverage term.** Model it as share of *team*
  games played, not average of games appeared in, or backup QBs project as
  starters. QBs additionally need an attempt-share cap (winner-take-all).
- **Distributions need parameter uncertainty**, not just outcome noise. Without
  a log-normal level draw + beta-binomial games, an "80% interval" empirically
  covered only ~33%.
- **Nothing published after the prediction cutoff may enter a prediction.**
  There are existing leakage guards (`nfl-experiments.js`, and tests asserting
  "features cannot see beyond the predicted week") — extend them, don't bypass.
- **Do not promote a complex model that doesn't beat a simple baseline
  out-of-sample.** The registry already enforces promotion gates; use them.

### Known-good measured baseline (2025 held out, build through 2024)
Model MAE **42.9** / R² **0.587** / Spearman **0.776**, vs "last season points"
**47.0** / **0.447** / **0.754**. CRPS **32.3**, 80% coverage **0.71**.
If your changes don't beat those on the same player set, they are not
improvements.

### Sequence I'd follow
1. Publish current accuracy (above) — baseline first, no code changes.
2. Per-position error decomposition (by week, usage class, injury status) to
   find where the model is actually weak, instead of guessing.
3. Fix the largest measured gap. Re-measure with the permutation null.
4. Only then extend to the roadmap's wider variable list (snap share, routes,
   air yards, red-zone) — `nfl-features.js` and `nflverse.js` already ingest
   much of this; check before adding sources.
5. Surface projections with confidence, drivers, freshness and model version.
   Keep model-generated evidence visually separate from LLM commentary.

### Gotchas recorded from earlier work
- `nflverse.js` needs its own RFC-4180 CSV parser — naive comma splitting breaks
  because headshot URLs are quoted and contain commas.
- Join nflverse to local players on `espn_id`, **not name** (and now you have
  `player-identity.js` for the cases where you must fall back to a name).
- `POST /api/stats/sync` populates `player_season_stats`, and `refresh-all` does
  **not** call it. `syncGameLogs` picks targets by ordering on projected points,
  so without it the gamelog sync silently no-ops.
- Season sim brackets must **re-seed high-vs-low each round** and simulate NFL
  weeks 15-17, or byes decide the title. Invariants: title odds sum to 1.0,
  finals to 2.0, playoff to `playoffTeamCount`.
- `ANTHROPIC_API_KEY` must be set for any LLM-backed analysis.

---

## 6. Testing expectations

Every change above lands with tests in `test/*.test.js` run by
`node --test --test-concurrency=1`. Two habits that caught real bugs here and
are worth keeping:

- **Assert the artifact, not the intent.** Parsing the emitted bookmarklet with
  `new Function(...)` is what caught that it had never been valid JavaScript.
- **Prove the test catches the bug.** Revert the fix, watch the test fail,
  restore it. I did this for the seed-duplication regression (2 of 3 tests fail
  without the fix) and it is the only reason I can claim that fix works.
