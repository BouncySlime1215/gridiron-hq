import type { ReactNode } from 'react';
import type { Destination, WarRoomView } from './types';
import { Val } from './FieldState';
import { pct, NOT_COMPUTED, isOk } from './format';
import LeagueRail, { TARGET_LEAGUE_ID, type LeagueChoice } from './LeagueRail';
import { rankInRange } from './TopStrip';

const MODES: Record<string, string> = { safe: 'Safe', balanced: 'Balanced', all_in: "Fuck it, let's go" };

/**
 * WAR-ROOM-UI v2 top strip: the league switcher (compact), title odds and the risk mode.
 * Nothing else is on the strip; the theme, the way back to the other tabs and the
 * Classic layout switch sit in the small menu on the right.
 */
export default function TopBarV2({ view, leagues, activeId, onLeague, onExit, theme, onTheme, onClassic, nav, health }: {
  view: WarRoomView; leagues: LeagueChoice[]; activeId: number; onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void; theme: 'light' | 'dark'; onTheme: () => void; onClassic?: () => void;
  /** The four-screen switcher (a bottom tab bar on a phone, by CSS). */
  nav?: ReactNode;
  /** The health chip (opens the brain report sheet). */
  health?: ReactNode;
}) {
  const rawAtt = isOk(view.attention) ? view.attention.value : null;
  const att = rawAtt && rankInRange(rawAtt.rank, rawAtt.of) ? rawAtt : null;
  const d = isOk(view.destination) ? view.destination.value : undefined;
  // A destination that is itself failed/unknown shows ITS state (and reason) in each fact, as the classic strip does.
  const titleNow = (d ? d.title_now : view.destination) as Destination['title_now'] | undefined;
  const risk = (d ? d.risk_mode : view.destination) as Destination['risk_mode'] | undefined;
  return (
    <header className="wr-bar2" aria-label="War Room summary">
      <div className="wr-bar2-brand">War Room</div>
      <div className="wr-bar2-leagues">
        <LeagueRail leagues={leagues} activeId={activeId} target={TARGET_LEAGUE_ID} attention={att} onLeague={onLeague} />
      </div>
      <div className="wr-bar2-facts">
        <span className="wr-bar2-fact" data-fact="title">
          <span className="wr-bar2-l">Title odds</span>
          <b className="wr-num"><Val f={titleNow} fmt={v => pct(v, 1)} /></b>
        </span>
        <span className={`wr-pill2${isOk(risk) && risk.value.mode === 'all_in' ? ' wr-pill2-red' : ''}`} data-fact="risk"
          title={isOk(risk) ? "Risk mode. Changing it is Coach's." : risk?.reason}>
          {isOk(risk) ? `${MODES[risk.value.mode]}${risk.value.until_week ? ` until wk ${risk.value.until_week}` : ''}`
            : risk?.status === 'failed' ? 'hidden: failed its check' : NOT_COMPUTED}
        </span>
      </div>
      {nav}
      <span className="wr-sp" />
      {health}
      {onClassic && <button type="button" className="wr-link wr-bar2-classic" data-testid="layout-toggle" onClick={onClassic}>Classic layout</button>}
      <details className="wr-menu">
        <summary aria-label="More">⋯</summary>
        <div className="wr-menu-list">
          <button type="button" onClick={onTheme}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
          <button type="button" onClick={() => onExit('managers')}>Who trades with you</button>
          <button type="button" onClick={() => onExit('proposals')}>Sendable proposals</button>
          {view.preview && <span className="wr-menu-note" title={view.preview_reason}>Preview, unconfirmed</span>}
        </div>
      </details>
    </header>
  );
}
