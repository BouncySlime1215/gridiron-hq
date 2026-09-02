import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// One team-code map and one name resolver for every ingestion path.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-team-codes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const codes = await import('../server/services/team-codes.js');

for (const [abbr, name] of [['WAS', 'Washington Commanders'], ['LAR', 'Los Angeles Rams'], ['LAC', 'Los Angeles Chargers'],
  ['NYG', 'New York Giants'], ['NYJ', 'New York Jets'], ['SEA', 'Seattle Seahawks'], ['JAX', 'Jacksonville Jaguars'],
  ['LV', 'Las Vegas Raiders'], ['NE', 'New England Patriots'], ['MIN', 'Minnesota Vikings']]) {
  run('INSERT OR IGNORE INTO nfl_teams (abbr, name, conference, division) VALUES (?,?,?,?)', abbr, name, 'NFC', 'East');
}
codes.clearTeamResolverCache();

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('every feed spelling of a code maps to the canonical nflverse code', () => {
  assert.equal(codes.canonicalTeamCode('WSH'), 'WAS');
  assert.equal(codes.canonicalTeamCode('was'), 'WAS');
  assert.equal(codes.canonicalTeamCode('LA'), 'LAR');
  assert.equal(codes.canonicalTeamCode('STL'), 'LAR');
  assert.equal(codes.canonicalTeamCode('SD'), 'LAC');
  assert.equal(codes.canonicalTeamCode('OAK'), 'LV');
  assert.equal(codes.canonicalTeamCode('JAC'), 'JAX');
  assert.equal(codes.canonicalTeamCode('KC'), 'KC', 'a canonical code passes through');
  assert.equal(codes.espnTeamCode('WAS'), 'WSH');
  assert.equal(codes.espnTeamCode('WSH'), 'WSH');
  assert.equal(codes.espnTeamCode('KC'), 'KC');
});

test('the resolver handles abbreviations, full names, nicknames, cities and feed prefixes', () => {
  const resolve = codes.teamResolver();
  assert.equal(resolve('WSH')?.abbr, 'WAS');
  assert.equal(resolve('Washington Commanders')?.abbr, 'WAS');
  assert.equal(resolve('commanders')?.abbr, 'WAS');
  assert.equal(resolve('Los Angeles Rams')?.abbr, 'LAR');
  assert.equal(resolve('LA Rams')?.abbr, 'LAR');
  assert.equal(resolve('NY Giants')?.abbr, 'NYG');
  assert.equal(resolve('NY Jets')?.abbr, 'NYJ');
  assert.equal(resolve('Seattle')?.abbr, 'SEA');
  assert.equal(resolve('SEA Seahawks')?.abbr, 'SEA');
  assert.equal(resolve('JAC')?.abbr, 'JAX');
});

test('ambiguous or unknown spellings resolve to null rather than a guess', () => {
  const resolve = codes.teamResolver();
  assert.equal(resolve('NY'), null, 'NY alone is the Giants or the Jets');
  assert.equal(resolve('NE'), codes.teamResolver()('NE'), 'stable');
  assert.equal(resolve('NE')?.abbr, 'NE', 'a bare canonical code resolves by abbreviation, never by substring');
  assert.equal(resolve('Springfield Isotopes'), null);
  assert.equal(resolve(''), null);
  assert.equal(codes.teamCodeFor('Los Angeles Chargers'), 'LAC');
});
