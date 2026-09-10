/**
 * The weekly teaser scan.
 *
 * These tests are deliberately built on a synthetic board rather than on the
 * live tables. The live board changes every hour, and a test that asserts
 * "there are nine qualifying legs this week" is a test that fails on Tuesday
 * for no reason. What must not change is the shape of the decision: which
 * source a book is read from, which quotes are too old to bet, which pairs are
 * legal, and which gate refuses when nothing is emitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-teaser-scan-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'scan.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { sourceForBook, bookSpreadBoard, legProbabilities, scanTeaserBoard, SPREAD_SOURCES } =
  await import('../server/betting/nfl/strategy/teaser-scan.js');
const { CROSS_BOTH_LINES, familyRate, teasedLegRate } =
  await import('../server/betting/nfl/strategy/teaser-leg-rates.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// The measured family, injected rather than recomputed. A fresh fixture
// database holds no game_lines, and the scan's responsibility is pairing,
// gating and pricing — not measurement, which teaser-leg-rates.test.js owns.
const DECIDED_RATE = 0.740586;
const PUSH_SHARES = { '-8.5': 0, '-8': 0.02, '-7.5': 0, '-7': 0.025424, '1.5': 0,
  '2': 0.023669, '2.5': 0, '3': 0.007117 };
const legProbability = line => legProbabilities(line,
  { decidedRate: DECIDED_RATE, pushShare: PUSH_SHARES[String(line)] ?? 0 });

const NOW = new Date('2026-09-11T18:00:00.000Z');
const KICK = '2026-09-13T17:00:00.000Z';

function snapshot(eventId, home, away, side, line, { minutesAgo = 20, book = 'draftkings' } = {}) {
  db.prepare(`INSERT OR REPLACE INTO nfl_line_snapshots
    (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price, provider)
    VALUES (?,?,?,?,?,?,'spreads',?,?,?, 'free:rotowire')`).run(
    new Date(NOW.getTime() - minutesAgo * 60000).toISOString(),
    eventId, KICK, home, away, book, side, line, -110);
}

/** A full two-sided game, so the mirror check passes. */
function game(eventId, home, away, homeLine, opts = {}) {
  snapshot(eventId, home, away, home, homeLine, opts);
  snapshot(eventId, home, away, away, -homeLine, opts);
}

function recordPrice(americanPrice, { book = 'draftkings', hoursAgo = 1, reachable = 1 } = {}) {
  db.prepare(`INSERT OR REPLACE INTO nfl_teaser_price_ledger
    (captured_at, book, teaser_points, legs, american_price, different_games_required, push_rule, reachable)
    VALUES (?,?,6,2,?,1,'push_removes_leg_reduces_to_single',?)`).run(
    new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(), book, americanPrice, reachable);
}

const clear = () => {
  db.exec('DELETE FROM nfl_line_snapshots');
  db.exec('DELETE FROM nfl_teaser_price_ledger');
};

test('a book is read from the source that actually holds its lines', () => {
  // This is the whole reason the scan exists as its own module. DraftKings is
  // not in the quote tape at all for this season; it is in nfl_line_snapshots,
  // second-hand and hourly. Reading it from the tape returns nothing, quietly.
  assert.equal(sourceForBook('draftkings').table, 'nfl_line_snapshots');
  assert.equal(sourceForBook('draftkings').provenance, 'second_hand_aggregator');
  assert.equal(sourceForBook('pinnacle').table, 'nfl_quote_tape');
  assert.equal(sourceForBook('pinnacle').provenance, 'first_hand_tape');
  assert.equal(sourceForBook('nowhere-books'), null);

  // The second-hand source gets a longer freshness budget because it is
  // captured hourly, not because it is trusted more.
  assert.ok(SPREAD_SOURCES.snapshots.maxAgeMinutes > SPREAD_SOURCES.tape.maxAgeMinutes);
});

test('per-leg probabilities pool the RATE and keep the push line-specific', () => {
  for (const line of CROSS_BOTH_LINES) {
    const p = legProbability(line);
    assert.equal(p.t, PUSH_SHARES[String(line)] ?? 0, `${line}: push share is this line's own`);
    assert.equal(p.decided_rate, DECIDED_RATE,
      `${line}: the decided rate is the pooled family rate, never the line's own`);
    // w is the family rate applied to the mass that is not a push.
    assert.ok(Math.abs(p.w - (1 - p.t) * DECIDED_RATE) < 1e-12);
    assert.ok(p.w + p.t <= 1 + 1e-9);
  }
  // Half points cannot push; the four integers can. That asymmetry is
  // structural, and it is the only thing that separates one leg from another.
  for (const half of [-8.5, -7.5, 1.5, 2.5]) assert.equal(legProbability(half).t, 0);
  for (const whole of [-8, -7, 2, 3]) assert.ok(legProbability(whole).t > 0, `${whole} can push`);

  // An unmeasurable history must refuse rather than price a ticket at zero.
  assert.throws(() => legProbabilities(1.5, { decidedRate: 0, pushShare: 0 }),
    /leg rates are unavailable/);
});

test('a torn capture is reported rather than half-priced', () => {
  clear();
  // Only one side ever landed. A one-sided game must not silently become a leg.
  snapshot('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns',
    'Jacksonville Jaguars', -8.5);
  const board = bookSpreadBoard({ book: 'draftkings', now: NOW });
  assert.deepEqual(board.torn_events, ['nfl:2026-09-13:CLE@JAX']);
});

test('the scan finds every legal pair, and every pair is two different games', () => {
  clear();
  recordPrice(100);
  game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
  game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);   // NYJ +1.5
  game('nfl:2026-09-13:GB@MIN', 'Minnesota Vikings', 'Green Bay Packers', -1.5); // GB +1.5
  const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });

  assert.deepEqual(scan.blocked_reasons, []);
  assert.equal(scan.qualifying_legs, 3, 'one qualifying side per game, never both');
  assert.equal(scan.candidate_count, 3, 'three legs -> three pairs');
  for (const c of scan.candidates) {
    assert.notEqual(c.legs[0].event_id, c.legs[1].event_id, 'a ticket is never one game twice');
    assert.ok(c.ev > 0);
    assert.equal(c.reduced_payout_verified, false, 'the reduced payout is still unverified');
    for (const leg of c.legs) assert.equal(leg.provenance, 'second_hand_aggregator');
  }
});

test('a game cannot supply both legs of a ticket — the family makes it impossible', () => {
  clear();
  recordPrice(100);
  // -7.5 qualifies for the favourite. Its counterpart is +7.5, which is not in
  // the set, so the away side cannot also qualify. Asserted rather than assumed.
  game('nfl:2026-09-13:NO@DET', 'Detroit Lions', 'New Orleans Saints', -7.5);
  const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
  assert.equal(scan.qualifying_legs, 1);
  assert.equal(scan.candidate_count, 0, 'one leg is not a ticket');
});

test('half-point pairs outrank integer pairs, because they cannot push', () => {
  clear();
  recordPrice(100);
  game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);  // half
  game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);          // half
  game('nfl:2026-09-13:NO@DET', 'Detroit Lions', 'New Orleans Saints', -7);           // integer
  const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
  const top = scan.candidates[0];
  assert.ok(top.legs.every(l => Math.abs(l.line % 1) === 0.5),
    'the best ticket is the one with no push exposure');
  assert.ok(scan.candidates.at(-1).legs.some(l => Number.isInteger(l.line)));
});

test('each gate refuses for its own stated reason', async t => {
  await t.test('no recorded price', () => {
    clear();
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
    const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
    assert.equal(scan.candidate_count, 0);
    assert.match(scan.blocked_reasons.join(' '), /No reachable two-team six-point teaser price/);
  });

  await t.test('an unreachable price is not a price', () => {
    clear();
    recordPrice(100, { reachable: 0 });
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
    const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
    assert.equal(scan.candidate_count, 0);
    assert.match(scan.blocked_reasons.join(' '), /No reachable/);
  });

  await t.test('a price older than a week has to be re-recorded', () => {
    clear();
    recordPrice(100, { hoursAgo: 200 });
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
    const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
    assert.equal(scan.candidate_count, 0);
    assert.match(scan.blocked_reasons.join(' '), /200h old.*Re-record it/);
  });

  await t.test('the -115 floor is a hard stop, not a preference', () => {
    clear();
    recordPrice(-130);
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
    const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
    assert.equal(scan.candidate_count, 0);
    assert.match(scan.blocked_reasons.join(' '), /worse than the -115 operating floor/);
  });

  await t.test('a stale quote is not a price you can bet', () => {
    clear();
    recordPrice(100);
    // Past the 120-minute budget for the hourly aggregator source.
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5, { minutesAgo: 400 });
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5, { minutesAgo: 400 });
    const scan = scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
    assert.equal(scan.stale_legs, 2);
    assert.equal(scan.usable_legs, 0);
    assert.equal(scan.candidate_count, 0);
    assert.match(scan.blocked_reasons.join(' '), /older than 120 minutes/);
  });

  await t.test('a kicked-off game keeps its quote forever and must still be dropped', () => {
    clear();
    recordPrice(100);
    game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
    game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
    // Scan from after kickoff: the rows are still there, fresh-looking and useless.
    const scan = scanTeaserBoard({ book: 'draftkings', now: new Date('2026-09-13T20:00:00.000Z'), legProbability });
    assert.equal(scan.qualifying_legs, 0, 'a played game is off the board');
    assert.equal(scan.candidate_count, 0);
  });
});

test('a better price is worth more, and the floor sits where the maths says', () => {
  clear();
  game('nfl:2026-09-13:CLE@JAX', 'Jacksonville Jaguars', 'Cleveland Browns', -8.5);
  game('nfl:2026-09-13:NYJ@TEN', 'Tennessee Titans', 'New York Jets', -1.5);
  const at = price => {
    db.exec('DELETE FROM nfl_teaser_price_ledger');
    recordPrice(price);
    return scanTeaserBoard({ book: 'draftkings', now: NOW, legProbability });
  };
  const plus = at(100).candidates[0].ev_percent;
  const minus = at(-110).candidates[0].ev_percent;
  assert.ok(plus > minus, 'a shorter price pays less');
  assert.ok(plus > 8 && plus < 12, `+100 on two half-point legs is around +9-10%, got ${plus}`);
  // -120 sits essentially at break-even for this family, so it must not be far
  // from zero — and -115, the operating floor, must still be positive.
  assert.ok(at(-115).candidates[0].ev_percent > 0, 'the operating floor is still +EV');
});
