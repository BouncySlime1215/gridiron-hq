import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';

export const DESTINATIONS = [
  ['Dashboard', '/', 'Overview and live workspace'],
  ['My Team', '/my-team', 'Roster, needs and lineup'],
  ['Players', '/players', 'Search, compare and rank players'],
  ['Draft Room', '/drafts', 'Drafts and live board'],
  ['32 Teams', '/teams', 'Team depth and scheme'],
  ['Fantasy Lab', '/lab', 'Predictions and edge tools'],
  ['Trade Lab', '/trade-lab', 'Trade construction and impact'],
  ['Camp News', '/news', 'News and fantasy impact'],
  ['My Leagues', '/leagues', 'Connected leagues'],
  ['Settings', '/settings', 'ESPN and data settings'],
  ['NFL Auto Picks', '/betting/nfl/picks', 'Decision desk and model hub'],
  ['NFL Props', '/betting/nfl/props', 'Player prop projections'],
  ['NFL Blind Replay', '/betting/training', 'Equity and validation evidence'],
  ['NFL Model Operations', '/betting/nfl/operations', 'Promotion gates and challenger state'],
  ['NFL Line Shop', '/betting/lines', 'Price and CLV comparison'],
  ['NFL Variables', '/betting/catalog', 'Feature contracts'],
  ['MLB Auto Picks', '/betting/mlb/auto', 'Forward and quarantined picks'],
  ['MLB Board', '/betting/mlb', 'Pregame projections'],
  ['MLB Pick Ledger', '/betting/mlb/picks', 'Tracked MLB decisions'],
] as const;

export function destinationLabel(pathname: string) {
  return DESTINATIONS.find(([, path]) => path === pathname)?.[0]
    ?? DESTINATIONS.find(([, path]) => path !== '/' && pathname.startsWith(`${path}/`))?.[0]
    ?? 'Workspace';
}

export default function QuickJump() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(v => !v); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const current = DESTINATIONS.find(([, path]) => path === location.pathname);
    if (!current) return;
    const old = JSON.parse(localStorage.getItem('gh:recent-routes') ?? '[]') as string[];
    localStorage.setItem('gh:recent-routes', JSON.stringify([current[1], ...old.filter(x => x !== current[1])].slice(0, 5)));
  }, [location.pathname]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = DESTINATIONS.filter(([name, path, note]) => !q || `${name} ${path} ${note}`.toLowerCase().includes(q));
    if (q) return matched;
    const recent = JSON.parse(localStorage.getItem('gh:recent-routes') ?? '[]') as string[];
    return [...matched].sort((a, b) => {
      const ai = recent.indexOf(a[1]), bi = recent.indexOf(b[1]);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
  }, [query]);
  const go = (path: string) => { setOpen(false); setQuery(''); navigate(path); };

  return <>
    <button onClick={() => setOpen(true)} className="quick-jump-button" aria-label="Jump to a feature">
      <span>Jump to</span><kbd>⌘K</kbd>
    </button>
    {open && createPortal(<div className="quick-jump-backdrop" onMouseDown={() => setOpen(false)}>
      <section className="quick-jump-panel" role="dialog" aria-modal="true" aria-label="Jump to a feature" onMouseDown={e => e.stopPropagation()}>
        <div className="quick-jump-search"><span>⌕</span><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search every feature…" /></div>
        <div className="quick-jump-results">
          {rows.map(([name, path, note]) => <button key={path} onClick={() => go(path)}>
            <span><b>{name}</b><small>{note}</small></span><span className="arrow">→</span>
          </button>)}
          {!rows.length && <div className="p-6 text-center text-sm text-slate-500">No matching feature.</div>}
        </div>
        <footer><span>{rows.length} destinations</span><span>Esc to close</span></footer>
      </section>
    </div>, document.body)}
  </>;
}
