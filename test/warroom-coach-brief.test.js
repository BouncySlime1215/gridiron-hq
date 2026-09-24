/**
 * COACH-BRIEF-UI: the morning brief in the War Room's Coach dock.
 *
 * The brief comes from the REAL route GET /api/coach/brief/:leagueId (PR #307) reading the
 * league-4-shaped producer fixture (test/fixtures/warroom-contract/producer-plans.json), and
 * is drawn by the REAL WarRoom.tsx -> CoachDock -> CoachBrief, mounted with react-dom/client
 * on the small DOM in test/helpers/warroom-render.js. No model call, no network beyond the
 * local express app, no league or manager names.
 *
 * Measured (printed as "# measure"): claims rendered in the dock / claims the route returned.
 *
 *   C1  every claim the route returns renders in the dock, in order, each with its cite(s)
 *   C2  a cite shows its ledger source on hover (title) and on tap (the source line)
 *   C3  typed unknowns render as "... not read: <reason>"
 *   C4  the weekly toggle asks for kind=weekly and renders every weekly claim
 *   C5  dropped claims are never rendered
 *   C6  a 500 from the route shows the small error state; the deck and Coach still render
 *   C7  a route that never answers shows the loading line, never blocks the deck; a timeout
 *       turns into the error state
 *   C8  the brief is asked for after the deck is on screen (no await on the brief)
 *   C9  flag off: the dock shows no brief at all
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDom, domRenderer, click, textOf, button, byAttr, one, all, waitFor } from './helpers/warroom-render.js';

installDom(); // before anything loads react-dom

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-brief-ui-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

/* ------------------------------------------------------- server: the real routes */
const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const { default: coachRouter } = await import('../server/routes/coach.js');
const { __resetPlansCache } = await import('../server/services/war-room-view.js');
__resetPlansCache?.();

const modelCalls = [];
setAnthropicClientForTesting({ messages: { create: async body => { modelCalls.push(body); throw new Error('no model calls here'); } } });

const USER = 7401, TOKEN = 'brief-ui-token';
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, 'brief-ui-user', 'Reader')`, USER);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`, USER, hashSessionToken(TOKEN));
const LEAGUES = [4];
for (const id of LEAGUES) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (?, 'espn', ?, 2026, NULL, '1', 10, 1, '{}', '2026-09-24 01:00:00')`, id, `brief-ui-${id}`);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, id, USER);
}

const app = express();
app.use(express.json());
app.use('/api/trades', requireAuthenticated, tradesRouter);
app.use('/api/warroom', requireAuthenticated, warroomRouter);
app.use('/api/coach', coachRouter);
// A route that fails the way a crashed handler does: server/index.js answers errors as JSON 500.
app.get('/api/test-broken', () => { throw new Error('brief builder crashed'); });
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

/**
 * The client's api(): the real routes, signed in. `briefMode` bends only the brief call:
 * 'real' (default), 'broken' (the same call answered by a 500 route), 'hang' (never answers),
 * 'drop' (the real answer plus dropped claims, to prove they are not drawn).
 */
let briefMode = 'real';
let gridAtBriefCall = [];
let currentUi = null;
const calls = [];
const DROPPED_TEXT = 'Dropped line that failed its number check 99.9';
async function fetchJson(p, opts = {}) {
  const res = await fetch(`${origin}/api${p}`, { ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...opts.headers } });
  const body = await res.json();
  calls.push({ path: p, method: opts.method ?? 'GET', status: res.status });
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
async function api(p, opts = {}) {
  if (p.startsWith('/coach/brief/')) {
    gridAtBriefCall.push(!!(currentUi && one(currentUi.container, 'data-testid', 'war-room-grid')));
    if (briefMode === 'broken') return fetchJson('/test-broken', opts);
    if (briefMode === 'hang') { calls.push({ path: p, method: 'GET', status: 'pending' }); return new Promise(() => {}); }
    if (briefMode === 'drop') {
      const body = await fetchJson(p, opts);
      return { ...body, dropped: [...(body.dropped ?? []), { section: 'next_move', text: DROPPED_TEXT, violations: ['99.9 is not in any cited cell'] }] };
    }
  }
  return fetchJson(p, opts);
}
globalThis.__warRoomApiCall = api;

/* ------------------------------------------------------ client: the real modules */
const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { default: WarRoom } = await wr.mod('WarRoom');
const { useWarRoom } = await wr.mod('useWarRoom');
// Tolerant import so the same command measures the baseline (no component: 0 rendered).
const { default: CoachBrief } = await wr.mod('coach/CoachBrief').catch(() => ({ default: null }));

function Host({ initial }) {
  const [id, setId] = React.useState(initial);
  const { data } = useWarRoom(id);
  if (!data) return React.createElement('p', null, 'loading');
  if (data.enabled !== true) return React.createElement('p', null, 'War Room is off');
  return React.createElement(WarRoom, { view: data, activeId: id, onLeague: setId, onExit() {},
    leagues: LEAGUES.map(l => ({ id: l, name: null })) });
}

globalThis.__warRoomApi = { '/trades/4/war-room': await fetchJson('/trades/4/war-room') };
assert.equal(globalThis.__warRoomApi['/trades/4/war-room'].league_id, 4, 'the view carries the app league id the dock hands the brief');

const mounted = [];
async function open(id = 4) {
  gridAtBriefCall = [];
  const ui = mount(React.createElement(Host, { initial: id }));
  currentUi = ui;
  mounted.push(ui);
  await waitFor(() => one(ui.container, 'data-testid', 'war-room-grid'), 3000, 'the War Room grid');
  return ui;
}
const briefEl = ui => one(ui.container, 'data-testid', 'coach-brief');
const claimEls = ui => byAttr(ui.container, 'data-testid', 'coach-brief-claim');
const citeEls = el => byAttr(el, 'data-cite');
const askInput = ui => all(ui.container, e => e.localName === 'input' && e.getAttribute('aria-label') === 'Ask Coach')[0] ?? null;
const routeBrief = kind => fetchJson(`/coach/brief/4${kind === 'weekly' ? '?kind=weekly' : ''}`);

/** The value a cite points at, read from the ledger the route sent (the test's own resolver). */
function cellOf(ledger, cite) {
  const d = ledger.derived.find(x => x.id === cite);
  if (d) return d.value;
  const m = /^(r\d+)#(\d+)\.(\w+)$/.exec(cite);
  return ledger.queries.find(q => q.id === m[1]).rows[Number(m[2])][m[3]];
}

test.afterEach(() => {
  briefMode = 'real';
  while (mounted.length) { try { mounted.pop().unmount(); } catch { /* already gone */ } }
  currentUi = null;
});
test.after(() => {
  server.close();
  wr.cleanup();
  setAnthropicClientForTesting(null);
  delete globalThis.__warRoomApiCall;
  delete globalThis.__warRoomApi;
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(modelCalls.length, 0, 'no model call');
});

/* ------------------------------------------------------------------------ tests */
test('C1: every claim the route returns renders in the dock, in order, each with its cite', async () => {
  const route = await routeBrief('morning');
  assert.equal(route.status, 'ok', JSON.stringify(route).slice(0, 300));
  assert.ok(route.claims.length >= 5, 'the fixture brief has claims');
  const ui = await open(4);
  // Measured either way (the baseline has no component: 0 rendered), then asserted.
  await waitFor(() => claimEls(ui).length > 0, 3000, 'brief claims in the dock').catch(() => {});
  const shown = claimEls(ui);
  console.log(`# measure morning: rendered ${shown.length} / route ${route.claims.length}; with cites ${shown.filter(c => citeEls(c).length > 0).length}`);
  assert.ok(one(ui.container, 'aria-label', 'Coach').contains(briefEl(ui)), 'the brief is inside the Coach dock');
  assert.equal(shown.length, route.claims.length);
  route.claims.forEach((c, i) => {
    assert.ok(textOf(shown[i]).includes(c.text), `claim ${i} reads "${c.text}"`);
    assert.deepEqual(citeEls(shown[i]).map(e => e.getAttribute('data-cite')), c.cites, `claim ${i} carries its cites`);
  });
  assert.ok(shown.every(c => citeEls(c).length > 0), 'every rendered claim has a cite');
});

test('C2: a cite shows its ledger source on hover (title) and on tap', async () => {
  const route = await routeBrief('morning');
  const ui = await open(4);
  await waitFor(() => claimEls(ui).length === route.claims.length, 3000, 'brief claims');
  for (const [i, c] of route.claims.entries()) {
    for (const cite of c.cites) {
      const el = citeEls(claimEls(ui)[i]).find(e => e.getAttribute('data-cite') === cite);
      assert.ok(el.getAttribute('title').includes(String(cellOf(route.ledger, cite))), `${cite} hover shows its ledger value`);
    }
  }
  const first = citeEls(claimEls(ui)[0])[0];
  const cite = first.getAttribute('data-cite');
  assert.equal(one(ui.container, 'data-testid', 'coach-brief-source'), null, 'no source line before a tap');
  click(first);
  const src = await waitFor(() => one(ui.container, 'data-testid', 'coach-brief-source'), 1000, 'the source line');
  assert.ok(textOf(src).includes(cite) && textOf(src).includes(String(cellOf(route.ledger, cite))), textOf(src));
  click(first);
  await waitFor(() => one(ui.container, 'data-testid', 'coach-brief-source') === null, 1000, 'a second tap closes it');
});

test('C3: typed unknowns render as "not read: <reason>"', async () => {
  const route = await routeBrief('morning');
  const unknowns = route.claims.filter(c => / not read: /.test(c.text));
  assert.ok(unknowns.length > 0, 'the fixture brief has typed unknowns (statements, credibility)');
  const ui = await open(4);
  await waitFor(() => claimEls(ui).length === route.claims.length, 3000, 'brief claims');
  const marked = claimEls(ui).filter(e => e.getAttribute('data-unknown') === 'true');
  assert.equal(marked.length, unknowns.length, 'each typed unknown is marked as one');
  for (const u of unknowns) {
    const reason = u.text.split(' not read: ')[1];
    assert.ok(marked.some(e => textOf(e).includes(`not read: ${reason}`)), `shows "${u.text}"`);
  }
  assert.match(textOf(briefEl(ui)), /Statements not read: chat labels not built yet/);
});

test('C4: the weekly toggle asks for kind=weekly and renders every weekly claim', async () => {
  const route = await routeBrief('weekly');
  assert.equal(route.status, 'ok');
  const ui = await open(4);
  await waitFor(() => claimEls(ui).length > 0, 3000, 'morning claims');
  click(button(briefEl(ui), 'Weekly'));
  await waitFor(() => calls.some(c => c.path === '/coach/brief/4?kind=weekly'), 2000, 'the weekly request');
  await waitFor(() => claimEls(ui).length === route.claims.length && textOf(claimEls(ui)[0]).includes(route.claims[0].text), 3000, 'weekly claims');
  console.log(`# measure weekly: rendered ${claimEls(ui).length} / route ${route.claims.length}`);
  assert.ok(claimEls(ui).every(c => citeEls(c).length > 0));
  assert.equal(button(briefEl(ui), 'Weekly').getAttribute('aria-pressed'), 'true');
  click(button(briefEl(ui), 'Morning'));
  const morning = await routeBrief('morning');
  await waitFor(() => claimEls(ui).length === morning.claims.length && textOf(claimEls(ui)[0]).includes(morning.claims[0].text), 3000, 'back to morning');
});

test('C5: dropped claims are never rendered', async () => {
  briefMode = 'drop';
  const route = await routeBrief('morning');
  const ui = await open(4);
  await waitFor(() => claimEls(ui).length === route.claims.length, 3000, 'brief claims');
  assert.ok(!textOf(ui.container).includes(DROPPED_TEXT), 'the dropped line is not on screen');
  assert.ok(!textOf(ui.container).includes('99.9'), 'nor its number');
});

test('C6: a 500 from the route shows the small error state; the deck and Coach still render', async () => {
  briefMode = 'broken';
  const ui = await open(4);
  const err = await waitFor(() => one(ui.container, 'data-testid', 'coach-brief-error'), 3000, 'the brief error state');
  assert.match(textOf(err), /Brief not read: brief builder crashed/);
  assert.ok(button(err, 'Retry'), 'a retry, not a dead end');
  assert.equal(claimEls(ui).length, 0);
  assert.ok(one(ui.container, 'data-panel', 'next'), 'the deck still renders');
  assert.ok(askInput(ui), 'the Coach dock is live');
  assert.ok(!byAttr(ui.container, 'role', 'alert').some(e => briefEl(ui).contains(e)), 'the brief failure is a small state, not an alert');
  briefMode = 'real';
  click(button(err, 'Retry'));
  await waitFor(() => claimEls(ui).length > 0, 3000, 'retry draws the brief');
});

test('C7: a route that never answers leaves a small loading line; the deck is not blocked; a timeout shows the error', async () => {
  briefMode = 'hang';
  const ui = await open(4);
  await waitFor(() => one(ui.container, 'data-testid', 'coach-brief-loading'), 2000, 'the loading line');
  assert.ok(one(ui.container, 'data-panel', 'next'), 'the deck renders while the brief is pending');
  assert.ok(askInput(ui), 'the Coach dock is live while the brief is pending');

  // The timeout itself: CoachBrief on its own with a short limit.
  const solo = mount(React.createElement(CoachBrief, { leagueId: 4, timeoutMs: 40 }));
  mounted.push(solo);
  const err = await waitFor(() => one(solo.container, 'data-testid', 'coach-brief-error'), 2000, 'the timeout error state');
  assert.match(textOf(err), /Brief not read: the brief took longer than/);
});

test('C8: the brief is asked for after the deck is on screen', async () => {
  const ui = await open(4);
  await waitFor(() => claimEls(ui).length > 0, 3000, 'brief claims');
  assert.ok(gridAtBriefCall.length >= 1, 'the brief was requested');
  assert.ok(gridAtBriefCall.every(Boolean), 'every brief request went out with the deck already in the DOM');
});

test('C9: flag off, the dock shows no brief at all', async () => {
  process.env.GRIDIRON_COACH_BRIEF_ENABLED = '0';
  try {
    const ui = await open(4);
    await waitFor(() => calls.filter(c => c.path.startsWith('/coach/brief/')).at(-1)?.status === 200, 2000, 'the brief answer');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(briefEl(ui), null, 'nothing drawn for an off brief');
    assert.ok(askInput(ui));
  } finally { process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1'; }
});
