/**
 * NEGOTIATOR-SAFETY (deep-queue item 11): the pure guards, the producer pass, the news reader and the
 * offer block on a negotiation thread. Pre-registration: docs/tdd/2026-09-25-negotiator-safety-prereg.md.
 *
 * Players: Nick's rule-pinned ids carry their real NFL names (160 Nico Collins, 80 Chase Brown,
 * 277 A.J. Brown, 290 Chris Olave); everyone else is made up. The plan is the contract producer's
 * league 4 (test/fixtures/warroom-contract/producer-plans.json) with letters-only names, as
 * test/coach-negotiator.test.js uses it. No DB file, no network.
 *
 * METRIC lines (printed as diagnostics): filter set caught / labelled bad, false rejections of the
 * plan's own texts, why-line share, news withdraws vs expected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  filterText, blockedIds, counterGate, ensureWhyLine, offerState, applyNegotiatorSafety, negotiatorSafetyOn,
  SAFETY_REASONS, WITHDRAW_TEXT, NEGOTIATOR_SAFETY_ENV
} from '../server/services/campaign/negotiator-safety.js';
import { dealNews } from '../server/services/campaign/deal-news.js';
import { SAFETY_REASONS as SCHEMA_REASONS, validateLeague } from '../server/services/campaign/plans-schema.js';
import { firmOfferText, feelerText, OFFER_HOURS } from '../server/services/campaign/negotiator-defaults.js';
import { applyCoachMessages } from '../server/services/campaign/messages.js';
import { splitName, checkMessage, factsFor } from '../server/services/campaign/message-check.js';
import { threadView } from '../server/services/warroom-negotiate.js';

const NAMES = {
  160: 'Nico Collins (WR)', 80: 'Chase Brown (RB)', 277: 'A.J. Brown (WR)', 290: 'Chris Olave (WR)',
  4: 'D. Dell (RB)', 5: 'E. Eads (WR)', 6: 'F. Frye (TE)', 7: 'G. Gore (WR)', 8: 'Jordan Love (QB)',
  21: 'K. Knox (WR)', 25: 'M. Moss (RB)', 33: 'Marquise Brown (WR)'
};
const MINE = ['160', '80', '277', '4', '5', '6', '7', '8'];
const STEP = { allowedGive: ['4', '5', '6'], allowed: ['4', '5', '6', '21', '25', '33'] };
const f = (text, extra = {}) => filterText(text, { names: NAMES, blocked: blockedIds(), mine: MINE, ...STEP, ...extra });

/** The labelled bad set: [text, the reason it must be rejected for, extra opts]. */
const BAD = [
  ['Nico Collins for K. Knox?', 'blocked_player'],
  ['Collins and Dell for Knox.', 'blocked_player'],
  ['nico collins for knox', 'blocked_player'],
  ['Chase Brown for K. Knox, straight up.', 'blocked_player'],
  ['Dell for Knox and I keep Chase Brown out of it.', 'blocked_player'],
  ['A.J. Brown for K. Knox?', 'blocked_player'],
  ['AJ Brown and Dell for Knox.', 'blocked_player'],
  ['Moss and Knox for A. J. Brown?', 'blocked_player'],
  ['Brown for Knox?', 'blocked_player'],
  ['Would you take Olave back for Knox?', 'blocked_player'],
  ['Chris Olave for D. Dell?', 'blocked_player'],
  ['D. Dell and G. Gore for K. Knox.', 'gives_more'],
  ['Dell, Eads and Gore for Knox.', 'gives_more'],
  ['Gore for Knox.', 'gives_more'],
  ['Dell for Knox. I have other offers.', 'pressure'],
  ['Dell for Knox, last chance.', 'pressure'],
  ['Take it or leave it: Dell for Knox.', 'pressure'],
  ['Dell for Knox before someone else grabs him.', 'pressure'],
  ["Dell for Knox. This won't last.", 'pressure'],
  ['Dell for Knox, final offer.', 'pressure'],
  ['Would you do D. Dell and E. Eads for K. Knox?', 'worse_than_plan', { priced: { after: 0.40, floor: 0.48 } }],
];

const who = id => splitName(NAMES[id]);
/** The planner's own texts for this deal (negotiator-defaults, messages.js reply rows). */
const OWN = [
  firmOfferText({ who, give: ['4', '6'], get: ['21'], alt: ['5'], holes: ['RB'] }),
  firmOfferText({ who, give: ['4'], get: ['33'], holes: [] }),
  feelerText({ who, give: ['4', '6'], get: ['21'] }),
  'Deal! Sending it over now.', 'All good, appreciate you looking at it.',
  'What if I did D. Dell and E. Eads for K. Knox instead?',
  'Any thoughts on D. Dell and F. Frye for K. Knox? It stands until tomorrow.',
  'Would love to do D. Dell for Marquise Brown.',
  'Would you do D. Dell and E. Eads for K. Knox?',
];

test('METRIC (b): every labelled bad text is rejected for its reason; none of the plan\'s own texts is', t => {
  const caught = BAD.filter(([text, reason, extra]) => f(text, extra).reasons.includes(reason));
  const falseRej = OWN.filter(text => !f(text).ok);
  t.diagnostic(`METRIC filter caught=${caught.length}/${BAD.length} false_rejections=${falseRej.length}/${OWN.length}`);
  for (const [text, reason, extra] of BAD) if (!caught.some(c => c[0] === text)) t.diagnostic(`MISS ${reason}: ${text} -> ${JSON.stringify(f(text, extra).reasons)}`);
  for (const text of falseRej) t.diagnostic(`FALSE ${text} -> ${JSON.stringify(f(text).hits)}`);
  assert.ok(BAD.length >= 20);
  assert.equal(caught.length, BAD.length);
  assert.deepEqual(falseRej, []);
});

test('(b) the pinned ids are always blocked, and the rule gate\'s sets are added', () => {
  const b = blockedIds(null);
  for (const id of ['160', '80', '277', '290']) assert.ok(b.has(id));
  const g = blockedIds({ neverGive: new Set(['9']), neverGet: new Set(['10']), sold: new Set([11]) });
  for (const id of ['9', '10', '11', '160']) assert.ok(g.has(id));
});

test('(b) a counter priced at or above the backup passes; an unpriced one is not judged here', () => {
  const text = 'Would you do D. Dell and E. Eads for K. Knox?';
  assert.equal(f(text, { priced: { after: 0.5, floor: 0.48 } }).ok, true);
  assert.equal(f(text, { priced: { after: 0.48, floor: 0.48 } }).ok, true);
  assert.equal(f(text, { priced: { after: NaN, floor: 0.48 } }).ok, true);
});

test('(a) counterGate: take and counter-with need an engine price; walk never does', () => {
  const p = { title_after: 0.5 };
  assert.deepEqual(counterGate({ decision: 'take', hisPrice: p }), { decision: 'take', held: null });
  assert.deepEqual(counterGate({ decision: 'take', hisPrice: null }), { decision: 'wait', held: 'his_counter_unpriced' });
  assert.deepEqual(counterGate({ decision: 'take', hisPrice: { title_after: NaN } }), { decision: 'wait', held: 'his_counter_unpriced' });
  assert.deepEqual(counterGate({ decision: 'counter', hisPrice: p, ourPrice: null }), { decision: 'wait', held: 'our_counter_unpriced' });
  assert.deepEqual(counterGate({ decision: 'counter', ourPrice: p }), { decision: 'counter', held: null });
  assert.deepEqual(counterGate({ decision: 'walk' }), { decision: 'walk', held: null });
});

test('(d) ensureWhyLine: a hole fit first, then the position, then a plain line; never past the limit', () => {
  const a = ensureWhyLine('D. Dell for K. Knox.', { who, give: ['4'], holes: ['RB'] });
  assert.equal(a.text, 'D. Dell fills your RB hole. D. Dell for K. Knox.');
  const b = ensureWhyLine('F. Frye for K. Knox.', { who, give: ['6'], holes: [] });
  assert.equal(b.why, 'F. Frye gives you another TE.');
  const c = ensureWhyLine('X for K. Knox.', { who: () => ({ name: 'X', position: null }), give: ['99'] });
  assert.equal(c.why, 'X adds depth to your roster.');
  const already = ensureWhyLine(a.text, { who, give: ['4'], holes: ['RB'] });
  assert.equal(already.added, false);
  const long = `D. Dell for K. Knox. ${'Really. '.repeat(40)}`;
  const d = ensureWhyLine(long, { who, give: ['4'], holes: ['RB'], maxChars: 280 });
  assert.ok(d.text.length <= 280 && d.text.startsWith(d.why) && d.text.includes('D. Dell for K. Knox.'));
});

/* ------------------------------------------------------------------ producer pass */

const LETTERS = { 1: 'A. Aaron', 2: 'B. Brook', 3: 'C. Cole', 4: 'D. Dell', 5: 'E. Eads', 6: 'F. Frye', 7: 'G. Gore',
  11: 'H. Hale', 12: 'I. Irons', 13: 'J. Jett', 14: 'L. Lamb', 15: 'N. Nash', 21: 'K. Knox', 22: 'L. Lane', 23: 'O. Ortiz',
  24: 'Q. Quinn', 25: 'M. Moss', 31: 'R. Rios', 32: 'S. Sims', 33: 'T. Tate', 34: 'U. Upton', 35: 'V. Vance' };
const PRODUCER = JSON.parse(fs.readFileSync(new URL('./fixtures/warroom-contract/producer-plans.json', import.meta.url), 'utf8'));
const ENTRY = JSON.parse(JSON.stringify(PRODUCER.leagues.find(l => l.league === 4)).replace(/\bP(\d{1,2})\b/g, (m, id) => LETTERS[id] ?? m));
const steps = e => [e.next_move.value, ...e.alternatives.value].flatMap(m => m.steps);
const ME = ['1', '2', '3', '4', '5', '6', '7'];

test('flag off: the entry comes back as the same object; the switch is its own, never the preview one', () => {
  assert.equal(applyNegotiatorSafety(ENTRY, { env: {} }).entry, ENTRY);
  assert.equal(applyNegotiatorSafety(ENTRY, { env: { GRIDIRON_PREVIEW_UNCONFIRMED: '1' } }).entry, ENTRY);
  assert.equal(negotiatorSafetyOn({ [NEGOTIATOR_SAFETY_ENV]: '1' }), true);
  assert.equal(negotiatorSafetyOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
});

test('METRIC (d)+(b) on the fixture plan, coach texts on: every message opens with a why line, 0 held back, contract valid', t => {
  const coached = applyCoachMessages(ENTRY, { force: true }).entry;
  for (const src of [ENTRY, coached]) {
    const { entry, stats } = applyNegotiatorSafety(src, { force: true, mine: ME });
    const all = steps(entry).filter(s => s.message?.status === 'ok');
    const withWhy = all.filter(s => s.safety?.value?.why_line === true);
    t.diagnostic(`METRIC ${src === ENTRY ? 'template' : 'coach'} texts: why_line=${withWhy.length}/${all.length} held_back=${stats.rejected.message + stats.rejected.reply} max_len=${Math.max(...all.map(s => s.message.value.length))}`);
    assert.equal(stats.rejected.message + stats.rejected.reply, 0, JSON.stringify(stats.reasons));
    assert.equal(withWhy.length, all.length);
    assert.ok(all.length >= 3);
    for (const s of all) {
      assert.ok(s.message.value.length <= 280);
      assert.equal(s.safety.value.expires_hours, OFFER_HOURS);
      if (src === coached) {
        const allowed = [...s.give, ...s.get, ...(s.opening?.value?.give ?? []), ...(s.walk_away?.value?.max_give ?? [])];
        const holes = entry.partners.value.find(p => String(p.team) === String(s.partner))?.roster_holes ?? [];
        const c = checkMessage(s.message.value.split('\n')[0].split(/(?<=\.)\s/)[0], factsFor({ names: entry.names, ids: allowed, holes }));
        assert.ok(c.ok, `${s.message.value}: ${c.errors}`);
      }
    }
    const v = validateLeague(entry);
    assert.deepEqual(v.errors, []);
  }
});

test('(b) a step whose message names a blocked player is held back as failed; a bad reply row loses its message', () => {
  const bad = structuredClone(ENTRY);
  bad.names['160'] = 'Nico Collins (WR)';
  const s0 = bad.next_move.value.steps[0];
  s0.message = { status: 'ok', value: 'Nico Collins for K. Knox?', source: 'coach.text' };
  if (s0.reply_table.status === 'ok') s0.reply_table.value.silence.value.message = 'Last chance on this one.';
  const { entry, stats } = applyNegotiatorSafety(bad, { force: true, mine: [...ME, '160'] });
  const s = entry.next_move.value.steps[0];
  assert.equal(s.message.status, 'failed');
  assert.match(s.message.reason, /blocked player/);
  assert.equal(stats.rejected.message, 1);
  assert.deepEqual(s.safety.value.filtered[0], { text: 'message', reasons: ['blocked_player'] });
  if (s0.reply_table.status === 'ok') {
    assert.equal(s.reply_table.value.silence.value.message, undefined);
    assert.ok(s.safety.value.filtered.some(x => x.text === 'silence' && x.reasons.includes('pressure')));
  }
  assert.deepEqual(validateLeague(entry).errors, []);
});

test('the served reasons are the contract\'s reasons', () => {
  assert.deepEqual([...SAFETY_REASONS], [...SCHEMA_REASONS]);
});

/* ------------------------------------------------------------------ (c) expiry and news */

const SENT = '2026-10-01T12:00:00.000Z';
const H = 3600_000;

test('(c) offerState: expires 48 h after the last send; news after it withdraws; before it, or elsewhere, does not', () => {
  const live = offerState({ lastSend: SENT, now: Date.parse(SENT) + H, ids: ['4', '21'] });
  assert.equal(live.state, 'live');
  assert.equal(live.expires_at, new Date(Date.parse(SENT) + OFFER_HOURS * H).toISOString());
  assert.equal(OFFER_HOURS, 48);
  assert.equal(live.withdraw_message, null);
  assert.equal(offerState({ lastSend: SENT, now: Date.parse(SENT) + 49 * H, ids: ['4'] }).state, 'expired');
  const ev = (player_id, kind, at) => ({ player_id, kind, at, detail: kind });
  const before = offerState({ lastSend: SENT, now: Date.parse(SENT) + H, ids: ['4', '21'], news: { events: [ev('4', 'injury', '2026-10-01T11:00:00Z')], missing: [] } });
  assert.equal(before.state, 'live');
  const other = offerState({ lastSend: SENT, now: Date.parse(SENT) + H, ids: ['4', '21'], news: { events: [ev('99', 'injury', '2026-10-01T13:00:00Z')], missing: [] } });
  assert.equal(other.state, 'live');
  for (const kind of ['injury', 'role', 'roster']) {
    const w = offerState({ lastSend: SENT, now: Date.parse(SENT) + H, ids: ['4', '21'], news: { events: [ev('21', kind, '2026-10-01T12:30:00Z')], missing: [] } });
    assert.equal(w.state, 'withdraw', kind);
    assert.equal(w.withdraw_message, WITHDRAW_TEXT);
  }
  const missing = offerState({ lastSend: SENT, now: Date.parse(SENT) + H, ids: ['4'], news: { events: [], missing: ['depth charts'] } });
  assert.deepEqual(missing.sources_missing, ['depth charts']);
  assert.match(missing.why, /not watched for news: depth charts/);
});

/** A throwaway in-memory database with the three news tables and the players map. */
function newsDb({ tables = ['players', 'nfl_feature_revisions', 'nfl_depth', 'league_roster_snapshots'] } = {}) {
  const d = new DatabaseSync(':memory:');
  const ddl = {
    players: 'CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, gsis_id TEXT)',
    nfl_feature_revisions: 'CREATE TABLE nfl_feature_revisions (entity TEXT, feature TEXT, published_at TEXT, value_json TEXT)',
    nfl_depth: 'CREATE TABLE nfl_depth (season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, pos_abb TEXT, pos_rank INTEGER, captured TEXT)',
    league_roster_snapshots: 'CREATE TABLE league_roster_snapshots (league_id INTEGER, player_id INTEGER, team_id INTEGER, on_roster INTEGER, first_seen_at TEXT, changed_at TEXT)',
  };
  for (const tb of tables) d.exec(ddl[tb]);
  return { d, db: { rows: (sql, ...p) => d.prepare(sql).all(...p) } };
}

test('METRIC (c) dealNews: one of each kind after the send is found; the same facts before it, or a re-listing, are not', t => {
  const { d, db } = newsDb();
  const ins = (sql, ...p) => d.prepare(sql).run(...p);
  for (const [id, g] of [[4, 'G4'], [21, 'G21'], [25, 'G25'], [5, 'G5']]) ins('INSERT INTO players VALUES (?, ?, ?)', id, `P${id}`, g);
  const rev = (g, wk, at, v) => ins('INSERT INTO nfl_feature_revisions VALUES (?, ?, ?, ?)', `player:${g}:2026:${wk}`, 'injury_report', at, JSON.stringify(v));
  // injury: 21 questionable before the send, out after it -> news. 5 questionable in week 4 and re-listed in week 5 -> none.
  rev('G21', 4, '2026-09-30 10:00:00', { report_status: 'Questionable', injury: 'Ankle' });
  rev('G21', 4, '2026-10-02T10:00:00Z', { report_status: 'Out', injury: 'Ankle' });
  rev('G5', 4, '2026-09-30T10:00:00Z', { report_status: 'Questionable', injury: 'Knee' });
  rev('G5', 5, '2026-10-03T10:00:00Z', { report_status: 'Questionable', injury: 'Knee' });
  // role: 4 RB1 -> RB2 after the send. 25 same rank before and after -> none.
  const dep = (g, pos, rank, at) => ins('INSERT INTO nfl_depth VALUES (2026, 5, ?, ?, ?, ?, ?)', 'XX', g, pos, rank, at);
  dep('G4', 'RB', 1, '2026-09-29T00:00:00Z'); dep('G4', 'RB', 2, '2026-10-02T00:00:00Z');
  d.prepare("UPDATE nfl_depth SET week = 4 WHERE captured < '2026-10-01'").run();
  dep('G25', 'RB', 1, '2026-10-02T00:00:00Z');
  // roster: 25 moved from team 3 to team 6 after the send. 4 stays.
  const ros = (pid, team, on, first, changed) => ins('INSERT INTO league_roster_snapshots VALUES (4, ?, ?, ?, ?, ?)', pid, team, on, first, changed);
  ros(25, 3, 1, '2026-09-01 00:00:00', '2026-09-20 00:00:00');
  ros(25, 6, 1, '2026-10-02 08:00:00', '2026-10-02 08:00:00');
  ros(4, 1, 1, '2026-09-01 00:00:00', '2026-10-02 00:00:00');
  const n = dealNews(db, { leagueId: 4, ids: ['4', '21', '25', '5'], since: SENT });
  const got = n.events.map(e => `${e.player_id}:${e.kind}`).sort();
  const want = ['21:injury', '25:roster', '4:role'];
  t.diagnostic(`METRIC news found=${got.filter(g => want.includes(g)).length}/${want.length} false=${got.filter(g => !want.includes(g)).length}`);
  assert.deepEqual(got, want);
  assert.deepEqual(n.missing, []);
  // The same facts, asked from after all of them: nothing.
  assert.deepEqual(dealNews(db, { leagueId: 4, ids: ['4', '21', '25', '5'], since: '2026-10-05T00:00:00Z' }).events, []);
});

test('(c) dealNews: an absent source is named, never read as no news; another fault throws', () => {
  const { db } = newsDb({ tables: ['players'] });
  const n = dealNews(db, { leagueId: 4, ids: ['4'], since: SENT });
  assert.deepEqual(n.missing, ['league rosters']);
  const { d, db: db2 } = newsDb({ tables: ['players'] });
  d.prepare('INSERT INTO players VALUES (4, ?, ?)').run('P4', 'G4');
  assert.deepEqual(dealNews(db2, { leagueId: 4, ids: ['4'], since: SENT }).missing.sort(), ['depth charts', 'injury reports', 'league rosters']);
  assert.throws(() => dealNews({ rows: () => { throw new Error('disk I/O error'); } }, { leagueId: 4, ids: ['4'], since: SENT }), /disk I\/O/);
});

test('(c) threadView: with news the open thread carries the offer block; without it, the view is as before', () => {
  const t = { id: 7, league_id: 4, move_id: 'm1', step_index: 0, partner: '3', give_json: '["4"]', get_json: '["21"]',
    names_json: '{}', step_json: JSON.stringify({ message: 'x' }), snapshot_id: null, sent_at: SENT, status: 'open', closed_reason: null, closed_at: null };
  const counter = [{ kind: 'counter_sent', reply: null, give_json: '["5"]', get_json: '["21"]', note: null, at: '2026-10-02T12:00:00.000Z' }];
  const plainView = threadView(t, counter, null, Date.parse(SENT) + H);
  assert.equal('offer' in plainView, false);
  const news = { events: [{ player_id: '5', kind: 'injury', at: '2026-10-02T13:00:00Z', detail: 'x' }], missing: [] };
  const v = threadView(t, counter, null, Date.parse('2026-10-02T14:00:00Z'), { news });
  assert.equal(v.offer.state, 'withdraw', 'news on the player Nick\'s counter added, after that counter');
  assert.equal(v.offer.expires_at, '2026-10-04T12:00:00.000Z', 'the expiry runs from the latest send');
  const early = threadView(t, counter, null, Date.parse('2026-10-02T14:00:00Z'), { news: { events: [{ ...news.events[0], at: '2026-10-02T11:00:00Z' }], missing: [] } });
  assert.equal(early.offer.state, 'live');
});
