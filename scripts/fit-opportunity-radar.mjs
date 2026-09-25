#!/usr/bin/env node
/**
 * O1 opportunity radar: fit 2021-2023, grade 2024. 2025 stays closed (never loaded).
 *
 * PRE-REGISTRATION (committed before any effect was estimated; do not edit after the fact)
 *   Rows      every player-week, weeks 3-18, player played that week, >= 2 prior games this
 *             season (QB / RB / WR+TE groups). Opportunity: QB attempts+carries, RB
 *             carries+targets, WR/TE targets.
 *   Baseline  EWMA (alpha 0.4) of the player's own opportunity over his prior games this
 *             season (the 2026-09-19 winner), on the same rows.
 *   Outcomes  opp1 next-week opportunity (THE GATE OUTCOME), opp3 mean opportunity over his
 *             next 3 games, ppr1 next-week PPR points, eff1 next-week PPR per opportunity.
 *   Effect    per event type x position group: slope of (outcome - EWMA) on the event's
 *             magnitude m, with intercept, fitted on 2021-2023; 90% CI by player-clustered
 *             bootstrap (1000 reps, fixed seed).
 *   Gate      an event passes (and may move a number, after O1c) only if BOTH
 *               (a) its 2021-23 opp1 CI excludes 0, and
 *               (b) on 2024 event rows, EWMA + beta*m beats EWMA on absolute error, with the
 *                   player-clustered 90% CI of the per-row gain entirely above 0.
 *             Fewer than 30 fit cases -> 'watch' (not estimable). Failing events are served
 *             only as 'watch' flags with their evidence.
 *   Also      start/sit pair accuracy (same week, same group, pairs a change can flip) for the
 *             gated set (ppr1 betas of events that passed on opp1), and for all events as a
 *             diagnostic that is never served; the backup-QB downgrade on pass-catchers
 *             (opp1 + eff1 + ppr1) reported separately; the O1a context head (spread, implied
 *             total, team pace, pass rate, opponent funnel, opponent box count, own
 *             questionable P(out)) graded the same way; a fitted EWMA alpha (grid 0.2-0.7).
 *   Coverage  league 4, current week: events found for rostered players, count by type.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 nice -n 10 node scripts/fit-opportunity-radar.mjs \
 *     [--baseline-only] [--reps 1000] [--json out.json] [--league 4]
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const REPS = Number(opt('--reps', 1000));
const GRADE = 2024;
const R = await import('../server/services/opportunity-radar.js');
const FIT = [...R.FIT_SEASONS];
if ([...FIT, GRADE].includes(2025)) throw new Error('2025 is closed');
const { solveLinear } = await import('../server/services/forecast-combination.js');
const { EVENT_TYPES, OUTCOMES, fitEffect, pairedGain, passesGate, pairAccuracy, magnitude, residual, ewma } = R;

const t0 = Date.now();
// P(out) cells from the fit seasons only: the role-layer table includes 2024 (review of #377).
// outDefinition() is the same lookup serving classifies with (P(OUT)-FIX), so train and serve agree.
const pOut = R.outDefinition();
{
  // P(OUT)-FIX diagnostic: cells where the 2021-24 role layer would have classified differently.
  const role = R.loadPOut();
  const flips = [];
  for (const rep of ['Out', 'Doubtful', 'Questionable']) {
    for (const pr of ['Did Not Participate In Practice', 'Limited Participation in Practice', 'Full Participation in Practice', '']) {
      for (const pos of R.POSITIONS) {
        const a = pOut(rep, pr, pos), b = role(rep, pr, pos);
        if ((a >= R.OUT_THRESHOLD) !== (b >= R.OUT_THRESHOLD)) flips.push(`${rep}|${pr || 'none'}|${pos} fit=${a.toFixed(3)} role=${b.toFixed(3)}`);
      }
    }
  }
  console.error(`out-definition cells the role layer would flip (served before P(OUT)-FIX, now unused): ${flips.length}`);
  for (const f of flips) console.error(`  ${f}`);
}
console.error('P(out) cells (fit seasons only) at or above ' + R.OUT_THRESHOLD + ' or near it:');
for (const [key, c] of Object.entries(pOut.cells).sort()) {
  if (c.p_out >= 0.4 && !key.startsWith('out|')) console.error(`  ${key} n=${c.n} p_out=${c.p_out}`);
}
const bySeason = new Map();
for (const s of [...FIT, GRADE]) {
  bySeason.set(s, R.buildRadarRows(s, { pOut }).filter(r => r.played));
  console.error(`built ${s}: ${bySeason.get(s).length} rows (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const fitRows = FIT.flatMap(s => bySeason.get(s));
const gradeRows = bySeason.get(GRADE);
const GROUPS = ['QB', 'RB', 'WRTE'];
const inGroup = (list, g) => list.filter(r => r.group === g);
const f3 = v => (v == null ? 'n/a' : v.toFixed(3));
const ci = c => (c ? `[${c[0].toFixed(3)}, ${c[1].toFixed(3)}]` : 'n/a');

// ---------------------------------------------------------------- baseline
console.log(`\n# O1 radar: fit ${FIT.join('+')} -> graded ${GRADE} (2025 closed)`);
console.log(`rows: fit ${fitRows.length}, graded ${gradeRows.length}`);
console.log('\n## Baseline: EWMA(0.4) of own opportunity, graded 2024');
const baseline = {};
for (const g of GROUPS) {
  const rs = inGroup(gradeRows, g);
  const m1 = rs.filter(r => Number.isFinite(r.opp1)), m3 = rs.filter(r => Number.isFinite(r.opp3));
  const mae1 = m1.reduce((s, r) => s + Math.abs(r.opp1 - r.base_opp), 0) / m1.length;
  const mae3 = m3.reduce((s, r) => s + Math.abs(r.opp3 - r.base_opp), 0) / m3.length;
  baseline[g] = { n: rs.length, mae_opp1: mae1, mae_opp3: mae3 };
  console.log(`  ${g.padEnd(5)} n=${rs.length}  MAE opp1 ${mae1.toFixed(3)}  opp3 ${mae3.toFixed(3)}`);
}
if (flag('--baseline-only')) process.exit(0);

// ---------------------------------------------------------------- per-event effects
console.log('\n## Events: effect on (outcome - EWMA) per unit m; fit 2021-23, graded 2024');
const results = {};
const effects = {};
for (const type of Object.keys(EVENT_TYPES)) {
  for (const g of EVENT_TYPES[type].groups) {
    const fr = inGroup(fitRows, g), gr = inGroup(gradeRows, g);
    const byOutcome = {};
    for (const o of Object.keys(OUTCOMES)) byOutcome[o] = fitEffect(fr, type, o, { reps: REPS });
    const f = byOutcome.opp1;
    const evRows = gr.filter(r => magnitude(r, type) !== 0);
    const graded = f.beta != null && f.n >= 30
      ? pairedGain(evRows, 'opp1', r => r.base_opp + f.beta * magnitude(r, type), { reps: REPS })
      : { n: evRows.length, gain: null, ci: null };
    const g24 = fitEffect(gr, type, 'opp1', { reps: 200 });
    const passes = f.n >= 30 && passesGate(f, graded);
    const key = `${type}|${g}`;
    results[key] = { type, group: g, fit: byOutcome, graded, graded_beta: g24.beta, graded_n: g24.n, passes_gate: passes };
    effects[key] = {
      beta: f.beta == null ? null : +f.beta.toFixed(4), ci: f.ci ? f.ci.map(v => +v.toFixed(4)) : null, n: f.n, players: f.players,
      opp3: byOutcome.opp3.beta == null ? null : +byOutcome.opp3.beta.toFixed(4),
      ppr1: byOutcome.ppr1.beta == null ? null : +byOutcome.ppr1.beta.toFixed(4),
      ppr1_ci: byOutcome.ppr1.ci ? byOutcome.ppr1.ci.map(v => +v.toFixed(4)) : null,
      eff1: byOutcome.eff1.beta == null ? null : +byOutcome.eff1.beta.toFixed(4),
      eff1_ci: byOutcome.eff1.ci ? byOutcome.eff1.ci.map(v => +v.toFixed(4)) : null,
      graded: graded.ci ? { n: graded.n, gain: +graded.gain.toFixed(4), ci: graded.ci.map(v => +v.toFixed(4)) } : null,
      passes_gate: passes
    };
    console.log(`  ${key.padEnd(28)} fit n=${String(f.n).padStart(5)} beta ${f3(f.beta)} ${ci(f.ci)}`
      + ` | opp3 ${f3(byOutcome.opp3.beta)} ${ci(byOutcome.opp3.ci)}`
      + ` | 2024 n=${String(evRows.length).padStart(4)} beta ${f3(g24.beta)} gain ${f3(graded.gain)} ${ci(graded.ci)}`
      + ` | ${passes ? 'PASS' : 'watch'}`);
  }
}

// ---------------------------------------------------------------- backup QB separately
console.log('\n## Backup QB starting / QB returning: pass-catchers and backs (fit 2021-23 | 2024 alone)');
for (const type of ['backup_qb_start', 'qb_return']) {
  for (const g of ['WRTE', 'RB']) {
    const r = results[`${type}|${g}`];
    const g24 = Object.fromEntries(Object.keys(OUTCOMES).map(o => [o, fitEffect(inGroup(gradeRows, g), type, o, { reps: REPS })]));
    console.log(`  ${type}|${g}: n=${r.fit.opp1.n}  targets/opps ${f3(r.fit.opp1.beta)} ${ci(r.fit.opp1.ci)}`
      + `  PPR/opp ${f3(r.fit.eff1.beta)} ${ci(r.fit.eff1.ci)}  PPR ${f3(r.fit.ppr1.beta)} ${ci(r.fit.ppr1.ci)}`
      + `  || 2024 n=${g24.opp1.n}: opps ${f3(g24.opp1.beta)} ${ci(g24.opp1.ci)} PPR/opp ${f3(g24.eff1.beta)} ${ci(g24.eff1.ci)} PPR ${f3(g24.ppr1.beta)} ${ci(g24.ppr1.ci)}`);
    results[`${type}|${g}`].graded_all_outcomes = Object.fromEntries(Object.entries(g24).map(([o, v]) => [o, { beta: v.beta, ci: v.ci, n: v.n }]));
  }
}

// ---------------------------------------------------------------- O1a context head
console.log('\n## O1a context head: (opp1 - EWMA) ~ spread, implied, pace, pass rate, opp funnel, opp box, own P(out)');
const CTX = ['spread', 'implied', 'pace', 'pass_rate', 'opp_allowed', 'opp_box', 'self_questionable'];
const context = {};
for (const g of GROUPS) {
  const fr = inGroup(fitRows, g).filter(r => residual(r, 'opp1') != null);
  const mu = {}, sd = {};
  for (const c of CTX) {
    const v = fr.map(r => r.ctx[c]).filter(Number.isFinite);
    mu[c] = v.reduce((s, x) => s + x, 0) / v.length;
    sd[c] = Math.sqrt(v.reduce((s, x) => s + (x - mu[c]) ** 2, 0) / v.length) || 1;
  }
  const z = r => [1, ...CTX.map(c => (Number.isFinite(r.ctx[c]) ? (r.ctx[c] - mu[c]) / sd[c] : 0))];
  const k = CTX.length + 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const r of fr) {
    const x = z(r), y = residual(r, 'opp1');
    for (let i = 0; i < k; i++) { b[i] += x[i] * y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; }
  }
  const w = solveLinear(A, b, 1e-6);
  const predict = r => { const x = z(r); let s = 0; for (let i = 1; i < k; i++) s += w[i] * x[i]; return r.base_opp + s; };
  const gr = inGroup(gradeRows, g);
  const gain = pairedGain(gr, 'opp1', predict, { reps: REPS });
  context[g] = { weights: Object.fromEntries(CTX.map((c, i) => [c, +w[i + 1].toFixed(4)])), graded: gain, passes: !!(gain.ci && gain.ci[0] > 0) };
  console.log(`  ${g.padEnd(5)} MAE ${f3(gain.mae_base)} -> ${f3(gain.mae_model)} gain ${f3(gain.gain)} ${ci(gain.ci)} ${context[g].passes ? 'PASS' : 'fail'}`
    + `  weights ${CTX.map((c, i) => `${c} ${w[i + 1].toFixed(2)}`).join(', ')}`);
}

// ---------------------------------------------------------------- fitted-K (EWMA alpha) head
console.log('\n## Fitted-K head: EWMA alpha chosen on 2021-23, graded 2024');
const alphaFit = {};
for (const g of GROUPS) {
  const fr = inGroup(fitRows, g).filter(r => Number.isFinite(r.opp1));
  let best = null;
  for (const a of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
    const m = fr.reduce((s, r) => s + Math.abs(r.opp1 - ewma(r.prior_opps, a)), 0) / fr.length;
    if (!best || m < best.mae) best = { alpha: a, mae: m };
  }
  const gain = pairedGain(inGroup(gradeRows, g), 'opp1', r => ewma(r.prior_opps, best.alpha), { reps: REPS });
  alphaFit[g] = { alpha: best.alpha, graded: gain };
  console.log(`  ${g.padEnd(5)} alpha ${best.alpha}  2024 MAE ${f3(gain.mae_base)} -> ${f3(gain.mae_model)} gain ${f3(gain.gain)} ${ci(gain.ci)}`);
}

// ---------------------------------------------------------------- whole radar vs EWMA + pair accuracy
const gated = Object.entries(effects).filter(([, e]) => e.passes_gate);
const shiftOpp = (r, set) => r.events.reduce((s, e) => { const f = set[`${e.type}|${r.group}`]; return s + (f && f.beta != null ? f.beta * e.m : 0); }, 0);
const shiftPpr = (r, set) => r.events.reduce((s, e) => { const f = set[`${e.type}|${r.group}`]; return s + (f && f.ppr1 != null ? f.ppr1 * e.m : 0); }, 0);
const gatedSet = Object.fromEntries(gated);
const allSet = Object.fromEntries(Object.entries(effects).filter(([, e]) => e.n >= 30));
console.log(`\n## Whole radar vs EWMA, 2024 (gated events: ${gated.map(([k]) => k).join(', ') || 'none'})`);
const whole = {};
for (const [name, set] of [['gated', gatedSet], ['all events (diagnostic, never served)', allSet]]) {
  const touched = gradeRows.filter(r => shiftOpp(r, set) !== 0);
  const g1 = pairedGain(gradeRows, 'opp1', r => r.base_opp + shiftOpp(r, set), { reps: REPS });
  const g3 = pairedGain(gradeRows.filter(r => Number.isFinite(r.opp3)), 'opp3', r => r.base_opp + shiftOpp(r, set), { reps: REPS });
  const pa = pairAccuracy(gradeRows, r => shiftPpr(r, set));
  whole[name] = { touched: touched.length, opp1: g1, opp3: g3, pairs: pa };
  console.log(`  ${name}: touches ${touched.length} rows; opp1 MAE ${f3(g1.mae_base)} -> ${f3(g1.mae_model)} ${ci(g1.ci)};`
    + ` opp3 ${f3(g3.mae_base)} -> ${f3(g3.mae_model)} ${ci(g3.ci)}; start/sit pairs ${pa.pairs}: ${f3(pa.before)} -> ${f3(pa.after)}`);
}

// ---------------------------------------------------------------- coverage, league 4
const leagueId = opt('--league', null);
let coverage = null;
if (leagueId) {
  process.env.GRIDIRON_OPP_RADAR = '1';
  const { loadServices, buildAdapter } = await import('./campaign/league-adapter.mjs');
  const svc = await loadServices();
  const adapter = buildAdapter(svc, Number(leagueId), { finder: false });
  if (adapter.fail) throw new Error(`league ${leagueId}: ${adapter.fail}`);
  const counts = {}, validated = {};
  let served = 0, withEvents = 0;
  for (const id of new Set([...adapter.rosters.values()].flat())) {
    const o = adapter.opportunityOf(id);
    if (!o) continue;
    served++;
    if (o.opportunity_events.length) withEvents++;
    for (const e of o.opportunity_events) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.passes_gate) validated[e.type] = (validated[e.type] ?? 0) + 1;
    }
  }
  coverage = { league: Number(leagueId), season: adapter.league.season, week: adapter.league.week, served, withEvents, counts, validated };
  console.log(`\n## Coverage: league ${leagueId}, ${adapter.league.season} week ${adapter.league.week}`);
  console.log(`  rostered players served ${served}, with >= 1 event ${withEvents}; by type ${JSON.stringify(counts)}; validated ${JSON.stringify(validated)}`);
}

const outPath = opt('--json', null);
if (outPath) fs.writeFileSync(outPath, JSON.stringify({ baseline, results, effects, context, alphaFit, whole, coverage }, null, 1));
console.log('\n// FITTED_EFFECTS literal for server/services/opportunity-radar.js');
console.log(JSON.stringify(effects));
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
