# Audit-consolidation pipeline — final report (Stage 6 of 6)

Branch: `build-2026-09-12-v2-audit-consolidation`
Worktree: `/tmp/gridiron-worktrees-v2/audit-consolidation`
Base: `main` @ `14c5e65`
Stages 1–5 commits (verified present before this stage started):

| Stage | Commit | Subject |
|---|---|---|
| 1 | `af14948` | T-60 packet body retention + CLV grades table (8.10/8.1) |
| 2 | `241ef58` | Feed the frozen-packet decision tape (G02/G03/G08) |
| 3 | `938da92` | One shared CLV convention, safe subset (8.1) |
| 4 | `53c408e` | Trial registry + candidate-findings isolation (8.3/8.12) |
| 5 | `8d2ac3b` | Blend-mode consolidation, freeze-scope fixes, audit-overview corrections, shared weekly bootstrap (8.9/8.11/8.14) |
| 6 | *(this stage)* | Decision-tape downgrade guard + bitemporal injury wiring (8.14) |

Stages 1–5 together touch 37 files vs `main` (+1656/−207 lines, per `git diff --stat main...HEAD` before this stage's own commit).

---

## 1. What Stage 6 implemented

### 1.1 `server/migrations/027_decision_tape.js` — downgrade guard on the tape itself

`down()` already refused to downgrade the execution ledger (`nfl_execution_opportunities` / `nfl_execution_lifecycle_events`) while it held terminal states 023's schema can't represent. But the function's own tape — `nfl_decision_runs` / `nfl_decision_events`, the append-only evidence 027 exists to create — was dropped unconditionally at the bottom of the same function, with no equivalent check. A rollback on any database that had actually recorded a decision run would silently delete that evidence.

Added: a row-count guard (`nfl_decision_runs` and `nfl_decision_events`, each checked for table existence first so it also behaves on a database that never got this far) that throws and names the count on either table being non-empty, pointing at the pre-migration snapshot instead — the same remediation the neighboring execution-ledger guards already point to. An empty tape (fresh install, or a database where the feature was never used) still rolls back exactly as before.

Tests added in `test/migration-027-populated-upgrade.test.js` (both call `down()` directly against a fixture built only through 027, for a reason explained in §3 below):
- a populated tape refuses the downgrade and names both counts;
- an untouched tape still drops cleanly, and the tables are actually gone afterward (not just left in place by an early return).

### 1.2 Bitemporal wiring for injuries (`nfl-bitemporal.js` fed, `nfl-t60-packet.js` reads it)

`nfl_feature_revisions` existed (schema + `nfl-bitemporal.js`'s `recordRevision`/`valueAsKnown`/`revisionHistory`/`revisionCoverage`) but had exactly zero real callers before this stage — only its own unit test (`test/evidence-dataset.test.js`) ever wrote to it.

**`server/services/nfl-advanced.js`: `syncInjuries`.** `nfl_injuries` UPSERTs a player-week's report in place (`ON CONFLICT ... DO UPDATE`), so a Wednesday "full participation" that becomes a Friday "questionable" leaves no trace once Friday's sync runs — the exact gap `nfl-bitemporal.js`'s own header describes. `syncInjuries` now:
- compares each incoming row against what's already stored, and calls `recordRevision` only when `report_status`/`practice_status`/`injury` are new or have changed — an unchanged re-sync (the common case; this runs every 6 hours on the `'live'` scheduler tier) must not manufacture a second observation of a fact the source never restated;
- uses one capture instant (`observedAt`) per HTTP fetch, matching `nfl_quote_batches`' own one-receipt-per-batch convention;
- derives `publishedAt` from the source's own `date_modified` when present, falling back to `observedAt` (an honest lower bound, not a claim) when it's absent — real 2025 rows carry none, the audit's own finding;
- tags `provenance` as `'captured'` only when the source's claimed modification time is within a 10-day window of our own observation, `'reconstructed'` otherwise (including every case where `date_modified` was missing) — a report the source says it changed 40 days before we saw it, or that we can't clock at all, was not received live;
- catches `recordRevision`'s own refusals per-row (e.g. a malformed future-dated `date_modified`) so one bad row can't abort the whole season's sync — `nfl_injuries` still gets written either way, and the failure is surfaced in the return value (`revision_failures`).

`nfl_injuries` is still written on every sync and remains the correct place to ask "what does the report say right now." It is no longer the evidence.

**`server/services/nfl-t60-packet.js`: the injury evidence read.** The block used `nfl_injuries.modified_at` as if it were this system's receipt clock. It isn't — it's the *source's* claim about when a report changed, and treating it as `receivedAt` is exactly the "published_at masquerading as observed_at" leak `nfl-bitemporal.js` exists to close; it's also why the audit could find 2025 rows with no clock at all (`nfl_injuries` itself never recorded when *this system* saw a value). The block now queries `nfl_feature_revisions` for `feature = 'injury_report'` scoped to the game's season/week, and uses `observed_at <= cutoff` for the as-of check. A revision's `observed_at` is always populated (this machine chose it), so the old "quarantined, no clock at all" case (`availability_unknown`) becomes structurally unreachable for injuries going forward — a real simplification, not a regression: what used to be an unclockable row is now either genuinely `received_by_cutoff` or `late_arrival_excluded`.

Tests updated/added in `test/nfl-t60-packet.test.js`:
- the old "quarantined, no receipt clock" test (which inserted straight into `nfl_injuries`) is replaced with one asserting that a **legacy** `nfl_injuries` row with no revision is now `missing`, not quarantined — this is the rollout-gap regression guard described in §2;
- a new happy-path test: a revision observed by the cutoff is `received_by_cutoff` and eligible;
- **INJECTION 1** (Section 6.3's own adversarial acceptance test — "tomorrow's injury status cannot enter today's packet") is rewired to insert a revision *observed after* the cutoff instead of an `nfl_injuries` row *modified after* the cutoff, preserving the exact audit requirement under the new data model;
- the "nothing by the cutoff" test's reason-string assertion was updated to match the new message.

New dedicated file `test/nfl-injuries-bitemporal.test.js` (6 tests, fetch mocked — `syncInjuries` pulls a real nflverse CSV and the suite runs under `test/offline-guard.mjs`, which throws on any non-local request): a genuine change appends a revision without losing the earlier one; an unchanged re-sync records nothing; a brand-new player-week is a revision too; a missing `date_modified` is always `reconstructed`; the captured/reconstructed window boundary; one bad row's revision failure doesn't drop it from `nfl_injuries` or abort the season.

### 1.3 Known, deliberate rollout consequence — read before merging

Historical `nfl_injuries` rows written **before** this stage's code runs have no corresponding revision, and are now invisible to `freezeT60Packet`'s injury evidence check (reported `missing` where they previously reported something, however weak). This is real and immediate: `t60-runner.js` calls `freezeT60Packet` as part of the actual live capture path (`scheduler.js` → `runT60Pass` → `freezeT60Packet`), and the safety brief for this session says a live process is capturing real 2026 games against the real database right now.

It is **bounded, not indefinite**: `nfl_injuries` sync (`refreshNflInjuries`) is already registered on the scheduler's `'live'` tier with `maxAgeMinutes: 360` (`server/services/scheduler.js:954`) — i.e. it already runs at least every 6 hours against the real database. The first scheduled run after this code deploys will populate real revisions for the live week, and the gap closes on its own within that window. No fallback to the old `modified_at` read was added to soften this — the two reads are answering genuinely different, and the old one was the dishonest one (see §1.2). **Recommendation: after merging, trigger one manual `syncInjuries` run for the current season rather than waiting out the full 6-hour window**, since Week-1/2 decisions are being captured on a live clock right now.

---

## 2. Full test suite (this stage's own requirement — step 3)

Command, exactly as CI runs it (`.github/workflows/ci.yml`):
```
GRIDIRON_DB_PATH=<fresh, nonexistent path>  SCHEDULER_DISABLED=1  NODE_OPTIONS='--import ./test/offline-guard.mjs'  npm test
```

```
tests 1674
pass  1631
fail  4
skipped 39   (documented: require real multi-season history in
              nfl_player_week_features/nfl_team_week_features; these
              intentionally refuse to run against a synthetic fixture)
duration 194.7s
```

`npm run typecheck` — clean (`tsc --noEmit`, no output).
`npm run lint` — clean ("Syntax checked 604 JavaScript files").

### The 4 failures, individually confirmed pre-existing and unrelated to Stage 6

I diffed each failure against the Stage-5 commit (`git stash` back to `8d2ac3b`, re-ran the exact same test file) before writing any of this stage's own code, and again with only this stage's changes stashed, to be sure none of it is something I introduced:

1–3. **`test/migration-027-populated-upgrade.test.js` (2 tests) + `test/model-registry-persistence.test.js` (1 test)** — all three fail with the identical error, from the identical migration, unrelated to the one this stage edited:
   ```
   error in table nfl_replay_runs after drop column: incomplete input
     at Module.down (server/migrations/041_nfl_replay_run_spec.js:53:6)
   ```
   **Root cause, and why it's new since Stage 5:** `041_nfl_replay_run_spec.js` (Stage 5's own migration — "blend-mode consolidation") has an asymmetric `up()`/`down()`: `up()` checks `if (!columns(db,'nfl_replay_runs').length) return;` before touching anything (a fresh install creates the table, with these columns already present, via the schema module directly — not through this migration), but `down()` unconditionally runs `ALTER TABLE nfl_replay_runs DROP COLUMN ...` with no such guard. Any test fixture built by replaying `server/migrations/*.js` in isolation (rather than taking the schema-bootstrap path a real fresh install always takes) never creates `nfl_replay_runs` at all, so `down()`'s `ALTER TABLE` targets a table that was never created and SQLite's column-drop rebuild fails on it. **Confirmed present, unmodified, on the Stage 5 commit itself** — this is not something Stage 6 introduced; it's a defect Stage 6's *first full-suite run of the whole pipeline* is what surfaced it (each earlier stage ran its own scoped test files, per their commit messages, not the full suite with a down-and-back-up migration walk through the newest migration).
   **Real-world severity: low.** Every actual installation's `nfl_replay_runs` table was created by the schema module long before migration 041 existed, so a real rollback attempt on a real database would find the table and succeed. This only breaks the specific fixture-construction pattern these three tests share (`unwindTo`/`rollbackMigration` walking down from the newest migration on a migrations-only-replayed database). Still a genuine bug worth fixing — `down()` should carry the same existence guard `up()` already has — but it is Stage 5's file, not one of this stage's two assigned items, so I left it alone and am flagging it separately (see §4) rather than silently fixing or silently ignoring it, per this pipeline's own conservatism rule.

4. **`test/nfl-execution-pipeline.test.js:62` — "resolveQuoteBasis: prefers the real multi-book quote tape..."** — confirmed pre-existing since **Stage 3**: Stage 4's own commit message (`53c408e`) already recorded it verbatim: *"Full suite (1642 tests)... 1602 pass, 1 pre-existing failure (test/nfl-execution-pipeline.test.js, confirmed present on Stage 3's commit before this change, unrelated), 39 skipped."* I re-ran it in isolation on today's HEAD and it fails identically (`actual: undefined` where `'quote_tape'` is expected) — nothing about it changed between Stage 3 and now. Older, unrelated, already known.

**Net for Stage 6's own two items:** every test touching migration 027's new guard passes; every test touching the bitemporal wiring (new file plus the updated `nfl-t60-packet.test.js`) passes. Zero failures are attributable to this stage's changes.

---

## 3. A note on how the migration-027 tests were written

The two new tests for item 1 call `m027.down(database)` directly against a fixture built only *through* 027 (via `migrationsThrough`), rather than through `rollbackMigration()`'s full unwind from whatever the newest migration happens to be. That is a deliberate choice to keep this stage's own regression coverage independent of the pre-existing Stage-5 defect in §2 — using the full unwind path would have made these two new tests fail for a reason that has nothing to do with the guard they exist to check. The two *older* tests in the same file that do use the full unwind path were left exactly as they were (still correct, still worth having) and are exactly the two of the four full-suite failures traced to `041`'s bug above.

---

## 4. Follow-up flagged, not fixed here

Per this pipeline's own conservatism rule ("smallest correct diff... never silently skip, never overreach into an unrequested rewrite"), the following was found in passing while running the full suite this stage was asked to run, but is outside this stage's two assigned items and is Stage 5's own file — a background-task suggestion has been filed for it rather than fixed inline:

- `server/migrations/041_nfl_replay_run_spec.js`'s `down()` needs the same table-existence guard its own `up()` already has, so a rollback attempt against a database where `nfl_replay_runs` doesn't exist (currently: three specific test fixtures; theoretically: any environment that doesn't take the schema-bootstrap path) doesn't abort with a raw SQLite error instead of a clean no-op.

---

## 5. Merge-confidence assessment, stage by stage

Asked to be specific about stage 2 (tape-routing) and stage 3 (CLV consolidation) as the two most architecturally significant — both are addressed below alongside the other four, including this stage's own two items.

**Stage 1 — T-60 packet body retention + CLV grades table.** High confidence. Purely additive (two write-only migrations, not yet load-bearing for anything else at that point), plus a real, narrow correctness fix (`t60PacketHash` excluding wall-clock fields so identical evidence hashes identically). Low blast radius, well tested in isolation per its own commit message.

**Stage 2 — feed the frozen-packet decision tape. Needs review before merging, not because tests fail (they don't) but because of *where* it lands.** This wires `t60-runner.js`'s live capture path to actually write `nfl_decision_runs`/`nfl_decision_events` rows on every observation, adds a capture grace-window boundary shared with the missed-observation marker, and gives `runExecutionPipeline` an optional real packet-hash input. The commit's own tests all pass (`t60-runner`, `nfl-decision-tape`, `nfl-execution-pipeline`, `nfl-execution-integrity`, `nfl-decision-identity-pipeline`), and I re-confirmed all of them pass in this stage's full run too (the one `nfl-execution-pipeline.test.js` failure is the older, unrelated one from §2, item 4). But this is a change to the actual write path of the system that is, per this session's own safety brief, capturing real live games right now — a subtle timing or grace-window edge case here shows up as a gap or duplicate in the live decision tape for an actual NFL week, not in a test fixture. Tests passing is necessary but not sufficient confidence for a change at this exact location; I'd want a human to specifically watch one real capture cycle land correctly before calling this fully proven in production, on top of the tests already passing.

**Stage 3 — one shared CLV convention. Needs review, for two separate reasons.** First, the consolidation itself (four modules' CLV math into `clv-core.js`) is exactly as low-risk as its own commit message argues: the four implementations already agreed numerically, so this is refactoring, not a behavior change, and it's verified against the existing suite. Second — and this is the part worth a human's attention — `polymarket-lines.js`'s ESPN-event lookup fix is *not* pure refactoring: it changes team-name matching from comparing raw strings (which the commit says "essentially never matched") to resolving both sides through `teamCodeFor()`. That is a **behavior change that turns on a previously-dead code path** — Polymarket line data that was silently discarded before will now actually flow into whatever consumes `refreshPolymarketLineWatch()`'s output. That's very likely the intended fix, but "a feed that never worked now works" deserves a specific look at what's downstream of it before trusting its numbers in anything live, separately from trusting the CLV math consolidation itself. The commit is also explicit that the *requested* scope (delete `nfl-clv.js`, wire `forward_picks`/`shadow_decisions` into `nfl_clv_grades`) was deliberately not completed — both are still open, documented as TODOs with the schema gaps that block them.

**Stage 4 — trial registry + candidate-findings isolation.** Good confidence, normal review. The per-finding holdout isolation is a genuine robustness improvement (one stale finding no longer voids an entire season-end cycle) and is well-scoped. `audit-registry.js`'s `priorTests` reordering (preregistration order instead of execution order) is a real correction to a statistical-significance input (the Šidák correction) — subtle, but narrowly targeted and tested. The two new schema-only changes (`research_trials`, `UNIQUE(segment_key, rule_version)`) are inert until something is wired to use them, so they carry no behavior risk yet.

**Stage 5 — blend-mode consolidation, freeze-scope fixes, audit-overview corrections, shared weekly bootstrap. Needs review** for a reason this stage's own full-suite run surfaced: it shipped the `041_nfl_replay_run_spec.js` migration defect detailed in §2/§4 (low real-world severity, but a genuine, previously-uncaught bug — its own commit's testing was scoped to its own new/extended files, not a full-suite down-and-up walk). Separately, its `nfl-audit-overview.js` fixes (win-rate case-sensitivity, ROI denominator, season-coverage source) are real corrections to numbers a human might already have looked at and trusted — merging this will change what past audit-overview reports show, which is the right outcome but is worth flagging explicitly rather than merging silently, since anyone who screenshotted or cited the old (wrong) numbers will see different ones afterward.

**Stage 6 (this stage) — decision-tape downgrade guard + bitemporal injury wiring.** Item 1 (the `027` guard): high confidence, narrow, directly tested, no behavior change on the happy path. Item 2 (bitemporal wiring): correct and well-tested, but carries the real, bounded rollout consequence in §1.3 above — read that before merging, and consider triggering a manual injury sync right after, rather than waiting out the scheduler's 6-hour window, given live games are being captured this week.

---

## Files changed this stage

- `server/migrations/027_decision_tape.js` — downgrade guard on `nfl_decision_runs`/`nfl_decision_events`.
- `server/services/nfl-advanced.js` — `syncInjuries` now appends bitemporal revisions on real change.
- `server/services/nfl-t60-packet.js` — injury evidence read moved to the bitemporal store's `observed_at`.
- `test/migration-027-populated-upgrade.test.js` — 2 new tests for the guard.
- `test/nfl-t60-packet.test.js` — 2 tests updated (1 repurposed for the new rollout-gap behavior, 1 reason-string fix), 1 new happy-path test, INJECTION 1 rewired to the new data model.
- `test/nfl-injuries-bitemporal.test.js` — new, 6 tests covering the sync-side wiring end to end (fetch mocked, no network).
