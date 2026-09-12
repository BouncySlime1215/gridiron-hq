/**
 * Codex plan section 6.3, the evidence-packet half:
 *
 *   "Collect ahead of T−60 and freeze records actually received by cutoff.
 *    Record computation start/end and forecast emission separately; never
 *    backdate a late capture or fill its missing cutoff packet from later
 *    arrivals. Record a missed capture as a missing prospective observation."
 *
 * The distinction under test is between three clocks that this codebase (and
 * most backtests) routinely collapse into one: when a fact became true, when
 * someone published it, and when THIS system actually received it. Only the
 * third supports a prospective claim. Each test below pins one clause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-t60-packet-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Codex correction C11 scopes the quote lookup to the CANONICAL event, and
// canonical team codes come from this table. Without it `teamCodeFor` returns
// null for every name, and the packet refuses to build rather than letting
// null === null match every game in the kickoff window.
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'ATL','Atlanta Falcons','NFC','South'),
  (2,'CAR','Carolina Panthers','NFC','South'),
  (3,'CHI','Chicago Bears','NFC','North'),
  (4,'DET','Detroit Lions','NFC','North')`);

const { freezeT60Packet, PACKET_VERSION, AVAILABILITY_CLAIMS } =
  await import('../server/services/nfl-t60-packet.js');
const { recordRevision } = await import('../server/services/nfl-bitemporal.js');

/**
 * One injury-report revision, in the exact shape nfl-advanced.js's
 * syncInjuries (Giant Plan 8.14) now writes to nfl_feature_revisions: entity
 * scoped to the player's SPECIFIC season/week (a report never bleeds into a
 * different week), a fixed 'injury_report' feature, and both clocks kept
 * apart so a test can put observedAt on either side of the cutoff without
 * also having to fake a publication time it does not care about.
 */
function storeInjuryRevision(gsisId, { season = GAME.season, week = GAME.week,
  publishedAt, observedAt = publishedAt, provenance = 'captured',
  value = { report_status: 'Questionable', practice_status: 'Limited', injury: 'Ankle' } } = {}) {
  recordRevision({ entity: `player:${gsisId}:${season}:${week}`, feature: 'injury_report',
    value, publishedAt, observedAt, provenance, sourceId: 'nflverse_injuries' });
}

const KICKOFF = '2026-09-20T17:00:00Z';
const CUTOFF = '2026-09-20T16:00:00.000Z';
const GAME = { season: 2026, week: 3, home: 'ATL', away: 'CAR', kickoff: KICKOFF };

/**
 * A quote batch for our game.
 *
 * `receivedAt` is the instant the provider's response actually COMPLETED, and
 * is what a prospective claim rests on. It defaults to `requestedAt` here only
 * because most of these fixtures do not care about the gap; the tests that DO
 * care pass them separately, because Codex correction C11 turns on exactly
 * that difference — `requested_at` is stamped before the request goes out, so
 * using it as a receipt admits prices the decision did not yet hold.
 *
 * `clockSource` defaults to a real observed receipt. A batch that only ever
 * recorded a request time must say `legacy_request_time_only`, and the packet
 * then refuses to grant it a prospective claim at all.
 */
function storeQuote(batchId, requestedAt, snapshotAt = requestedAt, {
  receivedAt = requestedAt, clockSource = 'response_completion',
  homeTeam = 'Atlanta Falcons', awayTeam = 'Carolina Panthers',
  commenceTime = KICKOFF, period = 'full_game', market = 'spreads',
  line = -3.5, price = -110, eventId = 'evt-1'
} = {}) {
  run(`INSERT INTO nfl_quote_batches
    (batch_id,provider,requested_at,received_at,receipt_clock_source,snapshot_at,mode,markets,
     source_ref,events,quotes,raw_hash,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    batchId, 'testbook', requestedAt, receivedAt, clockSource, snapshotAt, 'live', 'spreads', 'fixture', 1, 1,
    `hash-${batchId}`, 'v1', requestedAt);
  run(`INSERT INTO nfl_quote_tape
    (quote_id,batch_id,provider,provider_event_id,commence_time,snapshot_at,bookmaker_key,market,period,
     side_key,side_name,home_team,away_team,line,american_price,implied_probability,raw_json,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `q-${batchId}`, batchId, 'testbook', eventId, commenceTime, snapshotAt, 'testbook', market, period,
    'home', homeTeam, homeTeam, awayTeam, line, price, 0.524, '{}', 'v1', requestedAt);
}

const sourceIn = (packet, name) => packet.sources.find(s => s.source === name);

test('a quote received before the cutoff is the one claim a prospective decision may rest on', () => {
  storeQuote('batch-early', '2026-09-20T15:30:00Z');
  const packet = freezeT60Packet(GAME);

  assert.equal(packet.packet_version, PACKET_VERSION);
  assert.equal(packet.cutoff_at, CUTOFF);
  const quote = sourceIn(packet, 'nfl_quote_tape');
  assert.equal(quote.claim, 'received_by_cutoff');
  assert.equal(quote.received_at, '2026-09-20T15:30:00Z');
  assert.ok(packet.summary.eligible.includes('nfl_quote_tape'));
  assert.match(packet.claim, /^PROSPECTIVE/);
});

test('a capture that arrived AFTER the cutoff is not in the packet at all — it is not backdated', () => {
  // 16:45 is fifteen minutes before kickoff, and forty-five minutes after the
  // decision instant. This row exists in the database and describes the same
  // game, and it must not reach the packet.
  storeQuote('batch-late', '2026-09-20T16:45:00Z');
  const packet = freezeT60Packet(GAME);
  const quote = sourceIn(packet, 'nfl_quote_tape');
  assert.equal(quote.received_at, '2026-09-20T15:30:00Z',
    'the latest RECEIVED-by-cutoff capture, never the newest row in the table');
  assert.notEqual(quote.received_at, '2026-09-20T16:45:00Z');
});

test('a source with nothing by the cutoff is a RECORDED missing observation, not a silent absence', () => {
  const packet = freezeT60Packet({ ...GAME, season: 2099, week: 1 });
  const injuries = sourceIn(packet, 'nfl_injuries');
  assert.equal(injuries.claim, 'missing');
  assert.equal(injuries.rows, 0);
  assert.match(injuries.reason, /no injury revisions/);
  assert.ok(packet.summary.missing.includes('nfl_injuries'),
    '"we had no injury report" has to be a fact the evaluation can see, not a silence that reads as "nothing was wrong"');
});

test('Giant Plan 8.14: a legacy nfl_injuries row with no revision is invisible to the packet, not quarantined', () => {
  // Before this stage, the packet read nfl_injuries.modified_at directly, and
  // a row with no modified_at (real 2025 rows carry none — the audit's own
  // finding) was QUARANTINED: present but unusable. The packet now reads
  // nfl_feature_revisions instead, and a row written straight into
  // nfl_injuries -- bypassing nfl-advanced.js's syncInjuries, exactly like an
  // installation's pre-existing data before it was re-synced under the new
  // wiring -- has no revision at all. That is the documented rollout gap
  // (see PIPELINE_REPORT.md), and it must read as MISSING, not as a row the
  // packet saw and couldn't clock -- the two are different claims and this
  // guards against silently reviving the old quarantine path by accident.
  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,NULL)`, 2026, 3, 'GSIS-1', 'ATL', 'A Player', 'WR', 'Questionable');
  const packet = freezeT60Packet(GAME);
  const injuries = sourceIn(packet, 'nfl_injuries');
  assert.equal(injuries.claim, 'missing');
  assert.equal(injuries.rows_now, 0, 'the legacy row is real, but the as-of read only ever sees revisions');
  assert.ok(!packet.summary.eligible.includes('nfl_injuries'));
  assert.ok(packet.summary.missing.includes('nfl_injuries'));
});

test('Giant Plan 8.14: an injury revision received by the cutoff is the claim a prospective decision may use', () => {
  storeInjuryRevision('GSIS-2', { publishedAt: '2026-09-18T21:00:00Z', observedAt: '2026-09-18T21:05:00Z' });
  const packet = freezeT60Packet(GAME);
  const injuries = sourceIn(packet, 'nfl_injuries');
  assert.equal(injuries.claim, 'received_by_cutoff');
  assert.equal(injuries.received_at, '2026-09-18T21:05:00.000Z',
    'the revision store\'s own observed_at, not nfl_injuries.modified_at, is the receipt clock now');
  assert.ok(packet.summary.eligible.includes('nfl_injuries'));
});

test('a labeled historical replay may use evidenced publication, and says so in its own claim', () => {
  run(`INSERT INTO nfl_news_events
    (event_id,source_kind,source_ref,content_hash,claim_type,claim_text,evidence_span,published_at,
     first_seen_time,extractor_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'news-1', 'news_item', 'ref-1', 'hash-1', 'injury', 'Starter is out', 'span',
    '2026-09-20T14:00:00Z', '2026-09-20T14:05:00Z', 'v1');

  const prospective = freezeT60Packet(GAME);
  assert.equal(sourceIn(prospective, 'nfl_news_events').claim, 'received_by_cutoff');

  const historical = freezeT60Packet({ ...GAME, mode: 'historical' });
  assert.match(historical.claim, /LABELED HISTORICAL REPLAY/);
  assert.match(historical.claim, /not a record of what this system actually held/);
});

test('a prospective packet REFUSES what a historical one may use', () => {
  // Team-week features are rebuilt in bulk from a season file with no
  // per-row receipt clock, so they can never qualify as prospective.
  run('INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)',
    2026, 1, 'ATL', 'CAR', 1, '{}');
  const packet = freezeT60Packet(GAME);
  const features = sourceIn(packet, 'nfl_team_week_features');
  assert.equal(features.claim, 'availability_unknown');
  assert.ok(!packet.summary.eligible.includes('nfl_team_week_features'),
    'real data, unevidenced availability — it stays out of a prospective decision');
});

test('computation clocks are recorded separately from the cutoff, and a late emission is disclosed', () => {
  const packet = freezeT60Packet({ ...GAME,
    computationStartedAt: '2026-09-20T15:55:00Z',
    computationFinishedAt: '2026-09-20T16:03:00Z' });
  assert.equal(packet.computation_started_at, '2026-09-20T15:55:00Z');
  assert.equal(packet.emitted_after_cutoff, true,
    'the forecast finished three minutes past the cutoff; the packet still holds only pre-cutoff inputs');
  const quote = packet.sources.find(s => s.source === 'nfl_quote_tape');
  assert.equal(quote.received_at, '2026-09-20T15:30:00Z', 'a later emission never widens what was knowable');
});

test('an unresolvable kickoff yields no packet rather than a guessed cutoff', () => {
  assert.match(freezeT60Packet({ ...GAME, kickoff: 'not a time' }).error, /unresolvable kickoff/);
});

test('every claim a packet can make is one of the declared kinds', () => {
  const packet = freezeT60Packet(GAME);
  for (const source of packet.sources) {
    assert.ok(AVAILABILITY_CLAIMS.includes(source.claim), `undeclared claim: ${source.claim}`);
  }
  assert.equal(packet.summary.total_sources, packet.sources.length);
});


/*
 * Section 6.3 acceptance, verbatim:
 *
 *   "Attempt to inject tomorrow's injury status, postgame weather, next-week
 *    ranks, and a revised record. Each attempt must be rejected or
 *    quarantined with an explicit reason."
 *
 * Each test below performs one of those four injections against a real
 * packet and asserts BOTH that the value never becomes eligible AND that the
 * packet says why. A silent exclusion would pass the first half and fail the
 * point: the reason is what makes the refusal auditable.
 */

test('INJECTION 1 — tomorrow\'s injury status cannot enter today\'s packet', () => {
  // A revision OBSERVED after the cutoff. This is the most realistic
  // look-ahead in the whole system: the fact is genuine, it is about the
  // right game, and this system simply had not recorded it yet.
  storeInjuryRevision('GSIS-LATE', { season: 2031, week: 5,
    publishedAt: '2026-09-20T16:25:00Z', observedAt: '2026-09-20T16:30:00Z',
    value: { report_status: 'Out', practice_status: null, injury: null } });
  const packet = freezeT60Packet({ ...GAME, season: 2031, week: 5 });
  const injuries = sourceIn(packet, 'nfl_injuries');

  assert.equal(injuries.claim, 'late_arrival_excluded');
  assert.equal(injuries.rows, 0, 'nothing was knowable');
  assert.equal(injuries.rows_now, 1, 'the revision exists and is disclosed');
  assert.match(injuries.reason, /after the .* cutoff/);
  assert.match(injuries.reason, /Backfilling an old fact today is not discovering when it first became known/);
  assert.ok(!packet.summary.eligible.includes('nfl_injuries'));
  assert.ok(packet.summary.late_arrival_excluded.includes('nfl_injuries'));

  // And it cannot be smuggled in by asking for the weaker historical claim.
  const historical = freezeT60Packet({ ...GAME, season: 2031, week: 5, mode: 'historical' });
  assert.ok(!historical.summary.eligible.includes('nfl_injuries'),
    'a late arrival is excluded in EVERY mode — the historical claim is weaker, not unlimited');
});

test('INJECTION 2 — postgame weather is refused as an oracle in every mode', () => {
  run(`INSERT INTO nfl_game_weather (season,week,home,kickoff,temp_c,wind_kmh,gust_kmh,precip_mm,source,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, 2026, 3, 'ATL', KICKOFF, 12, 30, 45, 8,
    'realized-observation', '2026-09-20T15:00:00Z');
  // Note the fetched_at: 15:00 is BEFORE the 16:00 cutoff. A pure clock check
  // would admit this row. It is refused on what it IS, not on when it arrived.
  for (const mode of ['prospective', 'historical']) {
    const packet = freezeT60Packet({ ...GAME, mode });
    const weather = sourceIn(packet, 'nfl_game_weather');
    assert.equal(weather.claim, 'oracle_excluded', `mode ${mode} admitted realized weather`);
    assert.match(weather.reason, /records what actually happened, not what was forecast/);
    assert.ok(!packet.summary.eligible.includes('nfl_game_weather'));
    assert.ok(packet.summary.oracle_excluded.includes('nfl_game_weather'));
  }
});

test('INJECTION 3 — next-week ranks cannot reach an earlier week', () => {
  // Team-week features for weeks at and after the game. The packet's own
  // query is bounded to `week < ?`, so a later week is structurally
  // unreachable rather than filtered by a caller who might forget.
  run('INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)',
    2032, 9, 'ATL', 'CAR', 1, '{"rank":1}');
  run('INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)',
    2032, 10, 'ATL', 'CAR', 1, '{"rank":32}');

  const packet = freezeT60Packet({ ...GAME, season: 2032, week: 9 });
  const features = sourceIn(packet, 'nfl_team_week_features');
  assert.equal(features.rows_now, 0,
    'week 9 and week 10 rows are both outside a week-9 decision; only weeks 1-8 could ever qualify');
  assert.equal(features.claim, 'missing');
  assert.match(features.reason, /no prior-week team features/);
});

test('INJECTION 4 — a revised record does not overwrite what was received', () => {
  // The same game, quoted twice: once before the cutoff at -3.5, then revised
  // after it. "Preserve what was actually received, not just the latest
  // stored value" (section 6.1).
  storeQuote('batch-revision-early', '2026-09-20T14:00:00Z');
  storeQuote('batch-revision-late', '2026-09-20T16:59:00Z');
  const packet = freezeT60Packet(GAME);
  const quote = sourceIn(packet, 'nfl_quote_tape');

  assert.equal(quote.claim, 'received_by_cutoff');
  assert.ok(new Date(quote.received_at).getTime() <= new Date(CUTOFF).getTime(),
    'the packet reports the latest capture RECEIVED BY the cutoff, never the latest row in the table');
  assert.ok(quote.rows_now > quote.rows,
    'the later revisions are disclosed as existing, and excluded from what was knowable');
});

test('the four injection attempts are each refused for a stated reason, never silently', () => {
  const packet = freezeT60Packet({ ...GAME, season: 2031, week: 5 });
  for (const source of packet.sources) {
    if (packet.summary.eligible.includes(source.source)) continue;
    assert.ok(source.reason && source.reason.length > 20,
      `${source.source} was excluded with no usable reason: ${source.reason}`);
  }
});

/* ======================================================================
 * Codex correction C11 — "The T−60 packet is not yet a frozen game evidence
 * packet." Its close-with list, one test per clause.
 * ====================================================================== */

test('C11: simultaneous kickoffs cannot cross-match', () => {
  // The original predicate was the kickoff instant alone. The NFL runs up to
  // nine games at 1:00pm Eastern; the audit's fixture counted another game's
  // quote as CAR-CHI's evidence. Here CHI-DET kicks off at the same second.
  const packet = freezeT60Packet({ season: 2026, week: 3, home: 'CHI', away: 'DET', kickoff: KICKOFF });
  const before = sourceIn(packet, 'nfl_quote_tape').rows_now;

  storeQuote('batch-other-game', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00Z',
    { homeTeam: 'Chicago Bears', awayTeam: 'Detroit Lions' });

  const ours = sourceIn(freezeT60Packet(GAME), 'nfl_quote_tape');
  const theirs = sourceIn(freezeT60Packet(
    { season: 2026, week: 3, home: 'CHI', away: 'DET', kickoff: KICKOFF }), 'nfl_quote_tape');

  assert.equal(theirs.rows_now, before + 1, 'the new quote belongs to CHI-DET');
  assert.ok(ours.values.every(v => v.quote_id !== 'q-batch-other-game'),
    "another game's quote must never appear in ATL-CAR's packet");
});

test('C11: a first-half quote cannot qualify a full-game spread', () => {
  storeQuote('batch-first-half', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00Z',
    { period: 'first_half', line: -1.5, price: -200 });
  const quote = sourceIn(freezeT60Packet(GAME), 'nfl_quote_tape');
  assert.ok(quote.values.every(v => v.period === 'full_game'),
    'a full-game spread settles differently from a first-half spread; they are different contracts');
  assert.ok(quote.values.every(v => v.quote_id !== 'q-batch-first-half'));
});

test('C11: a totals quote cannot qualify a spread either', () => {
  storeQuote('batch-total', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00Z',
    { market: 'totals', line: 44.5 });
  const quote = sourceIn(freezeT60Packet(GAME), 'nfl_quote_tape');
  assert.ok(quote.values.every(v => v.market === 'spreads'));
});

test('C11: requested BEFORE the cutoff but received AFTER it is excluded', () => {
  // The exact CAR-CHI counterexample: the request went out at 15:59, one
  // minute before the 16:00 cutoff, and the response completed at 16:02. The
  // old predicate read `requested_at` and counted it as available.
  storeQuote('batch-straddling', '2026-09-20T15:59:00Z', '2026-09-20T16:02:00Z',
    { receivedAt: '2026-09-20T16:02:00Z' });
  const quote = sourceIn(freezeT60Packet(GAME), 'nfl_quote_tape');

  assert.ok(quote.values.every(v => v.quote_id !== 'q-batch-straddling'),
    'a price this system did not yet hold at the cutoff is not evidence at the cutoff');
  assert.ok(new Date(quote.received_at).getTime() <= new Date(CUTOFF).getTime());
});

test('C11: a batch carrying only a request time cannot support a prospective claim', () => {
  const isolated = { season: 2026, week: 3, home: 'CHI', away: 'DET', kickoff: '2026-09-21T17:00:00Z' };
  storeQuote('batch-legacy-clock', '2026-09-21T15:00:00Z', '2026-09-21T15:00:00Z', {
    clockSource: 'legacy_request_time_only', commenceTime: '2026-09-21T17:00:00Z',
    homeTeam: 'Chicago Bears', awayTeam: 'Detroit Lions', eventId: 'evt-legacy' });

  const quote = sourceIn(freezeT60Packet(isolated), 'nfl_quote_tape');
  assert.equal(quote.rows_now, 1, 'the row exists and is disclosed');
  assert.equal(quote.rows, 0, 'but it counts for nothing at the cutoff');
  assert.notEqual(quote.claim, 'received_by_cutoff');
  assert.match(quote.note, /only a request time/);
});

test('C11: the packet persists actual values, not just counts', () => {
  const quote = sourceIn(freezeT60Packet(GAME), 'nfl_quote_tape');
  assert.ok(Array.isArray(quote.values) && quote.values.length > 0);
  for (const value of quote.values) {
    for (const field of ['quote_id', 'bookmaker_key', 'market', 'period', 'side_key',
      'line', 'american_price', 'snapshot_at', 'received_at']) {
      assert.ok(field in value, `a frozen quote must carry its ${field}`);
    }
    assert.equal(value.market, 'spreads');
    assert.equal(value.period, 'full_game');
    assert.ok(new Date(value.received_at).getTime() <= new Date(CUTOFF).getTime());
  }
  assert.equal(quote.values.length, quote.rows, 'the count and the values are the same fact');
});

test('C11: an event this system cannot name canonically has no packet at all', () => {
  // Without this guard `teamCodeFor` returns null on both sides, null === null,
  // and an unidentifiable game silently matches EVERY row in the kickoff window
  // -- the cross-game bug wearing the costume of a scoped query.
  const packet = freezeT60Packet({ ...GAME, home: 'Notateam', away: 'Alsonotateam' });
  assert.match(packet.error, /unresolvable canonical event/);
});

test('C11: a reschedule keeps the event identity and moves the cutoff with it', () => {
  const moved = '2026-09-20T20:15:00Z';
  storeQuote('batch-rescheduled', '2026-09-20T18:00:00Z', '2026-09-20T18:00:00Z',
    { commenceTime: moved, eventId: 'evt-1' });

  const packet = freezeT60Packet({ ...GAME, kickoff: moved, scheduleVersion: 'sched-2' });
  assert.equal(packet.cutoff_at, '2026-09-20T19:15:00.000Z', 'the cutoff follows the new kickoff');
  assert.equal(packet.schedule_version, 'sched-2');
  const quote = sourceIn(packet, 'nfl_quote_tape');
  assert.ok(quote.values.some(v => v.quote_id === 'q-batch-rescheduled'),
    'the same canonical event still owns its quotes after the move');
});

test('C11: an invalid mode fails explicitly rather than silently widening what is eligible', () => {
  const packet = freezeT60Packet({ ...GAME, mode: 'whatever-i-feel-like' });
  assert.ok(packet.error || !packet.summary.eligible.includes('nfl_game_weather'),
    'an unknown mode must never grant more than prospective does');
});

test('C11: the corrected predicate is indexed, not merely correct', () => {
  // Migration 029 indexed the OLD predicate — kickoff alone — which made the
  // cross-game lookup fast rather than right. The corrected predicate leads
  // with the kickoff range and then narrows by market and period, and
  // migration 032 indexes that shape. Without an index this is a full scan of
  // a table that holds over a million rows in the real database.
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    SELECT q.quote_id FROM nfl_quote_tape q JOIN nfl_quote_batches b ON b.batch_id = q.batch_id
     WHERE q.commence_time >= ? AND q.commence_time < ? AND q.market = ? AND q.period = ?`)
    .all(KICKOFF, KICKOFF, 'spreads', 'full_game');
  const detail = plan.map(step => step.detail).join(' | ');
  assert.match(detail, /USING INDEX/, `the quote scan must use an index — plan was: ${detail}`);
  assert.doesNotMatch(detail, /SCAN nfl_quote_tape\b(?!.*USING)/,
    `nfl_quote_tape must not be table-scanned — plan was: ${detail}`);
});
