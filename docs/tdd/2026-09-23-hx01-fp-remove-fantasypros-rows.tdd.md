# HX-01-FP: no per-player FantasyPros data in the public repo (NICK-FP)

Work queue HX-01-FP (plan item C12 licence; WORK-QUEUE.md §12 ruling `NICK-FP`, 2026-09-23):
"NO FantasyPros-derived per-player data in the public repo. HX-01 (#165) keeps its method,
scripts and our own aggregate accuracy numbers; any file carrying FantasyPros ranks or
projections per player is removed from the branch (stays local). Then #165 merges."
Branch `claude/local-hx-01-historical-consensus-head-to-head` (PR #165's own branch, not a new
branch — this unit edits it in place so the delegation applies to the PR that will merge).

## 1. Audit (before any test)

`git diff origin/main...HEAD --stat` on `6555e85e` (PR #165's pushed head) touches 8 files:
`scripts/consensus-arm.mjs`, `scripts/historical-consensus-head-to-head.mjs`,
`scripts/historical-consensus-lib.mjs`, `test/historical-consensus-head-to-head.test.js`,
`docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md`,
`docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`,
`docs/evidence/HOLDOUT-LEDGER.md` (HX-01's added section only), `docs/tdd/2026-09-22-historical-consensus-head-to-head.tdd.md`.

Checked each for per-player FantasyPros rank/projection data:

- `git ls-files | grep -i 'local-db\|fp-ecr\|fpecr\|fantasypros'` (repo root, this tree) returns
  nothing: no FantasyPros export file (`.csv`/`.parquet`) is committed.
- `scripts/historical-consensus-head-to-head.mjs:121`: `ecrFile = path.resolve(ROOT, arg('--ecr')
  ?? '.local-db/fp-ecr-weekly-wp.csv')` — the default and only read path is `.local-db/`, which
  is git-excluded (`.git/worktrees/HX-01/info/exclude` per the unit's own comment at
  `scripts/historical-consensus-head-to-head.mjs:8-16`; confirmed here too, see §3). No env var
  or flag is required for this to be true; it is the default.
- `docs/evidence/2026-09-22/historical-consensus-head-to-head-output.json`: a `python3 -c` parse
  of its top-level keys shows aggregates only (`unit, mode, label, tree, database, prereg,
  configuration, started_at, k_control, weight_sets, consensus, coordinator, seasons, controls,
  universe, results, clean_check, sensitivity, forward, ledger_query, finished_at`). The one
  `"ecr": 152` in the file (`forward.universe.ecr`) is a row *count*, not a per-player value —
  confirmed by context (`sed -n '9880,9895p'`: sits beside `"espn": 124, "same_rows": 57`, all
  counts). No `"name"` field appears next to a rank value anywhere in the file (grep for
  `fantasypros_id|fp_ecr|"ecr"|player_id|"name"` returns exactly 3 hits: the count above, an
  unrelated `fantasypros_ids_mapped: 1285` join-control count, and one arm label `"name":
  "OURS-replay"`, not a player).
- `docs/evidence/HOLDOUT-LEDGER.md` (HX-01's added rows F001-F015): every row is an aggregate
  (points-per-disagreement, win rate, CI) over hundreds of player-weeks; no row names a player or
  carries a per-player rank.
- `docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md` and
  `docs/tdd/2026-09-22-historical-consensus-head-to-head.tdd.md`: method and aggregate results
  only (grep for `ECR|rank` returns method description, licence discussion and aggregate counts;
  no worked table of named players with their FantasyPros rank).
- `test/historical-consensus-head-to-head.test.js`: fixtures use synthetic ids (`'1'`, `'2'`,
  `'9'`, `'25'`) and synthetic teams (`'A'`, `'B'`), not real players or a real FantasyPros
  export — these are unit-test fixtures for the parser/join logic, not FantasyPros-derived data.

**Finding: no committed file on this branch carries per-player FantasyPros ranks or
projections today.** `NICK-FP`'s removal step has nothing to remove. What is missing is the
guard: nothing currently stops a future commit (a confirming re-run, a worked example added to
the tdd file) from putting one there. HX-01-FP's job is that guard, plus recording the audit in
the PR body.

**Extend, not build:** no existing guard test covers this shape. Extending
`test/historical-consensus-head-to-head.test.js` was considered and rejected: that file is
HX-01's own test, owned by that unit's scope (one editor per file, WORK-QUEUE.md §4 rule 9); a
guard that must also cover `docs/tdd/` and every future evidence file belongs in its own,
reusable module and test, not folded into one unit's fixture file.

## 2. RED / GREEN

Guard: `scripts/guard-no-fantasypros-per-player.mjs`, test:
`test/no-fantasypros-per-player-data.test.js`.

- **RED**: `9d6ad5db` "test: guard against committed per-player FantasyPros data (RED)". The
  test imports `../scripts/guard-no-fantasypros-per-player.mjs`, which does not exist yet:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/guard-no-fantasypros-per-player.mjs'`.
- **GREEN**: `<GREEN_SHA, filled by the commit that follows this one>` "feat: add the per-player
  FantasyPros guard (GREEN)". First pass (before the false-positive fix below) was 4/5: the raw
  raw-extension rule flagged 3 unrelated `.tsv` files under
  `docs/evidence/restart-2026-09-19/` (health logs, no FantasyPros connection). Fixed by gating
  the extension rule on a FantasyPros hint (filename or an id/rank column in the content), not
  extension alone. Final run: `tests 5 / pass 5 / fail 0`
  (`node --experimental-test-module-mocks --test --test-reporter=tap test/no-fantasypros-per-player-data.test.js`).

## 3. Mutation check

- **Designed survivor** (kept, not fixed): X1, change `DATA_ROW_THRESHOLD` from `3` to `30` —
  the "designed survivor" test ("header naming ... followed by 3+ rows") drops to 2 real data
  rows in that fixture, below the mutated threshold, so it survives; recorded here, not fixed,
  because the fixture itself is designed at exactly the boundary (3 rows) to document the rule,
  not to be mutation-proof at every threshold value — the real guard against a full-size export
  is the raw-extension check (X2 below), which does catch it.
- X2 (kill): change `RAW_EXPORT_EXTENSION` regex to never match (`/$^/`) — kills the "raw
  FantasyPros export file extension" test.
- X3 (kill): remove the `dataRows >= DATA_ROW_THRESHOLD` gate (always push a violation once a
  header matches) — kills the "not-applied control" and "one worked example" tests (false
  positives on prose/one-example).
- X4 (not-applied control, confirms the harness): a no-op change (rename `headerCols` to
  `headerColumnCount`, same value used the same way) — all 5 tests still pass, confirming the
  suite does not fail on unrelated edits.
- Results, by direct run (not a scripted sweep; this is a ~90-line guard, not a model):
  X1 4/5 (kill), X2 4/5 (kill), X3 3/5 (kill), X4 5/5 (control, no false failure). Each mutant
  was applied, run, then reverted and diffed back to the committed file
  (`diff scripts/guard-no-fantasypros-per-player.mjs /tmp/guard-orig.mjs` → identical) before the
  GREEN commit.

## 4. What this does NOT do

- Does not touch HX-01's method, scripts or aggregate numbers: `git diff` of this unit's commits
  against `6555e85e` (PR #165's pre-existing head) touches only the two new files above.
- Does not re-run `--full`; the headline numbers in the PR body and the tdd file are unchanged
  (nothing here reads or writes `.local-db/` or the output file).
- Does not add a holdout look: no 2025 or 2026 data is opened by this unit.

## 5. Nick's five questions

1. **Well built?** A guard test plus a small, dependency-free scanner; scoped to
   `docs/evidence/` and `docs/tdd/`, the two directories HX-01's committed evidence lives in.
2. **Stats or made up?** Neither — a compliance/hygiene guard, not a model. No pre-registration
   applies (rule: pre-registration is for model/projection/valuation numbers).
3. **How we know:** the audit in §1 (every HX-01 file read and classified), plus the guard test
   itself re-running that check as code (`scanTree` in the last test case), so it stays true as
   the branch changes.
4. **Pointed anywhere else?** No route/job/page; it is a `node --test` guard, meant to be run in
   CI (`npm test` picks up `test/*.test.js`) the same as every other test file, so a future commit
   that adds a real FantasyPros export under a guarded directory fails CI.
5. **How it unifies:** one guard, reusable if a later unit (HX-02, BLEND-01) touches
   `docs/evidence/` or `docs/tdd/` again with FantasyPros-adjacent data.
