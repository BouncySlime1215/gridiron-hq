/**
 * The News card's "active NN%" is the same chance-to-play Start/Sit shows, and it
 * multiplies straight into the projected points printed beside it.
 *
 * Two ways that number can be an assumption wearing a measurement's clothes:
 *
 *   1. The fit is not on file, so `weeklyAvailability` is pricing on the pooled
 *      injury-report rates or on constants. Every card is affected at once and the
 *      percentages look exactly the same as the validated ones.
 *   2. The player is not QB/RB/WR/TE. `weeklyAvailability` only prices those four
 *      positions, so anyone else fell through a bare `?? 0.92` — a hand-set constant
 *      rendered as "active 92%" with nothing to distinguish it from a measured rate.
 *
 * Neither had a caller or a test. These exercise the real `newsFantasyTracker`
 * against a controlled availability layer, so the fallback and the label it earns
 * are checked together: a number is only ever allowed out with the name of whatever
 * priced it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-basis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO game_lines (season, week, team, opponent, gameday) VALUES (2026, 2, 'KC', 'BUF', '2026-09-20')`);

/** One skill player the fit prices, and one kicker it does not cover at all. */
const RECEIVER = {
  player_id: 11, name: 'Fixture Receiver', team: 'KC', position: 'WR',
  volume: { targets_per_game: 8, carries_per_game: 0, attempts_per_game: 0, target_share: 0.25 },
  player_week_engine: { cutoff: '2026 week 1' }
};
const KICKER = {
  player_id: 12, name: 'Fixture Kicker', team: 'KC', position: 'K',
  volume: { targets_per_game: 0, carries_per_game: 0, attempts_per_game: 0, target_share: 0 },
  player_week_engine: { cutoff: '2026 week 1' }
};

mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    buildPlayerWeekEngine: () => new Map([[11, RECEIVER], [12, KICKER]]),
    // The distribution is not what these tests are about; it only has to be shaped
    // like one so the tracker reaches the availability fields.
    playerWeekDistribution: (_p, { activeProbability = 1 } = {}) =>
      ({ mean: 10 * activeProbability, p10: 4, p90: 18 })
  }
});

/** Whatever the fit is currently doing, stated by the same two values the real module returns. */
let availabilityState = { basis: 'role', missing: [], stamp: 'fixture', rate: 0.87,
  source: 'fitted availability by role (starter/noreport/full, n=812)' };

mock.module('../server/services/contingency.js', {
  namedExports: {
    availabilityBasis: () => ({ ...availabilityState, missing: [...availabilityState.missing] }),
    // Only the four positions the real function selects, so the kicker is absent
    // from the map exactly as he is in production. `source` is verbatim the string
    // playerActiveProbability builds, because that string is what is read.
    weeklyAvailability: () => new Map([[11, {
      player_id: 11, active_probability: availabilityState.rate, source: availabilityState.source
    }]])
  }
});

const { newsFantasyTracker } = await import('../server/services/news-fantasy-impact.js');

const signalFor = player => ({
  player_id: player.player_id, player_name: player.name, team: player.team,
  signal_type: 'role', status: 'role_up', confidence: 1, role_delta: 0,
  published_at: '2026-09-18T12:00:00Z'
});

test('a card priced by the fitted role layer says so, and is not marked assumed', () => {
  availabilityState = { basis: 'role', missing: [], stamp: 'fixture', rate: 0.87,
    source: 'fitted availability by role (starter/noreport/full, n=812)' };
  const out = newsFantasyTracker([signalFor(RECEIVER)]);
  const card = out.signals[0].fantasy_model;
  assert.equal(card.available, true);
  assert.equal(card.active_probability, 87);
  assert.equal(card.availability_basis, 'role');
  assert.equal(out.availability_basis.basis, 'role');
});

test('with no fit on file the same card carries the basis that priced it', () => {
  // The percentage moves and nothing else about the card does, which is the whole
  // reason the basis has to be served: 62% and 87% are the same kind of thing on screen.
  availabilityState = { basis: 'constants', missing: ['availability_fits', 'availability_role_rates'], stamp: null,
    rate: 0.62, source: 'weekly injury report + durability prior' };
  const out = newsFantasyTracker([signalFor(RECEIVER)]);
  assert.equal(out.signals[0].fantasy_model.active_probability, 62);
  assert.equal(out.signals[0].fantasy_model.availability_basis, 'constants');
  assert.equal(out.availability_basis.basis, 'constants');
  assert.deepEqual(out.availability_basis.missing, ['availability_fits', 'availability_role_rates']);
});

test('a position the fit does not cover is named, not quietly priced at the constant', () => {
  // The kicker has no row in the availability map on any basis, so his number is
  // UNFITTED_ACTIVE. Reporting the process basis here would be a lie of a second
  // kind: the role layer can be running perfectly and still not price him.
  availabilityState = { basis: 'role', missing: [], stamp: 'fixture', rate: 0.87,
    source: 'fitted availability by role (starter/noreport/full, n=812)' };
  const out = newsFantasyTracker([signalFor(KICKER)]);
  const card = out.signals[0].fantasy_model;
  assert.equal(card.available, true);
  assert.equal(card.active_probability, 92, 'the hand-set constant is still what he is priced at');
  assert.equal(card.availability_basis, 'unfitted_position',
    'and it is not reported as the role layer, which never saw him');
});

test('the page is told the basis even when no card could be modelled', () => {
  // Otherwise the note explaining a degraded basis disappears exactly when the
  // feed is emptiest, which is when a reader is most likely to trust what is left.
  availabilityState = { basis: 'pooled', missing: ['availability_role_rates'], stamp: 'fixture', rate: 0.55,
    source: 'fitted availability (QUE/limited, n=1204)' };
  const out = newsFantasyTracker([]);
  assert.equal(out.signals.length, 0);
  assert.equal(out.availability_basis.basis, 'pooled');
});

test('a player the role layer did not price is not labelled with the process basis', () => {
  // The correction that produced basisForRow. playerActiveProbability reaches the
  // fitted role cell only when the player has a gap_bucket AND the lookup hits;
  // everyone else drops to the pooled rates. So the process can be on 'role' while
  // THIS player was priced pooled, and reporting the process basis for him would be
  // the same overstatement the field exists to remove, one level up.
  availabilityState = { basis: 'role', missing: [], stamp: 'fixture', rate: 0.71,
    source: 'fitted availability (QUE/limited, n=1204) x KC' };
  const out = newsFantasyTracker([signalFor(RECEIVER)]);
  assert.equal(out.availability_basis.basis, 'role', 'the process is on the role layer');
  assert.equal(out.signals[0].fantasy_model.availability_basis, 'pooled',
    'but this player was not, and the card has to say so');
});

test('a player with no fit of any kind reads as constants, not as the process basis', () => {
  // Past the pooled rates is the hand-set chain: report status and durability prior.
  availabilityState = { basis: 'role', missing: [], stamp: 'fixture', rate: 0.80,
    source: 'durability prior only' };
  const out = newsFantasyTracker([signalFor(RECEIVER)]);
  assert.equal(out.signals[0].fantasy_model.availability_basis, 'constants');
});

test('both bases survive the route, which is the only way either reaches the page', () => {
  // Found by mutation, not by design: deleting `availability_basis` from the /news
  // response in routes/news.js turned nothing in this file red, because every test
  // above calls `newsFantasyTracker` directly and never goes near the route. A field
  // that can be quietly dropped from a response literal with nothing failing is not
  // wired, whatever the service does with it.
  //
  // The two bases travel by different paths and both are pinned here. The PAGE-level
  // one is a named key on the response and is what the degradation note reads, so its
  // absence silences exactly the sentence that exists to say the numbers are degraded.
  // The PER-CARD one rides inside `signals`, so it survives as long as the signals do
  // — but "as long as" is the assumption worth writing down rather than relying on.
  //
  // The field names are written out by hand. Deriving them from either side would
  // pass the exact defect this exists to catch.
  const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const route = read('server/routes/news.js');
  const page = read('client/src/pages/News.tsx');

  assert.match(route, /availability_basis: tracked\.availability_basis/,
    'the /news response stopped carrying the page-level basis');
  assert.match(route, /signals: /,
    'and the signals it carries are what the per-card basis rides inside');

  assert.match(page, /data\.availability_basis\.basis/,
    'the page stopped reading the page-level basis, so the degradation note is dead');
  assert.match(page, /s\.fantasy_model\.availability_basis/,
    'the card stopped reading its own basis, so every row reads as measured again');

  // Honest limit, since four assertions invite more confidence than they earn: this
  // pins the WIRE, not the rendering. A page that reads the field and then ignores
  // what it says still passes here — replacing one of the two branch arms with a
  // constant was tried and this test did not notice, because the other arm keeps the
  // string present. Catching that needs a rendered DOM, which this repository has no
  // harness for. What it does catch is the case that was previously undetectable:
  // the field never arriving at all.
});
