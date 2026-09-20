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
