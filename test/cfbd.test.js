import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cfbd-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { syncCfbdSeason, cfbdSignalFor, hasKey } = await import('../server/services/cfbd.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
const realKey = process.env.CFBD_API_KEY;
test.after(() => { globalThis.fetch = realFetch; process.env.CFBD_API_KEY = realKey; });

const USAGE = [
  { season: 2023, name: 'Marvin Harrison Jr.', position: 'WR', team: 'Ohio State',
    usage: { overall: 0.31, pass: 0.42, rush: 0 } },
  { season: 2023, name: 'Bijan Robinson', position: 'RB', team: 'Texas',
    usage: { overall: 0.28, pass: 0.05, rush: 0.55 } }
];
const PPA = [
  { season: 2023, name: 'Marvin Harrison Jr.', position: 'WR', team: 'Ohio State',
    averagePPA: { all: 0.45, pass: 0.45, rush: null } },
  // A player with PPA but no usage row — must still be stored, not dropped.
  { season: 2023, name: 'Late Add Receiver', position: 'WR', team: 'Georgia',
    averagePPA: { all: 0.22, pass: 0.22, rush: null } }
];

function stubFetch() {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/player/usage')) return { ok: true, json: async () => USAGE };
    if (String(url).includes('/ppa/players/season')) return { ok: true, json: async () => PPA };
    return { ok: false, status: 404 };
  };
}

test('without a configured key, sync is a graceful no-op', async () => {
  delete process.env.CFBD_API_KEY;
  const result = await syncCfbdSeason(2023);
  assert.equal(result, null);
});

test('hasKey reflects whether CFBD_API_KEY is set', () => {
  delete process.env.CFBD_API_KEY;
  assert.equal(hasKey(), false);
  process.env.CFBD_API_KEY = 'test-key';
  assert.equal(hasKey(), true);
});

test('with a key, syncing stores merged usage + PPA rows, keyed by normalized name', async () => {
  process.env.CFBD_API_KEY = 'test-key';
  stubFetch();
  const result = await syncCfbdSeason(2023);
  assert.equal(result.season, 2023);
  assert.equal(result.stored, 3, 'two usage rows + one PPA-only row, merged by name');

  const mhj = cfbdSignalFor('Marvin Harrison Jr.', 2023);
  assert.ok(mhj);
  assert.equal(mhj.usage_overall, 0.31);
  assert.equal(mhj.ppa_overall, 0.45, 'usage and PPA for the same player must merge into one row');

  const bijan = cfbdSignalFor('Bijan Robinson', 2023);
  assert.equal(bijan.usage_rush, 0.55);
  assert.equal(bijan.ppa_overall, null, 'a player with usage but no PPA row keeps a null PPA, not a fabricated one');

  const lateAdd = cfbdSignalFor('Late Add Receiver', 2023);
  assert.ok(lateAdd, 'a PPA-only player (no usage row) must still be stored');
  assert.equal(lateAdd.usage_overall, null);
});

test('a re-sync replaces rather than duplicates a season\'s rows', async () => {
  process.env.CFBD_API_KEY = 'test-key';
  stubFetch();
  await syncCfbdSeason(2023);
  await syncCfbdSeason(2023);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM cfbd_player_season WHERE season = 2023').get();
  assert.equal(rows.n, 3);
});

test('cfbdSignalFor returns null for a player/season never synced', () => {
  assert.equal(cfbdSignalFor('Nobody Real', 2023), null);
  assert.equal(cfbdSignalFor('Marvin Harrison Jr.', 1999), null);
});

test('cfbdSignalFor never throws on missing name/season', () => {
  assert.equal(cfbdSignalFor(null, 2023), null);
  assert.equal(cfbdSignalFor('Marvin Harrison Jr.', null), null);
});
