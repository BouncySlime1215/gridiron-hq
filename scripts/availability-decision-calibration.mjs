#!/usr/bin/env node
/**
 * Chance to play, graded on the rows a manager actually decides on.
 *
 * trade-engine.js#buildAssetUniverse multiplies every player's week projection by
 * contingency.js#weeklyAvailability(...).active_probability. On the posture-calibration
 * pool (2023-2025 weeks 5-17, top 14 QB / 34 RB / 40 WR / 14 TE, active the week before,
 * byes dropped) that number averaged about 0.76 while those players played 97.5-98.4% of
 * weeks. The production file has nfl_availability_rates but no nfl_availability_role_rates,
 * so every player without an injury report gets min(0.831, durability prior). 0.831 is the
 * rate for players who were ON the practice report, and the durability prior is career
 * games-with-a-stat / (17 x seasons since first seen), shrunk toward a position mean that
 * counts every backup.
 *
 * contingency.js already has the replacement (the role layer, commit 49174d4): for a player
 * seen in his team's last four games, a rate by report x practice x position x recent snap
 * share x games missed since, with no durability cap. Its rates were never written to the
 * production file, and its own gate graded every in-scope player-week, not the decision set.
 * This script measures today's number on the decision set and gates the role layer on it.
 *
 * GATE (below) was written before any 2025 number on these populations was computed. The
 * role layer's own gate (docs/tdd/play-chance.tdd.md) had already scored 2025 once on a
 * different population, so 2025 is a second look at this model family, not a first.
 *
 * Usage (never against the live file; point GRIDIRON_DB_PATH at a copy):
 *   GRIDIRON_DB_PATH=/path/copy.sqlite node scripts/availability-decision-calibration.mjs \
 *     --cache /path/dir [--rebuild] [--fit-only] [--out /path/result.json]
 *
 *   --cache     directory for the replayed decision rows (one file per season and block)
 *   --rebuild   replay again even if the cache exists
 *   --fit-only  measure 2023-2024 and run the selection; 2025 is not read
 *   --out       write the full result as JSON
 *   --variant-config '{"k":5,"byPosition":true,"durabilityCap":false}'
 *               VARIANT is "the rates scripts/fit-availability.mjs writes". Since
 *               play-chance-live (2026-09-18) that script writes a PINNED config instead
 *               of its re-selection; pass the pin here so VARIANT stays what ships. The
 *               re-selection still runs and is reported beside it. GATE text unchanged.
 */
process.env.SCHEDULER_DISABLED = '1';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const GATE = `
Population. replaySeasonWeekly(season, {startWeek 5, endWeek 17, distributions false, roleRecency
WEEKLY_ROLE_RECENCY, predictionHead = live fit-1 ensemble}) _decision_rows: recorded usage the week
before; y = recorded usage this week (player_week_usage row). Rows whose team has no game that week
are dropped. DECISION = every row. STARTERS = per week, top 14 QB / 34 RB / 40 WR / 14 TE by the raw
prediction (not multiplied by any chance to play, so both arms grade identical rows).
Arms. CURRENT = contingency.js#playerActiveProbability with the nfl_availability_rates on file and
no role rates, prior = availability({through: season-1}); asserted equal, row by row, to
weeklyAvailability(season, week, {through: season-1}) on a copy with no role table (production today).
CANDIDATE = the same function with role rates from fitRoleRates over every in-scope skill
player-week (weeks 1-18) of the fit seasons, built as scripts/fit-availability.mjs builds them,
stored at 4 dp, plus the same rates on file.
Selection (2025 not read): byPosition {no, yes} x k {2,5,10,20,50,100} x durability cap {off, on};
fit on 2023, pick the lowest log loss on 2024 DECISION rows (ties: first in that order). Refit the
pick on 2023+2024.
Validation, once, on 2025. For each population (STARTERS, DECISION):
 (1) log loss candidate < current AND pairedBootstrapDiff(ll_current, ll_candidate, {iterations
     2000, seed 20260918, groups player_id}) 90% CI upper bound < 0;
 (2) ECE (10 equal-width bins, contingency.js#availabilityScores) candidate < current.
 Guard: DECISION rows listed Questionable/Doubtful/Out, candidate log loss <= current + 0.01.
PASS only if (1) and (2) hold for both populations and the guard holds. Otherwise nothing ships.
What ships on PASS is the rates scripts/fit-availability.mjs writes (VARIANT: selection fit
2021-2023 scored on all in-scope 2024 rows, refit 2021-2024), and only if VARIANT also clears
(1), (2) and the guard on 2025. If CANDIDATE passes and VARIANT does not, nothing ships until
fit-availability.mjs is moved to CANDIDATE's seasons and re-gated.
Reported, not gated: current arm per season 2023-2025; candidate on 2023/2024 (in-sample);
2025 weeks 2-4; the posture pool (top-N by prediction x current, the finding's population).`;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

if (!process.env.GRIDIRON_DB_PATH) {
  throw new Error('Refusing to open the live database: set GRIDIRON_DB_PATH to a copy.');
}
const CACHE = opt('--cache', null);
if (!CACHE) throw new Error('--cache <dir> is required');
mkdirSync(CACHE, { recursive: true });
const OUT = opt('--out', null);
const FIT_ONLY = flag('--fit-only');

const FIT_SEASONS = [2023, 2024];
const SELECT_FIT = [2023], SELECT_SCORE = 2024;
const VALIDATION_SEASON = 2025;
const VARIANT_FIT = [2021, 2022, 2023, 2024], VARIANT_SELECT_FIT = [2021, 2022, 2023];
const MAIN_WEEKS = [5, 17];
const EARLY_WEEKS = [2, 4];
const POOL = { QB: 14, RB: 34, WR: 40, TE: 14 };
const POS = ['QB', 'RB', 'WR', 'TE'];
const K_GRID = [2, 5, 10, 20, 50, 100];
const BOOT = { iterations: 2000, seed: 20260918 };
const GUARD_SLACK = 0.01;
const GUARD_STATUSES = ['questionable', 'doubtful', 'out'];

const { rows } = await import('../server/db/index.js');
const C = await import('../server/services/contingency.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

if (rows(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'nfl_availability_role_rates'`)[0].n) {
  const n = rows('SELECT COUNT(*) AS n FROM nfl_availability_role_rates')[0].n;
  if (n) throw new Error(`this copy already has ${n} role rates; CURRENT must be production today (no role rates)`);
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r4 = x => (x == null || !Number.isFinite(x) ? x : +x.toFixed(4));
const corr = (xs, ys) => {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
};

/* ------------------------------------------------------------ decision rows */

/** The weekly harness's decision rows for one block, cached: replaying is the slow part. */
async function decisionRows(season, [startWeek, endWeek], block) {
  const file = path.join(CACHE, `decision-${season}-${block}.json`);
  if (!flag('--rebuild') && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
  const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } = await import('../server/services/weekly-ensemble.js');
  const { activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
  // Same head as scripts/fit-posture-calibration.mjs. It only ranks STARTERS here.
  const ws = activeWeeklyWeightSet({ season: 2026, week: 3 });
  const t0 = Date.now();
  const r = replaySeasonWeekly(season, {
    startWeek, endWeek, distributions: false, runs: 300, roleRecency: WEEKLY_ROLE_RECENCY,
    predictionHead: ctx => weeklyEnsemblePrediction(ctx, ws.weights)
  });
  const usage = rows('SELECT player_id, week, team FROM player_week_usage WHERE season = ?', season);
  const teamOf = new Map(usage.map(u => [`${u.player_id}|${u.week}`, u.team]));
  const playing = new Set(usage.filter(u => u.team).map(u => `${u.team}|${u.week}`));
  const audit = { season, block, weeks: `${startWeek}-${endWeek}`, weight_set: ws.id, raw: r._decision_rows.length,
    no_team: 0, bye_dropped: 0, bye_dropped_but_played: 0 };
  const out = [];
  for (const d of r._decision_rows) {
    if (!POOL[d.position]) continue;
    const team = teamOf.get(`${d.player_id}|${d.week - 1}`);
    if (!team) { audit.no_team++; continue; }
    if (!playing.has(`${team}|${d.week}`)) {       // bye: production projects 0, never starts him
      audit.bye_dropped++; if (d.played) audit.bye_dropped_but_played++;
      continue;
    }
    out.push({ season, week: d.week, pid: d.player_id, pos: d.position, pred: +d.prediction.toFixed(4), y: d.played ? 1 : 0 });
  }
  audit.kept = out.length;
  audit.seconds = Math.round((Date.now() - t0) / 1000);
  const payload = { built_at: new Date().toISOString(), audit, rows: out };
  writeFileSync(file, JSON.stringify(payload));
  console.log(JSON.stringify(audit));
  return payload;
}

/** Per week, top N per position by the raw prediction. */
function markStarters(list, key = 'pred') {
  const byWeek = new Map();
  for (const r of list) {
    const k = `${r.season}|${r.week}|${r.pos}`;
    (byWeek.get(k) ?? byWeek.set(k, []).get(k)).push(r);
  }
  const ids = new Set();
  for (const [k, rs] of byWeek) {
    const pos = k.split('|')[2];
    for (const r of [...rs].sort((a, b) => b[key] - a[key]).slice(0, POOL[pos])) ids.add(r);
  }
  return ids;
}

/* ------------------------------------------------------------ inputs per row */

const gsisOf = new Map(rows(`SELECT id, gsis_id FROM players
                             WHERE gsis_id IS NOT NULL AND position IN ('QB','RB','WR','TE')`)
  .map(r => [r.id, String(r.gsis_id)]));
const reportsCache = new Map();
const reportsFor = season => reportsCache.get(season) ?? reportsCache.set(season, new Map(
  rows('SELECT * FROM nfl_injuries WHERE season = ?', season).map(r => [`${r.gsis_id}|${r.week}`, r]))).get(season);
const priorsCache = new Map();
const priorsFor = season => priorsCache.get(season) ?? priorsCache.set(season, C.availability({ through: season - 1 })).get(season);

/** Everything playerActiveProbability reads for one player-week, strictly pregame. */
function inputsFor(season, week, pid) {
  const gsis = gsisOf.get(pid);
  const report = gsis ? reportsFor(season).get(`${gsis}|${week}`) ?? null : null;
  const role = C.roleStates(season, week).get(pid) ?? null;
  const prior = priorsFor(season).get(pid)?.available ?? 0.92;
  return { report, role, prior, rs: report ? C.normReportStatus(report.report_status) : 'noreport' };
}

const predict = (lk, inp, useRole = true) =>
  +C.playerActiveProbability({ fitted: lk, report: inp.report, prior: inp.prior, role: inp.role, useRole }).active.toFixed(3);

/* ------------------------------------------------------------ role fit rows */

/** Every in-scope skill player-week: the same rows scripts/fit-availability.mjs#roleObservations fits on. */
function roleObservations(seasons) {
  const list = [];
  for (const season of seasons) {
    const teamWeeks = new Set(rows(`SELECT DISTINCT team, week FROM player_week_usage
                                    WHERE season = ? AND team IS NOT NULL`, season).map(r => `${r.team}|${r.week}`));
    const played = new Set(rows('SELECT player_id, week FROM player_week_usage WHERE season = ?', season)
      .map(r => `${r.player_id}|${r.week}`));
    for (let week = 1; week <= 18; week++) {
      for (const st of C.roleStates(season, week).values()) {
        if (!st.gap_bucket || !teamWeeks.has(`${st.team}|${week}`)) continue;
        const gsis = gsisOf.get(st.player_id);
        const report = gsis ? reportsFor(season).get(`${gsis}|${week}`) ?? null : null;
        list.push({
          season, week, player_id: st.player_id, position: st.position, tier: st.tier, gap: st.gap_bucket,
          role: st, report, prior: priorsFor(season).get(st.player_id)?.available ?? 0.92,
          rs: report ? C.normReportStatus(report.report_status) : 'noreport',
          ps: C.normPracticeStatus(report?.practice_status),
          active: played.has(`${st.player_id}|${week}`) ? 1 : 0
        });
      }
    }
  }
  return list;
}

const ratesOnFile = rows('SELECT scope,team,report_status,practice_status,p_active,n FROM nfl_availability_rates');
const currentLk = C.buildAvailabilityLookup({ rates: ratesOnFile });
const withConfig = (rates, config) => rates.map(r => ({ ...r, p_active: +r.p_active.toFixed(4), config: JSON.stringify(config) }));
const lookupFor = (fitted, config, { withRates = true } = {}) =>
  C.buildAvailabilityLookup({ rates: withRates ? ratesOnFile : [], roleRates: withConfig(fitted, config) });

/* ------------------------------------------------------------------ scoring */

function scoreArm(list, key) {
  const s = C.availabilityScores(list.map(r => ({ p: r[key], y: r.y })), { bins: 10 });
  return {
    n: s.n, played: r4(mean(list.map(r => r.y))), mean_p: r4(mean(list.map(r => r[key]))),
    log_loss: r4(s.log_loss), brier: r4(s.brier), ece: r4(s.ece),
    corr_p_played: r4(corr(list.map(r => r[key]), list.map(r => r.y))),
    table: s.table.map(b => ({ bin: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n, mean_p: r4(b.mean_p), played: r4(b.rate) }))
  };
}

function compare(list, a = 'p_current', b = 'p_candidate') {
  const cur = scoreArm(list, a), cand = scoreArm(list, b);
  const boot = pairedBootstrapDiff(list.map(r => C.rowLogLoss(r[a], r.y)), list.map(r => C.rowLogLoss(r[b], r.y)),
    { ...BOOT, groups: list.map(r => r.pid) });
  return {
    current: cur, candidate: cand, bootstrap_candidate_minus_current: boot,
    log_loss_pass: cand.log_loss < cur.log_loss && !boot.error && boot.ci90[1] < 0,
    ece_pass: cand.ece < cur.ece
  };
}

function guard(list, a = 'p_current', b = 'p_candidate') {
  const listed = list.filter(r => GUARD_STATUSES.includes(r.rs));
  const ll = key => (listed.length ? mean(listed.map(r => C.rowLogLoss(r[key], r.y))) : null);
  const cur = ll(a), cand = ll(b);
  return { n: listed.length, current: r4(cur), candidate: r4(cand), slack: GUARD_SLACK,
    pass: listed.length === 0 || cand <= cur + GUARD_SLACK };
}

function printTable(title, arms) {
  console.log(`\n${title}`);
  console.log('  bin      | ' + arms.map(([name]) => `${name.padEnd(9)}   n  mean p  played`).join(' | '));
  for (let i = 0; i < 10; i++) {
    const bin = `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`;
    const cells = arms.map(([, s]) => {
      const b = s.table.find(t => t.bin === bin);
      return b ? `${String(b.n).padStart(13)}  ${b.mean_p.toFixed(3)}  ${b.played.toFixed(3)}` : `${'-'.padStart(13)}      -       -`;
    });
    console.log(`  ${bin}  | ${cells.join(' | ')}`);
  }
  for (const [name, s] of arms) {
    console.log(`  ${name}: n ${s.n}  played ${s.played}  mean p ${s.mean_p}  log loss ${s.log_loss}  ECE ${s.ece}  Brier ${s.brier}  corr ${s.corr_p_played}`);
  }
}

/* --------------------------------------------------------------------- main */

const result = {
  gate: GATE, gate_sha256: createHash('sha256').update(GATE).digest('hex'),
  started_at: new Date().toISOString(), db: process.env.GRIDIRON_DB_PATH, blocks: []
};
console.log(`gate sha256 ${result.gate_sha256}`);

const seasons = FIT_ONLY ? FIT_SEASONS : [...FIT_SEASONS, VALIDATION_SEASON];
const decision = [];
for (const season of seasons) {
  const d = await decisionRows(season, MAIN_WEEKS, 'main');
  result.blocks.push(d.audit);
  for (const r of d.rows) decision.push({ ...r, block: 'main' });
}
const early = [];
if (!FIT_ONLY) {
  const d = await decisionRows(VALIDATION_SEASON, EARLY_WEEKS, 'early');
  result.blocks.push(d.audit);
  for (const r of d.rows) early.push({ ...r, block: 'early' });
}

// Inputs and the CURRENT arm, checked against the function production calls.
let checked = 0, mismatched = 0;
const mismatches = [];
for (const list of [decision, early]) {
  const byWeek = new Map();
  for (const r of list) (byWeek.get(`${r.season}|${r.week}`) ?? byWeek.set(`${r.season}|${r.week}`, []).get(`${r.season}|${r.week}`)).push(r);
  for (const [key, rs] of byWeek) {
    const [season, week] = key.split('|').map(Number);
    const live = C.weeklyAvailability(season, week, { through: season - 1 });
    for (const r of rs) {
      Object.assign(r, inputsFor(season, week, r.pid));
      r.tier = r.role?.tier ?? 'none';
      r.gap = r.role?.gap_bucket ?? 'none';
      r.p_current = predict(currentLk, r, false);
      const prod = live.get(r.pid)?.active_probability ?? 0.92;
      checked++;
      if (Math.abs(prod - r.p_current) > 1e-9) { mismatched++; if (mismatches.length < 5) mismatches.push({ season, week, pid: r.pid, prod, mine: r.p_current }); }
    }
  }
}
result.current_arm_check = { rows: checked, mismatched, examples: mismatches };
console.log(`CURRENT arm vs weeklyAvailability: ${checked} rows, ${mismatched} mismatched`);
if (mismatched) throw new Error(`CURRENT arm does not reproduce production: ${JSON.stringify(mismatches)}`);

const starters = markStarters(decision);
for (const r of decision) r.starter = starters.has(r);
// The finding's population: scripts/fit-posture-calibration.mjs ranks by prediction x current.
for (const r of decision) r.p_x_current = r.pred * r.p_current;
const posture = markStarters(decision, 'p_x_current');
for (const r of decision) r.posture = posture.has(r);
const earlyStarters = markStarters(early);
for (const r of early) r.starter = earlyStarters.has(r);

/* 1. Measurement: CURRENT, per season, both populations and the finding's pool. */
result.measurement = {};
for (const season of seasons) {
  const inSeason = decision.filter(r => r.season === season);
  result.measurement[season] = {
    decision: scoreArm(inSeason, 'p_current'),
    starters: scoreArm(inSeason.filter(r => r.starter), 'p_current'),
    posture_pool: scoreArm(inSeason.filter(r => r.posture), 'p_current'),
    starters_by_position: Object.fromEntries(POS.map(pos => [pos, (() => {
      const s = scoreArm(inSeason.filter(r => r.starter && r.pos === pos), 'p_current');
      return { n: s.n, played: s.played, mean_p: s.mean_p, log_loss: s.log_loss };
    })()])),
    starters_unknown_tier: inSeason.filter(r => r.starter && r.tier === 'unknown').length,
    // availability() applies TODAY's injury_flag to every season's prior (not time-specific).
    starters_with_todays_injury_flag: inSeason.filter(r => r.starter && priorsFor(season).get(r.pid)?.flagged).length
  };
  const m = result.measurement[season];
  printTable(`CURRENT ${season} weeks 5-17`, [['decision', m.decision], ['starters', m.starters], ['posture', m.posture_pool]]);
}

/* 2. Selection on the fit seasons. */
const obsBySeason = new Map();
const obsFor = list => list.flatMap(s => obsBySeason.get(s) ?? obsBySeason.set(s, roleObservations([s])).get(s));
const selectRows = decision.filter(r => r.season === SELECT_SCORE);
const selection = [];
for (const byPosition of [false, true]) for (const k of K_GRID) {
  const fitted = C.fitRoleRates(obsFor(SELECT_FIT), { k, byPosition });
  for (const durabilityCap of [false, true]) {
    const lk = lookupFor(fitted, { k, byPosition, durabilityCap });
    const ll = mean(selectRows.map(r => C.rowLogLoss(predict(lk, r), r.y)));
    selection.push({ byPosition, k, durabilityCap, log_loss_2024_decision: ll });
  }
}
const chosen = [...selection].sort((a, b) => a.log_loss_2024_decision - b.log_loss_2024_decision)[0];
const config = { k: chosen.k, byPosition: chosen.byPosition, durabilityCap: chosen.durabilityCap };
const candidateLk = lookupFor(C.fitRoleRates(obsFor(FIT_SEASONS), config), config);
result.selection = { fit: SELECT_FIT, scored: SELECT_SCORE, rows: selectRows.length,
  grid: selection.map(s => ({ ...s, log_loss_2024_decision: r4(s.log_loss_2024_decision) })), chosen: config };
console.log(`\nselection (fit ${SELECT_FIT}, scored on ${selectRows.length} ${SELECT_SCORE} decision rows): ${JSON.stringify(config)} ` +
  `log loss ${chosen.log_loss_2024_decision.toFixed(5)}`);
for (const s of [...selection].sort((a, b) => a.log_loss_2024_decision - b.log_loss_2024_decision).slice(0, 5)) {
  console.log(`  byPosition=${s.byPosition} k=${s.k} cap=${s.durabilityCap}  ${s.log_loss_2024_decision.toFixed(5)}`);
}

for (const r of [...decision, ...early]) r.p_candidate = predict(candidateLk, r);

/* 3. In-sample look at the fit seasons (not gated). */
result.fit_seasons = {};
for (const season of FIT_SEASONS) {
  const inSeason = decision.filter(r => r.season === season);
  result.fit_seasons[season] = {
    decision: compare(inSeason), starters: compare(inSeason.filter(r => r.starter)), guard: guard(inSeason)
  };
}
const unknownStarters = decision.filter(r => FIT_SEASONS.includes(r.season) && r.starter && r.tier === 'unknown');
result.fit_seasons.unknown_tier_starters = { n: unknownStarters.length,
  played: r4(mean(unknownStarters.map(r => r.y))), mean_candidate: r4(mean(unknownStarters.map(r => r.p_candidate))) };
console.log(`\nfit seasons (candidate in-sample): ${JSON.stringify(Object.fromEntries(FIT_SEASONS.map(s => [s, {
  decision_ll: [result.fit_seasons[s].decision.current.log_loss, result.fit_seasons[s].decision.candidate.log_loss],
  starters_ll: [result.fit_seasons[s].starters.current.log_loss, result.fit_seasons[s].starters.candidate.log_loss]
}])))}`);
console.log(`unknown-tier starters 2023-2024: ${JSON.stringify(result.fit_seasons.unknown_tier_starters)}`);

if (FIT_ONLY) {
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('\n--fit-only: 2025 not read.');
  process.exit(0);
}

/* 4. Validation, once. */
const val = decision.filter(r => r.season === VALIDATION_SEASON);
const valStarters = val.filter(r => r.starter);
const gate = { decision: compare(val), starters: compare(valStarters), guard: guard(val) };
gate.pass = gate.decision.log_loss_pass && gate.decision.ece_pass
  && gate.starters.log_loss_pass && gate.starters.ece_pass && gate.guard.pass;

// VARIANT: the rates scripts/fit-availability.mjs would write to the production file.
const innerTest = obsFor([SELECT_SCORE]);
const vSel = [];
for (const byPosition of [false, true]) for (const k of K_GRID) {
  const fitted = C.fitRoleRates(obsFor(VARIANT_SELECT_FIT), { k, byPosition });
  for (const durabilityCap of [false, true]) {
    const lk = lookupFor(fitted, { k, byPosition, durabilityCap }, { withRates: false });
    const ll = mean(innerTest.map(o => C.rowLogLoss(predict(lk, o), o.active)));
    vSel.push({ byPosition, k, durabilityCap, ll });
  }
}
const vChosen = [...vSel].sort((a, b) => a.ll - b.ll)[0];
const vPinned = opt('--variant-config', null);
const vConfig = vPinned ? JSON.parse(vPinned)
  : { k: vChosen.k, byPosition: vChosen.byPosition, durabilityCap: vChosen.durabilityCap };
if (vPinned) {
  console.log(`VARIANT pinned to ${JSON.stringify(vConfig)} (fit-availability.mjs writes it); its re-selection picked ` +
    `${JSON.stringify({ k: vChosen.k, byPosition: vChosen.byPosition, durabilityCap: vChosen.durabilityCap })}`);
}
const variantLk = lookupFor(C.fitRoleRates(obsFor(VARIANT_FIT), vConfig), vConfig);
for (const r of [...decision, ...early]) r.p_variant = predict(variantLk, r);
const variant = {
  config: vConfig, pinned: Boolean(vPinned), selection_best: { k: vChosen.k, byPosition: vChosen.byPosition,
    durabilityCap: vChosen.durabilityCap }, selection_log_loss: r4(vChosen.ll),
  decision: compare(val, 'p_current', 'p_variant'), starters: compare(valStarters, 'p_current', 'p_variant'),
  guard: guard(val, 'p_current', 'p_variant')
};
variant.pass = variant.decision.log_loss_pass && variant.decision.ece_pass
  && variant.starters.log_loss_pass && variant.starters.ece_pass && variant.guard.pass;
result.validation = { season: VALIDATION_SEASON, gate, variant, ship: gate.pass && variant.pass };

/* 5. Reported, not gated. */
const subgroups = (list, keyFn, key = 'p_candidate') => {
  const m = new Map();
  for (const r of list) {
    const k = keyFn(r);
    const a = m.get(k) ?? { group: k, n: 0, y: 0, cur: 0, cand: 0 };
    a.n++; a.y += r.y; a.cur += r.p_current; a.cand += r[key]; m.set(k, a);
  }
  return [...m.values()].sort((a, b) => b.n - a.n).map(a => ({ group: a.group, n: a.n,
    played: r4(a.y / a.n), current: r4(a.cur / a.n), candidate: r4(a.cand / a.n) }));
};
result.diagnostics_2025 = {
  starters_by_position: Object.fromEntries(POS.map(pos => {
    const c = compare(valStarters.filter(r => r.pos === pos));
    return [pos, { n: c.current.n, played: c.current.played, current: c.current.mean_p, candidate: c.candidate.mean_p,
      log_loss: [c.current.log_loss, c.candidate.log_loss] }];
  })),
  decision_by_report_tier: subgroups(val, r => `${r.rs}/${r.tier}`).slice(0, 14),
  posture_pool: compare(val.filter(r => r.posture)),
  early_weeks_2_4: early.length ? { decision: compare(early), starters: compare(early.filter(r => r.starter)) } : null
};

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));

const line = (name, c) => `  ${name.padEnd(9)} log loss ${c.current.log_loss} -> ${c.candidate.log_loss}  ` +
  `CI90 [${c.bootstrap_candidate_minus_current.ci90?.map(x => x.toFixed(4))}]  ${c.log_loss_pass ? 'PASS' : 'FAIL'} | ` +
  `ECE ${c.current.ece} -> ${c.candidate.ece}  ${c.ece_pass ? 'PASS' : 'FAIL'} | mean p ${c.current.mean_p} -> ${c.candidate.mean_p} (played ${c.current.played})`;
console.log(`\n=== VALIDATION ${VALIDATION_SEASON}, candidate ${JSON.stringify(config)} ===`);
console.log(line('decision', gate.decision));
console.log(line('starters', gate.starters));
console.log(`  guard Q/D/Out n=${gate.guard.n}  ${gate.guard.current} -> ${gate.guard.candidate}  ${gate.guard.pass ? 'PASS' : 'FAIL'}`);
console.log(`  GATE: ${gate.pass ? 'PASS' : 'FAIL'}`);
console.log(`\n=== VARIANT (fit-availability.mjs rates) ${JSON.stringify(vConfig)} ===`);
console.log(line('decision', variant.decision));
console.log(line('starters', variant.starters));
console.log(`  guard Q/D/Out n=${variant.guard.n}  ${variant.guard.current} -> ${variant.guard.candidate}  ${variant.guard.pass ? 'PASS' : 'FAIL'}`);
console.log(`  VARIANT: ${variant.pass ? 'PASS' : 'FAIL'}   SHIP: ${result.validation.ship}`);
printTable('2025 DECISION rows', [['current', gate.decision.current], ['candidate', gate.decision.candidate], ['variant', variant.decision.candidate]]);
printTable('2025 STARTERS', [['current', gate.starters.current], ['candidate', gate.starters.candidate], ['variant', variant.starters.candidate]]);
console.log('\n2025 starters by position:', JSON.stringify(result.diagnostics_2025.starters_by_position));
console.log('2025 decision rows by report/tier:');
for (const g of result.diagnostics_2025.decision_by_report_tier) console.log(`  ${g.group.padEnd(24)} n=${String(g.n).padStart(5)} played ${g.played}  current ${g.current}  candidate ${g.candidate}`);
if (result.diagnostics_2025.early_weeks_2_4) {
  console.log('\n2025 weeks 2-4 (not gated):');
  console.log(line('decision', result.diagnostics_2025.early_weeks_2_4.decision));
  console.log(line('starters', result.diagnostics_2025.early_weeks_2_4.starters));
}
console.log('\nposture pool 2025 (not gated):');
console.log(line('posture', result.diagnostics_2025.posture_pool));
process.exit(0);
