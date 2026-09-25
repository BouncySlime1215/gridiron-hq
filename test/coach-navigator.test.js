/**
 * COACH-NAV: Coach turns plain words into itinerary edits, shows the engine's
 * trade-off before anything is written, writes only on Nick's confirm, and
 * ends every plan reply with a grounded "destination · where we are · next
 * move" line (server/services/coach/navigator.js).
 *
 * The plan is the contract's producer fixture (test/fixtures/warroom-contract/
 * producer-plans.json, written by the real producer on a made-up league), its
 * league 4: "go get player 21", balanced, with the brain gate holding all-in
 * back. Nick's roster there is team 1 of test/fixtures/campaign-league.mjs.
 * No real data, no model calls (the one askCoach test uses a stand-in client).
 *
 * METRIC (the unit's measure): 10 navigation requests, graded on the SERVED
 * path: runCoachTool('itinerary_edit') -> the action it hands the dashboard ->
 * the real client dispatcher (client warroomCoach.ts dispatch / confirm) ->
 * the real POST /api/warroom/:leagueId/requests route. Counted: correct edits,
 * previews shown before any write, writes without confirm (must be 0), every
 * edit either recorded after its own Confirm or queued and named (served),
 * grounded footer present. Printed as a `# METRIC` diagnostic.
 */
import express from 'express';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-nav-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_NAV;
delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;

const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const plansFile = path.join(temp, 'plans.json');
fs.writeFileSync(plansFile, JSON.stringify(PRODUCER));
process.env.GRIDIRON_WARROOM_PLANS = plansFile;

const { run, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer } = await import('../server/services/coach/verify.js');
const tools = await import('../server/services/coach/tools.js');
const client = await import('../client/src/components/warroom/coach/warroomCoach.ts');
const { hashSessionToken, requireAuthenticated } = await import('../server/platform/auth.js');
const { default: warroomRouter } = await import('../server/routes/warroom.js');

let nav = null;
try { nav = await import('../server/services/coach/navigator.js'); } catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

const LEAGUE = 4;
const USER = 7301;
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (${USER}, 'coach-nav-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (${USER}, ?, datetime('now','+1 day'))`, hashSessionToken('nav-token'));
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (${LEAGUE}, 'espn', 'nav-4', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-23 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (${LEAGUE}, ${USER}, 'member')`);

/* The served confirm route, mounted as server/index.js mounts it. */
const app = express();
app.use(express.json());
app.use('/api/warroom', requireAuthenticated, warroomRouter);
const server = app.listen(0);
test.after(() => server.close());
const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/warroom/${LEAGUE}/requests`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nav-token' },
  body: JSON.stringify(body) });
const CTX = { leagues: [LEAGUE], plans: PRODUCER.leagues.find(l => l.league === LEAGUE), now: '2026-09-24T12:00:00.000Z' };

/** Team 1 of campaign-league.mjs, best first per position (P2 is his RB1). */
const ROSTER = [
  { player_id: '1', position: 'QB', rank: 1 }, { player_id: '2', position: 'RB', rank: 1 },
  { player_id: '3', position: 'RB', rank: 2 }, { player_id: '6', position: 'RB', rank: 3 },
  { player_id: '4', position: 'WR', rank: 1 }, { player_id: '7', position: 'WR', rank: 2 },
  { player_id: '5', position: 'TE', rank: 1 }
];
nav?.setNavigatorSources({ roster: id => (id === LEAGUE ? ROSTER : null) });

const withNav = async (fn, value = '1') => {
  const was = process.env.GRIDIRON_COACH_NAV;
  process.env.GRIDIRON_COACH_NAV = value;
  try { return await fn(); } finally { if (was === undefined) delete process.env.GRIDIRON_COACH_NAV; else process.env.GRIDIRON_COACH_NAV = was; }
};
const requestRows = () => row('SELECT COUNT(*) n FROM warroom_requests').n;

/** The fixed set: Nick's words and the edit(s) they must become. Labels are free; every typed field is checked. */
const NAV_SET = [
  { ask: 'get a WR1 by week 8 but keep my RB1', want: [
    { type: 'add_stop', stop: { kind: 'get', player_id: null, week: 8 } },
    { type: 'add_stop', stop: { kind: 'untouchable', player_id: '2', week: null } }] },
  { ask: 'go all in', want: [{ type: 'set_risk_mode', mode: 'all_in', until_week: null }] },
  { ask: 'add a stop: cover the week-9 bye', want: [{ type: 'add_stop', stop: { kind: 'cover_bye', player_id: null, week: 9 } }] },
  { ask: 'play it safe until week 6', want: [{ type: 'set_risk_mode', mode: 'safe', until_week: 6 }] },
  { ask: 'forget the title, just make the playoffs', want: [{ type: 'set_objective', goal: 'playoffs', arrive_by: null }] },
  { ask: 'I want P11 by week 7', want: [{ type: 'set_objective', goal: 'get_player', player_id: '11', arrive_by: 7 }] },
  { ask: "don't trade P3, he's untouchable", want: [{ type: 'add_stop', stop: { kind: 'untouchable', player_id: '3', week: null } }] },
  { ask: 'drop the P21 stop', want: [{ type: 'remove_stop', stop_id: 'plan-0' }] },
  { ask: 'sell P6 before his week-6 bye', want: [{ type: 'add_stop', stop: { kind: 'sell', player_id: '6', week: 6 } }] },
  { ask: 'aim for 130 points a week', want: [{ type: 'set_objective', goal: 'points', points_per_week: 130, arrive_by: null }] }
];

/** The typed part of an edit (the label is Nick-facing wording, not graded). */
function typed(e) {
  const out = { type: e.type };
  for (const k of ['mode', 'until_week', 'goal', 'player_id', 'points_per_week', 'arrive_by', 'stop_id']) {
    if (k in e) out[k] = e[k] ?? null;
  }
  if (e.stop) out.stop = { kind: e.stop.kind, player_id: e.stop.player_id ?? null, week: e.stop.week ?? null };
  return out;
}
const sameEdits = (got, want) => JSON.stringify(got.map(typed)) === JSON.stringify(want.map(typed));

const KIND = { set_objective: 'objective.set', add_stop: 'stop.add', remove_stop: 'stop.remove', set_risk_mode: 'mode.set', set_tolerance: 'tolerance.set' };
const FOOTER = /^Destination: .+ · Where we are: .+ · Next move: .+\.$/;

/**
 * Grade one request on the served path. Turn 1 sends Nick's words through
 * runCoachTool; each later turn sends the `queued` list back (what Coach does
 * when Nick says "next change"). Every served action goes through the real
 * client dispatcher, an unconfirmed POST attempt, then Confirm and the real
 * POST with what the client sends.
 */
async function grade({ ask, want }) {
  const before = requestRows();
  const coachTurn = input => {
    const ledger = newLedger();
    const res = tools.runCoachTool('itinerary_edit', { league_id: LEAGUE, ...input }, { ledger });
    return { ...res, ledger };
  };
  const first = coachTurn({ request: ask });
  const { proposal } = first.summary;
  const correct = sameEdits(proposal.edits, want);
  const previewedServer = proposal.edits.length > 0
    && proposal.previews.length === proposal.edits.length
    && proposal.previews.every(p => (p.status === 'ok' || p.status === 'unknown')
      && Number.isFinite(p.title_now) && Number.isInteger(p.eta_week))
    && first.summary.claims.some(c => /^Trade-off for |^The planner has not priced/.test(c.text));
  const queuedNamed = !first.summary.queued.length || first.summary.refusals.some(r => r.includes('Queued behind it'));

  let unconfirmedWrites = 0;
  let previewedClient = true;
  const recorded = [];
  let turn = first;
  let s = client.newSession();
  for (let i = 0; i < 5 && turn.action; i++) {
    const rowsBefore = requestRows();
    const d = client.dispatch(s, turn.action, CTX, ask);
    previewedClient &&= d.outcome.status === 'previewed' && d.session.pending?.action.type === turn.action.type;
    // Unconfirmed: the tool, the preview, and a Coach-sourced POST without Confirm write nothing.
    const req = client.requestFor(turn.action);
    const bad = await post({ kind: req.kind, payload: req.payload, source: 'coach' });
    unconfirmedWrites += requestRows() - rowsBefore + (bad.status === 201 ? 1 : 0);
    // Confirm: what the War Room hook POSTs.
    const c = client.confirm(d.session, CTX);
    const ok = await post({ kind: c.request.kind, payload: c.request.payload, source: 'coach', confirmed: true });
    if (ok.status === 201) recorded.push((await ok.json()).request);
    s = c.session;
    turn = turn.summary.queued.length ? coachTurn({ request: 'next change', edits: turn.summary.queued }) : { action: null };
  }
  // Every wanted edit ends as its own Coach-sourced, confirmed row, in order.
  const served = recorded.length === want.length && queuedNamed
    && recorded.every((r, i) => r.source === 'coach' && r.confirmed === true && r.kind === KIND[want[i].type]
      && (!want[i].stop || (r.payload.stop.kind === want[i].stop.kind && (r.payload.stop.player_id ?? null) === want[i].stop.player_id)));
  const last = first.summary.claims.at(-1);
  const recheck = verifyAnswer({ answer: { claims: first.summary.claims, refusals: first.summary.refusals, as_of: first.summary.as_of },
    ledger: first.ledger });
  const footer = !!last && FOOTER.test(last.text) && first.summary.grounded && recheck.ok;
  const priced = proposal.previews.filter(p => p.status === 'ok').length;
  return { ask, correct, previewed: previewedServer && previewedClient, served, priced, unconfirmedWrites, footer,
    proposal, rows: requestRows() - before, recorded: recorded.length };
}

test('METRIC: 10 navigation requests on league 4, served path -> edits, previews, 0 unconfirmed writes, served, footer', async t => {
  if (!nav) {
    t.diagnostic('METRIC correct=0/10 previews=0/10 served=0/10 priced=0/10 unconfirmed_writes=0 footer=0/10 (no navigator on this tree)');
    assert.fail('Coach has no navigation tool on this tree (0/10)');
  }
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  let graded;
  try {
    graded = [];
    for (const item of NAV_SET) graded.push(await withNav(() => grade(item)));
  } finally { delete process.env.GRIDIRON_WARROOM_ENABLED; }
  const n = k => graded.filter(g => g[k]).length;
  const writes = graded.reduce((s, g) => s + g.unconfirmedWrites, 0);
  const priced = graded.filter(g => g.priced > 0).length;
  t.diagnostic(`METRIC correct=${n('correct')}/10 previews=${n('previewed')}/10 served=${n('served')}/10 priced=${priced}/10 unconfirmed_writes=${writes} footer=${n('footer')}/10`);
  for (const g of graded) {
    t.diagnostic(`${g.correct ? 'ok ' : 'BAD'} ${JSON.stringify(g.ask)} -> ${JSON.stringify(g.proposal.edits.map(typed))}` +
      ` recorded=${g.recorded}/${g.proposal.edits.length}${g.previewed ? '' : ' [no preview]'}${g.served ? '' : ' [not served]'}${g.footer ? '' : ' [footer]'}`);
  }
  assert.ok(n('correct') >= 9, `correct edits ${n('correct')}/10`);
  assert.equal(n('previewed'), 10);
  assert.equal(n('served'), 10);
  assert.equal(writes, 0);
  assert.equal(n('footer'), 10);
});

/**
 * Paraphrases written AFTER the parser rules, graded untouched first: 9/10
 * (the miss, "I'd like a starting receiver ...", had no get verb; "i'd like /
 * need / find me / looking for" were then added). Kept as a regression set.
 */
const PARAPHRASES = [
  { ask: "I'd like a starting receiver before week 8, and don't touch my top RB", want: NAV_SET[0].want },
  { ask: 'swing big this week', want: NAV_SET[1].want },
  { ask: 'we need to plan for the week 9 bye', want: NAV_SET[2].want },
  { ask: 'be conservative through week 6', want: NAV_SET[3].want },
  { ask: 'honestly just sneak into the playoffs', want: NAV_SET[4].want },
  { ask: 'target P11', want: [{ type: 'set_objective', goal: 'get_player', player_id: '11', arrive_by: null }] },
  { ask: 'P3 is off limits', want: NAV_SET[6].want },
  { ask: 'remove P21 from the route', want: NAV_SET[7].want },
  { ask: 'shop P6 by week 6', want: NAV_SET[8].want },
  { ask: 'go for the title', want: [{ type: 'set_objective', goal: 'title', arrive_by: null }] }
];

test('paraphrase set: the same edits from different words', t => {
  const got = PARAPHRASES.map(p => ({ ...p, edits: nav.navigate({ leagueId: LEAGUE, text: p.ask }).proposal.edits }));
  const ok = got.filter(g => sameEdits(g.edits, g.want)).length;
  t.diagnostic(`PARAPHRASES correct=${ok}/10`);
  for (const g of got.filter(x => !sameEdits(x.edits, x.want))) t.diagnostic(`BAD ${JSON.stringify(g.ask)} -> ${JSON.stringify(g.edits.map(typed))}`);
  assert.ok(ok >= 9, `${ok}/10`);
});

test('the footer is one grounded line read from the plan: destination, where we are, next move', () => {
  const out = nav.navigate({ leagueId: LEAGUE, text: 'go all in' });
  const footer = out.answer.claims.at(-1);
  assert.equal(footer.text,
    'Destination: Get P21 (WR) · Where we are: 43% title odds now, 43% planned, ETA week 4 · Next move: give P4 (WR) + P6 (RB) to Team 3 for P21 (WR).');
  assert.ok(footer.cites.length >= 6);
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
});

test('a priced change shows the engine trade-off: cost, net, verdict, ETA, and the brain gate', () => {
  const out = nav.navigate({ leagueId: LEAGUE, text: 'go all in' });
  const [p] = out.proposal.previews;
  assert.equal(p.status, 'ok');
  assert.equal(p.key, 'mode:all_in');
  assert.equal(p.verdict, 'not_worth_it');
  assert.equal(p.gated_to, 'balanced');
  const texts = out.answer.claims.map(c => c.text);
  assert.match(texts[0], /^Trade-off for "Switch to .+": costs 2\.4 pts of title odds, gains 0\.0, net -2\.4; not worth it, because it gives up expected gain\.$/);
  assert.ok(texts.some(x => /adds 0 steps to the route; the ETA is week 4 today; and it changes the next move/.test(x)), texts.join('\n'));
  assert.ok(texts.some(x => /brain gate is holding all-in back to balanced/.test(x)));
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
});

test('an unpriced change says so, with no number made up for it', () => {
  const out = nav.navigate({ leagueId: LEAGUE, text: 'add a stop: cover the week-9 bye' });
  const [p] = out.proposal.previews;
  assert.equal(p.status, 'unknown');
  assert.equal(p.cost, undefined);
  assert.match(out.answer.claims[0].text, /^The planner has not priced this change yet/);
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
});

test('a stop the producer did price reads its row under the same key the dashboard uses', () => {
  const doc = structuredClone(PRODUCER);
  const lg = doc.leagues.find(l => l.league === LEAGUE);
  const f = v => ({ status: 'ok', value: v, source: 'plan.path', unit: 'title_odds' });
  lg.stop_tradeoffs.value['add:cover_bye:9'] = { stop_label: 'Cover the week 9 bye', cost: f(0.012), extra_steps: 1,
    gain: f(0.004), net: f(-0.008), verdict: 'not_worth_it', because: 'the bye costs less than the trade to cover it', new_next_move_changes: false };
  fs.writeFileSync(plansFile, JSON.stringify(doc));
  try {
    const out = nav.navigate({ leagueId: LEAGUE, text: 'add a stop: cover the week-9 bye' });
    assert.equal(out.proposal.previews[0].status, 'ok');
    assert.equal(out.answer.claims[0].text,
      'Trade-off for "Cover the week 9 bye": costs 1.2 pts of title odds, gains 0.4, net -0.8; not worth it, because the bye costs less than the trade to cover it.');
    assert.match(out.answer.claims[1].text, /^It adds 1 step to the route; the ETA is week 4 today\.$/);
    assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
  } finally { fs.writeFileSync(plansFile, JSON.stringify(PRODUCER)); }
});

test('a two-edit request serves one action, queues and names the other, and nothing is written', async () => {
  const before = requestRows();
  const res = await withNav(() => tools.runCoachTool('itinerary_edit',
    { league_id: LEAGUE, request: 'get a WR1 by week 8 but keep my P2 untouchable' }, { ledger: newLedger() }));
  assert.equal(res.summary.proposal.edits.length, 2);
  assert.equal(res.action.type, 'add_stop');
  assert.equal(res.action.stop.kind, 'get');
  assert.equal(res.summary.on_screen.stop.kind, 'get');
  assert.deepEqual(res.summary.queued.map(e => [e.type, e.stop.kind, e.stop.player_id]), [['add_stop', 'untouchable', '2']]);
  assert.match(res.summary.refusals.join(' '), /one change at a time.+Queued behind it.+untouchable/);
  assert.equal(requestRows(), before);
  // "next change": the queued list comes back and is served as the next action.
  const next = await withNav(() => tools.runCoachTool('itinerary_edit',
    { league_id: LEAGUE, request: 'next change', edits: res.summary.queued }, { ledger: newLedger() }));
  assert.deepEqual([next.action.stop.kind, next.action.stop.player_id], ['untouchable', '2']);
  assert.deepEqual(next.summary.queued, []);
  assert.equal(requestRows(), before);
});

test('queued edits passed back are re-validated: an unknown or non-plan action is refused, not served', async () => {
  const res = await withNav(() => tools.runCoachTool('itinerary_edit',
    { league_id: LEAGUE, request: 'next change', edits: [{ type: 'send_offer', to: '7' }, { type: 'focus_panel', panel: 'targets' }] },
    { ledger: newLedger() }));
  assert.equal(res.action, undefined);
  assert.equal(res.summary.proposal.edits.length, 0);
  assert.match(res.summary.refusals.join(' '), /unknown action.+focus_panel is not a plan change/);
});

test('the served confirm route refuses a Coach plan change without Confirm and records it with one', async () => {
  process.env.GRIDIRON_WARROOM_ENABLED = '1';
  try {
    const before = requestRows();
    const bad = await post({ kind: 'mode.set', payload: { mode: 'all_in' }, source: 'coach' });
    assert.equal(bad.status, 400);
    assert.equal(requestRows(), before);
    const ok = await post({ kind: 'mode.set', payload: { mode: 'all_in' }, source: 'coach', confirmed: true });
    assert.equal(ok.status, 201);
    const { request } = await ok.json();
    assert.deepEqual([request.kind, request.source, request.confirmed], ['mode.set', 'coach', true]);
    assert.equal(requestRows(), before + 1);
  } finally { delete process.env.GRIDIRON_WARROOM_ENABLED; }
});

test('words that are not a plan change propose nothing and say so; a stop that is not on the route is not guessed', () => {
  const q = nav.navigate({ leagueId: LEAGUE, text: "what's my next move?" });
  assert.equal(q.proposal.edits.length, 0);
  assert.match(q.answer.refusals.join(' '), /does not read as a change to the plan/);
  assert.ok(FOOTER.test(q.answer.claims.at(-1).text));
  const r = nav.navigate({ leagueId: LEAGUE, text: 'remove the P35 stop' });
  assert.equal(r.proposal.edits.length, 0);
  assert.match(r.answer.refusals.join(' '), /no stop on the route matches/);
});

test('without a roster source "my RB1" stays a label for the producer, not a guessed player', () => {
  nav.setNavigatorSources({ roster: null });
  try {
    const out = nav.navigate({ leagueId: LEAGUE, text: 'keep my RB1' });
    assert.deepEqual(out.proposal.edits.map(typed), [{ type: 'add_stop', stop: { kind: 'untouchable', player_id: null, week: null } }]);
    assert.equal(out.proposal.edits[0].stop.label, 'Keep my RB1');
  } finally { nav.setNavigatorSources({ roster: id => (id === LEAGUE ? ROSTER : null) }); }
});

test('a league with no plan is a typed refusal and still ends with a footer that says so', () => {
  const out = nav.navigate({ leagueId: 99, text: 'go all in' });
  assert.match(out.answer.refusals.join(' '), /plan for league 99 is not readable/);
  assert.equal(out.proposal.previews[0].status, 'unknown');
  assert.ok(FOOTER.test(out.answer.claims.at(-1).text), out.answer.claims.at(-1).text);
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
});

test('flag: itinerary_edit is offered only with GRIDIRON_COACH_NAV or preview mode; =0 vetoes preview', async () => {
  const names = () => tools.toolDefinitions().map(d => d.name);
  assert.ok(!names().includes('itinerary_edit'));
  assert.throws(() => tools.runCoachTool('itinerary_edit', { league_id: LEAGUE, request: 'go all in' }, { ledger: newLedger() }),
    tools.CoachToolError);
  await withNav(() => assert.ok(names().includes('itinerary_edit')));
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.ok(names().includes('itinerary_edit'));
    await withNav(() => assert.ok(!names().includes('itinerary_edit')), '0');
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
});

test('through Coach (stand-in model): the tool proposes, writes nothing, and the echoed reply verifies', async () => {
  const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
  const { askCoach } = await import('../server/services/coach/ask.js');
  const usage = { input_tokens: 100, output_tokens: 50 };
  let toolResult = null;
  setAnthropicClientForTesting({ messages: { create: async body => {
    const last = body.messages.at(-1);
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      toolResult = JSON.parse(last.content[0].content);
      return { content: [{ type: 'text', text: JSON.stringify({ claims: toolResult.claims, refusals: toolResult.refusals, as_of: toolResult.as_of }) }],
        stop_reason: 'end_turn', usage };
    }
    return { content: [{ type: 'tool_use', id: 'tu1', name: 'itinerary_edit', input: { league_id: LEAGUE, request: 'play it safe until week 6' } }],
      stop_reason: 'tool_use', usage };
  } } });
  try {
    const before = requestRows();
    const res = await withNav(() => askCoach({ question: 'play it safe until week 6', leagueId: LEAGUE }));
    assert.equal(requestRows(), before, 'a Coach turn wrote a request');
    assert.equal(res.verification.ok, true, JSON.stringify(res.verification.violations));
    assert.deepEqual(res.actions, [{ type: 'set_risk_mode', mode: 'safe', until_week: 6 }]);
    assert.ok(FOOTER.test(res.answer.claims.at(-1).text));
    assert.equal(toolResult.proposal.writes, 0);
  } finally { setAnthropicClientForTesting(null); }
});
