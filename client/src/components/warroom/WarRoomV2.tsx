import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './warroom.css';
import './warroom-v2.css';
import { setTeamNames, teamLabel, type WarRoomView } from './types';
import type { DeckLogEntry, DeckState } from './deck';
import { postWarRoomRequest, type Poster, type WarRoomRequest } from './requests';
import { isOk } from './format';
import { SourcesContext } from './FieldState';
import { PanelBoundary } from './Panel';
import type { LeagueChoice } from './TopStrip';
import TopBarV2 from './TopBarV2';
import { openingLeague, TARGET_LEAGUE_ID } from './LeagueRail';
import NextMoveDeck, { type CurrentMove } from './NextMoveDeck';
import ScreenToday from './ScreenToday';
import ScreenGoGet from './ScreenGoGet';
import ScreenMarket from './ScreenMarket';
import ScreenLeague from './ScreenLeague';
import HealthSheet, { healthTone } from './HealthSheet';
import { CoachDrawer, FIXED_QUESTIONS, useWarRoomCoach, type Panel as CoachPanel } from './coach';
import { useNegotiations, usePlayerHeadshots } from './useWarRoom';
import { HeadshotContext } from './Avatar';
import { wasOpenedOnTarget, markOpenedOnTarget } from './WarRoom';

/**
 * WAR-ROOM-UI v2: the War Room as four calm screens (WarRoomShell's default).
 *
 *   TODAY    "Do this now" (the next move as a hero card), WATCHING (max 5), season progress
 *   GO GET   pick a target -> its paths as step timelines -> the offer composer; the plan's stops
 *   MARKET   the flip radar as cards, then catch-up
 *   LEAGUE   one card per league-mate; a tap opens Coach asked about a trade with him
 *
 * A segmented switcher sits in the top bar (a bottom tab bar on a phone). Health (brain
 * report + number audit) is a chip that opens a sheet. Coach is a right-side drawer on
 * every screen. It draws the same view (the plans contract) with the same pieces as the
 * classic dashboard (WarRoom.tsx); nothing here fetches a plan or computes a value.
 */
export type ScreenId = 'today' | 'goget' | 'market' | 'league';
export const SCREENS: { id: ScreenId; name: string }[] = [
  { id: 'today', name: 'Today' },
  { id: 'goget', name: 'Go get' },
  { id: 'market', name: 'Market' },
  { id: 'league', name: 'League' },
];

/** Coach's focus_panel -> the screen that holds it (null = stay). */
export const COACH_SCREEN: Record<CoachPanel, ScreenId | 'health' | null> = {
  next_move: 'today', itinerary: 'goget', targets: 'goget', flip_map: 'market', catch_up: 'market', brain_check: 'health',
  destination: 'today', cards: null,
};

/** The question a League card asks Coach. */
export const tradeWith = (team: string) => `Find a trade for ${teamLabel(team)}`;

const ICONS: Record<ScreenId, ReactNode> = {
  today: <path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.5 1.5M16.5 16.5 18 18M6 18l1.5-1.5M16.5 7.5 18 6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />,
  goget: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
  market: <path d="M4 17l5-5 4 4 7-8M15 8h5v5" />,
  league: <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c.6-3 3-5 6-5s5.4 2 6 5M14 15.3c.6-.2 1.3-.3 2-.3 3 0 5.4 2 6 5" />,
};

export default function WarRoomV2({ view, leagues, activeId, onLeague, onExit, deckInitial, onDeckLog, post, initialFocus, onClassic }: {
  view: WarRoomView;
  leagues: LeagueChoice[];
  activeId: number;
  onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void;
  deckInitial?: DeckState;
  onDeckLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
  initialFocus?: string;
  onClassic?: () => void;
}) {
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const [screen, setScreen] = useState<ScreenId>('today');
  const [coachOpen, setCoachOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [autoAsk, setAutoAsk] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [current, setCurrent] = useState<CurrentMove | null>(null);
  const coach = useWarRoomCoach({ leagueId: activeId, leagues: leagues.map(l => l.id), plans: view, onLeagueChange: onLeague });
  const coachMain = coach.ui.main;
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) setTheme('dark');
  }, []);

  // The page behind the War Room never scrolls while it is open (the War Room scrolls itself).
  useEffect(() => {
    // The html element too: the app shell under the overlay can be wider than a tablet screen.
    const prev = document.body.style.overflow, prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; document.documentElement.style.overflow = prevHtml; };
  }, []);

  // Esc closes whatever sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setCoachOpen(false); setHealthOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // WR-L4: open on the target league once per page load (shared with the classic layout).
  useEffect(() => {
    if (!leagues.length) return;
    const to = openingLeague(leagues, activeId, TARGET_LEAGUE_ID, wasOpenedOnTarget());
    markOpenedOnTarget();
    if (to != null) onLeague(to);
  }, [leagues, activeId, onLeague]);

  const go = useCallback((s: ScreenId) => {
    setScreen(s);
    scroller.current?.scrollTo?.({ top: 0 });
  }, []);

  // A new league opens on Today.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    go('today');
  }, [activeId, go]);

  // Coach's focus_panel moves to the screen that holds that panel.
  useEffect(() => {
    const to = coachMain ? COACH_SCREEN[coachMain] : null;
    if (to === 'health') setHealthOpen(true);
    else if (to) go(to);
  }, [coachMain, go]);

  const negotiations = useNegotiations(activeId);
  const players = usePlayerHeadshots();
  const headshots = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of players.data ?? []) if (p.headshot) out[String(p.id)] = p.headshot;
    return out;
  }, [players.data]);

  const send = useCallback((req: WarRoomRequest) => postWarRoomRequest(activeId, req, post), [activeId, post]);
  const onCurrent = useCallback((c: CurrentMove | null) => setCurrent(c), []);
  const ask = useCallback((q: string) => { setAutoAsk(q); setCoachOpen(true); }, []);
  const askAboutMove = useCallback(() => ask(FIXED_QUESTIONS[0]), [ask]);
  const health = healthTone(view);

  const deck = (
    <PanelBoundary name="Next move">
      <NextMoveDeck key={`${activeId}:${view.snapshot?.id ?? ''}:${initialFocus ?? ''}`} view={view} big variant="hero"
        initialState={deckInitial} onLog={onDeckLog} post={post} negotiation={negotiations.data}
        onCurrent={onCurrent} onAskCoach={askAboutMove}
        onAsk={q => { setCoachOpen(true); void coach.ask(q); }} />
    </PanelBoundary>
  );

  const nav = (
    <nav className="wr-nav" role="tablist" aria-label="War Room screens">
      {SCREENS.map(s => (
        <button key={s.id} type="button" role="tab" aria-selected={screen === s.id} data-screen={s.id}
          className={screen === s.id ? 'wr-on' : undefined} onClick={() => go(s.id)}>
          <svg viewBox="0 0 24 24" aria-hidden width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">{ICONS[s.id]}</svg>
          <span>{s.name}</span>
        </button>
      ))}
    </nav>
  );

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <HeadshotContext.Provider value={headshots}>
        <div className="wr-root wr-v2" data-theme={theme} data-testid="war-room-v2" data-screen-on={screen}>
          <div className="wr-v2-scroll" ref={scroller}>
            <TopBarV2 view={view} leagues={leagues} activeId={activeId} onLeague={onLeague} onExit={onExit}
              theme={theme} onTheme={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))} onClassic={onClassic}
              nav={nav}
              health={
                <button type="button" className={`wr-health-chip wr-hc-${health.tone}`} onClick={() => setHealthOpen(true)}
                  data-testid="health-chip" aria-haspopup="dialog" title="Is the brain working? Brain check and number audit">
                  <span className="wr-hc-dot" aria-hidden /><span className="wr-hc-t">{health.label}</span>
                </button>
              } />
            <main className="wr-v2-main">
              {/* Today stays mounted so the deck keeps its place while Nick looks at other screens. */}
              <div className="wr-screen" data-screen-panel="today" hidden={screen !== 'today'}>
                <ScreenToday view={view} negotiations={negotiations.data} deck={deck} />
              </div>
              {screen !== 'today' && (
                <div className="wr-screen" key={screen} data-screen-panel={screen}>
                  <PanelBoundary name={SCREENS.find(s => s.id === screen)?.name ?? screen}>
                    {screen === 'goget' && <ScreenGoGet view={view} leagueId={activeId} current={current} onRequest={send} />}
                    {screen === 'market' && <ScreenMarket view={view} />}
                    {screen === 'league' && <ScreenLeague view={view} onAsk={team => ask(tradeWith(team))} />}
                  </PanelBoundary>
                </div>
              )}
            </main>
          </div>

          {!coachOpen && coach.enabled !== false && (
            <button type="button" className="wr-coach-fab" onClick={() => setCoachOpen(true)} aria-label="Open Coach" data-testid="coach-fab">
              <svg viewBox="0 0 24 24" aria-hidden width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></svg>
              Coach
            </button>
          )}
          <HealthSheet view={view} open={healthOpen} onClose={() => setHealthOpen(false)} />
          <CoachDrawer coach={coach} plans={view} open={coachOpen} onClose={() => setCoachOpen(false)}
            autoAsk={autoAsk} onAutoAsked={() => setAutoAsk(null)}
            deckAt={current ? { deck_index: current.index, move_id: current.move.move_id } : null} />
        </div>
      </HeadshotContext.Provider>
    </SourcesContext.Provider>
  );
}
