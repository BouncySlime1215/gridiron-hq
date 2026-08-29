import test from 'node:test';
import assert from 'node:assert/strict';
import { driveClockState, formationProbabilities, PLAY_MODEL_VERSION,
  simulateMatchup } from '../server/services/nfl-drive-sim.js';

test('formation model respects team shotgun tendency and game situation', () => {
  const low = formationProbabilities({ shotgunRate: 0.42, isPass: false, down: 1, toGo: 10 });
  const high = formationProbabilities({ shotgunRate: 0.82, isPass: false, down: 1, toGo: 10 });
  const pass = formationProbabilities({ shotgunRate: 0.42, isPass: true, down: 3, toGo: 9 });
  assert.ok(high.shotgun > low.shotgun);
  assert.ok(pass.shotgun > low.shotgun);
  for (const mix of [low, high, pass]) {
    assert.ok(Math.abs(mix.shotgun + mix.pistol + mix.under_center - 1) < 0.001);
  }
});

test('drive clock maps half time to the correct quarter clock', () => {
  assert.deepEqual(driveClockState({ half: 1, halfSeconds: 1800 }),
    { quarter: 1, quarter_seconds: 900, game_clock: '15:00' });
  assert.deepEqual(driveClockState({ half: 1, halfSeconds: 900 }),
    { quarter: 2, quarter_seconds: 900, game_clock: '15:00' });
  assert.deepEqual(driveClockState({ half: 2, halfSeconds: 75 }),
    { quarter: 4, quarter_seconds: 75, game_clock: '1:15' });
});

test('sample game tape carries auditable score, clock, formation and possession state', () => {
  const out = simulateMatchup({ home: 'KC', away: 'BUF', trials: 1, seed: 41, sampleDrives: true });
  assert.equal(out.play_model.version, PLAY_MODEL_VERSION);
  assert.ok(out.example_drives.length > 1);
  const drive = out.example_drives[0];
  assert.equal(drive.id, 1);
  assert.equal(drive.clock_start.game_clock, '15:00');
  assert.equal(typeof drive.score_after.home, 'number');
  assert.equal(typeof drive.score_after.away, 'number');
  assert.ok(drive.tape.length > 0);
  assert.equal(drive.tape[0].play_number, 1);
  assert.equal(drive.tape[0].quarter, 1);
  assert.match(drive.tape[0].formation, /SHOTGUN|UNDER CENTER|PISTOL/);
});
