/**
 * RULES-EVERYWHERE: Nick's hard rules on every trade-suggesting surface, through the one gate
 * (server/services/campaign/never-give.js#ruleGate). Made-up ids and values only; no real data.
 *
 * League 4, Nick's team 5 (leagues.my_team_id). Rules:
 *   never give 160 / 80 / 277 (277 only for a consistent Blue chip, which nothing measures yet);
 *   never get 290 or a player Nick traded away this season (the ledger: here he sold 105);
 *   every get with a served blue-chip score scores 83+ (here 103 scores 70);
 *   no fc_value -> fail closed (here 110 is unpriced);
 *   no overpay by FantasyCalc value, except +12% on a depth-only 2-for-1 when lineup points AND
 *   title odds both rise (and only where the surface computed both).
 *
 * One test per surface proves a suggestion that gives 160 or 80, or gets 290 or a sold player, never
 * comes back, and the count lands in dropped_by_rule. The last block is the property test over every
 * gate wrapper (int7-rules-property.test.js style, fixed seeds).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rules-everywhere-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_ANTHROPIC_API_KEY = 'test-key-not-a-real-one';
const plansFile = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = plansFile;
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;

const { db, row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const NG = await import('../server/services/campaign/never-give.js');
const engine = await import('../server/services/trade-engine.js');
const { gateProposals } = await import('../server/services/trade-proposals.js');
const { gateThreadView } = await import('../server/routes/warroom-negotiate.js');
const coachTools = await import('../server/services/coach/tools.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { setAnthropicClientForTesting } = await import('../server/services/claude.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

const L = 4, ME = '5';
const DB = { row, rows };

/* ------------------------------------------------------------ fixture */
const PLAYERS = [
  [80, 'Rb Pinned', 'RB'], [160, 'Wr Pinned', 'WR'], [277, 'Wr Maybe', 'WR'], [290, 'Wr Sold', 'WR'],
  [101, 'Alpha Chip', 'WR'], [102, 'Bravo Chip', 'RB'], [103, 'Charlie Low', 'WR'], [104, 'Delta Depth', 'RB'],
  [105, 'Echo Sold', 'WR'], [106, 'Foxtrot Depth', 'WR'], [107, 'Golf Mine', 'QB'], [110, 'Hotel Unpriced', 'TE'],
];
for (const [id, name, pos] of PLAYERS) run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, name, pos, 7000 + id);
const FC = { 80: 5000, 160: 5000, 277: 3000, 290: 5000, 101: 4000, 102: 3800, 103: 3000, 104: 1000, 105: 2000, 106: 1100, 107: 2000 };
for (const [id, v] of Object.entries(FC)) run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, Number(id), v);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, espn_s2, swid, connection_status)
     VALUES (?, 'espn', 'rules-4', 2026, 'Rules League', '{"teams":[]}', 10, ?, 'x', 'y', 'connected')`, L, ME);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, espn_s2, swid, connection_status)
     VALUES (9, 'espn', 'rules-9', 2026, 'Other', '{"teams":[]}', 10, NULL, 'x', 'y', 'connected')`);
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
// Nick (5) sold 105 to team 2 for 107 this season.
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
     VALUES (?, 2026, 'tx1', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', '2026-09-10T12:00:00Z', ?, 'now', 'now')`, L,
JSON.stringify([{ playerId: 7105, fromTeamId: 5, toTeamId: 2, type: 'TRADE' }, { playerId: 7107, fromTeamId: 2, toTeamId: 5, type: 'TRADE' }]));
// The served blue-chip board: 101 and 102 are Blue chips, 103 is not, 104 and 106 are depth.
fs.writeFileSync(plansFile, JSON.stringify({ schema: 'warroom-plans/1', leagues: [{ league: L, me: ME,
  blue_chips: { status: 'ok', value: { rows: [[101, 90], [102, 86], [103, 70], [104, 50], [106, 45], [80, 88], [160, 93]]
    .map(([player, score]) => ({ player: String(player), score })) } } }] }));

const lg = row('SELECT id, my_team_id, season, payload FROM leagues WHERE id = ?', L);
const P = id => ({ id, name: PLAYERS.find(p => p[0] === id)?.[1] ?? `x${id}`, value: FC[id] ?? 0 });
/** The four bad ideas every surface is handed, and one clean one. */
const BAD = [
  { give: [80], get: [101], why: 'gives 80' },
  { give: [160], get: [102], why: 'gives 160' },
  { give: [107], get: [290], why: 'gets 290' },
  { give: [107], get: [105], why: 'gets a player Nick sold' },
];
const CLEAN = { give: [107, 104], get: [102] }; // 3000 given for 3800: no overpay, 102 is a Blue chip
const deal = (x, partner = '2') => ({ id: `${x.give.join('+')}>${x.get.join('+')}`, partner_id: partner, partner: `Team ${partner}`,
  i_give: x.give.map(P), i_get: x.get.map(P) });
const idsIn = list => list.map(d => `${(d.i_give ?? []).map(p => p.id).join('+')}>${(d.i_get ?? []).map(p => p.id).join('+')}`);

/* ------------------------------------------------------------ the rules */
test('ruleVerdict: each rule, and the +12% depth-only 2-for-1 exception only with both rises', () => {
  const g = NG.ruleGate(DB, { leagueId: L });
  assert.equal(g.me, ME);
  assert.deepEqual(g.rules.sources, { fc_value: 'ok', ledger: 'ok', scores: 'ok' });
  assert.ok(g.rules.sold.has('105'), 'the ledger reader finds the sale');
  const r = t => g.check(t).reasons;
  assert.deepEqual(r({ give: [80], get: [101] }), ['never_give', 'overpay']);
  assert.deepEqual(r({ give: [277], get: [101] }), ['never_give'], '277 stays pinned: nothing measures a consistent scorer');
  assert.deepEqual(r({ give: [107], get: [290] }), ['never_get']);
  assert.deepEqual(r({ give: [107], get: [105] }), ['sold_this_season']);
  assert.deepEqual(r({ give: [107], get: [103] }), ['below_blue_chip']);
  assert.deepEqual(r({ give: [110], get: [101] }), ['no_fc_value']);
  assert.deepEqual(r({ give: [101], get: [102] }), ['overpay']);
  // 104 + 106 (depth, 2100) for 107 (2000, unscored): +5%, a depth-only 2-for-1.
  assert.deepEqual(r({ give: [104, 106], get: [107] }), ['overpay'], 'no premium read: the exception does not apply');
  assert.deepEqual(r({ give: [104, 106], get: [107], premium: { points_delta: 1, title_delta: 0 } }), ['overpay']);
  assert.deepEqual(r({ give: [104, 106], get: [107], premium: { points_delta: 1, title_delta: 0.01 } }), []);
  assert.deepEqual(r(CLEAN), []);
});

test('ruleGate: only Nick\'s team; his side when he is the partner; a league with no team of his passes through', () => {
  const other = NG.ruleGate(DB, { leagueId: L, teamId: '2' });
  assert.equal(other.forNick, false);
  // Team 2 gives 101 for Nick's 80: from Nick's side he gives 80.
  assert.equal(other.filter([deal({ give: [101], get: [80] }, ME)], d => ({ give: NG.idsOf(d.i_give), get: NG.idsOf(d.i_get), partner: d.partner_id })).kept.length, 0);
  assert.equal(other.filter([deal({ give: [101], get: [80] }, '3')], d => ({ give: NG.idsOf(d.i_give), get: NG.idsOf(d.i_get), partner: d.partner_id })).kept.length, 1);
  assert.equal(NG.ruleGate(DB, { leagueId: 9 }).applies, false);
});

test('ruleGate fails closed: an unreadable ledger drops everything', () => {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'bad', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', '2026-09-11T12:00:00Z', '{not json', 'now', 'now')`, L);
  try {
    const g = NG.ruleGate(DB, { leagueId: L });
    assert.ok(g.rules.closed);
    assert.deepEqual(g.check(CLEAN).reasons, ['rules_unreadable']);
  } finally { run(`DELETE FROM league_transactions_raw WHERE tx_id = 'bad'`); }
});

/* ------------------------------------------------------------ one test per surface */
const raw = () => ({ mode: 'league', me: { roster_id: ME }, deals: [...BAD, CLEAN].map(x => deal(x)),
  title_mutual: { status: 'on', deals: [deal(BAD[0]), deal(CLEAN)] } });

test('surface /find (findTrades): rule-breaking ideas never come back, counted', () => {
  const out = engine.gateIdeas(lg, raw(), ME);
  assert.deepEqual(idsIn(out.deals), ['107+104>102']);
  assert.deepEqual(idsIn(out.title_mutual.deals), ['107+104>102']);
  assert.equal(out.dropped_by_rule, 5);
});

test('surface /post-draft-plan (findTrades, limit 5): the same gate; the route adds the count at the top', () => {
  const out = engine.gateIdeas(lg, { ...raw(), title_mutual: undefined }, ME);
  assert.ok(out.deals.every(d => !d.i_give.some(p => [80, 160].includes(p.id)) && !d.i_get.some(p => [290, 105].includes(p.id))));
  assert.equal(out.dropped_by_rule, 4);
  const src = fs.readFileSync(new URL('../server/routes/trades.js', import.meta.url), 'utf8');
  assert.match(src, /dropped_by_rule: trades\?\.dropped_by_rule \?\? 0/, 'post-draft-plan serves the count');
});

test('surface /find/sequences: both searches gated (findTrades), the count covers both', () => {
  const src = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  assert.match(src, /dropped_by_rule: \(first\.dropped_by_rule \?\? 0\) \+ \(second\.dropped_by_rule \?\? 0\)/);
  const second = engine.gateIdeas(lg, raw(), ME);
  assert.ok(!idsIn(second.deals).some(k => /(^|\+)(80|160)(\+|>)|>(.*\+)?(290|105)(\+|$)/.test(k)));
});

test('surface /offer (offerFor): target 290 -> every rung dropped; a clean target keeps its clean rungs', () => {
  const ladder = target => ({ mode: 'target', target: P(target), owner_id: '2',
    offers: [{ i_give: [P(80)] }, { i_give: [P(107), P(104)] }], open_with: { i_give: [P(160)] },
    fair: { i_give: [P(107), P(104)] }, max: { i_give: [P(80), P(160)] }, alternatives: [{ i_give: [P(160)] }] });
  const sold = engine.gateLadder(lg, ladder(290), ME);
  assert.equal(sold.offers.length, 0); assert.equal(sold.open_with, null); assert.equal(sold.fair, null);
  assert.equal(sold.dropped_by_rule, 6);
  const ok = engine.gateLadder(lg, ladder(102), ME);
  assert.equal(ok.offers.length, 1); assert.deepEqual(ok.offers[0].i_give.map(p => p.id), [107, 104]);
  assert.equal(ok.open_with, null); assert.equal(ok.max, null); assert.equal(ok.alternatives.length, 0);
  assert.equal(ok.dropped_by_rule, 4);
});

test('surface /offer-many (offerForMany): each ladder gated; a sold target (105) serves nothing', () => {
  const l = targets => ({ targets: targets.map(P), owner_id: '2', offers: [{ i_give: [P(107), P(104)] }], alternatives: [] });
  const a = engine.gateLadder(lg, { ...l([105]), me: { roster_id: ME } }, ME);
  const b = engine.gateLadder(lg, { ...l([102]), me: { roster_id: ME } }, ME);
  assert.equal(a.offers.length, 0); assert.equal(a.dropped_by_rule, 1);
  assert.equal(b.offers.length, 1); assert.equal(b.dropped_by_rule, 0);
});

test('surface /title-trades: candidates come from gated findTrades, and the count is served', () => {
  const src = fs.readFileSync(new URL('../server/services/title-odds-trades.js', import.meta.url), 'utf8');
  assert.match(src, /dropped_by_rule: found\.dropped_by_rule \?\? 0/);
  assert.equal(engine.gateIdeas(lg, raw(), ME).deals.length, 1);
});

test('surface /proposals: a written-up proposal is gated on its own package (names read back through its ideas)', () => {
  const ideas = [deal(CLEAN), deal({ give: [107], get: [101] })];
  const proposal = (give, get, ids) => ({ idea_ids: ids, package: { i_give: give.map(id => P(id).name), i_get: get.map(id => P(id).name) } });
  const result = { proposals: [
    proposal([107, 104], [102], [ideas[0].id]),                 // clean
    proposal([107, 104], [101], [ideas[0].id, ideas[1].id]),    // 3000 for 4000: clean
    proposal([107], [101, 102], [ideas[0].id, ideas[1].id]),    // clean too (Nick gets more)
    { idea_ids: [ideas[0].id], package: { i_give: ['Rb Pinned'], i_get: ['Bravo Chip'] } }, // names 80: unreadable -> dropped
  ] };
  const g = NG.ruleGate(DB, { leagueId: L, teamId: ME });
  const out = gateProposals(g, result, ideas);
  assert.equal(out.kept.length, 3); assert.equal(out.dropped_by_rule, 1);
  const withSold = [deal({ give: [107], get: [105] })];
  const sold = gateProposals(g, { proposals: [proposal([107], [105], [withSold[0].id])] }, withSold);
  assert.equal(sold.kept.length, 0); assert.equal(sold.dropped_by_rule, 1);
});

/* the trades router, for /explain */
const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: String(error.message) }));
const TOKEN = 'rules-everywhere-token';
db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (991,'rules-user','Rules User')`).run();
db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (991,?,datetime('now','+1 day'))`).run(hashSessionToken(TOKEN));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 991, 'commissioner')`, L);
async function post(url, body) {
  const text = JSON.stringify(body);
  const req = new Readable({ read() { this.push(text); this.push(null); } });
  req.url = url; req.method = 'POST';
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = c => { chunks.push(Buffer.from(c)); return true; };
    res.end = c => { if (c) chunks.push(Buffer.from(c)); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); };
    app.handle(req, res, reject);
  });
}

test('surface /explain: no message is drafted for a deal that gives 80 or gets 290; a clean one is', async () => {
  let calls = 0;
  setAnthropicClientForTesting({ messages: { create: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify({ pitch: 'p', evidence: '', their_counter: 'c', walk_away: 'w', risk: 'r' }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; } } });
  try {
    const side = (gives, gets) => ({ me: { owner: 'me', gives: gives.map(P), gets: gets.map(P), lineup_before: 1, lineup_after: 2, ppg_delta: 1, value_delta: 0 },
      them: { owner: 'them', gives: gets.map(P), lineup_before: 1, lineup_after: 1, ppg_delta: 0, value_delta: 0 }, partner_id: '2', fairness: 'fair', mutual: true });
    for (const [gives, gets] of [[[80], [101]], [[107], [290]]]) {
      const r = await post(`/api/trades/${L}/explain`, { deal: side(gives, gets) });
      assert.equal(r.status, 422, JSON.stringify(r.body)); assert.equal(r.body.dropped_by_rule, 1);
    }
    assert.equal(calls, 0, 'the model is never asked to write up a rule-breaking deal');
    const ok = await post(`/api/trades/${L}/explain`, { deal: side([107, 104], [102]) });
    assert.equal(ok.status, 200); assert.equal(ok.body.dropped_by_rule, 0); assert.equal(calls, 1);
  } finally { setAnthropicClientForTesting(null); }
});

test('surface War Room negotiation threads: a reply-table branch whose package breaks a rule is dropped', () => {
  const v = { get: ['102'], branches: [
    { kind: 'counter', plan: { status: 'ok', value: { next_rung_give: ['107', '104'], walk_away_give: ['107', '104'] } } },
    { kind: 'decline', plan: { status: 'ok', value: { backup: { partner: '3', give: ['80'], get: ['101'] } } } },
    { kind: 'stall', plan: { status: 'ok', value: { backup: { partner: '3', give: ['107'], get: ['290'] } } } },
    { kind: 'accept', plan: { status: 'unknown', reason: 'x' } },
  ] };
  const out = gateThreadView(NG.ruleGate(DB, { leagueId: L }), v);
  assert.equal(out.branches[0].plan.status, 'ok');
  assert.equal(out.branches[1].plan.source, 'rules'); assert.equal(out.branches[2].plan.source, 'rules');
  assert.equal(out.dropped_by_rule, 2);
});

test('surface Coach drafted message: a draft naming a pinned or sold player is never put in the box', () => {
  for (const name of ['Rb Pinned', 'Wr Sold', 'Echo Sold']) {
    const out = coachTools.runCoachTool('warroom_draft_message', { type: 'draft_message', text: `Would you do Golf Mine for ${name}?` }, {});
    assert.equal(out.action, undefined, `${name} must not reach the dock`);
    assert.equal(out.dropped_by_rule, 1);
  }
  const ok = coachTools.runCoachTool('warroom_draft_message', { type: 'draft_message', text: 'Would you do Golf Mine for Bravo Chip?' }, {});
  assert.equal(ok.action.type, 'draft_message');
});

test('surface Coach answers carry dropped_by_rule (ask.js sums every tool\'s count)', () => {
  const src = fs.readFileSync(new URL('../server/services/coach/ask.js', import.meta.url), 'utf8');
  assert.equal((src.match(/dropped_by_rule: counts\.dropped_by_rule/g) ?? []).length, 3);
});

/* ------------------------------------------------------------ property: every wrapper, random ideas */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; };
}
const POOL_MINE = [80, 160, 277, 104, 106, 107, 110];
const POOL_THEIRS = [290, 101, 102, 103, 105, 110];
const pick = (r, pool, n) => [...new Set(Array.from({ length: n }, () => pool[Math.floor(r() * pool.length)]))];
/** The rules re-stated from the fixture, not from never-give.js. */
function breaks({ give, get }) {
  const g = give.map(Number), t = get.map(Number);
  if (g.some(id => [80, 160, 277].includes(id))) return true;
  if (t.some(id => [290, 105].includes(id))) return true;
  if (t.includes(103)) return true;
  if ([...g, ...t].some(id => FC[id] == null)) return true;
  return g.reduce((s, id) => s + FC[id], 0) > t.reduce((s, id) => s + FC[id], 0);
}
const SEEDS = Number(process.env.RULES_EVERYWHERE_SEEDS ?? 40);

test('property: over random ideas, no gate wrapper ever serves a rule-breaking package, and every drop is counted', () => {
  let served = 0, dropped = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    const ideas = Array.from({ length: 12 }, () => ({ give: pick(r, POOL_MINE, 1 + Math.floor(r() * 2)), get: pick(r, POOL_THEIRS, 1 + Math.floor(r() * 2)) }));
    const out = engine.gateIdeas(lg, { mode: 'league', me: { roster_id: ME }, deals: ideas.map(x => deal(x)) }, ME);
    for (const d of out.deals) assert.equal(breaks({ give: d.i_give.map(p => p.id), get: d.i_get.map(p => p.id) }), false, `seed ${seed}: find served ${idsIn([d])}`);
    assert.equal(out.deals.length + out.dropped_by_rule, ideas.length);
    served += out.deals.length; dropped += out.dropped_by_rule;
    const target = POOL_THEIRS[Math.floor(r() * POOL_THEIRS.length)];
    const ladder = engine.gateLadder(lg, { target: P(target), owner_id: '2', offers: ideas.map(x => ({ i_give: x.give.map(P) })), alternatives: [] }, ME);
    for (const o of ladder.offers) assert.equal(breaks({ give: o.i_give.map(p => p.id), get: [target] }), false, `seed ${seed}: offer`);
    const ideasFull = ideas.map(x => deal(x));
    const props = { proposals: ideasFull.map(d => ({ idea_ids: [d.id], package: { i_give: d.i_give.map(p => p.name), i_get: d.i_get.map(p => p.name) } })) };
    const gp = gateProposals(NG.ruleGate(DB, { leagueId: L, teamId: ME }), props, ideasFull);
    for (const p of gp.kept) {
      const d = ideasFull.find(i => i.id === p.idea_ids[0]);
      assert.equal(breaks({ give: d.i_give.map(x => x.id), get: d.i_get.map(x => x.id) }), false, `seed ${seed}: proposal`);
    }
    const tv = gateThreadView(NG.ruleGate(DB, { leagueId: L }), { get: [String(target)], branches: ideas.map(x => ({ plan: { status: 'ok', value: { give: x.give.map(String), get: x.get.map(String) } } })) });
    tv.branches.forEach((b, k) => { if (b.plan.status === 'ok') assert.equal(breaks(ideas[k]), false, `seed ${seed}: branch`); });
  }
  assert.ok(served > 0 && dropped > 0, `not vacuous: ${served} served, ${dropped} dropped`);
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
