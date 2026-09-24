import { useContext } from 'react';
import type { CloneRow, CloneWant, CloneWord, ClonesView, Field, Partner, WarRoomView } from './types';
import { teamLabel } from './types';
import { FieldBlock, SourcesContext } from './FieldState';
import { isOk } from './format';
import { usePager } from './Panel';
import PeopleTile from './PeopleTile';

/**
 * PEOPLE-BOARD: the War Room's right rail (WAR-ROOM-UI.md v3). One tile per league-mate:
 * mood, in-market (what he said he wants, how long ago, and whether his talk holds),
 * P(responds), fatigue budget, last contact, the approach to take. Unreachable and
 * non-buyer managers are greyed with Nick's reason and sit last. Tap a tile -> his clone
 * panel (UI-ENG-4).
 *
 * Two reads, joined by roster id and nothing computed: the plans contract's `partners`
 * section (P(responds), offers this week, chat labels, roster holes, blocked) and the
 * clone rows (warroom-clones.js over people/profile-reader.js: Nick's word, wants,
 * credibility, profile labels). A slot neither read fills is 'unknown' with its reason.
 */
export interface PersonTile {
  team: string;
  label: string;
  /** Why this tile is greyed (Nick's word, or the plan's "never trading"); null when live. */
  grey: string | null;
  checked_out: boolean;
  mood: Field<string>;
  wants: Field<CloneWant[]>;
  credibility: Field<CloneWord>;
  holes: string[];
  p_responds: Field<{ p: number; basis: string }>;
  fatigue: Field<{ used: number; limit: number | null }>;
  last_contact: Field<string>;
  approach: Field<string>;
}

/** Sources the rail adds to the view's own (labels for the source tag). */
export const PEOPLE_SOURCES: Record<string, { label: string; calibrated: boolean }> = {
  'chat.labels': { label: 'Chat labels (no text)', calibrated: false },
  'campaign.plan': { label: 'Campaign plan', calibrated: false },
};

const unknown = <T,>(reason: string, source: string): Field<T> => ({ status: 'unknown', reason, source });
const ok = <T,>(value: T, source: string, guess = false): Field<T> => ({ status: 'ok', value, source, ...(guess ? { guess } : {}) });
const why = (f: Field<unknown> | undefined, what: string) =>
  f?.reason ?? (f?.status === 'failed' ? `${what} failed its check.` : `${what} not loaded yet.`);

export const LAST_CONTACT_REASON =
  'No contact log reaches the War Room yet (offers and replies are not logged per manager with a date), so last contact is not known.';

/** Profile labels that say how to pitch him, best first: his style, then how his no behaves, then his posture. */
const APPROACH_KEYS = ['style', 'no_holds', 'posture'];

function approachOf(row: CloneRow | undefined, rowsWhy: string): Field<string> {
  if (!row) return unknown(`No profile read: ${rowsWhy}`, 'people.profile');
  if (!isOk(row.profile)) return unknown(row.profile.reason ?? 'No profile read.', 'people.profile');
  const traits = row.profile.value.traits;
  for (const k of APPROACH_KEYS) {
    const t = traits.find(x => x.key === k);
    if (t) return ok(t.label, t.source, true);
  }
  return unknown('His profile has no approach label (no style, no-holds or posture read).', 'people.profile');
}

function moodOf(p: Partner | undefined): Field<string> {
  const tone = p?.chat_labels?.find(l => l.startsWith('tone:'));
  if (tone) return ok(tone.slice('tone:'.length), 'chat.labels', true);
  return unknown('No mood read: no chat tone label for him this run, and the mood clock (tilt after a loss, lift after a win) is not built.', 'chat.labels');
}

function greyOf(row: CloneRow | undefined, p: Partner | undefined): string | null {
  if (row && (row.standing === 'excluded' || row.standing === 'deprioritised')) {
    return row.nick.length ? row.nick.join(' · ') : 'Nick: left out';
  }
  if (p?.blocked) return p.basis;
  return null;
}

/** The join. Producer order (partners first, then clone-only rows), greyed tiles last. */
export function peopleTiles(view: WarRoomView, clones: ClonesView | null | undefined): PersonTile[] {
  const me = view.me == null ? null : String(view.me);
  const partnersF = view.partners;
  const partners = isOk(partnersF) ? partnersF.value : [];
  const partnersWhy = why(partnersF as Field<unknown> | undefined, 'The partner read');
  const rowsF = clones?.clones;
  const rows = isOk(rowsF) ? rowsF.value : [];
  const rowsWhy = clones ? why(rowsF as Field<unknown> | undefined, 'Clone reads') : 'clone reads loading.';

  const pBy = new Map(partners.map(p => [String(p.team), p]));
  const rBy = new Map(rows.map(r => [String(r.team), r]));
  const order = [...new Set([...partners.map(p => String(p.team)), ...rows.map(r => String(r.team))])]
    .filter(t => t !== me);

  const d = isOk(view.destination) ? view.destination.value : undefined;
  const tol = isOk(d?.tolerances) ? d.tolerances.value : undefined;
  const limit = tol && Number.isInteger(tol.max_offers_per_manager_week) ? tol.max_offers_per_manager_week : null;

  const tiles = order.map((team): PersonTile => {
    const p = pBy.get(team);
    const r = rBy.get(team);
    const pNone = isOk(partnersF) ? 'The planner did not score him as a partner this run.' : partnersWhy;
    return {
      team,
      label: r?.label ?? teamLabel(team),
      grey: greyOf(r, p),
      checked_out: p?.checked_out === true,
      mood: p ? moodOf(p) : unknown(`No mood read: ${pNone}`, 'chat.labels'),
      wants: r ? r.wants : unknown(`No read of what he wants: ${rowsWhy}`, 'people.profile'),
      credibility: r ? r.credibility : unknown(`No read of his word: ${rowsWhy}`, 'people.word'),
      holes: p?.roster_holes ?? [],
      p_responds: p ? ok({ p: p.p_responds, basis: p.basis }, 'campaign.plan', true) : unknown(pNone, 'campaign.plan'),
      fatigue: p && Number.isInteger(p.offers_logged)
        ? ok({ used: p.offers_logged as number, limit }, 'campaign.plan')
        : unknown(p ? 'No offers log for him this week, so the budget left is not known.' : pNone, 'campaign.plan'),
      last_contact: unknown(LAST_CONTACT_REASON, 'campaign.plan'),
      approach: approachOf(r, rowsWhy),
    };
  });
  return [...tiles.filter(t => !t.grey), ...tiles.filter(t => t.grey)];
}

export default function PeopleBoard({ view, clones, big, onOpen }: {
  view: WarRoomView; clones: ClonesView | null | undefined; big: boolean; onOpen: (team: string) => void;
}) {
  const tiles = peopleTiles(view, clones);
  const pg = usePager(tiles.length, big ? 6 : 4);
  const outer = useContext(SourcesContext);
  const failed = clones?.clones?.status === 'failed' ? clones.clones : null;
  // Nothing to show at all: say why (partners unknown and no clone rows).
  const empty: Field<PersonTile[]> = tiles.length ? ok(tiles, 'campaign.plan')
    : unknown(`No managers to show. ${why(view.partners as Field<unknown> | undefined, 'The partner read')} ${clones ? why(clones.clones as Field<unknown> | undefined, 'Clone reads') : ''}`.trim(), 'campaign.plan');
  return (
    <SourcesContext.Provider value={{ ...outer, ...PEOPLE_SOURCES, ...(clones?.sources ?? {}) }}>
      <FieldBlock f={empty} label="People board">
        {list => (
          <>
            <div className="wr-row wr-sub">
              <span>Who to work this week · tap for his clone</span>
              <span className="wr-sp" />{pg.control}
            </div>
            {!clones && <div className="wr-hint" role="status">Clone reads loading: wants, credibility and approach fill in when they land.</div>}
            {failed && <div className="wr-hint wr-fail" role="status">Clone reads failed: {failed.reason}</div>}
            {clones?.banner && <div className="wr-hint">{clones.banner}</div>}
            <ul className="wr-people">
              {list.slice(pg.a, pg.b).map(t => <li key={t.team}><PeopleTile tile={t} big={big} onOpen={onOpen} /></li>)}
            </ul>
          </>
        )}
      </FieldBlock>
    </SourcesContext.Provider>
  );
}
