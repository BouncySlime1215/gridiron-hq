/**
 * What promoting the volume-shrinkage fit actually changes on screen.
 *
 * The promotion gate (`promote-volume-shrinkage.mjs`) answers "is the fitted
 * vector better?" on a walk-forward replay of weeks 5-18 of finished seasons.
 * That is the right question for deciding whether to promote and the wrong one
 * for knowing what a user will see, for two reasons:
 *
 *   1. The vector does not reach most of the app. `activeKVectorFor` hands back
 *      the volume constants only when the caller's role recency is
 *      WEEKLY_ROLE_RECENCY, and strips them otherwise. The fit contains nothing
 *      but volume metrics, so every other caller gets null and keeps the
 *      hand-picked constants. Exactly one production caller passes it:
 *      player-week-engine.js. The draft board, ROS list, season sim, preseason
 *      model, ceiling lineup, week postmortem and the season endpoints in
 *      routes/model.js do not.
 *   2. A shrinkage constant has the most leverage when there is the least
 *      in-season evidence. The gate grades weeks 5-18; early in a season the
 *      projection is almost entirely prior-season share passed through the
 *      constant, so the move is far larger than the gate's pooled MAE suggests.
 *
 * This script reports both, read-only. It writes nothing and activates nothing.
 *
 *   --week=N     cutoff week to measure at (default: the current NFL week)
 *   --season=Y   season to measure at (default: NFL_SEASON)
 *   --vs-actuals grade both arms against the prior season's per-game scoring.
 *                A LEVEL check, not a forecast test: it grades against the same
 *                season the projection is built from, so a model that memorised
 *                that season would score zero. It answers "does this projection
 *                reproduce what the player did", which is what a systematic
 *                level bias shows up in, and nothing about forecast skill.
 */
import { buildProjections, RECENCY } from '../server/services/projections.js';
const SEASON = Number(process.env.NFL_SEASON) || 2026;
import { volumeKFits, toKVector, activeKVector, activeKVectorFor } from '../server/services/shrinkage-fit.js';
import { WEEKLY_ROLE_RECENCY } from '../server/services/weekly-ensemble.js';
import { actuals } from '../server/services/backtest.js';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const VS_ACTUALS = process.argv.includes('--vs-actuals');
const season = arg('season', SEASON);
const week = arg('week', 2);
const STARTERS = { QB: 24, RB: 48, WR: 60, TE: 24 };

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);

/* The vector under test: the active one if a fit is already promoted, else the
 * one the gate would write. Naming which it is matters — running this after the
 * promotion compares the live vector against the constants it replaced. */
const active = activeKVector();
const vector = active ?? toKVector(volumeKFits(season - 1));
console.log(active ? 'Comparing the ACTIVE fit against the hand-picked constants.'
                   : 'No fit is active. Comparing the CANDIDATE fit the gate would write.');
console.log('vector:', JSON.stringify(vector));
console.log(`cutoff: ${season} week ${week}\n`);

/* The two call shapes production actually uses. */
const WEEKLY = { through: season, throughWeek: week - 1, roleRecency: WEEKLY_ROLE_RECENCY };
const SEASON_LONG = { through: season - 1 };

function compare(shape) {
  const before = buildProjections({ ...shape, kOverride: null });
  const after = buildProjections({ ...shape, kOverride: vector });
  const out = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (a) out.push({ id, pos: b.position, name: b.name, old: b.ppg, new: a.ppg, d: a.ppg - b.ppg });
  }
  return out;
}

const report = (label, list) => {
  if (!list.length) return console.log(`${label.padEnd(26)} n=   0`);
  const d = list.map(r => r.d), ad = d.map(Math.abs);
  console.log(`${label.padEnd(26)} n=${String(list.length).padStart(4)}  mean ${sign(mean(d))}  ` +
    `median ${sign(q(d, 0.5))}  |d| p90 ${q(ad, 0.9).toFixed(2)}  max ${Math.max(...ad).toFixed(2)}  ` +
    `up ${d.filter(x => x > 0.01).length} / down ${d.filter(x => x < -0.01).length}`);
};

/* The season-long path must be read at the RESOLVER, not by diffing with an
 * explicit kOverride. An explicit override bypasses activeKVectorFor entirely,
 * so a forced diff answers "what if the guard were gone", which is a different
 * and much larger question. Both are reported below, labelled as such. */
console.log('SEASON-LONG callers (draft board, ROS, season sim, preseason, season endpoints)');
const resolvedDefault = activeKVectorFor({ ...RECENCY }, { predictingSeason: season });
const resolvedWeekly = activeKVectorFor({ ...RECENCY, ...WEEKLY_ROLE_RECENCY }, { predictingSeason: season });
if (!active) {
  console.log('   No fit is active, so nothing resolves yet. After promotion, the guard');
  console.log('   in activeKVectorFor decides; re-run this script then to see it directly.');
} else {
  console.log(`   activeKVectorFor(default recency)  -> ${resolvedDefault ? JSON.stringify(resolvedDefault) : 'null'}`);
  console.log(`   activeKVectorFor(WEEKLY_ROLE_RECENCY) -> ${resolvedWeekly ? 'the full vector' : 'null'}`);
  console.log(resolvedDefault === null
    ? '   => 0 season-long projections move. The volume constants are stripped here.'
    : '   => UNEXPECTED: the guard did not strip the volume metrics. Stop and read activeKVectorFor.');
}

const seasonLong = compare(SEASON_LONG);   // forced override: the counterfactual
report('   if the guard were lifted', seasonLong);
console.log('   (that line is NOT what promotion does — it is what the season-long path');
console.log('    is currently leaving on the table, and it is next-train work, not a flip:');
console.log('    the vector was never fitted under season-long recency.)');

const weekly = compare(WEEKLY);
console.log('\nWEEKLY caller (player-week-engine -> start/sit, trade values, props, expert council)');
report('   all', weekly);
for (const p of Object.keys(STARTERS)) report(`     ${p}`, weekly.filter(r => r.pos === p));

let pool = [];
console.log('\n   startable pool, top N per position by the CURRENT projection');
for (const [p, n] of Object.entries(STARTERS)) {
  const top = weekly.filter(r => r.pos === p).sort((a, b) => b.old - a.old).slice(0, n);
  report(`     ${p} top ${n}`, top);
  pool = pool.concat(top);
}
report('     combined', pool);

console.log('\n   rank churn within position');
for (const [p, n] of Object.entries(STARTERS)) {
  const all = weekly.filter(r => r.pos === p);
  const oldTop = new Set([...all].sort((a, b) => b.old - a.old).slice(0, n).map(r => r.id));
  const newTop = new Set([...all].sort((a, b) => b.new - a.new).slice(0, n).map(r => r.id));
  console.log(`     ${p}: ${n - [...oldTop].filter(i => newTop.has(i)).length} of ${n} swapped out of the top ${n}`);
}

console.log('\n   biggest movers in the startable pool');
for (const r of [...pool].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12)) {
  console.log(`     ${r.pos.padEnd(3)} ${String(r.name).padEnd(24)} ${r.old.toFixed(2).padStart(6)} -> ${r.new.toFixed(2).padStart(6)}  ${sign(r.d)}`);
}

if (VS_ACTUALS) {
  const truth = actuals(season - 1);
  const graded = weekly.map(r => ({ ...r, act: truth.get(r.id)?.ppg, g: truth.get(r.id)?.games }))
    .filter(r => r.act != null && r.g >= 8);
  const mae = (xs, f) => mean(xs.map(r => Math.abs(f(r) - r.act)));
  const bias = (xs, f) => mean(xs.map(r => f(r) - r.act));
  const line = (label, xs) => console.log(`${label.padEnd(24)} n=${String(xs.length).padStart(4)}  ` +
    `old MAE ${mae(xs, r => r.old).toFixed(2)} bias ${sign(bias(xs, r => r.old))}  |  ` +
    `new MAE ${mae(xs, r => r.new).toFixed(2)} bias ${sign(bias(xs, r => r.new))}`);

  console.log(`\nLEVEL CHECK against ${season - 1} per-game scoring (8+ games).`);
  console.log('Not a forecast test — it grades against the season the projection is built from.');
  line('   all', graded);
  for (const p of Object.keys(STARTERS)) line(`     ${p}`, graded.filter(r => r.pos === p));
  const top = [];
  for (const [p, n] of Object.entries(STARTERS)) {
    top.push(...graded.filter(r => r.pos === p).sort((a, b) => b.act - a.act).slice(0, n));
  }
  line(`     startable by ${season - 1}`, top);
}
