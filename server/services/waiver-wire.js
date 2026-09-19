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
 *
 * "Weakest" is now judged on the rest of the season as well as this week (see
 * chooseClaimCut): the replay's projection was one number for both horizons, while
 * the live board has a week number that can be one game (at week 2) and a separate
 * rest-of-season number, and cutting on the week alone released good players after
 * one bad game.
 */
import { rows } from '../db/index.js';
import { assetUniverse, tradeWeekContext, bestLineup, lineupSlots } from './trade-engine.js';
import { deriveFormat } from './format.js';
// The app's canonical name normaliser. This file used to compare raw
// `toLowerCase()` strings, which meant a typographic apostrophe on one side and
// a straight one on the other never matched: Ja'Marr Chase, De'Von Achane,
// D'Andre Swift and five more were dropped from your roster AND offered back to
// you as free agents. Every other consumer in the app already normalises.
import { normalizePlayerName } from './player-identity.js';
import { availabilityDegradation } from './contingency.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * THE CUT FOR AN IMMEDIATE CLAIM. Rule written down 2026-09-18 before it was run on
 * the live leagues (scratch step1b/decision-leftovers/GATE.md, check C2):
 *
 *   (a) never cut a player worth more over the rest of the season (ros_ppg) than the
 *       player claimed. A player the engine flags out for the season or released
 *       (available === false) counts as 0 there: he is the one genuinely free cut,
 *       whatever stale number he still carries;
 *   (b) never cut a player whose loss lowers the rest-of-season lineup (bestLineup on
 *       ros_ppg, after the add);
 *   (c) the claim must still improve THIS week's starting lineup by more than
 *       MIN_GAIN;
 *   (d) among cuts meeting (a)-(c): the largest week gain, then the highest
 *       rest-of-season lineup after, then the lowest rest-of-season value, then the
 *       lowest week number.
 *
 * Any active rostered player is a candidate, not only this week's bench: a bench cut
 * always keeps the full week gain, so (d) prefers one, but when none is safe,
 * replacing a weak starter can be. A free agent with no cut meeting (a)-(c) is not an
 * immediate claim; he is listed in `held_back` with the gain and the cut the old rule
 * would have used.
 *
 * Why. The cut used to be the bench player with the lowest THIS-WEEK number, which
 * turns one bad game into a release: Jaylen Waddle (1.2 points in week 1, a 9.9
 * rest-of-season player) was the suggested cut for Jalen Coker in leagues 1 and 2 at
 * 2026 week 2. And a cut chosen on the week alone ignored what it cost later: on the
 * week-2 sync, 16 of league 3's claims cut Tyler Warren and lowered the
 * rest-of-season lineup by 0.4-0.6 points a week.
 */
export const MIN_GAIN = 0.05;
const TIE = 0.005;
const seasonValue = p => (p.available === false ? 0 : (p.ros_ppg ?? 0));
export const DROP_RULE = 'An immediate claim cuts the player whose loss keeps this week\'s gain and costs the ' +
  'rest of season least: never someone worth more over the rest of season than the player claimed, and never ' +
  'someone whose loss lowers your rest-of-season lineup. A claim with no such cut is held back.';

/** Is cut `a` better than cut `b` under rule (d)? */
function betterCut(a, b) {
  if (Math.abs(a.week - b.week) > TIE) return a.week > b.week;
  if (Math.abs(a.rosAfter - b.rosAfter) > TIE) return a.rosAfter > b.rosAfter;
  if (Math.abs(seasonValue(a.drop) - seasonValue(b.drop)) > TIE) return seasonValue(a.drop) < seasonValue(b.drop);
  return weekPpg(a.drop) < weekPpg(b.drop);
}

/**
 * The cut for claiming `fa` onto `active`, under the rule above.
 * Returns { safe, unsafe }: the chosen safe cut (or null) and the best cut by week gain
 * alone (or null when the claim cannot help this week at all), each as
 * { drop, week, rosAfter }.
 */
export function chooseClaimCut(active, fa, slots, weekBase, rosBase) {
  // No cut can beat keeping everyone: if the add alone does not help this week, stop.
  if ((bestLineup([...active, fa], slots, 'current_week_ppg').points ?? 0) - weekBase <= MIN_GAIN) {
    return { safe: null, unsafe: null };
  }
  let safe = null, unsafe = null;
  for (const drop of active) {
    const after = [...active.filter(p => p.id !== drop.id), fa];
    const week = (bestLineup(after, slots, 'current_week_ppg').points ?? 0) - weekBase;
    if (!(week > MIN_GAIN)) continue;                                   // (c)
    const cut = { drop, week, rosAfter: bestLineup(after, slots, 'ros_ppg').points ?? 0 };
    if (!unsafe || cut.week > unsafe.week + TIE
      || (Math.abs(cut.week - unsafe.week) <= TIE && weekPpg(drop) < weekPpg(unsafe.drop))) unsafe = cut;
    if (seasonValue(drop) > (fa.ros_ppg ?? 0) + 1e-9) continue;         // (a)
    if (cut.rosAfter < rosBase - 1e-9) continue;                        // (b)
    if (!safe || betterCut(cut, safe)) safe = cut;                      // (d)
  }
  return { safe, unsafe };
}

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
      if (nm) owned.set(normalizePlayerName(nm), String(team.id));
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
export function waiverBoard(lg, { myTeamId, limit = 20, minProjected = 4, minRosProjected = minProjected } = {}) {
  if (!lg?.payload) return { error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const week = tradeWeekContext();
  const owned = rosteredNames(payload);
  const rosterId = String(myTeamId ?? lg.my_team_id);
  const slots = lineupSlots(lg);

  // My roster, priced. Indexed once by normalised name rather than a linear
  // scan of the asset universe per roster entry.
  const assetByName = new Map();
  for (const a of assets.values()) assetByName.set(normalizePlayerName(a.name), a);
  const mine = [];
  const team = (payload.teams ?? []).find(t => String(t.id) === rosterId);
  const myEntries = team?.roster?.entries ?? [];
  const unpriced = [];
  for (const e of myEntries) {
    const nm = e.playerPoolEntry?.player?.fullName;
    if (!nm) continue;
    const asset = assetByName.get(normalizePlayerName(nm));
    if (!asset) { unpriced.push(nm); continue; }
    if (!SCORED.has(asset.position)) continue;
    const espnStatus = e.playerPoolEntry?.player?.injuryStatus ?? null;
    // ESPN lineup slot 21 is the IR slot. A player parked there does not occupy
    // a bench spot, so he is not a drop candidate — suggesting him is how you
    // lose an injured starter for free.
    mine.push({ ...asset, espn_status: espnStatus, on_ir: e.lineupSlotId === 21 || espnStatus === 'INJURY_RESERVE' });
  }
  if (!mine.length) return { error: 'could not price your roster' };
  // Pricing SOME of the roster used to be indistinguishable from pricing all of
  // it: baseline_points, roster_size, live_players and every upgrade below are
  // measured against whatever survived the join, with nothing saying how much
  // of your team that was. A board built on half a roster recommends claims you
  // do not need and cuts you cannot afford.
  const rosterCoverage = {
    entries_in_payload: myEntries.length,
    priced: mine.length,
    unpriced: unpriced.slice(0, 10),
    unpriced_count: unpriced.length
  };

  const active = mine.filter(p => !p.on_ir);
  const baseline = bestLineup(active, slots, 'current_week_ppg');
  const baselinePoints = baseline.points ?? 0;
  // Drop order for the STASH cut: anyone the engine has flagged season-ending or
  // released goes FIRST. They are excluded from bestLineup, so they always land on the
  // bench — and the old ascending-projection sort put a season-ending player with a
  // stale high projection LAST, making the one genuinely free cut the one never
  // suggested (Kenneth Walker III: available false, current_week_ppg 22.99). The
  // immediate claim's cut has its own rule, chooseClaimCut() above, which reaches the
  // same answer for such a player through seasonValue() = 0.
  const dropOrder = field => (a, b) =>
    (a.available === false ? 0 : 1) - (b.available === false ? 0 : 1) || field(a) - field(b);

  // Free agents: priced by our own model, not on anyone's roster. The week gate
  // and the rest-of-season gate are separate. The single weekPpg gate used to run
  // BEFORE the stash list was built, so it also gated the stash list — a
  // rest-of-season question — and a free agent on bye, or with this week's number
  // suppressed by an availability discount, never reached the board at all: 294
  // free agents per league had current_week_ppg < 4 and ros_ppg >= 6. The bye week
  // was precisely when a good stash was invisible.
  //
  // A free agent with no NFL team is not on the board at all. He cannot score until
  // someone signs him (current_week_ppg is 0 by construction: no game), so he was
  // never an immediate claim — but his rest-of-season number is the last team's role,
  // and on the 2026-W2 sync such players were 17 of the 21 stash rows across the five
  // leagues (all ten of league 2's: out-of-work or retired quarterbacks at 13-16 a
  // week). The rows this takes off the board are counted in `teamless_excluded`
  // (below, once the stash cut is known), so the page can say so.
  const unownedAll = [...assets.values()].filter(a =>
    SCORED.has(a.position)
    && !owned.has(normalizePlayerName(a.name))
    && a.available !== false);
  const onNflTeam = a => Boolean(a.team_abbr ?? a.team);
  const unowned = unownedAll.filter(onNflTeam);
  // How much of the pool is priced at all. Distinguishes "the wire is thin"
  // from "nothing on the wire has a number", which read identically before.
  const pricedPool = unowned.filter(a => weekPpg(a) > 0 || (a.ros_ppg ?? 0) > 0).length;
  const passesWeek = a => weekPpg(a) >= minProjected;
  const passesRos = a => (a.ros_ppg ?? 0) >= minRosProjected;
  const free = unowned.filter(a => passesWeek(a) || passesRos(a));

  // Rest-of-season baseline, solved the same way. This is what makes a stash
  // meaningful: a fourth quarterback cannot improve a lineup that starts one,
  // however good his raw projection looks next to the worst man on the bench.
  const rosBaselineLineup = bestLineup(active, slots, 'ros_ppg');
  const rosBaseline = rosBaselineLineup.points ?? 0;
  // The stash question needs its OWN drop candidate. ros_upgrade used to be
  // measured after cutting the player chosen on THIS WEEK's number, which on 10
  // of 46 synced rosters was not the weakest rest-of-season player — e.g. cutting
  // Jonathon Brooks (this week 1.82, ros 7.12) instead of Rachaad White (3.83, 5.11)
  // — so every stash figure on those rosters was biased low, most of all for the
  // hurt-now-good-later players the stash list exists to find.
  const rosStarters = new Set(rosBaselineLineup.slots.map(s => s.player?.id).filter(Boolean));
  const rosBench = active.filter(p => !rosStarters.has(p.id)).sort(dropOrder(p => p.ros_ppg ?? 0));
  const rosDropForStash = rosBench[0] ?? null;
  const rosAfterWith = fa =>
    bestLineup([...active.filter(p => p.id !== rosDropForStash?.id), fa], slots, 'ros_ppg').points ?? 0;
  // Teamless free agents who would otherwise have been a stash (they score 0 this
  // week, so never a claim): the rows the no-team rule actually takes off the board.
  // Counting every unsigned player instead said "308 left off" in every league on
  // the live copy, nearly all of them retired.
  const teamlessExcluded = unownedAll.filter(a => !onNflTeam(a) && passesRos(a)
    && rosAfterWith(a) - rosBaseline > 0.5).length;

  const board = [];
  const heldBack = [];
  for (const fa of free) {
    // The immediate claim: what the lineup scores this week if he is added and the
    // cut chosen by the rule above goes. No safe cut, no immediate claim.
    const { safe, unsafe } = chooseClaimCut(active, fa, slots, baselinePoints, rosBaseline);
    const drop = safe?.drop ?? null;
    const after = safe ? bestLineup([...active.filter(p => p.id !== drop.id), fa], slots, 'current_week_ppg') : null;
    const upgrade = safe ? safe.week : 0;
    if (!safe && unsafe && passesWeek(fa)) {
      heldBack.push({
        player: fa.name, position: fa.position, team: fa.team_abbr ?? fa.team,
        ros_ppg: fa.ros_ppg ?? null,
        // What he would add this week, and the cut chosen on this week's number alone.
        week_upgrade: +unsafe.week.toFixed(2),
        would_cut: { player: unsafe.drop.name, position: unsafe.drop.position,
          ppg: +weekPpg(unsafe.drop).toFixed(2), ros_ppg: unsafe.drop.ros_ppg ?? null },
        why: seasonValue(unsafe.drop) > (fa.ros_ppg ?? 0) + 1e-9
          ? `${unsafe.drop.name} is worth more over the rest of season (${fmt(seasonValue(unsafe.drop))} a week) than ${fa.name} (${fmt(fa.ros_ppg ?? 0)}), and no other cut keeps this week's gain without costing the season.`
          : `Every cut that keeps this week's gain lowers your rest-of-season lineup.`,
      });
    }
    const rosDrop = rosDropForStash;
    const rosAfter = rosAfterWith(fa);
    board.push({
      player: fa.name, position: fa.position, team: fa.team_abbr ?? fa.team,
      projected_ppg: +weekPpg(fa).toFixed(2),
      ros_ppg: fa.ros_ppg ?? null,
      value: fa.value ?? null,
      injury_status: fa.injury_status ?? null,
      active_probability: fa.active_probability ?? null,
      // Points added to the STARTING lineup this week, after the rule's cut; 0 when
      // there is no safe cut.
      upgrade: +upgrade.toFixed(2),
      // Whether he would actually start, which is what makes the upgrade real.
      would_start: (after?.slots ?? []).some(s => s.player?.id === fa.id),
      drop_candidate: drop ? { player: drop.name, position: drop.position, ppg: +weekPpg(drop).toFixed(2),
        ros_ppg: drop.ros_ppg ?? null } : null,
      // What the claim-and-cut does to the rest-of-season lineup: never negative.
      ros_change: safe ? +(safe.rosAfter - rosBaseline).toFixed(2) : null,
      // A stash: no help this week, but a better rest-of-season lineup.
      ros_upgrade: +(rosAfter - rosBaseline).toFixed(2),
      // The cut the stash figure assumes. When it differs from drop_candidate, the
      // immediate claim and the stash claim imply different cuts, and the card
      // should say so rather than pretend there is one answer.
      ros_drop_candidate: rosDrop ? { player: rosDrop.name, position: rosDrop.position,
        ros_ppg: rosDrop.ros_ppg ?? null } : null,
      passes_week_gate: passesWeek(fa),
      passes_ros_gate: passesRos(fa),
    });
  }

  board.sort((a, b) => b.upgrade - a.upgrade || (b.ros_upgrade ?? 0) - (a.ros_upgrade ?? 0));
  // Each list keeps its own gate: the immediate list exactly as before (week
  // projection >= minProjected), the stash list on the rest-of-season projection.
  const starts = board.filter(b => b.passes_week_gate && b.upgrade > MIN_GAIN);
  const stashes = board.filter(b => b.passes_ros_gate && b.upgrade <= MIN_GAIN && (b.ros_upgrade ?? 0) > 0.5)
    .sort((a, b) => (b.ros_upgrade ?? 0) - (a.ros_upgrade ?? 0));
  heldBack.sort((a, b) => b.week_upgrade - a.week_upgrade);

  // Where the chance-to-play numbers came from. lineup-brain.js has surfaced
  // this since review-fixes-2 and this board never did, so `live_players` below
  // was presented as a measured count when every player behind it carried the
  // same hand-set constant.
  const availabilityBasis = assets.context?.availability_basis ?? null;

  return {
    season: week.season, week: week.week, roster_id: rosterId,
    baseline_points: +baselinePoints.toFixed(2),
    free_agents_considered: free.length,
    pool_size: unowned.length,
    pool_priced: pricedPool,
    roster_coverage: rosterCoverage,
    availability_basis: availabilityBasis,
    availability_note: availabilityDegradation(availabilityBasis),
    // Live players: how many of my roster are expected to actually play. The
    // replay's strongest in-season relationship — 5 live at week 14 was 0.443
    // all-play, 14 live was 0.553.
    live_players: active.filter(p => (p.active_probability ?? 1) >= 0.5).length,
    roster_size: active.length,
    on_ir: mine.filter(p => p.on_ir).map(p => p.name),
    immediate: starts.slice(0, limit),
    stashes: stashes.slice(0, Math.max(5, Math.floor(limit / 2))),
    // How an immediate claim's cut is chosen, and the claims no safe cut exists for.
    drop_rule: DROP_RULE,
    held_back: heldBack.slice(0, 5),
    held_back_count: heldBack.length,
    // Free agents left off the board because they have no NFL team.
    teamless_excluded: teamlessExcluded,
    // An unpriceable pool is a statement about the data, not about the wire.
    // Saying "no free agent improves your lineup" when not one of them carries
    // a projection reports a total outage as a finding about your roster.
    note: (pricedPool === 0
      ? `Not one of the ${unowned.length} available players carries a projection this week, so nothing was compared. That is missing data, not an empty wire.`
      : starts.length
        ? `${starts.length} free agents would improve this week's starting lineup.`
        : 'No free agent improves the starting lineup this week; stashes below are rest-of-season plays.')
      + (heldBack.length
        ? ` ${heldBack.length} more would help this week only by cutting someone worth more over the rest of season, so they are held back.`
        : ''),
  };
}

const fmt = v => (Number.isFinite(+v) ? (+v).toFixed(1) : '—');
