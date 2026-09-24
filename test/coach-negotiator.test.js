/**
 * COACH-NEGOTIATE: Coach as the live negotiation copilot (COACH-ANCHOR.md job 2),
 * server/services/coach/negotiator.js.
 *
 * Nick pastes (or taps) the partner's reply to the next move's step. Coach
 * classifies it, shows the step's pre-planned reply-table row, re-prices a
 * counter with the ENGINE (title odds from the campaign adapter's rescore, P(yes)
 * from its priceStep: the one counterpart model's price), recommends take /
 * counter with X / walk by the plan's walk-away rule, and drafts, never sends.
 *
 * The plan is the contract's producer fixture (test/fixtures/warroom-contract/
 * producer-plans.json, written by the real producer on a made-up league), its
 * league 4: step 1 gives P4 + P6 to Team 3 for P21, walk-away P4 + P6, opening
 * P4 + P5. The engine is that same made-up league's adapter
 * (test/fixtures/campaign-league.mjs makeAdapter), handed in the way the
 * producer hands in its adapter. Player names are rewritten to letters-only
 * names ("K. Knox") so a draft can pass the War Room's no-digit rule, as a real
 * league's names do. No real data, no model calls, no network.
 *
 * METRIC (the unit's measure): 12 fixed replies (3 accepts, 4 counters incl. a
 * lowball, 3 declines, 2 stalls), graded on the SERVED path: runCoachTool
 * ('negotiate_reply') from the Coach tool registry -> the action it hands the
 * War Room dock -> the real client dispatcher (warroomCoach.ts dispatch).
 * Counted: classification, counters priced from engine fields (every priced cell
 * equals a direct engine call), recommendation matches the walk-away rule,
 * ungrounded claims (verify.js, must be 0), sends (must be 0). Printed as a
 * `# METRIC` diagnostic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-neg-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_COACH_NEGOTIATE;
delete process.env.GRIDIRON_COACH_NAV;
delete process.env.GRIDIRON_COACH_BRAIN_TOOLS;

const LEAGUE = 4;

/** Letters-only names for the made-up league (real names carry no digits). */
const NAMES = {
  1: 'A. Aaron', 2: 'B. Brook', 3: 'C. Cole', 4: 'D. Dell', 5: 'E. Eads', 6: 'F. Frye', 7: 'G. Gore',
  11: 'H. Hale', 12: 'I. Irons', 13: 'J. Jett', 14: 'L. Lamb', 15: 'N. Nash',
  21: 'K. Knox', 22: 'L. Lane', 23: 'O. Ortiz', 24: 'Q. Quinn', 25: 'M. Moss',
  31: 'R. Rios', 32: 'S. Sims', 33: 'T. Tate', 34: 'U. Upton', 35: 'V. Vance'
};
const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const renamed = JSON.parse(JSON.stringify(PRODUCER.leagues.find(l => l.league === LEAGUE))
  .replace(/\bP(\d{1,2})\b/g, (m, id) => NAMES[id] ?? m));
const PLANS = { ...PRODUCER, leagues: PRODUCER.leagues.map(l => (l.league === LEAGUE ? renamed : l)) };
const plansFile = path.join(temp, 'plans.json');
fs.writeFileSync(plansFile, JSON.stringify(PLANS));
process.env.GRIDIRON_WARROOM_PLANS = plansFile;

const { run, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer } = await import('../server/services/coach/verify.js');
const tools = await import('../server/services/coach/tools.js');
const client = await import('../client/src/components/warroom/coach/warroomCoach.ts');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

let neg = null;
try { neg = await import('../server/services/coach/negotiator.js'); } catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (${LEAGUE}, 'espn', 'neg-4', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-23 01:00:00')`);

/* The engine: the made-up league's adapter, with every call counted. */
const ADAPTER = makeAdapter();
const engineCalls = { rescore: 0, priceStep: 0 };
const counted = {
  ...ADAPTER,
  world(seed) {
    const w = ADAPTER.world(seed);
    return { ...w, rescore(...a) { engineCalls.rescore++; return w.rescore(...a); } };
  },
  priceStep(...a) { engineCalls.priceStep++; return ADAPTER.priceStep(...a); }
};
neg?.setNegotiatorSources({ engine: id => (id === LEAGUE ? counted : null) });

/** What the engine says for a package, called directly (the grading reference). */
function direct({ give, get, partner = '3' }) {
  const rosters = ADAPTER.rosters;
  const me = [...rosters.get('1').filter(x => !give.includes(String(x))), ...get.map(Number)];
  const his = [...rosters.get(partner).filter(x => !get.includes(String(x))), ...give.map(Number)];
  const r = ADAPTER.world(ADAPTER.seed).rescore(new Map([['1', me], [partner, his]]), '1', partner).me;
  const p = ADAPTER.priceStep(partner, get.map(Number), give.map(Number));
  return { title_before: r.title_before, title_after: r.title_after, title_delta: r.title_delta,
    title_delta_se: r.title_delta_se, p_yes: p.p, p_yes_low: p.band.low, p_yes_high: p.band.high };
}

const CTX = { leagues: [LEAGUE], plans: renamed, now: '2026-09-24T12:00:00.000Z' };

/**
 * The fixed set. `kind`: what the reply is. `rec`: what the walk-away rule says
 * (take / counter / walk / wait). `pkg`: the counter's package as Nick sees it.
 *   C1 asks for G. Gore, who is not in the walk-away package (P4 + P6): richer -> walk.
 *   C2 adds C. Cole on top of the walk-away package: richer -> walk.
 *   C3 lowball: M. Moss instead of K. Knox for the same two; the engine re-price
 *      leaves title odds below the backup's -> counter with the plan's counter
 *      (the opening, D. Dell + E. Eads for K. Knox).
 *   C4 D. Dell alone for K. Knox: inside the walk-away and the re-price beats the
 *      backup -> take.
 */
const SET = [
  { reply: 'Deal! Accepting it now.', kind: 'accept', rec: 'take' },
  { reply: "yeah let's do it", kind: 'accept', rec: 'take' },
  { reply: 'Sounds good to me, accepted.', kind: 'accept', rec: 'take' },
  { reply: "Make it Dell and Gore for Knox and it's done", kind: 'counter', rec: 'walk', pkg: { give: ['4', '7'], get: ['21'] } },
  { reply: "Throw in Cole and you've got a deal", kind: 'counter', rec: 'walk', pkg: { give: ['4', '6', '3'], get: ['21'] } },
  { reply: "I'd do Moss instead of Knox for your Dell and Frye", kind: 'counter', rec: 'counter', pkg: { give: ['4', '6'], get: ['25'] },
    counterWith: { give: ['4', '5'], get: ['21'] } },
  { reply: 'How about just Dell for Knox?', kind: 'counter', rec: 'take', pkg: { give: ['4'], get: ['21'] } },
  { reply: "nah, I'm good", kind: 'decline', rec: 'walk' },
  { reply: 'Not interested, Knox is my guy', kind: 'decline', rec: 'walk' },
  { reply: 'No thanks.', kind: 'decline', rec: 'walk' },
  { reply: 'Let me think about it after the games Sunday', kind: 'stall', rec: 'wait' },
  { reply: "maybe, I'll get back to you tomorrow", kind: 'stall', rec: 'wait' }
];

/**
 * The hard cases (review of #327): replies whose words look like one kind and are
 * another. A "no" that repeats the offered players ("Knox for Dell and Frye? No
 * way.") must read as a decline, never as a counter of the same package (that
 * priced into a "take" and drafted an acceptance to a no). A conditional yes and
 * a no followed by a package are counters by rule, not by cue order. A reply that
 * only repeats the offer is a yes or a no, never a counter to take.
 * `rec` null: Coach makes no call and asks Nick to tap.
 */
const HARD = [
  { reply: "No, I'm not trading Knox for that.", kind: 'decline', rec: 'walk' },
  { reply: 'Knox for Dell and Frye? No way.', kind: 'decline', rec: 'walk' },
  { reply: 'Nah, not giving up Knox for Dell and Frye', kind: 'decline', rec: 'walk' },
  { reply: "I'm keeping Knox, sorry", kind: 'decline', rec: 'walk' },
  { reply: 'Dell and Frye for Knox? Pass.', kind: 'decline', rec: 'walk' },
  { reply: 'Not even if you throw in Eads', kind: 'decline', rec: 'walk' },
  { reply: 'yes if you throw in Gore', kind: 'counter', rec: 'walk' },
  { reply: 'Nope. Dell and Gore for Knox though', kind: 'counter', rec: 'walk' },
  { reply: 'No, but Dell for Knox works', kind: 'counter', rec: 'take' },
  { reply: 'Yes, Dell and Frye for Knox works for me', kind: 'accept', rec: 'take' },
  { reply: 'Knox for Dell and Frye?', kind: null, rec: null }
];
const ACCEPT_DRAFTS = /\b(deal|accept)/i;

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const withFlag = (fn, value = '1') => {
  const was = process.env.GRIDIRON_COACH_NEGOTIATE;
  process.env.GRIDIRON_COACH_NEGOTIATE = value;
  try { return fn(); } finally { if (was === undefined) delete process.env.GRIDIRON_COACH_NEGOTIATE; else process.env.GRIDIRON_COACH_NEGOTIATE = was; }
};

/* Sends: any network call, any request row, any offer row, any non-draft action. */
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetchCalls++; return realFetch(...a); };
test.after(() => { globalThis.fetch = realFetch; });
const tableRows = name => (row("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", name) ? row(`SELECT COUNT(*) n FROM ${name}`).n : 0);
const writeRows = () => tableRows('warroom_requests') + tableRows('trade_outcomes') + tableRows('offer_log') + tableRows('coach_offers');

function grade(item) {
  const before = { fetch: fetchCalls, rows: writeRows() };
  const ledger = newLedger();
  const res = tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: item.reply }, { ledger });
  const s = res.summary;
  const classified = s.kind === item.kind;
  const rec = s.recommendation?.do === item.rec
    && (!item.counterWith || (sameSet(s.recommendation.counter_with?.give ?? [], item.counterWith.give)
      && sameSet(s.recommendation.counter_with?.get ?? [], item.counterWith.get)));

  // Priced from engine fields: the counter's package, and every priced cell equals a direct engine call.
  let priced = null;
  if (item.kind === 'counter') {
    const his = s.reprice?.find(p => p.package === 'his_counter');
    const pkgOk = !!his && sameSet(his.give, item.pkg.give) && sameSet(his.get, item.pkg.get);
    const refs = (s.reprice ?? []).map(p => ({ p, d: direct(p) }));
    const fieldsOk = refs.length > 0 && refs.every(({ p, d }) => Object.entries(d).every(([k, v]) => p[k] === v));
    // ...and those cells are the ledger's (a claim cites them), not text Coach wrote.
    const entry = ledger.queries.find(q => q.tool === 'what_if');
    const inLedger = !!entry && refs.every(({ p }) => entry.rows.some(r => r.title_after === p.title_after && r.p_yes === p.p_yes));
    priced = pkgOk && fieldsOk && inLedger;
  }

  // Ungrounded: re-verify what the tool returned against its own ledger.
  const recheck = verifyAnswer({ answer: { claims: s.claims, refusals: s.refusals, as_of: s.as_of }, ledger });
  const ungrounded = recheck.violations.length + (s.grounded ? 0 : 1);

  // Served: the action goes through the dock's real dispatcher; a draft lands in the box, nothing else.
  let served = true;
  let badActions = 0;
  if (res.action) {
    if (res.action.type !== 'draft_message') badActions++;
    const d = client.dispatch(client.newSession(), res.action, CTX, item.reply);
    served = d.outcome.status === 'applied' && Object.values(d.session.ui.drafts).includes(s.draft)
      && !d.session.pending;
  } else if (s.draft) {
    served = false; // a draft exists but the dock was not handed it
  }
  const sends = (fetchCalls - before.fetch) + (writeRows() - before.rows) + badActions + (s.sends ?? 0);
  return { item, s, classified, rec, priced, ungrounded, served, sends, recheck };
}

test('METRIC: 12 replies on league 4, served path -> classified, counters engine-priced, walk-away rule, 0 ungrounded, 0 sends', t => {
  if (!neg) {
    t.diagnostic('METRIC classified=0/12 counters_priced=0/4 walk_away_rule=0/12 ungrounded=0 sends=0 served=0/12 (no negotiator on this tree)');
    assert.fail('Coach has no negotiation tool on this tree (0/12)');
  }
  const graded = withFlag(() => SET.map(grade));
  const hard = withFlag(() => HARD.map(item => {
    const s = tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: item.reply }, { ledger: newLedger() }).summary;
    const ok = s.kind === item.kind && (s.recommendation?.do ?? null) === item.rec
      && (item.kind === 'decline' ? !s.draft || !ACCEPT_DRAFTS.test(s.draft) : true) && s.grounded && s.sends === 0;
    return { item, s, ok };
  }));
  const n = k => graded.filter(g => g[k]).length;
  const counters = graded.filter(g => g.item.kind === 'counter');
  const pricedN = counters.filter(g => g.priced).length;
  const ungrounded = graded.reduce((a, g) => a + g.ungrounded, 0);
  const sends = graded.reduce((a, g) => a + g.sends, 0);
  t.diagnostic(`METRIC classified=${n('classified')}/12 counters_priced=${pricedN}/4 walk_away_rule=${n('rec')}/12 ungrounded=${ungrounded} sends=${sends} served=${n('served')}/12 hard_cases=${hard.filter(h => h.ok).length}/${HARD.length}`);
  for (const h of hard) if (!h.ok) t.diagnostic(`BAD hard ${JSON.stringify(h.item.reply)} -> ${h.s.kind} / ${h.s.recommendation?.do} draft=${JSON.stringify(h.s.draft)}`);
  for (const g of graded) {
    t.diagnostic(`${g.classified && g.rec ? 'ok ' : 'BAD'} ${JSON.stringify(g.item.reply)} -> ${g.s.kind} / ${g.s.recommendation?.do}` +
      `${g.item.kind === 'counter' ? ` priced=${g.priced}` : ''}${g.ungrounded ? ` UNGROUNDED ${JSON.stringify(g.recheck.violations)}` : ''}${g.served ? '' : ' [not served]'}`);
  }
  assert.ok(n('classified') >= 11, `classified ${n('classified')}/12`);
  assert.equal(pricedN, 4);
  assert.equal(n('rec'), 12);
  assert.equal(ungrounded, 0);
  assert.equal(sends, 0);
  assert.equal(n('served'), 12);
  assert.equal(hard.filter(h => h.ok).length, HARD.length);
});

test('the lowball: engine re-price below the backup -> counter with the plan\'s counter, P(yes) from the one model, labelled unproven', t => {
  const g = withFlag(() => grade(SET[5]));
  const { s } = g;
  assert.equal(s.recommendation.do, 'counter');
  const texts = s.claims.map(c => c.text).join('\n');
  const his = direct({ give: ['4', '6'], get: ['25'] });
  const back = direct({ give: ['4', '5'], get: ['21'] });
  assert.ok(his.title_after < 0.4879062333328974, 'fixture: the lowball leaves title odds below the backup');
  assert.match(texts, /Counter with D\. Dell \+ E\. Eads for K\. Knox/);
  assert.match(texts, new RegExp(`${(back.p_yes * 100).toFixed(0)}%`));
  assert.match(texts, /unproven: E1 .*failing/);
  assert.match(s.draft, /D\. Dell \+ E\. Eads for K\. Knox\?$/);
  assert.equal(g.ungrounded, 0);
  if (process.env.PEEK) for (const c of s.claims) t.diagnostic(c.text);
});

test('a richer ask walks at the plan\'s walk-away line, and says the line', () => {
  const g = withFlag(() => grade(SET[4]));
  assert.equal(g.s.recommendation.do, 'walk');
  assert.ok(g.s.claims.some(c => /^Walk-away line: Stop at D\. Dell \+ F\. Frye/.test(c.text)), g.s.claims.map(c => c.text).join('\n'));
  assert.equal(g.ungrounded, 0);
});

test('a tap works without words: silence -> the planned nudge, wait', () => {
  const ledger = newLedger();
  const { summary: s } = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply_kind: 'silence' }, { ledger }));
  assert.equal(s.kind, 'silence');
  assert.equal(s.recommendation.do, 'wait');
  assert.equal(s.draft, 'Still open to D. Dell + F. Frye for K. Knox?');
  assert.equal(s.grounded, true);
});

test('no engine: a counter is judged on the plan\'s walk-away alone and says it is unpriced; nothing is invented', () => {
  neg.setNegotiatorSources({ engine: () => null });
  try {
    const ledger = newLedger();
    const { summary: s } = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: SET[6].reply }, { ledger }));
    assert.equal(s.kind, 'counter');
    assert.equal(s.recommendation.do, 'take');
    assert.deepEqual(s.reprice, []);
    assert.ok(s.refusals.some(r => /not re-priced/.test(r)));
    assert.equal(ledger.queries.some(q => q.tool === 'what_if'), false);
    assert.equal(s.claims.some(c => /title odds/.test(c.text)), false);
    assert.equal(s.grounded, true);

    // A named player nobody can place (no engine rosters): no call at all, rather than a "take" with him dropped.
    const other = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: SET[4].reply }, { ledger: newLedger() })).summary;
    assert.equal(other.kind, 'counter');
    assert.equal(other.recommendation, null);
    assert.ok(other.refusals.some(r => /could not tell whose player/.test(r)));
  } finally {
    neg.setNegotiatorSources({ engine: id => (id === LEAGUE ? counted : null) });
  }
});

test('an unreadable plan refuses with no numbers', () => {
  const ledger = newLedger();
  const { summary: s } = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: 2, reply: 'deal' }, { ledger }));
  assert.equal(s.recommendation, null);
  assert.equal(s.claims.length, 0);
  assert.ok(s.refusals.length >= 1);
});

test('flag: off by default, on with its own flag or preview, and its own 0 vetoes preview', () => {
  const names = () => tools.toolDefinitions({ warRoom: true }).map(d => d.name);
  assert.equal(names().includes('negotiate_reply'), false);
  withFlag(() => assert.equal(names().includes('negotiate_reply'), true));
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.equal(names().includes('negotiate_reply'), true);
    withFlag(() => assert.equal(names().includes('negotiate_reply'), false), '0');
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
  assert.throws(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: 'deal' }, { ledger: newLedger() }),
    /no tool called negotiate_reply/);
});

test('the classifier on its own: kinds from words, a tap overrides words', () => {
  const c = neg.classifyReply;
  assert.equal(c('').kind, 'silence');
  assert.equal(c('no, but how about Dell for Knox', { names: { 4: 'D. Dell', 21: 'K. Knox' } }).kind, 'counter');
  assert.equal(c('hard pass').kind, 'decline');
  assert.equal(c('give me a day').kind, 'stall');
  assert.equal(c('works for me').kind, 'accept');
  assert.equal(c('whatever', { tap: 'decline' }).kind, 'decline');
});

test('the default engine builds in a worker, never on the request thread, and prices through it exactly as the engine does', async t => {
  // A stand-in adapter module whose build is BUILD_MS of synchronous work (the real one is ~35-40 s).
  const BUILD_MS = 3000;
  const slow = path.join(temp, 'slow-adapter.mjs');
  fs.writeFileSync(slow, `import { makeAdapter } from ${JSON.stringify(new URL('./fixtures/campaign-league.mjs', import.meta.url).href)};
export async function loadServices() { return {}; }
export function buildAdapter() { const end = Date.now() + ${BUILD_MS}; while (Date.now() < end) {} return makeAdapter(); }
`);
  neg.setNegotiatorSources({ engine: null, engineModule: pathToFileURL(slow).href });
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 20);
  try {
    const t0 = Date.now();
    const first = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: SET[6].reply }, { ledger: newLedger() })).summary;
    const firstMs = Date.now() - t0;
    assert.ok(firstMs < 1000, `first counter took ${firstMs} ms on the request thread`);
    assert.deepEqual(first.reprice, []);
    assert.ok(first.refusals.some(r => /still being built/.test(r)), first.refusals.join('\n'));
    assert.equal(first.grounded, true);

    const ticks0 = ticks;
    const waitStart = Date.now();
    let ready = false;
    while (!ready && Date.now() - waitStart < 30_000) {
      await new Promise(r => setTimeout(r, 100));
      ready = withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: SET[6].reply }, { ledger: newLedger() })).summary.reprice.length > 0;
    }
    const waitedMs = Date.now() - waitStart;
    assert.ok(ready, 'the worker never finished the build');
    // The event loop kept turning while the build ran: at least half the 20 ms ticks fired.
    assert.ok(ticks - ticks0 >= (waitedMs / 20) * 0.5, `event loop ticks ${ticks - ticks0} in ${waitedMs} ms`);

    const counters = withFlag(() => SET.filter(i => i.kind === 'counter').map(grade));
    const priced = counters.filter(g => g.priced && g.rec).length;
    const callMs = [];
    for (const item of SET.filter(i => i.kind === 'counter')) {
      const c0 = Date.now();
      withFlag(() => tools.runCoachTool('negotiate_reply', { league_id: LEAGUE, reply: item.reply }, { ledger: newLedger() }));
      callMs.push(Date.now() - c0);
    }
    t.diagnostic(`METRIC engine=worker first_counter_ms=${firstMs} build_ms=${waitedMs} loop_ticks_during_build=${ticks - ticks0} worker_priced=${priced}/4 max_counter_ms=${Math.max(...callMs)}`);
    assert.equal(priced, 4);
    assert.equal(counters.reduce((a, g) => a + g.ungrounded + g.sends, 0), 0);
  } finally {
    clearInterval(iv);
    await neg.stopNegotiatorEngine();
    neg.setNegotiatorSources({ engine: id => (id === LEAGUE ? counted : null), engineModule: null });
  }
});
