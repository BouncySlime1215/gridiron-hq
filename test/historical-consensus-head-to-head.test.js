/**
 * HX-01: the historical head-to-head of our served start/sit number against public consensus
 * (docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md).
 *
 * What these tests pin:
 *   - the consensus arm grades with C-01's one decision instrument (identity, not copies), and
 *     its pair accuracy is startSitPairAccuracy's rule;
 *   - the FantasyPros scrape -> NFL week mapping, the leak guard and the held-out season are the
 *     pre-registered rules (the 2025 window is dropped before any id join);
 *   - the common pair set holds every point arm to the threshold and needs a consensus rank;
 *   - the verdict and the Holm family are the pre-registered rule;
 *   - OURS is the served chain: round2(round2(B x p) x lift) through the served
 *     startSitWeekPoints, with trade-engine.js's default chance to play;
 *   - every fit that grades a season ends before it, and the k control stops a season.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hx01-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const arm = await import('../scripts/consensus-arm.mjs');
const lib = await import('../scripts/historical-consensus-lib.mjs');
const s02 = await import('../scripts/weekly-construction-grade-lib.mjs');
const { gradeDecisions, pigeonholeBootstrap } = await import('../server/services/gates/baseline-gate.js');
const { startSitDecisions, removeByes } = await import('../server/services/gates/start-sit-gate.js');
const { startSitPairAccuracy } = await import('../scripts/promote-early-week-weights.mjs');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { holm, normalCdf } = await import('../server/services/stats-util.js');
const { matchupSignalActive } = await import('../server/services/matchups.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const round2 = v => +v.toFixed(2);

/* ------------------------------------------------------------------ the consensus arm */

test('the consensus arm grades with C-01\'s one instrument, not a copy', () => {
  assert.equal(arm.GRADER, gradeDecisions);
  assert.equal(arm.PAIR_BOOTSTRAP, pigeonholeBootstrap);
  assert.equal(arm.DECISIONS, startSitDecisions);
});

test('weekBand splits weeks 2-18 into the four pre-registered bands', () => {
  const got = Object.fromEntries([1, 2, 4, 5, 8, 9, 13, 14, 18, 19].map(w => [w, arm.weekBand(w)]));
  assert.deepEqual(got, { 1: null, 2: '2-4', 4: '2-4', 5: '5-8', 8: '5-8', 9: '9-13', 13: '9-13',
    14: '14-18', 18: '14-18', 19: null });
});

test('parseEcrCsv reads the benchmark export and refuses a file without its columns', () => {
  const rows = arm.parseEcrCsv('page_type,scrape_date,id,pos,team,ecr\nweekly-wr,2023-10-06,19788,WR,MIA,1.5\n'
    + 'weekly-rb,2023-10-06,17240,RB,SF,NA\n');
  assert.deepEqual(rows, [{ page_type: 'weekly-wr', scrape_date: '2023-10-06', fp_id: '19788', pos: 'WR', team: 'MIA', ecr: 1.5 }]);
  assert.throws(() => arm.parseEcrCsv('page_type,scrape_date,pos\nweekly-wr,2023-10-06,WR\n'), /missing column/);
});

test('splitCsvLine keeps quoted commas and escaped quotes; parseEcrCsv carries player only when present', () => {
  assert.deepEqual(arm.splitCsvLine('a,"b, c","d ""e""",'), ['a', 'b, c', 'd "e"', '']);
  const rows = arm.parseEcrCsv('page_type,scrape_date,id,player,pos,team,ecr\n'
    + 'weekly-wr,2023-10-06,1,"Beckham, Odell",WR,MIA,3\n');
  assert.deepEqual(rows, [{ page_type: 'weekly-wr', scrape_date: '2023-10-06', fp_id: '1', pos: 'WR', team: 'MIA', ecr: 3,
    player: 'Beckham, Odell' }]);
});

// 2023 weeks 4-6 and 2025 weeks 2-3, as game_lines would give them (Thursday to Monday).
// 2023 week 3 is deliberately absent: a week whose previous week is unknown maps nothing.
const GAMES = [
  ...['2023-09-28', '2023-10-01', '2023-10-02'].map(d => ({ season: 2023, week: 4, gameday: d })),
  ...['2023-10-05', '2023-10-08', '2023-10-09'].map(d => ({ season: 2023, week: 5, gameday: d })),
  ...['2023-10-12', '2023-10-15', '2023-10-16'].map(d => ({ season: 2023, week: 6, gameday: d })),
  ...['2025-09-11', '2025-09-14', '2025-09-15'].map(d => ({ season: 2025, week: 2, gameday: d })),
  ...['2025-09-18', '2025-09-21', '2025-09-22'].map(d => ({ season: 2025, week: 3, gameday: d })),
  { season: 2023, week: 20, gameday: '2024-01-20' }
];
const BOUNDS = arm.weekBounds(GAMES);

test('weekBounds keeps regular-season weeks only, with each week\'s first and last game date', () => {
  assert.deepEqual(BOUNDS.get('2023|5'), { season: 2023, week: 5, first: '2023-10-05', last: '2023-10-09' });
  assert.equal(BOUNDS.has('2023|20'), false);
});

test('weekForScrape: the week whose last game is on or after the scrape, previous week over, within 7 days', () => {
  assert.deepEqual(arm.weekForScrape('2023-10-06', BOUNDS), { season: 2023, week: 5 });   // Friday
  assert.deepEqual(arm.weekForScrape('2023-10-09', BOUNDS), { season: 2023, week: 5 });   // Monday night still week 5
  assert.deepEqual(arm.weekForScrape('2023-10-10', BOUNDS), { season: 2023, week: 6 });   // Tuesday: 6 days to Monday
  assert.deepEqual(arm.weekForScrape('2023-09-25', BOUNDS), null);                        // week 3 never loaded
  assert.equal(arm.weekForScrape('2024-03-01', BOUNDS), null);
  // Exactly 7 days before the last game is inside the window; 8 is not.
  const tight = arm.weekBounds([{ season: 2024, week: 1, gameday: '2024-09-12' }]);
  assert.deepEqual(arm.weekForScrape('2024-09-05', tight), { season: 2024, week: 1 });
  assert.equal(arm.weekForScrape('2024-09-04', tight), null);
});

test('latestScrapeByWeek keeps the latest scrape of each week', () => {
  const got = arm.latestScrapeByWeek(['2023-10-03', '2023-10-06', '2023-10-13', '2024-03-01'], BOUNDS);
  assert.deepEqual([...got], [['2023|5', '2023-10-06'], ['2023|6', '2023-10-13']]);
});

test('ecrConsensus drops the held-out season before any id join, maps ids and positions, one scrape a week', () => {
  const looked = [];
  const ids = new Map([['1', 101], ['2', 102], ['3', 103], ['25', 125]]);
  const idMap = { get: id => { looked.push(id); return ids.get(id); } };
  const positions = new Map([[101, 'WR'], [102, 'WR'], [103, 'WR'], [125, 'RB']]);
  const rows = [
    { page_type: 'weekly-wr', scrape_date: '2023-10-03', fp_id: '1', pos: 'WR', team: 'A', ecr: 9 },    // older scrape of week 5
    { page_type: 'weekly-wr', scrape_date: '2023-10-06', fp_id: '1', pos: 'WR', team: 'A', ecr: 4 },
    { page_type: 'weekly-rb', scrape_date: '2023-10-06', fp_id: '2', pos: 'RB', team: 'A', ecr: 7 },    // app says WR
    { page_type: 'weekly-wr', scrape_date: '2023-10-06', fp_id: '9', pos: 'WR', team: 'A', ecr: 12 },   // no id map
    { page_type: 'weekly-k', scrape_date: '2023-10-06', fp_id: '3', pos: 'K', team: 'A', ecr: 1 },
    { page_type: 'weekly-wr', scrape_date: '2023-09-25', fp_id: '3', pos: 'WR', team: 'A', ecr: 2 },    // maps to no week
    { page_type: 'weekly-rb', scrape_date: '2025-09-19', fp_id: '25', pos: 'RB', team: 'B', ecr: 3 }    // 2025 week 3
  ];
  const got = arm.ecrConsensus(rows, { bounds: BOUNDS, idMap, positionOf: id => positions.get(id), excludeSeasons: [2025] });
  assert.deepEqual([...got.values], [['2023|5|101', { value: -4, ecr: 4, scrape_date: '2023-10-06' }]]);
  assert.equal(looked.includes('25'), false, 'a 2025 row reached the id join');
  assert.deepEqual(got.counts, { rows_in: 7, not_skill_page: 1, unmapped_week: 1, excluded_season: 1,
    not_latest_scrape: 1, unmapped_player: 1, position_mismatch: 1, duplicate: 0, kept: 1,
    by_season: { 2023: { weeks: 1, kept: 1 } } });
  assert.deepEqual([...got.scrapeByWeek], [['2023|5', '2023-10-06']]);
});

test('leakGuard drops a player whose team played on or before the scrape date, and counts why', () => {
  const scrapeByWeek = new Map([['2023|5', '2023-10-06']]);
  const dates = { A: '2023-10-05', B: '2023-10-06', C: '2023-10-08' };
  const rows = ['A', 'B', 'C', 'D'].map((team, i) => ({ season: 2023, week: 5, player_id: i, team_prev: team }))
    .concat([{ season: 2023, week: 6, player_id: 9, team_prev: 'C' }]);
  const got = arm.leakGuard(rows, { scrapeByWeek, gameDateOf: (s, w, t) => (s === 2023 && w === 5 ? dates[t] : '2023-10-15') });
  assert.deepEqual(got.kept.map(r => r.player_id), [2]);
  assert.deepEqual({ ...got, kept: undefined }, { kept: undefined, dropped_game_on_or_before_scrape: 2, no_game_date: 1, no_scrape: 1 });
});

test('commonSet keeps a row only when every point arm reaches the threshold and consensus ranks him', () => {
  const base = { ours: 5, D: 5, A: 5, std: 5, l3: 5, consensus: -3 };
  const rows = [base, { ...base, l3: 3.99 }, { ...base, consensus: null }, { ...base, ours: 9, D: 9, A: 9, std: 9, l3: 8 }];
  const pointArms = ['ours', 'D', 'A', 'std', 'l3'];
  assert.equal(arm.commonSet(rows, { pointArms, threshold: 4 }).length, 2);
  assert.equal(arm.commonSet(rows, { pointArms, threshold: 8 }).length, 1);
  assert.equal(arm.commonSet([{ ...base, std: NaN }], { pointArms, threshold: 4 }).length, 0);
});

// One season, two weeks, three WRs and two TEs a week: values and actuals chosen by hand.
function fixture() {
  const r = (week, position, player_id, ours, std, consensus, actual) =>
    ({ season: 2024, week, position, player_id, ours, std, consensus, actual, D: ours, A: ours, l3: std });
  return [
    r(5, 'WR', 1, 15, 10, -3, 20), r(5, 'WR', 2, 12, 14, -1, 8), r(5, 'WR', 3, 9, 12, -2, 11),
    r(5, 'TE', 4, 8, 7, -1, 6), r(5, 'TE', 5, 7, 9, -2, 9),
    r(6, 'WR', 1, 14, 11, -1, 5), r(6, 'WR', 2, 13, 13, -3, 13), r(6, 'WR', 3, 10, 12, -2, 12),
    r(6, 'TE', 4, 8, 8, -2, 4), r(6, 'TE', 5, 8, 9, -1, 7)
  ];
}

test('pairScore is startSitPairAccuracy\'s rule, and headToHead\'s pair accuracy equals it on point arms', () => {
  assert.equal(arm.pairScore(10, 5, 8, 3), 1);
  assert.equal(arm.pairScore(10, 5, 3, 8), 0);
  assert.equal(arm.pairScore(10, 10, 3, 8), 0.5);
  assert.equal(arm.pairScore(10, 5, 8, 8), 0.5);
  const rows = fixture();
  const h = arm.headToHead(rows, 'ours', 'std', { iterations: 200 });
  const canonical = startSitPairAccuracy(rows.map(x => ({ week: x.week, position: x.position, actual: x.actual,
    preds: { ours: x.ours, std: x.std } })), ['ours', 'std'], { threshold: 4 });
  assert.equal(h.pairs, canonical.pairs);
  assert.equal(h.pair_accuracy.policy, +canonical.accuracy.ours.toFixed(4));
  assert.equal(h.pair_accuracy.baseline, +canonical.accuracy.std.toFixed(4));
  assert.equal(h.pair_accuracy.diff, +(canonical.accuracy.ours - canonical.accuracy.std).toFixed(4));
  assert.ok(Array.isArray(h.pair_accuracy.ci90) && h.pair_accuracy.ci90[0] <= h.pair_accuracy.ci90[1]);
});

test('headToHead orients each disagreement to the policy\'s pick and grades it with gradeDecisions', () => {
  const rows = fixture();
  const h = arm.headToHead(rows, 'ours', 'consensus', { iterations: 200 });
  // Week 5 WR: ours 1>2>3, consensus 2>3>1 -> pairs (1,2) and (1,3) disagree, (2,3) agrees.
  // Week 5 TE: ours 4>5, consensus 4>5 -> agree. Week 6 WR: ours 1>2>3, consensus 1>3>2 -> (2,3) disagrees.
  // Week 6 TE: ours ties 4 and 5 -> no call.
  const want = [
    { season: 2024, week: 5, policy_id: 1, baseline_id: 2, policy_points: 20, baseline_points: 8 },
    { season: 2024, week: 5, policy_id: 1, baseline_id: 3, policy_points: 20, baseline_points: 11 },
    { season: 2024, week: 6, policy_id: 2, baseline_id: 3, policy_points: 13, baseline_points: 12 }
  ];
  const direct = gradeDecisions(want, { iterations: 200 });
  assert.equal(h.decisions.n, 3);
  assert.equal(h.decisions.win_rate, direct.win_rate);
  assert.equal(h.decisions.points_per_decision, direct.points_per_decision);
  assert.deepEqual(h.decisions.ci90, direct.ci90);
  assert.equal(h.decisions.points_per_decision, +((12 + 9 + 1) / 3).toFixed(4));
  assert.equal(h.verdict, arm.cellVerdict(direct));
});

test('the oracle wins every disagreement it has, and a policy against itself has none', () => {
  const rows = fixture();
  const c = arm.instrumentControl(rows, 'consensus');
  assert.equal(c.passed, true);
  assert.ok(c.oracle.n > 0);
  assert.equal(c.oracle.win_rate, 1);
  assert.ok(c.oracle.points_per_decision > 0);
  assert.equal(c.identity.n, 0);
  // A consensus column equal to the actuals leaves the oracle nothing to win: the control fails.
  assert.equal(arm.instrumentControl(rows.map(x => ({ ...x, consensus: x.actual })), 'consensus').passed, false);
});

test('cellVerdict: ahead needs both player-clustered bounds; behind needs the points bound below 0', () => {
  const g = (points, winRate, n = 50) => ({ n, ci90: { player: { points, win_rate: winRate } } });
  assert.equal(arm.cellVerdict(g([0.1, 1.2], [0.51, 0.6])), 'policy_ahead');
  assert.equal(arm.cellVerdict(g([0.1, 1.2], [0.5, 0.6])), 'not_distinguishable');
  assert.equal(arm.cellVerdict(g([0, 1.2], [0.52, 0.6])), 'not_distinguishable');
  assert.equal(arm.cellVerdict(g([-2, -0.1], [0.4, 0.49])), 'baseline_ahead');
  assert.equal(arm.cellVerdict(g([-2, 0], [0.4, 0.49])), 'not_distinguishable');
  assert.equal(arm.cellVerdict(g(null, null, 0)), 'no_disagreements');
});

test('twoSidedP and holmCells: Holm from stats-util, and a verdict counts only when the CI and Holm agree', () => {
  const g = (ppd, se, points, winRate) => ({ n: 100, points_per_decision: ppd, se: { points: se },
    ci90: { player: { points, win_rate: winRate } } });
  const cells = [
    { key: 'a', grade: g(-1.0, 0.2, [-1.3, -0.7], [0.40, 0.46]) },     // p ~ 5.7e-7: survives Holm
    { key: 'b', grade: g(0.33, 0.2, [0.001, 0.66], [0.501, 0.55]) },   // CI ahead, p ~ 0.099 raw: fails Holm (x2)
    { key: 'c', grade: { n: 0, ci90: {} } }
  ];
  const p = cells.map(c => arm.twoSidedP(c.grade));
  assert.equal(p[0], 2 * (1 - normalCdf(Math.abs(-1.0 / 0.2))));
  assert.equal(p[2], null);
  const got = arm.holmCells(cells, { alpha: 0.10 });
  const adjusted = holm([p[0], p[1], 1]);
  assert.deepEqual(got.map(c => c.p_holm), adjusted);
  assert.deepEqual(got.map(c => [c.key, c.ci_verdict, c.verdict]), [
    ['a', 'baseline_ahead', 'baseline_ahead'],
    ['b', 'policy_ahead', 'not_distinguishable'],
    ['c', 'no_disagreements', 'no_disagreements']
  ]);
});

test('breakouts partition the pairs: season, band and position cells add up to the pooled pairs', () => {
  const rows = fixture().concat(fixture().map(x => ({ ...x, season: 2023, week: x.week + 8 })));
  const pooled = arm.headToHead(rows, 'ours', 'consensus', { iterations: 100 });
  const b = arm.breakouts(rows, 'ours', 'consensus', { iterations: 100 });
  const sum = cells => Object.values(cells).reduce((s, c) => s + c.pairs, 0);
  assert.equal(sum(b.by_season), pooled.pairs);
  assert.equal(sum(b.by_band), pooled.pairs);
  assert.equal(sum(b.by_position), pooled.pairs);
  assert.deepEqual(Object.keys(b.by_band).sort(), ['14-18', '5-8', '9-13']);
  assert.equal(b.by_season[2024].decisions.per_week, undefined, 'breakout cells drop the weekly table');
});

/* ------------------------------------------------------------------ the served rows */

test('the served chain is the served functions, not copies', () => {
  assert.equal(lib.SERVED_CHAIN.constructArms, s02.constructArms);
  assert.equal(lib.SERVED_CHAIN.startSitWeekPoints, startSitWeekPoints);
  assert.equal(lib.SERVED_CHAIN.removeByes, removeByes);
});

test('the default chance to play and the game multiplier are the ones trade-engine.js serves', () => {
  const source = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  assert.match(source, new RegExp(`availability\\?\\.active_probability \\?\\? ${lib.DEFAULT_ACTIVE_PROBABILITY}\\b`));
  assert.match(source, /currentWeekBasePpg \* thisGame\.mult \* activeProbability/);
  assert.equal(lib.THIS_GAME_MULT, 1);
  assert.equal(matchupSignalActive(), false, 'a matchup multiplier is on: thisGame.mult is no longer 1');
});

test('2025 is refused: not requested, and every season gate throws on it', () => {
  assert.equal(lib.REQUESTED_SEASONS.includes(2025), false);
  assert.deepEqual([...lib.REQUESTED_SEASONS], [2021, 2022, 2023, 2024]);
  assert.throws(() => lib.assertNotHoldout(2025), /2025/);
  assert.equal(lib.assertNotHoldout(2024), 2024);
  assert.throws(() => lib.kControlSeasons([2024, 2025], () => ({ target_share: { ALL: 0.3 } })), /2025/);
});

test('kControlSeasons grades a season with a fitted k and excludes one whose k is missing or the hand-set 6', () => {
  const k = { 2021: null, 2022: { target_share: { ALL: 6 } }, 2023: { target_share: { ALL: 0.46 } } };
  const got = lib.kControlSeasons([2021, 2022, 2023], season => k[season]);
  assert.deepEqual(got.graded, [{ season: 2023, target_share_k: 0.46 }]);
  assert.deepEqual(got.excluded.map(e => e.season), [2021, 2022]);
  assert.match(got.excluded[0].reason, /missing/);
  assert.match(got.excluded[1].reason, /= 6/);
});

test('coordinatorRegistry fits each season on examples that end the season before; gradingFit re-checks', () => {
  const examples = [2021, 2021, 2022, 2022, 2023].map((season, i) => ({ season, week: 3, i }));
  const fit = rows => ({ ready: true, n: rows.length, maxSeason: Math.max(...rows.map(r => r.season)) });
  const reg = lib.coordinatorRegistry(examples, [2022, 2023, 2024], { fit });
  assert.deepEqual([...reg].map(([s, v]) => [s, v.through, v.fitS.n, v.fitS.maxSeason]),
    [[2022, 2021, 2, 2021], [2023, 2022, 4, 2022], [2024, 2023, 5, 2023]]);
  assert.equal(lib.gradingFit(reg, 2023).through, 2022);
  assert.throws(() => lib.gradingFit(new Map([[2023, { fitS: {}, through: 2023 }]]), 2023), /cutoff/);
  assert.throws(() => lib.gradingFit(reg, 2025), /2025/);
  assert.throws(() => lib.coordinatorRegistry(examples, [2021], { fit }), /no examples/);
  assert.throws(() => lib.coordinatorRegistry(examples, [2023], { fit: () => ({ ready: false, reason: 'x' }) }), /not ready/);
});

test('teamAtWeek maps a player and week to the team he played for', () => {
  const m = lib.teamAtWeek([{ player_id: 7, week: 4, team: 'BUF' }, { player_id: 7, week: 5, team: null }]);
  assert.equal(m.get('7|4'), 'BUF');
  assert.equal(m.has('7|5'), false);
});

function servedFixture() {
  const proj = (id, position, team, heads) => ({ player_id: id, position, team, ppg: 10, structural_ppg: 9, params: {},
    player_week_engine: { heads } });
  const engine = new Map([
    [1, proj(1, 'WR', 'HI', { season_to_date: 11, last3: 12 })],
    [2, proj(2, 'RB', 'LO', { season_to_date: 7, last3: 6 })],
    [3, proj(3, 'TE', 'HI', { season_to_date: 5, last3: 4 })],     // did not play week 5: not a decision row
    [4, proj(4, 'K', 'HI', { season_to_date: 8, last3: 8 })]       // not a skill position
  ]);
  const weeks = entries => ({ weeks: new Map(entries) });
  const truth = new Map([[1, weeks([[4, 10], [5, 12], [6, 15]])], [2, weeks([[5, 9]])], [3, weeks([[4, 3], [6, 8]])],
    [4, weeks([[5, 8], [6, 8]])]]);
  const lift = { HI: 1.1, LO: 0.9 };
  const deps = {
    constructArms: p => ({ A: p.ppg, B: p.ppg - 0.5, D: (p.ppg - 0.5) * lift[p.team], lift: lift[p.team], lift_applied: true }),
    startSitWeekPoints: (p) => ({ week_points: round2(p.current_week_ppg * lift[p.team_abbr]) })
  };
  return { engine, truth, deps, availability: new Map([[1, { active_probability: 0.85 }]]) };
}

test('servedWeekRows builds OURS as round2(round2(B x p) x lift) through the served startSitWeekPoints', () => {
  const { engine, truth, deps, availability } = servedFixture();
  const rows = lib.servedWeekRows({ season: 2024, week: 6, engine, truth, fitS: {}, availability, scoring: {} }, deps);
  assert.deepEqual(rows.map(r => r.player_id), [1, 2]);
  const [a, b] = rows;
  assert.equal(a.p, 0.85);
  assert.equal(a.ours, round2(round2(9.5 * 0.85) * 1.1));
  assert.equal(b.p, lib.DEFAULT_ACTIVE_PROBABILITY);
  assert.equal(b.ours, round2(round2(9.5 * 0.92) * 0.9));
  assert.deepEqual([a.std, a.l3, a.A, a.D, a.B], [11, 12, 10, 9.5 * 1.1, 9.5]);
  assert.deepEqual([a.played, a.actual, b.played, b.actual], [true, 15, false, 0]);
  assert.deepEqual([a.season, a.week, a.position], [2024, 6, 'WR']);
});

test('servedWeekRows stops when D is not what the served startSitWeekPoints makes of B', () => {
  const { engine, truth, deps, availability } = servedFixture();
  const broken = { ...deps, constructArms: p => ({ ...deps.constructArms(p), D: 99 }) };
  assert.throws(() => lib.servedWeekRows({ season: 2024, week: 6, engine, truth, fitS: {}, availability, scoring: {} }, broken),
    /parity/);
});

test('the full run refuses an uncommitted or edited pre-registration', () => {
  const git = answers => (...a) => answers[a[0]] ?? '';
  assert.throws(() => lib.preregState(git({ 'ls-files': '' }), 'p.md'), /not committed/);
  assert.throws(() => lib.preregState(git({ 'ls-files': 'p.md', status: ' M p.md' }), 'p.md'), /uncommitted/);
  assert.deepEqual(lib.preregState(git({ 'ls-files': 'p.md', status: '', log: 'abc', 'rev-parse': 'blob1' }), 'p.md'),
    { path: 'p.md', commit: 'abc', blob: 'blob1' });
});
