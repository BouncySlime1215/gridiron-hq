/**
 * "We have no number for this" and "this is not a number about this player's
 * position" are different sentences, and the block was saying the first when it
 * meant the second.
 *
 * The advanced-stats block reads `target_share` and `wopr` out of
 * `player_week_usage`. Those columns ARE carried by the ingest —
 * `server/services/nflverse.js:218` lists both in `USAGE_COLS` — and `numAt`
 * (`nflverse.js:58-64`) turns nflverse's `NA` or blank into SQL `null`. So a
 * quarterback's weekly rows land with `target_share` null for a reason that has
 * nothing to do with the file being incomplete: a passer is not targeted.
 *
 * The block could not tell those apart. Both came out as "The usage rows on
 * file for this season do not carry this column", which is a false claim about
 * the data, and a claim a reader can act on — someone reading it goes looking
 * for a better source for a statistic that does not describe quarterbacks at
 * all. Route participation was worse: it told a quarterback the sources that
 * publish it are paid, which says he would have route participation if we paid.
 *
 * This is the same collapse the rest of this branch exists to delete, built on
 * purpose by our own file. `unknown` had to be split out of `fresh` in the
 * freshness registry; `not measured` had to be split out of a rate of zero in
 * this very module. This is the third instance: `not applicable` has to be
 * split out of `no data`.
 *
 * What this file pins:
 *
 *   1. A stat that does not apply to a position says so, and its sentence is
 *      about the position, never about the player or the data.
 *   2. A stat that DOES apply to the position, and is missing, keeps its
 *      data-based reason. The new word must not eat the old one.
 *   3. An unknown position claims nothing. Applicability cannot be decided
 *      without knowing the position, and guessing it is the same mistake in a
 *      third costume.
 *   4. Red-zone share stays a platform absence for everyone. A quarterback
 *      takes red-zone carries, so the position does not rule it out; the
 *      missing play-by-play attribution does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-adv-pos-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { playerAdvancedStats, UNAVAILABLE, RECEIVING_POSITIONS, notApplicableTo } =
  await import('../server/services/player-advanced-stats.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;

const player = (id, name, position) => db.prepare(
  `INSERT INTO players (id, name, position) VALUES (?, ?, ?)`).run(id, name, position);

player(1, 'Busy Passer', 'QB');
player(2, 'Idle Passer', 'QB');
player(3, 'Slot Receiver', 'WR');
player(4, 'Kicker', 'K');
// `players.position` is TEXT NOT NULL (core-and-fantasy.js:89), so an unknown
// position arrives as a blank string, not as SQL null. That is the shape this
// has to be pinned against; a test using null would fail on the constraint and
// never reach the behaviour.
player(5, 'Position Unknown', '');
player(6, 'Receiving Back', 'RB');

const usage = (id, week, over = {}) => {
  const r = { targets: 0, carries: 0, attempts: 0, receiving_tds: 0, rushing_tds: 0,
    passing_tds: 0, target_share: null, wopr: null, ...over };
  db.prepare(`INSERT INTO player_week_usage
    (player_id, season, week, targets, carries, attempts, receiving_tds, rushing_tds,
     passing_tds, target_share, wopr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, SEASON, week, r.targets, r.carries, r.attempts, r.receiving_tds,
      r.rushing_tds, r.passing_tds, r.target_share, r.wopr);
};

// A quarterback with a full season of work. Every receiving column is null,
// which is what the real ingest writes for him.
usage(1, 1, { attempts: 35, passing_tds: 3 });
usage(1, 2, { attempts: 30, passing_tds: 2 });
// A second quarterback, on the roster and never used. Same position, no work.
usage(2, 1, {});
// A receiver whose rows exist and whose share columns are genuinely null — the
// season's file did not carry them. This is the absence that must survive.
usage(3, 1, { targets: 9, receiving_tds: 1 });
// A kicker with rows and nothing in them.
usage(4, 1, {});
// Position unknown, rows present, share columns null.
usage(5, 1, { targets: 4 });
// A receiving back, measured, so the applicable path stays exercised.
usage(6, 1, { targets: 6, carries: 11, rushing_tds: 1, target_share: 0.14, wopr: 0.33 });

const get = id => playerAdvancedStats(id, { season: SEASON, database: db });
const stat = (id, key) => get(id).stats.find(s => s.key === key);

const POSITIONAL = ['target_share', 'wopr', 'yards_per_route_run', 'route_participation'];

test('a quarterback is not told the data file is missing a column that is not about him', () => {
  for (const key of POSITIONAL) {
    const s = stat(1, key);
    assert.equal(s.value, null, `${key} was given a number for a quarterback`);
    assert.notEqual(s.unavailable_reason, UNAVAILABLE.notPopulated,
      `${key} blames the season's file for a statistic that does not describe a quarterback`);
    assert.notEqual(s.unavailable_reason, UNAVAILABLE.noUsage,
      `${key} blames missing rows for a quarterback who has two weeks of them`);
    assert.notEqual(s.unavailable_reason, UNAVAILABLE.routes,
      `${key} tells a quarterback the routes data is paid, which says he would have `
      + 'route participation if somebody bought it');
  }
});

test('the reason names the position, and is a fact about the position', () => {
  for (const key of POSITIONAL) {
    const reason = stat(1, key).unavailable_reason;
    assert.match(reason, /\bQB\b/,
      `${key} does not say which position it is not applicable to, so it reads as a `
      + 'general disclaimer rather than an answer about this player');
    assert.match(reason, /fact about the position/i,
      `${key} does not distinguish itself from a gap in the data`);
    // Pin the CLAIM, not the constant: every assertion that compares a reason
    // to itself passes when the sentence is rewritten into something false.
    // That is not hypothetical — it is exactly how the routes reason survived
    // a full mutation sweep in this module's first pass.
    assert.doesNotMatch(reason, /\bthis player\b|\bhis\b|\bhe\b|on file for|not carry/i,
      `${key} describes the player or the data file, and the whole point of the `
      + 'sentence is that it describes neither');
  }
});

test('the same position gets the same sentence, busy or idle', () => {
  // Two quarterbacks, one with two weeks of work and one with none. If the
  // sentence moves between them it is describing the workload, not the
  // position, and it is the wrong sentence.
  for (const key of POSITIONAL) {
    assert.equal(stat(1, key).unavailable_reason, stat(2, key).unavailable_reason,
      `${key} explains a busy quarterback differently from an idle one`);
  }
});

test('a kicker gets the same treatment, so the rule is about positions and not about QBs', () => {
  for (const key of POSITIONAL) {
    const reason = stat(4, key).unavailable_reason;
    assert.match(reason, /\bK\b/, `${key} does not name the kicker's position`);
    assert.notEqual(reason, stat(1, key).unavailable_reason,
      `${key} hands a kicker the quarterback's sentence, so the position in it is decoration`);
  }
});

test('a receiver whose column really is missing still gets the data reason', () => {
  // The control for the whole change. Target share DOES describe a receiver, so
  // when it is null the honest answer is still the one about the rows. A rule
  // that answered "not applicable" here would have replaced one wrong sentence
  // with another.
  for (const key of ['target_share', 'wopr']) {
    assert.equal(stat(3, key).unavailable_reason, UNAVAILABLE.notPopulated,
      `${key} for a receiver stopped blaming the file and started blaming the position`);
  }
  for (const key of ['yards_per_route_run', 'route_participation']) {
    assert.equal(stat(3, key).unavailable_reason, UNAVAILABLE.routes,
      `${key} for a receiver stopped being a platform absence, and it still is one`);
  }
});

test('a receiving back is measured, not gated away', () => {
  assert.ok(Math.abs(stat(6, 'target_share').value - 0.14) < 1e-9,
    'a running back was refused a target share, and backs are targeted');
  assert.ok(Math.abs(stat(6, 'wopr').value - 0.33) < 1e-9);
  assert.ok(RECEIVING_POSITIONS.has('RB') && RECEIVING_POSITIONS.has('FB')
    && RECEIVING_POSITIONS.has('WR') && RECEIVING_POSITIONS.has('TE'),
    'the receiving-eligible set dropped a position that is thrown to');
  assert.ok(!RECEIVING_POSITIONS.has('QB') && !RECEIVING_POSITIONS.has('K'),
    'the receiving-eligible set admitted a position that is not thrown to');
});

test('a blank position claims nothing about applicability', () => {
  // We cannot decide whether target share applies to a player whose position we
  // do not know. Answering "not applicable" there would be a guess, which is
  // the same mistake this change exists to remove, wearing a third costume.
  for (const key of ['target_share', 'wopr']) {
    const reason = stat(5, key).unavailable_reason;
    assert.equal(reason, UNAVAILABLE.notPopulated,
      `${key} invented an applicability ruling for a player with no position on file`);
    assert.doesNotMatch(reason, /not a statistic about/i,
      `${key} claims the statistic does not apply, without knowing what it would not apply to`);
  }
  for (const key of ['yards_per_route_run', 'route_participation']) {
    assert.equal(stat(5, key).unavailable_reason, UNAVAILABLE.routes,
      `${key} ruled on a position it does not know`);
  }
});

test('a player with no row at all claims nothing about applicability either', () => {
  // The other way to have no position: no player row. `playerAdvancedStats`
  // already answers with position null here, and null is not a position the
  // applicability rule may rule on.
  const report = playerAdvancedStats(404, { season: SEASON, database: db });
  assert.equal(report.position, null);
  for (const s of report.stats) {
    assert.doesNotMatch(String(s.unavailable_reason ?? ''), /not a statistic about/i,
      `${s.key} ruled a stat inapplicable to a player whose position is not on file`);
  }
});

test('red-zone share stays a platform absence, including for a quarterback', () => {
  // Scope pin. A quarterback takes red-zone carries, so the position does not
  // rule this one out; what rules it out is that play-by-play has no player
  // column. Gating it on position would be a true-sounding sentence for the
  // wrong reason, and it would go on being wrong after the attribution problem
  // was solved.
  for (const id of [1, 3, 4]) {
    assert.equal(stat(id, 'red_zone_share').unavailable_reason, UNAVAILABLE.redZone,
      `red-zone share for player ${id} was explained by position rather than by attribution`);
  }
});

test('touchdown rate is untouched: a quarterback still gets one, per attempt', () => {
  const td = stat(1, 'td_rate');
  assert.ok(Math.abs(td.value - 5 / 65) < 1e-9, '5 touchdown passes on 65 attempts');
  assert.match(td.basis, /attempt/i);
});

test('every stat still carries either a value or a reason, never both and never neither', () => {
  for (const id of [1, 2, 3, 4, 5, 6]) {
    for (const s of get(id).stats) {
      const hasValue = s.value != null;
      const hasReason = s.unavailable_reason != null;
      assert.ok(hasValue !== hasReason,
        `${s.key} for player ${id} has ${hasValue && hasReason ? 'both' : 'neither'}`);
    }
  }
});

test('the sentence builder names the position it was given, not a hardcoded one', () => {
  const made = notApplicableTo('TE', 'tight ends do not kick');
  assert.match(made, /\bTE\b/, 'the builder ignored the position it was handed');
  assert.match(made, /tight ends do not kick/,
    'the builder ignored the reason it was handed and wrote its own');
  assert.doesNotMatch(notApplicableTo('DST', 'x'), /\bQB\b/,
    'the builder has a quarterback baked into it');
});

/**
 * The panel has to keep the two absences apart on the page as well. A service
 * that distinguishes them and a panel that pools them under one heading is the
 * same collapse with an extra layer.
 */
const read = p => fs.readFileSync(p, 'utf8');

test('the panel separates a stat that does not apply from one it could not measure', () => {
  const panel = read('client/src/components/AdvancedStatsPanel.tsx');
  assert.match(panel, /not_applicable|notApplicable/,
    'the panel has no notion of a stat that does not apply, so it renders the '
    + 'positional absences in the same list as the missing measurements');
  // Both halves must be rendered. A panel that computes the split and then maps
  // only one of them has hidden the other, which is worse than not splitting.
  assert.match(panel, /inapplicable\.map\(/,
    'the not-applicable stats are computed and then dropped before rendering');
  assert.match(panel, /absent\.map\(/,
    'the unmeasurable stats stopped being rendered');
  assert.match(panel, /measured\.map\(/, 'the measured stats stopped being rendered');
});

test('the service marks which kind of absence each one is, rather than leaving it to a regex', () => {
  // The panel must not have to pattern-match the sentence to decide which list
  // a stat belongs in. Sorting by prose is how a reworded sentence silently
  // moves a row into the wrong group.
  for (const key of POSITIONAL) {
    assert.equal(stat(1, key).unavailable_kind, 'not_applicable',
      `${key} for a quarterback is not labelled as a positional absence`);
  }
  assert.equal(stat(3, 'target_share').unavailable_kind, 'not_measured',
    'a receiver\'s missing target share is labelled as though the stat did not apply');
  assert.equal(stat(3, 'red_zone_share').unavailable_kind, 'not_measured');
  assert.equal(stat(6, 'target_share').unavailable_kind, null,
    'a measured stat carries an absence label, and it is not absent');
});
