/**
 * Tests for nfl-market-correction-lookup.js -- the seam between the Python
 * research group (market_correction.py, exported offline) and the JS
 * ensemble's synchronous predict() loop.
 *
 * Isolation is the point of the first assertion: `test/offline-guard.mjs`
 * defaults `GRIDIRON_MARKET_CORRECTION_LOOKUP` to a path that does not exist,
 * so no test can read the real export unless it points at a file of its own.
 * These tests point at scratch files and never touch
 * `server/data/research/market-correction-lookup.json`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-market-correction-lookup-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const mod = await import('../server/services/nfl-market-correction-lookup.js');

function useLookup(name, payload) {
  const file = path.join(scratch, name);
  if (payload !== null) fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP = file;
  mod.clearMarketCorrectionLookupCache();
  return file;
}

test('the suite-wide default points at nothing, so a test cannot read the real export by accident', () => {
  // offline-guard.mjs sets this before any test file loads; a suite run
  // without that preload would fail here rather than silently reading real
  // research data into a synthetic fixture.
  assert.ok(process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP,
    'GRIDIRON_MARKET_CORRECTION_LOOKUP must be set for the whole test run');
  assert.ok(!process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP.includes(path.join('server', 'data', 'research')),
    'the default must not be the real export path');
});

test('a well-formed lookup answers exact keys and null for everything else', () => {
  useLookup('ok.json', {
    schema: 'nfl-market-correction-lookup-v1',
    weeks_correction_fitted: 5, weeks_correction_abstained: 1, games_with_correction: 2,
    entries: [
      { season: 2024, week: 3, home: 'KC', away: 'BAL', market_correction_margin: 1.75 },
      { season: 2024, week: 3, home: 'SF', away: 'SEA', market_correction_margin: -2.5 },
    ],
  });
  assert.equal(mod.marketCorrectionMargin(2024, 3, 'KC'), 1.75);
  assert.equal(mod.marketCorrectionMargin(2024, 3, 'SF'), -2.5);
  assert.equal(mod.marketCorrectionMargin(2024, 3, 'DAL'), null,
    'a game with no lookup entry must answer null, never a guessed number');
  assert.equal(mod.marketCorrectionMargin(1999, 1, 'KC'), null);
  const { meta } = mod.loadMarketCorrectionLookup();
  assert.equal(meta.games_with_correction, 2);
  assert.equal(meta.weeks_correction_fitted, 5);
});

test('a missing lookup file abstains everywhere rather than throwing', () => {
  useLookup('does-not-exist.json', null);
  assert.doesNotThrow(() => mod.marketCorrectionMargin(2024, 3, 'KC'));
  assert.equal(mod.marketCorrectionMargin(2024, 3, 'KC'), null);
  assert.equal(mod.loadMarketCorrectionLookup().meta, null);
});

test('a corrupt lookup file abstains everywhere rather than throwing', () => {
  useLookup('corrupt.json', 'not valid json{{{');
  assert.doesNotThrow(() => mod.marketCorrectionMargin(2024, 3, 'KC'));
  assert.equal(mod.marketCorrectionMargin(2024, 3, 'KC'), null);
  assert.equal(mod.loadMarketCorrectionLookup().meta, null);
});

test('the cache is keyed to a load, and clearing it re-reads the current path', () => {
  useLookup('first.json', { schema: 'nfl-market-correction-lookup-v1', games_with_correction: 1,
    entries: [{ season: 2024, week: 1, home: 'KC', away: 'BAL', market_correction_margin: 4 }] });
  assert.equal(mod.marketCorrectionMargin(2024, 1, 'KC'), 4);
  useLookup('second.json', { schema: 'nfl-market-correction-lookup-v1', games_with_correction: 1,
    entries: [{ season: 2024, week: 1, home: 'KC', away: 'BAL', market_correction_margin: -4 }] });
  assert.equal(mod.marketCorrectionMargin(2024, 1, 'KC'), -4);
});
