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

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Fantasy', question: 'Manage my team', items: [
    { to: '/', label: 'Command Center', icon: 'H', end: true },
    { to: '/league', label: 'League Hub', icon: 'L' },
    { to: '/draft', label: 'Draft', icon: 'D', live: true },
    { to: '/players', label: 'Players', icon: 'P' },
    { to: '/trade-lab', label: 'Trade Lab', icon: 'T' },
    { to: '/lineup', label: 'Start/Sit', icon: 'S' },
    { to: '/brain', label: 'League Brain', icon: 'B' },
    { to: '/trends', label: 'Trends', icon: 'W' }
  ]},
  { label: 'Intelligence', question: 'Understand football', items: [
    { to: '/news', label: 'News', icon: 'N' },
    { to: '/teams', label: "X's & O's", icon: 'X' },
    { to: '/matchups', label: 'Matchups', icon: 'M' }
  ]},
  { label: 'Betting', question: 'Track the market', items: [
    { to: '/betting', label: 'Betting Desk', icon: 'B', end: true },
    { to: '/betting/nfl', label: 'NFL', icon: 'N' },
    { to: '/betting/mlb/auto', label: 'MLB', icon: 'M' }
  ]},
  { label: 'Lab', question: 'Verify the model', items: [
    { to: '/model', label: 'The Model', icon: 'M' },
    { to: '/lab', label: 'Accuracy & Experiments', icon: 'A' },
    { to: '/data-health', label: 'Data Health', icon: 'H' },
    { to: '/settings', label: 'Settings', icon: 'S' }
  ]}
];

/** A one-line description per nav route, for the palette's second line. */
const NAV_NOTES: Record<string, string> = {
  '/': 'Prioritized actions and source freshness',
  '/league': 'Roster, sync health and league-wide analysis',
  '/draft': 'Mock, live and recap modes',
  '/players': 'Search, compare and rank players',
  '/trade-lab': 'Trade construction and impact',
  '/lineup': 'Weekly start/sit calls with the reasoning',
  '/brain': 'League-wide tiers, tendencies and rival reads',
  '/trends': 'Movement in usage, role and market value',
  '/news': 'Attributed news and fantasy impact',
  '/teams': 'Whiteboard schemes and team context',
  '/matchups': 'Opponent history and weekly projections',
  '/betting': 'Path to profit across NFL and MLB',
  '/betting/nfl': 'Board, execution, live games and one engine',
  '/betting/mlb/auto': 'Slate, forward capture and evidence ledger',
  '/model': 'What the model believes and why',
  '/lab': 'Backtests, promotion gates and registry',
  '/data-health': 'Feed freshness, cadence and failure modes',
  '/settings': 'Connections and local API configuration'
};

/**
 * Real pages worth jumping to that intentionally have no sidebar slot —
 * mostly subviews of the NFL betting desk, which owns a single nav entry and
 * routes internally. Reachable by clicking through; tedious to reach that way.
 */
export const DEEP_DESTINATIONS: readonly (readonly [string, string, string])[] = [
  ['Research Lab', '/betting/nfl/research', 'Experiments, negative results and the agent master plan'],
  ['Execution Ledger', '/betting/nfl/ledger', 'Exact-contract accept/settle path with real realized P&L'],
  ['NFL Auto Picks', '/betting/nfl/auto-picks', "The model's graded record, not what it would bet now"],
  ['Forward Ledger', '/betting/nfl/forward', "This week's frozen picks and their settlement"],
  ['NFL Props', '/betting/nfl/props', 'Player prop board and ticket builder'],
  ['Live Games', '/betting/nfl/watch', 'In-game state against the pre-game read'],
  ['Model Operations', '/betting/nfl/operations', 'Runs, gates and engine health'],
  ['Rankings', '/rankings', 'Your rankings and tiers'],
  ['Projections', '/projections', 'Weekly and rest-of-season projections'],
  ['Saved Drafts', '/drafts', 'Past mock and live draft recaps'],
  ['Live Draft Room', '/live-draft', 'Mirror an in-progress ESPN draft'],
  ['My Team', '/my-team', 'Your roster at a glance'],
  ['Edge', '/edge', 'Where the model disagrees with consensus']
] as const;

/** Every palette destination: the sidebar, in nav order, then the deep pages. */
export const DESTINATIONS: readonly (readonly [string, string, string])[] = [
  ...NAV_GROUPS.flatMap(group => group.items.map(item =>
    [item.label, item.to, NAV_NOTES[item.to] ?? group.question] as const)),
  ...DEEP_DESTINATIONS
];

/**
 * The human name for whatever route is showing, used in the header.
 * Longest-prefix wins so `/betting/nfl/research` resolves to Research Lab
 * rather than to NFL, which a plain `startsWith` scan in list order would
 * have picked instead.
 */
export function destinationLabel(pathname: string) {
  const exact = DESTINATIONS.find(([, path]) => path === pathname);
  if (exact) return exact[0];
  const prefixed = DESTINATIONS
    .filter(([, path]) => path !== '/' && pathname.startsWith(`${path}/`))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return prefixed?.[0] ?? 'Workspace';
}
