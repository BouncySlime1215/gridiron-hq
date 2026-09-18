/**
 * Floor or ceiling? The answer depends entirely on who you are playing.
 *
 * Item 5 out of the study. Maximising expected points is the wrong objective
 * for a head-to-head week: if you are a twenty-five point underdog, the safe
 * lineup loses slowly and the volatile one gives you a chance. If you are a
 * heavy favourite, variance is the only way you lose.
 *
 * The size of the effect is worth stating before anyone over-builds on it.
 * Two lineups with the same mean, mine at SD 30 against an opponent at SD 30,
 * P(win) = Phi(edge / sqrt(s1^2 + s2^2)):
 *
 *   edge      one boom/bust swap (SD 30->34)    two swaps (SD 30->40)
 *   -25 pts   +1.3pp                            +3.1pp
 *   -15 pts   +0.9pp                            +2.0pp
 *     0 pts    0.0pp                             0.0pp
 *   +15 pts   -0.9pp                            -2.0pp
 *   +25 pts   -1.3pp                            -3.1pp
 *
 * So: real, free, and only worth acting on at the extremes. Inside about five
 * points of even it is worth less than a third of a percentage point, which is
 * noise next to a projection that is a coin flip between players under a point
 * apart. The engine therefore stays silent in close matchups rather than
 * inventing advice.
 *
 * The literature agrees on the sign and on the conditionality: variance helps
 * in best ball (auto-optimal lineups harvest it) and slightly hurts in managed
 * head-to-head, and the favourite/underdog split is why a single pooled number
 * comes out near zero.
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

/** Below this edge the advice is not worth giving. */
export const MATERIAL_EDGE = 12;
/** Observed coefficient of variation of a team-week score, from the replay. */
export const TEAM_WEEK_CV = 0.28;

/** Standard normal CDF (Abramowitz-Stegun 26.2.17). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const winProb = (edge, sd, oppSd) => normalCdf(edge / Math.sqrt(sd * sd + oppSd * oppSd));

/** A lineup's mean and standard deviation, from each player's own spread. */
function lineupMoments(starters) {
  const mean = starters.reduce((s, p) => s + weekPpg(p), 0);
  // Players are close to independent week to week once the QB stack is set
  // aside, so variances add. Using each player's own floor/ceiling spread when
  // we have it, and a positional default when we do not.
  const DEFAULT_CV = { QB: 0.40, RB: 0.57, WR: 0.63, TE: 0.67 };
  let varTotal = 0;
  for (const p of starters) {
    const spread = (p.ceiling != null && p.floor != null && p.ceiling > p.floor)
      ? (p.ceiling - p.floor) / 2.56                 // p90-p10 spans 2.56 SD
      : weekPpg(p) * (DEFAULT_CV[p.position] ?? 0.6);
    varTotal += spread * spread;
  }
  // Independence understates a real lineup. Measured in the replay, team-week
  // scores have a CV near 0.28, so a 120-point lineup has SD near 34; summing
  // independent player variances gives about half that. Players share a week's
  // game environment (pace, weather, blowouts) and a QB shares outcomes with
  // his own receivers. Without that correction P(win) comes out far too
  // confident — a 43-point underdog was being told 5% when the honest answer is
  // closer to 15%.
  const independent = Math.sqrt(varTotal);
  const target = mean * TEAM_WEEK_CV;
  return { mean, sd: Math.max(independent, target) };
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

function rosterAssets(payload, assets, rosterId) {
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
export function lineupPosture(lg, { myTeamId, week } = {}) {
  if (!lg?.payload) return { error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const ctx = tradeWeekContext();
  const wk = Number(week) || ctx.week;
  const rosterId = String(myTeamId ?? lg.my_team_id);
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const slots = lineupSlots(lg);

  const mine = rosterAssets(payload, assets, rosterId);
  if (!mine.length) return { error: 'could not price your roster' };

  const oppId = opponentFor(payload, rosterId, wk);
  const theirs = oppId ? rosterAssets(payload, assets, oppId) : [];
  const oppLineup = theirs.length ? bestLineup(theirs, slots, 'current_week_ppg') : null;
  const oppMoments = oppLineup
    ? lineupMoments(oppLineup.slots.map(s => s.player).filter(Boolean))
    : { mean: null, sd: 30 };

  const best = bestLineup(mine, slots, 'current_week_ppg');
  const starters = best.slots.map(s => s.player).filter(Boolean);
  const startIds = new Set(starters.map(p => p.id));
  const mineMoments = lineupMoments(starters);

  if (oppMoments.mean == null) {
    return {
      season: ctx.season, week: wk, roster_id: rosterId, opponent_roster_id: null,
      note: 'No opponent found for this week, so there is no posture to take. Start the highest projection.',
      my_projection: +mineMoments.mean.toFixed(1), my_sd: +mineMoments.sd.toFixed(1),
      lineup: starters.map(p => ({ player: p.name, position: p.position, ppg: weekPpg(p) })),
    };
  }

  const edge = mineMoments.mean - oppMoments.mean;
  const basePwin = winProb(edge, mineMoments.sd, oppMoments.sd);
  const stance = Math.abs(edge) < MATERIAL_EDGE ? 'neutral' : (edge < 0 ? 'chase variance' : 'protect the lead');

  // Candidate swaps: a bench player who costs expected points but changes the
  // shape in the direction the matchup wants.
  const bench = mine.filter(p => !startIds.has(p.id));
  const swaps = [];
  if (stance !== 'neutral') {
    for (const inP of bench) {
      for (const outP of starters) {
        // RE-SOLVE, do not substitute. Swapping a receiver's name into a tight
        // end's slot leaves that slot empty and reports a lineup that cannot be
        // set — it was producing "give up -1.74 points", i.e. a free gain, which
        // is the tell that the substitution was illegal.
        const pool = mine.filter(p => p.id !== outP.id);
        const solved = bestLineup(pool, slots, 'current_week_ppg');
        const next = solved.slots.map(s2 => s2.player).filter(Boolean);
        if (!next.some(p => p.id === inP.id)) continue;   // he would not actually start
        if (next.length !== starters.length) continue;    // slot could not be filled
        const m = lineupMoments(next);
        const p2 = winProb(m.mean - oppMoments.mean, m.sd, oppMoments.sd);
        const delta = (p2 - basePwin) * 100;
        if (delta <= 0.15) continue;                 // below this it is not advice
        swaps.push({
          start: inP.name, start_position: inP.position, start_ppg: weekPpg(inP),
          instead_of: outP.name, instead_of_ppg: weekPpg(outP),
          points_given_up: +(mineMoments.mean - m.mean).toFixed(2),
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
    opponent_projection: +oppMoments.mean.toFixed(1), opponent_sd: +oppMoments.sd.toFixed(1),
    edge: +edge.toFixed(1),
    win_probability: +(basePwin * 100).toFixed(1),
    stance,
    lineup: starters.map(p => ({ player: p.name, position: p.position, ppg: weekPpg(p) })),
    swaps: swaps.slice(0, 5),
    note: stance === 'neutral'
      ? `Matchup is within ${MATERIAL_EDGE} points. Posture is worth under a third of a percentage point here — start the highest projections and leave it alone.`
      : edge < 0
        ? `You are a ${Math.abs(edge).toFixed(0)}-point underdog. The safe lineup loses slowly; variance is what gives you a chance.`
        : `You are a ${edge.toFixed(0)}-point favourite. Variance is the only way you lose this — take the floor.`,
  };
}
