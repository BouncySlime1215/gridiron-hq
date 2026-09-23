/**
 * The season sim's own `median_game` field (league-rules.js#inferMedian, one
 * producer) is `null` when ESPN publishes no median-game setting and no
 * regular-season week has been decided yet to infer it from — the standings
 * rule is genuinely unknown, not merely absent. Model.tsx and MyTeam.tsx both
 * render title/playoff odds off that same sim response but neither said so
 * (INT-168-1, from the CE-05 audit, #168). One producer for the notice text,
 * so the two pages cannot drift on the wording.
 *
 * Renders nothing while the value is still `undefined` (the sim hasn't
 * answered yet) — only an explicit `null` from the served field counts as
 * "unknown".
 */
export default function MedianGameNotice({ medianGame }: { medianGame: boolean | null | undefined }) {
  if (medianGame !== null) return null;
  return (
    <p className="text-[10px] text-amber-600 mt-1">
      Whether this league gives an extra win for beating the week's median score is still unknown — no
      regular-season week has been decided yet.
    </p>
  );
}
