/**
 * FIX-09 eval seams: every EVAL grader reads what its writer actually writes.
 *
 *   E1  trade_outcomes: observed rows + app_proposed rows that were SENT
 *       (sent_at, CLONE-01b #239); dedup on matched_tx_id first, then the
 *       72 h fallback for sent, unmatched app rows only. offer_log is gone.
 *   E2  trade_outcomes: sent app_proposed rows with a price_band (083).
 *   E3  title_odds_snapshots: a VIEW (083) over served_numbers (#243) with
 *       outcomes from the league history tables, NULL until the season ends.
 *   E5  campaign_steps (083).
 *   E6  follow_ledger (SELF-01a #245) joined to rec_ledger (GR-01 #174).
 *   E4/E7 stay not_enough_data, naming the unit that will feed them.
 *
 * Migration 083 runs FIRST here, before the sibling PRs' tables exist, to pin
 * that it does not depend on their merge order. Those tables are then created
 * with the exact DDL of their own migrations (080, 081, 071; 083 itself
 * carries 079's served_numbers).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-eval-seams-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_E4_REPLAY_JSON = path.join(temp, 'no-such-replay.json');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const L = await import('../server/services/eval/e1-league.js');
const E1 = await import('../server/services/eval/e1.js');
const E2 = await import('../server/services/eval/e2.js');
const E3 = await import('../server/services/eval/e3.js');
const E4 = await import('../server/services/eval/e4.js');
const E5 = await import('../server/services/eval/e5.js');
const E6 = await import('../server/services/eval/e6.js');
const E7 = await import('../server/services/eval/e7.js');
const M083 = await import('../server/migrations/083_eval_seams.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const iso = (day, hour = 0) => new Date(Date.UTC(2026, 8, 1 + day, hour)).toISOString();
const cols = t => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(c => c.name);
/** Which sibling PRs' schema this tree already carries (080 offer loop, 082 follow ledger). */
const SIBLINGS = { sent: cols('trade_outcomes').includes('sent_at'), follow: cols('follow_ledger').length > 0 };

// ------------------------------------------------------------ before siblings
test('083 is applied and every reader names the missing sibling source instead of throwing', () => {
  assert.ok(cols('trade_outcomes').includes('price_band'));
  assert.ok(cols('trade_outcomes').includes('move_id'));
  assert.ok(cols('campaign_steps').includes('predicted_se'));
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'title_odds_snapshots'`).get());
  // served_numbers comes with 083 (079's DDL), so the view reads cleanly and
  // a table rename elsewhere in the database is not blocked by it.
  assert.deepEqual(cols('served_numbers'), ['id', 'league_id', 'surface', 'entity', 'field', 'value', 'model',
    'model_version', 'as_of', 'served_at', 'request_id', 'trigger', 'season', 'week']);
  const e3 = E3.load(db);
  assert.deepEqual(e3.rows, []);
  assert.equal(e3.reason ?? null, null);
  db.exec('CREATE TABLE rename_probe (x); ALTER TABLE rename_probe RENAME TO rename_probe_2; DROP TABLE rename_probe_2');
  // Only while the sibling PRs have not landed: on a tree that carries 080/082
  // their tables exist from the start and there is nothing missing to name.
  if (!SIBLINGS.follow) assert.match(E6.load(db).reason, /follow_ledger/);
  if (!SIBLINGS.sent) {
    const e1 = E1.load(db);
    assert.match(e1.app_arm ?? '', /sent_at/, 'without sent_at no app row can be shown to have been sent');
    assert.match(E2.load(db).reason, /sent_at/);
  }
});

test('readSource reports a view whose table is missing as a missing source, and rethrows anything else', async () => {
  const { readSource } = await import('../server/services/eval/common.js');
  db.exec('CREATE VIEW probe_view AS SELECT x FROM probe_missing');
  try {
    const r = readSource(db, 'probe_view', ['x']);
    assert.equal(r.ok, false);
    assert.match(r.reason, /probe_view reads probe_missing, which is not built yet/);
    assert.throws(() => readSource({ prepare: q => (/sqlite_master/.test(q) ? { get: () => ({}) } : { all: () => { throw new Error('disk I/O error'); } }) }, 't', ['x']), /disk I\/O/);
  } finally {
    db.exec('DROP VIEW probe_view');
  }
});

// The sibling PRs' tables, as their own migrations create them.
test('the sibling PR tables arrive after 083 (any merge order works)', () => db.exec(`
  ${SIBLINGS.sent ? '' : `ALTER TABLE trade_outcomes ADD COLUMN sent_at TEXT;
  ALTER TABLE trade_outcomes ADD COLUMN matched_tx_id TEXT;
  ALTER TABLE trade_outcomes ADD COLUMN settle_reason TEXT;`}
  CREATE TABLE IF NOT EXISTS rec_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, league_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trade', 'lineup', 'waiver', 'scenario')),
    disposition TEXT NOT NULL DEFAULT 'shown' CHECK (disposition IN ('shown', 'considered_not_shown')),
    made_at TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL CHECK (week >= 1),
    inputs_hash TEXT NOT NULL, predicted_json TEXT NOT NULL, baseline_call_json TEXT,
    horizon INTEGER NOT NULL CHECK (horizon >= 1), graded_at TEXT, outcome_json TEXT, score REAL,
    CHECK ((graded_at IS NULL) = (outcome_json IS NULL)));
  CREATE TABLE IF NOT EXISTS follow_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, league_id INTEGER NOT NULL, team_id TEXT,
    season INTEGER NOT NULL, week INTEGER NOT NULL CHECK (week >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('start_sit', 'waiver', 'trade', 'next_move')),
    action TEXT NOT NULL CHECK (action IN ('start_sit', 'waiver', 'trade')),
    decision_key TEXT NOT NULL, rec_ledger_hash TEXT,
    source TEXT NOT NULL CHECK (source IN ('live', 'backfill')), shown_at TEXT NOT NULL,
    as_of_json TEXT NOT NULL, pick_json TEXT NOT NULL, alternative_json TEXT NOT NULL,
    margin REAL, epsilon REAL, near_tie INTEGER CHECK (near_tie IN (0, 1)),
    outcome TEXT CHECK (outcome IN ('follow', 'ignore', 'no_action')),
    complied INTEGER CHECK (complied IN (0, 1)), basis TEXT, matched_json TEXT,
    resolved_at TEXT, unresolved_reason TEXT,
    CHECK ((outcome IS NULL) = (resolved_at IS NULL)));
`));

// ------------------------------------------------------------ migration 083
test('083: price_band takes only below / at_point / above; campaign_steps pairs realized with realized_at', () => {
  const ins = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, model_p_accept, model_basis, status,
    price_band, created_at) VALUES (9, 2026, 'app_proposed', 0.5, 'heuristic_anchored', 'proposed', ?, 'x')`);
  for (const b of ['below', 'at_point', 'above', null]) ins.run(b);
  assert.throws(() => ins.run('at'), /CHECK/, "the old 'at' spelling is not a band");
  const step = db.prepare(`INSERT INTO campaign_steps (league_id, move_id, step_index, predicted_title_odds_gain,
    realized_title_odds_gain, realized_at, created_at) VALUES (9, 'm1', ?, 1.5, ?, ?, 'x')`);
  step.run(0, null, null);
  step.run(1, 0.8, '2026-10-01');
  assert.throws(() => step.run(2, 0.8, null), /CHECK/, 'a realized gain says when it was realized');
  assert.throws(() => step.run(1, null, null), /UNIQUE/, 'one row per (league, move, step)');
  db.exec(`DELETE FROM trade_outcomes WHERE league_id = 9; DELETE FROM campaign_steps WHERE league_id = 9`);
});

test('083 down refuses to drop campaign steps or price bands that hold evidence', () => {
  db.exec(`INSERT INTO campaign_steps (league_id, move_id, step_index, predicted_title_odds_gain, created_at)
    VALUES (9, 'm1', 0, 1, 'x')`);
  assert.throws(() => M083.down(db), /rollback refused: 1 campaign_steps/);
  db.exec('DELETE FROM campaign_steps WHERE league_id = 9');
});

// ------------------------------------------------------------ E1
test('E1: an UNSENT app_proposed row no longer suppresses the observed ESPN row it resembles', () => {
  const unsent = { league_id: 7, season: 2026, source: 'app_proposed', proposer_team_id: '1', counterparty_team_id: '3',
    proposed_at: iso(3), model_p_accept: 0.4, status: 'declined', sent_at: null };
  const espn = { league_id: 7, season: 2026, source: 'observed', proposer_team_id: '1', counterparty_team_id: '3',
    proposed_at: iso(3, 1), model_p_accept: null, status: 'accepted', espn_tx_id: '555' };
  const { offers, excluded } = L.mergeOffers({ rows: [unsent, espn] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].source, 'observed', 'the ESPN row is the evidence; the suggestion was never sent');
  assert.equal(excluded.espn_copy_of_app_offer, 0);
  assert.equal(excluded.unsent_app_offer, 1);
});

test('E1 dedup: matched_tx_id drops exactly the matched ESPN row; the 72 h fallback is for sent, unmatched rows only', () => {
  const base = { league_id: 7, season: 2026, proposer_team_id: '1', counterparty_team_id: '3' };
  const matched = { ...base, source: 'app_proposed', proposed_at: iso(3), sent_at: iso(3), matched_tx_id: '600', model_p_accept: 0.4, status: 'declined' };
  const itsCopy = { ...base, source: 'observed', proposed_at: iso(3, 2), status: 'declined', espn_tx_id: '600' };
  // A second, different ESPN offer to the same manager inside 72 h: a matched
  // app row has its copy already and must not swallow this one too.
  const another = { ...base, source: 'observed', proposed_at: iso(4), status: 'accepted', espn_tx_id: '601' };
  let r = L.mergeOffers({ rows: [matched, itsCopy, another] });
  assert.deepEqual(r.offers.map(o => o.espn_tx_id ?? o.source).sort(), ['601', 'app_proposed']);
  assert.equal(r.excluded.espn_copy_of_app_offer, 1);

  // The copy may also arrive from league_transactions_raw before it is settled.
  const items = JSON.stringify([{ fromTeamId: 1, toTeamId: 3 }, { fromTeamId: 3, toTeamId: 1 }]);
  const raw = [
    { league_id: 7, season: 2026, tx_id: '600', type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', team_id: 1, related_tx_id: null, proposed_at: iso(3, 2), items_json: items },
    { league_id: 7, season: 2026, tx_id: '600d', type: 'TRADE_DECLINE', execution_type: 'EXECUTE', team_id: 3, related_tx_id: '600', proposed_at: iso(3, 5), items_json: null },
  ];
  r = L.mergeOffers({ rows: [matched], raw });
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].source, 'app_proposed');

  // Sent but not yet matched: the 72 h fallback claims ONE ESPN copy, the earliest.
  const sentOnly = { ...matched, matched_tx_id: null };
  r = L.mergeOffers({ rows: [sentOnly, { ...itsCopy, espn_tx_id: '700' }, { ...another, espn_tx_id: '701' }] });
  assert.equal(r.excluded.espn_copy_of_app_offer, 1, 'one sent offer has one ESPN copy');
  assert.deepEqual(r.offers.map(o => o.espn_tx_id ?? o.source).sort(), ['701', 'app_proposed']);
});

test('E1 load: app arm = sent app_proposed rows; offer_log is not read even when a table of that name exists', () => {
  const ins = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
    proposed_at, model_p_accept, model_basis, status, espn_tx_id, sent_at, matched_tx_id, created_at)
    VALUES (1, 2026, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, 'x')`);
  for (let i = 0; i < 6; i += 1) {
    ins.run('app_proposed', String(i), iso(i), 0.3, 'heuristic_anchored', i % 2 ? 'accepted' : 'declined', null, iso(i), `t${i}`);
  }
  ins.run('app_proposed', '8', iso(8), 0.3, 'heuristic_anchored', 'declined', null, null, null); // suggested, never sent
  ins.run('observed', '8', iso(8, 1), null, null, 'accepted', 'obs8', null, null);                  // a real ESPN offer
  ins.run('observed', '0', iso(0, 1), null, null, 'declined', 't0', null, null);                    // copy of sent t0
  db.exec(`CREATE TABLE offer_log (league_id INTEGER, counterparty_team_id TEXT, proposed_at TEXT, model_p_accept REAL, status TEXT, idea_id TEXT);
    INSERT INTO offer_log VALUES (1, '9', '${iso(9)}', 0.6, 'accepted', 'fresh')`);
  const { offers, sources, excluded } = E1.load(db);
  assert.deepEqual(sources, ['trade_outcomes']);
  assert.equal(offers.length, 7, '6 sent app offers + the observed offer the unsent suggestion used to hide');
  assert.equal(offers.filter(o => o.source === 'observed').length, 1);
  assert.equal(excluded.espn_copy_of_app_offer, 1);
  assert.equal(excluded.unsent_app_offer, 0, 'the unsent row is filtered in SQL, never read');
  db.exec('DROP TABLE offer_log');
});

// ------------------------------------------------------------ E2
test('E2 reads sent, priced app offers from trade_outcomes, in send order', () => {
  const ins = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, counterparty_team_id, proposed_at,
    model_p_accept, model_basis, status, price_band, sent_at, created_at)
    VALUES (3, 2026, 'app_proposed', ?, ?, ?, 'heuristic_anchored', ?, ?, ?, 'x')`);
  for (let i = 0; i < 12; i += 1) ins.run(String(i % 4), iso(i), 0.5, i % 2 ? 'accepted' : 'declined', 'at_point', iso(i, 1));
  ins.run('1', iso(13), 0.2, 'declined', 'below', iso(13, 1));
  ins.run('1', iso(14), 0.5, 'accepted', 'at_point', null); // priced but never sent
  ins.run('1', iso(15), 0.5, 'accepted', null, iso(15, 1)); // sent, no band: not an E2 row
  const { rows, reason } = E2.load(db);
  assert.equal(reason ?? null, null);
  const league3 = rows.filter(r => r.league_id === 3);
  assert.equal(league3.length, 13);
  const r = E2.run(db);
  assert.equal(r.detail.at_yes_point, 12);
  assert.equal(r.detail.below_yes_point, 1);
  assert.equal(r.status, 'not_enough_data');
  assert.equal(r.n, 12);
});

test("E2 grades the 'at_point' band; the retired 'at' spelling is not graded", () => {
  const at = Array.from({ length: 12 }, (_, i) => ({ league_id: 1, counterparty_team_id: '1', model_p_accept: 0.5, price_band: 'at_point', status: i % 2 ? 'accepted' : 'declined', sent_at: iso(i) }));
  assert.equal(E2.grade(at).n, 12);
  assert.equal(E2.grade(at.map(o => ({ ...o, price_band: 'at' }))).n, 0);
});

// ------------------------------------------------------------ E3-live
test('E3-live reads title_odds_snapshots: weekly title-odds rows pivoted per team; outcomes NULL until the season ends', () => {
  db.prepare(`INSERT INTO leagues (id, platform, league_id, season, payload) VALUES (4, 'espn', 'x4', 2026, ?)`)
    .run(JSON.stringify({ settings: { scheduleSettings: { playoffTeamCount: 2 } } }));
  const sn = db.prepare(`INSERT INTO served_numbers (league_id, surface, entity, field, value, model, served_at, request_id, trigger, season, week)
    VALUES (4, ?, ?, ?, ?, 'season-sim.simulateSeason', ?, ?, ?, 2026, ?)`);
  for (const [team, pt, pp] of [[1, 0.5, 0.9], [2, 0.3, 0.7], [3, 0.2, 0.4]]) {
    sn.run('title_odds', `team:${team}`, 'title_odds', pt, iso(40), 'weekly:w7', 'weekly', 7);
    sn.run('title_odds', `team:${team}`, 'playoff_odds', pp, iso(40), 'weekly:w7', 'weekly', 7);
    sn.run('title_odds', `team:${team}`, 'title_odds_lo', pt / 2, iso(40), 'weekly:w7', 'weekly', 7);
    sn.run('title_odds', `team:${team}`, 'title_odds', 0.99, iso(41), 'req-page', 'request', 7);  // a page view, not the weekly snapshot
  }
  sn.run('trade_find', 'team:1', 'title_odds', 0.99, iso(40), 'weekly:w7', 'weekly', 7);           // another surface
  let rows = db.prepare('SELECT * FROM title_odds_snapshots WHERE league_id = 4 ORDER BY team_id').all();
  assert.equal(rows.length, 3, 'one row per team per weekly snapshot');
  assert.deepEqual(rows.map(r => [r.team_id, r.week, r.p_title, r.p_playoffs]), [['1', 7, 0.5, 0.9], ['2', 7, 0.3, 0.7], ['3', 7, 0.2, 0.4]]);
  assert.ok(rows.every(r => r.made_playoffs === null && r.won_title === null), 'no history rows yet');

  // In season: ESPN reports rankCalculatedFinal 0 and no playoff week is scored.
  const team = db.prepare(`INSERT OR REPLACE INTO league_season_teams (league_id, season, roster_id, final_rank, playoff_seed, captured_at)
    VALUES (4, 2026, ?, ?, ?, 'x')`);
  team.run('1', 0, 1); team.run('2', 0, 2); team.run('3', 0, 3);
  rows = db.prepare('SELECT * FROM title_odds_snapshots WHERE league_id = 4').all();
  assert.ok(rows.every(r => r.made_playoffs === null && r.won_title === null), 'the season has not ended');

  // Final ranks set, but the playoffs never scored: a seed fallback, not an end.
  team.run('1', 2, 1); team.run('2', 1, 2); team.run('3', 3, 3);
  rows = db.prepare('SELECT * FROM title_odds_snapshots WHERE league_id = 4').all();
  assert.ok(rows.every(r => r.made_playoffs === null), 'no playoff week scored yet');

  // Playoffs under way: a playoff week is scored, final ranks are still 0.
  team.run('1', 0, 1); team.run('2', 0, 2); team.run('3', 0, 3);
  db.prepare(`INSERT INTO league_week_scores (league_id, season, week, roster_id, points, is_playoff, captured_at)
    VALUES (4, 2026, 16, '2', 120, 1, 'x')`).run();
  rows = db.prepare('SELECT * FROM title_odds_snapshots WHERE league_id = 4').all();
  assert.ok(rows.every(r => r.made_playoffs === null && r.won_title === null), 'playoffs are not over');

  team.run('1', 2, 1); team.run('2', 1, 2); team.run('3', 3, 3);
  rows = db.prepare('SELECT team_id, made_playoffs, won_title FROM title_odds_snapshots WHERE league_id = 4 ORDER BY team_id').all();
  assert.deepEqual(rows.map(r => [r.team_id, r.made_playoffs, r.won_title]), [['1', 1, 0], ['2', 1, 1], ['3', 0, 0]]);

  const { rows: loaded, reason } = E3.load(db);
  assert.equal(reason ?? null, null);
  assert.equal(loaded.filter(r => r.league_id === 4).length, 3);
  const [, live] = E3.run(db);
  assert.equal(live.status, 'not_enough_data');
  assert.equal(live.n, 3);
});

// ------------------------------------------------------------ E5
test('E5 reads campaign_steps: only steps with a realized gain are graded', () => {
  const ins = db.prepare(`INSERT INTO campaign_steps (league_id, move_id, step_index, trade_outcome_id,
    predicted_title_odds_gain, predicted_se, realized_title_odds_gain, realized_at, created_at)
    VALUES (5, ?, 0, NULL, 1.2, 0.4, ?, ?, 'x')`);
  for (let i = 0; i < 4; i += 1) ins.run(`m${i}`, 1 + i / 10, iso(i));
  ins.run('m-open', null, null); // predicted when the offer was sent; not settled yet
  const { rows, reason } = E5.load(db);
  assert.equal(reason ?? null, null);
  assert.equal(rows.length, 5);
  const r = E5.run(db);
  assert.equal(r.status, 'not_enough_data');
  assert.equal(r.n, 4);
  assert.match(r.needs_text, /^needs 11 more steps/);
  assert.equal(r.detail.awaiting_realized, 1);
});

// ------------------------------------------------------------ E6
test('E6 reads follow_ledger joined to rec_ledger on the hash: follow vs ignore, near-tie from the follow ledger', () => {
  const rec = db.prepare(`INSERT INTO rec_ledger (league_id, kind, made_at, season, week, inputs_hash, predicted_json,
    horizon, graded_at, outcome_json, score) VALUES (6, 'lineup', 'x', 2026, ?, ?, '{}', ?, ?, ?, ?)`);
  const fol = db.prepare(`INSERT INTO follow_ledger (league_id, season, week, kind, action, decision_key, rec_ledger_hash,
    source, shown_at, as_of_json, pick_json, alternative_json, near_tie, outcome, resolved_at)
    VALUES (6, 2026, ?, 'start_sit', 'start_sit', ?, ?, 'live', 'x', '{}', '{}', '{}', ?, ?, ?)`);
  const plan = [['h1', 1, 1, 'follow', 3], ['h2', 1, 1, 'ignore', -1], ['h3', 2, 0, 'follow', 5],
    ['h4', 2, 1, 'no_action', 9], ['h5', 3, 1, null, 9]];
  for (const [h, w, nt, outcome, score] of plan) {
    rec.run(w, h, 1, '2026-10-01', '{}', score);
    rec.run(w, h, 2, '2026-10-08', '{}', score + 100); // a later horizon of the same call: not a second decision
    fol.run(w, `k-${h}`, h, nt, outcome, outcome ? 'x' : null);
  }
  fol.run(3, 'k-orphan', 'no-such-hash', 1, 'follow', 'x'); // no graded call behind it
  const { rows, reason } = E6.load(db);
  assert.equal(reason ?? null, null);
  assert.equal(rows.length, 3, 'follow + ignore only; no_action, unresolved and unjoined rows are out');
  assert.deepEqual(rows.map(r => [r.outcome, r.near_tie, r.score]).sort(),
    [['follow', 0, 5], ['follow', 1, 3], ['ignore', 1, -1]], 'the shortest graded horizon, once per decision');
  const r = E6.run(db);
  assert.equal(r.status, 'not_enough_data');
  assert.deepEqual(r.detail.near_tie, { followed: 1, ignored: 1, weeks: 1 });
});

// ------------------------------------------------------------ E4 / E7
test('E4 and E7 stay not_enough_data and name the unit that will feed them', () => {
  const e4 = E4.run(db);
  assert.equal(e4.status, 'not_enough_data');
  assert.match(e4.needs_text, /E4 planner replay/);
  const e7 = E7.run(db);
  assert.equal(e7.status, 'not_enough_data');
  assert.match(e7.needs_text, /PROJ-04-a/);
});
