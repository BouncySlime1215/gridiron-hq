# Gridiron HQ design system

One page. Everything the redesign is built from, and the thing every later step
gets held against.

**This extends `client/src/index.css`; it does not replace it.** That file
already carries a considered token set — surfaces, ink, spacing, radii,
shadows, a `--panel` near-neutral with a deliberate green bias, semantic
good/warn/crit kept separate from the brand accent on purpose, position
colours, entrance motion and a change flash, each with the reasoning written
next to it. None of that is re-decided here. What follows fills the gaps that
are actually open.

The gaps, named honestly so the scope of this document is clear:

1. **Typography.** The app sets `-apple-system, BlinkMacSystemFont, …` and
   nothing else. No display face, no scale, no mono. This is the whole of the
   "it looks generated" problem and most of what this document is for.
2. **No dark theme.** `prefers-color-scheme` appears zero times.
3. **Motion exists but is not coded.** `.tr-rise` and `.just-updated` are good
   primitives with the right instincts (compositor-only properties, reduced
   motion guarded, colour-only for a settling row). They carry hard-coded
   durations and easings, so the next component invents its own and the app
   drifts.
4. **No vocabulary for the three things the redesign adds**: the basis chip,
   the stat block, the deep-dive drawer.
5. **Numbers do not animate when they change.** `.just-updated` flashes the
   row behind a number; the digits themselves cut.

---

## 1. Type

The app is a wall of numbers with sentences around them. The pairing is chosen
for that, not for a marketing page.

| Role | Face | Why this one |
|---|---|---|
| Display | **Archivo**, width axis 112–125 | A wide grotesque reads as a broadcast lower-third, which is the app's own world. The width does the work a second display face would otherwise do. |
| Body | **Archivo**, width axis 100 | Same superfamily. Personality comes from width and weight rather than from two faces competing, which keeps long explanations calm and the headline numbers loud. |
| Data | **Spline Sans Mono** | For labels, basis chips, raw column names and anything that is literally a key. Has a real character to it; is not a default. |

Numbers in the body face, never the mono, and always with
`font-variant-numeric: tabular-nums` so columns line up. The mono is for the
names of things, not for the things themselves.

Deliberately not used: Inter, Roboto, Poppins, Space Grotesk, Montserrat,
system-ui as a design choice. Not because they are bad — because they are the
faces that arrive when nobody chose, and the whole point of this section is
that somebody chose.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&family=Spline+Sans+Mono:wght@400;500&display=swap">
```

### Scale

A fifth-based scale, rounded to whole pixels. Stay on it; nothing between steps.

| Token | Size / line | Used for |
|---|---|---|
| `--type-hero` | 44 / 1.02 | The one number a page exists to show |
| `--type-stat` | 30 / 1.08 | Numbers in a stat block |
| `--type-title` | 21 / 1.2 | Page and section titles |
| `--type-lead` | 17 / 1.5 | The sentence under a title |
| `--type-body` | 15 / 1.6 | Everything a manager reads |
| `--type-note` | 13 / 1.5 | Secondary lines, the "why" under a row |
| `--type-label` | 11 / 1.4 | Mono. Chips, column headers, raw names |

Display sizes (`hero`, `stat`, `title`) take the wide width axis and weight
600–700. Body sizes stay at width 100, weight 400–500. Uppercase is for
`--type-label` only, with `0.08em` tracking.

---

## 2. Colour

**Unchanged from `index.css`.** `--bg`, `--surface`, `--line`, `--ink`,
`--muted`, `--subtle`, `--accent`, `--warn`, `--danger`, `--info`, `--panel`,
`--good`/`--crit` and their tints all keep their meanings. The remapping layer
that pulls stray Tailwind emerald and slate classes onto the brand tokens stays
as it is.

Two additions.

### The basis scale

Six values, one hue each, and they are **not** semantic colours. A pooled
number is not "bad"; it is differently sourced. So they live in their own
ramp and never borrow `--good`, `--warn` or `--crit`, which would tell a
manager that an assumed number is a problem with their team.

| Token | Light | Meaning |
|---|---|---|
| `--basis-measured` | `#0d6b4d` | Counted from games played this season |
| `--basis-fitted` | `#2f6a8f` | A model fitted on history, with an id |
| `--basis-pooled` | `#6b5aa6` | The fitted model's coarse layer |
| `--basis-assumed` | `#9a6408` | A hand-set constant |
| `--basis-none` | `#8d2f27` | Nothing priced this at all |
| `--basis-missing` | `#5c6461` | The data is not loaded |

`--basis-none` sits near `--danger` on purpose and is the one place the two
ramps nearly touch: "nothing modelled this" is the tier a manager most needs
to notice, and a neutral would bury it.

### Dark

**Not built. This section is the contract for when it is, not a description of
what ships.** `client/src/index.css` has no `prefers-color-scheme` block and no
`data-theme` block, and no token in this document has a dark value. An earlier
draft of this section read "Every token above gets a dark value", which was a
promise with nothing behind it — the exact defect the rest of this document is
about, written into the document itself.

Dark is not a token exercise here. The app still carries several hundred
hard-coded `slate-*` and `emerald-*` classes from before this system, so
darkening the ramp while the page stays white would make the basis chips
unreadable and fix nothing. Dark lands after those surfaces move onto the
tokens, and not before.

When it does, three states, not two, because the default OS setting stamps
nothing:

```css
:root { /* complete light palette — every token defined here first */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* tokens only */ } }
:root[data-theme="dark"] { /* tokens again, so an explicit choice wins */ }
```

A colour whose only definition sits inside a media block does not apply in the
unstamped state. That is the classic bug and it is worth restating every time.
`test/design-system-tokens.test.js` holds both halves: while there is no dark
block it asserts the document does not claim one, and the moment a dark block
appears it requires every basis token to be redefined in all three places.

---

## 3. Motion

Motion shows a change or reveals structure. It never decorates. Two hard rules
before any token:

- **Nothing moves on first paint.** The page a manager opens is at rest and
  readable. `.tr-rise` is the exception and it is bounded — it fires once, on
  content arriving after a fetch, staggered at the call site.
- **Everything is behind `prefers-reduced-motion`**, which `index.css` already
  does globally and per-animation. Keep both.

| Token | Value | For |
|---|---|---|
| `--motion-quick` | `120ms` | Hover, focus, a chip tinting |
| `--motion-base` | `180ms` | The existing `.card` transition; borders, shadows |
| `--motion-reveal` | `260ms` | A row opening into the deep dive |
| `--motion-settle` | `420ms` | `.tr-rise`, content arriving |
| `--motion-decay` | `1600ms` | `.just-updated`, a flash fading out |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Anything arriving. Already `.tr-rise`'s curve |
| `--ease-inout` | `cubic-bezier(.4, 0, .2, 1)` | Anything opening or closing |

`.tr-rise` and `.just-updated` keep their current behaviour and move onto these
tokens, so their values stop being two more magic numbers.

### The number roll

The one new primitive. When a number a manager is looking at changes — a poll
lands, a trade side updates, an objective is switched — the digits **count** to
the new value over `--motion-reveal` rather than cutting, and `.just-updated`
flashes the row behind them as it already does.

It is worth the code because it answers a question the app currently cannot:
*did that number just move, or was it always this?* A cut is indistinguishable
from a re-render. It is bounded hard: no roll longer than `--motion-reveal`,
none on first paint, none on a value that changed by less than the number's own
display precision, and none at all under reduced motion — the value simply
sets.

---

## 4. Components

Five, named here so they are built once. Everything else is composition.

### Basis chip

A mono `--type-label` pill with a 3px left stripe in its basis colour and a
`--surface` fill. It sits **beside the number it describes**, never in a
footnote or a tooltip-only position, because the number is the thing that is
wrong without it. Hover gives the plain-words sentence for that tier.

It renders a basis string and decides nothing itself. Four separate
implementations exist today — Start/Sit's suffix, News's per-card
parenthetical, the odds sentence, the Settings freshness card — and they all
collapse into this.

### Stat block

A number at `--type-stat` or `--type-hero`, its canonical name above it at
`--type-label`, its basis chip beside it, and at most one `--type-note` line
under it. Tabular numerals. The block is the unit that gets clicked, and the
whole block is the hit target, not just the digits.

No borders and no fill by default. A stat block is not a card. Border, fill,
radius and shadow each say "separate object" and spending them on every number
flattens the page into a grid of equal things, which is the look this redesign
is getting away from.

### Deep-dive drawer

Opens over the current page, never a route. Five layers, revealed one at a
time at `--motion-reveal` with `--ease-inout`, each expandable. Closes back to
exactly where it was, with the originating stat block still focused. Deep-links
so a layer can be shared.

Plain words at every layer. The raw column name appears at the bottom layer
only, in the mono face, as a footnote to the canonical name — never as the
heading.

### Stat table

A grid of the same quantities the stat block shows, for when the question is
"compare these" rather than "how big is this". It is the fifth component
because the alternative is every page growing its own, which is exactly what
happened before: `components/StatTable.tsx` was a rankings-only pair of
`StatRow` and `StatHeader` with a hard-coded abbreviation map (`TGT`, `RECY`,
`RECTD`), `any`-typed rows and pre-system colours, and it was imported by one
page. It is replaced, not kept — a table whose column names live inside itself
is the label-written-inline bug in grid form.

**Columns are declared by glossary id, never by label.** A column is
`{ id }`; the header text, the unit, the decimal places and the plain sentence
all follow from the entry. A caller that can pass a column name is a caller
that will.

**Headers are mono `--type-label`, and they carry the basis.** A basis chip in
every cell of a twenty-row table is noise that nobody reads, and dropping the
basis entirely puts the table back where the rest of this document started. So
the basis sits **once per column, in the header** — that is the honest position,
because a column is usually one source. A cell whose basis differs from its
column's shows its own marker; a cell that matches shows nothing, so the marks
that appear are the ones that mean something.

**Tone comes from the lexicon's `better`, never from the basis.** Only a
quantity that says `higher` or `lower` may colour its numbers. `neither` — aDOT
is the example — is never coloured, because "far downfield" is not good or bad
on its own. A basis never tints a number; that is what the chip is for.

**A quantity we do not store renders as a struck header and the reason, not as
an empty column.** Four are in this state today and must never appear as
numbers: yards per route run and route participation (need a paid charting
feed), touchdown rate (nothing stores it), red-zone share (being built). A
column of em dashes reads as "we have no data on this player"; the truth is "we
have this on nobody", and those are different sentences.

**The first column sticks and the rest scroll.** This is read on a phone. A
table that reflows into cards loses the comparison that is the only reason it
is a table.

**No page renders it yet, and that is stated rather than hidden.** Its first
consumers are the depth-chart panel on the team page and the advanced-stats
block on the player page, and both are waiting on the normalised stat names —
building them against invented labels is the exact defect this component
exists to prevent, so they wait. The existing measured-identity panel on the
team page is deliberately **not** converted: it carries its own labels from
`nfl-team-tendencies.js`, and mapping them onto glossary ids before the lexicon
lands would be inventing the names by another route.

A component nobody imports is dead code that reads as a feature — that was just
found in this same system, where `useNumberRoll` shipped fully tested and wired
to nothing. So this paragraph is load-bearing: `test/stat-table.test.js`
requires either a consumer or this statement, and the day a page imports the
table, the statement has to go.

### Glossary

Not visual, but it belongs here because it is the other half of consistency.
One record per quantity: canonical display name, the plain sentence, the raw
column, the unit, the display precision. Every label in the app reads from it.
A label written inline in a component is a bug, and the reason is already in
the codebase: `floor` currently means the 10th percentile of a week in
`trade-engine.js` and the 20th percentile of a season in the career line, and
both appear on the same screen under the same word.

---

## 5. How to check a screen against this

Six questions. A "no" is not a matter of taste.

1. Is the number this page exists for the biggest thing on it?
2. Does every number carry its basis chip, beside it?
3. Does every label match the glossary, and does its hover sentence avoid
   every word on the banned list — percentile, distribution, prior, shrinkage,
   calibrated, variance?
4. Is every size on the scale, and is every colour a token?
5. Does anything move on first paint? Does anything move that is not showing a
   change or revealing structure?
6. At 400px wide: does it still work, with a 16px gutter and no sideways
   scroll on the page body?
