/**
 * COACH-V2 unit 1: the router and the answer format (a stand-in client; no network).
 *
 * Pinned here:
 *   - the router: each of the 7 intents by rule ($0); a question no rule matches goes to
 *     the cheap model only when the model is on; per-intent model / effort / lookup budget
 *     (Opus only for DO or ABOUT on a trade, Haiku for CHAT and EXPLAIN)
 *   - the shape check: verdict <= 18 words starting with a verb or "No", 1-3 why bullets
 *     <= 22 words, <= 2 risk lines, < 120 words; a violation gets one correction round,
 *     then the offending block is dropped and the answer still ships
 *   - a shaped answer's lines are the claims verify.js checks, and a refusal keeps a verdict
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-router-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
const PLANS_FILE = path.join(temp, 'plans.json');
fs.copyFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), PLANS_FILE);
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { askCoach } = await import('../server/services/coach/ask.js');
const { ruleIntent, routeQuestion, planFor, MODELS } = await import('../server/services/coach/router.js');
const { shapeCheck, enforceShape, toAnswer, LIMITS } = await import('../server/services/coach/answer-shape.js');
run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);

const usage = { input_tokens: 100, output_tokens: 50 };
const says = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage });
function scripted(...replies) {
  const sent = [];
  let turn = 0;
  return { sent, messages: { create: async body => { sent.push(structuredClone(body)); const r = replies[turn++]; if (!r) throw new Error(`out of replies at ${turn}`); return r; } } };
}
test.afterEach(() => setAnthropicClientForTesting(null));

test('the router: seven intents by rule, $0', async () => {
  const cases = {
    DO: ["what's my next move", 'who should I target this week', 'should I send this offer?'],
    WHY: ['why him?', 'how come that one'],
    WHAT_IF: ['what if he says no', 'what about team 7 instead'],
    ABOUT: ['tell me about my roster', 'how is my team looking', 'what is my overpay rule'],
    CHANGE: ['go all in', 'change my goal to the playoffs'],
    EXPLAIN: ['what does 19.6% mean', 'what are title odds'],
    CHAT: ['lol ok', 'thanks!']
  };
  for (const [intent, qs] of Object.entries(cases)) for (const q of qs) assert.equal(ruleIntent(q), intent, q);
  const r = await routeQuestion('which bye weeks line up badly?', { hasModel: false });
  assert.deepEqual([r.intent, r.by, r.cost_usd], ['ABOUT', 'default', 0], 'no model: no call, ABOUT');
});

test('a question no rule matches is routed by the cheap model, with a schema', async () => {
  const client = scripted(says({ intent: 'WHAT_IF' }));
  setAnthropicClientForTesting(client);
  const r = await routeQuestion('which bye weeks line up badly?', { hasModel: true });
  assert.deepEqual([r.intent, r.by], ['WHAT_IF', 'model']);
  assert.equal(client.sent[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(client.sent[0].output_config.format.schema.properties.intent.enum.length, 7);
});

test('per intent: model, effort and lookup budget', () => {
  assert.equal(planFor('DO', 'should I trade for a WR').model, MODELS.strong);
  assert.equal(planFor('DO', 'who should I start').model, MODELS.normal);
  assert.equal(planFor('CHAT', 'lol').model, MODELS.cheap);
  assert.equal(planFor('CHAT', 'lol').toolRounds, 0);
  assert.equal(planFor('EXPLAIN', 'x').effort, null, 'Haiku takes no effort setting');
  for (const i of ['DO', 'WHY', 'WHAT_IF', 'ABOUT', 'CHANGE']) assert.ok(planFor(i, 'x').toolRounds <= 2);
});

const good = { verdict: { text: 'Hold your roster this week.', cites: [] }, stance: 'wait', basis: 'nothing clears',
  why: [{ text: 'No served move clears your rules this week.', cites: ['r1#0.next_move'] }], risks: [], refusals: [], as_of: null };

test('the shape check: limits and leads', () => {
  assert.deepEqual(shapeCheck(toAnswer(good)), []);
  const long = { ...good, verdict: { text: Array(LIMITS.verdictWords + 2).fill('word').join(' '), cites: [] } };
  assert.ok(shapeCheck(toAnswer(long)).some(v => v.block === 'verdict' && v.rule === 'too_long'));
  assert.ok(shapeCheck(toAnswer({ ...good, verdict: { text: 'The plan says hold.', cites: [] } })).some(v => v.rule === 'lead'));
  assert.equal(shapeCheck(toAnswer({ ...good, verdict: { text: 'No move clears this week.', cites: [] } })).length, 0, '"No" leads');
  const many = { ...good, why: Array(4).fill(good.why[0]) };
  assert.ok(shapeCheck(toAnswer(many)).some(v => v.rule === 'too_many'));
  const wordy = { ...good, why: [{ text: Array(LIMITS.whyWords + 1).fill('w').join(' '), cites: ['r1#0.x'] }] };
  assert.ok(shapeCheck(toAnswer(wordy)).some(v => v.block === 'why' && v.rule === 'too_long'));
  assert.ok(shapeCheck(toAnswer({ ...good, why: [], refusals: [] })).some(v => v.block === 'why' && v.rule === 'missing'));
});

test('enforcing the shape drops blocks, never the answer', () => {
  const bad = toAnswer({ ...good, why: [...Array(4).fill(good.why[0]), { text: Array(30).fill('w').join(' '), cites: [] }],
    risks: Array(3).fill({ text: 'Risk: he goes quiet.', cites: [] }) });
  const { answer, dropped } = enforceShape(bad);
  assert.equal(answer.shape.verdict.text, good.verdict.text);
  assert.equal(answer.shape.why.length, LIMITS.whyMax);
  assert.equal(answer.shape.risks.length, LIMITS.risksMax);
  assert.ok(dropped.length >= 3);
  assert.deepEqual(shapeCheck(answer), []);
});

test('askCoach shaped: one correction round for the format, then the answer ships with bad blocks dropped', async () => {
  const cite = 'r1#0.next_move';
  const off = { ...good, verdict: { text: 'The plan says hold.', cites: [] }, why: [{ text: 'No served move clears your rules this week.', cites: [cite] }] };
  let client = scripted(says(off), says(good));
  setAnthropicClientForTesting(client);
  let out = await askCoach({ question: 'what should I do', leagueId: 4, context: { league: 4 }, shaped: true, toolRounds: 0 });
  assert.equal(client.sent.length, 2, 'one correction round');
  assert.match(JSON.stringify(client.sent[1].messages.at(-1).content), /answer format/);
  assert.equal(out.answer.shape.verdict.text, 'Hold your roster this week.');
  assert.equal(out.verification.ok, true);
  assert.equal(out.answer.claims[0].text, 'No served move clears your rules this week.', 'why bullets are the verified claims');

  const tooMany = { ...good, why: Array(5).fill(good.why[0]) };
  client = scripted(says(tooMany), says(tooMany));
  setAnthropicClientForTesting(client);
  out = await askCoach({ question: 'what should I do', leagueId: 4, context: { league: 4 }, shaped: true, toolRounds: 0 });
  assert.equal(out.answer.shape.why.length, LIMITS.whyMax, 'extra bullets dropped');
  assert.ok(out.verification.shape_dropped.length > 0, 'the drop is reported');
});

test('a shaped refusal keeps a verdict; an uncited number in the verdict is caught by verify.js', async () => {
  const client = scripted(
    says({ ...good, verdict: { text: 'Send it: 87% he says yes.', cites: [] }, why: [] , refusals: [] }),
    says({ ...good, verdict: { text: 'Send it: 87% he says yes.', cites: [] }, why: [], refusals: [] }));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'what should I do', leagueId: 4, context: { league: 4 }, shaped: true, toolRounds: 0 });
  assert.equal(out.answer.claims.length, 0, 'the unsupported number never ships');
  assert.ok(out.answer.refusals.length);
  assert.ok(out.answer.shape.verdict.text && !/\d/.test(out.answer.shape.verdict.text), 'a verdict with no number stands in');
});

test('plan ($0) answers come back in the same format: verdict from the first line, why and risks, the rest folded', async () => {
  const { shapeDeterministic } = await import('../server/services/coach/answer-shape.js');
  const c = (text, cite = 'r1#0.x') => ({ text, cites: [cite] });
  const out = shapeDeterministic({ claims: [c('Offer Team 3 P4 (WR) + P6 (RB) for P21 (WR).'), c('Chance he says yes: 53%, a guess.'),
    c('If he says yes, title odds move +11.6 pts to 54%.'), c('When: Now.'), c('If he says no: Log the reason.'), c('The risk: he says no.'),
    c('Nudge to copy: "Still open?"')], refusals: [] });
  assert.equal(out.shape.verdict.text, 'Send Team 3 P4 (WR) + P6 (RB) for P21 (WR).');
  assert.deepEqual(out.shape.verdict.cites, ['r1#0.x']);
  assert.equal(out.shape.why.length, 3);
  assert.deepEqual(out.shape.risks.map(r => r.text), ['If he says no: Log the reason.', 'The risk: he says no.']);
  assert.equal(out.shape.more.length, 1);
  assert.equal(out.claims.length, 7, 'the grounded claims are untouched');
  const none = shapeDeterministic({ claims: [c('No next move: nothing clears your sliders this week and every path overpays by FantasyCalc value.')], refusals: [] });
  assert.equal(none.shape.verdict.text, 'No move clears your rules this week.');
  const refused = shapeDeterministic({ claims: [], refusals: ['That one needs the AI model, which is off here, so Coach is not guessing.'] });
  assert.equal(refused.shape.verdict.text, 'No answer from your plan on this one.');
});

test('no dev text on screen: the live answer of 2026-09-26 is caught, corrected once, then stripped', async () => {
  const { devText, devTextViolations, stripDevText, NOT_ON_FILE } = await import('../server/services/coach/answer-shape.js');
  const LIVE = "nfl_injuries table doesn't have the columns I guessed (injury_status/practice_status)… need the correct column names";
  assert.ok(devText(LIVE).length >= 2, 'snake_case and schema talk');
  assert.ok(devText('Check player_analysis for him').length);
  assert.ok(devText('His snap_share fell last week').length);
  assert.deepEqual(devText('Send the offer on the table tonight.'), [], '"on the table" is plain English');
  assert.deepEqual(devText('No health update on file yet.'), []);
  const live = { claims: [], refusals: [LIVE], as_of: null,
    shape: { verdict: { text: 'Check the nfl_injuries table first.', cites: [] }, stance: 'none', basis: '',
      why: [{ text: 'His snap_share fell to 61%.', cites: ['r1#0.x'] }, { text: 'He practiced in full Thursday.', cites: ['r1#0.y'] }], risks: [] } };
  assert.equal(devTextViolations(live).length, 3);
  const { answer } = stripDevText(live);
  assert.equal(answer.shape.verdict.text, NOT_ON_FILE);
  assert.deepEqual(answer.shape.why.map(w => w.text), ['He practiced in full Thursday.']);
  assert.deepEqual(answer.refusals, [NOT_ON_FILE]);
  assert.deepEqual(devTextViolations(answer), []);

  // Through askCoach: one correction round, and what still shows dev text never ships.
  const bad = { verdict: { text: 'Check the nfl_injuries table first.', cites: [] }, stance: 'none', basis: '', why: [],
    risks: [], refusals: [LIVE], as_of: null };
  const client = scripted(says(bad), says(bad));
  setAnthropicClientForTesting(client);
  const out = await askCoach({ question: 'is my running back healthy', leagueId: 4, context: { league: 4 }, shaped: true, toolRounds: 0 });
  assert.equal(client.sent.length, 2, 'one correction round');
  assert.match(JSON.stringify(client.sent[1].messages.at(-1).content), /internal detail Nick must never see/);
  assert.equal(JSON.stringify(out.answer).match(/nfl_injuries|column|snake/), null, 'no dev text in the shipped answer');
});
