/**
 * FIX-289-4 (JEV-01b, ENGINE-SPECS): grade the engine's stored jev.* answers against
 * their settled truths and write producer 'jev_grader' fields. Rules: prereg addendum 2,
 * docs/evidence/2026-09-24/jev-01b-chat-preregistration-addendum-2.md.
 *
 * JEV-01a (#248) is not merged, so this test registers producer 'jev' itself with the
 * field names #248 declares (jev.<qtype>.jev_<arm>), and producer 'calendar' for the
 * nfl.week rows (calendar.js is not imported here, so the name is free in this process).
 * Guarantees:
 *   - leak: no outcome stamped at or before the answer is used, and no unit is graded
 *     before it settles (an offer still open, a week not final);
 *   - one unit per subject and arm: the last answer before the outcome (offer) or before
 *     the week's first kickoff (plays Sunday);
 *   - every write is typed: a thin question is null with absence 'thin', a question with
 *     no incumbent has jev_weight null with absence 'no_incumbent'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-jev01b-grader-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const registry = await import('../server/services/engine/registry.js');
const { writeState, getState } = await import('../server/services/engine/state.js');
const grader = await import('../server/services/jev/grader.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const clamp = p => Math.min(0.97, Math.max(0.03, p));
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// ------------------------------------------------------------ writers for the fixture
const JEV = registry.registerProducer({ name: 'jev', active: '1-ops', versions: { '1-ops': {}, '1-shadow': {} }, shadow: ['1-shadow'],
  fields: ['jev.p_accept.jev_a', 'jev.p_accept.jev_b', 'jev.plays_sunday.jev_a', 'jev.plays_sunday.jev_b']
    .map(field => ({ field, entityTypes: ['offer', 'player'] })) });
const CAL = registry.registerProducer({ name: 'calendar', active: 'ea02-1', versions: { 'ea02-1': {} },
  fields: [{ field: 'nfl.week', entityTypes: ['week'] }] });

function answer(field, entityType, entityId, at, p, version = 1) {
  const r = writeState({ entityType, entityId: String(entityId), field, value: { p, weight: 0, lane: 'shadow', question_version: version },
    asOf: iso(at), writer: JEV[field], producerVersion: '1-shadow', reasonChain: { contributions: [] } });
  return r.id;
}
function week(season, w, first, last, status, at) {
  writeState({ entityType: 'week', entityId: `${season}:${w}`, field: 'nfl.week', asOf: iso(at), writer: CAL['nfl.week'],
    producerVersion: 'ea02-1', value: { season, week: w, first_kickoff: iso(first), last_kickoff: iso(last), status },
    reasonChain: { contributions: [] } });
}

// ------------------------------------------------------------ p_accept fixture
const T0 = Date.parse('2026-09-01T12:00:00Z');
const GRADE_AT = Date.parse('2026-09-23T12:00:00Z');
const r = rng(7);
const offers = []; // { id, y, t, resolved }
function offer({ status, proposedAt, resolvedAt, team, pModel = 0.4 }) {
  run(`INSERT INTO trade_outcomes (league_id, season, source, counterparty_team_id, proposed_at, model_p_accept,
         model_p_accept_low, model_p_accept_high, model_basis, status, resolved_at, created_at)
       VALUES (4, 2026, 'app_proposed', ?, ?, ?, ?, ?, 'heuristic_unanchored', ?, ?, ?)`,
  String(team), iso(proposedAt), pModel, Math.max(0, pModel - 0.1), Math.min(1, pModel + 0.1), status,
  resolvedAt == null ? null : iso(resolvedAt), iso(proposedAt));
  return Number(rows('SELECT last_insert_rowid() AS id')[0].id);
}
for (let i = 0; i < 100; i++) {
  const t = T0 + i * 3 * 3600000;
  const y = r() < 0.4 ? 1 : 0;
  const id = offer({ status: y ? 'accepted' : 'declined', proposedAt: t, resolvedAt: t + 2 * DAY, team: 1 + (i % 6) });
  // An early, uninformed answer, then the one graded: the last before the outcome.
  answer('jev.p_accept.jev_a', 'offer', id, t - 3600000, 0.5);
  answer('jev.p_accept.jev_a', 'offer', id, t, clamp(0.4 + (y ? 0.3 : -0.2) + (r() - 0.5) * 0.2));
  answer('jev.p_accept.jev_b', 'offer', id, t, clamp(0.4 + (y ? 0.2 : -0.1) + (r() - 0.5) * 0.3));
  offers.push({ id, y, t });
}
// Leak: an answer stamped after the offer resolved is never graded (the earlier one is).
const LATE = offer({ status: 'accepted', proposedAt: T0, resolvedAt: T0 + DAY, team: 2 });
answer('jev.p_accept.jev_a', 'offer', LATE, T0 + 2 * DAY, 0.99);
// Unsettled: still open, and resolved only after the grade time.
const OPEN = offer({ status: 'proposed', proposedAt: T0, resolvedAt: null, team: 3 });
answer('jev.p_accept.jev_a', 'offer', OPEN, T0, 0.7);
const AFTER = offer({ status: 'declined', proposedAt: T0, resolvedAt: GRADE_AT + DAY, team: 4 });
answer('jev.p_accept.jev_a', 'offer', AFTER, T0, 0.7);
// An answer about an offer the ledger does not hold.
answer('jev.p_accept.jev_a', 'offer', 99999, T0, 0.7);
// An older question version is never pooled with v2... here v1 is the latest, so a v0 is "older".
answer('jev.p_accept.jev_b', 'offer', offers[0].id, offers[0].t - 60000, 0.5, 0);

// ------------------------------------------------------------ plays_sunday fixture
// Week 3 is final; week 4 has started but is not final.
const W3 = Date.parse('2026-09-17T23:15:00Z'), W3_LAST = Date.parse('2026-09-22T00:15:00Z');
const W4 = Date.parse('2026-09-24T23:15:00Z'), W4_LAST = Date.parse('2026-09-29T00:15:00Z');
week(2026, 3, W3, W3_LAST, 'final', W3_LAST + 6 * 3600000);
week(2026, 4, W4, W4_LAST, 'upcoming', W3_LAST + 6 * 3600000);
const PLAYERS = [['Ada Runner', 1], ['Bo Catcher', 0], ['Cy Thrower', 1]];
PLAYERS.forEach(([name], i) => run(`INSERT INTO players (id, name, position) VALUES (?, ?, 'WR')`, 700 + i, name));
run(`INSERT INTO nfl_snaps (season, week, player, team, position, offense_snaps, offense_pct, defense_snaps, defense_pct, st_pct)
     VALUES (2026, 3, 'Ada Runner', 'AAA', 'WR', 40, 0.6, 0, 0, 0), (2026, 3, 'Cy Thrower', 'CCC', 'WR', 0, 0, 0, 0, 0.2),
            (2026, 3, 'Dee Other', 'DDD', 'WR', 10, 0.1, 0, 0, 0)`);
answer('jev.plays_sunday.jev_a', 'player', 700, W3 - DAY, 0.9);
answer('jev.plays_sunday.jev_a', 'player', 701, W3 - DAY, 0.3);
answer('jev.plays_sunday.jev_b', 'player', 701, W3 - DAY, 0.4);
answer('jev.plays_sunday.jev_a', 'player', 702, W3 - 2 * DAY, 0.8);
answer('jev.plays_sunday.jev_a', 'player', 702, W3 + DAY, 0.95); // after TNF: excluded, the earlier one stands
answer('jev.plays_sunday.jev_a', 'player', 700, W4 - DAY, 0.9); // week 4: not final

test('p_accept: one unit per offer and arm, the last answer before the outcome, leaks and open offers excluded', () => {
  const g = grader.gradeJevAnswers({ asOf: GRADE_AT });
  const q = g.questions.p_accept;
  assert.equal(q.units, offers.length, 'one mean-claim unit per settled offer');
  assert.equal(q.arms.jev_a.n, offers.length);
  assert.equal(q.arms.jev_b.n, offers.length);
  assert.equal(q.excluded.outcome_before_answer, 1);
  assert.equal(q.excluded.unsettled, 2);
  assert.equal(q.excluded.unknown_offer, 1);
  assert.equal(q.excluded.older_version, 1);
  const byId = new Map(q.graded.map(u => [u.subject, u]));
  assert.ok(!byId.has(String(LATE)) && !byId.has(String(OPEN)) && !byId.has(String(AFTER)));
  for (const o of offers) {
    const u = byId.get(String(o.id));
    assert.equal(u.y, o.y);
    assert.ok(u.t === o.t, 'graded on the last answer before the outcome, not the early one');
    assert.equal(u.inc, 0.4, "the incumbent is the ledger's model_p_accept");
  }
  assert.equal(q.arms.jev_a.status, 'measured');
  assert.equal(q.blend.status, 'measured');
  assert.ok(q.blend.weight >= 0 && q.blend.weight <= 1);
  assert.ok(['jev', 'incumbent', 'undecided'].includes(q.blend.leader));
});

test('the leak test: before any offer settles, nothing is graded', () => {
  const g = grader.gradeJevAnswers({ asOf: T0 + DAY / 2 });
  assert.equal(g.questions.p_accept.units, 0);
  assert.deepEqual(g.questions.p_accept.blend, { status: 'unknown', reason: 'thin', n: 0 });
  // An answer stamped after the grade time is not even read.
  const early = grader.gradeJevAnswers({ asOf: T0 - 2 * 3600000 });
  assert.equal(early.questions.p_accept.read, 0);
});

test('plays_sunday: settled on a final week, the answer before the first kickoff, snaps as truth', () => {
  const g = grader.gradeJevAnswers({ asOf: GRADE_AT });
  const q = g.questions.plays_sunday;
  const got = q.graded.map(u => [u.subject, u.week, u.y, +u.claim.toFixed(2)]).sort();
  assert.deepEqual(got, [['700', '2026:3', 1, 0.9], ['701', '2026:3', 0, 0.35], ['702', '2026:3', 1, 0.8]]);
  assert.equal(q.excluded.asked_after_kickoff, 1);
  assert.equal(q.excluded.unsettled, 1, 'week 4 is not final');
  assert.deepEqual(q.arms.jev_a, { status: 'unknown', reason: 'thin', n: 3 });
  assert.deepEqual(q.blend, { status: 'unknown', reason: 'no_incumbent', n: 3 });
});

test("writeJevGrades writes producer 'jev_grader' fields, typed, citing the answers", () => {
  const g = grader.gradeJevAnswers({ asOf: GRADE_AT });
  const out = grader.writeJevGrades(g);
  assert.ok(out.written >= 8);
  const read = f => getState('engine', 'jev', f, { asOf: iso(GRADE_AT) });
  const cal = read('jev_cal.p_accept.jev_a');
  assert.equal(cal.producer, 'jev_grader');
  assert.ok(['platt', 'isotonic'].includes(cal.value.kind));
  assert.equal(cal.value.n, offers.length);
  assert.ok(cal.reason_chain.contributions[0].state_ids.length === offers.length, 'cites every graded answer row');
  const w = read('jev_weight.p_accept');
  assert.equal(typeof w.value, 'number');
  const score = read('jev_score.p_accept');
  assert.equal(score.value.n, offers.length);
  assert.ok(Number.isFinite(score.value.holdout.log_loss_blend));
  const thin = read('jev_cal.plays_sunday.jev_a');
  assert.equal(thin.value, null);
  assert.deepEqual(thin.health.absence, { status: 'unknown', reason: 'thin' });
  const noInc = read('jev_weight.plays_sunday');
  assert.equal(noInc.value, null);
  assert.deepEqual(noInc.health.absence, { status: 'unknown', reason: 'no_incumbent' });
  const alone = read('jev_score.plays_sunday');
  assert.equal(alone.value.incumbent, 'none');
  assert.equal(alone.value.n, 3);
  // The registry owns these fields for jev_grader; nobody else may claim one.
  assert.throws(() => registry.registerField('jev_weight.p_accept', { producer: 'jev', version: '1-ops' }), /one producer jev_grader/);
});
