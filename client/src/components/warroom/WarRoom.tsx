import { useCallback, useEffect, useRef, useState } from 'react';
import './warroom.css';
import type { PanelId, WarRoomView } from './types';
import type { DeckLogEntry, DeckState } from './deck';
import { SourcesContext } from './FieldState';
import { Panel } from './Panel';
import TopStrip, { type LeagueChoice } from './TopStrip';
import NextMoveDeck from './NextMoveDeck';
import Itinerary from './Itinerary';
import FlipMap from './FlipMap';
import TargetPicker from './TargetPicker';
import CatchUp from './CatchUp';
import BrainCheckCard from './BrainCheckCard';
import { CoachDock, useWarRoomCoach, type Panel as CoachPanel } from './coach';

/**
 * The War Room: ONE dashboard, no page scroll (WAR-ROOM-UI.md v2).
 *
 * Desktop: a fixed CSS grid exactly one viewport tall (100vh, overflow hidden). NEXT MOVE
 * holds the big slot; any other panel's Expand swaps it into that slot in place and Esc
 * swaps back. Lists page inside their panels. The Coach dock (coach/CoachDock) keeps the right column.
 * Phone (< 700 px): the same panels as a one-screen swipe deck (scroll-snap, dots below),
 * Coach as a bottom sheet. Still no vertical page scroll.
 *
 * It renders only what the view says; it fetches nothing itself (useWarRoom is the one fetch).
 */
export const PANELS: { id: PanelId; name: string }[] = [
  { id: 'next', name: 'Next move' },
  { id: 'stops', name: 'Stops' },
  { id: 'flip', name: 'Flip map' },
  { id: 'targets', name: 'Targets' },
  { id: 'catch', name: 'Catch-up' },
  { id: 'brain', name: 'Brain check' },
];

export const GRID_AREAS = [
  'top top top top coach',
  'next next stops flip coach',
  'next next stops flip coach',
  'targets targets catch brain coach',
].map(r => `"${r}"`).join(' ');

/** The no-page-scroll contract, inline so it cannot be lost to a stylesheet. */
/** Coach's panel names -> this grid's areas. Destination and cards have no slot of their own. */
export const COACH_PANEL_AREA: Record<CoachPanel, PanelId | null> = {
  next_move: 'next', itinerary: 'stops', flip_map: 'flip', targets: 'targets', catch_up: 'catch', brain_check: 'brain',
  destination: null, cards: null,
};

export const ROOT_STYLE = { position: 'fixed', inset: 0, height: '100vh', overflow: 'hidden', gridTemplateAreas: GRID_AREAS } as const;

export default function WarRoom({ view, leagues, activeId, onLeague, onExit, deckInitial, onDeckLog }: {
  view: WarRoomView;
  leagues: LeagueChoice[];
  activeId: number;
  onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void;
  deckInitial?: DeckState;
  onDeckLog?: (log: DeckLogEntry[]) => void;
}) {
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

  const d = view.destination;

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
            <NextMoveDeck key={activeId} field={view.next_move} big={big('next')} initialState={deckInitial} onLog={onDeckLog} />
          </Panel>
          <Panel {...common('stops')} title="Stops">
            <Itinerary field={view.itinerary} big={big('stops')} />
          </Panel>
          <Panel {...common('flip')} title="Flip map">
            <FlipMap field={view.flips} big={big('flip')} />
          </Panel>
          <Panel {...common('targets')} title="Suggested targets">
            <TargetPicker field={view.suggestions} big={big('targets')} />
          </Panel>
          <Panel {...common('catch')} title="Catch-up · speed">
            <CatchUp catchUp={view.catch_up} speed={view.speed_curve} groundLost={d?.ground_lost} big={big('catch')} />
          </Panel>
          <Panel {...common('brain')} title="Is the brain working?">
            <BrainCheckCard brain={view.brain_check} health={view.number_health} big={big('brain')} />
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
