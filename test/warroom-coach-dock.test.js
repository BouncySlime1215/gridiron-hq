/**
 * FIX-06: Coach docks in the War Room and reads the plans contract.
 *
 *  - WarRoom.tsx mounts useWarRoomCoach + coach/CoachDock (the #231 placeholder is gone),
 *    passing the War Room view as `plans`;
 *  - a Coach add_stop on a contract league with stop_tradeoffs['add:get:<id>'] renders the
 *    producer's cost / gain / net preview, and Confirm writes exactly one stop.add request
 *    with confirmed = 1 (through the real hook, the real route and the real table);
 *  - skip and decline reasons are one list, owned by plans-schema.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf, WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-dock-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_WARROOM_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const schema = await import('../server/services/warroom-actions/schema.js');
const plansSchema = await import('../server/services/campaign/plans-schema.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7201, 'dock-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (7201, ?, datetime('now','+1 day'))`,
  hashSessionToken('dock-token'));
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (62, 'espn', 'wr-62', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-24 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (62, 7201, 'member')`);

const app = express();
app.use(express.json());
app.use('/api/warroom', requireAuthenticated, warroomRouter);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const wr = await loadWarRoom();
test.after(() => { server.close(); wr.cleanup(); delete globalThis.__warRoomApiCall; fs.rmSync(temp, { recursive: true, force: true }); });

/** The client's api() in these tests: the real /api/warroom route, signed in. */
globalThis.__warRoomApiCall = async (p, opts = {}) => {
  const res = await fetch(`${origin}/api${p}`, { ...opts,
    headers: { 'content-type': 'application/json', authorization: 'Bearer dock-token', ...opts.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
};

const PLANS = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/coach-contract-plans.json', import.meta.url), 'utf8')).leagues[0];
const { default: CoachDock } = await wr.mod('coach/CoachDock');
const { useWarRoomCoach } = await wr.mod('coach/useWarRoomCoach');
const client = await wr.mod('coach/warroomCoach');

const ADD = { type: 'add_stop', stop: { kind: 'get', label: 'Get N. Whitfield (WR)', player_id: '702' } };

/** Render the real hook once and hand back what it returned. */
function mountCoach(plans) {
  let coach = null;
  const Probe = () => { coach = useWarRoomCoach({ leagueId: 62, leagues: [62], plans }); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  return coach;
}

test("add_stop on a league with stop_tradeoffs['add:get:<id>'] renders the producer's cost / gain / net", () => {
  assert.ok(PLANS.stop_tradeoffs.value['add:get:702'], 'fixture carries the priced stop');
  const { session, outcome } = client.dispatch(client.newSession(), ADD, { leagues: [62], plans: PLANS });
  assert.equal(outcome.status, 'previewed');
  assert.equal(session.pending.preview.status, 'ok');
  assert.equal(session.pending.preview.key, 'add:get:702');

  const coach = { ...mountCoach(PLANS), session, pending: session.pending, log: session.log };
  const text = textOf(renderToStaticMarkup(React.createElement(CoachDock, { coach })));
  assert.match(text, /Trade-off before anything changes/);
  assert.match(text, /Get N\. Whitfield \(WR\)/);
  assert.match(text, /Costs: 0\.6 pts, 1 extra step\(s\)/);
  assert.match(text, /Gains: 0\.4 pts/);
  assert.match(text, /Net: -0\.2 pts: not worth it/);
  assert.match(text, /Because he costs the tight end/);
  assert.match(text, /Next move stays the same/);
  assert.doesNotMatch(text, /not computed yet|NaN|undefined/);
  assert.match(text, /Confirm/);
});

test('Confirm writes exactly one stop.add request with confirmed = 1', async () => {
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  try {
    const coach = mountCoach(PLANS);
    assert.equal(coach.apply(ADD, 'add a stop: get Whitfield').status, 'previewed');
    assert.equal(rows(`SELECT id FROM warroom_requests WHERE league_id = 62`).length, 0, 'a preview records nothing');
    await coach.confirm();
    const got = rows(`SELECT kind, payload, source, confirmed FROM warroom_requests WHERE league_id = 62`);
    assert.equal(got.length, 1);
    assert.deepEqual({ ...got[0], payload: JSON.parse(got[0].payload) }, {
      kind: 'stop.add', source: 'coach', confirmed: 1,
      payload: { stop: { kind: 'get', label: 'Get N. Whitfield (WR)', player_id: '702', week: null } }
    });
    await coach.confirm();
    assert.equal(rows(`SELECT id FROM warroom_requests WHERE league_id = 62`).length, 1, 'a second Confirm with nothing pending records nothing');
  } finally { delete process.env.GRIDIRON_WARROOM_ENABLED; }
});

test('the War Room mounts the real Coach dock, and the placeholder is gone', () => {
  assert.equal(fs.existsSync(path.join(WARROOM_DIR, 'CoachDock.tsx')), false, "#231's placeholder dock is deleted");
  const src = fs.readFileSync(path.join(WARROOM_DIR, 'WarRoom.tsx'), 'utf8');
  assert.match(src, /import \{ CoachDock, useWarRoomCoach[^}]*\} from '\.\/coach'/);
  assert.match(src, /useWarRoomCoach\(\{[^}]*plans: view/);
  return (async () => {
    const { default: WarRoom } = await wr.mod('WarRoom');
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/war-room-plans.json', import.meta.url), 'utf8'));
    const view = buildWarRoomView(1, { status: 'ok', entries: fixture, as_of: 'x', id: 'y' }, { enabled: true, preview: true });
    const html = renderToStaticMarkup(React.createElement(WarRoom, { view, leagues: [{ id: 1, name: 'League 1' }], activeId: 1, onLeague() {}, onExit() {} }));
    assert.match(html, /class="wr-coach/);
    assert.match(html, /aria-label="Ask Coach"/);
    assert.doesNotMatch(html, /<input[^>]*disabled[^>]*aria-label="Ask Coach"|Not built yet|Coach turns on with WR-COACH/);
  })();
});

test('Coach focus_panel names map onto the War Room grid', async () => {
  const { COACH_PANEL_AREA, PANELS } = await wr.mod('WarRoom');
  assert.deepEqual(Object.keys(COACH_PANEL_AREA).sort(), [...client.PANELS].sort());
  const areas = new Set(PANELS.map(p => p.id));
  for (const a of Object.values(COACH_PANEL_AREA)) if (a) assert.ok(areas.has(a), a);
});

test('skip and decline reasons are one list, owned by plans-schema.js', async () => {
  assert.deepEqual([...schema.SKIP_REASONS], ['player', 'cost', 'manager', 'not_now']);
  assert.equal(schema.SKIP_REASONS, plansSchema.SKIP_REASONS);
  assert.equal(schema.DECLINE_REASONS, plansSchema.DECLINE_REASONS);
  const { SKIP_REASONS: deck } = await wr.mod('deck');
  assert.deepEqual(deck.map(r => r.id), [...plansSchema.SKIP_REASONS], "the deck's skip buttons send the shared ids");
  assert.equal(schema.validateRequest('deck.skip', { move_id: 'L1-m2', reason: 'cost' }).ok, true);
  assert.equal(schema.validateRequest('deck.skip', { move_id: 'L1-m2', reason: 'costs_too_much' }).ok, false);
});

test('store.js reads the War Room switch only through warroom-flag.js', () => {
  const store = fs.readFileSync(new URL('../server/services/warroom-actions/store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /process\.env|previewUnconfirmed/, 'no second reader of the switch');
  assert.match(store, /from '\.\.\/warroom-flag\.js'/);
});
