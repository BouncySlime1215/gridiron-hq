# A child that never reported is not a child that succeeded

Branch `claude/project-thread-o3wt2p-refresh-lastline`, off `main` **654ff93**.
RED `372890e` · GREEN `ea54eaf`.

## The defect

`scripts/refresh-live-data.mjs` spawns four children with `spawnSync` — whose
stdio is a **pipe** — and read three of their results off the **end** of the
output:

    :101  transactionsCapture    outputLines(r).filter(...).at(-1)
    :123  rosterSnapshots        lines.filter(/^roster_snapshots:/).at(-1) ?? lines.at(-1)
    :232  managerSignals         lines.at(-1)

Truncation cuts the **tail**, so the summary line is the **first** casualty. And
every one of these children ends in a `process.exit`, which does not flush a
pipe — measured separately at 0/24 whole payloads above 200 KB
(`docs/tdd/2026-09-22-flush-then-exit.md`).

The worst of the three is `transactionsCapture`, because its failure is silent
rather than loud:

```js
const last = outputLines(r)...at(-1) ?? spawnFailure(r) ?? `exit ${r.status}`;
const leaguesFailed = Number(/failed (\d+)/.exec(last)?.[1] ?? 0);
const ok = r.status === 0 && leaguesFailed === 0;
```

The collector exits 0 whether or not leagues failed — its own comment says so.
So when the summary is lost, the regex matches nothing, `leaguesFailed` is 0,
and the loop logs **ok**. **The absence of the summary is read as the absence of
problems.** Nothing is thrown, nothing is recorded, and the line a person reads
says the capture succeeded.

A second, independent defect in the same function: `spawnFailure(r)` appears
only as a fallback for the summary *text* (`?? spawnFailure(r)`). A child that
overflowed its buffer or died on a signal is therefore **ignored outright** as
long as any line arrived before it died.

## The file already knew how to do this

`parseChatStatus` (`:236`) reads the fourth child — the chat extractor — by its
**marker**, returns `null` when the line is absent, and the comment above it
states the contract plainly: `'error'` when the run failed, "non-zero exit, **or
no status line**".

So this is not a new convention being imposed. One of four children was read
correctly and three were not. The fix holds the other three to the pattern the
file already documents.

## What changed

`childOutcome(r, { marker })` finds the summary by marker rather than by
position and returns `{ ok, truncated, summary, lines, text }`. The three call
sites go through it:

| site | marker | the child already prints |
| --- | --- | --- |
| `transactionsCapture` | `/^transactions: seen \d+/` | `transactions: seen N, new N, failed N` |
| `rosterSnapshots` | `/^roster_snapshots:/` | `roster_snapshots: …` |
| `managerSignals` | `/^manager_signals:/` | `manager_signals: <status> in N ms` |

**No child script changes, and that was a constraint rather than a convenience.**
The unit was briefed to add "a structured last-line marker the child writes only
on completion", which cannot be done without editing
`collect-league-transactions.mjs`, `collect-roster-snapshots.mjs` and
`build-manager-signals.mjs` — three scripts this unit does not own, and which the
same brief put out of scope. Each already prints a recognisable summary, so the
parent can tell *"the child said nothing"* from *"the child said it was fine"*
with no protocol change at all. A new marker would also have stayed unreliable
until those scripts' flush is fixed, since a marker printed last is the first
thing a truncated pipe loses.

Three behaviour changes, each pinned by a test:

- **`transactionsCapture` reads `failed N` only from a summary that arrived.**
- **`spawnFailure` is checked first and unconditionally**, not as a fallback.
- **`manager_signals` freshness keys off the outcome, not the exit status.**
  Caching a truncated run as a success skips the next six hours of rebuilds on a
  run nobody can show completed — worse than the wrong log line it also produced.

`truncated` separates the two states a reader must act on differently: the child
said it failed (look at the child) versus the child never got its report out
(look at the pipe, or at what killed it mid-run). A truncated roster or signals
run also records an error row rather than only logging one.

## TDD record

Cited in the format the fleet uses: PR, commit subject, sha.

- **RED** — PR #123, `test: RED — a truncated child report must not be logged as ok`, `372890e1`
- **GREEN** — PR #123, `fix: a child that never reported is not a child that succeeded`, `ea54eaf2`

### The RED failure, as it printed

Two of the twelve, carried inline so the claim can be read without checking the
tree out. The second is the defect in one line — a run whose report never
arrived, logged as `ok`:

```
not ok 1 - a summary line that is present is found and reported
  error: 'LOOP.childOutcome is not a function'
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'

not ok 12 - rosterSnapshots: a truncated report is ERROR, not ok
  error: 'a truncated snapshot run logged: 17:29:31 roster_snapshots   ok league 3 period 2 written (0 ms)'
  code: 'ERR_ASSERTION'
```


- **`372890e` RED — 15 tests, 12 fail, 3 pass.** The three that pass are
  regression guards and must hold before and after: a good run is still `ok`,
  failing leagues are still `ERROR`, and no secret reaches the log line.
- **`ea54eaf` GREEN — 15 tests, 15 pass.** The existing
  `test/refresh-loop-steps.test.js` stays **19/19**, unchanged.
- **`c79f445` — 17 tests, 17 pass**, after the sweep's real gap added two more
  secret-path tests. That is the figure on this branch's head.

**Correction, 2026-09-22 16:4xZ.** The two lines above previously read "17 tests,
12 fail, 5 pass" for the RED commit and "17 tests, 17 pass" for GREEN. Both
counted the FINAL file's 17 tests back onto commits where the file had 15, and
"5 pass" was wrong on its own terms — 3 passed. The corrected numbers were
measured, not recalculated: each commit was checked out into its own worktree and
the file run against that tree.

```
372890e:  # tests 15  # pass 3   # fail 12
ea54eaf:  # tests 15  # pass 15  # fail 0
c79f445:  # tests 17  # pass 17  # fail 0
```

This is the failure mode the mutation-sweep hygiene rule exists for, one level
up: a number that was derived rather than read. It was caught by the Evidence
Auditor, not by this thread.

## Mutation sweep: 10 applied, 8 killed, 1 equivalent, 1 real gap

| # | injection | verdict |
| --- | --- | --- |
| M1 | a missing summary falls back to the last line — **the original bug** | killed (6) |
| M2 | `spawnFailure` checked last instead of first | killed (1) |
| M3 | marker search becomes positional again | killed (6) |
| M4 | `truncated` always false | killed (2) |
| M5 | read `failed N` from `text` | **NOT APPLIED — invalid** |
| M5b | the same, applied | **survived — EQUIVALENT, see below** |
| M6 | freshness keyed off exit status again | killed (1) |
| M7 | secret filter dropped | **survived — REAL GAP** |
| M7b | the same, after the two tests below | killed (2) |
| M8 | non-zero exit reported as ok | killed (3) |
| M9 | `transactionsCapture` ignores the failed-league count | killed (2) |

**M7 was a real gap, and the test that should have caught it was weak in a way
worth naming.** "Secrets never reach the log line" passed with the filter
removed, because on a **good** run the logged line is the matched summary — and
a credential would never be inside that. The two paths that actually quote the
child's own output back are the truncated one (which prints the last line it did
see) and the non-zero-exit one (which joins the child's problem lines). Tests for
both were added; `M7b` dies on both. A secrets test that only exercises the happy
path is close to no test at all, and this project's rule on credentials is
absolute, so this is the finding of the sweep rather than a footnote.

**M5b is an equivalent mutant, not a gap**, and the case analysis rather than an
assertion: `leaguesFailed` is read at exactly one place (`:155`,
`ok = outcome.ok && leaguesFailed === 0`) and nowhere else. When `outcome.ok` is
false, `ok` is false whichever string was parsed. When `outcome.ok` is true, the
only `ok: true` return (`:140`) sets `text: summary`, so the two are the same
string. No reachable state distinguishes them. Reading from `summary` is kept
anyway, because it stays correct if someone later removes the `outcome.ok &&`
coupling — defence in depth, not a live behaviour difference.

**M5's "survival" was invalid and is recorded as such**: the `perl` substitution
did not apply. Every injection in this sweep was `grep`-checked for having
actually landed before its verdict was read, after three global-substitution
errors earlier the same day — one `sed` without a line address that hit 13 call
sites, and two `perl -0p` substitutions that landed in doc comments.

## The five questions

**Is it well built?** The reader is one small pure-ish function over a `spawnSync`
result, which is what made ten injections cheap. It follows a pattern the file
already contained rather than inventing one, and it needs nothing from the child
scripts. The honest weakness: the markers are regexes over the children's current
output, so a child that renames its summary line silently becomes "truncated" on
every run. That fails **loud and safe** rather than silent, which is the right
direction, but it is a coupling and it is not tested against the real children —
doing that needs a populated database and live ESPN credentials.

**Is it statistics or is it made up?** Neither. No number this project reports
moves. The one measurement behind it — that a captured report is truncated at all
— was made separately, with its trial counts, in the flush unit's evidence file,
and nothing here asserts a byte count.

**How do we know?** Seventeen tests: eight over the reader with constructed
`spawnSync` results, six through the three real call sites with an injected
spawn, three on the credential paths. Ten injections applied, eight killed, one
equivalent and one real gap — each of those two argued rather than asserted.

**Is it pointed anywhere else?** Yes, and this unit is itself the follow-through
of one such pointer: the flush unit fixed the two children whose reports are
**unbounded** and captured, and named these three as a worse-shaped failure on a
smaller payload. **The producers are still unfixed.** These three children still
`process.exit` without flushing, so their reports can still be lost — the
difference is that losing one is now reported instead of being read as success.
The remaining producer-side work is a one-line change in each of the three, and
it belongs to whoever owns them.

**How does it unify?** The same rule as the freshness registry, the archetype
parse and the flush fix: **a layer may not report success off data it never
received.** There the instrument was satisfied by absence; here the parent
matched a regex against a line that was never the report, got no match, and read
"no failures" out of "no answer".
