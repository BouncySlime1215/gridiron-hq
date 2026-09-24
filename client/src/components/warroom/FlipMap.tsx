import type { Field, Flip } from './types';
import { namer, teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, whole } from './format';
import { usePager } from './Panel';

/** `flip_map`: biggest buy-from-A / sell-to-B gaps, in the producer's order (no client sort). */
export default function FlipMap({ field, names, big }: { field: Field<Flip[]> | undefined; names?: Record<string, string>; big: boolean }) {
  const rows = field?.status === 'ok' && field.value ? field.value : [];
  const pg = usePager(rows.length, big ? 9 : 4);
  const n = namer(names);
  const whyNot = (f: Flip) => f.legs_why_not ?? 'no fair legs found';
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
                  <tr key={`${f.player}-${f.buy_from}-${f.sell_to}`}>
                    <td><b>{n.one(f.player).name}</b></td>
                    <td>{teamLabel(f.buy_from)}</td><td>{teamLabel(f.sell_to)}</td>
                    <td className="wr-num"><Val f={f.spread} fmt={pts} showSe /></td>
                    <td className="wr-num"><Val f={f.price_a} fmt={whole} /> vs <Val f={f.price_b} fmt={whole} /></td>
                    <td className="wr-num">{f.legs ? <><Val f={f.legs.p_both} fmt={v => pct(v)} /> · you <Val f={f.legs.nick_after} fmt={pts} /></> : <span className="wr-muted" title={whyNot(f)}>{whyNot(f)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="wr-list">
              {list.slice(pg.a, pg.b).map(f => (
                <li key={`${f.player}-${f.buy_from}-${f.sell_to}`}>
                  <div className="wr-row"><b>{n.one(f.player).name}</b><span className="wr-sp" /><span className="wr-num">gap <Val f={f.spread} fmt={pts} /></span></div>
                  <div className="wr-sub">
                    Buy {teamLabel(f.buy_from)} → sell {teamLabel(f.sell_to)} · {f.legs ? <>both yes <Val f={f.legs.p_both} fmt={v => pct(v)} /></> : <span title={whyNot(f)}>no fair legs yet</span>}
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
