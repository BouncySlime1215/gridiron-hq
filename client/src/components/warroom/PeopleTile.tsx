import type { ReactNode } from 'react';
import type { CloneWant, CloneWord } from './types';
import type { PersonTile } from './PeopleBoard';
import { Val } from './FieldState';
import { pct } from './format';
import { WORD_LABEL } from './CloneBoard';

/**
 * PEOPLE-BOARD: one manager's tile in the rail. The whole tile is one button: tapping it
 * opens his clone panel. It formats what the tile carries and computes nothing; an
 * unknown slot reads "not computed yet" (its reason on hover, and inline when big),
 * never 0. A greyed tile says Nick's reason on its face.
 */
const ago = (days: number) => (days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`);
const wantText = (w: CloneWant) =>
  `wants ${w.player.name}${w.player.pos ? ` (${w.player.pos})` : ''} · ${ago(w.age_days)}${w.state === 'fading' ? ' · fading' : ''}${w.you_have ? ' · you have him' : ''}`;
const wordText = (w: CloneWord) => `${WORD_LABEL[w.label]}${w.from === 'record' ? ` (${w.held ?? 0} of ${w.n} held)` : ' (profile)'}`;
const budgetText = (v: { used: number; limit: number | null }) =>
  (v.limit == null ? `${v.used} offer${v.used === 1 ? '' : 's'} this week (no weekly limit set)` : `${v.used} of ${v.limit} offers this week`);

function Slot({ name, children }: { name: string; children: ReactNode }) {
  return <span className="wr-person-slot"><span className="wr-l">{name}</span> {children}</span>;
}

export default function PeopleTile({ tile: t, big, onOpen }: { tile: PersonTile; big: boolean; onOpen: (team: string) => void }) {
  const wants = t.wants.status === 'ok' ? t.wants.value ?? [] : null;
  return (
    <button type="button" className={`wr-person${t.grey ? ' wr-person-grey' : ''}`} data-team={t.team} data-grey={t.grey ? 'true' : 'false'}
      aria-label={`${t.label}: open his clone panel`} onClick={() => onOpen(t.team)}>
      <span className="wr-row">
        <b>{t.label}</b>
        {t.grey && <span className="wr-pill wr-pill-warn">left out</span>}
        {t.checked_out && <span className="wr-pill wr-pill-warn">checked out</span>}
        <span className="wr-sp" />
        <span className="wr-num" title={t.p_responds.status === 'ok' ? `Chance he responds: ${t.p_responds.value?.basis}` : t.p_responds.reason}>
          <Val f={t.p_responds} fmt={v => `${pct(v.p)} respond`} />
        </span>
      </span>
      {t.grey && <span className="wr-sub wr-person-why">{t.grey}</span>}

      <Slot name="In market">
        {wants && wants.length > 0
          ? wants.slice(0, big ? 3 : 1).map(w => (
            <span key={w.player.id} className={`wr-pill${w.state === 'fresh' ? ' wr-pill-run' : ''}`}
              title="From his chat profile. Strong for 7 days, fades by day 21.">{wantText(w)}</span>
          ))
          : wants ? <span className="wr-muted">no player named in the last 21 days</span>
            : <Val f={t.wants} fmt={() => ''} showReason={big} />}
        {t.holes.length > 0 && <span className="wr-muted"> · needs {t.holes.join(', ')}</span>}
      </Slot>
      <Slot name="His word"><Val f={t.credibility} fmt={wordText} showReason={big} /></Slot>
      <Slot name="Mood"><Val f={t.mood} fmt={v => `${v} (chat tone)`} showReason={big} /></Slot>
      <Slot name="Budget"><Val f={t.fatigue} fmt={budgetText} showReason={big} /></Slot>
      <Slot name="Last contact"><Val f={t.last_contact} fmt={v => v} showReason={big} /></Slot>
      <Slot name="Approach"><Val f={t.approach} fmt={v => v} showReason={big} /></Slot>
      {big && t.p_responds.status === 'ok' && <span className="wr-hint">Responds: {t.p_responds.value?.basis}</span>}
    </button>
  );
}
