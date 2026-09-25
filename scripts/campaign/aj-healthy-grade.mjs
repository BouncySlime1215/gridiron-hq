#!/usr/bin/env node
/**
 * AJ-HEALTHY grade: does CONSISTENT_NOW ("a consistent weekly scorer now") predict a held floor
 * over the next four weeks? Read-only over nfl_ffopportunity_weekly for completed seasons; prints
 * one JSON object and a PASS/FAIL line against the pre-registered bar (consistent-now.js).
 * GRIDIRON_AJ_HEALTHY stays off until this prints PASS on the Mac's database.
 *
 *   node scripts/campaign/aj-healthy-grade.mjs [--seasons 2023,2024,2025] [--seed 1]
 */
import { row, rows, db } from '../../server/db/index.js';
import { gradeConsistency } from '../../server/services/campaign/consistent-now.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
db.exec('PRAGMA query_only = ON');

if (!row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nfl_ffopportunity_weekly'`)) {
  console.error('nfl_ffopportunity_weekly is not on this database: nothing to grade');
  process.exit(2);
}
const seasons = String(arg('seasons', '2023,2024,2025')).split(',').map(Number).filter(Number.isInteger);
const seed = Number(arg('seed', 1));
const data = rows(`SELECT season, week, player_gsis_id, position, expected_fantasy_points, actual_fantasy_points
                   FROM nfl_ffopportunity_weekly WHERE season IN (${seasons.map(() => '?').join(', ')})
                   ORDER BY season, player_gsis_id, week`, ...seasons);
const series = new Map();
for (const r of data) {
  const k = `${r.season}:${r.player_gsis_id}`;
  if (!series.has(k)) series.set(k, { player: r.player_gsis_id, position: r.position, season: r.season, weeks: [] });
  series.get(k).weeks.push({ week: r.week, actual: r.actual_fantasy_points, expected: r.expected_fantasy_points });
}
const g = gradeConsistency([...series.values()], { seed });
console.log(JSON.stringify({ seasons, rows: data.length, players: series.size, ...g }, null, 2));
console.log(g.pass ? 'AJ-HEALTHY grade: PASS' : `AJ-HEALTHY grade: FAIL (${g.fails.join('; ')})`);
process.exit(g.pass ? 0 : 1);
