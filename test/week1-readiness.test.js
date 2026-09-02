import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Regression coverage for the 2026-09-02 diagnostic: the defects that would
// have kept Week 1 from settling, learning, or staying inside the odds budget.
// Same isolated-DB pattern as the other suites.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-week1-readiness-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.ODDS_API_KEY;

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const gamescript = await import('../server/services/gamescript.js');
const { nflModelGrowthStatus } = await import('../server/services/nfl-model-growth.js');
const { recordForwardPick, settleForwardPicks } = await import('../server/services/forward-ledger.js');
const { settleRiskLabPredictions } = await import('../server/services/nfl-risk-lab.js');
const { settleOnlineNeuralExamples } = await import('../server/services/nfl-online-neural.js');
const { finalizeClosingSnapshots } = await import('../server/services/nfl-prop-clv.js');
const { availabilityEdge } = await import('../server/services/nfl-availability.js');
const odds = await import('../server/services/odds-api.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const insertGame = db.prepare(`INSERT INTO game_lines
  (season,week,team,opponent,home,spread,total,gameday,gametime,team_score,opp_score,neutral_site)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

test('a week is finalized only when every game in it is final', () => {
  insertGame.run(2031, 1, 'SEA', 'NE', 1, -3.5, 44.5, '2031-09-10', '20:20', 24, 17, 0);
  insertGame.run(2031, 1, 'DET', 'NO', 1, -7, 49.5, '2031-09-14', '13:00', null, null, 0);
  assert.equal(nflModelGrowthStatus(2031).finalized_week, 0, 'one final game must not finalize the week');
  run(`UPDATE game_lines SET team_score=30, opp_score=20 WHERE season=2031 AND week=1 AND team='DET'`);
  assert.equal(nflModelGrowthStatus(2031).finalized_week, 1);
});

test('forward picks are not graded from a half-ingested final', () => {
  insertGame.run(2031, 2, 'BUF', 'NYJ', 1, -3, 42.5, '2031-09-21', '13:00', null, null, 0);
  assert.equal(recordForwardPick({ season: 2031, week: 2, home: 'BUF', away: 'NYJ', side: 'BUF', line: -3,
    recordedAt: '2031-09-21T12:00:00.000Z' }).ok, true);
  run(`UPDATE game_lines SET team_score=27 WHERE season=2031 AND week=2 AND team='BUF'`);
  assert.equal(settleForwardPicks().settled, 0, 'team_score alone is not a result');
  run(`UPDATE game_lines SET opp_score=20 WHERE season=2031 AND week=2 AND team='BUF'`);
  assert.equal(settleForwardPicks().settled, 1);
  assert.equal(rows(`SELECT result FROM forward_picks WHERE season=2031 AND week=2`)[0].result, 'Won');
});

test('risk-lab and online-neural rows settle against their own frozen market number', () => {
  insertGame.run(2031, 3, 'KC', 'DEN', 1, -3, 42.5, '2031-09-28', '20:15', 24, 20, 0);
  const cols = `season,week,home,away,horizon,model_id,epoch_id,captured_at,engine_version,feature_hash,features_json,market_margin,predicted_residual`;
  run(`INSERT INTO nfl_risk_lab_predictions (${cols}) VALUES (2031,3,'KC','DEN','T-24h','deep_ensemble',1,'2031-09-27T00:00:00Z','v','h','[]',3,0)`);
  run(`INSERT INTO nfl_risk_lab_predictions (${cols}) VALUES (2031,3,'KC','DEN','close','deep_ensemble',1,'2031-09-28T23:00:00Z','v','h','[]',4.5,0)`);
  const risk = settleRiskLabPredictions();
  assert.equal(risk.predictions_settled, 2);
  const byHorizon = Object.fromEntries(rows(`SELECT horizon,target_residual FROM nfl_risk_lab_predictions WHERE season=2031`)
    .map(r => [r.horizon, r.target_residual]));
  assert.equal(byHorizon['T-24h'], 1, 'actual 4 minus the T-24h market 3');
  assert.equal(byHorizon['close'], -0.5, 'actual 4 minus the closing market 4.5');

  const ncols = `season,week,home,away,head,horizon,epoch_id,captured_at,schema_version,model_version,feature_hash,features_json,market_margin,prediction_residual,predicted_margin`;
  run(`INSERT INTO nfl_online_neural_examples (${ncols}) VALUES (2031,3,'KC','DEN','spread_residual','T-24h',1,'2031-09-27T00:00:00Z','s','m','h','[]',3,0,3)`);
  run(`INSERT INTO nfl_online_neural_examples (${ncols}) VALUES (2031,3,'KC','DEN','spread_residual','close',1,'2031-09-28T23:00:00Z','s','m','h','[]',4.5,0,4.5)`);
  assert.equal(settleOnlineNeuralExamples().settled, 2);
  const neural = Object.fromEntries(rows(`SELECT horizon,target_residual FROM nfl_online_neural_examples WHERE season=2031`)
    .map(r => [r.horizon, r.target_residual]));
  assert.equal(neural['T-24h'], 1);
  assert.equal(neural['close'], -0.5);
});

test('a prop quote never closes against itself', () => {
  const base = { event_id: 'evt1', book: 'draftkings', market: 'player_pass_yds', player: 'Test Passer', side: 'over',
    season: 2031, week: 4, commence_time: '2031-10-05T17:00:00Z', line: 250.5, american_price: -110, implied_probability: 0.5238 };
  const insert = db.prepare(`INSERT INTO nfl_prop_clv
    (captured_at,event_id,book,market,player,side,season,week,commence_time,line,american_price,implied_probability)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('2031-10-04T17:00:00Z', base.event_id, base.book, base.market, base.player, base.side, base.season, base.week,
    base.commence_time, base.line, base.american_price, base.implied_probability);
  const single = finalizeClosingSnapshots('2031-10-05T18:00:00Z');
  assert.equal(single.finalized, 0, 'a lone capture has no separate close');
  assert.equal(single.unmatched, 1);
  insert.run('2031-10-05T16:00:00Z', base.event_id, base.book, base.market, base.player, base.side, base.season, base.week,
    base.commence_time, 252.5, -115, 0.5349);
  const paired = finalizeClosingSnapshots('2031-10-05T18:00:00Z');
  assert.equal(paired.finalized, 1, 'the earlier capture closes against the later one');
  const closed = rows(`SELECT captured_at, closing_line, clv_probability FROM nfl_prop_clv WHERE closing_price IS NOT NULL`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].captured_at, '2031-10-04T17:00:00Z');
  assert.equal(closed[0].closing_line, 252.5);
  assert.ok(Math.abs(closed[0].clv_probability - 0.0111) < 1e-3);
});

test('a missing injury report is missing evidence, not a healthy roster', () => {
  assert.equal(availabilityEdge(2031, 5, 'PHI', 'WAS'), null);
});

test('the ESPN sync records finals without an odds object, opening lines, neutral sites and roofs', async () => {
  const realFetch = globalThis.fetch;
  const event = ({ id, home, away, hs, as, final, odds, neutral, indoor }) => ({
    id, competitions: [{
      neutralSite: neutral, venue: { indoor },
      status: { type: { completed: final } },
      competitors: [
        { homeAway: 'home', score: String(hs), team: { abbreviation: home } },
        { homeAway: 'away', score: String(as), team: { abbreviation: away } }
      ],
      odds: odds ? [odds] : undefined
    }]
  });
  const live = {
    spread: -3.5, overUnder: 44.5, overOdds: -105, underOdds: -115,
    moneyline: { home: { close: { odds: '-180' } }, away: { close: { odds: '+150' } } },
    pointSpread: { home: { close: { line: '-3.5', odds: '-110' }, open: { line: '-2.5', odds: '-110' } },
      away: { close: { line: '+3.5', odds: '-110' }, open: { line: '+2.5', odds: '-110' } } },
    total: { over: { close: { line: 'o44.5', odds: '-105' }, open: { line: 'o43.5', odds: '-110' } },
      under: { close: { line: 'u44.5', odds: '-115' }, open: { line: 'u43.5', odds: '-110' } } }
  };
  globalThis.fetch = async url => {
    const week = Number(new URL(url).searchParams.get('week'));
    const events = week === 1 ? [
      event({ id: 'a', home: 'LAR', away: 'SF', hs: 0, as: 0, final: false, odds: live, neutral: true, indoor: false }),
      event({ id: 'b', home: 'WSH', away: 'PHI', hs: 20, as: 24, final: true, odds: null, neutral: false, indoor: false })
    ] : [];
    return { ok: true, json: async () => ({ events }) };
  };
  try {
    // The Washington game already existed from an earlier pre-kickoff sync.
    insertGame.run(2032, 1, 'WAS', 'PHI', 1, 4.5, 45.5, '2032-09-12', '13:00', null, null, 0);
    insertGame.run(2032, 1, 'PHI', 'WAS', 0, -4.5, 45.5, '2032-09-12', '13:00', null, null, 0);
    const out = await gamescript.syncCurrentLines(2032, 1);
    assert.equal(out.updated, 2, 'the priced game upserts two team rows');
    assert.equal(out.finals_scored, 2, 'the final without odds still lands its scores');
    const lar = rows(`SELECT * FROM game_lines WHERE season=2032 AND week=1 AND team='LAR'`)[0];
    assert.equal(lar.neutral_site, 1);
    assert.equal(lar.roof, 'outdoors');
    assert.equal(lar.open_spread, -2.5);
    assert.equal(lar.open_total, 43.5);
    assert.equal(lar.total_over_odds, -105);
    const sf = rows(`SELECT open_spread FROM game_lines WHERE season=2032 AND week=1 AND team='SF'`)[0];
    assert.equal(sf.open_spread, 2.5);
    const was = rows(`SELECT team_score, opp_score, spread FROM game_lines WHERE season=2032 AND week=1 AND team='WAS'`)[0];
    assert.equal(was.team_score, 20);
    assert.equal(was.opp_score, 24);
    assert.equal(was.spread, 4.5, 'the last pre-final line is preserved as the close');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the odds client refuses to spend below the reserve and reports the hold', async () => {
  process.env.ODDS_API_KEY = 'test-key';
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, headers: new Map([['x-requests-used', '499'], ['x-requests-remaining', '1']]), json: async () => [] }; };
  try {
    run(`INSERT INTO odds_usage (id,requests_used,requests_remaining,last_call_at) VALUES (1,498,2,'2031-09-01T00:00:00Z')
         ON CONFLICT(id) DO UPDATE SET requests_used=498, requests_remaining=2`);
    const payload = await odds.gameOdds({ markets: 'spreads,totals', ttlMs: 0 });
    assert.equal(payload, null, 'the call is refused, not sent');
    assert.equal(fetched, 0, 'no credit is spent');
    const status = odds.reserveStatus();
    assert.equal(status.exhausted, true);
    assert.equal(status.last_hold.cost, 2);
    assert.equal(odds.estimateCost({ markets: 'spreads,totals', regions: 'us,eu' }), 4);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ODDS_API_KEY;
  }
});
