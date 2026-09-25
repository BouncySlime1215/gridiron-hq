import type { WarRoomView } from './types';
import { teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { pct, pts, isOk } from './format';
import PeopleBoard from './PeopleBoard';

/**
 * WAR-ROOM-UI v2, LEAGUE: one card per league-mate. With the People board on, its tiles
 * (respond rate, budget, in market, his word, mood, approach, moves with him); otherwise
 * the plan's partners read. Tapping a manager opens Coach asked about a trade with him.
 */
export default function ScreenLeague({ view, onAsk }: { view: WarRoomView; onAsk: (team: string) => void }) {
  const people = view.people_board?.enabled === true;
  const moves = isOk(view.alternatives) ? view.alternatives.value : [];
  return (
    <section className="wr-card2 wr-league" data-panel="people" aria-label="League">
      <h3 className="wr-card2-h">Your league <span className="wr-muted wr-h-note">tap a manager to ask Coach about a trade with him</span></h3>
      {people ? (
        <PeopleBoard view={view} big={false} focus={null} onFocus={onAsk} pageSize={12}
          hint="Who to work this week" tapLabel="ask Coach about a trade with him" />
      ) : (
        <FieldBlock f={view.partners} label="Partners">
          {list => (
            <ul className="wr-people wr-stagger">
              {list.map(p => {
                const n = moves.filter(m => m.steps.some(s => String(s.partner) === String(p.team))).length;
                return (
                  <li key={p.team}>
                    <button type="button" className="wr-person" data-team={p.team} onClick={() => onAsk(String(p.team))}
                      aria-label={`${teamLabel(p.team)}: ask Coach about a trade with him`}>
                      <span className="wr-row"><b>{teamLabel(p.team)}</b><span className="wr-sp" />
                        <span className="wr-num">{pct(p.p_responds)} respond</span></span>
                      <span className="wr-person-slot"><span className="wr-l">Why</span> {p.basis}</span>
                      <span className="wr-person-slot"><span className="wr-l">Best edge through him</span> <Val f={p.edge} fmt={pts} /></span>
                      {p.roster_holes?.length ? <span className="wr-person-slot"><span className="wr-l">Needs</span> {p.roster_holes.join(', ')}</span> : null}
                      {typeof p.offers_logged === 'number' && <span className="wr-person-slot"><span className="wr-l">Offers logged</span> {p.offers_logged}</span>}
                      <span className="wr-hint">{n ? `${n} move${n === 1 ? '' : 's'} with him in the plan` : 'No move with him in the plan'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </FieldBlock>
      )}
    </section>
  );
}
