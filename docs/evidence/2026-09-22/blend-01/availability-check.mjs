// Descriptive (local copy, not production): the served chance to play for 2026 week 3, from the
// same call trade-engine.js makes (weeklyAvailability(season, week, { through: season - 1 })),
// for players ESPN projects >= 8 points this week, split by whether they carry a designation.
// Run from the repo root on a COPY of the app database:
//   GRIDIRON_DB_PATH=.local-db/data.sqlite NFL_SEASON=2026 node docs/evidence/2026-09-22/blend-01/availability-check.mjs
const ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import(`${ROOT}/server/db/index.js`);
const { weeklyAvailability, availabilityBasis } = await import(`${ROOT}/server/services/contingency.js`);
const a = weeklyAvailability(2026, 3, { through: 2025 });
const espn = new Map(rows(`SELECT espn_player_id, MAX(projected_points) AS pts FROM league_roster_snapshots
  WHERE season = 2026 AND scoring_period_id = 3 AND on_roster = 1 GROUP BY espn_player_id`).map(r => [String(r.espn_player_id), r.pts]));
const players = rows(`SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL AND espn_id != 0 AND position IN ('QB','RB','WR','TE')`);
const sel = players.map(p => ({ p, e: espn.get(String(p.espn_id)), av: a.get(p.id) })).filter(x => x.e != null && x.e >= 8 && x.av);
const m = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
const noDes = sel.filter(x => !x.av.report_status);
console.log('basis', JSON.stringify(availabilityBasis()));
console.log('ESPN >= 8 this week:', sel.length, 'mean active_probability', m(sel.map(x => x.av.active_probability)).toFixed(3),
  '| no designation:', noDes.length, 'mean', m(noDes.map(x => x.av.active_probability)).toFixed(3),
  'min', Math.min(...noDes.map(x => x.av.active_probability)), 'max', Math.max(...noDes.map(x => x.av.active_probability)));
const bySource = {};
for (const x of noDes) { const k = `${x.av.availability_basis}|measured=${x.av.durability_prior_measured}`; (bySource[k] ??= []).push(x.av.active_probability); }
for (const [k, v] of Object.entries(bySource)) console.log(' ', k, 'n', v.length, 'mean p', m(v).toFixed(3), 'mean prior', m(noDes.filter(x => `${x.av.availability_basis}|measured=${x.av.durability_prior_measured}` === k).map(x => x.av.durability_prior)).toFixed(3));
