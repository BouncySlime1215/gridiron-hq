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
import { assetUniverse, tradeWeekContext, bestLineup, lineupSlots, espnPlayerResolver } from './trade-engine.js';
import { deriveFormat } from './format.js';
import { availabilityDegradation, roleStates, weekDesignation } from './contingency.js';
// The league's wire, one producer shared with the trade engine's lineup value
// (RL-9-3), keyed by the ESPN-id-first resolver (RL-6-4).
import { rosteredAssetIds, unrosteredSkill, onNflTeam } from './league-wire.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';
// The one producer of "this player carries the Sleeper injury flag" (RL-12-2).
import { activeInjuryFlagIds } from './injury-flags.js';

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
/**
 * A player priced through the name fallback (identity_match 'name_position') is never
 * a suggested cut: his price may belong to someone else (RL-6-4). Assets with no
 * identity_match (other callers of chooseClaimCut) are unaffected.
 */
const cuttable = p => p.identity_match !== 'name_position';
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
    if (!cuttable(drop)) continue;
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


/**
 * Claims worth making, for one team.
 *
 * `upgrade` is the projected weekly points a claim adds to the STARTING lineup,
 * which is the only place points are actually scored. A free agent who would
 * sit on the bench is worth zero this week however good he looks in isolation —
 * though `ros_upgrade` keeps the rest-of-season view for stashes.
 */
export function waiverBoard(lg, {
  myTeamId, limit = 20, minProjected = 4, minRosProjected = minProjected, now = new Date(),
  sameTeamOrder: sameTeamOrderArg
} = {}) {
  // PREVIEW-01: the local-testing switch picks snap-share order when the caller did not
  // choose one; each alert's replacements then carry preview:true and the reason.
  const orderPreview = sameTeamOrderArg === undefined && previewUnconfirmed();
  const sameTeamOrder = sameTeamOrderArg === undefined ? (orderPreview ? 'snap_share' : 'projection') : sameTeamOrderArg;
  if (!lg?.payload) return { error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const week = tradeWeekContext();
  // Who each ESPN roster entry is: the ESPN id first, name + position only when no
  // asset carries that id (trade-engine.js#espnPlayerResolver, the resolver
  // loadRosters uses). The name-only join this replaced priced a retired or junk
  // namesake at 0.0 / 0.0 as the suggested cut in all 5 leagues on 2026-W3.
  const resolve = espnPlayerResolver(assets);
  const ownedById = rosteredAssetIds(payload, resolve);
  const rosterId = String(myTeamId ?? lg.my_team_id);
  const slots = lineupSlots(lg);

  const mine = [];
  const team = (payload.teams ?? []).find(t => String(t.id) === rosterId);
  const myEntries = team?.roster?.entries ?? [];
  const unpriced = [];
  const nameFallback = [];
  for (const e of myEntries) {
    const nm = e.playerPoolEntry?.player?.fullName;
    if (!nm) continue;
    const { asset, match } = resolve(e.playerPoolEntry.player);
    if (!asset) { unpriced.push(nm); continue; }
    if (!SCORED.has(asset.position)) continue;
    // Priced through the name fallback: the identity is unconfirmed, so he is shown
    // and counted in the lineup but never offered as a cut (chooseClaimCut, rosBench).
    if (match !== 'espn_id') nameFallback.push(nm);
    const espnStatus = e.playerPoolEntry?.player?.injuryStatus ?? null;
    // ESPN lineup slot 21 is the IR slot. A player parked there does not occupy
    // a bench spot, so he is not a drop candidate — suggesting him is how you
    // lose an injured starter for free.
    mine.push({ ...asset, identity_match: match, espn_status: espnStatus, lineup_slot: e.lineupSlotId ?? null,
      on_ir: e.lineupSlotId === ESPN_SLOT_IR || espnStatus === 'INJURY_RESERVE' });
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
    unpriced_count: unpriced.length,
    // Priced by name + position because no asset carries their ESPN id: never a cut.
    name_fallback: nameFallback
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
  const unownedAll = unrosteredSkill(assets, ownedById);
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
  const rosBench = active.filter(p => !rosStarters.has(p.id) && cuttable(p)).sort(dropOrder(p => p.ros_ppg ?? 0));
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

  // WV-02: my injured starters and who replaces them, before the next waiver run.
  const waiverRun = nextWaiverRun(payload, now);
  const injuryAlerts = injuryReplacementAlerts({
    mine, assets, unowned, ownedById, rosterId, waiverRun, roles: roleStates(week.season, week.week), sameTeamOrder,
    preview: orderPreview
  });

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
    // My starters who are Out / IR / Doubtful (or carry a current feed injury flag
    // with no designation), each with the replacements and the claim deadline.
    injury_alerts: injuryAlerts,
    waiver_run: waiverRun,
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

/* ---------------------------------------------- injury replacement alert (WV-02) */

// ESPN lineup slot ids: 20 is the bench, 21 injured reserve. Any other slot starts.
const ESPN_SLOT_BENCH = 20;
const ESPN_SLOT_IR = 21;
/** Designations (contingency.js#weekDesignation) that raise the alert. IR maps to 'out'. */
export const ALERT_DESIGNATIONS = new Set(['out', 'doubtful']);
const SAME_TEAM_SHOWN = 3;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/**
 * The clock the processing day is read on. ESPN's acquisitionSettings give
 * waiverProcessDays and waiverProcessHour with no zone; US Eastern is a guess, said
 * on the payload (`zone_basis`), not a measured fact.
 */
export const WAIVER_ZONE = 'America/New_York';
export const SNAP_SHARE_BASIS = 'Snap share: his mean offensive snap % over his last three appearances before this '
  + 'week (contingency.js#roleStates, the number the availability role tier uses).';
/**
 * How same-team replacements are ordered. Pre-registered check (docs/tdd/
 * 2026-09-23-injury-replacement-alert.tdd.md, section 5): the snap-share pick beat the
 * recent-points pick in 0.531 of 98 disagreements on 2022-2024, but the mean PPR
 * difference's 90% interval [-0.772, +0.385] crossed the -0.5 non-inferiority margin,
 * so snap-share order ships default-off. Default: this week's projection, the number
 * the claim list ranks on (not itself graded historically).
 */
/** Why snap-share order is default-off; also its preview reason (PREVIEW-01). */
export const SNAP_SHARE_UNCONFIRMED = 'unconfirmed: failed its pre-registered non-inferiority check on 2022-2024';
export const SAME_TEAM_ORDERS = Object.freeze({
  projection: 'Ordered by this week\'s projection. ' + SNAP_SHARE_BASIS,
  snap_share: `Ordered by snap share (${SNAP_SHARE_UNCONFIRMED}). `
    + SNAP_SHARE_BASIS
});

const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: WAIVER_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});

/**
 * The league's next waiver processing run, from the synced ESPN settings
 * (payload.settings.acquisitionSettings, present because the sync asks for
 * view=mSettings, server/routes/leagues.js). The first processing day at or after
 * `now` whose hour has not passed yet. `{ known: false, reason }` when the payload
 * has no such settings: an absence, not "no deadline".
 */
export function nextWaiverRun(payload, now = new Date()) {
  const acq = payload?.settings?.acquisitionSettings ?? null;
  const days = Array.isArray(acq?.waiverProcessDays) ? acq.waiverProcessDays.map(d => String(d).toUpperCase()) : [];
  const hour = Number.isInteger(acq?.waiverProcessHour) ? acq.waiverProcessHour : null;
  if (!days.length || hour == null) {
    return { known: false, reason: 'The synced league carries no acquisition settings (waiver days and hour), '
      + 'so no processing time is shown.' };
  }
  const q = Object.fromEntries(zoneParts.formatToParts(now).map(x => [x.type, x.value]));
  // Calendar days counted from today's date in the zone, so a DST change cannot skip one.
  const today = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day));
  for (let i = 0; i <= 7; i++) {
    const d = new Date(today + i * 86400000);
    const day = WEEKDAYS[d.getUTCDay()];
    if (!days.includes(day)) continue;
    if (i === 0 && Number(q.hour) >= hour) continue;
    return {
      known: true, day, date: d.toISOString().slice(0, 10), hour, zone: WAIVER_ZONE,
      zone_basis: 'guess: ESPN does not state the zone of waiverProcessHour',
      process_days: days, waiver_hours: acq.waiverHours ?? null,
      source: 'ESPN league settings (acquisitionSettings)'
    };
  }
  return { known: false, reason: `None of the listed processing days (${days.join(', ')}) is a weekday name.` };
}

/**
 * Players whose feed injury flag is CURRENT. Table player_metrics, source
 * 'injury_flag', written by syncSleeper (server/routes/aggregates.js) together with
 * the same player's 'sleeper_rank' row in one pass. The writer sets the flag and never
 * clears it, so a flag older than that player's latest rank row is left over from an
 * earlier sync and does not count.
 *
 * Whether a flag counts at all is the one producer's call (services/injury-flags.js
 * #activeInjuryFlagIds, RL-12-2: cleared flags and stale flags on players who have
 * played since are off); the same-sync rank-row check above is kept on top of it.
 */
function currentFeedFlags(ids) {
  if (!ids.length) return new Set();
  const active = activeInjuryFlagIds();
  ids = ids.filter(id => active.has(id));
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(',');
  return new Set(rows(`SELECT f.player_id FROM player_metrics f
                       JOIN player_metrics r ON r.player_id = f.player_id AND r.source = 'sleeper_rank'
                       WHERE f.source = 'injury_flag' AND f.value > 0 AND f.fetched_at >= r.fetched_at
                         AND f.player_id IN (${marks})`, ...ids).map(x => x.player_id));
}

/** This week's designation for a player: the canonical weekDesignation, fed the asset and ESPN inputs. */
function designationOf(p) {
  const d = weekDesignation({
    report: p.injury_status ? { report_status: p.injury_status } : null,
    espnStatus: p.espn_status ?? null
  });
  // weeklyAvailability has already merged ESPN into injury_status when ESPN was more
  // severe ("Out (ESPN)"), which weekDesignation then reads as an NFL row.
  const source = d.source === 'nfl' && /\(ESPN/.test(String(p.injury_status)) ? 'espn' : d.source;
  return { designation: d.designation, source, label: d.report?.report_status ?? p.espn_status ?? null };
}

const teamOf = p => p.team_abbr ?? p.team ?? null;
const round3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

function replacementRow(p, roles, onYourRoster) {
  const role = roles.get(p.id) ?? null;
  return {
    player: p.name, position: p.position, team: teamOf(p),
    snap_share: round3(role?.share ?? null),
    snap_last_seen: role?.last_seen ?? null,
    projected_ppg: +weekPpg(p).toFixed(2),
    ros_ppg: p.ros_ppg ?? null,
    injury_status: p.injury_status ?? null,
    on_your_roster: onYourRoster
  };
}

/** Higher snap share first; no snap share last; then this week's projection. */
const bySnapShare = (a, b) => (b.snap_share ?? -1) - (a.snap_share ?? -1) || b.projected_ppg - a.projected_ppg;
/** Higher projection this week first; then snap share. */
const byProjection = (a, b) => b.projected_ppg - a.projected_ppg || (b.snap_share ?? -1) - (a.snap_share ?? -1);

/**
 * One alert per starter of mine who is Out / IR / Doubtful this week, or who carries
 * a current feed injury flag while no designation exists yet (mid-week, before the
 * report). Replacements: same NFL team and position, free agents or already mine,
 * ranked by snap share; then the best free agent at the position from another team,
 * on this week's projection (the number the claim list ranks on).
 */
export function injuryReplacementAlerts({
  mine, assets, unowned, ownedById, rosterId, waiverRun, roles, sameTeamOrder = 'projection', preview = false
}) {
  if (!SAME_TEAM_ORDERS[sameTeamOrder]) throw new Error(`unknown sameTeamOrder: ${sameTeamOrder}`);
  const order = sameTeamOrder === 'snap_share' ? bySnapShare : byProjection;
  const starters = mine.filter(p => p.lineup_slot != null
    && p.lineup_slot !== ESPN_SLOT_BENCH && p.lineup_slot !== ESPN_SLOT_IR);
  const flagged = currentFeedFlags(starters.map(p => p.id));
  const healthy = p => p.available !== false && !ALERT_DESIGNATIONS.has(designationOf(p).designation);
  const mineById = new Map(mine.map(p => [p.id, p]));
  const alerts = [];
  for (const s of starters) {
    const d = designationOf(s);
    const trigger = ALERT_DESIGNATIONS.has(d.designation) ? d.source
      : d.designation == null && flagged.has(s.id) ? 'feed_flag' : null;
    if (!trigger) continue;
    const team = teamOf(s);
    const sameTeam = team == null ? [] : [...assets.values()]
      .filter(a => a.id !== s.id && a.position === s.position && teamOf(a) === team)
      .map(a => mineById.get(a.id) ?? a)
      .filter(a => {
        const holder = ownedById.get(a.id);
        return (holder == null || holder === rosterId) && healthy(a);
      })
      .map(a => replacementRow(a, roles, mineById.has(a.id)))
      .sort(order);
    const bestFree = unowned
      .filter(a => a.position === s.position && teamOf(a) !== team && healthy(a))
      .sort((a, b) => weekPpg(b) - weekPpg(a))[0] ?? null;
    alerts.push({
      player: s.name, position: s.position, team, lineup_slot: s.lineup_slot,
      designation: d.designation, designation_source: trigger, status: d.label,
      snap_share: round3(roles.get(s.id)?.share ?? null),
      replacements: {
        same_team: sameTeam.slice(0, SAME_TEAM_SHOWN),
        same_team_count: sameTeam.length,
        order: sameTeamOrder,
        ranked_by: SAME_TEAM_ORDERS[sameTeamOrder],
        ...(preview ? previewFields(SNAP_SHARE_UNCONFIRMED) : {}),
        best_free_agent: bestFree ? replacementRow(bestFree, roles, false) : null
      },
      claim_by: waiverRun
    });
  }
  return alerts;
}
