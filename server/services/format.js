/**
 * League format derivation for FantasyCalc value sets.
 *
 * Ported from akodsi/fantasy-advisor (app/fantasycalc.py:derive_format). FantasyCalc
 * prices players differently per format — a QB in superflex is worth roughly double
 * his 1QB value — so each distinct league shape needs its own value set. Pulling one
 * global set and applying it to every league misprices any league that differs.
 */

// FantasyCalc only serves these team counts; snap to the nearest.
const ALLOWED_TEAM_COUNTS = [8, 10, 12, 14, 16];

/** Sleeper settings.type: 0 = redraft, 1 = keeper, 2 = dynasty. */
export function leagueTypeFromPayload(platform, payload) {
  if (!payload) return null;
  if (platform === 'sleeper') {
    const t = payload.league?.settings?.type;
    if (t === 2) return 'dynasty';
    if (t === 1) return 'keeper';
    if (t === 0) return 'redraft';
    return null;
  }
  // ESPN has no dynasty flag; a non-zero keeper count is the closest signal.
  const keepers = payload.settings?.draftSettings?.keeperCount ?? 0;
  return keepers > 0 ? 'keeper' : 'redraft';
}

/**
 * @returns {{ formatKey: string, isDynasty: boolean, params: URLSearchParams }}
 */
export function deriveFormat(lg) {
  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions) : [];
  const numQbs = rp.includes('SUPER_FLEX') || lg.superflex ? 2 : 1;

  const rec = lg.ppr ?? 1;
  const ppr = rec >= 1 ? 1 : rec >= 0.5 ? 0.5 : 0;

  const total = lg.team_count || 12;
  const numTeams = ALLOWED_TEAM_COUNTS.reduce(
    (best, n) => (Math.abs(n - total) < Math.abs(best - total) ? n : best)
  );

  // Keeper leagues carry players over, so they price much closer to dynasty than
  // to redraft. Only an explicit redraft signal gets redraft values.
  const isDynasty = lg.league_type === 'dynasty' || lg.league_type === 'keeper';

  return {
    formatKey: `${isDynasty ? 'dyn' : 'rd'}_sf${numQbs}_t${numTeams}_ppr${ppr}`,
    isDynasty,
    params: new URLSearchParams({
      isDynasty: String(isDynasty),
      numQbs: String(numQbs),
      numTeams: String(numTeams),
      ppr: String(ppr)
    })
  };
}
