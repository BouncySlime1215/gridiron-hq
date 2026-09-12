/**
 * Giant Plan 8.14: nfl-advanced.js's syncInjuries UPSERTs `nfl_injuries` in
 * place, so a corrected Friday designation leaves no trace of what
 * Wednesday's report actually said. This wires it to nfl-bitemporal.js
 * instead: every player-week whose report/practice status or injury type
 * actually changes also gets appended as a revision in
 * `nfl_feature_revisions`, so nfl-t60-packet.js's as-of read (see
 * test/nfl-t60-packet.test.js) can answer "what did this system know by a
 * given cutoff" instead of only "what does the report say right now."
 * `nfl_injuries` keeps being written -- it is still the correct place to ask
 * what the report currently says -- it is just no longer the evidence.
 *
 * These tests mock fetch entirely. syncInjuries pulls a real nflverse CSV
 * over the network, and the test suite runs under test/offline-guard.mjs,
 * which throws on any request to a non-local host. There is no local fixture
 * server to point this at -- the URL is a fixed nflverse release asset -- so
 * the network boundary itself is what gets faked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-injuries-bitemporal-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const realFetch = globalThis.fetch;
let nextCsv = '';
globalThis.fetch = async url => {
  if (!String(url).includes('injuries_')) return realFetch(url);
  return { ok: true, body: new Response(nextCsv).body };
};

const { db, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { syncInjuries } = await import('../server/services/nfl-advanced.js');

test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const HEADER = 'season,week,gsis_id,team,full_name,position,report_status,practice_status,'
  + 'report_primary_injury,practice_primary_injury,date_modified,game_type\n';
const injuryRow = (overrides = {}) => {
  const r = { season: 2026, week: 1, gsis_id: '00-0000000', team: 'ATL', full_name: 'Test Player',
    position: 'WR', report_status: 'Questionable', practice_status: 'Full', report_primary_injury: 'Ankle',
    practice_primary_injury: 'Ankle', date_modified: '2026-09-09T18:00:00', game_type: 'REG', ...overrides };
  return [r.season, r.week, r.gsis_id, r.team, r.full_name, r.position, r.report_status, r.practice_status,
    r.report_primary_injury, r.practice_primary_injury, r.date_modified, r.game_type].join(',');
};
const csv = (...lines) => HEADER + lines.join('\n') + '\n';

const revisionsFor = gsisId => rows(`SELECT published_at, observed_at, provenance, value_json
  FROM nfl_feature_revisions WHERE entity LIKE ? ORDER BY published_at`, `player:${gsisId}:%`);

test('a genuinely changed report appends a revision without losing what the earlier report said', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0012345', report_status: 'Questionable', practice_status: 'Full' }));
  const first = await syncInjuries([2026]);
  assert.equal(first.revisions_recorded, 1);

  nextCsv = csv(injuryRow({ gsis_id: '00-0012345', report_status: 'Out', practice_status: 'Did Not Participate',
    date_modified: '2026-09-11T21:58:00' }));
  const second = await syncInjuries([2026]);
  assert.equal(second.revisions_recorded, 1, 'the changed report appended, it did not merely overwrite');

  const revisions = revisionsFor('00-0012345');
  assert.equal(revisions.length, 2, 'both reports survive');
  assert.equal(JSON.parse(revisions[0].value_json).report_status, 'Questionable',
    'the EARLIER report is still there -- this is exactly what the in-place UPSERT used to destroy');
  assert.equal(JSON.parse(revisions[1].value_json).report_status, 'Out');

  assert.deepEqual(
    { ...rows(`SELECT report_status, practice_status FROM nfl_injuries WHERE gsis_id=?`, '00-0012345')[0] },
    { report_status: 'Out', practice_status: 'Did Not Participate' },
    'nfl_injuries stays the mutable latest view -- it is no longer the evidence, but it is still written');
});

test('re-syncing an unchanged report is not a second observation', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0099999', report_status: 'Questionable' }));
  await syncInjuries([2026]);
  const before = revisionsFor('00-0099999').length;

  const second = await syncInjuries([2026]); // identical CSV, a different wall-clock instant
  assert.equal(second.revisions_recorded, 0,
    're-reading an unchanged feed must not look like the source said it again');
  assert.equal(revisionsFor('00-0099999').length, before);
});

test('a brand-new player-week is a revision too, not only a subsequent change', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0055555' }));
  const result = await syncInjuries([2026]);
  assert.equal(result.revisions_recorded, 1);
  assert.equal(revisionsFor('00-0055555').length, 1);
});

test('a source row with no date_modified is recorded as reconstructed, never as an unearned live capture', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0077777', date_modified: '' }));
  await syncInjuries([2026]);
  const [revision] = revisionsFor('00-0077777');
  assert.equal(revision.provenance, 'reconstructed',
    'no source-claimed modified date means no defensible claim this was received live');
  assert.equal(revision.published_at, revision.observed_at,
    'this machine\'s own capture instant is the only honest lower bound available');
});

test('a source-claimed modified date within the live window is captured; a stale one is reconstructed', async () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const stale = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);

  nextCsv = csv(injuryRow({ gsis_id: '00-0011111', date_modified: recent }));
  await syncInjuries([2026]);
  assert.equal(revisionsFor('00-0011111')[0].provenance, 'captured');

  nextCsv = csv(injuryRow({ gsis_id: '00-0022222', date_modified: stale }));
  await syncInjuries([2026]);
  assert.equal(revisionsFor('00-0022222')[0].provenance, 'reconstructed',
    'a report the source says it modified 40 days before we observed it was not received live');
});

test('one bad row does not abort the whole season\'s revision recording or the mutable sync', async () => {
  nextCsv = csv(
    injuryRow({ gsis_id: '00-0033333', date_modified: '2099-01-01T00:00:00' }), // "published" in the future: refused
    injuryRow({ gsis_id: '00-0044444', date_modified: '2026-09-09T18:00:00' })  // an ordinary row alongside it
  );
  const result = await syncInjuries([2026]);
  assert.equal(result.revision_failures.length, 1);
  assert.equal(result.revision_failures[0].gsis_id, '00-0033333');
  assert.match(result.revision_failures[0].error, /precedes/);
  // The mutable table still got BOTH rows -- one row's revision failure must
  // never silently drop it from nfl_injuries.
  assert.equal(
    rows(`SELECT COUNT(*) n FROM nfl_injuries WHERE gsis_id IN ('00-0033333','00-0044444')`)[0].n, 2);
  // And the other row's revision still recorded normally.
  assert.equal(revisionsFor('00-0044444').length, 1);
});
