/**
 * The waiver wire, ranked by what a claim is actually worth.
 *
 * Item 3 out of the study, and the first one to clear its gate. Measured in the
 * replay as a within-league contrast — some teams work the wire, others sit:
 *
 *   3 of 10 teams churn   +3.45pp of all-play   positive in 5 of 5 seasons
 *   5 of 10 teams churn   +2.27pp               positive in 5 of 5 seasons
 *
 * Both clear the pre-registered minimum effect of 0.010 and the 4-of-5 sign
 * rule, and the edge decays as more of the league does it — the same crowding
 * the draft-strategy results showed. For scale, the strongest draft-structure
 * effect was +6.1pp, once a year. This is available every week.
 *
 * The first attempt at that measurement returned nothing, for a reason worth
 * recording: all-play is zero-sum inside a league, so a league where EVERY team
 * churns averages 0.500 by construction. The contrast has to be between teams
 * in the same league.
 *
 * WHAT THIS RANKS BY. Not a free agent's raw projection — the upgrade he
 * represents over the player he would replace. A 9-point receiver is worth
 * nothing to a roster whose worst bench player already projects 9. The replay's
 * winning policy was exactly this and nothing cleverer: drop the weakest bench
 * player, add the best available, by projected points.
 */
import { rows } from '../db/index.js';
import { assetUniverse, tradeWeekContext, bestLineup, lineupSlots } from './trade-engine.js';
import { deriveFormat } from './format.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * Which number to rank on, and why it matters.
 *
 * `adj_ppg` is a 25%-this-week / 75%-rest-of-season blend built for the TRADE
 * horizon. `current_week_ppg` is this Sunday's matchup-adjusted projection.
 * They differ by about 5 points a player on a typical week — larger than the
 * projection's own error — and on a bye `current_week_ppg` is 0 while `adj_ppg`
 * is not, so ranking a one-week decision on the season blend will happily start
 * a player who is not playing.
 *
 * So: week decisions rank on `weekPpg`, season/trade decisions on `adj_ppg`.
 */
function weekPpg(p) {
  return p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0;
}


/** Every player rostered anywhere in the league, by normalised name. */
function rosteredNames(payload) {
  const owned = new Map();
  for (const team of payload.teams ?? []) {
    for (const e of team.roster?.entries ?? []) {
      const nm = e.playerPoolEntry?.player?.fullName;
      if (nm) owned.set(nm.toLowerCase(), String(team.id));
    }
  }
  return owned;
}

/**
 * Claims worth making, for one team.
 *
 * `upgrade` is the projected weekly points a claim adds to the STARTING lineup,
 * which is the only place points are actually scored. A free agent who would
 * sit on the bench is worth zero this week however good he looks in isolation —
 * though `ros_upgrade` keeps the rest-of-season view for stashes.
 */
export function waiverBoard(lg, { myTeamId, limit = 20, minProjected = 4 } = {}) {
  if (!lg?.payload) return { error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const week = tradeWeekContext();
  const owned = rosteredNames(payload);
  const rosterId = String(myTeamId ?? lg.my_team_id);
  const slots = lineupSlots(lg);

  // My roster, priced.
  const mine = [];
  const team = (payload.teams ?? []).find(t => String(t.id) === rosterId);
  for (const e of team?.roster?.entries ?? []) {
    const nm = e.playerPoolEntry?.player?.fullName;
    if (!nm) continue;
    const asset = [...assets.values()].find(a => String(a.name).toLowerCase() === nm.toLowerCase());
    if (!asset || !SCORED.has(asset.position)) continue;
    const espnStatus = e.playerPoolEntry?.player?.injuryStatus ?? null;
    // ESPN lineup slot 21 is the IR slot. A player parked there does not occupy
    // a bench spot, so he is not a drop candidate — suggesting him is how you
    // lose an injured starter for free.
    mine.push({ ...asset, espn_status: espnStatus, on_ir: e.lineupSlotId === 21 || espnStatus === 'INJURY_RESERVE' });
  }
  if (!mine.length) return { error: 'could not price your roster' };

  const active = mine.filter(p => !p.on_ir);
  const baseline = bestLineup(active, slots, 'current_week_ppg');
  const baselinePoints = baseline.points ?? 0;
  const starters = new Set(baseline.slots.map(s => s.player?.id).filter(Boolean));
  const bench = active.filter(p => !starters.has(p.id))
    .sort((a, b) => weekPpg(a) - weekPpg(b));

  // Free agents: priced by our own model, not on anyone's roster.
  const free = [...assets.values()].filter(a =>
    SCORED.has(a.position)
    && !owned.has(String(a.name).toLowerCase())
    && weekPpg(a) >= minProjected
    && a.available !== false);

  // Rest-of-season baseline, solved the same way. This is what makes a stash
  // meaningful: a fourth quarterback cannot improve a lineup that starts one,
  // however good his raw projection looks next to the worst man on the bench.
  const rosBaseline = bestLineup(active, slots, 'ros_ppg').points ?? 0;

  const board = [];
  for (const fa of free) {
    // What the lineup scores if he is added and the weakest bench player goes.
    const drop = bench[0] ?? null;
    const afterRoster = [...active.filter(p => p.id !== drop?.id), fa];
    const after = bestLineup(afterRoster, slots, 'current_week_ppg');
    const upgrade = (after.points ?? 0) - baselinePoints;
    const rosAfter = bestLineup(afterRoster, slots, 'ros_ppg').points ?? 0;
    board.push({
      player: fa.name, position: fa.position, team: fa.team_abbr ?? fa.team,
      projected_ppg: +weekPpg(fa).toFixed(2),
      ros_ppg: fa.ros_ppg ?? null,
      value: fa.value ?? null,
      injury_status: fa.injury_status ?? null,
      active_probability: fa.active_probability ?? null,
      // Points added to the STARTING lineup this week.
      upgrade: +upgrade.toFixed(2),
      // Whether he would actually start, which is what makes the upgrade real.
      would_start: (after.slots ?? []).some(s => s.player?.id === fa.id),
      drop_candidate: drop ? { player: drop.name, position: drop.position, ppg: +weekPpg(drop).toFixed(2) } : null,
      // A stash: no help this week, but a better rest-of-season lineup.
      ros_upgrade: +(rosAfter - rosBaseline).toFixed(2),
    });
  }

  board.sort((a, b) => b.upgrade - a.upgrade || (b.ros_upgrade ?? 0) - (a.ros_upgrade ?? 0));
  const starts = board.filter(b => b.upgrade > 0.05);
  const stashes = board.filter(b => b.upgrade <= 0.05 && (b.ros_upgrade ?? 0) > 0.5)
    .sort((a, b) => (b.ros_upgrade ?? 0) - (a.ros_upgrade ?? 0));

  return {
    season: week.season, week: week.week, roster_id: rosterId,
    baseline_points: +baselinePoints.toFixed(2),
    free_agents_considered: free.length,
    // Live players: how many of my roster are expected to actually play. The
    // replay's strongest in-season relationship — 5 live at week 14 was 0.443
    // all-play, 14 live was 0.553.
    live_players: active.filter(p => (p.active_probability ?? 1) >= 0.5).length,
    roster_size: active.length,
    on_ir: mine.filter(p => p.on_ir).map(p => p.name),
    immediate: starts.slice(0, limit),
    stashes: stashes.slice(0, Math.max(5, Math.floor(limit / 2))),
    note: starts.length
      ? `${starts.length} free agents would improve this week's starting lineup.`
      : 'No free agent improves the starting lineup this week; stashes below are rest-of-season plays.',
  };
}
