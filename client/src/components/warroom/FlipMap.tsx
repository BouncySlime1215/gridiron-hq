import type { Field, Flip } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, whole } from './format';
import { usePager } from './Panel';

/** Biggest buy-from-A / sell-to-B gaps, in the producer's order (no client sort). */
export default function FlipMap({ field, big }: { field: Field<Flip[]> | undefined; big: boolean }) {
  const rows = field?.status === 'ok' && field.value ? field.value : [];
  const pg = usePager(rows.length, big ? 9 : 4);
  return (
    <FieldBlock f={field} label="Flip map">
      {list => !list.length ? <div className="wr-empty">No flips found in this run.</div> : (
        <>
          <div className="wr-row wr-sub">
            {big && <span>Buy low from one manager, sell high to another. Gap is in title-odds points.</span>}
            <span className="wr-sp" />{pg.control}
          </div>
          {big ? (
            <table className="wr-table">
              <thead><tr><th style={{ width: '24%' }}>Player</th><th>Buy from</th><th>Sell to</th><th>Gap</th><th>Prices</th><th>Both say yes</th></tr></thead>
              <tbody>
                {list.slice(pg.a, pg.b).map(f => (
                  <tr key={`${f.player.id}-${f.buy_from}-${f.sell_to}`}>
                    <td><b>{f.player.name}</b></td>
                    <td>{f.buy_from}</td><td>{f.sell_to}</td>
                    <td className="wr-num"><Val f={f.spread} fmt={pts} showSe /></td>
                    <td className="wr-num"><Val f={f.price_a} fmt={whole} /> vs <Val f={f.price_b} fmt={whole} /></td>
                    <td className="wr-num">{f.legs ? <Val f={f.legs.p_both} fmt={v => pct(v)} /> : <span className="wr-muted" title={f.legs_why_not ?? ''}>{f.legs_why_not}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="wr-list">
              {list.slice(pg.a, pg.b).map(f => (
                <li key={`${f.player.id}-${f.buy_from}-${f.sell_to}`}>
                  <div className="wr-row"><b>{f.player.name}</b><span className="wr-sp" /><span className="wr-num">gap <Val f={f.spread} fmt={pts} /></span></div>
                  <div className="wr-sub">
                    Buy {f.buy_from} → sell {f.sell_to} · {f.legs ? <>both yes <Val f={f.legs.p_both} fmt={v => pct(v)} /></> : <span title={f.legs_why_not ?? ''}>no fair legs yet</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FieldBlock>
  );
}
