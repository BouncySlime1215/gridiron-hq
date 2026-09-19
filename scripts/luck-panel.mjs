#!/usr/bin/env node
/**
 * The luck panel: who has been good, who has been lucky, and who confuses the two.
 *
 * Step 1 of docs/WHAT-WINS-STUDY.md. The literature is blunt about this — a
 * 10-team, 14-week head-to-head season is roughly 80% luck at the manager level
 * (Cates: R* = 0.19, year-over-year R² = 0.01), and schedule alone moves a team
 * about +/- 2 wins. So a manager's RECORD is a poor measure of his roster and a
 * terrible measure of him.
 *
 * All-play fixes the schedule half: score every team against every other team
 * every week. A 7-6 team with a 90-27 all-play was good and unlucky; a 9-4 team
 * at 58-59 was lucky. Published benchmark for the all-play/H2H correlation in a
 * 10-team league is r ~= 0.82, and the actual-minus-all-play gap should reach
 * about +/- 3 wins in the tails. Both are printed as a sanity check on this
 * code, not as findings.
 *
 * Two uses, and they are different:
 *   - honesty, for Nick: his own luck, so he neither overrates nor underrates
 *     the roster he is about to trade from.
 *   - leverage, for the trade engine: a manager whose record flatters his roster
 *     is a manager who will price his players as if the record were real. That
 *     is the person to buy from, and it is a measurable, per-person edge that
 *     survives the 80%-luck finding because it is not about predicting football.
 *
 * Deliberately NOT computed here: bench points. That needs weekly rosters and
 * per-player scores, which ESPN only serves for the current season (mRoster with
 * scoringPeriodId). It is its own step.
 *
 * Usage: node --env-file-if-exists=.env scripts/luck-panel.mjs [--league N] [--json]
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const ONLY = argOf('--league');
const AS_JSON = argv.includes('--json');

const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};

/**
 * One league-season. Only weeks where EVERY team has a score are used: a
 * partially-scored week would give the teams that played an all-play advantage
 * over the ones that had not, which is an artifact of when we fetched, not of
 * football.
 */
function analyse(leagueId, season) {
  const scores = rows(`SELECT week, roster_id, points, opponent_roster_id, is_playoff
                       FROM league_week_scores WHERE league_id=? AND season=? ORDER BY week`, leagueId, season);
  if (!scores.length) return null;
  const teams = [...new Set(scores.map(s => s.roster_id))];
  const byWeek = new Map();
  for (const s of scores) (byWeek.get(s.week) ?? byWeek.set(s.week, []).get(s.week)).push(s);

  const full = [...byWeek.entries()]
    .filter(([, list]) => list.length === teams.length && list.every(x => x.points > 0))
    .sort((a, b) => a[0] - b[0]);
  if (!full.length) return null;

  const stat = new Map(teams.map(t => [t, {
    roster_id: t, weeks: 0, points: 0, h2h_w: 0, h2h_l: 0, ap_w: 0, ap_l: 0,
    weekly: [], beat_median: 0,
  }]));

  for (const [, list] of full) {
    const sorted = [...list].sort((a, b) => b.points - a.points);
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2].points
      : (sorted[sorted.length / 2 - 1].points + sorted[sorted.length / 2].points) / 2;
    for (const s of list) {
      const st = stat.get(s.roster_id);
      st.weeks++; st.points += s.points; st.weekly.push(s.points);
      if (s.points > median) st.beat_median++;
      // all-play: this team against every other team's score this week
      for (const o of list) {
        if (o.roster_id === s.roster_id) continue;
        if (s.points > o.points) st.ap_w++; else if (s.points < o.points) st.ap_l++;
      }
      // the head-to-head that actually happened
      if (s.opponent_roster_id && !s.is_playoff) {
        const opp = list.find(x => x.roster_id === s.opponent_roster_id);
        if (opp) { if (s.points > opp.points) st.h2h_w++; else if (s.points < opp.points) st.h2h_l++; }
      }
    }
  }

  const out = [...stat.values()].map(s => {
    const apGames = s.ap_w + s.ap_l, h2hGames = s.h2h_w + s.h2h_l;
    const ap = apGames ? s.ap_w / apGames : null;
    const h2h = h2hGames ? s.h2h_w / h2hGames : null;
    const mean = s.points / s.weeks;
    const sd = Math.sqrt(s.weekly.reduce((a, p) => a + (p - mean) ** 2, 0) / Math.max(1, s.weekly.length - 1));
    return {
      ...s, ppg: +mean.toFixed(1), sd: +sd.toFixed(1), cv: +(sd / mean).toFixed(3),
      all_play: ap == null ? null : +ap.toFixed(3),
      h2h_pct: h2h == null ? null : +h2h.toFixed(3),
      // Positive = his record flatters his scoring. In wins over the season:
      luck_wins: ap != null && h2h != null ? +((h2h - ap) * h2hGames).toFixed(1) : null,
      median_rate: +(s.beat_median / s.weeks).toFixed(3),
      weekly: undefined,
    };
  }).sort((a, b) => (b.all_play ?? 0) - (a.all_play ?? 0));

  const withBoth = out.filter(t => t.all_play != null && t.h2h_pct != null);
  return {
    league_id: leagueId, season, weeks: full.length, teams: teams.length,
    ap_h2h_r: withBoth.length >= 3 ? +pearson(withBoth.map(t => t.all_play), withBoth.map(t => t.h2h_pct)).toFixed(3) : null,
    median_score: +(() => {
      const all = full.flatMap(([, l]) => l.map(x => x.points)).sort((a, b) => a - b);
      return all.length % 2 ? all[(all.length - 1) / 2] : (all[all.length / 2 - 1] + all[all.length / 2]) / 2;
    })().toFixed(1),
    p75_score: +(() => { const a = full.flatMap(([, l]) => l.map(x => x.points)).sort((x, y) => x - y); return a[Math.floor(a.length * 0.75)]; })().toFixed(1),
    teams_detail: out,
  };
}

const seasons = rows(`SELECT DISTINCT league_id, season FROM league_week_scores
                      ${ONLY ? 'WHERE league_id = ' + Number(ONLY) : ''} ORDER BY league_id, season`);
const names = new Map(rows('SELECT id, name FROM leagues').map(r => [r.id, String(r.name).trim()]));
const owners = new Map(rows('SELECT league_id, season, roster_id, owner_name, team_name, wins, losses FROM league_season_teams')
  .map(r => [`${r.league_id}|${r.season}|${r.roster_id}`, r]));

const all = [];
for (const { league_id, season } of seasons) {
  const a = analyse(league_id, season);
  if (a) all.push(a);
}

if (AS_JSON) { console.log(JSON.stringify(all, null, 2)); process.exit(0); }

for (const a of all) {
  console.log(`\n=== league ${a.league_id} ${names.get(a.league_id) ?? ''} — ${a.season} ===`);
  console.log(`${a.weeks} fully-scored weeks, ${a.teams} teams | median score ${a.median_score}, 75th ${a.p75_score} | all-play vs H2H r = ${a.ap_h2h_r ?? 'n/a'} (published benchmark ~0.82)`);
  console.log('  owner                 ppg     cv   all-play    H2H   luck(wins)  beat-median');
  for (const t of a.teams_detail) {
    const o = owners.get(`${a.league_id}|${a.season}|${t.roster_id}`);
    const who = (o?.owner_name ?? o?.team_name ?? `roster ${t.roster_id}`).slice(0, 20);
    const luck = t.luck_wins == null ? '   -  ' : (t.luck_wins > 0 ? '+' : '') + t.luck_wins.toFixed(1);
    console.log(`  ${who.padEnd(21)} ${String(t.ppg).padStart(5)}  ${String(t.cv).padStart(5)}    ${String(t.all_play ?? '-').padStart(6)} ${String(t.h2h_pct ?? '-').padStart(6)}   ${luck.padStart(6)}      ${String(t.median_rate).padStart(5)}`);
  }
}

// Pooled sanity checks against the published benchmarks. These validate the
// code; they are not findings.
const rs = all.map(a => a.ap_h2h_r).filter(Number.isFinite);
const lucks = all.flatMap(a => a.teams_detail.map(t => t.luck_wins)).filter(Number.isFinite);
if (rs.length) {
  const meanR = rs.reduce((a, b) => a + b, 0) / rs.length;
  const absLuck = lucks.map(Math.abs).sort((a, b) => a - b);
  console.log(`\n--- sanity vs published benchmarks ---`);
  console.log(`all-play vs H2H r: mean ${meanR.toFixed(3)} across ${rs.length} league-seasons (expected ~0.82 for 10-team; higher is fine in short samples)`);
  console.log(`luck swing |wins|: median ${absLuck[Math.floor(absLuck.length / 2)]?.toFixed(1)}, p90 ${absLuck[Math.floor(absLuck.length * 0.9)]?.toFixed(1)} (expected up to ~3 wins over a full season)`);
  console.log(`n = ${lucks.length} team-seasons`);
}
process.exit(0);
