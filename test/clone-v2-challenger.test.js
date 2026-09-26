/**
 * CLONE v2 (#288 rebased for batch D): manager clones as a SHADOW LIVE-BLEND challenger arm.
 *
 * The clone model (prior + settled-reply update + price bound) and the veto read are #288's, unchanged.
 * What changed on the rebase: the clone no longer enters acceptanceBand, the valuation map or the served
 * P(yes). With GRIDIRON_CLONE_V2=1 it rides on the finder's acceptance as `p_yes_challenger`, and only
 * its own flag turns it on (GRIDIRON_PREVIEW_UNCONFIRMED does not).
 *
 * Gates (docs/tdd/2026-09-25-clone-v2-challenger.tdd.md):
 *  B1/B1b/B1c/B1d/B3/B8/B8b/B9 the clone model, as on #288.
 *  B6/B6b/B7 refreshCloneFits -> manager_clone_fits (migration 113), idempotent, run by settleOfferLoop.
 *  B13/B14/B16 settled-reply terms, the E1 grade and the Arm 1 grade, as on #288 minus the snapshot
 *     table (#247, not on main).
 *  S1 own flag only: off by default, on by GRIDIRON_CLONE_V2=1, never by preview mode.
 *  S2 shadow: the challenger block leaves the served acceptance (band, basis, p_gate, weights) untouched,
 *     and no served-path module (p-yes, p-yes-blend, planner, never-give, War Room adapter) reads it.
 *  S3 the finder's cache key is byte-identical with the flag off, and differs with it on.
 *  S4 P(complete) = P(accept) x (1 - P(veto)); no vetoVotesRequired -> null with the reason.
 *  B10 call site: off gives no clone context; on, each deal reads ITS partner fit and the veto.
 *
 * Every team, player and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-clone-v2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const acc = await import('../server/services/trade-acceptance.js');
const outcomes = await import('../server/services/trade-outcomes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEAGUE = 9101;
const SEASON = 2026;
const cp = (over = {}) => ({ counterparty_data: true, accept_rate: 0.3, accept_rate_n: 10,
  receptiveness: 1, perception_informed: false, receptiveness_factors: [], ...over });
const POOL = { p0: 0.3, m: 15 };
const pkg = gain => ({ give: [{ value: 100 + gain }], get: [{ value: 100 }] });
const decline = gain => ({ y: 0, gain_pct: gain, status: 'declined' });
const withEnv = (vars, fn) => {
  const save = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(save)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};

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

/* ------------------------------------------------------------------- B7 */

test('B7 migration 113: manager_clone_fits exists; trade_outcomes gains no column', () => {
  const cols = rows('PRAGMA table_info(manager_clone_fits)').map(c => c.name);
  for (const c of ['league_id', 'season', 'roster_id', 'coef_json', 'n', 'k', 'fit_stamp']) assert.ok(cols.includes(c), c);
  assert.ok(!rows('PRAGMA table_info(trade_outcomes)').some(c => c.name === 'pitch_json'), 'the pitch arm is not carried');
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

/* ------------------------------------------------------------------- S1 */

test('S1 own flag only: off by default, GRIDIRON_CLONE_V2=1 turns it on, preview mode never does', () => {
  withEnv({ GRIDIRON_CLONE_V2: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(acc.cloneMode(), { on: false }));
  withEnv({ GRIDIRON_CLONE_V2: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.deepEqual(acc.cloneMode(), { on: false }));
  withEnv({ GRIDIRON_CLONE_V2: 'true', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(acc.cloneMode(), { on: false }));
  withEnv({ GRIDIRON_CLONE_V2: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(acc.cloneMode(), { on: true }));
  const src = fs.readFileSync(new URL('../server/services/trade-acceptance.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/preview-mode\.js'|previewUnconfirmed\(/);
});

/* ------------------------------------------------------------------- S2 */

test('S2 shadow: the challenger block leaves the served acceptance untouched', async () => {
  const { pYesFor, pYesTableFrom } = await import('../server/services/p-yes.js');
  const counterparty = cp({ perception_informed: true, perception_delta: 8 });
  const at = d => new Date(Date.UTC(2026, 8, d)).toISOString();
  const offers = [['7', 1, 1], ['7', 3, 0], ['8', 5, 0], ['8', 7, 1]].map(([team, d, y]) => ({ league_id: String(LEAGUE),
    counterparty_team_id: team, proposed_at: at(d), resolved_at: at(d + 1), y, p: 0.3, prior: null }));
  const table = pYesTableFrom(offers, LEAGUE, ['7', '8'], { now: Date.UTC(2026, 9, 1), mode: 'blend' });
  const served = pYesFor({ counterparty, edge: { passes: true }, team: '7', table, on: true });
  const before = JSON.stringify(served);
  const clone = acc.cloneFor({ counterparty, pool: POOL, fit: { replies: [decline(10)] }, gainPct: 10 });
  const block = acc.challengerOf(clone, { p_veto: 0.1, level: 'watch', why: 'w' });
  const withChallenger = { ...served, p_yes_challenger: block };
  const { p_yes_challenger: _, ...rest } = withChallenger;
  assert.equal(JSON.stringify(rest), before, 'band, basis, p_gate and weights are byte-identical');
  assert.equal(block.served, false);
  assert.equal(block.shadow, true);
  assert.equal(block.model, acc.CLONE_V2_MODEL);
  // acceptanceBand has no clone or veto input any more: an extra argument is ignored.
  assert.equal(JSON.stringify(acc.acceptanceBand({ counterparty, edge: { passes: true }, clone, veto: {} })),
    JSON.stringify(acc.acceptanceBand({ counterparty, edge: { passes: true } })));
  // No served-path module reads the challenger or the clone model.
  for (const f of ['server/services/p-yes.js', 'server/services/p-yes-blend.js', 'server/services/campaign/never-give.js',
    'server/services/campaign/planner.js',
    'server/services/eval/e1-league.js', 'scripts/campaign/league-adapter.mjs', 'scripts/campaign/produce-plans.mjs']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /p_yes_challenger|cloneFor|challengerOf|GRIDIRON_CLONE_V2|manager_clone_fits/, f);
  }
  // In trade-engine.js the only write is the challenger key, after the one served assignment.
  const eng = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  assert.deepEqual(eng.match(/d\.acceptance(\.[a-z_]+)? = [^;]+;/g).map(s => s.split(' = ')[0]),
    ['d.acceptance', 'd.acceptance.p_yes_challenger']);
});

/* ------------------------------------------------------------------- S3 */

test('S3 the finder cache key is byte-identical with the flag off and differs with it on', async () => {
  const src = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  assert.match(src, /\$\{cv\.on \? ':cv1' : ''\}`;/);
});

/* ------------------------------------------------------------------- S4 */

test('S4 P(complete) = P(accept) x (1 - P(veto)); no vetoVotesRequired is null with its reason', () => {
  const clone = acc.cloneFor({ counterparty: cp(), pool: POOL, fit: null, gainPct: 0 });
  const inert = acc.vetoFactor({ votes_required: null });
  const a = acc.challengerOf(clone, inert);
  assert.equal(a.completion.p, null);
  assert.match(a.completion.reason, /vetoVotesRequired/);
  const v = acc.vetoFactor({ votes_required: 4, other_owners: 8, level: 'watch', n: 1 });
  const b = acc.challengerOf(clone, v);
  assert.equal(b.completion.p_veto, 0.1);
  assert.equal(b.completion.p, +(clone.p * 0.9).toFixed(3));
  assert.equal(acc.vetoFactor({ votes_required: 9, other_owners: 8, veto_reachable: false }).p_veto, 0);
  assert.ok(acc.vetoFactor({ votes_required: 4, level: 'high' }).p_veto <= acc.VETO_P_CAP);
  assert.equal(acc.challengerOf(null), null);
});

/* ------------------------------------------------------------------ B10 */

test('B10 call site: off gives no clone context; on, each deal reads ITS partner fit and the veto', async () => {
  const eng = await import('../server/services/trade-engine.js');
  const cps = new Map([['7', cp()], ['8', cp({ accept_rate: 0.5 })]]);
  withEnv({ GRIDIRON_CLONE_V2: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () =>
    assert.equal(eng.cloneContext({ id: LEAGUE }, cps, SEASON), null, 'preview mode does not switch it on'));
  withEnv({ GRIDIRON_CLONE_V2: '1' }, () => {
    const ctx = eng.cloneContext({ id: LEAGUE }, cps, SEASON);
    assert.equal(ctx.fits.get('7').n, 2, 'reads manager_clone_fits written in B6');
    assert.equal(+ctx.pool.p0.toFixed(3), 0.4);
    const deal = partner => ({ partner_id: partner, their_value_pct: 30, counterparty: {},
      i_give: [{ value: 110 }], i_get: [{ value: 100 }] });
    const climate = { votes_required: 4, other_owners: 8, n: 1, reference_n: 1, reference_skew_pct: 18, observed_max_votes: 4 };
    const seven = eng.challengerFor(ctx, cps.get('7'), deal(7), climate);
    const eight = eng.challengerFor(ctx, cps.get('8'), deal(8), climate);
    assert.equal(seven.n, 2);
    assert.equal(seven.gain_pct, 10);
    assert.equal(eight.n, 0);
    assert.equal(seven.completion.level, 'high');
    assert.equal(eng.challengerFor(ctx, cps.get('7'), deal(7), null).completion.p_veto, null);
    assert.equal(eng.challengerFor({ ...ctx, fits: null, error: 'x' }, cps.get('7'), deal(7), null).p, null,
      'a failed fits read is a stated absence, not a prior dressed as a read');
    const shown = [15, 12, 30].map(g => ({ partner_id: 7,
      acceptance: { band: {}, p_yes_challenger: { gain_pct: g, price_bound: { gain_pct: 10 } } } }));
    eng.markCloneFollowUps(shown);
    assert.deepEqual(shown.map(d => !!d.acceptance.p_yes_challenger.follow_up), [false, true, false]);
  });
});

const RAW_DDL = `CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`;

test('B13 settled-reply terms: the raw row, else the stored package; share reported', () => {
  const L = 9113;
  const now = '2026-10-01T00:00:00.000Z';
  db.exec(RAW_DDL);
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
  // p1: the raw row was blanked on resolve, so the stored package prices it (260 for 100: +160%).
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, team_id, items_json,
    first_seen_at, last_seen_at) VALUES (?, ?, 'p1', 'TRADE_PROPOSAL', 'EXECUTE', 1, '[]', ?, ?)`, L, SEASON, now, now);
  // p2: the raw row says 33 for 22 (gain 50%).
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, team_id, items_json,
    first_seen_at, last_seen_at) VALUES (?, ?, 'p2', 'TRADE_PROPOSAL', 'EXECUTE', 1, ?, ?, ?)`, L, SEASON,
  JSON.stringify([{ fromTeamId: 1, toTeamId: 7, playerId: 33 }, { fromTeamId: 7, toTeamId: 1, playerId: 22 }]), now, now);
  const r = outcomes.refreshCloneFits(L, SEASON);
  assert.deepEqual(r.terms, { raw: 1, stored: 2, share_with_terms: 0.333 });
  const replies = outcomes.cloneFitsFor(L, SEASON).get('7').replies;
  assert.deepEqual(replies.map(x => [x.terms, x.gain_pct]), [['stored', 160], ['raw', 50], ['stored', 160]]);
});

/* ------------------------------------------------------------------ B14 */

test('B14 the E1 grade reads terms from the raw rows and prints the share of offers with terms', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(temp, 'grade.sqlite');
  const g = new DatabaseSync(file);
  g.exec(RAW_DDL);
  const at = d => `2026-09-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  const rawIns = g.prepare(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type,
    team_id, related_tx_id, proposed_at, items_json, first_seen_at, last_seen_at) VALUES (1, 2026, ?, ?, 'EXECUTE', ?, ?, ?, ?, ?, ?)`);
  const items = JSON.stringify([{ fromTeamId: 1, toTeamId: 2, playerId: 5 }, { fromTeamId: 2, toTeamId: 1, playerId: 6 }]);
  // a: raw terms. b: raw blanked. c: no terms anywhere. d: only a decision.
  rawIns.run('a', 'TRADE_PROPOSAL', 1, null, at(1), items, at(1), at(1));
  rawIns.run('a-x', 'TRADE_DECLINE', 2, 'a', at(2), '[]', at(2), at(2));
  rawIns.run('b', 'TRADE_PROPOSAL', 1, null, at(3), '[]', at(3), at(3));
  rawIns.run('b-x', 'TRADE_ACCEPT', 2, 'b', at(4), '[]', at(4), at(4));
  rawIns.run('c', 'TRADE_PROPOSAL', 1, null, at(5), '[]', at(5), at(5));
  rawIns.run('c-x', 'TRADE_DECLINE', 2, 'c', at(6), '[]', at(6), at(6));
  rawIns.run('d-x', 'TRADE_DECLINE', 2, 'd', at(8), '[]', at(8), at(8));
  g.close();
  const out = execFileSync(process.execPath, ['scripts/rnd/grade-clone-e1.mjs', '--db', file],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(out, /offers with terms: 1\/4 decided \(25\.0%; snapshot 0, raw 1\)/);
  assert.match(out, /offers decided: 1 \(accepted 0\)/);
  assert.match(out, /"no_terms":3/);
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
