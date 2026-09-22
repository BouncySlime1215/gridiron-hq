# TDD evidence: two swallowed-absence reads (2026-09-22)

**Item:** Trade Brain's scan of `origin/main` found two more reads of the same shape as
`manager-signals.js`'s already-fixed `txIndex` — a bare `catch` around a table read that
cannot tell "this table has never been created on this machine" apart from a real query
fault. Queued by the coordinator with the exact lines and the treatment to copy
(`manager-signals.js:167`'s `if (!tableExists(...)) return { present: false, ... }`); picked
up as soon as the role_change slice finished.
**Files:** `server/services/nfl-rebuild-progress.js` (`nflRebuildProgress`),
`server/services/nfl-ensemble-rank.js` (`rankReports`); tests `test/nfl-rebuild-progress.test.js`
(new — the function had no test at all before this) and `test/nfl-ensemble-rank.test.js`
(extended).
**Source:** `nfl-rebuild-progress.js:13`/`:17`, `nfl-ensemble-rank.js:656` (Trade Brain's
scan); `manager-signals.js:167` (`txIndex`, the pattern being copied);
`docs/tdd/availability-honest-degradation.tdd.md` (the original finding of this bug shape,
in `contingency.js`, and the CLAUDE.md rule it produced: "errors are handled or they throw
... if a layer goes inert, the surface must say so").
**LLM spend:** $0.
**Environment:** cloud box, isolated temp SQLite per test file.

## 1. What was actually wrong

Both functions wrapped a table read in `try { ... } catch { /* table doesn't exist yet */ }`
and returned an empty answer either way — whether the table was genuinely never created, or
the query failed for a real reason (a locked database, a column the schema no longer has, a
corrupt row). CLAUDE.md names this exact shape by history: *"This project read a `Connection
error.` ... as a missing Anthropic key for weeks ... The wrong key was accepted in silence."*
The mechanism here is the same — a catch swallowing the actual cause and reporting a bland
"nothing here" — even though the specific bug is different.

**`nflRebuildProgress`** — two tables (`nfl_rebuild_progress`, `nfl_rebuild_checkpoints`),
both created only by `nfl-2022-2025-rebuild.mjs`. On a machine that has never run that
script (a fresh clone included), both catches fire on every call, silently. A real fault in
either query — say a future migration renames a column — would look identical: an empty
`progress`/`checkpoints` array, no error, no signal.

**`rankReports`** — one table (`nfl_ensemble_rank_reports`), created only by
`saveRankReport`'s own `CREATE TABLE IF NOT EXISTS`. Same shape, plus the catch also covered
`JSON.parse(r.report_json)` for every row — a single corrupt report would silently empty out
every OTHER valid report in the result too, not just itself.

## 2. The fix

Same treatment as `manager-signals.js:116`'s `tableExists` + `txIndex`'s
`if (!tableExists(...)) return { present: false, ... }` — not a new pattern; the codebase
already carries this exact one-liner independently in six other files
(`nfl-feature-coverage.js`, `nfl-engine-registry.js`, `nfl-evidence.js`,
`nfl-engine-backfill.js`, `nfl-profitability.js`, `manager-signals.js`), so a seventh local
copy matches the established convention rather than introducing a shared module this
codebase has evidently chosen not to have.

- **`nflRebuildProgress`**: checks `tableExists('nfl_rebuild_progress')` and
  `tableExists('nfl_rebuild_checkpoints')` before querying either. Absent → `[]` for that
  table, plus a new `progress_present`/`checkpoints_present` boolean on the return value (its
  one caller, `GET /rebuild-progress` in `nfl-betting.js:1100`, just JSON-serializes the
  whole object, so the new fields are purely additive). No catch remains around either
  `SELECT` — a real fault now throws.
- **`rankReports`**: checks `tableExists('nfl_ensemble_rank_reports')` before querying.
  Absent → `[]`, same shape the function already returned (return-type change avoided
  deliberately — see §5). No catch remains around the `SELECT` or the `JSON.parse` — a
  corrupt row now throws instead of blanking the whole result.

## 3. Regression

```
node --test test/nfl-rebuild-progress.test.js test/nfl-ensemble-rank.test.js
# tests 21
# pass 21
# fail 0
```

`npm run lint` — clean (916 files; one new test file).

**Full suite, 2x-verify, corrected guard form** (per the coordinator's guard-v3 correction:
no `set -e`, `rc=0; npm run check || rc=$?`, no `| tee`, log outside the repo,
`find . -path ./.git -prune -o -newermt "@$t0" -type f -print` afterward):

| pass | worktree | exit | tree hash before/after | status before/after | tests | files touched outside `client/dist/` |
|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/absence-verify-1` | 0 | `f7462477` / `f7462477` (unchanged) | empty/empty | 3156/3156 pass, 41 skipped, 0 fail | none |
| 2 | `/tmp/claude-0/absence-verify-2` | 0 | `f7462477` / `f7462477` (unchanged) | empty/empty | 3156/3156 pass, 41 skipped, 0 fail | none |

Both passes identical. Pushed to `claude/coach-grounded-4l8hno` only after both cleared.

## 4. Test specification

`test/nfl-rebuild-progress.test.js` (new file — none existed before):

| test | asserts |
|---|---|
| neither table exists yet: both are reported absent, not a swallowed error | fresh DB, no rebuild script ever run → `progress_present: false`, `checkpoints_present: false`, both arrays empty, `active: null` |
| once the rebuild script has created and populated both tables, real rows come back | both tables created + one row each → `*_present: true`, `percent` computed correctly (30/120 → 25), `detail_json` parsed, `active` picks the running phase |
| a real read fault throws once the table exists, rather than reading as absent | `checkpoints` table recreated missing its real columns → `nflRebuildProgress` throws (`no such column`), not a silent absence |

`test/nfl-ensemble-rank.test.js`, two new tests around the existing
`a report can be stored and read back` test:

| test | asserts |
|---|---|
| rankReports: an empty answer before anything is ever saved is not a swallowed fault | table genuinely does not exist yet (nothing in this file has called `saveRankReport`) → `[]`, both with and without a `label` filter |
| rankReports: a real fault throws once the table exists, rather than reading as empty | a row with unparsable `report_json` inserted directly → `rankReports` throws `SyntaxError`, not `[]` |

## 5. Design decision: `rankReports`' return shape was NOT changed

`nflRebuildProgress` already returned an object, so adding `progress_present`/
`checkpoints_present` fields was free. `rankReports` returns a bare array, and one existing
test (`a report can be stored and read back without losing its numbers`) calls
`.length`/`[0].report...` directly on it — changing to `{ present, reports }` would have
broken that pinned test for no reason connected to this bug. `rankReports` also has **zero
callers anywhere in the codebase** (checked: no route, no client, nothing outside its own
test) — there is no live surface today that a `present` flag would inform. The actual bug
(a real fault reading as `[]`) is fixed without a shape change: table-absence is still `[]`,
which is the one case that answer is actually correct for, and everything else now throws.

## 6. File ownership

Both files are named directly in the coordinator's queued unit; `manager-signals.js` was
read only, as the pattern reference, not modified. No route, no client file touched (the one
caller of `nflRebuildProgress`, `nfl-betting.js:1100`, needed no change — it forwards
whatever the function returns).

## 7. Known limits

- **`progress_present`/`checkpoints_present` are not yet read by any UI.** The endpoint that
  serves `nflRebuildProgress()` (`GET /rebuild-progress`) now carries the signal; whether the
  rebuild-progress page should show "never run" differently from "0% done" is a UI decision
  this unit does not make.
- **Scope was exactly the two reads named.** No search was run for a third instance of this
  shape beyond the seven `tableExists` definitions already found (§2) — those seven already
  guard the pattern correctly; this did not audit every bare `catch` in the codebase for the
  same failure mode, only the two Trade Brain's scan flagged.
