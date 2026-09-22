/**
 * `whoPlays` reads snap share as `AVG(offense_pct)` over `nfl_snaps`, and the
 * comment above that query says snap share is what "decides whether an absence
 * actually matters". For every defensive player that average is 0.0000,
 * including a cornerback who played every defensive snap of every game.
 *
 * Measured on the real snap_counts_2024.csv (26,615 rows,
 * docs/evidence/feed-zero-contamination-measured.md):
 *
 *   offense_pct has ZERO blank cells and 16,063 literal zeros. 11,027 of those
 *   zeros are rows whose defense_pct is positive — a defender who was on the
 *   field. They are averaged in as though the player did not play.
 *
 * The consequence is not cosmetic. `expected_snaps_lost` is
 * `snap_share * (1 - play_probability)`, and both the `out` and `questionable`
 * lists sort by snap_share. A starting corner ruled out therefore contributes
 * exactly 0 to the cost of his own absence and sorts last among the players
 * flagged.
 *
 * This bug was already found and fixed once in this repository, in
 * nfl-availability.js:188-194, whose comment reads:
 *
 *   "This used to select `offense_pct` alone. `nfl_snaps` carries a fully
 *    populated `defense_pct` too ... so every defender -- about half of each
 *    roster -- matched nothing ... A starting cornerback and a fourth safety
 *    were the same number. They are not the same number."
 *
 * who-plays.js is the sibling that never got that fix.
 *
 * The correction has to keep three cases apart, which is why neither NULLIF nor
 * a plain MAX(COALESCE(...)) is enough on its own:
 *
 *   - a defender's offensive zero is ABSENCE of a measurement,
 *   - a deep reserve's zero is a REAL measurement (he dressed and did not play),
 *   - a player with no snap row at all is NEITHER, and must stay unmeasured
 *     rather than becoming a hard 0.0000.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-whoplays-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { whoPlays } = await import('../server/services/who-plays.js');

const SEASON = 2024, WEEK = 5, TEAM = 'CHI';

/** Every player here is ruled OUT, so each one reaches the report. */
for (const [name, pos] of [['Real Corner', 'CB'], ['Star Wideout', 'WR'],
  ['Deep Reserve', 'WR'], ['Unmeasured Rookie', 'CB']]) {
  run(`INSERT INTO nfl_injuries (season, week, team, full_name, position, report_status,
       practice_status, injury) VALUES (?,?,?,?,?,?,?,?)`,
  SEASON, WEEK, TEAM, name, pos, 'Out', 'Did Not Participate', 'Knee');
}

const snap = (week, player, position, off, def) =>
  run(`INSERT INTO nfl_snaps (season, week, player, team, position,
       offense_snaps, offense_pct, defense_snaps, defense_pct, st_pct)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
  SEASON, week, player, TEAM, position, null, off, null, def, 0);

for (let w = 1; w < WEEK; w++) {
  // Plays every defensive snap, no offensive snaps. offense_pct is a literal 0.
  snap(w, 'Real Corner', 'CB', 0, 1);
  // Offensive starter: the control. Must be unaffected by the fix.
  snap(w, 'Star Wideout', 'WR', 0.9, 0);
  // Dressed and genuinely did not play. Both zeros are real measurements.
  snap(w, 'Deep Reserve', 'WR', 0, 0);
  // 'Unmeasured Rookie' deliberately gets NO snap row at all.
}

const flagged = () => {
  const r = whoPlays(SEASON, WEEK, TEAM);
  return new Map([...r.out, ...r.questionable].map(p => [p.player, p]));
};

test('a corner who played every defensive snap is not a zero', () => {
  // The bug: AVG(offense_pct) over four weeks of literal zeros = 0.0000.
  assert.equal(flagged().get('Real Corner').snap_share, 1);
});

test("that corner's absence actually costs something", () => {
  // expected_snaps_lost = snap_share * (1 - play_probability). With snap_share
  // pinned at 0 a ruled-out starter costs exactly nothing, which is the number
  // a lineup decision reads.
  assert.ok(flagged().get('Real Corner').expected_snaps_lost > 0);
});

test('an offensive starter is unchanged — the control', () => {
  assert.equal(flagged().get('Star Wideout').snap_share, 0.9);
});

test('a real zero stays zero: dressed, did not play', () => {
  // Both columns are 0 and both are genuine measurements. Dropping these the
  // way NULLIF would is the overcorrection, and would silently promote a deep
  // reserve to unmeasured.
  assert.equal(flagged().get('Deep Reserve').snap_share, 0);
});

test('a player with no snap row stays unmeasured, not a hard zero', () => {
  // "Never measured" and "played 0%" are different facts. Collapsing them is
  // the same absent-as-zero error the fix exists to remove, one layer up.
  assert.equal(flagged().get('Unmeasured Rookie').snap_share, null);
});
