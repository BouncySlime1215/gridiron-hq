/**
 * `chartingSummary` publishes `mean_defenders_in_box` from
 * `AVG(CAST(defense_box AS REAL))` over every charted row.
 *
 * That is the same defect already fixed one function above it in the same file.
 * `formationDistribution` wraps its box mean in NULLIF because the feed writes 0
 * rather than blank on plays where the box was never counted, and averaging
 * those zeros in drags the league mean down by roughly a defender. The sibling
 * read on `nfl_play_charting` never got the same treatment, so the number the
 * charting surface prints is still the contaminated one.
 *
 * The trap on the other side is overcorrection, and it is the more expensive
 * mistake: `play_action`, `motion`, `screen`, `rpo`, `no_huddle`, `trick` and
 * `out_of_pocket` are genuine 0/1 flags. A zero there is a real measurement —
 * the play was not play action — so NULLIF applied across the SELECT would
 * silently convert every one of those rates from "share of plays" into "share
 * of plays that had it", which is 1.0 by construction. Measured elsewhere in
 * this project, that class of overcorrection produced a figure 3.5x wrong,
 * worse than the bug it was meant to fix.
 *
 * So the assertions below pin BOTH sides: the box mean must exclude the
 * uncharted zeros, and the flag rates must keep theirs.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-charting-box-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { chartingSummary } = await import('../server/services/nfl-formations.js');

/**
 * Four rows. Three have the box counted; the fourth is the feed's "not charted"
 * row, which arrives as 0 and not as NULL. play_action is deliberately true on
 * exactly one of the four, so its correct rate is 0.25 over all plays — a value
 * that only survives if the zeros are kept for that column.
 */
const PLAYS = [
  { play_id: 10, defense_box: 7, play_action: 1, motion: 1, screen: 0, rpo: 0,
    no_huddle: 0, trick: 0, out_of_pocket: 0 },
  { play_id: 11, defense_box: 6, play_action: 0, motion: 0, screen: 0, rpo: 0,
    no_huddle: 0, trick: 0, out_of_pocket: 1 },
  { play_id: 12, defense_box: 5, play_action: 0, motion: 1, screen: 1, rpo: 0,
    no_huddle: 0, trick: 0, out_of_pocket: 0 },
  // box never counted on this one: the feed writes 0, meaning absence.
  { play_id: 13, defense_box: 0, play_action: 0, motion: 0, screen: 0, rpo: 0,
    no_huddle: 1, trick: 0, out_of_pocket: 0 }
];

for (const p of PLAYS) {
  run(`INSERT INTO nfl_play_charting
       (game_id, play_id, season, week, defense_box, play_action, motion, screen,
        rpo, no_huddle, trick, out_of_pocket)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  '2024_01_TEN_CHI', p.play_id, 2024, 1, p.defense_box, p.play_action, p.motion,
  p.screen, p.rpo, p.no_huddle, p.trick, p.out_of_pocket);
}

test('the box mean excludes the uncharted zeros, as the sibling query already does', () => {
  // (7 + 6 + 5) / 3 = 6.00, not (7 + 6 + 5 + 0) / 4 = 4.50.
  const s = chartingSummary({ season: 2024 });
  assert.equal(s.mean_defenders_in_box, 6);
});

test('a zero flag is a real measurement and stays in its rate', () => {
  // One play action out of four plays. If NULLIF reached this column the
  // denominator would collapse to the plays that had it and the rate would
  // read 1.0 — an "every play is play action" claim, from a real dataset.
  const s = chartingSummary({ season: 2024 });
  assert.equal(s.rates.play_action, 0.25);
  assert.equal(s.rates.motion, 0.5);
  assert.equal(s.rates.screen, 0.25);
  assert.equal(s.rates.rpo, 0);
  assert.equal(s.rates.no_huddle, 0.25);
  assert.equal(s.rates.trick, 0);
  assert.equal(s.rates.qb_out_of_pocket, 0.25);
});

test('the play count still counts every charted play, zeros included', () => {
  // The box fix must not shrink the denominator that `plays` reports; an
  // uncharted box is still a play that was charted for everything else.
  assert.equal(chartingSummary({ season: 2024 }).plays, 4);
});

test('a season with no rows returns the honest error, not a zero mean', () => {
  const s = chartingSummary({ season: 2019 });
  assert.equal(s.error, 'no charting data stored');
  assert.equal(s.mean_defenders_in_box, undefined);
});

test('a non-numeric season is refused rather than reaching SQL as NaN', () => {
  // The season is interpolated into the SQL string rather than bound. Number()
  // keeps it uninjectable, but a non-numeric season becomes the bare token NaN,
  // which SQLite parses as a column name and rejects at prepare time — so a bad
  // query parameter surfaces as a 500 instead of a clean answer.
  const s = chartingSummary({ season: 'not-a-season' });
  assert.equal(s.error, 'no charting data stored');
});
