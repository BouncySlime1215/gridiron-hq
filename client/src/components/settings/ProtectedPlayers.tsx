import { useState } from 'react';
import { Card, Chip } from '../ui/DesignSystem';
import { useLeague } from '../../state/league';
import { useProtectState } from '../warroom/useWarRoom';
import { postWarRoomRequest, protectMode, type ProtectMode } from '../warroom/requests';

/**
 * PROTECTED-UPGRADE (Nick 2026-09-26): Settings > Trade rules. One row per protected player in the
 * active league, with two modes:
 *   Locked           never offered (the rule before this setting);
 *   Blue chips only  offered only for a Blue chip whose score and market value both beat him, when the
 *                    trade raises playoff odds and lineup points; every such card still needs your OK.
 * A tap records a War Room request (protect.mode, Nick's own); the server holds the rule (never-give.js).
 */
export default function ProtectedPlayers() {
  const { activeId } = useLeague();
  const q = useProtectState(activeId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = async (player: string, mode: ProtectMode) => {
    if (!activeId) return;
    setBusy(player);
    try {
      await postWarRoomRequest(activeId, protectMode(player, mode));
      setError(null);
      q.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const players = q.data?.enabled ? q.data.players ?? [] : [];
  const modes = q.data?.modes ?? [];
  return (
    <Card className="!p-4"><div data-testid="protected-players">
      <h2 className="ds-h mb-1">Protected players</h2>
      <p className="ds-note mb-3">
        Locked: never offered. Blue chips only: offered only for a Blue chip whose score and market value both beat him,
        when the trade raises your playoff odds and lineup points and gives no more value than it gets. Every such trade still waits for your OK.
      </p>
      {q.loading && !q.data ? <p className="ds-note">Loading…</p>
        : !q.data?.enabled ? <p className="ds-note">The trade planner is off, so there is nothing to set.</p>
          : (
            <ul className="flex flex-col gap-3" data-testid="protected-list">
              {players.map(p => (
                <li key={p.player} className="flex flex-wrap items-center justify-between gap-2" data-testid="protected-row" data-mode={p.mode}>
                  <span className="min-w-0 font-semibold">{p.name ?? 'Protected player'}</span>
                  <span className="flex flex-wrap gap-2" role="group" aria-label={`Setting for ${p.name ?? 'this player'}`}>
                    {modes.map(m => (
                      <Chip key={m.mode} on={p.mode === m.mode} tone={p.mode === m.mode ? 'accent' : 'neutral'}
                        onClick={busy || p.mode === m.mode ? undefined : () => { void set(p.player, m.mode); }}>
                        {busy === p.player && p.mode !== m.mode ? 'Saving…' : m.label}
                      </Chip>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
      {error && <p className="ds-note mt-2" role="status">Could not save that: {error}</p>}
      <p className="ds-note mt-3">For the league you have open. The planner picks up a change on its next run, usually a few minutes.</p>
    </div></Card>
  );
}
