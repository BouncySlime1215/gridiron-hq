/**
 * LOVE-RULE (ONE-PLAN section 5 night 5, section 4d night 5).
 *
 * A BUY / PASS / AVOID tag from usage, draft capital and a healthy role. Luck
 * (actual minus expected points) is one sentence with weight 0; TD-over-expected
 * is a sell-high label with weight 0. Shadow behind GRIDIRON_LOVE_TAG: only
 * `_run.inputs.love` is written, never a served field, never a search constraint.
 *
 * Fixtures only: made-up players, ids and numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { loveTag, loveSummary, loveEnabled, LOVE_ENV, LOVE_RULE } =
  await import('../server/services/campaign/love.js');
const { readLoveInputs } = await import('../server/services/campaign/love-inputs.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const healthy = { status: 'healthy', report_status: null, radar: null };
const base = (over = {}) => ({
  player: 1, position: 'WR', games: 3, through: '2026-W3',
  target_share: 0.24, expected_ppg: 13, actual_ppg: 13, expected_tds: 1, actual_tds: 1,
  overall_pick: 40, role: healthy, ...over,
});

test('flag is off by default; only "1" turns it on', () => {
  assert.equal(LOVE_ENV, 'GRIDIRON_LOVE_TAG');
  assert.equal(loveEnabled({}), false);
  assert.equal(loveEnabled({ GRIDIRON_LOVE_TAG: '0' }), false);
  assert.equal(loveEnabled({ GRIDIRON_LOVE_TAG: '1' }), true);
});

test('WR with a strong target share, healthy, mid draft capital: BUY', () => {
  const t = loveTag(base());
  assert.equal(t.tag, 'BUY');
  assert.equal(t.usage.level, 'strong');
  assert.match(t.usage.basis, /target share/);
});

test('WR with weak share and no early draft capital: AVOID', () => {
  assert.equal(loveTag(base({ target_share: 0.08, overall_pick: 120 })).tag, 'AVOID');
});

test('early draft capital lifts a middling usage to BUY (the buy-low shape)', () => {
  assert.equal(loveTag(base({ target_share: 0.16, overall_pick: 60 })).tag, 'PASS');
  assert.equal(loveTag(base({ target_share: 0.16, overall_pick: 12 })).tag, 'BUY');
});

test('strong usage but a late pick: PASS, not BUY', () => {
  assert.equal(loveTag(base({ target_share: 0.26, overall_pick: 150 })).tag, 'PASS');
});

test('unhealthy role is AVOID whatever the usage', () => {
  const t = loveTag(base({ role: { status: 'unhealthy', report_status: 'Out', radar: null } }));
  assert.equal(t.tag, 'AVOID');
  assert.ok(t.reasons.some(r => /Out/.test(r)));
});

test('RB and QB read expected points per game, not target share', () => {
  const rb = loveTag(base({ position: 'RB', target_share: 0.02, expected_ppg: 14 }));
  assert.equal(rb.usage.level, 'strong');
  assert.match(rb.usage.basis, /expected points/);
  assert.equal(loveTag(base({ position: 'RB', target_share: 0.3, expected_ppg: 5, overall_pick: 120 })).tag, 'AVOID');
  assert.equal(loveTag(base({ position: 'QB', expected_ppg: 19 })).usage.level, 'strong');
});

test('missing usage: UNRATED with a reason, never a guessed tag', () => {
  const t = loveTag(base({ games: 1 }));
  assert.equal(t.tag, 'UNRATED');
  assert.match(t.reasons.join(' '), /games/);
  assert.equal(loveTag(base({ target_share: null })).tag, 'UNRATED');
  assert.equal(loveTag(base({ position: 'K' })).tag, 'UNRATED');
});

test('draft capital unknown is said, and counts as neither early nor late', () => {
  const t = loveTag(base({ overall_pick: null }));
  assert.equal(t.tag, 'BUY');
  assert.equal(t.draft.level, 'unknown');
});

test('luck weight 0: actual points and actual TDs never change the tag (2,000 seeded players)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const positions = ['QB', 'RB', 'WR', 'TE'];
  const statuses = ['healthy', 'healthy', 'healthy', 'unhealthy'];
  let flips = 0;
  for (let i = 0; i < 2000; i++) {
    const p = base({
      position: positions[Math.floor(rnd() * 4)], games: 1 + Math.floor(rnd() * 5),
      target_share: rnd() * 0.35, expected_ppg: rnd() * 25,
      overall_pick: rnd() < 0.2 ? null : 1 + Math.floor(rnd() * 170),
      role: { ...healthy, status: statuses[Math.floor(rnd() * 4)] },
    });
    const a = loveTag({ ...p, actual_ppg: rnd() * 30, actual_tds: rnd() * 5 });
    const b = loveTag({ ...p, actual_ppg: rnd() * 30, actual_tds: rnd() * 5 });
    if (a.tag !== b.tag) flips++;
  }
  assert.equal(flips, 0);
});

test('luck is one sentence; running hot and cold both named, with the weight', () => {
  const hot = loveTag(base({ expected_ppg: 10, actual_ppg: 15.2 }));
  assert.match(hot.luck, /5\.2 pts\/g above/);
  assert.match(hot.luck, /weight 0/);
  const cold = loveTag(base({ expected_ppg: 14, actual_ppg: 9 }));
  assert.match(cold.luck, /below/);
  assert.match(loveTag(base()).luck, /about what his usage predicts/);
  assert.equal(loveTag(base({ actual_ppg: null })).luck, null);
});

test('TD over expected is a sell-high label only', () => {
  const t = loveTag(base({ expected_tds: 0.8, actual_tds: 3 }));
  assert.equal(t.sell_high?.label, 'sell_high');
  assert.match(t.sell_high.text, /\+2\.2 TDs over expected/);
  assert.equal(t.tag, loveTag(base()).tag);
  assert.equal(loveTag(base()).sell_high, null);
});

test('every tag is ungraded until the luck-free r52 re-run; a supplied grade is carried', () => {
  assert.equal(loveTag(base()).grade.status, 'ungraded');
  assert.match(loveTag(base()).grade.reason, /r52/);
  const g = { status: 'graded', hit_rate: 0.61, ci: [0.52, 0.7], n: 140 };
  assert.deepEqual(loveTag(base(), { grade: g }).grade, g);
});

test('LOVE_RULE thresholds are frozen and labelled a guess', () => {
  assert.equal(Object.isFrozen(LOVE_RULE), true);
  assert.match(LOVE_RULE.basis, /GUESS/);
});

/** A db with the { row, rows } shape of server/db/index.js over an in-memory sqlite. */
function makeDb({ tables = ['players', 'player_week_usage', 'nfl_ffopportunity_weekly', 'nfl_injuries'] } = {}) {
  const raw = new DatabaseSync(':memory:');
  const ddl = {
    players: `CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, position TEXT, gsis_id TEXT)`,
    player_week_usage: `CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER, position TEXT,
      target_share REAL, passing_tds REAL, rushing_tds REAL, receiving_tds REAL, PRIMARY KEY (player_id, season, week))`,
    nfl_ffopportunity_weekly: `CREATE TABLE nfl_ffopportunity_weekly (season INTEGER, week INTEGER, player_gsis_id TEXT,
      expected_fantasy_points REAL, actual_fantasy_points REAL, expected_touchdowns REAL, PRIMARY KEY (season, week, player_gsis_id))`,
    nfl_injuries: `CREATE TABLE nfl_injuries (season INTEGER, week INTEGER, gsis_id TEXT, report_status TEXT,
      PRIMARY KEY (season, week, gsis_id))`,
  };
  for (const t of tables) raw.exec(ddl[t]);
  return {
    rows: (sql, ...p) => raw.prepare(sql).all(...p),
    row: (sql, ...p) => raw.prepare(sql).get(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
  };
}

function seed(db) {
  db.run(`INSERT INTO players VALUES (1, 'Made Up One', 'WR', 'G1'), (2, 'Made Up Two', 'RB', 'G2'), (3, 'Made Up Three', 'WR', NULL)`);
  for (const w of [1, 2, 3, 4]) {
    db.run(`INSERT INTO player_week_usage VALUES (1, 2026, ?, 'WR', ?, 0, 0, 1)`, w, 0.2 + w / 100);
    db.run(`INSERT INTO player_week_usage VALUES (2, 2026, ?, 'RB', 0.05, 0, 1, 0)`, w);
    db.run(`INSERT INTO nfl_ffopportunity_weekly VALUES (2026, ?, 'G1', 12, 16, 0.5)`, w);
    db.run(`INSERT INTO nfl_ffopportunity_weekly VALUES (2026, ?, 'G2', 13, 11, 0.6)`, w);
  }
  db.run(`INSERT INTO player_week_usage VALUES (1, 2025, 17, 'WR', 0.9, 0, 0, 5)`);
  db.run(`INSERT INTO nfl_injuries VALUES (2026, 4, 'G2', 'Out')`);
}

test('reader: strictly prior weeks of this season, averaged; week N itself is never read', () => {
  const db = makeDb(); seed(db);
  const r = readLoveInputs(db, { season: 2026, week: 4, ids: [1, 2] });
  const one = r.players.get(1);
  assert.equal(one.games, 3);
  assert.equal(one.through, '2026-W3');
  assert.equal(one.target_share, 0.22);          // weeks 1-3: 0.21, 0.22, 0.23 (week 4 and 2025 excluded)
  assert.equal(one.expected_ppg, 12);
  assert.equal(one.actual_ppg, 16);
  assert.equal(one.actual_tds, 3);
  assert.equal(one.expected_tds, 1.5);
  assert.equal(one.role.status, 'healthy');
  assert.equal(r.players.get(2).role.status, 'unhealthy');
  assert.equal(r.players.get(2).role.report_status, 'Out');
});

test('reader: a player with no gsis id has no expected points, and the tag says UNRATED only where it must', () => {
  const db = makeDb(); seed(db);
  const r = readLoveInputs(db, { season: 2026, week: 4, ids: [3] });
  const p = r.players.get(3);
  assert.equal(p.expected_ppg, null);
  assert.equal(r.sources.ffopportunity.missing_gsis, 1);
});

test('reader: absent tables are reported per source, not thrown and not an empty ok', () => {
  const db = makeDb({ tables: ['players'] });
  db.run(`INSERT INTO players VALUES (1, 'Made Up One', 'WR', 'G1')`);
  const r = readLoveInputs(db, { season: 2026, week: 4, ids: [1] });
  assert.equal(r.sources.usage.status, 'table_absent');
  assert.equal(r.sources.ffopportunity.status, 'table_absent');
  assert.equal(r.sources.injuries.status, 'table_absent');
  assert.equal(loveTag(r.players.get(1)).tag, 'UNRATED');
});

test('reader: draft capital comes from the DRAFT-ID-MAP map when given, else unknown', () => {
  const db = makeDb(); seed(db);
  const draft = new Map([[1, { overall_pick: 9 }]]);
  assert.equal(readLoveInputs(db, { season: 2026, week: 4, ids: [1], draft }).players.get(1).overall_pick, 9);
  const r = readLoveInputs(db, { season: 2026, week: 4, ids: [1] });
  assert.equal(r.players.get(1).overall_pick, null);
  assert.equal(r.sources.draft.status, 'not_read');
});

test('summary: counts and ids only, no names', () => {
  const db = makeDb(); seed(db);
  const r = readLoveInputs(db, { season: 2026, week: 4, ids: [1, 2, 3] });
  const s = loveSummary(r);
  assert.equal(s.lane, 'shadow');
  assert.equal(s.grade.status, 'ungraded');
  assert.deepEqual(Object.keys(s.counts).sort(), ['AVOID', 'BUY', 'PASS', 'UNRATED']);
  assert.equal(s.tags.length, 3);
  assert.equal(s.tags.find(t => t.player === 2).tag, 'AVOID');
  assert.doesNotMatch(JSON.stringify(s), /Made Up/);
});

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('producer: flag off (no adapter.love) -> no love key at all', async () => {
  const [l] = (await produce(makeAdapter())).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('love' in l._run.inputs, false);
  assert.doesNotMatch(JSON.stringify(l), /"love"/);
});

test('producer: flag on -> only _run.inputs.love is added; LOVE is never a search constraint', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  const asked = [];
  const love = (ids, opts) => {
    asked.push({ ids, draft: opts.draft });
    // Every player tagged AVOID: if LOVE constrained the search, the plan would change.
    return { players: new Map(ids.map(id => [id, base({ player: id, target_share: 0.01, overall_pick: 170 })])),
      sources: { usage: { status: 'ok' } } };
  };
  const on = (await produce(Object.assign(makeAdapter(), { love }))).leagues[0];
  assert.equal(asked.length, 1);
  assert.equal(asked[0].draft, null, 'no DRAFT-ID-MAP read on this adapter');
  assert.ok(asked[0].ids.length > 0, 'the tagged ids come from the entry: targets, flips, deck');
  assert.equal(on._run.inputs.love.lane, 'shadow');
  assert.ok(on._run.inputs.love.counts.AVOID > 0);
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.love;
  assert.deepEqual(on._run, off._run);
});
