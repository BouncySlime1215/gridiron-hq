import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PlayerCardProvider } from './components/PlayerCard';
import { LeagueProvider } from './state/league';
import LeagueSwitcher from './components/LeagueSwitcher';
import DevHub from './components/DevHub';
import RefreshAll from './components/RefreshAll';
import QuickJump, { destinationLabel } from './components/QuickJump';
import AiReplayDock from './components/AiReplayDock';
import { Skeleton } from './components/ui/DesignSystem';

const Home = lazy(() => import('./pages/Home'));
const Teams = lazy(() => import('./pages/Teams'));
const TeamDetail = lazy(() => import('./pages/TeamDetail'));
const DraftRoom = lazy(() => import('./pages/DraftRoom'));
const LiveDraft = lazy(() => import('./pages/LiveDraft'));
const DraftHub = lazy(() => import('./pages/DraftHub'));
const LeagueHub = lazy(() => import('./pages/LeagueHub'));
const PlayerDetail = lazy(() => import('./pages/PlayerDetail'));
const Players = lazy(() => import('./pages/Players'));
const TradeLab = lazy(() => import('./pages/TradeLab'));
const News = lazy(() => import('./pages/News'));
const Settings = lazy(() => import('./pages/Settings'));
const FantasyLab = lazy(() => import('./pages/FantasyLab'));
const PropsBoard = lazy(() => import('./pages/props/PropsBoard'));
const PropsPicks = lazy(() => import('./pages/props/PropsPicks'));
const PropsModel = lazy(() => import('./pages/props/PropsModel'));
const PropsAutoPicks = lazy(() => import('./pages/props/PropsAutoPicks'));
const NflMarketBoard = lazy(() => import('./pages/NflMarketBoard'));
const BettingHome = lazy(() => import('./pages/betting/BettingHome'));
const NflProps = lazy(() => import('./pages/betting/NflProps'));
const MlbBoard = lazy(() => import('./pages/betting/MlbBoard'));
const MlbAutoPicks = lazy(() => import('./pages/betting/MlbAutoPicks'));

type NavItem = { to: string; label: string; icon: string; end?: boolean; live?: boolean };
const NAV_GROUPS: { label: string; question: string; items: NavItem[] }[] = [
  { label: 'Fantasy', question: 'Manage my team', items: [
    { to: '/', label: 'Command Center', icon: 'H', end: true },
    { to: '/league', label: 'League Hub', icon: 'L' },
    { to: '/draft', label: 'Draft', icon: 'D', live: true },
    { to: '/players', label: 'Players', icon: 'P' },
    { to: '/trade-lab', label: 'Trade Lab', icon: 'T' }
  ]},
  { label: 'Intelligence', question: 'Understand football', items: [
    { to: '/news', label: 'News', icon: 'N' },
    { to: '/teams', label: "X's & O's", icon: 'X' },
    { to: '/matchups', label: 'Matchups', icon: 'M' }
  ]},
  { label: 'Betting', question: 'Track the market', items: [
    { to: '/betting', label: 'Betting Hub', icon: 'B', end: true },
    { to: '/betting/nfl/picks', label: 'NFL Auto', icon: 'N' },
    { to: '/betting/mlb/auto', label: 'MLB Auto', icon: 'M' }
  ]},
  { label: 'Lab', question: 'Verify the model', items: [
    { to: '/lab', label: 'Accuracy & Experiments', icon: 'A' },
    { to: '/settings', label: 'Settings', icon: 'S' }
  ]}
];

function RouteSkeleton() {
  return <div className="mx-auto max-w-[1440px] space-y-4" aria-label="Loading page"><Skeleton className="h-9 w-72" /><Skeleton className="h-4 w-[min(560px,90%)]" /><div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div><Skeleton className="h-80" /></div>;
}

export default function App() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gh:sidebar') === 'collapsed' || window.innerWidth < 900);
  useEffect(() => { localStorage.setItem('gh:sidebar', collapsed ? 'collapsed' : 'open'); }, [collapsed]);
  const location = useLocation();
  const inBetting = location.pathname.startsWith('/betting') || location.pathname.startsWith('/props') || location.pathname.startsWith('/nfl-board');
  const pageLabel = destinationLabel(location.pathname);

  return <LeagueProvider><PlayerCardProvider>
    <div className="flex min-h-screen bg-white">
      <aside style={{ width: collapsed ? 64 : 244 }} className={`sticky top-0 flex h-screen shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-slate-50 py-4 transition-[width] duration-200 ${collapsed ? 'px-2' : 'px-3'}`}>
        <div className={`mb-4 ${collapsed ? 'text-center' : 'px-2'}`}>
          <div className="text-xl font-extrabold tracking-tight text-slate-950">{collapsed ? 'GH' : <>Gridiron <span className="text-emerald-700">HQ</span></>}</div>
          {!collapsed && <div className="text-xs text-slate-500">Fantasy + market intelligence</div>}
        </div>

        <nav aria-label="Primary navigation" className="min-h-0 flex-1 overflow-y-auto">
          {NAV_GROUPS.map(group => <div key={group.label} className="mb-3">
            {!collapsed && <div className="mb-1 border-t border-slate-200 px-2 pt-3"><div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-slate-500">{group.label}</div><div className="text-[10px] text-slate-400">{group.question}</div></div>}
            {collapsed && <div className="mx-2 my-2 border-t border-slate-200" />}
            {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.end} title={collapsed ? item.label : undefined} className={({ isActive }) => `mb-0.5 flex items-center gap-2 rounded-md py-2 text-sm font-semibold transition-colors ${collapsed ? 'justify-center px-0' : 'px-2'} ${isActive ? 'bg-white text-emerald-800 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[10px] font-extrabold ${item.live ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600'}`}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </NavLink>)}
          </div>)}
        </nav>
        {!collapsed && <div className="px-2 pt-2 text-[10px] text-slate-400">Local app · data stays on your Mac</div>}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><rect x="1" y="2" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" /><line x1="5.5" y1="2" x2="5.5" y2="13" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          <span className="hidden text-sm font-semibold text-slate-500 sm:inline">{inBetting ? 'Betting' : 'Gridiron HQ'} <span className="mx-1 text-slate-300">/</span> <span className="text-slate-800">{pageLabel}</span></span>
          {!inBetting && <LeagueSwitcher />}
          <div className="ml-auto flex items-center gap-2"><QuickJump /><RefreshAll onDone={() => window.dispatchEvent(new Event('gridiron:refreshed'))} /><DevHub /></div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8"><Suspense fallback={<RouteSkeleton />}><Routes>
          <Route path="/" element={<Home />} />
          <Route path="/league" element={<LeagueHub />} />
          <Route path="/draft" element={<DraftHub />} />
          <Route path="/matchups" element={<FantasyLab />} />
          <Route path="/teams" element={<Teams />} /><Route path="/teams/:abbr" element={<TeamDetail />} />
          <Route path="/players/:id" element={<PlayerDetail />} /><Route path="/players" element={<Players />} />
          <Route path="/trade-lab" element={<TradeLab />} /><Route path="/news" element={<News />} />
          <Route path="/settings" element={<Settings />} /><Route path="/lab" element={<FantasyLab />} />
          <Route path="/betting" element={<BettingHome />} /><Route path="/betting/nfl" element={<NflMarketBoard initialTool="board" />} />
          <Route path="/betting/nfl/props" element={<NflProps />} /><Route path="/betting/nfl/picks" element={<NflMarketBoard initialTool="board" />} />
          <Route path="/betting/nfl/operations" element={<NflMarketBoard initialTool="operations" />} /><Route path="/betting/nfl/ensemble" element={<NflMarketBoard initialTool="ensemble" />} />
          <Route path="/betting/lines" element={<NflMarketBoard initialTool="lines" />} /><Route path="/betting/training" element={<NflMarketBoard initialTool="training" />} /><Route path="/betting/catalog" element={<NflMarketBoard initialTool="variables" />} />
          <Route path="/betting/mlb" element={<MlbBoard />} /><Route path="/betting/mlb/legacy" element={<PropsBoard />} /><Route path="/betting/mlb/auto" element={<MlbAutoPicks />} /><Route path="/betting/mlb/auto-legacy" element={<PropsAutoPicks />} /><Route path="/betting/mlb/picks" element={<PropsPicks />} /><Route path="/betting/mlb/model" element={<PropsModel />} />

          {/* Compatibility: old bookmarks resolve to the new domain hubs. */}
          <Route path="/my-team" element={<Navigate to="/league?view=team" replace />} /><Route path="/leagues" element={<Navigate to="/league?view=connections" replace />} />
          <Route path="/live-draft" element={<Navigate to="/draft?view=live" replace />} /><Route path="/live-draft/:id" element={<LiveDraft />} />
          <Route path="/drafts" element={<Navigate to="/draft" replace />} /><Route path="/drafts/:id" element={<DraftRoom />} />
          <Route path="/rankings" element={<Navigate to="/players" replace />} /><Route path="/projections" element={<Navigate to="/players" replace />} />
          <Route path="/edge" element={<Navigate to="/lab" replace />} /><Route path="/model" element={<Navigate to="/lab" replace />} />
          <Route path="/nfl-board" element={<Navigate to="/betting/nfl/picks" replace />} /><Route path="/props" element={<PropsBoard />} /><Route path="/props/auto-picks" element={<PropsAutoPicks />} /><Route path="/props/picks" element={<PropsPicks />} /><Route path="/props/model" element={<PropsModel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Suspense></main>
        <AiReplayDock />
      </div>
    </div>
  </PlayerCardProvider></LeagueProvider>;
}
