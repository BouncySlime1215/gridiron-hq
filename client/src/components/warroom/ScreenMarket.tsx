import { useState } from 'react';
import type { WarRoomView } from './types';
import { namer, teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, whole, isOk } from './format';
import { groupFlips } from './FlipMap';
import CatchUp from './CatchUp';
import Avatar from './Avatar';
import { isGuess } from './heroStatus';

/**
 * WAR-ROOM-UI v2, MARKET: the flip radar as a board of cards (one per player, the
 * producer's order and best leg, FlipMap.groupFlips): photo, buy from -> sell to, the
 * gap, the chance both say yes, and why now; players with no fair leg sit behind
 * "Show all". The catch-up list and speed curve sit under it.
 */
export default function ScreenMarket({ view }: { view: WarRoomView }) {
  const n = namer(view.names);
  const rows = isOk(view.flip_map) ? view.flip_map.value : [];
  const groups = groupFlips(rows);
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.filter(g => g.actionable);
  const hidden = groups.length - groups.filter(g => g.actionable).length;
  const d = isOk(view.destination) ? view.destination.value : undefined;
  return (
    <div className="wr-market">
      <section className="wr-card2" data-panel="flip_map" aria-label="Flip radar">
        <h3 className="wr-card2-h">Flip radar <span className="wr-muted wr-h-note">buy low from one manager, sell high to another</span></h3>
        <FieldBlock f={view.flip_map} label="Flip map">
          {list => !list.length ? <div className="wr-empty">No flips found in this run.</div> : (
            <>
              {!shown.length && (
                <div className="wr-empty" data-testid="flip-none-actionable">
                  No flip has a fair leg on both sides yet: gaps on {groups.length} player{groups.length > 1 ? 's' : ''}, none sendable.
                </div>
              )}
              <div className="wr-fgrid">
                {shown.map(({ best: f, rows: rs, player }) => {
                  const name = n.one(f.player).name;
                  const give = f.legs ? n.text(f.legs.give_a_ids?.length ? f.legs.give_a_ids : [f.legs.give_a]) : null;
                  const get = f.legs ? n.text(f.legs.get_b_ids?.length ? f.legs.get_b_ids : [f.legs.get_b]) : null;
                  return (
                    <article key={player} className="wr-fcard" data-flip-player={player}>
                      <header className="wr-fcard-h">
                        <Avatar id={f.player} name={name} size={48} />
                        <span className="wr-fcard-t"><b title={name}>{name}</b>
                          {rs.length > 1 && <span className="wr-muted"> · {rs.length} buyers</span>}</span>
                        <span className="wr-fcard-gap"><Val f={f.spread} fmt={pts} /></span>
                      </header>
                      <p className="wr-fcard-route">
                        <span title={teamLabel(f.buy_from)}>Buy from <b>{teamLabel(f.buy_from)}</b></span>
                        <span aria-hidden> → </span>
                        <span title={teamLabel(f.sell_to)}>sell to <b>{teamLabel(f.sell_to)}</b></span>
                      </p>
                      <div className="wr-fcard-nums">
                        <span><span className="wr-l2">Both say yes</span>
                          <b>{f.legs ? <><Val f={f.legs.p_both} fmt={v => pct(v)} />{isGuess(f.legs.p_both) && <span className="wr-pill2 wr-pill2-amber">guess</span>}</>
                            : <span className="wr-muted">no fair legs yet</span>}</b></span>
                        <span><span className="wr-l2">Prices</span><b className="wr-num"><Val f={f.price_a} fmt={whole} /> vs <Val f={f.price_b} fmt={whole} /></b></span>
                      </div>
                      {f.legs ? <p className="wr-sub" data-testid="flip-legs">give {give} → get {get}</p>
                        : <p className="wr-sub" title={f.legs_why_not}>{f.legs_why_not ?? 'no fair legs found'}</p>}
                      {f.reasoning && isOk(f.reasoning) && <p className="wr-fcard-why"><span className="wr-l2">Why now</span>{f.reasoning.value.case_for}</p>}
                    </article>
                  );
                })}
              </div>
              {hidden > 0 && (
                <button type="button" className="wr-link" onClick={() => setAll(a => !a)} aria-expanded={all} data-testid="flip-show-all">
                  {all ? 'Hide ones with no fair legs' : `Show all (${hidden} with no fair legs yet)`}
                </button>
              )}
            </>
          )}
        </FieldBlock>
      </section>

      <section className="wr-card2" data-panel="catch" aria-label="Catch-up">
        <h3 className="wr-card2-h">Catch-up <span className="wr-muted wr-h-note">cheapest way back first</span></h3>
        <CatchUp catchUp={view.catch_up} speed={view.speed_curve} groundLost={d?.ground_lost}
          arriveBy={isOk(d?.arrive_by) ? d.arrive_by.value : undefined} big />
      </section>
    </div>
  );
}
