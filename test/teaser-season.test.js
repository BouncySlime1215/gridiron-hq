/**
 * The Wong teaser as a season: settings, ticket selection, and projection.
 *
 * Two things these tests deliberately do NOT do.
 *
 * They do not measure. A fixture database has no `game_lines`, so the family
 * rate and the per-line push shares are injected from the values
 * `test/teaser-scan.test.js` already pins. `test/teaser-leg-rates.test.js` owns
 * the measurement; this file owns what is done with it.
 *
 * They do not assert the overlap finding in prose. The claim that four
 * non-overlapping tickets take a materially smaller chance of a losing week
 * than the same risk spread over overlapping ones is SIMULATED below, from the
 * ticket set `bestTicketSet` actually returns. If the claim ever stops being
 * true, this file fails rather than continuing to quote it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-teaser-season-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'season.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, migrate } = await import('../server/db/index.js');
// Just the one migration this fixture needs: the teaser execution ledger.
// `runMigrations()` would import every file in server/migrations/, which
// couples this suite to migrations that have nothing to do with teasers —
// and at the time of writing 035 is mid-flight and does not parse. Everything
// else used here (app_settings, nfl_teaser_price_ledger, nfl_line_snapshots)
// comes from the legacy schema, which db/index.js applies on import.
const ledgerMigration = await import('../server/migrations/012_teaser_execution_ledger.js');
migrate(ledgerMigration.name, () => ledgerMigration.up(db));

const {
  DEFAULT_WONG_SETTINGS, WONG_SETTINGS_KEY, SEASON_WEEKS, FORWARD_RATE_SD,
  wongSettings, saveWongSettings, resetWongSettings,
  kickoffSlot, ticketLegality, bestTicketSet,
  nflSeasonOf, seasonWeek1Kickoff, seasonPaceClock, forwardRatePrior,
  projectRemainingSeason, wongSeason, recordWongTicket,
} = await import('../server/betting/nfl/strategy/teaser-season.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* The measured family, injected. Same numbers as test/teaser-scan.test.js. */
const DECIDED_RATE = 0.7405857740585774;
const LEG_MIX = [
  { line: -8.5, weight: 93 / 2894, push_share: 0 },
  { line: -8, weight: 100 / 2894, push_share: 0.02 },
  { line: -7.5, weight: 275 / 2894, push_share: 0 },
  { line: -7, weight: 472 / 2894, push_share: 12 / 472 },
  { line: 1.5, weight: 169 / 2894, push_share: 0 },
  { line: 2, weight: 169 / 2894, push_share: 4 / 169 },
  { line: 2.5, weight: 492 / 2894, push_share: 0 },
  { line: 3, weight: 1124 / 2894, push_share: 8 / 1124 },
];

const KICK_SUN_EARLY = '2026-09-13T17:00:00.000Z';   // 13:00 ET
const KICK_SUN_LATE = '2026-09-13T20:25:00.000Z';    // 16:25 ET
const KICK_SUN_NIGHT = '2026-09-14T00:20:00.000Z';   // 20:20 ET Sunday

const r4 = v => +v.toFixed(4);
const leg = (event_id, team, line, commence_time = KICK_SUN_EARLY) =>
  ({ event_id, team, line, teased_to: line + 6, commence_time });
const ticket = (a, b, ev) => ({ legs: [a, b], ev, ev_percent: ev * 100, american_price: 100 });

/* ======================================================================== */
/* 1. SETTINGS                                                              */
/* ======================================================================== */

test('settings default, round-trip through app_settings, and reset', () => {
  const fresh = wongSettings();
  assert.equal(fresh.stored, false);
  assert.equal(fresh.unit_size_dollars, DEFAULT_WONG_SETTINGS.unit_size_dollars);
  assert.deepEqual(fresh.books, ['draftkings']);

  const saved = saveWongSettings({ unit_size_dollars: 250, max_tickets_per_week: 3 });
  assert.equal(saved.stored, true);
  assert.equal(saved.unit_size_dollars, 250);
  assert.equal(saved.max_tickets_per_week, 3);
  // Untouched fields survive the patch.
  assert.equal(saved.reduced_payout, DEFAULT_WONG_SETTINGS.reduced_payout);

  const reread = wongSettings();
  assert.equal(reread.stored, true);
  assert.equal(reread.unit_size_dollars, 250);
  assert.equal(reread.max_tickets_per_week, 3);

  // A second patch merges rather than replacing.
  saveWongSettings({ books: ['draftkings', 'fanduel'] });
  assert.deepEqual(wongSettings().books, ['draftkings', 'fanduel']);
  assert.equal(wongSettings().unit_size_dollars, 250);

  // It really is one row in the existing key/value table, not a new table.
  const stored = db.prepare('SELECT value FROM app_settings WHERE key=?').get(WONG_SETTINGS_KEY);
  assert.ok(stored, 'settings persist into app_settings');
  assert.equal(JSON.parse(stored.value).unit_size_dollars, 250);

  assert.equal(resetWongSettings().stored, false);
  assert.equal(wongSettings().unit_size_dollars, DEFAULT_WONG_SETTINGS.unit_size_dollars);
});

test('settings refuse values the ledger or the pricing model could not honour', () => {
  assert.throws(() => saveWongSettings({ unit_size_dollars: 0 }), /unit_size_dollars/);
  // The ledger's own cap is 5 units; a setting above it would fail every Sunday.
  assert.throws(() => saveWongSettings({ stake_units: 6 }), /stake_units/);
  assert.throws(() => saveWongSettings({ books: [] }), /books/);
  assert.throws(() => saveWongSettings({ max_tickets_per_week: 2.5 }), /max_tickets_per_week/);
  assert.throws(() => saveWongSettings({ reduced_payout: 'refund_plus_tip' }), /reduced_payout/);
  assert.throws(() => saveWongSettings({ price_floor: -50 }), /price_floor/);
  // Nothing was written by any of those.
  assert.equal(wongSettings().stored, false);
});

test('a corrupted stored blob degrades to defaults instead of throwing at the caller', () => {
  db.prepare(`INSERT INTO app_settings (key,value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(WONG_SETTINGS_KEY, '{not json');
  const out = wongSettings();
  assert.equal(out.stored, false);
  assert.match(out.invalid_stored_value, /not valid JSON/);
  assert.equal(out.unit_size_dollars, DEFAULT_WONG_SETTINGS.unit_size_dollars);

  db.prepare('UPDATE app_settings SET value=? WHERE key=?')
    .run(JSON.stringify({ stake_units: 99 }), WONG_SETTINGS_KEY);
  const invalid = wongSettings();
  assert.equal(invalid.stored, false);
  assert.match(invalid.invalid_stored_value, /stake_units/);
  resetWongSettings();
});

/* ======================================================================== */
/* 2. TICKET SELECTION                                                      */
/* ======================================================================== */

test('kickoff slots separate the blocks an operator would call different', () => {
  assert.notEqual(kickoffSlot(KICK_SUN_EARLY), kickoffSlot(KICK_SUN_LATE));
  assert.notEqual(kickoffSlot(KICK_SUN_LATE), kickoffSlot(KICK_SUN_NIGHT));
  // 16:05 and 16:25 ET are the same block of television.
  assert.equal(kickoffSlot('2026-09-13T20:05:00.000Z'), kickoffSlot('2026-09-13T20:25:00.000Z'));
  assert.equal(kickoffSlot(null), null);
  assert.equal(kickoffSlot('not a date'), null);
});

test('illegal tickets are refused, including the same-game pair the family makes impossible', () => {
  assert.equal(ticketLegality(ticket(leg('nfl:1', 'A', 2.5), leg('nfl:2', 'B', -7.5), 0.05)).legal, true);
  assert.match(ticketLegality(ticket(leg('nfl:1', 'A', 2.5), leg('nfl:1', 'B', -7.5), 0.05)).reason,
    /same game/);
  assert.match(ticketLegality(ticket(leg('nfl:1', 'A', 2.5), leg('nfl:2', 'B', -6.5), 0.05)).reason,
    /not in the cross-both family/);
  assert.match(ticketLegality({ legs: [leg('nfl:1', 'A', 2.5)] }).reason, /exactly two legs/);
  assert.match(ticketLegality(ticket(leg('nfl:1', 'A', 2.5), leg('nfl:2', 'B', -7.5), null)).reason,
    /no numeric ev/);
});

test('bestTicketSet is exactly optimal on a case where greedy is not', () => {
  // Four legs, three legal pairs, hand-checkable:
  //   A-B 0.10   C-D 0.10   B-C 0.19
  // Greedy takes B-C first (the single best edge) and is then stuck: A and D
  // have no edge between them, so greedy scores 0.19. The optimum is A-B plus
  // C-D for 0.20. There is no ordering of a greedy rule that finds this.
  const A = leg('nfl:A', 'AAA', 2.5);
  const B = leg('nfl:B', 'BBB', 2.5);
  const C = leg('nfl:C', 'CCC', 2.5);
  const D = leg('nfl:D', 'DDD', 2.5);
  const out = bestTicketSet({
    candidates: [ticket(A, B, 0.10), ticket(C, D, 0.10), ticket(B, C, 0.19)],
    maxTickets: 2,
  });

  assert.equal(out.method, 'exact_maximum_weight_matching');
  assert.equal(out.optimal, true);
  assert.equal(out.ticket_count, 2);
  assert.ok(Math.abs(out.total_ev - 0.20) < 1e-12,
    `expected the 0.20 matching, got ${out.total_ev}`);
  const pairs = out.tickets.map(t => t.legs.map(l => l.team).sort().join('-')).sort();
  assert.deepEqual(pairs, ['AAA-BBB', 'CCC-DDD']);
  assert.equal(out.legs_unused.length, 0);

  // With only one ticket in budget the single best edge IS the answer.
  const capped = bestTicketSet({
    candidates: [ticket(A, B, 0.10), ticket(C, D, 0.10), ticket(B, C, 0.19)],
    maxTickets: 1,
  });
  assert.equal(capped.ticket_count, 1);
  assert.ok(Math.abs(capped.total_ev - 0.19) < 1e-12);
  assert.equal(capped.legs_unused.length, 2);
  assert.ok(capped.legs_unused.every(l => l.reason === 'ticket_cap_reached'));
});

test('the chosen set shares no leg, and unused legs say why they were left out', () => {
  const legs = Array.from({ length: 9 }, (_, i) =>
    leg(`nfl:G${i}`, `T${i}`, 2.5, i % 2 ? KICK_SUN_LATE : KICK_SUN_EARLY));
  const orphan = leg('nfl:ORPHAN', 'ORP', 3, KICK_SUN_NIGHT);
  const candidates = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) candidates.push(ticket(legs[i], legs[j], 0.0416));
  }
  // An orphan pairs with nothing: it is on the board but has no legal partner
  // (a real board produces these whenever a qualifying leg's only counterparts
  // are already spoken for or in its own game).
  const out = bestTicketSet({ candidates, maxTickets: 4 });

  assert.equal(out.optimal, true);
  assert.equal(out.ticket_count, 4);
  const used = out.tickets.flatMap(t => t.legs.map(l => `${l.event_id}|${l.team}`));
  assert.equal(new Set(used).size, 8, 'four tickets must consume eight distinct legs');
  assert.equal(out.legs_unused.length, 1);
  assert.equal(out.legs_unused[0].reason, 'ticket_cap_reached');

  const withOrphan = bestTicketSet({
    candidates: [...candidates, { legs: [orphan, orphan], ev: 0.04 }], maxTickets: 9,
  });
  assert.equal(withOrphan.rejected.length, 1);
  assert.match(withOrphan.rejected[0].reason, /same game/);
});

test('ties break toward legs in different kickoff slots', () => {
  // A, B, C all qualify at identical EV. A-B are in the same slot; A-C are not.
  // Both matchings score the same EV, so the slot spread decides.
  const A = leg('nfl:A', 'AAA', 2.5, KICK_SUN_EARLY);
  const B = leg('nfl:B', 'BBB', 2.5, KICK_SUN_EARLY);
  const C = leg('nfl:C', 'CCC', 2.5, KICK_SUN_NIGHT);
  const out = bestTicketSet({
    candidates: [ticket(A, B, 0.05), ticket(A, C, 0.05)], maxTickets: 1,
  });
  assert.equal(out.ticket_count, 1);
  assert.deepEqual(out.tickets[0].legs.map(l => l.team).sort(), ['AAA', 'CCC']);
  assert.equal(out.tickets[0].legs_in_different_slots, true);
});

/* ---------------------------------------------------------------------- */
/* The overlap finding, simulated rather than quoted.                      */
/* ---------------------------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One week, at +100 on half-point legs (which cannot push), given a set of
 * tickets and the stake on each. Returns the share of weeks that finish down.
 */
function losingWeekProbability(tickets, stakePerTicket, { runs = 200_000, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const legIds = [...new Set(tickets.flatMap(t => t.legs.map(l => `${l.event_id}|${l.team}`)))];
  let losing = 0;
  const won = new Map();
  for (let run = 0; run < runs; run++) {
    for (const id of legIds) won.set(id, rng() < DECIDED_RATE);
    let profit = 0;
    for (const t of tickets) {
      const both = t.legs.every(l => won.get(`${l.event_id}|${l.team}`));
      profit += both ? stakePerTicket : -stakePerTicket;
    }
    if (profit < 0) losing++;
  }
  return losing / runs;
}

test('the disjoint set beats an overlapping one on losing-week probability at equal risk', () => {
  const legs = Array.from({ length: 9 }, (_, i) => leg(`nfl:W${i}`, `W${i}`, 2.5));
  const all = [];
  for (let i = 0; i < 9; i++) {
    for (let j = i + 1; j < 9; j++) all.push(ticket(legs[i], legs[j], 0.0416));
  }
  assert.equal(all.length, 36);

  const chosen = bestTicketSet({ candidates: all, maxTickets: 4 });
  assert.equal(chosen.ticket_count, 4);
  assert.equal(new Set(chosen.tickets.flatMap(t => t.legs.map(l => l.team))).size, 8);

  // Total risk held at 4 units in all three books.
  const disjoint = losingWeekProbability(chosen.tickets, 1);
  // What "just take the top four off the board" produces on a uniform board:
  // four tickets that all contain the same leg.
  const topFourOverlapping = [0, 1, 2, 3].map(k => ticket(legs[0], legs[k + 1], 0.0416));
  const overlapping = losingWeekProbability(topFourOverlapping, 1);
  // And the fully-spread version: every legal pair, same 4 units in total.
  const everyPair = losingWeekProbability(all, 4 / 36);

  assert.ok(disjoint < overlapping - 0.02,
    `disjoint ${disjoint.toFixed(4)} should beat top-four-overlapping ${overlapping.toFixed(4)}`);
  assert.ok(disjoint < everyPair - 0.10,
    `disjoint ${disjoint.toFixed(4)} should beat all-36 ${everyPair.toFixed(4)} by a wide margin`);
  // The numbers the module's header claims, within simulation noise.
  assert.ok(Math.abs(disjoint - 0.244) < 0.01, `disjoint losing-week ${disjoint.toFixed(4)}, expected ~0.244`);
  assert.ok(Math.abs(everyPair - 0.426) < 0.01, `all-36 losing-week ${everyPair.toFixed(4)}, expected ~0.426`);
});

/* ======================================================================== */
/* 3. SEASON CLOCK, LEDGER AGGREGATION AND PROJECTION                       */
/* ======================================================================== */

test('the season clock finds week 1 and counts the weeks left', () => {
  assert.equal(nflSeasonOf('2026-09-13T17:00:00Z'), 2026);
  assert.equal(nflSeasonOf('2027-01-10T17:00:00Z'), 2026, 'January is the previous season');
  assert.equal(nflSeasonOf('2027-04-01T17:00:00Z'), 2027);

  // The Thursday after the first Monday in September.
  assert.equal(seasonWeek1Kickoff(2026).toISOString().slice(0, 10), '2026-09-10');
  assert.equal(seasonWeek1Kickoff(2025).toISOString().slice(0, 10), '2025-09-04');

  const opening = seasonPaceClock({ season: 2026, now: new Date('2026-09-10T12:00:00Z') });
  assert.equal(opening.current_week, 1);
  assert.equal(opening.weeks_elapsed, 0);
  assert.equal(opening.weeks_remaining, SEASON_WEEKS);

  const week6 = seasonPaceClock({ season: 2026, now: new Date('2026-10-16T12:00:00Z') });
  assert.equal(week6.current_week, 6);
  assert.equal(week6.weeks_elapsed, 5);
  assert.equal(week6.weeks_remaining, 13);
});

/** Seed the existing ledger tables directly — this test owns aggregation, not the insert path. */
function seedTicket({ id, mode, status, profit, price = 100, stake = 1, kickoff }) {
  db.prepare(`INSERT INTO nfl_teaser_executions
    (id,candidate_id,logged_at,mode,book,american_price,teaser_points,stake_units,
     expected_leg_rate,expected_ticket_probability,expected_ev,price_captured_at,
     line_captured_at,status,settled_at,profit_units)
    VALUES (?,?,?,?,'draftkings',?,6,?,?,?,?,?,?,?,?,?)`).run(
    id, `seed-${id}`, kickoff, mode, price, stake, DECIDED_RATE, 0.5426, 0.0853,
    kickoff, kickoff, status, status === 'open' ? null : kickoff, profit);
  const insertLeg = db.prepare(`INSERT INTO nfl_teaser_execution_legs
    (execution_id,slot,event_id,team,opponent,matchup,commence_time,market_line,teased_line,result)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const slot of [1, 2]) {
    insertLeg.run(id, slot, `nfl:S${id}-${slot}`, `T${id}${slot}`, `O${id}${slot}`,
      `T${id}${slot} at O${id}${slot}`, kickoff, 2.5, 8.5,
      status === 'open' ? null : (status === 'won' ? 'won' : slot === 1 ? 'lost' : 'won'));
  }
}

test('season aggregation reads the existing ledger and keeps paper away from money', () => {
  const sunday = '2026-09-13T17:00:00.000Z';
  seedTicket({ id: 101, mode: 'placed', status: 'won', profit: 1, kickoff: sunday });
  seedTicket({ id: 102, mode: 'placed', status: 'won', profit: 1, kickoff: sunday });
  seedTicket({ id: 103, mode: 'placed', status: 'lost', profit: -1, kickoff: sunday });
  seedTicket({ id: 104, mode: 'placed', status: 'open', profit: null, kickoff: '2026-09-20T17:00:00.000Z' });
  seedTicket({ id: 105, mode: 'paper', status: 'lost', profit: -1, kickoff: sunday });
  // A different season must not leak in.
  seedTicket({ id: 106, mode: 'placed', status: 'won', profit: 1, kickoff: '2025-09-14T17:00:00.000Z' });

  const season = wongSeason({
    season: 2026, now: new Date('2026-09-24T12:00:00Z'),
    legRate: DECIDED_RATE, legMix: LEG_MIX, runs: 5000,
  });

  assert.equal(season.season, 2026);
  assert.equal(season.placed.tickets, 4);
  assert.equal(season.placed.record, '2-1-0');
  assert.equal(season.placed.open, 1);
  assert.equal(season.placed.open_exposure_units, 1);
  assert.equal(season.placed.units_staked, 3);
  assert.equal(season.placed.net_units, 1);
  assert.equal(season.placed.net_dollars, 100);
  assert.equal(season.placed.roi, r4(1 / 3));
  assert.equal(season.paper.tickets, 1);
  assert.equal(season.paper.net_units, -1);
  assert.equal(season.open_tickets.length, 1);
  assert.equal(season.open_tickets[0].id, 104);

  // Pace: two full weeks are behind us at 2026-09-24.
  assert.equal(season.pace.weeks_elapsed, 2);
  assert.equal(season.pace.weeks_remaining, 16);
  assert.equal(season.pace.tickets_per_week, 2);
  assert.equal(season.pace.tickets_remaining, 32);
  assert.equal(season.pace.projected_full_season_tickets, 36);
  assert.match(season.pace.pace_basis, /measured/);

  // The price the projection uses comes from what was actually taken.
  assert.equal(season.price.american_price, 100);
  assert.match(season.price.source, /placed tickets/);

  const empty = wongSeason({
    season: 2027, now: new Date('2027-09-16T12:00:00Z'),
    legRate: DECIDED_RATE, legMix: LEG_MIX, runs: 5000,
  });
  assert.equal(empty.placed.tickets, 0);
  assert.equal(empty.placed.roi, null);
  // A week has elapsed with nothing bet, so the measured pace is a real zero,
  // not an absence — and a zero pace cannot be projected from, so the planned
  // rate falls back to the configured cap.
  assert.equal(empty.pace.tickets_per_week, 0);
  assert.match(empty.pace.pace_basis, /max_tickets_per_week/);
  assert.equal(empty.pace.tickets_remaining, empty.settings.max_tickets_per_week * empty.pace.weeks_remaining);
  // Before week 1 there is nothing to measure at all, and the field says so.
  const preseason = wongSeason({ season: 2027, now: new Date('2027-08-01T12:00:00Z'),
    legRate: DECIDED_RATE, legMix: LEG_MIX, runs: 5000 });
  assert.equal(preseason.pace.tickets_per_week, null);
  assert.equal(preseason.pace.weeks_remaining, SEASON_WEEKS);
  assert.match(empty.price.source, /default/);
});

test('the Monte Carlo mean lands on the analytic EV', () => {
  const projection = projectRemainingSeason({
    tickets: 72, americanPrice: 100, stakeUnits: 1, unitSize: 100,
    legRate: DECIDED_RATE, legMix: LEG_MIX, runs: 50_000, seed: 4242,
  });
  assert.equal(projection.optimistic_ignores_rate_uncertainty.runs, 50_000);
  const analytic = projection.analytic.expected_units;
  const simulated = projection.optimistic_ignores_rate_uncertainty.mean.units;
  // 72 tickets at +100 has a per-season sd near 8.5 units, so 50k runs put the
  // standard error of this mean around 0.04. A 0.3-unit window is ~7 sigma.
  assert.ok(Math.abs(simulated - analytic) < 0.3,
    `simulated ${simulated} vs analytic ${analytic}`);
  // And the analytic figure itself is the one ticketEV would give.
  assert.ok(Math.abs(projection.analytic.ev_per_ticket - 0.0906) < 0.002,
    `per-ticket EV ${projection.analytic.ev_per_ticket}, expected about 0.0906 at +100`);
  assert.equal(projection.analytic.expected_dollars,
    +(projection.analytic.ev_per_ticket * 72 * 100).toFixed(2));
});

test('the rate-uncertainty projection is strictly wider than the point estimate', () => {
  const projection = projectRemainingSeason({
    tickets: 72, americanPrice: 100, stakeUnits: 1, unitSize: 100,
    legRate: DECIDED_RATE, legMix: LEG_MIX, runs: 50_000, seed: 4242,
  });
  const point = projection.optimistic_ignores_rate_uncertainty;
  const wide = projection.with_rate_uncertainty;

  const pointSpread = point.p95.units - point.p05.units;
  const wideSpread = wide.p95.units - wide.p05.units;
  assert.ok(wideSpread > pointSpread,
    `rate uncertainty must widen the interval: ${wideSpread} vs ${pointSpread}`);
  // Not a rounding difference: over 72 tickets the rate term adds about 4.9
  // units of standard deviation to the ~8.4 that sampling alone contributes.
  assert.ok(wideSpread > pointSpread * 1.05,
    `and by a real margin, not float noise: ${wideSpread} vs ${pointSpread}`);
  assert.ok(wide.p05.units < point.p05.units, 'the downside must get worse');
  assert.ok(wide.p95.units > point.p95.units, 'and the upside wider too');
  assert.ok(wide.probability_of_losing_season > point.probability_of_losing_season,
    'a wider rate must raise the chance of a losing season');

  // The prior it drew from is the one the module documents.
  assert.equal(projection.rate_prior.distribution, 'beta');
  assert.equal(projection.rate_prior.sd, FORWARD_RATE_SD);
  const [lo, hi] = projection.rate_prior.observed_interval_95;
  assert.ok(lo > 0.68 && lo < 0.71, `forward 2.5th percentile ${lo}, expected near 0.70`);
  assert.ok(hi > 0.77 && hi < 0.80, `forward 97.5th percentile ${hi}, expected near 0.79`);
  // The pseudo-sample is deliberately far smaller than the 2,868 legs measured.
  assert.ok(projection.rate_prior.pseudo_sample_legs < 500,
    `the prior claims ${projection.rate_prior.pseudo_sample_legs} legs of evidence; it must not claim 2868`);

  assert.equal(projection.headline, 'with_rate_uncertainty');
  assert.ok(projection.optimistic_ignores_rate_uncertainty, 'both versions are always returned');
});

test('forwardRatePrior refuses a spread the beta cannot represent', () => {
  assert.throws(() => forwardRatePrior({ mean: 1.2 }), /strictly between 0 and 1/);
  assert.throws(() => forwardRatePrior({ mean: 0.74, sd: 0.5 }), /too wide/);
  const prior = forwardRatePrior({ mean: 0.74, sd: 0.023 });
  assert.ok(Math.abs(prior.alpha / (prior.alpha + prior.beta) - 0.74) < 1e-9);
});

test('projection input is validated rather than quietly producing a number', () => {
  assert.throws(() => projectRemainingSeason({ tickets: -1, americanPrice: 100, legRate: DECIDED_RATE, legMix: LEG_MIX }),
    /non-negative integer/);
  assert.throws(() => projectRemainingSeason({ tickets: 10, americanPrice: 100, runs: 10, legRate: DECIDED_RATE, legMix: LEG_MIX }),
    /at least 1000 runs/);
  assert.throws(() => projectRemainingSeason({ tickets: 10, americanPrice: 100, legRate: DECIDED_RATE,
    legMix: [{ line: 3, weight: 0.5, push_share: 0 }] }), /must sum to 1/);
  assert.throws(() => projectRemainingSeason({ tickets: 10, americanPrice: 100, legRate: DECIDED_RATE,
    legMix: LEG_MIX, reducedPayout: 'nonsense' }), /unknown reducedPayout/);
});

/* ======================================================================== */
/* 4. RECORDING                                                             */
/* ======================================================================== */

test('recording refuses illegal tickets and reports the ledger seam honestly', () => {
  const illegal = recordWongTicket({
    ticket: ticket(leg('nfl:X', 'XX', 2.5), leg('nfl:X', 'YY', -7.5), 0.05), mode: 'paper',
  });
  assert.match(illegal.reason, /same game/);

  const badMode = recordWongTicket({
    ticket: ticket(leg('nfl:X', 'XX', 2.5), leg('nfl:Y', 'YY', -7.5), 0.05), mode: 'live',
  });
  assert.match(badMode.error, /paper' or 'placed/);

  const badStake = recordWongTicket({
    ticket: ticket(leg('nfl:X', 'XX', 2.5), leg('nfl:Y', 'YY', -7.5), 0.05),
    mode: 'paper', stakeUnits: 9,
  });
  assert.match(badStake.error, /at most 5/);

  // A ticket the old execution board cannot see is REPORTED, not written. This
  // is the seam between teaser-scan.js (which reads per-book) and
  // teaserExecutionBoard() (which pins to one capture instant); the wrapper
  // must never paper over it by inserting a row the ledger's gates never saw.
  const before = db.prepare('SELECT COUNT(*) n FROM nfl_teaser_executions').get().n;
  const unseen = recordWongTicket({
    ticket: ticket(leg('nfl:UNSEEN1', 'AA', 2.5), leg('nfl:UNSEEN2', 'BB', -7.5), 0.05),
    mode: 'paper', book: 'draftkings',
  });
  assert.match(unseen.error, /no counterpart on the execution board/);
  assert.match(unseen.reason, /simultaneousQuotes/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nfl_teaser_executions').get().n, before,
    'a ticket the ledger will not accept must not appear in it anyway');
});
