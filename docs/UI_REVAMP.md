# Total UI Revamp

Companion to `docs/HANDOFF.md`. This is cross-cutting: it applies to Phase 4 and
Phase 3.5 work as they land, and stands alone as its own phase.

---

## 0. Non-negotiable starting constraints

**Nick's stated preferences, learned from direct feedback — do not relitigate:**
- **White / light backgrounds.** A dark-themed dashboard was explicitly rejected.
- **Schematic, not decorative.** A green football-field SVG was rejected as
  "too confusing"; a plain whiteboard-style X's-and-Os diagram was preferred.
- Clean, minimal, subtle slate greys. Decorative/skeuomorphic backgrounds read as
  clutter.

Figma is connected (account `nmatta1215@gmail.com`, design file
"Gridiron HQ — Design" at `figma.com/design/5ELRsMZUl2Z0DnfjbobJ9K`). Load the
`figma-use` skill resource before any `use_figma` call.

---

## 1. The actual problem

There are **20 top-level pages**: `DraftRoom, Drafts, Edge, FantasyLab, Home,
Leagues, LiveDraft, Model, MyTeam, News, NflMarketBoard, PlayerDetail, Players,
Projections, Rankings, Settings, TeamDetail, Teams, TradeLab`, plus `betting/`
and `props/` directories.

That is not an information architecture, it is an accretion. Several pages
overlap (`Players` / `PlayerDetail` / `Rankings` / `Projections` all answer
"who is good"), and the split between fantasy, betting, and model-lab concerns
is not expressed in navigation at all.

---

## 2. Information architecture

Collapse to **four top-level domains**, each with a clear question it answers:

```
FANTASY          "Manage my team"
  Home / Command Center
  League Hub        (was: Leagues, MyTeam)
  Draft             (was: Drafts, DraftRoom, LiveDraft)
  Players           (was: Players, PlayerDetail, Rankings, Projections)
  Trade Lab
  Waivers

INTELLIGENCE     "Understand football"
  News
  X's & O's         (was: Teams, TeamDetail, FormationView)
  Matchups

BETTING          "Track the market"          [see PHASE_3_5]
  Ledger
  Divergence Board
  Prop Lab
  Honesty Panel

LAB              "Verify the model"          [see PHASE_4]
  Accuracy Ledger
  Experiments
  Registry / Promotion
  Dev Hub
```

Rules:
- **Players is one page with modes**, not four pages. Rankings/Projections become
  views over the same table with different default sorts and columns.
- **Draft is one page with three states** (mock / live / recap), not three pages.
- Betting and Lab are visibly separate from Fantasy — a casual user should never
  stumble into a model-promotion gate.

---

## 3. Design system

Build this **first**, before touching any page. Every page below assumes it.

### 3.1 Tokens
```
color:   --bg #ffffff · --surface #f8fafc · --line #e2e8f0
         --ink #0f172a · --muted #64748b · --subtle #94a3b8
         --accent #059669 (single accent; used sparingly)
         --warn #b45309 · --danger #b91c1c · --info #0369a1
space:   4 8 12 16 24 32 48 64            (no arbitrary values)
radius:  6 (controls) · 10 (cards) · 999 (pills)
type:    12 / 13 / 14 / 16 / 20 / 28 / 36
         one family, three weights (400/600/800)
shadow:  one elevation for cards, one for overlays. That is all.
```

### 3.2 Core components (build once, use everywhere)
- `Card`, `Section`, `PageHeader`
- `DataTable` — sortable, filterable, virtualised, sticky header, column presets
- `StatTile` — value + label + delta + freshness
- `Distribution` — the projection distribution plot (Phase 4 §5.1)
- `DriverBars` — additive contribution decomposition
- `Confidence` — calibrated confidence indicator
- `Provenance` — source + timestamp + version, as a hover/expand
- `EmptyState`, `ErrorState`, `Skeleton` — one of each, never ad-hoc
- `Sheet` / `Drawer` for detail-on-demand instead of navigation
- `Toast` with **deduplication built in** (repeated notices are a named defect in
  the Phase 3 spec)

### 3.3 Interaction rules
- **No stale-data flash.** Keep the previous value visible and dimmed until the
  new one resolves. Never blank → spinner → value.
- **Skeletons mirror the real layout**, so nothing shifts on load.
- **Scroll position is sacred.** Background refresh must never move it.
- Background refresh must never reset search, filters, queue, or watchlist.
- Late responses must never overwrite newer state (request sequencing / abort).
- Detail opens in a drawer where possible; full navigation only for a real
  context switch.

---

## 4. Accessibility (treat as correctness, not polish)

- Every flow completable by keyboard alone.
- Visible focus rings — never `outline: none` without a replacement.
- Programmatic labels on every control; errors associated to their field via
  `aria-describedby`.
- State changes announced via a polite live region (draft picks landing, sync
  status changing).
- **Never rely on colour alone** — pair with icon, shape, or text. This matters
  doubly in betting (win/loss) and draft (available/taken).
- Respect `prefers-reduced-motion`.
- Target AA contrast minimum; verify, don't assume.

---

## 5. The Home / Command Center

The home page must answer six questions, in this order, above the fold:

1. **What needs my attention?** — expiring credentials, draft starting soon,
   injured starter in my lineup, waiver deadline
2. **What changed?** — since last visit, ranked by impact on *my* teams
3. **What should I do next?** — concrete actions, each linking to the place it
   happens
4. **Why?** — one line of evidence per recommendation
5. **How confident is the system?** — calibrated, not decorative
6. **When was this updated?** — per data source, not one global timestamp

Anti-patterns to avoid: a wall of equal-weight cards; vanity metrics; anything
that requires reading a number to know whether it is good.

---

## 6. Per-page briefs

**League Hub** — connection health, roster, schedule, standings, playoff odds
from the season sim. Multi-league switching that never leaks state between
leagues (a named Phase 3 defect).

**Draft** — see `PHASE_3` spec §I for the full state/control matrix. Ten states,
seven controls, accessible, mobile-capable.

**Players** — one virtualised table; modes for Rankings / Projections / Waivers;
row expands to the projection card; compare drawer for up to 4.

**Trade Lab** — before/after lineup visualisation, fairness range, acceptance
likelihood, red flags, and an explicit separation between the deterministic
trade engine's evidence and the LLM's sense-check commentary.

**X's & O's** — whiteboard-style schematic diagrams (per the stated preference).
Personnel, formations, concepts, coverages. **Label clearly**: observed data vs
manually curated concept vs model inference vs educational example.

---

## 7. Performance

- Virtualise any list over ~100 rows (`Players` is 1000+).
- Route-level code splitting; the betting and lab bundles should not load for a
  fantasy-only user.
- Cache API responses with explicit invalidation on mutation.
- Target: interaction to visual feedback < 100ms, full page < 1s on repeat visit.

---

## 8. Sequence

1. **Design system + tokens + core components.** Nothing else starts first.
2. **Navigation / IA restructure** — the four domains, with redirects from old
   routes so nothing 404s.
3. **Home / Command Center** — highest visibility, sets the tone.
4. **Players consolidation** — largest surface-area win, kills 3 pages.
5. **Draft** (pairs with Phase 3D).
6. **Betting hub** (pairs with Phase 3.5).
7. **Lab** (pairs with Phase 4).
8. Accessibility audit + performance pass across all of it.

Do not do 3-7 before 1-2. Rebuilding pages onto an unfinished design system is
how you end up with 20 pages again.
