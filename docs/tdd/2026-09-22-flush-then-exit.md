# Flush a captured report before exiting

Branch `claude/project-thread-o3wt2p-flush-then-exit`, off `main` @ `654ff93`.
RED `d3b7a11` · GREEN `acb18b0` · sweep fix `dcca6c5`.

## The defect

`process.exit()` does not flush a pipe. A script that ends

    console.log(JSON.stringify(report, null, 2));
    process.exit(0);

is correct when a human runs it — a TTY flushes synchronously — and silently
wrong the moment a parent process captures its stdout. `execFile`,
`execFileSync` and `spawnSync` all pipe by default, and the exit wins the race
against the flush. The parent then reads a JSON document that stops mid-string.

## The measurement

A script that logs a payload of a given size and then exits, read back through
`execFile` with a 32 MB `maxBuffer`:

| payload | trials | whole | bytes through |
| --- | --- | --- | --- |
| 1,000 | 1 | 1/1 | 1,037 |
| 100,000 | 1 | 1/1 | 100,037 |
| 200,000 | 6 | **0/6** | 146,176 ×6 |
| 500,000 | 6 | **0/6** | 146,176 ×6 |
| 1,000,000 | 6 | **0/6** | 146,176 ×5, 182,720 ×1 |
| 5,000,000 | 6 | **0/6** | 146,176 ×6 |

The loss is total and reproducible: **0/24 whole above 200 KB**. Where it cuts
is **not** fixed — 146,176 is the modal value only, and 182,720, 657,792 and
730,880 have all been observed from the same probe (every value a multiple of
36,544, which reads as a race against however many pipe chunks have drained).

> **This corrects an earlier claim of mine.** `docs/tdd/2026-09-22-archetype-report-parse.md`,
> commit `c476c1a`'s message and PR #107's body all called this "a hard cliff
> just under 146 KB … the signature of a fixed buffer", on two runs. A third
> run contradicted it. The retraction is commit `3e2008a` on
> `claude/project-thread-o3wt2p-archetype-parse` (local, unpushed) and is in
> #107's body now. **Nothing in this unit asserts a byte count**, and nothing
> should: every end-to-end assertion here is "the whole report arrived and
> parsed", against a payload past any cut point yet seen.

## Which scripts are actually captured — the list I was handed was wrong both ways

The unit was briefed as five scripts, `promote-weekly-ensemble.mjs` first, on
the strength of a memory note **I wrote**. Reading the call sites rather than
the note: that note named three scripts nothing captures, and missed three that
something does.

| script | captured by | what its stdout carries | at risk today |
| --- | --- | --- | --- |
| `build-manager-archetypes.mjs` | `server/services/scheduler.js:637`, `execFile` | one **unbounded** JSON report, `--json` | **yes — fixed here** |
| `luck-panel.mjs` | `build-manager-archetypes.mjs:51`, `execFileSync` | one **unbounded** JSON report, `--json` | **yes — fixed here** |
| `collect-league-transactions.mjs` | `refresh-live-data.mjs:99`, `spawnSync` | a few human lines, summary last | mechanism yes, size no |
| `collect-roster-snapshots.mjs` | `refresh-live-data.mjs:114`, `spawnSync` | human lines, per team × week | mechanism yes, size maybe |
| `build-manager-signals.mjs` | `refresh-live-data.mjs:220`, `spawnSync` | a few human lines, summary last | mechanism yes, size no |
| `promote-weekly-ensemble.mjs` | **nothing** | small bounded objects; **the success path has no `exit()` at all** | no |
| `availability-decision-calibration.mjs` | **nothing** | a human report; the large payload goes to `writeFileSync`, not stdout | no |
| `import-alt-spreads.mjs` | **nothing** | unbounded `--json`, but betting-side and out of scope | no |

Two corrections worth stating plainly, because the brief rested on both:

- **`promote-weekly-ensemble.mjs` is the *least* exposed of the eight, not the
  most.** Its final statement is a `console.log` with no `process.exit` after
  it (`:342`), so its success path never races anything. Its JSON prints
  (`:163`, `:219`) are bounded objects of about ten keys, and each is followed
  by `process.exit(1)` on a failure path. The note's claim that "a truncated
  `--json` report would make a successful promotion read as a failure" was
  false twice over: there is no `--json` report at the end, and the success
  path does not exit.
- **The three `refresh-live-data.mjs` children fail *worse* than the two fixed
  here, on a smaller payload.** That parent reads
  `outputLines(r).filter(...).at(-1)` — the **last** line — and truncation cuts
  the **tail**, so the summary line is the first casualty. In
  `transactionsCapture` the parent then runs `/failed (\d+)/.exec(last)` to
  decide `ok`; losing the summary line yields `leaguesFailed = 0`, and with
  `r.status === 0` the loop logs **ok** off a stale earlier line. That is a
  silent misreport rather than a parse failure. Their payloads are a handful of
  lines per league, so this is a shape worth recording rather than a fault
  measured firing. **`refresh-live-data.mjs:101,123,232` reading `.at(-1)` off
  a captured pipe is its own finding**, and its own unit — a flush fix in the
  children would not make that read safe, only luckier.

## What changed

`scripts/lib/flush-then-exit.mjs`, new, two exported functions:

    writeThenExit(text, { code, stream, exit })
    printJsonThenExit(value, { code, stream, exit })

`stream` and `exit` are injectable so the ordering is assertable without
spawning; the scripts pass neither. The write callback fires when the bytes
have left the process, and only then does the exit run.

**The bytes do not move.** `printJsonThenExit` emits exactly what
`console.log(JSON.stringify(value, null, 2))` emitted, trailing newline
included, so both existing parsers — the scheduler's, and
`build-manager-archetypes.mjs:51` reading `luck-panel` — are untouched by this
change. One of the eleven injections checks precisely that.

**A stream error exits rather than waits.** A parent that closed the pipe must
not leave the child alive forever waiting to flush. Hanging is strictly worse
than the truncation this replaces: the scheduler would report the job killed on
its timeout and say nothing about why. There is no timer and no hang path — the
`write` callback fires on flush *or* error, the `'error'` listener is the
backstop, and an `exited` flag makes the exit idempotent.

**Three candidate fixes were measured**, all whole 5/5 at a 1 MB payload where
today's shape is 0/5:

    callback   process.stdout.write(payload + '\n', () => process.exit(0))
    exitcode   console.log(payload); process.exitCode = 0        // no exit()
    drain      write(), then exit on the 'drain' event if it returned false

`callback` is the one shipped. `exitcode` is the smaller diff but drops the
explicit exit these scripts rely on to come down with an open synchronous
`DatabaseSync` handle; `drain` is the same idea as `callback` with a hand-rolled
state machine in place of Node's own callback.

**Human-readable paths keep their `process.exit(0)`.** Nothing captures either
script without `--json`, and both print many small lines rather than one large
report. The change is the machine path and nothing else.

## TDD record

- **`d3b7a11` RED — 13 tests, 12 fail, 1 pass.** The pass is the CONTROL, and
  it passes at RED on purpose: it spawns today's shape at ~1 MB and asserts the
  output does **not** parse. It must pass before the fix and after it, because
  it is the only thing establishing that the end-to-end assertions are not
  vacuous on a machine where the flush happens to win. Its failure message says
  so, with the byte count it did get.
- **`acb18b0` GREEN — 13 tests, 13 pass, 0 fail.**
- **`dcca6c5`** — the sweep fix below.

## Mutation sweep: 11 applied, 11 killed; 1 invalid injection, 1 real gap

| # | injection | verdict |
| --- | --- | --- |
| M1 | exit before the write — **the actual bug**, in the helper | killed (9) |
| M2 | drop the once-only guard, so a late error exits twice | killed (1) |
| M3 | drop the `'error'` listener, so a closed pipe hangs | killed (1) |
| M4 | drop the trailing newline | killed (2) |
| M5 | indent 2 → none | **INVALID — see below** |
| M5b | indent 2 → none, in the code | killed (2) |
| M6 | ignore `code`, always exit 0 | killed (3) |
| M7 | revert `luck-panel.mjs` to `console.log` + `exit` | killed (1) |
| M8 | revert `build-manager-archetypes.mjs` to `console.log` | **SURVIVED — real gap** |
| M8b | the same, after `dcca6c5` | killed (1) |
| M9 | never exit at all | killed (5) |
| M10 | `printJsonThenExit` swallows `code` | killed (1) |
| M11 | `process.stdout.write(...)` then `exit(0)`, no `console.log` | killed (1) |

**M5 was not a mutation.** `perl -0p` with a non-global `s///` replaced the
first occurrence in the file, which was in the **doc comment**, not the code.
The behaviour was unchanged, so its "survival" said nothing. Re-run as M5b
against the code, it dies. This is the second invalid injection of this class
in two units; the lesson is to assert the injection applied to the *code* before
reading its verdict, which the second sweep script does with a `grep -q`.

**M8 was a real gap, and `dcca6c5` closes it.** The guard asserted only that
`lib/flush-then-exit.mjs` appeared in the source. An injection that put
`console.log(JSON.stringify(...))` back while leaving the now-unused import in
place satisfied that and survived — which is exactly the regression a later
edit would make. Two narrowings: assert `printJsonThenExit(` is actually
**called**, and forbid `console.log(JSON.stringify(` outright rather than only
when a `process.exit` follows within a few lines. Proximity was the hole — the
mutated code had a closing brace and two comment lines in between, which the
old regex did not span. Neither script has another such call (`grep`: none), so
the absolute rule costs nothing. M11 confirms the new shape holds against a
break that does not contain the words `console.log` at all.

## The five questions

**Is it well built?** The fix is Node's own write callback rather than a
hand-rolled drain, and the injectable `stream`/`exit` are what let the *ordering*
be asserted without spawning a process — the eight unit tests run in
milliseconds. The honest weakness is the two source-shape guards: they read the
scripts as text, which pins the shape but not the behaviour. A behavioural test
of either script end to end needs a populated league database and several
minutes, so the guards plus the spawn tests over a fixture are the trade made.
The second weakness is that this fixes the producer for two of seven captured
scripts and leaves a worse consumer-side read (`refresh-live-data.mjs`'s
`.at(-1)`) untouched and named.

**Is it statistics or is it made up?** Neither — no number this project reports
moves. The one measurement is the truncation probe, with its trial counts in
the table above, and the one inference two runs did not support is retracted
rather than left standing.

**How do we know?** Thirteen tests: eight over the helper with an injected
stream, four end to end through a real pipe (`execFile`, `execFileSync`, and
the control that proves they can fail), and two source-shape guards. Eleven
injections applied, eleven killed, with one invalid injection and one real gap
recorded as such rather than folded into the total.

**Is it pointed anywhere else?** Yes, and the capture table above is the
finding, not the two-file diff. Three scripts under `refresh-live-data.mjs` are
captured and were not on the list I was handed; three that were on it are
captured by nothing. The `.at(-1)` read is the item most worth someone's next
unit, because a flush fix in its children would not make it safe, only luckier.

**How does it unify?** The same rule as the freshness and archetype work: a
layer must not be able to report success off data it never received. There the
instrument was satisfied by absence; here the parent is handed a report that
stops mid-sentence, and in the `refresh-live-data.mjs` case reads the wrong
line as the summary and logs `ok`.
