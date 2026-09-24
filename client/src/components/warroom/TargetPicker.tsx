import { useState } from 'react';
import type { Field, Target } from './types';
import { namer, teamLabel } from './types';
import { targetApprove, type WarRoomRequest } from './requests';
import { FieldBlock, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

const FIT: Record<string, string> = { fits: 'fits your mode', needs_all_in: 'needs all-in', too_risky_for_safe: 'too risky for safe' };

/**
 * `targets`: the producer's suggested targets. Approve writes one `target.approve`
 * request; the producer's next run plans toward it. Choosing your own is Coach's (FIX-06).
 */
export default function TargetPicker({ field, names, big, onRequest }: {
  field: Field<Target[]> | undefined; names?: Record<string, string>; big: boolean;
  onRequest?: (req: WarRoomRequest) => Promise<unknown>;
}) {
  const rows = field?.status === 'ok' && field.value ? field.value : [];
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
      {list => (
        <>
          <div className="wr-row wr-sub"><span className="wr-sp" />{pg.control}</div>
          <table className="wr-table">
            <thead><tr><th style={{ width: '34%' }}>Player</th><th>If landed</th><th>Reachable</th>{big && <th>Owner</th>}{big && <th>Mode</th>}<th style={{ width: 84 }} /></tr></thead>
            <tbody>
              {list.slice(pg.a, pg.b).map(t => (
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
          {error && <div className="wr-hint wr-red" role="status">Could not save the approval: {error}</div>}
          <div className="wr-row"><button type="button" className="wr-btn wr-sm" disabled title="Choosing your own is Coach's (FIX-06)">Choose my own</button></div>
        </>
      )}
    </FieldBlock>
  );
}
