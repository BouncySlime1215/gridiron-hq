---
name: process-exit-truncates-a-piped-report
description: Measured 2026-09-22 — process.exit() after console.log truncates a piped report totally, at a cut point that VARIES; the list of which gridiron scripts are actually captured was wrong in both directions and is corrected here.
metadata:
  type: project
---

**`process.exit()` does not flush a pipe.** A script that prints a report then
exits loses the tail whenever its stdout is **captured** rather than inherited.
A TTY flushes synchronously and looks fine; `execFile`, `execFileSync` and
`spawnSync` all pipe by default.

Measured under `execFile`, 32 MB maxBuffer: whole at 1,000 and 100,000 bytes;
**0/24 whole** at 200 K / 500 K / 1 M / 5 M, six trials each.
**Where it cuts is NOT fixed** — 146,176 is only the modal value; 182,720,
657,792 and 730,880 all appeared from the same probe (every one a multiple of
36,544: a race against however many chunks drained, not a fixed buffer).
**RETRACTED:** the earlier "hard cliff just under 146 KB / a fixed buffer", in
this memory, `docs/tdd/2026-09-22-archetype-report-parse.md`, commit `c476c1a`
and PR #107's body. **Never assert a byte count; assert "the whole report
arrived and parsed"** with a payload over 1 MB.

## Which scripts are actually captured (corrected — the old list was wrong both ways)

| script | captured by | at risk |
| --- | --- | --- |
| `build-manager-archetypes.mjs` | `scheduler.js:637` `execFile` | **yes — FIXED** |
| `luck-panel.mjs` | `build-manager-archetypes.mjs:51` `execFileSync` | **yes — FIXED** |
| `collect-league-transactions.mjs` | `refresh-live-data.mjs:99` `spawnSync` | mechanism yes, size no |
| `collect-roster-snapshots.mjs` | `refresh-live-data.mjs:114` `spawnSync` | mechanism yes, size maybe |
| `build-manager-signals.mjs` | `refresh-live-data.mjs:220` `spawnSync` | mechanism yes, size no |
| `promote-weekly-ensemble.mjs` | **nothing** | no |
| `availability-decision-calibration.mjs` | **nothing** | no |
| `import-alt-spreads.mjs` | **nothing** | no (betting, out of scope) |

**`promote-weekly-ensemble.mjs` is the LEAST exposed, not the most.** Its final
statement is a `console.log` with no `exit()` after it (`:342`), so its success
path races nothing; its JSON prints (`:163`, `:219`) are bounded ~10-key objects
on failure paths only. The old claim that a truncated `--json` report would make
a successful promotion read as a failure was false twice over..

**The three `refresh-live-data.mjs` children fail WORSE on a smaller payload.**
That parent reads `outputLines(r).at(-1)` — the LAST line — and truncation cuts
the TAIL, so the summary line is the first casualty. `transactionsCapture` then
runs `/failed (\d+)/` on it; losing the summary gives `leaguesFailed = 0`, and
with `r.status === 0` the loop logs **ok** off a stale earlier line: a silent
misreport, not a parse failure. **`refresh-live-data.mjs:101,123,232` is its
own finding and unit** — fixing the children would not make that read safe.

## The fix

**Producer, the two captured scripts:** branch
`claude/project-thread-o3wt2p-flush-then-exit` off main `654ff93` — RED
`d3b7a11`, GREEN `acb18b0`, sweep `dcca6c5`, evidence `19f4b35`
(`docs/tdd/2026-09-22-flush-then-exit.md`). 13 tests, 11 injections killed. New
`scripts/lib/flush-then-exit.mjs` exports `writeThenExit(text, opts)` and
`printJsonThenExit(value, opts)`, `opts` = `{ code, stream, exit }`.

Three candidates measured, all 5/5 whole at 1 MB where today is 0/5: the write
**callback** (shipped), `process.exitCode` with no `exit()`, and a `drain`
listener. `callback` keeps the explicit exit these scripts need with an open
synchronous `DatabaseSync` handle. **Bytes unchanged**, so both existing
parsers are untouched. **Local only; nothing pushed under the 09:42Z
revocation.**

**Consumer, PR #107:** `parseArchetypeReport` reports a truncation AS a parse
failure, with the parse error and `stdout_bytes` beside it. Before it, all
three failure modes said "printed no JSON summary" — false for this one.

Family: [[freshness-contract-seam-failed-open]],
[[measure-the-seam-do-not-read-it]],
[[mutation-sweep-two-invalid-verdicts]].
