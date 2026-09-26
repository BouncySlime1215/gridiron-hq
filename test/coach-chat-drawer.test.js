/**
 * COACH-CHAT, the drawer: the REAL useWarRoomCoach + CoachDrawer, rendered in a DOM,
 * talking to the REAL coach and War Room routes (no model key, fixture plans).
 *
 * Pinned here:
 *   - an empty conversation opens on the starter questions; "New" is disabled with a reason
 *   - an answer shows as chat bubbles (Nick's question, Coach's grounded reply), with no
 *     footer line in it and no raw engine label, then 2-3 follow-up chips and the action
 *     cards (I sent it with Copy message, Skip this card), each saying what changes and
 *     that Nick's rules stay on
 *   - the thinking animation shows while Coach answers
 *   - a follow-up chip continues the same conversation
 *   - the conversation survives unmounting (closing, navigating, reloading): a fresh mount
 *     reads it back from the server
 *   - "I sent it" records offer.sent from source coach only on the tap, and says so
 *   - "New" empties the conversation and the starters come back
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDom, domRenderer, click, textOf, byAttr, one, all, waitFor } from './helpers/warroom-render.js';

installDom();

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-chat-drawer-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
process.env.GRIDIRON_WARROOM_ENABLED = '1';
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), process.env.GRIDIRON_WARROOM_PLANS);

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');
const { default: coachRouter } = await import('../server/routes/coach.js');

const modelCalls = [];
setAnthropicClientForTesting({ messages: { create: async body => { modelCalls.push(body); throw new Error('no model calls here'); } } });

const USER = 7601, TOKEN = 'chat-drawer-token';
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, 'chat-drawer', 'Reader')`, USER);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`, USER, hashSessionToken(TOKEN));
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'cd-4', 2026, NULL, '1', 4, 1, '{}', '2026-09-24 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (4, ?, 'member')`, USER);

const app = express();
app.use(express.json());
app.use('/api/warroom', requireAuthenticated, warroomRouter);
app.use('/api/coach', coachRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const calls = [];
let hold = null;
async function api(p, opts = {}) {
  if (p === '/coach/ask' && hold) await hold;
  const res = await fetch(`${origin}/api${p}`, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...opts.headers } });
  const body = await res.json();
  calls.push({ path: p, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, status: res.status });
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
globalThis.__warRoomApiCall = api;
globalThis.__warRoomApi = {};

const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { CoachDrawer, useWarRoomCoach, FIXED_QUESTIONS } = await wr.mod('coach/index');

function Host() {
  const coach = useWarRoomCoach({ leagueId: 4, leagues: [4], plans: undefined, onLeagueChange() {} });
  return React.createElement(CoachDrawer, { coach, open: true, onClose() {} });
}
const mounted = [];
const open = async () => {
  const ui = mount(React.createElement(Host));
  mounted.push(ui);
  await waitFor(() => calls.some(c => c.path === '/coach/thread/4'), 3000, 'the thread read');
  await new Promise(r => setTimeout(r, 30));
  return { ui, drawer: one(ui.container, 'data-testid', 'coach-drawer') };
};
test.after(() => {
  while (mounted.length) { try { mounted.pop().unmount(); } catch { /* gone */ } }
  server.close(); wr.cleanup(); setAnthropicClientForTesting(null);
  delete globalThis.__warRoomApiCall; delete globalThis.__warRoomApi;
  fs.rmSync(temp, { recursive: true, force: true });
});

const bubbles = drawer => all(drawer, e => /^coach-msg-(me|coach)$/.test(e.getAttribute?.('data-testid') ?? ''));
const ENGINE = /\b[a-z]+_[a-z_]+\b|\bnone:|\.js\b|claude-|\$\d/;

test('an empty conversation shows the starters; an answer is bubbles, chips and action cards', async () => {
  const { drawer } = await open();
  assert.deepEqual(byAttr(drawer, 'data-testid', 'coach-fixed-q').map(textOf), [...FIXED_QUESTIONS]);
  const fresh = one(drawer, 'data-testid', 'coach-new');
  assert.equal(fresh.hasAttribute('disabled'), true);
  assert.ok(fresh.getAttribute('title'), 'a disabled button says why');

  let release;
  hold = new Promise(r => { release = r; });
  click(all(drawer, e => e.localName === 'button' && textOf(e) === FIXED_QUESTIONS[0])[0]);
  await waitFor(() => one(drawer, 'data-testid', 'coach-thinking'), 2000, 'the thinking animation');
  hold = null; release();
  await waitFor(() => one(drawer, 'data-testid', 'coach-answer') && !one(drawer, 'data-testid', 'coach-thinking'), 5000, 'the answer');

  const b = bubbles(drawer);
  assert.deepEqual(b.map(e => e.getAttribute('data-testid')), ['coach-msg-me', 'coach-msg-coach']);
  assert.equal(textOf(b[0]), FIXED_QUESTIONS[0]);
  const answer = textOf(b[1]);
  assert.match(answer, /Send |Offer /);
  assert.doesNotMatch(answer, /Destination: /, 'no footer line in the answer');
  assert.doesNotMatch(answer.replace(/sources.*$/, ''), ENGINE, 'no raw engine labels');
  assert.equal(byAttr(drawer, 'data-testid', 'coach-fixed-q').length, 0, 'the starters give way to the thread');

  const chips = byAttr(drawer, 'data-testid', 'coach-followup');
  assert.ok(chips.length >= 2 && chips.length <= 3, 'two or three follow-up chips');
  const cards = byAttr(drawer, 'data-testid', 'coach-action-card');
  assert.equal(cards.length, 2, 'I sent it + Skip this card');
  for (const card of cards) {
    assert.match(textOf(card), /What changes/);
    assert.match(textOf(card), /Your rules/);
    assert.match(textOf(card), /Not now/);
  }
  assert.match(textOf(cards[0]), /Copy message/);
  assert.match(textOf(cards[0]), /I sent it/);
  assert.equal(modelCalls.length, 0);

  click(chips[0]);
  await waitFor(() => bubbles(drawer).length === 4 && !one(drawer, 'data-testid', 'coach-thinking'), 5000, 'the follow-up answer');
  assert.equal(textOf(bubbles(drawer)[2]), textOf(chips[0]));
  assert.equal(calls.filter(c => c.path === '/coach/ask').every(c => c.body.thread === true && c.body.league_id === 4), true);
});

test('the conversation survives a remount, "I sent it" records only on the tap, and New starts over', async () => {
  while (mounted.length) mounted.pop().unmount();
  const before = rows(`SELECT COUNT(*) AS n FROM warroom_requests WHERE kind = 'offer.sent'`)[0].n;
  const { drawer } = await open();
  await waitFor(() => bubbles(drawer).length === 4, 3000, 'the stored thread');
  assert.equal(rows(`SELECT COUNT(*) AS n FROM warroom_requests WHERE kind = 'offer.sent'`)[0].n, before, 'nothing recorded without a tap');

  // The last answer was a follow-up (why), so ask for the move again to get its cards.
  click(all(drawer, e => e.getAttribute?.('data-testid') === 'coach-followup' && /other option/i.test(textOf(e)))[0]
    ?? byAttr(drawer, 'data-testid', 'coach-followup')[0]);
  await waitFor(() => byAttr(drawer, 'data-testid', 'coach-action-card').length === 2, 5000, 'action cards');
  const sent = all(drawer, e => e.localName === 'button' && textOf(e) === 'I sent it')[0];
  click(sent);
  await waitFor(() => /Logged as sent/.test(textOf(drawer)), 3000, 'the success state');
  const rec = rows(`SELECT payload, source FROM warroom_requests WHERE kind = 'offer.sent' ORDER BY id DESC LIMIT 1`)[0];
  assert.equal(rec.source, 'coach');
  assert.ok(JSON.parse(rec.payload).move_id);

  click(one(drawer, 'data-testid', 'coach-new'));
  await waitFor(() => bubbles(drawer).length === 0 && byAttr(drawer, 'data-testid', 'coach-fixed-q').length === FIXED_QUESTIONS.length,
    3000, 'an empty conversation');
});
