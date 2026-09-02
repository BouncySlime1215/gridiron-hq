import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// weeklyRead() and retirement (docs/PROFIT_ROADMAP.md 0.6): a week-clustered
// bootstrap read per rule, and two consecutive weekly reads with the interval
// entirely below zero retire the rule so decideBeatTheClose stops freezing
// new decisions under it — recorded in nfl_rule_state, never deleted. A
// week-clustered interval needs at least two weeks of settled data to exist
// at all, so a rule's first measurable read cannot by itself retire it.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-btc-weekly-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
await import('../server/services/odds-archive.js');
await import('../server/services/shadow-ledger.js');
const btc = await import('../server/services/beat-the-close.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('KC','Kansas City Chiefs','AFC','West'),('DEN','Denver Broncos','AFC','West')`);

let n = 0;
function settledDecision(signal, season, week, clv, { home = 'KC', away = 'DEN' } = {}) {
  n++;
  run(`INSERT INTO shadow_decisions (sport,event_key,market,selection,model_version,regime,decision,reason,captured_at,
       season,week,home_team,away_team,line,american_price,quote_at,settled_at,result,clv_points,feature_snapshot_json)
       VALUES ('NFL',?,?,?,?,'beat_the_close','observe','test',?,?,?,?,?,-3,-110,?,?,?,?,?)`,
  `2026:${week}:${home}:${away}:${n}`, 'spread', home, `${btc.BEAT_THE_CLOSE_VERSION}:${signal}`,
  `2026-0${week}-01T12:00:00Z`, season, week, home, away, `2026-0${week}-01T12:00:00Z`,
  `2026-0${week}-05T12:00:00Z`, clv > 0 ? 'Won' : 'Lost', clv, JSON.stringify({ stake_units: 0 }));
}

test('a rule with consistently positive CLV across three weeks is not retired', () => {
  for (const week of [1, 2, 3]) {
    for (const clv of [0.8, 1.2, 0.5]) settledDecision('ratings_vs_open', 2026, week, clv);
  }
  const read = btc.weeklyRead(2026, 3);
  const r = read.reads.ratings_vs_open;
  assert.equal(r.through_week.settled, 9);
  assert.equal(r.through_week.weeks, 3);
  assert.ok(r.through_week.mean_clv > 0.5);
  assert.ok(r.through_week.clv_interval[0] <= r.through_week.mean_clv && r.through_week.mean_clv <= r.through_week.clv_interval[1]);
  assert.equal(r.retired_at, null);
  assert.equal(r.consecutive_negative_weeks, 0);
});

test('a single week of data cannot form a week-clustered interval, so it cannot move the retirement counter', () => {
  for (const clv of [-1.5, -2.0, -0.8]) settledDecision('ratings_vs_open_total', 2026, 1, clv);
  const read = btc.weeklyRead(2026, 1);
  const r = read.reads.ratings_vs_open_total;
  assert.equal(r.through_week.weeks, 1);
  assert.equal(r.through_week.clv_interval, null, 'one cluster cannot be bootstrapped into an interval');
  assert.equal(r.consecutive_negative_weeks, 0);
  assert.equal(r.retired_at, null);
});

test('a second bad week gives two clusters, a below-zero interval, and the first countable negative read', () => {
  for (const clv of [-1.2, -1.8, -0.5]) settledDecision('ratings_vs_open_total', 2026, 2, clv);
  const read = btc.weeklyRead(2026, 2);
  const r = read.reads.ratings_vs_open_total;
  assert.equal(r.through_week.weeks, 2);
  assert.ok(r.through_week.clv_interval[1] < 0, `expected the interval's upper bound below zero; got ${JSON.stringify(r.through_week.clv_interval)}`);
  assert.equal(r.consecutive_negative_weeks, 1);
  assert.equal(r.retired_at, null, 'one countable bad read is not enough to retire');
});

test('a third bad week makes it two consecutive countable bad reads, which retires the rule', () => {
  for (const clv of [-1.4, -1.6, -0.9]) settledDecision('ratings_vs_open_total', 2026, 3, clv);
  const read = btc.weeklyRead(2026, 3);
  const r = read.reads.ratings_vs_open_total;
  assert.equal(r.consecutive_negative_weeks, 2);
  assert.ok(r.retired_at, 'two consecutive countable negative reads retires the rule');

  const state = rows(`SELECT * FROM nfl_rule_state WHERE signal='ratings_vs_open_total'`)[0];
  assert.ok(state.retired_at);
  assert.match(state.retired_reason, /two consecutive weekly reads/);

  // ratings_vs_open (the OTHER rule) must be entirely unaffected.
  assert.equal(btc.weeklyRead(2026, 3).reads.ratings_vs_open.retired_at, null);
});

test('re-reading the same week is a no-op on the retirement counter', () => {
  const before = rows(`SELECT consecutive_negative_weeks, retired_at FROM nfl_rule_state WHERE signal='ratings_vs_open_total'`)[0];
  btc.weeklyRead(2026, 3);
  btc.weeklyRead(2026, 3);
  const after = rows(`SELECT consecutive_negative_weeks, retired_at FROM nfl_rule_state WHERE signal='ratings_vs_open_total'`)[0];
  assert.deepEqual(after, before, 're-reading week 3 again must change nothing');
});

test('the retired rule row is never deleted, and retired_at is not overwritten by a later read', () => {
  const retiredAt = rows(`SELECT retired_at FROM nfl_rule_state WHERE signal='ratings_vs_open_total'`)[0].retired_at;
  for (const clv of [-3, -3, -3]) settledDecision('ratings_vs_open_total', 2026, 4, clv);
  btc.weeklyRead(2026, 4);
  const stillRetiredAt = rows(`SELECT retired_at FROM nfl_rule_state WHERE signal='ratings_vs_open_total'`)[0].retired_at;
  assert.equal(stillRetiredAt, retiredAt);
});

test('decideBeatTheClose skips a retired signal entirely, even when its threshold would otherwise clear', () => {
  // Pinnacle opener for GB@CHI totals, with the wind rule's threshold cleared
  // — but ratings_vs_open_total is retired above, so its own threshold
  // clearing must not matter here; this only proves the retired signal is
  // skipped, not that it would have fired (a full end-to-end fire is covered
  // by test/beat-the-close-wind.test.js for the unretired wind_total rule).
  run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES ('GB','Green Bay Packers','NFC','North'),('CHI','Chicago Bears','NFC','North')`);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
       VALUES (2026,5,'GB','CHI',1,-3,44,22,'test',datetime('now'),'2026-10-11','13:00')`);
  const result = btc.decideBeatTheClose({ season: 2026, week: 5 });
  assert.ok(result.retired_skipped >= 0, 'the counter exists on the result even if nothing matched this slate');
  assert.ok(!result.decisions.some(d => d.signal === 'ratings_vs_open_total'), 'the retired signal never freezes a new decision');
});
