/**
 * The T−60 evidence packet (Codex plan sections 6.1–6.3).
 *
 * "Collect ahead of T−60 and freeze records actually received by cutoff.
 *  Record computation start/end and forecast emission separately; never
 *  backdate a late capture or fill its missing cutoff packet from later
 *  arrivals. Record a missed capture as a missing prospective observation."
 *
 * The distinction this module exists to enforce, and the reason it is
 * separate from every other data accessor in the codebase: there are three
 * different clocks, and treating any two of them as one is how a historical
 * replay quietly becomes a claim about what was knowable.
 *
 *   EFFECTIVE   when the fact became true in the world (a game was played,
 *               an injury happened).
 *   PUBLISHED   when a source first made it available.
 *   RECEIVED    when THIS system actually recorded it.
 *
 * A prospective decision may use only what was RECEIVED by its cutoff. A
 * labeled historical replay may use what was PUBLISHED by the simulated
 * cutoff, if that availability is independently evidenced — a different and
 * weaker claim, which is why the packet says which one it is rather than
 * leaving a reader to assume.
 *
 * MISSING IS A RECORDED OBSERVATION, NOT AN ABSENCE. A source that had
 * nothing by the cutoff produces a `missing` entry with a reason. That is
 * what makes "we had no injury report for this game" a fact the evaluation
 * can see, instead of a silence indistinguishable from "the report said
 * nothing was wrong."
 *
 * And a row that exists but arrived LATE is neither. Section 6.1 asks to
 * "distinguish historical provider snapshots, retrospectively reconstructed
 * records, assumed availability, and real prospective observations" — four
 * states this codebase previously collapsed into "the row is there." Every
 * pre-2026 weather row in this database was fetched on 2026-09-02, years
 * after the games it describes; counting it as knowable at a 2023 kickoff
 * would be the single largest look-ahead available here.
 */
import crypto from 'node:crypto';
import { rows } from '../db/index.js';
import { decisionCutoff, T60_PROTOCOL_VERSION } from './nfl-t60-protocol.js';
import { teamCodeFor } from './team-codes.js';
import { canonicalize } from '../betting/nfl/contracts/forecast-packet.js';

export const PACKET_VERSION = 'nfl-t60-packet-v3-c11';

/**
 * The only contract this packet freezes evidence for. The active mandate is
 * ordinary full-game pregame spreads; a first-half quote and a total are
 * different contracts that settle differently, and letting either into a
 * full-game spread's evidence is the "blending unlike contracts" the contract
 * key module already refuses everywhere else.
 */
const PACKET_MARKET = 'spreads';
const PACKET_PERIOD = 'full_game';

/**
 * How a value's availability is established. A prospective packet may only
 * rest on `received_by_cutoff`; every other kind exists so that a weaker or
 * disqualifying claim is impossible to mistake for one.
 */
export const AVAILABILITY_CLAIMS = Object.freeze([
  /** This system recorded it before the cutoff. The only claim a real prospective decision may rest on. */
  'received_by_cutoff',
  /** A source published it before the cutoff and that is independently evidenced. Historical replay only. */
  'published_by_cutoff_evidenced',
  /** The rows exist, but every one reached this system AFTER the cutoff. Never eligible, in any mode. */
  'late_arrival_excluded',
  /** Present in the database, but with no trustworthy receipt or publication clock. Quarantined. */
  'availability_unknown',
  /** Describes the outcome rather than the forecast. Never eligible in a pregame packet, in any mode. */
  'oracle_excluded',
  /** Nothing was available at all. A recorded observation in its own right. */
  'missing'
]);

/** The claims a packet may actually USE, by mode. Everything else is retained but ineligible. */
const ELIGIBLE_BY_MODE = Object.freeze({
  prospective: ['received_by_cutoff'],
  historical: ['received_by_cutoff', 'published_by_cutoff_evidenced']
});

const beforeOrAt = (when, cutoffAt) =>
  when != null && new Date(when).getTime() <= new Date(cutoffAt).getTime();

/**
 * One source's contribution, with all three clocks preserved rather than
 * collapsed.
 *
 * `rowsByCutoff` counts what had actually arrived; `rowsTotal` counts what
 * exists now. The gap between them is the late-arrival case, and reporting
 * that as `missing` would hide a real look-ahead risk behind a word that
 * sounds like an ordinary data gap.
 */
function sourceEntry({ source, rowsByCutoff = 0, rowsTotal = 0, effectiveAt = null, publishedAt = null,
  receivedAt = null, cutoffAt, missingReason = null, oracle = false, note = null, values = null }) {
  const base = { source, rows: rowsByCutoff, rows_now: rowsTotal,
    effective_at: effectiveAt ?? null, published_at: publishedAt ?? null, received_at: receivedAt ?? null,
    note: note ?? null,
    // The actual values this source contributed, where the source can supply
    // them. A count and a timestamp are a health summary; a forecast cannot be
    // reconstructed from them, which is the whole of Codex correction C11.
    values: values ?? null };

  if (oracle) {
    return { ...base, claim: 'oracle_excluded', rows: 0,
      reason: 'this source records what actually happened, not what was forecast. It can never enter a pregame ' +
        'packet in any mode; a labeled oracle diagnostic is the only legitimate use.' };
  }
  if (!rowsTotal) {
    return { ...base, claim: 'missing', rows: 0,
      reason: missingReason ?? 'no rows for this source at or before the cutoff' };
  }
  if (beforeOrAt(receivedAt, cutoffAt)) return { ...base, claim: 'received_by_cutoff', reason: null };
  if (beforeOrAt(publishedAt, cutoffAt)) return { ...base, claim: 'published_by_cutoff_evidenced', reason: null };
  if (receivedAt != null) {
    return { ...base, claim: 'late_arrival_excluded', rows: 0,
      reason: `every row for this source reached this system at ${receivedAt}, after the ${cutoffAt} cutoff. ` +
        'Backfilling an old fact today is not discovering when it first became known.' };
  }
  return { ...base, claim: 'availability_unknown',
    reason: 'rows exist but carry no receipt or evidenced publication clock at or before the cutoff — ' +
      'quarantined rather than counted as knowable' };
}

/**
 * Freeze what was actually knowable about one game at its T−60 cutoff.
 *
 * `mode` is the claim being made, and it changes what is allowed in:
 *   'prospective' — only `received_by_cutoff` entries are eligible. Anything
 *                   weaker is retained in the packet but marked ineligible,
 *                   so the packet still shows what existed while refusing to
 *                   let it into the decision.
 *   'historical'  — `published_by_cutoff_evidenced` is additionally eligible,
 *                   and the packet says so in its own `claim` field. This is
 *                   the labeled hypothetical, never a prospective record.
 *
 * Neither mode can admit an oracle or a late arrival. Section 6.3's
 * acceptance requires that an attempt to inject tomorrow's injury status,
 * postgame weather, next-week ranks or a revised record is "rejected or
 * quarantined with an explicit reason" — that is a property of the claim
 * taxonomy above, not of a caller remembering to filter.
 */
/*
 * TODO (audit-consolidation stage 1, Giant Plan section 8.10/8.1): the task
 * for this stage asked for freezeT60Packet to "emit the full contract shape
 * forecast-packet.js already validates" and to call validateForecastPacket
 * before sealing. That is NOT done here, deliberately, and the reason is an
 * architecture mismatch this stage found rather than one it can safely paper
 * over:
 *
 *   forecast-packet.js's CONTRACT_GROUPS describe a single-market DECISION
 *   packet: one chosen quote_id/side/handicap (market), one resolved
 *   forecast_identity and calibration_id (forecast), and a qualification_state
 *   already reached (decision). Every one of those is downstream of a policy
 *   run that has not happened yet at the moment this function executes: T-60
 *   evidence-freeze runs BEFORE a forecast is computed or a decision is made
 *   (see t60-runner.js's captureDueObservations, which freezes a packet and
 *   only later — a separate, not-yet-written step — would hand it to a
 *   policy). This packet also legitimately holds MULTIPLE sources with
 *   independent claims (quote_tape, injuries, weather, news, team features),
 *   which the single-market contract has no group for at all.
 *
 *   Populating market/forecast/decision here would mean either (a) guessing
 *   which of possibly several received quotes is "the" market entry before
 *   any policy has chosen one, or (b) writing placeholder/null values into a
 *   contract whose validator was written to CATCH exactly that kind of
 *   unearned claim (see forecast-packet.js's own docstring: "validation
 *   fails, it does not repair... a packet missing its event identity is not a
 *   packet with a gap in it"). Either one is the fabrication this whole module
 *   exists to refuse — the same failure mode as the four injection tests in
 *   nfl-t60-packet.test.js, just moved one level up.
 *
 *   Forcing this shape now would also break every existing consumer of the
 *   evidence shape (t60-runner.js's captureDueObservations, the read-only
 *   GET /t60/packet route in nfl-betting.js, and the whole of
 *   nfl-t60-packet.test.js, which pins packet.sources/packet.summary/
 *   packet.claim as the contract for THIS packet).
 *
 * What IS done in this stage, as the safe subset: the packet_json column
 * (migration 036) is now populated with this packet's actual body (see
 * t60-runner.js), and re-freezing identical inputs now hashes identically —
 * see t60PacketHash() below, which is the canonical hash this stage adds in
 * place of t60-runner.js's old ad-hoc `JSON.stringify(packet)` hash (unsorted
 * keys, and it hashed the wall-clock computation timestamps, so the same
 * evidence frozen twice at two different real times used to hash differently).
 *
 * The real fix for the full request — a genuine DECISION packet that
 * satisfies forecast-packet.js's contract by combining a frozen T-60 evidence
 * packet like this one with the policy's actual chosen market/forecast/
 * decision once that policy run exists — belongs in whatever stage wires the
 * T-60 runner to the decision/policy layer, where that data is first known.
 */
export function freezeT60Packet({ season, week, home, away, kickoff, scheduleVersion = null,
  mode = 'prospective', computationStartedAt = null, computationFinishedAt = null } = {}) {
  const cutoff = decisionCutoff(kickoff, { scheduleVersion });
  if (!cutoff) return { error: 'unresolvable kickoff — no cutoff, and therefore no packet' };
  const cutoffAt = cutoff.cutoff_at;
  const entries = [];

  // Quote tape: the one source here with a genuine per-row receipt clock,
  // which is exactly why it is the only one that can support a real
  // prospective claim today.
  // The kickoff is matched as a one-second RANGE rather than with
  // `julianday(commence_time) = julianday(?)`. Wrapping the column in a
  // function makes every index unusable, and this table holds 1.3M rows -- a
  // full scan per game turns a season manifest into an hours-long job. The
  // range also absorbs the two ISO spellings actually present in the column
  // ("...:00Z" and "...:00.000Z"), which both sort inside it.
  const kickoffAt = new Date(kickoff).getTime();
  const kickoffFrom = new Date(kickoffAt).toISOString();
  const kickoffTo = new Date(kickoffAt + 1000).toISOString();

  // Codex correction C11, three separate defects in one query.
  //
  // (1) THE GAME. The predicate used to be the kickoff range alone. A kickoff
  //     instant is not an event identity: the NFL runs up to nine games at
  //     1:00pm Eastern, and every one of them matched. The audit's fixture
  //     counted another game's quote as CAR-CHI's evidence. Migration 029 made
  //     that lookup fast; speed was never the problem with it.
  //
  // (2) THE PERIOD AND MARKET. Omitted entirely, so a first-half spread or a
  //     total could qualify a full-game spread forecast. Today's ingestion
  //     writes 'full_game' for everything, which means this has been latent
  //     rather than harmless -- the first first-half feed would have silently
  //     started poisoning packets.
  //
  // (3) THE CLOCK. `b.requested_at` is stamped BEFORE the provider request
  //     goes out. Since requested_at <= received_at, using it made every quote
  //     look like it arrived earlier than it did, and a quote requested before
  //     the cutoff but received after it counted as available AT the cutoff.
  //
  // The kickoff range still leads, because it is what the index can use and it
  // narrows 1.3M rows to a handful; the canonical event is then resolved in JS,
  // because the tape stores full team names while the schedule stores
  // abbreviations and only `teamCodeFor` knows how to reconcile the two.
  const kickoffWindow = rows(`SELECT q.quote_id, q.home_team, q.away_team, q.bookmaker_key,
      q.market, q.period, q.side_key, q.line, q.american_price, q.snapshot_at, q.book_updated_at,
      b.requested_at, b.received_at, b.receipt_clock_source
    FROM nfl_quote_tape q JOIN nfl_quote_batches b ON b.batch_id = q.batch_id
    WHERE q.commence_time >= ? AND q.commence_time < ?
      AND q.market = ? AND q.period = ?`,
  kickoffFrom, kickoffTo, PACKET_MARKET, PACKET_PERIOD);

  // Fail closed on an unresolvable team. `teamCodeFor` returns null for
  // anything it cannot map, and null === null would make an unidentifiable
  // game match EVERY row in the kickoff window -- reinstating the cross-game
  // bug in a form that looks like it is scoping. An event that cannot be named
  // canonically has no packet.
  const homeCode = teamCodeFor(home), awayCode = teamCodeFor(away);
  if (!homeCode || !awayCode) {
    return { error: `unresolvable canonical event — home ${JSON.stringify(home)} resolved to `
      + `${JSON.stringify(homeCode)}, away ${JSON.stringify(away)} to ${JSON.stringify(awayCode)}. `
      + 'A packet cannot be scoped to a game this system cannot name.' };
  }
  const scopedQuotes = kickoffWindow.filter(q => {
    const qHome = teamCodeFor(q.home_team), qAway = teamCodeFor(q.away_team);
    return qHome != null && qAway != null && qHome === homeCode && qAway === awayCode;
  });

  // Only a real observed response-completion clock can support a prospective
  // claim. A batch carrying `legacy_request_time_only` knows when it ASKED,
  // not when it was answered, and the difference always errs toward admitting
  // evidence too early -- so such rows are counted separately and never
  // granted `received_by_cutoff`.
  const realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion');
  const legacyClock = scopedQuotes.filter(q => q.receipt_clock_source !== 'response_completion');
  const receivedByCutoff = realClock.filter(q => beforeOrAt(q.received_at, cutoffAt));
  const latestReceipt = receivedByCutoff.reduce(
    (max, q) => (max == null || q.received_at > max ? q.received_at : max), null);
  const latestSnapshot = receivedByCutoff.reduce(
    (max, q) => (max == null || q.snapshot_at > max ? q.snapshot_at : max), null);

  entries.push(sourceEntry({ source: 'nfl_quote_tape',
    rowsByCutoff: receivedByCutoff.length, rowsTotal: scopedQuotes.length,
    effectiveAt: latestSnapshot,
    receivedAt: latestReceipt
      ?? (realClock.length
        ? realClock.reduce((max, q) => (max == null || q.received_at > max ? q.received_at : max), null)
        : null),
    cutoffAt,
    missingReason: 'no quote was ever captured for this game — a missed capture, recorded as a missing ' +
      'prospective observation rather than passed over in silence',
    note: legacyClock.length
      ? `${legacyClock.length} of ${scopedQuotes.length} quote rows for this game carry only a request `
        + 'time, not an observed receipt. They are retained and reported, but cannot support a prospective '
        + 'claim: a request time is a lower bound on receipt, and treating it as one admits prices the '
        + 'decision did not yet hold.'
      : null,
    // The actual rows, not a count. C11: "It does not persist the actual rows,
    // values, identities and fitted artifacts consumed by a forecast."
    values: receivedByCutoff.map(q => ({ quote_id: q.quote_id, bookmaker_key: q.bookmaker_key,
      market: q.market, period: q.period, side_key: q.side_key, line: q.line,
      american_price: q.american_price, snapshot_at: q.snapshot_at,
      book_updated_at: q.book_updated_at, received_at: q.received_at }))
  }));

  // Injuries. Giant Plan 8.14: `nfl_injuries.modified_at` is the SOURCE's own
  // claim about when a report changed, not this system's receipt clock --
  // treating it as `receivedAt` (the previous version of this block did) is
  // the exact "published_at masquerading as observed_at" leak nfl-bitemporal.js
  // exists to close, and it is why the audit could find 2025 rows with no
  // clock at all: `nfl_injuries` itself has never recorded when THIS system
  // actually saw a value, only what the source last said. nfl-advanced.js's
  // syncInjuries now appends every changed report to `nfl_feature_revisions`
  // with a real `observed_at`, so this reads that store instead. A revision's
  // `observed_at` is always populated -- this machine chose it -- so the
  // "quarantined, no clock at all" case that motivated this comment before
  // cannot recur going forward; what remains is the ordinary as-of question,
  // "had this system recorded it by the cutoff."
  //
  // KNOWN GAP: this only sees rows synced under the wiring above. Historical
  // `nfl_injuries` rows written before it exist have no corresponding
  // revision and are invisible here until the affected weeks are re-synced --
  // see PIPELINE_REPORT.md.
  const injurySuffix = `:${season}:${week}`;
  const injuries = rows(`SELECT
      SUM(CASE WHEN observed_at <= ? THEN 1 ELSE 0 END) by_cutoff,
      COUNT(*) total,
      MAX(CASE WHEN observed_at <= ? THEN observed_at END) received_by_cutoff,
      MAX(observed_at) received_ever
    FROM nfl_feature_revisions WHERE feature = 'injury_report' AND entity LIKE '%' || ?`,
  cutoffAt, cutoffAt, injurySuffix)[0];
  entries.push(sourceEntry({ source: 'nfl_injuries',
    rowsByCutoff: injuries?.by_cutoff ?? 0, rowsTotal: injuries?.total ?? 0,
    receivedAt: injuries?.received_by_cutoff ?? injuries?.received_ever ?? null, cutoffAt,
    missingReason: 'no injury revisions recorded for this season and week' }));

  // Typed news events. `first_seen_time` is an extraction timestamp — a
  // receipt clock for THIS system, though not the article's publication time.
  // Both are carried so neither is mistaken for the other.
  const news = rows(`SELECT
      SUM(CASE WHEN first_seen_time <= ? THEN 1 ELSE 0 END) by_cutoff,
      COUNT(*) total,
      MAX(CASE WHEN first_seen_time <= ? THEN first_seen_time END) received_by_cutoff,
      MAX(CASE WHEN first_seen_time <= ? THEN published_at END) published_by_cutoff,
      MAX(first_seen_time) received_ever
    FROM nfl_news_events`, cutoffAt, cutoffAt, cutoffAt)[0];
  entries.push(sourceEntry({ source: 'nfl_news_events',
    rowsByCutoff: news?.by_cutoff ?? 0, rowsTotal: news?.total ?? 0,
    publishedAt: news?.published_by_cutoff ?? null,
    receivedAt: news?.received_by_cutoff ?? news?.received_ever ?? null, cutoffAt,
    missingReason: 'no typed news event had been extracted by this cutoff' }));

  // Weather forecast archive. Section 6.2: "Select the latest forecast
  // actually available by the decision cutoff." In this database every
  // pre-2026 row was fetched on 2026-09-02, so for a historical game this
  // correctly reports late_arrival_excluded rather than handing a 2023
  // decision a forecast retrieved in 2026.
  const forecast = rows(`SELECT
      SUM(CASE WHEN fetched_at <= ? THEN 1 ELSE 0 END) by_cutoff,
      COUNT(*) total,
      MAX(CASE WHEN fetched_at <= ? THEN fetched_at END) received_by_cutoff,
      MAX(fetched_at) received_ever
    FROM nfl_game_weather_forecast_history
    WHERE season = ? AND week = ? AND home = ?`, cutoffAt, cutoffAt, season, week, home)[0];
  entries.push(sourceEntry({ source: 'nfl_game_weather_forecast_history',
    rowsByCutoff: forecast?.by_cutoff ?? 0, rowsTotal: forecast?.total ?? 0,
    receivedAt: forecast?.received_by_cutoff ?? forecast?.received_ever ?? null, cutoffAt,
    missingReason: 'no archived forecast for this game',
    note: 'a retrospectively reconstructed provider archive. Eligible for a labeled historical replay only ' +
      'where its receipt clock actually precedes the cutoff — it never becomes real prospective capture.' }));

  // Realized kickoff weather. Section 6.2: "Remove realized kickoff weather
  // from all pregame actionable experiments... Keep it only in a labeled
  // oracle diagnostic." Listed rather than omitted, so the packet shows the
  // source was considered and refused.
  const realized = rows('SELECT COUNT(*) total FROM nfl_game_weather WHERE season=? AND week=? AND home=?',
    season, week, home)[0];
  entries.push(sourceEntry({ source: 'nfl_game_weather', oracle: true,
    rowsTotal: realized?.total ?? 0, cutoffAt }));

  // Team-week features (play-by-play derived), rebuilt in bulk from a
  // full-season file with no per-row receipt clock. The data is real; the
  // claim "we had it by Sunday noon" is not evidenced, so it quarantines.
  const features = rows('SELECT COUNT(*) total FROM nfl_team_week_features WHERE season=? AND week < ?',
    season, week)[0];
  entries.push(sourceEntry({ source: 'nfl_team_week_features',
    rowsByCutoff: features?.total ?? 0, rowsTotal: features?.total ?? 0, cutoffAt,
    missingReason: 'no prior-week team features for this season',
    note: 'rebuilt in bulk per season; no per-row receipt clock exists to evidence cutoff availability' }));

  const eligibleClaims = ELIGIBLE_BY_MODE[mode] ?? ELIGIBLE_BY_MODE.prospective;
  const by = claim => entries.filter(e => e.claim === claim).map(e => e.source);
  const eligible = entries.filter(e => eligibleClaims.includes(e.claim));

  return {
    packet_version: PACKET_VERSION, protocol_version: T60_PROTOCOL_VERSION,
    season, week, matchup: `${away} at ${home}`,
    kickoff: cutoff.kickoff, cutoff_at: cutoffAt, schedule_version: scheduleVersion,
    mode,
    claim: mode === 'historical'
      ? 'LABELED HISTORICAL REPLAY: may additionally use sources whose publication before the cutoff is ' +
        'independently evidenced. This is not a record of what this system actually held at the time.'
      : 'PROSPECTIVE: only sources this system had actually RECEIVED by the cutoff are eligible.',
    // Computation clocks kept apart from the cutoff, per section 6.3: a
    // forecast emitted after the cutoff may use the frozen packet, but the
    // packet's contents are fixed at the cutoff and are never backfilled from
    // anything that arrived afterward.
    computation_started_at: computationStartedAt,
    computation_finished_at: computationFinishedAt,
    emitted_after_cutoff: computationFinishedAt
      ? new Date(computationFinishedAt).getTime() > new Date(cutoffAt).getTime() : null,
    sources: entries,
    summary: {
      eligible: eligible.map(e => e.source),
      late_arrival_excluded: by('late_arrival_excluded'),
      quarantined: by('availability_unknown'),
      oracle_excluded: by('oracle_excluded'),
      missing: by('missing'),
      eligible_count: eligible.length, total_sources: entries.length
    }
  };
}

/**
 * The packet's content address.
 *
 * Reuses forecast-packet.js's `canonicalize` (sorted keys recursively) so
 * this codebase has one canonicalization authority rather than two, even
 * though this packet does not yet meet that module's CONTRACT_GROUPS shape
 * (see the TODO above freezeT60Packet).
 *
 * Deliberately EXCLUDES the wall-clock computation fields —
 * `computation_started_at`, `computation_finished_at`, `emitted_after_cutoff`
 * — which record WHEN this packet was assembled, not what evidence it
 * contains. Without this exclusion, re-freezing the identical evidence a
 * second time (a retry, or a second caller asking about the same game) always
 * produced a different hash purely because real time had moved on, which
 * defeats the one thing a content hash is for: recognizing that nothing
 * actually changed. This was t60-runner.js's `packetHash`, replaced by this
 * function as part of this stage.
 */
export function t60PacketHash(packet) {
  const { computation_started_at: _started, computation_finished_at: _finished,
    emitted_after_cutoff: _emitted, ...content } = packet;
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

/**
 * The decision-time dataset manifest (Codex plan section 13, item 4:
 * "sources, availability rules, revision handling, coverage, quarantines,
 * code/data hashes, and representative inspected packets").
 *
 * This freezes a packet for every scheduled game in the requested seasons and
 * aggregates what the claims actually came out as. It is the honest answer to
 * "what could this system have known at decision time," and for the historical
 * seasons the answer is largely "nothing, and here is exactly why."
 *
 * Kickoff is reconstructed from `game_lines.gameday`/`gametime`, which are
 * stored in US Eastern local time. The conversion below uses a fixed −04:00
 * offset; a game in late season under standard time is therefore off by one
 * hour. That is disclosed rather than hidden because it does not affect any
 * conclusion here — the receipt gaps being measured are years wide, not hours
 * — but it would matter for a real prospective cutoff and is flagged in the
 * manifest's own `caveats`.
 */
export function decisionTimeManifest(seasons = [2021, 2022, 2023, 2024, 2025], { mode = 'prospective' } = {}) {
  const games = rows(`SELECT season, week, team AS home, opponent AS away, gameday, gametime, div_game, rest_days
    FROM game_lines
    WHERE home = 1 AND season IN (${seasons.map(() => '?').join(',')}) AND gameday IS NOT NULL
    ORDER BY season, week, gameday, gametime`, ...seasons);

  const byClaim = new Map();
  const bySource = new Map();
  const perSeason = new Map();
  const packets = [];

  for (const g of games) {
    const kickoff = `${g.gameday}T${g.gametime}:00-04:00`;
    const packet = freezeT60Packet({ season: g.season, week: g.week, home: g.home, away: g.away, kickoff, mode });
    if (packet.error) continue;
    packets.push({ game: g, packet });

    const season = perSeason.get(g.season) ?? { season: g.season, games: 0, any_eligible: 0 };
    season.games++;
    if (packet.summary.eligible_count > 0) season.any_eligible++;
    perSeason.set(g.season, season);

    for (const source of packet.sources) {
      byClaim.set(source.claim, (byClaim.get(source.claim) ?? 0) + 1);
      const entry = bySource.get(source.source) ?? { source: source.source, claims: {} };
      entry.claims[source.claim] = (entry.claims[source.claim] ?? 0) + 1;
      bySource.set(source.source, entry);
    }
  }

  return {
    packet_version: PACKET_VERSION, protocol_version: T60_PROTOCOL_VERSION,
    seasons, mode, games: packets.length,
    availability_rules: {
      prospective: 'only sources this system had actually RECEIVED by the cutoff',
      historical: 'additionally, sources whose publication before the cutoff is independently evidenced',
      never_eligible: ['oracle_excluded (records the outcome, not a forecast)',
        'late_arrival_excluded (every row reached this system after the cutoff)'],
      revision_handling: 'the latest capture RECEIVED BY the cutoff is reported; later revisions are counted in ' +
        'rows_now and excluded from what was knowable'
    },
    coverage: {
      by_claim: Object.fromEntries([...byClaim].sort((a, b) => b[1] - a[1])),
      by_source: [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
      per_season: [...perSeason.values()].sort((a, b) => a.season - b.season)
    },
    caveats: [
      'Kickoff is reconstructed from gameday/gametime at a fixed -04:00 Eastern offset; standard-time games are ' +
        'one hour off. Immaterial to these results (the receipt gaps measured are years wide) and material to a ' +
        'real prospective cutoff.',
      'This manifest describes AVAILABILITY, not quality. A source eligible by cutoff may still be wrong.'
    ],
    packets
  };
}

/**
 * The five representative packets section 6.3's acceptance asks to inspect by
 * hand: "a normal week, a quarterback scratch, a postponed/oddly timed game,
 * a bye return, and an early-season game."
 *
 * Each case is SELECTED FROM REAL SCHEDULE DATA rather than constructed, so
 * the inspection reports what the system actually holds for a real game.
 */
export function representativePackets(season = 2025) {
  const pick = (label, sql, ...params) => {
    const g = rows(sql, ...params)[0];
    if (!g) return { case: label, error: 'no game in this database matches the case' };
    const kickoff = `${g.gameday}T${g.gametime}:00-04:00`;
    return { case: label, game: `${g.away} at ${g.home}`, season: g.season, week: g.week,
      kickoff_local: `${g.gameday} ${g.gametime} ET`,
      packet: freezeT60Packet({ season: g.season, week: g.week, home: g.home, away: g.away, kickoff }) };
  };
  const base = `SELECT season, week, team AS home, opponent AS away, gameday, gametime, rest_days
    FROM game_lines WHERE home = 1 AND season = ? AND gameday IS NOT NULL`;
  return [
    // A midseason Sunday 13:00 game with ordinary rest: the baseline case.
    pick('normal week', `${base} AND week BETWEEN 8 AND 12 AND gametime = '13:00' AND rest_days = 7
      ORDER BY week LIMIT 1`, season),
    // A quarterback scratch is an injury-report fact, so the case is a game
    // whose week has an injury row designating a QB out.
    pick('quarterback scratch', `${base} AND week = (
        SELECT MIN(week) FROM nfl_injuries WHERE season = ? AND position = 'QB'
          AND report_status IN ('Out','Doubtful'))
      ORDER BY week LIMIT 1`, season, season),
    // Oddly timed: anything outside the standard Sunday windows.
    pick('oddly timed game', `${base} AND gametime NOT IN ('13:00','16:05','16:25')
      ORDER BY week LIMIT 1`, season),
    // A bye return shows up as extra rest days.
    pick('bye return', `${base} AND rest_days > 7 ORDER BY week LIMIT 1`, season),
    // Week 1: no prior-week features exist for the season at all.
    pick('early-season game', `${base} AND week = 1 ORDER BY gametime LIMIT 1`, season)
  ];
}
