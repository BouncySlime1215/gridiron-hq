/**
 * SEASON-REPLAY (plan item 30): the as-of replay of Nick's leagues. Fixture league only (made-up
 * player ids plus the pinned rule ids 160 / 80 / 277 / 290); no live database, no league names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../server/services/eval/common.js';
import { leagueRules } from '../server/services/league-rules.js';
import {
  SEASON_REPLAY_ENV, seasonReplayEnabled, weekCutoffs, formatProblem, opponents, asOfValue, exportLeague,
  provenance, realizedPoints, ruleBreaks, replayWeeks, summarizeReplay, main, MIN_LEAGUES, BLOCKED,
} from '../scripts/eval/season-replay.mjs';
import { prepareLeague, makeAdapter, finderMove, greedyMove } from '../scripts/eval/e4-planner-replay.mjs';

const TEAMS = [1, 2, 3, 4, 5, 6];
const NREG = 5;                    // regular weeks 1-5, playoffs 6-7 (4 teams, one-week rounds)
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const POS = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
const PAIRS = [[[1, 2], [3, 4], [5, 6]], [[1, 3], [2, 5], [4, 6]], [[1, 4], [2, 6], [3, 5]], [[1, 5], [2, 4], [3, 6]], [[1, 6], [2, 3], [4, 5]]];

/** Team t's player ids: 100t+j, except the pinned rule ids placed on teams 1 (Nick) and 2. */
const idsOf = t => POS.map((_, j) => {
  if (t === 1 && j === 4) return 160; if (t === 1 && j === 1) return 80; if (t === 1 && j === 5) return 277;
  if (t === 2 && j === 4) return 290;
  return 100 * t + j;
});

function payload() {
  const schedule = [];
  for (let w = 1; w <= NREG; w++) for (const [h, a] of PAIRS[w - 1]) schedule.push({ matchupPeriodId: w, home: { teamId: h }, away: { teamId: a } });
  return {
    settings: { scheduleSettings: { matchupPeriodCount: NREG, matchupPeriodLength: 1, playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      playoffReseed: true, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } },
    teams: TEAMS.map(id => ({ id, divisionId: 0 })), schedule,
  };
}

/** 'final' rows for weeks 1..through; the rule ids are strong players so a naive arm would pick them. */
function snaps(through = 7, { changedAt = w => `2026-09-${String(8 + 7 * w).padStart(2, '0')}T12:00:00Z` } = {}) {
  const out = [];
  for (let w = 1; w <= through; w++) for (const t of TEAMS) {
    idsOf(t).forEach((id, j) => {
      const strong = [160, 80, 277, 290].includes(id);
      const pts = strong ? 25 : 6 + ((t * 7 + j * 3 + w * 5) % 11);
      out.push({ scoring_period_id: w, team_id: t, player_id: id, position: POS[j], is_starter: j < 7 ? 1 : 0, on_roster: 1,
        projected_points: strong ? 20 : 10, actual_points: pts, source: 'final', changed_at: changedAt(w) });
    });
  }
  return out;
}

const lg = () => ({ id: 4, platform: 'espn', payload: JSON.stringify(payload()) });
const league = (rows = snaps()) => exportLeague({ leagueId: 4, season: 2026, snaps: rows, byes: new Map(), opp: opponents(payload()),
  rules: leagueRules(lg()), slots: SLOTS });

// A planner stand-in that returns the best-looking raw swap, rule ids included, so the filter is what is tested.
const naivePlanner = { objective: {}, planLeague: ad => {
  const me = ad.league.me;
  const give = ad.rosters.get(me)[0];
  const get = ad.rosters.get('2').find(id => id === '290') ?? ad.rosters.get('2')[0];
  return { best: { expected: 0.01, steps: [{ team: '2', give: [give], get: [get], p: 0.5 }] } };
} };

test('flag: off by default; the CLI refuses to run without it', async () => {
  assert.equal(seasonReplayEnabled({}), false);
  assert.equal(seasonReplayEnabled({ [SEASON_REPLAY_ENV]: '1' }), true);
  await assert.rejects(() => main(['--db', '/nonexistent'], {}), /GRIDIRON_SEASON_REPLAY=1 is required/);
});

test('cutoffs: the earliest game date of each week; a bad date is ignored, not read as 1970', () => {
  const c = weekCutoffs([{ week: 3, date: '2026-09-24' }, { week: 3, date: '2026-09-27' }, { week: 4, date: null }, { week: 4, date: 'x' }]);
  assert.equal(c.get(3), Date.parse('2026-09-24'));
  assert.equal(c.has(4), false);
});

test('format: the fixture reads cleanly; two-week rounds, odd playoff counts and median games are skipped with a reason', () => {
  assert.equal(formatProblem(leagueRules(lg())), null);
  const p = payload();
  p.settings.scheduleSettings.playoffMatchupPeriodLength = 2;
  assert.match(formatProblem(leagueRules({ platform: 'espn', payload: JSON.stringify(p) })), /2 weeks/);
  const q = payload();
  q.settings.scheduleSettings.playoffTeamCount = 5;
  assert.match(formatProblem(leagueRules({ platform: 'espn', payload: JSON.stringify(q) })), /playoff teams 5/);
  const ok = leagueRules(lg());
  assert.match(formatProblem({ ...ok, median_game: true }), /median/);
  assert.match(formatProblem({ ...ok, seeding: { ...ok.seeding, division_winners_first: true } }), /division/);
  const m = payload();
  delete m.settings.scheduleSettings.playoffTeamCount;
  assert.match(formatProblem(leagueRules({ platform: 'espn', payload: JSON.stringify(m) })), /playoffTeamCount/);
});

test('as-of value: shrinks points per game to the projection of the same weeks and never reads a later week', () => {
  const games = [{ week: 1, actual: 20, projected: 10 }, { week: 2, actual: 0, projected: 10 }, { week: 3, actual: 99, projected: 50 }];
  assert.equal(asOfValue(games, 0), 0);
  assert.equal(asOfValue(games, 1), (1 * 20 + 3 * 10) / 4);
  assert.equal(asOfValue(games, 2), (1 * 20 + 3 * 10) / 4, 'a 0-point week is a missed game, not a data point');
  assert.notEqual(asOfValue(games, 3), asOfValue(games, 2));
});

test('export: E4 shape, rosters at the end of each period, team score = starters, future weeks carry only the opponent', () => {
  const L = league(snaps(2));
  assert.deepEqual(L.rids, ['1', '2', '3', '4', '5', '6']);
  assert.equal(L.pt, 4);
  assert.equal(L.pws, NREG + 1);
  assert.equal(L.last_week, 7);
  assert.deepEqual(L.final_weeks, [1, 2]);
  assert.equal(L.tw['1'][0][2].length, POS.length);
  assert.equal(L.tw['1'][0][1], '2');
  assert.deepEqual(L.tw['1'][4], [null, '6', []]);
  const starters = snaps(1).filter(r => r.team_id === 1 && r.is_starter === 1).reduce((s, r) => s + r.actual_points, 0);
  assert.equal(L.tw['1'][0][0], starters);
});

test('provenance: rows this machine wrote after the cutoff mark the week reconstructed', () => {
  const rows = snaps(3);
  const cut = Date.parse('2026-09-30T00:00:00Z');   // after week 1 and 2 finals (09-15, 09-22)
  assert.deepEqual(provenance(rows, 3, cut), { rows: 2 * 6 * POS.length, observed_after_cutoff: 0, provenance: 'captured' });
  const back = snaps(3, { changedAt: () => '2026-10-05T00:00:00Z' });
  assert.equal(provenance(back, 3, cut).provenance, 'reconstructed');
  assert.equal(provenance(rows, 3, null).provenance, 'reconstructed', 'no cutoff known: never called captured');
});

test('LEAK: changing everything about weeks >= W leaves every arm at W unchanged', () => {
  const W = 3;
  const a = league(snaps(7));
  const tampered = snaps(7).map(r => (r.scoring_period_id >= W
    ? { ...r, actual_points: r.actual_points * 7 + 40, projected_points: 99, on_roster: r.player_id % 2 } : r));
  const b = league(tampered);
  const arms = L => {
    const C = prepareLeague(L, { decisionWeek: W });
    const ad = makeAdapter(C, '1', { runs: 60, leagueKey: 'Lfix' });
    return { base: [...C.base], values: [...ad.players].map(([id, p]) => [id, p.value, p.ros_ppg]),
      greedy: greedyMove(C, ad, '1', { blocked: BLOCKED }).move, finder: finderMove(C, ad, '1', ad.world(ad.seed), { blocked: BLOCKED }).move };
  };
  assert.deepEqual(arms(b), arms(a));
});

test('RULES: no arm offers 160, 80 or 277 or takes 290, even when the planner proposes it', () => {
  const L = league(snaps(4));
  const rows = replayWeeks(L, { me: '1', weeks: [2, 3], cutoffs: new Map(), snaps: snaps(4), planner: naivePlanner, runs: 40 });
  for (const r of rows) {
    for (const arm of ['finder', 'greedy']) {
      assert.deepEqual(r.rule_breaks[arm], [], `${arm} week ${r.week}`);
      for (const s of r.moves[arm]) {
        for (const id of s.give) assert.ok(!BLOCKED.give.has(id));
        for (const id of s.get) assert.ok(!BLOCKED.get.has(id));
      }
    }
    // The stand-in planner ignores the rules on purpose: the audit must catch it, never hide it.
    assert.ok(r.rule_breaks.planner.length > 0);
  }
  assert.ok(summarizeReplay(rows).rule_breaks > 0);
  assert.deepEqual(ruleBreaks([{ give: ['160'], get: ['290'] }]), ['gives 160', 'gets 290']);
});

test('real planner: its moves at each week obey the pinned rules (withNeverGive inside planLeague)', async () => {
  const { planLeague } = await import('../server/services/campaign/planner.js');
  const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
  const L = league(snaps(3));
  const rows = replayWeeks(L, { me: '1', weeks: [2, 3], cutoffs: new Map(), snaps: snaps(3),
    planner: { planLeague, objective: normaliseObjective({}) }, runs: 40 });
  const graded = rows.filter(r => r.planner);
  assert.ok(graded.length >= 1, JSON.stringify(rows.map(r => r.error ?? r.skipped)));
  for (const r of graded) assert.deepEqual(r.rule_breaks, { planner: [], finder: [], greedy: [] });
});

test('in-season: title is not graded until every period is final; the interim points number is', () => {
  const rows = replayWeeks(league(snaps(3)), { me: '1', weeks: [2, 3, 4, 5], cutoffs: new Map(), snaps: snaps(3), planner: naivePlanner, runs: 40 });
  assert.equal(rows.find(r => r.week === 5).skipped, 'period 4 not final');
  const g = rows.filter(r => r.planner);
  assert.ok(g.every(r => r.complete === false && r.planner.title === null && Number.isFinite(r.planner.points)));
  const s = summarizeReplay(g);
  assert.equal(s.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(s.complete_leagues, 0);
  assert.equal(s.interim_points_per_week.n, g.length);
});

test('complete season: realized title graded; fewer than MIN_LEAGUES leagues is not_enough_data whatever the CI', () => {
  const rows = replayWeeks(league(snaps(7)), { me: '1', weeks: [2, 3], cutoffs: new Map(), snaps: snaps(7), planner: naivePlanner, runs: 40 });
  assert.ok(rows.every(r => r.complete && Number.isFinite(r.planner.title)));
  assert.equal(summarizeReplay(rows).status, STATUS.NOT_ENOUGH_DATA);
  assert.ok(MIN_LEAGUES >= 5);
});

test('--strict drops reconstructed weeks instead of grading them', () => {
  const rows = snaps(3, { changedAt: () => '2026-12-01T00:00:00Z' });
  const out = replayWeeks(league(rows), { me: '1', weeks: [2, 3], cutoffs: new Map([[2, Date.parse('2026-09-17')], [3, Date.parse('2026-09-24')]]),
    snaps: rows, planner: naivePlanner, runs: 40, strict: true });
  assert.ok(out.every(r => r.skipped === 'reconstructed inputs (--strict)'));
});

test('realizedPoints: nothing is 0; one accepted step is p x the realized weekly points change', () => {
  const L = league(snaps(4));
  const C = prepareLeague(L, { decisionWeek: 2 });
  assert.deepEqual(realizedPoints(C, '1', [], 4), { points: 0, points_done: 0, weeks: 3 });
  const r = realizedPoints(C, '1', [{ team: '3', give: ['100'], get: ['300'], p: 0.4 }], 4);
  assert.ok(Math.abs(r.points - 0.4 * r.points_done) < 1e-12);
});

test('determinism: the same inputs give byte-identical rows (seeded worlds)', () => {
  const run = () => replayWeeks(league(snaps(4)), { me: '1', weeks: [2, 3], cutoffs: new Map(), snaps: snaps(4), planner: naivePlanner, runs: 40 })
    .map(({ ms, ...r }) => r);
  assert.deepEqual(run(), run());
});

test('CLI end to end on a database copy: reads leagues, snapshots, byes and dates; writes the summary', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const file = path.join(dir, 'copy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY, platform TEXT, league_id TEXT, season INTEGER, my_team_id TEXT,
      roster_positions TEXT, payload TEXT);
    CREATE TABLE league_roster_snapshots (league_id INTEGER, season INTEGER, scoring_period_id INTEGER, team_id INTEGER,
      espn_player_id INTEGER, player_id INTEGER, position TEXT, is_starter INTEGER, on_roster INTEGER, projected_points REAL,
      actual_points REAL, source TEXT, changed_at TEXT);
    CREATE TABLE players (id INTEGER PRIMARY KEY, bye_week INTEGER);
    CREATE TABLE schedule_games (season INTEGER, team_id INTEGER, week INTEGER, date TEXT);`);
  db.prepare('INSERT INTO leagues VALUES (4, ?, ?, 2026, ?, ?, ?)').run('espn', 'x', '1', JSON.stringify(SLOTS), JSON.stringify(payload()));
  const ins = db.prepare('INSERT INTO league_roster_snapshots VALUES (4, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of snaps(3)) ins.run(r.scoring_period_id, r.team_id, r.player_id, r.player_id, r.position, r.is_starter, r.on_roster,
    r.projected_points, r.actual_points, r.source, r.changed_at);
  for (let w = 1; w <= 7; w++) db.prepare('INSERT INTO schedule_games VALUES (2026, 1, ?, ?)').run(w, `2026-09-${String(3 + 7 * w).padStart(2, '0')}`);
  db.close();
  const out = path.join(dir, 'out.json');
  const res = await main(['--db', file, '--season', '2026', '--weeks', '2-3', '--runs', '40', '--out', out], { [SEASON_REPLAY_ENV]: '1' });
  assert.equal(res.leagues.length, 1);
  assert.equal(res.rows.filter(r => r.planner).length, 2);
  assert.equal(res.summary.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(res.summary.rule_breaks, 0);
  // Week-2 cutoff 2026-09-17; week-1 final written 2026-09-15 -> captured. Week 3 (09-24) reads week 2 written 09-22 -> captured.
  assert.ok(res.rows.filter(r => r.planner).every(r => r.audit.provenance === 'captured'));
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!/espn_s2|swid/i.test(text));
  fs.rmSync(dir, { recursive: true, force: true });
});
