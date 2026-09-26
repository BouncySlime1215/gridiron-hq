import { useCallback, useState } from 'react';
import { Button, Card, Chip, Sheet } from '../ui/DesignSystem';
import { ajAllow, ajConfirm, postWarRoomRequest, type Poster } from './requests';
import { useAjState } from './useWarRoom';
import type { Move, WarRoomView } from './types';
import { isOk } from './format';

/**
 * AJ-PICK (Nick 2026-09-25): A.J. Brown may be traded only for a player Nick picks himself, and each
 * card that gives him needs Nick's own OK before it can be the next move. Everything here is a tap
 * that records a War Room request (source 'nick'); the server holds the rules (never-give.js).
 *   useAjPicks        the league's picks (GET /warroom/:id/aj) and the toggle
 *   AjAllowToggle     "Allow A.J. for him" on a Go get target who is a Blue chip (83+)
 *   AjAllowedChip     "A.J. allowed for: N players" in the Trades context bar, opening the list
 *   AjOkBanner        the deck card's "Needs your OK" banner and its OK button
 */
export const AJ_ID = '277';
export const BLUE_CHIP = 83;

export type AjPicks = ReturnType<typeof useAjPicks>;

export function useAjPicks(leagueId: number | null, post?: Poster) {
  const q = useAjState(leagueId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = q.data?.enabled === true;
  const allow = enabled ? q.data?.allow ?? [] : [];
  const { refetch } = q;
  const toggle = useCallback(async (playerId: string, on: boolean) => {
    if (!leagueId) return;
    setBusy(playerId);
    try {
      await postWarRoomRequest(leagueId, ajAllow(playerId, on), post);
      setError(null);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [leagueId, post, refetch]);
  return { enabled, allow, busy, error, toggle, loading: q.loading };
}

/** Whether A.J. Brown is on Nick's roster in this view (the blue-chip board marks his own players). */
export function ajOnMyRoster(view: WarRoomView): boolean {
  return isOk(view.blue_chips) && view.blue_chips.value.rows.some(r => r.player === AJ_ID && r.mine);
}

/** The target's score on the served board, or null when the board does not score him. */
export function boardScore(view: WarRoomView, player: string): number | null {
  if (!isOk(view.blue_chips)) return null;
  const row = view.blue_chips.value.rows.find(r => r.player === player);
  return row && Number.isFinite(row.score) ? row.score : null;
}

export function AjAllowToggle({ player, name, picks }: { player: string; name: string; picks: AjPicks }) {
  const on = picks.allow.includes(player);
  const saving = picks.busy === player;
  return (
    <span data-testid="aj-allow-toggle" data-on={on ? '1' : '0'}>
      <Chip on={on} tone={on ? 'accent' : 'neutral'} onClick={saving ? undefined : () => { void picks.toggle(player, !on); }}
        title={on ? `A.J. Brown may be traded for ${name} (each card still needs your OK). Tap to stop.` : `Let the planner build trades giving A.J. Brown for ${name}; each needs your OK.`}>
        {saving ? 'Saving…' : on ? 'A.J. allowed for him' : 'Allow A.J. for him'}
      </Chip>
    </span>
  );
}

export function AjAllowedChip({ picks, nameOf }: { picks: AjPicks; nameOf: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  if (!picks.enabled) return null;
  const n = picks.allow.length;
  return (
    <>
      <Chip tone={n ? 'accent' : 'neutral'} onClick={() => setOpen(true)} title="Players you would trade A.J. Brown for">
        A.J. allowed for: {n} player{n === 1 ? '' : 's'}
      </Chip>
      <Sheet open={open} title="A.J. Brown: who you would take" onClose={() => setOpen(false)}>
        <p className="ds-note mb-3">The planner builds trades giving A.J. Brown only for these players, and only while each is a Blue chip (83+).
          Every such card waits for your OK before it can be your next move. Add players from Go get.</p>
        {picks.error && <p className="ds-note mb-3" role="status">Could not save that: {picks.error}</p>}
        {n === 0 ? <p className="ds-note">Nobody yet: A.J. Brown stays off the table.</p> : (
          <ul className="flex flex-col gap-2" data-testid="aj-allowed-list">
            {picks.allow.map(id => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate" title={nameOf(id)}>{nameOf(id)}</span>
                <Button size="sm" disabled={picks.busy === id} onClick={() => { void picks.toggle(id, false); }}
                  aria-label={`Stop allowing A.J. Brown for ${nameOf(id)}`}>{picks.busy === id ? 'Saving…' : 'Remove'}</Button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  );
}

/** A deck card that gives A.J. Brown (or, PROTECTED-UPGRADE, a protected player) and Nick has not OK'd yet. */
export const needsAjOk = (m: Move) => !!m.requires_nick_confirm && !m.nick_confirmed;

export function AjOkBanner({ move, leagueId, forText, post }: { move: Move; leagueId: number; forText: string; post?: Poster }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const ok = () => {
    setState('saving');
    postWarRoomRequest(leagueId, ajConfirm(move.move_id), post)
      .then(() => { setState('saved'); setError(null); })
      .catch(e => { setState('idle'); setError(e instanceof Error ? e.message : String(e)); });
  };
  return (
    <Card tone="warn" className="wr-aj-ok" as="div">
      <div data-testid="aj-ok-banner" role="note">
        <b>{move.protected_label ? `Needs your OK: ${move.protected_label}, for ${forText}` : `Needs your OK: gives A.J. Brown for ${forText}`}</b>
        <p className="ds-note">Only you can OK this card; Coach can explain it but not approve it. Until you do, it is never your next move.</p>
        {state === 'saved'
          ? <p className="ds-note" role="status" data-testid="aj-ok-saved">OK saved. The planner can make this your next move after its next run.</p>
          : <div className="mt-2"><Button variant="primary" size="sm" disabled={state === 'saving'} onClick={ok} data-testid="aj-ok-button">
            {state === 'saving' ? 'Saving…' : 'OK'}</Button></div>}
        {error && <p className="ds-note" role="status">Could not save your OK: {error}</p>}
      </div>
    </Card>
  );
}
