# Gridiron HQ UI system

The short reference. The long rationale for type, the basis ramp and motion is
`docs/design/design-system.md`; this page covers what the War Room v2 work added
and how every page uses it.

## Where it lives

| What | File |
|---|---|
| Tokens: colour, edges, elevation, radius, motion | `client/src/styles/tokens.css` |
| Type, basis ramp, motion durations, legacy names | `client/src/index.css` (its old names read the tokens) |
| Primitives and the app shell's classes | `client/src/styles/ui.css` |
| Primitive components | `client/src/components/ui/DesignSystem.tsx` |
| Icons (Lucide paths, inlined, one stroke) | `client/src/components/warroom/icons.tsx`, re-exported as `Icon` |

## Tokens

- **Colour.** There is one accent, `--c-accent` ("signal", a cobalt-violet), used for actions, selection and focus. The neutrals are tuned cool: `--c-bg`, `--c-card`, `--c-soft`, `--c-ink`, `--c-ink2`, `--c-muted` and `--c-subtle`. The status tones `--c-green`, `--c-amber` and `--c-red` (each with a `-tint`) are used only for status marks. Good means green, never the accent.
- **Dark.** `[data-theme="dark"]` redefines every colour token, hand-tuned rather than inverted.
- **Edges.** `--c-line` is a 1px alpha hairline, and `--c-line-strong` is the hover or active version. There are no solid grey borders. In dark, `--c-edge` adds a top-light inner edge.
- **Elevation.** There are two steps: `--e1` for things at rest and `--e2` for hover and overlays.
- **Radius.** The sizes follow a hierarchy where an inner radius equals the outer radius minus the inset:

  | Token | Size | Used for |
  |---|---|---|
  | `--r-hero` | 24 | the hero card |
  | `--r-card` | 18 | cards |
  | `--r-tile`, `--r-ctl` | 12 | tiles and controls |
  | `--r-badge` | 8 | badges |

  Pills and avatars are fully round.
- **Motion.**
  - Durations are `--t-fast` 140, `--t` 180 and `--t-slow` 240 ms. The easings are `--ease-out` for entrances and `--ease-spring` for drawers.
  - Only transform and opacity animate.
  - A hover shadow is a pre-painted layer that fades in; the shadow itself is never repainted per frame.
  - Everything turns off under `prefers-reduced-motion`.
- **Page.** `--page` is a soft layered gradient over `--c-bg`. `--bar` is the frosted top-bar fill, with a solid fallback.

## Type

Archivo carries display, body and numbers, and every number uses tabular figures. Spline Sans Mono is used only for labels. See `docs/design/design-system.md` section 1, which a test holds to.

## Primitives (`components/ui/DesignSystem.tsx`)

| Primitive | Use |
|---|---|
| `Card` (`lift` for clickable) | Every boxed surface. |
| `Section`, `PageHeader` | Section and page titles. |
| `Button` (`primary` / `quiet`, `sm` / `lg`, `icon`), `IconButton` | Every button. There is one primary action per screen. |
| `Chip` (`accent` / `good` / `warn` / `bad`, `on`) | Filters, tags and status. |
| `Stat`, `StatTile` | A number with its label. |
| `Avatar` | A player or manager picture, with an initials fallback. |
| `Tabs` | Switching one view at a time. |
| `DataTable` | Tables: a sticky header, hairline rows and a hover tint. |
| `Skeleton`, `EmptyState`, `ErrorState` | Loading, nothing-yet and failed states. |
| `Sheet` | A side sheet on desktop and a bottom sheet on phones. |
| `ToastProvider` / `useToast` | Brief confirmations. |
| `Icon` | The one icon set. |

## Rules every route PR is held to

1. Build with the primitives. A one-off that duplicates one is replaced, not kept beside it.
2. The overflow, clipped-text and fixed-over-content scan reports 0 at 375, 768, 1024, 1440 and 1920, in light and dark.
3. There are no long tasks over 50 ms on transitions or hover.
4. There are no stale buttons: every visible control works or is disabled with a tooltip saying why.
5. There is no raw engine id or dotted field name in the UI.

## Stopgap mapping

Until a route is migrated, `ui.css` maps the stock Tailwind neutrals it still uses onto the tokens: slate borders, text and backgrounds, `rounded-lg`/`xl`/`2xl`, and `shadow-*`. `index.css` maps the emerald classes onto the accent. Each route migration removes that route's reliance on the mapping.
