/**
 * PYES-ONE metric 3 on the REAL War Room adapter (scripts/campaign/league-adapter.mjs priceStep),
 * and the trade finder's call site and cache key (trade-engine.js), on the made-up
 * producer-speed league (test/fixtures/producer-speed-league.mjs). No real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pyes-one-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
const { db, svc, buildAdapter, leagueId } = await setupLeague({ teams: 6, perTeam: 12, regularWeeks: 9, currentWeek: 5, playoffTeams: 4 });
const { PYES_ENV, PYES_BASIS, pYesTable } = await import('../server/services/p-yes.js');

test.after(() => { delete process.env[PYES_ENV]; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 1);
const lg = () => svc.db.row('SELECT * FROM leagues WHERE id = ?', leagueId);
const partners = ['2', '3', '4', '5', '6'];
const pkg = team => {
  const a = buildAdapter({ now: NOW });
  return [a, a.rosters.get(team).slice(0, 1), a.rosters.get('1').slice(0, 1)];
};

test('flag off: the War Room adapter serves the clone band', () => {
  delete process.env[PYES_ENV];
  for (const t of partners) {
    const [a, theyGive, theyGet] = pkg(t);
    const s = a.priceStep(t, theyGive, theyGet);
    assert.notEqual(s.basis, PYES_BASIS);
    assert.ok(s.band, 'the clone carries a band');
    assert.deepEqual(Object.keys(s).sort(), ['band', 'basis', 'p'], 'the step shape is exactly as before');
  }
});

test('flag on: the War Room adapter serves the E1 baseline table, row by row', () => {
  process.env[PYES_ENV] = '1';
  try {
    const table = pYesTable(db, leagueId, partners, { now: NOW });
    for (const t of partners) {
      const [a, theyGive, theyGet] = pkg(t);
      const s = a.priceStep(t, theyGive, theyGet);
      assert.equal(s.basis, PYES_BASIS);
      assert.equal(s.band, null);
      assert.ok(Math.abs(s.p - table.byTeam.get(t).p) < 1e-12, `War Room, team ${t}`);
    }
  } finally {
    delete process.env[PYES_ENV];
  }
});

test('trade finder: the flag is part of the cache fingerprint, so flipping it re-prices', () => {
  const { tradeIdeasFingerprint } = svc.engine;
  delete process.env[PYES_ENV];
  const off = tradeIdeasFingerprint(lg(), { myTeamId: '1' });
  process.env[PYES_ENV] = '1';
  try {
    assert.notEqual(tradeIdeasFingerprint(lg(), { myTeamId: '1' }), off);
  } finally {
    delete process.env[PYES_ENV];
  }
});

test('trade finder: its one acceptance assignment goes through pYesFor with the partner and the table', () => {
  // This fixture league yields no finder deals (no market values), so the call site is pinned here;
  // the served-row check for this caller is in "Needs local measurement" on the PR.
  const src = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  const sites = src.match(/d\.acceptance = [^;]+;/g) ?? [];
  assert.equal(sites.length, 1);
  assert.match(sites[0], /^d\.acceptance = pYesFor\(\{[^]*team: d\.partner_id, table: pyTable, on: py\.on \}\);$/);
  assert.match(src, /const pyTable = py\.on \? pYesTable\(db, lg\.id\) : null;/);
});
