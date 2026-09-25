import { useRef, type ReactNode } from 'react';
import type { Destination, WarRoomView } from './types';
import { Val } from './FieldState';
import { pct, NOT_COMPUTED, isOk } from './format';
import { railOrder, TARGET_LEAGUE_ID, type LeagueChoice } from './LeagueRail';
import Icon from './icons';

import { MODE_LABEL as MODES } from './NoMoveHero';

/** The page explainer the app mounts on every page; inside the War Room it lives in this menu only. */
const EXPLAINER = 'button[aria-label="What am I looking at?"], button[aria-label="Close page explainer"]';

/**
 * WAR-ROOM-UI v2 top bar: the league (one select, target league first, never cut mid-word),
 * title odds and the risk mode, the four-screen switcher (desktop), health, Coach, and a
 * small menu (theme, the other Trade Brain tabs, the page explainer, Classic layout).
 */
export default function TopBarV2({ view, leagues, activeId, onLeague, onExit, theme, onTheme, onClassic, nav, health, coach }: {
  view: WarRoomView; leagues: LeagueChoice[]; activeId: number; onLeague: (id: number) => void;
  onExit: (tab: 'managers' | 'proposals') => void; theme: 'light' | 'dark'; onTheme: () => void; onClassic?: () => void;
  /** The four-screen switcher (desktop; the phone gets the bottom tab bar). */
  nav?: ReactNode;
  /** The health chip (opens the brain report sheet). */
  health?: ReactNode;
  /** The Coach button (desktop; the phone gets a Coach tab). */
  coach?: ReactNode;
}) {
  const d = isOk(view.destination) ? view.destination.value : undefined;
  // A destination that is itself failed/unknown shows ITS state (and reason) in each fact, as the classic strip does.
  const titleNow = (d ? d.title_now : view.destination) as Destination['title_now'] | undefined;
  const risk = (d ? d.risk_mode : view.destination) as Destination['risk_mode'] | undefined;
  const { target, training } = railOrder(leagues, TARGET_LEAGUE_ID);
  const name = (l: LeagueChoice) => (l.name ?? `League ${l.id}`).trim();
  const current = leagues.find(l => l.id === activeId) ?? null;
  const dd = useRef<HTMLDetailsElement | null>(null);
  const pick = (l: LeagueChoice, note?: string) => (
    <button key={l.id} type="button" role="option" aria-selected={l.id === activeId} data-league={l.id} title={name(l)}
      className={l.id === activeId ? 'wr-on' : undefined}
      onClick={() => { if (dd.current) dd.current.open = false; onLeague(l.id); }}>
      <span className="wr-league-n">{name(l)}</span>{note && <span className="wr-muted"> · {note}</span>}
    </button>
  );
  const explain = () => { (document.querySelector(EXPLAINER) as HTMLButtonElement | null)?.click(); };
  return (
    <header className="wr-bar2" aria-label="War Room summary">
      <div className="wr-bar2-brand">War Room</div>
      <details className="wr-league-dd" ref={dd} data-testid="league-picker">
        <summary title={current ? name(current) : undefined} aria-label="Pick a league">
          <span className="wr-league-cur">{current ? name(current) : 'League'}</span><Icon name="down" size={14} className="wr-league-chev" />
        </summary>
        <div className="wr-menu-list wr-league-list" role="listbox" aria-label="Leagues">
          {target && pick(target, 'target')}
          {training.length > 0 && <span className="wr-menu-note">Training leagues</span>}
          {training.map(l => pick(l))}
        </div>
      </details>
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
      {coach}
      <details className="wr-menu">
        <summary aria-label="More"><Icon name="more" size={18} /></summary>
        <div className="wr-menu-list">
          <button type="button" onClick={onTheme}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
          <button type="button" onClick={explain}>What am I looking at?</button>
          <button type="button" onClick={() => onExit('managers')}>Who trades with you</button>
          <button type="button" onClick={() => onExit('proposals')}>Sendable proposals</button>
          {onClassic && <button type="button" data-testid="layout-toggle" onClick={onClassic}>Classic layout</button>}
          {view.preview && <span className="wr-menu-note" title={view.preview_reason}>Preview, unconfirmed</span>}
        </div>
      </details>
    </header>
  );
}
