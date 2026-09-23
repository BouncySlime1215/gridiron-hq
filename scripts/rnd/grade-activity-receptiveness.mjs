#!/usr/bin/env node
/**
 * RL-11-1 grade: the SHIPPED activity and checked-out receptiveness terms
 * (activityFactor / checkedOutFactor in server/services/counterparty-pricing.js),
 * scored exactly as counterpartyLayer applies them.
 *
 * Pre-registration: docs/evidence/2026-09-23/activity-receptiveness-preregistration.md.
 *
 *   --corpus <team_seasons.sqlite>   H1: Sleeper 2021-24 corpus (read-only; 2024 graded, season <= 2024 asserted)
 *   --app-db <copy of data.sqlite>   H2: 2026 forward check. WRITES to this file (payload.scoringPeriodId and
 *                                    manager_signals are rebuilt as of each week), so pass a scratch copy only.
 *
 * Output: text on stdout. No league ids or names are printed.
 * Sign: AUC above 0.5 means the higher score went to the team that traded.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const corpusPath = arg('--corpus');
const appDb = arg('--app-db');
const RESAMPLES = 1000;

// Mulberry32, so a re-run prints the same intervals.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Within-group AUC: pairs are compared only inside the same league-week. */
function aucWithin(groups, key) {
  let num = 0, den = 0;
  for (const g of groups) {
    const pos = g.filter(r => r.y === 1), neg = g.filter(r => r.y === 0);
    if (!pos.length || !neg.length) continue;
    for (const p of pos) for (const q of neg) { num += p[key] > q[key] ? 1 : p[key] === q[key] ? 0.5 : 0; }
    den += pos.length * neg.length;
  }
  return { auc: den ? num / den : NaN, pairs: den };
}
/** Hanley & McNeil (1982) SE of an AUC at 0.5, and the MDE at 80% power for a two-sided 90% interval. */
function mde80(nPos, nNeg) {
  const se = Math.sqrt((nPos + nNeg + 1) / (12 * nPos * nNeg));
  return (1.645 + 0.842) * se;
}
function bootstrap(groupsByCluster, key, seed) {
  const r = rng(seed); const clusters = [...groupsByCluster.keys()]; const out = [];
  for (let b = 0; b < RESAMPLES; b += 1) {
    const groups = [];
    for (let i = 0; i < clusters.length; i += 1) {
      groups.push(...groupsByCluster.get(clusters[Math.floor(r() * clusters.length)]));
    }
    out.push(aucWithin(groups, key).auc);
  }
  return [pct(out, 0.05), pct(out, 0.95)];
}

/**
 * Team-cluster bootstrap, as H2 pre-registered: resample teams (all of a team's rows together) with
 * replacement, keep the within-league-week comparison. Used for H2; H1 resamples chains.
 */
function bootstrapTeams(rowsList, key, seed) {
  const r = rng(seed); const byTeam = new Map();
  for (const x of rowsList) (byTeam.get(x.cluster) ?? byTeam.set(x.cluster, []).get(x.cluster)).push(x);
  const teams = [...byTeam.values()]; const out = [];
  for (let b = 0; b < RESAMPLES; b += 1) {
    const byLw = new Map();
    for (let i = 0; i < teams.length; i += 1) {
      for (const x of teams[Math.floor(r() * teams.length)]) (byLw.get(x.lw) ?? byLw.set(x.lw, []).get(x.lw)).push(x);
    }
    const a = aucWithin([...byLw.values()], key).auc;
    if (Number.isFinite(a)) out.push(a);
  }
  return { lo: pct(out, 0.05), hi: pct(out, 0.95), usable: out.length, teams: teams.length };
}

// The production module opens the app DB on import; point it at a throwaway
// unless the forward check supplies its own copy.
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_DB_PATH = appDb ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rl11-grade-')), 'x.sqlite');
const pricing = await import('../../server/services/counterparty-pricing.js');
const { activityFactor, checkedOutFactor, ACTIVITY_MIN_WEEKS, RECEPTIVENESS_RANGE } = pricing;

/** The shipped score for one league-week: 0.5 + the two terms, clamped as counterpartyLayer clamps. */
function scoreLeagueWeek(teams, { gate }) {
  const have = teams;
  const mean = {
    adds: have.reduce((a, t) => a + t.metrics.tx_adds_per_week, 0) / have.length,
    traded: have.reduce((a, t) => a + (t.metrics.tx_completed_trades > 0 ? 1 : 0), 0) / have.length,
    managers: have.length,
  };
  for (const t of teams) {
    // `gate: false` grades the term the gate would release, on weeks the gate holds back: the gate
    // reads only samples.tx_adds_per_week, never the size, so lifting weeks to the minimum changes
    // nothing but whether the entry is withheld.
    const samples = { ...t.samples, tx_adds_per_week: gate ? t.samples.tx_adds_per_week
      : Math.max(ACTIVITY_MIN_WEEKS, t.samples.tx_adds_per_week) };
    const a = activityFactor(t.metrics, samples, mean);
    const c = checkedOutFactor(t.metrics, samples);
    t.sAct = Number.isFinite(a?.effect) ? a.effect : 0;
    t.sBoth = Math.max(0, Math.min(1, 0.5 + t.sAct + (Number.isFinite(c?.effect) ? c.effect : 0)));
    t.recept = RECEPTIVENESS_RANGE[0] + (RECEPTIVENESS_RANGE[1] - RECEPTIVENESS_RANGE[0]) * t.sBoth;
  }
}

function report(label, rowsList, clusterOf, seed) {
  const byLw = new Map();
  for (const r of rowsList) (byLw.get(r.lw) ?? byLw.set(r.lw, []).get(r.lw)).push(r);
  const groups = [...byLw.values()];
  const byCluster = new Map();
  for (const g of groups) {
    const c = clusterOf(g[0]);
    (byCluster.get(c) ?? byCluster.set(c, []).get(c)).push(g);
  }
  const nPos = rowsList.filter(r => r.y === 1).length, nNeg = rowsList.length - nPos;
  const act = aucWithin(groups, 'sAct'), both = aucWithin(groups, 'sBoth');
  const [aLo, aHi] = bootstrap(byCluster, 'sAct', seed);
  const [bLo, bHi] = bootstrap(byCluster, 'sBoth', seed + 1);
  console.log(`${label}: team-weeks ${rowsList.length}, league-weeks ${groups.length}, trade sides ${nPos}, clusters ${byCluster.size}`);
  console.log(`  AUC activity term      ${act.auc.toFixed(4)} [${aLo.toFixed(4)}, ${aHi.toFixed(4)}] (90%, ${RESAMPLES} cluster resamples)`);
  console.log(`  AUC activity+checked   ${both.auc.toFixed(4)} [${bLo.toFixed(4)}, ${bHi.toFixed(4)}]`);
  console.log(`  MDE80 (AUC - 0.5)      ${mde80(nPos, nNeg).toFixed(4)} (Hanley-McNeil SE at 0.5, pooled n; within-group pairs ${act.pairs})`);
  return { act, both, aLo, aHi, nPos, nNeg };
}

// ------------------------------------------------------------------ H1 corpus
if (corpusPath) {
  const c = new DatabaseSync(corpusPath, { readOnly: true });
  const ts = c.prepare(`SELECT lg, season, roster_id, chain, playoff_week_start FROM team_seasons
    WHERE source = 'sleeper' AND season BETWEEN 2021 AND 2024 AND COALESCE(league_dead,0) = 0
      AND COALESCE(late_start,0) = 0 AND COALESCE(team_inactive,0) = 0 AND COALESCE(idp,0) = 0`).all();
  if (ts.some(t => t.season > 2024)) throw new Error('corpus row after 2024: the 2025 holdout must stay closed');
  const tsKey = new Map(ts.map(t => [`${t.lg}|${t.roster_id}`, t]));
  const events = (sql) => {
    const m = new Map();
    for (const r of c.prepare(sql).all()) {
      const k = `${r.lg}|${r.roster_id}`; (m.get(k) ?? m.set(k, []).get(k)).push(r.leg_week);
    }
    return m;
  };
  const adds = events('SELECT lg, roster_id, leg_week FROM adds WHERE season BETWEEN 2021 AND 2024');
  const trades = events('SELECT DISTINCT lg, roster_id, leg_week FROM trade_sides WHERE season BETWEEN 2021 AND 2024');
  const tw = c.prepare(`SELECT lg, season, roster_id, week, dead_starts FROM team_weeks
    WHERE season BETWEEN 2021 AND 2024 AND points IS NOT NULL AND opp_points IS NOT NULL ORDER BY lg, roster_id, week`).all();
  const played = new Map();
  const out = [];
  for (const r of tw) {
    const t = tsKey.get(`${r.lg}|${r.roster_id}`);
    if (!t || r.week > t.playoff_week_start - 1) continue;
    const k = `${r.lg}|${r.roster_id}`;
    played.set(k, (played.get(k) ?? 0) + 1);
    // The package's rows: w >= 2, outcome leg w+1 in the regular season, and a prior game (winpct_prev defined).
    if (r.week < 2 || r.week + 1 > t.playoff_week_start - 1 || played.get(k) < 2) continue;
    const w = r.week;
    out.push({
      lw: `${r.lg}_${w}`, chain: t.chain, season: r.season, w,
      y: (trades.get(k) ?? []).includes(w + 1) ? 1 : 0,
      metrics: {
        tx_adds_per_week: (adds.get(k) ?? []).filter(x => x <= w).length / w,
        tx_completed_trades: (trades.get(k) ?? []).filter(x => x <= w).length,
        lineup_dead_starts_last_week: r.dead_starts ?? 0,
      },
      samples: { tx_adds_per_week: w, lineup_dead_starts_last_week: 1 },
    });
  }
  // Only league-weeks where someone traded in leg w+1 (the package's conditioning).
  const byLw = new Map();
  for (const r of out) (byLw.get(r.lw) ?? byLw.set(r.lw, []).get(r.lw)).push(r);
  const kept = [];
  for (const g of byLw.values()) { if (g.some(r => r.y === 1)) { scoreLeagueWeek(g, { gate: false }); kept.push(...g); } }
  console.log('H1 Sleeper corpus (league-weeks with a trade; shipped function; fit constants 2021-23)');
  report('  fit 2021-23 (in-sample)', kept.filter(r => r.season <= 2023), r => r.chain, 11);
  const h1 = report('  2024 held out', kept.filter(r => r.season === 2024), r => r.chain, 21);
  report('  2024 held out, w >= 5 (rows the gate releases)', kept.filter(r => r.season === 2024 && r.w >= ACTIVITY_MIN_WEEKS), r => r.chain, 31);
  report('  2024 held out, w 2-4 (rows the gate holds back)', kept.filter(r => r.season === 2024 && r.w < ACTIVITY_MIN_WEEKS), r => r.chain, 41);
  const at = kept.filter(r => r.season === 2024);
  const sat = at.filter(r => Math.abs(r.sAct) >= 0.5 - 1e-9).length;
  console.log(`  2024 rows at the activity cap: ${sat} of ${at.length}; receptiveness range seen ${Math.min(...at.map(r => r.recept)).toFixed(3)}-${Math.max(...at.map(r => r.recept)).toFixed(3)}`);
  console.log(`  H1 rule (activity term, 2024 >= 0.645): ${h1.act.auc >= 0.645 ? 'PASS' : 'FAIL'} at ${h1.act.auc.toFixed(4)}`);
  c.close();
}

// ------------------------------------------------------------------ H2 forward
if (appDb) {
  const { db, rows, run } = await import('../../server/db/index.js');
  const signals = await import('../../server/services/manager-signals.js');
  const leagues = rows(`SELECT id, json_extract(payload, '$.scoringPeriodId') AS sp FROM leagues
                        WHERE season = 2026 AND payload IS NOT NULL`);
  // Completed trades: the league processed them (TRADE_ACCEPT / PROCESS / EXECUTED), the same rule as
  // completedTrades in manager-signals.js; that row carries both sides' items.
  const trades = rows(`SELECT league_id, items_json, scoring_period AS period FROM league_transactions_raw
    WHERE season = 2026 AND type = 'TRADE_ACCEPT' AND execution_type = 'PROCESS' AND status = 'EXECUTED'`);
  const side = new Set();
  for (const t of trades) {
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (err) { throw new Error(`trade items_json: ${err.message}`); }
    for (const i of items) for (const id of [i.fromTeamId, i.toTeamId]) if (id > 0) side.add(`${t.league_id}|${id}|${t.period}`);
  }
  const decisions = rows(`SELECT league_id, team_id, scoring_period AS period, type FROM league_transactions_raw
    WHERE season = 2026 AND execution_type = 'EXECUTE' AND type IN ('TRADE_ACCEPT', 'TRADE_DECLINE')`);
  const out = [], dec = [];
  const maxSp = Math.max(...leagues.map(l => l.sp));
  for (const w of [1, 2]) {
    if (w + 1 > maxSp) continue;
    for (const l of leagues) {
      run(`UPDATE leagues SET payload = json_set(payload, '$.scoringPeriodId', ?) WHERE id = ?`, w + 1, l.id);
      signals.buildManagerSignals(l.id, { chat: null });
      const sig = signals.managerSignalsFor(l.id);
      const teams = [...sig.entries()].filter(([, s]) => Number.isFinite(s.metrics.tx_adds_per_week))
        .map(([id, s]) => ({ id, lw: `${l.id}_${w}`, cluster: `${l.id}|${id}`, w,
          y: side.has(`${l.id}|${id}|${w + 1}`) ? 1 : 0, metrics: s.metrics, samples: s.samples }));
      if (!teams.length) continue;
      scoreLeagueWeek(teams, { gate: false });
      if (teams.some(t => t.y === 1)) out.push(...teams);
      for (const d of decisions.filter(x => x.league_id === l.id && x.period === w + 1)) {
        const t = teams.find(x => String(x.id) === String(d.team_id));
        if (t) dec.push({ lw: `${l.id}`, cluster: t.cluster, y: d.type === 'TRADE_ACCEPT' ? 1 : 0, sAct: t.sAct, sBoth: t.sBoth });
      }
      run(`UPDATE leagues SET payload = json_set(payload, '$.scoringPeriodId', ?) WHERE id = ?`, l.sp, l.id);
    }
  }
  for (const l of leagues) signals.buildManagerSignals(l.id, { chat: null });
  console.log(`H2 2026 forward (local copy, not production): ${leagues.length} leagues, current period ${maxSp}; `
    + `completed trades ${trades.length} (control: known-nonzero before any AUC)`);
  const h2 = report('  teams completing a trade in w+1, w = 1-2 (clusters = leagues)', out, r => r.lw.split('_')[0], 51);
  console.log(`  by week: ${[1, 2].map(w => `w${w} sides ${out.filter(r => r.w === w && r.y === 1).length}/${out.filter(r => r.w === w).length}`).join(', ')}`);
  // The pre-registered interval is a team-cluster bootstrap; the league-cluster line above is kept for
  // comparison only. A zero-width interval, or fewer than two clusters, cannot test anything.
  const tb = bootstrapTeams(out, 'sAct', 53);
  console.log(`  pre-registered interval (${RESAMPLES} team-cluster resamples, ${tb.teams} teams, ${tb.usable} usable): `
    + `[${tb.lo?.toFixed(4)}, ${tb.hi?.toFixed(4)}]`);
  const evaluable = tb.teams >= 2 && tb.usable > 0 && tb.hi > tb.lo;
  const holds = h2.act.auc > 0.5 && tb.hi > 0.5;
  console.log(`  H2 rule (point > 0.5 and team-cluster interval not entirely below 0.5): `
    + `${!evaluable ? 'NOT EVALUABLE (degenerate interval)' : holds ? 'HOLDS' : 'DOES NOT HOLD'}`);
  if (dec.length) report('  secondary, descriptive: responder accept vs decline (within league)', dec, r => r.lw, 61);
  db.close();
}
