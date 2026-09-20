/**
 * WHAT A FITTED MODEL SAYS ABOUT EVERY TEAM IN THE LEAGUE.
 *
 * `GET /api/leagues/:id/outlook` reads the season so far through a model fitted
 * on finished seasons. It is NOT the simulation that produces the championship
 * number on My Team — that one plays the rest of the season out thousands of
 * times. Two methods, two answers, and the glossary keeps them under two names
 * (`outlook_probability` against `playoff_odds`) for the same reason it keeps
 * two floors apart.
 *
 * FOUR RULES FROM THE CONTRACT, all of them things a panel gets wrong by
 * default:
 *
 *   1. NOT READY IS A SENTENCE, PRINTED AS IT ARRIVES. Five distinct reasons,
 *      two of which are deliberate refusals rather than missing data. The
 *      server wrote them as finished sentences; rewording them here would put a
 *      second version of each claim in a second place.
 *   2. A PROBABILITY NEVER READS AS 0% OR 100%. The payload guarantees the
 *      value is neither and that does not survive rounding. The clamp is on the
 *      rendered string, in lib/percent.js, applied through the glossary entry's
 *      `neverCertain` flag so every surface gets it.
 *   3. `act` IS NEVER SYNTHESISED. The server sends `fine`, `watch` and
 *      `act_candidate` and never `act`, because act means a specific move
 *      exists that raises these odds and only a caller holding the trade
 *      engine's best move can know that. Upgrading the label here would be
 *      telling a manager to do something without having found anything to do.
 *   4. THE DECOMPOSITION IS SHOWN IN THE SERVER'S ORDER, and `real` is marked
 *      as a remainder. The three parts are not equally important in every
 *      league and the server knows which dominates; a fixed order would put the
 *      biggest one last in half of them. And `real` is what is left after luck
 *      and noise, not a separately measured quantity — `real_is` carries the
 *      sentence that says so.
 *
 * Nothing is computed at request time on the server, so `fit.basis` is an
 * as-of sentence about a fit that already existed, not about this request.
 */
import { useState } from 'react';
import BasisChip, { BasisLine } from '../ui/BasisChip';
import { formatValue } from '../../lib/glossary';
import { verdictOf, decompositionParts, showsDecomposition } from '../../lib/outlook.js';
import type { Outlook, OutlookReady, OutlookTeam } from '../../lib/outlook.js';

const isReady = (o: Outlook): o is OutlookReady => o.ready === true;

/** The team's own row, expandable into why the model reads it that way. */
function TeamRow({ team, name, isMine }: { team: OutlookTeam; name: string; isMine: boolean }) {
  const [open, setOpen] = useState(false);
  const v = verdictOf(team.verdict);
  const parts = decompositionParts(team.decomposition);

  return (
    <li className={`outlook-row${isMine ? ' is-mine' : ''}`}>
      <button type="button" className="outlook-row-main" onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`${name}. Chance to qualify ${formatValue('outlook_probability', team.probability)}. ${v?.plain ?? ''} Show what is behind it.`}>
        <span className="outlook-team">{name}</span>
        <span className="outlook-record tabular">
          {team.wins_so_far != null && team.games != null ? `${team.wins_so_far}-${team.games - team.wins_so_far}` : '—'}
        </span>
        <span className="outlook-probability tabular">
          {formatValue('outlook_probability', team.probability)}
        </span>
        {v && <span className={`outlook-verdict outlook-verdict-${team.verdict}`} title={v.plain}>{v.label}</span>}
      </button>

      {open && (
        <div className="outlook-why">
          {parts.length > 0 ? (
            <>
              <p className="outlook-why-lead">
                What is behind that number, biggest first:
              </p>
              <ul className="outlook-parts">
                {parts.map(p => (
                  <li key={p.key}>
                    <span className="outlook-part-label">{p.label}</span>
                    <span className="outlook-part-value tabular">
                      {p.value == null ? '—' : p.value.toFixed(2)}
                    </span>
                    {p.note && <span className="outlook-part-note">{p.note}</span>}
                  </li>
                ))}
              </ul>
              {team.decomposition?.no_results_yet != null && (
                <p className="outlook-why-note">
                  {/* Deliberately not called a preseason forecast: it is the
                      same model with the result features turned off, which is a
                      different thing, and naming it wrong would invent a
                      comparison nobody ran. */}
                  With everything that has happened this season set aside, the same model reads this
                  team at {formatValue('outlook_probability', team.decomposition.no_results_yet)}.
                </p>
              )}
            </>
          ) : (
            <p className="outlook-why-note">
              Nothing has been played yet, so there is nothing to take apart.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export default function OutlookPanel({ outlook, teamName, myRosterId }: {
  outlook: Outlook | null | undefined;
  /** Resolves a roster id to the name a manager reads. */
  teamName: (rosterId: string | number) => string;
  myRosterId?: string | number | null;
}) {
  // No payload at all is not the same as a payload saying it is not ready, and
  // neither is an error. The caller owns loading and error; this renders only
  // what the route actually answered.
  if (!outlook) return null;

  if (!isReady(outlook)) {
    // Rule 1. The server's sentence, as it arrives. Two of the five cases are
    // deliberate refusals rather than missing data, and the sentence is the
    // only thing that distinguishes them.
    return (
      <section className="outlook-panel" aria-label="League outlook">
        <h3 className="outlook-title">How the league looks</h3>
        <BasisLine basis="none">{outlook.reason}</BasisLine>
      </section>
    );
  }

  const withDecomposition = showsDecomposition(outlook);
  return (
    <section className="outlook-panel" aria-label="League outlook">
      <div className="outlook-head">
        <h3 className="outlook-title">How the league looks</h3>
        <span className="outlook-meta">
          {outlook.weeks_played} of {outlook.regular_periods} weeks played · top {outlook.playoff_teams} of {outlook.num_teams} qualify
        </span>
        {/* The fit is a model trained on finished seasons, so the chip is
            `fitted` and the server's own as-of sentence rides with it rather
            than being restated. */}
        <BasisChip basis="fitted" note={outlook.fit.basis} n={outlook.fit.weeks} />
      </div>

      <ul className="outlook-rows">
        {outlook.teams.map(t => (
          <TeamRow key={String(t.roster_id)} team={t} name={teamName(t.roster_id)}
            isMine={myRosterId != null && String(t.roster_id) === String(myRosterId)} />
        ))}
      </ul>

      {!withDecomposition && outlook.weeks_played === 0 && (
        <p className="outlook-foot">
          No games have been played, so every number here is what the model expects before a season
          starts rather than a read on this one.
        </p>
      )}
      <p className="outlook-foot">
        {/* Rule 3, said out loud rather than left as an absent button. A
            manager reading "Worth a look" will ask what to do, and the honest
            answer is that this panel does not know. */}
        "Worth a look" marks where a move would matter most. Whether a move is actually available is
        a different question, and this panel does not answer it — Trade Lab does.
      </p>
    </section>
  );
}
