// REASON-02: every claim a reasoning panel shows is stored as a checkable
// prediction with a resolve rule, settled against what happened, and graded
// (C8: share that came true). Offline: an in-memory database built from the
// real migrations, panels assembled by REASON-01's own assemblePanel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { up as upRoster } from '../server/migrations/058_league_roster_snapshots.js';
import { up as upOutcomes } from '../server/migrations/067_outcome_ledgers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { up as upClaims, down as downClaims, name as claimsMigrationName } from '../server/migrations/089_reasoning_claims.js';
import { assemblePanel } from '../server/services/reasoning/panel.js';
import { cardsForLeague } from '../server/services/reasoning/cards.js';
import { claimsFromPanel, recordClaims, RULES } from '../server/services/reasoning/claims.js';
import { resolveOpenClaims } from '../server/services/reasoning/resolve.js';
import * as c8 from '../server/services/reasoning/grade.js';
import * as grading from '../server/services/reasoning/grading.js';
const { runReasoningGrading } = grading;
import { PREVIEW_ENV } from '../server/services/preview-mode.js';

const AS_OF = '2026-09-24T12:00:00Z';
const LEAGUE = 4;

// Only the #239 pinning test opens the app database; it gets a temp one.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-reason-02-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function freshDb() {
  const db = new DatabaseSync(':memory:');
  upRoster(db);
  upOutcomes(db);
  upClaims(db);
  return db;
}

// ESPN ids -> the players table (core schema: position NOT NULL, espn_id added
// by the fantasy schema). 101 is the receiver we give, 201 the back we get.
const PLAYERS = [[101, 'WR'], [201, 'RB'], [301, 'TE'], [401, 'WR']];
function seedPlayers(db, list = PLAYERS) {
  db.exec(`CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    position TEXT NOT NULL, espn_id INTEGER)`);
  const ins = db.prepare('INSERT INTO players (name, position, espn_id) VALUES (?, ?, ?)');
  for (const [espn, pos] of list) ins.run(`p${espn}`, pos, espn);
  return db;
}

// counter_json exactly as #239 writes it: trade-outcomes.js replyTo() ->
// settleSentOffers() stores { tx_id, items } where items is the counter
// proposal's raw ESPN items_json (one item per player moving, fromTeamId ->
// toTeamId). We are team 1; he (team 3) proposes the counter.
const espnItem = (from, to, playerId) => ({ type: 'TRADE', playerId, fromTeamId: from, toTeamId: to,
  fromLineupSlotId: -1, toLineupSlotId: -1 });
const counter239 = (txId, askFromUs, giveToUs = [201]) => ({
  tx_id: txId,
  items: [...askFromUs.map(p => espnItem(1, 3, p)), ...giveToUs.map(p => espnItem(3, 1, p))]
});
// He wants our receiver back plus the tight end 301.
const COUNTER_TE = counter239('c-te', [101, 301]);
// He wants our receiver plus another receiver (401): no tight end.
const COUNTER_WR = counter239('c-wr', [101, 401]);

// The War Room contract (plans-schema.js `warroom-plans/1`) as cards.js reads
// it since FIX-03/FIX-08: typed fields, the deck in alternatives.value[], the
// partner row in partners.value[] by team, roster_holes as position strings.
const okf = value => ({ status: 'ok', value });
function plansFor() {
  return {
    generated_at: AS_OF,
    leagues: [{
      league: LEAGUE,
      names: { 101: 'Our Receiver', 201: 'Their Back' },
      alternatives: okf([{
        move_id: 'mv-1', delta_final: okf(0.02),
        steps: [{
          partner: 3, give: [101], get: [201], p_yes: { status: 'ok', value: 0.4, n: 9 },
          reply_table: okf({
            counter: okf({ do: 'Add him, stop there', counter_rules: { counter_with: 'asks for a bench tight end added' } }),
            decline: okf({ do: 'Move to the next card' })
          })
        }]
      }]),
      partners: okf([{ team: 3, roster_holes: ['RB', 'TE'], chat_labels: [], offers_logged: 9 }])
    }]
  };
}
// produce.js's news map: per league id, outside the plans file.
const NEWS = { [LEAGUE]: [{ id: 'n1', published_at: '2026-09-23T18:00:00Z', player_ids: [201], headline: 'Back limited in practice' }] };

const ok = value => ({ ok: true, violations: [], numbers_checked: 0, value });
const claim = (text, cites) => ({ text, cites });

function panelFor(plans, overrides = {}) {
  const league = plans.leagues[0];
  const card = cardsForLeague(league).cards[0];
  const grounded = {
    case_for: ok({ claims: [claim('Our spare receiver buys a starter back', ['card.give.0'])] }),
    his_side: ok({ claims: [
      claim('He is short a running back', ['his.hole.0.pos']),
      claim('He likes the deal on paper', ['card.p_yes'])
    ] }),
    devils_advocate: ok({ claims: [claim('The back may be hurt', ['news.n1.headline'])], would_change: [claim('A clean practice', ['news.n1.headline'])] }),
    news_check: ok({ contradictions: [{ quote_id: 'n1', claim: claim('Limited in practice', ['news.n1.headline']) }] }),
    counter: ok({ likely: claim('He counters for a bench tight end', ['reply.counter.counter', 'his.hole.1.pos']), answer: claim('Add him, stop there', ['reply.counter.action']) }),
    ...overrides
  };
  return assemblePanel({
    card, league, leagueId: LEAGUE, news: NEWS[LEAGUE], omit: [], omitReason: {}, grounded, missing: null,
    asOf: AS_OF, fingerprint: 'fp-1', cost: { reused: false, call_ok: true }
  });
}

const withPreview = async (fn) => {
  const before = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = before;
  }
};

function insertOutcome(db, { status, counter = null, proposedAt = '2026-09-25T00:00:00Z', ideaId = 'mv-1' }) {
  db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
    give_json, get_json, proposed_at, model_p_accept, model_basis, status, counter_json, idea_id, resolved_at, created_at)
    VALUES (?, 2026, 'app_proposed', '1', '3', '[101]', '[201]', ?, 0.4, 'heuristic_anchored', ?, ?, ?, ?, ?)`)
    .run(LEAGUE, proposedAt, status, counter && JSON.stringify(counter), ideaId, proposedAt, proposedAt);
}

function insertRoster(db, { period, team, player, pos, seen, changed = seen, source = 'final', status = null, proj = null, actual = null }) {
  db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
    player_name, position, lineup_slot_id, is_starter, injury_status, pregame_injury_status, projected_points,
    actual_points, source, first_seen_at, changed_at) VALUES (?, 2026, ?, ?, ?, 'x', ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(LEAGUE, period, team, player, pos, status, status, proj, actual, source, seen, changed);
}

// ---- migration ------------------------------------------------------------

test('089 is additive, idempotent and states its contract in SQL', () => {
  const db = freshDb();
  upClaims(db);
  const cols = db.prepare("SELECT name FROM pragma_table_info('reasoning_claims')").all().map(c => c.name);
  for (const c of ['kind', 'prediction_json', 'resolve_rule', 'resolve_by', 'status', 'evidence_json']) assert.ok(cols.includes(c), c);
  const base = `INSERT INTO reasoning_claims (league_id, card_id, fingerprint, section, claim_index, claim_text,
    cites_json, made_at, kind, prediction_json, resolve_rule, resolve_by, status, resolved_at, evidence_json, created_at)
    VALUES (4, 'c', 'f', 's', ?, 't', '[]', 'now', ?, '{}', ?, ?, ?, ?, ?, 'now')`;
  assert.throws(() => db.prepare(base).run(0, 'uncheckable', 'offer_reply_v1', null, 'uncheckable', null, null), /CHECK/, 'uncheckable with a rule');
  assert.throws(() => db.prepare(base).run(1, 'counter_with', 'none', 'x', 'open', null, null), /CHECK/, 'checkable without a rule');
  assert.throws(() => db.prepare(base).run(2, 'counter_with', 'offer_reply_v1', null, 'open', null, null), /CHECK/, 'no deadline');
  assert.throws(() => db.prepare(base).run(3, 'counter_with', 'offer_reply_v1', 'x', 'true', null, null), /CHECK/, 'verdict without evidence');
  db.prepare(base).run(4, 'counter_with', 'offer_reply_v1', 'x', 'true', 'now', '{}');
  downClaims(db);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='reasoning_claims'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='trade_outcomes'").get(), 'down touches nothing else');
});

test('089 is the number MIGRATIONS.md reserves for #271, its name matches its file, and nothing else uses 089', () => {
  const files = fs.readdirSync(new URL('../server/migrations/', import.meta.url)).filter(f => /^\d+_.+\.js$/.test(f));
  assert.deepEqual(files.filter(f => f.startsWith('089_')), ['089_reasoning_claims.js']);
  assert.equal(claimsMigrationName, '089_reasoning_claims', 'schema_migrations keys on this name');
  assert.equal(files.filter(f => /_reasoning_claims\.js$/.test(f)).length, 1, 'no leftover 085 copy');
});

// ---- extraction -----------------------------------------------------------

test('every shown claim becomes a row; the prediction comes from what it cites, not its words', () => {
  const plans = plansFor();
  const league = plans.leagues[0];
  const card = cardsForLeague(league).cards[0];
  const rows = claimsFromPanel({ panel: panelFor(plans), card, league, news: NEWS[LEAGUE] });

  const shown = 1 + 2 + 2 + 2; // case_for + his_side + devils (claims + would_change) + counter (likely + answer)
  const checkFirst = 1;       // one quote id; the news_check contradiction is its text, not a second row
  assert.equal(rows.length, shown + checkFirst);

  const counter = rows.find(r => r.section === 'counter' && r.claim_index === 0);
  assert.equal(counter.kind, 'counter_with');
  assert.equal(counter.resolve_rule, RULES.counter_with);
  assert.deepEqual(counter.prediction, { partner_team: '3', reply: 'counter', pos: 'TE', card_players: { give: ['101'], get: ['201'] } });

  const answer = rows.find(r => r.section === 'counter' && r.claim_index === 1);
  assert.equal(answer.kind, 'uncheckable');
  assert.equal(answer.prediction.why, 'own_action', 'our pre-planned answer is a plan, not a prediction');

  const wants = rows.find(r => r.section === 'his_side' && r.claim_index === 0);
  assert.equal(wants.kind, 'wants_position');
  assert.deepEqual(wants.prediction, { team: '3', pos: 'RB' });
  assert.equal(wants.subject_team, '3');

  const paper = rows.find(r => r.section === 'his_side' && r.claim_index === 1);
  assert.equal(paper.kind, 'uncheckable');
  assert.equal(paper.prediction.why, 'no_checkable_cite');

  const cf = rows.find(r => r.kind === 'check_first');
  assert.equal(cf.claim_text, 'Limited in practice');
  assert.deepEqual(cf.prediction, { quote_id: 'n1', player_ids: ['201'] });

  for (const r of rows) {
    assert.equal(r.made_at, AS_OF);
    assert.equal(r.resolve_by == null, r.kind === 'uncheckable', `${r.section}.${r.claim_index} deadline`);
  }
});

test('a check_first quote whose news item was not supplied is stored uncheckable, not guessed', () => {
  const plans = plansFor();
  const league = plans.leagues[0];
  const card = cardsForLeague(league).cards[0];
  const rows = claimsFromPanel({ panel: panelFor(plans), card, league });
  const cf = rows.find(r => r.section === 'check_first');
  assert.equal(cf.kind, 'uncheckable');
  assert.deepEqual(cf.prediction, { why: 'news_item_not_supplied', quote_id: 'n1' });
});

test('a failed or unknown section shows no words, so it makes no claims', () => {
  const plans = plansFor();
  const league = plans.leagues[0];
  const card = cardsForLeague(league).cards[0];
  const bad = { ok: false, violations: [{ kind: 'bad_cite' }], numbers_checked: 0, value: { likely: null, answer: null } };
  const rows = claimsFromPanel({ panel: panelFor(plans, { counter: bad }), card, league, news: NEWS[LEAGUE] });
  assert.equal(rows.filter(r => r.section === 'counter').length, 0);
  assert.ok(rows.some(r => r.section === 'his_side'));
});

test('recordClaims is idempotent on a reused panel and a rewritten panel is a new prediction', () => {
  const db = freshDb();
  const plans = plansFor();
  const panels = { as_of: AS_OF, leagues: [{ league_id: LEAGUE, panels: [panelFor(plans)] }] };
  const first = recordClaims(db, { plans, panels, news: NEWS, now: new Date(AS_OF) });
  assert.equal(first.inserted, 8);
  const again = recordClaims(db, { plans, panels, news: NEWS, now: new Date(AS_OF) });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 8);
  const rewritten = structuredClone(panels);
  rewritten.leagues[0].panels[0].fingerprint = 'fp-2';
  assert.equal(recordClaims(db, { plans, panels: rewritten, news: NEWS, now: new Date(AS_OF) }).inserted, 8);
  assert.equal(recordClaims(db, { plans, panels, news: NEWS, now: new Date(AS_OF), leagueId: 99 }).inserted, 0, 'league filter');
});

test('a panel whose card is no longer in the plans is reported, not guessed at', () => {
  const db = freshDb();
  const plans = plansFor();
  const panel = panelFor(plans);
  panel.card_id = 'gone';
  const out = recordClaims(db, { plans, panels: { leagues: [{ league_id: LEAGUE, panels: [panel] }] }, news: NEWS, now: new Date(AS_OF) });
  assert.equal(out.inserted, 0);
  assert.deepEqual(out.unmatched, [{ league_id: LEAGUE, card_id: 'gone' }]);
});

// ---- resolution -----------------------------------------------------------

function recorded() {
  const db = freshDb();
  const plans = plansFor();
  recordClaims(db, { plans, panels: { leagues: [{ league_id: LEAGUE, panels: [panelFor(plans)] }] }, news: NEWS, now: new Date(AS_OF) });
  return db;
}
const statusOf = (db, kind) => db.prepare('SELECT status, evidence_json FROM reasoning_claims WHERE kind = ?').get(kind);

test('counter_with: a #239 counter asking for the named position comes true, position checked', () => {
  const db = seedPlayers(recorded());
  insertOutcome(db, { status: 'countered', counter: COUNTER_TE });
  resolveOpenClaims(db, { now: new Date('2026-09-26T00:00:00Z') });
  const r = statusOf(db, 'counter_with');
  assert.equal(r.status, 'true');
  const ev = JSON.parse(r.evidence_json);
  assert.equal(ev.outcome_status, 'countered');
  assert.equal(ev.pos_checked, true, 'the position is read from counter_json.items');
  assert.deepEqual(ev.asked_player_ids, ['101', '301'], 'his receive side only, not the back he sends');
  assert.deepEqual(ev.asked_positions, ['TE', 'WR']);
  assert.deepEqual(ev.unresolved_player_ids, []);
  assert.match(ev.position_source, /^players\.position/);
});

test('counter_with: a decline makes it false; a #239 counter for another position is false', () => {
  const db = seedPlayers(recorded());
  insertOutcome(db, { status: 'declined' });
  resolveOpenClaims(db, { now: new Date('2026-09-26T00:00:00Z') });
  assert.equal(statusOf(db, 'counter_with').status, 'false');

  const db2 = seedPlayers(recorded());
  insertOutcome(db2, { status: 'countered', counter: COUNTER_WR });
  resolveOpenClaims(db2, { now: new Date('2026-09-26T00:00:00Z') });
  const r = statusOf(db2, 'counter_with');
  assert.equal(r.status, 'false');
  const ev = JSON.parse(r.evidence_json);
  assert.equal(ev.pos_checked, true);
  assert.deepEqual(ev.asked_positions, ['WR']);
});

test('counter_with: the old get_positions key is not read; only counter_json.items is', () => {
  const db = seedPlayers(recorded());
  insertOutcome(db, { status: 'countered', counter: { get_positions: ['WR'] } });
  resolveOpenClaims(db, { now: new Date('2026-09-26T00:00:00Z') });
  const r = statusOf(db, 'counter_with');
  const ev = JSON.parse(r.evidence_json);
  assert.equal(ev.pos_checked, false, 'no items, so no position to check');
  assert.equal(ev.asked_positions, null);
  assert.equal(r.status, 'true', 'judged on the reply kind alone');
});

test('counter_with: a player the players table cannot place leaves the position unchecked, and says which', () => {
  const db = seedPlayers(recorded(), [[101, 'WR']]);
  insertOutcome(db, { status: 'countered', counter: COUNTER_TE });
  resolveOpenClaims(db, { now: new Date('2026-09-26T00:00:00Z') });
  const ev = JSON.parse(statusOf(db, 'counter_with').evidence_json);
  assert.equal(ev.pos_checked, false, 'a half-known ask is not evidence the position was missing');
  assert.deepEqual(ev.unresolved_player_ids, ['301']);

  const noTable = recorded();
  insertOutcome(noTable, { status: 'countered', counter: COUNTER_TE });
  resolveOpenClaims(noTable, { now: new Date('2026-09-26T00:00:00Z') });
  const ev2 = JSON.parse(statusOf(noTable, 'counter_with').evidence_json);
  assert.equal(ev2.pos_checked, false);
  assert.match(ev2.position_source, /no players table/);
});

test('the counter fixture is exactly what #239 settleSentOffers writes into counter_json', async () => {
  const { db, run, row } = await import('../server/db/index.js');
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
  const { recordSentOffer, settleSentOffers } = await import('../server/services/trade-outcomes.js');
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
  const L = 7704;
  const sent = recordSentOffer({ league_id: L, season: 2026, proposer_team_id: '1', model_version: 'test',
    sent_at: '2026-09-25T00:00:00Z',
    deal: { id: 'mv-1', partner_id: '3', i_give: [{ id: 9101, name: 'x', espn_id: 101 }], i_get: [{ id: 9201, name: 'y', espn_id: 201 }],
      acceptance: { band: { low: 0.2, mid: 0.35, high: 0.5 }, basis: 'heuristic_unanchored' } } });
  const raw = (txId, teamId, related, at, items) => run(`INSERT INTO league_transactions_raw
    (league_id, season, tx_id, type, execution_type, proposed_at, team_id, related_tx_id, items_json, first_seen_at, last_seen_at)
    VALUES (?, 2026, ?, 'TRADE_PROPOSAL', 'EXECUTE', ?, ?, ?, ?, ?, ?)`, L, txId, at, teamId, related, JSON.stringify(items), at, at);
  raw('p1', 1, null, '2026-09-24T23:59:00Z', [espnItem(1, 3, 101), espnItem(3, 1, 201)]);
  raw('c-te', 3, 'p1', '2026-09-25T05:00:00Z', COUNTER_TE.items);
  settleSentOffers(L, 2026, { now: '2026-09-25T06:00:00Z' });
  const o = row('SELECT status, counter_json FROM trade_outcomes WHERE id = ?', sent.id);
  assert.equal(o.status, 'countered');
  assert.deepEqual(JSON.parse(o.counter_json), COUNTER_TE);
  db.close();
});

test('counter_with: never sent is void after the deadline, open before it; an offer from before the claim does not count', () => {
  const db = recorded();
  insertOutcome(db, { status: 'countered', counter: COUNTER_TE, proposedAt: '2026-09-20T00:00:00Z', ideaId: 'old' });
  resolveOpenClaims(db, { now: new Date('2026-09-26T00:00:00Z') });
  assert.equal(statusOf(db, 'counter_with').status, 'open');
  resolveOpenClaims(db, { now: new Date('2026-10-05T00:00:00Z') });
  const r = statusOf(db, 'counter_with');
  assert.equal(r.status, 'void');
  assert.equal(JSON.parse(r.evidence_json).why, 'offer_never_answered');
});

test('wants_position: he adds a running back inside the window -> true', () => {
  const db = recorded();
  insertRoster(db, { period: 3, team: 3, player: 500, pos: 'WR', seen: '2026-09-20T00:00:00Z' });
  insertRoster(db, { period: 4, team: 3, player: 500, pos: 'WR', seen: '2026-09-27T00:00:00Z' });
  insertRoster(db, { period: 4, team: 3, player: 777, pos: 'RB', seen: '2026-09-27T00:00:00Z' });
  resolveOpenClaims(db, { now: new Date('2026-09-28T00:00:00Z') });
  const r = statusOf(db, 'wants_position');
  assert.equal(r.status, 'true');
  assert.deepEqual(JSON.parse(r.evidence_json).added, [777]);
});

test('wants_position: a back he already had does not count; no back by the deadline -> false', () => {
  const db = recorded();
  insertRoster(db, { period: 3, team: 3, player: 600, pos: 'RB', seen: '2026-09-20T00:00:00Z' });
  insertRoster(db, { period: 4, team: 3, player: 600, pos: 'RB', seen: '2026-09-27T00:00:00Z' });
  resolveOpenClaims(db, { now: new Date('2026-09-28T00:00:00Z') });
  assert.equal(statusOf(db, 'wants_position').status, 'open', 'window still running');
  insertRoster(db, { period: 6, team: 3, player: 600, pos: 'RB', seen: '2026-10-10T00:00:00Z' });
  resolveOpenClaims(db, { now: new Date('2026-10-10T00:00:00Z') });
  assert.equal(statusOf(db, 'wants_position').status, 'false');
});

test('wants_position: no roster data at all is void after the grace period, never false', () => {
  const db = recorded();
  resolveOpenClaims(db, { now: new Date('2026-10-30T00:00:00Z') });
  const r = statusOf(db, 'wants_position');
  assert.equal(r.status, 'void');
  assert.equal(JSON.parse(r.evidence_json).why, 'no_roster_data');
});

test('check_first: the flagged player sat out -> true; played to projection -> false', () => {
  const db = recorded();
  // One row per (period, team, player): the live row turns final in place, so
  // first_seen_at stays before the claim and changed_at moves after it.
  insertRoster(db, { period: 3, team: 3, player: 201, pos: 'RB', seen: '2026-09-20T00:00:00Z', changed: '2026-09-29T00:00:00Z', status: 'OUT', proj: 12, actual: 0 });
  resolveOpenClaims(db, { now: new Date('2026-09-30T00:00:00Z') });
  assert.equal(statusOf(db, 'check_first').status, 'true');

  const db2 = recorded();
  insertRoster(db2, { period: 2, team: 3, player: 201, pos: 'RB', seen: '2026-09-13T00:00:00Z', changed: '2026-09-22T00:00:00Z', status: 'OUT', proj: 12, actual: 0 });
  insertRoster(db2, { period: 3, team: 3, player: 201, pos: 'RB', seen: '2026-09-20T00:00:00Z', changed: '2026-09-29T00:00:00Z', status: 'ACTIVE', proj: 12, actual: 14 });
  resolveOpenClaims(db2, { now: new Date('2026-09-30T00:00:00Z') });
  const r = statusOf(db2, 'check_first');
  assert.equal(r.status, 'false');
  assert.equal(JSON.parse(r.evidence_json).players[0].material, false);
  assert.equal(JSON.parse(r.evidence_json).players[0].period, 3, 'last week\'s final row is not this claim\'s game');
});

test('uncheckable claims are never touched by the resolver', () => {
  const db = recorded();
  const before = db.prepare("SELECT COUNT(*) n FROM reasoning_claims WHERE status = 'uncheckable'").get().n;
  resolveOpenClaims(db, { now: new Date('2027-01-01T00:00:00Z') });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reasoning_claims WHERE status = 'uncheckable'").get().n, before);
});

// ---- the C8 grader --------------------------------------------------------

const settled = (t, f) => [
  ...Array.from({ length: t }, (_, i) => ({ kind: 'counter_with', status: 'true', subject_team: String(i % 3) })),
  ...Array.from({ length: f }, (_, i) => ({ kind: 'wants_position', status: 'false', subject_team: String(i % 3) }))
];

// The columns #235 (EVAL-01) writes into brain_report for every grader row.
const BRAIN_REPORT_ROW = ['check', 'name', 'status', 'metric_name', 'metric', 'ci_low', 'ci_high', 'n',
  'needs_n', 'needs_unit', 'needs_text', 'pass_bar', 'source', 'detail'];

test('C8: too few settled claims is not_enough_data and says how many more', () => {
  const r = c8.grade([...settled(3, 2), { kind: 'uncheckable', status: 'uncheckable' }, { kind: 'check_first', status: 'open' }]);
  assert.deepEqual(Object.keys(r).sort(), [...BRAIN_REPORT_ROW].sort());
  assert.equal(r.check, 'C8');
  assert.equal(r.status, 'not_enough_data');
  assert.equal(r.n, 5);
  assert.equal(r.needs_n, c8.MIN_N - 5);
  assert.equal(r.needs_unit, 'decisions');
  assert.equal(r.detail.coverage.checkable, 6);
  assert.equal(r.detail.coverage.all, 7);
});

test('C8: mostly right passes, mostly wrong fails, with a CI and a per-kind and per-manager split', () => {
  const pass = c8.grade(settled(30, 6));
  assert.equal(pass.status, 'passing');
  assert.ok(pass.ci_low > 0.5 && pass.metric > pass.ci_low && pass.ci_high <= 1);
  assert.equal(pass.detail.by_kind.counter_with.true, 30);
  assert.equal(pass.detail.by_team['0'].n, 12);

  const fail = c8.grade(settled(6, 30));
  assert.equal(fail.status, 'failing');
  assert.ok(fail.ci_high < 0.5);

  const mid = c8.grade(settled(12, 12));
  assert.equal(mid.status, 'not_enough_data', 'a coin flip with a wide CI proves nothing yet');
  assert.ok(mid.needs_n > 0);
});

test('C8: void claims are counted in the detail but never in the share', () => {
  const r = c8.grade([...settled(30, 6), ...Array.from({ length: 50 }, () => ({ kind: 'counter_with', status: 'void' }))]);
  assert.equal(r.n, 36);
  assert.equal(r.detail.void, 50);
});

// ---- the flag -------------------------------------------------------------

test('behind previewUnconfirmed(): off records nothing and the grader says why', async () => {
  const db = freshDb();
  const plans = plansFor();
  const panels = { leagues: [{ league_id: LEAGUE, panels: [panelFor(plans)] }] };
  const before = process.env[PREVIEW_ENV];
  delete process.env[PREVIEW_ENV];
  try {
    const off = runReasoningGrading(db, { plans, panels, news: NEWS, now: new Date(AS_OF) });
    assert.equal(off.enabled, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reasoning_claims').get().n, 0);
    const row = c8.run(db);
    assert.equal(row.status, 'not_enough_data');
    assert.match(row.needs_text, /GRIDIRON_PREVIEW_UNCONFIRMED/);
  } finally {
    if (before !== undefined) process.env[PREVIEW_ENV] = before;
  }
});

test('on: record, resolve and grade in one pass, league-scoped, carrying the preview label', async () => {
  await withPreview(() => {
    const db = freshDb();
    const plans = plansFor();
    const panels = { leagues: [{ league_id: LEAGUE, panels: [panelFor(plans)] }] };
    seedPlayers(db);
    insertOutcome(db, { status: 'countered', counter: COUNTER_TE });
    db.prepare(`INSERT INTO reasoning_claims (league_id, card_id, fingerprint, section, claim_index, claim_text,
      cites_json, made_at, kind, prediction_json, resolve_rule, resolve_by, status, resolved_at, evidence_json, created_at)
      VALUES (99, 'other', 'f', 'counter', 0, 't', '[]', ?, 'counter_with', '{}', 'offer_reply_v1', ?, 'false', ?, '{}', ?)`)
      .run(AS_OF, AS_OF, AS_OF, AS_OF);
    const out = runReasoningGrading(db, { plans, panels, news: NEWS, now: new Date('2026-09-26T00:00:00Z'), leagueId: LEAGUE });
    assert.equal(out.enabled, true);
    assert.equal(out.preview, true);
    assert.equal(out.recorded.inserted, 8);
    assert.equal(out.resolved.true, 1);
    assert.equal(out.report.check, 'C8');
    assert.equal(out.report.n, 1, 'the other league\'s settled claim is not graded here');
    assert.equal(c8.run(db, { leagueId: 98 }).n, 0, 'another league sees none of it');
  });
});

test('C8 with no claims table yet is waiting, not an error', async () => {
  await withPreview(() => {
    const db = new DatabaseSync(':memory:');
    const r = c8.run(db);
    assert.equal(r.status, 'not_enough_data');
    assert.match(r.needs_text, /reasoning_claims/);
  });
});

// ---- the refresh-loop step (scripts/eval/run-graders.mjs) -------------------

function planFiles({ plans = plansFor(), panels = null, raw = null } = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'plans-'));
  const plansPath = path.join(dir, 'plans.json');
  fs.writeFileSync(plansPath, raw ?? JSON.stringify(plans));
  const cache = panels ?? { as_of: AS_OF, leagues: [{ league_id: LEAGUE, panels: [panelFor(plans)] }] };
  fs.writeFileSync(path.join(dir, 'panels.json'), JSON.stringify(cache));
  return plansPath;
}

test('refreshReasoningClaims: off, it reads nothing and writes nothing', () => {
  const before = process.env[PREVIEW_ENV];
  delete process.env[PREVIEW_ENV];
  try {
    const db = freshDb();
    const out = grading.refreshReasoningClaims(db, { plansPath: planFiles(), now: new Date(AS_OF) });
    assert.equal(out.enabled, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reasoning_claims').get().n, 0);
  } finally {
    if (before !== undefined) process.env[PREVIEW_ENV] = before;
  }
});

test('refreshReasoningClaims: on, it records the plans file\'s panels from the cache next to it and settles', async () => {
  await withPreview(() => {
    const db = seedPlayers(freshDb());
    insertOutcome(db, { status: 'countered', counter: COUNTER_TE });
    const out = grading.refreshReasoningClaims(db, { plansPath: planFiles(), now: new Date('2026-09-26T00:00:00Z') });
    assert.equal(out.enabled, true);
    assert.equal(out.recorded.inserted, 8);
    assert.equal(out.resolved.true, 1);
    assert.deepEqual(out.notes, ['no news feed in the loop; check_first quotes are stored uncheckable']);
  });
});

test('refreshReasoningClaims: no plans file still settles what is stored; a corrupt one is an error, not an empty run', async () => {
  await withPreview(() => {
    const db = freshDb();
    const missing = grading.refreshReasoningClaims(db, { plansPath: path.join(temp, 'nope', 'plans.json'), now: new Date(AS_OF) });
    assert.equal(missing.recorded, null);
    assert.match(missing.notes[0], /no plans file/);
    assert.ok(missing.resolved);

    const bad = grading.refreshReasoningClaims(db, { plansPath: planFiles({ raw: '{ not json' }), now: new Date(AS_OF) });
    assert.match(bad.error, /plans file .* could not be read/);
    assert.equal(bad.recorded, null);
  });
});
