/**
 * Giant Plan 8.9/8.11 (audit-consolidation stage 5).
 *
 * `nfl-replay.js`'s `replaySeason` never told `ensembleLine` (nfl-ensemble.js)
 * which blend mode to use, so it silently inherited ensembleLine's own
 * default ('raw') while the live production path (nfl-auto-picks.js) forces
 * 'market_residual'. A backtest run this way measures a different, unstated
 * policy from the one production actually runs.
 *
 * This makes `blendMode` a required, explicit parameter of `replaySeason`
 * (it throws rather than silently defaulting), and gives `nfl_replay_runs` a
 * `spec_json`/`spec_hash` column pair recording the run's blend spec as a
 * first-class, queryable fact instead of something buried in `config`'s
 * free-form JSON.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-replay-graph-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { replaySeason, saveReplay } = await import('../server/services/nfl-replay.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('replaySeason throws when blendMode is omitted entirely', () => {
  assert.throws(() => replaySeason(2026, {}), /blendMode is required/);
});

test('replaySeason throws when blendMode is an unrecognized value', () => {
  assert.throws(() => replaySeason(2026, { blendMode: 'blended' }), /blendMode is required/);
});

test('replaySeason throws even with no options object at all', () => {
  assert.throws(() => replaySeason(2026), /blendMode is required/);
});

test('replaySeason accepts a valid blendMode and proceeds to its normal (data-driven) result', () => {
  // No games are seeded for this season, so this exercises exactly the path
  // past blendMode validation: the ordinary "no completed games" result,
  // not a thrown TypeError.
  const out = replaySeason(2099, { blendMode: 'raw' });
  assert.equal(out.error, 'no completed games stored for 2099');
});

test("replaySeason accepts 'market_residual' as well as 'raw'", () => {
  const out = replaySeason(2099, { blendMode: 'market_residual' });
  assert.equal(out.error, 'no completed games stored for 2099');
});

/**
 * saveReplay() persists spec_json/spec_hash as their own columns, computed
 * from {blendMode, modelOptions} -- separate from the free-form `config`
 * blob so runs can be grouped/compared by spec without parsing it back out.
 */
function fakeResult(season, blendMode, modelOptions = {}) {
  return {
    summary: {
      season, label: null, bets: 0, wins: 0, losses: 0, pushes: 0, units: 0, roi: null,
      config: { policy: { id: 'test', version: '1' }, modelOptions, blendMode, startWeek: 1, endWeek: 1 }
    },
    bets: []
  };
}

test('saveReplay records spec_json/spec_hash matching the run\'s {blendMode, modelOptions}', () => {
  saveReplay(fakeResult(2026, 'raw'));
  const row = rows(`SELECT spec_json, spec_hash FROM nfl_replay_runs WHERE season=? ORDER BY id DESC LIMIT 1`, 2026)[0];
  assert.ok(row.spec_json, 'spec_json must be populated');
  assert.ok(row.spec_hash, 'spec_hash must be populated');
  const parsed = JSON.parse(row.spec_json);
  assert.deepEqual(parsed, { blendMode: 'raw', modelOptions: {} });
  const expectedHash = createHash('sha256').update(row.spec_json).digest('hex');
  assert.equal(row.spec_hash, expectedHash, 'spec_hash must be the sha256 of spec_json verbatim');
});

test('two runs with the same blendMode and modelOptions produce the same spec_hash', () => {
  saveReplay(fakeResult(2027, 'market_residual', { weighting: 'exponential' }));
  saveReplay(fakeResult(2028, 'market_residual', { weighting: 'exponential' }));
  const a = rows(`SELECT spec_hash FROM nfl_replay_runs WHERE season=?`, 2027)[0];
  const b = rows(`SELECT spec_hash FROM nfl_replay_runs WHERE season=?`, 2028)[0];
  assert.equal(a.spec_hash, b.spec_hash, 'identical blend specs must hash identically regardless of season');
});

test('a different blendMode produces a different spec_hash for otherwise identical modelOptions', () => {
  saveReplay(fakeResult(2029, 'raw', { weighting: 'exponential' }));
  saveReplay(fakeResult(2030, 'market_residual', { weighting: 'exponential' }));
  const a = rows(`SELECT spec_hash FROM nfl_replay_runs WHERE season=?`, 2029)[0];
  const b = rows(`SELECT spec_hash FROM nfl_replay_runs WHERE season=?`, 2030)[0];
  assert.notEqual(a.spec_hash, b.spec_hash, 'a real blend-spec difference must change the hash');
});

test('an existing (pre-migration-shaped) row is left with NULL spec columns rather than a fabricated hash', () => {
  // Simulates a row written before this migration: no spec_json/spec_hash at
  // all. Migration 041 is write-only and must never backfill a hash for a
  // run that was never actually computed under a declared blend spec.
  db.exec(`INSERT INTO nfl_replay_runs (season, label, created_at, bets, wins, losses, pushes, units, roi, config)
           VALUES (2020, NULL, datetime('now'), 0, 0, 0, 0, 0, NULL, '{}')`);
  const row = rows(`SELECT spec_json, spec_hash FROM nfl_replay_runs WHERE season=?`, 2020)[0];
  assert.equal(row.spec_json, null);
  assert.equal(row.spec_hash, null);
});
