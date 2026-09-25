import { Navigate, useLocation, useParams } from 'react-router-dom';

/**
 * UI consolidation (docs/ui/CONSOLIDATION-MAP.md section 5): every URL from before the
 * seven areas lands on its new home, so no bookmark or in-app link breaks. App.tsx
 * mounts one of these per old route; test/ui-redirects.test.js holds the table.
 */

/** Old path + query -> new URL. Query strings the old page read are carried over. */
export const OLD_TO_NEW: Record<string, (params: Record<string, string | undefined>, search: URLSearchParams) => string> = {
  '/leagues': () => '/league',
  '/lineup': () => '/my-team?view=lineup',
  '/trade-lab': () => '/trades?view=find',
  // Trade Brain's own ?view= values (its planner, managers, proposals tabs) carry over as they are.
  '/trade-brain': (_p, q) => (q.get('view') ? `/trades?view=${encodeURIComponent(q.get('view') as string)}` : '/trades'),
  '/teams': () => '/players/teams',
  '/teams/:abbr': p => `/players/teams/${p.abbr ?? ''}`,
  '/news': () => '/players?view=news',
  '/rankings': () => '/players?view=rankings',
  '/projections': () => '/players?view=board',
  '/drafts': () => '/draft',
  '/drafts/:id': p => `/draft/${p.id ?? ''}`,
  '/live-draft': () => '/draft?view=live',
  '/live-draft/:id': p => `/draft/live/${p.id ?? ''}`,
};

/** Renders the redirect for one old route pattern (a key of OLD_TO_NEW). */
export function MovedTo({ from }: { from: keyof typeof OLD_TO_NEW }) {
  const params = useParams();
  const location = useLocation();
  return <Navigate to={OLD_TO_NEW[from](params, new URLSearchParams(location.search))} replace />;
}
