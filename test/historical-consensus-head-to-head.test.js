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
 *   - every fit that grades a season ends before it, and the k control stops a season;
 *   - servedWeekRows takes its fit from the walk-forward registry itself (it refuses one that
 *     does not end before the season), hands that fit to constructArms, and reads every lift
 *     at the graded season and week (skeptics X1, X3, X5);
 *   - the leak guard's game date is keyed by season, week and team in a tested function (X4);
 *   - the pair-accuracy interval resamples both players of each pair (X2);
 *   - headToHead's default pair threshold is C-01's startable line, so on C-01's own rows it
 *     gives C-01's served-vs-ESPN grade exactly (one number, one producer).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hx01-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const arm = await import('../scripts/consensus-arm.mjs');
const lib = await import('../scripts/historical-consensus-lib.mjs');
const s02 = await import('../scripts/weekly-construction-grade-lib.mjs');
const { gradeDecisions, pigeonholeBootstrap } = await import('../server/services/gates/baseline-gate.js');
const {
  startSitDecisions, removeByes, servedArms, servedSnapshots, espnProjections, substitute, STARTABLE_PPR
} = await import('../server/services/gates/start-sit-gate.js');
const { startSitPairAccuracy } = await import('../scripts/promote-early-week-weights.mjs');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { holm, normalCdf } = await import('../server/services/stats-util.js');
const { matchupSignalActive } = await import('../server/services/matchups.js');
const { weeklyAvailability } = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const round2 = v => +v.toFixed(2);
const r4 = v => +v.toFixed(4);
/** The historical grade pairs rows that are already the common set, so it passes no threshold of its own. */
const NO_THRESHOLD = Object.freeze({ threshold: -Infinity });

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

test('gameDateLookup keys each game date by season, week and team, and the leak guard reads it (skeptic X4, standing row R5)', () => {
  // game_lines has one row per (season, week, team) (its primary key). Team A plays Thursday of
  // week 5 and Sunday of week 6; C plays Sunday of week 5; B is on a bye in week 5; 2022 is another season.
  const lookup = arm.gameDateLookup([
    { season: 2023, week: 5, team: 'A', gameday: '2023-10-05' },
    { season: 2023, week: 5, team: 'C', gameday: '2023-10-08' },
    { season: 2023, week: 6, team: 'A', gameday: '2023-10-15' },
    { season: 2022, week: 5, team: 'A', gameday: '2022-10-09' }
  ]);
  assert.equal(lookup(2023, 5, 'A'), '2023-10-05');
  assert.equal(lookup(2023, 6, 'A'), '2023-10-15');
  assert.equal(lookup(2022, 5, 'A'), '2022-10-09');
  assert.equal(lookup(2023, 5, 'B'), undefined);
  // Friday scrape of week 5: A's Thursday game is dropped, C's Sunday game is kept, B's bye has no date.
  const rows = [['A', 1], ['C', 2], ['B', 3]].map(([team, id]) => ({ season: 2023, week: 5, player_id: id, team_prev: team }));
  const got = arm.leakGuard(rows, { scrapeByWeek: new Map([['2023|5', '2023-10-06']]), gameDateOf: lookup });
  assert.deepEqual(got.kept.map(r => r.player_id), [2]);
  assert.deepEqual([got.dropped_game_on_or_before_scrape, got.no_game_date, got.no_scrape], [1, 1, 0]);
  assert.throws(() => arm.gameDateLookup([
    { season: 2023, week: 5, team: 'A', gameday: '2023-10-05' }, { season: 2023, week: 5, team: 'A', gameday: '2023-10-08' }
  ]), /two game dates/);
});

test('commonSet keeps a row only when every point arm reaches the threshold and consensus ranks him', () => {
  const base = { ours: 5, D: 5, A: 5, std: 5, l3: 5, consensus: -3 };
  const rows = [base, { ...base, l3: 3.99 }, { ...base, consensus: null }, { ...base, ours: 9, D: 9, A: 9, std: 9, l3: 8 }];
  const pointArms = ['ours', 'D', 'A', 'std', 'l3'];
  assert.equal(arm.commonSet(rows, { pointArms, threshold: 4 }).length, 2);
  assert.equal(arm.commonSet(rows, { pointArms, threshold: 8 }).length, 1);
  assert.equal(arm.commonSet([{ ...base, std: NaN }], { pointArms, threshold: 4 }).length, 0);
});

test('withConsensus joins the consensus value for the same season, week and player, and null otherwise', () => {
  const values = new Map([['2024|6|1', { value: -3, ecr: 3, scrape_date: '2024-10-11' }], ['2024|5|2', { value: -1 }]]);
  const got = arm.withConsensus([{ season: 2024, week: 6, player_id: 1 }, { season: 2024, week: 6, player_id: 2 }], values);
  assert.deepEqual(got.map(r => r.consensus), [-3, null]);
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
  const h = arm.headToHead(rows, 'ours', 'std', { iterations: 200, ...NO_THRESHOLD });
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
  const h = arm.headToHead(rows, 'ours', 'consensus', { iterations: 200, ...NO_THRESHOLD });
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

test('the pair-accuracy interval is on policy minus baseline (sweep 1 survivor M19)', () => {
  // The policy orders by the actual points and the baseline in reverse: every pair is +1.
  const rows = [10, 12, 14, 16, 18, 20].map((actual, i) => ({ season: 2024, week: 5, position: 'WR', player_id: i + 1,
    actual, ours: actual, std: 30 - actual }));
  const h = arm.headToHead(rows, 'ours', 'std', { iterations: 200, ...NO_THRESHOLD });
  assert.equal(h.pair_accuracy.diff, 1);
  assert.deepEqual(h.pair_accuracy.ci90, [1, 1]);
});

test('the pair-accuracy interval resamples both players of each pair, not one (skeptic X2)', () => {
  // Two weeks of the fixture plus a copy two weeks later with shifted actuals: a pair set whose
  // score differences vary, so the two clusterings give different intervals.
  const rows = fixture().concat(fixture().map(x => ({ ...x, week: x.week + 2, actual: x.actual + (x.player_id % 3) * 3 })));
  const h = arm.headToHead(rows, 'ours', 'std', { iterations: 400, ...NO_THRESHOLD });
  const scored = arm.pairScores(rows, 'ours', 'std');
  const series = { diff: scored.map(s => s.sp - s.sq) };
  const both = pigeonholeBootstrap(scored.map(s => ({ policy_id: s.a, baseline_id: s.b })), series, { iterations: 400, seed: 1 }).diff;
  const one = pigeonholeBootstrap(scored.map(s => ({ policy_id: s.a, baseline_id: s.a })), series, { iterations: 400, seed: 1 }).diff;
  assert.deepEqual(h.pair_accuracy.ci90, both.ci90.map(r4));
  assert.equal(h.pair_accuracy.se, r4(both.se));
  assert.notDeepEqual(one.ci90.map(r4), both.ci90.map(r4), 'the fixture must tell the two clusterings apart');
});

// 2026 week 2, eight WRs, as C-01's gate reads them: the replay rows (who, the week, what he
// scored), the projection the app saved before the week, and ESPN's settled projection.
const C01_AS_OF = '2026-09-17T18:56:10.819Z';
function seedC01Week2() {
  run('DELETE FROM weekly_prediction_snapshots WHERE season = 2026');
  run('DELETE FROM league_roster_snapshots WHERE season = 2026');
  const snapshot = { 1: 10, 2: 11, 3: 12, 4: 13, 5: 25, 6: 24, 7: 6.5, 8: 22 };     // player 7 below 8.0 by ours
  const espn = { 1: 10.5, 2: 14, 3: 13.5, 4: 7.5, 5: 13, 6: 12.5, 7: 12, 8: 15 };    // player 4 below 8.0 by ESPN
  for (const [id, prediction] of Object.entries(snapshot)) {
    run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
         structural, prediction, weight_fit, mode)
         VALUES (2026, 2, ?, 'WR', ?, '2026-W1', 'fixture', ?, ?, 'frozen-2023', 'position_ensemble')`,
    Number(id), C01_AS_OF, prediction, prediction);
  }
  for (const [id, projected] of Object.entries(espn)) {
    run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
         position, lineup_slot_id, is_starter, projected_points, source, first_seen_at, changed_at)
         VALUES (1, 2026, 2, 1, ?, ?, 'WR', 20, 0, ?, 'final', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z')`,
    1000 + Number(id), Number(id), projected);
  }
  const actual = { 1: 4, 2: 17, 3: 9, 4: 21, 5: 12, 6: 3, 7: 15, 8: 8 };
  return Object.entries(actual).map(([id, a]) => ({ season: 2026, week: 2, position: 'WR', player_id: Number(id),
    policy: 9, baseline: 9, actual: a, played: a > 0 }));
}

test('headToHead defaults to C-01\'s startable line, and on C-01\'s rows gives C-01\'s served-vs-ESPN grade (one producer)', () => {
  const replayRows = seedC01Week2();
  const c01 = servedArms(2026, [2, 2], replayRows, { iterations: 200 }).vs_espn;
  // The rows C-01 grades, built with C-01's own readers: the saved projection as the policy, ESPN as the baseline.
  const saved = new Map(servedSnapshots(2026, [2, 2]).map(s => [`${s.week}|${s.player_id}`, s.prediction]));
  const rows = substitute(substitute(replayRows, saved, 'policy').rows, espnProjections(2026, [2, 2]).values, 'baseline').rows;
  const h = arm.headToHead(rows, 'policy', 'baseline', { iterations: 200 });
  assert.deepEqual([h.pairs, h.agreement_share, h.pair_accuracy.policy, h.pair_accuracy.baseline],
    [c01.pairs, c01.agreement_share, c01.pair_accuracy.policy, c01.pair_accuracy.baseline]);
  assert.deepEqual([h.decisions.n, h.decisions.win_rate, h.decisions.points_per_decision],
    [c01.n, c01.win_rate, c01.points_per_decision]);
  assert.deepEqual(h.decisions.ci90, c01.ci90);
  assert.deepEqual(h.decisions.se, c01.se);
  assert.deepEqual(h.decisions.mde80, c01.mde80);
  assert.equal(STARTABLE_PPR, 8);
  assert.equal(h.pair_threshold, STARTABLE_PPR);
  // The line is doing work on this input: players 4 and 7 each fall below it on one side.
  const unthresholded = arm.headToHead(rows, 'policy', 'baseline', { iterations: 200, ...NO_THRESHOLD });
  assert.equal(unthresholded.pair_threshold, null);
  assert.ok(unthresholded.pairs > h.pairs, `${unthresholded.pairs} pairs without the line vs ${h.pairs} with it`);
  // A kicker pair is not a start/sit pair: C-01's instrument drops it, and so does the arm's
  // pair-accuracy score (sweep 3 survivor T6). Both kickers clear the line and disagree.
  const kickers = [[90, 9, 10, 5], [91, 10, 9, 6]].map(([id, policy, baseline, actual]) =>
    ({ season: 2026, week: 2, position: 'K', player_id: id, policy, baseline, actual, played: true }));
  const withKickers = arm.headToHead(rows.concat(kickers), 'policy', 'baseline', { iterations: 200 });
  assert.deepEqual([withKickers.pairs, withKickers.rows, withKickers.decisions], [h.pairs, h.rows, h.decisions]);
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
  const pooled = arm.headToHead(rows, 'ours', 'consensus', { iterations: 100, ...NO_THRESHOLD });
  const b = arm.breakouts(rows, 'ours', 'consensus', { iterations: 100, ...NO_THRESHOLD });
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
  assert.equal(lib.SERVED_CHAIN.weeklyAvailability, weeklyAvailability);
});

test('the default chance to play and the game multiplier are the ones trade-engine.js serves', () => {
  const source = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  // FIX-285-1 moved the flag-off default into contingency.js#legacyActiveProbability.
  const contingency = fs.readFileSync(new URL('../server/services/contingency.js', import.meta.url), 'utf8');
  assert.match(source, /: legacyActiveProbability\(availability\);/);
  assert.match(contingency, new RegExp(`return row\\?\\.active_probability \\?\\? ${lib.DEFAULT_ACTIVE_PROBABILITY};`));
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

test('kControlSeasons lets any other resolver error through, never recording it as an exclusion (sweep 1 survivor L11)', () => {
  assert.throws(() => lib.kControlSeasons([2023], () => { throw new Error('database is locked'); }), /database is locked/);
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

/** The fit a registry slot carries (an identity token) and the scoring the runner passes. */
const FIT = Object.freeze({ ready: true, token: 'coordinator fit through 2023' });
const REGISTRY = new Map([[2024, Object.freeze({ fitS: FIT, through: 2023, rows: 5 })]]);
const SCORING = Object.freeze({ token: 'PPR' });

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
  // The game-script lift differs by week, as game_lines' spread and total do, so a lift read at
  // the wrong week changes a value (skeptic X1). Every fake records what it was asked for.
  const liftOf = (team, week) => ({ HI: 1.1, LO: 0.9 }[team] + (week === 6 ? 0 : 0.2));
  const log = { constructArms: [], startSitWeekPoints: [], weeklyAvailability: [] };
  const deps = {
    constructArms: (p, ctx) => {
      log.constructArms.push({ player_id: p.player_id, ...ctx });
      const m = liftOf(p.team, ctx.week);
      return { A: p.ppg, B: p.ppg - 0.5, D: (p.ppg - 0.5) * m, lift: m, lift_applied: true };
    },
    startSitWeekPoints: (p, season, week) => {
      log.startSitWeekPoints.push({ team: p.team_abbr, season, week });
      return { week_points: round2(p.current_week_ppg * liftOf(p.team_abbr, week)) };
    },
    weeklyAvailability: (season, week, opts) => {
      log.weeklyAvailability.push([season, week, opts]);
      return new Map([[1, { active_probability: 0.85 }]]);
    }
  };
  const teamAt = new Map([['1|5', 'BUF'], ['1|6', 'MIA'], ['2|5', 'NYJ'], ['2|6', 'NE']]);
  return { engine, truth, deps, calls: log.weeklyAvailability, log, teamAt };
}

const week6 = (f, over = {}) => ({ season: 2024, week: 6, engine: f.engine, truth: f.truth, registry: REGISTRY,
  scoring: SCORING, teamAt: f.teamAt, ...over });

test('servedWeekRows builds OURS as round2(round2(B x p) x lift) through the served startSitWeekPoints', () => {
  const f = servedFixture();
  const rows = lib.servedWeekRows(week6(f), f.deps);
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

test('servedWeekRows takes its fit from the walk-forward registry and refuses one that does not end before the season (skeptic X3)', () => {
  const f = servedFixture();
  const withRegistry = registry => () => lib.servedWeekRows(week6(f, { registry }), f.deps);
  assert.throws(withRegistry(new Map([[2024, { fitS: FIT, through: 2024 }]])), /cutoff/);   // a fit that has seen 2024
  assert.throws(withRegistry(new Map([[2024, { fitS: FIT, through: 2025 }]])), /cutoff/);   // the served fit, through 2025
  assert.throws(withRegistry(new Map([[2023, { fitS: FIT, through: 2022 }]])), /cutoff/);   // no fit registered for 2024
  assert.deepEqual(lib.servedWeekRows(week6(f), f.deps).map(r => r.fit_through), [2023, 2023]);
});

test('servedWeekRows hands the registered fit to constructArms and reads every lift at the graded season and week (skeptics X1, X5)', () => {
  const f = servedFixture();
  lib.servedWeekRows(week6(f), f.deps);
  assert.deepEqual(f.log.constructArms.map(c => [c.player_id, c.season, c.week, c.fitS === FIT, c.fitE === FIT, c.scoring === SCORING]),
    [[1, 2024, 6, true, true, true], [2, 2024, 6, true, true, true]]);
  // Two lift reads per decision row: B for the parity check, then OURS; each at the graded week.
  assert.deepEqual(f.log.startSitWeekPoints.map(c => [c.team, c.season, c.week]),
    [['HI', 2024, 6], ['HI', 2024, 6], ['LO', 2024, 6], ['LO', 2024, 6]]);
});

test('servedWeekRows stops when D is not what the served startSitWeekPoints makes of B', () => {
  const f = servedFixture();
  const broken = { ...f.deps, constructArms: (p, ctx) => ({ ...f.deps.constructArms(p, ctx), D: 99 }) };
  assert.throws(() => lib.servedWeekRows(week6(f), broken), /parity/);
});

test('servedWeekRows stops when OURS was not lifted by the lift constructArms read (a second lift read at another week)', () => {
  const f = servedFixture();
  let reads = 0;
  const drifts = { ...f.deps, startSitWeekPoints: (p, season, week) => f.deps.startSitWeekPoints(p, season, reads++ % 2 ? week - 1 : week) };
  assert.throws(() => lib.servedWeekRows(week6(f), drifts), /parity/);
});

test('current_week_ppg is rounded before the lift, as trade-engine.js:474 then lineup-brain.js:363 do (sweep 1 survivor L3)', () => {
  const engine = new Map([[7, { player_id: 7, position: 'WR', team: 'MID', ppg: 16.5098, structural_ppg: 9, params: {},
    player_week_engine: { heads: { season_to_date: 9, last3: 9 } } }]]);
  const truth = new Map([[7, { weeks: new Map([[4, 10], [5, 10]]) }]]);
  const deps = {
    constructArms: p => ({ A: p.ppg, B: p.ppg - 0.5, D: (p.ppg - 0.5) * 1.25, lift: 1.25, lift_applied: true }),
    startSitWeekPoints: p => ({ week_points: round2(p.current_week_ppg * 1.25) }),
    weeklyAvailability: () => new Map([[7, { active_probability: 0.5 }]])
  };
  const [row] = lib.servedWeekRows({ season: 2024, week: 6, engine, truth, registry: REGISTRY, scoring: SCORING,
    teamAt: new Map() }, deps);
  // B x p = 8.0049: rounded first it is 8.00, and 8.00 x 1.25 = 10; unrounded it is 10.006, which rounds to 10.01.
  assert.equal(row.ours, 10);
});

test('a player whose chance to play is 0 is valued 0, not the 0.92 default (?? not ||; sweep 1 survivor L4)', () => {
  const f = servedFixture();
  const out = { ...f.deps, weeklyAvailability: () => new Map([[1, { active_probability: 0 }]]) };
  const [a] = lib.servedWeekRows(week6(f), out);
  assert.deepEqual([a.player_id, a.p, a.ours], [1, 0, 0]);
});

test('servedWeekRows asks the served weeklyAvailability for the week, with the season before as the cutoff', () => {
  const f = servedFixture();
  lib.servedWeekRows(week6(f), f.deps);
  assert.deepEqual(f.calls, [[2024, 6, { through: 2023 }]]);
});

test('servedWeekRows carries the team he played for in week W-1, the team the bye rule and leak guard read', () => {
  const f = servedFixture();
  const rows = lib.servedWeekRows(week6(f), f.deps);
  assert.deepEqual(rows.map(r => [r.player_id, r.team_prev]), [[1, 'BUF'], [2, 'NYJ']]);
  const noTeam = lib.servedWeekRows(week6(f, { teamAt: new Map() }), f.deps);
  assert.deepEqual(noTeam.map(r => r.team_prev), [null, null]);
});

test('the pre-registered coordinator starts its examples at 2021; the served recipe (the post-hoc sensitivity) at 2022', () => {
  assert.equal(lib.PREREGISTERED_COORDINATOR_FROM, 2021);
  const source = fs.readFileSync(new URL('../server/services/fantasy-coordinator.js', import.meta.url), 'utf8');
  for (const fn of ['buildFantasyCoordinatorExamples', 'refitFantasyCoordinator', 'fantasyCoordinatorWalkForward']) {
    assert.match(source, new RegExp(`function ${fn}\\(\\{ fromSeason = ${lib.SERVED_COORDINATOR_FROM},`), fn);
  }
});

test('the full run refuses an uncommitted or edited pre-registration', () => {
  const git = answers => (...a) => answers[a[0]] ?? '';
  assert.throws(() => lib.preregState(git({ 'ls-files': '' }), 'p.md'), /not committed/);
  assert.throws(() => lib.preregState(git({ 'ls-files': 'p.md', status: ' M p.md' }), 'p.md'), /uncommitted/);
  assert.deepEqual(lib.preregState(git({ 'ls-files': 'p.md', status: '', log: 'abc', 'rev-parse': 'blob1' }), 'p.md'),
    { path: 'p.md', commit: 'abc', blob: 'blob1' });
});
