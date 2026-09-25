import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { PlayerCardProvider } from './components/PlayerCard';
import { LeagueProvider } from './state/league';
import LeagueSwitcher from './components/LeagueSwitcher';
import DevHub from './components/DevHub';
import RefreshAll from './components/RefreshAll';
import QuickJump from './components/QuickJump';
import { NAV_GROUPS, destinationLabel } from './navigation';
import EspnConnectGate from './components/EspnConnectGate';
import DataFreshnessBanner from './components/DataFreshnessBanner';
import { NumberHealthNavDot } from './components/NumberHealth';
import { DataCredit } from './components/DataFreshnessBanner';
import { Skeleton } from './components/ui/DesignSystem';
import { PageExplainContext, type PageExplainInfo } from './components/PageExplainContext';
import { PageExplainAssistant } from './components/PageExplainAssistant';
import { Icon, type IconName } from './components/ui/DesignSystem';
import { MovedTo } from './components/Redirects';
import { AppCoachProvider, HeaderFacts } from './components/AppCoach';
import MoreMenu from './components/MoreMenu';

/** One icon per destination (the design system's Lucide set, via DesignSystem's Icon). */
const NAV_ICON: Record<string, IconName> = {
  '/': 'today', '/trades': 'swap', '/my-team': 'trophy', '/league': 'house', '/players': 'search',
  '/draft': 'layers', '/settings': 'sliders',
};

const Today = lazy(() => import('./pages/Today'));
const Trades = lazy(() => import('./pages/Trades'));
const Players = lazy(() => import('./pages/Players'));
const Teams = lazy(() => import('./pages/Teams'));
const TeamDetail = lazy(() => import('./pages/TeamDetail'));
const DraftRoom = lazy(() => import('./pages/DraftRoom'));
const LiveDraft = lazy(() => import('./pages/LiveDraft'));
const DraftHub = lazy(() => import('./pages/DraftHub'));
const LeagueHub = lazy(() => import('./pages/LeagueHub'));
const MyTeam = lazy(() => import('./pages/MyTeam'));
const PlayerDetail = lazy(() => import('./pages/PlayerDetail'));
const Settings = lazy(() => import('./pages/Settings'));
const Pair = lazy(() => import('./pages/Pair'));
const SignIn = lazy(() => import('./pages/SignIn'));
const SignInComplete = lazy(() => import('./pages/SignInComplete'));
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

  // Sign-in renders on its own, outside the app chrome. The sidebar, the
  // league switcher and the ESPN gate all read endpoints that need the session
  // this page exists to establish, so rendering them around it means a login
  // box behind a wall of failed requests.
  if (location.pathname === '/sign-in' || location.pathname.startsWith('/sign-in/')) {
    return <Suspense fallback={<div className="min-h-screen bg-slate-50" />}><Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/sign-in/complete" element={<SignInComplete />} />
    </Routes></Suspense>;
  }

  return <LeagueProvider><AppCoachProvider><PlayerCardProvider>
    <PageExplainContext.Provider value={pageExplain}>
    <div className="flex min-h-screen bg-white">
      {drawerOpen && <div className="fixed inset-0 z-40 bg-slate-900/40" aria-hidden="true" onClick={() => setCollapsed(true)} />}
      <aside style={{ width: rail ? 64 : 244 }} className={`app-side flex h-screen shrink-0 flex-col overflow-hidden py-4 ${rail ? 'px-2' : 'px-3'} ${isMobile
        ? `fixed inset-y-0 left-0 z-50 bg-[var(--c-card)] transition-transform duration-200 ${drawerOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`
        : 'sticky top-0 transition-[width] duration-200'}`}>
        <div className={`mb-4 ${rail ? 'text-center' : 'px-2'}`}>
          <div className="app-brand">{rail ? <>G<b>H</b></> : <>Gridiron <b>HQ</b></>}</div>
          {!rail && <div className="app-brand-sub">Fantasy + market intelligence</div>}
        </div>

        <nav aria-label="Primary navigation" className="min-h-0 flex-1 overflow-y-auto">
          {NAV_GROUPS.map(group => <div key={group.label} className="mb-3">
            {!rail && <div className="app-group" title={group.question || undefined}>{group.label}</div>}
            {rail && <div className="mx-2 my-2 h-px bg-[var(--c-line)]" />}
            {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.end} title={rail ? item.label : undefined} className={({ isActive }) => `app-nav-link${rail ? ' is-rail' : ''}${isActive ? ' is-active' : ''}`}>
              <span className="app-nav-ic">{NAV_ICON[item.to] ? <Icon name={NAV_ICON[item.to]} size={18} /> : item.icon}
                {/* BROKEN-01b: red when any number is broken for the selected league; nothing otherwise. */}
                {item.to === '/settings' && <span className="absolute -right-1 -top-1 flex"><NumberHealthNavDot /></span>}</span>
              {!rail && <span>{item.label}</span>}
            </NavLink>)}
          </div>)}
        </nav>
        {!rail && <div className="app-foot px-2 pt-2">Local app · data stays on your Mac</div>}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Renders nothing once a league is connected; a slim bar if the modal
            was dismissed for this sitting; the modal itself otherwise. */}
        <EspnConnectGate />
        <DataFreshnessBanner />
        <header className="app-header sticky top-0 z-30 flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <button onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? (isMobile ? 'Open menu' : 'Expand sidebar') : (isMobile ? 'Close menu' : 'Collapse sidebar')} className="ds-icon-btn shrink-0">
            <Icon name="panel" size={18} />
          </button>
          <span className="app-crumb hidden min-w-0 truncate sm:block">{inBetting ? 'Betting' : 'Gridiron HQ'} <span className="mx-1 opacity-40">/</span> <b>{pageLabel}</b></span>
          {/* On a phone the league select gives up width to the buttons instead of pushing them off-screen. */}
          {!inBetting && <div className="min-w-[8rem] flex-1 sm:flex-none [&_select]:w-full [&_select]:max-w-full sm:[&_select]:w-auto sm:[&_select]:max-w-[200px]"><LeagueSwitcher /></div>}
          <div className="ml-auto flex shrink-0 items-center gap-2"><HeaderFacts /><span className="hidden xl:inline-flex"><QuickJump /></span><RefreshAll onDone={() => window.dispatchEvent(new Event('gridiron:refreshed'))} /><span className="hidden lg:inline-flex"><DevHub /></span><PageExplainAssistant info={pageInfo} /><MoreMenu /></div>
        </header>
        <main className="app-main min-w-0 flex-1 p-4 sm:p-6 lg:p-8"><Suspense fallback={<RouteSkeleton />}><Routes>
          {/* The seven areas (docs/ui/CONSOLIDATION-MAP.md). */}
          <Route path="/" element={<Today />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/my-team" element={<MyTeam />} />
          <Route path="/league" element={<LeagueHub />} />
          <Route path="/players" element={<Players />} />
          <Route path="/players/teams" element={<Teams />} /><Route path="/players/teams/:abbr" element={<TeamDetail />} />
          <Route path="/players/:id" element={<PlayerDetail />} />
          <Route path="/draft" element={<DraftHub />} />
          <Route path="/draft/:id" element={<DraftRoom />} /><Route path="/draft/live/:id" element={<LiveDraft />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/pair" element={<Pair />} />

          {/* Every URL from before the seven areas lands on its new home (components/Redirects.tsx). */}
          <Route path="/leagues" element={<MovedTo from="/leagues" />} />
          <Route path="/lineup" element={<MovedTo from="/lineup" />} />
          <Route path="/trade-lab" element={<MovedTo from="/trade-lab" />} />
          <Route path="/trade-brain" element={<MovedTo from="/trade-brain" />} />
          <Route path="/teams" element={<MovedTo from="/teams" />} /><Route path="/teams/:abbr" element={<MovedTo from="/teams/:abbr" />} />
          <Route path="/news" element={<MovedTo from="/news" />} />
          <Route path="/rankings" element={<MovedTo from="/rankings" />} /><Route path="/projections" element={<MovedTo from="/projections" />} />
          <Route path="/drafts" element={<MovedTo from="/drafts" />} /><Route path="/drafts/:id" element={<MovedTo from="/drafts/:id" />} />
          <Route path="/live-draft" element={<MovedTo from="/live-draft" />} /><Route path="/live-draft/:id" element={<MovedTo from="/live-draft/:id" />} />
          <Route path="*" element={<NotFound />} />
        </Routes></Suspense></main>
        {/* The data licences ask for a visible credit; it sits under every page. */}
        <DataCredit />
      </div>
    </div>
    </PageExplainContext.Provider>
  </PlayerCardProvider></AppCoachProvider></LeagueProvider>;
}
