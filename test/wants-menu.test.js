/**
 * U8 WANTS-MENU (server/services/campaign/wants.js): stated vs revealed wants, Nick's rules
 * as filters on both menus, the shadow tie-break, the pre-registered 7-day grader, and the planner wiring
 * (flag off: byte-identical; flag on: `_run.inputs.wants` only, nothing served moves). Made-up ids only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { wantsRead, wantsMenu, wantsMatch, wantsTieBreak, wantsSummary, wantsOn, WANTS_FLAG } = await import('../server/services/campaign/wants.js');
const { gradeWants, wilson, WANTS_MIN_N } = await import('../server/services/campaign/wants.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T12:00:00Z');

// Nick is roster 5 here and holds the three pinned never-gives (160, 80, 277) plus 10 and 11.
const rosters = new Map([['5', ['160', '80', '277', '10', '11']], ['7', ['290', '20', '21', '22', '23']], ['9', ['30', '31']]]);
const fc = { 160: 9000, 80: 7000, 277: 6000, 10: 3000, 11: 2000, 290: 6100, 20: 5000, 21: 4500, 22: 4000, 23: 3500, 30: 1000, 31: 900 };
const score = { 20: 90, 21: 86, 22: 70, 290: 88, 31: 95 };   // 23 unscored, 22 below the 83 floor
const fcOf = id => fc[id] ?? null;
const scoreOf = id => (score[id] == null ? null : { score: score[id], label: 'fixture' });

const read = () => wantsRead({
  models: [
    { team: '7', status: 'ok', wants: [{ player: '160', n: 3, lift: 1 }, { player: '10', n: 1, lift: 0.2 }], shopping: ['22'] },
    { team: '9', status: 'unknown', wants: [{ player: '11' }], shopping: [] },
  ],
  block: { status: 'ok', by_team: { 7: ['20', '290'], 5: ['10'] }, unmapped: 0 },
  interest: { status: 'ok', by_team: { 7: { wants: ['80', '11'], would_give: ['21', '23'], n: 2 }, 9: { wants: [], would_give: ['31'], n: 1 } }, rows: 3, unmapped: 0 },
});

test('stated (chat asks, chat shopping, ESPN block) and revealed (his own screens) stay apart', () => {
  const r = read();
  assert.deepEqual(r.reads, { chat: 'ok', espn_block: 'ok', screens: 'ok' });
  const t7 = r.by_team['7'];
  assert.deepEqual(t7.stated.wants.map(x => x.player), ['160', '10']);
  assert.deepEqual(t7.stated.gives, [{ player: '22', sources: ['chat_shop'] }, { player: '20', sources: ['espn_block'] }, { player: '290', sources: ['espn_block'] }]);
  assert.deepEqual(t7.revealed.wants.map(x => x.player), ['80', '11']);
  assert.deepEqual(t7.revealed.gives.map(x => x.player), ['21', '23']);
  assert.equal(t7.revealed.screens, 2);
  // An unknown counterpart model contributes nothing.
  assert.equal(r.by_team['9'].stated.wants.length, 0);
  assert.deepEqual(wantsRead({}).reads, { chat: 'unread', espn_block: 'unread', screens: 'unread' });
  assert.deepEqual(wantsRead({ models: [], block: { status: 'unknown', reason: 'x' } }).reads, { chat: 'none', espn_block: 'unknown', screens: 'unread' });
});

test("Nick's rules filter both menus and every drop is counted", () => {
  const m = wantsMenu(read(), { me: '5', rosters, untouchable: new Set(), fcOf, scoreOf, sold: new Set(['21']) });
  assert.deepEqual(m.teams.map(t => t.team), ['7', '9']);
  const t7 = m.teams[0];
  // 160 and 80 are pinned never-give: he asks for them, they are never on the menu.
  assert.deepEqual(t7.give.stated.map(x => x.player), ['10']);
  assert.deepEqual(t7.give.revealed.map(x => x.player), ['11']);
  // 290 never-get, 22 below the floor, 21 sold this season, 23 unscored: only 20 survives.
  assert.deepEqual(t7.get.stated, [{ player: '20', fc: 5000, sources: ['espn_block'] }]);
  assert.deepEqual(t7.get.revealed, []);
  assert.deepEqual(m.teams[1].get.revealed.map(x => x.player), ['31']);
  assert.deepEqual(m.hidden, { never_give: 2, never_get: 1, below_blue_chip: 1, sold_this_season: 1, unscored: 1 });
  assert.equal(m.hidden_total, 6);
  // Nick's own block (roster 5) never becomes a menu.
  assert.ok(!m.teams.some(t => t.team === '5'));
  for (const t of m.teams) for (const f of ['stated', 'revealed']) {
    for (const x of t.give[f]) assert.ok(!['160', '80', '277'].includes(x.player));
    for (const x of t.get[f]) { assert.notEqual(x.player, '290'); assert.ok(score[x.player] >= 83); }
  }
});

test('the no-buy-back rule fails closed when the ledger is unread; adapter untouchables are never given', () => {
  const m = wantsMenu(read(), { me: '5', rosters, untouchable: new Set(['10']), fcOf, scoreOf, sold: null });
  assert.equal(m.teams.flatMap(t => [...t.get.stated, ...t.get.revealed]).length, 0);
  assert.ok(m.hidden.rules_unreadable >= 4);
  assert.deepEqual(m.teams.find(t => t.team === '7').give.stated, []);
  const noFc = wantsMenu(read(), { me: '5', rosters, fcOf: id => (id === '11' ? null : fcOf(id)), scoreOf, sold: new Set() });
  assert.equal(noFc.hidden.no_fc_value, 1);
  // No board: every get is unscored, never certified.
  const noBoard = wantsMenu(read(), { me: '5', rosters, fcOf, scoreOf: null, sold: new Set() });
  assert.equal(noBoard.teams.flatMap(t => [...t.get.stated, ...t.get.revealed]).length, 0);
});

test('the tie-break is shadow: only exact ties, one family at a time, input order untouched', () => {
  const menu = wantsMenu(read(), { me: '5', rosters, fcOf, scoreOf, sold: new Set() });
  assert.deepEqual(wantsMatch(menu, { team: '7', give: ['10'], get: ['20'] }), { stated: 2, revealed: 0 });
  const ranked = [
    { target: '22', score: 0.5, steps: [{ team: '7', give: ['11'], get: ['22'] }] },
    { target: '20', score: 0.5, steps: [{ team: '7', give: ['10'], get: ['20'] }] },
    { target: '21', score: 0.4, steps: [{ team: '7', give: ['11'], get: ['21'] }] },
  ];
  const before = JSON.stringify(ranked);
  const tie = wantsTieBreak(ranked, menu);
  assert.equal(JSON.stringify(ranked), before);
  assert.equal(tie.tied_pairs, 1);
  assert.deepEqual(tie.pairs[0], { at: 0, a: '22@7', b: '20@7', stated: 'swap', revealed: 'keep' });
  assert.deepEqual(tie.would_reorder, { stated: 1, revealed: 0 });
  const s = wantsSummary(read(), menu, tie);
  assert.equal(s.flag, 'shadow');
  assert.ok(!JSON.stringify(s).match(/[A-Z][a-z]+ [A-Z][a-z]+/), 'ids only');
});

test('only GRIDIRON_WANTS=1 switches it on; the preview switch does not', () => {
  assert.equal(WANTS_FLAG, 'GRIDIRON_WANTS');
  assert.equal(wantsOn({}), false);
  assert.equal(wantsOn({ GRIDIRON_WANTS: 'true' }), false);
  assert.equal(wantsOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(wantsOn({ GRIDIRON_WANTS: '1' }), true);
});

/* ------------------------------------------------------------------ the grader */

const opts = { now: T0 + 200 * DAY, rosterSize: 16, teamCount: 12 };
const trade = (at, moves) => ({ at, moves });

test('grader: hit, miss, open window and repeats', () => {
  const trades = [trade(T0 + 3 * DAY, [{ player: 'a', from: '2', to: '7' }]), trade(T0 + 9 * DAY, [{ player: 'b', from: '7', to: '3' }])];
  const sig = [
    { roster: '7', player: 'a', side: 'wants', family: 'revealed', at: T0 },            // hit at +3 d
    { roster: '7', player: 'a', side: 'wants', family: 'revealed', at: T0 + DAY },       // repeat inside 7 d
    { roster: '7', player: 'b', side: 'gives', family: 'stated', at: T0 },               // moved at +9 d: miss
    { roster: '7', player: 'c', side: 'gives', family: 'stated', at: opts.now - 2 * DAY }, // window open
  ];
  const g = gradeWants(sig, trades, opts);
  assert.equal(g.open, 1);
  assert.equal(g.repeats, 1);
  assert.deepEqual([g.cells['revealed:wants'].n, g.cells['revealed:wants'].hits], [1, 1]);
  assert.deepEqual([g.cells['stated:gives'].n, g.cells['stated:gives'].hits], [1, 0]);
  assert.equal(g.verdict, 'fail');   // n < 20 everywhere
});

test('grader: trailing base is the same roster over the prior 28 days, per player per week', () => {
  const trades = [0, 1, 2, 3].map(i => trade(T0 - (i + 1) * 5 * DAY, [{ player: `x${i}`, from: '7', to: '2' }]));
  const g = gradeWants([{ roster: '7', player: 'y', side: 'gives', family: 'stated', at: T0 }], trades, opts);
  assert.ok(Math.abs(g.cells['stated:gives'].base - 4 / (16 * 4)) < 1e-12);
  const w = gradeWants([{ roster: '2', player: 'y', side: 'wants', family: 'stated', at: T0 }], trades, opts);
  assert.ok(Math.abs(w.cells['stated:wants'].base - 4 / (11 * 16 * 4)) < 1e-12);
});

test('grader: a predictive family passes, a random one fails, and they are graded apart', () => {
  const trades = [], sig = [];
  for (let i = 0; i < 30; i++) {
    const at = T0 + i * 3 * DAY;
    sig.push({ roster: '7', player: `r${i}`, side: 'wants', family: 'revealed', at });
    if (i % 2 === 0) trades.push(trade(at + 2 * DAY, [{ player: `r${i}`, from: '3', to: '7' }]));  // half come true
    sig.push({ roster: '7', player: `s${i}`, side: 'wants', family: 'stated', at });             // never come true
  }
  const g = gradeWants(sig, trades, opts);
  assert.equal(g.cells['revealed:wants'].n, 30);
  assert.equal(g.cells['revealed:wants'].pass, true);
  assert.equal(g.cells['stated:wants'].hits, 0);
  assert.equal(g.cells['stated:wants'].pass, false);
  assert.equal(g.verdict, 'pass');
  assert.ok(WANTS_MIN_N === 20);
  const ci = wilson(15, 30);
  assert.ok(ci.lo > 0.31 && ci.lo < 0.34 && ci.hi > 0.66 && ci.hi < 0.69);
  assert.throws(() => gradeWants([], [], { now: 1, rosterSize: 0, teamCount: 12 }));
});

/* ------------------------------------------------------------------ the planner */

const obj = normaliseObjective({ risk_mode: 'balanced' });
const strip = res => JSON.parse(JSON.stringify({ ...res, runtime_ms: 0, phases_ms: {} }));
const withReads = a => {
  a.tradeBlock = { status: 'ok', by_team: { 3: ['21'] }, unmapped: 0 };
  a.chatInterest = { status: 'ok', by_team: { 2: { wants: ['2'], would_give: ['11'], n: 1 } }, rows: 1, unmapped: 0 };
  return a;
};

test('planner: flag off is byte-identical; flag on logs _run.inputs.wants and moves nothing served', () => {
  const off = planLeague(withReads(makeAdapter()), { objective: obj });
  const off2 = planLeague(withReads(makeAdapter()), { objective: obj, env: { GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_WANTS: '0' } });
  assert.equal(off.wants, undefined);
  assert.equal(off2.wants, undefined);
  const on = planLeague(withReads(makeAdapter()), { objective: obj, env: { GRIDIRON_WANTS: '1' } });
  assert.equal(on.wants.flag, 'shadow');
  assert.deepEqual(on.wants.reads, { chat: 'unread', espn_block: 'ok', screens: 'ok' });
  const { wants, ...rest } = strip(on);
  assert.deepEqual(rest, strip(off));
  // Nick (roster 1) holds 2, which roster 2 wants; the fixture has no board, so every get is withheld.
  const t2 = wants.menus.find(t => t.team === '2');
  assert.deepEqual(t2.give.revealed.map(x => x.player), ['2']);
  assert.ok(wants.hidden_by_rules >= 2);
  const entry = toEntry(on, { names: makeAdapter().names(), as_of: '2026-09-24T00:00:00Z' });
  assert.equal(entry._run.inputs.wants.flag, 'shadow');
  const entryOff = toEntry(off, { names: makeAdapter().names(), as_of: '2026-09-24T00:00:00Z' });
  assert.equal(entryOff._run.inputs.wants, undefined);
});

test('grader inputs: revealed from screen rows, stated from dated chat mentions, ids only', async () => {
  const { revealedSignals, statedSignals } = await import('../server/services/campaign/wants.js');
  const { valuesTalk } = await import('../server/services/people/counterpart.js');
  const toMs = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
  const r = revealedSignals({ status: 'ok', rows: [{ roster_id: 7, kind: 'finalize', seen_at: '2026-09-01T00:00:00Z', confidence: 0.9,
    wants: [{ player_id: 1, espn_id: 901 }], would_give: [{ player_id: 2, espn_id: 902 }, { player_id: 3, espn_id: null }] }] }, toMs);
  assert.deepEqual(r.signals.map(s => [s.roster, s.player, s.side, s.family]), [['7', '901', 'wants', 'revealed'], ['7', '902', 'gives', 'revealed']]);
  assert.equal(r.unmapped, 1);
  assert.equal(revealedSignals({ status: 'absent' }, toMs).status, 'absent');
  const people = { available: true, byRoster: new Map([['7', { status: 'ok', built_at: '2026-09-02T00:00:00Z',
    profile: { values_talk: { wants: [{ player: 'Alpha Beta', at: '2026-09-01T00:00:00Z' }, 'Gamma Delta', 'Nobody Known'], shopping: ['Gamma Delta'] } } }]]) };
  const resolve = n => ({ 'Alpha Beta': 901, 'Gamma Delta': 903 })[n] ?? null;
  const s = statedSignals(people, { valuesTalk, resolve, toMs });
  assert.deepEqual(s.signals.map(x => [x.player, x.side, x.source]), [['901', 'wants', 'chat_ask'], ['903', 'wants', 'chat_ask'], ['903', 'gives', 'chat_shop']]);
  assert.equal(s.unresolved, 1);
  assert.equal(s.undated, 2);
  assert.equal(statedSignals({ available: false, reason: 'no chat' }, { valuesTalk, resolve, toMs }).status, 'unknown');
});
