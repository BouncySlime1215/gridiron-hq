#!/usr/bin/env node
/**
 * The study: which DRAFT-TIME choices raise all-play win rate, per format.
 *
 * Runs only after study/replay/known-answers.mjs passes. See
 * docs/WHAT-WINS-STUDY.md; the discipline below is what the five-angle review
 * demanded and it is the whole difference between a result and a superstition.
 *
 *   EX-ANTE ONLY. Every regressor is knowable at the draft: archetype, draft
 *   slot, draft capital by position, ADP value captured, roster counts. Nothing
 *   realised. Regressing season-end strength on wins is points on points; it
 *   would produce a huge R-squared and no decision.
 *
 *   THE SEASON IS THE UNIT. Every simulated league inside 2023 shares 2023's
 *   breakouts, so thousands of leagues over five seasons is five draws, not
 *   thousands. Effects are reported per season and an effect only counts if its
 *   sign holds in at least 4 of 5. Confidence intervals come from a bootstrap
 *   that resamples SEASONS, not leagues.
 *
 *   MINIMUM PRACTICAL EFFECT. Pre-registered at 0.01 of all-play win rate
 *   (roughly a sixth of a win over a 14-week season). Smaller than that is not
 *   reported as a finding regardless of its interval.
 *
 *   THE FIELD MATTERS. Composition value is relative to what everyone else
 *   drafts, so each archetype is run at three adoption levels (1, 3 and 5 of
 *   the teams) and the effect is reported per level.
 *
 * Usage: node --env-file-if-exists=.env study/replay/study.mjs [--format redraft10_1flex] [--leagues 400]
 */
import { FORMATS, ARCHETYPES, loadSeason, runLeague } from './engine.mjs';

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const FORMAT_KEY = argOf('--format') ?? 'redraft10_1flex';
const PER_CELL = Number(argOf('--leagues') ?? 120);
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const ADOPTION = [1, 3, 5];
const MIN_EFFECT = 0.01;          // pre-registered
const STRATEGIES = ['zero_rb', 'hero_rb', 'robust_rb', 'early_qb', 'late_qb', 'early_te'];

const fmt = FORMATS[FORMAT_KEY];
if (!fmt) { console.error('unknown format', FORMAT_KEY); process.exit(1); }
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Bootstrap over SEASONS. Resampling leagues would treat 600 correlated draws
 * as independent and shrink the interval by roughly the square root of the
 * design effect, which the review put at 20-200.
 */
function seasonBootstrap(bySeason, iters = 4000) {
  const keys = Object.keys(bySeason).filter(k => bySeason[k] != null);
  if (keys.length < 2) return { lo: null, hi: null };
  let s = 987654321;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const draws = [];
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let k = 0; k < keys.length; k++) acc += bySeason[keys[Math.floor(rand() * keys.length)]];
    draws.push(acc / keys.length);
  }
  draws.sort((a, b) => a - b);
  return { lo: +draws[Math.floor(iters * 0.05)].toFixed(4), hi: +draws[Math.floor(iters * 0.95)].toFixed(4) };
}

console.log(`Format: ${fmt.label} | ${PER_CELL} leagues per cell | seasons ${SEASONS.join(',')}`);
console.log('Loading seasons...');
const data = Object.fromEntries(SEASONS.map(y => [y, loadSeason(y, fmt.scoring)]));

/**
 * One cell: a strategy at one adoption level, in one season. Returns the
 * strategy teams' mean all-play minus the balanced teams' mean all-play in the
 * SAME leagues — a within-league contrast, so draft-slot and season effects
 * cancel rather than needing to be controlled.
 */
function runCell(season, strategy, adopters, seed0) {
  const s = data[season];
  const diffs = [], slotEffect = [];
  let seed = seed0;
  for (let i = 0; i < PER_CELL; i++) {
    const agents = Array.from({ length: fmt.teams }, (_, k) => (k < adopters ? strategy : 'balanced'));
    // Rotate which slots the adopters occupy so the contrast is not confounded
    // with draft position.
    const rot = i % fmt.teams;
    const rotated = agents.map((_, k) => agents[(k + rot) % fmt.teams]);
    const r = runLeague(s, fmt, rotated, seed++);
    const teams = r.arms[fmt.bestBall ? 'hindsight' : 'attainable'].teams;
    const mineIdx = rotated.map((a, k) => (a === strategy ? k : -1)).filter(k => k >= 0);
    const theirIdx = rotated.map((a, k) => (a === 'balanced' ? k : -1)).filter(k => k >= 0);
    if (!mineIdx.length || !theirIdx.length) continue;
    diffs.push(mean(mineIdx.map(k => teams[k].all_play)) - mean(theirIdx.map(k => teams[k].all_play)));
    for (const k of [...mineIdx, ...theirIdx]) slotEffect.push([k, teams[k].all_play]);
  }
  return { diff: mean(diffs), n: diffs.length, slotEffect };
}

const findings = [];
const slotPool = [];
for (const strategy of STRATEGIES) {
  for (const adopters of ADOPTION) {
    const bySeason = {};
    let seed = 20000 + strategy.length * 977 + adopters * 131;
    for (const season of SEASONS) {
      const c = runCell(season, strategy, adopters, seed); seed += PER_CELL + 7;
      bySeason[season] = c.diff;
      if (adopters === 1) slotPool.push(...c.slotEffect);
    }
    const vals = SEASONS.map(y => bySeason[y]).filter(Number.isFinite);
    const pooled = mean(vals);
    const positive = vals.filter(v => v > 0).length;
    const signStable = Math.max(positive, vals.length - positive) >= 4;
    const ci = seasonBootstrap(bySeason);
    findings.push({
      strategy, adopters, pooled: +pooled.toFixed(4), bySeason,
      sign_seasons: `${positive}/${vals.length} positive`, sign_stable: signStable,
      ci_lo: ci.lo, ci_hi: ci.hi,
      material: Math.abs(pooled) >= MIN_EFFECT,
      verdict: signStable && Math.abs(pooled) >= MIN_EFFECT
        ? (pooled > 0 ? 'HELPS' : 'HURTS')
        : (Math.abs(pooled) < MIN_EFFECT ? 'too small' : 'unstable'),
    });
    process.stdout.write('.');
  }
}
console.log('\n');

/* --------------------------------------------------------------- the report */
console.log('='.repeat(112));
console.log(`EX-ANTE STRATEGY EFFECTS — ${fmt.label}`);
console.log('effect = strategy teams\' all-play minus balanced teams\' all-play, same leagues. Min practical effect 0.010.');
console.log('='.repeat(112));
console.log('strategy      adopt   effect   90% CI (season boot)   per-season signs          verdict');
for (const f of findings.sort((a, b) => b.pooled - a.pooled)) {
  const per = SEASONS.map(y => (f.bySeason[y] == null ? ' -- ' : (f.bySeason[y] > 0 ? '+' : '-'))).join(' ');
  console.log(
    `${f.strategy.padEnd(12)} ${String(f.adopters).padStart(3)}/${fmt.teams}` +
    `  ${(f.pooled > 0 ? '+' : '') + f.pooled.toFixed(4)}`.padStart(10) +
    `   [${String(f.ci_lo).padStart(7)}, ${String(f.ci_hi).padStart(7)}]` +
    `   ${per}  (${f.sign_seasons})`.padEnd(26) +
    `  ${f.verdict}`);
}

/* draft slot — a known effect that must appear, as a sanity check */
const bySlot = new Map();
for (const [slot, ap] of slotPool) (bySlot.get(slot) ?? bySlot.set(slot, []).get(slot)).push(ap);
console.log('\n--- draft slot (sanity: early slots should be at or above late ones) ---');
console.log([...bySlot.keys()].sort((a, b) => a - b)
  .map(k => `${k + 1}:${mean(bySlot.get(k)).toFixed(3)}`).join('  '));

const real = findings.filter(f => f.verdict === 'HELPS' || f.verdict === 'HURTS');
console.log('\n' + '='.repeat(112));
if (!real.length) {
  console.log('NO strategy cleared both bars (sign stable in >=4 of 5 seasons AND >=0.010 all-play).');
  console.log('That is the expected result given the literature: structure effects in managed formats are');
  console.log('small and flip year to year. The target spec becomes: capture ADP value, keep live players,');
  console.log('and switch lineup posture by stage — not "draft this shape".');
} else {
  for (const f of real) {
    console.log(`${f.verdict}: ${f.strategy} at ${f.adopters}/${fmt.teams} adopters — ` +
      `${(f.pooled * 100).toFixed(1)}pp of all-play, ${f.sign_seasons}, CI [${f.ci_lo}, ${f.ci_hi}]`);
  }
}
console.log('='.repeat(112));
process.exit(0);
