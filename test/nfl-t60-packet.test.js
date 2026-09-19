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
// SEA/SF are added alongside the original four so a team-scoping test can
// seed a THIRD real game (SEA @ SF) in the same week as ATL-CAR and CHI-DET,
// without disturbing any existing test's fixture.
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'ATL','Atlanta Falcons','NFC','South'),
  (2,'CAR','Carolina Panthers','NFC','South'),
  (3,'CHI','Chicago Bears','NFC','North'),
  (4,'DET','Detroit Lions','NFC','North'),
  (5,'SEA','Seattle Seahawks','NFC','West'),
  (6,'SF','San Francisco 49ers','NFC','West')`);

const { freezeT60Packet, PACKET_VERSION, AVAILABILITY_CLAIMS, decisionTimeManifest, resolvePacketMarketQuote,
  PACKET_BOARD_INPUT_COVERAGE } = await import('../server/services/nfl-t60-packet.js');
// WP15/D3: freezeT60Packet now calls nfl-ensemble.js's featureAggregates(),
// which caches its result per season/week at the module level (the same
// cache the live ensembleLine path already relied on). A test that inserts
// nfl_team_week_features rows for a season/week this file has already frozen
// a packet for (GAME's season/week is shared across most tests here) must
// invalidate that cache first, or it will see whatever an EARLIER test's
// freeze already cached -- often an empty map, from before any rows existed.
const { invalidateEnsembleCaches } = await import('../server/services/nfl-ensemble.js');
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
    value, publishedAt, observedAt, provenance, sourceId: 'nflverse_injuries',
    entitySeason: season, entityWeek: week });
}

/**
 * The same revision, but ALSO backed by an `nfl_injuries` row carrying a real
 * `team` — the shape nfl-advanced.js's syncInjuries actually produces in
 * production (GIANT_PLAN_BUILD_REPORT.md §2.2: "nfl_injuries is still written
 * in the same transaction as every real revision"). `storeInjuryRevision`
 * above deliberately leaves `nfl_injuries` untouched, which only exercises
 * the OTHER permissive branch of the query's `(ni.team IS NULL OR ni.team IN
 * (?, ?))` filter. To actually prove team-scoping rejects a real cross-game
 * row, the LEFT JOIN has to have a team to reject in the first place.
 */
function storeInjuryRevisionWithTeam(gsisId, team, { season = GAME.season, week = GAME.week,
  publishedAt, observedAt = publishedAt, provenance = 'captured',
  value = { report_status: 'Questionable', practice_status: 'Limited', injury: 'Ankle' } } = {}) {
  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    season, week, gsisId, team, `${gsisId} Player`, 'WR', value.report_status ?? 'Questionable', observedAt);
  recordRevision({ entity: `player:${gsisId}:${season}:${week}`, feature: 'injury_report',
    value, publishedAt, observedAt, provenance, sourceId: 'nflverse_injuries',
    entitySeason: season, entityWeek: week });
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
  invalidateEnsembleCaches();
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

/* ======================================================================
 * GIANT_PLAN_BUILD_REPORT.md §2.2 — dedicated regression.
 *
 * The injuries read against `nfl_feature_revisions` has no team of its own to
 * filter on (`entity` is `player:<gsisId>:<season>:<week>` — see
 * nfl-advanced.js:394), so a merge reintroduced the exact cross-game leak G22
 * had already fixed for the old `nfl_injuries.modified_at` read: without a
 * team filter, this game's packet would absorb every OTHER game's injury
 * revisions for the same week too. The fix synthesized during that merge
 * (LEFT JOIN back onto `nfl_injuries` purely to recover `team`, then
 * `ni.team IS NULL OR ni.team IN (?, ?)`) was flagged explicitly: "no test in
 * the repo exercises team-scoping of this specific (bitemporal) path... the
 * single highest-synthesis-risk line in this entire merge." These two tests
 * are that regression.
 * ====================================================================== */

test('GIANT_PLAN §2.2: this game does not absorb another same-week game\'s injury revisions', () => {
  // Three real games, one shared week: ATL-CAR (GAME, under test), CHI-DET,
  // and SEA-SF. Nothing about `freezeT60Packet` looks up a schedule to learn
  // who else is playing — the leak this guards against is purely a same
  // season/week match against `nfl_feature_revisions`, so seeding these as
  // three independently-named games (same convention the C11 kickoff test
  // above already uses for CHI-DET) is enough to exercise it for real.
  const UNRELATED_1 = { season: GAME.season, week: GAME.week, home: 'CHI', away: 'DET', kickoff: KICKOFF };
  const UNRELATED_2 = { season: GAME.season, week: GAME.week, home: 'SEA', away: 'SF', kickoff: KICKOFF };

  // Baselines first (deltas, not absolutes) — earlier tests in this file
  // already left season-2026/week-3 injury revisions on the shared fixture
  // DB (e.g. GSIS-2, which has no matching `nfl_injuries` row and so
  // legitimately passes every game's filter via the `ni.team IS NULL`
  // branch). That is expected, documented behavior, not this test's concern.
  const beforeGame = sourceIn(freezeT60Packet(GAME), 'nfl_injuries');
  const beforeU1 = sourceIn(freezeT60Packet(UNRELATED_1), 'nfl_injuries');
  const beforeU2 = sourceIn(freezeT60Packet(UNRELATED_2), 'nfl_injuries');

  // Positive control: a revision for OUR OWN team, recorded the same way the
  // leak attempt below will be. This must count, so a later zero-delta for
  // the unrelated games can't be misread as "the query stopped counting
  // anything at all" rather than "team-scoping is doing its job."
  storeInjuryRevisionWithTeam('GSIS-ATL-1', 'ATL',
    { publishedAt: '2026-09-19T12:00:00Z', observedAt: '2026-09-19T12:05:00Z' });
  const afterOwnTeam = sourceIn(freezeT60Packet(GAME), 'nfl_injuries');
  assert.equal(afterOwnTeam.rows, beforeGame.rows + 1, 'our own team\'s revision must be counted');
  assert.equal(afterOwnTeam.rows_now, beforeGame.rows_now + 1);

  // The leak attempt: two OTHER real games, each getting injury revisions for
  // the exact same season/week as GAME. Before the team-scoping fix, none of
  // these had anything stopping them from matching GAME's season/week filter.
  storeInjuryRevisionWithTeam('GSIS-CHI-1', 'CHI',
    { publishedAt: '2026-09-19T13:00:00Z', observedAt: '2026-09-19T13:05:00Z' });
  storeInjuryRevisionWithTeam('GSIS-DET-1', 'DET',
    { publishedAt: '2026-09-19T13:10:00Z', observedAt: '2026-09-19T13:15:00Z' });
  storeInjuryRevisionWithTeam('GSIS-SEA-1', 'SEA',
    { publishedAt: '2026-09-19T13:20:00Z', observedAt: '2026-09-19T13:25:00Z' });
  storeInjuryRevisionWithTeam('GSIS-SF-1', 'SF',
    { publishedAt: '2026-09-19T13:30:00Z', observedAt: '2026-09-19T13:35:00Z' });

  const afterLeakAttempt = sourceIn(freezeT60Packet(GAME), 'nfl_injuries');
  assert.equal(afterLeakAttempt.rows, afterOwnTeam.rows,
    'four other games\' teams just received injury revisions for this exact season/week — none of them may ' +
    'count toward what ATL-CAR could have known');
  assert.equal(afterLeakAttempt.rows_now, afterOwnTeam.rows_now,
    'rows_now is computed inside the SAME team-filtered query as rows — an unrelated game\'s revision must be ' +
    'invisible here entirely, not merely excluded from cutoff eligibility');

  // And those four revisions are real, not silently lost — proving this is
  // team-SCOPING, not a bug that happens to also drop the unrelated rows.
  // Each belongs to its own game's packet, and only its own game's.
  const afterU1 = sourceIn(freezeT60Packet(UNRELATED_1), 'nfl_injuries');
  assert.equal(afterU1.rows_now, beforeU1.rows_now + 2,
    'CHI-DET\'s own packet gains exactly its own two teams\' revisions');
  const afterU2 = sourceIn(freezeT60Packet(UNRELATED_2), 'nfl_injuries');
  assert.equal(afterU2.rows_now, beforeU2.rows_now + 2,
    'SEA-SF\'s own packet gains exactly its own two teams\' revisions — not CHI-DET\'s, and not ATL-CAR\'s');
});

test('GIANT_PLAN §2.2 boundary: an unresolved-team revision (ni.team IS NULL) still counts here', () => {
  // The LEFT JOIN exists ONLY to recover a team to filter on. When
  // `nfl_injuries` itself has no team for a player — a real case: a snapshot
  // taken during the player's bye week, or before a trade/signing resolved
  // their team — the code explicitly keeps the row rather than dropping it:
  // "the same permissive rule G22 already applied to nfl_news_events'
  // nullable team" (GIANT_PLAN_BUILD_REPORT.md §2.2). This is the other half
  // of the filter (`ni.team IS NULL OR ...`) that the leak test above does
  // not exercise, and it must keep working even though the fix's whole point
  // is to REJECT other teams — this one team value is explicitly not that.
  const before = sourceIn(freezeT60Packet(GAME), 'nfl_injuries');

  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    GAME.season, GAME.week, 'GSIS-BYE-1', null, 'Bye Week Player', 'RB', 'Questionable', '2026-09-19T14:00:00Z');
  recordRevision({ entity: `player:GSIS-BYE-1:${GAME.season}:${GAME.week}`, feature: 'injury_report',
    value: { report_status: 'Questionable', practice_status: 'Limited', injury: 'Knee' },
    publishedAt: '2026-09-19T14:00:00Z', observedAt: '2026-09-19T14:05:00Z',
    provenance: 'captured', sourceId: 'nflverse_injuries',
    entitySeason: GAME.season, entityWeek: GAME.week });

  const after = sourceIn(freezeT60Packet(GAME), 'nfl_injuries');
  assert.equal(after.rows_now, before.rows_now + 1,
    'a revision whose matching nfl_injuries row has team IS NULL is retained, not dropped');
  assert.equal(after.rows, before.rows + 1,
    'it was observed before the cutoff, so it counts toward what this game\'s decision could have known');
  assert.equal(after.claim, 'received_by_cutoff');
});

/* ======================================================================
 * decisionTimeManifest's kickoff reconstruction used to hardcode a -04:00
 * (EDT) offset when turning game_lines.gameday/gametime (US Eastern wall
 * time) into a kickoff instant. That is only correct for roughly
 * mid-March-to-early-November; a game played under Eastern STANDARD time
 * (UTC-5) came out an hour early. The fix reuses date-util.js's
 * `nflKickoffDate`, which resolves the real America/New_York offset —
 * including DST — for the given date. These tests pin one game from each
 * side of the DST boundary and check the resulting packet's own `kickoff`
 * field, which is the exact instant `freezeT60Packet` used to compute its
 * cutoff and scope its evidence queries.
 * ====================================================================== */

test('decisionTimeManifest: a standard-time (winter) kickoff resolves to UTC-5, not the old hardcoded UTC-4', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime)
       VALUES (?,?,?,?,?,?,?)`, 2025, 18, 'ATL', 'CAR', 1, '2026-01-04', '13:00');

  const manifest = decisionTimeManifest([2025], { mode: 'prospective' });
  const found = manifest.packets.find(p => p.game.gameday === '2026-01-04');
  assert.ok(found, 'the seeded winter game must produce a packet');
  assert.equal(found.packet.kickoff, '2026-01-04T18:00:00.000Z',
    '13:00 Eastern STANDARD time is 18:00Z (UTC-5); the old fixed -04:00 offset would have produced 17:00Z');
});

test('decisionTimeManifest: a daylight-time (summer/early-fall) kickoff resolves to UTC-4', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime)
       VALUES (?,?,?,?,?,?,?)`, 2026, 2, 'CHI', 'DET', 1, '2026-09-13', '13:00');

  const manifest = decisionTimeManifest([2026], { mode: 'prospective' });
  const found = manifest.packets.find(p => p.game.gameday === '2026-09-13');
  assert.ok(found, 'the seeded early-season game must produce a packet');
  assert.equal(found.packet.kickoff, '2026-09-13T17:00:00.000Z',
    '13:00 Eastern DAYLIGHT time is 17:00Z (UTC-4), matching nflKickoffDate\'s America/New_York conversion');
});

test('decisionTimeManifest: caveats no longer disclose a hardcoded -04:00 offset bug that is fixed', () => {
  const manifest = decisionTimeManifest([2025], { mode: 'prospective' });
  for (const caveat of manifest.caveats) {
    assert.doesNotMatch(caveat, /-04:00/, 'no caveat should still describe the retired fixed-offset limitation');
    assert.doesNotMatch(caveat, /one hour off/i);
  }
});

/**
 * resolvePacketMarketQuote: two related bugs found in code review (C03/C04).
 *
 * resolvePacketMarketQuote() operates purely on a packet's already-frozen
 * `sources` array -- it never touches the database -- so these tests build a
 * minimal synthetic packet directly rather than going through
 * freezeT60Packet(). That keeps each case a single, unambiguous fixture for
 * exactly the pairing/selection logic under test.
 */
function quote(bookmaker_key, side_key, line, receivedAt, { american_price = -110, snapshotAt = receivedAt } = {}) {
  return { bookmaker_key, side_key, line, american_price, received_at: receivedAt, snapshot_at: snapshotAt };
}
function quotePacket(values, { mode = 'prospective' } = {}) {
  return { mode, sources: [{ source: 'nfl_quote_tape', claim: 'received_by_cutoff', values }],
    summary: { eligible: ['nfl_quote_tape'] } };
}

test('resolvePacketMarketQuote: an exact mirrored pair from the preferred book is unaffected (happy path)', () => {
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:00:00Z'),
    quote('pinnacle', 'away', 3, '2026-09-20T15:05:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.book, 'pinnacle');
  assert.equal(resolved.pair_complete, true);
  assert.equal(resolved.home_spread, -3);
  assert.equal(resolved.away_spread, 3);
  assert.equal(resolved.away_price, -110);
});

test('C03: a home/away pair whose lines are not exact mirror images is rejected, not silently combined', () => {
  // home -3 paired with away +2.5 is not a real spread contract (a real
  // market always mirrors: home -3 implies away +3). The two quotes were
  // also received at different times, underscoring they are independent,
  // non-simultaneous offers rather than one coherent capture.
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:59:00Z'),
    quote('pinnacle', 'away', 2.5, '2026-09-20T15:30:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'unavailable',
    'mismatched home/away lines must never be presented as one matched contract');
  assert.match(resolved.reason, /mirror|mismatch|non-mirrored/i);
});

test('C03: a mismatched book does not fall back to a single-sided quote either', () => {
  // The book DID capture an away side -- it just does not mirror the home
  // side -- so treating the home line as an uncontested single-sided quote
  // would ignore evidence the book itself froze that the market had moved.
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:59:00Z'),
    quote('pinnacle', 'away', 2.5, '2026-09-20T15:30:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'unavailable');
  assert.notEqual(resolved.book, 'pinnacle');
});

test('C04: a preferred book with only half the market falls back to a different book holding a complete pair', () => {
  // pinnacle (first in SHARP_BOOKS) only froze an away-side quote here; a
  // second book, 'other', has a complete, correctly mirrored pair. The
  // complete pair must be used instead of declaring the quote unavailable.
  const packet = quotePacket([
    quote('pinnacle', 'away', 3, '2026-09-20T15:59:00Z'),
    quote('other', 'home', -3, '2026-09-20T15:59:00Z'),
    quote('other', 'away', 3, '2026-09-20T15:59:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'available',
    'a complete pair in a non-preferred book must not be discarded for an incomplete preferred book');
  assert.equal(resolved.book, 'other');
  assert.equal(resolved.pair_complete, true);
  assert.equal(resolved.home_spread, -3);
  assert.equal(resolved.away_spread, 3);
  assert.equal(resolved.away_price, -110);
});

test('C04: with no complete pair anywhere, a lone home-side quote is still reported as a single-sided fallback', () => {
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:00:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.book, 'pinnacle');
  assert.equal(resolved.pair_complete, false);
  assert.equal(resolved.home_spread, -3);
  // Spreads are symmetric by construction, so the away number can be
  // reported, but never a price this packet never actually froze.
  assert.equal(resolved.away_spread, 3);
  assert.equal(resolved.away_price, null);
});

test('C04: an unavailable book is skipped in favor of a later, complete book even when both are non-sharp', () => {
  const packet = quotePacket([
    quote('zzzbook', 'home', -3, '2026-09-20T15:00:00Z'),
    // zzzbook has no away quote at all (single-sided candidate).
    quote('aaabook', 'home', -3, '2026-09-20T15:00:00Z'),
    quote('aaabook', 'away', 3, '2026-09-20T15:00:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.book, 'aaabook', 'a complete pair beats a single-sided quote regardless of alphabetical order');
  assert.equal(resolved.pair_complete, true);
});

test('timestamp of record: an asynchronously-updated pair reports the LATER of the two sides\' receipt times', () => {
  // The away leg arrived 45 minutes after the home leg -- the pair as a
  // whole was not fully known until the away leg showed up, so quote_at
  // must reflect that later moment, not the home side's earlier clock.
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:00:00Z'),
    quote('pinnacle', 'away', 3, '2026-09-20T15:45:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.quote_at, '2026-09-20T15:45:00Z');
  assert.equal(resolved.snapshot_at, '2026-09-20T15:45:00Z');
});

test('timestamp of record: the later side is whichever leg actually updated last, not always home or always away', () => {
  // Same pair, but this time HOME is the side that updated last -- the
  // result must track "whichever leg was later," not a hardcoded side.
  const packet = quotePacket([
    quote('pinnacle', 'away', 3, '2026-09-20T15:00:00Z'),
    quote('pinnacle', 'home', -3, '2026-09-20T15:45:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.quote_at, '2026-09-20T15:45:00Z');
});

test('timestamp of record: a single-sided quote uses the home side\'s own clock (there is no second leg to combine)', () => {
  const packet = quotePacket([
    quote('pinnacle', 'home', -3, '2026-09-20T15:00:00Z')
  ]);
  const resolved = resolvePacketMarketQuote(packet);
  assert.equal(resolved.quote_at, '2026-09-20T15:00:00Z');
});

/*
 * WP15/D3 -- the packet now freezes real VALUES for game_context and
 * team_features, not just a count, so a packet-sourced board can be scored
 * without a live re-read of either table. This section proves the freeze
 * itself; test/t60-packet-sourced-board.test.js proves the consuming board
 * actually stays put after a live-table mutation.
 */

test('D3: game_lines_context freezes the actual weather/rest/division row, not a count', () => {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,temp,wind,roof,
       rest_days,div_game,neutral_site,open_spread,open_total)
     VALUES (?,?,?,?,1,-3.5,44,?,?,?,?,?,?,?,?)`,
    GAME.season, GAME.week, GAME.home, GAME.away, 28, 14, 'outdoors', 6, 1, 0, -3, 43.5);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,rest_days)
     VALUES (?,?,?,?,0,3.5,44,?)`, GAME.season, GAME.week, GAME.away, GAME.home, 7);

  const packet = freezeT60Packet(GAME);
  const context = sourceIn(packet, 'game_lines_context');
  assert.ok(context, 'a new source entry, not folded into an existing one');
  assert.deepEqual(context.values, {
    temp: 28, wind: 14, roof: 'outdoors', home_rest: 6, div_game: 1, neutral_site: 0,
    open_spread: -3, open_total: 43.5, away_rest: 7
  });
});

test('D3: game_lines_context is a recorded missing observation when this game has no game_lines row at all', () => {
  const packet = freezeT60Packet({ ...GAME, season: 2077, week: 1 });
  const context = sourceIn(packet, 'game_lines_context');
  assert.equal(context.claim, 'missing');
  assert.equal(context.values, null);
});

test('D3: nfl_team_week_features freezes the actual per-team feature-aggregate map, not a count', () => {
  run(`INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)`,
    GAME.season, GAME.week - 1, GAME.home, GAME.away, 1, JSON.stringify({ off_epa_per_play: 0.12 }));
  run(`INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (?,?,?,?,?,?)`,
    GAME.season, GAME.week - 1, GAME.away, GAME.home, 0, JSON.stringify({ off_epa_per_play: -0.05 }));

  invalidateEnsembleCaches();
  const packet = freezeT60Packet(GAME);
  const features = sourceIn(packet, 'nfl_team_week_features');
  assert.ok(Array.isArray(features.values), 'a [team, aggregate] pair array, the shape ensembleLine\'s ' +
    'teamFeaturesOverride expects straight from `new Map(values)`');
  const asMap = new Map(features.values);
  assert.equal(asMap.get(GAME.home)?.off_epa, 0.12);
  assert.equal(asMap.get(GAME.away)?.off_epa, -0.05);
  // Still un-evidenced-by-cutoff, same as before this stage -- freezing real
  // values does not upgrade the claim (see the source's own note in
  // nfl-t60-packet.js). A caller that wants both reproducibility AND a
  // prospective claim for this source does not get the second one from D3.
  assert.equal(features.claim, 'availability_unknown');
});

test('D3: nfl_quote_tape_totals captures a totals quote as its own source, distinct from the spread quote', () => {
  storeQuote('batch-totals-capture', '2026-09-20T15:30:00Z', undefined,
    { market: 'totals', line: 44.5, eventId: 'evt-total' });
  const packet = freezeT60Packet(GAME);
  const spreadQuote = sourceIn(packet, 'nfl_quote_tape');
  const totalQuote = sourceIn(packet, 'nfl_quote_tape_totals');
  assert.ok(totalQuote, 'a distinct source, not folded into nfl_quote_tape');
  assert.equal(totalQuote.values[0].line, 44.5);
  assert.equal(totalQuote.values[0].market, 'totals');
  assert.ok(!spreadQuote.values.some(v => v.market === 'totals'),
    'the two markets never contaminate each other\'s capture');
});

test('D3: PACKET_BOARD_INPUT_COVERAGE reports the new schema honestly, including the not-yet-wired total_market state', () => {
  assert.equal(PACKET_BOARD_INPUT_COVERAGE.market_quote, 'in_schema');
  assert.equal(PACKET_BOARD_INPUT_COVERAGE.game_context, 'in_schema');
  assert.equal(PACKET_BOARD_INPUT_COVERAGE.team_features, 'in_schema');
  assert.equal(PACKET_BOARD_INPUT_COVERAGE.total_market, 'in_schema_not_wired',
    'captured as evidence, but not consumed by any decision until a totals contract exists (WP13)');
  assert.equal(PACKET_BOARD_INPUT_COVERAGE.model_state, 'out_of_packet_scope');
});
