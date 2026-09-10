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

const { freezeT60Packet, PACKET_VERSION, AVAILABILITY_CLAIMS } =
  await import('../server/services/nfl-t60-packet.js');

const KICKOFF = '2026-09-20T17:00:00Z';
const CUTOFF = '2026-09-20T16:00:00.000Z';
const GAME = { season: 2026, week: 3, home: 'ATL', away: 'CAR', kickoff: KICKOFF };

/** A quote batch received at `requestedAt`, carrying one quote for our game. */
function storeQuote(batchId, requestedAt, snapshotAt = requestedAt) {
  run(`INSERT INTO nfl_quote_batches
    (batch_id,provider,requested_at,snapshot_at,mode,markets,source_ref,events,quotes,raw_hash,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    batchId, 'testbook', requestedAt, snapshotAt, 'live', 'spreads', 'fixture', 1, 1,
    `hash-${batchId}`, 'v1', requestedAt);
  run(`INSERT INTO nfl_quote_tape
    (quote_id,batch_id,provider,provider_event_id,commence_time,snapshot_at,bookmaker_key,market,period,
     side_key,side_name,home_team,away_team,line,american_price,implied_probability,raw_json,tape_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `q-${batchId}`, batchId, 'testbook', 'evt-1', KICKOFF, snapshotAt, 'testbook', 'spreads', 'full_game',
    'ATL', 'Atlanta Falcons', 'ATL', 'CAR', -3.5, -110, 0.524, '{}', 'v1', requestedAt);
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
  assert.match(injuries.reason, /no injury rows/);
  assert.ok(packet.summary.missing.includes('nfl_injuries'),
    '"we had no injury report" has to be a fact the evaluation can see, not a silence that reads as "nothing was wrong"');
});

test('rows with no receipt clock are QUARANTINED, not counted as knowable', () => {
  // Real 2025 injury rows carry no modified_at — the audit found exactly this.
  // The data is real; the claim "we had it by Sunday noon" is not evidenced.
  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,NULL)`, 2026, 3, 'GSIS-1', 'ATL', 'A Player', 'WR', 'Questionable');
  const packet = freezeT60Packet(GAME);
  const injuries = sourceIn(packet, 'nfl_injuries');
  assert.equal(injuries.claim, 'availability_unknown');
  assert.equal(injuries.rows, 0, 'nothing was RECEIVED by the cutoff');
  assert.equal(injuries.rows_now, 1, 'but the row is still reported — quarantine is not deletion');
  assert.match(injuries.reason, /quarantined/);
  assert.ok(!packet.summary.eligible.includes('nfl_injuries'));
  assert.ok(packet.summary.quarantined.includes('nfl_injuries'));
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
  // An injury designation stamped after the cutoff. This is the most
  // realistic look-ahead in the whole system: the row is genuine, it is
  // about the right game, and it simply was not known yet.
  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,?)`, 2031, 5, 'GSIS-LATE', 'ATL', 'Late Scratch', 'QB', 'Out',
    '2026-09-20T16:30:00Z');
  const packet = freezeT60Packet({ ...GAME, season: 2031, week: 5 });
  const injuries = sourceIn(packet, 'nfl_injuries');

  assert.equal(injuries.claim, 'late_arrival_excluded');
  assert.equal(injuries.rows, 0, 'nothing was knowable');
  assert.equal(injuries.rows_now, 1, 'the row exists and is disclosed');
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
