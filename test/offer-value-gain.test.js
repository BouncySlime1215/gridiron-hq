/**
 * PROJ-ESPN Q3: the value-gain hint is info only, and the per-offer log has the four features.
 *   - features from the counterparty's side; unpriced / unscored reads are null, never a guess
 *   - the finder hint is added to every idea without touching the finder's order unless asked
 *   - the log writes one row per decided offer, first write wins
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-value-gain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const vg = await import('../server/services/offer-value-gain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const fc = { status: 'ok', byId: new Map([['1', 5000], ['2', 3000], ['3', 1500], ['4', 800]]) };

test('features: FantasyCalc gain, need met, blue chip given, days to deadline (counterparty side)', () => {
  const f = vg.valueGainFeatures({ received: [1], sent: [2, 4] }, {
    fc, scores: new Map([['1', 90], ['2', 70]]), needs: new Set(['WR']), positionOf: id => ({ 1: 'WR', 2: 'RB', 4: 'TE' })[id],
    deadlineMs: Date.parse('2026-11-20T00:00:00Z'), atMs: Date.parse('2026-09-25T00:00:00Z') });
  assert.deepEqual(f, { fc_gain: 1200, need_met: 1, blue_chip_given: 1, days_to_deadline: 56 });
  const g = vg.valueGainFeatures({ received: [3], sent: [99] }, { fc });
  assert.deepEqual(g, { fc_gain: null, need_met: null, blue_chip_given: null, days_to_deadline: null },
    'an unpriced player, no board, no needs and no deadline are unknown, not 0');
});

test('positional needs: below the league median of each team\'s best at the position', () => {
  const t = (id, wr, rb) => ({ roster_id: id, players: [{ position: 'WR', ros_ppg: wr }, { position: 'RB', ros_ppg: rb }] });
  const needs = vg.positionalNeeds([t(1, 10, 20), t(2, 15, 12), t(3, 20, 16)]);
  assert.deepEqual([...needs.get('1')], ['WR'], 'team 1 is below the median WR (15), not RB; nobody has a QB or TE');
  assert.ok(needs.get('2').has('RB') && !needs.get('2').has('WR'));
});

test('finder hint: added to every idea, info only; order changes only with sort=value_gain', () => {
  const out = { deals: [
    { partner_id: 'a', i_give: [{ id: 4 }], i_get: [{ id: 3 }] },   // they gain -700
    { partner_id: 'b', i_give: [{ id: 1 }], i_get: [{ id: 2 }] },   // they gain +2000
    { partner_id: 'c', i_give: [{ id: 9 }], i_get: [{ id: 2 }] },   // unpriced
  ], dropped_by_rule: 3 };
  const kept = vg.withValueGainHint(out, { fc });
  assert.deepEqual(kept.deals.map(d => d.partner_id), ['a', 'b', 'c']);
  assert.deepEqual(kept.deals.map(d => d.value_gain_hint.their_fc_gain), [-700, 2000, null]);
  assert.equal(kept.deals[0].value_gain_hint.info_only, true);
  assert.match(kept.deals[0].value_gain_hint.note, /Not a chance he says yes/);
  assert.equal(kept.dropped_by_rule, 3, 'the rule-gate count rides along untouched');
  assert.equal(out.deals[0].value_gain_hint, undefined, 'the cached finder result is not mutated');
  const sorted = vg.withValueGainHint(out, { fc, sort: 'value_gain' });
  assert.deepEqual(sorted.deals.map(d => d.partner_id), ['b', 'a', 'c']);
  assert.match(sorted.value_gain_sort, /info only/);
});

test('the log: one row per decided offer with the four features; first write wins', async () => {
  db.exec(`INSERT INTO leagues (id, platform, league_id, season, payload) VALUES
    (7, 'espn', 'x7', 2026, '{"settings":{"tradeSettings":{"deadlineDate":${Date.parse('2026-11-20T00:00:00Z')}}}}')`);
  const offers = { offers: [
    { offer_id: 'o1', league_id: 7, season: 2026, counterparty_team_id: '2', proposed_at: '2026-09-25T00:00:00Z', y: 1,
      terms: [{ playerId: 501, fromTeamId: 1, toTeamId: 2 }, { playerId: 502, fromTeamId: 2, toTeamId: 1 }] },
    { offer_id: 'o2', league_id: 7, season: 2026, counterparty_team_id: '2', proposed_at: '2026-09-25T00:00:00Z', y: 0, terms: null },
  ] };
  const ctx = async () => ({ espnToId: new Map([[501, 1], [502, 2]]), positionOf: id => (id === 1 ? 'WR' : 'RB'),
    needs: new Map([['2', new Set(['WR'])]]), scores: new Map([['1', 85]]) });
  db.exec(`INSERT INTO players (id, name, position) VALUES (1, 'P1', 'WR'), (2, 'P2', 'RB')`);
  db.exec(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (1, 'fc_value', 5000, '2026-09-25'), (2, 'fc_value', 3000, '2026-09-25')`);
  const r = await vg.logOfferValueGains({ loadOffers: async () => offers, leagueContext: ctx });
  assert.deepEqual([r.logged, r.skipped], [1, 1]);
  const row = db.prepare('SELECT * FROM offer_value_gain_log WHERE offer_id = ?').get('o1');
  assert.deepEqual([row.fc_gain, row.need_met, row.blue_chip_given, row.days_to_deadline, row.outcome], [2000, 1, 1, 56, 1]);
  const again = await vg.logOfferValueGains({ loadOffers: async () => offers, leagueContext: ctx });
  assert.equal(again.logged, 0);
});

test('offer keys: an app offer with no ESPN tx id is not collapsed into "<league>:null"', () => {
  const a = { league_id: 4, offer_id: '4:null', espn_tx_id: null, decision_tx_id: 'd1', proposed_at: 't1', counterparty_team_id: '2' };
  const b = { ...a, decision_tx_id: 'd2' };
  assert.notEqual(vg.offerKey(a), vg.offerKey(b));
  assert.equal(vg.offerKey({ league_id: 4, offer_id: '4:777', espn_tx_id: 777 }), '4:777');
});
