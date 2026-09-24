/**
 * PLAYER-SCORE: the blue-chip score (people/player-score.js), the FantasyPros bridge
 * (people/fantasypros-ros.js), the adapter board (league-adapter.mjs#blueChipBoard), the plans
 * section (view.js#blueChipsSection + plans-schema.js), protection of Nick's blue chips in the
 * planner, and the badge + panel (ScoreBadge.tsx, BlueChipBoard.tsx).
 *
 * Every player, team and rank here is made up (public repo, NICK-FP: no FantasyPros per-player data).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const score = await import('../server/services/people/player-score.js');
const fpr = await import('../server/services/people/fantasypros-ros.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { blueChipBoard, draftPicks } = await import('../scripts/campaign/league-adapter.mjs');
const { blueChipsSection } = await import('../server/services/campaign/view.js');
const schema = await import('../server/services/campaign/plans-schema.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

async function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/* ------------------------------------------------------------------ flag */

test('flag: off by default, on with its own switch, on under preview, =0 vetoes preview', async () => {
  const E = score.PLAYER_SCORE_ENV;
  await withEnv({ [PREVIEW_ENV]: null }, () => {
    assert.equal(score.playerScoreFlag({}), 'off');
    assert.equal(score.playerScoreFlag({ [E]: '1' }), 'on');
  });
  await withEnv({ [PREVIEW_ENV]: '1' }, () => {
    assert.equal(score.playerScoreFlag({}), 'preview');
    assert.equal(score.playerScoreFlag({ [E]: '0' }), 'off');
  });
});

/* --------------------------------------------------------------- labels */

test('seven labels from the score bands, and the contract spells them the same', () => {
  const cases = [[100, 'Elite blue chip'], [90, 'Elite blue chip'], [89, 'Blue chip'], [80, 'Blue chip'], [79, 'Level below'],
    [70, 'Level below'], [69, 'Solid starter'], [60, 'Solid starter'], [59, 'Flex'], [50, 'Flex'], [49, 'Depth'], [35, 'Depth'],
    [34, 'Bench'], [0, 'Bench']];
  for (const [s, l] of cases) assert.equal(score.labelOf(s), l, `score ${s}`);
  assert.deepEqual([...score.LABEL_NAMES], [...schema.SCORE_LABELS]);
  assert.deepEqual([...score.GAP_TYPES], [...schema.SCORE_GAPS]);
  assert.equal(score.WEIGHTS.pick, 0.5);
  assert.equal(score.WEIGHTS.production, 0.5);
  assert.match(score.WEIGHTS.basis, /provisional/);
});

/* ---------------------------------------------------------------- score */

// A made-up 10-pick draft and 5 WRs; team A has played 4 games (not early).
const WRS = [
  { id: 1, name: 'Alpha One', position: 'WR', espn_id: 101, team_abbr: 'AAA', ros_ppg: 18, ros_basis: { games: 4, season_to_date: 21 } },
  { id: 2, name: 'Bravo Two', position: 'WR', espn_id: 102, team_abbr: 'AAA', ros_ppg: 14, ros_basis: { games: 4, season_to_date: 15 } },
  { id: 3, name: 'Charlie Three', position: 'WR', espn_id: 103, team_abbr: 'AAA', ros_ppg: 16, ros_basis: { games: 1, season_to_date: 6 }, injury: 0 },
  { id: 4, name: 'Delta Four', position: 'WR', espn_id: 104, team_abbr: 'AAA', ros_ppg: 10, ros_basis: { games: 4, season_to_date: 12 } },
  { id: 5, name: 'Echo Five', position: 'WR', espn_id: 999, team_abbr: 'AAA', ros_ppg: 9, ros_basis: { games: 4, season_to_date: 18 } },
];
const PICKS = new Map([['101', 1], ['102', 2], ['103', 3], ['104', 10]]);

test('score = 50% pick percentile + 50% production percentile, on season ppg once teams have played 3 games', () => {
  const s = score.scorePlayers(WRS, { picks: PICKS, nPicks: 10 });
  const one = s.get('1');
  assert.equal(one.parts.pick, 1);
  assert.equal(one.parts.pick_pct, 100);
  assert.equal(one.parts.prod_basis, 'season_ppg');
  assert.equal(one.parts.pos_rank, 1);
  assert.equal(one.parts.prod_pct, 100);
  assert.equal(one.score, 100);
  assert.equal(one.label, 'Elite blue chip');
  // Pick 2 of 10 -> 88.9; 15 ppg is 3rd of 5 -> 50: round(0.5*88.9 + 0.5*50) = 69.
  assert.equal(s.get('2').score, 69);
  assert.equal(s.get('2').label, 'Solid starter');
  // Undrafted: pick percentile 0, production 2nd of 5 -> 75 -> 38.
  assert.equal(s.get('5').parts.pick, null);
  assert.equal(s.get('5').parts.pick_pct, 0);
  assert.equal(s.get('5').score, 38);
});

test('hurt: a high pick whose low production comes with missed games; the score itself is not moved', () => {
  const s = score.scorePlayers(WRS, { picks: PICKS, nPicks: 10 });
  const c = s.get('3');
  assert.equal(c.parts.missed, 3);
  assert.equal(c.hurt, true);
  assert.equal(c.score, Math.round(0.5 * (100 * 7 / 9) + 0.5 * 0));
  assert.equal(s.get('4').hurt, false, 'a late pick is never "hurt"');
  // Every game played but on the injury report: still hurt.
  const reported = WRS.map(p => (p.id === 3 ? { ...p, injury: 1, ros_basis: { games: 4, season_to_date: 6 } } : p));
  assert.equal(score.scorePlayers(reported, { picks: PICKS, nPicks: 10 }).get('3').hurt, true);
  // The same player with every game played and no report: low production, not hurt.
  const healthy = WRS.map(p => (p.id === 3 ? { ...p, injury: 0, ros_basis: { games: 4, season_to_date: 6 } } : p));
  assert.equal(score.scorePlayers(healthy, { picks: PICKS, nPicks: 10 }).get('3').hurt, false);
});

test('early season (fewer than 3 team games): production is the rest-of-season rate', () => {
  const early = WRS.map(p => ({ ...p, ros_basis: { ...p.ros_basis, games: Math.min(2, p.ros_basis.games) } }));
  const s = score.scorePlayers(early, { picks: PICKS, nPicks: 10 });
  assert.equal(s.get('1').parts.prod_basis, 'ros_ppg');
  assert.equal(s.get('3').parts.pos_rank, 2, 'ranked on ros_ppg 16, not his 6 ppg');
});

/* ----------------------------------------------------------------- gaps */

test('gap flags: each type fires on its case and not without both numbers', () => {
  assert.deepEqual(score.gapFlags({ score: 85, fp_rank: 10, model_rank: 30 }), ['undervalued_blue_chip', 'we_value_lower']);
  assert.deepEqual(score.gapFlags({ score: 85, fp_rank: 30, fp_prev_rank: 12, model_rank: 30 }), ['fading_blue_chip']);
  assert.deepEqual(score.gapFlags({ score: 65, fp_rank: 20, model_rank: 25 }), ['riser']);
  assert.deepEqual(score.gapFlags({ score: 40, fp_rank: 100, model_rank: 40 }), ['we_value_higher']);
  assert.deepEqual(score.gapFlags({ score: 85, fp_rank: null, model_rank: 30 }), []);
  assert.deepEqual(score.gapFlags({ score: 40, fp_rank: 400, model_rank: 200 }), [], 'deep ranks are not compared');
});

test('board: Nick\'s blue chips (80+) and his protected players are protected; nobody else is', () => {
  const players = WRS.map((p, i) => ({ ...p, value: 1000 - i * 100, owner: i < 3 ? '5' : '7' }));
  const b = score.buildBoard(players, { picks: PICKS, nPicks: 10, allValues: players, me: '5', untouchable: new Set(['2']) });
  assert.deepEqual([...b.protect].sort(), ['1', '2'], '1 scores 100; 2 is on his untouchable list; 3 is hurt at 39');
  assert.ok(!b.rows.find(r => r.player === '4').protected, 'another team\'s player is never "protected"');
  assert.equal(b.coverage.rostered, 5);
  assert.equal(b.coverage.score, 1);
  assert.equal(b.coverage.fp_ros_rank, 0);
  assert.equal(b.rows[0].player, '1', 'best score first');
});

/* ------------------------------------------------------- FantasyPros side */

const HEADER = 'fp_page,page_type,ecr_type,player,id,pos,team,ecr,sd,best,worst,sportsdata_id,player_filename,yahoo_id,cbs_id,player_owned_avg,player_owned_espn,player_owned_yahoo,player_image_url,player_square_image_url,rank_delta,bye,mergename,scrape_date,tm';
const line = (page, type, player, id, pos, ecr, date) => `/x,${page},${type},${player},${id},${pos},AAA,${ecr},1.0,1,9,NA,x.php,NA,NA,50,NA,NA,NA,NA,NA,7,${player},${date},AAA`;
const CSV = [HEADER,
  line('redraft-overall', 'ro', 'Alpha One', 'f1', 'WR', 3, '2026-09-24'),
  line('redraft-wr', 'rp', 'Alpha One', 'f1', 'WR', 2, '2026-09-24'),
  line('redraft-overall', 'ro', 'Bravo Two', 'f2', 'WR', 40, '2026-09-24'),
  line('redraft-overall', 'ro', 'Bravo Two', 'f2', 'WR', 12, '2026-09-10'),
  line('redraft-overall', 'ro', 'Twin Name', 'f5', 'RB', 30, '2026-09-24'),
  line('redraft-idp', 'ro', 'Some Linebacker', 'f9', 'LB', 1, '2026-09-24'),
  line('redraft-overall', 'ro', 'Alpha One', 'f1', 'WR', 9, '2026-08-30'),
  line('dynasty-overall', 'do', 'Alpha One', 'f1', 'WR', 1, '2026-09-24'),
].join('\n');

test('FantasyPros parse keeps in-season redraft rows only, folds the positional rank on', () => {
  const rows = fpr.parseRosCsv(CSV);
  assert.equal(rows.length, 4, 'preseason, IDP and dynasty rows are dropped');
  const a = rows.find(r => r.fp_id === 'f1');
  assert.equal(a.ecr, 3);
  assert.equal(a.pos_rank, 2);
  assert.equal(a.scrape_date, '2026-09-24');
  assert.equal(fpr.inSeason('2026-09-09'), false);
  assert.equal(fpr.inSeason('2026-09-10'), true);
});

const memDb = () => {
  const d = new DatabaseSync(':memory:');
  return { db: d, row: (s, ...p) => d.prepare(s).get(...p), rows: (s, ...p) => d.prepare(s).all(...p), run: (s, ...p) => d.prepare(s).run(...p) };
};

test('FantasyPros cache: never synced says so; stored scrapes join by name + position; the earlier scrape gives the trend', async () => {
  const dbm = memDb();
  const ours = [{ id: 1, name: 'Alpha One', position: 'WR' }, { id: 2, name: 'Bravo Two', position: 'WR' },
    { id: 3, name: 'Twin Name', position: 'RB' }, { id: 4, name: 'Twin Name', position: 'RB' }];
  assert.equal(fpr.fpRosFor(dbm, ours).status, 'unknown');
  const fetchImpl = async () => ({ ok: true, text: async () => CSV });
  const r = await fpr.syncFpRos(dbm, { fetchImpl });
  assert.deepEqual(r.dates, ['2026-09-10', '2026-09-24']);
  const got = fpr.fpRosFor(dbm, ours);
  assert.equal(got.status, 'ok');
  assert.equal(got.scrape_date, '2026-09-24');
  assert.equal(got.prev_date, '2026-09-10');
  assert.equal(got.byId.get('1').ecr, 3);
  assert.equal(got.byId.get('2').prev_ecr, 12);
  assert.equal(got.byId.get('3'), undefined, 'two of our players share the name: neither is guessed');
  assert.equal(fpr.fpRosFor(dbm, ours.slice(0, 3)).byId.get('3').ecr, 30, 'a unique name joins');
  // syncIfStale: fresh within a day, and a failed fetch is reported, never thrown.
  assert.equal((await fpr.syncIfStale(dbm, { fetchImpl })).status, 'fresh');
  const bad = await fpr.syncIfStale(memDb(), { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(bad.status, 'failed');
  assert.match(bad.reason, /HTTP 503/);
});

/* --------------------------------------------------------- adapter board */

function fakeSvc({ picks = [[101, 1], [102, 2], [103, 3]], fpStatus = 'unknown' } = {}) {
  const dbm = memDb();
  dbm.db.exec('CREATE TABLE league_draft_picks (league_id INTEGER, season INTEGER, overall_pick INTEGER, player_id INTEGER)');
  for (const [pid, pk] of picks) dbm.run('INSERT INTO league_draft_picks VALUES (4, 2026, ?, ?)', pk, pid);
  dbm.run('INSERT INTO league_draft_picks VALUES (4, 2025, 1, 555)');
  return { db: dbm, fpSync: { status: fpStatus } };
}

test('adapter board: off -> nothing served or protected; on -> this league\'s draft, rostered + free agents', async () => {
  const assets = new Map(WRS.map(p => [p.id, { ...p, value: 500, available: true }]));
  const players = new Map(WRS.slice(0, 4).map(p => [p.id, { ...p, value: 500 }]));
  const rosters = new Map([['5', [1, 2]], ['7', [3, 4]]]);
  const lg = { id: 4, season: 2026 };
  const off = blueChipBoard(fakeSvc(), lg, { rosters, players, assets, me: '5', env: {} });
  assert.equal(off.served.status, 'off');
  assert.equal(off.protect.size, 0);
  const on = blueChipBoard(fakeSvc(), lg, { rosters, players, assets, me: '5', env: { [score.PLAYER_SCORE_ENV]: '1' } });
  assert.equal(on.served.status, 'ok');
  assert.equal(on.served.draft.picks, 3, 'only this league\'s 2026 picks');
  assert.equal(on.served.rows.length, 5, 'four rostered + one free agent');
  assert.equal(on.served.rows.find(r => r.player === '5').owner, null);
  assert.ok(on.protect.has('1'));
  assert.equal(on.served.fp.status, 'unknown');
  assert.equal(draftPicks(fakeSvc({ picks: [] }), lg).n, 0);
});

/* ------------------------------------------------ plans section + contract */

const ENTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8')).leagues[0];

test('plans section: off/absent -> unknown with a reason; on -> typed rows that pass the contract', () => {
  assert.equal(blueChipsSection(null).status, 'unknown');
  assert.match(blueChipsSection({ status: 'off' }).reason, /GRIDIRON_PLAYER_SCORE/);
  const assets = new Map(WRS.map(p => [p.id, { ...p, value: p.id === 4 ? 0 : 500, available: true }]));
  const players = new Map(WRS.slice(0, 4).map(p => [p.id, { ...p, value: assets.get(p.id).value }]));
  const b = blueChipBoard(fakeSvc(), { id: 4, season: 2026 }, { rosters: new Map([['5', [1, 2]], ['7', [3, 4]]]), players, assets, me: '5',
    env: { [score.PLAYER_SCORE_ENV]: '1' } });
  const sec = blueChipsSection(b.served, { suggestions: [{ player: 3, gain_if_landed: 0.012, gain_se: 0.003 }] });
  assert.equal(sec.status, 'ok');
  const r3 = sec.value.rows.find(r => r.player === '3');
  assert.equal(r3.title_add.value, 0.012);
  assert.equal(r3.fp_ros_rank.status, 'unknown');
  assert.equal(sec.value.rows.find(r => r.player === '4').model_value.status, 'unknown', 'no price -> unknown, never 0');
  const entry = { ...ENTRY, blue_chips: sec };
  const v = schema.validateLeague(entry);
  assert.deepEqual(v.errors, []);
  // Breaking a row is caught.
  const broken = structuredClone(sec);
  broken.value.rows[0].label = 'Superstar';
  assert.equal(schema.validateLeague({ ...ENTRY, blue_chips: broken }).ok, false);
  assert.ok(schema.OPTIONAL_SECTIONS.includes('blue_chips'));
  assert.ok(schema.SOURCE_IDS.includes('people.score') && schema.SOURCE_IDS.includes('fp.ros'));
});

/* ------------------------------------------------ Nick's blue chips never given */

test('planner: a player in adapter.untouchable (Nick\'s blue chips join it) is never given in any step, walk-away or flip leg', () => {
  const run = untouchable => {
    const a = makeAdapter();
    if (untouchable) a.untouchable = untouchable;
    return planLeague(a, { objective: normaliseObjective({ risk_mode: 'all_in' }) });
  };
  const gives = res => {
    const out = new Set();
    for (const c of res.deck) {
      for (const st of c.plan.steps) st.give.forEach(id => out.add(String(id)));
      for (const pb of c.playbooks ?? [c.playbook]) (pb?.walk_away?.give ?? []).forEach(id => out.add(String(id)));
    }
    for (const f of res.flip.realised) for (const id of f.legs?.give_a_ids ?? (f.legs?.give_a != null ? [f.legs.give_a] : [])) out.add(String(id));
    return out;
  };
  const free = gives(run(null));
  assert.ok(free.size > 0, 'the fixture gives someone when nothing is protected');
  const protect = new Set([...free]);
  const guarded = gives(run(protect));
  for (const id of protect) assert.ok(!guarded.has(id), `protected ${id} is never given`);
});

/* ------------------------------------------------------------------- UI */

const ROWS = [
  { player: '1', name: 'Alpha One', position: 'WR', owner: '7', mine: false, score: 92, label: 'Elite blue chip', hurt: false,
    parts: { pick: 1, pick_pct: 100, prod_basis: 'ros_ppg', prod_pct: 84, games: 2, team_games: 2, missed: 0 },
    model_value: { status: 'ok', value: 9100, source: 'market.fc' }, fp_ros_rank: { status: 'ok', value: 4, source: 'fp.ros' }, gaps: [], protected: false },
  { player: '2', name: 'Bravo Two', position: 'RB', owner: '5', mine: true, score: 83, label: 'Blue chip', hurt: false,
    parts: { pick_pct: 90, prod_basis: 'ros_ppg', prod_pct: 76, games: 2, team_games: 2, missed: 0 },
    model_value: { status: 'ok', value: 7000, source: 'market.fc' }, fp_ros_rank: { status: 'unknown', source: 'fp.ros', reason: 'no match' }, gaps: [], protected: true },
  { player: '3', name: 'Charlie Three', position: 'WR', owner: '8', mine: false, score: 64, label: 'Solid starter', hurt: true,
    parts: { pick_pct: 88, prod_basis: 'ros_ppg', prod_pct: 40, games: 0, team_games: 2, missed: 2 },
    model_value: { status: 'ok', value: 5000, source: 'market.fc' }, fp_ros_rank: { status: 'ok', value: 20, source: 'fp.ros' }, gaps: ['riser'], protected: false },
];
const BOARD = { status: 'ok', source: 'people.score', value: { weights: { pick: 0.5, production: 0.5, basis: 'provisional 50/50' },
  labels: [...schema.SCORE_LABELS], rows: ROWS, coverage: { rostered: 3, board: 3, score: 1, model_value: 1, fp_ros_rank: 0.67 },
  fp: { status: 'ok', sync: 'fresh', scrape_date: '2026-09-24' }, draft: { season: 2026, picks: 170 } } };

test('badge and Blue chips panel render: score + label, hurt, filters for others / risers / mine', async () => {
  const w = await loadWarRoom();
  try {
    const { default: ScoreBadge } = await w.mod('ScoreBadge');
    const { default: BlueChipBoard, boardRows } = await w.mod('BlueChipBoard');
    const badge = textOf(renderToStaticMarkup(React.createElement(ScoreBadge, { row: ROWS[2] })));
    assert.equal(badge, '64 Solid starter · hurt');
    assert.equal(renderToStaticMarkup(React.createElement(ScoreBadge, { row: null })), '');
    const others = textOf(renderToStaticMarkup(React.createElement(BlueChipBoard, { field: BOARD, big: true })));
    assert.match(others, /Alpha One WR 92 Elite blue chip/);
    assert.match(others, /9,100/);
    assert.match(others, /#4/);
    assert.doesNotMatch(others, /Bravo Two/, 'others view leaves Nick\'s own out');
    assert.deepEqual(boardRows(BOARD.value, 'mine').map(r => r.player), ['2']);
    assert.deepEqual(boardRows(BOARD.value, 'risers').map(r => r.player), ['3']);
    const mine = textOf(renderToStaticMarkup(React.createElement(BlueChipBoard, { field: BOARD, big: true, initial: 'mine' })));
    assert.match(mine, /Bravo Two RB 83 Blue chip protected/);
    assert.match(mine, /not computed yet/, 'an unknown FantasyPros rank is never a number');
    const off = textOf(renderToStaticMarkup(React.createElement(BlueChipBoard, { field: { status: 'unknown', source: 'people.score', reason: 'off' }, big: false })));
    assert.doesNotMatch(off, /\d+ Elite/);
  } finally { w.cleanup(); }
});

test('the War Room mounts the Blue chips panel only when the board is served', () => {
  const src = fs.readFileSync(path.join(REPO, 'client', 'src', 'components', 'warroom', 'WarRoom.tsx'), 'utf8');
  assert.match(src, /view\.blue_chips && view\.blue_chips\.status === 'ok' && <BlueChipBoard/);
});
