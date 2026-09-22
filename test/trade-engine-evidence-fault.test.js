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
  // These stay 0, not null — the fix deliberately does not change the numeric
  // shape, because every consumer of `seasons`/`top24` expects a number and a
  // null would propagate as NaN through packageRisk's sums. `profile` is what
  // carries the distinction, and `packageRisk.unreadable` is what stops these
  // zeros being read as a measurement of the package.
  assert.equal(profile.seasons, 0);
  assert.equal(profile.top24, 0);
});

/**
 * The pair, asserted together: the whole fix is that these two cases stop
 * producing the same sentence, so neither reading means anything without the
 * other in the same breath.
 */
test('thrown and null careers are told apart: unknown vs a genuine "no NFL record"', () => {
  _setEvidenceSources({ careerLine: () => { throw new Error('career query failed'); } });
  const thrown = packageRisk([playerWithEvidence(10, 'Real Veteran')]);

  _setEvidenceSources({ careerLine: () => null });
  const genuinelyNone = packageRisk([playerWithEvidence(11, 'Genuine Rookie')]);

  assert.equal(thrown.players[0].profile, 'unknown');
  assert.equal(genuinelyNone.players[0].profile, 'unproven');
  assert.match(thrown.headline_read, /could not be read/i);
  assert.match(genuinelyNone.headline_read, /no NFL record/i);
  assert.notEqual(thrown.headline_read, genuinelyNone.headline_read);
});

/**
 * packageRisk sums over `withRecord` (seasons > 0), which drops an unknown
 * player. Without the count, a package whose second record failed to load
 * reports the first player's seasons as though they were the whole package.
 */
test('an unreadable record in a package is counted, not silently dropped from the sums', () => {
  let call = 0;
  _setEvidenceSources({
    careerLine: () => { call += 1; if (call === 2) throw new Error('career query failed'); return VETERAN_CAREER; }
  });

  const read = packageRisk([playerWithEvidence(20, 'Readable Veteran'), playerWithEvidence(21, 'Unreadable Veteran')]);

  assert.equal(read.unreadable, 1);
  // The sums still cover only the readable player — that is what makes the
  // count load-bearing rather than cosmetic.
  assert.equal(read.seasons, 5);
  assert.equal(read.players.length, 2);
  assert.equal(read.players[1].profile, 'unknown');
});

test('a package with every record readable reports nothing unreadable', () => {
  _setEvidenceSources({ careerLine: () => VETERAN_CAREER });

  const read = packageRisk([playerWithEvidence(30, 'A'), playerWithEvidence(31, 'B')]);

  assert.equal(read.unreadable, 0);
  assert.equal(read.seasons, 10);
});

/**
 * Stated because it is a real consequence and not obvious: playerEvidence
 * memoises per player, so a TRANSIENT throw is sticky — the player reads
 * "record could not be read" until the cache turns over (buildAssetUniverse
 * clears it on a data change, _setEvidenceSources clears it, and it clears
 * itself past 5000 entries). The cache is kept because evaluate() runs
 * thousands of times inside findTrades() and an always-throwing source would
 * otherwise be re-invoked on every one of them.
 */
test('a faulted evidence read is memoised like any other, so the fault is sticky', () => {
  let calls = 0;
  _setEvidenceSources({ careerLine: () => { calls += 1; throw new Error('transient'); } });

  const first = playerEvidence(40);
  const second = playerEvidence(40);

  assert.equal(calls, 1, 'the throwing source is called once, not per lookup');
  assert.deepEqual(first, second);
  assert.deepEqual(second.evidence_unreadable, ['career']);
});
