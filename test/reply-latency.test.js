/**
 * E-LATENCY: a descriptive reply-time table per manager, a "no reply after N h"
 * follow-up / withdraw hint, and the pre-registered forward grade of that hint.
 * Reads decided-offers.js's pairing (one producer); never a P(yes) input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  replyLatencyTable, followUpHints, gradeHint, loadReplyLatency, quantile, HINT_BAR, MIN_N, REPLY_LATENCY_FLAG,
} from '../server/services/eval/reply-latency.js';
import { decidedOffers } from '../server/services/eval/decided-offers.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/decided-offers-2026-09-24.json', import.meta.url)));
const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const at = h => new Date(T0 + h * H).toISOString();

// A decided offer as decided-offers.js emits it.
const answered = (to, sentH, replyH, { league = 9, from = '1', status = 'declined' } = {}) => ({
  league_id: league, season: 2026, source: 'observed', proposer_team_id: from, counterparty_team_id: String(to),
  proposed_at: at(sentH), decided_at: at(sentH + replyH), status, y: status === 'accepted' ? 1 : 0,
});

test('quantile: linear interpolation, null on empty', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([4], 0.9), 4);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([0, 10], 0.9), 9);
});

test('table: per-manager reply hours, pooled league row, silence counted apart from answers', () => {
  const offers = [1, 2, 3, 4, 5].map((h, i) => answered(7, i * 10, h)).concat([answered(8, 0, 0.5, { status: 'accepted' })]);
  const silent = [{ league_id: 9, season: 2026, excluded: 'expired', counterparty_team_id: '7', proposer_team_id: '1', proposed_at: at(0), closed_at: at(48) },
    { league_id: 9, season: 2026, excluded: 'withdrawn', counterparty_team_id: '7', proposer_team_id: '1', proposed_at: at(0), closed_at: at(2) }];
  const t = replyLatencyTable({ offers, silent });
  const m7 = t.leagues['9'].managers['7'];
  assert.deepEqual([m7.n_answered, m7.median_h, m7.p90_h, m7.n_expired, m7.n_withdrawn], [5, 3, 4.6, 1, 1]);
  assert.equal(m7.threshold_basis, 'manager');
  const m8 = t.leagues['9'].managers['8'];
  assert.equal(m8.n_answered, 1);
  assert.equal(m8.threshold_basis, 'league', `fewer than ${MIN_N} answers borrow the league's p90`);
  assert.equal(m8.threshold_h, t.leagues['9'].pooled.p90_h);
  assert.equal(t.leagues['9'].pooled.n_answered, 6);
  assert.equal(t.p_yes_input, false, 'descriptive only');
});

test('table: an answer before its proposal or with no timestamps is skipped and counted', () => {
  const bad = { ...answered(7, 10, 1), decided_at: at(5) };
  const none = { ...answered(7, 10, 1), proposed_at: null };
  const t = replyLatencyTable({ offers: [bad, none, answered(7, 0, 2)] });
  assert.equal(t.leagues['9'].managers['7'].n_answered, 1);
  assert.equal(t.skipped.bad_times, 2);
});

test('hint: wait under N, follow up past N, withdraw-or-resend past 2N; no basis says so', () => {
  const offers = [1, 2, 3, 4, 5].map((h, i) => answered(7, i * 10, h));
  const table = replyLatencyTable({ offers });
  const N = table.leagues['9'].managers['7'].threshold_h;
  const pend = (to, sentH, league = 9) => ({ league_id: league, counterparty_team_id: String(to), proposer_team_id: '1', sent_at: at(sentH), offer_id: `p${sentH}` });
  const now = at(100);
  const hints = followUpHints([pend(7, 100 - N / 2), pend(7, 100 - N * 1.5), pend(7, 100 - N * 3), pend(7, 99, 5)], table, { now });
  assert.deepEqual(hints.map(h => h.hint), ['wait', 'follow_up', 'withdraw_or_resend', 'no_basis']);
  assert.ok(hints.every(h => h.shadow === true && h.graded === false), 'shadow until the grade passes');
  assert.equal(hints[1].threshold_h, N);
  assert.match(hints[3].reason, /no answered offers/);
  const graded = followUpHints([pend(7, 99)], table, { now, grade: { pass: true } });
  assert.equal(graded[0].shadow, false);
});

test('grade: time-forward, thresholds from earlier offers only; bar is pre-registered', () => {
  assert.deepEqual(HINT_BAR, { min_graded: 30, max_late_rate: 0.15 });
  // 40 answers from one manager, alternating 2 h and 3 h: after the first MIN_N, none is late.
  const offers = Array.from({ length: 40 }, (_, i) => answered(7, i * 10, 2 + (i % 2)));
  const g = gradeHint(offers);
  assert.equal(g.n_graded, 40 - MIN_N);
  assert.equal(g.n_late, 0);
  assert.equal(g.pass, true);
  // The manager slows down: from the 26th offer on, every answer takes 60 h. The
  // earlier fast answers set N, so the slow ones read late until N catches up.
  const slow = offers.map((o, i) => (i >= 25 ? answered(7, i * 10, 60) : o));
  const s = gradeHint(slow);
  assert.ok(s.late_rate > HINT_BAR.max_late_rate);
  assert.equal(s.pass, false);
  assert.match(s.verdict, /late/);
  // Too few graded offers: not a pass, however clean.
  const few = gradeHint(offers.slice(0, 10));
  assert.equal(few.pass, false);
  assert.match(few.verdict, /n=5 of 30/);
});

test('grade: an offer never uses its own or a later reply time', () => {
  // First MIN_N answers are fast; the 6th is slow. Its threshold must come from the first five only.
  const offers = [1, 1, 1, 1, 1].map((h, i) => answered(7, i, h)).concat([answered(7, 10, 30)]);
  const g = gradeHint(offers);
  assert.equal(g.n_graded, 1);
  assert.equal(g.n_late, 1);
});

test('fixture: the pairing now carries who and when for silent offers, counts unchanged', () => {
  const r = decidedOffers(fixture);
  assert.equal(r.offers.length, 37);
  const t = replyLatencyTable({ offers: r.offers, silent: r.silent });
  const L4 = t.leagues['4'];
  assert.equal(L4.pooled.n_answered, 21);
  assert.equal(L4.pooled.n_expired + Object.values(t.leagues).filter(l => l !== L4).reduce((a, l) => a + l.pooled.n_expired, 0), 7);
});

test('loader: reads the db, lists pending sent offers and unanswered ESPN offers, dedupes the ESPN copy', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE trade_outcomes (league_id INTEGER, season INTEGER, source TEXT, proposer_team_id TEXT, counterparty_team_id TEXT,
    proposed_at TEXT, model_p_accept REAL, status TEXT, espn_tx_id TEXT, idea_id TEXT, resolved_at TEXT, sent_at TEXT, matched_tx_id TEXT);
    CREATE TABLE league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT, type TEXT, execution_type TEXT, team_id INTEGER,
    related_tx_id TEXT, proposed_at TEXT, items_json TEXT);`);
  const items = JSON.stringify([{ fromTeamId: 1, toTeamId: 7 }, { fromTeamId: 7, toTeamId: 1 }]);
  const ins = db.prepare('INSERT INTO league_transactions_raw VALUES (?, 2026, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(4, 'a', 'TRADE_PROPOSAL', 'EXECUTE', 1, null, at(0), items);
  ins.run(4, 'b', 'TRADE_DECLINE', 'EXECUTE', 7, 'a', at(3), null);
  ins.run(4, 'c', 'TRADE_PROPOSAL', 'EXECUTE', 1, null, at(90), items); // pending, the ESPN copy of the app offer below
  db.prepare(`INSERT INTO trade_outcomes VALUES (4, 2026, 'app_proposed', '1', '7', ?, 0.3, 'proposed', NULL, 'i1', NULL, ?, 'c')`).run(at(89), at(89.5));
  const r = loadReplyLatency(db, { leagueId: 4, now: at(100) });
  assert.equal(r.table.leagues['4'].managers['7'].n_answered, 1);
  assert.equal(r.pending.length, 1, 'the app row and its ESPN copy are one pending offer');
  assert.equal(r.pending[0].source, 'app_proposed');
  assert.equal(r.pending[0].hours_waiting, 10.5);
  assert.equal(typeof r.grade.pass, 'boolean');
  assert.equal(REPLY_LATENCY_FLAG, 'GRIDIRON_REPLY_LATENCY');
});
