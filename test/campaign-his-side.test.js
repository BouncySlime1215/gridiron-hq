/**
 * HIS-SIDE-WIRE (ONE-PLAN night 3): every War Room target says what its owner needs, shops and
 * blocks, each with its n, from the reads the producer already holds (counterparty needs, the
 * ONE-COUNTERPART chat model with credibility, the ESPN trade block, TRADE-MEMORY's ledger).
 * GRIDIRON_HIS_SIDE=1 serves `targets[].his_side`; off, only the counts go to `_run.inputs.his_side`.
 *
 * PUBLIC REPO: made-up league (test/fixtures/campaign-league.mjs), synthetic players 'P1'..'P35'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-his-side-'));
process.env.GRIDIRON_DB_PATH ??= path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { buildCounterparts } = await import('../server/services/people/counterpart.js');
const { hisSide, hisSideOn, tradeBlockRead, HIS_SIDE_FLAG } = await import('../server/services/campaign/his-side.js');
const { tradeBlocks } = await import('../server/services/espn-trade-block.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const AT = Date.parse('2026-09-24T05:00:00.000Z');
const nm = id => `P${id}`;
const tl = id => `Team ${id}`;

/** TRADE-MEMORY's summary shape (trade-memory.js#memorySummary, PR #379): ids and numbers only. */
const MEMORY = {
  status: 'on', trades: 1,
  floors: [{ key: '3:21', floor: 5705, basis: 'value_at_trade' }],
  currency: { 3: { wants: ['WR'], sells: ['RB'] } },
};
const MODEL = {
  team: '3', status: 'ok', wants: [{ player: '2', n: 4, lift: 1 }], untouchable: ['22'], shopping: ['25'],
  credibility: { untouchable: { value: 0.75, n: 2, kept: 1, broken: 0, open: 0 }, shop: { value: 0.5, n: 0, kept: 0, broken: 0, open: 1 } },
};

test('flag: on only for GRIDIRON_HIS_SIDE=1 (preview does not switch it on)', () => {
  assert.equal(HIS_SIDE_FLAG, 'GRIDIRON_HIS_SIDE');
  assert.equal(hisSideOn({}), false);
  assert.equal(hisSideOn({ GRIDIRON_HIS_SIDE: '0' }), false);
  assert.equal(hisSideOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(hisSideOn({ GRIDIRON_HIS_SIDE: '1' }), true);
});

test('ESPN trade block: payload -> planner ids, ON_THE_BLOCK only, unmapped counted not guessed', () => {
  const payload = { teams: [
    { id: 3, tradeBlock: { players: { 9025: 'ON_THE_BLOCK', 9022: 'UNTOUCHABLE', 9999: 'ON_THE_BLOCK' } } },
    { id: 4 },
  ] };
  const blocks = tradeBlocks(JSON.stringify(payload));
  assert.equal(blocks.error, null);
  assert.equal(blocks.blocks.get('3').get(9025), 'ON_THE_BLOCK');
  const read = tradeBlockRead(blocks, e => ({ 9025: 25, 9022: 22 })[e] ?? null);
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.by_team, { 3: ['25'], 4: [] });
  assert.equal(read.unmapped, 1);
  const bad = tradeBlockRead(tradeBlocks('{not json'), () => null);
  assert.equal(bad.status, 'unknown');
  assert.match(bad.reason, /not JSON/);
});

test('his side: needs, chat model with credibility n, ESPN block and the ledger floor in one read', () => {
  const hs = hisSide({ player: '21', owner: '3', partner: { team: '3', needs: ['RB', 'TE'] }, model: MODEL,
    block: { status: 'ok', by_team: { 3: ['25', '21'] } }, memory: MEMORY, inNames: () => true, nm, tl });
  assert.equal(hs.status, 'ok');
  assert.deepEqual(hs.value.reads, { needs: 'ok', chat: 'ok', espn_block: 'ok', ledger: 'ok' });
  assert.deepEqual(hs.value.needs, ['RB', 'TE']);
  assert.deepEqual(hs.value.shops, { players: ['25'], n: 1, source: 'chat' });
  assert.deepEqual(hs.value.espn_block, { players: ['25', '21'], n: 2 });
  assert.deepEqual(hs.value.protects, { players: ['22'], n: 1, credibility: { value: 0.75, n: 2 } });
  assert.deepEqual(hs.value.wants, ['2']);
  assert.equal(hs.value.target_on_block, true);
  assert.equal(hs.value.target_protected, false);
  assert.deepEqual(hs.value.floor, { value: 5705, basis: 'value_at_trade' });
  assert.deepEqual(hs.value.currency, { wants: ['WR'], sells: ['RB'] });
  const t = hs.value.text;
  assert.match(t, /Team 3's roster read lists RB, TE as thin\./);
  assert.match(t, /P21 is on his ESPN trade block\./);
  assert.match(t, /He paid 5,705 for P21 this season, so he sells only above that\./);
  assert.match(t, /His trades this season took in WR and sent out RB\./);
  assert.match(t, /In chat he is shopping P25 and calls P22 untouchable \(kept 1 of 2 such claims\)\./);
});

test('his side: a target the owner calls untouchable says so; no ledger says "no trade ledger"', () => {
  const hs = hisSide({ player: '22', owner: '3', partner: { team: '3', needs: [] }, model: MODEL,
    block: null, memory: null, inNames: () => true, nm, tl });
  assert.equal(hs.status, 'ok');
  assert.equal(hs.value.target_protected, true);
  assert.deepEqual(hs.value.reads, { needs: 'none', chat: 'ok', espn_block: 'unread', ledger: 'unread' });
  assert.equal(hs.value.floor, undefined);
  assert.match(hs.value.text, /He calls P22 untouchable in chat \(kept 1 of 2 such claims\)\./);
  assert.match(hs.value.text, /No trade ledger read this run\./);
});

test('his side: nothing read about the owner is unknown with the reason, never an empty ok', () => {
  const hs = hisSide({ player: '11', owner: '2', partner: { team: '2', needs: [] }, model: { team: '2', status: 'unknown', wants: [], untouchable: [], shopping: [], credibility: {} },
    block: null, memory: null, inNames: () => true, nm, tl });
  assert.equal(hs.status, 'unknown');
  assert.match(hs.reason, /Nothing is read about Team 2/);
  assert.deepEqual(hs.reads, { needs: 'none', chat: 'unknown', espn_block: 'unread', ledger: 'unread' });
});

test('his side: ids outside the entry names are left out (the contract pid rule)', () => {
  const hs = hisSide({ player: '21', owner: '3', partner: { team: '3', needs: ['RB'] }, model: MODEL,
    block: { status: 'ok', by_team: { 3: ['999'] } }, memory: null, inNames: id => id !== '999' && id !== '25', nm, tl });
  assert.deepEqual(hs.value.espn_block, { players: [], n: 0 });
  assert.equal(hs.value.shops, undefined);
});

/** League 1 of the contract fixture's shape: a chat counterpart model on team 3, an ESPN block on team 3. */
function league({ block = true } = {}) {
  const a = makeAdapter();
  const profile = { values_talk: { wants: [{ player: 'P2', at: AT, n: 4 }], untouchable: [{ player: 'P22', at: AT, n: 2 }],
    shopping: [{ player: 'P25', at: AT, n: 3 }], talks_up: [], talks_down: [] } };
  a.counterparts = buildCounterparts({ profiles: new Map([['3', { status: 'ok', profile, built_at: '2026-09-24T05:00:00.000Z', nick: null }]]),
    players: a.players, now: AT, teams: [...a.managers.keys()] });
  if (block) a.tradeBlock = { status: 'ok', by_team: { 2: [], 3: ['25'], 4: ['35'] }, unmapped: 0 };
  return a;
}
const planOf = a => planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
const entryOf = (a, opts = {}) => {
  const res = planOf(a);
  return toEntry(res, { names: a.names(), as_of: '2026-09-24T06:00:00.000Z', ...opts });
};

test('shadow summary: the ESPN block status and unmapped count are written out, unread and failed alike', () => {
  const a = league();
  a.tradeBlock = { status: 'ok', by_team: { 3: [] }, unmapped: 4 };
  assert.deepEqual(entryOf(a)._run.inputs.his_side.espn_block, { status: 'ok', unmapped: 4 });
  a.tradeBlock = { status: 'unknown', reason: 'stored league payload is not JSON: x' };
  assert.deepEqual(entryOf(a)._run.inputs.his_side.espn_block, { status: 'unknown', reason: 'stored league payload is not JSON: x' });
  delete a.tradeBlock;
  assert.deepEqual(entryOf(a)._run.inputs.his_side.espn_block, { status: 'unread' });
});

test('planner: the adapter trade block rides on the result', () => {
  assert.deepEqual(planOf(league()).trade_block, { status: 'ok', by_team: { 2: [], 3: ['25'], 4: ['35'] }, unmapped: 0 });
  assert.equal(planOf(league({ block: false })).trade_block, null);
});

test('flag off: no target carries his_side, the reasoning text is unchanged, the counts go to _run.inputs', () => {
  const a = league();
  const off = entryOf(a);
  assert.equal(off.targets.status, 'ok');
  assert.ok(off.targets.value.length >= 1);
  for (const t of off.targets.value) {
    assert.equal(t.his_side, undefined);
    assert.match(t.reasoning.value.his_side, /roster read lists|There is no read/);
  }
  const s = off._run.inputs.his_side;
  assert.equal(s.flag, 'shadow');
  assert.equal(s.of, off.targets.value.length);
  assert.equal(s.ok, s.targets.filter(x => x.status === 'ok').length);
  assert.deepEqual(Object.keys(s.targets[0]).sort(), ['owner', 'player', 'reads', 'status']);
  // A broken ESPN id map must not read as an empty block: the unmapped count is written out.
  assert.deepEqual(s.espn_block, { status: 'ok', unmapped: 0 });
  assert.deepEqual(validateLeague(off).errors, []);
});

test('flag off: the entry is identical to one built without the unit, except _run.inputs.his_side', () => {
  const a = league();
  const off = entryOf(a);
  const on = entryOf(a, { his_side_on: true });
  const strip = e => { const c = structuredClone(e); delete c._run.inputs.his_side; return c; };
  const base = strip(off);
  assert.equal(JSON.stringify(base).includes('"his_side":{"status"'), false);
  // the only served differences with the flag on are inside targets
  const onNoTargets = strip(on); delete onNoTargets.targets;
  const offNoTargets = structuredClone(base); delete offNoTargets.targets;
  assert.deepEqual(onNoTargets, offNoTargets);
});

test('flag on: every target serves his_side ok (contract-valid) and the reasoning slot reads it', () => {
  const a = league();
  const on = entryOf(a, { his_side_on: true });
  assert.deepEqual(validateLeague(on).errors, []);
  const ts = on.targets.value;
  assert.ok(ts.length >= 1);
  for (const t of ts) {
    assert.equal(t.his_side.status, 'ok', `target ${t.player}`);
    assert.equal(t.his_side.source, 'plan.template');
    assert.equal(t.reasoning.value.his_side, t.his_side.value.text);
  }
  const fromThree = ts.find(t => t.owner === '3');
  if (fromThree) {
    assert.equal(fromThree.his_side.value.reads.chat, 'ok');
    assert.deepEqual(fromThree.his_side.value.espn_block, { players: ['25'], n: 1 });
  }
  assert.equal(on._run.inputs.his_side.flag, 'on');
  assert.equal(on._run.inputs.his_side.ok, ts.length);
});

test('producer: GRIDIRON_HIS_SIDE=1 in the run env serves the field; unset leaves it shadow', async () => {
  const run = env => buildPlansFile([{ id: 1, load: async () => ({ adapter: league() }) }],
    { generated_at: '2026-09-24T06:00:00.000Z', clock: () => 0, env });
  const off = (await run({})).leagues[0];
  const on = (await run({ GRIDIRON_HIS_SIDE: '1' })).leagues[0];
  assert.equal(off._run.inputs.his_side.flag, 'shadow');
  assert.equal(off.targets.value.every(t => t.his_side === undefined), true);
  assert.equal(on._run.inputs.his_side.flag, 'on');
  assert.equal(on.targets.value.every(t => t.his_side?.status === 'ok'), true);
});

test('needs: the live layer hands a Set (counterparty-pricing.js#deriveRosterNeeds); the his-side read still sees it', () => {
  const a = league();
  a.managers.set('3', { ...a.managers.get('3'), needs: new Set(['RB', 'TE']) });
  const res = planOf(a);
  const p3 = res.partners.find(p => p.team === '3');
  assert.deepEqual(p3.needs_read, ['RB', 'TE']);
  const on = toEntry(res, { names: a.names(), as_of: '2026-09-24T06:00:00.000Z', his_side_on: true });
  for (const t of on.targets.value.filter(x => x.owner === '3')) {
    assert.deepEqual(t.his_side.value.needs, ['RB', 'TE']);
    assert.equal(t.his_side.value.reads.needs, 'ok');
  }
});
