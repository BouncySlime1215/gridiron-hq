# TDD evidence: HYPO-01a surprise detector

Source: ENGINE-SPECS HYPO-01a (handoff package, `docs/handoff/local/ENGINE-SPECS.md`),
narrowed by the cloud task: "when a league outcome deviates from the model (accept we
gave <10%, decline we gave >70%, sudden roster move), write a hypothesis row for Jev/R&D
to test, with the evidence ids. Behind a flag."

Built in a Claude Code cloud session, 2026-09-24. No league DB in the box, so everything
here is fixture-verified. The run on a copy of the real DB is a `LOCAL:` line in the PR.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      test/hypo-surprise.test.js

LLM spend: $0.

## What was built, and what of the spec was not

| Spec part | Here | Why |
|---|---|---|
| Surprise detector, s = -ln p(outcome) | Yes, three streams: `accept_low`, `decline_high`, `roster_burst` | The task's three cases |
| Threshold = per-stream 95th percentile, refit nightly | **No.** Fixed cuts: 10% / 70% (the task's), burst P < 0.05 (hand-set) | No graded calibration window yet (the spec itself waits for >= 6 graded weeks) |
| `surprise` event in engine_events | **No.** Row in `surprise_hypotheses` (migration 095) | ENGINE-00a spine (075, #216) was not on main when written; it merged since. Moving the rows to engine_state is a follow-up |
| Reasoner via JEV-01a gateway, spec grammar, pre-registration | **No** | JEV-01a not on main; HYPO-01a-2 |
| onEvent learner on ENGINE-00b-a hooks | **No.** CLI `scripts/hypo-surprise.mjs` | Daemon not on main |

## Gates, stated before the implementation

- **G1 flag.** Off unless `GRIDIRON_HYPO_ENABLED=1`; off writes nothing.
- **G2 cuts.** Accepted at p < 0.10 and declined at p > 0.70 are surprises; the edges
  (0.10, 0.70), unanswered offers and expected outcomes are not.
- **G3 evidence ids.** Every row names its trade_outcomes id(s) or tx ids; the table
  refuses a row that names neither.
- **G4 idempotent.** A second run writes nothing.
- **G5 league scoped.** Another league's rows are not read.
- **G6 burst.** A quiet team's 4 moves in 48 h is one `roster_burst` carrying all 4 tx
  ids; a steady team is not flagged; a trade counts for both parties.
- **G7 no silent skip.** A run of moves with < 7 days of collected history is reported
  as skipped with a reason; an absent `league_transactions_raw` is a stated state.

## RED

Commit `test: HYPO-01a surprise detector RED`: `test/hypo-surprise.test.js` fails with
`ERR_MODULE_NOT_FOUND` for `server/services/hypo/surprise.js` (pass 0, fail 1).

## GREEN

`server/services/hypo/surprise.js`, `server/migrations/095_surprise_hypotheses.js` (first numbered 086; renumbered to 095 per the coordinator ledger),
`scripts/hypo-surprise.mjs`: pass 12, fail 0 (the 10 RED tests plus a dry-run test and a
CLI test added with the CLI).

`npm run lint`, `npm run typecheck`, `npm run check:wiring` clean (the module is on the
accepted-orphan list with a retire condition, as TELLS-01a's were).

## Liveness: mutation sweep

Each mutant applied alone to the GREEN tree, `test/hypo-surprise.test.js` re-run.

| # | Mutant | Result |
|---|---|---|
| M1 | `p < ACCEPT_LOW` -> `<=` | killed (fail 1) |
| M2 | `p > DECLINE_HIGH` -> `>=` | killed |
| M3 | offer read drops `league_id = ?` | killed |
| M4 | flag forced on | killed |
| M5 | migration CHECK without COALESCE on `trade_outcome_ids` | killed |
| M6 | migration CHECK without COALESCE on `tx_ids` | killed |
| M7 | reported window = least improbable instead of most | **survived first**: both windows were identical in the fixture (same timestamp). Fixture staggered; now killed |
| M8 | a trade counts for its first party only | **survived first**: the test never checked the second party. Test now asserts team 6's burst carries the trade; killed |
| M9 | `BASELINE_MIN_DAYS` 7 -> 0 | killed |
| M10 | `ON CONFLICT DO NOTHING` -> `DO UPDATE` | killed |
| M11 | baseline window includes its own start (`<=`) | killed |
| C1 | control: whitespace-only change to a constant line | survived (as designed) |
| C2 | control: a mutation string that is not in the file (the first M7 spelling) | not applied (assert fired, no test run) |

After M7/M8 the RED was re-run against the unfixed tree (no `surprise.js`): still fails
at import, `ERR_MODULE_NOT_FOUND`.

## Nick's five questions

1. **Well built?** One writer (`detectSurprises`) to one new table with CHECKs for the
   evidence contract; idempotent; flag-gated; no served number reads it.
2. **Stats or made up?** Surprisal is -ln p(outcome) under what was served. The 10%/70%
   cuts are the task's. The burst rule (72 h, >= 3 moves, P < 0.05 Poisson on a 28-day
   base rate, 0.5 pseudo-count, >= 7 days history) is **hand-set, a guess**.
3. **How we know:** nothing measured yet. Fixtures only; the real-DB count is the PR's
   `LOCAL:` line. The spec's 5% +/- 1.5% calibrated surprise rate on the 2024 replay is
   **not** checked.
4. **Pointed anywhere?** No. Nothing reads `surprise_hypotheses` except the CLI's `--list`.
5. **How it unifies:** the row maps onto ENGINE-00a's engine_state `hypothesis` entity
   when the spine merges; HYPO-01b's screen excludes `evidence` ids (no double-dipping).

## Round 2: a waiver run is one decision (from the local run on PR #277)

The coordinator's run on a DB copy (league 4, `8929aac8`) flagged 8 `roster_burst` rows,
among them "team 10, 3 moves in 0 h, p=0.000025". ESPN processes a team's waiver claims
in one batch at one timestamp. v1 counted each claim as an independent Poisson event, so
the p-value was far too small, and the same double-count inflated the base rate.

Fix (`hypo-01a-v2`): the count is **decisions**, meaning the distinct timestamps of a
team's moves, both inside the window and in the baseline. `BURST_MIN_MOVES` (3) applies
to decisions. The evidence keeps every tx id and reports `moves`, `decisions`,
`baseline.prior_moves` and `baseline.prior_decisions`.

- RED `00e259a8` "test: HYPO-01a a waiver run is one decision, not a burst (RED)":
  the new test fails on v1 (pass 12, fail 1). Two existing fixtures that had used
  same-instant adds as three decisions were moved to distinct times.
- The GREEN commit also pins p and the baseline (the assertions were added after the
  mutants below survived). They were re-run against the unfixed source: pass 12, fail 1.

| # | Mutant | Result |
|---|---|---|
| M12 | p from the move count, not the decisions | survived first (p not pinned), then killed |
| M13 | candidates by move count | killed |
| M14 | baseline rate from moves, not decisions | survived first (no batched baseline in the fixture), then killed |

## Round 3: a decision is a run of moves under 60 min apart (v2 re-run on PR #277)

v2's run (`0e7f5e6e`) printed the same 8 bursts, including "team 10, 3 moves (3 decisions)
in 0 h". Those claims were not at one instant: they were minutes apart. Round 2's
exact-timestamp rule had the right cause and the wrong test for it.

Fix (`hypo-01a-v3`): a move less than `DECISION_GAP_MINUTES` (60, hand-set) after the
team's previous move belongs to the same decision. This applies in the window and in the
baseline. Windows open only where a decision starts.

- RED `6a8177fc` "test: HYPO-01a moves minutes apart are one decision (RED)": fails on
  v2. The GREEN commit adds "a window never opens mid-decision". That test also fails on
  v2 (v2 source: pass 13, fail 2). v3: pass 15, fail 0.

| # | Mutant | Result |
|---|---|---|
| M15 | `DECISION_GAP_MINUTES` 60 -> 0 | killed (2 tests) |
| M16 | windows open at every move | survived first, then killed by the mid-decision test |
| M14 | baseline counted in moves (re-run on v3) | killed |

## Sweep fixes (2026-09-24): FIX-277-1 to FIX-277-4

- **FIX-277-1** (migration number): already `095_surprise_hypotheses` at `aec1fe3d`, the
  number MIGRATIONS.md registers to #277; main has no 095. Name, file, tests and this
  file already say 095. No change.
- **Pre-registration** `2d8bd1d`: `docs/evidence/2026-09-24/hypo-01a-threshold-prereg.md`
  (sha256 `837525e0…`), committed before the calibration code and before any run.
- **RED** `ce20f29`: `test/hypo-surprise-streams.test.js` fails to load
  (`ERR_MODULE_NOT_FOUND: server/services/hypo/projection-stream.js`); the existing
  fixture's app offers are now marked sent, and `test/hypo-surprise.test.js` alone
  passes 15 of 15 on the old code.
- **GREEN** `21e0e33`: both files, 24 of 24 pass.

| Mutant | Result |
|---|---|
| M17 offer SQL reads unsent app rows | survived: equivalent. `mergeOffers` (e1-league.js) excludes an unsent app row on its own, so the SQL filter is a second guard with the same behaviour |
| M18 a chain of flagged windows is not split | killed (2 fail) |
| M19 accept cut loosened to 0.3 | killed (2 fail) |
| M20 projection_miss flags every unit | killed (1 fail) |
| M21 one-sided tail probability | killed (1 fail) |
| M22 projection scope drops the roster join key | killed (1 fail) |
| M23 walk-forward history never grows | killed (1 fail) |
| M24 walk-forward threshold ignored | killed (1 fail) |
| M25 no minimum history | killed (1 fail) |

Command: `SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test test/hypo-surprise-streams.test.js test/hypo-surprise.test.js`

Not built: FIX-277-4's second stream (a PROJ-04 autopsy row's knowable miss) needs #251's
`projection_autopsy` table, which is not on main.
