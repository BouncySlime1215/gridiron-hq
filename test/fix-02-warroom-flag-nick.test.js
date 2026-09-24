/**
 * FIX-02 (INTEGRATION-AUDIT-0923 section 8):
 *  (a) server/services/warroom-flag.js is the one reader of the War Room switch and
 *      plans path: the refresh loop, the producer and the request store all go through it;
 *  (b) the producer writes the effective model flags into producer_version;
 *  (c) Nick's own per-roster read (nick_override + manager_notes) beats every
 *      chat-derived read: unreachable -> never a step, flip leg or target owner;
 *      not trading -> ranked below the active pool; hard to deal with -> tougher pricing.
 *
 * Made-up four-team league (test/fixtures/campaign-league.mjs), in-memory chat DB, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fix02-'));
process.env.GRIDIRON_DB_PATH ??= path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const FLAG = 'GRIDIRON_WARROOM_ENABLED';
const PREVIEW = 'GRIDIRON_PREVIEW_UNCONFIRMED';
const PLANS = 'GRIDIRON_WARROOM_PLANS';
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r?.then) return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { priceLadder, HARD_SHIFT_PCT } = await import('../server/services/campaign/playbook.js');
const { chatLabels, pResponds, rankPartners, BASE_RESPONDS, CHECKED_OUT_RESPONDS } = await import('../server/services/campaign/partners.js');
const { toEntry, plansFile, PRODUCER_VERSION } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { nickBlock, nickBlocksFrom, publicNick, NICK_NOTES_SOURCE } = await import('../server/services/people/nick-block.js');
const { modelFlags, versionWithFlags } = await import('../server/services/campaign/model-flags.js');

/* ------------------------------------------------------------ (a) one flag reader */

const CODE_DIRS = ['server', 'scripts', 'client/src'];
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx)$/;
function codeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') out.push(...codeFiles(rel)); }
    else if (CODE_EXT.test(e.name)) out.push(rel);
  }
  return out;
}

test('(a) grep: only server/services/warroom-flag.js names the War Room switch and plans-path variables', () => {
  const files = CODE_DIRS.flatMap(codeFiles);
  assert.ok(files.length > 100, `walked the code (${files.length} files)`);
  const hits = name => files.filter(f => fs.readFileSync(path.join(REPO, f), 'utf8').includes(name));
  assert.deepEqual(hits(FLAG), ['server/services/warroom-flag.js']);
  assert.deepEqual(hits(PLANS), ['server/services/warroom-flag.js']);
  assert.deepEqual(hits('GRIDIRON_WARROOM_SOURCE'), [], 'the old plans-path alias is gone');
});

test('(a) the refresh loop launches the producer under preview mode alone, and reads the plans path from warroom-flag.js', async () => {
  const LOOP = await import('../scripts/refresh-live-data.mjs');
  const plans = path.join(temp, 'wr', 'plans.json');
  const quiet = () => {};
  let launched = 0;
  const launch = () => { launched++; return 1; };
  await withEnv({ [FLAG]: null, [PREVIEW]: null, [PLANS]: plans }, () => {
    LOOP.warRoomPlans({ launch, log: quiet, record: quiet });
    assert.equal(launched, 0, 'both switches off: not launched');
    assert.equal(LOOP.warRoomFiles().plans, plans);
    assert.equal(LOOP.warRoomFiles().log, path.join(path.dirname(plans), 'producer.log'));
  });
  await withEnv({ [FLAG]: null, [PREVIEW]: '1', [PLANS]: plans }, () => {
    LOOP.warRoomPlans({ launch, log: quiet, record: quiet });
    assert.equal(launched, 1, 'preview mode alone turns the producer on');
  });
  const PP = await import('../scripts/campaign/produce-plans.mjs');
  withEnv({ [PLANS]: plans }, () => assert.equal(PP.plansPath(), path.resolve(plans)));
});

test('(a) the request store answers through warRoomFlag: off, on, and on-by-preview with the preview label', async () => {
  await (await import('../server/db/migrate.js')).runMigrations();
  const { warRoomEnabled, warRoomPreview } = await import('../server/services/warroom-actions/store.js');
  withEnv({ [FLAG]: null, [PREVIEW]: null }, () => {
    assert.equal(warRoomEnabled(), false);
    assert.deepEqual(warRoomPreview(), {});
  });
  withEnv({ [FLAG]: '1', [PREVIEW]: null }, () => {
    assert.equal(warRoomEnabled(), true);
    assert.deepEqual(warRoomPreview(), {});
  });
  withEnv({ [FLAG]: null, [PREVIEW]: '1' }, () => {
    assert.equal(warRoomEnabled(), true);
    assert.equal(warRoomPreview().preview, true);
  });
  const src = fs.readFileSync(path.join(REPO, 'server/services/warroom-actions/store.js'), 'utf8');
  assert.match(src, /from '\.\.\/warroom-flag\.js'/);
});

/* ------------------------------------------------------------ (b) model flags */

test('(b) model flags come from each reader, a missing reader reads absent, and the file head carries them', async () => {
  const load = async mod => {
    if (mod.endsWith('trade-horizon.js')) return { playoffImportance: () => ({ value: 5.13, measured: true, preview: true }) };
    if (mod.endsWith('season-sim.js')) return { rosBasisFlag: () => ({ on: false, preview: false }) };
    const e = new Error(`Cannot find module '/x/server/services/title-mutual.js' imported from /x/model-flags.js`);
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  };
  const flags = await withEnv({ [PREVIEW]: '1' }, () => modelFlags({ load }));
  assert.deepEqual(flags, { rl16_1: 'preview', rl17_3: 'off', title_mutual: 'absent', preview: 'on' });
  const v = versionWithFlags('1', flags);
  assert.equal(v, '1+rl16_1=preview,rl17_3=off,title_mutual=absent,preview=on');
  assert.equal(plansFile([], { generated_at: 't', flags }).producer_version, versionWithFlags(PRODUCER_VERSION, flags));

  // A reader whose own imports are broken is a real fault, not 'absent'.
  const broken = async () => {
    const e = new Error(`Cannot find module '/x/dep.js' imported from /x/server/services/season-sim.js`);
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  };
  await assert.rejects(modelFlags({ load: broken }), /dep\.js/);
});

/* ------------------------------------------------------------ (c) the nick block */

test('(c) nick block: nick_override beats a structured note; unreachable, not trading, active and hard read as flags', () => {
  const unreachable = nickBlock({ contactable: false }, [{ note: '{"active": true}' }]);
  assert.equal(unreachable.unreachable, true);
  assert.equal(unreachable.in_active_pool, false, 'active but unreachable is not in the pool');
  const notTrading = nickBlock({ buyer: false, trades: 'probably none' });
  assert.equal(notTrading.deprioritised, true);
  assert.equal(nickBlock({ trades: 'probably none' }).deprioritised, true);
  const hard = nickBlock({ active: true, difficulty: 'hard to deal with' });
  assert.deepEqual([hard.in_active_pool, hard.hard], [true, true]);
  const both = nickBlock({ active: false }, [{ note: '{"active": true}' }, { note: 'plain note text' }]);
  assert.equal(both.active, false, 'nick_override beats manager_notes on the same key');
  assert.equal(both.sources.active, 'nick_override');
  assert.equal(both.notes.length, 1);
  assert.equal(publicNick(both).notes_n, 1);
  assert.equal(JSON.stringify(publicNick(both)).includes('plain note text'), false, 'note text never leaves the block');
  assert.equal(nickBlock(null, []), null);
});

test('(c) nick blocks are read per roster from negotiation_profiles.nick_override and manager_notes (source nick-chat-2026-09-23)', () => {
  const chat = new DatabaseSync(':memory:');
  chat.exec(`CREATE TABLE negotiation_profiles (name TEXT, profile_json TEXT);
             CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);`);
  const ins = chat.prepare('INSERT INTO negotiation_profiles VALUES (?, ?)');
  ins.run('chat-a', JSON.stringify({ says_no: {}, nick_override: { contactable: false } }));
  ins.run('chat-b', JSON.stringify({ nick_override: { buyer: false, trades: 'probably none' } }));
  ins.run('chat-c', JSON.stringify({ says_no: {} }));
  const note = chat.prepare('INSERT INTO manager_notes VALUES (?, ?, ?, ?)');
  note.run('chat-c', '{"active": true, "difficulty": "hard to deal with"}', NICK_NOTES_SOURCE, '2026-09-23');
  note.run('chat-c', '{"active": false}', 'some-other-source', '2026-09-20');
  const ids = new Map([[2, { chat_name: 'chat-a' }], [3, { chat_name: 'chat-b' }], [4, { chat_name: 'chat-c' }], [5, { chat_name: 'chat-d' }]]);
  const r = nickBlocksFrom(chat, ids);
  assert.equal(r.status, 'ok');
  assert.equal(r.byRoster.get('2').unreachable, true);
  assert.equal(r.byRoster.get('3').deprioritised, true);
  assert.deepEqual([r.byRoster.get('4').in_active_pool, r.byRoster.get('4').hard], [true, true], 'only the named source counts');
  assert.equal(r.byRoster.has('5'), false);
  const empty = nickBlocksFrom(new DatabaseSync(':memory:'), ids);
  assert.equal(empty.status, 'unknown');
  assert.match(empty.reason, /neither/);
});

const plan = (managerExtra, obj = {}) => {
  const a = makeAdapter({ managerExtra });
  return planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', ...obj }) });
};
const teamsIn = res => ({
  deck: new Set(res.deck.flatMap(c => c.plan.steps.map(s => String(s.team)))),
  best: new Set((res.best?.steps ?? []).map(s => String(s.team))),
  flips: new Set([...res.flip.top, ...res.flip.realised].flatMap(f => [String(f.a), String(f.b)])),
  targets: new Set(res.suggestions.map(s => String(s.owner))),
});

test('(c) an unreachable manager never appears in any deck, flip or target', () => {
  const free = teamsIn(plan({}));
  // Sanity: without Nick's read, team 3 is in play (so the exclusion below is doing something).
  assert.ok(free.deck.has('3') || free.flips.has('3') || free.targets.has('3'), 'team 3 is a partner on the free run');
  const res = plan({ 3: { nick: nickBlock({ contactable: false, active: true }) } });
  const t = teamsIn(res);
  for (const [where, set] of Object.entries(t)) assert.equal(set.has('3'), false, `team 3 in ${where}`);
  assert.equal(res.catch_up.some(c => /Team 3\b/.test(c.text)), false, 'nor in the catch-up list');
  const row = res.partners.find(p => p.team === '3');
  assert.deepEqual([row.p_responds, row.basis, row.excluded], [0, 'Nick: unreachable', true]);
  assert.equal(res.partners.at(-1).team, '3', 'listed last, with the reason');

  // And in the contract entry (FIX-03 shape): valid, marked blocked, and in no move, flip leg or target.
  const entry = toEntry(res, { names: makeAdapter().names(), as_of: '2026-09-24T00:00:00.000Z' });
  assert.deepEqual(validateLeague(entry).errors, []);
  const p3 = entry.partners.value.find(p => p.team === '3');
  assert.deepEqual([p3.p_responds, p3.basis, p3.blocked], [0, 'Nick: unreachable', true]);
  const moves = entry.alternatives.status === 'ok' ? entry.alternatives.value : [];
  assert.equal(moves.some(m => m.steps.some(st => st.partner === '3')), false, 'no move step');
  assert.equal((entry.flip_map.value ?? []).some(f => f.buy_from === '3' || f.sell_to === '3'), false, 'no flip leg');
  assert.equal((entry.targets.value ?? []).some(t => t.owner === '3'), false, 'no target owner');
});

test('(c) a not-trading manager ranks below every active manager at equal edge, whatever his activity read', () => {
  const managers = new Map([
    ['2', { receptiveness: 0.4, nick: nickBlock({ active: true }) }],                           // weak read, floored
    ['3', { receptiveness: 1.6, nick: nickBlock({ active: true, difficulty: 'hard to deal with' }) }],
    ['4', { receptiveness: 1.8, nick: nickBlock({ buyer: false, trades: 'probably none' }) }],  // chat/activity says eager
    ['5', { receptiveness: 1.0 }],
  ]);
  const edge = new Map(['2', '3', '4', '5'].map(t => [t, 0.02]));
  const ranked = rankPartners(managers, edge);
  const pos = t => ranked.findIndex(p => p.team === t);
  assert.ok(pos('4') > pos('2') && pos('4') > pos('3'), `order ${ranked.map(p => p.team)}`);
  assert.equal(ranked.find(p => p.team === '4').p_responds, CHECKED_OUT_RESPONDS);
  assert.match(ranked.find(p => p.team === '4').basis, /^Nick: not trading \(capped at 0\.05, hand-set/);
  assert.equal(ranked.find(p => p.team === '2').p_responds, BASE_RESPONDS, 'the active pool is floored at BASE_RESPONDS');
  // At equal edge and equal read, the active pool comes first.
  const tie = rankPartners(new Map([['5', { receptiveness: 1 }], ['2', { receptiveness: 1, nick: nickBlock({ active: true }) }]]),
    new Map([['5', 0.02], ['2', 0.02]]));
  assert.deepEqual(tie.map(p => p.team), ['2', '5']);
  const zeroEdge = rankPartners(managers, new Map());
  assert.ok(zeroEdge.findIndex(p => p.team === '4') > zeroEdge.findIndex(p => p.team === '2'), 'and at zero edge');
});

test('(c) a hard manager\'s opening asks for less than a neutral one on the same deal, with a lower walk-away', () => {
  const curve = [
    { give: ['a'], his_pct: -25, p: 0.1, nick_gain: 0.029 },
    { give: ['b'], his_pct: -12, p: 0.18, nick_gain: 0.030 },
    { give: ['c'], his_pct: 1, p: 0.35, nick_gain: 0.028 },
    { give: ['d'], his_pct: 8, p: 0.45, nick_gain: 0.022 },
    { give: ['e'], his_pct: 15, p: 0.5, nick_gain: 0.020 },
    { give: ['f'], his_pct: 30, p: 0.7, nick_gain: 0.009 },
  ];
  const neutral = priceLadder(curve, { batna: 0.01 });
  const hard = priceLadder(curve, { batna: 0.01, hard: true });
  assert.ok(hard.opening.his_pct < neutral.opening.his_pct, `${hard.opening.his_pct} < ${neutral.opening.his_pct}`);
  assert.ok(hard.walk_away.his_pct < neutral.walk_away.his_pct, `${hard.walk_away.his_pct} < ${neutral.walk_away.his_pct}`);
  assert.deepEqual(hard.indifference, neutral.indifference, 'his yes-point is the same; only where Nick opens and stops moves');
  assert.equal(neutral.nick_shift, null);
  assert.equal(hard.nick_shift.shift_pct, HARD_SHIFT_PCT);
  assert.match(hard.nick_shift.text, /^Nick: hard to deal with/);
  assert.match(hard.nick_shift.basis, /hand-set/);

  // Through the planner: the step's playbook and the card's reason chain carry the shift.
  const base = plan({});
  const team = String(base.best.steps[0].team);
  const res = plan({ [team]: { nick: nickBlock({ active: true, difficulty: 'hard to deal with' }) } });
  const pb = res.playbook[0];
  assert.equal(String(res.best.steps[0].team), team);
  assert.ok(pb.opening.his_pct <= base.playbook[0].opening.his_pct);
  assert.equal(pb.nick_shift.reason, 'Nick: hard to deal with');
  const a = makeAdapter();
  const entry = toEntry(res, { names: a.names(), as_of: 't' });
  assert.ok(JSON.stringify(entry).includes('Nick: hard to deal with'), 'shown in the reason chain');
});

test('(c) nick_override beats a contrary chat label', () => {
  const chat = { profile: { msgs: 250, p_competitive: 0.6, p_friendly: 0.3, p_open_to_trade: 0.5 } };
  assert.equal(chatLabels(chat).open_to_trade, 'high', 'the chat alone reads him as open to trading');
  const labels = chatLabels({ ...chat, nick: nickBlock({ buyer: false, trades: 'probably none' }) });
  assert.equal(labels.open_to_trade, 'low');
  assert.deepEqual(labels.overridden, ['open_to_trade']);
  assert.equal(labels.nick_source, 'nick_override');
  const gone = chatLabels({ ...chat, nick: nickBlock({ contactable: false }) });
  assert.deepEqual([gone.open_to_trade, gone.engagement], ['none', 'unreachable']);
  // And the partner read: a high activity read cannot lift a manager Nick says is not trading.
  assert.equal(pResponds({ receptiveness: 1.8, nick: nickBlock({ buyer: false }) }).p, CHECKED_OUT_RESPONDS);
  assert.equal(pResponds({ receptiveness: 1.8, nick: nickBlock({ contactable: false }) }).p, 0);
  // Without chat rows at all, Nick's read still lands.
  assert.equal(chatLabels({ nick: nickBlock({ active: true }) }).open_to_trade, 'high');
});
