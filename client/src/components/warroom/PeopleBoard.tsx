import type { ReactNode } from 'react';
import type { Field, Move, PersonTile, PersonWord, WarRoomView } from './types';
import { teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { isOk, pct } from './format';
import { usePager } from './Panel';

/**
 * PEOPLE-BOARD: the War Room's right rail (WAR-ROOM-UI.md v3). One tile per league-mate,
 * served whole by war-room-view.js#buildPeopleBoard (`view.people`): P(responds) and the
 * fatigue budget from the plan's partners, Nick's notes over the models (can't reach him
 * = never a partner, last; not a buyer = goes last; hard negotiator flagged), mood and
 * in-market from the chat pulse, his word from the follow-through record, the approach
 * from his profile labels. This file formats and computes nothing; an unknown slot reads
 * "not computed yet" with its reason, never 0.
 *
 * Tap a tile -> the Next move deck shows only the plan's moves with him (focusView).
 */

const WORD_TEXT: Record<PersonWord['status'], string> = {
  proven: 'follows through', manager_split: 'mixed record', noise: 'talk does not predict his moves',
};
const wordText = (w: { wants: PersonWord | null; shop: PersonWord | null }) => [
  w.wants ? `wants: ${WORD_TEXT[w.wants.status]}${w.wants.weight != null && w.wants.status === 'proven' ? ` (x${Math.round(w.wants.weight)})` : ''}, ${w.wants.n} said` : null,
  w.shop ? `shop talk: ${WORD_TEXT[w.shop.status]}, ${w.shop.n} said` : null,
].filter(Boolean).join(' · ');
export const budgetText = (v: { used: number; limit: number | null }) =>
  (v.limit == null ? `${v.used} offer${v.used === 1 ? '' : 's'} this week (no weekly limit set)` : (v.used > v.limit ? `${v.used} offers this week, over your ${v.limit}-a-week limit` : `${v.used} of ${v.limit} offers this week`));

/** The deck's view with only the moves that have a step with `team` (a People Board tap). */
export function focusView(view: WarRoomView, team: string): WarRoomView {
  const alts = view.alternatives;
  if (!isOk(alts)) return view;
  const withHim = (m: Move) => (m.steps ?? []).some(s => String(s.partner) === team);
  return { ...view, alternatives: { ...alts, value: alts.value.filter(withHim) } };
}

/** The strip above the focused deck: whose moves these are, and the way back to all of them. */
export function DeckFocusBar({ view, team, onClear }: { view: WarRoomView; team: string; onClear: () => void }) {
  const n = isOk(view.alternatives) ? view.alternatives.value.filter(m => (m.steps ?? []).some(s => String(s.partner) === team)).length : 0;
  return (
    <div className="wr-row wr-sub" role="status" data-testid="deck-focus">
      <span>Moves with {teamLabel(team)}: {n}</span>
      <span className="wr-sp" />
      <button type="button" className="wr-xp" onClick={onClear}>All moves</button>
    </div>
  );
}

function Slot({ name, children }: { name: string; children: ReactNode }) {
  return <span className="wr-person-slot"><span className="wr-l">{name}</span> {children}</span>;
}

function Tile({ t, big, focused, onFocus, tapLabel }: { t: PersonTile; big: boolean; focused: boolean; onFocus: (team: string) => void; tapLabel: string }) {
  const grey = t.standing !== 'live';
  const market = isOk(t.in_market) ? t.in_market.value : null;
  return (
    <button type="button" className={`wr-person${grey ? ' wr-person-grey' : ''}`} data-team={t.team} data-standing={t.standing}
      aria-pressed={focused} aria-label={`${t.label}: ${tapLabel}`} onClick={() => onFocus(t.team)}>
      <span className="wr-row">
        <b>{t.label}</b>
        {t.standing === 'never' && <span className="wr-pill wr-pill-warn">never a partner</span>}
        {t.standing === 'last' && <span className="wr-pill wr-pill-warn">goes last</span>}
        {t.nick.hard && <span className="wr-pill wr-pill-warn">hard negotiator</span>}
        {t.checked_out && <span className="wr-pill wr-pill-warn">checked out</span>}
        <span className="wr-sp" />
        <span className="wr-num" title={t.p_responds.status === 'ok' ? `Chance he responds: ${t.p_responds.value?.basis}` : t.p_responds.reason}>
          <Val f={t.p_responds} fmt={v => `${pct(v.p)} respond`} />
        </span>
      </span>
      {t.nick.said.length > 0 && <span className="wr-sub wr-person-why" data-testid="nick-said">{t.nick.said.join(' · ')}</span>}
      <Slot name="Budget"><Val f={t.fatigue} fmt={budgetText} showReason={big} /></Slot>
      <Slot name="In market">
        {market
          ? market.said.map((s, i) => (
            <span key={i} className={`wr-pill${s.credible && !s.fading ? ' wr-pill-run' : ''}`}
              title={s.credible ? 'His kind of talk that turns into moves' : 'Said, not yet shown to turn into moves'}>
              {s.text} · {s.ago}{s.fading ? ' · fading' : ''}
            </span>
          ))
          : <Val f={t.in_market} fmt={() => ''} showReason={big} />}
      </Slot>
      <Slot name="His word"><Val f={t.word} fmt={wordText} showReason={big} /></Slot>
      <Slot name="Mood"><Val f={t.mood} fmt={v => v} showReason={big} /></Slot>
      <Slot name="Approach"><Val f={t.approach} fmt={v => v} showReason={big} /></Slot>
      <Slot name="Last contact"><Val f={t.last_contact} fmt={v => v} showReason={big} /></Slot>
      <span className="wr-hint">{t.moves_n ? `${t.moves_n} move${t.moves_n === 1 ? '' : 's'} with him in the plan` : 'No move with him in the plan'}</span>
    </button>
  );
}

export default function PeopleBoard({ view, big, focus, onFocus, hint = 'Who to work this week · tap for his moves', tapLabel = 'show the moves with him', pageSize }: {
  view: WarRoomView; big: boolean; focus: string | null; onFocus: (team: string) => void;
  /** WAR-ROOM-UI v2 (League screen): its own hint, tap label and page size. */
  hint?: string; tapLabel?: string; pageSize?: number;
}) {
  const field: Field<PersonTile[]> = view.people ?? { status: 'unknown', source: 'campaign.plan', reason: 'The people board has not loaded.' };
  const list = isOk(field) ? field.value : [];
  const pg = usePager(list.length, pageSize ?? (big ? 6 : 4));
  return (
    <FieldBlock f={field} label="People board">
      {tiles => (
        <>
          <div className="wr-row wr-sub">
            <span>{hint}</span>
            <span className="wr-sp" />{pg.control}
          </div>
          <ul className="wr-people">
            {tiles.slice(pg.a, pg.b).map(t => (
              <li key={t.team}><Tile t={t} big={big} focused={focus === t.team} onFocus={onFocus} tapLabel={tapLabel} /></li>
            ))}
          </ul>
        </>
      )}
    </FieldBlock>
  );
}
