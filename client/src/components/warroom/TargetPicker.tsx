import { useState } from 'react';
import type { Field, HiddenTarget, Target } from './types';
import { namer, teamLabel } from './types';
import { targetApprove, type WarRoomRequest } from './requests';
import { FieldBlock, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

/** The plan's untouchable mark on a target row (batch 4): true, an ok Field, or { label }. */
export function isUntouchable(t: Target): boolean {
  const m = t.untouchable;
  if (m === true) return true;
  if (m && typeof m === 'object') return 'status' in m ? m.status === 'ok' && !!m.value : true;
  return false;
}

const FIT: Record<string, string> = { fits: 'fits your mode', needs_all_in: 'needs all-in', too_risky_for_safe: 'too risky for safe' };

/**
 * `targets`: the producer's suggested targets. Approve writes one `target.approve`
 * request; the producer's next run plans toward it. Choosing your own is Coach's (FIX-06).
 */
export default function TargetPicker({ field, names, big, onRequest }: {
  field: (Field<Target[]> & { hidden_untouchable?: HiddenTarget[] }) | undefined; names?: Record<string, string>; big: boolean;
  onRequest?: (req: WarRoomRequest) => Promise<unknown>;
}) {
  // Audit defect 8: a player the plan marks untouchable on his roster is never a target
  // (the view drops them; this is the belt to that brace) and the panel says how many.
  const rows = field?.status === 'ok' && field.value ? field.value.filter(t => !isUntouchable(t)) : [];
  const hiddenUt = field?.status === 'ok' ? [
    ...(field.hidden_untouchable ?? []),
    ...(field.value ?? []).filter(isUntouchable).map(t => ({ player: t.player, owner: t.owner, label: t.untouchable_label ?? 'on his untouchable list' })),
  ] : [];
  const pg = usePager(rows.length, big ? 8 : 3);
  const n = namer(names);
  const [asked, setAsked] = useState<Record<string, 'saving' | 'saved'>>({});
  const [error, setError] = useState<string | null>(null);
  const approve = (player: string) => {
    if (!onRequest) return;
    setAsked(a => ({ ...a, [player]: 'saving' }));
    onRequest(targetApprove(player))
      .then(() => { setAsked(a => ({ ...a, [player]: 'saved' })); setError(null); })
      .catch(e => {
        setAsked(a => { const { [player]: _drop, ...rest } = a; return rest; });
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return (
    <FieldBlock f={field} label="Suggested targets">
      {() => (
        <>
          <div className="wr-row wr-sub"><span className="wr-sp" />{pg.control}</div>
          <table className="wr-table">
            <thead><tr><th style={{ width: '34%' }}>Player</th><th>If landed</th><th>Reachable</th>{big && <th>Owner</th>}{big && <th>Mode</th>}<th style={{ width: 84 }} /></tr></thead>
            <tbody>
              {rows.slice(pg.a, pg.b).map(t => (
                <tr key={t.player} title={t.why.status === 'ok' ? t.why.value : t.why.reason}>
                  <td><b>{n.one(t.player).name}</b></td>
                  <td className="wr-num"><Val f={t.gain_if_landed} fmt={pts} /></td>
                  <td className="wr-num"><Val f={t.p_reach} fmt={v => pct(v)} /></td>
                  {big && <td>{teamLabel(t.owner)}</td>}
                  {big && <td><Val f={t.mode_fit} fmt={v => FIT[v] ?? v} /></td>}
                  <td>{t.is_plan_target ? <span className="wr-pill wr-pill-next">in the plan</span>
                    : t.approved || asked[t.player] === 'saved' ? <span className="wr-pill">approved</span>
                    : <button type="button" className="wr-btn wr-sm" disabled={!onRequest || asked[t.player] === 'saving'}
                        onClick={() => approve(t.player)}>Approve</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenUt.length > 0 && (
            <div className="wr-hint" data-testid="targets-untouchable" title={hiddenUt.map(h => `${n.one(h.player).name}: ${h.label}`).join('\n')}>
              {hiddenUt.length} hidden: {hiddenUt.map(h => `${n.one(h.player).name} (${teamLabel(h.owner)}, ${h.label})`).join('; ')}
            </div>
          )}
          {error && <div className="wr-hint wr-red" role="status">Could not save the approval: {error}</div>}
          <div className="wr-row"><button type="button" className="wr-btn wr-sm" disabled title="Choosing your own is Coach's (FIX-06)">Choose my own</button></div>
        </>
      )}
    </FieldBlock>
  );
}
