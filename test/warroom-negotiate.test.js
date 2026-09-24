/**
 * NEGOTIATE-UI: the War Room's negotiation mode (WAR-ROOM-UI.md v3, new mode 1).
 *
 * Server (server/routes/warroom-negotiate.js, services/warroom-negotiate.js,
 * services/warroom-rescorer.js, migration 093):
 *  - membership before the flag; flag off answers { enabled: false }; preview says so;
 *  - "I sent it" reads the step from the served view, never the body; one open thread
 *    per move and step; the stored branches are the step's reply_table;
 *  - replies: a logged reply marks its branch live; accept/decline close the thread;
 *    a counter carries his ask; a closed thread refuses more;
 *  - the countdown comes from his reply-time distribution (ESPN answers, then chat,
 *    else the playbook's hand-set 24 h / 48 h with the reason); a counter restarts it;
 *  - Undo works for 10 minutes only;
 *  - the rescore: one world per league sync, every edit one tradeImpact against it;
 *    Nick's title-odds change, his P(yes) band and yes-point, the walk-away line.
 * Client (Negotiate.tsx, negotiate.ts, requests.ts, NextMoveDeck.tsx):
 *  - the thread renders branches, the live branch, the countdown, and the slider with
 *    the yes-point and walk-away line; an unknown walk-away says why, never 0;
 *  - the package reducer never empties a side and caps each at four;
 *  - every negotiation call posts to its one path; a sent card flips to the thread.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-negotiate-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
delete process.env.GRIDIRON_WARROOM_ENABLED;
delete process.env.GRIDIRON_WARROOM_NEGOTIATE;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { negotiateRouter } = await import('../server/routes/warroom-negotiate.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const N = await import('../server/services/warroom-negotiate.js');
const { makeRescorer, rescorerFor, __resetRescorers, SCREEN_AXIS } = await import('../server/services/warroom-rescorer.js');
const { negotiateFlag, NEGOTIATE_ENV } = await import('../server/services/warroom-flag.js');
const { PREVIEW_PREFIX } = await import('../server/services/preview-mode.js');
const express = (await import('express')).default;

const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));

/* ------------------------------------------------------------------ fixtures */

function account(subject, token) {
  run('INSERT INTO users (subject, display_name) VALUES (?, ?)', subject, subject);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`, id, hashSessionToken(token));
  return id;
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, fetched_at)
     VALUES (1, 'espn', 'neg-1', 2026, 'League A', '{"teams":[]}', 12, '1', '2026-09-24T05:00:00Z')`);
const owner = account('owner', 'owner-token');
account('stranger', 'stranger-token');
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (1, ?, 'commissioner')`, owner);

// The ESPN transaction log is created by its collector script, not a migration.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);

const ON = { enabled: true, preview: false };
const served = buildWarRoomView(1, { status: 'ok', entries: structuredClone(producer.leagues), as_of: '2026-09-24T06:00:00.000Z', id: 'plans@1',
  head: { schema: producer.schema } }, ON);
const MOVE = served.alternatives.value[0];
const STEP = MOVE.steps[0];

let NOW = Date.parse('2026-09-24T12:00:00Z');
const clock = () => NOW;
const noChat = async () => ({ missing: 'no chat corpus in the test' });

/** A fake rescorer with the real one's interface; counts its scores. */
const fakeScores = [];
const fake = {
  build_ms: 900, me: '1', axis: SCREEN_AXIS,
  score({ partner, give, get }) {
    fakeScores.push({ partner, give, get });
    if (give.includes('999')) return { problems: ['Player 999 is not on the your roster.'] };
    return {
      problems: [], ms: 74.2, runs: 1200,
      nick: {
        title_before: { status: 'ok', value: 0.42, source: 'sim.title' },
        title_after: { status: 'ok', value: 0.47, source: 'sim.title' },
        title_odds_delta: { status: 'ok', value: 0.05, se: 0.004, clears_2se: true, source: 'sim.title' }
      },
      his: {
        screen: { status: 'ok', value: 8, source: 'market.fc' },
        yes_point: { status: 'ok', value: -6, source: 'clone.price', guess: true, basis: 'his read' },
        p_yes: { status: 'ok', value: 0.55, source: 'clone.accept', band: { low: 0.45, high: 0.65 }, guess: true }
      }
    };
  },
  roster: team => (team === '1' ? [{ id: '5', label: 'P5 (RB)', value: 900 }] : [{ id: '21', label: 'P21 (WR)', value: 1800 }]),
  screenOf: () => 20,
  label: id => `P${id}`
};

const app = express();
app.use(express.json());
app.use('/api/warroom', ...legacyAuthenticated, negotiateRouter({
  rescorer: async () => fake, view: async () => structuredClone(served),
  times: (l, me, p) => N.replyTimes(l, me, p, { chat: noChat }), clock
}));
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/warroom/1/negotiations`;

const wr = await loadWarRoom();
test.after(() => { server.close(); db.close(); wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (url, { token = 'owner-token', body } = {}) => {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: res.status, body: await res.json() };
};
const withEnv = async (env, fn) => {
  const keep = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};
const LIVE = { GRIDIRON_WARROOM_ENABLED: '1', [NEGOTIATE_ENV]: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null };
const fresh = () => { run('DELETE FROM warroom_negotiation_events'); run('DELETE FROM warroom_negotiations'); };

/* -------------------------------------------------------------- flag + auth */

test('migration 093 adds the two negotiation tables', () => {
  assert.ok(row(`SELECT 1 AS ok FROM schema_migrations WHERE name = '093_warroom_negotiations'`));
  for (const t of ['warroom_negotiations', 'warroom_negotiation_events']) {
    assert.ok(row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
  }
});

test('the flag: off by default, needs the War Room on, preview turns both on and says so', async () => {
  await withEnv({ GRIDIRON_WARROOM_ENABLED: null, [NEGOTIATE_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.deepEqual(negotiateFlag(), { enabled: false, preview: false });
  });
  await withEnv({ GRIDIRON_WARROOM_ENABLED: null, [NEGOTIATE_ENV]: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.equal(negotiateFlag().enabled, false, 'negotiation needs the War Room itself on');
  });
  await withEnv({ GRIDIRON_WARROOM_ENABLED: '1', [NEGOTIATE_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.equal(negotiateFlag().enabled, false, 'the War Room alone does not turn negotiation on');
  });
  await withEnv({ GRIDIRON_WARROOM_ENABLED: null, [NEGOTIATE_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, async () => {
    assert.deepEqual(negotiateFlag(), { enabled: true, preview: true });
    const r = await call(base);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.preview, true);
    assert.match(r.body.preview_reason, /unvalidated/);
  });
  const src = fs.readFileSync(path.join(REPO, 'server', 'services', 'preview-mode.js'), 'utf8');
  assert.match(src, /warroom-flag\.js#negotiateFlag/);
  assert.match(fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8'), /app\.use\('\/api\/warroom', \.\.\.legacyAuthenticated, warroomNegotiateRouter\)/);
});

test('membership comes before the flag: a stranger gets 403 even when it is off', async () => {
  await withEnv({ GRIDIRON_WARROOM_ENABLED: null, [NEGOTIATE_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, async () => {
    assert.equal((await call(base, { token: 'stranger-token' })).status, 403);
    const off = await call(base);
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { enabled: false });
    assert.deepEqual((await call(base, { body: { move_id: MOVE.move_id } })).body, { enabled: false });
  });
});

/* ------------------------------------------------------------ open + replies */

test('"I sent it" stores the served step, once; the body cannot supply the step', async () => {
  fresh();
  await withEnv(LIVE, async () => {
    const a = await call(base, { body: { move_id: MOVE.move_id, step_index: 0, partner: '99', give: ['1'] } });
    assert.equal(a.status, 201);
    const t = a.body.thread;
    assert.equal(t.partner, STEP.partner);
    assert.deepEqual(t.give, STEP.give);
    assert.deepEqual(t.get, STEP.get);
    assert.equal(t.status, 'open');
    assert.deepEqual(t.branches.map(b => b.kind), ['accept', 'decline', 'counter', 'silence']);
    assert.deepEqual(t.branches.map(b => b.plan), ['accept', 'decline', 'counter', 'silence'].map(k => STEP.reply_table.value[k]));
    assert.ok(t.branches.every(b => !b.live));
    assert.equal(t.names[STEP.give[0]], served.names[STEP.give[0]]);
    const again = await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } });
    assert.equal(again.body.thread.id, t.id, 'one open thread per move and step');
    assert.equal((await call(base, { body: { move_id: 'not-a-move', step_index: 0 } })).status, 409);
    assert.equal((await call(base, { body: { step_index: 0 } })).status, 400);
    const list = await call(base);
    assert.deepEqual(list.body.threads.map(x => x.id), [t.id]);
  });
});

test('replies: the logged branch goes live; a counter carries his ask; accept closes the thread', async () => {
  fresh();
  await withEnv(LIVE, async () => {
    const { thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
    assert.equal((await call(`${base}/${thread.id}/reply`, { body: { reply: 'maybe' } })).status, 400);
    NOW += 30 * 60_000;
    const c = (await call(`${base}/${thread.id}/reply`, { body: { reply: 'counter', give: ['5', '6', '7'], get: ['21'] } })).body.thread;
    assert.equal(c.status, 'open');
    assert.deepEqual(c.branches.filter(b => b.live).map(b => b.kind), ['counter']);
    assert.deepEqual(c.events.at(-1), { kind: 'reply', reply: 'counter', give: ['5', '6', '7'], get: ['21'], note: null, at: new Date(NOW).toISOString() });
    assert.equal(c.countdown.phase, 'answered');
    const a = (await call(`${base}/${thread.id}/reply`, { body: { reply: 'accept' } })).body.thread;
    assert.equal(a.status, 'closed');
    assert.equal(a.closed_reason, 'accepted');
    assert.equal(a.countdown, null);
    assert.equal((await call(`${base}/${thread.id}/reply`, { body: { reply: 'decline' } })).status, 409);
  });
});

test('Undo works for 10 minutes after "I sent it", then only walking away does', async () => {
  fresh();
  await withEnv(LIVE, async () => {
    let { thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
    assert.equal(thread.can_undo, true);
    NOW += 9 * 60_000;
    const u = await call(`${base}/${thread.id}/close`, { body: { reason: 'undone' } });
    assert.equal(u.body.thread.closed_reason, 'undone');
    ({ thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body);
    assert.equal(thread.status, 'open', 'an undone thread does not block sending it again');
    NOW += 11 * 60_000;
    assert.equal((await call(`${base}/${thread.id}/close`, { body: { reason: 'undone' } })).status, 409);
    assert.equal((await call(`${base}/${thread.id}/close`, { body: { reason: 'bored' } })).status, 400);
    const w = await call(`${base}/${thread.id}/close`, { body: { reason: 'walked_away' } });
    assert.equal(w.body.thread.closed_reason, 'walked_away');
  });
});

/* ------------------------------------------------------------------ countdown */

test('countdown: follow up past his slow reply time, move on at twice it, floors and phases', () => {
  const sent = '2026-09-24T12:00:00.000Z', t0 = Date.parse(sent), H = 3600_000;
  const dist = { status: 'ok', p50_min: 90, p90_min: 300, n: 7, source: 'espn.offers', basis: 'his answers' };
  const c = N.countdown(dist, sent, t0 + H);
  assert.equal(c.phase, 'waiting');
  assert.equal(c.follow_up_at, new Date(t0 + 5 * H).toISOString());
  assert.equal(c.move_on_at, new Date(t0 + 10 * H).toISOString());
  assert.equal(c.typical_min, 90);
  assert.equal(c.guess, true);
  assert.equal(N.countdown(dist, sent, t0 + 6 * H).phase, 'follow_up');
  assert.equal(N.countdown(dist, sent, t0 + 10 * H).phase, 'move_on');
  assert.equal(N.countdown(dist, sent, t0 + 10 * H, { answeredAt: sent }).phase, 'answered');
  // A fast texter is not chased within minutes.
  const fast = N.countdown({ ...dist, p50_min: 3, p90_min: 12 }, sent, t0);
  assert.equal(fast.follow_up_at, new Date(t0 + N.FOLLOW_UP_FLOOR_MIN * 60_000).toISOString());
  assert.equal(fast.move_on_at, new Date(t0 + N.MOVE_ON_FLOOR_MIN * 60_000).toISOString());
  // No data: the playbook's hand-set 24 h / 48 h, with the reason, and no typical time.
  const none = N.countdown({ status: 'unknown', reason: 'No reply-time data for him: x.' , basis: 'hand-set' }, sent, t0);
  assert.equal(none.follow_up_at, new Date(t0 + 24 * H).toISOString());
  assert.equal(none.move_on_at, new Date(t0 + 48 * H).toISOString());
  assert.equal(none.typical_min, null);
  assert.match(none.reason, /No reply-time data/);
});

test('reply times: his ESPN answers first, then his chat reply time, else unknown with both reasons', async () => {
  run('DELETE FROM league_transactions_raw');
  // ESPN's shape: Nick's offer under his team, the answer under the partner's, tied by related_tx_id.
  const ins = (tx, type, exec, team, at, related = null) => run(`INSERT INTO league_transactions_raw
      (league_id, season, tx_id, type, execution_type, proposed_at, team_id, related_tx_id, first_seen_at, last_seen_at)
    VALUES (1, 2026, ?, ?, ?, ?, ?, ?, 'x', 'x')`, tx, type, exec, new Date(at).toISOString(), team, related);
  const add = (i, mins, { to = 3, answer = 'TRADE_ACCEPT', exec = 'EXECUTE' } = {}) => {
    const at = Date.parse('2026-09-10T12:00:00Z') + i * 864e5;
    ins(`p${i}`, 'TRADE_PROPOSAL', 'EXECUTE', 1, at);
    ins(`a${i}`, answer, exec, to, at + mins * 60_000, `p${i}`);
  };
  [60, 120, 30, 240].forEach((m, i) => add(i, m));
  add(4, 90, { answer: 'TRADE_DECLINE' });  // a no is an answer too
  add(10, 5, { exec: 'PROCESS' });          // the league processing it: not his answer
  add(11, 7, { to: 4 });                    // another manager
  const espn = await N.replyTimes(1, '1', '3', { chat: noChat });
  assert.equal(espn.status, 'ok');
  assert.equal(espn.source, 'espn.offers');
  assert.equal(espn.n, 5);
  assert.equal(espn.p50_min, 90);
  assert.equal(espn.p90_min, 192);          // 120 + 0.6 x (240 - 120)
  const chat = await N.replyTimes(1, '1', '4', { chat: async () => ({ p50: 12, p90: 70, n: 40 }) });
  assert.equal(chat.source, 'chat.labels');
  assert.equal(chat.p90_min, 70);
  const none = await N.replyTimes(1, '1', '4', { chat: noChat });
  assert.equal(none.status, 'unknown');
  assert.match(none.reason, /1 answered ESPN offer to him \(needs 5\); no chat corpus in the test/);
  const broken = await N.replyTimes(1, '1', '4', { chat: async () => { throw new Error('locked'); } });
  assert.match(broken.reason, /the chat read failed \(locked\)/);
});

test('a counter Nick sends restarts the clock from that moment', async () => {
  fresh();
  run('DELETE FROM league_transactions_raw');   // no reply-time data: the hand-set 24 h / 48 h
  await withEnv(LIVE, async () => {
    const { thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
    NOW += 30 * 3600_000;
    const late = (await call(base)).body.threads[0];
    assert.equal(late.countdown.phase, 'follow_up');
    const f = (await call(`${base}/${thread.id}/follow-up`, { body: {} })).body.thread;
    assert.equal(f.events.at(-1).kind, 'follow_up');
    assert.equal((await call(`${base}/${thread.id}/counter-sent`, { body: { give: [], get: ['21'] } })).status, 400);
    const c = (await call(`${base}/${thread.id}/counter-sent`, { body: { give: ['5'], get: ['21'] } })).body.thread;
    assert.equal(c.countdown.from, new Date(NOW).toISOString());
    assert.equal(c.countdown.phase, 'waiting');
  });
});

/* ------------------------------------------------------------------- rescore */

test('rescore: Nick\'s title-odds change, his P(yes) and yes-point, the walk-away line, rosters on request', async () => {
  fresh();
  await withEnv(LIVE, async () => {
    const { thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
    const before = fakeScores.length;
    const r = (await call(`${base}/${thread.id}/rescore`, { body: { give: ['5'], get: ['21'], rosters: true } })).body;
    assert.equal(fakeScores.length, before + 1, 'one edit, one rescore');
    assert.deepEqual(fakeScores.at(-1), { partner: STEP.partner, give: ['5'], get: ['21'] });
    assert.equal(r.status, 'ok');
    assert.equal(r.ms, 74.2);
    assert.deepEqual(r.axis, SCREEN_AXIS);
    assert.equal(r.nick.title_odds_delta.value, 0.05);
    assert.equal(r.his.yes_point.value, -6);
    assert.deepEqual(r.his.p_yes.band, { low: 0.45, high: 0.65 });
    assert.deepEqual(Object.keys(r.rosters), ['mine', 'his']);
    // The fixture's walk-away is unknown: no line, its reason, and no number.
    assert.equal(r.walk_away.status, 'unknown');
    assert.ok(!('value' in r.walk_away));
    assert.match(r.walk_away.reason, /No walk-away/);
    const again = (await call(`${base}/${thread.id}/rescore`, { body: { give: ['5', '6'], get: ['21'] } })).body;
    assert.ok(!('rosters' in again), 'rosters only when asked');
    const off = await call(`${base}/${thread.id}/rescore`, { body: { give: ['999'], get: ['21'] } });
    assert.equal(off.status, 422);
    assert.match(off.body.error, /not on the your roster/);
    assert.equal((await call(`${base}/${thread.id}/rescore`, { body: { give: 'x', get: ['21'] } })).status, 400);
  });
});

test('rescore: a priced walk-away is placed on his screen with its text', async () => {
  fresh();
  const priced = structuredClone(served);
  priced.alternatives.value[0].steps[0].walk_away = { status: 'ok', source: 'clone.price', value: { text: 'up to P5 + P6 + P7', max_give: ['5', '6', '7'] } };
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/warroom', ...legacyAuthenticated, negotiateRouter({ rescorer: async () => fake, view: async () => priced,
    times: (l, me, p) => N.replyTimes(l, me, p, { chat: noChat }), clock }));
  const s2 = app2.listen(0);
  try {
    await withEnv(LIVE, async () => {
      const b2 = `http://127.0.0.1:${s2.address().port}/api/warroom/1/negotiations`;
      const { thread } = (await call(b2, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
      const r = (await call(`${b2}/${thread.id}/rescore`, { body: { give: ['5'], get: ['21'] } })).body;
      assert.deepEqual(r.walk_away, { status: 'ok', source: 'clone.price', value: 20, unit: 'percent', text: 'up to P5 + P6 + P7' });
    });
  } finally { s2.close(); }
});

/** A fake simulator and pricing for makeRescorer: two teams, four players. */
function fakeDeps({ informed = true, fail = null } = {}) {
  const calls = { world: 0, impact: [], readDeal: [] };
  const assets = new Map([[5, { name: 'P5', position: 'RB', value: 1000 }], [6, { name: 'P6', position: 'WR', value: 500 }],
    [21, { name: 'P21', position: 'WR', value: 1200 }], [22, { name: 'P22', position: 'TE', value: 300 }]]);
  let t = 0;
  return {
    calls,
    deps: {
      world: () => { calls.world++; return fail ? { fail } : { prep: { assets, teams: [
        { roster_id: '1', players: [{ id: 5 }, { id: 6 }] }, { roster_id: '3', players: [{ id: 21 }, { id: 22 }] }] } }; },
      impact: (lg, opts) => { calls.impact.push(opts); return { runs: 1200, me: { title_before: 0.4, title_after: 0.46, title_delta: 0.06, title_delta_se: 0.01, title_delta_clears_noise: true } }; },
      layer: () => new Map([['3', { receptiveness: 1, negotiation: null }]]),
      readDeal: a => { calls.readDeal.push(a); return informed ? { perception_informed: true, perception_shift: 7.5, perception_delta: 3 } : { perception_informed: false, perception_shift: null }; },
      band: () => ({ band: { low: 0.3, mid: 0.4, high: 0.5 }, basis: 'test' }),
      now: () => (t += 40)
    }
  };
}
const LG = { id: 1, my_team_id: '1', fetched_at: 'sync-1', season: 2026 };

test('the rescorer builds one world per league sync and rescores each edit against it', async () => {
  __resetRescorers();
  const { calls, deps } = fakeDeps();
  const R = await rescorerFor(LG, deps);
  assert.equal(await rescorerFor(LG, deps), R, 'same sync, same rescorer');
  for (const give of [['5'], ['5', '6'], ['6']]) R.score({ partner: '3', give, get: ['21'] });
  assert.equal(calls.world, 1);
  assert.equal(calls.impact.length, 3);
  assert.ok(calls.impact.every(o => o.world && o.myTeamId === '1' && o.theirTeamId === '3'), 'every rescore reuses the world');
  const next = await rescorerFor({ ...LG, fetched_at: 'sync-2' }, deps);
  assert.notEqual(next, R, 'a new sync builds a new world');
  assert.equal(calls.world, 2);
  __resetRescorers();
});

test('his side: P(yes) band, yes-point at minus his perception shift, market-fair without a read', () => {
  const { calls, deps } = fakeDeps();
  const R = makeRescorer(LG, deps);
  const s = R.score({ partner: '3', give: ['5', '6'], get: ['21'] });
  assert.deepEqual(s.problems, []);
  assert.equal(s.ms, 40);
  assert.equal(s.nick.title_odds_delta.value, 0.06);
  assert.equal(s.nick.title_odds_delta.clears_2se, true);
  assert.equal(s.his.screen.value, 25);            // he gets 1500, gives 1200
  assert.equal(s.his.yes_point.value, -7.5);
  assert.equal(s.his.yes_point.guess, true);
  assert.equal(s.his.p_yes.value, 0.4);
  assert.deepEqual(s.his.p_yes.band, { low: 0.3, high: 0.5 });
  // readDeal is asked from HIS side: he gives what Nick gets.
  assert.deepEqual(calls.readDeal[0].theirGive.map(p => p.id), [21]);
  assert.deepEqual(calls.readDeal[0].theirGet.map(p => p.id), [5, 6]);
  const plain = makeRescorer(LG, fakeDeps({ informed: false }).deps).score({ partner: '3', give: ['5'], get: ['21'] });
  assert.equal(plain.his.yes_point.value, 0);
  assert.match(plain.his.yes_point.basis, /market-fair/);
  assert.deepEqual(R.score({ partner: '3', give: ['21'], get: ['5'] }).problems.length > 0, true);
  assert.match(R.score({ partner: '3', give: ['5', '6', '5'], get: ['21'] }).problems[0], /twice/);
  assert.deepEqual(R.roster('3').map(p => p.id), ['21', '22']);
  const broken = makeRescorer(LG, fakeDeps({ fail: { error: 'no projections' } }).deps);
  assert.match(broken.fail, /no projections/);
});

/* -------------------------------------------------------------------- client */

const neg = await wr.mod('negotiate');
const { default: Negotiate } = await wr.mod('Negotiate');
const req = await wr.mod('requests');
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');

function threadFixture(over = {}) {
  const sent = '2026-09-24T12:00:00.000Z';
  const t = N.threadView({
    id: 7, league_id: 1, move_id: MOVE.move_id, step_index: 0, partner: '3', give_json: '["5","6"]', get_json: '["21"]',
    names_json: JSON.stringify({ 5: 'P5 (RB)', 6: 'P6 (WR)', 21: 'P21 (WR)' }), step_json: JSON.stringify(STEP),
    snapshot_id: 'plans@1', sent_at: sent, status: 'open', closed_reason: null, closed_at: null
  }, over.events ?? [], { status: 'ok', p50_min: 90, p90_min: 300, n: 7, source: 'espn.offers', basis: 'his answers to 7 of your ESPN offers' },
  Date.parse(sent) + 3600_000);
  return t;
}

test('the thread renders branches, the countdown from his reply times, and Undo inside the window', () => {
  const t = threadFixture();
  const html = renderToStaticMarkup(React.createElement(Negotiate, { thread: t, onThread() {}, now: Date.parse(t.sent_at) + 3600_000 }));
  const text = textOf(html);
  assert.match(text, /Waiting on Team 3/);
  assert.match(text, /Follow up in 4 h if he has not answered/);
  assert.match(text, /He usually answers in 1 h 30 min, slow is 5 h/);
  assert.match(text, /his answers to 7 of your ESPN offers/);
  for (const k of ['He accepts', 'He declines', 'He counters', 'No reply']) assert.match(text, new RegExp(k));
  assert.match(text, /Log the reason, then offer Team 3 instead/);
  assert.match(html, /data-phase="waiting"/);
  assert.doesNotMatch(text, /Undo/, 'an hour after sending, Undo is gone');
  assert.match(text, /Walk away/);
  assert.match(text, /Build a counter/);
});

test('a logged counter makes its branch live and shows its rules', () => {
  const t = threadFixture({ events: [{ kind: 'reply', reply: 'counter', give_json: '["5","6"]', get_json: '["21"]', note: null, at: '2026-09-24T12:30:00.000Z' }] });
  t.branches.find(b => b.kind === 'counter').plan = { status: 'ok', source: 'plan.path', value: { do: 'Check his ask against the walk-away.',
    counter_rules: { accept_if: 'no richer than the walk-away', counter_with: 'the next rung', walk_away_if: 'richer than the walk-away' } } };
  const html = renderToStaticMarkup(React.createElement(Negotiate, { thread: t, onThread() {}, now: Date.parse('2026-09-24T13:00:00Z') }));
  const text = textOf(html);
  assert.match(html, /data-branch="counter" data-live="true"/);
  assert.match(text, /Take it if no richer than the walk-away/);
  assert.match(text, /He countered: wants P5 \(RB\) \+ P6 \(WR\), gives P21 \(WR\)/);
  assert.match(text, /He answered\. The clock is stopped\./);
});

test('the counter builder draws the live numbers, the yes-point and the walk-away line; unknown says why', () => {
  const t = threadFixture();
  const rescore = {
    enabled: true, status: 'ok', ms: 74.2, axis: { low: -35, high: 45 },
    nick: fake.score({ partner: '3', give: ['5'], get: ['21'] }).nick,
    his: fake.score({ partner: '3', give: ['5'], get: ['21'] }).his,
    walk_away: { status: 'ok', source: 'clone.price', value: 20, text: 'up to P5 + P6 + P7' },
    rosters: { mine: [{ id: '5', label: 'P5 (RB)', value: 900 }, { id: '6', label: 'P6 (WR)', value: 500 }], his: [{ id: '21', label: 'P21 (WR)', value: 1800 }] }
  };
  const html = renderToStaticMarkup(React.createElement(Negotiate, { thread: t, onThread() {}, now: Date.parse(t.sent_at), initialRescore: rescore }));
  const text = textOf(html);
  assert.match(text, /\+5\.0 pts/);
  assert.match(text, /42\.0% → 47\.0%/);
  assert.match(text, /55%/);
  assert.match(text, /45%–65%/);
  assert.match(text, /His yes-point -6%/);
  assert.match(text, /package now \+8% on his screen/);
  assert.match(html, /style="left:36\.25%" data-testid="yes-point"/);
  assert.match(html, /style="left:68\.75%" data-testid="walk-away-line"/);
  assert.match(html, /style="left:53\.75%" data-testid="package-dot"/);
  assert.match(text, /Red line: your walk-away \(up to P5 \+ P6 \+ P7\)/);
  assert.match(html, /aria-pressed="true"[^>]*>P5 \(RB\)/);
  const unknown = { ...rescore, walk_away: { status: 'unknown', source: 'clone.price', reason: 'No walk-away: no package beats your next-best plan.' } };
  const h2 = renderToStaticMarkup(React.createElement(Negotiate, { thread: t, onThread() {}, now: Date.parse(t.sent_at), initialRescore: unknown }));
  assert.doesNotMatch(h2, /walk-away-line/);
  assert.match(textOf(h2), /No walk-away line: No walk-away: no package beats your next-best plan\./);
  const failed = { ...rescore, nick: { title_before: { status: 'failed', source: 'sim.title', reason: 'x' }, title_after: { status: 'failed', source: 'sim.title', reason: 'x' },
    title_odds_delta: { status: 'failed', source: 'sim.title', reason: 'The rescore failed (boom).' } } };
  const h3 = textOf(renderToStaticMarkup(React.createElement(Negotiate, { thread: t, onThread() {}, now: Date.parse(t.sent_at), initialRescore: failed })));
  assert.match(h3, /hidden: failed its check/);
  assert.doesNotMatch(h3, /Your title odds [+\d]/);
});

test('package edits: never empty a side, at most four a side; slider and time helpers', () => {
  let p = { give: ['5'], get: ['21'] };
  p = neg.pkgReducer(p, { type: 'toggle', side: 'give', id: '5' });
  assert.deepEqual(p.give, ['5'], 'the last player on a side stays');
  for (const id of ['6', '7', '8', '9']) p = neg.pkgReducer(p, { type: 'toggle', side: 'give', id });
  assert.deepEqual(p.give, ['5', '6', '7', '8']);
  p = neg.pkgReducer(p, { type: 'toggle', side: 'give', id: '6' });
  assert.deepEqual(p.give, ['5', '7', '8']);
  assert.equal(neg.samePkg({ give: ['6', '5'], get: ['21'] }, { give: ['5', '6'], get: ['21'] }), true);
  assert.deepEqual(neg.slot(-35, { low: -35, high: 45 }), { left: 0, off: false });
  assert.deepEqual(neg.slot(90, { low: -35, high: 45 }), { left: 100, off: true });
  assert.equal(neg.span(45), '45 min');
  assert.equal(neg.span(190), '3 h 10 min');
  assert.equal(neg.span(3000), '2 d 2 h');
  const c = { phase: 'move_on', from: '2026-09-24T12:00:00Z', follow_up_at: '2026-09-24T17:00:00Z', move_on_at: '2026-09-24T22:00:00Z' };
  assert.equal(neg.countdownText(c, Date.parse('2026-09-25T00:00:00Z')), 'Move on: 2 h past his window');
  assert.equal(neg.elapsed(c, Date.parse('2026-09-24T17:00:00Z')), 0.5);
});

test('every negotiation call posts once to its one path', async () => {
  const posted = [];
  const post = async (p, init) => { posted.push([p, init.method, JSON.parse(init.body)]); return {}; };
  await req.openNegotiation(1, 'M1', 0, post);
  await req.logNegotiationReply(1, 7, 'counter', { give: ['5'], get: ['21'] }, post);
  await req.logNegotiationReply(1, 7, 'decline', null, post);
  await req.counterSent(1, 7, { give: ['5'], get: ['21'] }, post);
  await req.followedUp(1, 7, post);
  await req.closeNegotiation(1, 7, 'walked_away', post);
  await req.rescoreCounter(1, 7, { give: ['5'], get: ['21'] }, true, post);
  assert.deepEqual(posted, [
    ['/warroom/1/negotiations', 'POST', { move_id: 'M1', step_index: 0 }],
    ['/warroom/1/negotiations/7/reply', 'POST', { reply: 'counter', give: ['5'], get: ['21'] }],
    ['/warroom/1/negotiations/7/reply', 'POST', { reply: 'decline' }],
    ['/warroom/1/negotiations/7/counter-sent', 'POST', { give: ['5'], get: ['21'] }],
    ['/warroom/1/negotiations/7/follow-up', 'POST', {}],
    ['/warroom/1/negotiations/7/close', 'POST', { reason: 'walked_away' }],
    ['/warroom/1/negotiations/7/rescore', 'POST', { give: ['5'], get: ['21'], rosters: true }]
  ]);
});

test('a sent card flips to the live thread; without negotiation mode the reply table stays', () => {
  const t = threadFixture();
  const on = textOf(renderToStaticMarkup(React.createElement(NextMoveDeck, {
    view: served, big: true, negotiation: { enabled: true, threads: [t] }
  })));
  assert.match(on, /Waiting on Team 3/);
  assert.doesNotMatch(on, /If he says… \(tap what happened\)/);
  const off = textOf(renderToStaticMarkup(React.createElement(NextMoveDeck, {
    view: served, big: true, negotiation: { enabled: false }
  })));
  assert.doesNotMatch(off, /Waiting on Team/);
  assert.match(off, /If he says… \(tap what happened\)/);
  const undone = { ...t, status: 'closed', closed_reason: 'undone' };
  const u = textOf(renderToStaticMarkup(React.createElement(NextMoveDeck, { view: served, big: true, negotiation: { enabled: true, threads: [undone] } })));
  assert.doesNotMatch(u, /Waiting on Team/, 'an undone thread gives the card back');
});

test('preview prefixes the countdown\'s sentences', async () => {
  fresh();
  await withEnv({ GRIDIRON_WARROOM_ENABLED: null, [NEGOTIATE_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, async () => {
    const { thread } = (await call(base, { body: { move_id: MOVE.move_id, step_index: 0 } })).body;
    assert.ok(thread.countdown.basis.startsWith(PREVIEW_PREFIX));
  });
});
