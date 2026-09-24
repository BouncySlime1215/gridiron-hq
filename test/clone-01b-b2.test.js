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
 *  (PR sweep fixes, FIX-288-6) B1d a counter is not subtracted from the ESPN history.
 *  (PR sweep fixes, FIX-288-2..5)
 *  B11 every "I sent this" writes pitch_json: screen fairness, 2-for-1 vs
 *      1-for-1, lead need, and the ONE factor varied; accept rate by arm is
 *      labelled 'no claim before the prereg n'.
 *  B12 playerValuation gains a 'clone' source inside PLAYER_VALUATION_CAP;
 *      zero:['clone'] (and the flag off) reproduce today's valuation byte-for-byte.
 *  B12c the declines are charged once in the band when both clone terms are on.
 *  B13 settled-reply pricing reads the offer's terms from
 *      trade_proposal_snapshots first, then the raw row, and counts the share.
 *  B14 the E1 grade reads terms snapshot-first and prints the share with terms.
 *  B15 the TradeCard follow-up chip renders only when clone.follow_up is set.
 *
 * Every team, player and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

test('B1d a counter is not in his ESPN accept rate, so it is not taken out of the history', () => {
  // manager-signals counts only his TRADE_ACCEPT / TRADE_DECLINE rows; a counter is his own proposal
  const fit = { replies: [decline(10), { y: 0, gain_pct: 5, status: 'countered' }], n: 2, k: 0 };
  const c = acc.cloneFor({ counterparty: cp(), pool: POOL, fit, gainPct: 10 });
  assert.equal(c.history_n, 9, 'only the decline is subtracted');
  assert.equal(c.n, 2, 'the counter still updates the clone as a no');
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

/* ------------------------------------------------------------------ B11 */

const sentDeal = (partner, over = {}) => ({
  partner_id: String(partner), their_value_pct: 2, their_needs: ['WR'],
  i_give: [{ id: 1, espn_id: 11, position: 'WR', value: 100 }],
  i_get: [{ id: 2, espn_id: 22, position: 'RB', value: 100 }],
  acceptance: { band: { low: 0.2, mid: 0.35, high: 0.5 }, basis: 'heuristic_anchored' }, ...over });

test('B11 pitch arm: the control arm, one factor varied, two factors, and an unread factor', () => {
  const control = outcomes.pitchArmOf(sentDeal(7));
  assert.deepEqual([control.fairness, control.shape, control.lead_need, control.varied],
    ['fair', '1-for-1', true, 'control']);
  const twoForOne = outcomes.pitchArmOf(sentDeal(7, { i_give: [{ position: 'WR' }, { position: 'TE' }] }));
  assert.equal(twoForOne.shape, '2-for-1');
  assert.equal(twoForOne.varied, 'shape');
  assert.equal(outcomes.pitchArmOf(sentDeal(7, { their_value_pct: 12 })).varied, 'fairness');
  assert.equal(outcomes.pitchArmOf(sentDeal(7, { their_value_pct: -9 })).fairness, 'short');
  assert.equal(outcomes.pitchArmOf(sentDeal(7, { their_needs: ['QB'] })).varied, 'lead_need');
  assert.equal(outcomes.pitchArmOf(sentDeal(7, { their_value_pct: 12, their_needs: ['QB'] })).varied, 'multiple');
  const unread = outcomes.pitchArmOf(sentDeal(7, { their_needs: undefined }));
  assert.equal(unread.varied, 'unknown', 'an arm with an unread factor is never the control');
  assert.match(unread.reason, /needs/);
});

test('B11b every "I sent this" writes pitch_json; accept rate by arm says no claim before the prereg n', () => {
  const L = 9111;
  const a = outcomes.recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1',
    deal: sentDeal(7), model_version: 't', sent_at: '2026-10-01T00:00:00.000Z' });
  const b = outcomes.recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1',
    deal: sentDeal(8, { their_value_pct: 12 }), model_version: 't', sent_at: '2026-10-01T00:00:00.000Z' });
  const arm = id => JSON.parse(rows('SELECT pitch_json FROM trade_outcomes WHERE id = ?', id)[0].pitch_json);
  assert.equal(arm(a.id).varied, 'control');
  assert.equal(arm(b.id).varied, 'fairness');
  run(`UPDATE trade_outcomes SET status = 'accepted' WHERE id = ?`, a.id);
  run(`UPDATE trade_outcomes SET status = 'declined' WHERE id = ?`, b.id);
  const r = outcomes.pitchArmRates(L, SEASON);
  assert.equal(r.settled, 2);
  assert.match(r.label, /no claim before the prereg n/);
  assert.deepEqual(r.arms.map(x => [x.arm, x.n, x.k]), [['control', 1, 1], ['fairness=rich', 1, 0]]);
  assert.ok(r.arms.every(x => /no claim before the prereg n/.test(x.claim)));
  assert.equal(r.prereg_n, outcomes.PITCH_PREREG_N);
});

/* ------------------------------------------------------------------ B12 */

test('B12 clone valuation source: inside the per-player cap, off and zero:[clone] are byte-identical', async () => {
  const pricing = await import('../server/services/counterparty-pricing.js');
  assert.ok(pricing.VALUATION_SOURCES.clone, 'clone is a declared valuation source');
  assert.ok(pricing.VALUATION_SOURCES.clone.cap <= pricing.PLAYER_VALUATION_CAP);
  const mine = { name: 'His Guy', position: 'WR', value: 1000 };
  const base = { owned: new Set(['his guy']), players: new Map(), reads: new Map() };
  const fit = gain => ({ ...base, clone_fit: { price_bound: { gain_pct: gain, declines: 1 }, fit_stamp: 'T' } });
  const today = JSON.stringify(pricing.playerValuation(base, mine));
  assert.equal(JSON.stringify(pricing.playerValuation(fit(8), mine, { zero: ['clone'] })), today,
    "zero:['clone'] reproduces today's valuation byte-for-byte");
  const on = pricing.playerValuation(fit(8), mine);
  const f = on.factors.find(x => x.source === 'clone');
  assert.equal(f.effect, 0.08);
  assert.equal(on.their_value, 1080);
  assert.equal(pricing.playerValuation(fit(40), mine).factors.find(x => x.source === 'clone').effect,
    pricing.VALUATION_SOURCES.clone.cap, 'capped at its own cap');
  // not his player: a decline says nothing about what he pays for someone else's
  assert.equal(pricing.playerValuation(fit(8), { ...mine, name: 'Other' }).factors.length, 0);
  // no decline yet / a decline that already cost him: inert with its reason
  const none = pricing.playerValuation({ ...base, clone_fit: null }, mine);
  assert.match(none.inert.find(x => x.source === 'clone').reason, /rests on 0 of the 1/);
  const neg = pricing.playerValuation(fit(-5), mine);
  assert.match(neg.inert.find(x => x.source === 'clone').reason, /bounds nothing/);
});

test('B12b the layer attaches clone_fit only when the clone flag is on', async () => {
  const pricing = await import('../server/services/counterparty-pricing.js');
  const save = { c: process.env.GRIDIRON_CLONE_V2, p: process.env.GRIDIRON_PREVIEW_UNCONFIRMED };
  try {
    delete process.env.GRIDIRON_CLONE_V2; delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload,
         fetched_at, current_week) VALUES (?, 'espn', 'clone-b2', ?, 'Fixture', '1', 10, 1, '{}', '2026-10-01', 3)`,
    LEAGUE, SEASON);
    for (const id of ['7', '8']) {
      run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
           VALUES (?, ?, 'tx_accept_rate', 0.3, 10, 'espn_transactions', '2026-10-01')`, LEAGUE, id);
    }
    const off = pricing.counterpartyLayer(LEAGUE, { season: SEASON, week: 3 });
    assert.equal(off.size, 2, 'precondition: the layer has two managers');
    assert.ok([...off.values()].every(m => !('clone_fit' in m)), 'off: no manager carries clone_fit');
    process.env.GRIDIRON_CLONE_V2 = '1';
    const on = pricing.counterpartyLayer(LEAGUE, { season: SEASON, week: 3 });
    assert.equal(on.get('7').clone_fit.n, 2, 'on: manager 7 carries his fit (written in B6)');
    assert.equal(on.get('8').clone_fit, null, 'on: a manager with no settled reply carries null');
  } finally {
    for (const [k, v] of [['GRIDIRON_CLONE_V2', save.c], ['GRIDIRON_PREVIEW_UNCONFIRMED', save.p]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('B12c one charge: with the clone factor on, the band reads his numbers without the clone source', async () => {
  const pricing = await import('../server/services/counterparty-pricing.js');
  const theirs = { name: 'His Guy', position: 'WR', value: 1000 };
  const ours = { name: 'Our Guy', position: 'RB', value: 1100 };
  const profile = { owned: new Set(['his guy']), players: new Map(), reads: new Map(), receptiveness: 1,
    accept_rate: 0.3, accept_rate_n: 10,
    clone_fit: { price_bound: { gain_pct: 8, declines: 1 }, fit_stamp: 'T' } };
  const read = pricing.readDeal({ theirGive: [theirs], theirGet: [ours], managerProfile: profile });
  assert.ok(read.perception_delta < 10, `the clone source priced his player up: ${read.perception_delta}`);
  assert.equal(read.perception_delta_ex_clone, null, 'nothing but the clone source priced this deal');
  const counterparty = { ...read, counterparty_data: true };
  const clone = acc.cloneFor({ counterparty, pool: POOL, fit: { replies: [decline(8)] }, gainPct: 10 });
  const on = acc.acceptanceBand({ counterparty, edge: pass, clone });
  assert.equal(on.factors.find(f => f.source === 'perception_delta'), undefined,
    'the decline is charged by the clone factor only');
  assert.ok(on.factors.find(f => f.source === 'clone'));
  const zeroed = acc.acceptanceBand({ counterparty, edge: pass, clone, zero: ['clone'] });
  assert.ok(zeroed.factors.find(f => f.source === 'perception_delta'),
    'with the clone factor zeroed, his numbers (clone source included) price the band as before');
  // flag off: no fit attached, so readDeal serves no ex-clone delta
  const { clone_fit: _, ...offProfile } = profile;
  assert.equal('perception_delta_ex_clone' in pricing.readDeal({ theirGive: [theirs], theirGet: [ours],
    managerProfile: offProfile }), false);
});

/* ------------------------------------------------------------------ B13 */

// The OFFER-SNAPSHOT table (#247, migration 084), created by hand: it is not on this branch.
const SNAP_DDL = `CREATE TABLE IF NOT EXISTS trade_proposal_snapshots (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, proposal_tx_id TEXT NOT NULL,
  proposer_team_id INTEGER, proposed_at TEXT, scoring_period INTEGER, items_json TEXT NOT NULL,
  first_raw_json TEXT, captured_from TEXT NOT NULL, captured_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  last_status TEXT, resolution TEXT, resolution_tx_id TEXT, resolved_at TEXT,
  PRIMARY KEY (league_id, season, proposal_tx_id))`;
const RAW_DDL = `CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`;

test('B13 settled-reply terms: snapshot first, then the raw row, then the stored package; share reported', () => {
  const L = 9113;
  const now = '2026-10-01T00:00:00.000Z';
  db.exec(SNAP_DDL); db.exec(RAW_DDL);
  // Stored packages price ESPN ids 11 (110) and 22 (100) and 33 (150).
  const give = JSON.stringify([{ espn_id: 11, value: 110 }, { espn_id: 33, value: 150 }]);
  const get = JSON.stringify([{ espn_id: 22, value: 100 }]);
  const ins = (tx, cpId) => run(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json, proposed_at,
     model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status,
     resolved_at, created_at, sent_at, matched_tx_id)
    VALUES (?, ?, 'app_proposed', '1', ?, ?, ?, ?, 0.3, 0.1, 0.5, 'heuristic_anchored', 't', 'declined', ?, ?, ?, ?)`,
  L, SEASON, cpId, give, get, now, now, now, now, tx);
  ins('p1', '7'); ins('p2', '7'); ins(null, '7');
  // p1: the snapshot says 11 for 22 (gain 10%); the raw row was blanked on resolve.
  run(`INSERT INTO trade_proposal_snapshots (league_id, season, proposal_tx_id, proposer_team_id, items_json,
    captured_from, captured_at, last_seen_at) VALUES (?, ?, 'p1', 1, ?, 'pending', ?, ?)`, L, SEASON,
  JSON.stringify([{ fromTeamId: 1, toTeamId: 7, playerId: 11 }, { fromTeamId: 7, toTeamId: 1, playerId: 22 }]), now, now);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, team_id, items_json,
    first_seen_at, last_seen_at) VALUES (?, ?, 'p1', 'TRADE_PROPOSAL', 'EXECUTE', 1, '[]', ?, ?)`, L, SEASON, now, now);
  // p2: no snapshot; the raw row says 33 for 22 (gain 50%).
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, team_id, items_json,
    first_seen_at, last_seen_at) VALUES (?, ?, 'p2', 'TRADE_PROPOSAL', 'EXECUTE', 1, ?, ?, ?)`, L, SEASON,
  JSON.stringify([{ fromTeamId: 1, toTeamId: 7, playerId: 33 }, { fromTeamId: 7, toTeamId: 1, playerId: 22 }]), now, now);
  const r = outcomes.refreshCloneFits(L, SEASON);
  assert.deepEqual(r.terms, { snapshot: 1, raw: 1, stored: 1, share_with_terms: 0.667 });
  const replies = outcomes.cloneFitsFor(L, SEASON).get('7').replies;
  assert.deepEqual(replies.map(x => [x.terms, x.gain_pct]), [['snapshot', 10], ['raw', 50], ['stored', 160]]);
});

/* ------------------------------------------------------------------ B14 */

test('B14 the E1 grade reads terms snapshot-first and prints the share of offers with terms', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(temp, 'grade.sqlite');
  const g = new DatabaseSync(file);
  g.exec(RAW_DDL); g.exec(SNAP_DDL);
  const at = d => `2026-09-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  const rawIns = g.prepare(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type,
    team_id, related_tx_id, proposed_at, items_json, first_seen_at, last_seen_at) VALUES (1, 2026, ?, ?, 'EXECUTE', ?, ?, ?, ?, ?, ?)`);
  const items = JSON.stringify([{ fromTeamId: 1, toTeamId: 2, playerId: 5 }, { fromTeamId: 2, toTeamId: 1, playerId: 6 }]);
  // a: raw terms. b: raw blanked, snapshot has them. c: no terms anywhere. d: only a decision + snapshot.
  rawIns.run('a', 'TRADE_PROPOSAL', 1, null, at(1), items, at(1), at(1));
  rawIns.run('a-x', 'TRADE_DECLINE', 2, 'a', at(2), '[]', at(2), at(2));
  rawIns.run('b', 'TRADE_PROPOSAL', 1, null, at(3), '[]', at(3), at(3));
  rawIns.run('b-x', 'TRADE_ACCEPT', 2, 'b', at(4), '[]', at(4), at(4));
  rawIns.run('c', 'TRADE_PROPOSAL', 1, null, at(5), '[]', at(5), at(5));
  rawIns.run('c-x', 'TRADE_DECLINE', 2, 'c', at(6), '[]', at(6), at(6));
  rawIns.run('d-x', 'TRADE_DECLINE', 2, 'd', at(8), '[]', at(8), at(8));
  const snapIns = g.prepare(`INSERT INTO trade_proposal_snapshots (league_id, season, proposal_tx_id,
    proposer_team_id, proposed_at, items_json, captured_from, captured_at, last_seen_at) VALUES (1, 2026, ?, 1, ?, ?, 'pending', ?, ?)`);
  snapIns.run('b', at(3), items, at(3), at(3));
  snapIns.run('d', at(7), items, at(7), at(7));
  g.close();
  const out = execFileSync(process.execPath, ['scripts/rnd/grade-clone-e1.mjs', '--db', file],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(out, /offers with terms: 3\/4 decided \(75\.0%; snapshot 2, raw 1\)/);
  assert.match(out, /offers decided: 3 \(accepted 1\)/);
  assert.match(out, /"no_terms":1/);
});

/* ------------------------------------------------------------------ B15 */

test('B15 TradeCard follow-up chip: only when clone.follow_up is set, with the bound, labelled in preview', async () => {
  const card = fs.readFileSync(new URL('../client/src/components/TradeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /<CloneFollowUpChip clone=\{deal\.acceptance\?\.clone\} \/>/);
  const src = fs.readFileSync(new URL('../client/src/components/trade/CloneFollowUpChip.tsx', import.meta.url), 'utf8');
  const req = createRequire(new URL('../package.json', import.meta.url));
  const rt = JSON.stringify(req.resolve('react/jsx-runtime'));
  let js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const shim = path.join(temp, 'jsx-runtime.mjs');
  fs.writeFileSync(shim, `import { createRequire } from 'node:module';
const rt = createRequire(${rt})(${rt}); export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
  js = js.split('"react/jsx-runtime"').join(`'${pathToFileURL(shim).href}'`);
  const file = path.join(temp, 'CloneFollowUpChip.mjs');
  fs.writeFileSync(file, js);
  const Chip = (await import(pathToFileURL(file).href)).default;
  const html = clone => renderToStaticMarkup(React.createElement(Chip, { clone }));
  assert.equal(html(undefined), '', 'flag off: the engine attaches no clone block, so no chip');
  assert.equal(html({ p: 0.3, price_bound: { gain_pct: 10 } }), '', 'no follow-up on this deal: no chip');
  const on = html({ follow_up: { above_bound_pct: 10, why: 'w' } });
  assert.match(on, /Cheapest package above the price he declined \(\+10% for him\)/);
  assert.doesNotMatch(on, /Preview/);
  assert.match(html({ preview: true, follow_up: { above_bound_pct: 10, why: 'w' } }), /Preview \(unconfirmed forward\)/);
});

/* ------------------------------------------------------------------ B16 */

test('B16 Arm 1 grades only claims with >= 10 earlier claims by that manager, 2024 only', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const sl = path.join(temp, 'sleeper.sqlite');
  const ap = path.join(temp, 'app.sqlite');
  const s = new DatabaseSync(sl);
  s.exec(`CREATE TABLE sh_leagues (league_id TEXT PRIMARY KEY, season INTEGER NOT NULL);
    CREATE TABLE sh_transactions (league_id TEXT NOT NULL, week INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT,
      status TEXT, roster_ids_json TEXT, adds_json TEXT, drops_json TEXT, waiver_bid REAL, draft_picks INTEGER,
      created_ms INTEGER, latency_ms INTEGER, PRIMARY KEY (league_id, week, seq));
    INSERT INTO sh_leagues VALUES ('A', 2024), ('Z', 2025);`);
  const ins = s.prepare(`INSERT INTO sh_transactions (league_id, week, seq, type, status, adds_json, created_ms)
    VALUES (?, ?, ?, 'waiver', ?, ?, ?)`);
  // roster 1: 12 RB claims (graded: the 11th and 12th); roster 2: 5 claims (never graded)
  for (let i = 0; i < 12; i += 1) ins.run('A', 1 + i, 1, 'complete', JSON.stringify({ 100: 1 }), i);
  for (let i = 0; i < 5; i += 1) ins.run('A', 1 + i, 2, 'complete', JSON.stringify({ 200: 2 }), i);
  ins.run('A', 14, 3, 'failed', JSON.stringify({ 100: 1 }), 99);         // failed: not a claim
  for (let i = 0; i < 12; i += 1) ins.run('Z', 1 + i, 1, 'complete', JSON.stringify({ 100: 1 }), i); // 2025: never read
  s.close();
  const a = new DatabaseSync(ap);
  a.exec(`CREATE TABLE off_sleeper_players (sleeper_id TEXT PRIMARY KEY, position TEXT);
    INSERT INTO off_sleeper_players VALUES ('100', 'RB'), ('200', 'WR');`);
  a.close();
  const out = execFileSync(process.execPath, ['scripts/rnd/grade-clone-arm1.mjs', '--sleeper', sl, '--app', ap],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(out, /complete waiver claims read: 17;/);
  assert.match(out, /graded claims \(manager has >= 10 earlier claims\): 2; managers: 1; leagues: 1/);
  assert.match(out, /PRIMARY gain clone vs activity-only: -?\d/);
});
