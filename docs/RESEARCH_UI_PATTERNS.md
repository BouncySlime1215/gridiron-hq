# Evidence-first UI research — draft room, trade evaluator, start/sit

Scoped to what's already built: `LiveDraft.tsx`'s "Claude's call" card (headshot + headline +
`EvidenceTable` + `StreakChips` + pros/cons), `SparkBar`/`InlineBar`, `DraftBoardRail`, and the
ESPN-page overlay pill in `chrome-extension/`. Recommendations extend this pattern, not replace it.

## 1. Live draft-tool information hierarchy (60s clock)

Direct DOM/screenshot access to ESPN's, Yahoo's, and Sleeper's draft rooms wasn't available in
this pass (no authenticated session), so this section leans on FantasyPros Draft Wizard's
[Draft Assistant](https://draftwizard.fantasypros.com/football/draft-assistant/) product pages
and documented industry convention, cross-checked against what's public. Treat the layout claims
as directional, not pixel-verified — worth a 10-minute manual screenshot pass before final sign-off.

**Consistent hierarchy across the category:**
1. **The recommended name is the single largest text element on screen** — bigger than the clock,
   bigger than the team-need summary. Your `Claude's call` card already does this correctly
   (`text-xl font-extrabold` on the pick name, 56px headshot) — that's the right instinct, keep it.
2. **The clock itself is secondary**, usually top-right, monospace, color-shifts red under ~15s —
   you have this exactly (`tabular-nums`, red under 15s).
3. **Reasoning is terse and directly under the name** — a single bolded stat line, not paragraphs.
   Your `pickHeadline` (stat-rooted, tabular-nums, bold) is the right shape; the risk is
   `advice.why` running long under it and pushing the evidence table below the fold. Consider a
   hard line-clamp (`line-clamp-2`) on `advice.why` with a "more" disclosure, so headline → evidence
   table stays within the first viewport on a laptop.
4. **Alternatives are a compact secondary list**, not full cards, when the clock is short. Your
   "other options" grid is already dense; the one gap vs. Draft Wizard-style tools is that yours
   requires a `<details>` toggle to see pros/cons, while the top tools keep a single-line "why"
   visible with pros/cons collapsed only on mobile widths (breakpoint-based collapse, not a fixed
   `<details>` per row).

**Projection ranges as a visual element:** best-ball tools (Underdog-adjacent products like
BestBall Edge and BestBallTracker) lean on Monte-Carlo-derived range bands and ADP-vs-rank delta
coloring rather than a single point projection — the common visual is a **horizontal range bar**
(min–max or p20–p80) with a marked median tick, color-coded green/red by whether the player is a
"value" or "reach" versus market ADP. That's conceptually identical to your `preseason.p20`/`p80`
line in `EvidenceTable`, which is currently **text only** ("212–268 pts (p20–p80)"). Concrete
upgrade: render that as a horizontal range bar reusing `InlineBar`'s track, with a tick mark at
the median and the text as a label below/beside it — same component family, more scannable at a
glance than reading two numbers.

Sources: [FantasyPros Draft Wizard — Draft Assistant](https://draftwizard.fantasypros.com/football/draft-assistant/), [BestBallTracker](https://bestballtracker.com/), [BestBall Edge](https://bestballedge.com/)

## 2. Dense stat-table / sparkline patterns from open-source dashboards

- **`tabular-nums` + right-aligned numeric columns**: already in use in `EvidenceTable`
  (`tabular-nums` on the `<table>`, `text-right` per numeric `<td>`). This is exactly the
  shadcn/ReUI convention — sparkline/metrics table blocks pair `tabular-nums` with a trailing
  sparkline cell so digits don't jitter as values change width. No change needed here, just confirm
  every numeric column (including `EvidenceTable`'s `Rank` column) keeps a fixed-width font-variant.
- **Sparkline-in-cell instead of a separate sparkline row**: your `InlineBar` per season row is
  the right idea, but it only encodes one metric (PPR total) as a bar. The pattern seen in
  shadcn sparkline-table blocks is a tiny **polyline with a filled dot on the latest point** placed
  in its own narrow column — good for trend direction across many rows without taking a full row's
  height. Concrete: add a second, optional inline sparkline column to `EvidenceTable` for `ppg`
  trend across seasons (reuse `SparkBar`'s bar approach at the row level is redundant with
  `InlineBar`; a genuine polyline would show acceleration/deceleration that a bar-per-row can't).
- **Sticky first column on horizontal scroll**: `EvidenceTable`'s `<table>` already wraps in
  `overflow-x-auto` for narrow viewports. shadcn's own tracker (GitHub issue #3809, discussion
  #4202) confirms sticky-column isn't built into the base table and has to be hand-added: apply
  `sticky left-0 bg-inherit z-10` to the `Season` `<th>`/`<td>` pair so the season label stays
  visible while `Car`/`Rush`/`RTD` etc. scroll under it on a narrow phone. This is a one-line class
  addition, cheap to add.
- **Zebra/hover**: you already do a subtle "newest season" tint (`i === 0 ? 'bg-slate-50/60'`)
  instead of full zebra striping — that's the more modern approach (highlight the *relevant* row,
  not every-other row) and matches Linear/Vercel dashboard conventions of using a single
  highlighted state rather than zebra noise. Recommend adding `hover:bg-slate-50` to each `<tr>`
  for scanability when a user's mouse rests on a row, since none of the rows currently respond to
  hover.

Sources: [shadcn.io — Sparkline Table Block](https://www.shadcn.io/blocks/tables-sparkline), [shadcn-ui/ui — sticky column discussion #4202](https://github.com/shadcn-ui/ui/discussions/4202), [shadcn-ui/ui — sticky column issue #3809](https://github.com/shadcn-ui/ui/issues/3809)

## 3. Mobile card patterns at 375px

`LiveDraft.tsx`'s "other options" grid degrades to `grid-cols-1` implicitly (no `sm:` prefix
active below 640px) — each card stacks full width, which is fine, but the "Claude's call" +
"other options" + "lookahead" stack means a lot of vertical scrolling to reach "Take one of these"
on a phone during a live pick.

Concrete, JS-free technique worth adopting for the **"other options"** row specifically (2-4
short-lived comparison cards — a natural carousel candidate): pure CSS scroll-snap.

```css
.option-rail {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
}
.option-rail > * {
  flex: 0 0 85%;       /* peek the next card so users know to swipe */
  scroll-snap-align: start;
}
```
Applied only below the `sm:` breakpoint (keep the existing `sm:grid-cols-2` above it), this turns
the "other options" section into a swipeable strip on a phone instead of a long vertical stack —
zero JS, works with native momentum scrolling and works with VoiceOver/TalkBack scroll gestures.
`scroll-snap-align: start` with a partial (85%) card width is the standard technique for signaling
"more content" without a scrollbar or arrow affordance (Nolan Lawson's and Builder.io's
write-ups both converge on this "peek" pattern as the actual UX signal, not the snap itself).

For `EvidenceTable`'s season table: rather than collapsing to a card list (a bigger rewrite),
the existing `overflow-x-auto` + shrinking column set is already the lighter-weight version of
"collapse wide table at breakpoints" — recommend leaving it, but add `scroll-snap-type: x proximity`
(not `mandatory`, since this is a table a user may want to scrub freely rather than snap through)
so it still gets subtle snap-to-column behavior without fighting free scrolling.

Sources: [Builder.io — CSS Carousels](https://www.builder.io/blog/css-carousel), [Nolan Lawson — Building a modern carousel with CSS scroll snap](https://nolanlawson.com/2019/02/10/building-a-modern-carousel-with-css-scroll-snap-smooth-scrolling-and-pinch-zoom/)

## 4. "This just changed" micro-interactions (calm, CSS-only)

No animation library in this app, so this needs to be pure `@keyframes`. The calm version (vs. a
"gamey" bounce/scale) is a **background-color flash that decays**, not a scale/transform pulse —
transform pulses read as game-notification style; a color-only flash-then-fade reads as
professional (this is the same pattern GitHub uses for "just updated" table rows, and Linear for
newly-changed issue rows).

```css
@keyframes evidence-flash {
  from { background-color: var(--good-tint); }
  to   { background-color: transparent; }
}
.just-updated {
  animation: evidence-flash 1.6s ease-out;
}
```
Concrete application points already in the code:
- `syncNote` ("+1 pick from ESPN") already exists as a text toast; pair it with `.just-updated`
  on the `Off the board` feed's newest `<div>` row (`state.recent_picks[0]`) so the new pick
  visibly settles in rather than just appearing.
- The `~{left}s` clock text going from black to `text-rose-600` under 15s is already a "state
  changed" signal — no animation needed there, a hard color swap is correct for a countdown.
- `t.vorp`/`t.gone_by_next` changing on the "Take one of these" list between polls is exactly
  the case for `.just-updated`: give each target row a `key` that changes when its numeric fields
  change is unnecessary (`key={t.player_id}` stays stable), but toggling a `useState` boolean for
  "just changed" via a `useRef` diff against the previous poll's value, then adding/removing the
  class, gives you the flash without any library.
- Respect `prefers-reduced-motion`: wrap the animation in `@media (prefers-reduced-motion: no-preference)`.

Sources: [CSS-Tricks — animation property almanac](https://css-tricks.com/almanac/properties/a/animation/), [Florin Pop — CSS Pulse Effect](https://www.florin-pop.com/blog/2019/03/css-pulse-effect/) (used here only for the keyframe *mechanics*, not the bounce effect itself — the recommendation above deliberately avoids the scale/box-shadow pulse these describe in favor of a flatter color fade)

## 5. Chrome-extension overlay isolation (for the ESPN status pill)

Per `docs/DRAFT_CAPTURE_EXTENSION.md` and the `chrome-extension/` directory, the current pill is
appended directly into the ESPN page DOM as a styled `<div>` — meaning it inherits ESPN's CSS
cascade (any `* { box-sizing }`, font resets, or z-index stacking context ESPN defines can bleed
into it), and any ESPN JS that queries broad selectors could incidentally match it.

**Concrete fix: mount into a Shadow DOM root, not a bare div.**
```js
const host = document.createElement('div');
host.id = 'gridiron-hq-pill-host';
host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
document.body.appendChild(host);
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>${compiledPillCss}</style><div class="pill">...</div>`;
```
Key points from current Chrome-extension practice:
- `all: initial` on the **host** element (not inside the shadow root) resets inherited CSS
  properties before the shadow boundary takes over — this is the specific technique that prevents
  ESPN's page-level resets from leaking in.
- `z-index: 2147483647` (max signed 32-bit int) on the host, `position: fixed`, is the de facto
  ceiling extensions use to guarantee top stacking regardless of the host page's own stacking
  contexts — a smaller value like `9999` can still lose to a page that also races z-index high.
- Compiled/static CSS injected as a string into the shadow root (as done above), not CSS-in-JS —
  CSS-in-JS libraries inject into `document.head`, which is *outside* the shadow boundary and
  won't apply. Tailwind's JIT output can be compiled once and inlined as a `<style>` string the
  same way.
- For draggable/collapsible behavior without fighting the host page's own click handlers: since
  everything drawn inside the shadow root is isolated from the page's event listeners by default
  (shadow DOM doesn't stop events from bubbling out, but the host page has no listeners bound to
  your internal nodes), a simple `pointerdown`/`pointermove`/`pointerup` drag handler scoped inside
  the shadow root is safe to add without namespacing concerns.
- No dedicated content-script UI library rose to "best real open-source example" in this pass, but
  the mechanism above (shadow root + `all: initial` host + compiled CSS string) is the
  convention documented consistently across the Chrome-extension shadow-DOM writeups found.

Sources: [Railwaymen — The secrets of Chrome Extensions and Shadow DOM](https://blog.railwaymen.org/chrome-extensions-shadow-dom), [Anders — Chrome Extension Content Script Stylesheet Isolation](https://apitman.com/3/), [DEV Community — Solving CSS/JS interference with React Shadow DOM](https://dev.to/developertom01/solving-css-and-javascript-interference-in-chrome-extensions-a-guide-to-react-shadow-dom-and-best-practices-9l), [crxjs/chrome-extension-tools — shadow DOM style isolation discussion #910](https://github.com/crxjs/chrome-extension-tools/discussions/910)

## Priority order (cheapest-to-implement, highest-leverage first)

1. Shadow DOM remount for the ESPN pill (isolation risk is real today; fix is mechanical).
2. `.just-updated` flash keyframe on `recent_picks[0]` and changed target rows.
3. Range bar for `preseason.p20`–`p80` reusing `InlineBar`.
4. `sticky left-0` on `EvidenceTable`'s Season column.
5. Scroll-snap rail for "other options" below `sm:`.
