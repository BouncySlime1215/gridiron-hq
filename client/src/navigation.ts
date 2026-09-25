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
 * UI consolidation (docs/ui/CONSOLIDATION-MAP.md): seven areas instead of eight pages.
 * Today leads. Trades holds the War Room planner, the manager reads, proposals and Trade
 * Lab; My Team holds Start/Sit; Players holds the board, rankings, news and NFL teams.
 * Every old URL redirects (App.tsx, components/Redirects.tsx; test/ui-redirects.test.js).
 */
export const NAV_GROUPS: NavGroup[] = [
  { label: 'Play', question: 'Win this week and the title', items: [
    { to: '/', label: 'Today', icon: 'T', end: true },
    { to: '/trades', label: 'Trades', icon: 'X' },
    { to: '/my-team', label: 'My team', icon: 'M', end: true },
    { to: '/league', label: 'League', icon: 'L', end: true },
    { to: '/players', label: 'Players', icon: 'P' },
    { to: '/draft', label: 'Draft', icon: 'D', live: true }
  ]},
  { label: 'Setup', question: '', items: [
    { to: '/settings', label: 'Settings', icon: 'S' }
  ]}
];

/** A one-line description per nav route, for the palette's second line. */
const NAV_NOTES: Record<string, string> = {
  '/': 'The next move, this week across every league, and what to watch',
  '/trades': 'The planner, who trades with you, proposals, and the trade finder',
  '/my-team': 'Title odds, start/sit, scouting report and the ceiling lineup',
  '/league': 'Your leagues, sync health and every roster',
  '/players': 'Market board, your rankings, news and NFL teams',
  '/draft': 'Mock, live and recap modes',
  '/settings': 'Connections, health and local API configuration'
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
  ['Start/Sit', '/my-team?view=lineup', 'Weekly start/sit calls with the reasoning'],
  ['Trade finder', '/trades?view=find', 'Trade construction, title impact and targets'],
  ['Who trades with you', '/trades?view=managers', 'Your read of each manager, beside the measured one'],
  ['Rankings', '/players?view=rankings', 'Your rankings and tiers'],
  ['News', '/players?view=news', 'Attributed news and fantasy impact'],
  ["X's & O's", '/players/teams', 'Whiteboard schemes and team context'],
  ['Live Draft Room', '/draft?view=live', 'Mirror an in-progress ESPN draft']
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
