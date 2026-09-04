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
 * Best-ball detection from a league's raw synced payload (leagues.payload).
 *
 * Sleeper exposes this directly and reliably: `league.settings.best_ball === 1`
 * is Sleeper's own documented league-settings flag. ESPN has no official public
 * docs for it; the field community-maintained ESPN API clients (e.g.
 * cwendt94/espn-api) read for this is `settings.rosterSettings.isBestBallLeague`
 * — used here the same fail-closed way this codebase already treats other
 * reverse-engineered ESPN fields (see espn-draft.js's playerId===-1 sentinel
 * comment): if the field isn't there, this returns false rather than guessing.
 */
export function isBestBallFromPayload(platform, payload) {
  if (!payload) return false;
  if (platform === 'sleeper') return payload.league?.settings?.best_ball === 1;
  return Boolean(payload.settings?.rosterSettings?.isBestBallLeague);
}

/**
 * @returns {{ formatKey: string, isDynasty: boolean, isBestBall: boolean, params: URLSearchParams }}
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

  // Best-ball has no in-season lineup management to correct a bad roster bet —
  // this is what makes Zero-RB/Anchor-RB strategies and QB+pass-catcher stacks
  // outperform there specifically (4for4/RotoWire/DraftSharks best-ball
  // strategy research), which draft-assist.js's rankTargets() acts on.
  let payload = null;
  if (lg.payload) { try { payload = JSON.parse(lg.payload); } catch { payload = null; } }
  const isBestBall = Boolean(lg.best_ball) || isBestBallFromPayload(lg.platform, payload);

  return {
    formatKey: `${isDynasty ? 'dyn' : 'rd'}_sf${numQbs}_t${numTeams}_ppr${ppr}`,
    isDynasty,
    isBestBall,
    params: new URLSearchParams({
      isDynasty: String(isDynasty),
      numQbs: String(numQbs),
      numTeams: String(numTeams),
      ppr: String(ppr)
    })
  };
}
