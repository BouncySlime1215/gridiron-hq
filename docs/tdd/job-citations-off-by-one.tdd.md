# Every job citation in the wiring map pointed at the wrong line

RED `d256949` · GREEN this commit · `scripts/wiring-map.mjs`, `test/wiring-map.test.js`

## What was wrong

The map emits one surface per scheduler job, each with a `line`. Every one of
those line numbers was wrong, and had been since the map was written.

Each job was cited at the *previous* entry's line:

| job | map said | what is actually on that line |
| --- | --- | --- |
| `mlb_schedule` | `:1190` | `export const JOBS = {` |
| `mlb_logs` | `:1191` | `mlb_schedule: { run: refreshMlbSchedule, ...` |
| `mlb_boxscores` | `:1192` | `mlb_logs: { ...` |
| `player_rosters` | `:1195` | `mlb_tomorrow_picks: { ...` |
| `ffopportunity` | `:1529` | `// them every three days — see refreshFfOpportunit...` |

Measured rather than sampled: of 62 job surfaces, the number cited at a line
containing their own key was **0**. Several landed on a `*/` closing a comment.

The cause is one expression at `scripts/wiring-map.mjs:676` as of the RED
commit `d256949`; the fix moves it to :681, and the citation is given against
the tree that still holds the defect so it resolves. `RE_JOB` opens
with `(^|[\n{,])`, so `m.index` is the offset of the leading delimiter — the
comma that *ends* the previous entry — and not of the name that follows it.

## How it was found, which matters more than the bug

Not by this test. The inventory generator was rendering job paths as
`null:1280`, and the `null` was the part that looked like the defect. Reading
the surrounding rows to fix it showed the line numbers were wrong too, on all
62 rows including the 8 where the path resolved fine.

The confirming reading came from outside this branch. The scheduler thread
cited `server/services/scheduler.js:1196` for `refreshPlayerRosters` from
their own reading of the file, before this map existed to disagree with them.
Line 1196 is `player_rosters: { run: refreshPlayerRosters, maxAgeMinutes: 3 *
60, tier: 'live',`. They were right and the map was wrong, so their number is
pinned as an assertion: a fix that cannot reproduce a figure somebody already
got by hand is a second guess, not a fix.

## What was NOT wrong

The census. 62 job surfaces against 62 top-level keys in `JOBS`, no phantoms,
every name resolving to a real key; tiers and labels are sound. Only the line
was off. Recorded because the natural over-correction is to distrust the whole
job section.

`file: null` on 54 of the 62 is also correct and is kept. The map refuses to
attribute an unresolved job to `scheduler.js`, because doing so would make
every such job appear to reach every module the scheduler imports. The fault
there was in the *generator*, which printed the string `"null"` instead of
reading the `unresolved` flag beside it.

## The fix

```js
-      line: lineOf(code, open + m.index),
+      line: lineOf(code, open + m.index + m[0].lastIndexOf(m[2])),
```

## Defect injection

Each row: the exact edit, the tree's sha256 (first 16 hex of
`sha256sum scripts/wiring-map.mjs`), and the killing tests **by title**.
Baseline green is 86 pass / 0 fail at `6edaa907cf589abf`.

### J1 — restore the original defect · `5380446f72edcea9` · **KILLED** (84/2)
```
-      line: lineOf(code, open + m.index + m[0].lastIndexOf(m[2])),
+      line: lineOf(code, open + m.index),
```
KILLED BY: *schedulerJobs cites each job at the line its own key is on*
KILLED BY: *every job in the real scheduler is cited at a line holding that job key*

### J2 — `lastIndexOf` to `indexOf` · `8933ccfe082feec1` · **SURVIVED** (86/0)
```
-      line: lineOf(code, open + m.index + m[0].lastIndexOf(m[2])),
+      line: lineOf(code, open + m.index + m[0].indexOf(m[2])),
```
Survived, and correctly so. `m[0]` is `<delim><ws><name>:<ws>{`, in which the
name occurs exactly once, so the two are the same offset on every input the
grammar admits. This is a finding about the code, not the test: the
`lastIndexOf` is defensive against a case that cannot arise, and no test can
distinguish it because no input can. Left as-is rather than weakened, but it
is not load-bearing and should not be read as if a test were holding it.

The same row records the boundary of what these tests constrain: they pin the
**line**, not the column. An injection adding `+ 1` to the offset would also
survive, because a job name does not span a newline. That is deliberate — the
claim the map makes is a line citation.

### J3 — `lineOf` counts from zero · `034a467ec5046e2e` · **KILLED** (83/3)
```
 function lineOf(text, idx) {
-  let l = 1;
+  let l = 0;
```
KILLED BY: *declarations sees a computed value that is never used again*
KILLED BY: *schedulerJobs cites each job at the line its own key is on*
KILLED BY: *every job in the real scheduler is cited at a line holding that job key*

### J4 — drop `{` from the delimiter class · `54c95b2ae01b1d8f` · **NO-OP, misdesigned**
```
-  const RE_JOB = /(^|[\n{,])\s*([a-z][\w]*)\s*:\s*\{/g;
+  const RE_JOB = /(^|[\n,])\s*([a-z][\w]*)\s*:\s*\{/g;
```
Intended to drop the first job and test the census. It drops nothing: the
first job sits on its own line, so the `\n` after `export const JOBS = {`
still matches. Recorded as written rather than quietly replaced, because a
mutation that changes nothing proves nothing about the suite, and reporting it
as a second control would be a nicer story than the truth, which is that the
injection was chosen badly. J4b is the one that does the work.

### J4b — name class loses digits · `9b047c4818c84393` · **KILLED** (85/1)
```
-  const RE_JOB = /(^|[\n{,])\s*([a-z][\w]*)\s*:\s*\{/g;
+  const RE_JOB = /(^|[\n{,])\s*([a-z][a-z_]*)\s*:\s*\{/g;
```
Drops `nfl_t60_runner` and every other job with a digit in its name.
KILLED BY: *every job in the real scheduler is cited at a line holding that job key*

This one changed the test. At first attempt the census was not asserted at
all, so a dropped job left every surviving citation correct and the suite
green. The count assertion was added in response, and it is counted a
different way than the scanner counts it — a line-anchored match over the
`JOBS` block, sharing none of the offset arithmetic — so the two agreeing is
evidence rather than a tautology.

### J6 — emit each job twice · `c8b06598973af1ed` · **KILLED** (83/3)
```
+    jobs.push(jobs.length ? jobs[jobs.length - 1] : { name: m[2], tier, label, runFn: fn, runModule: null, line: 1 });
     jobs.push({
       name: m[2], tier, label, runFn: fn,
```
KILLED BY: *schedulerJobs reads both shapes of run:*
KILLED BY: *schedulerJobs cites each job at the line its own key is on*
KILLED BY: *every job in the real scheduler is cited at a line holding that job key*

### J5 — control, comment text only · `c9cd948792ec0418` · **SURVIVED** (86/0)
```
-      // job). Seeking to the name inside the match
+      // job). NO-OP CONTROL. Seeking to the name inside the match
```
Must survive, and does. A suite that fails here is failing on the text of the
file rather than on its behaviour.

## The five questions

**Well built?** The fix is one expression and the tests are behavioural — they
call `schedulerJobs` and read what comes back, rather than matching a regex
against the scanner's own source, which is the failure this suite has already
hit once.

**Stats or made up?** Measured. 62 surfaces, 0 cited correctly before, 62
after; 62 top-level `JOBS` keys counted independently of the scanner.

**How do we know?** `node --test test/wiring-map.test.js` — 84/2 at RED
`d256949`, 86/0 at GREEN. Six injections, four killed with the killing tests
named, one survivor explained, one control, one misdesign recorded as such.

**Pointed anywhere else on the platform?** Yes, and that is the cost. The job
line numbers feed `docs/inventory/inventory.json`, so 62 inventory rows were
carrying a citation that does not resolve. The scheduler thread's own reading
was never derived from this map, so nothing downstream had to be corrected —
that is luck, not design.

**How does it unify?** It is the branch's own claim turned on itself: a
citation is a promise. This map has been checking whether the repository's
citations resolve while emitting 62 that do not.
