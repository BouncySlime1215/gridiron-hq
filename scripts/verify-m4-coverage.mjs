/**
 * INTEGRATION VERIFICATION (2026-09-12): re-measure m4's conformal claim.
 *
 * Runs only against a fresh scratch database seeded with this repo's own
 * deterministic league fixture. It never opens server/data.sqlite.
 *
 * Reports, on the SAME held-out rows, the coverage/width/Brier of
 *   BEFORE: one pooled-SD normal interval + normalCdf win probability
 *   AFTER : the Mondrian split-conformal interval + its own empirical CDF
 */
// This script WRITES a synthetic league into the database it is pointed at, so
// it refuses any path that is not an explicit scratch file under /tmp. Seeding
// a fixture into the real history would be unrecoverable.
const dbPath = process.env.GRIDIRON_DB_PATH ?? '';
if (!/^\/(private\/)?tmp\//.test(dbPath)) {
  console.error('Refusing to run: GRIDIRON_DB_PATH must be a fresh scratch path under /tmp. ' +
    'This script seeds a synthetic league and must never touch real history.');
  process.exit(1);
}

// Dynamic, so the guard above runs BEFORE the db module is evaluated. A static
// import is hoisted and would open (and create) the database before the check.
const { run, db, rows } = await import('../server/db/index.js');
const { seedTeams, seedLeagueHistory } = await import('../test/helpers/seed-league-history.js');
const { nestedEvaluationRows, clearNflMarketCache } = await import('../server/services/nfl-market.js');

const SEASONS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const seed = Number(process.env.FIXTURE_SEED ?? 20260910);
seedTeams(db);
const seeded = seedLeagueHistory(run, { seasons: SEASONS, seed });
console.log(`seeded ${seeded.games} fixture games over ${SEASONS.length} seasons (seed ${seed})`);
console.log('game_lines rows:', rows('SELECT COUNT(*) n FROM game_lines')[0].n);

clearNflMarketCache();
const nested = nestedEvaluationRows();
if (nested.error) { console.error(nested.error); process.exit(1); }
const held = nested.rows;
console.log(`held-out rows: ${held.length}  seasons: ${nested.evaluation_seasons.join(',')}`);

const EDGES = [3, 6.5, 10];
const binKeyOf = r => Math.abs(r.g?.home_spread != null ? r.g.home_spread : r.predMargin);
const binLabel = k => k < EDGES[0] ? `0-${EDGES[0]}` : k < EDGES[1] ? `${EDGES[0]}-${EDGES[1]}`
  : k < EDGES[2] ? `${EDGES[1]}-${EDGES[2]}` : `${EDGES[2]}+`;

function report(label, intervalOf, probOf) {
  const bins = new Map();
  let hits = 0, width = 0, n = 0, brier = 0;
  for (const r of held) {
    const iv = intervalOf(r); if (!iv) continue;
    n++;
    const inside = r.actualMargin >= iv[0] && r.actualMargin <= iv[1];
    if (inside) hits++;
    width += iv[1] - iv[0];
    const b = binLabel(binKeyOf(r));
    const e = bins.get(b) ?? { n: 0, hits: 0 }; e.n++; e.hits += inside ? 1 : 0; bins.set(b, e);
    const p = probOf(r), win = r.actualMargin > 0 ? 1 : 0;
    brier += (p - win) ** 2;
  }
  const per = [...bins.entries()].map(([bin, e]) => ({ bin, n: e.n, cov: e.hits / e.n }));
  const maxErr = Math.max(...per.map(b => Math.abs(b.cov - 0.8)));
  const rms = Math.sqrt(per.reduce((s, b) => s + b.n * (b.cov - 0.8) ** 2, 0) / n);
  console.log(`\n${label}`);
  console.log(`  games ${n}  coverage ${(hits / n * 100).toFixed(1)}%  mean width ${(width / n).toFixed(2)}`);
  console.log(`  worst-bin |cov-80| ${(maxErr * 100).toFixed(1)}pp   n-weighted RMS bin error ${(rms * 100).toFixed(1)}pp`);
  console.log(`  Brier ${(brier / n).toFixed(4)}`);
  for (const b of per.sort((a, c) => (a.bin < c.bin ? -1 : 1))) {
    console.log(`    ${b.bin.padEnd(8)} n=${String(b.n).padStart(4)}  cov ${(b.cov * 100).toFixed(1)}%`);
  }
  return { n, coverage: hits / n, width: width / n, maxErr, rms, brier: brier / n };
}

const erf = x => { const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const normalCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

const before = report('BEFORE — one pooled SD, normal shape',
  r => [r.predMargin - 1.2816 * r.marginStd, r.predMargin + 1.2816 * r.marginStd],
  r => normalCdf(r.predMargin / r.marginStd));
const after = report('AFTER — Mondrian split-conformal, binned by |market spread|',
  r => r.marginConformal?.interval(r.predMargin, binKeyOf(r), 0.80),
  r => r.marginConformal?.probabilityAbove(r.predMargin, binKeyOf(r), 0) ?? normalCdf(r.predMargin / r.marginStd));

console.log('\n=== DELTA (after - before) ===');
console.log(`coverage        ${(before.coverage * 100).toFixed(1)}% -> ${(after.coverage * 100).toFixed(1)}%`);
console.log(`worst-bin err   ${(before.maxErr * 100).toFixed(1)}pp -> ${(after.maxErr * 100).toFixed(1)}pp`);
console.log(`RMS bin err     ${(before.rms * 100).toFixed(1)}pp -> ${(after.rms * 100).toFixed(1)}pp`);
console.log(`mean width      ${before.width.toFixed(2)} -> ${after.width.toFixed(2)}`);
console.log(`Brier           ${before.brier.toFixed(4)} -> ${after.brier.toFixed(4)}`);
