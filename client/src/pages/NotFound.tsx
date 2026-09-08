import { useLocation, useNavigate, Link } from 'react-router-dom';

/**
 * Catch-all for any URL that doesn't match a route — a stale bookmark, a typo,
 * or a link into a page that's since moved. Previously this silently redirected
 * to "/", which made a bad link look like the app teleported you home for no
 * reason. This says plainly what happened and gives real ways out.
 */
const RECOVERY_LINKS = [
  { to: '/', label: 'Command Center', blurb: 'Home dashboard' },
  { to: '/league', label: 'League Hub', blurb: 'Your team and league' },
  { to: '/players', label: 'Players', blurb: 'Rankings and projections' },
  { to: '/betting', label: 'Betting Desk', blurb: 'Market intelligence' }
];

export default function NotFound() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-2xl pt-6">
      <div className="card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <h1 className="text-xl font-bold">Page not found</h1>
        </div>
        <p className="text-sm text-slate-600">
          There's no page at <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">{location.pathname}</code>.
          It may have moved, or the link was mistyped.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="btn-ghost" onClick={() => navigate(-1)}>Go back</button>
          <Link to="/" className="btn-ghost">Go to Command Center</Link>
        </div>
      </div>

      <div className="card p-5 mt-4 space-y-3">
        <h2 className="font-bold text-slate-800">Or try one of these</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {RECOVERY_LINKS.map(link => (
            <Link
              key={link.to}
              to={link.to}
              className="rounded-lg border border-slate-200 px-3 py-2 hover:border-emerald-300 hover:bg-emerald-50/40"
            >
              <div className="text-sm font-semibold text-slate-800">{link.label}</div>
              <div className="text-xs text-slate-500">{link.blurb}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
