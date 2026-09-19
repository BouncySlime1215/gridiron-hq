/**
 * What the odds above were built from.
 *
 * `season-sim.js` has always decided three things and served all three, and the page
 * rendered none of them:
 *
 *   - `playoff_basis` — whether the bracket came from the league's own schedule or
 *     from a fallback constant. My Team said "real playoff bracket weeks 15–17" as a
 *     flat sentence, which is false for any league whose bracket is not weeks 15–17
 *     and misleading when it is, because `default_weeks_15_17` is the fallback taken
 *     when the league's schedule could not be read at all. A hardcoded sentence that
 *     happens to match the fallback is the worst case: it reads as a fact about your
 *     league and is a fact about our default.
 *   - `projection_basis` — which games the odds rest on. Odds built off last season
 *     and odds built off this season's games so far are different numbers and look
 *     identical, and the string names the case where the current-season usage log is
 *     empty, which is the live defect this project keeps hitting.
 *   - `odds_interval` — that the ± range beside the championship number is run-to-run
 *     Monte Carlo error only. A range labelled just "range" reads as the uncertainty
 *     in the forecast, which it is not and is much smaller than.
 *
 * The strings are the server's own. Nothing is reworded here beyond turning the
 * bracket enum into a sentence, because a page that paraphrases what it was told is
 * a second place for the claim to drift.
 */

const BRACKET: Record<string, string> = {
  league_schedule: "Playoff bracket taken from your league's own schedule.",
  league_schedule_short_of_field:
    "Your league's schedule lists fewer playoff rounds than its playoff field needs, so the bracket "
    + 'is the rounds it actually lists — no week was invented to fill the gap.',
  sleeper_playoff_week_start: "Playoff bracket from the week Sleeper says your playoffs start, one week per round.",
  default_weeks_15_17:
    "Your league's playoff weeks could not be read, so weeks 15–17 are assumed. If your league plays "
    + 'its bracket on different weeks, these odds are for a bracket you do not play.'
};

export default function OddsBasis({ sim }: { sim: any }) {
  if (!sim) return null;
  const bracket = BRACKET[sim.playoff_basis] ?? null;
  const assumed = sim.playoff_basis === 'default_weeks_15_17';
  return (
    <div className="mt-2 space-y-1 text-[10px] leading-4 text-slate-400">
      <p>
        {sim.runs?.toLocaleString()} simulated seasons, correlated player outcomes.
        {sim.projection_basis ? ` Built from ${sim.projection_basis}.` : ''}
      </p>
      {bracket && <p className={assumed ? 'text-amber-700' : undefined}>{bracket}</p>}
      {sim.odds_interval && <p>The range is {sim.odds_interval}.</p>}
    </div>
  );
}
