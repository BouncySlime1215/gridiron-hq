import type { CatchUpItem, RiskModeRow, WarRoomView } from './types';
import { namer, teamLabel } from './types';
import { Val } from './FieldState';
import { pct, pts, isOk } from './format';

export const NOT_CLEARED = 'did not clear the fresh-dice check';

/**
 * WR-POLISH (audit defect 2): NEXT MOVE when the planner found nothing that clears
 * (`next_move` unknown, `alternatives` empty). The reason comes first, then the best
 * near-miss path (the risk-mode row with the highest expected gain, even though it did
 * not clear) and the all-in option from `catch_up`, each labelled as not cleared.
 * Reads only; picks the largest producer value by comparison, no arithmetic.
 */
export default function NoMoveCard({ view, onAsk }: { view: WarRoomView; onAsk?: (q: string) => void }) {
  const n = namer(view.names);
  const reason = view.next_move?.reason ?? 'The planner found no move for this league.';
  const near = bestNearMiss(isOk(view.risk_modes) ? view.risk_modes.value : []);
  const allIn = allInItems(isOk(view.catch_up) ? view.catch_up.value : []);
  const step = near?.first_step;
  return (
    <div className="wr-nomove" data-testid="no-move">
      <div className="wr-nomove-head" role="status">
        <div className="wr-who wr-who-sm">No move clears this week</div>
        <p className="wr-nomove-why">{reason}</p>
      </div>
      <div className="wr-nomove-grid">
        <section className="wr-nm-card" data-testid="near-miss" aria-label="Closest path">
          <div className="wr-row"><span className="wr-cap">Closest path</span><span className="wr-sp" /><span className="wr-tag wr-guess">{NOT_CLEARED}</span></div>
          {near ? (
            <>
              <div className="wr-nm-deal">
                {step ? <>Offer {teamLabel(step.partner)}: {n.text(step.give)} for {n.text(step.get)}</> : <>No first step written for this path.</>}
              </div>
              <div className="wr-sub">
                {near.label} mode{near.active ? ' (your mode)' : ''} · <Val f={near.expected} fmt={pts} /> expected
                {' · '}<Val f={near.if_complete} fmt={pts} /> if it all lands
                {' · '}finishes <Val f={near.p_complete} fmt={v => pct(v)} /> of the time
              </div>
            </>
          ) : (
            <div className="wr-sub">No path has an expected gain written for this run.</div>
          )}
          <div className="wr-sub">Finder's best single offer: <Val f={view.finder_best_expected} fmt={pts} showSe /></div>
        </section>
        <section className="wr-nm-card" data-testid="all-in" aria-label="All-in option">
          <div className="wr-row"><span className="wr-cap">All-in option</span><span className="wr-sp" /><span className="wr-tag wr-guess">{NOT_CLEARED}</span></div>
          {allIn.length ? (
            <ul className="wr-list">
              {allIn.map((c, i) => (
                <li key={i}><b>{c.text}</b> <span className="wr-muted"><Val f={c.gain} fmt={pts} /> expected{c.steps ? `, ${c.steps} step${c.steps > 1 ? 's' : ''}` : ''}</span></li>
              ))}
            </ul>
          ) : (
            <div className="wr-sub">{view.catch_up?.reason ?? 'The planner wrote no all-in option for this run.'}</div>
          )}
        </section>
      </div>
      {onAsk && (
        <div className="wr-acts">
          <button type="button" className="wr-btn wr-sm" onClick={() => onAsk('Show me the all-in plan')}>Show me the all-in plan</button>
          <button type="button" className="wr-btn wr-sm" onClick={() => onAsk('Why is nothing clearing?')}>Why is nothing clearing?</button>
        </div>
      )}
      <div className="wr-hint">Nothing here cleared the planner's own check. Treat both as ideas to talk through, not moves to send.</div>
    </div>
  );
}

/** The risk-mode row with the highest ok expected gain (the producer's number, compared, not computed). */
export function bestNearMiss(rows: RiskModeRow[]): RiskModeRow | null {
  let best: RiskModeRow | null = null;
  for (const r of rows) {
    if (!isOk(r.expected)) continue;
    if (!best || !isOk(best.expected) || r.expected.value > best.expected.value) best = r;
  }
  return best;
}

/** catch_up rows about the all-in plan; else the ones that are trades (steps > 0). */
export function allInItems(items: CatchUpItem[]): CatchUpItem[] {
  const named = items.filter(c => /all[- ]in/i.test(c.text));
  return named.length ? named : items.filter(c => c.steps > 0);
}
