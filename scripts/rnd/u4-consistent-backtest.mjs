#!/usr/bin/env node
/**
 * U4 CONSISTENT-CHIP backtest, exactly as pre-registered in docs/tdd/U4-CONSISTENT-CHIP-PREREG.md.
 *
 * Reads a COPY of the app DB (never the live file): nfl_ffopportunity_weekly (full PPR, team),
 * nfl_injuries, league_draft_picks, players (espn_id -> gsis_id). Every read goes through the
 * producers themselves: scripts/rnd/consistent-chip.mjs (rule D) and people/player-score.js#scorePlayers
 * (the board score).
 *
 * Usage: node scripts/rnd/u4-consistent-backtest.mjs --db <copy.sqlite> [--out <results.json>]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RULE, starterBaselines, teamWindow, consistentRead } from './consistent-chip.mjs';
import { scorePlayers } from '../../server/services/people/player-score.js';
import { residuals } from '../../server/services/range-residuals.js';

const SEASONS = [2024, 2025];
const WEEKS = { from: 4, to: 14 };
const B = 2000;
const SEED = 20260925;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const MIN_ROWS = 30;
const MIN_CLUSTERS = 10;
const FA_TOP = 40;
const EARLY_GAMES = 3;

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);

/** Every QB/RB/WR/TE game (weeks 1-17) as { id: gsis, season, week, team, position, pts }, and team weeks. */
export function loadGames(db, { from, to }) {
  const rows = db.prepare(`SELECT player_gsis_id AS id, season, week, team, position, actual_fantasy_points AS pts
    FROM nfl_ffopportunity_weekly WHERE season BETWEEN ? AND ? AND week BETWEEN 1 AND ? AND position IN ('QB','RB','WR','TE')`)
    .all(from, to, RULE.last_week);
  const byId = new Map(), teamWeeks = new Map(), seen = new Set();
  for (const r of rows) {
    const k = `${r.id}:${r.season}:${r.week}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
    const tk = `${r.season}:${r.team}`;
    if (!teamWeeks.has(tk)) teamWeeks.set(tk, new Set());
    teamWeeks.get(tk).add(r.week);
  }
  return { byId, teamWeeks, rows };
}

/** Latest injury report status per player as of a (season, week): Map gsis -> status (reports with week <= w). */
function injuryReader(db) {
  const rows = db.prepare(`SELECT season, week, gsis_id, report_status FROM nfl_injuries WHERE report_status IS NOT NULL AND report_status != ''`).all();
  const by = new Map();
  for (const r of rows) by.set(`${r.season}:${r.week}:${r.gsis_id}`, r.report_status);
  // The week W-1 report (published before game W-1): no report row = not listed = null.
  return (season, week, id) => by.get(`${season}:${week}:${id}`) ?? null;
}

function draftOf(db, leagueId, season) {
  const rows = db.prepare(`SELECT d.overall_pick AS pick, p.gsis_id AS gsis FROM league_draft_picks d
    LEFT JOIN players p ON p.espn_id = d.player_id WHERE d.league_id = ? AND d.season = ?`).all(leagueId, season);
  const n = db.prepare('SELECT COUNT(*) AS n FROM league_draft_picks WHERE league_id = ? AND season = ?').get(leagueId, season).n;
  const picks = new Map();
  for (const r of rows) if (r.gsis && Number.isInteger(r.pick) && !picks.has(r.gsis)) picks.set(r.gsis, r.pick);
  return { picks, n };
}

/** Rows for one league-season: every as-of 83+ player-week with its rule-D read and next-4 outcome. */
export function leagueRows({ leagueId, season, games, injuries, draft, baseline, k, table }) {
  const out = [];
  const pos = new Map(), prior = new Map();
  for (const [id, gs] of games.byId) {
    const last = gs.filter(g => g.season === season || g.season === season - 1).sort((a, b) => (b.season - a.season) || (b.week - a.week))[0];
    if (last) pos.set(id, last.position);
    const pr = gs.filter(g => g.season === season - 1);
    if (pr.length) prior.set(id, mean(pr.map(g => g.pts)));
  }
  for (let W = WEEKS.from; W <= WEEKS.to; W++) {
    const cand = [];
    for (const [id, gs] of games.byId) {
      if (!pos.has(id)) continue;
      const cur = gs.filter(g => g.season === season && g.week < W);
      const team = cur.length ? cur.reduce((a, b) => (b.week > a.week ? b : a)).team : null;
      const st = injuries(season, W - 1, id);
      cand.push({ id, espn_id: id, position: pos.get(id), team_abbr: team,
        ros_basis: { games: cur.length, season_to_date: cur.length ? mean(cur.map(g => g.pts)) : null },
        ros_ppg: prior.get(id) ?? null, injury: st === 'Out' || st === 'Doubtful' ? st : null, _status: st });
    }
    const teamGames = new Map();
    for (const c of cand) if (c.team_abbr) teamGames.set(c.team_abbr, Math.max(teamGames.get(c.team_abbr) ?? 0, c.ros_basis.games));
    const early = Math.max(0, ...teamGames.values()) < EARLY_GAMES;
    const prodOf = c => (!early && c.ros_basis.games > 0 ? c.ros_basis.season_to_date : c.ros_ppg);
    const drafted = cand.filter(c => draft.picks.has(c.id));
    const fa = cand.filter(c => !draft.picks.has(c.id) && Number.isFinite(prodOf(c)) && prodOf(c) > 0)
      .sort((a, b) => prodOf(b) - prodOf(a)).slice(0, FA_TOP);
    const universe = [...drafted, ...fa];
    const scored = scorePlayers(universe, { picks: draft.picks, nPicks: draft.n });
    for (const c of universe) {
      const s = scored.get(String(c.id));
      if (!s || s.score < RULE.min_score) continue;
      // Outcome: his team's next 4 weeks (W..17) in season s; a missed game scores 0.
      const gs = games.byId.get(c.id);
      const nowTeam = c.team_abbr ?? gs.filter(g => g.season === season - 1).sort((a, b) => b.week - a.week)[0]?.team;
      const tw = [...(games.teamWeeks.get(`${season}:${nowTeam}`) ?? [])].filter(w => w >= W && w <= RULE.last_week).sort((a, b) => a - b).slice(0, 4);
      if (tw.length < 4) continue;
      const pts = tw.map(w => gs.find(g => g.season === season && g.week === w)?.pts ?? 0);
      const base = baseline.get(c.position) ?? null;
      const floor = [...pts].sort((a, b) => a - b)[1];
      const input = { position: c.position, score: s.score, hurt: s.hurt, injuryStatus: c._status,
        window: teamWindow(gs, games.teamWeeks, { season, week: W }), mean: s.parts.prod_value };
      const d = consistentRead(input, { baseline: base, k, table });
      const d0 = consistentRead(input, { baseline: base, k, table, literal: true });
      out.push({ league: leagueId, season, W, id: c.id, position: c.position, score: s.score, prod: s.parts.prod_value,
        flag: d.consistent, flag0: d0.consistent, reasons: d.reasons, F: floor,
        S: base ? mean(pts.map(p => Math.max(0, base.median - p))) : null,
        weeks_at_median: base ? pts.filter(p => p >= base.median).length : null });
    }
  }
  return out;
}

/** delta = mean(flagged) - mean(unflagged) of `f`, CI over player-season clusters (union of both arms). */
export function bootstrapDelta(rows, f, { b = B, seed = SEED } = {}) {
  const flagged = rows.filter(r => r.flag), un = rows.filter(r => !r.flag);
  const est = flagged.length && un.length ? mean(flagged.map(f)) - mean(un.map(f)) : null;
  const cl = new Map();
  for (const r of rows) { const k = `${r.id}:${r.season}`; if (!cl.has(k)) cl.set(k, []); cl.get(k).push(r); }
  const groups = [...cl.values()];
  const flaggedClusters = groups.filter(g => g.some(r => r.flag)).length;
  if (est == null) return { n_flagged: flagged.length, n_unflagged: un.length, flagged_clusters: flaggedClusters, estimate: null, lo: null, hi: null, se: null };
  const rand = rng(seed);
  const stats = [];
  for (let i = 0; i < b; i++) {
    let sf = 0, nf = 0, su = 0, nu = 0;
    for (let j = 0; j < groups.length; j++) {
      for (const r of groups[Math.floor(rand() * groups.length)]) { if (r.flag) { sf += f(r); nf++; } else { su += f(r); nu++; } }
    }
    if (nf && nu) stats.push(sf / nf - su / nu);
  }
  stats.sort((x, y) => x - y);
  const m = mean(stats);
  const se = Math.sqrt(mean(stats.map(x => (x - m) ** 2)));
  return { n_flagged: flagged.length, n_unflagged: un.length, flagged_clusters: flaggedClusters, clusters: groups.length,
    estimate: r3(est), lo: r3(stats[Math.floor(0.025 * stats.length)]), hi: r3(stats[Math.ceil(0.975 * stats.length) - 1]), se: r3(se),
    mde80: r3(2.8 * se), mean_flagged: r3(mean(flagged.map(f))), mean_unflagged: r3(mean(un.map(f))) };
}

/** F residual after an OLS on the production value, per position (descriptive). */
function adjusted(rows) {
  const out = [];
  for (const pos of POSITIONS) {
    const rs = rows.filter(r => r.position === pos && Number.isFinite(r.prod));
    if (rs.length < 3) continue;
    const mx = mean(rs.map(r => r.prod)), my = mean(rs.map(r => r.F));
    const sxx = rs.reduce((s, r) => s + (r.prod - mx) ** 2, 0);
    const beta = sxx > 0 ? rs.reduce((s, r) => s + (r.prod - mx) * (r.F - my), 0) / sxx : 0;
    for (const r of rs) out.push({ ...r, Fadj: r.F - (my + beta * (r.prod - mx)) });
  }
  return out;
}

function verdict(rows) {
  const primary = bootstrapDelta(rows, r => r.F);
  const secondary = bootstrapDelta(rows, r => -r.S); // flagged shortfall lower = positive
  const enough = primary.n_flagged >= MIN_ROWS && primary.flagged_clusters >= MIN_CLUSTERS;
  const pass = enough && primary.lo != null && primary.lo > 0 && secondary.estimate != null && secondary.estimate > 0;
  return { primary, secondary_shortfall: secondary, too_few: !enough, pass };
}

async function main() {
  const dbPath = arg('--db');
  if (!dbPath) throw new Error('--db <copy.sqlite> is required (a copy, never the live DB)');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const games = loadGames(db, { from: Math.min(...SEASONS) - 1, to: Math.max(...SEASONS) });
  const injuries = injuryReader(db);
  const table = residuals();
  const k = Number(table.k.value);
  const rows = [];
  const baselines = {};
  for (const season of SEASONS) {
    const baseline = starterBaselines(games.rows.filter(g => g.season === season - 1));
    baselines[season] = Object.fromEntries(baseline);
    const leagues = db.prepare('SELECT DISTINCT league_id FROM league_draft_picks WHERE season = ? ORDER BY league_id').all(season).map(r => r.league_id);
    for (const leagueId of leagues) {
      rows.push(...leagueRows({ leagueId, season, games, injuries, draft: draftOf(db, leagueId, season), baseline, k, table }));
    }
  }
  const pooled = verdict(rows);
  const perPosition = Object.fromEntries(POSITIONS.map(pos => {
    const v = verdict(rows.filter(r => r.position === pos));
    return [pos, { ...v, serve: pooled.pass && v.pass }];
  }));
  const adj = adjusted(rows);
  const reasonCounts = {};
  for (const r of rows) for (const x of r.reasons) reasonCounts[x] = (reasonCounts[x] ?? 0) + 1;
  const flaggedWeeks = rows.filter(r => r.flag);
  const out = {
    prereg: 'docs/tdd/U4-CONSISTENT-CHIP-PREREG.md', rule_version: RULE.version, seasons: SEASONS, weeks: WEEKS, k,
    bootstrap: { resamples: B, seed: SEED, cluster: 'player-season' },
    baselines,
    universe: { rows: rows.length, flagged: flaggedWeeks.length, flagged_d0: rows.filter(r => r.flag0).length,
      league_seasons: [...new Set(rows.map(r => `${r.league}:${r.season}`))], not_consistent_reasons: reasonCounts },
    primary: pooled,
    per_position: perPosition,
    served_positions: Object.entries(perPosition).filter(([, v]) => v.serve).map(([p]) => p),
    reported: {
      by_season: Object.fromEntries(SEASONS.map(s => [s, bootstrapDelta(rows.filter(r => r.season === s), r => r.F)])),
      mean_adjusted: bootstrapDelta(adj, r => r.Fadj),
      weekly_bar_share_at_median: flaggedWeeks.length ? r3(mean(flaggedWeeks.map(r => r.weeks_at_median / 4))) : null,
      weekly_bar_share_at_median_unflagged: r3(mean(rows.filter(r => !r.flag).map(r => r.weeks_at_median / 4))),
    },
  };
  const json = JSON.stringify(out, null, 2);
  if (arg('--out')) fs.writeFileSync(arg('--out'), json + '\n');
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.stack ?? e); process.exit(1); });
