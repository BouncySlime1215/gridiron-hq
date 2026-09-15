/**
 * Integration stage 1 (2026-09-12): closing the gap the old t60-runner.js
 * comment named outright -- "the board itself is still computed from the live
 * (mutable) tables ... which is the strongest claim available today." The
 * decision tape stamped a run `frozen_packet` with the packet's hash while
 * autoPickDecisionBoard() actually reread game_lines at compute time.
 *
 * The property under test is exactly the one that comment admitted was
 * missing: a board built from a frozen packet must reflect what the PACKET
 * says, not whatever the live tables say right now -- proven here by making
 * them say two different things on purpose and checking which one wins, both
 * before and after the live table is mutated out from under the frozen packet.
 */
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-t60-packet-board-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, dbPath, run } = await import('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'this test must never be able to reach the real database');
await (await import('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Same isolation nfl-ensemble-authority.test.js already establishes for this
// exact fixture shape: substitute only the external feature producers, run
// fitting/blend/calibration/policy for real, unmodified.
const teams = ['KC', 'BAL', 'BUF', 'MIA', 'DAL', 'PHI', 'SF', 'SEA'];
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-roster-strength.js', { namedExports: {
  rosterStrengthWeek: () => new Map(teams.map((team, i) => [team, { available: true, roster_score: (4 - i) * 12 }]))
} });
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-availability.js', { namedExports: { availabilityDeficit: () => new Map() } });
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-pbp.js', { namedExports: { teamWeeks: () => [] } });
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-player-value.js', { namedExports: { gamePlayerAvailability: () => null } });
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-engine-registry.js', { namedExports: {
  nflEngineVersionFor: () => 'fixture-engine', activeLearningEpoch: () => null
} });
mock.module('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-signal-reliability.js', { namedExports: {
  signalReliabilityFor: () => ({ version: 'fixture', multipliers: {}, adjusted: [] })
} });

// nfl-t60-packet.js's teamCodeFor needs real rows to resolve abbreviations.
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'KC','Kansas City Chiefs','AFC','West'), (2,'BAL','Baltimore Ravens','AFC','North'),
  (3,'BUF','Buffalo Bills','AFC','East'), (4,'MIA','Miami Dolphins','AFC','East'),
  (5,'DAL','Dallas Cowboys','NFC','East'), (6,'PHI','Philadelphia Eagles','NFC','East'),
  (7,'SF','San Francisco 49ers','NFC','West'), (8,'SEA','Seattle Seahawks','NFC','West')`);

// Nine synthetic prior seasons, double-length weeks, so the ensemble's fit has
// well over its required 100-game floor before the current week is asked about.
for (let season = 2015; season <= 2023; season++) {
  for (let week = 1; week <= 36; week++) {
    const order = teams.map((_, i) => (i + week) % teams.length);
    for (let pair = 0; pair < 4; pair++) {
      const h = order[pair], a = order[7 - pair];
      const margin = 2 + Math.round((a - h) * 3.84) + ((week + season) % 3 - 1);
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score)
        VALUES (?,?,?,?,1,-2,60,?,30)`, season, week, teams[h], teams[a], 30 + margin);
    }
  }
}

const SEASON = 2024, WEEK = 1;
const KICKOFF = '2024-09-08T17:00:00Z';
const CUTOFF_AT = '2024-09-08T16:00:00.000Z'; // T-60 of the kickoff above
const BEFORE_CUTOFF = '2024-09-08T15:30:00Z';
const LIVE_SPREAD = -2;   // what game_lines says at compute time
const PACKET_SPREAD = -7; // what the tape actually had received by the cutoff

run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,spread_odds,total,source,fetched_at)
     VALUES (?,?,?,?,1,?,?,60,'espn',datetime('now'))`, SEASON, WEEK, 'KC', 'BAL', LIVE_SPREAD, -110);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,spread_odds,total,source,fetched_at)
     VALUES (?,?,?,?,0,?,?,60,'espn',datetime('now'))`, SEASON, WEEK, 'BAL', 'KC', -LIVE_SPREAD, -110);

function storeQuote(batchId, { side, team, line, price, receivedAt }) {
  run(`INSERT INTO nfl_quote_batches
    (batch_id,provider,requested_at,received_at,receipt_clock_source,snapshot_at,mode,markets,
     source_ref,events,quotes,raw_hash,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    batchId, 'testbook', receivedAt, receivedAt, 'response_completion', receivedAt, 'live', 'spreads',
    'fixture', 1, 1, `hash-${batchId}`, 'v1', receivedAt);
  run(`INSERT INTO nfl_quote_tape
    (quote_id,batch_id,provider,provider_event_id,commence_time,snapshot_at,bookmaker_key,market,period,
     side_key,side_name,home_team,away_team,line,american_price,implied_probability,raw_json,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `q-${batchId}`, batchId, 'testbook', 'evt-kc-bal', KICKOFF, receivedAt, 'testbook', 'spreads', 'full_game',
    side, team, 'KC', 'BAL', line, price, 0.5, '{}', 'v1', receivedAt);
}
storeQuote('batch-home', { side: 'home', team: 'KC', line: PACKET_SPREAD, price: -115, receivedAt: BEFORE_CUTOFF });
storeQuote('batch-away', { side: 'away', team: 'BAL', line: -PACKET_SPREAD, price: -105, receivedAt: BEFORE_CUTOFF });

const { freezeT60Packet, PACKET_BOARD_INPUT_COVERAGE } = await import('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-t60-packet.js');
const { autoPickDecisionBoard, autoPickDecisionBoardForPacket, clearAutoPickBoardCache } =
  await import('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-auto-picks.js');

test('freezing the packet captures the tape spread, distinct from the live game_lines spread', () => {
  const packet = freezeT60Packet({ season: SEASON, week: WEEK, home: 'KC', away: 'BAL', kickoff: KICKOFF, mode: 'prospective' });
  assert.equal(packet.error, undefined, JSON.stringify(packet));
  assert.equal(packet.cutoff_at, CUTOFF_AT);
  assert.equal(packet.home_team, 'KC', 'the packet now carries canonical team codes, not just the matchup string');
  assert.equal(packet.away_team, 'BAL');
  assert.ok(packet.summary.eligible.includes('nfl_quote_tape'));
  const quote = packet.sources.find(s => s.source === 'nfl_quote_tape');
  assert.equal(quote.values.length, 2, 'both sides frozen');
  assert.ok(quote.values.every(v => v.line === PACKET_SPREAD || v.line === -PACKET_SPREAD));
});

test('the packet-sourced board runs on the FROZEN quote, not whatever game_lines says right now', () => {
  const packet = freezeT60Packet({ season: SEASON, week: WEEK, home: 'KC', away: 'BAL', kickoff: KICKOFF, mode: 'prospective' });

  const liveBoard = autoPickDecisionBoard(SEASON, WEEK);
  const liveDecision = liveBoard.decisions.find(d => d.matchup === 'BAL at KC');
  assert.ok(liveDecision, 'the live board covers this game');
  assert.equal(liveDecision.feature_snapshot.raw_forecast.market_margin, -LIVE_SPREAD,
    'the live board is anchored to game_lines, confirming the fixture actually diverges as intended');
  assert.equal(liveDecision.feature_snapshot.data_provenance.market_quote, 'game_lines');

  const packetBoard = autoPickDecisionBoardForPacket(packet);
  assert.equal(packetBoard.decisions.length, 1, 'scoped to exactly the one game this packet is for');
  const d = packetBoard.decisions[0];
  assert.equal(d.matchup, 'BAL at KC');
  assert.equal(d.feature_snapshot.raw_forecast.market_margin, -PACKET_SPREAD,
    'the packet-sourced board is anchored to the FROZEN tape quote, not game_lines');
  assert.notEqual(d.feature_snapshot.raw_forecast.market_margin, liveDecision.feature_snapshot.raw_forecast.market_margin,
    'proving the two paths genuinely used different market numbers, not coincidentally the same one');

  // Disclosure, not silence: every input this stage did and did not source
  // from the packet is named on the result.
  assert.equal(d.feature_snapshot.data_provenance.market_quote, 'frozen_packet');
  assert.equal(d.feature_snapshot.data_provenance.market_spread_and_total.home_spread, 'frozen_packet');
  assert.equal(d.feature_snapshot.data_provenance.game_context, 'game_lines',
    'weather/rest/div/neutral context is genuinely not in this packet\'s schema yet, and that must say so');
  assert.equal(packetBoard.packet_provenance.market_quote.book, 'testbook');
  assert.deepEqual(packetBoard.packet_provenance.schema_coverage, PACKET_BOARD_INPUT_COVERAGE);

  // The reproducibility claim itself: mutate the live table AFTER the freeze
  // and confirm the packet-sourced board does not move. If this ever reads
  // game_lines again, this is the assertion that catches it.
  run(`UPDATE game_lines SET spread=-11, spread_odds=-130 WHERE season=? AND week=? AND team='KC'`, SEASON, WEEK);
  clearAutoPickBoardCache();
  const packetBoard2 = autoPickDecisionBoardForPacket(packet);
  assert.equal(packetBoard2.decisions[0].feature_snapshot.raw_forecast.market_margin, -PACKET_SPREAD,
    'independent of what the live table now says, per the VALIDATE requirement');
});

test('a game with nothing eligible in the packet abstains honestly instead of reading game_lines', () => {
  // Deliberately no quote-tape rows at all for SF@SEA.
  const packet = freezeT60Packet({ season: SEASON, week: WEEK, home: 'SF', away: 'SEA', kickoff: KICKOFF, mode: 'prospective' });
  assert.equal(packet.error, undefined, JSON.stringify(packet));
  assert.ok(!packet.summary.eligible.includes('nfl_quote_tape'));
  assert.ok(packet.summary.missing.includes('nfl_quote_tape'));

  // A live line exists for this same game -- proving it is not silently used.
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,spread_odds,total)
       VALUES (?,?,?,?,1,-4,-110,44)`, SEASON, WEEK, 'SF', 'SEA');
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,spread_odds,total)
       VALUES (?,?,?,?,0,4,-110,44)`, SEASON, WEEK, 'SEA', 'SF');

  const board = autoPickDecisionBoardForPacket(packet);
  assert.equal(board.decisions.length, 1, 'computationStatus can still be "complete": the model looked and had nothing');
  const d = board.decisions[0];
  assert.equal(d.line, null);
  assert.equal(d.eligible, false);
  assert.equal(d.abstention_reason, 'missing_line');
  assert.equal(d.feature_snapshot.raw_forecast.market_margin, null,
    'must NOT have quietly picked up the live -4 spread from game_lines');
  assert.equal(d.feature_snapshot.data_provenance.market_quote_status, 'ineligible');
});

test('a packet frozen before this stage (no home_team/away_team) refuses to guess, rather than fall back live', () => {
  const packet = freezeT60Packet({ season: SEASON, week: WEEK, home: 'KC', away: 'BAL', kickoff: KICKOFF, mode: 'prospective' });
  delete packet.home_team; delete packet.away_team; // simulate an old packet_json row
  const board = autoPickDecisionBoardForPacket(packet);
  assert.equal(board.decisions.length, 0);
  assert.match(board.packet_error, /home_team\/away_team/);
});

 test('review: same frozen packet changes when a live total changes after restart/cache reset', async () => {
  const { clearEnsembleCache } = await import('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/nfl-ensemble.js');
  const packet = freezeT60Packet({ season: SEASON, week: WEEK, home: 'KC', away: 'BAL', kickoff: KICKOFF, mode: 'prospective' });
  clearEnsembleCache();
  const first = autoPickDecisionBoardForPacket(packet);
  run(`UPDATE game_lines SET total=77 WHERE season=? AND week=? AND team='KC'`,SEASON,WEEK);
  clearEnsembleCache();
  const second = autoPickDecisionBoardForPacket(packet);
  const a=first.decisions[0].feature_snapshot, b=second.decisions[0].feature_snapshot;
  assert.notDeepEqual(a,b,'Confirms frozen packet does not reproduce the complete board.');
  const changed=Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
  console.log('REVIEW_RESULT '+JSON.stringify({probe:'same_packet_live_total_mutation',changed_fields:changed,before:Object.fromEntries(changed.map(k=>[k,a[k]])),after:Object.fromEntries(changed.map(k=>[k,b[k]]))}));
 });
