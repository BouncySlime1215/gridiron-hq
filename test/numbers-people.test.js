/**
 * NUMBERS-PEOPLE: the producer (a stand-in Claude client and a stand-in Jev; no network, no spend).
 *
 * Pinned here:
 *   - one run reads the plan's key items: Claude once for all of them (lane 1, numbers), then Jev
 *     once per item with a stored people signal, fed Claude's read (lane 2, "Claude -> Jev", Jev
 *     leads); one row per item with both lanes and a verdict; the comparison is DIFFER on a
 *     different stance, AGREE on the same stance and basis, SAME_BUT on the same stance and a
 *     different basis, and NO_PEOPLE_READ when nobody on the item has a stored signal
 *   - caching: a second run inside the window with the same plan asks nothing; a plan change or
 *     Refresh runs again; every run's rows are kept (history by week)
 *   - no chat text and no names: a speech-shaped stored value never reaches a prompt, prompts carry
 *     ids and plan numbers only, stored rows carry no quotes, and a why stating a number is withheld
 *   - spend is logged in ai_usage per lane under numbers_people:*, and the run's cost and latency kept
 *   - the budget used up: the run is recorded as 'budget', the view shows the last reads and a
 *     notice, and nothing throws
 * Names are made up (public repo); plans from the producer fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-numbers-people-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_NUMBERS_PEOPLE;
const PLANS_FILE = path.join(temp, 'plans.json');
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
fs.writeFileSync(PLANS_FILE, JSON.stringify(FIXTURE));
process.env.GRIDIRON_WARROOM_PLANS = PLANS_FILE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { setBrainSources } = await import('../server/services/coach/brain-tools.js');
const { setDailyBudget } = await import('../server/services/llm-budget.js');
const producer = await import('../server/services/numbers-people/producer.js');
const { verdictOf, cleanWhy, NP_FEATURES } = await import('../server/services/numbers-people/lanes.js');
const { numbersPeopleView } = await import('../server/services/numbers-people/view.js');
const { keyItems } = await import('../server/services/numbers-people/items.js');

run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at, current_week)
     VALUES (4, 'espn', 'fx-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00', 3)`);

const SENTINEL = "lol i'd never trade him SENTINEL-CHAT-LINE";
setBrainSources({ profiles: () => ({ status: 'ok', reason: null, as_of: Date.now(), byRoster: new Map([['3', {
  roster_id: '3', status: 'ok', reason: null,
  negotiation: { status: 'ok', messages_read: 12, confidence: 'medium',
    values_talk: { status: 'ok', wants: [{ player: 'P21 (WR)' }], shopping: [{ player: SENTINEL }], untouchable: [] } },
  override: { status: 'none', exclude: false, deprioritize: false, toughen: false },
  chat: { status: 'ok', p_open_to_trade: 0.7 } }]]) }) });
test.after(() => setBrainSources({ profiles: null }));

const usage = { input_tokens: 1000, output_tokens: 400 };
const laneOf = () => 'numbers';
const keysIn = body => [...JSON.stringify(body.messages).matchAll(/\\"key\\":\\"([a-z]+:[A-Za-z0-9-]+)\\"/g)].map(m => m[1]);

/**
 * A client that answers each lane from `script(lane, key)` -> { stance, basis, why?, cites? } for
 * every item key in the prompt. Records every body.
 */
function client(script) {
  const sent = [];
  const create = async body => {
    const lane = laneOf(body);
    sent.push({ lane, body: structuredClone(body) });
    const reads = keysIn(body).map(key => ({ key, why: 'This one is worth a look.', cites: [], ...script(lane, key) }));
    return { content: [{ type: 'text', text: JSON.stringify({ reads }) }], stop_reason: 'end_turn', usage };
  };
  return { sent, messages: { create } };
}

// Claude says go on everything, on title gain.
const SCRIPT = () => ({ stance: 'go', basis: 'title_gain', cites: ['p_yes_first_step', 'gain_if_landed', 'edge'] });
// Jev (only asked about roster 3's items): avoid the first move (DIFFER), go on title gain for
// partner 3 (AGREE), go on willingness for the rest (SAME_BUT).
function fakeJev() {
  const inputs = [];
  const lane = async input => {
    inputs.push(structuredClone(input));
    const k = input.item.key;
    const take = k === 'move:L4-1dhntz0' ? { stance: 'avoid', basis: 'willingness' }
      : k === 'partner:3' ? { stance: 'go', basis: 'title_gain' } : { stance: 'go', basis: 'willingness' };
    return { lead: 'jev', ...take, why: k === 'target:22' ? 'They have 3 players they want.' : 'The chat read backs Claude\'s call.',
      probabilities: { stance: 0.7, backs_claude: 0.6, willing: 0.55 }, cost_usd: 0.00001 };
  };
  return { inputs, lane };
}

const entry4 = () => JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8')).leagues.find(e => e.league === 4);

test('best first: the seven bands, then the odds gain if landed, then the chance of a deal', async () => {
  const { bestFirst, rankOf, bandOf } = await import('../server/services/numbers-people/order.js');
  const card = (name, claude, jev, facts = {}) => ({ name, claude, jev, facts, order: 0 });
  const shuffled = [
    card('avoid-avoid', 'avoid', 'avoid'), card('noread-avoid', 'avoid', null), card('wait-avoid', 'wait', 'avoid'),
    card('go-avoid', 'go', 'avoid'), card('avoid-go', 'avoid', 'go'), card('noread-wait', 'wait', null), card('wait-wait', 'wait', 'wait'),
    card('wait-go', 'wait', 'go'), card('go-wait', 'go', 'wait'), card('noread-go', 'go', null),
    card('go-go low gain', 'go', 'go', { gain_if_landed: 0.05, p_reach: 0.9 }),
    card('go-go high gain', 'go', 'go', { gain_if_landed: 0.2, p_reach: 0.1 }),
    card('go-go high gain, better deal', 'go', 'go', { gain_if_landed: 0.2, p_reach: 0.3 })
  ];
  assert.deepEqual(bestFirst(shuffled).map(c => c.name), [
    'go-go high gain, better deal', 'go-go high gain', 'go-go low gain',   // 1 both go; gain, then chance of a deal
    'noread-go',                                                            // 7 below both go
    'wait-go', 'go-wait',                                                   // 2 one go, one wait (either lane)
    'wait-wait', 'noread-wait',                                             // 3 both wait, then no read on wait
    'go-avoid', 'avoid-go',                                                 // 4 a real split (either lane; ties keep the producer's order)
    'wait-avoid',                                                           // 5
    'avoid-avoid', 'noread-avoid'                                           // 6 both avoid, then no read on avoid
  ]);
  assert.equal(rankOf('go', 'wait'), rankOf('wait', 'go'), 'either lane');
  assert.deepEqual(['go|go', 'go|avoid', 'avoid|avoid', 'wait|wait', 'go|'].map(k => bandOf(...k.split('|').map(x => x || null))),
    ['go', 'split', 'avoid', 'wait', 'no_read']);
  // A move ties on its full-move gain; a league-mate on the edge; the chance of a deal next.
  assert.deepEqual(bestFirst([card('m1', 'go', 'go', { title_gain_if_complete: 0.1, p_complete: 0.2 }),
    card('m2', 'go', 'go', { title_gain_if_complete: 0.1, p_complete: 0.5 })]).map(c => c.name), ['m2', 'm1']);
});

test('the comparison step', () => {
  assert.equal(verdictOf({ stance: 'go', basis: 'price' }, { stance: 'wait', basis: 'price' }), 'differ');
  assert.equal(verdictOf({ stance: 'go', basis: 'price' }, { stance: 'go', basis: 'price' }), 'agree');
  assert.equal(verdictOf({ stance: 'go', basis: 'price' }, { stance: 'go', basis: 'willingness' }), 'same_but');
  assert.equal(verdictOf({ stance: 'go', basis: 'price' }, null), 'no_people_read');
  assert.equal(cleanWhy('He has 3 players he wants.'), null, 'a why with a number is withheld');
  assert.equal(cleanWhy('he said "never"'), null, 'a quote is withheld');
  assert.equal(cleanWhy('  Worth it   now. '), 'Worth it now.');
});

test('one run: Claude once, Jev per item with a signal (fed Claude\'s read), a verdict per item, no chat text or names', async () => {
  const c = client(SCRIPT);
  setAnthropicClientForTesting(c);
  const jev = fakeJev();
  const out = await producer.runForLeague(4, { trigger: null, jevLane: jev.lane });
  assert.equal(out.status, 'ran');
  assert.equal(c.sent.length, 1, 'one Claude call for every item');
  assert.deepEqual(out.jev, { asked: jev.inputs.length, answered: jev.inputs.length });
  const items = keyItems(entry4());
  assert.equal(out.items, items.length);
  const stored = rows('SELECT * FROM numbers_people_reads WHERE run_id = ? ORDER BY id', out.run_id);
  const byKey = Object.fromEntries(stored.map(r => [`${r.item_type}:${r.item_id}`, r]));
  assert.equal(byKey['move:L4-1dhntz0'].verdict, 'differ');
  assert.equal(byKey['partner:3'].verdict, 'agree');
  assert.equal(byKey['target:22'].verdict, 'same_but', 'target 22 is on roster 3, which has a signal');
  assert.equal(byKey['target:11'].verdict, 'no_people_read', 'target 11 is on roster 2: no stored signal');
  assert.match(JSON.parse(byKey['target:11'].lane_b).skipped, /no stored people signal/);
  // Jev was asked only about roster 3's items, and was given Claude's read of each.
  const jevKeys = jev.inputs.map(i => i.item.key);
  assert.deepEqual(jevKeys.sort(), ['move:L4-1dhntz0', 'move:L4-1sxri0k', 'move:L4-umwph9', 'partner:3', 'target:22']);
  for (const i of jev.inputs) {
    assert.deepEqual([i.claude.stance, i.claude.basis], ['go', 'title_gain'], 'Claude\'s read is Jev\'s input');
    assert.ok(i.signals.length > 0);
  }
  assert.equal(JSON.parse(byKey['partner:3'].lane_b).lead, 'jev');
  assert.equal(JSON.parse(byKey['partner:3'].lane_b).claude_stance, 'go');
  // A why with a number is withheld, not stored.
  const b22 = JSON.parse(byKey['target:22'].lane_b);
  assert.equal(b22.why, null);
  assert.equal(b22.why_withheld, true);
  // Cites resolve to the plan's numbers (never the model's).
  const a = JSON.parse(byKey['move:L4-1dhntz0'].lane_a);
  assert.deepEqual(a.cites.map(x => [x.key, x.value]), [['p_yes_first_step', 0.525]]);
  // No chat text, no names, anywhere.
  const names = [...Object.values(entry4().names), ...Object.values(entry4().teams.value).map(t => t.name)];
  for (const body of [...c.sent.map(x => x.body), ...jev.inputs]) {
    const s = JSON.stringify(body);
    assert.doesNotMatch(s, /SENTINEL-CHAT-LINE/, 'no chat text in any prompt');
    for (const n of names.filter(x => !/^P21 \(WR\)$/.test(x))) assert.ok(!s.includes(`"${n}"`), `no name in a prompt: ${n}`);
  }
  const strings = o => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []);
  for (const r of stored) {
    for (const v of strings([JSON.parse(r.lane_a), JSON.parse(r.lane_b)])) {
      assert.doesNotMatch(v, /SENTINEL|["“”]|\blol\b/, `no chat text in a stored row: ${v}`);
      assert.ok(v.length <= 160, 'short labels and one-line whys only');
    }
  }
  const logged = rows(`SELECT feature FROM ai_usage WHERE feature LIKE 'numbers_people:%' ORDER BY id`).map(r => r.feature);
  assert.deepEqual(logged, [NP_FEATURES.claude], 'Claude\'s call is logged (the stand-in Jev logs nothing)');
  const runRow = rows('SELECT * FROM numbers_people_runs WHERE id = ?', out.run_id)[0];
  assert.equal(runRow.week, 3);
  assert.ok(runRow.cost_usd > 0);
  assert.ok(Number.isInteger(runRow.latency_ms));
});

test('caching: no second call in the window; a plan change and Refresh run again; history is kept', async () => {
  const c = client(SCRIPT);
  setAnthropicClientForTesting(c);
  const again = await producer.runForLeague(4);
  assert.equal(again.status, 'skipped');
  assert.equal(c.sent.length, 0, 'nothing asked inside the window');
  // Refresh (force) runs.
  const forced = await producer.runForLeague(4, { force: true, trigger: 'refresh', jevLane: fakeJev().lane });
  assert.equal(forced.status, 'ran');
  assert.equal(forced.trigger, 'refresh');
  // A plan change: the fifth target leaves the plan.
  const file = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
  file.leagues.find(e => e.league === 4).targets.value.pop();
  fs.writeFileSync(PLANS_FILE, JSON.stringify(file));
  const changed = await producer.runForLeague(4, { jevLane: fakeJev().lane });
  assert.equal(changed.status, 'ran');
  assert.equal(changed.trigger, 'plan_change');
  const runs = rows(`SELECT trigger FROM numbers_people_runs WHERE league_id = 4 AND status = 'ok' ORDER BY id`).map(r => r.trigger);
  assert.equal(runs.length, 3, 'every run kept');
  assert.equal(rows('SELECT COUNT(*) n FROM numbers_people_reads WHERE league_id = 4')[0].n > 20, true, 'every row kept');
  // The window rule itself.
  const now = Date.parse('2026-09-25T12:00:00Z');
  const last = { inputs_hash: 'h', created_at: '2026-09-25T07:00:00Z', status: 'ok' };
  assert.equal(producer.dueReason({ last, lastAny: last, hash: 'h', now }), null, '5 h: not due');
  assert.equal(producer.dueReason({ last: { ...last, created_at: '2026-09-25T05:59:00Z' }, lastAny: last, hash: 'h', now }), 'schedule', '6 h: due');
  assert.equal(producer.dueReason({ last, lastAny: last, hash: 'other', now }), 'plan_change');
  // The week-by-week view: one entry per week, the last read of that week.
  run(`UPDATE numbers_people_reads SET week = 2 WHERE run_id = (SELECT MIN(id) FROM numbers_people_runs WHERE league_id = 4)`);
  const view = numbersPeopleView({ leagueId: 4, entry: entry4() });
  const move = view.items.find(i => i.key === 'move:L4-1dhntz0');
  assert.deepEqual(move.history.map(h => h.week), [2, 3]);
  // Best first: Claude says go on everything; Jev says go on all of roster 3's items but avoid on one move.
  const ranks = view.items.map(i => [i.numbers.stance, i.people.stance ?? null]);
  const firstNoRead = ranks.findIndex(([, j]) => j == null);
  assert.ok(ranks.slice(0, firstNoRead).every(([c, j]) => c === 'go' && j === 'go'), 'both say go on top');
  assert.ok(ranks.slice(firstNoRead, -1).every(([, j]) => j == null), 'then Claude-go with no chat read');
  assert.deepEqual(ranks.at(-1), ['go', 'avoid'], 'the go/avoid split is last here');
  assert.deepEqual([view.summary.both_go, view.summary.split, view.summary.both_avoid], [4, 1, 0]);
});

test('GRIDIRON_NUMBERS_PEOPLE=0 turns the producer off; nothing is asked', async () => {
  process.env.GRIDIRON_NUMBERS_PEOPLE = '0';
  try {
    const c = client(SCRIPT);
    setAnthropicClientForTesting(c);
    assert.equal((await producer.runForLeague(4, { force: true })).status, 'off');
    assert.equal((await producer.refreshNumbersPeople()).skipped, true);
    assert.equal(c.sent.length, 0);
    assert.equal(numbersPeopleView({ leagueId: 4 }).status, 'off');
  } finally { delete process.env.GRIDIRON_NUMBERS_PEOPLE; }
});

test('the budget used up: recorded, the last reads shown with a notice, no error', async () => {
  setDailyBudget('numbers_people', 0);
  try {
    const c = client(SCRIPT);
    setAnthropicClientForTesting(c);
    const jev = fakeJev();
    const out = await producer.runForLeague(4, { force: true, trigger: 'refresh', jevLane: jev.lane });
    assert.equal(out.status, 'budget');
    assert.equal(jev.inputs.length, 0, 'Jev is not asked without Claude\'s read');
    assert.equal(c.sent.length, 0, 'the budget stops the call before it is sent');
    const view = numbersPeopleView({ leagueId: 4, entry: entry4() });
    assert.equal(view.status, 'ok');
    assert.ok(view.items.length > 0, 'the last reads are still shown');
    assert.equal(view.notice.kind, 'budget');
    assert.match(view.notice.text, /used up.*Showing the last reads/);
    assert.doesNotMatch(view.notice.text, /\$|numbers_people|GRIDIRON/, 'no dollars or dev text on screen');
    // The schedule does not hammer a stopped budget.
    assert.equal((await producer.runForLeague(4)).status, 'skipped');
  } finally { setDailyBudget('numbers_people', null); }
});

test('the scheduler job is registered, off-thread, and never on preview', async () => {
  const { JOBS } = await import('../server/services/scheduler.js');
  const job = JOBS.numbers_people_reads;
  assert.ok(job, 'registered');
  assert.equal(job.offThread, true);
  assert.equal(job.tier, 'growth');
  const src = fs.readFileSync(new URL('../server/services/numbers-people/producer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /preview-mode/, 'the flag does not read preview mode');
});

test('Ask Coach about this: the item goes into the thread focus, ids only', async () => {
  const { setThreadFocus, activeThread } = await import('../server/services/coach/threads.js');
  const t = setThreadFocus(9911, 4, { move_id: 'L4-1dhntz0', partner: '3', players: ['21', '4'] });
  assert.deepEqual(t.focus, { move_id: 'L4-1dhntz0', step: 0, partner: '3', players: ['21', '4'], prev_move_id: null });
  const t2 = setThreadFocus(9911, 4, { partner: '4', players: ['32'] });
  assert.equal(t2.focus.prev_move_id, 'L4-1dhntz0', 'the move discussed before is kept for "the other one"');
  assert.equal(t2.focus.move_id, null);
  assert.throws(() => setThreadFocus(9911, 4, { partner: 'he said "no"' }), /focus id/);
  assert.equal(activeThread(9911, 4, { create: false }).id, t.id, 'the same thread');
});

test('jevLane: the COACH-LANES Jev stage (recorded reply), fed Claude\'s read, facts and labels; no chat text, no names; neutral why', async () => {
  const { createJevLane } = await import('../server/services/numbers-people/jev-lane.js');
  const sent = [];
  // A recorded Jev reply, in the gateway's shape ({ ok, answers, costUsd }).
  const ask = async ({ state, questions }) => {
    sent.push({ state, questions });
    return { ok: true, costUsd: 0.00004, answers: {
      better_stance: { type: 'choice', choice: 'wait', probabilities: { go: 0.2, wait: 0.7, avoid: 0.1 } },
      basis: { type: 'choice', choice: 'willingness', probabilities: { willingness: 0.6 } },
      claude_call_right: { type: 'boolean', probability: 0.3 }, p_accept: { type: 'boolean', probability: 0.2 } } };
  };
  const input = { item: { key: 'partner:3', kind: 'partner', players: [] }, facts: { p_responds: { value: 0.65, means: 'Reply chance (guess)' } },
    claude: { stance: 'go', basis: 'willingness', why: 'They reply often.' },
    signals: [{ ref: 's0', signal: 'profile', roster_id: '3', wants: 'P21 (WR)', p_open_to_trade: 0.7 }] };
  const take = await createJevLane({ ask })(input);
  assert.match(sent[0].state, /Claude's call on this partner: GO\. They reply often\./);
  assert.match(sent[0].state, /P21 \(WR\)/);
  assert.match(sent[0].state, /MANAGER M1/);
  assert.doesNotMatch(sent[0].state, /SENTINEL|roster_id/);
  assert.ok(sent[0].questions.better_stance && sent[0].questions.claude_call_right, 'the coach_take questions');
  assert.deepEqual([take.lead, take.stance, take.basis, take.cost_usd], ['jev', 'wait', 'willingness', 0.00004]);
  assert.equal(take.why, 'The chat read cuts against Claude\'s call; not ready to deal yet, so Jev says wait instead of go.');
  // No ask given: the stage's own client, JEV-01a's gateway (ledgered). With no gateway key here it
  // says so, and the lane is an honest skip, not an exception.
  const saved = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const off = await createJevLane()(input);
    assert.equal(off.skipped, 'jev_not_configured');
    assert.match(off.reason, /gateway key/);
  } finally { if (saved != null) process.env.AI_GATEWAY_API_KEY = saved; }
  // A failure is a skip that says so.
  const broken = await createJevLane({ ask: async () => ({ ok: false, error: '503 gateway down' }) })(input);
  assert.equal(broken.skipped, 'jev_failed');
});

test('one ledgered path: Numbers & People never calls a model or Jev directly', () => {
  const dir = new URL('../server/services/numbers-people/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /from ['"]ai['"]|import\(['"]ai['"]\)|experimental_evaluate|AI_GATEWAY_API_KEY|recordUsage|messages\.create/, `${f}: no direct client`);
  }
});

test('copy: league-mates are "they" (labels, whys), and no label is long enough to be cut off', async () => {
  const { FACT_LABELS, MAX_LABEL_CHARS, factLabel } = await import('../server/services/numbers-people/items.js');
  const { JEV_CITE_LABELS, neutral } = await import('../server/services/numbers-people/lanes.js');
  const { jevWhy } = await import('../server/services/numbers-people/jev-lane.js');
  const GENDERED = /\b(he|him|his|himself|she|her)\b/i;
  const labels = [...Object.keys(FACT_LABELS).flatMap(k => [factLabel(k, 'title_odds'), factLabel(k, 'playoff_odds')]), ...Object.values(JEV_CITE_LABELS)];
  for (const l of labels) {
    assert.doesNotMatch(l, GENDERED, l);
    assert.ok(l.length <= MAX_LABEL_CHARS, `${l} (${l.length} > ${MAX_LABEL_CHARS})`);
  }
  for (const stance of ['go', 'wait', 'avoid']) for (const backs of [0.2, 0.8]) for (const accept of [0.2, 0.8]) {
    assert.doesNotMatch(jevWhy({ stance, claude: { stance: 'go' }, backs, accept }), GENDERED);
  }
  assert.equal(neutral("He rarely accepts; his roster is thin and he's shopping."), null, 'an unswappable "he" is withheld');
  assert.equal(neutral("His roster is thin and he's shopping."), "Their roster is thin and they're shopping.");
  // Every static string in the view and the client components.
  const srcs = ['server/services/numbers-people/view.js', 'client/src/components/trade/NumbersPeople.tsx',
    'client/src/components/trade/NumbersPeopleCard.tsx', 'client/src/components/trade/numbersPeopleParts.tsx'];
  for (const f of srcs) {
    const code = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const m of code.matchAll(/(['"`])((?:(?!\1).){3,})\1/g)) assert.doesNotMatch(m[2], GENDERED, `${f}: ${m[2]}`);
    for (const m of code.matchAll(/>([^<>{}]{3,})</g)) assert.doesNotMatch(m[1], GENDERED, `${f}: ${m[1]}`);
  }
});

test('Coach: an answer about an item with a read carries that read (stored with the turn); flag off, none', async () => {
  const { setThreadFocus, threadMessages, activeThread } = await import('../server/services/coach/threads.js');
  const { chatTurn } = await import('../server/services/coach/chat.js');
  setThreadFocus(9912, 4, { move_id: 'L4-1dhntz0', partner: '3', players: ['21'] });
  const out = await chatTurn({ userId: 9912, leagueId: 4, question: 'why?', hasModel: false, context: { league: 4 } });
  assert.equal(out.intent, 'why', 'a $0 follow-up about the focused move');
  assert.equal(out.numbers_people?.key, 'move:L4-1dhntz0');
  assert.equal(out.numbers_people.verdict, 'differ');
  assert.equal(out.numbers_people.people.stance, 'avoid');
  const t = activeThread(9912, 4, { create: false });
  const stored = threadMessages(t.id).filter(m => m.role === 'coach').at(-1);
  assert.equal(stored.payload.numbers_people.key, 'move:L4-1dhntz0', 'a reopened drawer shows it too');
  process.env.GRIDIRON_NUMBERS_PEOPLE = '0';
  try {
    const off = await chatTurn({ userId: 9912, leagueId: 4, question: 'why?', hasModel: false, context: { league: 4 } });
    assert.equal(off.numbers_people, undefined);
  } finally { delete process.env.GRIDIRON_NUMBERS_PEOPLE; }
});
