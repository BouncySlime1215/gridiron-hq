import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
import Rankings from './pages/Rankings';
import Drafts from './pages/Drafts';
import DraftRoom from './pages/DraftRoom';
import MyTeam from './pages/MyTeam';
import PlayerDetail from './pages/PlayerDetail';
import Projections from './pages/Projections';
import Leagues from './pages/Leagues';
import { PlayerCardProvider } from './components/PlayerCard';
import DevHub from './components/DevHub';
import RefreshAll from './components/RefreshAll';
import News from './pages/News';
import Settings from './pages/Settings';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '🏠' },
  { to: '/my-team', label: 'My Team', icon: '⭐' },
  { to: '/rankings', label: 'Rankings', icon: '📋' },
  { to: '/drafts', label: 'Draft Room', icon: '🎯' },
  { to: '/teams', label: '32 Teams', icon: '🏈' },
  { to: '/projections', label: 'Projections', icon: '📊' },
  { to: '/news', label: 'Camp News', icon: '📰' },
  { to: '/leagues', label: 'My Leagues', icon: '🔗' },
  { to: '/settings', label: 'ESPN Settings', icon: '⚙️' }
];

export default function App() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gh:sidebar') === 'collapsed');
  useEffect(() => {
    localStorage.setItem('gh:sidebar', collapsed ? 'collapsed' : 'open');
  }, [collapsed]);

  return (
    <PlayerCardProvider>
    <div className="flex min-h-screen">
      <aside
        style={{ width: collapsed ? 62 : 224 }}
        className={`shrink-0 border-r border-slate-200 bg-slate-50 py-4 flex flex-col gap-1 sticky top-0 h-screen
          transition-[width] duration-300 ease-in-out overflow-hidden ${collapsed ? 'px-2' : 'px-4'}`}>
        <div className={`mb-4 ${collapsed ? 'px-0 text-center' : 'px-2'}`}>
          {collapsed ? (
            <div className="text-xl font-black tracking-tight text-emerald-600">G<span className="text-slate-800">H</span></div>
          ) : (
            <>
              <div className="text-xl font-bold tracking-tight whitespace-nowrap">Gridiron <span className="text-emerald-600">HQ</span></div>
              <div className="text-xs text-slate-500 whitespace-nowrap">2026 Fantasy Command Center</div>
            </>
          )}
        </div>
        {NAV.map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            title={collapsed ? n.label : undefined}
            className={({ isActive }) =>
              `py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                collapsed ? 'px-0 justify-center' : 'px-3'
              } ${isActive ? 'bg-emerald-100 text-emerald-700' : 'text-slate-700 hover:bg-slate-100'}`
            }
          >
            <span className="shrink-0">{n.icon}</span>
            <span className={`transition-opacity duration-200 ${collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'}`}>
              {n.label}
            </span>
          </NavLink>
        ))}
        {!collapsed && (
          <div className="mt-auto px-2 text-[10px] text-slate-400 whitespace-nowrap">
            Local app · data stays on your Mac
          </div>
        )}
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center gap-3 px-6 py-3 border-b border-slate-200 bg-white sticky top-0 z-30">
          <button
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-8 h-8 grid place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <rect x="1" y="2" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <line x1={collapsed ? '5.5' : '5.5'} y1="2" x2="5.5" y2="13" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-slate-500">Gridiron HQ</span>
          <div className="ml-auto flex items-center gap-2">
            <RefreshAll onDone={() => window.dispatchEvent(new Event('gridiron:refreshed'))} />
            <DevHub />
          </div>
        </header>
        <main className="flex-1 min-w-0 p-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/:abbr" element={<TeamDetail />} />
          <Route path="/players/:id" element={<PlayerDetail />} />
          <Route path="/projections" element={<Projections />} />
          <Route path="/rankings" element={<Rankings />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/drafts/:id" element={<DraftRoom />} />
          <Route path="/my-team" element={<MyTeam />} />
          <Route path="/news" element={<News />} />
          <Route path="/leagues" element={<Leagues />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        </main>
      </div>
    </div>
    </PlayerCardProvider>
  );
}
