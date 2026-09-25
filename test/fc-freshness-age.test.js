/**
 * FC-FRESH-AGE (batch D item 8a): a FantasyCalc price is fetched daily, so whether it is current is an
 * AGE rule, never a per-week one, and the window is the daily budget plus the refresh loop's slack
 * (the job is due at 24 h but runs on the loop's next tick). The redraft values Nick's rules are
 * priced on (player_metrics 'fc_value', fc-value.js) get a Data freshness row of their own.
 * Made-up rows only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fc-fresh-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const F = await import('../server/services/data-freshness.js');
const H = await import('../server/services/dynasty-value-history.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const ctx = { currentSeason: 2026, currentWeek: 3, database: db };
const entry = table => F.servedTablesRegistry().find(e => e.table === table);
const ago = minutes => `datetime('now', '-${minutes} minutes')`;
db.exec('PRAGMA foreign_keys = OFF');
const setFc = minutes => {
  run(`DELETE FROM player_metrics`);
  db.exec(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (1, 'fc_value', 100, ${ago(minutes)}), (2, 'fc_value', 90, ${ago(minutes)})`);
};

test('the window is an age: the daily budget plus the loop slack, one constant', () => {
  assert.equal(H.MARKET_MAX_AGE_MINUTES, 24 * 60, 'the job still runs daily');
  assert.equal(H.MARKET_FRESH_MINUTES, H.MARKET_MAX_AGE_MINUTES + H.MARKET_FRESH_SLACK_MINUTES);
  assert.equal(H.MARKET_FRESH_SLACK_MINUTES, 60);
  for (const t of ['dynasty_values', 'player_metrics']) {
    const e = entry(t);
    assert.ok(e, `${t} has a Data freshness row`);
    assert.equal(e.week_col, null, `${t}: no week column in the rule`);
    assert.deepEqual(e.current_rule.bind, [], `${t}: binds no season or week`);
    assert.match(e.current_rule.predicate, new RegExp(`-${H.MARKET_FRESH_MINUTES} minutes`));
  }
});

test('player_metrics fc_value: fresh just fetched and on the next loop tick after 24 h, stale past the slack', () => {
  const e = entry('player_metrics');
  assert.equal(F.tableFreshness(e, ctx).status, 'empty', 'no rows yet');
  setFc(5);
  assert.equal(F.tableFreshness(e, ctx).status, 'fresh');
  setFc(24 * 60 + 10); // due at 24 h, the loop's tick runs it a few minutes later: on schedule
  assert.equal(F.tableFreshness(e, ctx).status, 'fresh', 'a daily price 24 h 10 min old is not late');
  setFc(24 * 60 + 90);
  assert.equal(F.tableFreshness(e, ctx).status, 'stale', 'past the slack it is stale');
  // Any week passed in changes nothing: the rule is an age.
  assert.equal(F.tableFreshness(e, { ...ctx, currentWeek: 17 }).status, 'stale');
  setFc(5);
  assert.equal(F.tableFreshness(e, { ...ctx, currentWeek: 1 }).status, 'fresh');
});

test('player_metrics fc_value: another source\'s fresh rows neither make it fresh nor show as its stamp', () => {
  const e = entry('player_metrics');
  setFc(3 * 24 * 60);
  db.exec(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (1, 'sleeper_rank', 5, datetime('now')), (3, 'ffc_adp', 12, datetime('now'))`);
  const f = F.tableFreshness(e, ctx);
  assert.equal(f.status, 'stale', 'a fresh ADP pull does not make the trade-rule currency fresh');
  assert.equal(f.row_count, 2, 'only the fc_value rows are counted');
  const stamp = db.prepare(`SELECT MAX(fetched_at) AS w FROM player_metrics WHERE source = 'fc_value'`).get().w;
  assert.equal(f.last_write, stamp, 'the stamp shown is the fc_value fetch, not the newest of any source');
});

test('dynasty_values and marketAsOf use the same window: 24 h 30 min is fresh, 26 h is stale', () => {
  const fmt = 'rd_sf1_t10_ppr1';
  const put = minutes => {
    run(`DELETE FROM dynasty_values`);
    db.exec(`INSERT INTO dynasty_values (format_key, player_id, value, fetched_at) VALUES ('${fmt}', 1, 100, ${ago(minutes)})`);
  };
  put(24 * 60 + 30);
  assert.equal(F.tableFreshness(entry('dynasty_values'), ctx).status, 'fresh');
  const m = H.marketAsOf(fmt);
  assert.equal(m.state, 'fresh');
  assert.equal(m.stale_after_hours, 25);
  put(26 * 60);
  assert.equal(F.tableFreshness(entry('dynasty_values'), ctx).status, 'stale');
  assert.equal(H.marketAsOf(fmt).state, 'stale');
});
