/**
 * BROKEN-H: Trade Brain under preview showed two "checked out" signals at once, the
 * LIVING-01a producer's activity.manager (P(checked out)) and counterparty-pricing.js's
 * checkedOutFactor (last week's dead starts). activity.manager declares
 * `replaces: counterparty-pricing.js#checkedOutFactor`; these tests hold it to that.
 *
 * Ratchet: whenever an activity.manager row is visible (flag / preview, or a live row),
 * the receptiveness factors carry exactly one checked_out entry and it is the engine's;
 * the legacy function has one call site and it sits behind the replacement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-broken-h-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
delete process.env.GRIDIRON_LIVING01A_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_RECEPTIVENESS_ACTIVITY;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const activity = await import('../server/services/engine/activity-model.js');
const { appendEvents } = await import('../server/services/engine/events.js');
const pricing = await import('../server/services/counterparty-pricing.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L = 91;
const CUT = '2026-09-22T12:00:00Z';
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (${L}, 'espn', 'bh-91', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-18 01:00:00')`);
const tx = (key, asOf, period, team) => ({ event_type: 'espn.transaction', as_of: asOf, league_id: L, team_id: String(team),
  source: 'fixture-broken-h', natural_key: key,
  payload: { season: 2026, type: 'FREEAGENT', status: 'EXECUTED', scoring_period: period, items: [{ type: 'ADD', to_team_id: team }] } });
const sig = (key, asOf, team, period, value) => ({ event_type: 'manager.signal', as_of: asOf, league_id: L, team_id: String(team),
  source: 'fixture-broken-h', natural_key: key,
  payload: { signal_source: 'roster', metric: 'lineup_dead_starts_last_week', value, n: 9, scoring_period: period } });
const coverage = [];
for (let t = Date.parse('2026-09-07T12:00:00Z'); t <= Date.parse(CUT); t += 86400000) {
  const at = new Date(t).toISOString();
  coverage.push({ event_type: 'source.coverage', as_of: at, source: 'fixture-broken-h-cov', natural_key: 'league_transactions',
    entities: [{ type: 'source', id: 'league_transactions', role: 'subject' }],
    payload: { job: 'league_transactions', last_run_at: at, status: 'ok', consecutive_failures: 0 } });
}
// Team 1 busy with full lineups; team 2 no adds and dead starts both weeks. Team 3 has
// dead starts in manager_signals but no activity.manager row (the producer never saw it).
appendEvents([
  tx('a1', '2026-09-09T12:00:00Z', 1, 1), tx('a2', '2026-09-10T12:00:00Z', 1, 1),
  tx('a3', '2026-09-16T12:00:00Z', 2, 1), tx('a4', '2026-09-17T12:00:00Z', 2, 1),
  sig('s1-p2', '2026-09-15T10:00:00Z', 1, 2, 0), sig('s2-p2', '2026-09-15T10:00:00Z', 2, 2, 2),
  sig('s1-p3', '2026-09-22T10:00:00Z', 1, 3, 0), sig('s2-p3', '2026-09-22T10:00:00Z', 2, 3, 2),
  ...coverage,
]);
await activity.produceActivityStates({ leagueId: L, season: 2026, through: 2, asOf: CUT, weeksLeft: 12 });
// What counterpartyLayer reads today: every roster had a dead start last week, so the
// legacy factor fires on all three.
for (const team of ['1', '2', '3']) {
  run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
       VALUES (?, ?, 'lineup_dead_starts_last_week', 1, 9, 'roster', '2026-09-22 10:00:00')`, L, team);
}

const withEnv = (env, fn) => {
  const keys = Object.keys(env);
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of keys) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};
const checkedOutEntries = (layer, team) =>
  layer.get(team).receptiveness_factors.filter(f => f.source === 'checked_out');
const LEGACY_LABEL = 'Checked out (left a starter in who did not play)';

test('control: with preview and the LIVING-01a flag off, the legacy term is unchanged and activity.manager is not read', () => {
  const layer = withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: null, GRIDIRON_LIVING01A_ENABLED: null },
    () => pricing.counterpartyLayer(L, { season: 2026, week: 3 }));
  for (const team of ['1', '2', '3']) {
    const got = checkedOutEntries(layer, team);
    assert.equal(got.length, 1);
    assert.equal(got[0].label, LEGACY_LABEL, `team ${team}: the old factor still owns the term off-preview`);
    assert.equal(got[0].engine, undefined);
    assert.equal(got[0].effect, null, 'still default-off: reported, not applied');
    assert.ok(got[0].would_effect < 0);
  }
});

test('RED: under preview there is ONE checked-out signal per manager, and it is activity.manager', () => {
  const layer = withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => pricing.counterpartyLayer(L, { season: 2026, week: 3 }));
  const perUnit = (pricing.ACTIVITY_FIT.dead_start / pricing.ACTIVITY_FIT.base) / (pricing.RECEPTIVENESS_RANGE[1] - pricing.RECEPTIVENESS_RANGE[0]);
  const p = {};
  for (const team of ['1', '2']) {
    const got = checkedOutEntries(layer, team);
    assert.equal(got.length, 1, `team ${team}: two checked-out signals at once`);
    assert.notEqual(got[0].label, LEGACY_LABEL, `team ${team}: the legacy factor was served beside/instead of activity.manager`);
    assert.equal(got[0].engine.field, 'activity.manager');
    assert.equal(got[0].engine.lane, 'shadow');
    assert.equal(got[0].preview, true, 'on only through preview: labelled');
    const row = db.prepare(`SELECT value FROM engine_state WHERE id = ?`).get(got[0].engine.row_id);
    p[team] = JSON.parse(row.value).probs[2];
    assert.equal(got[0].effect, +(p[team] * perUnit).toFixed(4), 'effect is P(checked out) x the dead-start coefficient');
  }
  assert.ok(p['2'] > p['1'], `the quiet dead-start team (${p['2']}) should read more checked out than the busy one (${p['1']})`);
  assert.ok(checkedOutEntries(layer, '2')[0].effect < checkedOutEntries(layer, '1')[0].effect);
  // No activity.manager row: withheld with the reason, never refilled from the legacy factor.
  const three = checkedOutEntries(layer, '3');
  assert.equal(three.length, 1);
  assert.equal(three[0].effect, null);
  assert.match(three[0].why, /no activity\.manager row/);
  assert.equal(three[0].engine.row_id, null);
});

test('the LIVING-01a flag alone hands the term over the same way (one rule for "shown")', async () => {
  const signal = await import('../server/services/checked-out-signal.js');
  const got = withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: null, GRIDIRON_LIVING01A_ENABLED: '1' },
    () => signal.activityCheckedOut(L, '2', { perUnit: -1 }));
  assert.equal(got.replaced, true);
  assert.equal(got.factor.engine.field, 'activity.manager');
  const off = withEnv({ GRIDIRON_PREVIEW_UNCONFIRMED: null, GRIDIRON_LIVING01A_ENABLED: null },
    () => signal.activityCheckedOut(L, '2', { perUnit: -1 }));
  assert.deepEqual(off, { replaced: false, factor: null }, 'no live row and nothing shown: the legacy term keeps it');
});

test('ratchet: checkedOutFactor has one production call site, behind the activity.manager replacement', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(m?js|tsx?)$/.test(e.name)) files.push(p);
  } };
  walk(path.join(root, 'server'));
  walk(path.join(root, 'client', 'src'));
  const calls = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n')
    .map((line, i) => ({ f: path.relative(root, f), i: i + 1, line }))
    .filter(x => /checkedOutFactor\(/.test(x.line) && !/function checkedOutFactor\(/.test(x.line)));
  // The count may only go down: 0 once activity.manager is promoted and the legacy factor is deleted.
  assert.ok(calls.length <= 1, `new call sites of the replaced function: ${calls.map(c => `${c.f}:${c.i}`).join(', ')}`);
  for (const c of calls) {
    assert.equal(c.f, path.join('server', 'services', 'counterparty-pricing.js'));
    assert.match(c.line, /a\.replaced \? a\.factor : checkedOutFactor\(/,
      'the only call must sit behind activityCheckedOut, so a visible activity.manager makes it unreachable');
  }
  // The producer still declares what it replaces; if that declaration goes, this unit's premise is gone.
  const src = fs.readFileSync(path.join(root, 'server/services/engine/activity-model.js'), 'utf8');
  assert.match(src, /replaces: \['counterparty-pricing\.js#checkedOutFactor'\]/);
});
