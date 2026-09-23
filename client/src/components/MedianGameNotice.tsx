/**
 * The season sim's own `median_game` field (league-rules.js#inferMedian, one
 * producer) is `null` when the median-game rule is genuinely unknown. The
 * producer has more than one null path (no regular-season week decided yet;
 * weeks decided but records per week neither 1 nor 2), and each one pushes its
 * own reason, prefixed `median_game:`, into `rules.unknown`, which the sim
 * serves as `rules_unknown` (season-sim.js:439). This component never invents
 * a reason: it shows the sim's own entry, or none if the sim gave none.
 *
 * While the rule is unknown the sim plays the season WITHOUT a median game
 * (season-sim.js:310, `rules.median_game === true`), so the notice says so.
 *
 * Renders nothing while the value is still `undefined` (the sim hasn't
 * answered yet) — only an explicit `null` from the served field counts as
 * "unknown". Model.tsx and MyTeam.tsx both render it (INT-168-1, from the
 * CE-05 audit, #168); one producer for the text so they cannot drift.
 */
const PREFIX = 'median_game:';

export function medianUnknownReason(rulesUnknown: unknown): string | null {
  if (!Array.isArray(rulesUnknown)) return null;
  const hit = rulesUnknown.find((u): u is string => typeof u === 'string' && u.startsWith(PREFIX));
  return hit ? hit.slice(PREFIX.length).trim() || null : null;
}

export default function MedianGameNotice({ medianGame, rulesUnknown }: {
  medianGame: boolean | null | undefined;
  rulesUnknown?: string[] | null;
}) {
  if (medianGame !== null) return null;
  const reason = medianUnknownReason(rulesUnknown);
  return (
    <p className="text-[10px] text-amber-600 mt-1" data-median-notice="">
      Whether this league gives an extra win for beating the week's median score is still unknown, so these
      odds are simulated without one.{reason ? ` Why: ${reason}.` : ''}
    </p>
  );
}
