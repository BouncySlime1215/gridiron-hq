/**
 * FC-VALUE (integration-8, coordinator decision on #410): Nick's overpay rule, the +12% depth-only 2-for-1
 * exception and the value edge read FantasyCalc value (player_metrics source 'fc_value') through ONE
 * reader (server/services/fc-value.js). A player with no fc_value is never given, got or flipped (fail
 * closed), counted under _run.dropped_by_reason.no_fc_value. Made-up leagues only.
 *
 * The fuzz property computes the overpay from its OWN FantasyCalc table, independently of the planner,
 * over every served surface (RULE-FUZZ's offersOf: best, every deck card and its playbooks, the second
 * package, backups, every risk mode's pick, catch-up, flip legs, ladder rungs and on_no), in every mode,
 * with every Batch B flag on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fc-value-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { fcValues, fcValueOf, FC_VALUE_LABEL } = await import('../server/services/fc-value.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { makeFuzzLeague, rng, NICO_COLLINS, CHASE_BROWN, AJ_BROWN, BLUE_CHIP } = await import('./fixtures/rule-fuzz-league.mjs');
const { offersOf } = await import('./fixtures/nick-rules.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const S = x => String(x);

/* ------------------------------------------------------------ the reader */

const fakeDb = rowsOf => ({ rows: (sql, ...args) => (/sqlite_master/.test(sql) ? [{ name: 'player_metrics' }] : rowsOf(sql, args)) });

test('reader: fc_value rows only, by id; a missing player is null, never another number', () => {
  const fc = fcValues(fakeDb((sql, [src]) => (src === 'fc_value'
    ? [{ player_id: 1, value: 5000, fetched_at: '2026-09-24 08:57:05' }, { player_id: 2, value: 120, fetched_at: '2026-09-24 08:57:05' }] : [])));
  assert.equal(fc.status, 'ok');
  assert.equal(fcValueOf(fc, 1), 5000);
  assert.equal(fcValueOf(fc, '2'), 120);
  assert.equal(fcValueOf(fc, 3), null);
  assert.equal(fc.source, FC_VALUE_LABEL);
});

test('reader: no rows, no table or a failed read -> nothing priced, with the reason (fail closed)', () => {
  assert.equal(fcValues(fakeDb(() => [])).status, 'empty');
  assert.equal(fcValues({ rows: () => [] }).status, 'table_absent');
  const e = fcValues({ rows: () => { throw new Error('disk I/O error'); } });
  assert.equal(e.status, 'error');
  assert.match(e.reason, /disk I\/O/);
  assert.equal(fcValueOf(e, 1), null);
});

/* ------------------------------------------------------------ the real adapter */

test('real adapter: player value IS the fc_value row; a player without one is null and counted', async () => {
  const { setupLeague } = await import('./fixtures/producer-speed-league.mjs');
  const { db, buildAdapter } = await setupLeague({ teams: 4, perTeam: 8, regularWeeks: 6, currentWeek: 3, playoffTeams: 2 });
  try {
    const before = buildAdapter({ env: {} });
    const ids = [...before.players.keys()];
    const missing = ids[3];
    db.exec('PRAGMA foreign_keys = OFF'); // the fixture mocks the asset universe; its players rows are not seeded
    const ins = db.prepare(`INSERT OR REPLACE INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`);
    ids.forEach((id, i) => { if (id !== missing) ins.run(id, 1000 + 37 * i); });
    db.prepare(`DELETE FROM player_metrics WHERE player_id = ? AND source = 'fc_value'`).run(missing);
    const a = buildAdapter({ env: {} });
    ids.forEach((id, i) => assert.equal(a.players.get(id).value, id === missing ? null : 1000 + 37 * i, `player ${id}`));
    assert.equal(a.valueSource.status, 'ok');
    assert.deepEqual(a.valueSource.unpriced, [String(missing)]);
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), env: {} });
    assert.equal(res.no_fc_value.players, 1);
    const entry = toEntry(res, { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
    assert.equal(entry._run.dropped_by_reason.no_fc_value, 1);
    assert.equal(entry._run.inputs.value_source.source, FC_VALUE_LABEL);
  } finally { db.close(); }
});

/* ------------------------------------------------------------ the fuzz property */

/** A fuzz league re-priced through the one reader on its own FantasyCalc table (some players missing). */
function fcLeague(seed) {
  const a = makeFuzzLeague(seed);
  const r = rng(seed * 7919 + 1);
  const table = new Map();
  for (const [id, p] of a.players) {
    // The pinned players keep a price, so the never-give tests still see them; ~6% of the rest have none.
    if (![NICO_COLLINS, CHASE_BROWN, AJ_BROWN].includes(id) && r() < 0.06) continue;
    table.set(S(id), Math.round(p.value * (0.85 + 0.3 * r())));
  }
  const fc = fcValues(fakeDb(() => [...table].map(([player_id, value]) => ({ player_id, value, fetched_at: 'x' }))));
  for (const [id, p] of a.players) a.players.set(id, { ...p, market_value: p.value, value: fcValueOf(fc, id) });
  a.valueSource = { status: fc.status, source: fc.source, unpriced: [...a.players.keys()].filter(id => fcValueOf(fc, id) == null).map(S) };
  return { a, table };
}
const ENV = Object.freeze({ GRIDIRON_RISK_RULE: '1', GRIDIRON_LADDER: '1', GRIDIRON_NEGOTIATOR_DEFAULTS: '1', GRIDIRON_GETS_FLOOR: '1' });

test('fuzz: every served surface, every mode: no overpay by FantasyCalc and no unpriced player', () => {
  let offers = 0, unpricedLeagues = 0;
  const surfaces = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    for (const mode of ['safe', 'balanced', 'all_in']) {
      const { a, table } = fcLeague(seed);
      if (a.valueSource.unpriced.length) unpricedLeagues++;
      const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env: ENV });
      assert.equal(res.error, undefined);
      const fc = id => table.get(S(id));
      const blue = id => Number(a.scoreOf(id)?.score) >= BLUE_CHIP;
      for (const o of offersOf(res).offers) {
        offers++;
        surfaces.add(o.surface.replace(/\[\d+\]/g, '[]').replace(/^flip \d+/, 'flip'));
        const ids = [...o.give, ...o.get].map(S);
        const none = ids.filter(id => fc(id) == null);
        assert.deepEqual(none, [], `seed ${seed} ${mode} ${o.surface}: serves players with no FantasyCalc value`);
        const gv = o.give.reduce((s, id) => s + fc(id), 0), tv = o.get.reduce((s, id) => s + fc(id), 0);
        if (gv <= tv * (1 + 1e-9)) continue;
        const pct = gv / tv - 1;
        const c = o.step?.depth_premium?.confirmed;
        const ok = o.give.length === 2 && o.get.length === 1 && !o.give.some(id => blue(id) || [NICO_COLLINS, CHASE_BROWN, AJ_BROWN].map(S).includes(S(id)))
          && pct <= 0.12 + 1e-9 && c && Number(c.points_delta) > 0 && Number(c.title_delta) > 0;
        assert.ok(ok, `seed ${seed} ${mode} ${o.surface}: ${o.give.join('+')} for ${o.get.join('+')} overpays +${(pct * 100).toFixed(1)}% by FantasyCalc`);
      }
    }
  }
  assert.ok(unpricedLeagues > 30, `non-vacuous: ${unpricedLeagues} runs had unpriced players`);
  assert.ok(offers > 1000, `non-vacuous: ${offers} offers`);
  for (const s of ['best.step[]', 'backup[]', 'risk_modes.balanced']) assert.ok(surfaces.has(s), `surface ${s} was served: ${[...surfaces].slice(0, 40)}`);
  assert.ok([...surfaces].some(s => s.includes('alt_package')), 'second packages served');
  assert.ok([...surfaces].some(s => s.startsWith('ladders')), 'ladder rungs served');
});
