# Giant Plan build — integration report

Branch: `build-2026-09-12-v2-integration`
Worktree: `/tmp/gridiron-worktrees-v2/integration`
Base: `main` @ `14c5e65`
Merged: 10 branches, one `--no-ff` merge each, in the order below, plus one migration-renumbering commit and one node_modules-untrack commit from earlier in this same integration session.

```
2e05b8b Merge fix-041-down-guard into integration
0011506 Integration: renumber cleanup/money-path migrations to 042/043
7e1ffae   (fix-041-down-guard's own tip — 041 down() guard + schema comment fix)
5652547 Merge build-2026-09-12-v2-a9-nfl-t60-packet-scoping into integration
fc507b3 Untrack node_modules symlink accidentally added by git add -A
7da93e7 Integration fix: renumber colliding migration 036 -> 037 (a6 only — superseded, see below)
a76be63 Merge build-2026-09-12-v2-a8-cleanup into integration
e8d64e7 Merge build-2026-09-12-v2-a7-data-integrity into integration
cc67ccf Merge build-2026-09-12-v2-a6-money-path into integration
3625c45 Merge build-2026-09-12-v2-a5-simulation into integration
d907ef6 Merge build-2026-09-12-v2-a4-fantasy-client into integration
b0eb4bf Merge build-2026-09-12-v2-a3-fantasy-decision-layer into integration
148f529 Merge build-2026-09-12-v2-a2-fantasy-p1 into integration
bbe2511 Merge build-2026-09-12-v2-a1-security into integration
```

29 commits ahead of `main`; **123 files changed, +4004/−886** (`git diff --stat main...HEAD`).

**Not merged into `main`/`current`. Not pushed. Live server (PID on :5177) and `server/data.sqlite` were never touched at any point in this session** — every test run below used a fresh, never-before-existing `GRIDIRON_DB_PATH` under `/tmp`.

---

## 0. A correction made before any of this report's own work

This integration worktree already existed when this session started, left mid-merge by an earlier pass: it had merged a1–a9 correctly, but was **mid-merge on `build-2026-09-12-v2-audit-consolidation`** (conflicts resolved, staged, uncommitted) — the branch the brief explicitly says *not* to merge (`fix-041-down-guard` supersedes it). It had also renumbered the 036 collision in the wrong direction: it kept `a8-cleanup` and `a6-money-path` at 036/037 and, mid-merge, was about to renumber the *pipeline's own* 036–041 chain up to 038–043 to make room — the opposite of the brief's explicit instruction (pipeline keeps 036–041; the two non-pipeline files move to 042/043).

Both were corrected before proceeding:
1. `git merge --abort` on the in-progress `audit-consolidation` merge.
2. New commit `0011506`: renumbered `a8-cleanup`'s `036_drop_dead_auction_tables.js` → `042_drop_dead_auction_tables.js` and `a6-money-path`'s (already-once-renumbered) `037_execution_opportunity_frozen_columns.js` → `043_execution_opportunity_frozen_columns.js`. Both migrations are tracked by their self-referential `name` export in `schema_migrations`, not filename position, so this is a pure rename; grepped the whole repo first and confirmed nothing else referenced either filename.
3. Merged `fix-041-down-guard` (not `audit-consolidation`) — see §3.

End state matches the brief exactly: pipeline's own `036_t60_packet_body.js` … `041_nfl_replay_run_spec.js` untouched, `042_drop_dead_auction_tables.js` (cleanup, no dependencies, goes first), `043_execution_opportunity_frozen_columns.js` (money-path). No two files share a number (`ls server/migrations | grep -oE '^[0-9]+' | sort | uniq -c` shows every prefix exactly once; pre-existing gap at 030 predates this work and is unrelated). Migration and full-suite tests re-run after the fix (§5) — clean.

---

## 1. What was built, by Giant Plan section

### 1.1 Section 5.1 — `a1-security` (commit `84f2497`)
- Untracked the stray `server/data.sqlite.pre-migration-*.bak-journal`; extended `.gitignore` for `-wal`/`-shm` variants of the same pattern.
- `server/db/seed/index.js`: `seedIfEmpty()` was overwriting every `nfl_teams` column and every `ranking_entries` rank/tier on **every server boot**, including the ones the app lets a user hand-edit live. Now: `nfl_teams` self-heals only its 5 non-editable identity columns; the 14 user-editable columns (coach names, scheme write-ups, etc.) are insert-once. `ranking_entries` is `INSERT OR IGNORE`.
  - **Disclosed deviation, reviewed and endorsed by this integration:** the plan text said "INSERT OR IGNORE for teams" (a blanket ignore); a literal reading breaks `test/model-registry-persistence.test.js`'s corrupted-name self-heal test. The column-scoped `DO UPDATE` actually implemented satisfies both the bug report and that still-desired self-heal. Verified: `test/model-registry-persistence.test.js` passes; two new regression tests confirm edited analysis and re-ranks now survive reseed.
- `server/index.js`: gated the 13 previously-unauthenticated route families (teams, rankings, espn, aggregates, analysis, nfldata, stats, accolades, edge, props, props-tickets, decision-inbox, wong) with the same `legacyAuthenticated` pattern already used elsewhere.
- `server/routes/leagues.js`: `GET /:id/data` no longer echoes `espn_s2`/`swid` (any league member could previously read the commissioner's ESPN session cookies).
- **Disclosed, no action needed:** the a1-security worktree's own author ran `md5` against the live 12 GB `server/data.sqlite` while sanity-checking they hadn't modified it — read-only, mtime/size unaffected, but technically "opens" a file Safety Rule 1 says never to open the contents of. Flagged by that worktree's own report; nothing further to do (file untouched, this integration session never touched it either).

### 1.2 Sections 4.1 + 3.4 — `a2-fantasy-p1` (commit `2ceefef`)
- `player-week-engine.js` `priorScores()`: week-1 (or any week before the current season has usage rows) now falls back to a season-recency-weighted average of prior seasons (`SEASON_WEIGHT`, now exported from `projections.js`) instead of reporting zero prior-week evidence for every player.
- `weekly-learning.js`: a true cold start (`engine.heads` null) used to be silently dropped from capture with no record. Now captured with every ensemble head degraded to the structural estimate, tagged `mode='cold_start_structural_only'` (new column), and `captureWeeklyPredictions` reports `skipped:false` instead of an ambiguous `'ok'`.
- `nfl-prop-clv.js` / `td-regression.js`: commit `129115e` silently broke every name-based join in both files when it abbreviated `projections.js`'s `name` field. Both now join through stable ids (`players.id` / `gsis_id`) instead of normalized display-name strings.

### 1.3 Sections 4.3 + 4.5 — `a3-fantasy-decision-layer` (commit `832399e`)
Ten independent fixes in one commit (dynasty curve provenance fields; lineup-brain's start/sit multiplier now ranks on `current_week_ppg` not the trade-horizon blend; a 10-minute `finalizeStaleDrafts` job so an abandoned ESPN-mirrored draft doesn't stay `active` forever; a phantom week-1 "1 game" floor removed from availability; the QBR nudge now folds into the sampler's own `params.ypa` instead of only the deterministic ppg; shrinkage-fit trains under production's live recency weights; a Doubtful/full-practice contingency conflict closed; durability's denominator now spans every season since debut, not just seasons with a logged game; `vacated_share` now reported for movers instead of silently null; `player-case.js`'s name-collision matching now checks full-name equality before falling back to initial+surname; `ceiling-lineup.js` now uses this season's own games mid-season instead of always falling back to last season; CFBD rookie-usage sync finally wired to a scheduler job after having zero callers).

### 1.4 `a4-fantasy-client` (commit `107ca5e`)
Client-only: ceiling-lineup tab and NflMarketBoard no longer hardcode week=1 for the whole season; sidebar "Matchups" now opens the DvP/head-to-head tab that already existed but was unlinked; FantasyLab's tab list gained Availability; LiveDraft's advice-to-board match is now id-based instead of a second name comparison that could mismatch or collide.

### 1.5 Section 6 — `a5-simulation` (commit `ac942aa`)
`nfl-sim-policy.js`: an away possession was reading the home line as its own spread in three decision functions — fixed by flipping to `posteam_spread` before comparing. `nfl-drive-sim.js`: turnovers now flip field position like punts/missed FGs already did; home-field advantage is now a small continuous per-drive nudge instead of a discrete end-of-game coin-flip; a real full-game clock now runs alongside the half clock; `timeoutPolicy`'s decision is now wired to an actual counter. `nfl-sim-learn.js`/`nfl-sim-calibration.js`/`nfl-live.js`: three smaller correctness fixes (no double net-40 punt transform, calibration divides by its own measured baseline not a hardcoded 27, live OT win probability no longer reports an exact 100/0).
- **Left as TODOs, per explicit instruction:** the kneel-rule sign/formula in `nfl-sim-policy.js` was **not** touched beyond the timeout-decrement wiring, per this session's own safety rule 7. gamescript's post-kickoff spread/total update was also left alone — it's tested, intentional behavior, not a bug.

### 1.6 `a6-money-path` (commit `44e40b7`, no single Giant Plan section number cited)
Teaser settlement now looks up the real final score instead of trusting a caller-supplied one; the real-money teaser/execution/decision-inbox routes gained `model:execute`/authenticated gates; `ProfitabilityControl` no longer defaults "reachable" to a price-prefilled true; `simultaneousQuotes()` now uses a bounded per-book capture window instead of exact-equality on one global max timestamp; `stakeFor()` is now an allow-list on `'execution'` instead of a deny-list on `'model'` (closes an unrecognized-source gap in the CLV-proof gate); `rankBooks()` excludes non-real prices before they can produce an infinite payout ratio; `lifecycleFunnel()` now sums settlement corrections instead of only the original settle event.
- **Open follow-up, disclosed by that branch, not fixed here:** `safeStakeFor()`'s `uncertaintyWidth` and `openBets`/`openPortfolioFraction` remain caller-supplied rather than server-computed from persisted evidence (unlike the calibration/forward-sample gates, which this commit did fix). Documented, not silently dropped.

### 1.7 Section 3 — `a7-data-integrity` (commit `a3e1841`)
Thirteen fixes: book-feeds/line-shopping now pass a real response-completion receipt clock (previously every free-book quote was quarantined as `legacy_request_time_only`); the T-60 packet's injury read (pre-pipeline-merge version) reports `publishedAt` not `receivedAt` for nflverse's publish clock; the archive-median opener backfill now writes a correctly-negated away-side spread per row instead of copying the home number to both sides; `nfl-ensemble.js` backtests against the real historical open line instead of a hardcoded NULL; shadow-ledger settlement grades against the frozen close (`COALESCE(closing_spread, spread)`) instead of the live, overwritable number, and no longer freezes a decision for an already-final/past-kickoff game; a placeholder-flagging script for copied 2025→2026 QBR rows; MLB pregame capture now skips games already past first pitch; the ScottFree feature-row filter now actually excludes outcome columns; live-edge Polymarket matching now requires both team names, not just the home team's; two audit scripts now return the snake_case fields `audit-registry.js` actually reads (previously every run sealed with `p_value`/`sample_size` null); the football-first route no longer blocks ~90s on a cold fit; the release-packaging script's database exclusion now matches by basename at any depth; **`npm test` itself now sets `GRIDIRON_DB_PATH` to a fresh scratch path, `SCHEDULER_DISABLED=1` and the offline-guard `NODE_OPTIONS`**, closing the gap where a bare `npm test` could previously open the real database.

### 1.8 Section 9(a)/(b) — `a8-cleanup` (commit `907e7ee`)
Retired one dead component (`PickReasoning.tsx`, zero importers); added the (now-renumbered) dead-table-drop migration for `auction_sales`/`auction_settings`; corrected several stale doc claims (schema "frozen" claim, a superseded "latest run" headline, a false claim about what `SCHEDULER_DISABLED` blocks).
- **Disclosed, self-corrected within the branch:** an attempt to archive 8 "zero-importer" service files was fully reverted after discovering all 8 are dynamically imported by their own test files — a scope the specified grep didn't cover. Full suite was confirmed green again after reverting.
- Tier-c items (live database, live process, applied migrations) correctly left untouched per that branch's own read of the safety rules.

### 1.9 G22/G23 — `a9-nfl-t60-packet-scoping` (commit `95e0a96`)
The T-60 packet's `nfl_news_events` query had **no WHERE clause at all** — every typed news event ever extracted, for every team and season, fed every game's packet; now scoped to the game's two teams plus a kickoff-anchored date window (nulls still pass — the table has no season/week column). The injuries query was scoped by season/week only, contrary to what G22 originally claimed — every other game's injury report for the same week leaked in; fixed with `team IN (?, ?)`. G23 (time-permitting): `t60-runner.js`'s capture predicate got the grace-window floor described in §2 below. G24 was investigated and found not to match the code as it stands (no caller feeds a T-60 cutoff through the verifier this item described) — correctly not implemented rather than guessed at.

### 1.10 The audit-consolidation pipeline, stages 1–6 + this session's stage 7 (`fix-041-down-guard`)
Full detail lives in `PIPELINE_REPORT.md` at the repo root (carried through the merge unchanged) — summarized here:

| Stage | Giant Plan | What |
|---|---|---|
| 1 | 8.10/8.1 | T-60 packet body retention + `nfl_clv_grades` table; `t60PacketHash` excludes wall-clock fields |
| 2 | G02/G03/G08 | Feeds `t60-runner.js`'s live capture into the append-only decision tape (`nfl_decision_runs`/`nfl_decision_events`) |
| 3 | 8.1 | One shared CLV convention (`clv-core.js`) replacing four independent copies; also turns on a previously-dead Polymarket team-matching path |
| 4 | 8.3/8.12 | Trial registry + per-finding candidate isolation; `audit-registry.js` preregistration-order fix for the Šidák correction |
| 5 | 8.9/8.11/8.14 | Blend-mode consolidation, freeze-scope fixes, `nfl-audit-overview.js` corrections (win-rate case-sensitivity, ROI denominator, season-coverage source), shared weekly bootstrap |
| 6 | 8.14 | This session's own: a downgrade guard on the decision tape itself (`027_decision_tape.js` `down()` refused the execution ledger but not its own tape), plus real bitemporal wiring for injuries (`nfl_feature_revisions` fed by `syncInjuries`, read by the T-60 packet) replacing a dishonest publish-clock-as-receipt-clock read |
| 7 | — | **This integration's designated stage-7 branch (`fix-041-down-guard`).** `041_nfl_replay_run_spec.js`'s `down()` had no existence guard (its `up()` does), so any migration-only test fixture rolling back through 041 threw a raw SQLite error. Fixing it surfaced a more serious bug: a comma-bearing SQL comment sitting directly above `nfl_replay_runs`' `spec_json`/`spec_hash` columns in the schema module corrupted SQLite's own `ALTER TABLE ... DROP COLUMN` schema rewrite on **every** rollback attempt, real installations included, not just fixtures. Moved the documentation into a plain JS comment (never persisted to `sqlite_master`) instead. |

**Rollout note carried forward from stage 6, still applicable:** historical `nfl_injuries` rows written before this code deploys have no corresponding bitemporal revision, so they read as `missing` rather than the old (dishonest) `publishedAt`-based claim until the next scheduled `refreshNflInjuries` run (max 6-hourly on the `'live'` tier). **Recommend triggering one manual `syncInjuries` run for the current week after merging**, since live 2026 games are being captured on this system right now — see `PIPELINE_REPORT.md` §1.3.

---

## 2. Three merge conflicts, all in code `a9-nfl-t60-packet-scoping` and the pipeline branch both touched independently

### 2.1 `server/betting/nfl/strategy/t60-runner.js` — duplicate fix, low risk
Both sides independently added the identical grace-window floor to `captureDueObservations`/`runT60Pass` (G23 and pipeline-stage-6-adjacent work landed on the same idea at the same time). Resolved in favor of the pipeline's version, which threads the already-shared `CAPTURE_GRACE_MINUTES` constant consistently (a9's version hardcoded the same value, `10`, inline) — same runtime behavior, less future drift risk. **Ready to merge, high confidence.**

### 2.2 `server/services/nfl-t60-packet.js` — two real, non-duplicate fixes to the same block; combined, needs review
- a9/G22 fixed a cross-game leak in the **old** `nfl_injuries.modified_at` read by adding `team IN (?, ?)`.
- Pipeline stage 6 **replaced that same read entirely** with a query against `nfl_feature_revisions` for an honest receipt clock — but `nfl_feature_revisions.entity` (`player:<gsisId>:<season>:<week>`, see `nfl-advanced.js:394`) carries no team, so the replacement re-introduced the identical cross-game leak against the new table.

**Resolution implemented (file: `server/services/nfl-t60-packet.js`, the injuries block just after the quote-tape `entries.push`, ~line 303–350 post-merge):** kept the bitemporal read, added a `LEFT JOIN nfl_injuries` back onto it (matching `gsis_id`/`season`/`week` extracted from the revision's own entity string) purely to recover `team` for the `IN (?, ?)` filter — `nfl_injuries` is still written in the same transaction as every real revision (`nfl-advanced.js`'s batch loop runs `stmt.run(...b)` unconditionally), so this is safe in production. A revision with no matching `nfl_injuries` row (only possible for a test that calls `recordRevision` directly, bypassing `syncInjuries`) still passes rather than being silently dropped — the same permissive rule G22 already applied to `nfl_news_events`' nullable team.

**Needs Nick's review before trusting this in production, despite passing tests:** this LEFT JOIN was synthesized during this merge to reconcile two independently-correct fixes; it is not something either branch's own author wrote or tested directly, and **no test in the repo exercises team-scoping of this specific bitemporal path** (the pipeline's own `test/nfl-t60-packet.test.js` tests only ever `recordRevision` for the single game under test, so a cross-game leak here would not currently be caught by any existing assertion). The join logic itself is simple and I'm confident it's correct by inspection and by the full suite passing, but it is the single highest-synthesis-risk line in this entire merge — worth a specific look, and ideally a dedicated regression test (insert a second team's injury revision for the same season/week and assert it does not appear in this game's packet) before this ships to the live capture path.

### 2.3 `server/services/shadow-ledger.js` — two real, complementary fixes; combined, low risk
- `a7-data-integrity` changed which closing-line **value** feeds shadow CLV: `closing_spread ?? spread` (the frozen true close) instead of the live, overwritable `spread` column.
- Pipeline stage 3 changed how that CLV is **signed**: `signedClvPoints()` from the new `clv-core.js`, shared with the other three ledgers, instead of a fourth local copy of the same ternary.

These compose cleanly with no tension: `closeSpread`'s value now feeds `signedClvPoints()`. Both intents kept exactly. **Ready to merge, high confidence** — same formula `signedClvPoints` already uses for the other three ledgers (`ourLine - closeLine` for spread), verified in `clv-core.js`.

---

## 3. Full-suite result on the fully-merged branch

```
GRIDIRON_DB_PATH=<fresh /tmp path>  SCHEDULER_DISABLED=1  NODE_OPTIONS='--import ./test/offline-guard.mjs'
node --experimental-test-module-mocks --test --test-concurrency=1 test/*.test.js   (= npm test)

tests    1703
pass     1663
fail     1
skipped  39   (documented: require real multi-season history in nfl_player_week_features
              /nfl_team_week_features; these intentionally refuse a synthetic fixture)
duration 104.3s
```

**The 1 failure** — `test/nfl-execution-pipeline.test.js:62`, `resolveQuoteBasis: prefers the real multi-book quote tape...` (`actual: undefined`, `expected: 'quote_tape'`) — is the same pre-existing, date-boundary-sensitive failure independently confirmed by **five separate branches' own reports** (a1-security, a2-fantasy-p1, a3, a6, a7, and the pipeline's own stage 6) as present on unmodified `main`/each stage's own base commit, unrelated to any change in this integration. Re-confirmed here in isolation against the fully-merged tree; it reproduces identically. Not fixed by this integration (out of scope for every branch that touched it).

`npm run typecheck` — clean, no output.
`npm run lint` — clean, "Syntax checked 611 JavaScript files."

Also independently re-ran the specific tests touching this session's own conflict resolutions and the renumbered migrations (`migration-027-populated-upgrade`, `nfl-t60-packet`, `t60-runner`, `shadow-ledger-kickoff-guard`, `nfl-execution-clv`, `forward-ledger`, `nfl-injuries-bitemporal`, `nfl-replay-graph`, `model-registry-persistence`, `audit-overview-counting`, `nfl-blind-audit-team-scope`, `nfl-moneyline-domain`, `paired-bootstrap-clustering`, `nfl-decision-tape`, `nfl-execution-pipeline`, `nfl-execution-integrity`, `nfl-decision-identity-pipeline`, `evidence-provenance`, `polymarket-lines`, `seed-idempotence`, `local-auth`, `legacy-route-security`) as a standalone batch: 225/226 pass, only the same known failure above.

Diff-level sanity scan across the full `main...HEAD` diff: no `.skip(`/`.only(` left in any test file, no new hardcoded secrets/API keys, no stray `console.log` added to `server/`/`client/`. The only "TODO" strings introduced are the ones each branch explicitly documented as deliberate follow-up (CLV `forward_picks`/`shadow_decisions` wiring, `p_always_valid`/`p_fixed_sample_only`, the freezeT60Packet architecture note) — none are silent scope-cuts.

---

## 4. Ready to merge to `main` — high confidence

- **`a1-security`** — all 4 items, including the disclosed seed-reconciliation deviation (reviewed above and endorsed: it's the more correct fix, not a shortcut).
- **`a2-fantasy-p1`** — all 3 items; well-covered by `model-integrity.test.js` and the two prop/TD-specific suites.
- **`a3-fantasy-decision-layer`** — all 10 items; each independently scoped and tested, no cross-item interaction risk.
- **`a4-fantasy-client`** — client-only navigation/state fixes, no data-model risk.
- **`a5-simulation`** — all fixes except the two explicitly-left TODOs (kneel-rule formula untouched per instruction; gamescript guard correctly left alone as intentional behavior).
- **`a7-data-integrity`** (all 13 items) and **`a8-cleanup`** (all completed items; the reverted archive attempt left zero trace).
- **`a9-nfl-t60-packet-scoping`**'s news-events scoping and the merged grace-window fix (§2.1).
- **Pipeline stages 1, 4, 6, and 7** (this session's `041` down-guard + schema-comment fix) — each independently high-confidence per `PIPELINE_REPORT.md`'s own stage-by-stage assessment and this session's full-suite re-verification.
- **The merged shadow-ledger CLV fix** (§2.3).
- **The migration renumbering** (§0) — mechanical rename, tracked by name not position, re-verified by the full suite.

## 5. Needs Nick's review before trusting in production (tests pass; still worth a human look)

Specific, file:line, as requested — especially the two named as architecturally significant:

1. **`server/services/nfl-t60-packet.js`, the injuries block (~line 303–350 post-merge)** — the LEFT JOIN synthesized in this merge to reconcile G22's team-scoping fix with the pipeline's bitemporal-receipt-clock rework. See §2.2 in full. No existing test exercises cross-game team-scoping of this specific path. **Highest-priority review item in this entire integration** — it sits directly on the live capture path (`t60-runner.js` → `freezeT60Packet` → this block) for games being captured this week.

2. **Pipeline stage 3 — CLV consolidation, `server/services/polymarket-lines.js`'s ESPN-event lookup** (per `PIPELINE_REPORT.md` §5, stage 3): not pure refactoring. Team-name matching changed from raw string comparison (which the commit says "essentially never matched") to `teamCodeFor()` resolution on both sides — a previously-dead code path now actually flows data into whatever consumes `refreshPolymarketLineWatch()`'s output. Very likely the intended fix, but "a feed that never worked now works" deserves a specific look at what's downstream before trusting its numbers live, independent of trusting the CLV-math consolidation itself (which *is* pure refactoring — four already-numerically-agreeing implementations merged into `clv-core.js`).

3. **Pipeline stage 2 — tape-routing, `server/betting/nfl/strategy/t60-runner.js`'s decision-tape write path** (per `PIPELINE_REPORT.md` §5, stage 2): wires the live capture path to actually write `nfl_decision_runs`/`nfl_decision_events` on every observation, plus the capture grace-window boundary now shared with `markMissedObservations`. All named tests pass, but this is a change to the write path of a system capturing real live games right now — a subtle timing/grace-window edge case would show up as a gap or duplicate in the live tape for an actual NFL week, not in a fixture. The pipeline's own report recommends watching one real capture cycle land correctly; this integration did not (and could not, per Safety Rule 2) run that live observation.

4. **Pipeline stage 5 — `server/services/nfl-audit-overview.js`** (per `PIPELINE_REPORT.md` §5, stage 5): win-rate case-sensitivity, ROI denominator, and season-coverage-source corrections. These are real fixes, but they change what past audit-overview reports show — anyone who screenshotted or cited the old (wrong) numbers will see different ones after this merges. Not a code-risk item; a communication one.

5. **Bitemporal injuries rollout gap** (pipeline stage 6, `PIPELINE_REPORT.md` §1.3): historical `nfl_injuries` rows predate the new revision store and read as `missing` until the next sync. Recommend a manual `syncInjuries` trigger right after merging, given live capture is in progress.

6. **`server/services/nfl-execution-edge.js`'s `safeStakeFor()`** (a6-money-path, disclosed): `uncertaintyWidth` and `openBets`/`openPortfolioFraction` remain caller-supplied rather than server-computed, unlike the calibration/forward-sample gates this branch did fix. Documented follow-up, not a regression, but still an open gap in the money-path's input trust boundary.

7. **The pre-existing, still-unfixed `test/nfl-execution-pipeline.test.js:62` failure** — confirmed unrelated to this integration by six independent sources now (see §3), but it has never actually been fixed by anyone; worth someone finally tracking down the real date-boundary bug in `resolveQuoteBasis` rather than continuing to wave it through as "known."

---

## Files changed (this integration session's own commits, not counting the 10 merged branches' own diffs)

- `server/migrations/042_drop_dead_auction_tables.js`, `043_execution_opportunity_frozen_columns.js` — renamed/renumbered, `name` export updated to match (commit `0011506`).
- `server/betting/nfl/strategy/t60-runner.js`, `server/services/nfl-t60-packet.js`, `server/services/shadow-ledger.js` — the three merge-conflict resolutions in commit `2e05b8b`, detailed in §2.
- `GIANT_PLAN_BUILD_REPORT.md` — this file.
- `.gitignore` — added a non-trailing-slash `node_modules` line: the existing `node_modules/` pattern doesn't match a worktree's *symlinked* `node_modules` (this exact gap already produced commit `fc507b3` in this branch's own history), so this closes it for good.
