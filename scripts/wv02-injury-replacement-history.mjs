/**
 * WV-02 walk-forward check: when a starter is Out, does the same-team backup with the
 * highest snap share (contingency.js#roleStates) outscore the backup with the highest
 * recent points per game (the dumb baseline)? Pre-registration and results:
 * docs/tdd/2026-09-23-injury-replacement-alert.tdd.md, section 2 and section 5.
 *
 * Read-only. Run against a COPY of the database:
 *   GRIDIRON_DB_PATH=.local-db/data.sqlite GRIDIRON_DB_INTEGRITY_CHECK=off SCHEDULER_DISABLED=1 \
 *     node scripts/wv02-injury-replacement-history.mjs
 * Every input for week w is from before week w (roleStates reads seasons s-1..s, weeks < w).
 */
import { rows } from '../server/db/index.js';
import { roleStates, normReportStatus } from '../server/services/contingency.js';

const SPLITS = { primary: [2022, 2023, 2024], holdout: [2025], forward: [2026] };
const POS = new Set(['QB', 'RB', 'WR', 'TE']);

const ppr = u => (u.receptions ?? 0) + 0.1 * ((u.rushing_yards ?? 0) + (u.receiving_yards ?? 0))
  + 6 * ((u.rushing_tds ?? 0) + (u.receiving_tds ?? 0)) + 0.04 * (u.passing_yards ?? 0)
  + 4 * (u.passing_tds ?? 0) - 2 * (u.interceptions ?? 0) - 2 * (u.fumbles_lost ?? 0);

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seasonEvents(season) {
  const idByGsis = new Map(rows('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL')
    .map(p => [String(p.gsis_id), p.id]));
  const usage = rows(`SELECT player_id, season, week, receptions, rushing_yards, receiving_yards, rushing_tds,
                             receiving_tds, passing_yards, passing_tds, interceptions, fumbles_lost
                      FROM player_week_usage WHERE season IN (?, ?)`, season - 1, season);
  const pts = new Map();              // `${id}|${season}|${week}` -> points
  const history = new Map();          // id -> [{ slot, points }]
  for (const u of usage) {
    const p = ppr(u);
    pts.set(`${u.player_id}|${u.season}|${u.week}`, p);
    (history.get(u.player_id) ?? history.set(u.player_id, []).get(u.player_id))
      .push({ slot: u.season * 100 + u.week, points: p });
  }
  const recentPpg = (id, week) => {
    const h = (history.get(id) ?? []).filter(x => x.slot < season * 100 + week)
      .sort((a, b) => b.slot - a.slot).slice(0, 3);
    return h.length ? h.reduce((s, x) => s + x.points, 0) / h.length : null;
  };
  const weeks = rows(`SELECT DISTINCT week FROM nfl_injuries WHERE season = ? AND week BETWEEN 2 AND 18
                      AND week IN (SELECT DISTINCT week FROM player_week_usage WHERE season = ?)
                      ORDER BY week`, season, season).map(r => r.week);
  const events = [];
  for (const week of weeks) {
    const report = rows('SELECT gsis_id, report_status FROM nfl_injuries WHERE season = ? AND week = ?', season, week);
    const status = new Map();
    for (const r of report) {
      const id = idByGsis.get(String(r.gsis_id));
      if (id != null) status.set(id, normReportStatus(r.report_status));
    }
    const roles = roleStates(season, week);
    for (const [id, st] of status) {
      if (st !== 'out') continue;
      const me = roles.get(id);
      if (!me || me.tier !== 'starter' || !POS.has(me.position) || !me.team) continue;
      const cands = [...roles.values()].filter(r => r.player_id !== id && r.team === me.team
        && r.position === me.position && r.gap_bucket != null
        && !['out', 'doubtful'].includes(status.get(r.player_id)));
      if (cands.length < 2) continue;
      const withPpg = cands.map(r => ({ id: r.player_id, share: r.share ?? -1, ppg: recentPpg(r.player_id, week) ?? -1 }));
      const snap = [...withPpg].sort((a, b) => b.share - a.share || a.id - b.id)[0];
      const base = [...withPpg].sort((a, b) => b.ppg - a.ppg || a.id - b.id)[0];
      const got = c => pts.get(`${c.id}|${season}|${week}`) ?? 0;
      events.push({ season, week, position: me.position, agree: snap.id === base.id, snapPts: got(snap), basePts: got(base) });
    }
  }
  return events;
}

function grade(events) {
  const n = events.length;
  const dis = events.filter(e => !e.agree);
  const wins = dis.reduce((s, e) => s + (e.snapPts > e.basePts ? 1 : e.snapPts === e.basePts ? 0.5 : 0), 0);
  const diffs = events.map(e => e.snapPts - e.basePts);
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const rnd = mulberry32(1);
  const boots = [];
  for (let b = 0; b < 2000 && n; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const mde = dis.length ? (1.645 + 0.842) * Math.sqrt(0.25 / dis.length) : null;
  return {
    events: n, disagreements: dis.length, agreement_rate: n ? +(1 - dis.length / n).toFixed(3) : null,
    snap_win_rate_on_disagreements: dis.length ? +(wins / dis.length).toFixed(3) : null,
    mean_diff_ppr: n ? +mean(diffs).toFixed(3) : null,
    ci90: n ? [+boots[Math.floor(0.05 * boots.length)].toFixed(3), +boots[Math.floor(0.95 * boots.length) - 1].toFixed(3)] : null,
    mean_diff_on_disagreements: dis.length ? +mean(dis.map(e => e.snapPts - e.basePts)).toFixed(3) : null,
    mde_win_rate_80pct_power: mde == null ? null : +mde.toFixed(3),
    by_position: Object.fromEntries([...POS].map(p => {
      const d = dis.filter(e => e.position === p);
      const w = d.reduce((s, e) => s + (e.snapPts > e.basePts ? 1 : e.snapPts === e.basePts ? 0.5 : 0), 0);
      return [p, { disagreements: d.length, snap_win_rate: d.length ? +(w / d.length).toFixed(3) : null }];
    }))
  };
}

const out = {};
for (const [name, seasons] of Object.entries(SPLITS)) {
  const events = seasons.flatMap(seasonEvents);
  out[name] = { seasons, ...grade(events) };
}
console.log(JSON.stringify(out, null, 2));
