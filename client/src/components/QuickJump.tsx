import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, headshotUrl } from '../api';
import { DESTINATIONS } from '../navigation';

export { DESTINATIONS, destinationLabel } from '../navigation';

/**
 * `localStorage` is a shared, user-writable store that can hold anything —
 * a half-written value from a killed tab, something a previous version of
 * this app wrote in a different shape, or nothing at all in a private window.
 * A bare `JSON.parse` of it inside a render path turns any of those into a
 * blank screen, and "recently visited pages" is never worth a crash.
 */
function recentRoutes(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('gh:recent-routes') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export default function QuickJump() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [players, setPlayers] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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
    const old = recentRoutes();
    try {
      localStorage.setItem('gh:recent-routes', JSON.stringify([current[1], ...old.filter(x => x !== current[1])].slice(0, 5)));
    } catch { /* private mode, or the quota is full; recents are a convenience */ }
  }, [location.pathname]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = DESTINATIONS.filter(([name, path, note]) => !q || `${name} ${path} ${note}`.toLowerCase().includes(q));
    if (q) return matched;
    const recent = recentRoutes();
    return [...matched].sort((a, b) => {
      const ai = recent.indexOf(a[1]), bi = recent.indexOf(b[1]);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
  }, [query]);

  const go = (path: string) => { setOpen(false); setQuery(''); navigate(path); };

  // Players first, then destinations — the same order they render in, so the
  // highlighted row and the Enter key always agree with what the eye sees.
  const options = useMemo(
    () => [...players.map(p => `/players/${p.id}`), ...rows.map(([, path]) => path)],
    [players, rows]
  );

  // A ⌘K palette that can only be clicked is half a palette: the whole point
  // is never leaving the keyboard. Arrow keys move, Enter opens, and the
  // selection wraps at both ends so holding Down never dead-ends.
  useEffect(() => { setCursor(0); }, [query, open]);
  useEffect(() => {
    if (cursor > 0 && cursor >= options.length) setCursor(Math.max(0, options.length - 1));
  }, [options.length, cursor]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, options.length]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!options.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => (c + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => (c - 1 + options.length) % options.length); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(options[cursor]); }
  };

  const activeId = options.length ? `quick-jump-option-${cursor}` : undefined;

  return <>
    <button onClick={() => setOpen(true)} className="quick-jump-button" aria-label="Jump to a feature">
      <span>Jump to</span><kbd>⌘K</kbd>
    </button>
    {open && createPortal(<div className="quick-jump-backdrop" onMouseDown={() => setOpen(false)}>
      <section className="quick-jump-panel" role="dialog" aria-modal="true" aria-label="Jump to a feature" onMouseDown={e => e.stopPropagation()}>
        <div className="quick-jump-search"><span>⌕</span>
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Search players, or jump to a feature…"
            role="combobox" aria-expanded="true" aria-controls="quick-jump-results"
            aria-activedescendant={activeId} aria-autocomplete="list" />
        </div>
        <div className="quick-jump-results" id="quick-jump-results" role="listbox" ref={listRef}
          aria-label="Destinations and players">
          {players.length > 0 && (
            <div className="quick-jump-group">
              <div className="quick-jump-group-label">Players</div>
              {players.map((p, i) => (
                <button key={p.id} id={`quick-jump-option-${i}`} role="option" aria-selected={cursor === i}
                  data-active={cursor === i} onMouseEnter={() => setCursor(i)} onClick={() => go(`/players/${p.id}`)}>
                  <img src={headshotUrl(p) ?? ''} alt="" className="quick-jump-avatar" onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                  <span className="quick-jump-label"><b>{p.name}</b><small>{p.position} · {p.team_abbr ?? 'FA'}</small></span>
                  <span className="arrow">→</span>
                </button>
              ))}
            </div>
          )}
          {rows.map(([name, path, note], i) => {
            const index = players.length + i;
            return <button key={path} id={`quick-jump-option-${index}`} role="option" aria-selected={cursor === index}
              data-active={cursor === index} onMouseEnter={() => setCursor(index)} onClick={() => go(path)}>
              <span><b>{name}</b><small>{note}</small></span><span className="arrow">→</span>
            </button>;
          })}
          {!rows.length && !players.length && <div className="p-6 text-center text-sm text-slate-500">No matching feature or player.</div>}
        </div>
        <footer><span>{rows.length} destinations</span><span>↑↓ to move · ↵ to open · Esc to close</span></footer>
      </section>
    </div>, document.body)}
  </>;
}
