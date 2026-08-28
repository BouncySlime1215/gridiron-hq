/**
 * Lineups built for the outcome you actually need, not the highest average.
 *
 * Every lineup tool in this app — and almost every one anywhere — maximises
 * EXPECTED points. That is the right objective exactly once: when you are
 * favoured and want to bank the median. It is the wrong objective when you are
 * an underdog, when you are chasing a playoff seed, and it is catastrophically
 * wrong in a daily-fantasy tournament, where finishing at the median wins
 * nothing at all.
 *
 * What those situations need is P(score >= some target), and that quantity is
 * governed by CORRELATION rather than by any individual projection. Two
 * lineups with identical expected points have very different ceilings if one
 * of them stacks a quarterback with his own receiver: when the QB has a big
 * day the receiver usually does too, so their good weeks arrive together and
 * the joint distribution grows a fat right tail. Sampling players
 * independently — which is what a naive optimiser does — assumes that shared
 * variance cancels out, and systematically understates the ceiling of exactly
 * the lineups that win tournaments.
 *
 * We already have the machinery to do this properly:
 *   `correlation.js`   Gaussian copula over archetype correlations
 *   `projections.js`   per-player weekly outcome distributions
 *   `trade-engine.js`  the league's real slot configuration
 *
 * The app has even been TELLING the user to do this — self-scout emits "you
 * need variance, target boom-rate players" — while providing no way to act on
 * it. This is the missing half.
 */
import { rows, row } from '../db/index.js';
import { PPR } from './scoring.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { correlatedSampler } from './correlation.js';
import { dvpFor, matchupModel } from './matchups.js';
import { gameScriptFor } from './gamescript.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, lineupSlots } from './trade-engine.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const POOL = 600;          // outcomes sampled per player, then indexed by the copula
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const FLEX_ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Build each candidate's weekly outcome pool for one week, with matchup and
 * game-script context applied — the same construction the season simulator
 * uses, so a ceiling here is comparable to a title probability there.
 */
function outcomePools(players, season, week, scoring) {
  const proj = buildProjections({ through: season - 1, scoring });
  const { schedule } = matchupModel();
  const entries = [];
  for (const p of players) {
    if (!SCORED.has(p.position)) continue;
    const pr = proj.get(p.id);
    const game = schedule.get(p.team_abbr)?.find(g => g.week === week);
    // On a bye, or with no projection, a player cannot contribute. Excluded
    // rather than zero-filled: a zero would silently drag a lineup's mean down
    // while still occupying a slot the optimiser could have used.
    if (!pr || !game) continue;
    const d = dvpFor(game.opponent_abbr, p.position);
    const base = d.mult * (game.home ? 1.02 : 0.98);
    const gs = gameScriptFor(p.team_abbr, season, week);
    const samples = sampleWeeks(pr.params, POOL, scoring,
      { pass: base * gs.pass_mult, rush: base * gs.rush_mult }, 1).sort((a, b) => a - b);
    entries.push({
      player: p,
      meta: { id: p.id, position: p.position, team: p.team_abbr, opponent: game.opponent_abbr,
        target_share: pr.volume?.target_share ?? null },
      samples,
      mean: samples.reduce((s, v) => s + v, 0) / samples.length
    });
  }
  return entries;
}

/** Every legal assignment of a candidate set to the league's slots, greedily. */
function fillSlots(chosen, slots) {
  const used = new Set();
  const filled = [];
  for (const slot of slots.filter(s => SCORED.has(s))) {
    const pick = chosen.find(c => !used.has(c.player.id) && c.player.position === slot);
    if (pick) used.add(pick.player.id);
    filled.push({ slot, pick: pick ?? null });
  }
  for (const slot of slots.filter(s => FLEX_ELIGIBLE[s])) {
    const ok = FLEX_ELIGIBLE[slot];
    const pick = chosen.find(c => !used.has(c.player.id) && ok.includes(c.player.position));
    if (pick) used.add(pick.player.id);
    filled.push({ slot, pick: pick ?? null });
  }
  return filled;
}

/**
 * Score one lineup on the joint distribution.
 *
 * Returns the full shape, not a point estimate: mean, the ceiling percentiles,
 * and P(score >= target). The last is the objective a tournament actually pays.
 */
function scoreLineup(entries, draws, target) {
  const n = entries.length;
  const totals = new Array(draws.length);
  for (let d = 0; d < draws.length; d++) {
    const v = draws[d];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += v[entries[i].index];
    totals[d] = sum;
  }
  totals.sort((a, b) => a - b);
  const q = p => totals[Math.min(totals.length - 1, Math.floor(p * totals.length))];
  const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
  const hit = target == null ? null
    : totals.filter(t => t >= target).length / totals.length;
  return { mean: r2(mean), floor: r2(q(0.10)), median: r2(q(0.50)),
    ceiling: r2(q(0.90)), p99: r2(q(0.99)), hit_probability: r4(hit) };
}

/**
 * The ceiling-optimal lineup for one team in one week.
 *
 * @param objective 'ceiling' maximises P(score >= target) — the tournament and
 *   underdog objective. 'mean' reproduces the classic highest-average lineup,
 *   kept so the two can be compared side by side, which is the whole point.
 * @param target the score to beat. Defaults to a stretch above the team's own
 *   median, because "what do I need to beat a good week" is the real question.
 */
export function ceilingLineup(leagueId, {
  teamId = null, week = 1, season = SEASON, objective = 'ceiling',
  target = null, trials = 3000, candidates = 14
} = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(teamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'team not found in this league' };
  const slots = lineupSlots(lg);

  const pools = outcomePools(me.players, season, week, PPR)
    .sort((a, b) => b.mean - a.mean)
    .slice(0, candidates);
  if (pools.length < slots.length) {
    return { error: `only ${pools.length} playable candidates for ${slots.length} slots in week ${week}` };
  }
  pools.forEach((e, i) => { e.index = i; });

  // One correlated sampler over the whole candidate pool, drawn once. Every
  // lineup is then scored against the SAME draws, so two lineups differ only
  // by who is in them and never by sampling luck.
  const draw = correlatedSampler(pools.map(e => e.meta), pools.map(e => e.samples));
  const draws = Array.from({ length: trials }, () => draw());

  // A default target set from the team's own top-heavy lineup: beating your own
  // median is not a goal, beating a strong week is.
  const naive = fillSlots([...pools].sort((a, b) => b.mean - a.mean), slots)
    .map(f => f.pick).filter(Boolean);
  const naiveScore = scoreLineup(naive, draws, null);
  const effectiveTarget = target ?? r2(naiveScore.ceiling);

  // Search: start from the highest-mean lineup and try single swaps until no
  // swap improves the objective. Exhaustive enumeration is factorial and
  // unnecessary — the objective is smooth in one substitution at a time.
  const objectiveOf = picks => {
    const s = scoreLineup(picks, draws, effectiveTarget);
    return objective === 'mean' ? s.mean : s.hit_probability;
  };

  let best = naive, bestVal = objectiveOf(naive);
  let improved = true, passes = 0;
  while (improved && passes < 6) {
    improved = false; passes++;
    for (let i = 0; i < best.length; i++) {
      for (const cand of pools) {
        if (best.some(b => b.player.id === cand.player.id)) continue;
        const trial = best.slice();
        trial[i] = cand;
        // The swap must still produce a legal lineup for this league's slots.
        const legal = fillSlots(trial, slots);
        if (legal.some(f => !f.pick)) continue;
        const picks = legal.map(f => f.pick);
        const val = objectiveOf(picks);
        if (val > bestVal) { best = picks; bestVal = val; improved = true; }
      }
    }
  }

  const bestFilled = fillSlots(best, slots);
  const bestScore = scoreLineup(best, draws, effectiveTarget);
  const naiveFilled = fillSlots(naive, slots);
  const naiveFull = scoreLineup(naive, draws, effectiveTarget);

  // Which stacks the optimiser actually chose — the mechanism behind any
  // ceiling gain, surfaced so the recommendation is inspectable rather than
  // a black box telling you to bench your best player.
  const byTeam = new Map();
  for (const p of best) {
    const t = p.player.team_abbr;
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(`${p.player.name} (${p.player.position})`);
  }
  const stacks = [...byTeam.entries()].filter(([, v]) => v.length > 1)
    .map(([team, players]) => ({ team, players }));

  return {
    league: lg.name, team: me.owner, season, week,
    objective, target: effectiveTarget, trials, candidates_considered: pools.length,
    lineup: bestFilled.map(f => ({ slot: f.slot, player: f.pick.player.name,
      position: f.pick.player.position, team: f.pick.player.team_abbr,
      mean_points: r2(f.pick.mean) })),
    distribution: bestScore,
    // The comparison that makes the case: same roster, same draws, different
    // objective. If these are identical the roster has no ceiling lever and
    // saying so is more useful than manufacturing a difference.
    versus_highest_mean: {
      lineup: naiveFilled.map(f => ({ slot: f.slot, player: f.pick?.player.name ?? null })),
      distribution: naiveFull,
      mean_given_up: r2(bestScore.mean - naiveFull.mean),
      ceiling_gained: r2(bestScore.ceiling - naiveFull.ceiling),
      hit_probability_gained: r4((bestScore.hit_probability ?? 0) - (naiveFull.hit_probability ?? 0))
    },
    stacks,
    note: 'Scored on a Gaussian copula over fitted archetype correlations, so a quarterback and ' +
      'his own receiver have their good weeks together. Every lineup is evaluated against the ' +
      'same draws, so a difference between them is never sampling luck.'
  };
}
