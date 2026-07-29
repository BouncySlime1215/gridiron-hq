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
  { to: '/settings', label: 'ESPN Settings', icon: '⚙️' }
];

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-slate-50 p-4 flex flex-col gap-1 sticky top-0 h-screen">
        <div className="mb-4 px-2">
          <div className="text-xl font-bold tracking-tight">Gridiron <span className="text-emerald-600">HQ</span></div>
          <div className="text-xs text-slate-500">2026 Fantasy Command Center</div>
        </div>
        {NAV.map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${
                isActive ? 'bg-emerald-100 text-emerald-700' : 'text-slate-700 hover:bg-slate-100'
              }`
            }
          >
            <span>{n.icon}</span> {n.label}
          </NavLink>
        ))}
        <div className="mt-auto px-2 text-[10px] text-slate-400">
          Local app · data stays on your Mac
        </div>
      </aside>
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
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
