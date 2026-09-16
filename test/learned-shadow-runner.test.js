import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveResearchPython } from '../server/betting/nfl/forecast/python-artifact.js';

const python = resolveResearchPython();
test('weekly trained model reaches the existing shadow decision tape', {
  skip: python ? false : 'configure GRIDIRON_RESEARCH_PYTHON for real training integration'
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-shadow-test-'));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
  process.env.SCHEDULER_DISABLED = '1';
  const { db, run, rows } = await import('../server/db/index.js');
  await (await import('../server/db/migrate.js')).runMigrations();
  t.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const { seedEnsembleFixture, FIXTURE_TEAMS } = await import('./helpers/seed-ensemble-fixture.js');
  // unified_model's chronological blocks need >=200 base rows, >=100
  // combination rows across 24 weeks and >=100 calibration rows across 12
  // weeks (research/betting/nfl/unified_model.py RECIPE). The default
  // 16-team fixture (8 games/week) caps the fixed 12-week calibration block
  // at 96 rows no matter how many seasons are added, since that block's
  // week count is a constant, not something more history can grow. Two
  // extra placeholder teams (18 total, 9 games/week) clear all three
  // minimums with margin; the original 16 (including KC/BAL/SF/SEA, scored
  // below) are unchanged so their historical form features are unaffected.
  seedEnsembleFixture({ run, rows }, {
    seasons: [2020, 2021, 2022, 2023], teams: [...FIXTURE_TEAMS, 'XX1', 'XX2'],
    latentFactors: 3, noise: 0.35,
  });
  for (const [i, team] of ['KC', 'BAL', 'SF', 'SEA'].entries()) {
    run("INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','West')", i + 1, team, team);
  }
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  for (const [home, away] of [['KC', 'BAL'], ['SF', 'SEA']]) {
    run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,rest_days)
      VALUES (2026,2,?,?,1,?,'13:00',7)`, home, away, date);
    run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,rest_days)
      VALUES (2026,2,?,?,0,?,'13:00',8)`, away, home, date);
  }
  const m = await import('../server/betting/nfl/strategy/learned-shadow-runner.js');
  const options = { season: 2026, week: 2, outputRoot: path.join(temp, 'outputs'), python };
  const firstPromise = m.runLearnedShadowPass(options);
  assert.equal(m.runLearnedShadowPass(options), firstPromise, 'overlapping scheduler passes share one worker');
  const first = await firstPromise;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.fit.ok, true, JSON.stringify(first.fit));
  assert.equal(first.captured, 2);
  assert.equal(first.attempts.length, 2);
  assert.ok(first.attempts.every(a => a.available));
  const events = rows(`SELECT * FROM nfl_decision_events WHERE run_id IN
    (SELECT id FROM nfl_decision_runs WHERE experiment_id=?)`, m.LEARNED_SHADOW_VERSION);
  assert.equal(events.length, 2);
  assert.ok(events.every(e => Number.isFinite(e.projected_margin) && e.eligible === 0 && e.model_probability == null));
  const original = events.map(e => JSON.parse(e.feature_snapshot_json));
  assert.ok(original.every(s => s.frozen_request && s.evidence_mode === 'observed_shadow'));
  const obsDir = path.join(options.outputRoot, 'observations');
  const requestFile = fs.readdirSync(obsDir).find(n => n.endsWith('.request.json'));
  const observation = JSON.parse(fs.readFileSync(path.join(obsDir, requestFile), 'utf8'));
  run(`UPDATE game_lines SET team_score=999,rest_days=100 WHERE season=2021`);
  // Simulate a lost link acknowledgement, then retry the exact retained
  // observation. No refit or live source mutation can change the tape content.
  const replay = await m.recordLearnedObservation(observation, { outputRoot: options.outputRoot, python });
  assert.equal(replay.created, false);
  const again = rows(`SELECT * FROM nfl_decision_events WHERE run_id=?`, replay.run_id)[0];
  const previous = events.find(e => e.run_id === replay.run_id);
  assert.equal(again.feature_snapshot_json, previous.feature_snapshot_json);
  const missing = { ...observation, id: 'missing-artifact-fixture', request: null, reason: 'no_eligible_artifact' };
  const abstained = await m.recordLearnedObservation(missing, { outputRoot: options.outputRoot, python });
  assert.equal(abstained.available, false);
  assert.equal(rows('SELECT abstention_reason FROM nfl_decision_events WHERE run_id=?', abstained.run_id)[0].abstention_reason, 'no_eligible_artifact');
});
