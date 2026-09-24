/**
 * North-star row 12: "how do we catch back up" (pure).
 *
 * The list is ordered by KIND first, then by gain inside a kind:
 *   1. free       moves that cost no player (waiver claims that beat a starter)
 *   2. flip       buy-low / sell-high through Nick, both legs fair on each screen
 *   3. desperate  deals with managers who are out of it (low title odds) or checked out
 *   4. swing      bigger swings when behind (all-in plans), only when Nick is behind
 *   5. timing     wait-or-act flags and the deadline clock
 * Cheap and certain before expensive and risky: that is the whole ordering rule.
 */
export const CATCHUP_ORDER = Object.freeze(['free', 'flip', 'desperate', 'swing', 'timing']);

/** items: [{ kind, gain (objective units, may be null), text, ... }] -> ordered copy with rank. */
export function orderCatchUp(items) {
  const rank = k => {
    const i = CATCHUP_ORDER.indexOf(k);
    return i < 0 ? CATCHUP_ORDER.length : i;
  };
  return [...items]
    .filter(x => x && CATCHUP_ORDER.includes(x.kind))
    .sort((a, b) => (rank(a.kind) - rank(b.kind)) || ((b.gain ?? -Infinity) - (a.gain ?? -Infinity)))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/** Whether Nick is behind: his odds under an equal share of the league. */
export function isBehind(titleNow, teamCount) {
  return Number.isFinite(titleNow) && teamCount > 0 && titleNow < 1 / teamCount;
}

/**
 * Free moves: free agents whose rest-of-season rate beats Nick's weakest starter at the position.
 * fas: [{ id, name, position, ros_ppg }]; starters: [{ id, name, position, ros_ppg }]
 */
export function freeMoves(fas, starters, { limit = 3 } = {}) {
  const out = [];
  for (const fa of fas) {
    const same = starters.filter(s => s.position === fa.position && Number.isFinite(s.ros_ppg));
    if (!same.length || !Number.isFinite(fa.ros_ppg)) continue;
    const worst = same.reduce((a, b) => (b.ros_ppg < a.ros_ppg ? b : a));
    const edge = fa.ros_ppg - worst.ros_ppg;
    if (edge > 0) {
      out.push({ kind: 'free', gain: null, ppg_gain: edge, player: fa.id, replaces: worst.id,
        text: `Claim ${fa.name}: ${fa.ros_ppg.toFixed(1)} pts a game rest of season vs ${worst.name}'s ${worst.ros_ppg.toFixed(1)}.` });
    }
  }
  return out.sort((a, b) => b.ppg_gain - a.ppg_gain).slice(0, limit);
}
