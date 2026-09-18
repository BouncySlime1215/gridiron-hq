#!/usr/bin/env node
/**
 * Fit the availability model that replaces contingency.js's hand-set constants.
 *
 * Priority one out of the study (docs/TARGET-SPEC.md section 6): the gap between
 * an attainable lineup and a perfect one is 19.4 points a week, and the largest
 * single component of it is starting somebody who does not play. Today every
 * team's "Questionable" is treated identically, with numbers typed in by hand:
 * Out 0.01, Doubtful capped at 0.15, Questionable clamped to [0.45, 0.75].
 *
 * Teams do not use the designation the same way. Some list a player Questionable
 * as a formality and play him; others use it to mean a genuine game-time call.
 * That is a measurable, stable property of the team's medical staff and it is
 * worth more than any refinement to the projection itself.
 *
 * WHAT "AVAILABLE" MEANS HERE: recorded usage in `player_week_usage` — a target,
 * a carry or an attempt. Deliberately not "dressed". A player who suits up and
 * touches the ball zero times scores zero, and the number this model feeds is a
 * fantasy projection, so the fantasy-relevant event is the right one. It makes
 * the absolute levels lower than published "percent who played" figures; the
 * comparison across teams, which is what we use, is unaffected.
 *
 * SHRINKAGE: a team-status cell has on the order of 10-60 observations across
 * five seasons, so raw rates would be mostly noise. Each cell is shrunk toward
 * the league rate for that status with a fitted strength, and the fit is chosen
 * by out-of-sample log loss on a held-out season rather than by taste.
 *
 * Writes `nfl_availability_rates`. Usage:
 *   node --env-file-if-exists=.env scripts/fit-availability.mjs [--dry-run]
 */
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');

const DRY = process.argv.includes('--dry-run');
const FIT_SEASONS = [2021, 2022, 2023, 2024];
const TEST_SEASON = 2025;

db.exec(`CREATE TABLE IF NOT EXISTS nfl_availability_rates (
  scope TEXT NOT NULL,            -- 'league' | 'team'
  team TEXT NOT NULL,             -- '' for league scope
  report_status TEXT NOT NULL,    -- normalised: out | doubtful | questionable | none
  practice_status TEXT NOT NULL,  -- normalised: dnp | limited | full | none | any
  p_active REAL NOT NULL,
  n INTEGER NOT NULL,
  raw_rate REAL,
  shrunk INTEGER NOT NULL,
  fitted_at TEXT NOT NULL,
  PRIMARY KEY (scope, team, report_status, practice_status))`);

const normStatus = s => {
  const t = String(s ?? '').toLowerCase();
  if (/out|reserve|\bir\b|pup|suspend/.test(t)) return 'out';
  if (/doubtful/.test(t)) return 'doubtful';
  if (/questionable/.test(t)) return 'questionable';
  return 'none';
};
const normPractice = s => {
  const t = String(s ?? '').toLowerCase();
  if (/did not|dnp/.test(t)) return 'dnp';
  if (/limited/.test(t)) return 'limited';
  if (/full/.test(t)) return 'full';
  return 'none';
};

/** Every skill-position injury report joined to whether he recorded usage. */
function observations(seasons) {
  const list = rows(`
    WITH played AS (
      SELECT DISTINCT u.season, u.week, p.gsis_id
      FROM player_week_usage u JOIN players p ON p.id = u.player_id
      WHERE p.gsis_id IS NOT NULL AND u.season IN (${seasons.join(',')})
    )
    SELECT i.season, i.week, i.team, i.report_status, i.practice_status,
           CASE WHEN played.gsis_id IS NOT NULL THEN 1 ELSE 0 END AS active
    FROM nfl_injuries i
    LEFT JOIN played ON played.season = i.season AND played.week = i.week AND played.gsis_id = i.gsis_id
    WHERE i.season IN (${seasons.join(',')}) AND i.gsis_id IS NOT NULL
      AND upper(i.position) IN ('QB','RB','WR','TE','FB','HB')`);
  return list.map(r => ({
    team: String(r.team ?? '').toUpperCase(),
    rs: normStatus(r.report_status), ps: normPractice(r.practice_status),
    active: r.active,
  }));
}

const agg = obs => {
  const m = new Map();
  for (const o of obs) {
    const k = `${o.rs}|${o.ps}`;
    const rec = m.get(k) ?? { n: 0, hits: 0 };
    rec.n++; rec.hits += o.active; m.set(k, rec);
  }
  return m;
};
const aggTeam = obs => {
  const m = new Map();
  for (const o of obs) {
    if (!o.team) continue;
    const k = `${o.team}|${o.rs}`;
    const rec = m.get(k) ?? { n: 0, hits: 0 };
    rec.n++; rec.hits += o.active; m.set(k, rec);
  }
  return m;
};

const fitObs = observations(FIT_SEASONS);
const testObs = observations([TEST_SEASON]);
console.log(`fit ${fitObs.length} reports (${FIT_SEASONS.join(',')}), test ${testObs.length} (${TEST_SEASON})`);

const leagueCells = agg(fitObs);
const leagueByStatus = new Map();
for (const o of fitObs) {
  const rec = leagueByStatus.get(o.rs) ?? { n: 0, hits: 0 };
  rec.n++; rec.hits += o.active; leagueByStatus.set(o.rs, rec);
}
const teamCells = aggTeam(fitObs);

/**
 * Shrink a team cell toward its league status rate: (hits + k*prior) / (n + k).
 * k is the number of notional league observations the prior is worth.
 */
const shrink = (hits, n, prior, k) => (hits + k * prior) / (n + k);

/** Out-of-sample log loss on the held-out season, for one shrinkage strength. */
function logLoss(k) {
  let ll = 0, n = 0;
  for (const o of testObs) {
    const lg = leagueByStatus.get(o.rs);
    const prior = lg && lg.n ? lg.hits / lg.n : 0.8;
    const cell = leagueCells.get(`${o.rs}|${o.ps}`);
    const base = cell && cell.n >= 30 ? cell.hits / cell.n : prior;
    const tc = teamCells.get(`${o.team}|${o.rs}`);
    let p = base;
    if (tc) {
      // A team's deviation is expressed as a RATIO to its league status rate and
      // applied to the status-and-practice cell, so team effect and practice
      // effect compose instead of one overwriting the other.
      const teamRate = shrink(tc.hits, tc.n, prior, k);
      const ratio = prior > 0 ? teamRate / prior : 1;
      p = Math.max(0.001, Math.min(0.999, base * ratio));
    }
    p = Math.max(0.001, Math.min(0.999, p));
    ll += o.active ? -Math.log(p) : -Math.log(1 - p);
    n++;
  }
  return n ? ll / n : Infinity;
}

let bestK = null, bestLL = Infinity;
const grid = [0, 5, 10, 15, 20, 30, 40, 60, 80, 120, 200, 400];
for (const k of grid) { const l = logLoss(k); if (l < bestLL) { bestLL = l; bestK = k; } }

// Baseline: the constants the app ships today, scored the same way.
function currentConstantsLoss() {
  let ll = 0, n = 0;
  for (const o of testObs) {
    let p = 0.92;
    if (o.rs === 'out') p = 0.01;
    else if (o.rs === 'doubtful') p = Math.min(p, 0.15);
    else if (o.rs === 'questionable') p = Math.min(0.75, Math.max(0.45, p * 0.70));
    if (o.rs !== 'out') {
      if (o.ps === 'dnp') p *= 0.72;
      else if (o.ps === 'limited') p *= 0.92;
      else if (o.ps === 'full' && o.rs !== 'doubtful') p = Math.max(p, 0.96);
    }
    p = Math.max(0.01, Math.min(0.995, p));
    ll += o.active ? -Math.log(p) : -Math.log(1 - p);
    n++;
  }
  return n ? ll / n : Infinity;
}
const curLL = currentConstantsLoss();
console.log(`\nshrinkage k fitted on ${TEST_SEASON} out-of-sample: k=${bestK}, log loss ${bestLL.toFixed(4)}`);
console.log(`current hand-set constants:                        log loss ${curLL.toFixed(4)}`);
console.log(`improvement: ${(((curLL - bestLL) / curLL) * 100).toFixed(1)}%`);

/* ------------------------------------------------------------------ output */
const out = [];
for (const [status, rec] of leagueByStatus) {
  out.push({ scope: 'league', team: '', rs: status, ps: 'any', p: rec.hits / rec.n, n: rec.n, raw: rec.hits / rec.n, shrunk: 0 });
}
for (const [key, rec] of leagueCells) {
  const [rs, ps] = key.split('|');
  if (rec.n < 30) continue;
  out.push({ scope: 'league', team: '', rs, ps, p: rec.hits / rec.n, n: rec.n, raw: rec.hits / rec.n, shrunk: 0 });
}
for (const [key, rec] of teamCells) {
  const [team, rs] = key.split('|');
  const lg = leagueByStatus.get(rs);
  const prior = lg && lg.n ? lg.hits / lg.n : 0.8;
  out.push({ scope: 'team', team, rs, ps: 'any', p: shrink(rec.hits, rec.n, prior, bestK), n: rec.n, raw: rec.hits / rec.n, shrunk: 1 });
}

console.log('\n--- league rates by status ---');
for (const r of out.filter(x => x.scope === 'league' && x.ps === 'any').sort((a, b) => b.n - a.n)) {
  console.log(`  ${r.rs.padEnd(13)} p=${r.p.toFixed(3)}  n=${r.n}`);
}
console.log('\n--- league rates by status x practice ---');
for (const r of out.filter(x => x.scope === 'league' && x.ps !== 'any').sort((a, b) => b.n - a.n).slice(0, 10)) {
  console.log(`  ${(r.rs + ' / ' + r.ps).padEnd(26)} p=${r.p.toFixed(3)}  n=${r.n}`);
}
const q = out.filter(x => x.scope === 'team' && x.rs === 'questionable' && x.n >= 15).sort((a, b) => b.p - a.p);
console.log(`\n--- the dialect: P(active | Questionable) by team, shrunk (n>=15), ${q.length} teams ---`);
for (const r of q.slice(0, 5)) console.log(`  most likely to play  ${r.team.padEnd(4)} ${r.p.toFixed(3)}  (raw ${r.raw.toFixed(3)}, n=${r.n})`);
for (const r of q.slice(-5)) console.log(`  least likely to play ${r.team.padEnd(4)} ${r.p.toFixed(3)}  (raw ${r.raw.toFixed(3)}, n=${r.n})`);
if (q.length) console.log(`  spread: ${(q[0].p - q.at(-1).p).toFixed(3)} between the most and least permissive team`);

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
const now = new Date().toISOString();
db.exec('BEGIN');
try {
  run('DELETE FROM nfl_availability_rates');
  for (const r of out) {
    run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, r.scope, r.team, r.rs, r.ps, +r.p.toFixed(4), r.n, +r.raw.toFixed(4), r.shrunk, now);
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`\nwrote ${out.length} rows to nfl_availability_rates (shrinkage k=${bestK})`);
process.exit(0);
