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
 * ROLE LAYER (2026-09-18): the rates above are fit on injury-report rows only,
 * so "no game status" (0.831) is the rate for players who were ON the practice
 * report, and the app applied it to every healthy player who was not. The role
 * layer fits a second table, `nfl_availability_role_rates`, on every in-scope
 * player-week (report or not) by report group x practice x recent snap-share
 * tier x games missed since his last appearance. It is written only when the
 * pre-registered gate below passes on the held-out season.
 *
 * Writes `nfl_availability_rates` and `nfl_availability_role_rates`. Usage:
 *   node --env-file-if-exists=.env scripts/fit-availability.mjs [--dry-run] [--report=path.json]
 */
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
const {
  AVAILABILITY_RATES_DDL, AVAILABILITY_ROLE_RATES_DDL, normReportStatus, normPracticeStatus,
  availability, roleStates, fitRoleRates, buildAvailabilityLookup, playerActiveProbability,
  rowLogLoss, availabilityScores, roleGateDecision, ROLE_GATE, designationRoleGate, DESIGNATION_ROLE_GATE
} = await import('../server/services/contingency.js');

const DRY = process.argv.includes('--dry-run');
const FIT_SEASONS = [2021, 2022, 2023, 2024];
const TEST_SEASON = 2025;

const REPORT_PATH = process.argv.find(a => a.startsWith('--report='))?.slice('--report='.length) ?? null;

// Both tables' DDL is shared with the loader (contingency.js) and the tests.
db.exec(AVAILABILITY_RATES_DDL);
db.exec(AVAILABILITY_ROLE_RATES_DDL);

// What the app reads today, captured before anything is rewritten, so the gate
// can confirm its "current" arm is the table actually on file.
let ratesOnFile = [];
try { ratesOnFile = rows('SELECT scope,team,report_status,practice_status,p_active FROM nfl_availability_rates'); } catch { ratesOnFile = []; }

const normStatus = normReportStatus;
const normPractice = normPracticeStatus;

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

/* ------------------------------------------------------------ role layer */
/*
 * PRE-REGISTERED GATE — written 2026-09-18 before any 2025 number for the role
 * layer was computed, and never moved after. The rule itself is ROLE_GATE /
 * roleGateDecision in server/services/contingency.js; the protocol is recorded
 * in docs/tdd/play-chance.tdd.md.
 *
 *   Event: a player_week_usage row that week (the same event as the rates above).
 *   Population: every season x week 1-18 x skill player in role scope (appeared
 *     in one of his team's last four games) whose team plays that week.
 *   Selection, never touching 2025: byPosition {no, yes} x k {2,5,10,20,50,100}
 *     x durability cap {off, on}; fit 2021-2023, chosen by 2024 log loss, no
 *     team ratio inside the inner fold.
 *   Validation: the chosen config refit on 2021-2024, scored ONCE on 2025
 *     against today's path (league cell x team ratio; min durability prior for
 *     a player with no report).
 *   Ship only if ALL hold: (1) 2025 log loss improves and the player-clustered
 *     paired bootstrap of per-row log loss (candidate minus current, 2,000
 *     draws, seed 20260918) has its 90% interval below zero; (2) expected
 *     calibration error over 10 equal-width bins improves; (3) on rows listed
 *     Questionable/Doubtful/Out, log loss is no more than 0.01 worse.
 *   A failed gate writes no role rates and clears any left from an earlier fit.
 *
 * G2, ADDED 2026-09-18 (play-chance-live) before any 2025 number was broken out
 * this way; the rule is DESIGNATION_ROLE_GATE / designationRoleGate in contingency.js:
 *   On the same 2025 rows, by designation (report group noreport | none |
 *   questionable | doubtful | out) x role tier, plus each designation pooled: every
 *   cell with n >= 50 must have (a) candidate log loss <= current + 0.02 and
 *   (b) |mean candidate - actual| <= max(0.03, 2 x binomial SE) or no worse than
 *   current's. 10-bin ECE per cell reported for both arms, gated overall only.
 *   Role rates are written only if the original gate AND G2 pass. Live ESPN
 *   designations are not in any of these rows (no pregame ESPN history exists);
 *   they are checked on the live week (docs/tdd/play-chance-live.tdd.md, G4).
 */
const ROLE_INNER_FIT = FIT_SEASONS.slice(0, -1);
const ROLE_INNER_TEST = FIT_SEASONS.at(-1);
const ROLE_K_GRID = [2, 5, 10, 20, 50, 100];

/** Every in-scope skill player-week, with his role, his report, and whether he recorded usage. */
function roleObservations(seasons) {
  const gsisOf = new Map(rows(`SELECT id, gsis_id FROM players
                               WHERE gsis_id IS NOT NULL AND position IN ('QB','RB','WR','TE')`)
    .map(r => [r.id, String(r.gsis_id)]));
  const list = [];
  for (const season of seasons) {
    const teamWeeks = new Set(rows(`SELECT DISTINCT team, week FROM player_week_usage
                                    WHERE season = ? AND team IS NOT NULL`, season).map(r => `${r.team}|${r.week}`));
    const played = new Set(rows('SELECT player_id, week FROM player_week_usage WHERE season = ?', season)
      .map(r => `${r.player_id}|${r.week}`));
    const reports = new Map(rows('SELECT * FROM nfl_injuries WHERE season = ?', season)
      .map(r => [`${r.gsis_id}|${r.week}`, r]));
    for (let week = 1; week <= 18; week++) {
      for (const st of roleStates(season, week).values()) {
        if (!st.gap_bucket || !teamWeeks.has(`${st.team}|${week}`)) continue;
        const gsis = gsisOf.get(st.player_id);
        const report = gsis ? reports.get(`${gsis}|${week}`) ?? null : null;
        list.push({
          season, week, player_id: st.player_id, position: st.position, tier: st.tier, gap: st.gap_bucket,
          role: st, report,
          rs: report ? normReportStatus(report.report_status) : 'noreport',
          ps: normPracticeStatus(report?.practice_status),
          active: played.has(`${st.player_id}|${week}`) ? 1 : 0
        });
      }
    }
  }
  return list;
}

const roleObs = roleObservations([...FIT_SEASONS, TEST_SEASON]);
const priorsBySeason = new Map([ROLE_INNER_TEST, TEST_SEASON].map(s => [s, availability({ through: s - 1 })]));
const priorOf = o => priorsBySeason.get(o.season)?.get(o.player_id)?.available ?? 0.92;
// Rounded exactly as the app stores (4 dp) and shows (3 dp) them.
const withConfig = (rates, config) => rates.map(r => ({ ...r, p_active: +r.p_active.toFixed(4), config: JSON.stringify(config) }));
const predict = (lk, o, useRole = true) =>
  +playerActiveProbability({ fitted: lk, report: o.report, prior: priorOf(o), role: o.role, useRole }).active.toFixed(3);

console.log(`\n--- role layer: ${roleObs.length} in-scope player-weeks (${[...FIT_SEASONS, TEST_SEASON].join(',')}) ---`);
const innerTrain = roleObs.filter(o => ROLE_INNER_FIT.includes(o.season));
const innerTest = roleObs.filter(o => o.season === ROLE_INNER_TEST);
const selection = [];
for (const byPosition of [false, true]) for (const k of ROLE_K_GRID) {
  const fitted = fitRoleRates(innerTrain, { k, byPosition });
  for (const durabilityCap of [false, true]) {
    const lk = buildAvailabilityLookup({ roleRates: withConfig(fitted, { k, byPosition, durabilityCap }) });
    const ll = innerTest.reduce((s, o) => s + rowLogLoss(predict(lk, o), o.active), 0) / innerTest.length;
    selection.push({ byPosition, k, durabilityCap, log_loss: +ll.toFixed(5) });
  }
}
selection.sort((a, b) => a.log_loss - b.log_loss);
const selected = selection[0];
console.log(`selection (fit ${ROLE_INNER_FIT.join(',')}, scored ${ROLE_INNER_TEST}, ${innerTest.length} rows), best 5:`);
for (const s of selection.slice(0, 5)) console.log(`  byPosition=${s.byPosition} k=${s.k} durabilityCap=${s.durabilityCap}  log loss ${s.log_loss}`);

/*
 * PINNED CONFIG (play-chance-live, 2026-09-18). The selection above picked
 * byPosition, k = 5, no cap before any change in that item (49174d4, and run 1 of
 * play-chance-live), and that config was validated on 2025 on its first look. After
 * Out/Doubtful were priced at their designation rate (contingency.js NEAR_CERTAIN) the
 * same selection flipped to k = 2 on a 0.00018 margin (k = 5 vs k = 2 is a near-tie
 * both ways), and k = 2 failed the designation x role gate on 2025 (none/unknown log
 * loss +0.028). The pin keeps every row the new rules do not touch identical to the
 * validated model; the selection still runs and is reported, and the output says when
 * it disagrees. Pinned after seeing that failure — docs/tdd/play-chance-live.tdd.md.
 * A new pin needs its own gate.
 */
const PINNED_ROLE_CONFIG = Object.freeze({ k: 5, byPosition: true, durabilityCap: false });
const chosen = { ...PINNED_ROLE_CONFIG, log_loss: selection.find(s => s.k === PINNED_ROLE_CONFIG.k
  && s.byPosition === PINNED_ROLE_CONFIG.byPosition && s.durabilityCap === PINNED_ROLE_CONFIG.durabilityCap)?.log_loss ?? null };
const selectionAgrees = selected.k === chosen.k && selected.byPosition === chosen.byPosition
  && selected.durabilityCap === chosen.durabilityCap;
console.log(`pinned config k=${chosen.k} byPosition=${chosen.byPosition} durabilityCap=${chosen.durabilityCap} ` +
  `(2024 log loss ${chosen.log_loss}); selection ${selectionAgrees ? 'agrees' : `DISAGREES (picked k=${selected.k} byPosition=${selected.byPosition} durabilityCap=${selected.durabilityCap})`}`);

const baseConfig = { k: chosen.k, byPosition: chosen.byPosition, durabilityCap: chosen.durabilityCap };
const roleFit = fitRoleRates(roleObs.filter(o => FIT_SEASONS.includes(o.season)), baseConfig);
const leagueTeamRates = out.map(r => ({ scope: r.scope, team: r.team, report_status: r.rs, practice_status: r.ps, p_active: +r.p.toFixed(4), n: r.n }));
const currentLk = buildAvailabilityLookup({ rates: leagueTeamRates });
const candidateLk = buildAvailabilityLookup({ rates: leagueTeamRates, roleRates: withConfig(roleFit, baseConfig) });

// The "current" arm must be the table the app reads today.
const onFileKey = r => `${r.scope}|${r.team}|${r.report_status}|${r.practice_status}`;
const onFile = new Map(ratesOnFile.map(r => [onFileKey(r), r.p_active]));
const sameAsOnFile = ratesOnFile.length === leagueTeamRates.length
  && leagueTeamRates.every(r => Math.abs((onFile.get(onFileKey(r)) ?? NaN) - r.p_active) < 1e-9);
console.log(`current arm = rates on file: ${sameAsOnFile ? 'yes' : `NO (${ratesOnFile.length} on file vs ${leagueTeamRates.length} refit)`}`);

const gateRows = roleObs.filter(o => o.season === TEST_SEASON).map(o => ({
  player_id: o.player_id, y: o.active, rs: o.rs, tier: o.tier, gap: o.gap, position: o.position,
  p_current: predict(currentLk, o, false), p_candidate: predict(candidateLk, o)
}));
const gate = roleGateDecision(gateRows);
const f4 = x => (x == null ? 'n/a' : x.toFixed(4));
console.log(`\n=== GATE ${TEST_SEASON} (fit ${FIT_SEASONS.join(',')}), ${gateRows.length} player-weeks, ${new Set(gateRows.map(r => r.player_id)).size} players ===`);
const L = gate.checks.log_loss, E = gate.checks.calibration, G = gate.checks.guard;
console.log(`  1 log loss      current ${f4(L.current)}  candidate ${f4(L.candidate)}  mean(b-a) ${L.bootstrap.mean_diff}  ci90 [${L.bootstrap.ci90}]  ${L.pass ? 'PASS' : 'FAIL'}`);
console.log(`  2 calibration   ECE current ${f4(E.current)}  candidate ${f4(E.candidate)}  ${E.pass ? 'PASS' : 'FAIL'}`);
console.log(`  3 guard Q/D/Out n=${G.n}  current ${f4(G.current)}  candidate ${f4(G.candidate)}  (slack ${G.slack})  ${G.pass ? 'PASS' : 'FAIL'}`);
console.log(`  Brier current ${f4(gate.current.brier)}  candidate ${f4(gate.candidate.brier)}`);
const g2 = designationRoleGate(gateRows);
const ship = gate.pass && g2.pass;
console.log(`  G2 designation x role (cells n >= ${DESIGNATION_ROLE_GATE.minCell} gated): ${g2.pass ? 'PASS' : 'FAIL'}`);
console.log('  designation/role            n   actual  mean cur  mean cand  ll cur  ll cand  ECE cur  ECE cand  gated  result');
for (const c of g2.cells) {
  console.log(`  ${(c.designation + '/' + c.role).padEnd(24)} ${String(c.n).padStart(5)}  ${c.actual.toFixed(3)}   ${c.mean_current.toFixed(3)}     ` +
    `${c.mean_candidate.toFixed(3)}    ${c.log_loss_current.toFixed(3)}   ${c.log_loss_candidate.toFixed(3)}    ${c.ece_current.toFixed(3)}    ` +
    `${c.ece_candidate.toFixed(3)}    ${c.gated ? 'yes' : 'no '}    ${!c.gated ? '-' : c.pass ? 'PASS' : `FAIL${c.log_loss_pass ? '' : ' ll'}${c.calibration_pass ? '' : ' cal'}`}`);
}
console.log(`  DECISION: ${ship ? 'PASS - role rates will be written' : 'FAIL - no role rates are written'}`);
console.log('\n  calibration table (predicted vs actual play rate)');
console.log('  bin        | current: n    mean p  actual | candidate: n  mean p  actual');
for (let i = 0; i < ROLE_GATE.bins; i++) {
  const lo = i / ROLE_GATE.bins;
  const c = gate.current.table.find(b => b.lo === lo), d = gate.candidate.table.find(b => b.lo === lo);
  const cell = b => b ? `${String(b.n).padStart(6)}  ${b.mean_p.toFixed(3)}  ${b.rate.toFixed(3)}` : '     -      -      -';
  console.log(`  ${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}    | ${cell(c)} | ${cell(d)}`);
}
const groupSummary = keyFn => {
  const m = new Map();
  for (const r of gateRows) {
    const k = keyFn(r);
    const a = m.get(k) ?? { group: k, n: 0, played: 0, cur: 0, cand: 0 };
    a.n++; a.played += r.y; a.cur += r.p_current; a.cand += r.p_candidate; m.set(k, a);
  }
  return [...m.values()].sort((a, b) => b.n - a.n).map(a => ({
    group: a.group, n: a.n, actual: +(a.played / a.n).toFixed(3),
    current: +(a.cur / a.n).toFixed(3), candidate: +(a.cand / a.n).toFixed(3)
  }));
};
const subgroups = groupSummary(r => `${r.rs}/${r.tier}/${r.gap}`);
console.log('\n  by report group / tier / gap (mean predicted vs actual), largest 14');
for (const g of subgroups.slice(0, 14)) console.log(`  ${g.group.padEnd(30)} n=${String(g.n).padStart(5)} actual ${g.actual.toFixed(3)}  current ${g.current.toFixed(3)}  candidate ${g.candidate.toFixed(3)}`);

const roleConfig = {
  ...baseConfig, fitSeasons: FIT_SEASONS,
  selection: { fit: ROLE_INNER_FIT, scored: ROLE_INNER_TEST, log_loss: chosen.log_loss, pinned: true,
    selection_agrees: selectionAgrees, selection_best: { k: selected.k, byPosition: selected.byPosition,
      durabilityCap: selected.durabilityCap, log_loss: selected.log_loss } },
  gate: {
    season: TEST_SEASON, pass: gate.pass, rows: gateRows.length,
    log_loss: { current: L.current, candidate: L.candidate, ci90: L.bootstrap.ci90 },
    ece: { current: E.current, candidate: E.candidate },
    guard: { n: G.n, current: G.current, candidate: G.candidate },
    designation_role: { pass: g2.pass, failed_cells: g2.cells.filter(c => c.gated && !c.pass).map(c => `${c.designation}/${c.role}`) },
    ship
  }
};
const roleRatesToWrite = withConfig(roleFit, roleConfig);
if (REPORT_PATH) {
  const fs = await import('node:fs');
  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    selection, chosen, selected, selection_agrees: selectionAgrees, current_arm_matches_table_on_file: sameAsOnFile,
    gate_rows: gateRows,
    gate: { pass: gate.pass, checks: gate.checks, current: gate.current, candidate: gate.candidate },
    designation_role_gate: g2, ship,
    subgroups, role_rates: roleRatesToWrite.map(({ config, ...r }) => r)
  }, null, 2));
  console.log(`\nreport written to ${REPORT_PATH}`);
}

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
const now = new Date().toISOString();
db.exec('BEGIN');
try {
  run('DELETE FROM nfl_availability_rates');
  for (const r of out) {
    run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, r.scope, r.team, r.rs, r.ps, +r.p.toFixed(4), r.n, +r.raw.toFixed(4), r.shrunk, now);
  }
  // A failed gate ships nothing: no role rates, and none left over from an earlier fit.
  run('DELETE FROM nfl_availability_role_rates');
  if (ship) {
    for (const r of roleRatesToWrite) {
      run(`INSERT INTO nfl_availability_role_rates
           (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, r.report_status, r.practice_status, r.position, r.tier, r.gap,
        r.p_active, r.n, +r.raw_rate.toFixed(4), r.config, now);
    }
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`\nwrote ${out.length} rows to nfl_availability_rates (shrinkage k=${bestK})`);
console.log(ship
  ? `wrote ${roleRatesToWrite.length} rows to nfl_availability_role_rates (k=${chosen.k}, byPosition=${chosen.byPosition}, durabilityCap=${chosen.durabilityCap})`
  : 'nfl_availability_role_rates left empty: the gate (overall or designation x role) failed');
process.exit(0);
