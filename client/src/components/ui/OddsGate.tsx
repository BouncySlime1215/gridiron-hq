/**
 * WHETHER THE CHAMPIONSHIP NUMBER SHOULD BE SHOWN AT ALL.
 *
 * The playoff-odds simulation was graded on 184,959 real team-weeks across
 * 2,500 Sleeper leagues, 2021-2025. Before week 4 it is WORSE than telling
 * every team its league's base rate — Brier 0.2855 against 0.2410 at week 2 —
 * and at every week it is overconfident at both ends: teams it gives no chance
 * qualify about 12% of the time, teams it calls certain miss about 10%.
 *
 * A number that loses to the base rate is worse than no number, because a
 * manager acts on it. So the percentage is withheld until the odds stand on
 * enough results, and what replaces it is a designed state with a sentence,
 * not a blank space or an empty chip.
 *
 * THREE STATES, and the middle one is the one that is easy to miss:
 *
 *   no_results   The odds stand on ZERO games played. This is not "too early
 *                to say" — it is a preseason projection that has not been told
 *                anything about the season the manager has been watching. It
 *                is also, today, what League Hub sends: MyTeam.tsx:67 requests
 *                the simulation with no from_week at all.
 *   too_early    Some weeks are in, but fewer than the grading says are needed
 *                before the number beats a base rate.
 *   published    Shown, with the note that the extremes run hot.
 *
 * The numbers are ALL still in the payload in every state. The server does not
 * blank them; this decides what to render. That matters because the deep dive
 * still shows what went into them — withholding the headline is not the same as
 * pretending there is nothing there.
 */
import BasisChip from './BasisChip';
// The decisions live in plain JS so the test suite can import and call them;
// this file only renders what they return. See lib/odds-gate.js.
import { gateState, withheldReason } from '../../lib/odds-gate.js';
import type { OddsGate } from '../../lib/odds-gate.js';
export { gateState, gradedSentence, BRIER_IN_WORDS } from '../../lib/odds-gate.js';

// The gate's shape has one home, in lib/odds-gate.d.ts, beside the logic that
// reads it. A second copy here would be a second thing to keep in step with
// the server's payload.
export type { OddsGate, Calibration, WeekGrade, GateState } from '../../lib/odds-gate.js';


const fmtPct = (v?: number | null) =>
  v == null || !Number.isFinite(v) ? null : `${Math.round(v * 100)}%`;

/**
 * What stands where the percentage would be.
 *
 * Deliberately not a card, not amber, and not an error. Nothing is broken and
 * nothing is wrong with the manager's team — we simply decline to show a number
 * we have measured to be worse than a coin flip's cousin at this point in the
 * season. The basis chip carries that: `none` means nothing prices this yet.
 */
export function WithheldOdds({ gate, label }: { gate: OddsGate; label: string }) {
  const state = gateState(gate);
  const none = state === 'no_results';
  return (
    <div className="odds-withheld">
      <span className="odds-withheld-label">{label}</span>
      <span className="odds-withheld-value">
        {none ? 'Not from this season yet' : 'Too early to say'}
      </span>
      <BasisChip basis={none ? 'missing' : 'none'} />
      <p className="odds-withheld-why">
        {/* The server's own reason always wins. A page that paraphrases what it
            was told is a second place for the claim to drift. */}
        {gate.reason ?? withheldReason(state, gate.min_week)}
      </p>
    </div>
  );
}

/**
 * The line that rides ALONGSIDE a published percentage.
 *
 * Publishing is not the same as being right. The overconfidence was measured at
 * every week, including the ones where the number beats a base rate, so a
 * published number still says where it is weakest — at the two ends, which is
 * exactly where a manager is most likely to act on it.
 */
export function PublishedCaveat({ gate }: { gate?: OddsGate | null }) {
  const e = gate?.calibration?.extremes;
  const noChance = fmtPct(e?.no_chance_qualify_rate);
  const certainMiss = fmtPct(e?.certain_miss_rate);
  if (!noChance && !certainMiss) return null;
  return (
    <p className="odds-caveat">
      This number is least reliable at the extremes.
      {noChance && ` Teams we gave no chance still got there ${noChance} of the time.`}
      {certainMiss && ` Teams we called certain missed ${certainMiss} of the time.`}
      {' '}Treat a very high or very low number as a lean, not a verdict.
    </p>
  );
}
