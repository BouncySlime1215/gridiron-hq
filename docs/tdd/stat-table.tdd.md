# The design system's fifth component — RED/GREEN evidence

`test/stat-table.test.js`, `client/src/components/ui/StatTable.tsx`,
`docs/design/design-system.md` §4, and the dark-palette correction in §2
(`test/design-system-tokens.test.js`).

Retroactive RED by mutation.

## Spec before component

§4 opened "Four, named here so they are built once. Everything else is
composition" and listed basis chip, stat block, deep-dive drawer, glossary.
There was **no table spec**. An earlier message from this thread claimed the
document "defines one and ships none"; that was wrong and is corrected here.
The spec is written first and the component is built to it, which is the point
of §4 existing at all.

## What it replaces, and why replacing beats keeping

`client/src/components/StatTable.tsx` was a `StatRow`/`StatHeader` pair for the
rankings page: a hard-coded abbreviation map (`TGT`, `RECY`, `RECTD`),
`any`-typed rows, pre-system emerald/slate colours, ADP and FantasyCalc value
columns, and exactly one caller. That caller was `Rankings.tsx`, deleted in the
previous commit, so it was already imported by nothing.

Keeping the file and rewriting its inside would have been building a second
table and calling it the first one. A table whose column names live inside
itself is the label-written-inline bug in grid form — the same defect the
glossary exists to end, one level up.

## The four rules, each one something the old table broke

Each rule's id prefixes the title of the test that enforces it (`R1: …`), so
the mutation evidence below names a real test rather than a rule no runner
knows about. `R4` has two tests: the struck header, and the em dash a tracked
quantity's missing value renders as.

1. **Columns are declared by glossary id.** A column is `{ id }`; header text,
   unit, decimal places and the plain sentence all follow. There is no `label`
   prop, for the reason `StatBlock` has none: a caller that can pass a label
   will, and then one quantity has two names again.
2. **The basis sits in the header, once per column.** A chip in every cell of a
   twenty-row table is noise nobody reads; no chip at all puts the table back
   where this redesign started. A column is usually one source, so the column is
   the honest place. A cell whose basis *differs* carries a 6px dot in its own
   basis colour; a cell that matches carries nothing, so every mark on screen
   means something.
3. **Tone comes from the lexicon's `better`, never from the basis.** Only
   `higher` or `lower` may colour. `neither` never does — aDOT is the example:
   far downfield is not good or bad on its own. And an *unsigned* column is
   never coloured either, because a column of raw values has no zero point to
   colour against and inventing one would be this component issuing a verdict.
4. **A quantity stored nowhere is a struck header and a reason, not a column of
   em dashes.** Em dashes read as "we have no data on this player"; the truth is
   "we have this on nobody". Four are in this state and must never appear as
   numbers: yards per route run and route participation (need a paid charting
   feed), touchdown rate (nothing stores it), red-zone share (being built).

## Placeholder columns for the lexicon

No display name is invented here. Every column takes its name from
`client/src/lib/glossary.ts`. The quantities the design system's first two
consumers will need that have **no glossary entry yet**, for Coach to add as
lexicon concepts:

- target share, air-yards share, snap share, WOPR, aDOT, RACR, PACR, catch
  rate, expected points — all named in the lexicon and not yet mirrored into
  the client glossary
- depth-chart position and depth-chart rank — the depth-chart panel's two
  columns, which may not be lexicon concepts at all

Three tendencies columns already have entries and are usable today:
`shotgun_rate`, `no_huddle_rate`, `deep_rate`.

## It has no consumer, and the document says so

The table is imported by nothing. That is the state `useNumberRoll` shipped in
— fully tested, wired to nothing, with its tests passing the whole time because
they read the hook's own source. So the orphan is closed from both sides
instead of being left to be noticed later:

- while nothing imports it, §4 must carry the statement that nothing does and
  **why** (the normalised stat names are not in this tree yet);
- the moment a page imports it, that statement must be removed, or the test
  fails.

The existing measured-identity panel on the team page is deliberately **not**
converted. It carries its own labels from `nfl-team-tendencies.js`, and mapping
those onto glossary ids before the lexicon lands would be inventing the names
by another route.

## The dark palette the document promised and the stylesheet did not have

§2 said "Every token above gets a dark value". `client/src/index.css` has **no**
`prefers-color-scheme` block, no `[data-theme]` block, and no dark value for any
token. A design system asserting something untrue about itself is the same
defect as a page printing a number with no basis, one level up — in my own
document.

§2 now states it is not built, and why it is not a token exercise: several
hundred hard-coded `slate-*` and `emerald-*` classes remain from before this
system, so darkening the ramp while the page stays white would make the basis
chips unreadable and fix nothing.

The test holds both directions. While there is no dark block it requires the
document to say so and forbids the old sentence. The moment a dark block
appears it requires **both** states — the media query *and* `[data-theme="dark"]`
— and every basis token redefined in each, because a token defined in only one
falls back to its light value in exactly one state with nothing failing. That is
the classic bug §2 itself warns about.

## Mutation runs

`test/stat-table.test.js` baseline: 9 tests, 9 pass, 0 fail. All nineteen red.

| Mutation | Result | Caught by |
|---|---|---|
| a column gains its own `label` | 7/**1** | declared by glossary id |
| the header text stops coming from the glossary | 7/**1** | declared by glossary id |
| the header loses its basis chip | 7/**1** | basis in the header |
| `basis` stops being required per column | 7/**1** | basis in the header |
| the cell marker shows on every cell | 7/**1** | basis in the header |
| a `neither` quantity becomes colourable | 7/**1** | tone from direction |
| an unsigned column is coloured against an invented zero | 7/**1** | tone from direction |
| the tone is decided from the basis | 7/**1** | tone from direction |
| a not-tracked column renders cells of em dashes | 7/**1** | struck header |
| the struck header stops being struck | 7/**1** | struck header |
| the design system stops naming the untracked quantities | 7/**1** | struck header |
| the sticky column loses its background | 7/**1** | the first column sticks |
| the table stops scrolling sideways | 7/**1** | the first column sticks |
| the design system goes back to four components | 7/**1** | five components |
| the table defaults a missing value to zero | 7/**1** | em dash, never zero |
| `formatValue` stops distinguishing missing from zero | 7/**1** | em dash, never zero |
| the document drops the no-consumer statement | 8/**1** | consumer or statement |
| the document drops the reason for it | 8/**1** | consumer or statement |
| a page imports the table while the document still says none does | 8/**1** | consumer or statement |

`test/design-system-tokens.test.js` baseline: 9 tests, 9 pass, 0 fail.

| Mutation | Result |
|---|---|
| the document promises dark values again | 8 pass / **1 fail** |
| the document drops the not-built statement | 8 pass / **1 fail** |
| dark lands half-wired (media query, no `[data-theme]`) | 8 pass / **1 fail** |
| dark lands in both blocks with one token forgotten | 8 pass / **1 fail** |

The last two are forward-looking: they fail against a dark palette that does
not exist yet, which is the only way to make a contract for future work bite
before the work happens.

## One test assertion was scoped down, and why

"the old table is gone" checked the whole new file for `RECY`, `RECTD`,
`rushAtt`. It failed, correctly: the header comment names those abbreviations
on purpose, to say what was replaced. Explaining what was removed is not the
same as shipping it, and a whole-file check would forbid the explanation. The
check now runs below the header comment.

---

## Mutation re-run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/components/ui/StatTable.tsx`, `client/src/index.css`, `client/src/lib/glossary.ts`, `client/src/pages/TeamDetail.tsx`, `docs/design/design-system.md`.

**a column gains its own label** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `c1926a0ca8c0` — **RED**, 1 failing · killed by *R1: a column is declared by glossary id and cannot be given a label*

```diff
-export interface StatColumn {
-  /** The quantity. Everything visible about this column follows from it. */
-  id: TermId;
+export interface StatColumn {
+  /** The quantity. Everything visible about this column follows from it. */
+  id: TermId;
+  label?: string;
```

**the header text stops coming from the glossary** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `dbd0e7b441c8` — **RED**, 1 failing · killed by *R1: a column is declared by glossary id and cannot be given a label*

```diff
-const t = term(col.id);
+const t = { name: String(col.id), plain: '' };
```

**the column header loses its basis chip** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `a160059b318b` — **RED**, 1 failing · killed by *R2: the basis is in the header once, and a cell marks itself only when it differs*

```diff
-<BasisChip basis={col.basis} note={col.basisNote} className="stat-table-basis" />
+  (the text is removed)
```

**a basis stops being required per column** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `4abdcccc3a95` — **RED**, 1 failing · killed by *R2: the basis is in the header once, and a cell marks itself only when it differs*

```diff
-  /** Where this column's numbers come from. Rendered once, in the header. */
-  basis: Basis;
+  basis?: Basis;
```

**the cell marker shows on every cell** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `5fe70b1a487a` — **RED**, 1 failing · killed by *R2: the basis is in the header once, and a cell marks itself only when it differs*

```diff
-{differs && differs !== col.basis && (
+{true && (
```

**a 'neither' quantity becomes colourable** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `d837ec278fc8` — **RED**, 1 failing · killed by *R3: a number is coloured only by the lexicon direction, never by its basis*

```diff
-  if (better === 'neither' || value == null || !Number.isFinite(value) || value === 0) return 'neutral';
+  if (value == null || !Number.isFinite(value) || value === 0) return 'neutral';
```

**an unsigned column is coloured against an invented zero** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `eb9f28caa58d` — **RED**, 1 failing · killed by *R3: a number is coloured only by the lexicon direction, never by its basis*

```diff
-  if (!col.signed) return 'neutral';
-
+  (the text is removed)
```

**the tone is decided from the basis** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `28a87a4b6c71` — **RED**, 1 failing · killed by *R3: a number is coloured only by the lexicon direction, never by its basis*

```diff
-  const better = col.better ?? 'neither';
+  const better = col.basis === 'measured' ? 'higher' : (col.better ?? 'neither');
```

**a not-tracked column renders cells of em dashes** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `9cdb8b2c86f7` — **RED**, 1 failing · killed by *R4: a quantity stored nowhere is a struck header, not a column of dashes*

```diff
-                if (!isTracked(col)) return <td key={`nt-${i}`} className="stat-table-cell" aria-hidden="true" />;
+                if (!isTracked(col)) return <td key={`nt-${i}`} className="stat-table-cell">—</td>;
```

**the struck header stops being struck** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `2bd910fc81a0` — **RED**, 1 failing · killed by *R4: a quantity stored nowhere is a struck header, not a column of dashes*

```diff
-.stat-table-not-tracked { display: block; text-decoration: line-through;
+.stat-table-not-tracked { display: block;
```

**the sticky column loses its background** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `f52b9ac94a20` — **RED**, 1 failing · killed by *the first column sticks, because this is read on a phone*

```diff
-  position: sticky; left: 0; z-index: 1;
-  background: var(--bg);
+  position: sticky; left: 0; z-index: 1;
```

**the table stops scrolling sideways** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `86c9490d2b2e` — **RED**, 1 failing · killed by *the first column sticks, because this is read on a phone*

```diff
-.stat-table-scroll { overflow-x: auto;
+.stat-table-scroll { overflow-x: visible;
```

**the design system goes back to four components** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `14341693a756` — **RED**, 1 failing · killed by *the design system names five components, and the table is one*

```diff
-Five, named here so they are built once.
+Four, named here so they are built once.
```

**the design system stops naming the untracked quantities** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `2fd62aba4f76` — **RED**, 1 failing · killed by *R4: a quantity stored nowhere is a struck header, not a column of dashes*

```diff
-yards per route run and route participation
+some stats
```

**the table defaults a missing value to zero** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `042d0c5e7342` — **RED**, 1 failing · killed by *R4: a missing value is an em dash, never a zero, and never an empty cell*

```diff
-                const value = row.values[col.id];
+                const value = row.values[col.id] ?? 0;
```

**formatValue stops distinguishing missing from zero** (`client/src/lib/glossary.ts`) — APPLIED `651cd69a37a7` → `a74db51466e0` — **RED**, 1 failing · killed by *R4: a missing value is an em dash, never a zero, and never an empty cell*

```diff
-  if (value == null || !Number.isFinite(value)) return '—';
+  if (value == null) return '0';
```

**the document drops the no-consumer statement** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `6788652a5291` — **RED**, 1 failing · killed by *the table has a consumer, or the design system says why it does not*

```diff
-**No page renders it yet, and that is stated rather than hidden.**
+It is ready for use.
```

**the document drops the reason for no consumer** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `f1297f3dde66` — **RED**, 1 failing · killed by *the table has a consumer, or the design system says why it does not*

```diff
-and both are waiting on the normalised stat names —
+and both are coming —
```

**a page imports the table while the document still says none does** (`client/src/pages/TeamDetail.tsx`) — APPLIED `c4f77680d2fd` → `911bc7d38c15` — **RED**, 1 failing · killed by *the table has a consumer, or the design system says why it does not*

```diff
-import { Headshot } from '../components/PlayerRow';
+import { Headshot } from '../components/PlayerRow';
+import StatTable from '../components/ui/StatTable';
```

**the document promises dark values again** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `e9ec30ac5037` — **RED**, 1 failing · killed by *the document does not promise a dark palette the stylesheet does not have*

```diff
-**Not built. This section is the contract for when it is, not a description of
-what ships.**
+Every token above gets a dark value.
```

**the document drops the not-built statement** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `6aacefd8f95d` — **RED**, 1 failing · killed by *the document does not promise a dark palette the stylesheet does not have*

```diff
-**Not built. This section is the contract for when it is, not a description of
-what ships.**
+Dark is handled elsewhere.
```

**dark lands half-wired: media query with no [data-theme]** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `639780621a71` — **RED**, 1 failing · killed by *the document does not promise a dark palette the stylesheet does not have*

```diff
-  --basis-unknown:  #6b5f52;
+  --basis-unknown:  #6b5f52;
+}
+@media (prefers-color-scheme: dark) {
+  :root:not([data-theme="light"]) {
+    --basis-measured: #4ade80;
+    --basis-fitted: #7dd3fc;
+    --basis-pooled: #c4b5fd;
+    --basis-assumed: #fcd34d;
+    --basis-none: #fca5a5;
+    --basis-missing: #94a3b8;
+    --basis-unknown: #a8a29e;
+  }
+}
+:root {
```

**dark lands in both blocks with one token forgotten** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `e4300b7deb92` — **RED**, 1 failing · killed by *the document does not promise a dark palette the stylesheet does not have*

```diff
-  --basis-unknown:  #6b5f52;
+  --basis-unknown:  #6b5f52;
+}
+@media (prefers-color-scheme: dark) {
+  :root:not([data-theme="light"]) {
+    --basis-measured: #4ade80;
+    --basis-fitted: #7dd3fc;
+    --basis-pooled: #c4b5fd;
+    --basis-assumed: #fcd34d;
+    --basis-none: #fca5a5;
+    --basis-missing: #94a3b8;
+    --basis-unknown: #a8a29e;
+  }
+}
+:root[data-theme="dark"] {
+  --basis-measured: #4ade80;
+  --basis-fitted: #7dd3fc;
+  --basis-pooled: #c4b5fd;
+  --basis-assumed: #fcd34d;
+  --basis-none: #fca5a5;
+  --basis-missing: #94a3b8;
+}
+:root {
```

**NO-OP CONTROL: a comment word changed in the stat table** (`client/src/components/ui/StatTable.tsx`) — APPLIED `ae52477a44e7` → `b88370a5a9c2` — **green — survived, as intended**

```diff
- * THE GRID, WHEN THE QUESTION IS "COMPARE THESE".
+ * THE GRID, WHEN THE QUESTION IS "COMPARE THESE" (control).
```

**NO-OP CONTROL: a heading word changed in the dark section** (`docs/design/design-system.md`) — APPLIED `cfb842ff64e5` → `0231821539c5` — **green — survived, as intended**

```diff
-### Dark
+### Dark 
```

23 mutations applied and red, 2 applied and green. The green
rows are the deliberate no-op controls — edits that are real (the SHA changes) but
touch nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database. The tree is `af7f01a` plus the working tree of
the commit this section lands in; the source was restored and verified clean
after the run.
