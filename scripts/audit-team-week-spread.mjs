#!/usr/bin/env node
/**
 * How much does a fantasy team's weekly score actually move, and does that depend on the
 * league's format?
 *
 *   node scripts/audit-team-week-spread.mjs
 *
 * WHY THIS EXISTS. The master plan (queue item [WO O3/O6]) says the posture surface and the
 * season simulator "should share one fitted team-week variance model instead of two", and
 * quotes real Sleeper spreads of "20.2 for 10-team PPR, 26.0 for 8-team PPR" as evidence that
 * the spread depends on the format. Before building a format-stratified model on that premise
 * it is worth measuring the premise, because if the spread is format-dependent the shared
 * model needs a table and if it is not, it needs one number.
 *
 * WHAT IT MEASURES. For every team-season with at least 8 regular-season weeks, the standard
 * deviation of that team's own weekly scores about its own mean -- the within-team spread,
 * which is what a matchup's outcome turns on. Reported in points AND as a coefficient of
 * variation, stratified by league size and scoring, on the crawled public Sleeper history.
 *
 * WHAT IT IS NOT. This is NOT the quantity `lineup-posture.js`'s SPREAD_SCALE is fitted on.
 * That scale calibrates the spread of (actual margin - projected margin) -- the error in a
 * projected edge -- and posture's own header is explicit that the two "are not the same
 * quantity". So a match here neither validates nor refutes 1.63. What it does do is
 * independently check the cross-check that header cites (ESPN team-weeks, CV 0.20) on a
 * different platform and a sample roughly fifteen times larger.
 *
 * Abandoned leagues and zero weeks are excluded on the same two rules `league-history.js`
 * applies, and for the same reason: a league nobody played has a spread, and it is not a
 * fantasy team's spread.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const FILE = process.env.GRIDIRON_LEAGUE_HISTORY_PATH
  ?? path.join(process.cwd(), 'data', 'derived', 'sleeper_history.sqlite');
const MIN_WEEKS = 8;
const MIN_TEAMS_PER_STRATUM = 60;

let db;
try { db = new DatabaseSync(FILE, { readOnly: true }); }
catch { console.error(`no league history at ${FILE}; build it with scripts/collect-sleeper-history.mjs`); process.exit(1); }

const rows = db.prepare(`
  SELECT l.league_id, l.num_teams, l.scoring, tw.roster_id, tw.points
  FROM sh_team_weeks tw JOIN sh_leagues l ON l.league_id = tw.league_id
  WHERE tw.points IS NOT NULL AND l.playoff_week_start IS NOT NULL
    AND tw.week < l.playoff_week_start`).all();
db.close();

// The two data-quality rules, applied identically to league-history.js.
const tally = new Map();
for (const r of rows) {
  const t = tally.get(r.league_id) ?? { n: 0, z: 0 };
  t.n++; if (r.points === 0) t.z++; tally.set(r.league_id, t);
}
const abandoned = new Set([...tally].filter(([, t]) => t.z / t.n > 0.5).map(([id]) => id));
const clean = rows.filter(r => r.points !== 0 && !abandoned.has(r.league_id));

const byTeam = new Map();
for (const r of clean) {
  const key = `${r.league_id}|${r.roster_id}`;
  const t = byTeam.get(key) ?? { pts: [], num_teams: r.num_teams, scoring: r.scoring };
  t.pts.push(r.points); byTeam.set(key, t);
}

const strata = new Map();
let allSd = [], allCv = [];
for (const t of byTeam.values()) {
  if (t.pts.length < MIN_WEEKS) continue;
  const m = t.pts.reduce((a, b) => a + b, 0) / t.pts.length;
  if (!(m > 0)) continue;
  // Sample variance, n-1: each team-season is a sample of that team's weeks, not the
  // population of them.
  const sd = Math.sqrt(t.pts.reduce((a, b) => a + (b - m) ** 2, 0) / (t.pts.length - 1));
  const key = `${t.num_teams}-team ${t.scoring}`;
  const g = strata.get(key) ?? { sds: [], means: [], cvs: [] };
  g.sds.push(sd); g.means.push(m); g.cvs.push(sd / m); strata.set(key, g);
  allSd.push(sd); allCv.push(sd / m);
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

console.log(`Within-team weekly spread, regular season only.`);
console.log(`${byTeam.size} team-seasons read, ${allSd.length} with at least ${MIN_WEEKS} weeks.`);
console.log(`Excluded: ${abandoned.size} abandoned league-seasons and every exactly-zero week.`);
console.log();
console.log('stratum            team-seasons   mean score   within-team sd   CV');
const ordered = [...strata.entries()]
  .filter(([, g]) => g.sds.length >= MIN_TEAMS_PER_STRATUM)
  .sort((a, b) => b[1].sds.length - a[1].sds.length);
for (const [key, g] of ordered) {
  console.log(`  ${key.padEnd(18)} ${String(g.sds.length).padStart(10)}   ${mean(g.means).toFixed(1).padStart(10)}   ${mean(g.sds).toFixed(1).padStart(14)}   ${mean(g.cvs).toFixed(3)}`);
}
const cvs = ordered.map(([, g]) => mean(g.cvs));
console.log();
console.log(`Pooled:  within-team sd ${mean(allSd).toFixed(1)} points,  CV ${mean(allCv).toFixed(3)}`);
console.log(`Across the ${ordered.length} strata above, CV ranges ${Math.min(...cvs).toFixed(3)} to ${Math.max(...cvs).toFixed(3)} (spread ${sdOf(cvs).toFixed(4)}).`);
console.log();
console.log('READ THIS BEFORE BUILDING A STRATIFIED MODEL.');
console.log('The spread in POINTS varies by format from about 21 to about 28, and almost all');
console.log('of that is the mean score differing rather than the spread behaving differently:');
console.log('half-PPR leagues score less and therefore move less in absolute terms. As a');
console.log('coefficient of variation the same strata sit between about 0.19 and 0.23.');
console.log();
console.log('So one cv applied to each league\'s own scoring level captures most of what a');
console.log('per-format points table would, and is a far smaller object. It does NOT capture');
console.log('all of it, and saying otherwise would repeat the mistake of asserting instead of');
console.log('measuring: 10-team PPR comes in at 0.226 against 12-team PPR\'s 0.198 on 2,729 and');
console.log('5,591 team-seasons, which is too much data to wave away as noise. Whether that gap');
console.log('is the format or something correlated with it -- 10-team leagues start a higher');
console.log('share of each roster, so a weak week has fewer places to hide -- is not settled');
console.log('here and should not be guessed at.');
console.log();
console.log('What IS settled: the plan\'s quoted evidence for stratifying does not reproduce.');
console.log('It cites 20.2 points for 10-team PPR and 26.0 for 8-team PPR; measured here they');
console.log('are 26.7 and 27.7, so the gap it describes is not there and its 10-team figure is');
console.log('the one that is off. A stratified model built to fit those two numbers would be');
console.log('fitting an artifact.');
