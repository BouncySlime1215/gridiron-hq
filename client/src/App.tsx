import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
import Rankings from './pages/Rankings';
import Drafts from './pages/Drafts';
import DraftRoom from './pages/DraftRoom';
import LiveDraft from './pages/LiveDraft';
import MyTeam from './pages/MyTeam';
import PlayerDetail from './pages/PlayerDetail';
import Players from './pages/Players';
import TradeLab from './pages/TradeLab';
import Leagues from './pages/Leagues';
import { PlayerCardProvider } from './components/PlayerCard';
import { LeagueProvider } from './state/league';
import LeagueSwitcher from './components/LeagueSwitcher';
import DevHub from './components/DevHub';
import RefreshAll from './components/RefreshAll';
import News from './pages/News';
import Settings from './pages/Settings';
import PropsBoard from './pages/props/PropsBoard';
import PropsPicks from './pages/props/PropsPicks';
import PropsModel from './pages/props/PropsModel';
import PropsAutoPicks from './pages/props/PropsAutoPicks';
import NflMarketBoard from './pages/NflMarketBoard';
import FantasyLab from './pages/FantasyLab';
import BettingHome from './pages/betting/BettingHome';
import NflProps from './pages/betting/NflProps';
import MlbBoard from './pages/betting/MlbBoard';
import MlbAutoPicks from './pages/betting/MlbAutoPicks';
import QuickJump, { destinationLabel } from './components/QuickJump';
import AiReplayDock from './components/AiReplayDock';

// Fantasy and betting answer different questions off different data, so they get
// separate sections rather than one long mixed list. Edge Tools and the
// Prediction Engine are now one hub (see FantasyLab) instead of two entries.
const NAV = [
  { to: '/', label: 'Dashboard', icon: 'D' },
  { to: '/my-team', label: 'My Team', icon: 'M' },
  { to: '/players', label: 'Players', icon: 'P' },
  { to: '/live-draft', label: 'Live Draft Hub', icon: '●', live: true },
  { to: '/drafts', label: 'Draft Room', icon: 'R' },
  { to: '/teams', label: '32 Teams', icon: 'T' },
  { to: '/lab', label: 'Research Lab', icon: 'F' },
  { to: '/trade-lab', label: 'Trade Lab', icon: 'X' },
  { to: '/news', label: 'Camp News', icon: 'N' },
  { to: '/leagues', label: 'My Leagues', icon: 'L' },
  { to: '/settings', label: 'ESPN Settings', icon: 'S' }
];

const BETTING_NAV = [
  { to: '/betting/nfl/picks', label: 'NFL Auto Picks', icon: 'N', end: true },
  { to: '/betting/nfl/props', label: 'NFL Props', icon: 'P', end: true },
  { to: '/betting/mlb/auto', label: 'MLB Auto Picks', icon: 'M', end: true }
];

export default function App() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gh:sidebar') === 'collapsed' || window.innerWidth < 900);
  useEffect(() => {
    localStorage.setItem('gh:sidebar', collapsed ? 'collapsed' : 'open');
  }, [collapsed]);
  const location = useLocation();
  // The league switcher is fantasy-only context; betting pages have no league.
  const inBetting = location.pathname.startsWith('/betting') || location.pathname.startsWith('/props')
    || location.pathname.startsWith('/nfl-board');
  const pageLabel = destinationLabel(location.pathname);

  return (
    <LeagueProvider>
    <PlayerCardProvider>
    <div className="flex min-h-screen">
      <aside
        style={{ width: collapsed ? 64 : 236 }}
        className={`shrink-0 border-r border-sky-100 bg-[#f4f9fd]/90 backdrop-blur-xl py-4 flex flex-col gap-1 sticky top-0 h-screen
          transition-[width] duration-300 ease-in-out overflow-hidden ${collapsed ? 'px-2' : 'px-4'}`}>
        <div className={`mb-4 ${collapsed ? 'px-0 text-center' : 'px-2'}`}>
          {collapsed ? (
            <div className="text-xl font-black tracking-tight text-slate-900">GH</div>
          ) : (
            <>
              <div className="text-xl font-bold tracking-tight whitespace-nowrap">Gridiron <span className={inBetting ? 'text-slate-900' : 'text-emerald-600'}>HQ</span></div>
              <div className="text-xs text-slate-500 whitespace-nowrap">{inBetting ? 'Betting Intelligence Desk' : '2026 Fantasy Command Center'}</div>
            </>
          )}
        </div>
        {!inBetting && NAV.map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            title={collapsed ? n.label : undefined}
            className={({ isActive }) =>
              `py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                collapsed ? 'px-0 justify-center' : 'px-3'
              } ${isActive ? 'bg-sky-100 text-sky-900' : 'text-slate-600 hover:bg-sky-50'}`
            }
          >
            {/* The live draft hub is the one page that is time-critical during a
                draft, so it reads as live rather than as another list entry. */}
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-bold ring-1 ${
              n.live ? 'bg-emerald-500 text-white ring-emerald-300 animate-pulse' : 'bg-white/80 text-sky-800 ring-sky-100'}`}>
              {n.icon}
            </span>
            <span className={`transition-opacity duration-200 ${collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'} ${n.live ? 'font-bold text-emerald-700' : ''}`}>
              {n.label}
            </span>
          </NavLink>
        ))}

        {/* Betting is its own product — different sports, different data, no league
            context — so it gets a labelled section rather than being blended in. */}
        {inBetting && <NavLink to="/" title={collapsed ? 'Back to fantasy' : undefined}
          className={`mb-2 py-2 rounded-lg text-sm font-medium flex items-center gap-2 text-slate-500 hover:bg-slate-100 ${collapsed ? 'px-0 justify-center' : 'px-3'}`}>
          <span>←</span><span className={collapsed ? 'hidden' : ''}>Back to fantasy</span>
        </NavLink>}
        <div className={`${inBetting ? 'mt-1' : 'mt-3'} mb-1 border-t border-slate-200 pt-3 ${collapsed ? '' : 'px-1'}`}>
          {!collapsed && (
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 px-2 mb-1 whitespace-nowrap">
              {inBetting ? 'Betting desk' : 'Betting'}
            </div>
          )}
        </div>
        {BETTING_NAV.map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            title={collapsed ? n.label : undefined}
            className={({ isActive }) =>
              `py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                collapsed ? 'px-0 justify-center' : 'px-3'
              } ${isActive ? 'bg-sky-100 text-sky-900' : 'text-slate-600 hover:bg-sky-50'}`
            }
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/80 text-[10px] font-bold text-sky-800 ring-1 ring-sky-100">{n.icon}</span>
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
        <header className="flex h-12 items-center gap-3 border-b border-sky-100 bg-[#f8fcff]/85 px-4 backdrop-blur-xl sticky top-0 z-30 sm:px-6">
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
          <span className="hidden text-sm font-semibold text-slate-500 sm:inline">{inBetting ? 'Betting' : 'Fantasy'} <span className="mx-1 text-slate-300">/</span> <span className="text-slate-700">{pageLabel}</span></span>
          {!inBetting && <LeagueSwitcher />}
          <div className="ml-auto flex items-center gap-2">
            <QuickJump />
            <RefreshAll onDone={() => window.dispatchEvent(new Event('gridiron:refreshed'))} />
            <DevHub />
          </div>
        </header>
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/:abbr" element={<TeamDetail />} />
          <Route path="/players/:id" element={<PlayerDetail />} />
          <Route path="/players" element={<Players />} />
          <Route path="/trade-lab" element={<TradeLab />} />
          <Route path="/rankings" element={<Rankings />} />
          <Route path="/projections" element={<Players />} />
          <Route path="/live-draft" element={<LiveDraft />} />
          <Route path="/live-draft/:id" element={<LiveDraft />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/drafts/:id" element={<DraftRoom />} />
          <Route path="/my-team" element={<MyTeam />} />
          <Route path="/news" element={<News />} />
          <Route path="/leagues" element={<Leagues />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/lab" element={<FantasyLab />} />

          {/* Betting section */}
          <Route path="/betting" element={<BettingHome />} />
          {/* /betting/nfl/picks is the one this app's own nav actually links to
              ("NFL Auto Picks") — /betting/nfl is a bare alias nothing links to
              internally, kept only in case it's bookmarked. Both explicitly pass
              initialTool now, matching every sibling route below, instead of the
              picks route silently relying on NflMarketBoard's default. */}
          <Route path="/betting/nfl" element={<NflMarketBoard initialTool="board" />} />
          <Route path="/betting/nfl/props" element={<NflProps />} />
          <Route path="/betting/nfl/picks" element={<NflMarketBoard initialTool="board" />} />
          <Route path="/betting/nfl/operations" element={<NflMarketBoard initialTool="operations" />} />
          <Route path="/betting/nfl/ensemble" element={<NflMarketBoard initialTool="ensemble" />} />
          <Route path="/betting/lines" element={<NflMarketBoard initialTool="lines" />} />
          <Route path="/betting/training" element={<NflMarketBoard initialTool="training" />} />
          <Route path="/betting/catalog" element={<NflMarketBoard initialTool="variables" />} />
          <Route path="/betting/mlb" element={<MlbBoard />} />
          <Route path="/betting/mlb/legacy" element={<PropsBoard />} />
          <Route path="/betting/mlb/auto" element={<MlbAutoPicks />} />
          <Route path="/betting/mlb/auto-legacy" element={<PropsAutoPicks />} />
          <Route path="/betting/mlb/picks" element={<PropsPicks />} />
          <Route path="/betting/mlb/model" element={<PropsModel />} />

          {/* Previous paths, kept so existing links and bookmarks still resolve. */}
          <Route path="/edge" element={<FantasyLab />} />
          <Route path="/model" element={<FantasyLab />} />
          <Route path="/nfl-board" element={<NflMarketBoard />} />
          <Route path="/props" element={<PropsBoard />} />
          <Route path="/props/auto-picks" element={<PropsAutoPicks />} />
          <Route path="/props/picks" element={<PropsPicks />} />
          <Route path="/props/model" element={<PropsModel />} />
        </Routes>
        </main>
        <AiReplayDock />
      </div>
    </div>
    </PlayerCardProvider>
    </LeagueProvider>
  );
}
