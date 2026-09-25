import { useCallback, useEffect, useRef, useState } from 'react';
import './warroom.css';
import { setTeamNames, type PanelId, type WarRoomView } from './types';
import type { DeckLogEntry, DeckState } from './deck';
import { postWarRoomRequest, type Poster, type WarRoomRequest } from './requests';
import { isOk } from './format';
import { SourcesContext } from './FieldState';
import { Panel } from './Panel';
import TopStrip, { type LeagueChoice } from './TopStrip';
import { openingLeague, TARGET_LEAGUE_ID } from './LeagueRail';
import NextMoveDeck from './NextMoveDeck';
import Itinerary from './Itinerary';
import FlipMap from './FlipMap';
import TargetPicker from './TargetPicker';
import CatchUp from './CatchUp';
import BrainCheckCard from './BrainCheckCard';
import { CoachDock, useWarRoomCoach, type Panel as CoachPanel } from './coach';
import { useNegotiations } from './useWarRoom';
import PeopleBoard, { DeckFocusBar, focusView } from './PeopleBoard';
import BlueChipBoard from './BlueChipBoard';

/**
 * The War Room: ONE dashboard, no page scroll (WAR-ROOM-UI.md v2).
 *
 * Desktop: a fixed CSS grid exactly one viewport tall (100vh, overflow hidden). NEXT MOVE
 * holds the big slot; any other panel's Expand swaps it into that slot in place and Esc
 * swaps back. Lists page inside their panels. The Coach dock (coach/CoachDock) keeps the right column.
 * Phone (< 700 px): the same panels as a one-screen swipe deck (scroll-snap, dots below),
 * Coach as a bottom sheet. Still no vertical page scroll.
 *
 * It renders only what the view says (the contract's league entry: `alternatives`,
 * `targets`, `flip_map`, `brain_report`, ...); useWarRoom is the one read and
 * requests.ts the one write (skips, "I sent it", replies, target approvals).
 *
 * PEOPLE-BOARD (WAR-ROOM-UI.md v3): when the view says `people_board.enabled`, a People
 * rail takes the column left of Coach, top to bottom; on the phone it is the deck page
 * right after Next move. Tapping a tile focuses the Next move deck on the plan's moves
 * with that manager ("All moves" clears it). Off, the grid is exactly GRID_AREAS.
 */
export const PANELS: { id: PanelId; name: string }[] = [
  { id: 'next', name: 'Next move' },
  { id: 'stops', name: 'Stops' },
  { id: 'flip_map', name: 'Flip map' },
  { id: 'targets', name: 'Targets' },
  { id: 'catch', name: 'Catch-up' },
  { id: 'brain_report', name: 'Brain check' },
];

export const GRID_AREAS = [
  'top top top top coach',
  'next next stops flip_map coach',
  'next next stops flip_map coach',
  'targets targets catch brain_report coach',
].map(r => `"${r}"`).join(' ');

/**
 * Coach's panel names -> this grid's areas (FIX-04 named them after the contract sections).
 * Destination and cards have no slot of their own.
 */
export const COACH_PANEL_AREA: Record<CoachPanel, PanelId | null> = {
  next_move: 'next', itinerary: 'stops', flip_map: 'flip_map', targets: 'targets', catch_up: 'catch', brain_check: 'brain_report',
  destination: null, cards: null,
};

/** WR-L4: the War Room opens on the target league once per page load; after that Nick's pick stands. */
let openedOnTarget = false;
/** Test hook: forget that this page load already opened on the target league. */
export function __resetOpening() { openedOnTarget = false; }

/** The same grid with the People rail between the panels and Coach. */
export const GRID_AREAS_PEOPLE = [
  'top top top top top coach',
  'next next stops flip_map people coach',
  'next next stops flip_map people coach',
  'targets targets catch brain_report people coach',
].map(r => `"${r}"`).join(' ');

/** The no-page-scroll contract, inline so it cannot be lost to a stylesheet. */
export const ROOT_STYLE = { position: 'fixed', inset: 0, height: '100vh', overflow: 'hidden', gridTemplateAreas: GRID_AREAS } as const;
const ROOT_STYLE_PEOPLE = { ...ROOT_STYLE, gridTemplateAreas: GRID_AREAS_PEOPLE } as const;
export const rootStyle = (people: boolean) => (people ? ROOT_STYLE_PEOPLE : ROOT_STYLE);

/** Panel order = DOM order = phone deck order; the People rail goes right after Next move. */
const PANELS_PEOPLE = [PANELS[0], { id: 'people' as const, name: 'People' }, ...PANELS.slice(1)];
export const panelsFor = (people: boolean) => (people ? PANELS_PEOPLE : PANELS);

export default function WarRoom({ view, leagues, activeId, onLeague, onExit, deckInitial, onDeckLog, post, initialFocus }: {
  view: WarRoomView;
  leagues: LeagueChoice[];
  activeId: number;
  onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void;
  deckInitial?: DeckState;
  onDeckLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
  /** A manager the deck starts focused on (a People Board tap). */
  initialFocus?: string;
}) {
  // TEAM-NAMES: before any panel renders, so every teamLabel reads this view's names.
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const [swap, setSwap] = useState<PanelId | null>(null);
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);
  const [coachOpen, setCoachOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [phone, setPhone] = useState(false);
  const [deckPos, setDeckPos] = useState(0);
  const deckRef = useRef<HTMLElement | null>(null);
  // Coach reads the same view the panels draw (the plans contract); it never fetches plans.
  const coach = useWarRoomCoach({ leagueId: activeId, leagues: leagues.map(l => l.id), plans: view, onLeagueChange: onLeague });
  const coachMain = coach.ui.main;

  // Theme starts from the system; the toggle overrides. Phone = < 700 px.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) setTheme('dark');
    const mq = window.matchMedia('(max-width: 699px)');
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  // The page behind the War Room never scrolls while it is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Esc puts NEXT MOVE back in the big slot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSwap(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Open on the target league the first time the War Room shows in this page load.
  const target = TARGET_LEAGUE_ID;
  useEffect(() => {
    if (!leagues.length) return;
    const to = openingLeague(leagues, activeId, target, openedOnTarget);
    openedOnTarget = true;
    if (to != null) onLeague(to);
  }, [target, leagues, activeId, onLeague]);

  // A new league starts on its own deck.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSwap(null); setFocus(null);
  }, [activeId]);

  // Coach's focus_panel (and its undo) swaps that panel into the big slot, like Expand.
  useEffect(() => {
    const area = coachMain ? COACH_PANEL_AREA[coachMain] : null;
    setSwap(area && area !== 'next' ? area : null);
  }, [coachMain]);

  const areaOf = (p: PanelId) => (swap ? (p === swap ? 'next' : p === 'next' ? swap : p) : p);
  const big = (p: PanelId) => phone || areaOf(p) === 'next';
  const common = (p: PanelId) => ({
    id: p, area: areaOf(p), big: big(p), expanded: swap === p,
    onExpand: p === 'next' ? (swap ? () => setSwap(null) : undefined) : () => setSwap(p),
    onRestore: () => setSwap(null),
  });

  const gotoPanel = useCallback((i: number) => {
    const el = deckRef.current?.children[i] as HTMLElement | undefined;
    if (el && deckRef.current) deckRef.current.scrollTo({ left: el.offsetLeft - deckRef.current.offsetLeft, behavior: 'smooth' });
  }, []);

  const negotiations = useNegotiations(activeId);
  const people = view.people_board?.enabled === true;
  const panels = panelsFor(people);
  // A tile tap: the deck shows only the moves with him, in the big slot, in view.
  const focusOn = useCallback((team: string) => { setFocus(team); setSwap(null); if (phone) gotoPanel(0); }, [phone, gotoPanel]);
  const deckView = focus ? focusView(view, focus) : view;

  const d = isOk(view.destination) ? view.destination.value : undefined;
  const send = useCallback((req: WarRoomRequest) => postWarRoomRequest(activeId, req, post), [activeId, post]);

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <div className={`wr-root wr-app${people ? ' wr-people-on' : ''}`} data-theme={theme} data-testid="war-room-grid" style={rootStyle(people)}>
        <TopStrip view={view} leagues={leagues} activeId={activeId} onLeague={onLeague} onExit={onExit}
          theme={theme} onTheme={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))} />

        <main className="wr-panels" ref={deckRef} aria-label="War Room panels"
          onScroll={e => {
            if (!phone) return;
            const el = e.currentTarget, i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth + 8));
            if (i !== deckPos) setDeckPos(i);
          }}>
          <Panel {...common('next')} title="Next move">
            {view.banner && <div className="wr-banner">{view.banner}</div>}
            {focus && <DeckFocusBar view={view} team={focus} onClear={() => setFocus(null)} />}
            <NextMoveDeck key={`${activeId}:${view.snapshot?.id ?? ''}:${focus ?? ''}`} view={deckView} big={big('next')}
              initialState={focus ? undefined : deckInitial} onLog={onDeckLog} post={post} negotiation={negotiations.data}
              onAsk={q => { setCoachOpen(true); void coach.ask(q); }} />
          </Panel>
          {people && (
            <Panel {...common('people')} title="People">
              <PeopleBoard view={view} big={big('people')} focus={focus} onFocus={focusOn} />
            </Panel>
          )}
          <Panel {...common('stops')} title="Stops">
            <Itinerary field={view.itinerary} big={big('stops')} />
          </Panel>
          <Panel {...common('flip_map')} title="Flip map">
            <FlipMap field={view.flip_map} names={view.names} big={big('flip_map')} />
          </Panel>
          <Panel {...common('targets')} title="Suggested targets">
            <TargetPicker field={view.targets} names={view.names} big={big('targets')} onRequest={send} />
            {view.blue_chips && view.blue_chips.status === 'ok' && <BlueChipBoard field={view.blue_chips} big={big('targets')} />}
          </Panel>
          <Panel {...common('catch')} title="Catch-up · speed">
            <CatchUp catchUp={view.catch_up} speed={view.speed_curve} groundLost={d?.ground_lost}
              arriveBy={isOk(d?.arrive_by) ? d.arrive_by.value : undefined} big={big('catch')} />
          </Panel>
          <Panel {...common('brain_report')} title="Is the brain working?">
            <BrainCheckCard brain={view.brain_report} health={view.number_health} big={big('brain_report')} />
          </Panel>
        </main>

        <nav className="wr-dots" aria-label="Panels">
          {panels.map((p, i) => (
            <button key={p.id} type="button" className={i === deckPos ? 'wr-on' : undefined} onClick={() => gotoPanel(i)}>{p.name}</button>
          ))}
        </nav>

        <CoachDock coach={coach} plans={view} open={coachOpen} onToggle={() => setCoachOpen(o => !o)} />
      </div>
    </SourcesContext.Provider>
  );
}
