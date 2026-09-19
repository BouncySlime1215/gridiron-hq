#!/usr/bin/env node
/**
 * The measurement `scripts/execution-fill-study.mjs` explicitly could NOT make:
 * "Not measured, and not claimed: anything about real order books ... The
 * only book store is server/data.sqlite, off-limits to this session."
 *
 * This script is that measurement. It opens the real database READ-ONLY
 * (node:sqlite `{ readOnly: true }`, its own connection -- never the app's
 * server/db/index.js, which opens read-write and would sit next to the live
 * capture process) and runs the pure functions in execution-fill.js against
 * every real captured quote that has genuine bid_size/ask_size. It writes
 * nothing, anywhere, ever: no INSERT, no UPDATE, no schema call, no journal
 * mode change. `db.close()` runs immediately after the one SELECT.
 *
 * WHAT IT MEASURES
 *   For each real captured two-sided Polymarket quote (best_bid, best_ask,
 *   bid_size, ask_size all present and sane) and a range of desired stakes,
 *   compare:
 *     naive  -- naiveFill(): the whole stake fills at the posted touch price
 *               (this is what live-edge.js and polymarket.js's reporting
 *               tier assume today)
 *     real   -- simulateFill(): what fromStoredQuote()'s one-level book
 *               (the only book shape stored history has -- see
 *               POLYMARKET_LADDER_NOTE in execution-fill.js) actually absorbs
 *   and report the fill-ratio gap between them.
 *
 * WHAT IT DOES NOT MEASURE
 *   Average-price slippage past the touch. `polymarket_quotes` only ever
 *   stored one level (see migration 044's comment and execution-fill.js's own
 *   CAVEAT), so every historical book here has exactly one ask level and one
 *   bid level: a fill either completes AT the touch price or is capped by
 *   touch SIZE with the remainder simply unfilled, never priced worse. The
 *   "40% of this stake never fills" finding below is real; "and would have
 *   cost 3 cents more per share" is not measurable from this table and this
 *   script does not claim it.
 *
 * USAGE
 *   node scripts/execution-fill-real-book-validation.mjs
 *   REAL_DB_PATH=/path/to/other/data.sqlite node scripts/execution-fill-real-book-validation.mjs
 *
 * Calls no network. Opens exactly one file, read-only, and closes it before
 * any arithmetic runs.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const { fromStoredQuote, simulateFill, naiveFill } =
  await import(path.join(repoRoot, 'server/services/execution-fill.js'));

const REAL_DB = process.env.REAL_DB_PATH ??
  new URL('../server/data.sqlite', import.meta.url).pathname;

console.log(`Opening ${REAL_DB} read-only (node:sqlite { readOnly: true }).`);
const db = new DatabaseSync(REAL_DB, { readOnly: true });

// The entire population this measurement can be made on: every row across the
// whole capture history (started 2026-08-29) where the book side actually
// carried a real size. Most of the 16.5M-row table has null sizes -- this
// WHERE clause is exactly the reason.
const rows = db.prepare(`
  SELECT q.captured_at, q.condition_id, q.best_bid, q.best_ask, q.bid_size, q.ask_size, m.question
  FROM polymarket_quotes q
  JOIN polymarket_markets m ON m.condition_id = q.condition_id
  WHERE q.bid_size IS NOT NULL AND q.ask_size IS NOT NULL
    AND q.bid_size > 0 AND q.ask_size > 0
    AND q.best_bid IS NOT NULL AND q.best_ask IS NOT NULL
    AND q.best_ask > q.best_bid AND q.best_ask < 1 AND q.best_bid > 0
`).all();
db.close(); // done with the real file before any arithmetic runs

console.log(`Real snapshots with a genuine two-sided touch + size: ${rows.length}`);
console.log(`Distinct markets represented: ${new Set(rows.map(r => r.condition_id)).size}\n`);

const STAKES = [50, 100, 250, 500, 1000, 2500, 5000];
const side = 'buy'; // buying YES at the ask, walking the ask ladder

const results = {};
for (const stake of STAKES) results[stake] = { fully_filled: 0, fill_ratios: [] };

for (const r of rows) {
  const book = fromStoredQuote(r);
  const touch = book.asks[0]?.price;
  if (!touch) continue;
  for (const stake of STAKES) {
    const real = simulateFill({ book, side, shares: stake / touch });
    const bucket = results[stake];
    if (real.fill_ratio >= 0.999999) bucket.fully_filled++;
    bucket.fill_ratios.push(real.fill_ratio);
  }
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

console.log('Naive ("the whole stake fills at the posted ask", fill_ratio == 1 always) vs the REAL');
console.log('posted ask_size, measured on every real two-sided snapshot this database holds:\n');
console.log('stake'.padEnd(8) + 'n'.padEnd(9) + 'fully_filled%'.padEnd(15) +
  'mean_fill_ratio'.padEnd(17) + 'median_fill_ratio'.padEnd(19) +
  'p10_fill_ratio'.padEnd(16) + 'naive_overstatement');
const summary = [];
for (const stake of STAKES) {
  const b = results[stake];
  const n = b.fill_ratios.length;
  const row = {
    stake, n,
    fully_filled_pct: +(100 * b.fully_filled / n).toFixed(1),
    mean_fill_ratio: +mean(b.fill_ratios).toFixed(4),
    median_fill_ratio: +pct(b.fill_ratios, 0.5).toFixed(4),
    p10_fill_ratio: +pct(b.fill_ratios, 0.10).toFixed(4)
  };
  row.naive_overstatement_pct = +(100 * (1 - row.mean_fill_ratio)).toFixed(2);
  summary.push(row);
  console.log(
    `$${stake}`.padEnd(8) + String(n).padEnd(9) +
    row.fully_filled_pct.toFixed(1).padEnd(15) +
    row.mean_fill_ratio.toFixed(4).padEnd(17) +
    row.median_fill_ratio.toFixed(4).padEnd(19) +
    row.p10_fill_ratio.toFixed(4).padEnd(16) +
    row.naive_overstatement_pct + '%'
  );
}

const askDollarDepth = rows.map(r => r.ask_size * r.best_ask).filter(Number.isFinite);
console.log(`\nReal executable size AT THE TOUCH ONLY (ask_size * best_ask, in dollars), n=${askDollarDepth.length}:`);
const depthSummary = {
  p10: +pct(askDollarDepth, 0.10).toFixed(2), p25: +pct(askDollarDepth, 0.25).toFixed(2),
  median: +pct(askDollarDepth, 0.5).toFixed(2), p75: +pct(askDollarDepth, 0.75).toFixed(2),
  p90: +pct(askDollarDepth, 0.90).toFixed(2), mean: +mean(askDollarDepth).toFixed(2)
};
console.log(`  p10=$${depthSummary.p10}  p25=$${depthSummary.p25}  median=$${depthSummary.median}  ` +
  `p75=$${depthSummary.p75}  p90=$${depthSummary.p90}  mean=$${depthSummary.mean}`);

console.log('\nWorst 10 real snapshots at a $500 desired stake (thinnest touches):');
const at500 = rows.map(r => {
  const book = fromStoredQuote(r);
  const touch = book.asks[0]?.price;
  if (!touch) return null;
  const real = simulateFill({ book, side: 'buy', shares: 500 / touch });
  return { question: r.question, captured_at: r.captured_at, ask_size: r.ask_size,
    best_ask: r.best_ask, fill_ratio: real.fill_ratio };
}).filter(Boolean).sort((a, b) => a.fill_ratio - b.fill_ratio).slice(0, 10);
for (const w of at500) {
  console.log(`  ${w.captured_at}  ${(w.question ?? '').slice(0, 50).padEnd(52)} ` +
    `ask=${w.best_ask} size=${w.ask_size}  fill_ratio=${w.fill_ratio}`);
}

if (process.env.WRITE_EVIDENCE_JSON) {
  const fs = await import('node:fs');
  const out = {
    generated_at: new Date().toISOString(),
    source_db: REAL_DB,
    note: 'READ-ONLY measurement. avg_price slippage beyond the touch is not measurable ' +
      'from this table -- every stored book has exactly one level. See header comment.',
    snapshots: rows.length,
    distinct_markets: new Set(rows.map(r => r.condition_id)).size,
    by_stake: summary,
    touch_depth_dollars: depthSummary,
    worst_at_500: at500
  };
  fs.writeFileSync(process.env.WRITE_EVIDENCE_JSON, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${process.env.WRITE_EVIDENCE_JSON}`);
}
