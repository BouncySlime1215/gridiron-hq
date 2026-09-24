import type { Field, Itinerary as It } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

/** Stops in order (get X, flip Y, ...), as the producer wrote them. + Add a stop opens the WR-3 AddStopSheet. */
export default function Itinerary({ field, big, onAddStop }: { field: Field<It> | undefined; big: boolean; onAddStop?: () => void }) {
  const stops = field?.status === 'ok' && field.value ? field.value.stops : [];
  const pg = usePager(stops.length, big ? 7 : 4);
  const list = (
    <FieldBlock f={field} label="Stops">
      {it => (
        <>
          <div className="wr-row wr-sub">
            <span>{it.stops_left} stop{it.stops_left === 1 ? '' : 's'} left</span>
            <span className="wr-sp" />{pg.control}
          </div>
          <ol className="wr-list wr-stops">
            {it.stops.slice(pg.a, pg.b).map(s => (
              <li key={s.id} className={s.status === 'next' ? 'wr-next' : undefined}>
                <span className="wr-n">{s.order}</span>
                <span className="wr-lab">
                  <b>{s.label}</b>
                  {(s.p_yes || s.title_odds_delta) && (
                    <>
                      <br />
                      <span className="wr-sub">
                        chance <Val f={s.p_yes} fmt={v => pct(v)} /> · you after <Val f={s.title_odds_delta} fmt={pts} />
                      </span>
                    </>
                  )}
                </span>
                <span className={`wr-pill${s.status === 'next' ? ' wr-pill-next' : ''}`}>{s.status}</span>
              </li>
            ))}
          </ol>
          {it.conflicts.map((c, i) => <p key={i} className="wr-sub wr-red">{c.text}</p>)}
        </>
      )}
    </FieldBlock>
  );
  return (
    <>
      {list}
      <button type="button" className="wr-btn wr-sm" disabled={!onAddStop} onClick={onAddStop}
        title={onAddStop ? 'Add a stop; you see its trade-off before anything is recorded' : 'Pick a league first'}>+ Add a stop</button>
    </>
  );
}
