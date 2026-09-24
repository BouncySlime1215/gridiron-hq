/**
 * WR-3 + WR-COACH: Coach drives the War Room through typed actions only.
 *
 * What is pinned here (WAR-ROOM-UI.md v2 section 2 guardrails):
 *  - the action schema refuses unknown actions, on the server and the client,
 *    and the two copies of the schema are the same lists;
 *  - the client dispatcher applies focus_panel / filter / undo;
 *  - a plan-changing action does nothing until Nick taps Confirm, and the
 *    server refuses a Coach-proposed plan request that was not confirmed;
 *  - "show flip map for league 3" comes back as a valid focus_panel action,
 *    without a model call;
 *  - verify.js still blocks an invented number, including on a War Room turn
 *    whose tools returned an action;
 *  - the WR-3 route records requests (and only records), is off with the flag
 *    off, and every Coach reply footer carries destination / stops left / next move.
 *
 * No network: every Claude call is a stand-in client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-coach-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_WARROOM_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { run, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
const { runCoachTool, toolDefinitions, COACH_TOOLS, WARROOM_TOOLS, CoachToolError } = await import('../server/services/coach/tools.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer, VIOLATIONS } = await import('../server/services/coach/verify.js');
const schema = await import('../server/services/warroom-actions/schema.js');
const { routeIntent } = await import('../server/services/warroom-actions/intent.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const client = await import('../client/src/components/warroom/coach/warroomCoach.ts');

/* ------------------------------------------------------------- fixture */
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7101, 'warroom-user', 'Reader')`);
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7102, 'warroom-other', 'Other')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7101, ?, datetime('now','+1 day'))`, hashSessionToken('wr-token'));
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (7102, ?, datetime('now','+1 day'))`, hashSessionToken('wr-other'));
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (61, 'espn', 'wr-61', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-23 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (61, 7101, 'member')`);

const { requireAuthenticated } = await import('../server/platform/auth.js');
const app = express();
app.use(express.json());
app.use('/api/warroom', requireAuthenticated, warroomRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/warroom`;
test.after(() => { server.close(); setAnthropicClientForTesting(null); });

const call = (method, url, body, token = 'wr-token') => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body) });
const withFlag = async fn => {
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  try { return await fn(); } finally { delete process.env.GRIDIRON_WARROOM_ENABLED; }
};

/** One league of the plans contract (campaign/plans-schema.js), as the producer writes it. */
const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/coach-contract-league.json', import.meta.url), 'utf8'));
const PLANS = PRODUCER.leagues[0];
const CTX = { leagues: [1, 2, 3, 4], plans: PLANS, now: '2026-09-23T22:00:00.000Z' };

/* ---------------------------------------------------- schema validation */
test('the schema refuses an unknown action, on the server and on the client', () => {
  for (const bad of [{ type: 'send_offer', to: '7' }, { type: 'eval', code: 'alert(1)' }, { type: 'SEND' }, {}, null, 'focus_panel']) {
    assert.equal(schema.validateAction(bad).ok, false, `server accepted ${JSON.stringify(bad)}`);
    assert.equal(client.validateAction(bad).ok, false, `client accepted ${JSON.stringify(bad)}`);
  }
  assert.match(schema.validateAction({ type: 'send_offer' }).error, /unknown action/);
  assert.ok(!schema.ACTION_TYPES.some(t => /send/.test(t)), 'there is no send action');
});

test('the client and server schemas are the same lists', () => {
  assert.deepEqual([...client.ACTION_TYPES], [...schema.ACTION_TYPES]);
  assert.deepEqual([...client.PLAN_CHANGING], [...schema.PLAN_CHANGING]);
  assert.deepEqual([...client.PANELS], [...schema.PANELS]);
  assert.deepEqual([...client.POSITIONS], [...schema.POSITIONS]);
  assert.deepEqual([...client.SORT_KEYS], [...schema.SORT_KEYS]);
  assert.deepEqual([...client.RISK_MODES], [...schema.RISK_MODES]);
  assert.deepEqual([...client.GOALS], [...schema.GOALS]);
  assert.deepEqual([...client.STOP_KINDS], [...schema.STOP_KINDS]);
  assert.deepEqual([...client.TOLERANCE_KEYS], Object.keys(schema.TOLERANCES));
  assert.deepEqual(client.TOLERANCES, schema.TOLERANCES);
  assert.deepEqual(Object.fromEntries(Object.entries(client.PLUG_IN_FIELDS).map(([k, v]) => [k, [...v]])),
    Object.fromEntries(Object.entries(schema.PLUG_IN_FIELDS).map(([k, v]) => [k, [...v]])));
});

test('schema: plug_in binds only to whitelisted engine fields; draft_message carries no digits', () => {
  assert.equal(schema.validateAction({ type: 'plug_in', field: 'destination.path', view: 'sparkline' }).ok, true);
  assert.equal(schema.validateAction({ type: 'plug_in', field: 'users.password', view: 'number' }).ok, false);
  assert.equal(schema.validateAction({ type: 'plug_in', field: 'destination.path', view: 'number' }).ok, false);
  // Contract names only: the pre-contract names and fields no producer writes are refused.
  for (const field of ['suggestions', 'flips', 'brain_check.checks', 'roster.bye_holes', 'title.odds_by_week']) {
    assert.equal(schema.validateAction({ type: 'plug_in', field, view: 'table' }).ok, false, field);
    assert.equal(client.validateAction({ type: 'plug_in', field, view: 'table' }).ok, false, field);
  }
  assert.equal(schema.validateAction({ type: 'draft_message', text: 'No pressure, just floating an idea.' }).ok, true);
  assert.equal(schema.validateAction({ type: 'draft_message', text: 'This gets you 12% better odds.' }).ok, false);
  assert.equal(client.validateAction({ type: 'draft_message', text: 'This gets you 12% better odds.' }).ok, false);
  assert.equal(schema.validateAction({ type: 'set_tolerance', key: 'max_assets', value: 99 }).ok, false);
  assert.equal(client.validateAction({ type: 'set_tolerance', key: 'max_assets', value: 99 }).ok, false);
});

/* ------------------------------------------------------------ dispatcher */
test('the dispatcher applies focus_panel, filter and undo', () => {
  let s = client.newSession();
  let r = client.dispatch(s, { type: 'focus_panel', panel: 'flip_map', league: 3 }, CTX, 'show flip map for league 3');
  assert.equal(r.outcome.status, 'applied');
  assert.equal(r.session.ui.league, 3);
  assert.equal(r.session.ui.main, 'flip_map');
  s = r.session;

  r = client.dispatch(s, { type: 'filter', panel: 'flip_map', position: 'RB' }, CTX, 'only RBs');
  assert.equal(r.outcome.status, 'applied');
  assert.equal(r.session.ui.filters.flip_map, 'RB');
  s = r.session;

  const u = client.undo(s, CTX, 'undo');
  assert.equal(u.outcome.status, 'undone');
  assert.equal(u.session.ui.filters.flip_map, undefined, 'the filter is gone');
  assert.equal(u.session.ui.main, 'flip_map', 'the focus stays: one undo reverts one change');
  const u2 = client.undo(u.session, CTX);
  assert.equal(u2.session.ui.league, null);
  assert.equal(client.undo(u2.session, CTX).outcome.status, 'refused', 'nothing left to undo');

  const logged = u2.session.log.map(l => `${l.type}:${l.outcome}`);
  assert.deepEqual(logged, ['undo:undone', 'undo:undone', 'filter:applied', 'focus_panel:applied'], 'every action is logged');
});

test('the dispatcher refuses an unknown action and a league that is not on the switcher, changing nothing', () => {
  const s = client.newSession();
  const r = client.dispatch(s, { type: 'send_offer', to: '7' }, CTX, 'send it');
  assert.equal(r.outcome.status, 'refused');
  assert.deepEqual(r.session.ui, s.ui);
  assert.equal(r.session.history.length, 0);
  assert.equal(r.session.log[0].outcome, 'refused');
  const r2 = client.dispatch(s, { type: 'focus_panel', panel: 'flip_map', league: 9 }, CTX);
  assert.equal(r2.outcome.status, 'refused');
  assert.equal(r2.session.ui.league, null);
});

test('next advances the swipe deck and refuses past the end', () => {
  let s = client.newSession();
  const r = client.dispatch(s, { type: 'next' }, CTX);
  assert.equal(r.outcome.status, 'applied');
  assert.equal(r.session.ui.deck.current, 1);
  assert.match(client.coachFooter(PLANS, r.session.ui).next_move, /Team 2/);
  assert.equal(client.dispatch(r.session, { type: 'next' }, CTX).outcome.status, 'refused');
});

/* ----------------------------------------------------- confirm gate */
test('a plan-changing action does nothing until Nick taps Confirm', () => {
  const s = client.newSession();
  const r = client.dispatch(s, { type: 'set_risk_mode', mode: 'all_in' }, CTX, 'go fuck-it mode');
  assert.equal(r.outcome.status, 'previewed');
  assert.deepEqual(r.session.ui, s.ui, 'the screen and plan are unchanged');
  assert.equal(r.session.history.length, 0);
  assert.equal(r.session.pending.preview.status, 'ok');
  assert.equal(r.session.pending.preview.value.net.value, 0.009, 'the preview is the engine row, read not computed');

  // Asking something else drops the preview: still nothing changed.
  const other = client.dispatch(r.session, { type: 'filter', panel: 'flip_map', position: 'WR' }, CTX);
  assert.equal(other.session.pending, null);
  assert.equal(other.session.ui.replanning.length, 0);

  const c = client.confirm(r.session, CTX);
  assert.equal(c.outcome.status, 'confirmed');
  assert.deepEqual(c.request, { kind: 'mode.set', payload: { mode: 'all_in', until_week: null } });
  assert.equal(c.session.ui.replanning.length, 1);

  const none = client.confirm(client.newSession(), CTX);
  assert.equal(none.request, null, 'no pending preview, no request');
});

test('a change the planner has not priced previews as "not computed yet", never a made-up number', () => {
  const r = client.dispatch(client.newSession(),
    { type: 'add_stop', stop: { kind: 'get', label: 'Get a TE', player_id: 'p3' } }, CTX);
  assert.equal(r.session.pending.preview.status, 'unknown');
  assert.match(r.session.pending.preview.reason, /not computed yet/);
  assert.equal(r.session.pending.preview.key, 'add:get:p3');
});

test('undo after a recorded plan change asks the hook to retract that request', () => {
  const r = client.dispatch(client.newSession(), { type: 'set_risk_mode', mode: 'safe' }, CTX);
  const c = client.confirm(r.session, CTX);
  const marked = client.markRecorded(c.session, 42);
  const u = client.undo(marked, CTX);
  assert.equal(u.retractRequestId, 42);
});

test('the server refuses a Coach-proposed plan request that Nick did not confirm', () => {
  const unconfirmed = schema.validateRequest('mode.set', { mode: 'all_in' }, { source: 'coach', confirmed: false });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.error, /Confirm/);
  assert.equal(schema.validateRequest('mode.set', { mode: 'all_in' }, { source: 'coach', confirmed: true }).ok, true);
  assert.equal(schema.validateRequest('offer.sent', { move_id: 'm1' }, { source: 'coach' }).ok, true, 'a log is not a plan change');
});

/* ------------------------------------------------------- Coach tools */
test('Coach returns a valid action for "show flip map for league 3"', () => {
  const routed = routeIntent('show flip map for league 3');
  assert.deepEqual(routed, { tool: 'warroom_view', input: { type: 'focus_panel', panel: 'flip_map', league: 3 } });
  const { action, entry, summary } = runCoachTool(routed.tool, routed.input, { ledger: newLedger() });
  assert.equal(entry, null, 'a UI action is not evidence and does not enter the ledger');
  assert.deepEqual(action, { type: 'focus_panel', panel: 'flip_map', league: 3 });
  assert.equal(schema.validateAction(action).ok, true);
  assert.equal(client.validateAction(action).ok, true);
  assert.match(summary.note, /undo/);
});

test('Coach UI tools refuse what the schema refuses, and a send is refused outright', () => {
  assert.throws(() => runCoachTool('warroom_view', { type: 'set_risk_mode', mode: 'all_in' }, {}), CoachToolError);
  assert.throws(() => runCoachTool('warroom_plug_in', { type: 'plug_in', field: 'users.token', view: 'number' }, {}), CoachToolError);
  assert.ok(routeIntent('send the offer to team 7').refuse);
  const plan = runCoachTool('warroom_plan_change', { type: 'set_risk_mode', mode: 'all_in', until_week: 6 }, {});
  assert.match(plan.summary.note, /Confirm/);
});

test('War Room tools are declared only on a War Room turn; every other surface keeps today\'s list', () => {
  assert.equal(toolDefinitions().length, COACH_TOOLS.length);
  assert.equal(toolDefinitions({ warRoom: true }).length, COACH_TOOLS.length + WARROOM_TOOLS.length);
});

const usage = { input_tokens: 10, output_tokens: 5 };
const says = o => ({ content: [{ type: 'text', text: JSON.stringify(o) }], stop_reason: 'end_turn', usage });
const toolUse = (name, input, id = 'tu1') => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage });
function scripted(...replies) {
  const sent = []; let turn = 0;
  return { sent, messages: { create: async body => { sent.push(body); const r = replies[turn++];
    if (!r) throw new Error(`out of replies at turn ${turn}`); return r; } } };
}

test('askCoach from the War Room: a screen command needs no model call', async () => {
  const stub = scripted();
  setAnthropicClientForTesting(stub);
  const res = await withFlag(() => askCoach({ question: 'show flip map for league 3', context: { surface: 'war_room' } }));
  assert.equal(stub.sent.length, 0, 'no model call');
  assert.deepEqual(res.actions, [{ type: 'focus_panel', panel: 'flip_map', league: 3 }]);
  assert.equal(res.cost_usd, 0);
});

test('askCoach with the flag off is today\'s Coach: no War Room tools, no fast path', async () => {
  const stub = scripted(says({ claims: [], refusals: ['Coach does not read that.'], as_of: null }));
  setAnthropicClientForTesting(stub);
  const res = await askCoach({ question: 'show flip map for league 3', context: { surface: 'war_room' } });
  assert.equal(stub.sent.length, 1);
  assert.ok(!stub.sent[0].tools.some(t => t.name.startsWith('warroom_')));
  assert.deepEqual(res.actions, []);
});

test('verify.js still blocks an invented number, even on a War Room turn that returned an action', async () => {
  // Direct: the grounding rule is unchanged.
  const ledger = newLedger();
  const v = verifyAnswer({ ledger, answer: { claims: [{ text: 'All-in lifts your title odds to 19.2%.', cites: [] }] } });
  assert.equal(v.ok, false);
  const ledger2 = newLedger();
  ledger2.record({ sql: 'SELECT 1', params: [], tables: ['players'], columns: ['n'], rows: [{ n: 11 }], row_count: 1, truncated: false, provenance: {} });
  const v2 = verifyAnswer({ ledger: ledger2, answer: { claims: [{ text: 'All-in adds 4 title points.', cites: ['r1#0.n'] }] } });
  assert.equal(v2.ok, false);
  assert.equal(v2.violations[0].kind, VIOLATIONS.UNGROUNDED_NUMBER);

  // Through askCoach: a tool action does not launder an invented number.
  const invented = says({ claims: [{ text: 'Switching gets you 4.2 more title points.', cites: ['r1#0.n'] }], refusals: [], as_of: null });
  setAnthropicClientForTesting(scripted(
    toolUse('warroom_plan_change', { type: 'set_risk_mode', mode: 'all_in' }),
    invented, invented));
  const res = await withFlag(() => askCoach({ question: 'what if we go all in and swing big this week?', context: { surface: 'war_room' } }));
  assert.deepEqual(res.actions, [{ type: 'set_risk_mode', mode: 'all_in', until_week: null }]);
  assert.equal(res.answer.claims.length, 0, 'the invented number never ships');
  assert.ok(res.answer.refusals.some(r => /4\.2/.test(r)));
});

test('a War Room turn answered only by an action is not "silence"', async () => {
  setAnthropicClientForTesting(scripted(
    toolUse('warroom_plug_in', { type: 'plug_in', field: 'destination.path', view: 'sparkline' }),
    says({ claims: [], refusals: [], as_of: null })));
  const res = await withFlag(() => askCoach({ question: 'chart my title odds by week please', context: { surface: 'war_room' } }));
  assert.equal(res.verification.ok, true);
  assert.equal(res.actions[0].type, 'plug_in');
});

/* ------------------------------------------------------------ footer */
test('every Coach reply footer carries destination, stops left and next move', () => {
  const f = client.coachFooter(PLANS, client.newSession().ui);
  assert.equal(f.destination, 'Score 140 projected points a week by week 7', 'goal and arrive_by are typed fields');
  assert.equal(f.stops_left, '3');
  assert.equal(f.next_move, 'send Team 7 M. Oduya (WR) + T. Kline (TE) for C. Ruiz (RB)', 'the deal is the move\'s first step');
  assert.match(f.text, /^Destination: .+ \/ Stops left: .+ \/ Next move: .+$/);
  const empty = client.coachFooter(null);
  assert.equal(empty.text, 'Destination: no goal set yet / Stops left: not computed yet / Next move: not computed yet');
});

test('plug_in reads a whitelisted field through Field wrappers, and nothing else', () => {
  assert.equal(client.readField(PLANS, 'destination.title_now'), 0.118, 'steps into each typed field');
  assert.deepEqual(client.readField(PLANS, 'flip_map'), PLANS.flip_map.value);
  assert.deepEqual(client.readField(PLANS, 'brain_report.checks'), PLANS.brain_report.value.checks);
  assert.equal(client.readField({ destination: { status: 'unknown', source: 'sim.title', reason: 'x' } }, 'destination.title_now'), undefined);
  assert.equal(client.readField({ destination: { status: 'failed', source: 'sim.title', reason: 'x' } }, 'destination.title_now'), undefined);
  // A field that failed its check is hidden even if a value leaked into it.
  assert.equal(client.readField({ destination: { status: 'ok', source: 'campaign.plan',
    value: { title_now: { status: 'failed', source: 'sim.title', reason: 'x', value: 0.5 } } } }, 'destination.title_now'), null);
  assert.equal(client.readField({ secrets: { k: 1 } }, 'secrets.k'), undefined);
});

/* ------------------------------------------------------- WR-3 route */
test('flag off: every War Room route answers { enabled: false } and records nothing', async () => {
  const res = await call('POST', '/61/requests', { kind: 'offer.sent', payload: { move_id: 'm1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false });
  assert.equal(row('SELECT COUNT(*) n FROM warroom_requests').n, 0);
});

test('the WR-3 route records each of Nick\'s inputs and only records', () => withFlag(async () => {
  const inputs = [
    ['objective.set', { goal: 'get_player', player_id: 'p2', arrive_by: 7 }],
    ['target.approve', { player_id: 'p2', source: 'own' }],
    ['offer.sent', { move_id: 'm1' }],
    ['offer.reply', { move_id: 'm1', reply: 'decline', decline_reason: 'wants_more' }],
    ['deck.skip', { move_id: 'm2', reason: 'cost' }],
    ['mode.set', { mode: 'safe' }],
    ['tolerance.set', { key: 'max_offers_per_manager_week', value: 2 }],
    ['stop.add', { stop: { kind: 'cover_bye', label: 'Cover the TE bye', week: 9 } }],
    ['stop.remove', { stop_id: 's2' }]
  ];
  for (const [kind, payload] of inputs) {
    const res = await call('POST', '/61/requests', { kind, payload });
    assert.equal(res.status, 201, `${kind}: ${await res.clone().text()}`);
    const body = await res.json();
    assert.equal(body.request.kind, kind);
    assert.equal(body.request.consumed_at, null, 'the route never consumes; the producer does');
  }
  const list = await (await call('GET', '/61/requests')).json();
  assert.equal(list.requests.length, inputs.length);

  const bad = await call('POST', '/61/requests', { kind: 'offer.send_to_manager', payload: {} });
  assert.equal(bad.status, 400);
  const unconfirmed = await call('POST', '/61/requests', { kind: 'mode.set', payload: { mode: 'all_in' }, source: 'coach' });
  assert.equal(unconfirmed.status, 400);
  const confirmed = await call('POST', '/61/requests', { kind: 'mode.set', payload: { mode: 'all_in' }, source: 'coach', confirmed: true });
  assert.equal(confirmed.status, 201);

  // "I sent it" can be taken back inside ten minutes.
  const sent = list.requests.find(r => r.kind === 'offer.sent');
  const retract = await call('POST', '/61/requests', { kind: 'retract', payload: { request_id: sent.id } });
  assert.equal(retract.status, 201);

  const outsider = await call('POST', '/61/requests', { kind: 'offer.sent', payload: { move_id: 'm1' } }, 'wr-other');
  assert.equal(outsider.status, 403, 'a user outside the league cannot write to it');
}));

test('layouts are saved per user and versioned; the action log refuses unknown actions', () => withFlag(async () => {
  assert.equal((await (await call('GET', '/layout')).json()).saved, null);
  await call('PUT', '/layout', { layout: { layout: { order: ['flip_map'], large: [] }, pins: [], cards: [] } });
  const second = await (await call('PUT', '/layout', { layout: { layout: { order: ['targets'], large: [] }, pins: [], cards: [] } })).json();
  assert.equal(second.saved.version, 2);
  assert.deepEqual((await (await call('GET', '/layout')).json()).saved.layout.layout.order, ['targets']);
  assert.equal((await (await call('GET', '/layout', undefined, 'wr-other')).json()).saved, null, 'layouts are per user');

  const ok = await (await call('POST', '/61/action-log', { action: { type: 'filter', panel: 'flip_map', position: 'RB' }, outcome: 'applied', asked: 'only RBs' })).json();
  assert.equal(ok.logged.outcome, 'applied');
  const unknown = await (await call('POST', '/61/action-log', { action: { type: 'send_offer' }, outcome: 'applied', asked: 'send it' })).json();
  assert.equal(unknown.logged.outcome, 'refused', 'an unknown action is logged as refused, never as applied');
}));
