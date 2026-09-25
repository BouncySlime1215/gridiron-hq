/**
 * STEP-LOG: sent War Room steps -> campaign_steps (predicted) -> realized gain
 * from the next title-odds snapshot (E5's live evidence).
 *
 * Gates:
 *  S1 an "I sent it" writes one campaign_steps row with the card's predicted
 *     gain and se, once the undo window has closed; not before; not if retracted.
 *  S2 an ESPN proposal from Nick's team that is exactly a plan step (partner +
 *     players by ESPN id, near the plans file's time) writes the step and
 *     stamps trade_outcomes.move_id; other proposals write nothing.
 *  S3 a proposal already claimed by an "I sent it" offer is not logged twice.
 *  S4 an accepted step realizes p_title(next snapshot after settle) minus
 *     p_title(last snapshot before send); with no later snapshot it stays open.
 *  S5 declined/expired: 'snapshot' uses the same difference, 'zero' writes 0.
 *  S6 settling is idempotent, and E5 grades what it writes.
 *  S7 the FIX-07 producer path writes through the same insert (one row per identity).
 *
 * Every league, team, player and id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-steplog-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { logSentSteps, logEspnSteps, settleSteps, stepLogLeague, planSteps, SENT_SETTLE_MS } =
  await import('../server/services/campaign/step-log.js');
const { recordRequest } = await import('../server/services/warroom-actions/store.js');
const { leagueInputs, consumeWith } = await import('../server/services/campaign/requests.js');
const e5 = await import('../server/services/eval/e5.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const ME = '5';
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const H = 3_600_000;
// warroom_requests.created_at is the database clock, so the undo window is read against real time.
const NOW = Date.now();
const LATER = NOW + SENT_SETTLE_MS + 1000;

for (const id of [1, 2, 3, 4, 5, 6]) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
       VALUES (?, 'espn', ?, ?, ?, ?, 4, ?, 4)`, id, `espn-steplog-${id}`, SEASON, `L${id}`, JSON.stringify({ teams: [] }), ME);
}
for (const id of [101, 102, 201, 202, 301, 302]) {
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, `Made Up ${id}`, 'WR', id + 90000);
}

const step = (partner, give, get, delta, se = 0.01) => ({
  partner, give, get, p_yes: { status: 'ok', value: 0.4 },
  title_odds_delta: { status: 'ok', value: delta, se },
  p_yes_band: { low: 0.3, high: 0.5, basis: 'heuristic_unanchored' },
});
function plansFor(leagueId, asOf = iso(T0)) {
  const entry = {
    league: leagueId, me: ME,
    next_move: { status: 'ok', value: { move_id: `M${leagueId}-a`, steps: [step('7', ['101'], ['201'], 0.03)] } },
    alternatives: { status: 'ok', value: [
      { move_id: `M${leagueId}-a`, steps: [step('7', ['101'], ['201'], 0.03)] },
      { move_id: `M${leagueId}-b`, steps: [step('8', ['102', '301'], ['202'], 0.05, 0.02), step('9', ['202'], ['302'], 0.01)] },
    ] },
  };
  return { status: 'ok', entries: [entry], as_of: asOf, id: 'plans@test' };
}

const items = (from, to, ids) => ids.map(p => ({ fromTeamId: Number(from), toTeamId: Number(to), playerId: p + 90000, type: 'TRADE' }));
function observed(leagueId, { to, give, get, at, tx, status = 'proposed', resolved = null }) {
  return Number(run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
      give_json, get_json, proposed_at, status, espn_tx_id, resolved_at, created_at)
    VALUES (?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, leagueId, SEASON, ME, to,
  JSON.stringify(items(ME, to, give)), JSON.stringify(items(to, ME, get)), at, status, tx, resolved, at).lastInsertRowid);
}
function snap(leagueId, at, pTitle, week = 4) {
  run(`INSERT INTO served_numbers (league_id, surface, entity, field, value, model, as_of, served_at, request_id, trigger, season, week)
       VALUES (?, 'title_odds', ?, 'title_odds', ?, 'test', ?, ?, ?, 'weekly', ?, ?)`,
  leagueId, `team:${ME}`, pTitle, at, at, `req-${leagueId}-${at}`, SEASON, week);
}
const steps = leagueId => rows('SELECT * FROM campaign_steps WHERE league_id = ? ORDER BY id', leagueId);

/* ------------------------------------------------------------ S1 */

test('S1: "I sent it" logs the card\'s predicted gain after the undo window; retracted does not log', () => {
  const plans = plansFor(1);
  const sent = recordRequest({ userId: 1, leagueId: 1, kind: 'offer.sent', payload: { move_id: 'M1-b' }, plans });
  assert.ok(sent.trade_outcome?.id, 'the store recorded the offer');
  const taken = recordRequest({ userId: 1, leagueId: 1, kind: 'offer.sent', payload: { move_id: 'M1-a' }, plans });
  recordRequest({ userId: 1, leagueId: 1, kind: 'retract', payload: { request_id: taken.id } });

  const early = logSentSteps(1, { now: NOW + 60_000 });
  assert.equal(early.written, 0, 'inside the undo window nothing is logged');

  const later = logSentSteps(1, { now: LATER });
  assert.equal(later.written, 1);
  const [s] = steps(1);
  assert.equal(s.move_id, 'M1-b');
  assert.equal(s.step_index, 0);
  assert.equal(s.predicted_title_odds_gain, 0.05);
  assert.equal(s.predicted_se, 0.02);
  assert.equal(s.trade_outcome_id, sent.trade_outcome.id);
  assert.equal(s.realized_title_odds_gain, null);
  assert.equal(logSentSteps(1, { now: LATER }).written, 0, 'second run writes nothing');
});

/* ------------------------------------------------------------ S2 / S3 */

test('S2: an ESPN proposal that is exactly a plan step is logged and stamped with its move', () => {
  const hit = observed(2, { to: '8', give: [301, 102], get: [202], at: iso(T0 + 2 * H), tx: 'tx-2a' });
  observed(2, { to: '8', give: [102], get: [202], at: iso(T0 + 2 * H), tx: 'tx-2b' }); // different players
  observed(2, { to: '9', give: [101], get: [201], at: iso(T0 + 2 * H), tx: 'tx-2c' }); // wrong partner
  observed(2, { to: '7', give: [101], get: [201], at: iso(T0 + 72 * H), tx: 'tx-2d' }); // outside the window
  const r = logEspnSteps(2, plansFor(2));
  assert.equal(r.matched, 1);
  assert.equal(r.written, 1);
  const [s] = steps(2);
  assert.deepEqual([s.move_id, s.step_index, s.trade_outcome_id, s.predicted_title_odds_gain], ['M2-b', 0, hit, 0.05]);
  assert.equal(row('SELECT move_id FROM trade_outcomes WHERE id = ?', hit).move_id, 'M2-b');
  assert.equal(logEspnSteps(2, plansFor(2)).written, 0, 'idempotent');
});

test('S2b: a second step of a chained move matches by its own index', () => {
  observed(6, { to: '9', give: [202], get: [302], at: iso(T0 + H), tx: 'tx-6a' });
  assert.equal(logEspnSteps(6, plansFor(6)).written, 1);
  assert.deepEqual([steps(6)[0].move_id, steps(6)[0].step_index, steps(6)[0].predicted_title_odds_gain], ['M6-b', 1, 0.01]);
  assert.equal(planSteps(plansFor(6).entries[0]).length, 3, 'the next move repeated in the deck is counted once');
});

test('S3: a proposal an "I sent it" offer already matched is left to that path', () => {
  const tx = observed(3, { to: '7', give: [101], get: [201], at: iso(T0 + H), tx: 'tx-3a' });
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status,
       created_at, sent_at, matched_tx_id)
       VALUES (3, ?, 'app_proposed', ?, '7', '[]', '[]', ?, 0.4, 0.3, 0.5, 'heuristic_unanchored', 't', 'proposed', ?, ?, 'tx-3a')`,
  SEASON, ME, iso(T0), iso(T0), iso(T0));
  assert.equal(logEspnSteps(3, plansFor(3)).written, 0);
  assert.equal(row('SELECT move_id FROM trade_outcomes WHERE id = ?', tx).move_id, null);
});

/* ------------------------------------------------------------ S4 / S5 */

test('S4: an accepted step realizes the next snapshot minus the one before the send', () => {
  snap(2, iso(T0 - 24 * H), 0.10, 3);
  const o = steps(2)[0].trade_outcome_id;
  assert.equal(settleSteps(2).settled, 0, 'still proposed');
  run(`UPDATE trade_outcomes SET status = 'accepted', resolved_at = ? WHERE id = ?`, iso(T0 + 5 * H), o);
  const waiting = settleSteps(2);
  assert.equal(waiting.settled, 0);
  assert.match(waiting.open[0].why, /no title-odds snapshot after/);
  snap(2, iso(T0 + 3 * H), 0.50, 4); // between send and settle: not the "after"
  snap(2, iso(T0 + 7 * 24 * H), 0.14, 5);
  assert.equal(settleSteps(2).settled, 1);
  const s = steps(2)[0];
  assert.ok(Math.abs(s.realized_title_odds_gain - 0.04) < 1e-12, `realized ${s.realized_title_odds_gain}`);
  assert.equal(s.realized_at, iso(T0 + 5 * H));
});

test('S5: declined uses the snapshot difference by default; zero mode writes 0', () => {
  const mk = (league, tx) => {
    const o = observed(league, { to: '7', give: [101], get: [201], at: iso(T0 + H), tx, status: 'declined', resolved: iso(T0 + 2 * H) });
    logEspnSteps(league, plansFor(league));
    snap(league, iso(T0 - H), 0.20, 3);
    snap(league, iso(T0 + 48 * H), 0.18, 4);
    return o;
  };
  mk(4, 'tx-4a');
  assert.equal(settleSteps(4).settled, 1);
  assert.ok(Math.abs(steps(4)[0].realized_title_odds_gain + 0.02) < 1e-12);
  mk(5, 'tx-5a');
  assert.equal(settleSteps(5, { nonExecuted: 'zero' }).settled, 1);
  assert.equal(steps(5)[0].realized_title_odds_gain, 0);
  assert.throws(() => settleSteps(5, { nonExecuted: 'maybe' }), /nonExecuted/);
});

/* ------------------------------------------------------------ S6 / S7 */

test('S6: settling twice changes nothing, and E5 reads the rows', () => {
  const before = rows('SELECT id, realized_title_odds_gain, realized_at FROM campaign_steps ORDER BY id');
  for (const id of [1, 2, 3, 4, 5, 6]) stepLogLeague(id, plansFor(id), { now: LATER });
  assert.deepEqual(rows('SELECT id, realized_title_odds_gain, realized_at FROM campaign_steps ORDER BY id'), before);
  const g = e5.run(db);
  assert.equal(g.n, 3, 'three realized steps');
  assert.equal(g.detail.awaiting_realized, 2, 'the "I sent it" step and the chained step still open');
});

test('S7: the producer\'s consume path and the step log write one row per step identity', () => {
  const plans = plansFor(1);
  recordRequest({ userId: 1, leagueId: 1, kind: 'offer.sent', payload: { move_id: 'M1-b', sent_as: 'opening' }, plans });
  const n = consumeWith([leagueInputs(1).consume], () => {}, { at: iso(T0) });
  assert.equal(n.campaign_steps, 0, 'M1-b step 0 is already logged');
  assert.equal(steps(1).length, 1);
});
