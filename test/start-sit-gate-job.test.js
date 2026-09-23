/**
 * The start_sit_gate job, run the way the worker runs it: job-worker.js calls
 * `scheduler.JOBS[job].run()`, so that call has to reach the gate's WRITER
 * (start-sit-gate.js#refreshStartSitGate -> model-governance.js#recordGateAudit,
 * table model_gate_audits) and not a reader. A job that only read would log 'ok'
 * in sync_log every week while the Lineup panel said "not measured yet" forever.
 *
 * The replay (weekly-backtest.js#replaySeasonWeekly) is mocked; everything between
 * JOBS.start_sit_gate.run and the stored row is the real code, including the default
 * k resolver (a stored fit through 2023 is cutoff-safe for 2024-2026).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-sit-gate-job-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const replayCalls = [];
mock.module('../server/services/weekly-backtest.js', {
  namedExports: {
    replaySeasonWeekly: (season, opts) => {
      replayCalls.push(season);
      const week = opts.startWeek;
      // Ours prefers the higher id and is right; the average prefers the lower id. Every
      // actual is startable (>= 8.0), so the oracle control has pairs to win.
      return { season, _decision_rows: [1, 2, 3, 4].map(id => ({ player_id: id, week, position: 'WR',
        prediction: 9 + id, season_to_date: 14 - id, actual: 8 + 2 * id, played: true })) };
    }
  }
});

const { JOBS, statusFromDetail } = await import('../server/services/scheduler.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function seed() {
  run(`INSERT INTO shrinkage_fits (id, fitted_at, through_season, test_season, active, note)
       VALUES (1, '2024-01-01T00:00:00Z', 2023, 2023, 1, 'fixture')`);
  run(`INSERT INTO shrinkage_k (fit_id, metric, position, k) VALUES (1, 'target_share', 'ALL', 0.2)`);
  for (let id = 1; id <= 4; id++) run(`INSERT INTO players (id, name, position) VALUES (?, ?, 'WR')`, id, `Fixture ${id}`);
  const usage = (id, season, week) => run(`INSERT OR IGNORE INTO player_week_usage (player_id, season, week, team, position)
    VALUES (?, ?, ?, 'AAA', 'WR')`, id, season, week);
  for (const season of [2024, 2025]) for (let week = 1; week <= 18; week++) for (let id = 1; id <= 4; id++) usage(id, season, week);
  for (const week of [1, 2]) for (let id = 1; id <= 4; id++) usage(id, 2026, week);
}

test('JOBS.start_sit_gate.run() stores one FANTASY / start_sit row in model_gate_audits and says where', async () => {
  seed();
  assert.equal(rows('SELECT COUNT(*) AS n FROM model_gate_audits')[0].n, 0, 'nothing stored before the run');
  const detail = await JOBS.start_sit_gate.run();
  const stored = rows(`SELECT id, sport, market, verdict, evidence_json FROM model_gate_audits`);
  assert.equal(stored.length, 1, 'the job wrote exactly one gate row');
  assert.equal(stored[0].sport, 'FANTASY');
  assert.equal(stored[0].market, 'start_sit');
  assert.equal(detail.audit_id, stored[0].id);
  assert.equal(JSON.parse(stored[0].evidence_json).verdict, detail.verdict);
  // Every replayed call is won (the average check passes), but this fixture has no served
  // snapshot and no ESPN value, so the plan's rule has no week to grade (Auditor A1, A4, A5).
  assert.notEqual(detail.verdict, 'beats_dumb', 'the job detail must carry the plan rule, not the average check');
  assert.equal(detail.verdict, 'not_shown');
  assert.equal(detail.average_verdict, 'beats_dumb');
  assert.equal(stored[0].verdict, 'blocked');
  assert.equal(statusFromDetail(detail), 'ok');
  assert.deepEqual(replayCalls, [2024, 2025, 2026], 'the job ran the past windows and the forward week');
});
