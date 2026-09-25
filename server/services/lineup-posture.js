/**
 * Floor or ceiling? The answer depends entirely on who you are playing.
 *
 * Item 5 out of the study. Maximising expected points is the wrong objective
 * for a head-to-head week: if you are a twenty-five point underdog, the safe
 * lineup loses slowly and the volatile one gives you a chance. If you are a
 * heavy favourite, variance is the only way you lose.
 *
 * The size of the effect is worth stating before anyone over-builds on it.
 * P(win) = Phi(edge / sqrt(s1^2 + s2^2)), with the spread now FITTED to real
 * matchup outcomes (see SPREAD_SCALE). A typical live lineup has SD 37.5 and a
 * typical one-for-one bench swap moves it by 1.5 (medians, 46 live rosters,
 * 2026 W2), so for two lineups of that SD:
 *
 *   edge      one swap (SD 37.5->39.0)    two swaps (SD 37.5->40.5)
 *   -25 pts   +0.33pp                     +0.65pp
 *   -15 pts   +0.21pp                     +0.42pp
 *     0 pts    0.00pp                      0.00pp
 *   +15 pts   -0.21pp                     -0.42pp
 *   +25 pts   -0.33pp                     -0.65pp
 *
 * So: real, but small, and only worth mentioning at the extremes. Below
 * MATERIAL_EDGE (23 points) a typical swap is worth less than a third of a
 * percentage point, which is noise next to a projection that is a coin flip
 * between players under a point apart. The engine therefore stays silent in
 * close matchups rather than inventing advice. (An earlier version of this table
 * assumed SD 30 and a 4-point swap; neither was measured, and it overstated the
 * effect about fourfold.)
 *
 * Since the spread is now one positional CV times the projection, a same-position
 * bench player always has a lower mean AND a lower SD than the starter he
 * replaces, so "chase variance" can only come from a cross-position FLEX swap and
 * will rarely fire. That is what the evidence supports: a player's own boom/bust
 * distribution did not predict matchup outcomes any better than his position
 * (SPREAD_SCALE has the numbers), and the old search returned zero swaps on all
 * 46 live rosters anyway.
 *
 * The literature agrees on the sign and on the conditionality: variance helps
 * in best ball (auto-optimal lineups harvest it) and slightly hurts in managed
 * head-to-head, and the favourite/underdog split is why a single pooled number
 * comes out near zero.
 */
import { rows } from '../db/index.js';
import { assetUniverse, tradeWeekContext, pinnedBestLineup, lineupSlots, FLEX_ELIGIBLE } from './trade-engine.js';
import { rosterLocks, lockPins } from './lineup-lock.js';
import { deriveFormat } from './format.js';
import { startSitWeekPoints } from './lineup-brain.js';
import { oneWorldFlag, oneWorldPreviewFields } from './one-world.js';
import { leagueWorld, worldRange, worldStamp } from './league-world.js';
import { leagueLineupWeekRange } from './lineup-week-range.js';

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
 *
 * `week_points` first when a player carries it: lineupPosture() prices both rosters
 * with lineup-brain.js#startSitWeekPoints, the Start/Sit number (current_week_ppg x the
 * betting-line game-script multiplier), so the card and the Start/Sit page show the
 * same lineup at the same total. A caller that passes plain assets (the calibration
 * script, tests of lineupMoments) keeps the old current_week_ppg basis.
 */
function weekPpg(p) {
  return p.week_points ?? p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0;
}

/**
 * Below this edge the advice is not worth giving. DERIVED, 2026-09-18, by a rule
 * written down before it was computed: the smallest edge at which one typical swap
 * moves P(win) by 0.3 percentage points. On the 46 live rosters (2026 W2) under the
 * fitted spread: median lineup SD 37.5; median |SD change| across all 840 legal
 * one-for-one bench swaps 1.48; |Phi(e/sqrt(39.0^2 + 37.5^2)) - Phi(e/sqrt(2 x 37.5^2))|
 * first reaches 0.003 at e = 23. It was 12 when a swap was believed to move the SD
 * by ~4 on a lineup of 30; neither number was measured.
 */
export const MATERIAL_EDGE = 23;
/**
 * One player's weekly spread, relative to his projection: SD = weekPpg x POSITION_CV.
 * Only the SHAPE across positions matters here; the level is SPREAD_SCALE's job.
 * These are the old positional defaults, unchanged — a per-position fit (4 free
 * CVs) did no better out of sample and could not pin the QB value down at all
 * (it ran to the 0.05 search bound), so the shape was left alone.
 */
export const POSITION_CV = { QB: 0.40, RB: 0.57, WR: 0.63, TE: 0.67 };
/**
 * The scale that makes P(win) an honest probability. FITTED, 2026-09-18.
 *
 * What has to be calibrated is not how much scores move but how often a projected
 * edge holds up, i.e. the spread of (actual margin - projected margin).
 * scripts/fit-posture-calibration.mjs measures exactly that, walk-forward: the weekly
 * harness with the live ensemble head, 2023-2025 weeks 5-17, every plausible starter
 * priced the way production prices him (prediction x active probability, a
 * did-not-play counted as the zero it is), 100 synthetic 10-team leagues a week,
 * about 6,500 graded head-to-head matchups a season. Fit on 2023+2024 by Bernoulli
 * log-likelihood (1.6304), validated ONCE on 2025 against the rule it replaces, on a
 * gate written down before the fit:
 *
 *                                        log loss   calibration error (10 bins)
 *   old: own distribution x 1.9           0.6726          0.039
 *   new: POSITION_CV x 1.63                0.6669          0.010
 *   difference, bootstrap clustered by week: -0.0057, 90% CI [-0.0096, -0.0016]
 *
 * In plain terms the old rule pulled every probability toward 50%: when it said
 * 30-40% the team won 26% of the time, when it said 60-70% it won 73%. The new rule
 * says 36% and they win 38%, 64% and they win 65%, 73% and they win 74%. Weeks 2-4
 * (reported, not gated): 0.6732 vs 0.6765, calibration error 0.014 vs 0.042.
 *
 * What replaced what. The old SD was each player's own weekly distribution,
 * (p90 - p10) / 2.56 — every live starter had one — times a 1.9 "correlation
 * inflation" reverse-engineered to hit a team-week CV of 0.28 that nothing in the
 * repo ever measured. With a fitted scale, that distribution spread (x 0.99) and the
 * plain positional CV (x 1.63) came out tied on 2023-24 held-out seasons (log loss
 * 0.66733 vs 0.66716; the pre-registered rule took the lower). So a player's own
 * boom/bust shape carries no measurable information about who wins a matchup beyond
 * his position and projection, and ONE spread source now serves everyone. It is also
 * the source that survives the known flaw in its input: current_week_ppg carries an
 * availability discount averaging ~0.76 on starters who in fact play 98% of weeks,
 * and a positional CV scales with the projection, so edge and SD shrink together and
 * P(win) does not move; a distribution with a 24% spike at zero does not have that
 * property. If the availability model is recalibrated, re-run the script — part of
 * this 1.63 is the noise that discount adds to the edge.
 *
 * Why above 1. Raw lineup misses have SD ~21.5 on these lineups, but the projected
 * edge also overstates the real one (actual on projection, slope 0.87 per player), so
 * the spread that turns an edge into an honest probability is wider, ~26.5.
 * Cross-check: real ESPN team-week scores in league_week_scores (2023-25 regular
 * season, 62 team-seasons, 861 team-weeks, K and DEF included) swing with SD 24.1
 * around a team's own average (CV 0.20). Same order, as it should be; they are not
 * the same quantity, and the fit is on the one P(win) needs.
 */
export const SPREAD_SCALE = 1.63;

/** Standard normal CDF (Abramowitz-Stegun 26.2.17). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const winProb = (edge, sd, oppSd) => normalCdf(edge / Math.sqrt(sd * sd + oppSd * oppSd));

/**
 * A lineup's mean and standard deviation. Exported so that the MATERIAL_EDGE
 * derivation and any test measure the function that ships, not a copy of it.
 */
export function lineupMoments(starters) {
  const mean = starters.reduce((s, p) => s + weekPpg(p), 0);
  let varTotal = 0;
  for (const p of starters) {
    // A player projected for zero this week — on bye, or with no game matched —
    // contributes zero variance. This guard dates from when the spread came from a
    // weekly distribution that was never zeroed for a bye, which handed a
    // non-playing player a full game's spread at zero mean cost: free variance, the
    // exact shape the chase-variance search looks for (672 of 8,640 assets carried
    // current_week_ppg 0 with a live floor/ceiling). A positional CV is zero at a
    // zero projection anyway; the guard stays so a future spread source cannot
    // reintroduce it.
    if (!(weekPpg(p) > 0)) continue;
    // EA-07: `week_sd` is the player's spread in the one world (his pool's SD, the
    // same draws as the card's floor/ceiling and the title odds); without it, the
    // positional CV.
    const spread = Number.isFinite(p.week_sd) ? p.week_sd : weekPpg(p) * (POSITION_CV[p.position] ?? 0.6);
    varTotal += spread * spread;
  }
  // Variances add, then ONE fitted scale (SPREAD_SCALE) turns the sum into the
  // spread that makes P(win) honest. It is a SCALE, not a floor: a floor was tried
  // once and bound every lineup to an identical SD, which erased every difference
  // between lineups. See SPREAD_SCALE for the fit and the evidence.
  return { mean, sd: Math.sqrt(varTotal) * SPREAD_SCALE };
}

/** This week's opponent for a roster, from the synced schedule. */
function opponentFor(payload, rosterId, week) {
  for (const m of payload.schedule ?? []) {
    if (m.matchupPeriodId !== week) continue;
    if (String(m.home?.teamId) === rosterId) return String(m.away?.teamId ?? '');
    if (String(m.away?.teamId) === rosterId) return String(m.home?.teamId ?? '');
  }
  return null;
}

export function rosterAssets(payload, assets, rosterId) {
  const team = (payload.teams ?? []).find(t => String(t.id) === String(rosterId));
  const out = [];
  for (const e of team?.roster?.entries ?? []) {
    const nm = e.playerPoolEntry?.player?.fullName;
    if (!nm) continue;
    const a = [...assets.values()].find(x => String(x.name).toLowerCase() === nm.toLowerCase());
    if (!a || !SCORED.has(a.position)) continue;
    const onIr = e.lineupSlotId === 21 || e.playerPoolEntry?.player?.injuryStatus === 'INJURY_RESERVE';
    if (!onIr) out.push(a);
  }
  return out;
}

/**
 * Posture advice for one team-week.
 *
 * Returns the max-points lineup, its win probability against this specific
 * opponent, and — only when the matchup is lopsided enough to matter — the
 * swaps that trade expected points for the shape the matchup calls for.
 */
/**
 * Roster entries a league does not start. The same notion `trade-engine.js:2596`
 * already encodes for ESPN slot ids ("a starter is ... minus BENCH(20)/IR(21)"),
 * written here as tokens because both platforms' vocabularies reach this field:
 * ESPN emits BENCH/IR (espn-draft.js:80), Sleeper's own spelling is BN, and
 * dynasty leagues add TAXI.
 */
const NON_STARTING_SLOTS = new Set(['BENCH', 'BN', 'IR', 'TAXI']);

/**
 * The scope sentence printed beside the win probability.
 *
 * Its whole job is to describe the number next to it, which is why the parts are
 * computed rather than asserted. The numerator is what `lineupSlots()` prices.
 * The denominator must be the slots the league actually STARTS — not
 * `roster_positions.length`, which counts bench and IR rows too. While ESPN sent
 * starters only those were the same figure; once bench rows arrive they are not,
 * and the old sentence attributed a bench-sized gap to K and DEF.
 *
 * The excluded slots are named from the data for the same reason. Hardcoding "K
 * and DEF" tells an IDP league its DL/LB/DB starters are kickers, and tells a
 * roster with no kicker that it has one. A slot is modelled exactly when
 * `lineupSlots()` keeps it, so that function stays the single definition of what
 * is priced and this reads the answer off it rather than restating the rule.
 */
export function winProbabilityScope(lg, slots) {
  const rosterPositions = JSON.parse(lg.roster_positions ?? '[]');
  const starting = rosterPositions.filter(slot => !NON_STARTING_SLOTS.has(slot));
  // No roster slots on file is not the same as nothing being excluded, and the
  // card must not claim the second when it only knows the first.
  if (!starting.length) {
    return `modelled skill slots only (${slots.length} slots); this league's roster slots are `
      + 'not on file, so what else it starts is unknown';
  }
  const modelled = new Set(lineupSlots(lg));
  const excluded = [...new Set(starting.filter(slot => !modelled.has(slot)))];
  // Read out loud on the card, so it is joined the way a person would say it.
  const named = excluded.length < 2 ? excluded.join('')
    : `${excluded.slice(0, -1).join(', ')} and ${excluded.at(-1)}`;
  return `modelled skill slots only (${slots.length} of ${starting.length} starting slots); `
    + (excluded.length ? `${named} excluded` : 'nothing excluded');
}

export function lineupPosture(lg, { myTeamId, week, now = Date.now() } = {}) {
  if (!lg?.payload) return { error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const ctx = tradeWeekContext();
  const wk = Number(week) || ctx.week;
  const rosterId = String(myTeamId ?? lg.my_team_id);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const slots = lineupSlots(lg);

  // Both rosters priced on the Start/Sit number, betting-line lift included, and both
  // solved on it. The card used to sum raw current_week_ppg: on the 2026-W2 sync its
  // "You" was 0.25-1.98 points off the Start/Sit projection in every league, and in
  // leagues 4 and 5 it started a different FLEX. The lift is priced for the week
  // current_week_ppg describes (tradeWeekContext), exactly as lineupCall does.
  // SPREAD_SCALE was fitted on the unlifted number; the lift is clamped to
  // [0.75, 1.3] and scales a player's mean and SD together, so P(win) moves little,
  // but the fit script should be re-run on this basis (see handoff).
  const oneWorld = oneWorldFlag();
  const world = oneWorld.on ? leagueWorld(lg) : null;
  const worldSd = p => {
    if (!world || world.fail) return {};
    const range = worldRange(lg, p, wk);
    return range ? { week_sd: range.sd } : {};
  };
  const price = players => players.map(p => ({
    ...p, week_points: startSitWeekPoints(p, ctx.season, ctx.week).week_points ?? 0, ...worldSd(p)
  }));
  const mine = price(rosterAssets(payload, assets, rosterId));
  if (!mine.length) return { error: 'could not price your roster' };

  const oppId = opponentFor(payload, rosterId, wk);
  const theirs = oppId ? price(rosterAssets(payload, assets, oppId)) : [];
  // RL-4-2: a player whose game has kicked off (or ESPN already locked) cannot move,
  // on either side. Both lineups are solved with the locked starters held in their
  // slots and the locked bench players out (the same lock rule and pinned solve as
  // the Start/Sit list and the League Hub card: lineup-lock.js,
  // trade-engine.js#pinnedBestLineup). This card used to solve every slot all
  // Sunday, so after 1:00 pm ET its "You" total and its swaps could start a bench
  // player whose game was already under way, on the same page as a Start/Sit list
  // that would not.
  const lockOpts = { season: ctx.season, week: wk, now };
  const myPins = lockPins(rosterLocks(lg, rosterId, mine, lockOpts));
  const oppPins = theirs.length ? lockPins(rosterLocks(lg, oppId, theirs, lockOpts)) : new Map();
  const oppLineup = theirs.length ? pinnedBestLineup(theirs, slots, 'week_points', oppPins) : null;
  // A locked starter flagged out still holds his slot but scores 0, as the pinned
  // solve counts him (unpinned, bestLineup never starts him at all).
  const counted = p => (p.available === false ? { ...p, week_points: 0 } : p);
  // `sd: 30` here was a hardcoded spread for an unpriceable opponent. It is
  // unreachable — the `mean == null` early return below fires first — so it
  // never shipped a number, but it is a live landmine if that return ever
  // moves. Nothing is known about this opponent, so nothing is asserted.
  const oppMoments = oppLineup
    ? lineupMoments(oppLineup.slots.map(s => s.player).filter(Boolean).map(counted))
    : { mean: null, sd: null };

  const best = pinnedBestLineup(mine, slots, 'week_points', myPins);
  const starters = best.slots.map(s => s.player).filter(Boolean).map(counted);
  const startIds = new Set(starters.map(p => p.id));
  const mineMoments = lineupMoments(starters);
  // WEEKLY-RANGE-ONE: the lineup's weekly range (p10 / p50 / p90) is the one producer's,
  // the same numbers the trade card, My team and the ceiling lineup print for this
  // lineup-week. my_sd above is NOT a range: it is the fitted P(win) spread
  // (SPREAD_SCALE), a margin model, and is never turned into a floor or ceiling.
  const weeklyRange = (({ floor, median, ceiling, coverage, percentiles, method, error }) =>
    ({ floor, median, ceiling, coverage, percentiles, method, ...(error ? { error } : {}) }))(
    leagueLineupWeekRange(lg, starters.map(p => p.id), wk));

  if (oppMoments.mean == null) {
    return {
      season: ctx.season, week: wk, roster_id: rosterId, opponent_roster_id: null,
      note: 'No opponent found for this week, so there is no posture to take. Start the highest projection.',
      my_projection: +mineMoments.mean.toFixed(1), my_sd: +mineMoments.sd.toFixed(1),
      weekly_range: weeklyRange,
      lineup: starters.map(p => ({ player: p.name, position: p.position, ppg: weekPpg(p) })),
    };
  }

  // Both spreads are built from `weekPpg(p) > 0` players only, so when the
  // projection pipeline yields nothing both sides price to a mean of 0 and an
  // SD of 0. `winProb` then computes normalCdf(0 / 0), which is NaN, which
  // `toFixed` turns into NaN and JSON turns into null — and the client falls
  // through to printing this function's `note`, a confident sentence about a
  // matchup on which nothing was measured. There is no posture to take on two
  // lineups nobody could price.
  if (!(mineMoments.sd > 0) || !(oppMoments.sd > 0)) {
    return {
      season: ctx.season, week: wk, roster_id: rosterId, opponent_roster_id: oppId,
      error: 'no weekly projections available to price this matchup',
      my_projection: +mineMoments.mean.toFixed(1), opponent_projection: +oppMoments.mean.toFixed(1),
      my_priced: starters.filter(p => weekPpg(p) > 0).length,
      opponent_priced: (oppLineup?.slots ?? []).map(s2 => s2.player).filter(p => p && weekPpg(p) > 0).length,
      lineup: starters.map(p => ({ player: p.name, position: p.position, ppg: weekPpg(p) })),
    };
  }

  const edge = mineMoments.mean - oppMoments.mean;
  const basePwin = winProb(edge, mineMoments.sd, oppMoments.sd);
  const stance = Math.abs(edge) < MATERIAL_EDGE ? 'neutral' : (edge < 0 ? 'chase variance' : 'protect the lead');

  // Candidate swaps: a bench player who costs expected points but changes the
  // shape in the direction the matchup wants.
  //
  // SUBSTITUTE INTO THE SLOT, with eligibility checked. Two wrong versions came
  // before this one. The first swapped names without regard to slot, so a
  // receiver could land in the tight end's spot and leave it empty — the tell
  // was "give up -1.74 points", a free gain, which is impossible if the
  // baseline was already optimal. The second re-solved the lineup after
  // deleting a starter, which is a different question entirely: the solver
  // maximises MEAN, so it always replaced him with the highest-projection bench
  // player and essentially never with the volatile one this module exists to
  // find. That version could not fire at all, and duly returned zero swaps in
  // every league.
  //
  // The right question is "what if I deliberately start him in that slot", so
  // the candidate is built directly and its legality is checked explicitly.
  // Only players the solver itself could start. bestLineup() excludes anyone
  // flagged season-ending or released (available === false); this pool did not,
  // so the swap search offered them as starters. On the 2026-W2 sync that was
  // EVERY swap the module produced — 6 of 6 across the 5 leagues told the user to
  // start Kenneth Walker III or Patrick Mahomes, both out, with a fabricated 1.5-10pp
  // win-probability gain. ESPN's IR slot is a different flag and is handled in
  // rosterAssets(); this is the engine's own season-ending flag.
  // A locked bench player cannot come in (RL-4-2), and a locked starter cannot go
  // out: his slot is skipped below.
  const benchPool = mine.filter(p => !startIds.has(p.id) && p.available !== false && !myPins.has(p.id));
  let artifactsRejected = 0;
  const swaps = [];
  if (stance !== 'neutral') {
    const startingSlots = best.slots.filter(s2 => s2.player);
    for (const slot of startingSlots) {
      const outP = slot.player;
      if (myPins.has(outP.id)) continue;
      // The same eligibility table the solver uses. This used to special-case only
      // the literal 'FLEX', so REC_FLEX, WRRB_FLEX, SUPER_FLEX and OP fell through
      // to `position === slot` and silently yielded no candidates at all.
      const eligible = benchPool.filter(p => (FLEX_ELIGIBLE[slot.slot]
        ? FLEX_ELIGIBLE[slot.slot].includes(p.position)
        : p.position === slot.slot));
      for (const inP of eligible) {
        const next = startingSlots.map(s2 => (s2.player.id === outP.id ? inP : counted(s2.player)));
        const m = lineupMoments(next);
        const p2 = winProb(m.mean - oppMoments.mean, m.sd, oppMoments.sd);
        const delta = (p2 - basePwin) * 100;
        if (delta <= 0.15) continue;                 // below this it is not advice
        // The baseline maximises mean points, so a legal swap can only GIVE UP
        // points. A negative value means the baseline was not optimal for this
        // candidate — an eligibility or availability mismatch — and the "gain" is
        // an artifact, not advice. This is the tell the header of this search
        // describes; it is now enforced rather than remembered.
        if (mineMoments.mean - m.mean < -1e-9) { artifactsRejected++; continue; }
        swaps.push({
          slot: slot.slot,
          start: inP.name, start_position: inP.position, start_ppg: weekPpg(inP),
          instead_of: outP.name, instead_of_ppg: weekPpg(outP),
          points_given_up: +(mineMoments.mean - m.mean).toFixed(2),
          lineup_sd_change: +(m.sd - mineMoments.sd).toFixed(1),
          win_prob_change: +delta.toFixed(2),
          new_win_prob: +(p2 * 100).toFixed(1),
        });
      }
    }
    swaps.sort((a, b) => b.win_prob_change - a.win_prob_change);
  }

  return {
    season: ctx.season, week: wk, roster_id: rosterId, opponent_roster_id: oppId,
    my_projection: +mineMoments.mean.toFixed(1), my_sd: +mineMoments.sd.toFixed(1),
    weekly_range: weeklyRange,
    opponent_projection: +oppMoments.mean.toFixed(1), opponent_sd: +oppMoments.sd.toFixed(1),
    edge: +edge.toFixed(1),
    win_probability: +(basePwin * 100).toFixed(1),
    stance,
    lineup: starters.map(p => ({ player: p.name, position: p.position, ppg: weekPpg(p) })),
    swaps: swaps.slice(0, 5),
    swaps_rejected_as_artifacts: artifactsRejected,
    // Where both SDs come from. There used to be a per-side "coverage" figure here
    // because two spread sources on different scales were mixed; there is one now.
    projection_basis: 'Start/Sit week points: this week\'s projection x the betting-line game-script adjustment',
    sd_model: world && !world.fail
      ? `one-world pool SD per player (EA-07; positional CV where a player has none) x ${SPREAD_SCALE} (scale fitted on the CV basis, not refitted on this one)`
      : `projection x positional CV x ${SPREAD_SCALE} (fitted 2023-24, validated 2025: scripts/fit-posture-calibration.mjs)`,
    ...(world && !world.fail ? { one_world: worldStamp(lg, world), ...oneWorldPreviewFields(oneWorld) } : {}),
    // Scope of the probability. lineupSlots() prices the skill slots only; every
    // synced league also starts a K and a DEF, which are in neither side's mean nor
    // variance. The omission cancels in a DIFFERENCE of two lineups but not in a
    // level and its spread, so this is P(win) over the modelled slots, not over the
    // matchup as scored. SPREAD_SCALE was fitted on the same scope (QB, 2 RB, 2 WR,
    // TE, FLEX graded on their own actual totals), so it is calibrated for exactly
    // the probability printed here; K and DEF add real variance it does not see.
    win_probability_scope: winProbabilityScope(lg, slots),
    note: stance === 'neutral'
      ? `Matchup is within ${MATERIAL_EDGE} points. Posture is worth under a third of a percentage point here — start the highest projections and leave it alone.`
      : edge < 0
        ? `You are a ${Math.abs(edge).toFixed(0)}-point underdog. The safe lineup loses slowly; variance is what gives you a chance.`
        : `You are a ${edge.toFixed(0)}-point favourite. Variance is the only way you lose this — take the floor.`,
  };
}
