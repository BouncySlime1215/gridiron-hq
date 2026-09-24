/**
 * BANDIT-01 (IDEA-037, M5): Thompson sampling over pitch framings, per manager.
 *
 * Four framing arms (need-based, value-based, face-saving, urgency). Each
 * manager's posterior per arm is a Beta whose prior is shared across the
 * league: the other managers' graded replies on that arm, capped at
 * PRIOR_STRENGTH pseudo-offers, on top of Beta(1, 1). The evidence is
 * `trade_outcomes` rows Nick actually sent (`sent_at`, #239), that carry an arm
 * in `pitch_json` (migration 087), and that ESPN has answered.
 *
 * Gates, pre-registered in docs/tdd/pitch-bandit.tdd.md:
 *  B1 empty ledger: "learning, n=0", every arm Beta(1, 1), no number invented.
 *  B2 flag off: the War Room section is 'unknown' with a reason, and no arm is
 *     suggested; flag on: 'ok', preview-labelled, an arm suggested.
 *  B3 only sent + answered + armed rows count; accepted = 1, declined and
 *     expired = 0, countered = COUNTER_REWARD. Pending, unsent, unarmed,
 *     observed and considered_only rows do not count.
 *  B4 the shared prior: other managers' replies move this manager's prior,
 *     capped at PRIOR_STRENGTH, and never his own replies twice.
 *  B5 per-manager posterior: his own declines pull his arm below another
 *     manager's same arm.
 *  B6 Thompson: seeded and repeatable; a dominant arm wins nearly always; at
 *     n=0 every arm is explored.
 *  B7 recordPitchArm refuses an unknown arm, an unsent row, and a second arm.
 *  B8 the War Room section validates against the plans contract.
 *  B9 migration 087 is additive and idempotent.
 *  B10 the Beta sampler's mean is right.
 *
 * Every team and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pitch-bandit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const bandit = await import('../server/services/pitch-bandit.js');
const { PITCH_ARMS, PRIOR_STRENGTH, COUNTER_REWARD, recordPitchArm, pitchCounts, posteriorFor,
  thompsonPick, sampleBeta, seededRng, pitchBandit, pitchBanditSection } = bandit;
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
let seq = 0;
/** One trade_outcomes row; `arm` null leaves pitch_json empty. */
function offer(league, counterparty, { arm = 'need_based', status = 'declined', sent = true,
  source = 'app_proposed' } = {}) {
  seq += 1;
  const settled = status !== 'proposed' && status !== 'not_proposed';
  const info = run(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
     proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, status,
     not_proposed_reason, espn_tx_id, idea_id, resolved_at, created_at, sent_at)
    VALUES (?, ?, ?, '1', ?, '[]', '[]', '2026-10-01T12:00:00Z', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T12:00:00Z', ?)`,
  league, SEASON, source, String(counterparty),
  source === 'observed' ? null : 0.4, source === 'observed' ? null : 0.2, source === 'observed' ? null : 0.6,
  source === 'observed' ? null : 'heuristic_unanchored',
  status, status === 'not_proposed' ? 'filtered' : null,
  source === 'observed' ? `tx-${seq}` : null, `idea-${seq}`,
  settled ? '2026-10-02T12:00:00Z' : null, sent ? '2026-10-01T12:05:00Z' : null);
  const id = Number(info.lastInsertRowid);
  if (arm) run(`UPDATE trade_outcomes SET pitch_json = ? WHERE id = ?`,
    JSON.stringify({ v: 1, arm, chosen_by: 'test' }), id);
  return id;
}

function withPreview(on, fn) {
  const was = process.env[PREVIEW_ENV];
  if (on) process.env[PREVIEW_ENV] = '1'; else delete process.env[PREVIEW_ENV];
  try { return fn(); } finally {
    if (was === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = was;
  }
}

/* -------------------------------------------------------------- B1 / B2 */

test('B1: an empty ledger is "learning, n=0" with flat Beta(1,1) arms and no invented rate', () => {
  const b = withPreview(true, () => pitchBandit(901, SEASON, { teamId: '2', rng: seededRng(1) }));
  assert.equal(b.n, 0);
  assert.equal(b.label, 'learning, n=0');
  assert.deepEqual(b.arms.map(a => a.arm), [...PITCH_ARMS]);
  for (const a of b.arms) {
    assert.equal(a.alpha, 1); assert.equal(a.beta, 1); assert.equal(a.n, 0);
    assert.equal(a.mean, null, 'no reply, no rate: a flat prior is not a 50% measurement');
  }
});

test('B2: flag off -> unknown with a reason and no arm; flag on -> ok, preview-labelled, an arm', () => {
  const off = withPreview(false, () => pitchBanditSection(902, SEASON, { rng: seededRng(1) }));
  assert.equal(off.status, 'unknown');
  assert.match(off.reason, /preview/i);
  assert.equal('value' in off, false);
  const offOne = withPreview(false, () => pitchBandit(902, SEASON, { teamId: '2', rng: seededRng(1) }));
  assert.equal(offOne.enabled, false);
  assert.equal(offOne.suggested_arm, null);

  const on = withPreview(true, () => pitchBanditSection(902, SEASON, { rng: seededRng(1) }));
  assert.equal(on.status, 'ok');
  assert.equal(on.value.label, 'learning, n=0');
  assert.equal(on.value.preview, true);
  const onOne = withPreview(true, () => pitchBandit(902, SEASON, { teamId: '2', rng: seededRng(1) }));
  assert.equal(onOne.enabled, true);
  assert.ok(PITCH_ARMS.includes(onOne.suggested_arm));
});

/* ------------------------------------------------------------------ B3 */

test('B3: only sent, answered, armed offers count, with the pre-registered rewards', () => {
  const L = 903;
  offer(L, 2, { arm: 'urgency', status: 'accepted' });
  offer(L, 2, { arm: 'urgency', status: 'declined' });
  offer(L, 2, { arm: 'urgency', status: 'expired' });
  offer(L, 2, { arm: 'urgency', status: 'countered' });
  // None of these may count.
  offer(L, 2, { arm: 'urgency', status: 'proposed' });            // no answer yet
  offer(L, 2, { arm: 'urgency', status: 'accepted', sent: false }); // suggested, never sent
  offer(L, 2, { arm: null, status: 'accepted' });                  // sent with no arm
  offer(L, 2, { arm: 'urgency', status: 'accepted', source: 'observed', sent: false });
  offer(L, 2, { arm: 'urgency', status: 'not_proposed', source: 'considered_only', sent: false });

  const c = pitchCounts(L, SEASON);
  const u = c.byManager.get('2').urgency;
  assert.equal(u.n, 4);
  assert.equal(u.s, 1 + COUNTER_REWARD);
  assert.equal(c.n, 4);
  assert.equal(c.excluded.pending, 1);
  assert.equal(c.excluded.unarmed, 1);
});

/* -------------------------------------------------------------- B4 / B5 */

test('B4: other managers move the shared prior, capped at PRIOR_STRENGTH, never counting him twice', () => {
  const L = 904;
  for (let i = 0; i < 5; i++) offer(L, 3, { arm: 'value_based', status: 'accepted' });
  for (let i = 0; i < 5; i++) offer(L, 3, { arm: 'face_saving', status: 'declined' });
  for (let i = 0; i < 100; i++) offer(L, 4, { arm: 'urgency', status: 'accepted' });

  const post = posteriorFor(pitchCounts(L, SEASON), '2');
  const mean = a => post[a].alpha / (post[a].alpha + post[a].beta);
  assert.ok(mean('value_based') > 0.5 && mean('value_based') < 1, 'others said yes: prior leans yes');
  assert.ok(mean('face_saving') < 0.5, 'others said no: prior leans no');
  assert.equal(mean('need_based'), 0.5, 'no evidence anywhere: flat');
  const u = post.urgency;
  assert.ok(u.prior_alpha + u.prior_beta <= 2 + PRIOR_STRENGTH + 1e-9, 'a hundred replies elsewhere are still a prior, not his answer');
  assert.equal(u.n, 0, 'he himself has never seen urgency');

  // Manager 3's prior on value_based excludes his own five accepts.
  const own = posteriorFor(pitchCounts(L, SEASON), '3').value_based;
  assert.equal(own.prior_alpha, 1); assert.equal(own.prior_beta, 1);
  assert.equal(own.alpha, 6); assert.equal(own.beta, 1);
});

test('B5: his own declines pull his arm below another manager on the same arm', () => {
  const L = 905;
  for (let i = 0; i < 3; i++) offer(L, 5, { arm: 'need_based', status: 'accepted' });
  for (let i = 0; i < 3; i++) offer(L, 6, { arm: 'need_based', status: 'declined' });
  const c = pitchCounts(L, SEASON);
  const m = p => p.need_based.alpha / (p.need_based.alpha + p.need_based.beta);
  assert.ok(m(posteriorFor(c, '6')) < m(posteriorFor(c, '7')), 'his three declines vs a manager with none');
  assert.ok(m(posteriorFor(c, '5')) > m(posteriorFor(c, '7')));
});

/* ------------------------------------------------------------------ B6 */

test('B6: Thompson is seeded, exploits a dominant arm, and explores all arms at n=0', () => {
  const flat = Object.fromEntries(PITCH_ARMS.map(a => [a, { alpha: 1, beta: 1 }]));
  assert.equal(thompsonPick(flat, seededRng(42)).arm, thompsonPick(flat, seededRng(42)).arm);

  const hits = Object.fromEntries(PITCH_ARMS.map(a => [a, 0]));
  for (let s = 1; s <= 400; s++) hits[thompsonPick(flat, seededRng(s)).arm] += 1;
  for (const a of PITCH_ARMS) assert.ok(hits[a] >= 60, `${a} explored ${hits[a]}/400`);

  // Beta(21, 1) against two flat arms and a Beta(1, 21): it wins with
  // P = E[x^2] = 21/23 = 0.913 (the Beta(1, 21) arm is near-zero). 2,000 seeds,
  // SE 0.0063: the band is +-3 SE.
  const skew = { ...flat, urgency: { alpha: 21, beta: 1 }, need_based: { alpha: 1, beta: 21 } };
  let wins = 0;
  for (let s = 1; s <= 2000; s++) if (thompsonPick(skew, seededRng(s)).arm === 'urgency') wins += 1;
  assert.ok(Math.abs(wins / 2000 - 21 / 23) < 0.019, `dominant arm won ${wins}/2000`);
});

/* ------------------------------------------------------------------ B7 */

test('B7: recordPitchArm writes one known arm onto a sent offer, and refuses the rest', () => {
  const L = 907;
  const id = offer(L, 2, { arm: null, status: 'proposed' });
  recordPitchArm(id, 'face_saving', { chosen_by: 'nick' });
  const pj = JSON.parse(row(`SELECT pitch_json FROM trade_outcomes WHERE id = ?`, id).pitch_json);
  assert.equal(pj.arm, 'face_saving');
  assert.equal(pj.chosen_by, 'nick');
  assert.throws(() => recordPitchArm(id, 'urgency'), /already/);
  const other = offer(L, 2, { arm: null, status: 'proposed' });
  assert.throws(() => recordPitchArm(other, 'flattery'), /arm/);
  const unsent = offer(L, 2, { arm: null, status: 'proposed', sent: false });
  assert.throws(() => recordPitchArm(unsent, 'urgency'), /sent/);
  assert.throws(() => recordPitchArm(999999, 'urgency'), /no trade_outcomes row/);
});

/* ------------------------------------------------------------------ B8 */

test('B8: the War Room section validates against the plans contract, on and off', () => {
  offer(908, 2, { arm: 'urgency', status: 'accepted' });
  for (const on of [false, true]) {
    const pitch_bandit = withPreview(on, () => pitchBanditSection(908, SEASON, { rng: seededRng(3) }));
    const r = validateLeague({ league: 908, me: '1', names: {}, error: 'no plan run', pitch_bandit }, '$');
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  }
  const s = withPreview(true, () => pitchBanditSection(908, SEASON, { rng: seededRng(3) }));
  assert.equal(s.value.label, 'learning, n=1');
  assert.equal(s.source, 'pitch.bandit');
});

/* ------------------------------------------------------------------ B9 */

test('B9: migration 087 is additive and idempotent', async () => {
  const m = await import('../server/migrations/087_trade_outcomes_pitch_arm.js');
  const before = rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n;
  m.up(db); m.up(db);
  const cols = rows(`PRAGMA table_info(trade_outcomes)`).map(c => c.name);
  assert.equal(cols.filter(c => c === 'pitch_json').length, 1);
  assert.equal(rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n, before);
});

/* ----------------------------------------------------------------- B10 */

test('B10: the Beta sampler has the right mean and stays in (0, 1)', () => {
  const rng = seededRng(7);
  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    const x = sampleBeta(3, 7, rng);
    assert.ok(x > 0 && x < 1);
    sum += x;
  }
  assert.ok(Math.abs(sum / 4000 - 0.3) < 0.02, `mean ${sum / 4000}`);
  // Shape < 1 takes the boost path.
  let small = 0;
  for (let i = 0; i < 4000; i++) small += sampleBeta(0.5, 0.5, rng);
  assert.ok(Math.abs(small / 4000 - 0.5) < 0.03);
});
