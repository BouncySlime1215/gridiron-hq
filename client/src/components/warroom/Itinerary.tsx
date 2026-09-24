import type { Field, Itinerary as It } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

/** Stops in order (get X, flip Y, ...). Adding a stop is WR-3 / WR-COACH. */
export default function Itinerary({ field, big }: { field: Field<It> | undefined; big: boolean }) {
  const stops = field?.status === 'ok' && field.value ? field.value.stops : [];
  const pg = usePager(stops.length, big ? 7 : 4);
  return (
    <FieldBlock f={field} label="Stops">
      {it => (
        <>
          <div className="wr-row wr-sub">
            {it.target ? <span><b className="wr-ink">Target:</b> {it.target.name}</span> : <span>No target yet.</span>}
            <span className="wr-sp" />{pg.control}
          </div>
          <ol className="wr-list wr-stops">
            {it.stops.slice(pg.a, pg.b).map(s => (
              <li key={s.id} className={s.status === 'next' ? 'wr-next' : undefined}>
                <span className="wr-n">{s.order}</span>
                <span className="wr-lab">
                  <b>{s.label}</b>
                  <br />
                  <span className="wr-sub">
                    chance <Val f={s.p_yes} fmt={v => pct(v)} /> · you after <Val f={s.odds_after} fmt={pts} />
                  </span>
                </span>
                <span className={`wr-pill${s.status === 'next' ? ' wr-pill-next' : ''}`}>{s.status}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="wr-btn wr-sm" disabled title="Adding stops turns on with the engine request queue (WR-3)">+ Add a stop</button>
        </>
      )}
    </FieldBlock>
  );
}
