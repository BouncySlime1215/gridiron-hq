/**
 * The freshness check must fail CLOSED, and it currently fails open.
 *
 * `servedTables()` (#96) emits each rule as `{ sql, params, text }` — a full
 * query returning 1/0. This module was written against `{ predicate, bind,
 * description }` — a bare WHERE fragment. Neither side is wrong on its own; the
 * mismatch is, and the way it breaks is the worst available:
 *
 *   rule.predicate  -> undefined -> predicate = ''
 *   rule.bind       -> undefined -> bind = []
 *   placeholders (0) === bind.length (0)  -> the guard passes
 *   predicate falsy -> currentCount = base.row_count
 *   row_count > 0   -> status = 'fresh'
 *
 * So every table with any row in it reports fresh, whatever season those rows
 * are from, and `stale` becomes unreachable. A registry that loads correctly
 * makes the check less truthful than no registry at all — with the fallback
 * registry the same data reads `stale`, which is right.
 *
 * That is precisely the failure this whole feature exists to prevent: a surface
 * that says the data is current because it never actually asked.
 *
 * The specimen, measured by Scheduler on a real migrated database: player_week_usage
 * loaded for 2021-2025 and nothing for 2026, asked about 2026 week 3. The honest
 * answer is `stale` — there are rows, but none for the season being played.
 *
 * The rules pinned here:
 *   1. A rule in the shipped `{sql, params}` shape is evaluated, not ignored.
 *   2. A rule that is missing, null, or unusable is a FAULT, reported as such.
 *      It is never treated as a passing check. "I could not ask" and "the answer
 *      is yes" must not be the same outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-freshness-contract-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { tableFreshness } = await import('../server/services/data-freshness.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 3;
db.prepare(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`).run();
const pwu = (season, week) =>
  db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, ?, ?)`).run(season, week);

// The specimen: five seasons loaded, nothing for the season being played.
for (let s = 2021; s <= 2025; s++) for (const w of [1, 2, 3]) pwu(s, w);

/** A rule in the shape servedTables() actually emits. */
const SHIPPED_RULE = {
  sql: 'SELECT CASE WHEN EXISTS (SELECT 1 FROM player_week_usage WHERE season = ? AND week <= ?) '
    + 'THEN 1 ELSE 0 END AS ok',
  params: ['season', 'week'],
  text: 'Has weekly usage rows for the season being played, up to the current week.'
};

const entry = rule => ({
  table: 'player_week_usage', label: 'Weekly player usage',
  season_col: 'season', week_col: 'week', updated_col: null, current_rule: rule
});

const check = rule => tableFreshness(entry(rule), {
  currentSeason: SEASON, currentWeek: WEEK, database: db
});

test('a shipped-shape rule is evaluated, so an unplayed season reads stale', () => {
  const r = check(SHIPPED_RULE);
  assert.notEqual(r.status, 'fresh',
    'five seasons of old rows reported as fresh for 2026 — the rule was never evaluated');
  assert.equal(r.status, 'stale');
});

test('the same table reads fresh once the current season has rows', () => {
  pwu(SEASON, 1);
  try {
    assert.equal(check(SHIPPED_RULE).status, 'fresh',
      'the rule is not being evaluated at all, or it can never return true');
  } finally {
    db.prepare(`DELETE FROM player_week_usage WHERE season = ?`).run(SEASON);
  }
});

test('a missing rule is a fault, never a pass', () => {
  for (const rule of [undefined, null, {}]) {
    const r = check(rule);
    assert.notEqual(r.status, 'fresh',
      `a table with no usable rule (${JSON.stringify(rule)}) reported fresh — the check failed open`);
    assert.equal(r.status, 'unknown');
    assert.match(String(r.note ?? ''), /rule/i,
      'nothing says why the status could not be determined');
  }
});

test('an unusable rule is a fault rather than a thrown page', () => {
  // A rule whose params cannot be bound is a registry bug, but it must degrade
  // to a reported fault: one bad entry cannot take the whole panel down.
  const r = check({ sql: 'SELECT 1 AS ok WHERE ? = ?', params: ['season', 'nonsense'] });
  assert.equal(r.status, 'unknown');
  assert.match(String(r.note ?? ''), /rule/i);
});

test('fault is distinguishable from every other state', () => {
  const states = new Set([
    check(SHIPPED_RULE).status,   // stale
    check(null).status            // unknown
  ]);
  assert.equal(states.size, 2, 'a faulted check and a stale table report the same status');
});
