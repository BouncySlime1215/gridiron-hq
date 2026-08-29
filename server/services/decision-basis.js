/**
 * What the model was actually looking at when it made each bet — written down,
 * in English, without spending a token.
 *
 * The blind replay says the production policy loses 10.43% of ROI over 157
 * bets. That is a verdict without a reason, and a verdict without a reason
 * cannot be fixed. The obvious next move is to ask an LLM to explain each pick,
 * and this project already has that: a `nfl_blind_replay_gate` feature that
 * sends every candidate bet to Claude for a structured risk review. It costs
 * money per bet, it is non-deterministic, and it cannot be re-run to reproduce
 * an audit — three properties that make it exactly the wrong tool for auditing.
 *
 * This is the other approach. The model's reasoning is already numeric and
 * fully available: twenty-two components each produce a margin, and the
 * ensemble is a weighted blend of them. So the basis for any decision can be
 * reconstructed exactly — which components pushed toward the pick, which
 * pushed against, how far each sat from the market — and rendered into English
 * by template. Deterministic, free, and reproducible.
 *
 * The real payoff is not the individual explanation, it is the AGGREGATE. One
 * decision tells you nothing. Compile the basis of every decision and you can
 * ask which components actually drive the picks, and whether the components
 * doing the driving have any relationship to whether the pick wins. That is a
 * question about the model's character rather than its record, and it is the
 * one thing a bare ROI figure cannot answer.
 */
import { rows, row, run } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

run(`CREATE TABLE IF NOT EXISTS decision_basis (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at  TEXT NOT NULL,
  season       INTEGER, week INTEGER,
  home         TEXT, away TEXT, side TEXT,
  market_margin REAL, model_margin REAL, edge_points REAL,
  result       TEXT, units REAL,
  drivers_json TEXT,
  narrative    TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS idx_db_season ON decision_basis(season, week)`);

/**
 * Reduce one game's twenty-two component predictions to the handful that
 * actually moved the answer.
 *
 * A component matters to a decision in proportion to how far it sat from the
 * market AND how much weight it carried — a wild opinion with no weight changes
 * nothing, and so does a heavily-weighted component that agreed with the price.
 * Contribution is the product, signed toward the side the bet took.
 */
export function driversFor(modelList, { marketMargin, side, home }) {
  if (!Array.isArray(modelList) || !Number.isFinite(marketMargin)) return [];
  const betOnHome = String(side ?? '').toUpperCase().startsWith(String(home ?? '').toUpperCase());

  const drivers = modelList
    .filter(m => Number.isFinite(m.margin))
    .map(m => {
      const deviation = m.margin - marketMargin;
      const weight = Number.isFinite(m.margin_weight) ? m.margin_weight : 0;
      // Signed so a positive contribution always means "argued for the side we
      // took", regardless of which team that was.
      const toward = betOnHome ? deviation : -deviation;
      return { id: m.id, name: m.name, family: m.family,
        margin: r2(m.margin), deviation_from_market: r2(deviation),
        weight: r4(weight), contribution: r4(toward * weight),
        agreed_with_bet: toward > 0 };
    })
    .filter(d => d.weight > 0);

  return drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/**
 * Turn a decision into English, deterministically.
 *
 * Template-driven natural language rather than a generated one. Every clause is
 * traceable to a number, the same inputs always produce the same sentence, and
 * it costs nothing to run over ten thousand decisions — none of which is true
 * of asking a language model to describe its own reasoning.
 */
export function narrate({ home, away, side, marketMargin, modelMargin, edgePoints, drivers,
  coverProbability = null, uncertaintyWidth = null }) {
  const parts = [];
  const gap = Math.abs(edgePoints ?? 0);
  const strength = gap >= 7 ? 'a large disagreement' : gap >= 3.5 ? 'a moderate disagreement'
    : gap >= 1.5 ? 'a small disagreement' : 'a marginal disagreement';

  parts.push(`Took ${side} in ${away} at ${home}. The market priced this at ` +
    `${r2(marketMargin)} and the ensemble at ${r2(modelMargin)} — ${strength} of ` +
    `${r2(gap)} points.`);

  const forBet = drivers.filter(d => d.agreed_with_bet).slice(0, 3);
  const against = drivers.filter(d => !d.agreed_with_bet).slice(0, 2);

  if (forBet.length) {
    parts.push(`The case came mostly from ${forBet.map(d =>
      `${d.name} (${d.deviation_from_market > 0 ? '+' : ''}${d.deviation_from_market} vs market)`)
      .join(', ')}.`);
  }
  if (against.length) {
    parts.push(`Arguing the other way: ${against.map(d =>
      `${d.name} (${d.deviation_from_market > 0 ? '+' : ''}${d.deviation_from_market})`).join(', ')}.`);
  }

  // Concentration is the part worth flagging. A pick resting on one component
  // is a different animal from one where twenty agree, and the record does not
  // distinguish them.
  const total = drivers.reduce((s, d) => s + Math.abs(d.contribution), 0);
  const top = drivers[0] ? Math.abs(drivers[0].contribution) / (total || 1) : 0;
  if (top > 0.4) {
    parts.push(`This decision was concentrated: ${drivers[0].name} alone accounts for ` +
      `${(top * 100).toFixed(0)}% of the case, so the bet is effectively that one component's opinion.`);
  } else if (drivers.length > 8 && top < 0.2) {
    parts.push(`The case was diffuse — no single component supplies more than ` +
      `${(top * 100).toFixed(0)}% of it, so this is a consensus lean rather than one model's call.`);
  }

  if (coverProbability != null) {
    parts.push(`Implied cover probability ${(coverProbability * 100).toFixed(1)}%, against a ` +
      `52.38% break-even at -110.`);
  }
  if (uncertaintyWidth != null && uncertaintyWidth > 30) {
    parts.push(`The 80% margin interval spans ${r2(uncertaintyWidth)} points, which is wide enough ` +
      `that the point estimate carries little information on its own.`);
  }
  return parts.join(' ');
}

/**
 * Record the basis of every bet a replayed season made.
 *
 * Runs the ensemble again for each game to recover the per-component numbers
 * the replay does not store, then writes both the structured drivers and the
 * rendered narrative.
 */
export async function recordSeasonBases({ season = 2024, maxBets = 200 } = {}) {
  const { replaySeason } = await import('./nfl-replay.js');
  const { ensembleLine } = await import('./nfl-ensemble.js');
  const rep = replaySeason(season, { minEdge: 0, maxDisagreement: null,
    maxPicksPerWeek: 20, markets: ['spread'] });
  if (rep.error) return { error: rep.error };

  const bets = rep.bets.filter(b => ['Won', 'Lost'].includes(b.result)).slice(0, maxBets);
  const now = new Date().toISOString();
  let stored = 0;

  for (const b of bets) {
    let line;
    try { line = ensembleLine(b.season, b.week, b.home, b.away); } catch { continue; }
    const drivers = driversFor(line?.models, { marketMargin: b.market_margin,
      side: b.side, home: b.home });
    if (!drivers.length) continue;

    const pd = b.feature_snapshot?.predictive_distribution ?? {};
    const narrative = narrate({ home: b.home, away: b.away, side: b.side,
      marketMargin: b.market_margin, modelMargin: b.model_margin, edgePoints: b.edge_points,
      drivers,
      coverProbability: String(b.side ?? '').toUpperCase().startsWith(String(b.home).toUpperCase())
        ? pd.home_cover_probability : pd.away_cover_probability,
      uncertaintyWidth: pd.uncertainty_width_80 });

    run(`INSERT INTO decision_basis
         (recorded_at, season, week, home, away, side, market_margin, model_margin,
          edge_points, result, units, drivers_json, narrative)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    now, b.season, b.week, b.home, b.away, b.side, b.market_margin, b.model_margin,
    b.edge_points, b.result, b.units, JSON.stringify(drivers.slice(0, 8)), narrative);
    stored++;
  }
  return { season, bets_recorded: stored,
    note: 'Each decision now carries a structured basis and a rendered explanation, both produced ' +
      'deterministically from the numbers. No tokens were spent.' };
}

/**
 * The aggregate: across every recorded decision, what is the model actually
 * looking at — and does it work?
 *
 * This is the diagnostic the ROI figure cannot give. For each component it
 * reports how often it drove a decision and the record of the decisions it
 * drove. A component that leads many picks and wins under half of them is doing
 * active harm, and no amount of weight-tuning finds that without asking the
 * question this way.
 */
export function compileDecisionBases({ minDecisions = 5 } = {}) {
  const all = rows(`SELECT * FROM decision_basis`);
  if (!all.length) return { error: 'no decision bases recorded', hint: 'run recordSeasonBases()' };

  const byDriver = new Map();
  let concentrated = 0, diffuse = 0;
  for (const d of all) {
    let drivers = [];
    try { drivers = JSON.parse(d.drivers_json ?? '[]'); } catch { continue; }
    if (!drivers.length) continue;

    const total = drivers.reduce((s, x) => s + Math.abs(x.contribution), 0) || 1;
    const topShare = Math.abs(drivers[0].contribution) / total;
    if (topShare > 0.4) concentrated++; else if (topShare < 0.2) diffuse++;

    // Credit the LEAD driver of each decision, which is the component whose
    // opinion the bet most nearly is.
    const lead = drivers[0];
    if (!byDriver.has(lead.id)) {
      byDriver.set(lead.id, { id: lead.id, name: lead.name, family: lead.family,
        led: 0, wins: 0, losses: 0, units: 0, mean_deviation: [] });
    }
    const e = byDriver.get(lead.id);
    e.led++;
    if (d.result === 'Won') e.wins++; else if (d.result === 'Lost') e.losses++;
    e.units += d.units ?? 0;
    e.mean_deviation.push(Math.abs(lead.deviation_from_market ?? 0));
  }

  // Significance, corrected. Ranking twenty-odd components by win rate and
  // reporting the best and worst is precisely the subgroup analysis that
  // manufactures discoveries: with this many components and a few dozen
  // decisions each, some will look excellent and some dreadful by chance alone.
  // Every rate below therefore carries a z-score against the break-even, and a
  // Sidak-corrected threshold for the number of components actually tested.
  const componentCount = byDriver.size;
  const alpha = 0.05;
  const correctedAlpha = 1 - Math.pow(1 - alpha, 1 / Math.max(1, componentCount));
  // Two-sided normal critical value for the corrected alpha.
  const zCritical = (() => {
    // Acklam-style inverse normal, adequate for a threshold.
    const p = 1 - correctedAlpha / 2;
    const a = [-39.696830, 220.946098, -275.928510, 138.357751, -30.664798, 2.506628];
    const b = [-54.476098, 161.585836, -155.698979, 66.801311, -13.280681];
    const c = [-0.007784894002, -0.32239645, -2.400758, -2.549732, 4.374664, 2.938163];
    const d = [0.007784695709, 0.32246712, 2.445134, 3.754408];
    const pl = 0.02425;
    let q, r2v, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    else if (p <= 1 - pl) { q = p - 0.5; r2v = q*q;
      x = (((((a[0]*r2v+a[1])*r2v+a[2])*r2v+a[3])*r2v+a[4])*r2v+a[5])*q /
          (((((b[0]*r2v+b[1])*r2v+b[2])*r2v+b[3])*r2v+b[4])*r2v+1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    return x;
  })();

  const leaders = [...byDriver.values()]
    .map(e => ({ id: e.id, name: e.name, family: e.family,
      decisions_led: e.led, record: `${e.wins}-${e.losses}`,
      win_rate: e.wins + e.losses ? r4(e.wins / (e.wins + e.losses)) : null,
      units: r2(e.units),
      mean_deviation_from_market: r2(mean(e.mean_deviation)),
      ...(() => {
        const n = e.wins + e.losses;
        if (!n) return { z_vs_break_even: null, significant: null };
        const rate = e.wins / n;
        const se = Math.sqrt(0.25 / n);
        const z = (rate - 0.5238) / se;
        return { z_vs_break_even: r2(z), significant: Math.abs(z) > zCritical };
      })() }))
    .filter(e => e.decisions_led >= minDecisions)
    .sort((a, b) => b.decisions_led - a.decisions_led);

  const wins = all.filter(a => a.result === 'Won').length;
  const losses = all.filter(a => a.result === 'Lost').length;
  const totalUnits = all.reduce((s, a) => s + (a.units ?? 0), 0);

  // The components that lead most often, and whether leading helps.
  // Only components whose record clears the corrected threshold are called out.
  // Everything else is a rate that looks interesting and is not distinguishable
  // from chance once you account for having examined every component.
  const harmful = leaders.filter(l => l.significant && (l.win_rate ?? 1) < 0.5238);
  const helpful = leaders.filter(l => l.significant && (l.win_rate ?? 0) > 0.5238);
  const suggestive = leaders.filter(l => !l.significant
    && ((l.win_rate ?? 0.5) < 0.45 || (l.win_rate ?? 0.5) > 0.58));

  return {
    decisions: all.length,
    overall_record: `${wins}-${losses}`,
    overall_win_rate: wins + losses ? r4(wins / (wins + losses)) : null,
    units: r2(totalUnits),
    break_even_at_minus_110: 0.5238,

    decision_shape: {
      concentrated: concentrated, diffuse: diffuse,
      mixed: all.length - concentrated - diffuse,
      note: 'A concentrated decision rests more than 40% on one component; a diffuse one has no ' +
        'component above 20%. The record does not distinguish them, but they are different bets.'
    },

    multiple_comparisons: {
      components_tested: componentCount,
      nominal_alpha: alpha,
      sidak_corrected_alpha: r4(correctedAlpha),
      z_required: r2(zCritical),
      note: 'Ranking every component and reporting the extremes is how a coin flip becomes a ' +
        'discovery. A rate is only called out below if it clears the corrected threshold.'
    },
    what_the_model_leans_on: leaders,
    components_significantly_losing: harmful,
    components_significantly_winning: helpful,
    suggestive_but_not_significant: suggestive.map(s2 =>
      ({ name: s2.name, record: s2.record, win_rate: s2.win_rate, z: s2.z_vs_break_even })),

    verdict: (() => {
      if (!leaders.length) return 'Not enough decisions per component to say anything.';
      const top = leaders[0];
      const rate = wins + losses ? wins / (wins + losses) : 0;
      const lines = [];
      lines.push(`${top.name} leads ${top.decisions_led} of ${all.length} decisions ` +
        `(${(top.decisions_led / all.length * 100).toFixed(0)}%) with a ${top.record} record.`);
      if (harmful.length) {
        lines.push(`${harmful.length} component(s) lead losing decisions at a rate that survives ` +
          `correction for testing ${componentCount} components: ` +
          harmful.map(h => `${h.name} (${h.record}, z=${h.z_vs_break_even})`).join(', ') + '.');
      } else {
        lines.push(`No component's record clears the corrected threshold in either direction — with ` +
          `${componentCount} components examined, none of the spread between best and worst is ` +
          `distinguishable from chance. Dropping a component on this evidence would be fitting noise.`);
      }
      if (rate < 0.5238) {
        lines.push(`Overall ${(rate * 100).toFixed(1)}% against a 52.38% break-even — the aggregate ` +
          'is unprofitable regardless of which component led.');
      }
      return lines.join(' ');
    })(),

    note: 'Compiled from deterministic bases, not from asking a language model what it thinks it did. ' +
      'The narratives are template-rendered from the same numbers, so this aggregate and every ' +
      'individual explanation are guaranteed consistent with each other.'
  };
}

/** One decision, with its rendered explanation. */
export function decisionDetail({ season, week, home } = {}) {
  const where = [], args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (week) { where.push('week = ?'); args.push(week); }
  if (home) { where.push('home = ?'); args.push(home); }
  const sql = `SELECT * FROM decision_basis ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY season DESC, week DESC LIMIT 25`;
  return rows(sql, ...args).map(d => {
    let drivers = [];
    try { drivers = JSON.parse(d.drivers_json ?? '[]'); } catch { /* leave empty */ }
    return { season: d.season, week: d.week, matchup: `${d.away} at ${d.home}`, side: d.side,
      market_margin: d.market_margin, model_margin: d.model_margin, edge: d.edge_points,
      result: d.result, units: r2(d.units), narrative: d.narrative, drivers };
  });
}
