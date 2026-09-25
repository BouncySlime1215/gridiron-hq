import type { ReactNode } from 'react';
import type { Destination, WarRoomView } from './types';
import type { Negotiations } from './negotiateModel';
import { Val } from './FieldState';
import { pct, isOk } from './format';
import { stopCounts, watchItems } from './today';

/**
 * WAR-ROOM-UI v2, TODAY (the default screen): the "Do this now" card (the hero deck,
 * passed in so its state survives screen changes), a short WATCHING list and the
 * SEASON PROGRESS strip. Every line is a served field; nothing is computed.
 */
export default function ScreenToday({ view, negotiations, deck }: {
  view: WarRoomView; negotiations?: Negotiations | null; deck: ReactNode;
}) {
  const items = watchItems(view, negotiations);
  const d = isOk(view.destination) ? view.destination.value : undefined;
  const stops = stopCounts(view);
  // A destination that is itself failed/unknown shows its own state, as the top strip does.
  const goal = (d ? d.goal : view.destination) as Destination['goal'] | undefined;
  return (
    <div className="wr-today">
      <section className="wr-hero" data-panel="next" aria-label="Do this now">
        <h2 className="wr-screen-h">Do this now</h2>
        {deck}
      </section>

      <div className="wr-today-grid">
        <section className="wr-card2" data-panel="watching" aria-label="Watching">
          <h3 className="wr-card2-h">Watching</h3>
          {items.length ? (
            <ul className="wr-watch">
              {items.map(it => (
                <li key={it.id} className={`wr-watch-i wr-watch-${it.tone}`} title={it.detail}>
                  <span className="wr-watch-dot" aria-hidden />
                  <span className="wr-watch-t">{it.text}</span>
                </li>
              ))}
            </ul>
          ) : <p className="wr-sub">Nothing needs watching right now.</p>}
        </section>

        <section className="wr-card2" data-panel="progress" aria-label="Season progress">
          <h3 className="wr-card2-h">Season progress</h3>
          <dl className="wr-prog">
            <div><dt>Goal</dt><dd><Val f={goal} fmt={g => g.label} /></dd></div>
            <div><dt>Title odds plan</dt><dd className="wr-num"><Val f={d?.title_planned_now} fmt={v => pct(v, 1)} /></dd></div>
            <div><dt>Stops</dt><dd>{stops ? `${stops.done} done · ${stops.left} left` : <Val f={view.itinerary} fmt={() => ''} />}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
