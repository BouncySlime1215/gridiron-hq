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

/** The no-page-scroll contract, inline so it cannot be lost to a stylesheet. */
export const ROOT_STYLE = { position: 'fixed', inset: 0, height: '100vh', overflow: 'hidden', gridTemplateAreas: GRID_AREAS } as const;

export default function WarRoom({ view, leagues, activeId, onLeague, onExit, deckInitial, onDeckLog, post }: {
  view: WarRoomView;
  leagues: LeagueChoice[];
  activeId: number;
  onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void;
  deckInitial?: DeckState;
  onDeckLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
}) {
  // TEAM-NAMES: before any panel renders, so every teamLabel reads this view's names.
  setTeamNames(isOk(view.teams) ? view.teams.value : null);
  const [swap, setSwap] = useState<PanelId | null>(null);
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
  useEffect(() => { setSwap(null); }, [activeId]);

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
  const d = isOk(view.destination) ? view.destination.value : undefined;
  const send = useCallback((req: WarRoomRequest) => postWarRoomRequest(activeId, req, post), [activeId, post]);

  return (
    <SourcesContext.Provider value={view.sources ?? {}}>
      <div className="wr-root wr-app" data-theme={theme} data-testid="war-room-grid" style={ROOT_STYLE}>
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
            <NextMoveDeck key={`${activeId}:${view.snapshot?.id ?? ''}`} view={view} big={big('next')} initialState={deckInitial} onLog={onDeckLog} post={post} negotiation={negotiations.data}
              onAsk={q => { setCoachOpen(true); void coach.ask(q); }} />
          </Panel>
          <Panel {...common('stops')} title="Stops">
            <Itinerary field={view.itinerary} big={big('stops')} />
          </Panel>
          <Panel {...common('flip_map')} title="Flip map">
            <FlipMap field={view.flip_map} names={view.names} big={big('flip_map')} />
          </Panel>
          <Panel {...common('targets')} title="Suggested targets">
            <TargetPicker field={view.targets} names={view.names} big={big('targets')} onRequest={send} />
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
          {PANELS.map((p, i) => (
            <button key={p.id} type="button" className={i === deckPos ? 'wr-on' : undefined} onClick={() => gotoPanel(i)}>{p.name}</button>
          ))}
        </nav>

        <CoachDock coach={coach} plans={view} open={coachOpen} onToggle={() => setCoachOpen(o => !o)} />
      </div>
    </SourcesContext.Provider>
  );
}
