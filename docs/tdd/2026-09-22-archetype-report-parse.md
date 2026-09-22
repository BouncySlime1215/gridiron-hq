# The archetype build's failure row says which failure it was

**Date:** 2026-09-22
**Branch:** `claude/project-thread-o3wt2p-archetype-parse`, off `main` at `654ff93`
**Files:** `server/services/scheduler.js`, `test/archetype-report-parse.test.js`

## The claim, in one sentence

`refreshManagerArchetypes` collapsed three different failures of the archetype
build into one sentence — *"the archetype build printed no JSON summary"* — and
for one of the three that sentence is false, because the script printed a great
deal of JSON and only its tail was lost.

## The three states, and why one sentence is not enough

| what happened | where to look | what the row used to say |
| --- | --- | --- |
| nothing parseable on stdout | the script — it died before printing | printed no JSON summary |
| JSON that will not parse | the pipe — it printed and the output is damaged | printed no JSON summary |
| JSON with no `summary` key | the report — it printed fine and the shape changed | printed no JSON summary |

The middle one is the one worth the most, and it is measured rather than
imagined.

### The measurement: `process.exit` does not flush a pipe

`scripts/build-manager-archetypes.mjs` ends with `process.exit(0)` immediately
after `console.log` of the whole report. With stdout a pipe under `execFile`,
that truncates. Probed on this container — a script that logs a payload of a
given size then calls `process.exit(0)`, read back through `execFile` with a
32 MB `maxBuffer`:

| payload | bytes through | parse |
| --- | --- | --- |
| 1,000 | 1,037 | OK |
| 100,000 | 100,037 | OK |
| 1,000,000 | **146,176** | `Unterminated string in JSON at position 146176` |
| 5,000,000 | **146,176** | same |

A hard cliff just under 146 KB, identical at 1 MB and at 5 MB, which is the
signature of a fixed buffer rather than of a size-dependent effect. The report
contains `summary`, `repeatability`, `reliability` and `jev`, pretty-printed at
two-space indent, and it grows with the number of leagues — so this is a cliff
the report moves towards rather than one it is safely far from.

**When it is crossed, the old message sends the reader to the one place that is
definitely not wrong**: a script that is not printing. The new message reports
the parse error verbatim and the byte count beside it, so a failure sitting at a
suspiciously round number reads as a truncated pipe immediately.

**The flush is not fixed here.** It is `scripts/build-manager-archetypes.mjs`'s
to fix — dropping `process.exit(0)`, or exiting after a flush — and that file is
outside this unit. Recorded so the next person does not have to re-measure it.

### The brace search was fragile rather than broken

The old code found the report with `stdout.indexOf('{')` — the **first** brace
anywhere in stdout. It works today, and only because `--json` suppresses the
human report, whose second line is
`console.log(\`consensus source by season: ${JSON.stringify(...)}\`)`
(`build-manager-archetypes.mjs:74`, inside `if (!AS_JSON)`).

That is an accident one refactor away from a silent regression: move that line,
or add any diagnostic that prints an object, and a successful build starts
reporting itself as having printed nothing. The two stdout writers the import
path does have (`server/db/index.js:128,130`, the pre-migration backup lines)
print plain paths with no brace, and the child `luck-panel.mjs` run at
`build-manager-archetypes.mjs:50` is captured with `execFileSync` rather than
inherited, so neither reaches the parent's stdout today.

The search now runs from the **end** of stdout to the last line beginning with
`{` in **column zero**, which is exactly what
`console.log(JSON.stringify(x, null, 2))` produces for a top-level object and
what nothing nested produces (`  "summary": {` begins with spaces).

## RED

`f4500b7` — **8 tests, 8 fail**, all on `parseArchetypeReport is not a function`.

**Correction to that commit's own message, which says "nine tests" twice: there
are eight.** The count was written before the file was run and never
re-checked; `--amend` is not available in this environment, so it is corrected
here and in the GREEN commit rather than by rewriting history. The RED result
itself — 8 of 8 failing on the missing export — is what the log shows.

Three further tests were added during GREEN, taking the file to eleven, each
because a mutation showed the suite could not see something:

- a top-level JSON object printed at column zero **before** the report. Without
  it, searching forward and searching backward give the same answer on every
  fixture, so "from the end" was incidental rather than pinned (mutation 2).
- the spawn-error describer, twice. The `maxBuffer` message improvement was
  going to ship untested, so it was extracted into
  `describeArchetypeSpawnError(err, limit)` and pinned instead — including that
  a timeout must not be described as a buffer overflow.

## GREEN

`parseArchetypeReport(stdout)` is a pure function over a string, so none of this
needs a populated database or the several minutes the real build takes. It
returns either the summary row or a failure carrying four fields — `error`,
`tail`, `parse_error`, `stdout_bytes` — on **every** failure, so a reader never
meets an `undefined` on one path and a value on another.

`describeArchetypeSpawnError(err, limit)` rewrites the message of an overflowing
or killed child and hands the same error object back. **The control flow is
deliberately unchanged**: an overflowing child is a job failure and must throw,
never become a summary row saying everything is fine. Only the message changes,
and Node's own text is kept inside the new one rather than replaced.

**11 tests, 11 pass, 0 fail.**

## Mutation sweep — 9 applied, 9 killed

| # | injection | result |
| --- | --- | --- |
| 1 | back to `indexOf('{')`, the first brace anywhere | killed (2 tests) |
| 2 | search forward through the lines instead of backward | killed |
| 3 | malformed JSON collapses back into "printed no JSON at all" | killed |
| 4 | a missing `summary` collapses into "printed no JSON at all" | killed |
| 5 | the caught parse error is discarded again | killed |
| 6 | `stdout_bytes` dropped from the failure shape | killed (3 tests) |
| 7 | the tail is left unbounded | killed |
| 8 | a timed-out child is described as a buffer overflow | killed |
| 9 | the describer replaces Node's own message instead of keeping it | killed |

Mutations 2, 8 and 9 each killed only because a test was added for them during
GREEN; before that they survived. They are listed as killed because the suite
that ships kills them, and named here because the suite that was written first
did not.

## The five questions

**Is it well built?** The parsing moved out of the job body into a pure function,
which is what made nine injections cheap to run and what makes the truncation
case testable at all. The `startsWith('{')` at column zero is a convention rather
than a parse, and that is the honest weakness: it is exactly right for
`JSON.stringify(x, null, 2)` through `console.log` and would need revisiting if
the report were ever printed some other way. The alternative — a real streaming
parse — is more machinery than a job summary warrants.

**Is it statistics or is it made up?** Neither. No number moves; this is what the
job says when it cannot read its own child's output. The one measurement here is
the truncation probe, and its table is above with the sizes it was run at.

**How do we know?** Eleven tests over constructed stdout, one per state plus the
shape and bound assertions; nine injections, all killed; and the truncation cliff
measured at four payload sizes rather than asserted. The measurement is
reproducible from the probe described above.

**Is it pointed anywhere else?** Two places. The flush bug belongs to
`scripts/build-manager-archetypes.mjs` and is recorded, not fixed. And the shape
generalises: any job in `scheduler.js` that parses a child's stdout has the same
three states, and none of them distinguishes them today — that is a sweep worth
doing, not a change to smuggle into this diff.

**How does it unify?** It is the same rule as the freshness work earlier tonight:
a layer that fails must say **what** failed, not merely that something did. There
the instrument was satisfied by absence; here the report was satisfied by three
different absences at once and named the wrong one.
