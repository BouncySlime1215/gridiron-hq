import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PlayerCardProvider } from './components/PlayerCard';
import { LeagueProvider } from './state/league';
import LeagueSwitcher from './components/LeagueSwitcher';
import DevHub from './components/DevHub';
import RefreshAll from './components/RefreshAll';
import QuickJump from './components/QuickJump';
import { NAV_GROUPS, destinationLabel } from './navigation';
import EspnConnectGate from './components/EspnConnectGate';
import DataSetupBanner from './components/DataSetupBanner';
import { Skeleton } from './components/ui/DesignSystem';
import { PageExplainContext, type PageExplainInfo } from './components/betting/PageExplainContext';
import { PageExplainAssistant } from './components/betting/PageExplainAssistant';

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
const LeagueBrain = lazy(() => import('./pages/LeagueBrain'));
const Trends = lazy(() => import('./pages/Trends'));
const Lineup = lazy(() => import('./pages/Lineup'));
const TheModel = lazy(() => import('./pages/TheModel'));
const News = lazy(() => import('./pages/News'));
const Settings = lazy(() => import('./pages/Settings'));
const Pair = lazy(() => import('./pages/Pair'));
const FantasyLab = lazy(() => import('./pages/FantasyLab'));
const NflMarketBoard = lazy(() => import('./pages/NflMarketBoard'));
const BettingHome = lazy(() => import('./pages/betting/BettingHome'));
const MlbHub = lazy(() => import('./pages/betting/MlbHub'));
const NflAutoPicks = lazy(() => import('./pages/betting/NflAutoPicks'));
const DataHealth = lazy(() => import('./pages/DataHealth'));
const NotFound = lazy(() => import('./pages/NotFound'));

// NAV_GROUPS moved to src/navigation.ts so the command palette can render the
// same destinations the sidebar does. They were two hand-maintained lists of
// the same thing and had already drifted by five pages.

function RouteSkeleton() {
  return <div className="mx-auto max-w-[1440px] space-y-4" aria-label="Loading page"><Skeleton className="h-9 w-72" /><Skeleton className="h-4 w-[min(560px,90%)]" /><div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div><Skeleton className="h-80" /></div>;
}

export default function App() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gh:sidebar') === 'collapsed' || window.innerWidth < 900);
  useEffect(() => { localStorage.setItem('gh:sidebar', collapsed ? 'collapsed' : 'open'); }, [collapsed]);
  const location = useLocation();

  // On a phone there is no room for a rail, so the same sidebar becomes a
  // drawer: "collapsed" means closed (nothing on screen), the header button
  // opens it over the page, and any navigation closes it again. Desktop keeps
  // the sticky rail/expanded column exactly as before.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => { if (isMobile) setCollapsed(true); }, [isMobile, location.pathname, location.search]);
  const drawerOpen = isMobile && !collapsed;
  const rail = !isMobile && collapsed;
  const inBetting = location.pathname.startsWith('/betting') || location.pathname.startsWith('/props') || location.pathname.startsWith('/nfl-board');
  const pageLabel = destinationLabel(location.pathname);

  // The floating "what am I looking at" assistant's state lives here, at the
  // true app root — mounted once, above every route, so it's present on
  // every page in the whole app (fantasy pages, League Hub, Trade Lab, all
  // of /betting/*) and is never torn down/reset by navigation. Pages opt in
  // to telling it what's on screen via usePageExplain(); a page that hasn't
  // yet (most non-betting pages, so far) just leaves this at its default,
  // and the assistant itself falls back to an honest route-derived guess.
  const [pageInfo, setPageInfo] = useState<PageExplainInfo>({});
  // Memoized so an App re-render for an unrelated reason (sidebar collapse,
  // route change) doesn't hand every consumer a new object and re-render them
  // all. usePageExplain no longer depends on this identity at all, so this is
  // now only about wasted work — but it is the shape the hook's comment
  // assumes, and leaving it unmemoized invites the loop back.
  const pageExplain = useMemo(() => ({ info: pageInfo, setInfo: setPageInfo }), [pageInfo]);

  return <LeagueProvider><PlayerCardProvider>
    <PageExplainContext.Provider value={pageExplain}>
    <div className="flex min-h-screen bg-white">
      {drawerOpen && <div className="fixed inset-0 z-40 bg-slate-900/40" aria-hidden="true" onClick={() => setCollapsed(true)} />}
      <aside style={{ width: rail ? 64 : 244 }} className={`flex h-screen shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-slate-50 py-4 ${rail ? 'px-2' : 'px-3'} ${isMobile
        ? `fixed inset-y-0 left-0 z-50 transition-transform duration-200 ${drawerOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`
        : 'sticky top-0 transition-[width] duration-200'}`}>
        <div className={`mb-4 ${rail ? 'text-center' : 'px-2'}`}>
          <div className="text-xl font-extrabold tracking-tight text-slate-950">{rail ? 'GH' : <>Gridiron <span className="text-emerald-700">HQ</span></>}</div>
          {!rail && <div className="text-xs text-slate-500">Fantasy + market intelligence</div>}
        </div>

        <nav aria-label="Primary navigation" className="min-h-0 flex-1 overflow-y-auto">
          {NAV_GROUPS.map(group => <div key={group.label} className="mb-3">
            {!rail && <div className="mb-1 border-t border-slate-200 px-2 pt-3"><div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-slate-500">{group.label}</div><div className="text-[10px] text-slate-400">{group.question}</div></div>}
            {rail && <div className="mx-2 my-2 border-t border-slate-200" />}
            {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.end} title={rail ? item.label : undefined} className={({ isActive }) => `mb-0.5 flex items-center gap-2 rounded-md py-2 text-sm font-semibold transition-colors ${rail ? 'justify-center px-0' : 'px-2'} ${isActive ? 'bg-white text-emerald-800 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[10px] font-extrabold ${item.live ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600'}`}>{item.icon}</span>
              {!rail && <span>{item.label}</span>}
            </NavLink>)}
          </div>)}
        </nav>
        {!rail && <div className="px-2 pt-2 text-[10px] text-slate-400">Local app · data stays on your Mac</div>}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Renders nothing once a league is connected; a slim bar if the modal
            was dismissed for this sitting; the modal itself otherwise. */}
        <EspnConnectGate />
        <DataSetupBanner />
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? (isMobile ? 'Open menu' : 'Expand sidebar') : (isMobile ? 'Close menu' : 'Collapse sidebar')} className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><rect x="1" y="2" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" /><line x1="5.5" y1="2" x2="5.5" y2="13" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          <span className="hidden text-sm font-semibold text-slate-500 sm:inline">{inBetting ? 'Betting' : 'Gridiron HQ'} <span className="mx-1 text-slate-300">/</span> <span className="text-slate-800">{pageLabel}</span></span>
          {/* On a phone the league select gives up width to the buttons instead of pushing them off-screen. */}
          {!inBetting && <div className="min-w-0 flex-1 sm:flex-none [&_select]:w-full [&_select]:max-w-full sm:[&_select]:w-auto sm:[&_select]:max-w-[200px]"><LeagueSwitcher /></div>}
          <div className="ml-auto flex shrink-0 items-center gap-2"><span className="hidden sm:inline-flex"><QuickJump /></span><RefreshAll onDone={() => window.dispatchEvent(new Event('gridiron:refreshed'))} /><span className="hidden sm:inline-flex"><DevHub /></span></div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8"><Suspense fallback={<RouteSkeleton />}><Routes>
          <Route path="/" element={<Home />} />
          <Route path="/league" element={<LeagueHub />} />
          <Route path="/draft" element={<DraftHub />} />
          <Route path="/matchups" element={<FantasyLab />} />
          <Route path="/teams" element={<Teams />} /><Route path="/teams/:abbr" element={<TeamDetail />} />
          <Route path="/players/:id" element={<PlayerDetail />} /><Route path="/players" element={<Players />} />
          <Route path="/trade-lab" element={<TradeLab />} /><Route path="/brain" element={<LeagueBrain />} /><Route path="/trends" element={<Trends />} /><Route path="/lineup" element={<Lineup />} /><Route path="/model" element={<TheModel />} /><Route path="/news" element={<News />} />
          <Route path="/settings" element={<Settings />} /><Route path="/lab" element={<FantasyLab />} /><Route path="/data-health" element={<DataHealth />} />
          <Route path="/pair" element={<Pair />} />
          <Route path="/betting" element={<BettingHome />} /><Route path="/betting/nfl" element={<NflMarketBoard initialTool="board" />} />
          <Route path="/betting/nfl/props" element={<NflMarketBoard initialTool="props" />} /><Route path="/betting/nfl/picks" element={<NflMarketBoard initialTool="board" />} /><Route path="/betting/nfl/auto-picks" element={<NflAutoPicks />} />
          <Route path="/betting/nfl/operations" element={<NflMarketBoard initialTool="operations" />} /><Route path="/betting/nfl/ensemble" element={<NflMarketBoard initialTool="ensemble" />} /><Route path="/betting/nfl/forward" element={<NflMarketBoard initialTool="forward" />} />
          <Route path="/betting/nfl/research" element={<NflMarketBoard initialTool="research" />} />
          <Route path="/betting/nfl/watch" element={<NflMarketBoard initialTool="watch" />} />
          <Route path="/betting/lines" element={<NflMarketBoard initialTool="lines" />} /><Route path="/betting/training" element={<NflMarketBoard initialTool="training" />} /><Route path="/betting/catalog" element={<NflMarketBoard initialTool="variables" />} />
          {/* One MLB hub instead of six routes, two of which were named "legacy"
              and all of which were reachable with nothing saying which was current. */}
          <Route path="/betting/mlb" element={<MlbHub />} />
          <Route path="/betting/mlb/auto" element={<MlbHub initialTab="auto" />} />
          <Route path="/betting/mlb/picks" element={<MlbHub initialTab="picks" />} />
          <Route path="/betting/mlb/model" element={<MlbHub initialTab="model" />} />
          <Route path="/betting/mlb/legacy" element={<MlbHub initialTab="legacy" />} />
          <Route path="/betting/mlb/auto-legacy" element={<MlbHub initialTab="auto" />} />

          {/* Compatibility: old bookmarks resolve to the new domain hubs. */}
          <Route path="/my-team" element={<Navigate to="/league?view=team" replace />} /><Route path="/leagues" element={<Navigate to="/league?view=connections" replace />} />
          <Route path="/live-draft" element={<Navigate to="/draft?view=live" replace />} /><Route path="/live-draft/:id" element={<LiveDraft />} />
          <Route path="/drafts" element={<Navigate to="/draft" replace />} /><Route path="/drafts/:id" element={<DraftRoom />} />
          <Route path="/rankings" element={<Navigate to="/players" replace />} /><Route path="/projections" element={<Navigate to="/players" replace />} />
          <Route path="/edge" element={<Navigate to="/lab" replace />} />
          <Route path="/nfl-board" element={<Navigate to="/betting/nfl/picks" replace />} />
          {/* The `/props/*` pages were MLB pages standing outside the MLB hub,
              linked from nowhere and reachable only by typing the URL — yet all
              four of their endpoints still return live data (the proxied board
              answers with 31 rows and 120 projections). Two of them,
              PropsPicks and PropsModel, were already the hub's own ledger and
              proof-room views rendered a second time without the workspace
              chrome, so they are pure duplicates and simply redirect. The other
              two are the proxied half of the first-party/proxied overlap and
              are now a source toggle inside the hub's slate and forward views,
              rather than deleted or left orphaned. */}
          <Route path="/props" element={<MlbHub initialTab="slate" initialSource="proxied" />} />
          <Route path="/props/auto-picks" element={<MlbHub initialTab="forward" initialSource="proxied" />} />
          <Route path="/props/picks" element={<Navigate to="/betting/mlb/picks" replace />} />
          <Route path="/props/model" element={<Navigate to="/betting/mlb/model" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes></Suspense></main>
      </div>
    </div>
    <PageExplainAssistant info={pageInfo} />
    </PageExplainContext.Provider>
  </PlayerCardProvider></LeagueProvider>;
}
