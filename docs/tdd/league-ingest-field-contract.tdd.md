# TDD evidence: league-ingest field contract in routes/leagues.js

2026-09-22. Base: `654ff93` (main). RED `e916b2c`, GREEN `042a9ad`.

## 1. Where this came from

`docs/wiring/league-ingest-field-contract.md` — a spec Fantasy plan wrote
against `docs/tdd/league-config-verification.tdd.md`'s Phase A scoping,
handed to this thread by the coordinator because `server/routes/leagues.js`
is this thread's file under the one-editor rule. The doc never landed on a
pushed branch (Fantasy plan's own branch is local-only); the coordinator
relayed its full text instead once that was confirmed.

Six items. #1 needed no code change (see §4). #2–#6 are this commit.

## 2. What was actually there, verified against shipped code before touching anything

The contract flagged several of its own asks as unverified. Three turned out
to already be confirmed by code this repo ships and runs today — grounding
the fix in that rather than the contract's own caution:

- **ESPN bench/IR slot ids (contract said "not verified here, worth a
  one-line check").** `server/services/espn-draft.js:78-79` already has
  `SLOT_NAME = { 0:'QB', 2:'RB', 4:'WR', 6:'TE', 16:'DEF', 17:'K', 23:'FLEX',
  20:'BENCH', 21:'IR', 7:'OP' }`, and `server/services/trade-engine.js:2602`
  already derives its `IR_SLOT_ID` from that exact map. `routes/leagues.js`
  had its own independent, incomplete copy (`ESPN_SLOT_NAME`, missing
  20/21/7) — two hand-maintained copies of the same platform constant, one
  stale. Not a value to look up; a duplication to remove.
- **ESPN's `scheduleSettings.playoffTeamCount` (contract item 6).**
  Already read from `payload` on every call by `season-sim.js:198` and
  `trade-horizon.js`'s `leagueSchedule()`. Confirmed live code, not a new
  field.
- **Sleeper's `settings.playoff_teams`/`settings.playoff_week_start`
  (contract item 6).** Already read the same way by
  `server/services/sleeper-history.js:37,39,54`.

What stayed unverified at the time of the first commit (`042a9ad`) and was
NOT guessed at: ESPN's waiver-type, FAAB and trade-deadline fields.
`server/services/trade-tactics.js:375` confirms `payload.settings.
tradeSettings` is a real object (it already reads `vetoVotesRequired` off
it), but `deadlineDate` specifically had never been observed on a real
payload, and there was no known path at all for ESPN waiver type or FAAB.
Those three columns were left NULL for ESPN in `042a9ad`.

**Corrected the same night (`5a13095`).** Fantasy plan found real field
paths against a captured payload (cwendt94/espn-api) and the coordinator
relayed them: `waiver_type` is `settings.acquisitionSettings.acquisitionType`
(a string); `faab_budget` is `settings.acquisitionSettings.acquisitionBudget`,
gated on `isUsingAcquisitionBudget === true` (a real payload had
`acquisitionBudget: 100` present alongside `isUsingAcquisitionBudget: false`,
so reading it unconditionally would fake a FAAB budget for a plain-waiver
league); `trade_deadline` is `settings.tradeSettings.deadlineDate` (epoch
ms), where ESPN's own `0` means "no deadline set" and is stored as `NULL`,
not a literal epoch-0 timestamp. RED (`d2691f8`) → GREEN (`5a13095`), same
TDD shape, own mutation sweep (5 injections, all caught; both controls
correct). §3-§7 below describe the original (`042a9ad`) implementation and
its own RED/GREEN/sweep/check; the ESPN waiver/FAAB/deadline correction is a
second, later pass on top of it, not a rewrite of this file's earlier
sections.

## 3. RED (`e916b2c`)

`test/league-ingest-field-contract.test.js`, four tests against unmodified
`654ff93`:

```
node --experimental-test-module-mocks --test-concurrency=1 \
  test/league-ingest-field-contract.test.js
# tests 4
# pass 1
# fail 3
```

- FAIL — `an ESPN league's bench and IR lineup slots are not dropped from
  roster_positions`: `0 !== 6` (BENCH), same shape for IR.
- FAIL — `an ESPN league's playoff bracket size is stored on the row at
  sync time`: `no such column: playoff_teams`.
- FAIL — `a Sleeper league's waiver, trade-deadline and playoff settings
  are stored on the row`: `no such column: waiver_type`.
- **PASS** — `a Sleeper league's full scoring_settings survives into
  payload, not just the PPR flag`. This is contract item 1, confirmed
  needing no fix: `syncSleeperLeague` already builds
  `payload = { league, ... }` and stores the whole thing, so
  `payload.league.scoring_settings` was always there in full. The test
  exists so a future change that narrows what goes into `payload` fails
  loudly instead of silently reintroducing the gap the contract described.

File sha256 before any implementation:
`d9765d6b49a23006795aec7e58566d2d78093e4db2f2b40c2f94ade953fcec5e`.

## 4. GREEN (`042a9ad`)

- `server/migrations/068_league_ingest_field_contract.js`: adds
  `waiver_type TEXT`, `faab_budget INTEGER`, `trade_deadline INTEGER`,
  `playoff_teams INTEGER`, `playoff_week_start INTEGER` to `leagues`,
  additive and idempotent (checked against `PRAGMA table_info` first, same
  pattern as `061_sync_log_consecutive_failures.js`).
- `server/routes/leagues.js`:
  - imports `SLOT_NAME` from `espn-draft.js`, deletes the local
    `ESPN_SLOT_NAME`, and uses the shared map in `syncEspnLeague`'s
    `rosterPositions` build.
  - `syncEspnLeague` now also writes `playoff_teams` from
    `data.settings?.scheduleSettings?.playoffTeamCount ?? null`.
  - `syncSleeperLeague` now reads `league.settings ?? {}` and writes
    `waiver_type` (stringified, undecoded), `faab_budget` (from
    `waiver_budget`), `trade_deadline`, `playoff_teams`,
    `playoff_week_start` — all `?? null` when absent.

```
node --experimental-test-module-mocks --test-concurrency=1 \
  test/league-ingest-field-contract.test.js
# tests 4
# pass 4
# fail 0
```

## 5. Side effects checked, not guessed at

`roster_positions` gaining `'BENCH'`/`'IR'`/`'OP'` entries for ESPN leagues
touches every consumer of that column. Checked each rather than assuming:

- `trade-engine.js#lineupSlots()` filters `rp` through
  `SCORED.has(s) || FLEX_ELIGIBLE[s]` (`SCORED` = QB/RB/WR/TE,
  `FLEX_ELIGIBLE` keys = FLEX/REC_FLEX/WRRB_FLEX/SUPER_FLEX/OP) — BENCH and
  IR are in neither, so they're filtered out exactly like the DEF/K entries
  ESPN rosters already carried before this change. Safe.
- `format.js#deriveFormat`, `tradelab.js#analyzeLeague`: only check for
  specific position strings (`SUPER_FLEX`, `QB`/`RB`/`WR`/`TE`) or count
  matches by exact string; BENCH/IR/OP never match those, so no double
  counting.
- **One real, left-alone side effect**: `lineup-posture.js:361`'s
  `win_probability_scope` string divides by
  `JSON.parse(lg.roster_positions ?? '[]').length` as a display-only "of N
  roster slots" count. That denominator will grow for ESPN leagues once
  BENCH/IR/OP are included — but Sleeper leagues' `roster_positions` already
  includes Sleeper's own `'BN'` bench entries verbatim from its API today,
  so this makes ESPN's denominator consistent with what Sleeper already
  does, not a new inconsistency. `lineup-posture.js` is UI's file under the
  one-editor rule; flagged to the coordinator rather than edited here. No
  test asserts the exact string or count, and
  `test/posture-calibration.test.js`, `test/decision-leftovers-lineup.test.js`,
  `test/lineup-surfaces-agree.test.js` all still pass.
- Ran full: `test/league-roster-schedule.test.js`,
  `test/league-brain.test.js`, `test/league-analysis-unpriced.test.js`,
  `test/cross-account-league-access.test.js`,
  `test/llm-budget-per-league.test.js`, `test/league-removal.test.js`,
  `test/league-chat-sync.test.js` — all green, no regressions from either
  the schema change or the sync-logic change.

## 6. Mutation sweep

`sweep.mjs` (scratchpad, not committed — this file is the durable record).
Each injection: verify the anchor string appears exactly once in
`server/routes/leagues.js`, apply it, run
`test/league-ingest-field-contract.test.js`, record the result, restore the
original bytes, verify the restored sha256 matches the pre-sweep baseline
(`de926025107c2b522ebe4a5cd129bb22b2d145e507e135dee17991eaca4c151f`, matched
after every case).

| Injection | Result |
|---|---|
| ESPN slot map reverted to the old incomplete map | caught: 1 failing |
| `playoffTeams` bound to `null` unconditionally (ESPN) | caught: 1 failing |
| Sleeper `settings` object always `{}` | caught: 1 failing |
| `waiver_type` bound to `null` unconditionally | caught: 1 failing |
| `faab_budget` bound to `null` unconditionally | caught: 1 failing |
| `trade_deadline` bound to `null` unconditionally | caught: 1 failing |
| `playoff_teams` (Sleeper) bound to `null` unconditionally | caught: 1 failing |
| `playoff_week_start` bound to `null` unconditionally | caught: 1 failing |
| absent-pattern control (anchor that doesn't exist) | **0 matches — reported NOT-FOUND, not run** |
| NO-OP control (whitespace-only edit) | all green, as expected |

All eight real injections were each caught by exactly one failing test — the
one that names the field or behavior the injection removed. The
absent-pattern control correctly reports NOT-FOUND rather than silently
running as a no-op edit (the sweep script checks the anchor count before
writing). The NO-OP control confirms the harness doesn't false-positive on
an unrelated change. File restored byte-identical after every case.

## 7. Base and verification

Branch `claude/project-thread-n4052e-league-ingest-fields`, base `654ff93`
(current main). RED `e916b2c`, GREEN `042a9ad`.

Full local check on `042a9ad`, source-isolated (own source tree,
`node_modules` symlinked to the container's checkout, no install run).
`git write-tree` before and after the run both `24fdfe626e58669eaaa2d154517d0a2793ff4429` — unchanged, run is not void.
`node_modules` mtime before/after: `2026-09-19 16:17:48.380643953 +0000`
(unchanged); `.package-lock.json` `2026-09-19 16:14:10.624631009 +0000`
(unchanged).

`npm run check` — exit 0:

- typecheck: clean
- lint: clean, 883 JavaScript files
- test: 2,990 tests, 2,949 passed, 0 failed, 41 skipped
- build: clean
- start:smoke: "Application startup smoke passed on isolated database (32 teams)"

### 7b. Corrected ESPN waiver/FAAB/deadline pass — current head (`5a13095`)

RED `d2691f8`, GREEN `5a13095` (this is the current head — see §2/§6b's
correction). Same worktree, same isolation.

`git write-tree` before and after this run both `8362dd346eaa03f8c0af697ca15b78b08e6ef2a2` — unchanged, run is not void.
`node_modules` mtime unchanged from §7 above (no install ran between the
two checks).

`npm run check` — exit 0:

- typecheck: clean
- lint: clean, 883 JavaScript files
- test: 2,994 tests, 2,953 passed, 0 failed, 41 skipped
- build: clean
- start:smoke: "Application startup smoke passed on isolated database (32 teams)"

**Note on lineup-posture.js.** Two commits touching `server/services/
lineup-posture.js` and a new test file were made and then reverted on this
branch (`git reset --hard 5a13095`) after the coordinator confirmed the
apparent authorization to fix it — and a related lineup-brain.js finding —
had both been misrouted to this thread from UI's (a thread-id mix-up on the
coordinator's end, not this thread's). Nothing from that work survives:
the reset's resulting tree (`8362dd34...`) is confirmed identical to the
tree this section's check already verified, so no re-run was needed. §5's
observation about `lineup-posture.js:361`'s denominator remains flagged for
UI, not fixed here.

## 8. Not done here (routed, not edited)

- `scoring.js`'s Sleeper branch reading `payload.league.scoring_settings`
  (item 1's other half) — Fantasy plan's file.
- `season-sim.js`/`trade-horizon.js` reading the new `playoff_teams` column
  instead of re-parsing `payload` — Fantasy plan's files, once this lands.
- The `win_probability_scope` denominator in `lineup-posture.js` — UI's
  file; flagged, not edited.
- Two live wiring bugs the contract explicitly excluded (scoring never
  reaching the simulator at `title-odds-trades.js:66` and
  `routes/trades.js:1132`) — not this file, not this contract.

## The five questions

**Is this well built?** It replaces a stale, incomplete, hand-maintained
map with the one map the rest of the codebase already trusts (removing a
duplication rather than adding one), and stores fields the sync already
fetches and previously discarded. Every new column defaults to NULL and is
additive; nothing that worked before reads differently now except where the
contract asked it to.

**Is it based on stats, or made up?** Every "already confirmed" claim above
cites the file:line that already ships it. Every field left NULL is left
NULL specifically because no such citation exists.

**How do we know?** RED before GREEN, a mutation sweep with an
absent-pattern control and a NO-OP control, and every affected consumer of
`roster_positions` read and reasoned through rather than assumed safe.

**Should this data point anywhere else?** Yes — two downstream call sites
(`scoring.js`, `season-sim.js`/`trade-horizon.js`) need to start reading
these fields to make item 1 and item 6 pay off; both are Fantasy plan's
files, routed rather than edited here. The `lineup-posture.js` display-text
side effect is UI's to decide whether it matters.

**How does it unify?** One shared `SLOT_NAME` map instead of two now backs
every ESPN-lineup-slot decision in the codebase (`trade-engine.js` and
`routes/leagues.js` alike), and the sync path stops discarding data the
platform already sends.
