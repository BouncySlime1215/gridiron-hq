/**
 * PLAYOFF-WEEK VALUE (batch D item 28): same-season defense-vs-position read, applied to the
 * league's playoff weeks, as a points delta per player and a LOGGED tiebreak on the served
 * targets. Shadow behind GRIDIRON_PLAYOFF_WEEK_VALUE; pass bar P1-P3 in
 * docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md.
 *
 * Fixtures only: made-up players, ids, teams and numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-playoff-week-'));
process.env.GRIDIRON_DB_PATH ??= path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK ??= 'off';
process.env.SCHEDULER_DISABLED = '1';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { playoffWeekMode, defenseRatios, playoffWeekRows, tieBreak, playoffWeekSummary, gradePlayoffWeek,
  PLAYOFF_WEEK_ENV, PLAYOFF_WEEK_RULE, PLAYOFF_WEEK_PASS_BAR } = await import('../server/services/campaign/playoff-week.js');
const { readPlayoffWeekLines } = await import('../server/services/campaign/playoff-week-inputs.js');
const { PPR } = await import('../server/services/scoring.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

/* ------------------------------------------------------------ a made-up season */

// Deterministic uniform / normal draws.
function hash(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) { h ^= x >>> 0; h = Math.imul(h, 16777619) >>> 0; h ^= h >>> 13; h = Math.imul(h, 2654435761) >>> 0; }
  return (h >>> 0) / 4294967296;
}
const normal = (...k) => {
  const u = Math.max(1e-12, hash(...k, 1)), v = hash(...k, 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const POS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];

/**
 * One season: 32 teams, 7 skill players each, weeks 1-17, a rotating schedule (team i plays
 * team (i + w) mod 32 paired off so every team has one game). `effect` = how strongly a
 * defense's true multiplier (fixed per defense and position) bends points.
 */
function season(seed, { effect = 0, noise = 0.35 } = {}) {
  const lines = [];
  const opp = new Map();
  for (let w = 1; w <= 17; w++) {
    const shift = 1 + ((w * 7 + seed) % 31);
    const used = new Set();
    for (let i = 0; i < 32; i++) {
      if (used.has(i)) continue;
      let j = (i + shift) % 32;
      while (used.has(j) || j === i) j = (j + 1) % 32;
      used.add(i); used.add(j);
      opp.set(`${TEAMS[i]}|${w}`, TEAMS[j]); opp.set(`${TEAMS[j]}|${w}`, TEAMS[i]);
    }
  }
  const trueMult = (d, pos) => 1 + effect * (2 * hash(seed, TEAMS.indexOf(d), pos.charCodeAt(0), 77) - 1);
  TEAMS.forEach((team, t) => POS.forEach((pos, k) => {
    const player = 1000 + t * 10 + k;
    const level = { QB: 18, RB: 11, WR: 10, TE: 7 }[pos] * (0.6 + 0.8 * hash(seed, player, 5));
    for (let w = 1; w <= 17; w++) {
      const o = opp.get(`${team}|${w}`);
      const pts = Math.max(0, level * trueMult(o, pos) * (1 + noise * normal(seed, player, w)));
      lines.push({ player, position: pos, team, opponent: o, week: w, pts: +pts.toFixed(2) });
    }
  }));
  return { lines, opp, trueMult };
}

/* ------------------------------------------------------------ flag */

test('flag: off unless GRIDIRON_PLAYOFF_WEEK_VALUE is shadow or 1; preview never turns it on', () => {
  assert.equal(PLAYOFF_WEEK_ENV, 'GRIDIRON_PLAYOFF_WEEK_VALUE');
  assert.equal(playoffWeekMode({}), 'off');
  assert.equal(playoffWeekMode({ GRIDIRON_PLAYOFF_WEEK_VALUE: '0' }), 'off');
  assert.equal(playoffWeekMode({ GRIDIRON_PLAYOFF_WEEK_VALUE: 'on' }), 'off');
  assert.equal(playoffWeekMode({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(playoffWeekMode({ GRIDIRON_PLAYOFF_WEEK_VALUE: 'shadow' }), 'shadow');
  assert.equal(playoffWeekMode({ GRIDIRON_PLAYOFF_WEEK_VALUE: '1' }), 'shadow');
});

test('rule and bar are the pre-registered constants', () => {
  assert.equal(PLAYOFF_WEEK_RULE.k, 200);
  assert.deepEqual({ ...PLAYOFF_WEEK_RULE.floors }, { QB: 6, RB: 4, WR: 4, TE: 3 });
  assert.equal(PLAYOFF_WEEK_RULE.role, 'tiebreaker');
  assert.equal(PLAYOFF_WEEK_RULE.tie_se, 1);
  assert.equal(PLAYOFF_WEEK_PASS_BAR.as_of_week, 13);
  assert.deepEqual([...PLAYOFF_WEEK_PASS_BAR.playoff_weeks], [15, 16, 17]);
  assert.equal(PLAYOFF_WEEK_PASS_BAR.held_out, 2025);
  assert.deepEqual([...PLAYOFF_WEEK_PASS_BAR.no_reversal], [2023, 2024]);
  assert.equal(PLAYOFF_WEEK_PASS_BAR.min_player_weeks, 300);
  assert.equal(PLAYOFF_WEEK_PASS_BAR.min_games, 4);
});

/* ------------------------------------------------------------ T1 ratios */

test('T1: the ratios recover a planted defense effect and shrink toward 1 with few games', () => {
  const { lines, trueMult } = season(3, { effect: 0.3, noise: 0.1 });
  const before13 = lines.filter(l => l.week < 13);
  const r = defenseRatios(before13);
  // Correlation between the true and read multiplier across (defense, WR).
  const xs = [], ys = [];
  for (const d of TEAMS) { const v = r.get(`${d}|WR`); if (v) { xs.push(trueMult(d, 'WR')); ys.push(v.mult); } }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const corr = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  assert.ok(corr > 0.8, `corr ${corr}`);
  // Shrinkage: with K = 200 and a few dozen ratio games, every read sits well inside the truth's spread.
  for (const [, v] of r) assert.ok(Math.abs(v.mult - 1) < 0.3, JSON.stringify(v));
  // Fewer games -> closer to 1.
  const few = defenseRatios(lines.filter(l => l.week < 3));
  const spread = m => Math.max(...[...m.values()].map(v => Math.abs(v.mult - 1)));
  assert.ok(spread(few) < spread(r));
});

test('T1: a line under the position floor is not used; a player with one useful game gives no ratio', () => {
  const lines = [
    { player: 1, position: 'WR', opponent: 'AAA', week: 1, pts: 20 },
    { player: 1, position: 'WR', opponent: 'BBB', week: 2, pts: 10 },
    { player: 2, position: 'WR', opponent: 'AAA', week: 1, pts: 15 },   // one useful game only
    { player: 2, position: 'WR', opponent: 'BBB', week: 2, pts: 2 },    // under the WR floor 4
  ];
  const r = defenseRatios(lines);
  const a = r.get('AAA|WR');
  assert.equal(a.games, 2);                // raw games count both useful lines
  assert.equal(a.ratio_games, 1);          // only player 1 has a leave-one-out baseline
  assert.ok(a.observed > 1.9 && a.observed < 2.1, `${a.observed}`); // 20 vs his other game 10
  assert.ok(a.mult > 1 && a.mult < 1.01);  // one game, K 200: barely moves
  assert.equal(r.has('BBB|WR'), true);
});

/* ------------------------------------------------------------ T2 grader power and no false pass */

test('T2: the grader passes a league with a real defense effect and does not pass one with none', () => {
  const real = new Map([2023, 2024, 2025].map((s, i) => [s, season(11 + i, { effect: 0.35, noise: 0.15 }).lines]));
  const g = gradePlayoffWeek(real);
  assert.equal(g.verdict, 'pass', JSON.stringify(g.bar));
  for (const s of [2023, 2024, 2025]) {
    assert.ok(g.seasons[s].n_player_weeks >= 300);
    assert.ok(g.seasons[s].mae_change.mean_diff < 0);
  }

  const none = new Map([2023, 2024, 2025].map((s, i) => [s, season(21 + i, { effect: 0 }).lines]));
  const n = gradePlayoffWeek(none);
  assert.equal(n.verdict, 'fail');
  assert.match(n.reason, /P1|P2/);
});

test('T2: too few player-weeks is a fail on P3, not a pass', () => {
  const tiny = new Map([2023, 2024, 2025].map((s, i) => [s, season(31 + i, { effect: 0.35, noise: 0.15 }).lines.filter(l => l.player < 1030)]));
  const g = gradePlayoffWeek(tiny);
  assert.equal(g.verdict, 'fail');
  assert.match(g.reason, /P3/);
});

test('T2: the grade reads only weeks before the as-of week for the ratios and the baseline', () => {
  const { lines } = season(41, { effect: 0.3, noise: 0.15 });
  const a = gradePlayoffWeek(new Map([[2025, lines]]));
  // Changing weeks 13-14 (between the as-of week and the playoffs) cannot change anything.
  const moved = lines.map(l => (l.week === 13 || l.week === 14 ? { ...l, pts: l.pts * 3 } : l));
  const b = gradePlayoffWeek(new Map([[2025, moved]]));
  assert.deepEqual(b.seasons[2025], a.seasons[2025]);
});

/* ------------------------------------------------------------ T3 rows off the world */

const WORLD = {
  as_of_week: 4,
  playoff_weeks: [15, 16, 17],
  players: new Map([[5, { id: 5, position: 'WR', team_abbr: 'AAA' }], [6, { id: 6, position: 'RB', team_abbr: 'BBB' }], [7, { id: 7, position: 'TE', team_abbr: 'CCC' }]]),
  expected: new Map([[15, new Map([[5, 12], [6, 10]])], [16, new Map([[5, 12], [6, 10], [7, 6]])], [17, new Map([[5, 12], [6, 10], [7, 6]])]]),
  schedule: new Map([
    ['AAA', [{ week: 15, opponent_abbr: 'SOFT' }, { week: 16, opponent_abbr: 'HARD' }, { week: 17, opponent_abbr: 'SOFT' }]],
    ['BBB', [{ week: 15, opponent_abbr: 'HARD' }, { week: 16, opponent_abbr: 'NONE' }, { week: 17, opponent_abbr: 'HARD' }]],
    ['CCC', [{ week: 16, opponent_abbr: 'SOFT' }, { week: 17, opponent_abbr: 'SOFT' }]],
  ]),
};
const RATIOS = new Map([['SOFT|WR', { mult: 1.1, games: 30 }], ['HARD|WR', { mult: 0.9, games: 30 }], ['HARD|RB', { mult: 0.95, games: 30 }], ['SOFT|TE', { mult: 1.05, games: 30 }]]);

test('T3: rows read the world expected points on the league playoff weeks; bye and no-read are explicit', () => {
  const rows = playoffWeekRows(WORLD, RATIOS, [5, 6, 7, 99]);
  const p5 = rows.find(r => r.player === 5);
  assert.deepEqual(p5.weeks.map(w => [w.week, w.opponent, w.mult]), [[15, 'SOFT', 1.1], [16, 'HARD', 0.9], [17, 'SOFT', 1.1]]);
  assert.equal(p5.delta_pts, 1.2);        // 12 x (0.1 - 0.1 + 0.1)
  assert.equal(p5.playoff_pts, 36);
  const p6 = rows.find(r => r.player === 6);
  assert.equal(p6.weeks[1].read, false);  // no NONE|RB ratio -> mult 1, counted
  assert.equal(p6.weeks[1].mult, 1);
  assert.equal(p6.no_read_weeks, 1);
  assert.equal(p6.delta_pts, -1);         // 10 x (-0.05) x 2
  const p7 = rows.find(r => r.player === 7);
  assert.equal(p7.weeks[0].bye, true);    // CCC has no week-15 game
  assert.equal(p7.weeks[0].delta, null);
  assert.equal(p7.delta_pts, 0.6);
  const p99 = rows.find(r => r.player === 99);
  assert.equal(p99.status, 'unrated');
  assert.match(p99.reason, /not in the simulated world/);
});

/* ------------------------------------------------------------ T4 tiebreak */

const tgt = (player, value, se) => ({ player: String(player), gain_if_landed: { status: 'ok', value, se } });

test('T4: the tiebreak looks only inside the 1-SE band of the top target, and is logged, never applied', () => {
  const rows = [{ player: 5, status: 'ok', delta_pts: -2 }, { player: 6, status: 'ok', delta_pts: 3 }, { player: 7, status: 'ok', delta_pts: 9 }];
  // 5 on top; 6 within 1 combined SE (0.010 vs 0.008, se 0.002 each -> band 0.0028); 7 far below.
  const targets = { status: 'ok', value: [tgt(5, 0.010, 0.002), tgt(6, 0.008, 0.002), tgt(7, 0.001, 0.002)] };
  const snapshot = structuredClone(targets);
  const t = tieBreak(targets, rows);
  assert.equal(t.served_top, '5');
  assert.deepEqual(t.tied, ['5', '6']);
  assert.equal(t.tiebreak_top, '6');
  assert.equal(t.would_change, true);
  assert.equal(t.applied, false);
  assert.deepEqual(targets, snapshot, 'the served targets are untouched');

  // No second target in the band -> no tie, nothing would change.
  const alone = tieBreak({ status: 'ok', value: [tgt(5, 0.03, 0.002), tgt(6, 0.008, 0.002)] }, rows);
  assert.deepEqual(alone.tied, ['5']);
  assert.equal(alone.would_change, false);
  // A missing SE is no evidence of a tie.
  const noSe = tieBreak({ status: 'ok', value: [tgt(5, 0.010, null), tgt(6, 0.0099, 0.002)] }, rows);
  assert.deepEqual(noSe.tied, ['5']);
  // Unknown targets -> a reason, not a crash.
  assert.match(tieBreak({ status: 'unknown', reason: 'x' }, rows).reason, /no served targets/);
});

/* ------------------------------------------------------------ T6 summary: ids only, shadow, ungraded */

test('T6: the summary is shadow, ungraded, ids only, and never names a player', () => {
  const lines = season(51, { effect: 0.2 }).lines.filter(l => l.week < 4);
  const s = playoffWeekSummary({ ...WORLD, lines, sources: { usage: { status: 'ok', rows: lines.length } } },
    { ids: [5, 6, 7], targets: { status: 'ok', value: [tgt(5, 0.01, 0.002)] } });
  assert.equal(s.lane, 'shadow');
  assert.equal(s.grade.status, 'ungraded');
  assert.match(s.grade.reason, /playoff-week-grade\.mjs/);
  assert.equal(s.as_of_week, 4);
  assert.deepEqual(s.playoff_weeks, [15, 16, 17]);
  assert.equal(s.rule.k, 200);
  assert.equal(s.ratios.defenses_read > 0, true);
  assert.equal(s.players.length, 3);
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /"name"/);
  assert.equal(s.tie_break.applied, false);
});

test('T6: a missing usage table is reported, not thrown, and every row is unrated', () => {
  const s = playoffWeekSummary({ ...WORLD, lines: [], sources: { usage: { status: 'table_absent', reason: 'player_week_usage is not on this database' } } },
    { ids: [5], targets: null });
  assert.equal(s.status, 'no_read');
  assert.match(s.reason, /player_week_usage/);
  assert.equal(s.players.length, 0);
});

/* ------------------------------------------------------------ the one reader */

test('reader: scores player_week_usage with the league scoring, weeks strictly before the as-of week', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, position TEXT);
    CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER, team TEXT, opponent TEXT, position TEXT,
      receptions REAL, receiving_yards REAL, receiving_tds REAL, rushing_yards REAL, rushing_tds REAL, passing_yards REAL,
      passing_tds REAL, interceptions REAL, fumbles_lost REAL, first_downs REAL);
    INSERT INTO players VALUES (5, 'WR'), (6, 'K');
    INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, receptions, receiving_yards, receiving_tds)
      VALUES (5, 2026, 1, 'AAA', 'WSH', 'WR', 5, 60, 1), (5, 2026, 2, 'AAA', 'BBB', 'WR', 2, 20, 0),
             (5, 2026, 4, 'AAA', 'CCC', 'WR', 9, 90, 0), (5, 2025, 1, 'AAA', 'BBB', 'WR', 9, 90, 0), (6, 2026, 1, 'AAA', 'BBB', 'K', 0, 0, 0);`);
  const q = { row: (s, ...a) => db.prepare(s).get(...a), rows: (s, ...a) => db.prepare(s).all(...a) };
  const r = readPlayoffWeekLines(q, { season: 2026, toWeek: 4, scoring: PPR });
  assert.equal(r.sources.usage.status, 'ok');
  assert.deepEqual(r.lines.map(l => [l.player, l.week, l.opponent, l.pts]), [[5, 1, 'WAS', 17], [5, 2, 'BBB', 4]]);
  const none = readPlayoffWeekLines({ row: () => undefined, rows: () => [] }, { season: 2026, toWeek: 4, scoring: PPR });
  assert.equal(none.sources.usage.status, 'table_absent');
  assert.deepEqual(none.lines, []);
});

/* ------------------------------------------------------------ T5 producer wiring: off is off */

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('T5: flag off (no adapter.playoffWeek) -> no playoff_week key at all', async () => {
  const [l] = (await produce(makeAdapter())).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('playoff_week' in l._run.inputs, false);
});

test('T5: flag on -> only _run.inputs.playoff_week is added; no served number moves', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  let calls = 0;
  const lines = season(61, { effect: 0.2 }).lines.filter(l => l.week < 4);
  const playoffWeek = () => { calls++; return { ...WORLD, lines, sources: { usage: { status: 'ok', rows: lines.length } } }; };
  const on = (await produce(Object.assign(makeAdapter(), { playoffWeek }))).leagues[0];
  assert.equal(calls, 1);
  assert.equal(on._run.inputs.playoff_week.lane, 'shadow');
  // Nick's roster (team 1 in the fixture) is always asked about.
  const asked = on._run.inputs.playoff_week.players.map(p => String(p.player));
  for (const id of makeAdapter().rosters.get('1')) assert.ok(asked.includes(String(id)), `roster ${id}`);
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.playoff_week;
  assert.deepEqual(on._run, off._run);
});

test('T5: a failing read is recorded as an error on the block, and the league still plans', async () => {
  const playoffWeek = () => { throw new Error('boom'); };
  const [l] = (await produce(Object.assign(makeAdapter(), { playoffWeek }))).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal(l._run.inputs.playoff_week.status, 'error');
  assert.match(l._run.inputs.playoff_week.reason, /boom/);
});
