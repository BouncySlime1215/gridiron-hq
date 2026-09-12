import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Giant Plan section 3, item 5: recordNflShadowBoard must refuse to capture a
 * "shadow" (paper-forward) decision for a game that has already been decided
 * or has already kicked off, mirroring forward-ledger.js's recordForwardPick
 * guard. A shadow row frozen after the fact is not evidence of anything --
 * nothing downstream could tell it apart from a real prospective observation.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-shadow-kickoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const auto = await import('../server/services/nfl-auto-picks.js');
let boards = [];
mock.module('../server/services/nfl-auto-picks.js', { namedExports: {
  ...auto, autoPickDecisionBoard: () => boards.shift() ?? { decisions: [], selected: [], policy: { id: 'p', version: '1' }, engine_mode: 'champion' }
} });

const { recordNflShadowBoard } = await import('../server/services/shadow-ledger.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertGame = db.prepare(`INSERT INTO game_lines
  (season,week,team,opponent,home,spread,gameday,gametime,team_score,opp_score)
  VALUES (?,?,?,?,1,?,?,?,?,?)`);

function decision(home, away, overrides = {}) {
  return { home_team: home, away_team: away, market: 'spread', selection: home,
    model_probability: 0.55, implied_probability: 0.5, disagreement: 1.5,
    eligible: true, abstention_reason: null, line: -3, american_price: -110,
    quote_at: '2026-09-13T16:00:00.000Z', feature_snapshot: {}, ...overrides };
}
function boardWith(decisions, engineMode = 'champion') {
  return { decisions, selected: decisions.filter(d => d.eligible),
    policy: { id: 'shadow-test', version: '1' }, engine_mode: engineMode };
}

test('a game already final is never captured, even though it is the first time this game/market/model is seen', () => {
  insertGame.run(2026, 1, 'BUF', 'NYJ', -3, '2026-09-13', '13:00', 27, 20); // final
  boards = [boardWith([decision('BUF', 'NYJ')]), boardWith([decision('BUF', 'NYJ')])];
  const result = recordNflShadowBoard(2026, 1, '2026-09-14T00:00:00.000Z');
  assert.equal(result.recorded, 0, 'a finished game must not be recorded as a forward observation');
  assert.equal(result.already_played, 2, 'both engine-mode boards saw the same already-played game');
  const stored = db.prepare(`SELECT COUNT(*) n FROM shadow_decisions WHERE event_key='2026:1:BUF:NYJ'`).get().n;
  assert.equal(stored, 0);
});

test('a game past its kickoff wall clock, still scoreless in the database, is also refused', () => {
  // Kickoff 2026-09-13T17:00:00Z, captured well after -- score not yet synced.
  insertGame.run(2026, 2, 'KC', 'LV', -4, '2026-09-13', '13:00', null, null);
  boards = [boardWith([decision('KC', 'LV')]), boardWith([decision('KC', 'LV')])];
  const result = recordNflShadowBoard(2026, 2, '2026-09-13T20:00:00.000Z');
  assert.equal(result.recorded, 0);
  assert.equal(result.already_played, 2);
});

test('a game genuinely ahead of kickoff is recorded normally', () => {
  insertGame.run(2026, 3, 'PHI', 'DAL', -4, '2026-09-20', '13:00', null, null);
  boards = [boardWith([decision('PHI', 'DAL')]),
    boardWith([decision('PHI', 'DAL', { eligible: false, abstention_reason: 'test' })], 'challenger')];
  const result = recordNflShadowBoard(2026, 3, '2026-09-18T12:00:00.000Z');
  assert.equal(result.already_played, 0);
  assert.equal(result.recorded, 2, 'one per engine-mode board, both frozen before kickoff');
  const stored = db.prepare(`SELECT decision FROM shadow_decisions WHERE event_key='2026:3:PHI:DAL' ORDER BY rowid`).all();
  assert.equal(stored.length, 2);
});
