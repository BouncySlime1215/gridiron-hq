/**
 * HISTORY-INGEST (LIVING-01b re-gate, part 4): does ESPN keep past seasons'
 * transactions for our leagues, and a flag-off ingest when it does.
 *
 * league-history.js note 3 records that X-Fantasy-Filter does not widen the
 * ~3-day window. Two routes it did not try are probed here: mTransactions2 asked
 * per scoring period, and the league communication feed. ESPN is faked; every
 * payload is made up (roster ids and player ids only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as H from '../server/services/league-history-tx.js';
import { up as migrate104 } from '../server/migrations/104_league_history_transactions.js';

const LG = { id: 4, league_id: '999', season: 2026, espn_s2: 'S2-SECRET', swid: '{SWID-SECRET}' };
const DAY = 86_400_000;
const SEASON_2024 = Date.parse('2024-09-05T00:00:00Z');

const periodTx = (period, n) => Array.from({ length: n }, (_, i) => ({
  id: `p${period}-${i}`, type: 'FREEAGENT', status: 'EXECUTED', executionType: 'EXECUTE', teamId: (i % 8) + 1,
  scoringPeriodId: period, proposedDate: SEASON_2024 + period * 7 * DAY, processDate: SEASON_2024 + period * 7 * DAY,
  items: [{ type: 'ADD', toTeamId: (i % 8) + 1, playerId: 100 + i }],
}));

const commPayload = () => ({
  topics: [
    { id: 't1', date: SEASON_2024 + 10 * DAY, messages: [
      { id: 'm1', messageTypeId: 178, to: 3, targetId: 501 },
      { id: 'm2', messageTypeId: 179, to: 3, targetId: 502 }] },
    { id: 't2', date: SEASON_2024 + 60 * DAY, messages: [
      { id: 'm3', messageTypeId: 244, from: 5, targetId: 503 },
      { id: 'm4', messageTypeId: 239, for: 6, targetId: 504 },
      { id: 'm5', messageTypeId: 999, to: 1, targetId: 505 }] },
  ],
});

/** A fake ESPN: `history` decides what each route answers. Records every URL and header asked. */
function fakeEspn({ periods = true, comm = true } = {}) {
  const calls = [];
  const fetchJson = async (url, headers) => {
    calls.push({ url, headers });
    const u = new URL(url);
    if (u.pathname.includes('/communication/')) return comm ? commPayload() : { topics: [] };
    const period = Number(u.searchParams.get('scoringPeriodId'));
    const tx = periods && period >= 1 && period <= 3 ? periodTx(period, 4) : [];
    // leagueHistory answers with an array
    return u.pathname.includes('/leagueHistory/') ? [{ transactions: tx }] : { transactions: tx };
  };
  return { fetchJson, calls };
}

test('urls: a prior season goes to leagueHistory, the current one to seasons; the period route asks one period', () => {
  const past = new URL(H.periodUrl(LG, 2024, 7));
  assert.match(past.pathname, /\/leagueHistory\/999$/);
  assert.equal(past.searchParams.get('seasonId'), '2024');
  assert.equal(past.searchParams.get('scoringPeriodId'), '7');
  assert.equal(past.searchParams.get('view'), 'mTransactions2');
  const now = new URL(H.periodUrl(LG, 2026, 2));
  assert.match(now.pathname, /\/seasons\/2026\/segments\/0\/leagues\/999$/);
  const comm = new URL(H.communicationUrl(LG, 2024));
  assert.match(comm.pathname, /\/seasons\/2024\/segments\/0\/leagues\/999\/communication\/$/);
  assert.equal(comm.searchParams.get('view'), 'kona_league_communication');
});

test('communication feed: adds, drops and trades by team, unknown message types counted, not guessed', () => {
  const m = H.movesFromCommunication(commPayload());
  assert.deepEqual(m.moves.map(x => [x.id, x.kind, x.team_id, x.player_id]), [
    ['m1', 'add', 3, 501], ['m2', 'drop', 3, 502], ['m3', 'trade', 5, 503], ['m4', 'drop', 6, 504]]);
  assert.equal(m.unknown_types, 1);
  assert.equal(m.moves[0].at, new Date(SEASON_2024 + 10 * DAY).toISOString());
});

test('probe: counts what each route returns for a past season, read-only, and never prints the cookies', async () => {
  const espn = fakeEspn();
  const r = await H.probeLeagueSeason({ lg: LG, season: 2024, periods: [1, 2, 3, 4], fetchJson: espn.fetchJson, paceMs: 0 });
  assert.deepEqual(r.period_route, { requests: 4, rows: 12, periods_with_rows: [1, 2, 3], errors: 0,
    earliest: new Date(SEASON_2024 + 7 * DAY).toISOString(), latest: new Date(SEASON_2024 + 21 * DAY).toISOString() });
  assert.equal(r.communication_route.moves, 4);
  assert.equal(r.communication_route.span_days, 50);
  assert.equal(r.exists, true, 'rows older than a 3-day window: history is there');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('SECRET'), 'no cookie in the result');
  assert.ok(espn.calls.every(c => /espn_s2=S2-SECRET/.test(c.headers.Cookie)), 'cookies go in the header only');
});

test('probe: nothing past a 3-day window is "no history", and an ESPN error is counted, not swallowed', async () => {
  const empty = fakeEspn({ periods: false, comm: false });
  const r = await H.probeLeagueSeason({ lg: LG, season: 2024, periods: [1, 2], fetchJson: empty.fetchJson, paceMs: 0 });
  assert.equal(r.exists, false);
  assert.equal(r.period_route.rows, 0);
  const failing = async () => { throw new Error('ESPN 500'); };
  const e = await H.probeLeagueSeason({ lg: LG, season: 2024, periods: [1, 2], fetchJson: failing, paceMs: 0 });
  assert.equal(e.period_route.errors, 2);
  assert.match(e.communication_route.error, /ESPN 500/);
  assert.equal(e.exists, null, 'could not look is not "no"');
});

test('ingest is off by default: without GRIDIRON_HISTORY_INGEST=1 nothing is written', async () => {
  delete process.env[H.HISTORY_INGEST_ENV];
  const d = new DatabaseSync(':memory:');
  migrate104(d);
  const espn = fakeEspn();
  const r = await H.ingestLeagueSeason(d, { lg: LG, season: 2024, periods: [1, 2, 3], fetchJson: espn.fetchJson, paceMs: 0 });
  assert.equal(r.state, 'off');
  assert.equal(espn.calls.length, 0, 'off asks ESPN nothing');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM league_history_transactions').get().n, 0);
});

test('ingest on: past-season rows go to their own table, idempotently, and never into league_transactions_raw', async () => {
  process.env[H.HISTORY_INGEST_ENV] = '1';
  try {
    const d = new DatabaseSync(':memory:');
    migrate104(d);
    d.exec('CREATE TABLE league_transactions_raw (league_id INTEGER, season INTEGER, tx_id TEXT)');
    const espn = fakeEspn();
    const a = await H.ingestLeagueSeason(d, { lg: LG, season: 2024, periods: [1, 2, 3], fetchJson: espn.fetchJson, paceMs: 0 });
    assert.equal(a.written, 12);
    const b = await H.ingestLeagueSeason(d, { lg: LG, season: 2024, periods: [1, 2, 3], fetchJson: espn.fetchJson, paceMs: 0 });
    assert.equal(b.written, 0, 'the same transactions are not stored twice');
    const row = d.prepare(`SELECT * FROM league_history_transactions WHERE tx_id = 'p2-1'`).get();
    assert.deepEqual([row.league_id, row.season, row.scoring_period, row.type, row.status], [4, 2024, 2, 'FREEAGENT', 'EXECUTED']);
    assert.ok(!row.raw_json.includes('SECRET'));
    assert.equal(d.prepare('SELECT COUNT(*) n FROM league_transactions_raw').get().n, 0,
      'served readers of league_transactions_raw do not filter by season; history must not land there');
    await assert.rejects(() => H.ingestLeagueSeason(d, { lg: LG, season: 2026, periods: [1], fetchJson: espn.fetchJson, paceMs: 0 }),
      /current season/, 'the current season is the forward collector\'s, not this one\'s');
  } finally {
    delete process.env[H.HISTORY_INGEST_ENV];
  }
});
