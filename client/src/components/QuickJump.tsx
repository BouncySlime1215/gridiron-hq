import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, headshotUrl } from '../api';

export const DESTINATIONS = [
  ['Command Center', '/', 'Prioritized actions and source freshness'],
  ['League Hub', '/league', 'Roster, sync health and league-wide analysis'],
  ['Draft', '/draft', 'Mock, live and recap modes'],
  ['Players', '/players', 'Search, compare and rank players'],
  ['Trade Lab', '/trade-lab', 'Trade construction and impact'],
  ['News', '/news', 'Attributed news and fantasy impact'],
  ["X's & O's", '/teams', 'Whiteboard schemes and team context'],
  ['Matchups', '/matchups', 'Opponent history and weekly projections'],
  ['Betting Hub', '/betting', 'NFL and MLB ledgers'],
  ['NFL Auto', '/betting/nfl/picks', 'Picks, CLV, line shop and model evidence'],
  ['MLB Auto Picks', '/betting/mlb/auto', 'Forward and quarantined picks'],
  ['Accuracy & Experiments', '/lab', 'Backtests, promotion gates and registry'],
  ['Settings', '/settings', 'Connections and local API configuration'],
] as const;

export function destinationLabel(pathname: string) {
  return DESTINATIONS.find(([, path]) => path === pathname)?.[0]
    ?? DESTINATIONS.find(([, path]) => path !== '/' && pathname.startsWith(`${path}/`))?.[0]
    ?? 'Workspace';
}

export default function QuickJump() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [players, setPlayers] = useState<any[]>([]);
  const location = useLocation();
  const navigate = useNavigate();

  // Search actual players while typing, not just static feature pages — the
  // command palette used to only navigate between the ~20 pages listed below,
  // with no way to jump straight to "Mahomes" the way ⌘K implies it should.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setPlayers([]); return; }
    const t = setTimeout(() => {
      api<any[]>(`/players?q=${encodeURIComponent(q)}`).then(ps => setPlayers(ps.slice(0, 6))).catch(() => setPlayers([]));
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

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
        <div className="quick-jump-search"><span>⌕</span><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search players, or jump to a feature…" /></div>
        <div className="quick-jump-results">
          {players.length > 0 && (
            <div className="quick-jump-group">
              <div className="quick-jump-group-label">Players</div>
              {players.map(p => (
                <button key={p.id} onClick={() => go(`/players/${p.id}`)}>
                  <img src={headshotUrl(p) ?? ''} alt="" className="quick-jump-avatar" onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                  <span className="quick-jump-label"><b>{p.name}</b><small>{p.position} · {p.team_abbr ?? 'FA'}</small></span>
                  <span className="arrow">→</span>
                </button>
              ))}
            </div>
          )}
          {rows.map(([name, path, note]) => <button key={path} onClick={() => go(path)}>
            <span><b>{name}</b><small>{note}</small></span><span className="arrow">→</span>
          </button>)}
          {!rows.length && !players.length && <div className="p-6 text-center text-sm text-slate-500">No matching feature or player.</div>}
        </div>
        <footer><span>{rows.length} destinations</span><span>Esc to close</span></footer>
      </section>
    </div>, document.body)}
  </>;
}
