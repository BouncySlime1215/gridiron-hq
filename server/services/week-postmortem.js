/**
 * Was I wrong, or was I unlucky?
 *
 * Nothing in fantasy separates these two, and confusing them is how people
 * abandon correct processes. A manager who starts the right players and loses
 * to a 40-burger learns "my process is bad" when the correct lesson is "that
 * happens 12% of the time". A manager who benches the right player and wins
 * anyway learns nothing at all.
 *
 * A week's result decomposes cleanly into three parts, and this measures all
 * three against the same actual outcome:
 *
 *   DECISION COST   the gap between what you started and the best lineup your
 *                   own roster could have produced. Entirely your fault, and
 *                   entirely knowable only in hindsight.
 *   PROJECTION ERROR how far the engine's forecast for the players you started
 *                   sat from what they actually did. The model's fault.
 *   VARIANCE        where your result landed in the distribution the simulator
 *                   drew for that exact lineup BEFORE the games. Nobody's fault.
 *
 * The third is what makes this honest. Without a distribution you can only say
 * "you scored less than projected", which conflates a bad process with a bad
 * Sunday. With one you can say "you scored at the 12th percentile of your own
 * lineup's range" — a sentence that correctly assigns no blame.
 */
import { rows, row } from '../db/index.js';
import { PPR, scoreLine } from './scoring.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, lineupSlots, bestLineup } from './trade-engine.js';
import { buildProjections, sampleWeeks } from './projections.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const FLEX_ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/** Fill league slots greedily from a list already sorted best-first. */
function fill(sorted, slots) {
  const used = new Set(); const out = [];
  for (const slot of slots.filter(s => SCORED.has(s))) {
    const p = sorted.find(x => !used.has(x.id) && x.position === slot);
    if (p) used.add(p.id);
    out.push({ slot, player: p ?? null });
  }
  for (const slot of slots.filter(s => FLEX_ELIGIBLE[s])) {
    const ok = FLEX_ELIGIBLE[slot];
    const p = sorted.find(x => !used.has(x.id) && ok.includes(x.position));
    if (p) used.add(p.id);
    out.push({ slot, player: p ?? null });
  }
  return out;
}

/**
 * @param week   the completed week to attribute
 * @param lineup optional list of player ids actually started. When omitted the
 *   engine's own recommended lineup is used as the counterfactual, which
 *   answers "how did the advice do" rather than "how did I do" — a different
 *   and clearly-labelled question.
 */
export function weekPostmortem(leagueId, {
  teamId = null, week = 1, season = SEASON, lineup = null, trials = 3000
} = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(teamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'team not found' };
  const slots = lineupSlots(lg);

  // Actual scored production for that week, for anyone on this roster.
  const actualsRaw = rows(
    `SELECT u.player_id, u.passing_yards, u.passing_tds, u.interceptions,
            u.rushing_yards, u.rushing_tds, u.receptions, u.receiving_yards,
            u.receiving_tds, u.fumbles_lost
     FROM player_week_usage u WHERE u.season = ? AND u.week = ?`, season, week);
  if (!actualsRaw.length) {
    return { error: `no results stored for ${season} week ${week} — nothing to attribute yet` };
  }
  const actual = new Map(actualsRaw.map(u => [u.player_id, scoreLine(u, PPR)]));

  const roster = me.players.filter(p => SCORED.has(p.position));
  const played = roster.filter(p => actual.has(p.id));
  if (played.length < slots.length) {
    return { error: `only ${played.length} rostered players have ${season} week ${week} results` };
  }

  // 1. What the best possible lineup would have scored, in hindsight.
  const hindsight = fill(
    [...played].sort((a, b) => (actual.get(b.id) ?? 0) - (actual.get(a.id) ?? 0)), slots);
  const hindsightPoints = hindsight.reduce((s, f) => s + (actual.get(f.player?.id) ?? 0), 0);

  // 2. What was actually started. Falls back to the engine's own pick, which
  //    changes the question from "how did I do" to "how did the advice do".
  const usedEngineLineup = !lineup?.length;
  const startedIds = usedEngineLineup
    ? bestLineup(me.players, slots).slots.map(s => s.player?.id).filter(Boolean)
    : lineup.map(Number);
  const started = startedIds.map(id => roster.find(p => p.id === id)).filter(Boolean);
  const startedPoints = started.reduce((s, p) => s + (actual.get(p.id) ?? 0), 0);

  // 3. What the engine expected that exact lineup to do, as a DISTRIBUTION —
  //    the piece that makes "unlucky" a measurable claim instead of an excuse.
  const proj = buildProjections({ through: season - 1, scoring: PPR });
  const totals = new Array(trials).fill(0);
  let projectedMean = 0;
  const perPlayer = [];
  for (const p of started) {
    const pr = proj.get(p.id);
    const act = actual.get(p.id) ?? 0;
    if (!pr) { perPlayer.push({ name: p.name, position: p.position, projected: null, actual: r2(act), miss: null }); continue; }
    const samples = sampleWeeks(pr.params, trials, PPR, 1, 1);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    projectedMean += mean;
    for (let i = 0; i < trials; i++) totals[i] += samples[i];
    perPlayer.push({ name: p.name, position: p.position,
      projected: r2(mean), actual: r2(act), miss: r2(act - mean) });
  }
  totals.sort((a, b) => a - b);
  const percentile = totals.length
    ? totals.filter(t => t <= startedPoints).length / totals.length : null;

  const decisionCost = hindsightPoints - startedPoints;
  const projectionError = startedPoints - projectedMean;

  // The biggest single decision mistake, named — a total is not actionable, a
  // swap is.
  const benchHeroes = played
    .filter(p => !startedIds.includes(p.id))
    .sort((a, b) => (actual.get(b.id) ?? 0) - (actual.get(a.id) ?? 0))[0];
  const worstStarter = started
    .sort((a, b) => (actual.get(a.id) ?? 0) - (actual.get(b.id) ?? 0))[0];

  return {
    league: lg.name, team: me.owner, season, week,
    used_engine_lineup: usedEngineLineup,
    scored: r2(startedPoints),
    best_possible: r2(hindsightPoints),
    projected: r2(projectedMean),

    attribution: {
      decision_cost: r2(decisionCost),
      projection_error: r2(projectionError),
      // Where the result landed inside the range drawn for this exact lineup.
      outcome_percentile: percentile == null ? null : +percentile.toFixed(3),
      range: { p10: r2(totals[Math.floor(trials * 0.1)]), p50: r2(totals[Math.floor(trials * 0.5)]),
        p90: r2(totals[Math.floor(trials * 0.9)]) }
    },

    // The whole point, in one sentence.
    verdict: (() => {
      const unlucky = percentile != null && percentile < 0.25;
      const lucky = percentile != null && percentile > 0.75;
      const badDecisions = decisionCost > 10;
      if (badDecisions && unlucky) {
        return `Both. You left ${r2(decisionCost)} points on your bench AND landed in the bottom ` +
          `${Math.round(percentile * 100)}% of your own lineup's range.`;
      }
      if (badDecisions) {
        return `Decisions. You left ${r2(decisionCost)} points on the bench — that is on you, not on variance.`;
      }
      if (unlucky) {
        return `Unlucky. Your lineup was near-optimal and you still landed at the ` +
          `${Math.round(percentile * 100)}th percentile of its own range. Nothing to fix.`;
      }
      if (lucky) {
        return `You got away with one — ${Math.round(percentile * 100)}th percentile of your lineup's range.`;
      }
      return 'An ordinary week: near-optimal lineup, result close to the middle of its range.';
    })(),

    players: perPlayer.sort((a, b) => (a.miss ?? 0) - (b.miss ?? 0)),
    biggest_miss: worstStarter ? { name: worstStarter.name, actual: r2(actual.get(worstStarter.id) ?? 0) } : null,
    best_bench: benchHeroes ? { name: benchHeroes.name, actual: r2(actual.get(benchHeroes.id) ?? 0) } : null,
    note: usedEngineLineup
      ? 'No submitted lineup was supplied, so this attributes the ENGINE\'s recommended lineup — it ' +
        'answers how the advice performed, not how you did. Pass the ids you actually started to ' +
        'attribute your own week.'
      : 'Attributed against the lineup you actually started.'
  };
}
