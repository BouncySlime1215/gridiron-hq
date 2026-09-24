import type { WarRoomView } from './types';
import { Val } from './FieldState';
import { HealthDot } from './BrainCheckCard';
import { pct, pts, NOT_COMPUTED } from './format';

const MODES: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };

export interface LeagueChoice { id: number; name: string | null }

/**
 * Top strip: league switcher ranked by "needs you this week" (producer rank; app order
 * with "not ranked yet" until it exists), destination, ETA vs plan, title odds now vs
 * plan, risk mode chip, brain + number-health dots, and the way back to the other tabs.
 */
export default function TopStrip({ view, leagues, activeId, onLeague, onExit, theme, onTheme }: {
  view: WarRoomView; leagues: LeagueChoice[]; activeId: number; onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void; theme: 'light' | 'dark'; onTheme: () => void;
}) {
  const att = view.attention;
  const ranked = att?.status === 'ok' && att.value
    ? [...leagues].sort((a, b) => rankOf(att.value!, a.id) - rankOf(att.value!, b.id)) : leagues;
  const d = view.destination;
  const risk = d?.risk_mode;
  return (
    <header className="wr-top" aria-label="Where we are going">
      <div className="wr-brand"><small>Trade Brain</small>War Room</div>
      <div className="wr-leagues" role="tablist" aria-label="Leagues, most urgent first">
        {ranked.map((l, i) => {
          const a = att?.status === 'ok' ? att.value?.find(x => x.league_id === l.id) : undefined;
          return (
            <button key={l.id} type="button" role="tab" aria-selected={l.id === activeId}
              className={`wr-lg${l.id === activeId ? ' wr-on' : ''}`} onClick={() => onLeague(l.id)}>
              <span className="wr-lg-n">{a && <span className={`wr-rk${i > 1 ? ' wr-rk-low' : ''}`}>{a.rank}</span>}{l.name ?? `League ${l.id}`}</span>
              <span className="wr-lg-w">{a ? a.text : 'not ranked yet'}</span>
            </button>
          );
        })}
      </div>
      <div className="wr-facts">
        <div className="wr-fact"><span className="wr-l">Destination</span><span className="wr-v"><Val f={d?.goal} fmt={g => g.label} /></span></div>
        <div className="wr-fact"><span className="wr-l">ETA vs plan</span><span className="wr-v">
          <Val f={d?.eta_week} fmt={w => `wk ${w}`} />{d?.arrive_by?.status === 'ok' && <span className="wr-muted"> plan wk {d.arrive_by.value}</span>}
        </span></div>
        <div className="wr-fact"><span className="wr-l">Title odds</span><span className="wr-v wr-num">
          <Val f={d?.title_now} fmt={v => pct(v, 1)} />
          {d?.title_planned_now?.status === 'ok' && <span className="wr-muted"> plan <Val f={d.title_planned_now} fmt={v => pct(v, 1)} /></span>}
          {d?.ground_lost?.status === 'ok' && <span className="wr-amber"> <Val f={d.ground_lost} fmt={pts} /></span>}
        </span></div>
        <div className="wr-fact"><span className="wr-l">Risk mode</span>
          <button type="button" className={`wr-chip${risk?.status === 'ok' && risk.value === 'all_in' ? ' wr-chip-allin' : ''}`} disabled
            title={risk?.status === 'ok' ? 'Changing the mode turns on with the request queue (WR-3)' : risk?.reason}>
            {risk?.status === 'ok' && risk.value ? MODES[risk.value] : NOT_COMPUTED}
          </button>
        </div>
        <div className="wr-fact"><span className="wr-l">Checks</span><span className="wr-v">
          <span className="wr-dotwrap" title={view.brain_check?.reason ?? 'Brain check'}><span className={`wr-dot wr-dot-${view.brain_check?.status === 'ok' ? brainColor(view.brain_check.value?.overall) : 'grey'}`} />brain</span>{' '}
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

function rankOf(list: { league_id: number; rank: number }[], id: number) {
  return list.find(x => x.league_id === id)?.rank ?? Number.MAX_SAFE_INTEGER;
}
function brainColor(o: string | undefined) {
  return o === 'failing' ? 'red' : o === 'passing' ? 'green' : 'grey';
}
