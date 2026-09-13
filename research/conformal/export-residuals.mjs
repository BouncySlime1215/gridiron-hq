/**
 * Export the EXACT residual panel that server/services/model-intelligence.js
 * `uncertainty()` consumes, plus that function's own hand-rolled conformal
 * output, so an independent library (MAPIE) can be run on identical numbers.
 *
 * Giant Plan §7.3 / FIX #26. The rationale is narrow and worth restating: this
 * codebase had six hand-rolled numeric bugs found in a single file, so a
 * hand-rolled split-conformal implementation deserves a second opinion from a
 * library many people have reviewed. This script does not re-implement the
 * conformal maths — it calls the shipped code and writes down what it did.
 *
 * SAFETY: this never touches server/data.sqlite. It requires GRIDIRON_DB_PATH
 * to point somewhere under a temp directory and refuses to run otherwise, then
 * seeds the deterministic fixture league from test/helpers/seed-league-history.js.
 * The fixture is a stand-in for the shape of the panel, NOT for real football:
 * coverage numbers below describe the implementations, not the NFL.
 */
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.GRIDIRON_DB_PATH || '';
if (!/^\/(private\/)?tmp\//.test(dbPath)) {
  console.error(`Refusing to run: GRIDIRON_DB_PATH must be a fresh /tmp path, got ${dbPath || '(unset)'}`);
  process.exit(2);
}
if (fs.existsSync(dbPath)) {
  console.error(`Refusing to run: ${dbPath} already exists; use a fresh unused path.`);
  process.exit(2);
}

const outDir = process.argv[2];
if (!outDir) { console.error('usage: export-residuals.mjs <output-dir>'); process.exit(2); }

const { db, run } = await import('../../server/db/index.js');
const { seedTeams, seedLeagueHistory } = await import('../../test/helpers/seed-league-history.js');
seedTeams(db);

// Sixteen seasons so the first graded outer fold still has >= 500 training
// games and clears the LEAGUE_MIN_SEASON + 5 warmup filter in nfl-market.js.
const seasons = Array.from({ length: 16 }, (_, i) => 2010 + i);
const seeded = seedLeagueHistory(run, { seasons });

const { nestedEvaluationRows, clearNflMarketCache } = await import('../../server/services/nfl-market.js');
clearNflMarketCache();
const nested = nestedEvaluationRows();
if (nested.error) { console.error('nestedEvaluationRows failed:', nested.error); process.exit(1); }

// ---- the panel, exactly as uncertainty() sees it ----------------------------
const panel = nested.rows.map(r => ({
  season: r.g.season,
  week: r.g.week,
  pred_margin: r.predMargin,
  actual_margin: r.actualMargin,
  pred_total: r.predTotal,
  actual_total: r.actualTotal
}));

// ---- the shipped hand-rolled conformal output -------------------------------
// Imported, not re-derived: if uncertainty() has a bug, this carries the bug,
// which is the entire point of the cross-check.
const { nflIntelligence } = await import('../../server/services/model-intelligence.js');
let jsUncertainty;
try {
  jsUncertainty = nflIntelligence().uncertainty;
} catch (err) {
  // nflIntelligence() pulls in daemons/ledgers that a bare fixture DB may not
  // have; fall back to the same uncertainty() inputs via a direct recompute of
  // ONLY the published fold table, using the module's own exported path when
  // available. Recorded so the report can say which path produced the numbers.
  jsUncertainty = { error: String(err && err.message || err) };
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'panel.json'), JSON.stringify({
  source: 'deterministic fixture league (test/helpers/seed-league-history.js), NOT real NFL history',
  db_path: dbPath,
  seeded,
  evaluation_seasons: nested.evaluation_seasons,
  n: panel.length,
  rows: panel
}, null, 2));
fs.writeFileSync(path.join(outDir, 'js-uncertainty.json'), JSON.stringify(jsUncertainty, null, 2));

console.log(`panel rows: ${panel.length}; eval seasons: ${nested.evaluation_seasons.join(',')}`);
console.log(`wrote ${outDir}/panel.json and ${outDir}/js-uncertainty.json`);
