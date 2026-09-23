/**
 * nflverse participation carries four charted columns that `ingestFormations`
 * reads past and throws away: was_pressure, time_to_throw,
 * defense_man_zone_type and defense_coverage_type. Storing them is package #9's
 * ask. Storing them *correctly* is the work, because the file lies in a
 * specific way.
 *
 * Measured on the real 2024 file (45,919 rows,
 * docs/evidence/participation-dropback-contamination.mjs):
 *
 *   was_pressure is non-blank on 45,905 rows, but 23,497 of those (51.2%) are
 *   plays with no coverage charted at all — runs, kneels, punts, kicks. They
 *   read 'FALSE', and only 20 of the 23,497 say 'TRUE'. Averaged in, they halve
 *   the pressure rate: 0.1539 against 0.3145 over charted dropbacks.
 *
 * So a blank-means-null rule is not enough. was_pressure has to be NULL when
 * the play was not a dropback, and the discriminator is *coverage charted*, not
 * time_to_throw: 2,689 rows have coverage but no time_to_throw, and 1,990 of
 * them (74%) are pressured. Those are the sacks and scrambles — gating on
 * time_to_throw would delete the pressure signal exactly where it is strongest.
 *
 * And the insert is ON CONFLICT DO NOTHING, so widening the table alone leaves
 * every existing row NULL forever. ingestCharting already hit this at migration
 * 059 and switched to DO UPDATE; this is the same trap on the sibling table.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-participation-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const COLS = ['nflverse_game_id', 'play_id', 'possession_team', 'offense_formation',
  'offense_personnel', 'defenders_in_box', 'defense_personnel', 'number_of_pass_rushers',
  'time_to_throw', 'was_pressure', 'route', 'defense_man_zone_type', 'defense_coverage_type'];
// Personnel strings contain commas, which is why splitCsv honours quotes —
// the fixture has to quote them or every later column shifts.
const cell = v => (String(v).includes(',') ? `"${v}"` : String(v));
const line = o => COLS.map(c => cell(o[c] ?? '')).join(',');

/** Shapes taken from real 2024 rows; see the header. */
const PLAYS = [
  // a charted dropback, pressured
  { nflverse_game_id: '2024_01_TEN_CHI', play_id: 85, possession_team: 'CHI',
    offense_formation: 'SHOTGUN', offense_personnel: '1 RB, 1 TE, 3 WR', defenders_in_box: 7,
    defense_personnel: '4 DL, 2 LB, 5 DB', number_of_pass_rushers: 4, time_to_throw: 2.55,
    was_pressure: 'TRUE', defense_man_zone_type: 'ZONE_COVERAGE', defense_coverage_type: 'COVER_2' },
  // a charted dropback, clean, man coverage
  { nflverse_game_id: '2024_01_TEN_CHI', play_id: 108, possession_team: 'CHI',
    offense_formation: 'SHOTGUN', offense_personnel: '1 RB, 1 TE, 3 WR', defenders_in_box: 5,
    defense_personnel: '4 DL, 1 LB, 6 DB', number_of_pass_rushers: 4, time_to_throw: 2.96,
    was_pressure: 'FALSE', defense_man_zone_type: 'MAN_COVERAGE', defense_coverage_type: '2_MAN' },
  // a sack: coverage charted, no time_to_throw, pressured — the 74% case
  { nflverse_game_id: '2024_01_TEN_CHI', play_id: 120, possession_team: 'CHI',
    offense_formation: 'SHOTGUN', offense_personnel: '1 RB, 1 TE, 3 WR', defenders_in_box: 6,
    defense_personnel: '4 DL, 2 LB, 5 DB', number_of_pass_rushers: 5, time_to_throw: '',
    was_pressure: 'TRUE', defense_man_zone_type: 'ZONE_COVERAGE', defense_coverage_type: 'COVER_3' },
  // NOT a dropback: a run. was_pressure reads FALSE and rushers reads 0, and
  // both are absence of a pass play, not measurements of one.
  { nflverse_game_id: '2024_01_TEN_CHI', play_id: 40, possession_team: 'CHI',
    offense_formation: 'I_FORM', offense_personnel: '2 RB, 1 TE, 2 WR', defenders_in_box: 0,
    defense_personnel: '4 DL, 3 LB, 4 DB', number_of_pass_rushers: 0, time_to_throw: '',
    was_pressure: 'FALSE', defense_man_zone_type: '', defense_coverage_type: '' }
];

const csv = [COLS.join(','), ...PLAYS.map(line)].join('\n') + '\n';
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => csv });

const { ingestFormations, formationDistribution } = await import('../server/services/nfl-formations.js');

// A row stored before the columns existed, to prove a re-ingest fills them in.
run(`INSERT INTO nfl_play_formations (game_id, play_id, season, possession, offense_formation,
     offense_personnel, defense_personnel, defenders_in_box, pass_rushers)
     VALUES (?,?,?,?,?,?,?,?,?)`,
'2024_01_TEN_CHI', 85, 2024, 'CHI', 'SHOTGUN', '1 RB, 1 TE, 3 WR', '4 DL, 2 LB, 5 DB', 7, 4);

await ingestFormations(2024);

const play = id => rows('SELECT * FROM nfl_play_formations WHERE game_id=? AND play_id=?',
  '2024_01_TEN_CHI', id)[0];

test('the four charted columns are stored on a dropback', () => {
  const p = play(108);
  assert.equal(p.was_pressure, 0);
  assert.equal(p.time_to_throw, 2.96);
  assert.equal(p.defense_man_zone_type, 'MAN_COVERAGE');
  assert.equal(p.defense_coverage_type, '2_MAN');
});

test('a pressured dropback keeps its pressure', () => {
  assert.equal(play(85).was_pressure, 1);
});

test('a sack keeps its pressure — coverage is the discriminator, not time_to_throw', () => {
  const p = play(120);
  assert.equal(p.was_pressure, 1, 'gating on time_to_throw would null this out');
  assert.equal(p.time_to_throw, null);
  assert.equal(p.defense_coverage_type, 'COVER_3');
});

test('a run stores NULL pressure, not a FALSE that averages in as a clean dropback', () => {
  const p = play(40);
  assert.equal(p.was_pressure, null);
  assert.equal(p.time_to_throw, null);
  assert.equal(p.defense_man_zone_type, null);
  assert.equal(p.defense_coverage_type, null);
});

test('a re-ingest backfills rows stored before the columns existed', () => {
  // play 85 was inserted narrow above; ON CONFLICT DO NOTHING would leave it NULL.
  assert.equal(play(85).defense_coverage_type, 'COVER_2');
  assert.equal(play(85).time_to_throw, 2.55);
});

/*
 * The gate at nfl-model-growth.js:200 read `if (season <= 2023)`, on the belief
 * that nflverse stops publishing participation after 2023. It does not — 2024
 * and 2025 both serve, and only the current season 404s, which is what commit
 * 1d8f6aa corrected in this module's own doc comment. These two prove the gate
 * has nothing left to protect: a post-2023 season ingests, and an unpublished
 * one returns an honest note instead of throwing, so attempting it costs a
 * recorded 404 rather than a failure.
 */
test('a season after 2023 ingests — the gate had nothing to protect', () => {
  assert.equal(play(85).season, 2024);
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_play_formations WHERE season=2024')[0].n, 4);
});

test('an unpublished season returns the honest note rather than throwing', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  try {
    const out = await ingestFormations(2026);
    assert.match(out.error, /participation for 2026 returned 404/);
    assert.match(out.note, /has not published participation for 2026/);
  } finally { globalThis.fetch = saved; }
});

test('a server error carries no reassuring note — only a 404 means "not published"', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  try {
    const out = await ingestFormations(2025);
    assert.match(out.error, /returned 500/);
    assert.equal(out.note, undefined);
  } finally { globalThis.fetch = saved; }
});

test('the mean box count excludes the zeros its own distribution query already excludes', () => {
  // formationDistribution filters defenders_in_box > 0 for its histogram but
  // not for AVG(). I_FORM's only play has box 0, so a mean of 0 is the tell.
  // Shotgun's three plays are 7, 5 and 6.
  const s = formationDistribution({ season: 2024 });
  const iform = s.formations.find(f => f.formation === 'I_FORM');
  assert.equal(iform.mean_defenders_in_box, null, 'zero defenders in the box is not a measurement');
  const shotgun = s.formations.find(f => f.formation === 'SHOTGUN');
  assert.equal(shotgun.mean_defenders_in_box, 6);
  // Same for the rusher mean: 23,754 of the 2024 rows read 0 because the play
  // was not a dropback, and a formation whose only play is a run has no mean.
  assert.equal(iform.mean_pass_rushers, null);
  assert.equal(shotgun.mean_pass_rushers, 4.33);
});
