// PARTNER-KERNEL (RL-46-1): the fitted who-trades-with-whom tilt on Nick's partner ranking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  KERNEL_C, KERNEL_A, KERNEL_LAM, kernelWeight, kernelWeights, kernelFromTrades, completedTradesFromEspn,
  partnerKernelFlag, PARTNER_KERNEL_ENV, leagueKernel, espnTradeRows,
} from '../server/services/people/partner-kernel.js';
import { rankPartners, pResponds } from '../server/services/campaign/partners.js';
import { planLeague } from '../server/services/campaign/planner.js';
import { normaliseObjective } from '../server/services/campaign/objectives.js';
import { makeAdapter } from './fixtures/campaign-league.mjs';

const ON = { on: true, preview: false };
const OFF = { on: false, preview: false };

function withEnv(vars, fn) {
  const keep = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

test('constants are the RL-46-1 checker refit, not the withdrawn tester fit', () => {
  assert.deepEqual([KERNEL_C, KERNEL_A, KERNEL_LAM], [0.899, 0.124, 0.358]);
  // c is an additive pseudo-count: log(deg + c), per r46_IDEA-134_check.py.
  assert.equal(kernelWeight(0), 0.899);
  assert.ok(Math.abs(kernelWeight(2, 1, true) - (2 + 0.358 + 0.899) * 1.124) < 1e-12);
});

test('flag: default off, =1 on, preview turns it on labelled, =0 vetoes preview', () => {
  withEnv({ [PARTNER_KERNEL_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(partnerKernelFlag(), OFF));
  withEnv({ [PARTNER_KERNEL_ENV]: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(partnerKernelFlag(), ON));
  withEnv({ [PARTNER_KERNEL_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.deepEqual(partnerKernelFlag(), { on: true, preview: true }));
  withEnv({ [PARTNER_KERNEL_ENV]: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.deepEqual(partnerKernelFlag(), OFF));
});

test('tilt is weight over the league mean; no trades yet tilts nobody', () => {
  const flat = kernelWeights({ candidates: ['1', '2', '3'] });
  for (const k of flat.values()) assert.equal(k.tilt, 1);
  const k = kernelWeights({ candidates: ['1', '2', '3'], tradeEnds: new Map([['1', 3]]), repeat: new Set(['2']) });
  const mean = [...k.values()].reduce((s, x) => s + x.weight, 0) / 3;
  assert.ok(Math.abs(k.get('1').tilt - k.get('1').weight / mean) < 1e-12);
  assert.deepEqual(k.get('1').reasons, ['trades a lot']);
  assert.ok(k.get('2').reasons.includes('traded with you before'));
  assert.ok(k.get('3').reasons.includes('few trades so far'));
});

test('kernelFromTrades: strictly before now, last season scaled by lam, repeat only from earlier seasons with Nick', () => {
  const trades = [
    { season: 2026, at: '2026-09-10T00:00:00.000Z', teams: ['1', '2'] },
    { season: 2026, at: '2026-09-20T00:00:00.000Z', teams: ['1', '3'] }, // at now: not counted
    { season: 2025, at: '2025-10-01T00:00:00.000Z', teams: ['3', '4'] },
    { season: 2024, at: '2024-10-01T00:00:00.000Z', teams: ['5', '2'] }, // Nick (5) and 2 traded before
  ];
  const k = kernelFromTrades({ me: '5', candidates: ['1', '2', '3', '4'], trades, season: 2026, now: '2026-09-20T00:00:00.000Z' });
  assert.equal(k.get('1').trade_ends, 1);
  assert.equal(k.get('3').trade_ends, 0);
  assert.equal(k.get('3').prev_season, 1);
  assert.equal(k.get('2').repeat, true);
  assert.equal(k.get('4').repeat, false);
  assert.ok(Math.abs(k.get('3').weight - (0.358 + 0.899)) < 1e-12);
});

test('completedTradesFromEspn reads only PROCESS / EXECUTED accept rows', () => {
  const items = JSON.stringify([{ fromTeamId: 7, toTeamId: 5 }, { fromTeamId: 5, toTeamId: 7 }]);
  const rows = [
    { tx_id: 'a', season: 2026, type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED', processed_at: '2026-09-01T00:00:00Z', items_json: items },
    { tx_id: 'b', season: 2026, type: 'TRADE_ACCEPT', execution_type: 'EXECUTE', status: '', items_json: items },
    { tx_id: 'c', season: 2026, type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', status: 'PENDING', items_json: items },
  ];
  assert.deepEqual(completedTradesFromEspn(rows), [{ season: 2026, at: '2026-09-01T00:00:00Z', teams: ['7', '5'] }]);
});

// A small league: 1 and 2 neutral, 3 active, 4 unreachable, 6 not trading (non-buyer).
const managers = () => new Map([
  ['1', { receptiveness: 1 }],
  ['2', { receptiveness: 1 }],
  ['3', { receptiveness: 0.9, nick: { in_active_pool: true } }],
  ['4', { receptiveness: 1.2, nick: { unreachable: true } }],
  ['6', { receptiveness: 1, nick: { deprioritised: true } }],
]);
const edge = new Map([['1', 0.01], ['2', 0.01], ['3', 0.01], ['4', 0.05], ['6', 0.01]]);
const kernel = kernelWeights({ candidates: ['1', '2', '3', '4', '6'],
  tradeEnds: new Map([['2', 4], ['4', 6], ['6', 5]]), repeat: new Set(['2']) });

test('flag off (or no kernel): rankPartners output is unchanged', () => {
  const before = rankPartners(managers(), edge, null, { flag: OFF });
  assert.deepEqual(rankPartners(managers(), edge, null, { kernel, flag: OFF }), before);
  assert.deepEqual(rankPartners(managers(), edge, null, { flag: ON }), before);
  withEnv({ [PARTNER_KERNEL_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => assert.deepEqual(rankPartners(managers(), edge, null, { kernel }), before));
  assert.ok(before.every(p => !('partner_kernel' in p)));
});

test('flag on: order tilts, P(responds) does not change, reasons show', () => {
  const off = rankPartners(managers(), edge, null, { flag: OFF });
  const on = rankPartners(managers(), edge, null, { kernel, flag: ON });
  const byTeam = rows => new Map(rows.map(r => [r.team, r]));
  for (const [t, r] of byTeam(on)) assert.equal(r.p_responds, byTeam(off).get(t).p_responds, `team ${t} P(responds)`);
  assert.equal(off[0].team, '3'); // floored active manager led on equal edges
  assert.equal(on[0].team, '2'); // the frequent, repeat trader leads once the kernel is on
  const two = byTeam(on).get('2');
  assert.ok(two.partner_kernel.tilt > 1);
  assert.deepEqual(two.partner_kernel.reasons, ['trades a lot', 'traded with you before']);
  assert.ok(Math.abs(two.score - two.p_responds * two.partner_kernel.tilt * 0.01) < 1e-15);
});

test('overrides stay hard: unreachable is 0 and last, non-buyer never rises', () => {
  const on = rankPartners(managers(), edge, null, { kernel, flag: ON });
  const four = on.find(r => r.team === '4');
  assert.equal(four.p_responds, 0);
  assert.equal(four.score, 0);
  assert.equal(four.excluded, true);
  assert.equal(four.partner_kernel.tilt, 1);
  assert.equal(on.at(-1).team, '4');
  assert.equal(pResponds(managers().get('4')).p, 0);
  const six = on.find(r => r.team === '6');
  const sixOff = rankPartners(managers(), edge, null, { flag: OFF }).find(r => r.team === '6');
  assert.equal(six.partner_kernel.tilt, 1); // raw tilt > 1, capped
  assert.ok(!six.partner_kernel.reasons.includes('trades a lot'));
  assert.equal(six.score, sixOff.score);
  assert.equal(six.p_responds, 0.05);
});

test('preview mode labels the kernel entry', () => {
  const on = rankPartners(managers(), edge, null, { kernel, flag: { on: true, preview: true } });
  assert.equal(on[0].partner_kernel.preview, true);
  assert.match(on[0].partner_kernel.preview_reason, /descriptive/);
});

// ---- served path: the planner hands rankPartners its league; the kernel is built from the DB ----

/** A throwaway DB with only league_transactions_raw: league 99 (made up), team 3 in three completed trades. */
function tradesDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-kernel-'));
  const file = path.join(dir, 'k.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT, execution_type TEXT,
    status TEXT, team_id INTEGER, proposed_at TEXT, processed_at TEXT, related_tx_id TEXT, items_json TEXT)`);
  const ins = db.prepare('INSERT INTO league_transactions_raw VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const items = (a, b) => JSON.stringify([{ fromTeamId: a, toTeamId: b }, { fromTeamId: b, toTeamId: a }]);
  ins.run(99, 2026, 't1', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 3, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', null, items(3, 4));
  ins.run(99, 2026, 't2', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 3, '2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z', null, items(3, 4));
  ins.run(99, 2026, 't3', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 3, '2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z', null, items(3, 2));
  ins.run(99, 2026, 'p1', 'TRADE_PROPOSAL', 'EXECUTE', 'PENDING', 2, '2026-09-10T00:00:00Z', null, null, items(2, 4)); // not a completed trade
  ins.run(98, 2026, 'o1', 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED', 2, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', null, items(2, 4)); // other league
  db.close();
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NOW = Date.parse('2026-09-24T00:00:00Z');

test('leagueKernel reads the league\'s completed trades from the DB file, as of now', () => {
  const t = tradesDb();
  try {
    const rows = espnTradeRows({ leagueId: 99, season: 2026, dbPath: t.file });
    assert.deepEqual(rows.map(r => r.tx_id).sort(), ['t1', 't2', 't3']);
    const k = leagueKernel({ league: { id: 99, me: '1', season: 2026 }, candidates: ['2', '3', '4'], now: NOW,
      readRows: a => espnTradeRows({ ...a, dbPath: t.file }) });
    assert.equal(k.status, 'ok');
    assert.equal(k.trades, 3);
    assert.deepEqual(['2', '3', '4'].map(x => k.kernel.get(x).trade_ends), [1, 3, 2]);
    const early = leagueKernel({ league: { id: 99, me: '1', season: 2026 }, candidates: ['2', '3', '4'], now: Date.parse('2026-09-03T00:00:00Z'),
      readRows: a => espnTradeRows({ ...a, dbPath: t.file }) });
    assert.deepEqual(['2', '3', '4'].map(x => early.kernel.get(x).trade_ends), [0, 1, 1]); // strictly before now
    assert.equal(leagueKernel({ league: { id: 99, me: '1' }, candidates: ['2'] }).kernel, null); // no season
  } finally { t.done(); }
});

test('rankPartners builds the kernel from { league } when the flag is on; the reason shows in basis', () => {
  const t = tradesDb();
  try {
    const mgr = () => new Map([['2', { receptiveness: 1 }], ['3', { receptiveness: 1 }], ['4', { receptiveness: 1, nick: { unreachable: true } }]]);
    const e = new Map([['2', 0.01], ['3', 0.01], ['4', 0.01]]);
    const league = { id: 99, me: '1', season: 2026 };
    const readRows = a => espnTradeRows({ ...a, dbPath: t.file });
    const off = rankPartners(mgr(), e, null, { league, readRows, now: NOW, flag: OFF });
    assert.deepEqual(off, rankPartners(mgr(), e, null, { flag: OFF })); // flag off: league is ignored
    const on = rankPartners(mgr(), e, null, { league, readRows, now: NOW, flag: ON });
    assert.equal(on[0].team, '3');
    assert.ok(on[0].partner_kernel.tilt > 1);
    assert.match(on[0].basis, /partner kernel \(trades a lot\), order only/);
    assert.equal(on[0].p_responds, off.find(r => r.team === '3').p_responds);
    const four = on.find(r => r.team === '4');
    assert.equal(four.score, 0);
    assert.equal(four.basis, 'Nick: unreachable');
    // A failed read is reported on every partner, and the order is today's.
    const bad = rankPartners(mgr(), e, null, { league, now: NOW, flag: ON, readRows: () => { throw new Error('no such table'); } });
    assert.match(bad[0].partner_kernel.basis, /kernel read failed: no such table/);
    assert.deepEqual(bad.map(r => r.team), off.map(r => r.team));
  } finally { t.done(); }
});

test('served path: planLeague passes its league, so the flag changes the plan\'s partner order and basis', () => {
  const t = tradesDb();
  try {
    const run = flag => withEnv({ [PARTNER_KERNEL_ENV]: flag, GRIDIRON_PREVIEW_UNCONFIRMED: null, GRIDIRON_DB_PATH: t.file }, () => {
      const a = makeAdapter();
      a.league = { ...a.league, season: 2026 };
      return planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) }).partners;
    });
    const off = run('0'), on = run('1');
    assert.ok(off.every(p => !('partner_kernel' in p)));
    const three = on.find(p => p.team === '3');
    assert.ok(three.partner_kernel.tilt > 1, 'team 3 (three trades) is tilted up in the served plan');
    assert.equal(three.partner_kernel.trade_ends, 3);
    assert.match(three.basis, /partner kernel/);
    for (const p of on) assert.equal(p.p_responds, off.find(x => x.team === p.team).p_responds, `team ${p.team} P(responds)`);
  } finally { t.done(); }
});
