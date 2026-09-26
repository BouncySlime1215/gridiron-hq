/**
 * COACH-PRELOAD: every model turn starts with the served context, cited, and a
 * small lookup budget (a stand-in client; no network, no spend).
 *
 * Measured 2026-09-25 on a DB copy: live turns spent 4-6 calls on catalog
 * lookups and exploratory SQL, then refused questions the plan already answers.
 * Pinned here:
 *   - the bundle records the plan summary (title odds +/- SE), the moves, the
 *     targets, Nick's roster with projection and 80% floor, the partner in
 *     focus (his read, P(yes), reply history) and Nick's rules in the turn's
 *     ledger, and the prompt carries it
 *   - a claim citing a preloaded cell passes verify.js with no tool call
 *   - two lookup rounds by default, then the answer round; an "analyze"
 *     question keeps the full budget; GRIDIRON_COACH_PRELOAD=0 restores the old turn
 *   - a failed answer on the last round gets its correction round, and an
 *     answer that never passes is never shown (it shipped unverified before)
 * Names are made up (public repo); plans from the producer fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-preload-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_PRELOAD;
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach, MAX_TOOL_ROUNDS } = await import('../server/services/coach/ask.js');
const { preloadContext, PRELOAD_TOOL_ROUNDS } = await import('../server/services/coach/preload.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const PLANS = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
const L4 = PLANS.leagues.find(e => e.league === 4);

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);
for (const [pid, name, pos, slot, starter, espn, pred, floor] of [
  [9001, 'Fixture Runner', 'RB', 'RB', 1, 17.5, 16.2, 7.1], [9002, 'Fixture Wideout', 'WR', 'WR', 1, 11.0, 10.4, 3.9],
  [9003, 'Fixture Bench', 'TE', 'BENCH', 0, 6.0, null, null]]) {
  run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (?, ?, ?)`, pid, name, pos);
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id, player_name, position,
         lineup_slot_id, lineup_slot, is_starter, projected_points, source, first_seen_at, changed_at)
       VALUES (4, 2026, 3, 1, ?, ?, ?, ?, 0, ?, ?, ?, 'live', '2026-09-24', '2026-09-24')`, pid + 100000, pid, name, pos, slot, starter, espn);
  if (pred != null) {
    run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version, structural, prediction, lower_80, upper_80)
         VALUES (2026, 3, ?, ?, '2026-09-22', '2026-09-22', 'fx', ?, ?, ?, ?)`, pid, pos, pred, pred, floor, pred + 8);
  }
}
const focusMove = L4.next_move.value;
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9951, 'preload', 'Reader')`);
run(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, source, confirmed) VALUES (9951, 4, 'offer.sent', ?, 'nick', 0)`,
  JSON.stringify({ move_id: focusMove.move_id, step_index: 0, sent_as: 'card' }));

const usage = { input_tokens: 100, output_tokens: 50 };
const tool = (i = 0) => ({ content: [{ type: 'tool_use', id: `tu${i}`, name: 'sql_select', input: { sql: 'SELECT name FROM players WHERE id = 9001' } }], stop_reason: 'tool_use', usage });
const says = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage });
function scripted(...replies) {
  const sent = [];
  let turn = 0;
  return { sent, messages: { create: async body => {
    sent.push(structuredClone(body));
    const r = replies[turn++];
    if (!r) throw new Error(`ran out of replies at turn ${turn}`);
    return typeof r === 'function' ? r(body) : r;
  } } };
}
test.afterEach(() => setAnthropicClientForTesting(null));

test('the bundle: plan, moves, targets, roster with floors, the partner in focus, the rules', async () => {
  const ledger = newLedger();
  const focus = { move_id: focusMove.move_id, partner: String(focusMove.steps[0].partner) };
  const pre = await preloadContext({ leagueId: 4, focus, ledger });
  const byTable = Object.fromEntries(ledger.queries.map(q => [q.tables[0], q]));
  assert.deepEqual(Object.keys(byTable), ['plan_summary', 'plan_moves', 'plan_targets', 'my_roster', 'partner_focus', 'nick_rules']);
  assert.ok(ledger.queries.every(q => q.tool === 'plan_read'));
  assert.equal(byTable.plan_summary.rows[0].title_odds_now, L4.destination.value.title_now.value);
  assert.equal(byTable.plan_moves.rows[0].move_id, focusMove.move_id);
  assert.equal(byTable.plan_moves.rows[0].title_odds_change_se, focusMove.steps[0].title_odds_delta.se);
  const roster = byTable.my_roster.rows;
  assert.deepEqual(roster.map(r => r.player), ['Fixture Runner', 'Fixture Wideout', 'Fixture Bench']);
  assert.equal(roster[0].floor_80, 7.1);
  assert.equal(roster[2].prediction, null, 'no prediction is null, not a guess');
  const p = byTable.partner_focus.rows[0];
  assert.equal(p.partner, focus.partner);
  assert.equal(p.sent, 1, 'his reply history reads the War Room records');
  assert.equal(p.p_yes, focusMove.steps[0].p_yes.value);
  const rules = byTable.nick_rules.rows[0];
  assert.equal(rules.overpay_cap_pct, 0);
  assert.equal(rules.sends_offers, false);
  assert.match(pre.text, /r1 \(plan_summary\)/);
});

test('a claim citing a preloaded cell passes with no lookup; the prompt carries the bundle', async () => {
  const client = scripted(({ messages }) => {
    assert.match(JSON.stringify(messages[0].content), /PRELOADED CONTEXT/);
    return says({ claims: [{ text: 'Fixture Runner has a floor of 7.1 points this week.', cites: ['r4#0.player', 'r4#0.floor_80'] }], refusals: [], as_of: null });
  });
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'what is my best starter floor', leagueId: 4, context: { league: 4 } });
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
  assert.equal(out.answer.claims.length, 1);
  assert.equal(client.sent.length, 1);
  assert.match(JSON.stringify(client.sent[0].system), /PRELOADED CONTEXT\. /);
  assert.ok(out.plan.some(e => e.t === 'preloaded'));
});

test('two lookup rounds, then the answer round', async () => {
  const client = scripted(tool(1), tool(2), says({ claims: [], refusals: ['Coach does not read that.'], as_of: null }));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'what is the weather', leagueId: 4, context: { league: 4 } });
  assert.deepEqual(out.answer.refusals, ['Coach does not read that.']);
  assert.equal(client.sent.length, PRELOAD_TOOL_ROUNDS + 1);
  assert.deepEqual(client.sent.at(-1).tool_choice, { type: 'none' });
});

test('an "analyze" question keeps the full lookup budget; the flag off restores the old turn', async () => {
  const tools = Array.from({ length: MAX_TOOL_ROUNDS - 1 }, (_, i) => tool(i));
  let client = scripted(...tools, says({ claims: [], refusals: ['x'], as_of: null }));
  setAnthropicClientForTesting(client);
  await askCoach({ question: 'analyze my roster for me', leagueId: 4, context: { league: 4 } });
  assert.equal(client.sent.length, MAX_TOOL_ROUNDS);

  process.env.GRIDIRON_COACH_PRELOAD = '0';
  try {
    client = scripted(...tools, says({ claims: [], refusals: ['x'], as_of: null }));
    setAnthropicClientForTesting(client);
    await askCoach({ question: 'what is the weather', leagueId: 4, context: { league: 4 } });
    assert.equal(client.sent.length, MAX_TOOL_ROUNDS);
    assert.doesNotMatch(JSON.stringify(client.sent[0].messages[0].content), /PRELOADED CONTEXT/);
  } finally { delete process.env.GRIDIRON_COACH_PRELOAD; }
});

test('a failed answer on the last round gets its correction round; one that never passes is not shown', async () => {
  const bad = says({ claims: [{ text: 'Your title odds are 87%.', cites: ['r1#0.title_odds_now'] }], refusals: [], as_of: null });
  const good = says({ claims: [{ text: 'Fixture Runner has a floor of 7.1 points this week.', cites: ['r4#0.player', 'r4#0.floor_80'] }], refusals: [], as_of: null });
  let client = scripted(tool(1), tool(2), bad, good);
  setAnthropicClientForTesting(client);
  let out = await askCoach({ question: 'how am I doing', leagueId: 4, context: { league: 4 } });
  assert.equal(out.verification.ok, true);
  assert.equal(client.sent.length, 4, 'the correction got a round past the budget');

  client = scripted(tool(1), tool(2), bad, bad);
  setAnthropicClientForTesting(client);
  out = await askCoach({ question: 'how am I doing', leagueId: 4, context: { league: 4 } });
  assert.equal(out.answer.claims.length, 0, 'never shown');
  assert.match(out.answer.refusals.join(' '), /could not trace/);
});
