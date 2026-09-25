import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { markOpenedOnTarget, openingLeague, TARGET_LEAGUE_ID, wasOpenedOnTarget } from './LeagueRail';
import NextMoveDeck, { type CurrentMove } from './NextMoveDeck';
import ScreenToday from './ScreenToday';
import ScreenGoGet from './ScreenGoGet';
import ScreenMarket from './ScreenMarket';
import ScreenLeague from './ScreenLeague';
import HealthSheet, { healthTone } from './HealthSheet';
import { CoachDrawer, FIXED_QUESTIONS, useWarRoomCoach, type Panel as CoachPanel } from './coach';
import { useNegotiations, usePlayerHeadshots } from './useWarRoom';
import { HeadshotContext } from './Avatar';
import Icon, { type IconName } from './icons';
import { useDocTheme } from './useDocTheme';

/**
 * WAR-ROOM-UI v2: the War Room as four calm screens (Trades → Next move).
 *
 *   TODAY    "Do this now" (the next move as a hero card), WATCHING (max 5), season progress
 *   GO GET   pick a target -> its paths as step timelines -> the offer composer; the plan's stops
 *   MARKET   the flip radar as cards, then catch-up
 *   LEAGUE   one card per league-mate; a tap opens Coach asked about a trade with him
 *
 * A segmented switcher sits in the top bar (a bottom tab bar on a phone). Health (brain
 * report + number audit) is a chip that opens a sheet. Coach is a right-side drawer on
 * every screen. It draws the same view (the plans contract) with the same pieces as the
 * retired classic dashboard; nothing here fetches a plan or computes a value.
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

const ICONS: Record<ScreenId, IconName> = { today: 'today', goget: 'target', market: 'trend', league: 'users' };

export default function WarRoomV2({ view, leagues, activeId, onLeague, onExit, deckInitial, onDeckLog, post, initialFocus }: {
  view: WarRoomView;
  leagues: LeagueChoice[];
  activeId: number;
  onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void;
  deckInitial?: DeckState;
  onDeckLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
  initialFocus?: string;
}) {
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const [screen, setScreen] = useState<ScreenId>('today');
  const [coachOpen, setCoachOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [autoAsk, setAutoAsk] = useState<string | null>(null);
  const [theme, toggleTheme] = useDocTheme();
  const [current, setCurrent] = useState<CurrentMove | null>(null);
  const coach = useWarRoomCoach({ leagueId: activeId, leagues: leagues.map(l => l.id), plans: view, onLeagueChange: onLeague });
  const coachMain = coach.ui.main;
  const scroller = useRef<HTMLDivElement | null>(null);

  // The page behind the War Room never scrolls while it is open (the War Room scrolls itself).
  useEffect(() => {
    // The html element too: the app shell under the overlay can be wider than a tablet screen.
    const prev = document.body.style.overflow, prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    // The app's floating page explainer moves into the War Room's menu (warroom-v2.css hides its button).
    document.body.classList?.add('wr-v2-open');
    return () => {
      document.body.style.overflow = prev; document.documentElement.style.overflow = prevHtml;
      document.body.classList?.remove('wr-v2-open');
    };
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
    // ESPN has no headshot for a negative (team defence) id; those get initials without a failed request.
    for (const p of players.data ?? []) if (p.headshot && !/\/-\d+\.png$/.test(p.headshot)) out[String(p.id)] = p.headshot;
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

  const coachIcon = <Icon name="coach" size={18} />;
  const coachOn = coach.enabled !== false;
  // One switcher, drawn twice: in the top bar on a wide screen, as the bottom tab bar (with a Coach tab) on a phone.
  const tabs = (where: 'top' | 'bottom') => (
    <nav className={where === 'top' ? 'wr-nav' : 'wr-tabbar'} role="tablist" aria-label="War Room screens"
      data-nav={where}>
      {SCREENS.map(s => (
        <button key={s.id} type="button" role="tab" aria-selected={screen === s.id} data-screen={where === 'top' ? s.id : undefined}
          data-tab-screen={where === 'bottom' ? s.id : undefined}
          className={screen === s.id ? 'wr-on' : undefined} onClick={() => go(s.id)}>
          <Icon name={ICONS[s.id]} size={where === 'top' ? 16 : 22} />
          <span>{s.name}</span>
        </button>
      ))}
      {where === 'bottom' && coachOn && (
        <button type="button" className={`wr-tab-coach${coachOpen ? ' wr-on' : ''}`} onClick={() => setCoachOpen(true)}
          aria-label="Open Coach" data-testid="coach-tab">{coachIcon}<span>Coach</span></button>
      )}
    </nav>
  );

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <HeadshotContext.Provider value={headshots}>
        <div className="wr-root wr-v2" data-theme={theme} data-testid="war-room-v2" data-screen-on={screen}>
          <TopBarV2 view={view} leagues={leagues} activeId={activeId} onLeague={onLeague} onExit={onExit}
            theme={theme} onTheme={toggleTheme}
            nav={tabs('top')}
            health={
              <button type="button" className={`wr-health-chip wr-hc-${health.tone}`} onClick={() => setHealthOpen(true)}
                data-testid="health-chip" aria-haspopup="dialog" title={`${health.label}. Is the brain working? Brain check and number audit`}>
                <Icon name={health.tone === 'green' ? 'ok' : health.tone === 'grey' ? 'pulse' : 'warn'} size={14} className="wr-hc-ic" /><span className="wr-hc-t">{health.label}</span><span className="wr-hc-s">{health.short}</span>
              </button>
            }
            coach={coachOn ? (
              <button type="button" className="wr-btn wr-coach-btn" onClick={() => setCoachOpen(true)} aria-label="Open Coach" data-testid="coach-fab">
                {coachIcon}Coach
              </button>
            ) : null} />
          <div className="wr-v2-scroll" ref={scroller}>
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
          {tabs('bottom')}
          <HealthSheet view={view} open={healthOpen} onClose={() => setHealthOpen(false)} />
          <CoachDrawer coach={coach} plans={view} open={coachOpen} onClose={() => setCoachOpen(false)}
            autoAsk={autoAsk} onAutoAsked={() => setAutoAsk(null)}
            deckAt={current ? { deck_index: current.index, move_id: current.move.move_id } : null} />
        </div>
      </HeadshotContext.Provider>
    </SourcesContext.Provider>
  );
}
