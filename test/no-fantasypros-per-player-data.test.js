/**
 * NICK-FP guard: no committed evidence file may carry per-player FantasyPros ranks or
 * projections (WORK-QUEUE.md §12, ruling NICK-FP). HX-01 keeps its method, its scripts and our
 * own aggregate accuracy numbers; a real per-player FantasyPros export does not belong in the
 * public repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForPerPlayerFantasyPros, scanTree, GUARDED_DIRECTORIES } from '../scripts/guard-no-fantasypros-per-player.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('designed survivor: a header naming a FantasyPros id column and an ecr/rank column, followed by real data rows, is caught', () => {
  const csv = 'player,fantasypros_id,ecr\nA. Player,101,3\nB. Player,102,7\nC. Player,103,12\n';
  const violations = scanForPerPlayerFantasyPros(csv, 'docs/evidence/fake-export.md');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'docs/evidence/fake-export.md');
});

test('not-applied control: prose that only mentions fantasypros_id and ecr, with no data rows after it, is not caught', () => {
  const prose = 'The join maps fantasypros_id to gsis id; ecr is the weekly rank on that page.\n\nMore prose, no table.\n';
  const violations = scanForPerPlayerFantasyPros(prose, 'docs/tdd/fake-note.tdd.md');
  assert.deepEqual(violations, []);
});

test('a two-column mention with fewer than 3 data-shaped rows after it is not caught (one worked example, not a table)', () => {
  const oneExample = 'player,fantasypros_id,ecr\nA. Player,101,3\n\nThat is the only row we quote.\n';
  const violations = scanForPerPlayerFantasyPros(oneExample, 'docs/tdd/fake-note.tdd.md');
  assert.deepEqual(violations, []);
});

test('a raw FantasyPros export file extension committed under a guarded directory is always a violation, whatever it contains', () => {
  const violations = scanForPerPlayerFantasyPros('season,week,ecr\n2023,4,1.5\n', 'docs/evidence/2026-09-22/fp-ecr-weekly-wp.csv');
  assert.equal(violations.length, 1);
});

test('the real committed tree has zero violations under docs/evidence and docs/tdd (HX-01 already reads FantasyPros only from .local-db/, git-excluded)', () => {
  const violations = scanTree(ROOT, GUARDED_DIRECTORIES);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------------------------
// Skeptic round 1 (HX-01-FP): the checks above only used a synthetic `fantasypros_id` column,
// which the real export does not have. The cases below use the REAL export header HX-01 reads
// (`.local-db/fp-ecr-weekly-wp.csv`: page_type,scrape_date,id,player,pos,team,ecr) and the other
// realistic shapes a skeptic built, each of which the first guard returned 0 violations for.
// Rows are synthetic (made-up players), only the column layout is real.
// ---------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';

const REAL_HEADER = ['page_type', 'scrape_date', 'id', 'player', 'pos', 'team', 'ecr'];
const REAL_ROWS = [
  ['weekly-wr', '2023-10-01', '9001', 'Alpha Player', 'WR', 'AAA', '1.4'],
  ['weekly-wr', '2023-10-01', '9002', 'Bravo Player', 'WR', 'BBB', '2.9'],
  ['weekly-wr', '2023-10-01', '9003', 'Charlie Player', 'WR', 'CCC', '3.3'],
  ['weekly-wr', '2023-10-01', '9004', 'Delta Player', 'WR', 'DDD', '4.8']
];
const asPipeTable = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map(r => `| ${r.join(' | ')} |`)
].join('\n') + '\n';
const asCsv = (header, rows) => [header, ...rows].map(r => r.join(',')).join('\n') + '\n';
const asJsonRows = (header, rows) => JSON.stringify(rows.map(r => Object.fromEntries(header.map((h, k) => [h, r[k]]))), null, 2);

test('real export header, pasted as a markdown pipe table into an evidence .md, is caught', () => {
  const v = scanForPerPlayerFantasyPros(asPipeTable(REAL_HEADER, REAL_ROWS), 'docs/evidence/x/rows.md');
  assert.equal(v.length, 1);
});

test('real export header, as plain CSV text in a .txt or .md file, is caught', () => {
  assert.equal(scanForPerPlayerFantasyPros(asCsv(REAL_HEADER, REAL_ROWS), 'docs/evidence/x/rows.txt').length, 1);
  assert.equal(scanForPerPlayerFantasyPros(asCsv(REAL_HEADER, REAL_ROWS), 'docs/evidence/x/rows.md').length, 1);
});

test('real export rows as a pretty-printed JSON array of objects in a .json file are caught', () => {
  const v = scanForPerPlayerFantasyPros(asJsonRows(REAL_HEADER, REAL_ROWS), 'docs/evidence/x/rows.json');
  assert.equal(v.length, 1);
});

test('real export rows as a JSON array nested inside a larger .json document are caught', () => {
  const doc = JSON.stringify({ meta: { n: 4 }, table: JSON.parse(asJsonRows(REAL_HEADER, REAL_ROWS)) }, null, 2);
  assert.equal(scanForPerPlayerFantasyPros(doc, 'docs/evidence/x/out.json').length, 1);
});

test('a table pasted from the FantasyPros site (RK | PLAYER NAME | TEAM | POS | BEST | WORST | AVG | ECR) is caught', () => {
  const header = ['RK', 'PLAYER NAME', 'TEAM', 'POS', 'BEST', 'WORST', 'AVG', 'ECR'];
  const rows = [['1', 'Alpha Player', 'AAA', 'WR', '1', '3', '1.4', '1'], ['2', 'Bravo Player', 'BBB', 'WR', '1', '5', '2.9', '2'], ['3', 'Charlie Player', 'CCC', 'WR', '2', '6', '3.3', '3']];
  assert.equal(scanForPerPlayerFantasyPros(asPipeTable(header, rows), 'docs/evidence/x.md').length, 1);
});

test('an ECR table keyed by gsis_id (how HX-01 joins) is caught', () => {
  const header = ['gsis_id', 'season', 'week', 'ecr'];
  const rows = [['00-0030001', '2023', '4', '1.5'], ['00-0030002', '2023', '4', '2.5'], ['00-0030003', '2023', '4', '3.5']];
  assert.equal(scanForPerPlayerFantasyPros(asCsv(header, rows), 'docs/evidence/x.md').length, 1);
});

test('a FantasyPros projections table (fantasypros_id | player | fpts) is caught', () => {
  const header = ['fantasypros_id', 'player', 'fpts'];
  const rows = [['101', 'Alpha Player', '18.2'], ['102', 'Bravo Player', '16.0'], ['103', 'Charlie Player', '14.9']];
  assert.equal(scanForPerPlayerFantasyPros(asPipeTable(header, rows), 'docs/evidence/x.md').length, 1);
});

test('not-applied control: an aggregate table with an ecr LABEL column and no player identity column is not caught', () => {
  const header = ['source', 'season', 'mae', 'win_rate'];
  const rows = [['ecr', '2021', '5.1', '0.52'], ['ecr', '2022', '5.3', '0.51'], ['model', '2023', '5.0', '0.53']];
  assert.deepEqual(scanForPerPlayerFantasyPros(asPipeTable(header, rows), 'docs/evidence/x.md'), []);
});

test('known-nonzero tree control: scanTree finds a planted .md table and a planted fp-ecr .csv under guarded dirs, and nothing outside them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs/evidence/2026-09-23'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'docs/tdd'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'docs/other'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/evidence/2026-09-23/planted.md'), '# note\n\n' + asPipeTable(REAL_HEADER, REAL_ROWS));
    fs.writeFileSync(path.join(tmp, 'docs/tdd/fp-ecr-weekly-wp.csv'), asCsv(REAL_HEADER, REAL_ROWS));
    fs.writeFileSync(path.join(tmp, 'docs/other/outside.md'), asPipeTable(REAL_HEADER, REAL_ROWS));
    const files = scanTree(tmp, GUARDED_DIRECTORIES).map(v => v.file).sort();
    assert.deepEqual(files, ['docs/evidence/2026-09-23/planted.md', 'docs/tdd/fp-ecr-weekly-wp.csv']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a trimmed export keyed only by the bare FantasyPros `id` column (id,pos,team,ecr) is caught', () => {
  const header = ['id', 'pos', 'team', 'ecr'];
  const rows = [['9001', 'WR', 'AAA', '1.4'], ['9002', 'WR', 'BBB', '2.9'], ['9003', 'WR', 'CCC', '3.3']];
  assert.equal(scanForPerPlayerFantasyPros(asCsv(header, rows), 'docs/evidence/x.md').length, 1);
});

test('not-applied control: our OWN per-player ranked table (player | rank | fpts, no FantasyPros column) is not caught', () => {
  const header = ['player', 'rank', 'fpts'];
  const rows = [['Alpha Player', '1', '18.2'], ['Bravo Player', '2', '16.0'], ['Charlie Player', '3', '14.9']];
  assert.deepEqual(scanForPerPlayerFantasyPros(asPipeTable(header, rows), 'docs/evidence/x.md'), []);
});
