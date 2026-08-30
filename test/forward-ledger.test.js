import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-forward-ledger-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
const { nflKickoffDate } = await import('../server/services/date-util.js');
const { recordForwardPick, settleForwardPicks, forwardLedger } =
  await import('../server/services/forward-ledger.js');
const { planEvidenceWindows } = await import('../server/services/evidence-daemon.js');
const { settleNflShadowDecisions, shadowLedgerSummary } =
  await import('../server/services/shadow-ledger.js');
const { validationFirewall } = await import('../server/services/nfl-evidence.js');
const { nflModelGrowthStatus } = await import('../server/services/nfl-model-growth.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const insertGame = db.prepare(`INSERT INTO game_lines
  (season,week,team,opponent,home,spread,gameday,gametime,team_score,opp_score)
  VALUES (?,?,?,?,1,?,?,?,?,?)`);

test('NFL wall-clock kickoff converts through daylight and standard time', () => {
  assert.equal(nflKickoffDate('2025-09-07', '13:00').toISOString(), '2025-09-07T17:00:00.000Z');
  assert.equal(nflKickoffDate('2025-12-07', '13:00').toISOString(), '2025-12-07T18:00:00.000Z');
  assert.equal(nflKickoffDate('2025-02-31', '13:00'), null);
  assert.equal(nflKickoffDate('2025-09-07', '25:00'), null);
});

test('the forward ledger locks at kickoff even before a score is synced', () => {
  insertGame.run(2026, 1, 'BUF', 'NYJ', -3, '2026-09-13', '13:00', null, null);
  const before = recordForwardPick({
    season: 2026, week: 1, home: 'BUF', away: 'NYJ', side: 'BUF', line: -3,
    recordedAt: '2026-09-13T16:59:59.000Z'
  });
  assert.equal(before.ok, true);

  const after = recordForwardPick({
    season: 2026, week: 1, home: 'BUF', away: 'NYJ', side: 'NYJ', line: 3,
    source: 'late-test', recordedAt: '2026-09-13T17:00:00.000Z'
  });
  assert.match(after.error, /already been played/);
});

test('the ledger refuses fabricated games, sides and lines', () => {
  assert.match(recordForwardPick({
    season: 2026, week: 1, home: 'FAKE', away: 'BUF', side: 'FAKE', line: -3
  }).error, /no matching scheduled game/);
  assert.match(recordForwardPick({
    season: 2026, week: 1, home: 'BUF', away: 'NYJ', side: 'MIA', line: -3,
    source: 'bad-side'
  }).error, /must match/);
  assert.match(recordForwardPick({
    season: 2026, week: 1, home: 'BUF', away: 'NYJ', side: 'BUF', line: 'three',
    source: 'bad-line'
  }).error, /numeric/);
});

test('NFL evidence windows use the real Eastern kickoff and repair queued rows', () => {
  planEvidenceWindows();
  const close = db.prepare(`SELECT event_at,due_at FROM evidence_capture_windows
    WHERE sport='NFL' AND event_key='2026:1:BUF:NYJ' AND horizon='close'`).get();
  assert.equal(close.event_at, '2026-09-13T17:00:00.000Z');
  assert.equal(close.due_at, '2026-09-13T16:55:00.000Z');

  db.prepare(`UPDATE evidence_capture_windows SET event_at='2026-09-13T13:00:00.000Z',
    due_at='2026-09-13T12:55:00.000Z' WHERE sport='NFL'
    AND event_key='2026:1:BUF:NYJ' AND horizon='close'`).run();
  planEvidenceWindows();
  const repaired = db.prepare(`SELECT event_at,due_at FROM evidence_capture_windows
    WHERE sport='NFL' AND event_key='2026:1:BUF:NYJ' AND horizon='close'`).get();
  assert.deepEqual(repaired, close);
});

test('spread CLV compares the backed team handicap in the same coordinate system', () => {
  insertGame.run(2026, 2, 'PHI', 'DAL', -4, '2026-09-20', '13:00', null, null);
  assert.equal(recordForwardPick({
    season: 2026, week: 2, home: 'PHI', away: 'DAL', side: 'PHI', line: -3,
    recordedAt: '2026-09-20T16:00:00.000Z'
  }).ok, true);

  insertGame.run(2026, 3, 'KC', 'LV', -4, '2026-09-27', '13:00', null, null);
  assert.equal(recordForwardPick({
    season: 2026, week: 3, home: 'KC', away: 'LV', side: 'LV', line: 3,
    recordedAt: '2026-09-27T16:00:00.000Z'
  }).ok, true);

  db.prepare(`UPDATE game_lines SET team_score=?,opp_score=? WHERE season=? AND week=? AND team=?`)
    .run(24, 20, 2026, 2, 'PHI');
  db.prepare(`UPDATE game_lines SET team_score=?,opp_score=? WHERE season=? AND week=? AND team=?`)
    .run(20, 18, 2026, 3, 'KC');
  assert.equal(settleForwardPicks().settled, 2);

  const recent = forwardLedger().recent;
  const home = recent.find(p => p.matchup === 'DAL at PHI');
  const away = recent.find(p => p.matchup === 'LV at KC');
  assert.equal(home.result, 'Won');
  assert.equal(home.clv_points, 1, 'PHI -3 should beat a close of PHI -4 by one point');
  assert.equal(away.result, 'Won');
  assert.equal(away.clv_points, -1, 'LV +3 should trail a close of LV +4 by one point');
});

test('shadow decisions become labels without counting horizon copies as independent bets', () => {
  insertGame.run(2026, 4, 'DET', 'GB', -4, '2026-10-04', '13:00', 27, 20);
  const insert = db.prepare(`INSERT INTO shadow_decisions
    (sport,event_key,market,selection,model_version,probability,market_probability,
     uncertainty,regime,decision,reason,captured_at,season,week,home_team,away_team,
     line,american_price,quote_at,feature_snapshot_json)
    VALUES ('NFL',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const args = capturedAt => [
    '2026:4:DET:GB', 'spread', 'DET', 'test-model@1', .54, .5, 2.1,
    'test', 'observe', 'eligible', capturedAt, 2026, 4, 'DET', 'GB', -3, -105,
    capturedAt, '{}'
  ];
  insert.run(...args('2026-10-01T12:00:00.000Z'));
  insert.run(...args('2026-10-04T15:00:00.000Z'));

  const result = settleNflShadowDecisions();
  assert.ok(result.settled >= 2);
  const labels = db.prepare(`SELECT result,clv_points,outcome_json FROM shadow_decisions
    WHERE event_key='2026:4:DET:GB' ORDER BY captured_at`).all();
  assert.equal(labels.length, 2);
  assert.ok(labels.every(label => label.result === 'Won'));
  assert.ok(labels.every(label => label.clv_points === 1));
  assert.ok(labels.every(label => JSON.parse(label.outcome_json).actual_margin === 7));

  const summary = shadowLedgerSummary('NFL');
  assert.equal(summary.selected, 2, 'raw rows remain visible for migration auditing');
  assert.equal(summary.independent_examples, 1, 'horizon copies collapse to one game/market/model example');
  const firewall = validationFirewall();
  assert.equal(firewall.forward.decisions, 1);
  assert.equal(firewall.forward.settled, 1);

  const growth = nflModelGrowthStatus(2026);
  assert.equal(growth.state, 'ingest_due');
  assert.equal(growth.finalized_week, 4);
  assert.equal(growth.learned_through_week, 0);
  assert.ok(growth.sources.some(source => source.required && source.lag_weeks === 4));
});
