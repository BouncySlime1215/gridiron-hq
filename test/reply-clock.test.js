/**
 * REPLY-CLOCK: per league-mate, the median reply, the reply rate and the best
 * US Eastern send window, with n and a "(guess)" label below MIN_N. Extends
 * E-LATENCY (same pairing, same reply hours); flag default-off plus shadow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  replyClock, replyClockMode, sendSlot, hoursText, sendWhenLines, loadReplyClock, MIN_N, REPLY_CLOCK_FLAG,
} from '../server/services/eval/reply-latency.js';

const H = 3_600_000;
// Tue 2026-09-01 00:00 US Eastern (EDT, UTC-4) = 04:00 UTC.
const TUE0 = Date.UTC(2026, 8, 1, 4);
const at = h => new Date(TUE0 + h * H).toISOString();
const answered = (to, sentH, replyH, { league = 9, from = '1' } = {}) => ({
  league_id: league, season: 2026, source: 'observed', proposer_team_id: from, counterparty_team_id: String(to),
  proposed_at: at(sentH), decided_at: at(sentH + replyH), status: 'declined', y: 0,
});
const quiet = (to, excluded, { league = 9 } = {}) => ({ league_id: league, season: 2026, excluded, counterparty_team_id: String(to), proposer_team_id: '1', proposed_at: at(0) });

test('flag: off by default, shadow, on', () => {
  assert.equal(replyClockMode({}), 'off');
  assert.equal(replyClockMode({ [REPLY_CLOCK_FLAG]: '0' }), 'off');
  assert.equal(replyClockMode({ [REPLY_CLOCK_FLAG]: 'shadow' }), 'shadow');
  assert.equal(replyClockMode({ [REPLY_CLOCK_FLAG]: '1' }), 'on');
});

test('sendSlot: US Eastern weekday and part of day, across DST', () => {
  assert.deepEqual(sendSlot(at(19)), { day: 'Tue', part: 'evening', key: 2 * 4 + 3 });
  assert.deepEqual(sendSlot(at(24 + 7)), { day: 'Wed', part: 'morning', key: 3 * 4 + 1 });
  assert.equal(sendSlot(at(5)).part, 'night');
  // 2026-12-01 17:00 UTC = 12:00 EST (UTC-5): afternoon, a Tuesday.
  assert.deepEqual(sendSlot('2026-12-01T17:00:00Z'), { day: 'Tue', part: 'afternoon', key: 2 * 4 + 2 });
  assert.equal(sendSlot(null), null);
});

test('hoursText: hour, hours, days', () => {
  assert.equal(hoursText(0.3), 'within the hour');
  assert.equal(hoursText(2.6), 'within ~3\u00a0h');
  assert.equal(hoursText(50), 'within ~2\u00a0days');
  assert.equal(hoursText(null), null);
});

test('clock: best window = most answers, median reply, reply rate leaves withdrawn out', () => {
  // Team 7: three Tue-evening sends (2, 3, 4 h), one Wed-morning (1 h), one Thu-night (10 h): n = 5.
  const offers = [answered(7, 19, 2), answered(7, 20, 3), answered(7, 21, 4), answered(7, 24 + 8, 1), answered(7, 48 + 2, 10)];
  const silent = [quiet(7, 'expired'), quiet(7, 'unanswered'), quiet(7, 'withdrawn')];
  const c = replyClock({ offers, silent });
  const m = c.leagues['9']['7'];
  assert.deepEqual([m.n_answered, m.n_no_reply, m.n_withdrawn, m.median_h, m.reply_rate], [5, 2, 1, 3, 0.714]);
  assert.deepEqual(m.window, { day: 'Tue', part: 'evening', n: 3, median_h: 3 });
  assert.equal(m.guess, false);
  assert.equal(m.text, 'Best time to send: Tue evening (replies within ~3\u00a0h) · answers 5 of 7');
  assert.equal(c.p_yes_input, false);
});

test('clock: below MIN_N, or a window on one answer, reads "(guess)"', () => {
  const few = replyClock({ offers: [answered(4, 19, 2), answered(4, 20, 6)] }).leagues['9']['4'];
  assert.ok(few.n_answered < MIN_N);
  assert.equal(few.guess, true);
  assert.match(few.text, /^Best time to send: Tue evening \(replies within ~4\u00a0h\) · answers 2 of 2 \(guess\)$/);
  // Five answers, all in different windows: the window rests on one answer.
  const spread = replyClock({ offers: [0, 30, 55, 80, 105].map(h => answered(4, h, 1)) }).leagues['9']['4'];
  assert.equal(spread.n_answered, 5);
  assert.equal(spread.window.n, 1);
  assert.equal(spread.guess, true);
});

test('clock: ties go to the faster median; no answers says so and names no window', () => {
  const tie = replyClock({ offers: [answered(3, 19, 8), answered(3, 24 + 8, 1)] }).leagues['9']['3'];
  assert.deepEqual([tie.window.day, tie.window.part], ['Wed', 'morning']);
  const none = replyClock({ silent: [quiet(2, 'expired'), quiet(2, 'unanswered')] }).leagues['9']['2'];
  assert.equal(none.window, null);
  assert.equal(none.reply_rate, 0);
  assert.equal(none.text, 'Send when: no reply times yet (0 of 2 offers answered)');
});

test("clock: Nick's own team is never a row", () => {
  const c = replyClock({ offers: [answered(5, 19, 2), answered(7, 19, 2)], silent: [quiet(5, 'expired')] }, { me: { 9: '5' } });
  assert.deepEqual(Object.keys(c.leagues['9']), ['7']);
});

function fixtureDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY, season INTEGER, my_team_id INTEGER);
    INSERT INTO leagues VALUES (9, 2026, 1);
    CREATE TABLE trade_outcomes (league_id INTEGER, season INTEGER, source TEXT, proposer_team_id TEXT, counterparty_team_id TEXT,
      proposed_at TEXT, model_p_accept REAL, status TEXT, espn_tx_id TEXT, idea_id TEXT, resolved_at TEXT, sent_at TEXT, matched_tx_id TEXT);
    CREATE TABLE league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT, execution_type TEXT, team_id INTEGER,
      related_tx_id TEXT, proposed_at TEXT, items_json TEXT);`);
  const items = JSON.stringify([{ fromTeamId: 1, toTeamId: 7 }, { fromTeamId: 7, toTeamId: 1 }]);
  const ins = d.prepare('INSERT INTO league_transactions_raw VALUES (9, 2026, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('a', 'TRADE_PROPOSAL', 'EXECUTE', 1, null, at(19), items); // Tue evening ET
  ins.run('b', 'TRADE_DECLINE', 'EXECUTE', 7, 'a', at(21), null); // 2 h later
  return d;
}

test('sendWhenLines: null unless the flag is 1; with it, one line per league-mate, ids only', () => {
  const d = fixtureDb();
  assert.equal(sendWhenLines(d, 9, {}), null);
  assert.equal(sendWhenLines(d, 9, { [REPLY_CLOCK_FLAG]: 'shadow' }), null, 'shadow draws nothing');
  const lines = sendWhenLines(d, 9, { [REPLY_CLOCK_FLAG]: '1' });
  assert.deepEqual(Object.keys(lines), ['7'], "Nick's team (1) is not a row");
  assert.deepEqual(lines['7'], { text: 'Best time to send: Tue evening (replies within ~2\u00a0h) · answers 1 of 1 (guess)', guess: true, n: 1 });
  assert.equal(loadReplyClock(d, { leagueId: 9 }).leagues['9']['7'].window.day, 'Tue');
  // A db the pairing cannot read draws nothing rather than failing the card.
  assert.equal(sendWhenLines({ prepare() { throw new Error('no table'); } }, 9, { [REPLY_CLOCK_FLAG]: '1' }), null);
});

test('served numbers stay put: the clock only rides beside the plan (war-room-view, N&P view)', () => {
  const wr = fs.readFileSync(new URL('../server/services/war-room-view.js', import.meta.url), 'utf8');
  assert.match(wr, /GRIDIRON_REPLY_CLOCK === '1'/);
  assert.match(wr, /view\.reply_clock = lines/);
  const np = fs.readFileSync(new URL('../server/services/numbers-people/view.js', import.meta.url), 'utf8');
  assert.match(np, /sendWhenLines\(database, leagueId\)/);
  // No second producer of reply hours.
  const src = fs.readFileSync(new URL('../server/services/eval/reply-latency.js', import.meta.url), 'utf8');
  assert.equal((src.match(/function replyHours\(/g) ?? []).length, 1);
});

test('UI: one "send when" line on the War Room hero card and deck card and in the Numbers & People people lane, drawn from the server line only', () => {
  const read = p => fs.readFileSync(new URL(`../client/src/components/${p}`, import.meta.url), 'utf8');
  assert.match(read('warroom/HeroCard.tsx'), /view\.reply_clock\?\.\[String\(s\.partner\)\]/);
  assert.match(read('warroom/HeroCard.tsx'), /data-testid="hero-send-when"/);
  assert.match(read('warroom/NextMoveDeck.tsx'), /data-testid="deck-send-when"/);
  const np = read('trade/NumbersPeopleCard.tsx');
  assert.match(np, /<Lane read=\{item\.people\} people sendWhen=\{item\.send_when\} \/>/);
  assert.equal((np.match(/data-testid="np-send-when"/g) ?? []).length, 2, 'full and compact');
});
