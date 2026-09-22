import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern used across this suite: point GRIDIRON_DB_PATH at a
// throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-engine-evidence-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { playerEvidence, playerRiskProfile, packageRisk, _setEvidenceSources } =
  await import('../server/services/trade-engine.js');

await runMigrations();

afterEach(() => { _setEvidenceSources(); });
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A five-season top-24 record, in the shape careerLine() returns. */
const VETERAN_CAREER = {
  headline: '5 straight top-24 seasons',
  seasons: [2025, 2024, 2023, 2022, 2021].map(season => ({
    season, games: 16, ppr_points: 280, ppg: 17.5, pos_rank: 8
  })),
  consistency: { seasons_counted: 5, seasons_top24: 5, seasons_top12: 4, cv_points: 0.15, min_games: 15 }
};

/** Built the way slim() builds an outgoing player: the evidence spread on top. */
const playerWithEvidence = (id, name) => ({ id, name, value: 5000, ...playerEvidence(id) });

test('a veteran reads as his record when the career source works', () => {
  _setEvidenceSources({ careerLine: () => VETERAN_CAREER });

  const read = packageRisk([playerWithEvidence(1, 'Real Veteran')]);

  assert.equal(read.players[0].profile, 'proven floor');
  assert.match(read.headline_read, /top-24 floor/);
});

test('a genuine rookie reads as having no NFL record', () => {
  // The source worked and correctly reported nothing: he really is unproven.
  _setEvidenceSources({ careerLine: () => null });

  const read = packageRisk([playerWithEvidence(2, 'Genuine Rookie')]);

  assert.equal(read.players[0].profile, 'unproven');
  assert.match(read.headline_read, /no NFL record/);
});

test('a veteran whose career source THREW is not described as having no NFL record', () => {
  // The fault this pins: playerEvidence() catches the throw and leaves the
  // career field absent, which playerRiskProfile() reads as "0 seasons" and
  // describeProfile() states as a fact about the player. A broken data layer
  // then tells the user a real veteran has never played in the NFL.
  _setEvidenceSources({ careerLine: () => { throw new Error('career query failed'); } });

  const read = packageRisk([playerWithEvidence(3, 'Real Veteran')]);

  assert.notEqual(read.players[0].profile, 'unproven');
  assert.doesNotMatch(read.headline_read, /no NFL record/);
  assert.match(read.headline_read, /could not be read/i);
});

test('the fault is recorded on the evidence object, not silently dropped', () => {
  _setEvidenceSources({ careerLine: () => { throw new Error('career query failed'); } });

  const evidence = playerEvidence(4);

  assert.deepEqual(evidence.evidence_unreadable, ['career']);
  assert.equal(evidence.career, undefined);
});

test('a working source records no fault', () => {
  _setEvidenceSources({ careerLine: () => VETERAN_CAREER });

  const evidence = playerEvidence(5);

  assert.equal(evidence.evidence_unreadable, undefined);
});

test('playerRiskProfile marks the unreadable case as unknown, not unproven', () => {
  _setEvidenceSources({ careerLine: () => { throw new Error('career query failed'); } });

  const profile = playerRiskProfile(playerWithEvidence(6, 'Real Veteran'));

  assert.equal(profile.profile, 'unknown');
  // The numbers stay null rather than reading as measured zeros.
  assert.equal(profile.seasons, 0);
  assert.equal(profile.top24, 0);
});
