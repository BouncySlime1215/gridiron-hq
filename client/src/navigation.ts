/**
 * The one place a first-class destination in this app is declared.
 *
 * This used to live in App.tsx as `NAV_GROUPS`, with the command palette
 * (`components/QuickJump.tsx`) keeping its own hand-maintained `DESTINATIONS`
 * list alongside it. The two drifted, as two hand-maintained lists of the same
 * thing always do: by the time this was pulled out, the sidebar offered
 * Start/Sit, League Brain, Trends, The Model and Data Health, and ⌘K knew
 * about none of them. Nothing failed loudly — the palette just quietly could
 * not reach a third of the app.
 *
 * Now the sidebar renders NAV_GROUPS and the palette derives its primary rows
 * from the same constant, so adding a nav item makes it reachable from both.
 * The palette also offers DEEP_DESTINATIONS below, which are real pages that
 * deliberately do not earn a permanent sidebar slot.
 *
 * Deliberately NOT listed anywhere here: the legacy and duplicate routes
 * (`/props/*`, `/betting/mlb/legacy`, `/betting/mlb/auto-legacy`,
 * `/nfl-board`). They still resolve for old links and bookmarks, but a
 * "jump to" list is a statement about where a user should go, and pointing
 * them at a route slated for removal is the wrong answer.
 */

export type NavItem = { to: string; label: string; icon: string; end?: boolean; live?: boolean };
export type NavGroup = { label: string; question: string; items: NavItem[] };

/**
 * UX-11 (2026-09-23, Nick: "my team good"): My team promotes out of League
 * Hub's inner tab to its own top-level route (`/my-team`, first in this
 * group) per docs/handoff/local/ui/UX-02-ia.md. Nav stays at 8 items, so
 * something had to fold: Nick decided X's & O's is not one of the 8 and
 * "lives as a section of News" (Intelligence group) instead of a sidebar
 * slot — its page (Teams.tsx) and route (`/teams`) are untouched, only the
 * nav entry moved; News.tsx links into it.
 */
export const NAV_GROUPS: NavGroup[] = [
  { label: 'My team', question: 'Win this week', items: [
    { to: '/my-team', label: 'My team', icon: 'M', end: true },
    { to: '/league', label: 'League Hub', icon: 'L', end: true },
    { to: '/lineup', label: 'Start/Sit', icon: 'S' },
    { to: '/trade-lab', label: 'Trade Lab', icon: 'T' },
    { to: '/trade-brain', label: 'Trade Brain', icon: 'B' },
    { to: '/draft', label: 'Draft', icon: 'D', live: true }
  ]},
  { label: 'Intelligence', question: 'Understand football', items: [
    { to: '/news', label: 'News', icon: 'N' }
  ]},
  { label: 'Setup', question: '', items: [
    { to: '/settings', label: 'Settings', icon: 'S' }
  ]}
];

/** A one-line description per nav route, for the palette's second line. */
const NAV_NOTES: Record<string, string> = {
  '/my-team': 'Title-odds ladder, doomsday cards, luck ledger and risk across your leagues',
  '/league': 'Roster, sync health and league-wide analysis',
  '/draft': 'Mock, live and recap modes',
  '/trade-lab': 'Trade construction and impact',
  '/trade-brain': 'Who actually trades with you, and the message to send them',
  '/lineup': 'Weekly start/sit calls with the reasoning',
  '/news': 'Attributed news and fantasy impact',
  '/settings': 'Connections and local API configuration'
};

/**
 * Real pages worth jumping to that intentionally have no sidebar slot.
 * Reachable by clicking through; tedious to reach that way.
 *
 * Every entry here must resolve to something. Eight did not: seven
 * `/betting/nfl/*` subviews and `/edge` were listed long after the routes
 * themselves were removed (App.tsx has no `/betting` or `/edge` route), so the
 * palette's own "jump to" list sent the user to NotFound — a dead link a user
 * hits, not a stale comment. They are gone, along with the `/betting/nfl/wong`
 * note above. The rest are redirects into a hub's own view, which is a real
 * destination; `/rankings` and `/projections` are the weakest of those, since
 * both land on League Hub without a view of their own.
 */
export const DEEP_DESTINATIONS: readonly (readonly [string, string, string])[] = [
  ['Rankings', '/rankings', 'Your rankings and tiers'],
  ['Projections', '/projections', 'Weekly and rest-of-season projections'],
  ['Saved Drafts', '/drafts', 'Past mock and live draft recaps'],
  ['Live Draft Room', '/live-draft', 'Mirror an in-progress ESPN draft'],
  ["X's & O's", '/teams', 'Whiteboard schemes and team context']
] as const;

/** Every palette destination: the sidebar, in nav order, then the deep pages. */
export const DESTINATIONS: readonly (readonly [string, string, string])[] = [
  ...NAV_GROUPS.flatMap(group => group.items.map(item =>
    [item.label, item.to, NAV_NOTES[item.to] ?? group.question] as const)),
  ...DEEP_DESTINATIONS
];

/**
 * The human name for whatever route is showing, used in the header.
 * Longest-prefix wins so a nested route resolves to the most specific
 * destination that covers it, rather than to the first one a plain
 * `startsWith` scan in list order happened to match.
 */
export function destinationLabel(pathname: string) {
  const exact = DESTINATIONS.find(([, path]) => path === pathname);
  if (exact) return exact[0];
  const prefixed = DESTINATIONS
    .filter(([, path]) => path !== '/' && pathname.startsWith(`${path}/`))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return prefixed?.[0] ?? 'Workspace';
}

/**
 * Old League Hub deep links that now live at their own route (UX-11):
 * `/league?view=team` was the inner "My team" tab, now `/my-team`.
 * Returns where to redirect, or null to render League Hub as-is.
 */
export function legacyLeagueRedirect(params: URLSearchParams): string | null {
  return params.get('view') === 'team' ? '/my-team' : null;
}
