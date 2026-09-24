/**
 * FIX-230-1: the WR-3 tap controls in the War Room.
 *
 *  - ObjectiveSheet (title / playoffs / get player / points) posts ONE objective.set;
 *  - RiskModeSheet posts nothing until its Confirm, then ONE mode.set;
 *  - AddStopSheet shows the producer's stop_tradeoffs entry (or "Trade-off not computed
 *    yet", never a made-up number) BEFORE Confirm exists, then posts ONE stop.add; with
 *    no preview on screen it posts nothing;
 *  - ToleranceSliders posts ONE tolerance.set per Save;
 *  - ReplyTable's counter form posts ONE offer.reply carrying the counter note;
 *  - Undo inside 10 minutes posts ONE retract for that request id; after 10 it posts nothing.
 *
 * The mocked post counts every call and forwards it to the real /api/warroom route over a
 * real migrated database, so every payload is one the server's validator accepts.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-controls-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
process.env.GRIDIRON_WARROOM_ENABLED = '1';

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const { validateRequest } = await import('../server/services/warroom-actions/schema.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7301, 'controls-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (7301, ?, datetime('now','+1 day'))`,
  hashSessionToken('controls-token'));
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (63, 'espn', 'wr-63', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-24 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (63, 7301, 'member')`);

const app = express();
app.use(express.json());
app.use('/api/warroom', requireAuthenticated, warroomRouter);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const wr = await loadWarRoom();
test.after(() => {
  server.close(); wr.cleanup(); delete process.env.GRIDIRON_WARROOM_ENABLED;
  fs.rmSync(temp, { recursive: true, force: true });
});

/** A mocked post: counts each call, then answers it with the real route (throws on a non-2xx). */
function mockPost() {
  const calls = [];
  const post = async (p, init) => {
    calls.push({ path: p, method: init.method, body: JSON.parse(init.body) });
    const res = await fetch(`${origin}/api${p}`, { ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer controls-token' } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  };
  return { calls, post };
}
const stored = () => rows(`SELECT id, kind, payload FROM warroom_requests WHERE league_id = 63 ORDER BY id`)
  .map(r => ({ ...r, payload: JSON.parse(r.payload) }));

const PLANS = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/ui-contract-plans.json', import.meta.url), 'utf8')).leagues[0];
const NO_TRADEOFFS = { ...PLANS, stop_tradeoffs: undefined };

const req = await wr.mod('requests');
const controls = await wr.mod('controls');
const { default: ObjectiveSheet } = await wr.mod('ObjectiveSheet');
const { default: RiskModeSheet } = await wr.mod('RiskModeSheet');
const { default: AddStopSheet } = await wr.mod('AddStopSheet');
const { default: ToleranceSliders } = await wr.mod('ToleranceSliders');
const { CounterForm } = await wr.mod('ReplyTable');
const { deckReducer, initialDeck } = await wr.mod('deck');

const html = (C, props) => renderToStaticMarkup(React.createElement(C, props));
const noop = async () => { throw new Error('a render must not post'); };

test('objective: one Set goal posts exactly one objective.set, for every goal kind', async () => {
  const { calls, post } = mockPost();
  const rec = await controls.sendAction({ type: 'set_objective', goal: 'points', points_per_week: 120, arrive_by: 12 }, 63, post);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: '/warroom/63/requests', method: 'POST',
    body: { kind: 'objective.set', payload: { goal: 'points', points_per_week: 120, arrive_by: 12 }, source: 'nick' } });
  assert.ok(Number.isInteger(rec.id) && rec.kind === 'objective.set', 'the stored row id comes back for Undo');
  for (const goal of ['title', 'playoffs']) assert.ok(validateRequest('objective.set', req.objectiveSet({ goal }).payload).ok, goal);
  assert.ok(validateRequest('objective.set', req.objectiveSet({ goal: 'get_player', player_id: '702' }).payload).ok);

  await assert.rejects(controls.sendAction({ type: 'set_objective', goal: 'points' }, 63, post), /points/);
  assert.equal(calls.length, 1, 'an incomplete objective posts nothing');

  const text = textOf(html(ObjectiveSheet, { plans: PLANS, names: PLANS.names, onRecord: noop, onClose() {} }));
  for (const label of ['Win the title', 'Make the playoffs', 'Get a player', 'Points per week']) assert.match(text, new RegExp(label));
  assert.match(text, /Set goal/);
});

test('risk mode: choosing a mode posts nothing; Confirm posts exactly one mode.set', async () => {
  const { calls, post } = mockPost();
  const review = controls.reviewOf({ type: 'set_risk_mode', mode: 'all_in' }, PLANS);
  assert.equal(review.phase, 'review');
  assert.equal(calls.length, 0, 'the review step posts nothing');
  assert.equal(await controls.confirmReview(controls.EDIT, 63, post), null);
  assert.equal(calls.length, 0, 'Confirm from the edit step posts nothing');

  const edit = html(RiskModeSheet, { plans: PLANS, onRecord: noop, onClose() {} });
  assert.doesNotMatch(edit, />Confirm</, 'no Confirm before the review step');
  assert.match(textOf(edit), /Review/);
  const shown = textOf(html(RiskModeSheet, { plans: PLANS, onRecord: noop, onClose() {}, initial: review }));
  assert.match(shown, /Switch to all-in/, "the producer's mode:all_in trade-off is on screen");
  assert.match(shown, /Confirm/);

  const rec = await controls.confirmReview(review, 63, post);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { kind: 'mode.set', payload: { mode: 'all_in', until_week: null }, source: 'nick' });
  assert.equal(rec.kind, 'mode.set');
});

test('add stop: the stop_tradeoffs preview renders before Confirm exists; one Confirm posts one stop.add', async () => {
  const stop = { kind: 'get', label: 'Get N. Whitfield (WR)', player_id: '702' };
  const edit = html(AddStopSheet, { plans: PLANS, names: PLANS.names, onRecord: noop, onClose() {} });
  assert.doesNotMatch(edit, />Confirm</, 'Confirm is not rendered before the preview');
  assert.match(textOf(edit), /Show the trade-off/);

  const review = controls.reviewOf({ type: 'add_stop', stop }, PLANS);
  assert.equal(review.preview.key, 'add:get:702');
  assert.equal(review.preview.status, 'ok');
  const shown = textOf(html(AddStopSheet, { plans: PLANS, names: PLANS.names, onRecord: noop, onClose() {}, initial: review }));
  assert.match(shown, /Costs: 0\.6 pts, 1 extra step\(s\)/);
  assert.match(shown, /Net: -0\.2 pts: not worth it/);
  assert.ok(shown.indexOf('Costs:') < shown.lastIndexOf('Confirm'), 'the preview comes before Confirm');

  // No stop_tradeoffs key: it says so, with no number.
  const blind = controls.reviewOf({ type: 'add_stop', stop }, NO_TRADEOFFS);
  assert.equal(blind.preview.status, 'unknown');
  const blindText = textOf(html(AddStopSheet, { plans: NO_TRADEOFFS, names: PLANS.names, onRecord: noop, onClose() {}, initial: blind }));
  assert.match(blindText, /Trade-off not computed yet/);
  assert.doesNotMatch(blindText.slice(blindText.indexOf('Trade-off not computed yet')), /\d/, 'no made-up number in the preview');

  const { calls, post } = mockPost();
  assert.equal(await controls.confirmReview(controls.EDIT, 63, post), null);
  assert.equal(await controls.confirmReview({ phase: 'review', action: { type: 'add_stop', stop }, preview: null }, 63, post), null);
  assert.equal(calls.length, 0, 'no preview on screen, no post');

  await controls.confirmReview(review, 63, post);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { kind: 'stop.add', payload: { stop }, source: 'nick' });
  const last = stored().at(-1);
  assert.deepEqual(last.payload, { stop: { ...stop, week: null } });
});

test('tolerance: one Save posts exactly one tolerance.set; out of range posts nothing', async () => {
  const { calls, post } = mockPost();
  await controls.sendAction({ type: 'set_tolerance', key: 'max_assets', value: 4 }, 63, post);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { kind: 'tolerance.set', payload: { key: 'max_assets', value: 4 }, source: 'nick' });
  await assert.rejects(controls.sendAction({ type: 'set_tolerance', key: 'max_assets', value: 11 }, 63, post), /max_assets/);
  assert.equal(calls.length, 1);

  const out = html(ToleranceSliders, { tolerances: PLANS.destination.value.tolerances, onRecord: noop });
  assert.equal((out.match(/type="range"/g) ?? []).length, 5, 'one slider per CAMPAIGN-01d tolerance');
  assert.match(textOf(out), /Max assets/);
});

test('counter form: one Log counter posts exactly one offer.reply with the counter note', async () => {
  const s = deckReducer(initialDeck(), { type: 'reply', card: 'L1-m1', reply: 'counter', note: 'wants my second-round pick', at: 1 });
  assert.deepEqual(s.outbox, [{ kind: 'offer.reply', payload: { move_id: 'L1-m1', reply: 'counter', counter_note: 'wants my second-round pick' } }]);
  const { calls, post } = mockPost();
  assert.equal(await req.flushOutbox(63, s.outbox, 0, post), 1);
  assert.equal(calls.length, 1);
  assert.equal(stored().at(-1).payload.counter_note, 'wants my second-round pick', 'the server kept the note');

  const form = textOf(html(CounterForm, { onSubmit() {}, onCancel() {} }));
  assert.match(form, /What did he counter with/);
  assert.match(form, /Log counter/);
});

test('Undo inside 10 minutes posts one retract for that id; after 10 minutes it posts nothing', async () => {
  const { calls, post } = mockPost();
  const t0 = Date.now();
  const rec = await req.recordWarRoomRequest(63, req.modeSet('safe'), post, t0);
  assert.equal(calls.length, 1);
  assert.equal(req.canUndo(rec, t0 + 9 * 60_000), true);
  const done = await req.undoWarRoomRequest(63, rec, post, t0 + 60_000);
  assert.equal(done.posted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { kind: 'retract', payload: { request_id: rec.id }, source: 'nick' });
  assert.equal(stored().at(-1).kind, 'retract', 'the server accepted the take-back');

  const late = await req.recordWarRoomRequest(63, req.toleranceSet('ai_spend', 20), post, t0);
  assert.equal(req.canUndo(late, t0 + 10 * 60_000 + 1), false);
  const expired = await req.undoWarRoomRequest(63, late, post, t0 + 11 * 60_000);
  assert.equal(expired.posted, false);
  assert.match(expired.reason, /10-minute/);
  assert.equal(calls.length, 3, 'no retract after the window');
});

test('a failed post rejects with its cause (the sheet shows it); nothing is swallowed', async () => {
  const failing = async () => { throw new Error('HTTP 500'); };
  await assert.rejects(req.recordWarRoomRequest(63, req.modeSet('safe'), failing), /HTTP 500/);
  await assert.rejects(req.recordWarRoomRequest(63, req.modeSet('safe'), async () => ({ enabled: false })),
    /War Room is off|not recorded/i, 'a flag-off answer is not a success');
});

test('the War Room wires the sheets in, and the WR-3 placeholders are gone', async () => {
  const src = fs.readFileSync(path.join(WARROOM_DIR, 'WarRoom.tsx'), 'utf8');
  for (const m of ['ObjectiveSheet', 'RiskModeSheet', 'AddStopSheet']) assert.match(src, new RegExp(`import ${m} from './${m}'`));
  for (const f of ['TopStrip.tsx', 'Itinerary.tsx']) {
    assert.doesNotMatch(fs.readFileSync(path.join(WARROOM_DIR, f), 'utf8'), /is Coach's \(FIX-06\)/, f);
  }
  const { default: WarRoom } = await wr.mod('WarRoom');
  const view = buildWarRoomView(1, { status: 'ok', entries: [{ ...PLANS, league: 1 }], as_of: 'x', id: 'y' }, { enabled: true, preview: false });
  const out = renderToStaticMarkup(React.createElement(WarRoom, { view, leagues: [{ id: 1, name: 'League 1' }], activeId: 1, onLeague() {}, onExit() {} }));
  assert.match(out, /Change goal/);
  assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*>\+ Add a stop/, 'Add a stop is live');
  assert.match(out, /aria-label="Change risk mode"/);
});
