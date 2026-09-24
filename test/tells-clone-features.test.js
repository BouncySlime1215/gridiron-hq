/**
 * TELLS-01b: per-manager tells as named clone features, a walk-forward fit
 * with shrunk weights, graded by E1 (log loss vs activity-only), and the
 * Trade Brain tells card built from the same numbers.
 *
 * Every fixture is synthetic: team ids and made-up player names only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as T from '../server/services/tells/clone-features.js';
import { tellsCardResponse } from '../server/services/tells/card.js';
import { PREVIEW_ENV } from '../server/services/preview-mode.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const at = h => new Date(T0 + h * H).toISOString();

let tx = 1000;
/** A resolved offer in the e1-league merged shape. */
function offer({ league = 4, from, to, h, replyH = 5, status = 'declined', id = String(tx += 1) }) {
  return {
    league_id: league, season: 2026, source: 'observed', proposer_team_id: String(from),
    counterparty_team_id: String(to), proposed_at: at(h), resolved_at: replyH == null ? null : at(h + replyH),
    status, y: status === 'accepted' ? 1 : 0, espn_tx_id: id, model_p_accept: null,
  };
}

// ------------------------------------------------------------- features
test('reply_latency: median reply hours of the responder vs the league, as of the offer; under 2 replies is missing', () => {
  const offers = [
    offer({ from: 1, to: 2, h: 0, replyH: 40 }), offer({ from: 3, to: 2, h: 1, replyH: 60 }),
    offer({ from: 1, to: 3, h: 2, replyH: 2 }), offer({ from: 2, to: 3, h: 3, replyH: 4 }),
    offer({ from: 1, to: 2, h: 200 }),
  ];
  const ctx = T.makeContext({ offers });
  const f = T.featuresAsOf(offers[4], ctx);
  assert.equal(f.reply_latency.n, 2);
  assert.equal(f.reply_latency.missing, false);
  // Team 2 replies in ~50 h, the league in ~22 h: slower than the league -> positive.
  assert.ok(f.reply_latency.value > 0);
  const thin = T.featuresAsOf(offer({ from: 3, to: 1, h: 200 }), ctx);
  assert.equal(thin.reply_latency.missing, true);
  assert.equal(thin.reply_latency.value, 0);
});

test('counter_style: a decline answered by a proposal back within 72 h counts; one after 72 h does not', () => {
  const offers = [offer({ from: 1, to: 2, h: 0, replyH: 1 }), offer({ from: 3, to: 2, h: 10, replyH: 1 })];
  const proposals = [
    { league_id: 4, proposer: '2', counterparty: '1', proposed_at: at(20) }, // 19 h after the decline: a counter
    { league_id: 4, proposer: '2', counterparty: '3', proposed_at: at(11 + 80) }, // 80 h after: not a counter
  ];
  const ctx = T.makeContext({ offers, proposals });
  const f = T.featuresAsOf(offer({ from: 4, to: 2, h: 300 }), ctx);
  assert.equal(f.counter_style.n, 2);
  assert.equal(f.counter_style.countered, 1);
  // A 'countered' status is a counter on its own.
  const ctx2 = T.makeContext({ offers: [offer({ from: 1, to: 2, h: 0, status: 'countered' })] });
  assert.equal(T.featuresAsOf(offer({ from: 4, to: 2, h: 300 }), ctx2).counter_style.countered, 1);
});

test('prior_accept_price: this offer\'s value ratio minus the responder\'s shrunk accepted ratio, values read as of the proposal', () => {
  const a = offer({ from: 1, to: 2, h: 0, status: 'accepted', id: 'A' });
  const now = offer({ from: 3, to: 2, h: 100, id: 'B' });
  const itemsByTx = new Map([
    ['4:2026:A', [{ playerId: 11, fromTeamId: 1, toTeamId: 2 }, { playerId: 12, fromTeamId: 2, toTeamId: 1 }]],
    ['4:2026:B', [{ playerId: 13, fromTeamId: 3, toTeamId: 2 }, { playerId: 14, fromTeamId: 2, toTeamId: 3 }]],
  ]);
  const valueHistory = new Map([
    ['11', [{ on: '2026-08-30', value: 300 }]], ['12', [{ on: '2026-08-30', value: 100 }]],
    ['13', [{ on: '2026-08-30', value: 100 }, { on: '2026-09-30', value: 9000 }]], // a price captured AFTER the offer
    ['14', [{ on: '2026-08-30', value: 100 }]],
  ]);
  const ctx = T.makeContext({ offers: [a, now], itemsByTx, valueHistory });
  const f = T.featuresAsOf(now, ctx);
  const accepted = Math.log(301 / 101);
  assert.equal(f.prior_accept_price.n, 1);
  assert.ok(Math.abs(f.prior_accept_price.value - (0 - accepted / 3)) < 1e-9, 'gap uses the as-of price and shrinks the prior by n/(n+2)');
  // No priced accepted offer before this one -> missing, not zero-by-accident.
  assert.equal(T.featuresAsOf(a, ctx).prior_accept_price.missing, true);
});

test('chat_wants_player: flagged unproven, never enters the fit, and a mention after the offer is ignored', () => {
  const o = offer({ from: 1, to: 2, h: 100, id: 'W' });
  const ctx = T.makeContext({
    offers: [o],
    itemsByTx: new Map([['4:2026:W', [{ playerId: 21, fromTeamId: 1, toTeamId: 2 }]]]),
    names: new Map([['21', 'Player Alpha']]),
    wants: [{ league_id: 4, roster_id: '2', player_name: 'Player Alpha', sentiment: 0.6, n: 3, last_mention: at(50) }],
  });
  assert.equal(T.featuresAsOf(o, ctx).chat_wants_player.value, 1);
  const late = T.makeContext({ ...ctx.input, wants: [{ ...ctx.input.wants[0], last_mention: at(150) }] });
  assert.equal(T.featuresAsOf(o, late).chat_wants_player.value, 0);
  const spec = T.FEATURES.find(x => x.id === 'chat_wants_player');
  assert.equal(spec.graded, false);
  assert.match(spec.unproven_reason, /not dated/);
  assert.deepEqual(T.GRADED_FEATURES, ['reply_latency', 'counter_style', 'prior_accept_price']);
});

test('as-of safety: an offer resolved or proposed 1 second after the cut changes no feature', () => {
  const base = [offer({ from: 1, to: 2, h: 0, replyH: 3 }), offer({ from: 3, to: 2, h: 5, replyH: 9 })];
  const target = offer({ from: 4, to: 2, h: 50 });
  const before = T.featuresAsOf(target, T.makeContext({ offers: [...base, target] }));
  const lateResolve = { ...offer({ from: 5, to: 2, h: 40, replyH: null }), resolved_at: new Date(Date.parse(target.proposed_at) + 1000).toISOString() };
  const lateProposal = { league_id: 4, proposer: '2', counterparty: '1', proposed_at: new Date(Date.parse(target.proposed_at) + 1000).toISOString() };
  const after = T.featuresAsOf(target, T.makeContext({ offers: [...base, lateResolve, target], proposals: [lateProposal] }));
  assert.deepEqual(after, before);
});

// ------------------------------------------------------------- the fit
test('fitWeights: under MIN_TRAIN offers the weights are zero with a reason; above it they are shrunk and capped', () => {
  const few = T.fitWeights(Array.from({ length: T.MIN_TRAIN - 1 }, () => ({ x: [1, 0, 0], offset: 0, y: 1 })));
  assert.deepEqual(few.weights, [0, 0, 0]);
  assert.match(few.reason, /fewer than/);

  // Feature 0 strongly predicts yes; feature 1 is noise.
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const x0 = (i % 2) ? 1 : -1;
    rows.push({ x: [x0, (i % 3) - 1, 0], offset: 0, y: (x0 > 0) === (i % 10 !== 0) ? 1 : 0 });
  }
  const shrunk = T.fitWeights(rows);
  const uncapped = T.fitWeights(rows, { cap: Infinity });
  const loose = T.fitWeights(rows, { penalty: 1e-6, cap: Infinity });
  assert.ok(uncapped.weights[0] > 0);
  assert.ok(uncapped.weights[0] < loose.weights[0] - 0.05, 'the default penalty shrinks the weight toward 0');
  assert.ok(Math.abs(shrunk.weights[0]) <= T.WEIGHT_CAP);
  assert.equal(shrunk.weights[2], 0);
});

test('walk-forward: an offer\'s clone p ignores the answers of offers resolved after it was proposed', () => {
  const offers = [];
  for (let i = 0; i < 40; i += 1) offers.push(offer({ from: 1 + (i % 3), to: 4 + (i % 4), h: i * 10, replyH: 2 + (i % 5) * 10, status: i % 3 ? 'declined' : 'accepted' }));
  const scored = T.cloneScores(offers, T.makeContext({ offers }));
  const k = 30;
  const flipped = offers.map((o, i) => (i > k ? { ...o, status: o.status === 'accepted' ? 'declined' : 'accepted', y: 1 - o.y } : o));
  const again = T.cloneScores(flipped, T.makeContext({ offers: flipped }));
  for (let i = 0; i <= k; i += 1) assert.equal(again[i].p, scored[i].p, `offer ${i}`);
  assert.ok(scored.every(s => s.p > 0 && s.p < 1 && Number.isFinite(s.baseline)));
});

// ------------------------------------------------------------- E1 grade
test('gradeClone: E1 rows for the target league only; with no usable tell the clone IS activity-only (gain 0)', () => {
  const offers = [];
  for (let i = 0; i < 12; i += 1) offers.push(offer({ league: 4, from: 1, to: 2 + (i % 3), h: i * 10, replyH: null, status: i % 2 ? 'accepted' : 'declined' }));
  for (let i = 0; i < 6; i += 1) offers.push(offer({ league: 9, from: 1, to: 2, h: i * 10, status: 'declined' }));
  const g = T.gradeClone(offers, T.makeContext({ offers }), { leagueId: 4 });
  assert.equal(g.clone.check, 'E1');
  assert.equal(g.clone.metric_name, 'log_loss_gain_vs_activity');
  assert.equal(g.clone.n, 12);
  assert.equal(g.production.n, 12);
  assert.equal(Math.abs(g.clone.metric), 0);
  assert.equal(g.league_id, 4);
  assert.deepEqual(g.features, T.GRADED_FEATURES);
});

// ------------------------------------------------------------- the card
test('tells card: every entry carries n, what it predicts, as_of and the E1 evidence; absence is unknown, never 0', () => {
  const offers = [offer({ from: 1, to: 2, h: 0, replyH: 3 }), offer({ from: 3, to: 2, h: 5, replyH: 9 }), offer({ from: 2, to: 3, h: 6, replyH: 1 })];
  const ctx = T.makeContext({ offers });
  const card = T.tellsCard(ctx, { leagueId: 4, asOf: at(500), grade: { clone: { status: 'not_enough_data', metric: 0, ci_low: null, ci_high: null, n: 3, needs_text: 'needs 40 more offers' } } });
  assert.equal(card.league_id, 4);
  const team2 = card.managers.find(m => m.team_id === '2');
  assert.ok(team2);
  for (const e of team2.tells) {
    assert.ok('n' in e && e.predicts && e.as_of === at(500), e.id);
    assert.equal(e.evidence.e1_status, 'not_enough_data');
    if (e.status === 'unknown') { assert.equal(e.value, null); assert.ok(e.reason); }
  }
  const lat = team2.tells.find(e => e.id === 'reply_latency');
  assert.equal(lat.status, 'measured');
  assert.equal(lat.n, 2);
  const price = team2.tells.find(e => e.id === 'prior_accept_price');
  assert.equal(price.status, 'unknown');
  const chat = team2.tells.find(e => e.id === 'chat_wants_player');
  assert.equal(chat.status, 'unknown');
  assert.equal(card.managers.find(m => m.team_id === '3').tells.find(e => e.id === 'reply_latency').status, 'thin');
});

test('tells card: chat wants shows as unproven with the player names and n, never as a weight', () => {
  const ctx = T.makeContext({
    offers: [offer({ from: 1, to: 2, h: 0 })],
    wants: [{ league_id: 4, roster_id: '2', player_name: 'Player Alpha', sentiment: 0.5, n: 4, last_mention: at(1) }],
  });
  const chat = T.tellsCard(ctx, { leagueId: 4, asOf: at(10) }).managers.find(m => m.team_id === '2')
    .tells.find(e => e.id === 'chat_wants_player');
  assert.equal(chat.status, 'unproven');
  assert.equal(chat.weight, null);
  assert.deepEqual(chat.players, ['Player Alpha']);
  assert.equal(chat.n, 4);
});

// ------------------------------------------------------------- loader + flag
function fixtureDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT, execution_type TEXT,
            team_id INTEGER, related_tx_id TEXT, proposed_at TEXT, items_json TEXT);
          CREATE TABLE trade_outcomes (league_id INTEGER, season INTEGER, source TEXT, proposer_team_id TEXT, counterparty_team_id TEXT,
            proposed_at TEXT, model_p_accept REAL, status TEXT, espn_tx_id TEXT, idea_id TEXT, resolved_at TEXT);`);
  const ins = d.prepare('INSERT INTO league_transactions_raw VALUES (?,?,?,?,?,?,?,?,?)');
  for (let k = 0; k < 6; k += 1) {
    const id = `p${k}`;
    ins.run(4, 2026, id, 'TRADE_PROPOSAL', 'EXECUTE', 1, null, at(k * 10), JSON.stringify([{ playerId: 50 + k, fromTeamId: 1, toTeamId: 2 }]));
    ins.run(4, 2026, `${id}a`, k % 2 ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', 'EXECUTE', 2, id, at(k * 10 + 4), null);
  }
  return d;
}

test('loadCloneContext: reads offers and proposal items; absent optional sources are reasons, not errors', () => {
  const ctx = T.loadCloneContext(fixtureDb());
  assert.equal(ctx.offers.length, 6);
  assert.equal(ctx.itemsByTx.size, 6);
  assert.ok(ctx.missing.some(m => /dynasty_value_history/.test(m)));
  assert.ok(ctx.missing.some(m => /manager_player_view/.test(m)));
});

test('FIX-268-4: offer terms come from trade_proposal_snapshots first, raw items_json only when no snapshot exists', () => {
  const d = fixtureDb();
  d.exec(`CREATE TABLE trade_proposal_snapshots (league_id INTEGER, season INTEGER, proposal_tx_id TEXT, proposer_team_id INTEGER,
            proposed_at TEXT, items_json TEXT, captured_from TEXT)`);
  // p0: the raw upsert lost the items (ESPN handed the resolved offer back empty); the snapshot kept them.
  d.prepare(`UPDATE league_transactions_raw SET items_json = '[]' WHERE tx_id = 'p0'`).run();
  d.prepare('INSERT INTO trade_proposal_snapshots VALUES (?,?,?,?,?,?,?)')
    .run(4, 2026, 'p0', 1, at(0), JSON.stringify([{ playerId: 900, fromTeamId: 1, toTeamId: 2 }]), 'pending');
  // p1: both exist and differ; the snapshot wins.
  d.prepare('INSERT INTO trade_proposal_snapshots VALUES (?,?,?,?,?,?,?)')
    .run(4, 2026, 'p1', 1, at(10), JSON.stringify([{ playerId: 901, fromTeamId: 1, toTeamId: 2 }]), 'pending');
  const ctx = T.loadCloneContext(d);
  assert.equal(ctx.offers.length, 6, 'p0 is an offer again: its parties come from the snapshot');
  assert.equal(ctx.itemsByTx.get('4:2026:p0')[0].playerId, 900);
  assert.equal(ctx.itemsByTx.get('4:2026:p1')[0].playerId, 901);
  assert.equal(ctx.itemsByTx.get('4:2026:p2')[0].playerId, 52, 'no snapshot: the raw items');
  const src = Object.fromEntries(ctx.offers.map(o => [o.espn_tx_id, o.terms_source]));
  assert.deepEqual(src, { p0: 'trade_proposal_snapshots', p1: 'trade_proposal_snapshots', p2: 'league_transactions_raw',
    p3: 'league_transactions_raw', p4: 'league_transactions_raw', p5: 'league_transactions_raw' });
  assert.deepEqual(ctx.terms_sources, { trade_proposal_snapshots: 2, league_transactions_raw: 4 });
  assert.deepEqual(T.tellsCard(ctx, { leagueId: 4, asOf: at(900) }).terms_sources, ctx.terms_sources);
  assert.ok(!ctx.missing.some(m => /trade_proposal_snapshots/.test(m)));
  assert.ok(T.loadCloneContext(fixtureDb()).missing.some(m => /trade_proposal_snapshots.*fall back/.test(m)),
    'without the table the fallback is said, not silent');
});

test('flag: the card is off unless previewUnconfirmed(); on, it is labelled a preview and read, not computed', () => {
  const d = fixtureDb();
  const prev = process.env[PREVIEW_ENV];
  try {
    delete process.env[PREVIEW_ENV];
    const off = tellsCardResponse(d, 4);
    assert.equal(off.enabled, false);
    assert.match(off.reason, /E1/);
    assert.equal(off.card, undefined);
    process.env[PREVIEW_ENV] = '1';
    const on = tellsCardResponse(d, 4);
    assert.equal(on.enabled, true);
    assert.equal(on.preview, true);
    // The stored-card path is test/tells-producer.test.js; here there is no engine_state at all.
    assert.equal(on.card, null);
    assert.match(on.reason, /engine_state is not built/);
  } finally {
    if (prev == null) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = prev;
  }
});

// ------------------------------------------------------------- guards
test('guard: no tell reaches the served P(accept) — acceptanceBand and the pricing layer never import the clone features', () => {
  for (const f of ['server/services/trade-acceptance.js', 'server/services/counterparty-pricing.js', 'server/services/trade-engine.js']) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    assert.doesNotMatch(src, /tells\/clone-features|tells\/card/, f);
  }
});

test('guard: the tells files carry no league or manager names', () => {
  for (const f of ['server/services/tells/clone-features.js', 'server/services/tells/card.js', 'server/routes/tells.js',
    'client/src/components/brain/TellsCard.tsx']) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    assert.doesNotMatch(src, /NICK_PRIORS|league_name|leagues\.name/, f);
  }
});
