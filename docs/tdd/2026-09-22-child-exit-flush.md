# The three captured children flush before they exit

Branch `claude/project-thread-o3wt2p-child-flush`, **off
`claude/project-thread-o3wt2p-flush-then-exit` @ `19f4b35`**, not off `main` —
it uses that branch's helper, and stacking is the honest representation of the
dependency. RED `9cd43e5` · GREEN `2e1dda7`.

This is the **producer half** of `2026-09-22-child-report-never-arrived.md`.
That unit stopped the parent reading a lost report as a success; this one means
there is far less often a lost report. **Neither makes the other redundant**: a
pipe can still be cut by something other than an unflushed exit, and a fix in
three scripts does not help a parent that misreads what does arrive.

## The defect

    scripts/collect-league-transactions.mjs   captured by refresh-live-data.mjs:99
    scripts/collect-roster-snapshots.mjs      captured by refresh-live-data.mjs:114
    scripts/build-manager-signals.mjs         captured by refresh-live-data.mjs:220

All three end in a bare `process.exit(...)` with output still buffered, and all
three are read through a pipe (`spawnSync`). **The summary line is the last
thing each prints, so it is the first thing a truncated pipe loses — and it is
exactly the line the parent reads to decide whether the run succeeded.**

## The measurement, and a shape worth noting

8,000 printed lines, read back through `execFile`:

| | lines delivered, of 8,000 |
| --- | --- |
| `process.exit(0)` | **2,812 · 3,311 · 2,435 · 1,433** |
| `exitWhenFlushed(0)` | **8,000 · 8,000 · 8,000 · 8,000** |

With many small lines the loss is **partial and varies run to run**, where the
single-large-payload case in `19f4b35` was **total** above 200 KB. Same cause,
different shape — and a third independent confirmation that the cut point is not
a constant, which is the claim retracted in `2026-09-22-archetype-report-parse.md`.
Nothing here asserts a byte or line count; every assertion is "all of it arrived".

## What changed

`exitWhenFlushed(code)` on the existing helper, for a script that has nothing
left to write and simply needs to come down. One line at each of the three call
sites, plus the import.

**The empty write is the mechanism, not a trick.** Stream writes are ordered, so
an empty chunk's callback cannot fire until every chunk queued before it has
drained. That was measured before it was relied on — it is the whole reason this
can be one line per script instead of restructuring three scripts' output. And
nothing is added to the output: a stray byte would land inside a report another
process parses.

## TDD record

- **`9cd43e5` RED — 10 tests, 9 fail, 1 pass.** The pass is the CONTROL: it
  spawns today's shape and asserts output is *lost*. It must pass before and
  after, or every assertion around it is vacuous.
- **`2e1dda7` GREEN — 10 tests, 10 pass.** Related suites unchanged:
  `flush-then-exit`, `refresh-loop-steps`, `refresh-loop-child-outcome` 32/32;
  `manager-data-pipeline`, `manager-signals-api`, `roster-snapshots` 51 pass,
  0 fail, 1 skipped.
- **11 tests** after the sweep fix below.

## Mutation sweep: 7 applied and killed, 1 real gap, 5 invalid attempts

| # | injection | verdict |
| --- | --- | --- |
| N1c | `exitWhenFlushed` exits without flushing — **the bug itself** | killed (4) |
| N2b | it writes a newline of its own | killed (2) |
| N3b | it ignores its code | killed (3) |
| N4 | transactions collector reverts to `process.exit` | killed (1) |
| N5 | roster snapshots reverts to `process.exit` | killed (1) |
| N6b | manager signals reverts to `process.exit` | killed (1) |
| N7 | roster snapshots discards `main()`'s exit code | **survived — REAL GAP** |
| N7c | the same, after the test below | killed (1) |

**N7 was a real gap.** Replacing `exitWhenFlushed(await main())` with
`await main(); exitWhenFlushed(0)` survived every test. All of them checked that
the *output* arrived; none checked that the script still reports *how the run
went*. Silently exiting 0 on a failed snapshot run is the same class of defect
this pair of units exists to fix — a caller told it succeeded when it did not —
and `refresh-live-data.mjs:114` branches on exactly that status. A test now pins
it.

## The sweep harness was the other finding

**Five injection attempts were invalid, and one of them produced a false
result that looked like a serious gap in the core function.**

N1 reported *"applied"* and *survived* — which read as: the central function can
be replaced by an immediate exit and no test notices. That would have been the
worst possible gap. It was not true. The applied-check was a
`grep -qF '  exit(code);'`, and that string **already existed elsewhere in the
file**, inside `writeThenExit`'s own `finish`. The substitution never landed;
the grep matched the pre-existing copy and reported success.

So: **grepping for a string that may already exist is not a check that an
injection applied.** The harness now compares the file's checksum before and
after, which cannot be fooled this way, and N1c — the same injection, correctly
applied — dies against four tests.

This is the third refinement of the same practice in one day, each from a real
misfire:

1. `perl -0p` with a non-global `s///` replaces the **first** match, usually in
   a doc comment. Two invalid "survivors".
2. `sed -i` with no line address replaces on **every** line. One injection hit
   13 real call sites and produced two phantom failures.
3. A `grep` applied-check passes on a **pre-existing** occurrence. One phantom
   survivor, in the most alarming possible place.

The rule that covers all three: **an injection's verdict is only readable if the
file demonstrably changed and the baseline is demonstrably green.** Both are now
printed on every line of the sweep.

## The five questions

**Is it well built?** One named function, four unit tests over an injected
stream, four end to end through a real pipe, three source guards and one
exit-code guard. The change at each call site is a single line, which is what
keeps three scripts owned by nobody in particular reviewable. The honest
weakness is the source guards: they read the scripts as text, so they pin the
shape and not the behaviour. Running the real scripts needs a populated database
and live ESPN credentials, so the fixtures plus the guards are the trade.

**Is it statistics or is it made up?** Neither; no number this project reports
moves. The one measurement is the delivery table above, with its four trials per
arm, and the one inference it does **not** support — a fixed cut point — is
explicitly not claimed.

**How do we know?** Eleven tests, including a control that asserts the *old*
shape still fails. Seven injections applied and killed, one real gap found and
closed, five invalid attempts recorded as invalid rather than counted either way.

**Is it pointed anywhere else?** Yes. Five scripts in this repository were
originally enumerated as having this shape; the two that print unbounded reports
were fixed in `19f4b35`, these three are fixed here, and the remaining ones named
in that file's table are captured by nothing today. If anything ever captures
`promote-weekly-ensemble.mjs`, `availability-decision-calibration.mjs` or
`import-alt-spreads.mjs`, they need the same one-line change.

**How does it unify?** The same rule as the freshness registry, the archetype
parse, the orphaned epoch fit and the consumer half of this unit: **a layer may
not report success off data it never received.** This is the one place in that
series where the fix is on the sending side — the others all taught a reader to
notice. Both halves are needed, and that is the point.
