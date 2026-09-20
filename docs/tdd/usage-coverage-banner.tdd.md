# usage-coverage-banner — TDD report

**Item:** The setup banner could not tell "this source never ran" from "this
source ran, reported success, and wrote nothing". The second is the state this
install is in, and it renders as a healthy app.

**Files changed:** `client/src/lib/usage-coverage.js` (new),
`client/src/lib/usage-coverage.d.ts` (new),
`client/src/components/DataSetupBanner.tsx`,
`test/usage-coverage-banner.test.js` (new), this document.

No server file. `server/routes/model.js` belongs to the wiring-map thread and
is only read here; the field this renders is specified in §5 for them to serve.

**Branch:** a `-hold` branch in this thread's namespace. No PR, no deploy, no
database touched.

---

## The five questions

**Is this well built?** It is a rendering change plus a contract the server does
not serve yet. The banner is correct before and after the field arrives: with no
field there is no claim, and the existing `needs_setup` behaviour is untouched.

**Is this based on stats, or is it made up?** Neither — it is a state machine
over a field, and its whole point is to stop a *made-up* impression: an app that
looks healthy while projecting this season off last season's usage.

**How do we know?** Sixteen mutations at the stack tip, each proved applied by
its file's SHA-256 before and after, each named with the test title that turned
red, each quoting its exact before and after text. Two deliberate no-op controls
were applied and survived. One mutation survived its first run and is written up
in §4, because a survivor is a finding.

**Should this data be pointed anywhere else on the platform?** Yes, and §5 says
where: the same question — does this table hold rows for the season being
played — is the one the Settings freshness card answers per source, and the two
should read from one computation rather than two.

**How does it unify?** It applies the availability vocabulary's rule one surface
over: a value this build does not recognise gets its own visible state and is
never folded into the healthy one.

---

## 1. The defect

`GET /api/model/setup-status` (`server/routes/model.js:685`) builds its answer
from one predicate:

```js
const missing = sources.filter(s => s.last_status === 'never run').map(...)
res.json({ needs_setup: missing.length > 0, missing, checked: sources.length + 1 });
```

`last_status` comes from `source-registry.js:216`, which reads the last logged
run. A source that ran, logged `ok`, and inserted zero rows is not `'never run'`,
so it is not in `missing`, so `needs_setup` is false and the banner returns
`null` before rendering anything.

**This is the live state.** The weekly usage source is stamped `ok`;
`player_week_usage` holds 2021 through 2025 and nothing for the season being
played. Nothing failed. Nothing said anything. Every page that needs this
season's usage is serving an earlier season's, silently — which is the exact
failure mode `CLAUDE.md` names: *"If a layer goes inert, the surface must say
so."*

## 2. Four states, and why the fourth is different

| State | Means | Retry? |
|---|---|---|
| `healthy` | rows for the season being played, up to about the current week | — |
| `never_run` | the source has not run: a fresh clone | yes |
| `stale` | it ran and has rows, but they stop short of the current week | yes |
| `ok_no_rows` | **it reports success and the table has no rows for this season** | **no** |

`ok_no_rows` does not offer "Update now", and that is the point of separating it
rather than lumping it in with `never_run`. Running the same pull again is what
produced the nothing — it already believes it succeeded. A button that cannot
help is worse than no button: a person who presses it, waits, and sees the
banner unchanged learns to ignore banners, and this is the banner they can least
afford to ignore.

It is also not dressed in the same amber as "you have not run the backfill yet".
A gap and a false report are different things, and the bar says which.

Its sentence names what is being used instead — *"Every number that needs this
season's usage is coming from 2023, 2024, 2025 instead"* — because "missing
data" with no years in it is what let this go unnoticed.

## 3. A fifth state that nobody planned

`coverageState` returns `'unrecognised'` for any value not in the known four,
and `'unrecognised'` renders. That is the availability vocabulary's rule
(`lineup-brain.js#playerAvailabilityBasis`) applied one surface over: a server
that grows a fifth state must surface as something a reader can ask about, not
vanish into the healthy case.

Absent is different from unknown. No field served means no claim to make, so
`coverageState(undefined)` is `null` and the banner falls back to exactly the
behaviour it has today. Both are tested.

## 4. The mutations

Run at `af7f01a` + the working tree of this commit,
`test/usage-coverage-banner.test.js`, 6 tests. Each entry records the mutated
file's SHA-256 before and after, which is what proves the mutation was APPLIED;
each names the **test title** that turned red; each quotes its **exact before
and after text** so it can be reproduced from this file rather than taken on
trust.

**S1 a healthy install is given a headline** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `51a13b5e8af8` — **RED**, 1 failing · killed by *S1 healthy: rows for the season being played renders nothing at all*

```diff
-    default:
-      return null;
-  }
-}
-
-/** What the person reading it should understand, and what to do. */
+    default:
+      return 'This install is missing historical model data';
+  }
+}
+
+/** What the person reading it should understand, and what to do. */
```

**S1 the banner renders on a healthy install** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `56d2dcd3ab8c` — **RED**, 1 failing · killed by *S1 healthy: rows for the season being played renders nothing at all*

```diff
-const coverageWrong = coverage != null && coverage !== 'healthy';
+const coverageWrong = coverage != null;
```

**S2 a fresh clone stops being offered the fix** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `1561dd9cbd94` — **RED**, 1 failing · killed by *S2 never run: a fresh clone is told what is missing, and offered the fix*

```diff
-  return state === 'never_run' || state === 'stale';
+  return state === 'stale';
```

**S2 the fresh-clone detail stops saying why there is no data** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `cbfa1ca8595d` — **RED**, 1 failing · killed by *S2 never run: a fresh clone is told what is missing, and offered the fix*

```diff
-      return 'None of it ships in the repository — it only exists once the one-time backfill has run.';
+      return 'Some data is missing.';
```

**S3 the stale headline stops naming where the data stops** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `5a5b5b69ed14` — **RED**, 1 failing · killed by *S3 stale: it names the week it stops at and the week the league is on*

```diff
-`Player usage stops at week ${upTo}; this league is on week ${week}`
+`This league is on week ${week}`
```

**S3 a stale state with no week numbers invents one** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `71130af67c0b` — **RED**, 1 failing · killed by *S3 stale: it names the week it stops at and the week the league is on*

```diff
-        : 'Player usage has not caught up to the current week';
+        : `Player usage stops at week ${upTo}; this league is on week ${week}`;
```

**S4 the empty-table state offers a retry that cannot work** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `c930b90e2a29` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-  return state === 'never_run' || state === 'stale';
+  return state === 'never_run' || state === 'stale' || state === 'ok_no_rows';
```

**S4 the empty-table state wears the missing-data headline** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `c5e8a7c36792` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-        ? `Player usage reports that it updated, but holds no ${season} rows at all`
+        ? 'This install is missing historical model data'
```

**S4 the detail stops saying a retry changes nothing** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `a3c59eadc1d5` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-      return 'Running it again produces the same nothing: the pull already believes it succeeded. '
+      return 'The usage pull needs attention. '
```

**S4 the detail stops saying where the numbers come from instead** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `4cdb1fa156c5` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-          ? `Every number that needs this season's usage is coming from ${had.join(', ')} instead. `
+          ? '' 
```

**S4 the Update button renders in every state** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `83c64ecaae25` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-      {retryable && (
-        <button onClick={runSync} disabled={busy}
+      {true && (
+        <button onClick={runSync} disabled={busy}
```

**S4 the banner decides retryability on its own** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `6630b5621e8a` — **RED**, 1 failing · killed by *S4 reports ok with no rows: its own headline, and no Update button*

```diff
-const retryable = coverage == null ? true : canRetry(coverage);
+const retryable = coverage !== 'never_run';
```

**S5 an unplanned state is treated as healthy** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `5d4d451c159f` — **RED**, 1 failing · killed by *an unplanned fifth state is shown, never silently treated as healthy*

```diff
-  if (!KNOWN.includes(state)) return 'unrecognised';
+  if (!KNOWN.includes(state)) return 'healthy';
```

**S5 an absent field is read as a state** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `ae1824304e7f` — **RED**, 1 failing · killed by *an unplanned fifth state is shown, never silently treated as healthy*

```diff
-  if (!coverage || typeof coverage !== 'object') return null;
+  if (!coverage || typeof coverage !== 'object') return 'healthy';
```

**S6 the banner grows its own copy of the coverage logic** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `558e0835766e` — **RED**, 1 failing · killed by *the banner and this test are calling the same module*

```diff
-import { coverageState, canRetry, coverageHeadline, coverageDetail } from '../lib/usage-coverage';
+const coverageState = (c: any) => c?.state ?? null;
+const canRetry = (s: any) => s !== 'ok_no_rows';
+const coverageHeadline = (_s: any, _c: any) => 'Data problem';
+const coverageDetail = (_s: any, _c: any) => null;
```

**S6 usage_coverage is dropped from the interface** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `67b040e11184` — **RED**, 1 failing · killed by *the banner and this test are calling the same module*

```diff
-  usage_coverage?: UsageCoverage | null;
-
+  (the text is removed)
```

**NO-OP CONTROL: a word in the module comment** (`client/src/lib/usage-coverage.js`) — APPLIED `64d65f320c19` → `41a61878e0cb` — **green — survived, as intended**

```diff
- * Which of four states the player-usage backfill is actually in.
+ * Which of the four states the player-usage backfill is actually in.
```

**NO-OP CONTROL: a class name nothing asserts** (`client/src/components/DataSetupBanner.tsx`) — APPLIED `18e3c97ca717` → `2854d113fa82` — **green — survived, as intended**

```diff
-className="font-semibold"
+className="font-semibold "
```
16 mutations, 16 red, each by the test that names it. Both controls were
applied — real edits, the SHA changes — and both survived.

### The survivor, and the instrument that lied

**A mutation survived the first run.** Replacing the whole value import with
four local shims left the suite green, because the identity check was
`assert.match(banner, /from '\.\.\/lib\/usage-coverage'/)` — and the line below
it, `import type { UsageCoverage } from '../lib/usage-coverage'`, satisfies that
pattern on its own. The component could have stopped using every function in
the module and kept the test that exists to prove it uses them. Now the value
import is matched by name, and a local shadow of any of the four is banned
outright.

**And ten mutations reported NOT APPLIED that had in fact applied.** The runner
verifies application with `git diff --numstat`, and three of these files were
untracked, so git reported no change to a file that had just been rewritten.
Every mutation of the new module came back as a gap. The fix was `git add -N`
before the run, and the lesson is the one the runner was written for pointed at
itself: **a verification step that can be silently wrong about whether the
mutation landed is the same class of failure as an assertion that cannot fail.**
Both runs are in this file; only the second is evidence.

## 5. What the server has to serve

For the wiring-map thread, who own `routes/model.js`. `GET
/api/model/setup-status` gains one key, and everything in §2 follows from it:

```
usage_coverage: {
  state:             'healthy' | 'never_run' | 'stale' | 'ok_no_rows',
  season:            number,        // the season being played
  rows:              number,        // rows in player_week_usage for that season
  latest_week:       number | null, // last week that has rows
  league_week:       number | null, // the week the league is on
  seasons_with_rows: number[],      // what is being used instead
  source_status:     string,        // what the registry last recorded
  last_run_at:       string | null
}
```

`ok_no_rows` is `rows === 0` while the source's `last_status` is anything other
than `'never run'`. `stale` is `rows > 0 && latest_week < league_week`. The
client treats the four as mutually exclusive and shows anything else as
unrecognised, so the server must not send a fifth without one of us noticing.

Omitting the key entirely is a supported state and means "no claim": the banner
behaves exactly as it does today.

## 6. Every test has a killing row

The mirror of an unkilled mutation. All six tests in
`test/usage-coverage-banner.test.js` — the only suite these rows were run
against — are turned red by at least one mutation above:

| Test | Killed by |
|---|---|
| S1 healthy: rows for the season being played renders nothing at all | rows 1, 2 |
| S2 never run: a fresh clone is told what is missing, and offered the fix | rows 3, 4 |
| S3 stale: it names the week it stops at and the week the league is on | rows 5, 6 |
| S4 reports ok with no rows: its own headline, and no Update button | rows 7–12 |
| an unplanned fifth state is shown, never silently treated as healthy | rows 13, 14 |
| the banner and this test are calling the same module | rows 15, 16 |

No test is red for nothing, and no mutation is left unkilled, so nothing here
is declared equivalent or surviving.

Both zero-fail rows are **NO-OP CONTROLS**, not equivalent survivors: each is a
real edit that moves the file's hash and breaks nothing, which is the
distinction a zero-fail row has to state. No separate kill-control is needed —
sixteen rows land and turn a named test red, which is what a kill-control
exists to establish.

## 7. Full check

`npm run check` on the tree of **this commit**: typecheck clean, **3,188 tests,
3,147 pass, 0 fail, 41 skipped**, build 2.70s, startup smoke passed on an
isolated database.

A figure claimed on the commit that prints it is normally false, because the
commit changes the tree the figure describes. It is not false here, and this is
checkable rather than asserted: `npm run check` is typecheck, lint, test, build
and smoke; `scripts/lint.mjs:5` walks `['server', 'scripts', 'test']`; `tsc`
and `vite build` read the client; and no test opens anything under `docs/tdd/`
(`test/design-system-tokens.test.js:28` reads `docs/design/design-system.md`
and `test/nfl-execution-integrity.test.js:258` reads
`docs/CLAUDE-NEXT-STEPS.md` — those are the only two `docs/` readers in the
suite). Adding this file therefore cannot move any of the numbers it states.

The source was restored after the mutation run and verified clean with
`git status`, not assumed clean because the runner said so.

