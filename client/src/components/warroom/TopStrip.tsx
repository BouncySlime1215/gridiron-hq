import type { WarRoomView } from './types';
import { Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import LeagueRail, { TARGET_LEAGUE_ID, type LeagueChoice } from './LeagueRail';

export type { LeagueChoice };

const MODES: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };

/**
 * Top strip: league rail (LeagueRail: the target league first, the rest folded under
 * "training leagues"; the open league shows its "needs you this week" rank), `destination`
 * (goal, ETA vs plan, title odds now vs plan, risk mode), the `brain_report` and
 * number-health dots, and the way back to the other tabs.
 */
export default function TopStrip({ view, leagues, activeId, onLeague, onExit, theme, onTheme }: {
  view: WarRoomView; leagues: LeagueChoice[]; activeId: number; onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void; theme: 'light' | 'dark'; onTheme: () => void;
}) {
  const att = isOk(view.attention) ? view.attention.value : null;
  const d = isOk(view.destination) ? view.destination.value : undefined;
  // A destination that is itself failed/unknown shows ITS state (and reason) in every fact, not a bare "not computed".
  const sub = <K extends keyof NonNullable<typeof d>>(k: K) => (d ? d[k] : view.destination) as NonNullable<typeof d>[K] | undefined;
  const risk = d?.risk_mode;
  const brain = view.brain_report;
  return (
    <header className="wr-top" aria-label="Where we are going">
      <div className="wr-brand"><small>Trade Brain</small>War Room</div>
      <LeagueRail leagues={leagues} activeId={activeId} target={TARGET_LEAGUE_ID}
        attention={att} onLeague={onLeague} />
      <div className="wr-facts">
        <div className="wr-fact"><span className="wr-l">Destination</span><span className="wr-v"><Val f={sub('goal')} fmt={g => g.label} /></span></div>
        <div className="wr-fact"><span className="wr-l">ETA vs plan</span><span className="wr-v">
          <Val f={sub('eta_week')} fmt={w => `wk ${w}`} />{d?.arrive_by?.status === 'ok' && <span className="wr-muted"> plan wk {d.arrive_by.value}</span>}
        </span></div>
        <div className="wr-fact"><span className="wr-l">Title odds</span><span className="wr-v wr-num">
          <Val f={sub('title_now')} fmt={v => pct(v, 1)} />
          {d?.title_planned_now?.status === 'ok' && <span className="wr-muted"> plan <Val f={d.title_planned_now} fmt={v => pct(v, 1)} /></span>}
          {d?.ground_lost?.status === 'ok' && <span className="wr-amber"> <Val f={d.ground_lost} fmt={pts} /></span>}
        </span></div>
        <div className="wr-fact"><span className="wr-l">Risk mode</span>
          <button type="button" className={`wr-chip${isOk(risk) && risk.value.mode === 'all_in' ? ' wr-chip-allin' : ''}`} disabled
            title={isOk(risk) ? "Changing the mode is Coach's (FIX-06)" : risk?.reason ?? view.destination?.reason}>
            {isOk(risk) ? `${MODES[risk.value.mode]}${risk.value.until_week ? ` until wk ${risk.value.until_week}` : ''}`
              : (risk ?? view.destination)?.status === 'failed' ? 'hidden: failed its check' : NOT_COMPUTED}
          </button>
        </div>
        <NoMoveFact next={view.next_move} planned={!!d} />
        <div className="wr-fact"><span className="wr-l">Checks</span><span className="wr-v">
          <span className="wr-dotwrap" data-brain={isOk(brain) ? brain.value.overall : brain?.status ?? 'unknown'}
            title={isOk(brain) ? `Brain check: ${BRAIN_WORDS[brain.value.overall] ?? brain.value.overall}` : brain?.reason ?? `Brain check ${NOT_COMPUTED}`}>
            <span className={`wr-dot wr-dot-${isOk(brain) ? brainColor(brain.value.overall) : 'grey'}`} />brain{isOk(brain) && brain.value.overall === 'not_enough_data' && <span className="wr-muted"> (not enough data)</span>}</span>{' '}
          <NumberDot health={view.number_health} /> numbers
        </span></div>
      </div>
      {view.preview && <span className="wr-tag wr-prev" title={view.preview_reason}>Preview, unconfirmed</span>}
      <button type="button" className="wr-chip" onClick={onTheme} aria-label="Switch light or dark">{theme === 'dark' ? 'Light' : 'Dark'}</button>
      <div className="wr-exit">
        <button type="button" className="wr-chip" onClick={() => onExit('managers')}>Who trades with you</button>
        <button type="button" className="wr-chip" onClick={() => onExit('proposals')}>Sendable proposals</button>
      </div>
    </header>
  );
}

/**
 * WR-L4: the strip's number-health dot. The contract writes `overall` (+ broken/warn/ok
 * counts); types.ts's NumberHealth says `status`, which the producer never writes, so the
 * shared HealthDot stayed grey on a computed audit. Read `overall`, fall back to `status`.
 */
function NumberDot({ health }: { health: WarRoomView['number_health'] }) {
  const v = isOk(health) ? (health.value as unknown as { overall?: string; status?: string; broken?: number; warn?: number }) : null;
  const s = v ? v.overall ?? v.status ?? null : null;
  const color = s === 'broken' ? 'red' : s === 'warn' ? 'amber' : s === 'ok' ? 'green' : 'grey';
  const text = s === 'broken' ? `numbers broken (${v?.broken ?? '?'})` : s === 'warn' ? `${v?.warn ?? '?'} number warning(s)` : s === 'ok' ? 'numbers checked'
    : health?.status === 'failed' ? 'number check failed' : `number check ${NOT_COMPUTED}`;
  return (
    <span className="wr-dotwrap" title={health?.reason ?? text} data-health={color}>
      <span className={`wr-dot wr-dot-${color}`} />
    </span>
  );
}

export const NO_MOVE = 'No move clears this week';

/**
 * WR-L4: when the producer searched and found no move (`next_move` unknown with a reason),
 * the strip says so in words, with the producer's reason, instead of leaving it to a blank
 * deck. A computed next move needs no strip fact (the deck shows it); a failed one says failed.
 */
function NoMoveFact({ next, planned }: { next: WarRoomView['next_move']; planned: boolean }) {
  // Only a league the planner ran for (destination ok): with no plan at all, "no move clears" would be false.
  if (!planned || !next || isOk(next)) return null;
  const failed = next?.status === 'failed';
  return (
    <div className="wr-fact" data-testid="no-move"><span className="wr-l">This week</span><span className="wr-v">
      <span className={failed ? 'wr-fail' : 'wr-amber'} data-state={failed ? 'failed' : 'no-move'}>
        {failed ? 'Next move hidden: failed its check' : NO_MOVE}
      </span>
      {next?.reason && <span className="wr-muted" data-testid="no-move-reason"> {next.reason}</span>}
    </span></div>
  );
}

const BRAIN_WORDS: Record<string, string> = { passing: 'passing', failing: 'failing', not_enough_data: 'not enough data yet' };

function brainColor(o: string | undefined) {
  return o === 'failing' ? 'red' : o === 'passing' ? 'green' : 'grey';
}
