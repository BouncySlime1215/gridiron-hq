/**
 * WAR-ROOM-UI v2: the new default War Room layout, end to end, the way Nick uses it.
 *
 * Same harness as warroom-e2e.test.js: the plans file is written by the REAL producer
 * (make-producer-plans.mjs, five made-up leagues), served by the REAL route, read by the
 * REAL useWarRoom hook and drawn by the REAL WarRoomShell (TradeBrain's mount) on a small
 * DOM, so buttons are really pressed and every write goes through the real routes.
 *
 * Behaviours (one test each):
 *   V1  the shell opens the new layout on TODAY: the hero, WATCHING, season progress; Coach closed
 *   V2  the hero shows partner, give / get chips, chance with its guess pill, title odds, value edge
 *   V3  the status badge reads only served fields (heroStatus unit cases, and the live card)
 *   V4  Copy message picks the card; "I sent it" posts one offer.sent
 *   V5  GO GET: target -> paths (step timelines) -> the offer composer with the walk-away and
 *       "If he says..." (the picked deck card logs offer.reply); Approve posts one target.approve
 *   V6  every screen draws its contract sections, not "not computed" (Go get, Market, League, Health)
 *   V7  untouchable targets stay hidden with their label; FantasyPros is never shown
 *   V8  the Coach drawer: closed by default, fixed questions, "Ask Coach about this" answers the
 *       next-move question with one sources toggle and no repeated footer; a League card pre-asks
 *   V9  "Classic layout" swaps in the old dashboard and "New layout" swaps back; the choice persists
 *   V10 the plan switcher: › skips (the deck's Next), ‹ goes back
 *   V11 WATCHING: at most five items, red first, each a served field
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDom, domRenderer, click, textOf, button, byAttr, one, all, waitFor } from './helpers/warroom-render.js';

installDom(); // before anything loads react-dom

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-v2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_HIS_SCREEN;

const { makeProducerPlans } = await import('./fixtures/warroom-contract/make-producer-plans.mjs');
const doc = await makeProducerPlans();
const L4 = doc.leagues.find(l => l.league === 4);
assert.ok(L4 && L4.next_move.status === 'ok', 'the producer wrote a next move for league 4');
fs.writeFileSync(process.env.GRIDIRON_WARROOM_PLANS, JSON.stringify(doc));

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { __resetPlansCache } = await import('../server/services/war-room-view.js');
__resetPlansCache?.();

const modelCalls = [];
setAnthropicClientForTesting({ messages: { create: async body => { modelCalls.push(body); throw new Error('no model calls in the War Room v2 test'); } } });

const USER = 7501, TOKEN = 'v2-token';
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, 'v2-user', 'Reader')`, USER);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`, USER, hashSessionToken(TOKEN));
const LEAGUES = [4];
for (const id of LEAGUES) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (?, 'espn', ?, 2026, NULL, '1', 10, 1, '{}', '2026-09-24 01:00:00')`, id, `v2-${id}`);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, id, USER);
}

const app = express();
app.use(express.json());
app.use('/api/trades', requireAuthenticated, tradesRouter);
app.use('/api/warroom', requireAuthenticated, warroomRouter);
app.use('/api/coach', coachRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const calls = [];
async function api(p, opts = {}) {
  const res = await fetch(`${origin}/api${p}`, { ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...opts.headers } });
  const body = await res.json();
  calls.push({ path: p, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, status: res.status });
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
globalThis.__warRoomApiCall = api;

const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { default: WarRoomShell } = await wr.mod('WarRoomShell');
const { useWarRoom } = await wr.mod('useWarRoom');
const { hisScreenPath } = await wr.mod('HisScreen');
const { heroStatus, valueEdgeText, playerParts, SAFE_TO_SEND } = await wr.mod('heroStatus');
const { readLayout, writeLayout, LAYOUT_KEY } = await wr.mod('layoutPref');
const { FIXED_QUESTIONS } = await wr.mod('coach/CoachDrawer');
const { watchItems, WATCH_MAX } = await wr.mod('today');
const { tradeWith } = await wr.mod('WarRoomV2');

/** What TradeBrain.tsx does: useWarRoom(activeId), then the War Room (now WarRoomShell). */
function Host({ initial }) {
  const [id, setId] = React.useState(initial);
  const { data } = useWarRoom(id);
  if (!data) return React.createElement('p', null, 'loading');
  return React.createElement(WarRoomShell, { view: data, activeId: id, onLeague: setId, onExit() {},
    leagues: [...LEAGUES, 7].map(l => ({ id: l, name: null })) });
}

globalThis.__warRoomApi = {};
const v4 = await api('/trades/4/war-room');
globalThis.__warRoomApi['/trades/4/war-room'] = v4;
// League 7 (the page's map only): league 4's view with one target hidden as untouchable.
const t0 = v4.targets.value[0];
const v7 = { ...structuredClone(v4), league: 7, league_id: 7,
  targets: { ...structuredClone(v4.targets), hidden_untouchable: [{ player: t0.player, owner: t0.owner, label: 'on his untouchable list' }] } };
v7.targets.value = v7.targets.value.slice(1);
globalThis.__warRoomApi['/trades/7/war-room'] = v7;
// The hero's value edge reads the real his-screen route (default-off here: it answers why).
const nm = L4.next_move.value;
const s0 = nm.steps[0];
const hisPath = hisScreenPath(4, { partner: String(s0.partner), give: s0.give.map(String), get: s0.get.map(String) });
globalThis.__warRoomApi[hisPath] = await api(hisPath);

const mounted = [];
async function open(id = 4) {
  const ui = mount(React.createElement(Host, { initial: id }));
  mounted.push(ui);
  await waitFor(() => one(ui.container, 'data-testid', 'hero-card') || one(ui.container, 'data-testid', 'war-room-v2'), 3000, 'the War Room v2');
  await waitFor(() => calls.some(c => c.path === '/warroom/layout'), 3000, 'the Coach layout read');
  await new Promise(r => setTimeout(r, 20));
  return ui;
}
const n = ids => ids.map(i => L4.names[i] ?? `Player ${i}`).join(' + ');
const requestsOf = (league, kind) => rows(`SELECT kind, payload, source FROM warroom_requests WHERE league_id = ? AND kind = ? ORDER BY id`, league, kind)
  .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const screenBtn = (ui, id) => all(ui.container, e => e.localName === 'button' && e.getAttribute('data-screen') === id)[0];
async function go(ui, id) {
  click(screenBtn(ui, id));
  await waitFor(() => one(ui.container, 'data-screen-panel', id) && !one(ui.container, 'data-screen-panel', id).hasAttribute('hidden'), 2000, `screen ${id}`);
  return one(ui.container, 'data-screen-panel', id);
}

test.afterEach(() => { while (mounted.length) { try { mounted.pop().unmount(); } catch { /* already gone */ } } });
test.after(() => {
  server.close();
  wr.cleanup();
  setAnthropicClientForTesting(null);
  delete globalThis.__warRoomApiCall;
  delete globalThis.__warRoomApi;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('V1: the new layout is the default and opens on Today; Coach is closed', async () => {
  const ui = await open();
  assert.ok(one(ui.container, 'data-testid', 'war-room-v2'), 'v2 root');
  assert.equal(one(ui.container, 'data-testid', 'war-room-grid'), null, 'not the classic grid');
  assert.equal(screenBtn(ui, 'today').getAttribute('aria-selected'), 'true');
  assert.deepEqual(byAttr(ui.container, 'data-screen').filter(e => e.localName === 'button').map(e => e.getAttribute('data-screen')),
    ['today', 'goget', 'market', 'league']);
  const card = one(ui.container, 'data-testid', 'move-card');
  assert.equal(card.getAttribute('data-move'), nm.move_id, 'the hero is next_move');
  assert.ok(one(card, 'data-testid', 'hero-card'));
  assert.ok(one(ui.container, 'data-panel', 'watching'), 'watching');
  const prog = textOf(one(ui.container, 'data-panel', 'progress'));
  assert.ok(prog.includes(L4.destination.value.goal.value.label), 'the goal');
  const st = L4.itinerary.value;
  assert.ok(prog.includes(`${st.stops.filter(x => x.status === 'done').length} done · ${st.stops_left} left`), prog);
  for (const other of ['goget', 'market', 'league']) assert.equal(one(ui.container, 'data-screen-panel', other), null, `${other} is not drawn`);
  const drawer = one(ui.container, 'data-testid', 'coach-drawer');
  assert.doesNotMatch(drawer.getAttribute('class'), /wr-open/, 'Coach is closed by default');
  assert.equal(drawer.getAttribute('aria-hidden'), 'true');
  assert.equal(one(ui.container, 'data-testid', 'health-sheet'), null, 'health is a chip until tapped');
  assert.match(textOf(one(ui.container, 'data-testid', 'deck-count')), new RegExp(`^1 of ${L4.alternatives.value.length}$`));
  // One league picker (target first), no floating Coach button over the page.
  const picker = one(ui.container, 'data-testid', 'league-picker');
  assert.deepEqual(byAttr(picker, 'data-league').map(e => e.getAttribute('data-league')), ['4', '7']);
  assert.equal(one(ui.container, 'class', 'wr-coach-fab'), null);
  assert.ok(one(ui.container, 'data-testid', 'coach-tab'), 'phones get Coach as a tab');
});

test('V2: the hero shows partner, give / get chips, chance with its guess pill, title odds and value edge', async () => {
  const ui = await open();
  const hero = one(ui.container, 'data-testid', 'hero-card');
  const t = textOf(hero);
  assert.ok(t.includes(`Team ${s0.partner}`), 'partner');
  const chips = side => byAttr(all(hero, e => e.getAttribute('data-side') === side)[0], 'data-player').map(e => e.getAttribute('data-player'));
  assert.deepEqual(chips('give'), s0.give.map(String), 'you give chips');
  assert.deepEqual(chips('get'), s0.get.map(String), 'you get chips');
  for (const id of [...s0.give, ...s0.get]) assert.ok(t.includes(playerParts(L4.names[id]).name), `chip name ${id}`);
  const want = `${(s0.p_yes.value * 100).toFixed(0)}%`;
  const chance = await waitFor(() => { const c = textOf(one(hero, 'data-testid', 'hero-chance')); return c.includes(want) && c; }, 2000, 'the chance (after its count-up)');
  assert.equal(s0.p_yes.guess, true, 'contract: p_yes is a guess');
  assert.match(chance, /\bguess\b/, 'the guess pill');
  const now = L4.destination.value.title_now;
  let odds = textOf(one(hero, 'data-testid', 'hero-odds'));
  if (now.status === 'ok' && s0.title_after.status === 'ok') {
    odds = await waitFor(() => { const o = textOf(one(hero, 'data-testid', 'hero-odds'));
      return o.includes(`${(now.value * 100).toFixed(1)}%`) && o.includes(`${(s0.title_after.value * 100).toFixed(1)}%`) && o; }, 2000, 'title odds before -> after');
  }
  if (s0.title_odds_delta.clears_2se === false) assert.match(odds, /inside the noise/);
  else assert.doesNotMatch(odds, /inside the noise/);
  // Value edge: the his-screen route is off here, so it says "not computed yet" with the route's reason.
  const value = one(hero, 'data-testid', 'hero-value');
  const unk = one(value, 'data-state', 'unknown');
  assert.ok(unk && textOf(unk) === 'not computed yet', textOf(value));
  assert.equal(unk.getAttribute('title'), globalThis.__warRoomApi[hisPath].reason);
  // The hero is calm: no tables, no reply table, no message text drawn in the card.
  assert.equal(all(hero, e => e.localName === 'table').length, 0);
  assert.doesNotMatch(t, /NaN|undefined|\[object Object\]/);
});

test('V3: the status badge reads only served fields', async () => {
  const ok = (value, extra = {}) => ({ status: 'ok', value, source: 's', ...extra });
  const clean = { p_yes: ok(0.4), title_odds_delta: ok(0.02, { clears_2se: true, se: 0.004 }), title_after: ok(0.3) };
  assert.deepEqual(heroStatus(clean), { tone: 'green', label: SAFE_TO_SEND, reasons: [] });
  const guess = heroStatus({ ...clean, p_yes: ok(0.4, { guess: true }) });
  assert.equal(guess.tone, 'amber');
  assert.equal(guess.label, 'Not yet: chance is a guess');
  const both = heroStatus({ ...clean, p_yes: ok(0.4, { guess: true }), title_odds_delta: ok(0.001, { clears_2se: false }) });
  assert.deepEqual(both.reasons, ['chance is a guess', 'gain inside the noise']);
  assert.equal(both.label, 'Not yet: chance is a guess', 'the shortest reason is on the badge');
  assert.equal(heroStatus({ ...clean, title_odds_delta: ok(0.02) }).label, 'Not yet: gain has no noise check');
  const failed = heroStatus({ ...clean, p_yes: { status: 'failed', source: 's', reason: 'x' } });
  assert.equal(failed.tone, 'red');
  assert.equal(failed.label, "Don't send: chance failed its check");
  assert.equal(heroStatus({ ...clean, p_yes: { status: 'unknown', source: 's' } }).label, 'Not yet: chance not computed');
  // The live card: the producer marks p_yes a guess, so it is never "Safe to send".
  const ui = await open();
  const badge = one(ui.container, 'data-testid', 'hero-status');
  assert.equal(badge.getAttribute('data-tone'), heroStatus(s0).tone);
  assert.equal(textOf(badge), heroStatus(s0).label);
  assert.notEqual(textOf(badge), SAFE_TO_SEND);
  assert.deepEqual(valueEdgeText(12), { big: '−12%', note: 'you pay 12% over market', tone: 'amber' });
  assert.deepEqual(valueEdgeText(-8), { big: '+8%', note: 'you get 8% more market value', tone: 'green' });
  assert.equal(valueEdgeText(0.2).big, '±0%');
});

test('V4: Copy message picks the card; "I sent it" posts one offer.sent', async () => {
  const ui = await open();
  assert.equal(button(ui.container, 'I sent it'), null, 'no "I sent it" before the card is picked');
  click(button(ui.container, /^Copy (message|blocked)$/));
  await waitFor(() => button(ui.container, 'I sent it'), 2000, 'the I sent it button');
  const before = calls.filter(c => c.body?.kind === 'offer.sent').length;
  click(button(ui.container, 'I sent it'));
  await waitFor(() => calls.filter(c => c.body?.kind === 'offer.sent').length === before + 1, 3000, 'the offer.sent post');
  assert.deepEqual(calls.filter(c => c.body?.kind === 'offer.sent').at(-1).body, { kind: 'offer.sent', payload: { move_id: nm.move_id }, source: 'nick' });
  await waitFor(() => button(ui.container, 'Marked as sent'), 2000, 'Marked as sent');
});

test('V5: Go get: target -> paths -> the offer composer; a picked deck card logs offer.reply; Approve posts once', async () => {
  const ui = await open();
  const p = await go(ui, 'goget');
  const targets = L4.targets.value;
  const cards = byAttr(p, 'data-target-player').map(e => e.getAttribute('data-target-player'));
  assert.deepEqual(cards, targets.map(t => String(t.player)), 'one card per suggested target, the producer order');
  // It opens on the plan's moves (or the plan target's paths); a target with no path says so.
  const pickTarget = (root, id) => click(all(one(root, 'data-target-player', id), e => e.localName === 'button')[0]);
  const hasPath = t => L4.alternatives.value.some(m => m.target === t.player || m.steps.some(x => x.get.map(String).includes(String(t.player))));
  const noPath = targets.find(t => !hasPath(t));
  if (noPath) {
    pickTarget(p, noPath.player);
    await waitFor(() => /No plan leads to/.test(textOf(one(p, 'data-panel', 'paths'))), 2000, 'the no-path state');
    click(button(p, 'Show every plan move'));
  }
  await waitFor(() => byAttr(p, 'data-path').length > 0, 2000, 'paths');
  const paths = byAttr(p, 'data-path');
  const withPath = targets.find(hasPath);
  if (!withPath) assert.deepEqual(paths.map(e => e.getAttribute('data-path')), L4.alternatives.value.map(m => m.move_id), 'every plan move, best first');
  const firstPath = L4.alternatives.value.find(m => m.move_id === paths[0].getAttribute('data-path'));
  assert.ok(firstPath, 'a path is a plan move');
  const tl = all(paths[0], e => e.localName === 'li');
  assert.equal(tl.length, firstPath.steps.length, 'one timeline row per step');
  assert.ok(textOf(tl[0]).includes(`Team ${firstPath.steps[0].partner}`), 'step partner');
  assert.ok(textOf(tl[0]).includes(`${(firstPath.steps[0].p_yes.value * 100).toFixed(0)}%`), 'step chance');
  // The composer: message, walk-away ladder, "If he says..." for the chosen path.
  const comp = await waitFor(() => one(p, 'data-panel', 'composer'), 2000, 'the composer');
  const s1 = firstPath.steps[0];
  assert.ok(one(comp, 'aria-label', 'Negotiation ladder'), 'the ladder');
  if (s1.walk_away.status === 'ok') assert.ok(textOf(comp).includes(`${n(s1.walk_away.value.max_give)} for ${n(s1.get)}`), 'walk-away package');
  assert.ok(one(comp, 'aria-label', 'If he says'), 'the reply table');
  if (s1.message.status === 'ok') assert.ok(textOf(comp).includes(s1.message.value), 'the message text');
  // Replies log only for the deck's picked card: pick it on Today, then log from Go get.
  if (firstPath.move_id === nm.move_id) {
    assert.equal(button(comp, 'He did this'), null, 'replies log only once the card is picked');
    await go(ui, 'today');
    click(button(ui.container, /^Copy (message|blocked)$/));
    await waitFor(() => button(ui.container, 'I sent it'), 2000, 'picked');
    const p2 = await go(ui, 'goget');
    if (withPath) pickTarget(p2, withPath.player);
    await waitFor(() => button(one(p2, 'data-panel', 'composer'), 'He did this'), 2000, 'the reply buttons');
    click(button(one(p2, 'data-panel', 'composer'), 'He did this'));
    await waitFor(() => requestsOf(4, 'offer.reply').length === 1, 3000, 'the offer.reply row');
    assert.equal(requestsOf(4, 'offer.reply')[0].payload.move_id, nm.move_id);
  }
  // Approve on a target that is not in the plan posts one target.approve.
  const p3 = one(ui.container, 'data-screen-panel', 'goget');
  const free = targets.find(t => !t.is_plan_target && !t.approved);
  if (free) {
    click(button(one(p3, 'data-target-player', free.player), 'Approve'));
    await waitFor(() => requestsOf(4, 'target.approve').length === 1, 3000, 'the target.approve row');
    assert.deepEqual(requestsOf(4, 'target.approve')[0].payload, { player_id: free.player, source: 'suggested' });
  }
});

test('V6: every screen draws its contract sections', async () => {
  const ui = await open();
  const sections = {
    goget: [['stops', L4.itinerary, v => v.stops[0].label], ['targets', L4.targets, v => L4.names[v[0].player]]],
    market: [['flip_map', L4.flip_map, v => { const f = v.find(x => v.some(r => r.player === x.player && r.legs));
      return f ? L4.names[f.player] : 'No flip has a fair leg on both sides yet'; }], ['catch', L4.catch_up, v => v[0].text]],
  };
  for (const [id, list] of Object.entries(sections)) {
    const scr = await go(ui, id);
    for (const [panel, field, first] of list) {
      assert.equal(field.status, 'ok', `${panel}: the producer computed it`);
      const p = one(scr, 'data-panel', panel);
      assert.ok(p, `${panel} is on the ${id} screen`);
      assert.ok(textOf(p).includes(first(field.value)), `${panel} shows its first row (${first(field.value)})`);
      const blocks = all(p, e => e.getAttribute('role') === 'status' && ['unknown', 'failed'].includes(e.getAttribute('data-state')));
      assert.deepEqual(blocks.map(textOf), [], `${panel} renders no unknown/failed block`);
    }
  }
  if (L4.speed_curve.status === 'ok') {
    assert.ok(all(one(ui.container, 'data-panel', 'catch'), e => e.localName === 'svg' && e.getAttribute('role') === 'img').length, 'speed curve draws');
  }
  const league = await go(ui, 'league');
  assert.ok(one(league, 'data-panel', 'people'), 'the League screen');
  // Health: the chip opens the brain report sheet.
  click(one(ui.container, 'data-testid', 'health-chip'));
  const sheet = await waitFor(() => one(ui.container, 'data-testid', 'health-sheet'), 2000, 'the health sheet');
  const brain = one(sheet, 'data-panel', 'brain_report');
  assert.ok(textOf(brain).includes(L4.brain_report.value.checks[0].id), 'brain checks');
  for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) assert.ok(textOf(brain).includes(id), id);
  click(button(sheet, '×'));
  await waitFor(() => !one(ui.container, 'data-testid', 'health-sheet'), 2000, 'the sheet closes');
  assert.doesNotMatch(textOf(ui.container), /NaN|undefined|\[object Object\]/);
});

test('V7: untouchable targets stay hidden with their label; FantasyPros is never shown', async () => {
  const ui = await open(7);
  await go(ui, 'goget');
  await waitFor(() => one(ui.container, 'data-testid', 'targets-untouchable'), 2000, 'the hidden-untouchable line');
  const name = v7.names[t0.player] ?? `Player ${t0.player}`;
  assert.equal(textOf(one(ui.container, 'data-testid', 'targets-untouchable')), `1 hidden: ${name} (Team ${t0.owner}, on his untouchable list)`);
  assert.equal(one(ui.container, 'data-target-player', t0.player), null, 'the untouchable player is not a target card');
  let seen = textOf(ui.container);
  for (const id of ['today', 'goget', 'market', 'league']) {
    await go(ui, id);
    seen += ` ${textOf(ui.container)}`;
  }
  click(one(ui.container, 'data-testid', 'health-chip'));
  await waitFor(() => one(ui.container, 'data-testid', 'health-sheet'), 2000, 'the health sheet');
  seen += ` ${textOf(ui.container)}`;
  assert.doesNotMatch(seen, /fantasy ?pros/i, 'FantasyPros never appears');
});

test('V8: Coach drawer: fixed questions; "Ask Coach about this" answers the next-move question', async () => {
  const ui = await open();
  const drawer = one(ui.container, 'data-testid', 'coach-drawer');
  assert.deepEqual(byAttr(drawer, 'data-testid', 'coach-fixed-q').map(textOf), [...FIXED_QUESTIONS]);
  const asks = () => calls.filter(c => c.path === '/coach/ask');
  const before = asks().length;
  click(button(ui.container, 'Ask Coach about this'));
  await waitFor(() => /wr-open/.test(drawer.getAttribute('class')), 2000, 'the drawer opens');
  await waitFor(() => asks().length === before + 1 && one(drawer, 'data-testid', 'coach-answer'), 5000, 'the answer');
  assert.equal(asks().at(-1).body.question, FIXED_QUESTIONS[0]);
  const answer = one(drawer, 'data-testid', 'coach-answer');
  assert.ok(textOf(answer).length > 0, 'the answer has sentences');
  assert.doesNotMatch(textOf(answer), /Destination: /, 'no footer line under the answer');
  assert.equal(byAttr(answer, 'data-testid', 'coach-answer-sources').length <= 1, true, 'at most one sources toggle per answer');
  assert.equal(all(answer, e => e.getAttribute('class') === 'wr-cite').length, 0, 'no numbered cite chips');
  assert.ok(one(drawer, 'data-testid', 'coach-context'), 'context shows once, at the top');
  assert.equal(modelCalls.length, 0, 'the next-move question never calls a model');
  assert.ok(all(drawer, e => e.localName === 'input' && e.getAttribute('aria-label') === 'Ask Coach')[0], 'free text stays, below');
  click(button(drawer, '×'));
  await waitFor(() => !/wr-open/.test(drawer.getAttribute('class')), 2000, 'the drawer closes');
  // A League card opens Coach already asked about a trade with that manager.
  const league = await go(ui, 'league');
  const tile = all(league, e => e.localName === 'button' && e.hasAttribute('data-team'))[0];
  assert.ok(tile, 'a manager card');
  {
    const team = tile.getAttribute('data-team');
    click(tile);
    await waitFor(() => /wr-open/.test(drawer.getAttribute('class')), 2000, 'the drawer opens from League');
    await waitFor(() => asks().at(-1)?.body?.question === tradeWith(team), 3000, 'the pre-asked question');
    assert.equal(textOf(all(one(drawer, 'data-testid', 'coach-custom-q'), e => e.localName === 'button')[0]), tradeWith(team));
    assert.deepEqual(asks().at(-1).body.context.move_id, nm.move_id, 'the plan on screen rides along as context');
  }
});

test('V9: "Classic layout" swaps in the old dashboard, "New layout" swaps back; the choice persists', async () => {
  const mem = new Map();
  const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readLayout(store), 'v2', 'default');
  assert.equal(writeLayout('classic', store), true);
  assert.equal(mem.get(LAYOUT_KEY), 'classic');
  assert.equal(readLayout(store), 'classic');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readLayout(broken), 'v2', 'blocked storage keeps the default');
  assert.equal(writeLayout('classic', broken), false);

  const saved = [];
  const ls = globalThis.window.localStorage;
  const setItem = ls.setItem;
  ls.setItem = (k, v) => saved.push([k, v]);
  try {
    const ui = await open();
    click(one(ui.container, 'data-testid', 'layout-toggle'));
    await waitFor(() => one(ui.container, 'data-testid', 'war-room-grid'), 2000, 'the classic grid');
    assert.equal(one(ui.container, 'data-testid', 'war-room-v2'), null);
    assert.deepEqual(saved.at(-1), [LAYOUT_KEY, 'classic']);
    click(one(ui.container, 'data-testid', 'layout-toggle'));
    await waitFor(() => one(ui.container, 'data-testid', 'war-room-v2'), 2000, 'back to v2');
    assert.deepEqual(saved.at(-1), [LAYOUT_KEY, 'v2']);
  } finally { ls.setItem = setItem; }
});

test('V10: the plan switcher: › skips to the next plan, ‹ goes back', async () => {
  const ui = await open();
  const [first, second] = L4.alternatives.value;
  assert.ok(second, 'league 4 has a second card');
  const prev = one(ui.container, 'aria-label', 'Previous plan');
  assert.notEqual(prev.getAttribute('disabled'), null, '‹ is off on the first plan');
  click(one(ui.container, 'aria-label', 'Next plan (skips this one)'));
  await waitFor(() => one(ui.container, 'data-move', second.move_id), 2000, 'card 2');
  assert.match(textOf(one(ui.container, 'data-testid', 'deck-count')), /^2 of \d+$/);
  click(one(ui.container, 'aria-label', 'Previous plan'));
  await waitFor(() => one(ui.container, 'data-move', first.move_id), 2000, 'card 1 again');
});

test('V11: WATCHING lists at most five served items, red first', async () => {
  const view = structuredClone(v4);
  view.number_health = { status: 'ok', source: 'audit.numbers', value: { overall: 'broken', checks: [
    { check_id: 'a', status: 'warn', title: 'A warning' }, { check_id: 'b', status: 'broken', title: 'A break' },
    { check_id: 'c', status: 'ok', title: 'Fine' }, { check_id: 'd', status: 'warn', title: 'W2' }, { check_id: 'e', status: 'warn', title: 'W3' },
    { check_id: 'f', status: 'warn', title: 'W4' }, { check_id: 'g', status: 'warn', title: 'W5' }] } };
  const items = watchItems(view, { enabled: true, threads: [{ id: 1, partner: '3', status: 'open', countdown: { phase: 'move_on' } }] });
  assert.equal(items.length, WATCH_MAX);
  assert.deepEqual(items.slice(0, 2).map(i => i.tone), ['red', 'red']);
  assert.equal(items[0].text, 'Move on from Team 3');
  assert.ok(!items.some(i => i.text === 'Fine'), 'ok checks are not watched');
  const ui = await open();
  const w = one(ui.container, 'data-panel', 'watching');
  const lis = all(w, e => e.localName === 'li');
  assert.ok(lis.length <= WATCH_MAX);
  assert.deepEqual(lis.map(textOf), watchItems(v4, null).map(i => i.text));
});
