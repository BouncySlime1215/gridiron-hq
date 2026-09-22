// Feed-zero sweep, pass 3: does nfl_player_week_features carry the same
// literal-zero contamination as player_week_usage?
//
// Usage: node docs/evidence/feed-zero-player-week-features.mjs <path to data.sqlite>
// Answer, measured 2026-09-22 over 21,427 rows: no. See
// docs/evidence/feed-zero-contamination-measured.md section 7.
//
// The writer is server/services/nfl-pbp.js:589-678. Its helper at :115 is
//   const div = (a, b) => (b > 0 ? a / b : null);
// so target_share / carry_share / air_yards_share / opportunity_share are
// null-on-inapplicable BY CONSTRUCTION. wopr is not: :650 reads
//   wopr: r3(1.5 * (tgtShare ?? 0) + 0.7 * (airShare ?? 0))
// which turns either null into a literal 0 and publishes the sum as if both
// components were measured. This script counts how often that happens.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const all = db.prepare('SELECT season, week, player_id, team, position, features FROM nfl_player_week_features').all();

const b = { n: 0, both_null: 0, tgt_only_null: 0, air_only_null: 0, clean: 0 };
const woprZero = { total: 0, from_null: 0, true_zero: 0 };
const noTeam = { rows: 0, wopr_zero: 0 };
const byPos = new Map();

for (const r of all) {
  const f = JSON.parse(r.features);
  b.n++;
  const tNull = f.target_share == null, aNull = f.air_yards_share == null;
  if (tNull && aNull) b.both_null++;
  else if (tNull) b.tgt_only_null++;
  else if (aNull) b.air_only_null++;
  else b.clean++;

  if (f.wopr === 0) {
    woprZero.total++;
    if (tNull || aNull) woprZero.from_null++; else woprZero.true_zero++;
  }
  if (!r.team) { noTeam.rows++; if (f.wopr === 0) noTeam.wopr_zero++; }

  // Per-position view of the partial collapse: a row with a real target share
  // but a null air share still publishes a wopr, just a smaller one.
  if (aNull && !tNull) {
    const k = String(r.position ?? '?').toUpperCase();
    const e = byPos.get(k) ?? { rows: 0, sum_tgt: 0 };
    e.rows++; e.sum_tgt += f.target_share;
    byPos.set(k, e);
  }
}

const pct = (a, n) => `${a} (${(100 * a / n).toFixed(2)}%)`;
console.log('rows                         ', b.n);
console.log('both shares null             ', pct(b.both_null, b.n));
console.log('target_share null only       ', pct(b.tgt_only_null, b.n));
console.log('air_yards_share null only    ', pct(b.air_only_null, b.n));
console.log('both measured (clean)        ', pct(b.clean, b.n));
console.log('---');
console.log('wopr === 0 rows              ', pct(woprZero.total, b.n));
console.log('  of which a null was coerced', woprZero.from_null);
console.log('  of which a true zero       ', woprZero.true_zero);
console.log('---');
console.log('rows with no team            ', noTeam.rows, 'wopr 0 among them', noTeam.wopr_zero);
console.log('--- partial collapse: air null, target measured');
for (const [k, e] of [...byPos].sort((x, y) => y[1].rows - x[1].rows)) {
  console.log(`  ${k.padEnd(4)} rows ${String(e.rows).padStart(5)}  mean target_share ${(e.sum_tgt / e.rows).toFixed(4)}`);
}
