/**
 * WR-E2E: the War Room page, end to end, the way Nick uses it.
 *
 * The plans file is written by the REAL producer (scripts/campaign/produce-plans.mjs, via
 * test/fixtures/warroom-contract/make-producer-plans.mjs: five made-up leagues, league 4 =
 * "go get player 21") at test time, served by the REAL route
 * GET /api/trades/:leagueId/war-room, read by the REAL useWarRoom hook and drawn by the
 * REAL WarRoom.tsx with its panels and the Coach dock, mounted with react-dom/client on a
 * small DOM (test/helpers/warroom-render.js) so buttons are really pressed. Every write
 * (skip, "I sent it", reply, approve, Coach) goes through the real /api/warroom and
 * /api/coach routes into a temp database.
 *
 * Assertions read expected values from the plans file itself (the contract), never from
 * producer internals, so they hold when the producer's numbers change.
 *
 * Behaviours (one test each):
 *   B1  the route answers under 2 s (cold and warm), flag on; flag off is { enabled: false }
 *   B2  every contract section the plan computed renders its data, not "not computed"
 *   B3  deck card 1 is next_move
 *   B4  Next + a skip reason posts one deck.skip; card 2 shows
 *   B5  Back restores card 1
 *   B6  Do it, then "I sent it", posts one offer.sent; the button locks
 *       (B6b: the route records a real-producer card, card 2; fixed by #332)
 *   B7  a logged reply posts one offer.reply
 *   B8  Approve on a suggested target posts one target.approve
 *   B9  the brain-report card shows its states (failing + fallback, unknown)
 *   B10 the number-health dot shows its unknown and failed states
 *       B10b a computed audit (overall warn) shows amber with its warning count (was todo until #333's HealthDot read the contract shape)
 *   B11 the Coach dock mounts; "show flip map" moves Flip map into the big slot; Undo puts it back
 *   B12 next_move unknown with no deck renders its reason; the other panels still draw
 *   B13 a league whose planner run failed renders every panel hidden with the reason
 *   B14 Expand swaps a panel into the big slot; Esc swaps it back
 *   B15 switching league redraws the deck from that league's plan
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDom, domRenderer, click, submit, type, keydown, textOf, button, byAttr, one, all, waitFor } from './helpers/warroom-render.js';

installDom(); // before anything loads react-dom

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-e2e-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

/* ------------------------------------------------ the plans file (real producer) */
const { makeProducerPlans } = await import('./fixtures/warroom-contract/make-producer-plans.mjs');
const doc = await makeProducerPlans();
const entryOf = n => doc.leagues.find(l => l.league === n);
const L4 = entryOf(4);
assert.ok(L4 && L4.next_move.status === 'ok', 'the producer wrote a next move for league 4');

// League 6: league 4's plan with the two check sections in their other contract states
// (brain report unknown, number audit failed). Typed-field states only; the rest is L4.
const L6 = structuredClone(L4);
L6.league = 6;
L6.brain_report = { status: 'unknown', source: 'eval.check', reason: 'The brain check has not run for this league yet.' };
L6.number_health = { status: 'failed', source: 'audit.numbers', reason: 'The number audit could not read its table.' };
for (const m of [L6.next_move.value, ...L6.alternatives.value]) m.move_id = m.move_id.replace(/^L4-/, 'L6-');
for (const s of L6.itinerary.value.stops) if (s.move_id) s.move_id = s.move_id.replace(/^L4-/, 'L6-');
doc.leagues.push(L6);
fs.writeFileSync(process.env.GRIDIRON_WARROOM_PLANS, JSON.stringify(doc));

/* ------------------------------------------------------- server: the real routes */
const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { __resetPlansCache } = await import('../server/services/war-room-view.js');
__resetPlansCache?.();

// Coach must answer a screen command without a model call; any model call fails the test.
const modelCalls = [];
setAnthropicClientForTesting({ messages: { create: async body => { modelCalls.push(body); throw new Error('no model calls in the War Room e2e'); } } });

const USER = 7301, TOKEN = 'e2e-token';
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, 'e2e-user', 'Reader')`, USER);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`, USER, hashSessionToken(TOKEN));
const LEAGUES = [1, 2, 4, 5, 6];
for (const id of LEAGUES) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (?, 'espn', ?, 2026, NULL, '1', 10, 1, '{}', '2026-09-24 01:00:00')`, id, `e2e-${id}`);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, id, USER);
}

const app = express();
app.use(express.json());
app.use('/api/trades', requireAuthenticated, tradesRouter);
app.use('/api/warroom', requireAuthenticated, warroomRouter);
app.use('/api/coach', coachRouter);
// server/index.js answers errors as JSON; so does this app, so a 500 reaches the page as one.
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

/** Every call the page made, and the client's api(): the real routes, signed in. */
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

/** GET the route the page reads, timed. */
async function getView(id) {
  const t0 = performance.now();
  const view = await api(`/trades/${id}/war-room`);
  return { view, ms: performance.now() - t0 };
}

/* ------------------------------------------------------ client: the real modules */
const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { default: WarRoom, COACH_PANEL_AREA } = await wr.mod('WarRoom');
const { useWarRoom } = await wr.mod('useWarRoom');

/** What TradeBrain.tsx does with the War Room: useWarRoom(activeId), then <WarRoom>. */
function Host({ initial }) {
  const [id, setId] = React.useState(initial);
  const { data } = useWarRoom(id);
  if (!data) return React.createElement('p', null, 'loading');
  if (data.enabled !== true) return React.createElement('p', null, 'War Room is off');
  return React.createElement(WarRoom, { view: data, activeId: id, onLeague: setId, onExit() {},
    leagues: LEAGUES.map(l => ({ id: l, name: null })) });
}

// useApi (stubbed by warroom-tsx) answers from this map; fill it from the real route.
globalThis.__warRoomApi = {};
const routeTimes = [];
for (const id of LEAGUES) {
  const { view, ms } = await getView(id);
  routeTimes.push(ms);
  globalThis.__warRoomApi[`/trades/${id}/war-room`] = view;
}

const mounted = [];
async function open(id) {
  const layoutReads = () => calls.filter(c => c.path === '/warroom/layout' && c.method === 'GET').length;
  const before = layoutReads();
  const ui = mount(React.createElement(Host, { initial: id }));
  mounted.push(ui);
  await waitFor(() => one(ui.container, 'data-testid', 'war-room-grid'), 3000, 'the War Room grid');
  // The Coach dock reads the saved layout on mount (and applies it); let that land first.
  await waitFor(() => layoutReads() > before, 3000, 'the Coach layout read');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(askInput(ui), 'the Coach dock is live');
  return ui;
}
const panel = (ui, id) => one(ui.container, 'data-panel', id);
const askInput = ui => all(ui.container, e => e.localName === 'input' && e.getAttribute('aria-label') === 'Ask Coach')[0] ?? null;
const requestsOf = (league, kind) => rows(`SELECT kind, payload, source FROM warroom_requests WHERE league_id = ? AND kind = ? ORDER BY id`, league, kind)
  .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const n = (entry, ids) => ids.map(i => entry.names[i] ?? `Player ${i}`).join(' + ');

test.afterEach(() => { while (mounted.length) { try { mounted.pop().unmount(); } catch { /* already gone */ } } });
test.after(() => {
  for (const ui of mounted) { try { ui.unmount(); } catch { /* already gone */ } }
  server.close();
  wr.cleanup();
  setAnthropicClientForTesting(null);
  delete globalThis.__warRoomApiCall;
  delete globalThis.__warRoomApi;
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ tests */
test('B1: the route answers under 2 s, cold and warm; flag off answers { enabled: false }', async () => {
  const cold = routeTimes[0];
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push((await getView(4)).ms);
  const worst = Math.max(cold, ...warm);
  console.log(`# route ms: cold ${cold.toFixed(1)}, warm max ${Math.max(...warm).toFixed(1)}, warm median ${warm.sort((a, b) => a - b)[2].toFixed(1)}`);
  assert.ok(worst < 2000, `route took ${worst.toFixed(0)} ms`);
  const v = globalThis.__warRoomApi['/trades/4/war-room'];
  assert.equal(v.enabled, true);
  assert.equal(v.league, 4);
  assert.equal(v.snapshot.schema, doc.schema, 'the view carries the producer file head');
  delete process.env.GRIDIRON_WARROOM_ENABLED;
  try {
    assert.deepEqual(await api('/trades/4/war-room'), { enabled: false });
  } finally { process.env.GRIDIRON_WARROOM_ENABLED = '1'; }
});

test('B2: every contract section the plan computed renders its data, not "not computed"', async () => {
  const ui = await open(4);
  const text = textOf(ui.container);
  const d = L4.destination.value;
  assert.ok(text.includes(d.goal.value.label), 'destination goal');
  if (d.eta_week.status === 'ok') assert.ok(text.includes(`wk ${d.eta_week.value}`), 'destination ETA');
  if (d.title_now.status === 'ok') assert.ok(text.includes(`${(d.title_now.value * 100).toFixed(1)}%`), 'title odds now');
  assert.ok(text.includes(`rank ${L4.attention.value.rank} of ${L4.attention.value.of}`), 'attention rank');

  const sections = {
    stops: [L4.itinerary, v => v.stops[0].label],
    // WR-POLISH (#333): one row per player; players with no fair leg anywhere sit behind "Show all".
    flip_map: [L4.flip_map, v => { const f = v.find(x => v.some(r => r.player === x.player && r.legs));
      return f ? L4.names[f.player] : 'No flip has a fair leg on both sides yet'; }],
    targets: [L4.targets, v => L4.names[v[0].player]],
    catch: [L4.catch_up, v => v[0].text],
    brain_report: [L4.brain_report, v => v.checks[0].id],
  };
  for (const [id, [field, first]] of Object.entries(sections)) {
    assert.equal(field.status, 'ok', `${id}: the producer computed it`);
    const p = panel(ui, id);
    assert.ok(p, `${id} panel is on the page`);
    const pt = textOf(p);
    assert.ok(pt.includes(first(field.value)), `${id} shows its first row (${first(field.value)})`);
    // A section the plan computed has no "unknown" block (a row-level unknown number is fine).
    const blocks = all(p, e => e.getAttribute('role') === 'status' && ['unknown', 'failed'].includes(e.getAttribute('data-state')))
      ;
    assert.deepEqual(blocks.map(textOf), [], `${id} renders no unknown/failed block`);
  }
  if (L4.speed_curve.status === 'ok') {
    assert.ok(all(panel(ui, 'catch'), e => e.localName === 'svg' && e.getAttribute('role') === 'img').length, 'speed curve draws');
  }
  assert.ok(panel(ui, 'next'), 'next move panel');
  assert.doesNotMatch(text, /NaN|undefined|\[object Object\]/);
});

test('B3: deck card 1 is next_move', async () => {
  const ui = await open(4);
  const nm = L4.next_move.value;
  const card = one(ui.container, 'data-testid', 'move-card');
  assert.equal(card.getAttribute('data-move'), nm.move_id);
  assert.equal(L4.alternatives.value[0].move_id, nm.move_id, 'contract: the deck head is next_move');
  const t = textOf(card);
  assert.ok(t.includes(`Send this to Team ${nm.steps[0].partner}`), t.slice(0, 80));
  assert.ok(t.includes(n(L4, nm.steps[0].give)), 'you give');
  assert.ok(t.includes(n(L4, nm.steps[0].get)), 'you get');
  assert.ok(t.includes(`${(nm.steps[0].p_yes.value * 100).toFixed(0)}%`), 'chance he says yes');
  assert.match(textOf(one(ui.container, 'data-testid', 'deck-count')), new RegExp(`^1 of ${L4.alternatives.value.length}$`));
});

test('B4: Next plus a skip reason posts one deck.skip through the real route; card 2 shows', async () => {
  const ui = await open(4);
  const [first, second] = L4.alternatives.value;
  assert.ok(second, 'league 4 has a second card');
  click(button(ui.container, 'Next →'));
  await waitFor(() => one(ui.container, 'data-move', second.move_id), 2000, 'card 2');
  assert.match(textOf(one(ui.container, 'data-testid', 'deck-count')), /^2 of \d+/);
  assert.deepEqual(requestsOf(4, 'deck.skip'), [], 'nothing posts while the optional reason is on offer');
  click(button(ui.container, 'Costs too much'));
  await waitFor(() => requestsOf(4, 'deck.skip').length === 1, 3000, 'the deck.skip row');
  const [skip] = requestsOf(4, 'deck.skip');
  assert.equal(skip.source, 'nick');
  assert.equal(skip.payload.move_id, first.move_id);
  assert.equal(skip.payload.reason, 'cost');
  assert.equal(skip.payload.card?.partner, first.steps[0].partner, 'the route keeps the skipped card');
  const posted = await waitFor(() => { const p = calls.filter(c => c.path === '/warroom/4/requests' && c.body?.kind === 'deck.skip'); return p.length && p; }, 2000, 'the logged post');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].status, 201);
  assert.doesNotMatch(textOf(ui.container), /Could not save that to the planner/);
});

test('B5: Back restores card 1', async () => {
  const ui = await open(4);
  const [first, second] = L4.alternatives.value;
  click(button(ui.container, 'Next →'));
  await waitFor(() => one(ui.container, 'data-move', second.move_id), 2000, 'card 2');
  click(button(ui.container, '← back'));
  await waitFor(() => one(ui.container, 'data-move', first.move_id), 2000, 'card 1 again');
  assert.match(textOf(one(ui.container, 'data-testid', 'deck-count')), /^1 of \d+$/);
});

test('B6: Do it, then "I sent it", posts one offer.sent for card 1; the button locks', async () => {
  const ui = await open(4);
  const nm = L4.next_move.value;
  const before = calls.filter(c => c.body?.kind === 'offer.sent').length;
  click(button(ui.container, 'Do it'));
  await waitFor(() => button(ui.container, 'I sent it'), 2000, 'the I sent it button');
  click(button(ui.container, 'I sent it'));
  await waitFor(() => calls.filter(c => c.body?.kind === 'offer.sent').length === before + 1, 3000, 'the offer.sent post');
  const posted = calls.filter(c => c.body?.kind === 'offer.sent').at(-1);
  assert.equal(posted.path, '/warroom/4/requests');
  assert.deepEqual(posted.body, { kind: 'offer.sent', payload: { move_id: nm.move_id }, source: 'nick' });
  await waitFor(() => button(ui.container, 'Marked as sent'), 2000, 'Marked as sent');
  assert.notEqual(button(ui.container, 'Marked as sent').getAttribute('disabled'), null, 'a second tap is not possible');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.filter(c => c.body?.kind === 'offer.sent').length, before + 1, 'posted once');
});

/**
 * KNOWN BUG on main (found by this suite): the real producer writes p_yes_band as
 * { low, high } with no `basis`; warroom-actions/cards.js defaults the basis to
 * 'campaign.p_yes_band', which trade_outcomes' CHECK (model_basis IN no_information /
 * heuristic_unanchored / heuristic_anchored) refuses, so the route answers 500 and the
 * deck shows "Could not save that to the planner". FIX-07's tests hand-add a basis, so
 * they pass. Marked todo so it reports without failing CI; it passes once fixed.
 */
test('B6b: the route records a real-producer "I sent it" (offer.sent row, no save error)', async () => {
  // Card 2, so B6's send on card 1 (which locks that card) can't mask this one. Since #332 the
  // producer carries the acceptance model's basis on p_yes_band, so the ledger accepts real cards.
  const ui = await open(4);
  const [, second] = L4.alternatives.value;
  assert.ok(second, 'league 4 has a second card');
  click(button(ui.container, 'Next →'));
  await waitFor(() => one(ui.container, 'data-move', second.move_id), 2000, 'card 2');
  const before = requestsOf(4, 'offer.sent').length;
  click(button(ui.container, 'Do it'));
  await waitFor(() => button(ui.container, 'I sent it'), 2000, 'the I sent it button');
  click(button(ui.container, 'I sent it'));
  await waitFor(() => calls.filter(c => c.body?.kind === 'offer.sent' && c.body?.payload?.move_id === second.move_id).at(-1)?.status, 3000, 'the route answered');
  assert.equal(calls.filter(c => c.body?.kind === 'offer.sent' && c.body?.payload?.move_id === second.move_id).at(-1).status, 201);
  assert.equal(requestsOf(4, 'offer.sent').length, before + 1);
  await new Promise(r => setTimeout(r, 50));
  assert.doesNotMatch(textOf(ui.container), /Could not save that to the planner/);
});
test('B7: a logged reply posts one offer.reply', async () => {
  const ui = await open(4);
  const nm = L4.next_move.value;
  assert.equal(button(ui.container, 'He did this'), null, 'replies log only once the card is picked');
  click(button(ui.container, 'Do it'));
  await waitFor(() => button(ui.container, 'He did this'), 2000, 'the reply buttons');
  click(button(ui.container, 'He did this')); // first row: Accepts
  await waitFor(() => requestsOf(4, 'offer.reply').length === 1, 3000, 'the offer.reply row');
  assert.deepEqual(requestsOf(4, 'offer.reply')[0].payload.move_id, nm.move_id);
  assert.equal(requestsOf(4, 'offer.reply')[0].payload.reply, 'accept');
  await waitFor(() => button(ui.container, 'Logged'), 2000, 'Logged');
});

test('B8: Approve on a suggested target posts one target.approve', async () => {
  const ui = await open(4);
  const t = L4.targets.value.find(x => !x.is_plan_target && !x.approved);
  assert.ok(t, 'league 4 has a suggested target to approve');
  const rowEl = all(panel(ui, 'targets'), e => e.localName === 'tr' && textOf(e).includes(L4.names[t.player]))[0];
  click(button(rowEl, 'Approve'));
  await waitFor(() => requestsOf(4, 'target.approve').length === 1, 3000, 'the target.approve row');
  assert.deepEqual(requestsOf(4, 'target.approve')[0].payload, { player_id: t.player, source: 'suggested' });
  await waitFor(() => textOf(rowEl).includes('approved'), 2000, 'the row says approved');
});

test('B9: the brain-report card shows its states (failing + fallback, unknown)', async () => {
  const ui = await open(4);
  const br = L4.brain_report.value;
  const card = panel(ui, 'brain_report');
  for (const c of br.checks) {
    const cell = all(card, e => e.getAttribute('title')?.startsWith(`${c.name}.`))[0];
    assert.ok(cell, `${c.id} drawn`);
    assert.ok(textOf(cell).includes(c.status.replace(/_/g, ' ')), `${c.id} reads ${c.status}`);
  }
  if (br.fell_back_to) assert.match(textOf(card), /runs in Balanced mode/);
  const dot = all(one(ui.container, 'aria-label', 'Where we are going'), e => e.getAttribute('class')?.startsWith('wr-dot wr-dot-'))[0];
  assert.equal(dot.getAttribute('class'), `wr-dot wr-dot-${br.overall === 'failing' ? 'red' : br.overall === 'passing' ? 'green' : 'grey'}`);

  const u = await open(6);
  const ut = textOf(panel(u, 'brain_report'));
  assert.ok(ut.includes(L6.brain_report.reason), 'unknown brain report shows its reason');
  assert.doesNotMatch(ut, /failing|passing/, 'never green (or red) by default');
});

test('B10: the number-health dot shows its unknown and failed states, never green by default', async () => {
  const health = ui => one(panel(ui, 'brain_report'), 'data-health');
  assert.equal(L4.number_health.status, 'unknown');
  const u = await open(4);
  assert.equal(health(u).getAttribute('data-health'), 'grey');
  assert.match(textOf(health(u)), /number check not computed yet/);
  const f = await open(6);
  assert.equal(health(f).getAttribute('data-health'), 'grey');
  assert.match(textOf(health(f)), /number check failed/);
});

/**
 * KNOWN BUG on main (found by this suite): the contract's number_health value is
 * { overall, broken, warn, ok, checks } (campaign/plans-schema.js), but
 * client/src/components/warroom/types.ts#NumberHealth and BrainCheckCard.tsx#HealthDot
 * read { status, open }, so a league whose audit ran (league 1: overall 'warn') shows a
 * grey "number check not computed yet". Marked todo; it passes once HealthDot reads the contract.
 */
test('B10b: a computed number audit (overall warn) shows amber with its warning count', async () => {
  const L1 = entryOf(1);
  assert.equal(L1.number_health.value.overall, 'warn');
  const w = await open(1);
  const dot = one(panel(w, 'brain_report'), 'data-health');
  assert.equal(dot.getAttribute('data-health'), 'amber');
  assert.match(textOf(dot), new RegExp(`${L1.number_health.value.warn} warning\\(s\\)`));
});

test('B11: the Coach dock mounts; "show flip map" moves Flip map into the big slot; Undo puts it back', async () => {
  const ui = await open(4);
  const dock = one(ui.container, 'aria-label', 'Coach');
  assert.ok(dock, 'the dock is mounted');
  assert.equal(dock.localName, 'aside');
  assert.equal(panel(ui, 'flip_map').style.gridArea, 'flip_map');
  assert.equal(panel(ui, 'next').style.gridArea, 'next');
  assert.equal(COACH_PANEL_AREA.flip_map, 'flip_map');

  const input = askInput(ui);
  type(input, 'show flip map');
  await waitFor(() => input.value === 'show flip map' && button(ui.container, 'Ask').getAttribute('disabled') == null, 2000, 'Ask enabled');
  submit(all(dock, e => e.localName === 'form')[0]);
  await waitFor(() => panel(ui, 'flip_map').style.gridArea === 'next', 3000, 'flip map in the big slot');
  assert.equal(panel(ui, 'next').style.gridArea, 'flip_map', 'next move swapped out');
  assert.ok(all(panel(ui, 'flip_map'), e => e.localName === 'table').length, 'the big flip map is the table view');
  assert.equal(modelCalls.length, 0, 'a screen command is not a model call');
  const ask = calls.filter(c => c.path === '/coach/ask').at(-1);
  assert.equal(ask.status, 200);
  assert.equal(ask.body.context.surface, 'war_room');
  await waitFor(() => rows(`SELECT id FROM warroom_action_log WHERE league_id = 4`).length >= 1, 2000, 'the action log row')
    .catch(() => assert.ok(calls.some(c => c.path === '/warroom/4/action-log' && c.status < 300), 'the action log was written'));

  click(button(dock, 'Undo'));
  await waitFor(() => panel(ui, 'flip_map').style.gridArea === 'flip_map', 2000, 'flip map back in place');
  assert.equal(panel(ui, 'next').style.gridArea, 'next');
});

test('B12: next_move unknown with no deck renders its reason; the other panels still draw', async () => {
  const L5 = entryOf(5);
  assert.equal(L5.next_move.status, 'unknown');
  const ui = await open(5);
  const nt = textOf(panel(ui, 'next'));
  assert.ok(nt.includes(L5.next_move.reason), nt.slice(0, 160));
  assert.doesNotMatch(nt, /could not be drawn/);
  for (const id of ['stops', 'flip_map', 'targets', 'catch', 'brain_report']) assert.ok(panel(ui, id), `${id} still draws`);
  assert.ok(textOf(panel(ui, 'targets')).includes(L5.names[L5.targets.value[0].player]));
  assert.doesNotMatch(textOf(ui.container), /NaN|undefined|could not be drawn/);
});

test('B13: a league whose planner run failed renders every panel hidden with the reason', async () => {
  const L2 = entryOf(2);
  assert.equal(typeof L2.error, 'string');
  const ui = await open(2);
  const text = textOf(ui.container);
  assert.ok(text.includes(L2.error), 'the failure reason is on the page');
  for (const id of ['stops', 'flip_map', 'targets']) {
    assert.ok(byAttr(panel(ui, id), 'data-state', 'failed').length, `${id} is hidden as failed`);
  }
  assert.doesNotMatch(text, /\d+(\.\d+)?%|NaN|could not be drawn/, 'no numbers from a failed run');
});

test('B14: Expand swaps a panel into the big slot; Esc swaps it back', async () => {
  const ui = await open(4);
  click(button(panel(ui, 'targets'), 'Expand'));
  await waitFor(() => panel(ui, 'targets').style.gridArea === 'next', 2000, 'targets expanded');
  assert.equal(panel(ui, 'next').style.gridArea, 'targets');
  keydown('Escape');
  await waitFor(() => panel(ui, 'targets').style.gridArea === 'targets', 2000, 'Esc restored');
  assert.equal(panel(ui, 'next').style.gridArea, 'next');
});

test('B15: switching league redraws the deck from that league\'s plan', async () => {
  const ui = await open(4);
  const L1 = entryOf(1);
  assert.equal(one(ui.container, 'data-testid', 'move-card').getAttribute('data-move'), L4.next_move.value.move_id);
  const tab = all(ui.container, e => e.getAttribute('role') === 'tab' && textOf(e).startsWith('League 1'))[0];
  click(tab);
  await waitFor(() => one(ui.container, 'data-testid', 'move-card')?.getAttribute('data-move') === L1.next_move.value.move_id, 2000, 'league 1 deck');
  const selected = all(ui.container, e => e.getAttribute('role') === 'tab' && e.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1);
  assert.match(textOf(selected[0]), /League 1\b/);
  assert.ok(textOf(ui.container).includes(L1.destination.value.goal.value.label));
});
