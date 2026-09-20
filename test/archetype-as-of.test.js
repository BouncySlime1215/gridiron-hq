/**
 * The manager card says when its archetype evidence was built.
 *
 * `archetypesFor` is served on the trades surface (`routes/trades.js:501`) as
 * the `archetype` block on every manager card: a career roll-up, this season's
 * metrics, and the stored Jev answers. Every one of those comes out of
 * `manager_archetypes` / `manager_archetype_jev`, and the only writer of either
 * is `buildManagerArchetypes()`, called from exactly one place —
 * `scripts/build-manager-archetypes.mjs:60`, which a person runs by hand.
 * Nothing on the server invokes it.
 *
 * So a card saying "reaches for a QB early, 16 picks" is a claim about evidence
 * whose age the payload never stated. These tests pin the block that states it.
 *
 * The rule the shape follows, taken from the same fix on the signals payload:
 * the stamp is the TABLE'S OWN, per league-season, never `sync_log.last_run_at`.
 * A job-level stamp says when the build ran, not which league-seasons it
 * actually produced rows for, and the two come apart the moment a league is
 * missing its draft picks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-archetype-asof-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { archetypesFor, archetypesBuilt, MANAGER_ARCHETYPE_VERSION } =
  await import('../server/services/manager-archetypes.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const ALDA = 'MEM-ALDA';
const BRYN = 'MEM-BRYN';

const team = (leagueId, season, rosterId, memberId, owner) =>
  run(`INSERT INTO league_season_teams (league_id, season, roster_id, espn_member_id, owner_name, team_name, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-19T00:00:00.000Z')`,
  leagueId, season, rosterId, memberId, owner, `Team ${rosterId}`);

const arch = (memberId, leagueId, season, metric, source, computedAt) =>
  run(`INSERT OR REPLACE INTO manager_archetypes
         (member_id, league_id, season, metric, value, label, n, source, version, computed_at)
       VALUES (?, ?, ?, ?, 0.25, NULL, 16, ?, ?, ?)`,
  memberId, leagueId, season, metric, source, MANAGER_ARCHETYPE_VERSION, computedAt);

// League 31, 2026: two managers, both with this-season rows and a career
// roll-up. The career rows sit under (league_id 0, season 0), which is a
// DIFFERENT key from this league-season — that is why they are stamped apart.
team(31, 2026, '1', ALDA, 'Alda Reyes');
team(31, 2026, '2', BRYN, 'Bryn Okafor');
arch(ALDA, 31, 2026, 'auto_draft_rate', 'draft', '2026-09-18T04:10:00.000Z');
arch(BRYN, 31, 2026, 'auto_draft_rate', 'draft', '2026-09-18T04:10:00.000Z');
// One row from an older build of the same league-season. MAX has to win: the
// question is when this evidence was last refreshed, not when it first appeared.
arch(ALDA, 31, 2026, 'reach_rate', 'draft', '2026-09-11T04:10:00.000Z');
// The career roll-up is a week older than this season's rows.
arch(ALDA, 0, 0, 'seasons_observed', 'career', '2026-09-11T04:10:00.000Z');
arch(BRYN, 0, 0, 'seasons_observed', 'career', '2026-09-11T04:10:00.000Z');

// League 32, 2026: a roster the build has never covered, so the card is served
// with no metrics at all. This is exactly where someone asks where the data went.
team(32, 2026, '1', ALDA, 'Alda Reyes');

// Two stored Jev answers for Alda, none for Bryn. These are written by a
// SEPARATE pass (`storeJevAnswers`, after a gateway call) with its own
// `evaluated_at`, so their date is not the archetype build's and must not be
// reported as if it were. Alda's newest answer is a day after the build.
const jev = (memberId, outcome, p, evaluatedAt) =>
  run(`INSERT INTO manager_archetype_jev
         (member_id, question, outcome, probability, basis, n_seasons, n_picks, model, state_chars, evaluated_at)
       VALUES (?, 'reaches_for_qb', ?, ?, 'draft', 4, 64, 'test-model', 900, ?)`,
  memberId, outcome, p, evaluatedAt);
jev(ALDA, 'true', 0.62, '2026-09-19T09:00:00.000Z');
jev(ALDA, 'false', 0.38, '2026-09-12T09:00:00.000Z');

// League 33, 2026: the fixture that separates the two readings of "as of".
// `career_influence` is a real source='draft' row and is the NEWEST row in the
// league-season, but it is not in manager-signals.js's ARCHETYPE_METRICS map,
// so archetypeIndex's own asOf skips it and reports the older date. The shared
// accessor reports the build, not one consumer's metric list.
team(33, 2026, '1', BRYN, 'Bryn Okafor');
arch(BRYN, 33, 2026, 'auto_draft_rate', 'draft', '2026-09-14T04:10:00.000Z');
arch(BRYN, 33, 2026, 'career_influence', 'draft', '2026-09-17T04:10:00.000Z');
// A career-source row for this same league-season key. It must not move the
// priced stamp: the trade path reads draft and outcome only.
arch(BRYN, 33, 2026, 'seasons_observed', 'career', '2026-09-18T04:10:00.000Z');

test('every served manager card says when its archetype evidence was built', () => {
  const cards = archetypesFor(31, 2026);
  assert.equal(cards.size, 2);
  for (const [rosterId, card] of cards) {
    assert.ok(card.built, `roster ${rosterId} served an archetype with no build stamp`);
    assert.equal(card.built.as_of, '2026-09-18T04:10:00.000Z',
      'as_of is the NEWEST build stamp for this league-season, not the oldest');
    // League-season scope, not per-member: the block dates the build that
    // produced this league-season, and league 32 below asserts 0 for the same
    // field, so a count borrowed from every league would fail there.
    assert.equal(card.built.rows, 3,
      'the row count is this league-season\'s own, so an empty one cannot hide behind a full one');
  }
});

test('the block names what writes the table, and says the server does not', () => {
  const [, card] = [...archetypesFor(31, 2026)][0];
  assert.match(card.built.built_by, /build-manager-archetypes\.mjs/,
    'a stale stamp is only actionable if the reader knows what to run');
  assert.match(card.built.built_by, /by hand|nothing on the deployed app/,
    'the payload must not imply a build the server never runs');
});

test('the career roll-up is stamped apart from this season, because it is a different key', () => {
  const [, card] = [...archetypesFor(31, 2026)][0];
  assert.ok(card.career, 'fixture sanity: the card carries a career roll-up');
  assert.equal(card.built.career_as_of, '2026-09-11T04:10:00.000Z',
    'the career rows live under league 0 / season 0 and can be older than this season\'s');
  assert.notEqual(card.built.career_as_of, card.built.as_of,
    'one stamp for both halves would date the career roll-up by this season\'s build');
});

test('a league-season the build never covered says so, and borrows no stamp', () => {
  const [, card] = [...archetypesFor(32, 2026)][0];
  assert.equal(card.built.as_of, null, 'never built is not a date');
  assert.equal(card.built.rows, 0);
  assert.match(card.built.reason ?? '', /never covered|no archetype row/,
    'the block is served for an uncovered league-season, which is where the question gets asked');
  assert.notEqual(card.built.as_of, card.built.career_as_of,
    'the career stamp must not stand in for a league-season that was never built');
});

test('the Jev answers carry their own evaluation date, not the archetype build stamp', () => {
  const cards = archetypesFor(31, 2026);
  const alda = cards.get('1');
  assert.equal(Object.keys(alda.jev).length, 1, 'fixture sanity: one question is stored');
  assert.equal(alda.built.jev_answers, 2);
  assert.equal(alda.built.jev_as_of, '2026-09-19T09:00:00.000Z',
    'storeJevAnswers writes evaluated_at in a separate pass, so it is a different date');
  assert.notEqual(alda.built.jev_as_of, alda.built.as_of,
    'dating the answers by the archetype build would be a stamp this pass never wrote');
});

test('a manager with no Jev answers reports none, not the other manager\'s date', () => {
  const bryn = archetypesFor(31, 2026).get('2');
  assert.equal(bryn.built.jev_answers, 0);
  assert.equal(bryn.built.jev_as_of, null,
    'a league-wide MAX would hand Bryn a date for answers that do not exist');
});

test('a full league-season is clean: no gap reported when both halves are there', () => {
  const built = archetypesBuilt(31, 2026);
  assert.equal(built.rows, 3);
  assert.equal(built.career_rows, 2);
  assert.equal(built.reason, null,
    'a built league-season must not report itself as missing');
});

// The direct entry point needs its own assertions, not the card's. The first
// mutation run injected MIN for MAX and survived, because every stamp check ran
// through archetypesFor and this function answered from a second copy of the
// same query. The copy is gone; these are the assertions that would have
// noticed either way.
test('the direct read answers with the same stamps the card does', () => {
  const built = archetypesBuilt(31, 2026, ALDA);
  assert.equal(built.as_of, '2026-09-18T04:10:00.000Z',
    'the newest build stamp for this league-season, not the oldest');
  assert.equal(built.career_as_of, '2026-09-11T04:10:00.000Z');
  assert.equal(built.jev_as_of, '2026-09-19T09:00:00.000Z');
  assert.deepEqual(
    { ...archetypesFor(31, 2026).get('1').built },
    { ...built },
    'one shape, or a caller reading the block directly sees a different answer');
});

test('called without a member, the block leaves the Jev fields off rather than guessing', () => {
  const built = archetypesBuilt(31, 2026);
  assert.equal('jev_as_of' in built, false,
    'a null jev_as_of would read as "no answers stored" when none was asked for');
  assert.equal('jev_answers' in built, false);
});

/**
 * THE SECOND ACCESSOR.
 *
 * manager-signals.js:271 `archetypeIndex` already derives an `asOf` from this
 * same store for the same league-season, served at `:425` as
 * `archetypes_as_of`. These tests pin the shared read that replaces it, and
 * pin the one place the shared read deliberately does NOT reproduce it.
 */

test('the priced stamp is the draft and outcome rows only, not every source', () => {
  const built = archetypesBuilt(33, 2026);
  assert.equal(built.priced_as_of, '2026-09-17T04:10:00.000Z',
    'the newest draft-or-outcome row, ignoring the newer career row');
  assert.equal(built.priced_rows, 2);
  assert.equal(built.as_of, '2026-09-18T04:10:00.000Z',
    'the unrestricted stamp still sees the career row, so the two are genuinely different reads');
});

test('on an ordinary league-season the two readings agree', () => {
  // League 31 has only draft-source rows, which is the normal case, so the
  // shared accessor and the consumer it replaces must not disagree there.
  const built = archetypesBuilt(31, 2026);
  assert.equal(built.priced_as_of, built.as_of,
    'a divergence on an ordinary fixture would mean the switch changes behaviour where it should not');
  assert.equal(built.priced_rows, built.rows);
});

test('the priced stamp does not depend on a consumer\'s metric allowlist', () => {
  // This is the defect being fixed, stated as a test. archetypeIndex updates
  // its asOf inside the row loop, AFTER a `continue` that drops any metric not
  // in ARCHETYPE_METRICS, so editing that map moves the date it reports.
  // career_influence is source='draft' and unmapped; the shared read counts it.
  const built = archetypesBuilt(33, 2026);
  assert.equal(built.priced_rows, 2,
    'both draft rows count, whether or not a downstream map names the metric');
  assert.notEqual(built.priced_as_of, '2026-09-14T04:10:00.000Z',
    'reporting the mapped-only date is archetypeIndex\'s bug, not the contract');
});

test('a league-season with no priced rows says so rather than borrowing the unrestricted stamp', () => {
  const built = archetypesBuilt(32, 2026);
  assert.equal(built.priced_as_of, null);
  assert.equal(built.priced_rows, 0);
  assert.match(built.reason ?? '', /never covered|no archetype row/);
});

test('the card carries the priced stamp too, so one payload answers both questions', () => {
  const card = archetypesFor(33, 2026).get('1');
  assert.equal(card.built.priced_as_of, '2026-09-17T04:10:00.000Z');
  assert.deepEqual({ ...card.built }, { ...archetypesBuilt(33, 2026, BRYN) },
    'the card and the direct read are one shape, priced fields included');
});
