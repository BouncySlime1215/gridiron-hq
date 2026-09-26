/**
 * COACH-V2 $0 paths: EXPLAIN for a term the app serves (a definition plus this league's
 * value from the bundle, cited), and CHAT ("thanks", "lol ok"). No model call, answer format.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-explain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
process.env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
process.env.GRIDIRON_WARROOM_ENABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { chatTurn } = await import('../server/services/coach/chat.js');
const { shapeCheck } = await import('../server/services/coach/answer-shape.js');
await import('../server/routes/coach.js');
run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
let uid = 9960;
const user = () => { const id = ++uid; run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Reader')`, id, `explain-${id}`); return id; };
let calls = 0;
setAnthropicClientForTesting({ messages: { create: async () => { calls += 1; throw new Error('no model here'); } } });
test.after(() => setAnthropicClientForTesting(null));
const ask = q => chatTurn({ userId: user(), leagueId: 4, question: q, hasModel: true, context: { league: 4 } });

test('EXPLAIN a served term: a definition plus the league value, cited, in the format, $0', async () => {
  for (const [q, rx] of [['What do title odds mean?', /^Read title odds as/], ['What is the overpay cap?', /^Read the overpay cap/],
    ['What does a blue chip mean here?', /^Read a blue chip/], ['What does P(yes) mean?', /^Read P\(yes\)/],
    ['What is the depth premium?', /^Read the depth premium/], ['What does SE mean next to a number?', /^Read SE as/]]) {
    const out = await ask(q);
    assert.equal(out.cost_usd, 0, q);
    assert.match(out.answer.shape.verdict.text, rx, q);
    assert.deepEqual(shapeCheck(out.answer), [], `${q}: in the format`);
    assert.equal(out.verification.ok, true);
    for (const c of out.answer.claims) assert.ok(c.cites.length, `${q}: every number line is cited`);
  }
  const cap = await ask('What is the overpay cap?');
  assert.match(cap.answer.shape.why.map(w => w.text).join(' '), /Yours is 0%/);
  assert.equal(calls, 0, 'no model call');
});

test('CHAT: an acknowledgement and a pointer, $0', async () => {
  for (const [q, v] of [['thanks', 'Happy to help.'], ['lol ok', 'Glad that landed.'], ['cool', 'Got it.']]) {
    const out = await ask(q);
    assert.equal(out.answer.shape.verdict.text, v);
    assert.equal(out.cost_usd, 0);
    assert.ok(out.thread.followups.length >= 2);
  }
  assert.equal(calls, 0);
});

test('a term the app does not serve still goes to the model', async () => {
  calls = 0;
  await assert.rejects(ask('What does a handcuff mean?'));
  assert.ok(calls >= 1, 'routed to the model (which this stand-in refuses)');
});
