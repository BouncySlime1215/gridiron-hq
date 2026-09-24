import type { WarRoomView } from './types';
import { Val } from './FieldState';
import { HealthDot } from './BrainCheckCard';
import { pct, pts, NOT_COMPUTED, isOk } from './format';

const MODES: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };

export interface LeagueChoice { id: number; name: string | null }

/**
 * Top strip: league switcher (app order; the open league shows its "needs you this week"
 * rank from `attention`, "not ranked yet" until the producer writes it), `destination`
 * (goal, ETA vs plan, title odds now vs plan, risk mode), the `brain_report` and
 * number-health dots, and the way back to the other tabs.
 */
export default function TopStrip({ view, leagues, activeId, onLeague, onExit, theme, onTheme }: {
  view: WarRoomView; leagues: LeagueChoice[]; activeId: number; onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void; theme: 'light' | 'dark'; onTheme: () => void;
}) {
  // Audit defect 1: a rank outside 1..of is never drawn (the view already fails it).
  const rawAtt = isOk(view.attention) ? view.attention.value : null;
  const att = rawAtt && rankInRange(rawAtt.rank, rawAtt.of) ? rawAtt : null;
  const d = isOk(view.destination) ? view.destination.value : undefined;
  const risk = d?.risk_mode;
  const brain = view.brain_report;
  return (
    <header className="wr-top" aria-label="Where we are going">
      <div className="wr-brand"><small>Trade Brain</small>War Room</div>
      <div className="wr-leagues" role="tablist" aria-label="Leagues, most urgent first">
        {leagues.map(l => {
          const a = l.id === activeId ? att : null;
          return (
            <button key={l.id} type="button" role="tab" aria-selected={l.id === activeId}
              className={`wr-lg${l.id === activeId ? ' wr-on' : ''}`} onClick={() => onLeague(l.id)}>
              <span className="wr-lg-n">{a && <span className={`wr-rk${a.rank > 2 ? ' wr-rk-low' : ''}`}>{a.rank}</span>}{l.name ?? `League ${l.id}`}</span>
              <span className="wr-lg-w" title={a ? `rank ${a.rank} of ${a.of}: ${a.reason}` : l.id === activeId ? view.attention?.reason : undefined}>{a ? `rank ${a.rank} of ${a.of}: ${a.reason}` : l.id === activeId ? 'not ranked yet' : 'open to see its rank'}</span>
            </button>
          );
        })}
      </div>
      <div className="wr-facts">
        <div className="wr-fact"><span className="wr-l">Destination</span><span className="wr-v"><Val f={d?.goal} fmt={g => g.label} /></span></div>
        <div className="wr-fact"><span className="wr-l">ETA vs plan</span><span className="wr-v">
          <Val f={d?.eta_week} fmt={w => `wk ${w}`} />{d?.arrive_by?.status === 'ok' && <span className="wr-muted"> plan wk {d.arrive_by.value}</span>}
        </span></div>
        <div className="wr-fact" data-fact="title"><span className="wr-l">Title odds now → planned</span><span className="wr-v wr-num">
          <Val f={d?.title_now} fmt={v => pct(v, 1)} /><span className="wr-muted"> → </span><Val f={d?.title_planned_now} fmt={v => pct(v, 1)} />
          {d?.ground_lost?.status === 'ok' && <span className="wr-amber"> <Val f={d.ground_lost} fmt={pts} /></span>}
        </span></div>
        <div className="wr-fact" data-fact="risk"><span className="wr-l">Risk mode</span>
          <button type="button" className={`wr-chip${isOk(risk) && risk.value.mode === 'all_in' ? ' wr-chip-allin' : ''}`} disabled
            title={isOk(risk) ? "Changing the mode is Coach's (FIX-06)" : risk?.reason ?? view.destination?.reason}>
            {isOk(risk) ? `${MODES[risk.value.mode]}${risk.value.until_week ? ` until wk ${risk.value.until_week}` : ''}` : NOT_COMPUTED}
          </button>
        </div>
        <div className="wr-fact" data-fact="checks"><span className="wr-l">Checks</span><span className="wr-v">
          <span className="wr-dotwrap" title={brain?.reason ?? 'Brain check'}><span className={`wr-dot wr-dot-${isOk(brain) ? brainColor(brain.value.overall) : 'grey'}`} />brain</span>{' '}
          <HealthDot health={view.number_health} compact /> numbers
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

/** 1 <= rank <= of, both whole numbers. */
export function rankInRange(rank: unknown, of: unknown): boolean {
  return Number.isInteger(rank) && Number.isInteger(of) && (rank as number) >= 1 && (rank as number) <= (of as number);
}

function brainColor(o: string | undefined) {
  return o === 'failing' ? 'red' : o === 'passing' ? 'green' : 'grey';
}
