import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLeague } from '../state/league';
import { CoachContext, useCoach } from '../state/coach';
import { useWarRoom } from './warroom/useWarRoom';
import { CoachDrawer, useWarRoomCoach } from './warroom/coach';
import HealthSheet, { healthTone } from './warroom/HealthSheet';
import { SourcesContext } from './warroom/FieldState';
import { Icon, Skeleton } from './ui/DesignSystem';
// The drawer's styles: without this, a page opened directly (not via Today) drew the closed drawer unstyled, in the page flow.
import './warroom/warroom-v2.css';
import { isOk } from './warroom/format';

/**
 * UI consolidation: Coach on every area. It reads the active league's War Room view (the
 * plans contract; /trades/:id/war-room) and asks the same POST /api/coach/ask the War Room
 * uses. The drawer and the health sheet render inside a `.wr-v2.wr-inline` scope so they
 * keep the War Room styles without its full-screen frame.
 */
export function AppCoachProvider({ children }: { children: ReactNode }) {
  const { leagues, activeId, setActiveId } = useLeague();
  const wr = useWarRoom(activeId);
  const view = wr.data?.enabled === true ? wr.data : null;
  const leagueIds = useMemo(() => leagues.map(l => l.id), [leagues]);
  const coach = useWarRoomCoach({ leagueId: activeId ?? 0, leagues: leagueIds, plans: view, onLeagueChange: setActiveId });
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState(false);
  const [autoAsk, setAutoAsk] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setHealth(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openCoach = useCallback((q?: string) => { if (q) setAutoAsk(q); setOpen(true); }, []);
  const loading = activeId != null && wr.loading && !wr.data;
  const api = useMemo(() => ({ enabled: coach.enabled !== false, open: openCoach, openHealth: () => setHealth(true), view, loading }),
    [coach.enabled, openCoach, view, loading]);

  return (
    <CoachContext.Provider value={api}>
      {children}
      <SourcesContext.Provider value={view?.sources ?? {}}>
        <div className="wr-root wr-v2 wr-inline wr-app-layer">
          {view && <HealthSheet view={view} open={health} onClose={() => setHealth(false)} />}
          <CoachDrawer coach={coach} plans={view ?? undefined} open={open} onClose={() => setOpen(false)}
            autoAsk={autoAsk} onAutoAsked={() => setAutoAsk(null)} />
        </div>
      </SourcesContext.Provider>
    </CoachContext.Provider>
  );
}

/** The header's title odds, health chip and Coach button (the War Room top bar's pieces, app-wide). */
export function HeaderFacts() {
  const { enabled, open, openHealth, view, loading } = useCoach();
  const d = view && isOk(view.destination) ? view.destination.value : null;
  const odds = d && isOk(d.title_now) ? `${(d.title_now.value * 100).toFixed(1)}%` : null;
  const h = view ? healthTone(view) : null;
  const tone = h?.tone === 'red' ? 'ds-chip-bad' : h?.tone === 'amber' ? 'ds-chip-warn' : h?.tone === 'green' ? 'ds-chip-good' : '';
  return (
    <>
      {odds && <span className="app-fact hidden xl:inline-flex" title="Your title odds now (the plan's read)"><span>Title odds</span><b>{odds}</b></span>}
      {/* While the plans load: the chips at their final size, so nothing in the header moves when they land. */}
      {loading && <>
        <span className="app-fact hidden xl:inline-flex" aria-busy="true" data-testid="app-odds-skeleton"><span>Title odds</span><Skeleton className="h-4 w-11" /></span>
        <span className="hidden sm:inline-flex" aria-hidden="true"><Skeleton className="app-health-skel h-[26px] w-[74px] !rounded-full xl:w-[150px]" /></span>
      </>}
      {h && (
        <button type="button" className={`ds-chip ${tone} app-health hidden sm:inline-flex`} onClick={openHealth} data-testid="app-health-chip"
          aria-haspopup="dialog" title={`${h.label}. Is the brain working? Brain check and number audit`}>
          <Icon name={h.tone === 'green' ? 'ok' : h.tone === 'grey' ? 'pulse' : 'warn'} size={14} />
          <span className="hidden xl:inline">{h.label}</span><span className="xl:hidden">{h.short}</span>
        </button>
      )}
      {enabled && (
        <button type="button" className="ds-btn ds-btn-quiet app-coach-btn" onClick={() => open()} aria-label="Open Coach" data-testid="app-coach-btn">
          <Icon name="coach" size={16} /><span className="hidden lg:inline">Coach</span>
        </button>
      )}
    </>
  );
}
