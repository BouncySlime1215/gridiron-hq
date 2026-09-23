import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB);
const rows = db.prepare(
  `SELECT season, week, team, features FROM nfl_team_week_features WHERE season BETWEEN 2022 AND 2025`
).all();
const vals = [];
for (const r of rows) {
  let f; try { f = JSON.parse(r.features); } catch { continue; }
  const v = f.off_fourth_down_rate;
  if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
}
vals.sort((a, b) => a - b);
const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
console.log(`off_fourth_down_rate over ${rows.length} team-weeks, ${vals.length} finite`);
console.log(`  mean   ${mean.toFixed(4)}`);
console.log(`  p10 ${q(0.10).toFixed(3)}  p25 ${q(0.25).toFixed(3)}  median ${q(0.50).toFixed(3)}  p75 ${q(0.75).toFixed(3)}  p90 ${q(0.90).toFixed(3)}`);
console.log(`  share >= 0.40: ${(vals.filter(v => v >= 0.40).length / vals.length * 100).toFixed(1)}%`);
console.log(`  share <= 0.25: ${(vals.filter(v => v <= 0.25).length / vals.length * 100).toFixed(1)}%`);
console.log('');
console.log('League go-for-it prior asserted by nfl-sim-learn.js:52 and nfl-sim-policy.js:510 = 0.20');
console.log('');
// What the aggression module actually does with it.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shifts = vals.map(v => clamp(-(v - 0.20) * 3.0, -0.6, 0.6));
const atFloor = shifts.filter(s => s <= -0.5999).length;
console.log(`coachAggression ep_threshold_shift from these values:`);
console.log(`  mean ${(shifts.reduce((s, v) => s + v, 0) / shifts.length).toFixed(4)}  (0 would be league-average)`);
console.log(`  pinned at the -0.6 clamp floor: ${(atFloor / shifts.length * 100).toFixed(1)}% of team-weeks`);
console.log(`  reason "more conservative than the league": ${(vals.filter(v => v - 0.20 < -0.03).length / vals.length * 100).toFixed(1)}%`);
