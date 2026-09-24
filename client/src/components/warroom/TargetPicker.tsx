import type { Field, Target } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

/** Suggested targets. Approve / choose your own are WR-3 (they write an objective request). */
export default function TargetPicker({ field, big }: { field: Field<Target[]> | undefined; big: boolean }) {
  const rows = field?.status === 'ok' && field.value ? field.value : [];
  const pg = usePager(rows.length, big ? 8 : 3);
  return (
    <FieldBlock f={field} label="Suggested targets">
      {list => (
        <>
          <div className="wr-row wr-sub"><span className="wr-sp" />{pg.control}</div>
          <table className="wr-table">
            <thead><tr><th style={{ width: '34%' }}>Player</th><th>If landed</th><th>Reachable</th>{big && <th>Owner</th>}<th style={{ width: 84 }} /></tr></thead>
            <tbody>
              {list.slice(pg.a, pg.b).map(t => (
                <tr key={t.player.id}>
                  <td><b>{t.player.name}</b></td>
                  <td className="wr-num"><Val f={t.gain_if_landed} fmt={pts} /></td>
                  <td className="wr-num"><Val f={t.p_reach} fmt={v => pct(v)} /></td>
                  {big && <td><Val f={t.owner} fmt={v => v} /></td>}
                  <td>{t.is_plan_target ? <span className="wr-pill wr-pill-next">in the plan</span>
                    : <button type="button" className="wr-btn wr-sm" disabled title="Approving turns on with the engine request queue (WR-3)">Approve</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="wr-row"><button type="button" className="wr-btn wr-sm" disabled title="Choosing your own turns on with the engine request queue (WR-3)">Choose my own</button></div>
        </>
      )}
    </FieldBlock>
  );
}
