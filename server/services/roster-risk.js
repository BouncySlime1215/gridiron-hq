/**
 * The losses you can already see coming.
 *
 * Everything else in the brain optimises an average week. That is the right
 * objective for a trade and completely wrong for the two things that actually
 * knock teams out of fantasy playoffs, both of which are known months ahead:
 *
 *   BYE WEEKS. On a real roster this week, three starters share week 11 and the
 *   only quarterback is off in week 5. Week 5 is not "a slightly worse week" —
 *   it is a guaranteed zero at quarterback, which is roughly a twenty-point hole
 *   against an opponent who has one. The schedule has been public since spring
 *   and almost nobody plans against it, because every tool reports a season
 *   average and a season average cannot see a single catastrophic Sunday.
 *
 *   SINGLE POINTS OF FAILURE. A lineup can be excellent and one hamstring from
 *   unstartable. `injury_dropoff` already measures that per position and nothing
 *   ever acted on it.
 *
 * The useful output is not "you have a bye problem". It is which week, how many
 * points it costs, and which specific free agent patches it — which is
 * computable, because the bye schedule and the waiver pool are both known.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SOLVED AND NOT ESTIMATED
 *
 * The obvious implementation counts how many starters share a bye and flags the
 * weeks with three or more. That is a proxy, and a poor one: three bye-week
 * receivers on a deep roster costs little, and one quarterback on a roster
 * carrying exactly one costs everything. Both read as "a bye week".
 *
 * So each week is actually solved. Remove the players on bye, re-optimise the
 * lineup from who remains, and take the difference. That is the real cost, it
 * ranks weeks correctly, and it is cheap because the lineup solver is cheap.
 */
import { row } from '../db/index.js';
import { deriveFormat } from './format.js';
import {
  assetUniverse, loadRosters, lineupSlots, bestLineup, tradeWeekContext
} from './trade-engine.js';
import { freeAgents, horizonValue } from './waiver-brain.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const LAST_REGULAR_WEEK = 14;

/**
 * What every remaining week actually costs you, solved rather than counted.
 *
 * @returns weeks ranked by damage, each with the players missing and the exact
 *   point loss against a full-strength lineup.
 */
export function byeOutlook(leagueId, { myTeamId = null } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  if (!teams.length) return { error: 'league sync contains no rosters yet' };
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  const { week: now } = tradeWeekContext();
  const full = bestLineup(me.players, slots);

  const weeks = [];
  for (let w = now; w <= LAST_REGULAR_WEEK; w++) {
    const out = me.players.filter(p => p.bye === w);
    if (!out.length) continue;
    const outIds = new Set(out.map(p => p.id));
    const line = bestLineup(me.players.filter(p => !outIds.has(p.id)), slots);
    const cost = r2(full.points - line.points);
    if (cost <= 0.01) continue;                       // covered by depth already

    // Which slot the damage lands in tells you what to go and get.
    const missingStarters = full.slots
      .map(s => s.player).filter(p => p && outIds.has(p.id));
    const holes = line.holes ?? [];

    weeks.push({
      week: w,
      players_out: out.map(p => ({ name: p.name, position: p.position, adj_ppg: p.adj_ppg })),
      starters_out: missingStarters.map(p => ({ name: p.name, position: p.position, adj_ppg: p.adj_ppg })),
      points_lost: cost,
      unfillable_slots: holes,
      severity: holes.length ? 'critical' : cost >= 12 ? 'severe' : cost >= 6 ? 'notable' : 'minor',
      reading: holes.length
        ? `You cannot field a legal lineup in week ${w} — no ${holes.join('/')} on the roster once ` +
          `${missingStarters.map(p => p.name).join(' and ')} ${missingStarters.length === 1 ? 'is' : 'are'} on bye. ` +
          'That is a zero at the slot, not a downgrade.'
        : `Week ${w} costs ${cost} points with ${missingStarters.length || out.length} ` +
          `${missingStarters.length === 1 ? 'starter' : 'starters'} out.`
    });
  }

  weeks.sort((a, b) => b.points_lost - a.points_lost);

  return {
    league: lg.name, from_week: now,
    full_strength_points: r2(full.points),
    weeks,
    worst_week: weeks[0] ?? null,
    total_points_lost: r2(weeks.reduce((s, w) => s + w.points_lost, 0)),
    note: weeks.length
      ? 'Each week is solved, not counted. Three bye-week receivers on a deep roster costs little; ' +
        'one quarterback on a roster carrying exactly one costs everything, and a count of bye-week ' +
        'starters reads those two identically.'
      : 'No remaining bye week costs you anything your bench cannot cover.'
  };
}

/**
 * The cheapest free agent who fixes your worst week.
 *
 * Deliberately scored on the damaged week rather than on season value: the
 * question is not "who is the best available player", it is "who turns a zero
 * into a number in week 11", and those have different answers. A backup
 * quarterback nobody wants is worthless on average and worth twenty points on
 * the one Sunday your starter is off.
 */
export function byePatches(leagueId, { myTeamId = null, limit = 4, pool = 150 } = {}) {
  const outlook = byeOutlook(leagueId, { myTeamId });
  if (outlook.error) return outlook;
  if (!outlook.weeks.length) return { ...outlook, patches: [] };

  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  const { week: now } = tradeWeekContext();

  const available = freeAgents(lg, { limit: pool });
  const patches = [];

  // Only the weeks worth acting on. Patching a two-point dip is roster churn.
  const worthFixing = outlook.weeks.filter(w => w.points_lost >= 5).slice(0, 3);
  for (const [rank, bad] of worthFixing.entries()) {
    const outIds = new Set(me.players.filter(p => p.bye === bad.week).map(p => p.id));
    const remaining = me.players.filter(p => !outIds.has(p.id));
    const damaged = bestLineup(remaining, slots);

    const ranked = available
      // A free agent on the SAME bye is not a patch, which is the single most
      // obvious mistake this could make and the one a season-average ranking
      // would walk straight into.
      .filter(fa => fa.bye !== bad.week)
      .map(fa => {
        const fixed = bestLineup([...remaining, fa], slots);
        return { fa, recovered: r2(fixed.points - damaged.points) };
      })
      .filter(x => x.recovered > 0.25)
      .sort((a, b) => b.recovered - a.recovered)
      .slice(0, limit);

    patches.push({
      week: bad.week,
      points_lost: bad.points_lost,
      severity: bad.severity,
      candidates: ranked.map(x => ({
        name: x.fa.name, position: x.fa.position, team_abbr: x.fa.team_abbr,
        bye: x.fa.bye, adj_ppg: x.fa.adj_ppg,
        season_value: horizonValue(x.fa, now),
        recovers: x.recovered,
        // The whole point of ranking on the damaged week rather than on average.
        why: `Recovers ${x.recovered} of the ${bad.points_lost} points week ${bad.week} costs you` +
          ((x.fa.adj_ppg ?? 0) < 8
            ? ', and he is cheap precisely because he is unremarkable on an average week.'
            : '.')
      })),
      // Only the first is the worst. The loop previously called every week it
      // looked at "your worst remaining week", putting three contradictory
      // sentences on one page.
      reading: ranked.length
        ? (rank === 0
          ? `Week ${bad.week} is your worst remaining week, at ${bad.points_lost} points. `
          : `Week ${bad.week} costs ${bad.points_lost} points. `) +
          `${ranked[0].fa.name} is on the wire and recovers ${ranked[0].recovered} of them.`
        : `Week ${bad.week} costs ${bad.points_lost} points and nothing on the wire fixes it — ` +
          'this one has to come from a trade or be absorbed.'
    });
  }

  return { ...outlook, patches };
}

/**
 * Where one injury ends your season.
 *
 * `injury_dropoff` — what the lineup loses if the best player at a position goes
 * down — has been computed by `selfScout` for as long as it has existed and has
 * never been surfaced or acted on. A team can look strong on every average and
 * still be one hamstring from unstartable at a position, which is a different
 * risk from being thin and needs a different fix (a handcuff, not an upgrade).
 */
export function fragility(leagueId, { myTeamId = null } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your roster could not be resolved from the league sync' };

  const full = bestLineup(me.players, slots);
  const starters = full.slots.map(s => s.player).filter(Boolean);

  const risks = starters.map(p => {
    const without = bestLineup(me.players.filter(x => x.id !== p.id), slots);
    return {
      name: p.name, position: p.position,
      adj_ppg: p.adj_ppg,
      // Availability is already modelled per player; a fragile slot behind a
      // player who misses time often is a much worse combination than either
      // alone, and reporting them together is the only way that shows.
      active_probability: p.active_probability ?? null,
      cost_if_lost: r2(full.points - without.points),
      leaves_hole: (without.holes ?? []).length > 0,
      unfillable: without.holes ?? []
    };
  }).sort((a, b) => b.cost_if_lost - a.cost_if_lost);

  // Expected damage, not worst case: a fragile slot behind a durable player is
  // a smaller problem than a moderate slot behind one who misses a third of the
  // season, and only the product distinguishes them.
  const weighted = risks.map(r => ({
    ...r,
    expected_loss: r2(r.cost_if_lost * (1 - (r.active_probability ?? 0.92)))
  })).sort((a, b) => b.expected_loss - a.expected_loss);

  return {
    league: lg.name,
    full_strength_points: r2(full.points),
    most_fragile: weighted.slice(0, 5),
    critical: weighted.filter(r => r.leaves_hole).map(r => ({
      ...r,
      reading: `Losing ${r.name} leaves you with no startable ${r.unfillable.join('/')} at all. ` +
        'That is not a downgrade, it is an empty slot, and a handcuff off the wire is cheaper than ' +
        'discovering it in week 9.'
    })),
    note: 'Ranked by expected loss — what a slot costs if the player is unavailable, times how often ' +
      'he is. A fragile slot behind a durable player is a smaller problem than a moderate one behind ' +
      'a player who misses time, and only the product separates them.'
  };
}
