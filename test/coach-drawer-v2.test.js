/**
 * COACH-V2 unit 5, DRAWER v2 (COACH-V2.md section 3). Recorded replies only; no network, no spend.
 *
 * Pinned here:
 *   - thinking stages: one line that changes in place, shown as soon as Nick asks (before any
 *     server event), from the streamed events; "Still working, the numbers will show first." after 8 s
 *   - the partial answer: lane 1's answer shows while Jev reads, then the full answer replaces it
 *   - states: empty, thinking, answered, partial, failed (plain cause + Try again), AI-off / limit banner
 *   - the goal strip never shows placeholder copy ("not computed yet"): the parts the plan has, or
 *     "Plan not ready yet"; a layout that fails to load says one plain line, never the raw error
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, domRenderer, click, textOf, one, waitFor, button, all } from './helpers/warroom-render.js';

installDom();
let spend = { model_on: true, spent_today_usd: 0.12, daily_budget_usd: 5 };
let layout = async () => ({ enabled: true, saved: null });
const plainAsks = [];
globalThis.__warRoomApiCall = async (p, opts = {}) => {
  if (p === '/coach/spend') return spend;
  if (p === '/warroom/layout') return layout();
  if (p === '/coach/ask') { plainAsks.push(JSON.parse(opts.body)); return { answer: { claims: [{ text: 'Plain answer.', cites: [] }], refusals: [] } }; }
  return {};
};
globalThis.__warRoomApi = {};
const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { CoachDrawer, useWarRoomCoach } = await wr.mod('coach/index');
const drawer = await wr.mod('coach/CoachDrawer');
const stream = await wr.mod('coach/coachStream');
const hook = await wr.mod('coach/useWarRoomCoach');
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; wr.cleanup(); });

const GOAL = { destination: 'Win the title', stops_left: '2', next_move: 'an offer' };
const coachWith = (over = {}) => ({
  enabled: true, messages: [], busy: false, error: null, pending: null, starters: [], log: [], stage: null, stageWho: null, partial: null,
  session: { history: [] }, ui: { cards: [], drafts: {}, league: 4 }, footer: GOAL,
  ask: async () => null, undo() {}, cancel() {}, confirm: async () => {}, clearError() {}, newConversation: async () => {}, doProposal: async () => {},
  ...over
});
const render = coach => mount(React.createElement(CoachDrawer, { coach, open: true, onClose() {} }));
const tick = () => new Promise(r => setImmediate(r));

/* ------------------------------------------------------------ pure parts */

test('stages: every server event maps to one of five lines, in Nick\'s words', () => {
  const { stageOf, stageText, STILL_WORKING, STILL_WORKING_MS } = stream;
  const seen = ['understood', 'routed', 'preloaded', 'planning', 'query', 'lane2_start', 'checking', 'drafting', 'rejected', 'reshaping'].map(t => stageOf({ t }));
  assert.deepEqual(seen, ['reading', 'checking_league', 'checking_league', 'checking_league', 'checking_league', 'asking_jev', 'comparing', 'comparing', 'rechecking', 'rechecking']);
  assert.equal(stageOf({ t: 'lane1' }), null, 'the partial answer does not change the line');
  assert.equal(stageOf(null), null);
  assert.equal(stageText('asking_jev', 'Team 2'), 'Asking Jev about Team 2…');
  assert.equal(stageText('asking_jev', null), 'Asking Jev…');
  for (const s of ['reading', 'checking_league', 'asking_jev', 'comparing', 'rechecking']) assert.doesNotMatch(stageText(s), /_|engine|lane|verify/i, s);
  assert.equal(STILL_WORKING, 'Still working, the numbers will show first.');
  assert.equal(STILL_WORKING_MS, 8000);
});

test('parseSse: whole events out, the unfinished tail kept, a bad payload is an error', () => {
  const { parseSse } = stream;
  const a = parseSse('data: {"t":"understood"}\n\ndata: {"t":"rou');
  assert.deepEqual(a.events, [{ t: 'understood' }]);
  assert.equal(a.rest, 'data: {"t":"rou');
  const b = parseSse(`${a.rest}ted"}\n\n: comment\n\n`);
  assert.deepEqual(b.events, [{ t: 'routed' }]);
  assert.equal(b.rest, '');
  assert.throws(() => parseSse('data: not json\n\n'), SyntaxError);
});

test('goal strip: the parts the plan has, "Plan not ready yet" when none, never placeholder copy', () => {
  const { contextParts } = drawer;
  assert.deepEqual(contextParts(GOAL), ['Win the title', '2 stops left', 'Next: an offer']);
  assert.deepEqual(contextParts({ destination: 'Win the title', stops_left: '1', next_move: 'not computed yet' }), ['Win the title', '1 stop left']);
  assert.deepEqual(contextParts({ destination: 'no goal set yet', stops_left: 'not computed yet', next_move: 'not computed yet' }), ['Plan not ready yet']);
});

test('banner: AI off, or today\'s limit used, says plan answers still work; otherwise none', () => {
  const { aiBanner } = drawer;
  assert.equal(aiBanner(null), null);
  assert.equal(aiBanner({ model_on: true, spent_today_usd: 1, daily_budget_usd: 5 }), null);
  assert.match(aiBanner({ model_on: false, spent_today_usd: 0 }), /^The AI is off here\. Answers from your plan still work\.$/);
  assert.match(aiBanner({ model_on: true, spent_today_usd: 5, daily_budget_usd: 5 }), /^Today's AI limit is used\./);
});

test('a failure in plain words, never the raw error', () => {
  const { failedText } = hook;
  const raw = [Object.assign(new Error('HTTP 429 budget exceeded for coach:answer'), { status: 429 }),
    Object.assign(new Error('Your credit balance is too low (req_011abc)'), { status: 503 }),
    Object.assign(new Error('jwt expired'), { status: 401 }), new Error('TypeError: x is undefined at chat.js:212')];
  const said = raw.map(failedText);
  assert.deepEqual(said, ["Today's AI limit is used. Answers from your plan still work.", "Coach's AI is unavailable right now. Answers from your plan still work.",
    'Coach could not sign in to answer. Reload the page and try again.', 'Coach could not answer this one.']);
  for (const t of said) assert.doesNotMatch(t, /HTTP|req_|jwt|TypeError|\.js/);
});

/* ------------------------------------------------------------ the drawer */

test('empty: an empty state above the starter questions; the goal strip has no placeholder copy', async () => {
  const ui = render(coachWith({ footer: { destination: 'no goal set yet', stops_left: 'not computed yet', next_move: 'not computed yet' } }));
  await waitFor(() => all(ui.container, e => e.getAttribute?.('data-testid') === 'coach-fixed-q').length > 0, 2000, 'the starters');
  const text = textOf(ui.container);
  assert.match(text, /Ask Coach about your plan/);
  assert.equal(textOf(one(ui.container, 'data-testid', 'coach-context')), 'Plan not ready yet');
  assert.doesNotMatch(text, /not computed yet|no goal set yet/);
  ui.unmount();
});

test('thinking: the stage line and skeletons; after 8 s "Still working"', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = render(coachWith({ busy: true, stage: 'checking_league', messages: [{ who: 'nick', text: 'what should I do?' }] }));
  for (let i = 0; i < 5; i++) await tick();
  const box = one(ui.container, 'data-testid', 'coach-thinking');
  assert.ok(box, 'the thinking box shows');
  assert.equal(box.getAttribute('data-stage'), 'checking_league');
  assert.equal(textOf(one(box, 'data-testid', 'coach-stage')), 'Checking the league…');
  assert.equal(one(box, 'data-testid', 'coach-still-working'), null);
  t.mock.timers.tick(7999);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(one(box, 'data-testid', 'coach-still-working'), null, 'not before 8 s');
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(textOf(one(ui.container, 'data-testid', 'coach-still-working')), 'Still working, the numbers will show first.');
  ui.unmount();
});

test('partial: lane 1\'s answer shows while Jev reads, with "Asking Jev about Team 2…"', async () => {
  const partial = { who: 'coach', text: '', claims: [{ text: 'Send the served offer tonight.', cites: [] }], refusals: [], partial: true, shape: null };
  const ui = render(coachWith({ busy: true, stage: 'asking_jev', stageWho: 'Team 2', partial, messages: [{ who: 'nick', text: 'should I send it?' }] }));
  const box = await waitFor(() => one(ui.container, 'data-testid', 'coach-partial'), 2000, 'the partial');
  assert.match(textOf(box), /Send the served offer tonight\./);
  assert.equal(textOf(one(box, 'data-testid', 'coach-stage')), 'Asking Jev about Team 2…');
  ui.unmount();
});

test('failed: the cause in plain words and Try again, which asks the same question', async () => {
  const asked = [];
  const ui = render(coachWith({ ask: async q => { asked.push(q); return null; },
    messages: [{ who: 'nick', text: 'should I send it?' }, { who: 'coach', text: '', failed: 'Coach could not answer this one.', question: 'should I send it?' }] }));
  const retry = await waitFor(() => button(ui.container, 'Try again'), 2000, 'Try again');
  assert.match(textOf(ui.container), /No answer this time.*Coach could not answer this one\./);
  click(retry);
  assert.deepEqual(asked, ['should I send it?']);
  ui.unmount();
});

test('banner: the AI off shows one line; plan starters still work', async () => {
  spend = { model_on: false, spent_today_usd: 0 };
  try {
    const ui = render(coachWith());
    const banner = await waitFor(() => one(ui.container, 'data-testid', 'coach-ai-banner'), 2000, 'the banner');
    assert.equal(textOf(banner), 'The AI is off here. Answers from your plan still work.');
    assert.ok(all(ui.container, e => e.getAttribute?.('data-testid') === 'coach-fixed-q').length > 0);
    ui.unmount();
  } finally { spend = { model_on: true, spent_today_usd: 0.12, daily_budget_usd: 5 }; }
});

/* ------------------------------------------------------------ the hook */

function mountHook() {
  const box = { coach: null };
  const Probe = () => { box.coach = useWarRoomCoach({ leagueId: 4, leagues: [4], plans: undefined }); return null; };
  const ui = mount(React.createElement(Probe));
  return { box, ui };
}

test('layout load fails: one plain line, never the raw error', async () => {
  layout = async () => { throw new Error('SQLITE_BUSY: database is locked (warroom_layouts)'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { box, ui } = mountHook();
    await waitFor(() => box.coach?.error, 2000, 'the error');
    assert.equal(box.coach.error, "Couldn't load your layout; showing the default.");
    ui.unmount();
  } finally { console.warn = warn; layout = async () => ({ enabled: true, saved: null }); }
});

test('streamed ask: "Reading" at once, the stages as events arrive, lane 1 as a partial, then the answer', async () => {
  let push;
  const body = new ReadableStream({ start(c) { push = c; } });
  const enc = new TextEncoder();
  const send = ev => push.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, accept: init.headers.Accept });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
  try {
    const { box, ui } = mountHook();
    await waitFor(() => box.coach?.enabled, 2000, 'the hook');
    const done = box.coach.ask('should I send the offer?');
    await waitFor(() => box.coach.busy && box.coach.stage === 'reading', 300, 'the first stage within 300 ms, before any event');
    assert.deepEqual(sent, [{ url: '/api/coach/ask', accept: 'text/event-stream' }]);
    send({ t: 'understood' }); send({ t: 'routed', intent: 'TRADE' });
    await waitFor(() => box.coach.stage === 'checking_league', 2000, 'checking the league');
    send({ t: 'lane1', answer: { claims: [{ text: 'Send the served offer tonight.', cites: [] }], refusals: [] }, ledger: null });
    send({ t: 'lane2_start', who: 'Team 2' });
    await waitFor(() => box.coach.stage === 'asking_jev' && box.coach.partial, 2000, 'the partial');
    assert.equal(box.coach.stageWho, 'Team 2');
    assert.equal(box.coach.partial.claims[0].text, 'Send the served offer tonight.');
    send({ t: 'result', answer: { claims: [{ text: 'Send the served offer tonight, leading with their need.', cites: [] }], refusals: [] }, thread: { followups: ['What if they say no?'] } });
    push.close();
    const reply = await done;
    assert.equal(reply.claims[0].text, 'Send the served offer tonight, leading with their need.');
    await waitFor(() => !box.coach.busy && !box.coach.partial, 2000, 'the partial cleared');
    assert.deepEqual(plainAsks, [], 'no second, plain ask');
    ui.unmount();
  } finally { globalThis.fetch = realFetch; }
});

test('no stream (an old server): the plain ask answers; a failed ask is a bubble with its question', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const { box, ui } = mountHook();
    await waitFor(() => box.coach?.enabled, 2000, 'the hook');
    const reply = await box.coach.ask('what now?');
    assert.equal(reply.claims[0].text, 'Plain answer.');
    assert.equal(plainAsks.length, 1);
    globalThis.fetch = async () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const warn = console.warn;
    console.warn = () => {};
    try { await box.coach.ask('and then?'); } finally { console.warn = warn; }
    await waitFor(() => !box.coach.busy && box.coach.messages.at(-1)?.who === 'coach', 2000, 'done');
    const last = box.coach.messages.at(-1);
    assert.deepEqual([last.failed, last.question], ['Coach could not answer this one.', 'and then?']);
    ui.unmount();
  } finally { globalThis.fetch = realFetch; plainAsks.length = 0; }
});
