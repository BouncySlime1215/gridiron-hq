/**
 * CLONE-01b b2: manager clones v2 + the veto model.
 *
 * Each manager's clone is a Beta posterior on the logit scale: the population
 * prior (his decided-offer accept rate shrunk to the league pool, plus capped
 * motive and activity offsets), updated by every settled reply to an offer
 * Nick sent, each weighted by how relevant it is to THIS package's price.
 * P(complete) = P(accept) x (1 - P(veto)), veto from vetoRiskFor.
 *
 * Gates (ENGINE-SPECS.md CLONE-01b b2 RED, docs/tdd/clone-01b-b2.tdd.md):
 *  B1 one decline moves THAT manager's P(accept) down for an equal-or-worse
 *     package and leaves other managers unchanged.
 *  B2 zero:['clone','veto'] reproduces today's band byte-for-byte.
 *  B3 n = 0 settled replies equals the population prior.
 *  B4 vetoVotesRequired null gives an inert veto factor with a reason.
 *  B5 flag: off by default, on by GRIDIRON_CLONE_V2=1 or preview mode (labelled).
 *  B6 refreshCloneFits: settled sent offers -> manager_clone_fits, idempotent.
 *  B7 migration 096: manager_clone_fits + trade_outcomes.pitch_json, additive.
 *  B8 an activity term already applied in receptiveness is not counted again.
 *  B9 the follow-up: the cheapest package above a decline's price bound.
 *
 * Every team, player and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-clone-b2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const acc = await import('../server/services/trade-acceptance.js');
const outcomes = await import('../server/services/trade-outcomes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEAGUE = 9101;
const SEASON = 2026;
const pass = { passes: true };
const cp = (over = {}) => ({ counterparty_data: true, accept_rate: 0.3, accept_rate_n: 10,
  receptiveness: 1, perception_informed: false, receptiveness_factors: [], ...over });
const POOL = { p0: 0.3, m: 15 };
const pkg = gain => ({ give: [{ value: 100 + gain }], get: [{ value: 100 }] });
const decline = gain => ({ y: 0, gain_pct: gain, status: 'declined' });

/* ------------------------------------------------------------------- B3 */

test('B3 n=0: the clone is the population prior, and the prior is the shrunk accept rate', () => {
  const prior = acc.clonePrior({ counterparty: cp(), pool: POOL });
  // (0.3*10 + 15*0.3) / (10 + 15) = 0.3: a manager at the pool reads as the pool
  assert.equal(+prior.p.toFixed(6), 0.3);
  const hi = acc.clonePrior({ counterparty: cp({ accept_rate: 0.8 }), pool: POOL });
  assert.equal(+hi.p.toFixed(6), +((0.8 * 10 + 15 * 0.3) / 25).toFixed(6));
  const c = acc.cloneFor({ counterparty: cp(), pool: POOL, fit: null, gainPct: 5 });
  assert.equal(c.p, prior.p);
  assert.equal(c.n, 0);
  assert.match(c.reason, /no settled reply/);
});

/* ------------------------------------------------------------------- B1 */

test('B1 one decline lowers his P(accept) for an equal-or-worse package, not other managers', () => {
  // Before: 3 accepts in 9 decided offers. The decline makes it 3 in 10 on ESPN
  // AND a settled reply; the clone takes it out of the history and applies it once.
  const fit = { replies: [decline(10)], n: 1, k: 0 };
  const before = acc.cloneFor({ counterparty: cp({ accept_rate: 3 / 9, accept_rate_n: 9 }), pool: POOL,
    fit: null, gainPct: 10 });
  const same = acc.cloneFor({ counterparty: cp(), pool: POOL, fit, gainPct: 10 });
  const worse = acc.cloneFor({ counterparty: cp(), pool: POOL, fit, gainPct: 0 });
  const better = acc.cloneFor({ counterparty: cp(), pool: POOL, fit, gainPct: 40 });
  assert.ok(same.p < before.p, `equal package: ${same.p} < ${before.p}`);
  assert.ok(worse.p <= same.p + 1e-12, 'a worse package is refuted at least as much');
  assert.ok(better.p > same.p, 'a clearly better package is refuted less');
  assert.equal(same.price_bound.gain_pct, 10);
  // another manager has no fit row: exactly his prior, untouched by this decline
  const other = acc.cloneFor({ counterparty: cp({ accept_rate: 0.5 }), pool: POOL, fit: null, gainPct: 10 });
  assert.equal(other.p, acc.clonePrior({ counterparty: cp({ accept_rate: 0.5 }), pool: POOL }).p);
});

test('B1b an accept raises P(accept) for an equal-or-better package', () => {
  const fit = { replies: [{ y: 1, gain_pct: 5, status: 'accepted' }], n: 1, k: 1 };
  const before = acc.cloneFor({ counterparty: cp({ accept_rate: 3 / 9, accept_rate_n: 9 }), pool: POOL,
    fit: null, gainPct: 5 });
  const after = acc.cloneFor({ counterparty: cp({ accept_rate: 0.4 }), pool: POOL, fit, gainPct: 5 });
  assert.ok(after.p > before.p);
});

test('B1c settled replies already inside his ESPN accept rate are not counted twice', () => {
  // 1 decline of his 10 decided offers was an app-sent offer: the prior uses the other 9
  const fit = { replies: [decline(10)], n: 1, k: 0 };
  const c = acc.cloneFor({ counterparty: cp(), pool: POOL, fit, gainPct: 10 });
  assert.equal(c.history_n, 9);
});

/* ------------------------------------------------------------------- B2 */

test('B2 zero:[clone, veto] reproduces the band byte-for-byte', () => {
  const counterparty = cp({ receptiveness: 1.1 });
  const base = acc.acceptanceBand({ counterparty, edge: pass });
  const clone = acc.cloneFor({ counterparty, pool: POOL, fit: { replies: [decline(0)], n: 1, k: 0 }, gainPct: 0 });
  const veto = acc.vetoFactor({ votes_required: 4, other_owners: 8, level: 'high', n: 1, veto_reachable: true });
  const zeroed = acc.acceptanceBand({ counterparty, edge: pass, clone, veto, zero: ['clone', 'veto'] });
  assert.equal(JSON.stringify(zeroed), JSON.stringify(base));
  // and with nothing passed (the flag off), also identical
  assert.equal(JSON.stringify(acc.acceptanceBand({ counterparty, edge: pass, clone: null, veto: null })),
    JSON.stringify(base));
});

test('B2b on: the clone moves the centre as a capped, named factor', () => {
  // 1 accept in 10 decided offers, 2 of them declines of offers Nick sent
  const counterparty = cp({ accept_rate: 0.1 });
  const base = acc.acceptanceBand({ counterparty, edge: pass });
  const clone = acc.cloneFor({ counterparty, pool: POOL, fit: { replies: [decline(0), decline(0)], n: 2, k: 0 }, gainPct: 0 });
  const on = acc.acceptanceBand({ counterparty, edge: pass, clone });
  const f = on.factors.find(x => x.source === 'clone');
  assert.ok(f, 'clone factor present');
  // the clone replaces the raw 10% centre: shrunk up toward the 30% pool
  assert.equal(f.effect, +(clone.p - 0.1).toFixed(3));
  assert.ok(Math.abs(f.effect) <= acc.ACCEPTANCE_SOURCES.clone.cap);
  assert.equal(on.band.mid, +(base.band.mid + f.effect).toFixed(3));
  assert.equal(on.clone.p, clone.p);
});

/* ------------------------------------------------------------------- B4 */

test('B4 vetoVotesRequired null: veto inert with a reason; else P(complete) = P(accept)(1 - P(veto))', () => {
  const inert = acc.vetoFactor({ votes_required: null, other_owners: 8, level: 'unknown', n: 0 });
  assert.equal(inert.p_veto, null);
  assert.match(inert.reason, /vetoVotesRequired/);
  const b0 = acc.acceptanceBand({ counterparty: cp(), edge: pass, veto: inert });
  assert.equal(b0.completion.band, null);
  assert.match(b0.completion.reason, /vetoVotesRequired/);

  const v = acc.vetoFactor({ votes_required: 4, other_owners: 8, level: 'high', n: 1, veto_reachable: true });
  assert.ok(v.p_veto > 0 && v.p_veto <= acc.ACCEPTANCE_SOURCES.veto.cap);
  assert.equal(v.fitted, false);
  const b = acc.acceptanceBand({ counterparty: cp(), edge: pass, veto: v });
  assert.equal(b.completion.band.mid, +(b.band.mid * (1 - v.p_veto)).toFixed(3));
  assert.equal(b.completion.fitted, false);

  const none = acc.vetoFactor({ votes_required: 9, other_owners: 8, level: 'unknown', n: 0, veto_reachable: false });
  assert.equal(none.p_veto, 0);
});

/* ------------------------------------------------------------------- B5 */

test('B5 flag: off by default; site flag or preview turns it on, preview labelled', () => {
  const save = { c: process.env.GRIDIRON_CLONE_V2, p: process.env.GRIDIRON_PREVIEW_UNCONFIRMED };
  try {
    delete process.env.GRIDIRON_CLONE_V2; delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    assert.deepEqual(acc.cloneMode(), { on: false, preview: false });
    process.env.GRIDIRON_CLONE_V2 = '1';
    assert.deepEqual(acc.cloneMode(), { on: true, preview: false });
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    assert.deepEqual(acc.cloneMode(), { on: true, preview: false }, 'the site flag wins: not a preview');
    delete process.env.GRIDIRON_CLONE_V2;
    assert.deepEqual(acc.cloneMode(), { on: true, preview: true });
    const c = acc.cloneFor({ counterparty: cp(), pool: POOL, fit: null, gainPct: 0, preview: true });
    assert.equal(c.preview, true);
    assert.match(c.why, /^Preview \(unconfirmed forward\)/);
  } finally {
    for (const [k, v] of [['GRIDIRON_CLONE_V2', save.c], ['GRIDIRON_PREVIEW_UNCONFIRMED', save.p]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/* ------------------------------------------------------------------- B7 */

test('B7 migration 096: manager_clone_fits and trade_outcomes.pitch_json exist', () => {
  const cols = rows('PRAGMA table_info(manager_clone_fits)').map(c => c.name);
  for (const c of ['league_id', 'season', 'roster_id', 'coef_json', 'n', 'k', 'fit_stamp']) assert.ok(cols.includes(c), c);
  assert.ok(rows('PRAGMA table_info(trade_outcomes)').some(c => c.name === 'pitch_json'));
});

/* ------------------------------------------------------------------- B6 */

test('B6 refreshCloneFits writes settled replies per manager, idempotently', () => {
  const now = '2026-10-01T00:00:00.000Z';
  const ins = (cpId, status, giveV, getV) => run(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json, proposed_at,
     model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status,
     resolved_at, created_at, sent_at)
    VALUES (?, ?, 'app_proposed', '1', ?, ?, ?, ?, 0.3, 0.1, 0.5, 'heuristic_anchored', 't', ?, ?, ?, ?)`,
  LEAGUE, SEASON, cpId, JSON.stringify([{ value: giveV }]), JSON.stringify([{ value: getV }]),
  now, status, status === 'proposed' ? null : now, now, now);
  ins('7', 'declined', 110, 100);
  ins('7', 'accepted', 130, 100);
  ins('7', 'expired', 100, 100);   // not a decision
  ins('8', 'proposed', 100, 100);  // not settled
  const r1 = outcomes.refreshCloneFits(LEAGUE, SEASON);
  const r2 = outcomes.refreshCloneFits(LEAGUE, SEASON);
  assert.equal(r1.managers, 1);
  assert.deepEqual(r2.managers, r1.managers);
  const fits = outcomes.cloneFitsFor(LEAGUE, SEASON);
  const f = fits.get('7');
  assert.equal(f.n, 2);
  assert.equal(f.k, 1);
  assert.deepEqual(f.replies.map(x => [x.y, x.gain_pct]), [[0, 10], [1, 30]]);
  assert.equal(fits.has('8'), false);
  assert.equal(rows('SELECT * FROM manager_clone_fits WHERE league_id = ?', LEAGUE).length, 1);
});

test('B6b settleOfferLoop refreshes the clone fits after it settles', () => {
  const out = outcomes.settleOfferLoop(LEAGUE, SEASON, { now: '2026-10-02T00:00:00.000Z' });
  assert.ok(out.clones, 'settleOfferLoop reports the clone refresh');
});

/* ------------------------------------------------------------------- B8 */

test('B8 an activity term already applied in receptiveness is not added to the clone again', () => {
  const applied = cp({ receptiveness_factors: [{ source: 'trade_activity', effect: 0.2 }] });
  const withheld = cp({ receptiveness_factors: [{ source: 'trade_activity', effect: null, would_effect: 0.2 }] });
  const a = acc.clonePrior({ counterparty: applied, pool: POOL });
  const w = acc.clonePrior({ counterparty: withheld, pool: POOL });
  assert.equal(a.offsets.find(o => o.source === 'activity').logit, null);
  assert.match(a.offsets.find(o => o.source === 'activity').reason, /already/);
  assert.ok(w.offsets.find(o => o.source === 'activity').logit > 0);
  assert.ok(w.p > a.p);
});

test('B8b motive: a state moves the prior by a capped offset; no state is inert with its reason', () => {
  const m = acc.clonePrior({ counterparty: cp({ motive: { state: 'desperate_buyer' } }), pool: POOL });
  const none = acc.clonePrior({ counterparty: cp({ motive: { state: null, reason: 'no sim' } }), pool: POOL });
  const o = m.offsets.find(x => x.source === 'motive');
  assert.ok(o.logit > 0 && o.logit <= acc.CLONE_OFFSET_CAP);
  assert.equal(none.offsets.find(x => x.source === 'motive').logit, null);
  assert.match(none.offsets.find(x => x.source === 'motive').reason, /no sim/);
});

/* ------------------------------------------------------------------- B9 */

test('B9 the follow-up is the cheapest package above the decline bound', () => {
  const pick = acc.cheapestAbove([{ id: 'a', gain_pct: 5 }, { id: 'e', gain_pct: 10 }, { id: 'b', gain_pct: 25 },
    { id: 'c', gain_pct: 15 }], 10);
  assert.equal(pick.id, 'c');
  assert.equal(acc.cheapestAbove([{ id: 'a', gain_pct: 5 }], 10), null);
  assert.equal(acc.packageGainPct(pkg(10).give, pkg(10).get), 10);
  assert.equal(acc.packageGainPct([{ value: null }], [{ value: 100 }]), null);
});

/* ------------------------------------------------------------------ B10 */

test('B10 call site: off gives no clone context; on, each deal reads ITS partner fit and the veto', async () => {
  const eng = await import('../server/services/trade-engine.js');
  const save = { c: process.env.GRIDIRON_CLONE_V2, p: process.env.GRIDIRON_PREVIEW_UNCONFIRMED };
  try {
    delete process.env.GRIDIRON_CLONE_V2; delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    const cps = new Map([['7', cp()], ['8', cp({ accept_rate: 0.5 })]]);
    assert.equal(eng.cloneContext({ id: LEAGUE }, cps, SEASON), null);
    process.env.GRIDIRON_CLONE_V2 = '1';
    const ctx = eng.cloneContext({ id: LEAGUE }, cps, SEASON);
    assert.equal(ctx.fits.get('7').n, 2, 'reads manager_clone_fits written in B6');
    assert.equal(+ctx.pool.p0.toFixed(3), 0.4);
    const deal = partner => ({ partner_id: partner, their_value_pct: 30, counterparty: {},
      i_give: [{ value: 110 }], i_get: [{ value: 100 }] });
    const climate = { votes_required: 4, other_owners: 8, n: 1, reference_n: 1, reference_skew_pct: 18, observed_max_votes: 4 };
    const seven = eng.cloneInputs(ctx, cps.get('7'), deal(7), climate);
    const eight = eng.cloneInputs(ctx, cps.get('8'), deal(8), climate);
    assert.equal(seven.clone.n, 2);
    assert.equal(seven.clone.gain_pct, 10);
    assert.equal(eight.clone.n, 0);
    assert.equal(seven.veto.level, 'high');
    assert.equal(eng.cloneInputs(ctx, cps.get('7'), deal(7), null).veto.p_veto, null);
    // follow-up: cheapest shown package above the bound (10%) is marked
    const shown = [15, 12, 30].map(g => ({ partner_id: 7, acceptance: { clone: { gain_pct: g, price_bound: { gain_pct: 10 } } } }));
    eng.markCloneFollowUps(shown);
    assert.deepEqual(shown.map(d => !!d.acceptance.clone.follow_up), [false, true, false]);
  } finally {
    for (const [k, v] of [['GRIDIRON_CLONE_V2', save.c], ['GRIDIRON_PREVIEW_UNCONFIRMED', save.p]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});
