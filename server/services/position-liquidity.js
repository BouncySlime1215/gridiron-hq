/**
 * Which positions can actually be traded for in this league, and which cannot.
 *
 * This exists because the planner kept returning an empty page and the reason
 * turned out to be structural rather than a bug. Tracing the rejections on a
 * real ten-team league: of the deals that would have helped meaningfully, 26
 * were refused for leaving the other side with no startable player, and half of
 * those were quarterbacks.
 *
 * That is not the search failing. It is the league telling you something:
 *
 *   In a one-quarterback league every team starts exactly one and most carry
 *   exactly one. There is no surplus anywhere. A quarterback is therefore very
 *   nearly UNTRADEABLE — not because managers are stubborn, but because giving
 *   one up creates a hole the seller cannot fill, so a rational manager declines
 *   every offer regardless of price.
 *
 * The planner was silently discovering this over and over and reporting nothing.
 * Told plainly it is one of the more useful things in the app, because it
 * redirects the whole plan: if your biggest hole is at a position with no
 * liquidity, the answer is not a better trade offer, it is the waiver wire, and
 * no amount of negotiating will change that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "SURPLUS" MEANS HERE
 *
 * A team's requirement at a position is its dedicated starting slots plus a
 * share of the flex slots that position competes for. Anything beyond that is
 * tradeable depth. Summed across rivals, that is the supply available to you —
 * and it is frequently zero at quarterback and tight end while being large at
 * running back and receiver, which is exactly the asymmetry that decides where
 * a trade can be found.
 */
import { row } from '../db/index.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, lineupSlots, bestLineup } from './trade-engine.js';

const SKILL = ['QB', 'RB', 'WR', 'TE'];
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/** Which positions a flex slot will accept. */
const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'],
  'W/R': ['RB', 'WR'],
  'W/R/T': ['RB', 'WR', 'TE'],
  'W/T': ['WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE']
};

/**
 * How many players at each position a team must keep to field a legal lineup.
 *
 * Flex slots are shared, so they are apportioned rather than counted whole: a
 * single FLEX that three positions compete for adds a third of a body to each
 * requirement. Counting it as a full slot for every eligible position would
 * overstate requirements badly enough to make every roster look like it has no
 * surplus at all — which would turn this analysis into a machine that always
 * says "nothing is tradeable".
 */
export function positionRequirements(slots) {
  const req = Object.fromEntries(SKILL.map(p => [p, 0]));
  const dedicated = Object.fromEntries(SKILL.map(p => [p, 0]));
  for (const slot of slots) {
    const s = String(slot).toUpperCase();
    if (SKILL.includes(s)) { req[s] += 1; dedicated[s] += 1; continue; }
    const eligible = FLEX_ELIGIBLE[s];
    if (eligible) {
      const share = 1 / eligible.length;
      for (const p of eligible) if (req[p] != null) req[p] += share;
    }
  }
  // Both numbers matter and they answer different questions.
  //
  // `dedicated` is the hard floor: a team must keep this many or it cannot field
  // a legal lineup, so it decides whether a trade is possible at all.
  // `req` includes the flex share and decides how much the trade costs them.
  //
  // Conflating them produced a contradiction on a real league: tight end showed
  // 4.69 spare bodies across the league and simultaneously "0 teams with spare",
  // because the fractional requirement of 1.33 meant a team holding two startable
  // tight ends scored 0.67 surplus and failed a `>= 1` test. That team can
  // obviously trade one — they keep the one their TE slot needs and put a running
  // back in the flex. The flex is fungible; the dedicated slot is not.
  return { ...req, _dedicated: dedicated };
}

/**
 * Supply and demand per position across the whole league.
 *
 * @returns for each position: how much spare depth exists on other rosters, how
 *   many teams hold any, and a plain reading of whether you can shop there.
 */
export function positionLiquidity(leagueId, { myTeamId = null } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  if (!teams.length) return { error: 'league sync contains no rosters yet' };
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  const rivals = teams.filter(t => t.roster_id !== me.roster_id);
  const req = positionRequirements(slots);

  const out = {};
  for (const pos of SKILL) {
    const need = req[pos] ?? 0;
    const floor = req._dedicated[pos] ?? 0;
    // Only count depth that is actually startable somewhere. A fourth tight end
    // projected for two points a week is not supply; nobody is trading for him
    // and his owner is not protecting him either.
    const perRival = rivals.map(t => {
      const at = t.players.filter(p => p.position === pos && (p.adj_ppg ?? 0) > 0);
      const startable = at.filter(p => (p.adj_ppg ?? 0) >= 4)
        .sort((a, b) => b.adj_ppg - a.adj_ppg);
      return {
        owner: t.owner, roster_id: t.roster_id,
        rostered: at.length,
        startable: startable.length,
        // Against the hard floor: can they give one up and still field a lineup?
        can_spare: Math.max(0, startable.length - floor),
        // Against the full requirement including flex: what it costs them.
        surplus: r2(Math.max(0, startable.length - need)),
        best_spare: startable[Math.max(0, Math.ceil(floor))] ?? null
      };
    });

    const totalSurplus = r2(perRival.reduce((s, r) => s + r.surplus, 0));
    const teamsWithSpare = perRival.filter(r => r.can_spare >= 1).length;

    out[pos] = {
      starters_required: r2(need),
      league_surplus: totalSurplus,
      teams_with_spare: teamsWithSpare,
      of_teams: rivals.length,
      // The whole point, in one word.
      liquidity: teamsWithSpare === 0 ? 'none'
        : teamsWithSpare <= 2 ? 'thin'
          : teamsWithSpare <= rivals.length / 2 ? 'workable' : 'deep',
      sellers: perRival.filter(r => r.can_spare >= 1)
        .sort((a, b) => b.can_spare - a.can_spare)
        .map(r => ({ owner: r.owner, roster_id: r.roster_id, surplus: r.surplus,
          spare_player: r.best_spare ? { name: r.best_spare.name, adj_ppg: r.best_spare.adj_ppg } : null })),
      reading: teamsWithSpare === 0
        ? `Nobody in this league has a spare ${pos}. Every team starts ${r2(need)} and carries barely ` +
          `that, so giving one up creates a hole they cannot fill — which is why a ${pos} trade gets ` +
          'declined at any price. This position has to come from the waiver wire.'
        : teamsWithSpare <= 2
          ? `Only ${teamsWithSpare} team${teamsWithSpare === 1 ? '' : 's'} can spare a ${pos} without ` +
            'breaking their own lineup, so your negotiating position is weak and you will overpay.'
          : `${teamsWithSpare} of ${rivals.length} teams carry spare ${pos} depth, so there is a real ` +
            'market here and you can shop it.'
    };
  }

  return {
    league: lg.name,
    starters_required: Object.fromEntries(SKILL.map(p => [p, r2(req[p])])),
    dedicated_slots: req._dedicated,
    positions: out,
    // Ordered so the caller can say "shop here, not there" without re-deriving it.
    easiest_to_acquire: SKILL.slice().sort((a, b) => out[b].league_surplus - out[a].league_surplus),
    untradeable: SKILL.filter(p => out[p].liquidity === 'none'),
    note: 'Surplus counts only startable depth beyond what a team needs to field a legal lineup. ' +
      'Flex slots are shared out between the positions that compete for them rather than counted ' +
      'whole for each, which would otherwise make every roster look like it has nothing to spare.'
  };
}

/**
 * Given where you are thin, where should you actually go shopping?
 *
 * Combines your own need with what the league can supply, which is a different
 * and more useful question than either on its own. The largest hole at a
 * position nobody can sell is not the thing to work on; the second-largest hole
 * at a position four teams have spare is.
 */
export function shoppingGuidance(leagueId, needProfileByPosition, { myTeamId = null } = {}) {
  const liq = positionLiquidity(leagueId, { myTeamId });
  if (liq.error) return liq;

  const rows_ = SKILL.map(pos => {
    const need = needProfileByPosition?.[pos]?.need ?? 0;
    const l = liq.positions[pos];
    // Need you can actually act on. A perfect need at an untradeable position
    // scores zero for trading purposes, which is the correction this makes.
    const tradeable = need * Math.min(1, l.teams_with_spare / Math.max(1, l.of_teams / 2));
    return {
      position: pos, need: r2(need),
      liquidity: l.liquidity, teams_with_spare: l.teams_with_spare,
      tradeable_need: r2(tradeable),
      route: l.liquidity === 'none' ? 'waivers only' : 'trade or waivers',
      reading: l.reading
    };
  }).sort((a, b) => b.tradeable_need - a.tradeable_need);

  const biggestNeed = [...rows_].sort((a, b) => b.need - a.need)[0];
  const bestTarget = rows_[0];

  return {
    positions: rows_,
    best_trade_target: bestTarget?.position ?? null,
    // The sentence that makes this worth computing.
    redirect: biggestNeed && bestTarget && biggestNeed.position !== bestTarget.position
      && biggestNeed.liquidity === 'none'
      ? `Your biggest hole is ${biggestNeed.position}, and no team in this league can trade you one ` +
        `without wrecking their own lineup — that is why the trade board looks empty. Fix ${biggestNeed.position} ` +
        `off waivers, and spend your trade capital on ${bestTarget.position} instead, where ` +
        `${bestTarget.teams_with_spare} teams have depth to sell.`
      : null
  };
}
