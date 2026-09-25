// E-XGB phase 2: shadow forecasts (GRIDIRON_EXGB) and the weekly pre-registered grader
// (docs/tdd/EXGB-PREREG.md + addendum 1). Synthetic fixtures only; nothing is served.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-exgb-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_EXGB;

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const flag = await import('../server/services/exgb-flag.js');
const shadow = await import('../server/services/exgb-shadow.js');
const grader = await import('../server/services/exgb-grader.js');
const { JOBS, resolveOffThread } = await import('../server/services/scheduler.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const S = 2031;
const WEEKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const POS = { 1: 'QB', 2: 'QB', 3: 'RB', 4: 'RB', 5: 'WR', 6: 'WR', 7: 'TE', 8: 'TE' };
// Sunday 13:00 ET of week w (weeks start 2031-09-07).
const sunday = w => { const d = new Date(Date.UTC(2031, 8, 7 + 7 * (w - 1))); return d.toISOString().slice(0, 10); };
const { nflKickoffDate } = await import('../server/services/date-util.js');
const kickoffIso = w => nflKickoffDate(sunday(w), '13:00').toISOString(); // DST-aware, like game_lines
const actualOf = (pid, w) => (pid === 8 ? 0 : 5 + pid + (w % 3)); // TE 8 never plays

function seed() {
  for (const [pid, pos] of Object.entries(POS)) {
    run('INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES (?,?,?,?,?)',
      Number(pid), `fixture ${pid}`, pos, 1000 + Number(pid), `G${pid}`);
  }
  for (const w of WEEKS) {
    run('INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (?,?,?,?,?)', S, w, 'AAA', sunday(w), '13:00');
    for (const pid of Object.keys(POS).map(Number)) {
      const cap = new Date(Date.parse(kickoffIso(w)) - 2 * 3600e3).toISOString();
      run(`INSERT INTO espn_weekly_projection_snapshots (season, week, player_id, espn_id, position, pro_team, projected_pts,
             scoring_key, captured_at, kickoff_at, late, window_key, capture_id, source_url_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, S, w, pid, 1000 + pid, POS[pid], 'AAA', 10, 'ppr', cap, kickoffIso(w), 0,
      'pre_kick', `c-${w}`, 'h');
      run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
             structural, prediction) VALUES (?,?,?,?,?,?,?,?,?)`, S, w, pid, POS[pid], cap, `${S}-W${w - 1}`, 'fx', 12, 12);
      if (pid === 8) continue;
      if (pid === 7) { // no ffopportunity row: the usage formula is the fallback (5 rec, 30 yds + (w%3) rec)
        run(`INSERT INTO player_week_usage (player_id, season, week, team, position, receptions, receiving_yards)
             VALUES (?,?,?,?,?,?,?)`, pid, S, w, 'AAA', 'TE', 3 + (w % 3), 90);
      } else {
        run(`INSERT INTO player_week_usage (player_id, season, week, team, position, receptions) VALUES (?,?,?,?,?,?)`,
          pid, S, w, 'AAA', POS[pid], 1);
        run(`INSERT INTO nfl_ffopportunity_weekly (season, week, player_gsis_id, actual_fantasy_points, source_release,
               ingested_at) VALUES (?,?,?,?,?,?)`, S, w, `G${pid}`, actualOf(pid, w), 'fixture', '2031-01-01');
      }
    }
  }
}
seed();

// The model is the actual + 0.5 for every player (a good model), stamped before kickoff.
function modelPayload(w, offset = 0.5) {
  return { season: S, week: w, lock_sha256: 'L', manifest_sha256: 'M', rows: Object.keys(POS).map(Number).map(pid => ({
    player_id: pid, espn_id: 1000 + pid, position: POS[pid], arm: 'A_xgb', prediction: actualOf(pid, w) + offset,
    espn_input: 10, kickoff_at: kickoffIso(w) })) };
}

test('GRIDIRON_EXGB is its own switch: off by default, and preview mode never turns it on', () => {
  assert.equal(flag.exgbEnabled(), false);
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try { assert.equal(flag.exgbEnabled(), false); } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
  process.env.GRIDIRON_EXGB = '1';
  try { assert.equal(flag.exgbEnabled(), true); } finally { delete process.env.GRIDIRON_EXGB; }
});

test('ingestPredictions stamps each row and flags a forecast made at or after kickoff as late', () => {
  const pre = new Date(Date.parse(kickoffIso(6)) - 3600e3);
  const r1 = shadow.ingestPredictions(modelPayload(6), { now: pre, windowKey: 'pre_kick_x' });
  assert.equal(r1.inserted, 8);
  assert.equal(r1.late, 0);
  // a later, WORSE forecast made after kickoff must never be graded
  const r2 = shadow.ingestPredictions(modelPayload(6, 9), { now: new Date(Date.parse(kickoffIso(6)) + 60e3), windowKey: 'late' });
  assert.equal(r2.late, 8);
  assert.throws(() => run('UPDATE exgb_shadow_predictions SET prediction = 0'), /append-only/);
  assert.throws(() => run('DELETE FROM exgb_shadow_predictions'), /append-only/);
});

test('actualPoints: nflverse PPR first, the usage formula as a counted fallback, no line = 0', () => {
  const a = grader.actualPoints(S, 6);
  assert.equal(a.get(1).pts, actualOf(1, 6));
  assert.equal(a.get(1).source, 'ffopportunity');
  assert.equal(a.get(7).source, 'usage_formula');
  assert.equal(a.get(7).pts, 3 + (6 % 3) + 9);
  assert.equal(a.get(8), undefined);
});

test('gradeWeek scores model vs frozen ESPN vs our projection on the pre-registered population', () => {
  const g = grader.gradeWeek(S, 6);
  const qb = g.rows.find(r => r.position === 'QB' && r.arm === 'A_xgb');
  assert.equal(qb.n, 2);
  assert.equal(qb.mae_model, 0.5, 'the late, worse forecast is ignored');
  const exp = (pid) => actualOf(pid, 6);
  assert.equal(qb.mae_espn, Math.abs(exp(1) - 10) / 2 + Math.abs(exp(2) - 10) / 2);
  assert.equal(qb.mae_current, Math.abs(exp(1) - 12) / 2 + Math.abs(exp(2) - 12) / 2);
  const te = g.rows.find(r => r.position === 'TE' && r.arm === 'A_xgb');
  assert.equal(te.n, 2, 'the TE who did not play is in the population with 0 points');
  assert.equal(te.n_actual_fallback, 1);
  const lgbm = g.rows.find(r => r.position === 'QB' && r.arm === 'A_lgbm');
  assert.equal(lgbm.n_model_fallback, 2, 'no A_lgbm forecast: scored with our projection, and counted');
  assert.equal(lgbm.mae_model, lgbm.mae_current);
});

test('pairedBootstrapP is deterministic and near 0 for a model that is always better', () => {
  const byWeek = new Map(WEEKS.map(w => [w, [1, 2, 0.5]]));
  const p1 = grader.pairedBootstrapP(byWeek, { draws: 2000 });
  assert.equal(p1, grader.pairedBootstrapP(byWeek, { draws: 2000 }));
  assert.equal(p1, 0);
  const mixed = new Map([[1, [1]], [2, [-1]], [3, [0.2]]]);
  assert.ok(grader.pairedBootstrapP(mixed, { draws: 2000 }) > 0.05);
});

test('the running result is not_run below 6 confirmatory weeks and passes a clearly better model at 6', () => {
  for (const w of WEEKS) {
    if (w === 6) continue;
    shadow.ingestPredictions(modelPayload(w), { now: new Date(Date.parse(kickoffIso(w)) - 3600e3), windowKey: 'pre' });
  }
  const five = grader.runningResult(S, 'A_xgb', { weeks: [6, 7, 8, 9, 10] });
  assert.equal(five.QB.verdict, 'not_run');
  const six = grader.runningResult(S, 'A_xgb', { weeks: [6, 7, 8, 9, 10, 11] });
  assert.equal(six.QB.weeks, 6);
  assert.equal(six.QB.verdict, 'pass');
  assert.ok(six.QB.holm_p_vs_espn >= six.QB.p_vs_espn, 'Holm never lowers a p-value');
  assert.equal(six.TE.verdict, 'pass');
});

test('runExgbWeeklyGrade: skipped while the flag is off; with it on, one row per week/position/arm, regraded only on change', async () => {
  const off = await grader.runExgbWeeklyGrade({ now: new Date('2031-12-01T00:00:00Z'), season: S, confirmatoryWeeks: [6, 7, 8, 9, 10, 11] });
  assert.ok(off.skipped);
  process.env.GRIDIRON_EXGB = '1';
  try {
    const now = new Date('2031-12-01T00:00:00Z');
    const r = await grader.runExgbWeeklyGrade({ now, season: S, confirmatoryWeeks: [6, 7, 8, 9, 10, 11] });
    assert.equal(r.weeks_graded, WEEKS.length);
    const last = rows(`SELECT * FROM exgb_weekly_grades WHERE week = 11 AND position = 'QB' AND arm = 'A_xgb'`);
    assert.equal(last.length, 1);
    assert.equal(last[0].verdict, 'pass');
    assert.equal(last[0].provisional, 1, 'before the outcome freeze every running result is provisional');
    assert.equal(rows(`SELECT * FROM exgb_weekly_grades WHERE week = 3`)[0].confirmatory, 0);
    const again = await grader.runExgbWeeklyGrade({ now, season: S, confirmatoryWeeks: [6, 7, 8, 9, 10, 11] });
    assert.equal(again.rows_written, 0, 'unchanged inputs write nothing');
    const md = grader.benchmarksMarkdown(S);
    assert.match(md, /\| 11 \| QB \| A_xgb \| 2 \|/);
  } finally { delete process.env.GRIDIRON_EXGB; }
});

test('runExgbShadowPredict: skipped while off; with it on, one forecast run per open window via the locked Python', async () => {
  const now = new Date(Date.parse(kickoffIso(9)) - 90 * 60e3);
  const off = await shadow.runExgbShadowPredict({ now, season: S });
  assert.ok(off.skipped);
  process.env.GRIDIRON_EXGB = '1';
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const out = args[args.indexOf('--out') + 1];
    fs.writeFileSync(out, JSON.stringify(modelPayload(Number(args[args.indexOf('--week') + 1]), 0.25)));
    return { status: 0, stdout: '{}', stderr: '' };
  };
  try {
    const r = await shadow.runExgbShadowPredict({ now, season: S, spawn });
    assert.equal(r.runs, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('predict'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--as-of') + 1], now.toISOString());
    const again = await shadow.runExgbShadowPredict({ now: new Date(now.getTime() + 15 * 60e3), season: S, spawn });
    assert.equal(again.runs, 0, 'the same window is never forecast twice');
    const fail = await shadow.runExgbShadowPredict({ now: new Date(Date.parse(kickoffIso(10)) - 90 * 60e3), season: S,
      spawn: () => ({ status: 1, stdout: '', stderr: 'LOCK: exgb_panel.py changed since the lock' }) });
    assert.equal(fail.failed, 1);
    assert.match(rows(`SELECT error FROM exgb_shadow_runs WHERE status = 'error'`)[0].error, /LOCK/);
  } finally { delete process.env.GRIDIRON_EXGB; }
});

test('both jobs are live, off-thread scheduler jobs on the refresh loop, after the ESPN capture', async () => {
  for (const name of ['exgb_shadow_predict', 'exgb_weekly_grade']) {
    assert.ok(JOBS[name], name);
    assert.equal(JOBS[name].tier, 'live');
    assert.equal(resolveOffThread(JOBS[name]), true);
  }
  const { FANTASY_LIVE_JOBS: L } = await import('../scripts/refresh-live-data.mjs');
  assert.ok(L.indexOf('espn_weekly_projection_capture') < L.indexOf('exgb_shadow_predict'));
  assert.ok(L.indexOf('exgb_shadow_predict') < L.indexOf('exgb_weekly_grade'));
});
