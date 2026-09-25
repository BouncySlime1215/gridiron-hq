/**
 * HISTORY-INGEST (LIVING-01b re-gate, part 4): do ESPN's past seasons still hold
 * our leagues' transactions, and a flag-off ingest for when they do.
 *
 * Final standings and weekly scores for past seasons are already stored:
 * league-history.js (league_season_teams, league_week_scores) reads them from
 * /leagueHistory on the scheduler's league_history job. Transactions are not.
 * league-history.js note 3 found that X-Fantasy-Filter does not widen
 * mTransactions2's ~3-day window. Two routes it did not try:
 *
 *   period          mTransactions2 asked one scoring period at a time
 *                   (scoringPeriodId=N), the way the espn-api client asks.
 *   communication   the league's activity feed, /communication/ with
 *                   view=kona_league_communication and an ACTIVITY_TRANSACTIONS
 *                   topics filter (limit and sort in the same object, note 3).
 *
 * probeLeagueSeason asks both, read-only, and reports counts and date spans
 * only. "Exists" means rows reach back further than a 3-day window could.
 * ingestLeagueSeason stores the period route's rows, which are
 * league_transactions_raw's own shape, into league_history_transactions
 * (migration 104), and only with GRIDIRON_HISTORY_INGEST=1. Past seasons only:
 * the current season is the forward collector's.
 *
 * No database import: callers pass the handle and the ESPN fetcher, so the
 * cookies stay in the request header and never reach a result or a log.
 */
export const HISTORY_INGEST_ENV = 'GRIDIRON_HISTORY_INGEST';
/** DEFAULT-OFF: exactly `1` turns the ingest on. The probe is read-only and needs no flag. */
export const historyIngestOn = () => process.env[HISTORY_INGEST_ENV] === '1';

export const WINDOW_DAYS = 3;
export const PACE_MS = 900;
export const REGULAR_PERIODS = Object.freeze(Array.from({ length: 18 }, (_, i) => i + 1));
/** espn-api's activity map: 178 FA add, 180 waiver add, 179 / 181 / 239 drop, 244 trade. */
export const MESSAGE_KINDS = Object.freeze({ 178: 'add', 180: 'add', 179: 'drop', 181: 'drop', 239: 'drop', 244: 'trade' });
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const iso = ms => (Number.isFinite(Number(ms)) && ms ? new Date(Number(ms)).toISOString() : null);
const msg = e => String(e?.message ?? e).slice(0, 200);

export function periodUrl(lg, season, period) {
  const q = `view=mTransactions2&scoringPeriodId=${Number(period)}`;
  return season === lg.season
    ? `${BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}?${q}`
    : `${BASE}/leagueHistory/${lg.league_id}?seasonId=${season}&${q}`;
}

export function communicationUrl(lg, season) {
  return `${BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}/communication/?view=kona_league_communication`;
}

export const COMMUNICATION_FILTER = JSON.stringify({
  topics: {
    filterType: { value: ['ACTIVITY_TRANSACTIONS'] }, limit: 1000, limitPerMessageSet: { value: 25 }, offset: 0,
    sortMessageDate: { sortPriority: 1, sortAsc: false }, sortFor: { sortPriority: 2, sortAsc: false },
    filterIncludeMessageTypeIds: { value: Object.keys(MESSAGE_KINDS).map(Number) },
  },
});

const headersFor = (lg, base = {}, extra = {}) => ({ ...base, ...extra, Cookie: `espn_s2=${lg.espn_s2}; SWID=${lg.swid}` });

/** The real fetcher: JSON, null on 404 (the league did not exist that season), throws otherwise. */
export async function espnFetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

/** A period payload's transactions (leagueHistory answers with an array). */
export function transactionsFromPayload(payload) {
  const p = Array.isArray(payload) ? payload[0] : payload;
  return Array.isArray(p?.transactions) ? p.transactions : [];
}

/** The activity feed as moves by team. Message types outside MESSAGE_KINDS are counted, not guessed. */
export function movesFromCommunication(payload) {
  const moves = [];
  let unknown = 0;
  for (const topic of payload?.topics ?? []) {
    for (const m of topic.messages ?? []) {
      const kind = MESSAGE_KINDS[m.messageTypeId];
      if (!kind) { unknown++; continue; }
      // espn-api: a trade is credited to `from`, message 239 to `for`, the rest to `to`
      const team = m.messageTypeId === 244 ? m.from : m.messageTypeId === 239 ? m.for : m.to;
      moves.push({ id: String(m.id), kind, team_id: Number(team), player_id: Number(m.targetId), at: iso(topic.date) });
    }
  }
  return { moves, unknown_types: unknown };
}

const spanOf = dates => {
  const ok = dates.filter(Boolean).sort();
  return ok.length ? { earliest: ok[0], latest: ok[ok.length - 1] } : { earliest: null, latest: null };
};

/**
 * Ask both routes for one league-season. Read-only. Returns counts and date
 * spans; `exists` is true when either route reaches back past a 3-day window,
 * false when both answered with nothing older, and null when a route failed and
 * the other found nothing (could not look is not "no").
 */
export async function probeLeagueSeason({ lg, season, periods = REGULAR_PERIODS, fetchJson = espnFetchJson,
  baseHeaders = {}, paceMs = PACE_MS }) {
  const period = { requests: 0, rows: 0, periods_with_rows: [], errors: 0, earliest: null, latest: null };
  const dates = [];
  for (const p of periods) {
    period.requests++;
    try {
      const tx = transactionsFromPayload(await fetchJson(periodUrl(lg, season, p), headersFor(lg, baseHeaders)));
      if (tx.length) period.periods_with_rows.push(p);
      period.rows += tx.length;
      for (const t of tx) dates.push(iso(t.processDate ?? t.proposedDate));
    } catch (e) {
      period.errors++;
      period.last_error = msg(e);
    }
    await sleep(paceMs);
  }
  Object.assign(period, spanOf(dates));

  const communication = { moves: 0, unknown_types: 0, earliest: null, latest: null, span_days: 0, error: null };
  try {
    const c = movesFromCommunication(await fetchJson(communicationUrl(lg, season),
      headersFor(lg, baseHeaders, { 'X-Fantasy-Filter': COMMUNICATION_FILTER })));
    Object.assign(communication, { moves: c.moves.length, unknown_types: c.unknown_types }, spanOf(c.moves.map(m => m.at)));
  } catch (e) {
    communication.error = msg(e);
  }
  const days = s => (s.earliest && s.latest ? Math.round((Date.parse(s.latest) - Date.parse(s.earliest)) / 86_400_000) : 0);
  communication.span_days = days(communication);
  const reaches = days(period) > WINDOW_DAYS || communication.span_days > WINDOW_DAYS;
  const failed = period.errors > 0 || communication.error != null;
  return {
    league_id: lg.id, season,
    period_route: period,
    communication_route: communication,
    exists: reaches ? true : failed ? null : false,
  };
}

/**
 * Store one PAST league-season's period-route transactions in
 * league_history_transactions. Off unless GRIDIRON_HISTORY_INGEST=1 (then it asks
 * ESPN nothing and writes nothing). Idempotent by (league, season, tx id).
 */
export async function ingestLeagueSeason(database, { lg, season, periods = REGULAR_PERIODS, fetchJson = espnFetchJson,
  baseHeaders = {}, paceMs = PACE_MS, now = new Date() }) {
  if (!historyIngestOn()) return { state: 'off', written: 0, reason: `${HISTORY_INGEST_ENV} is not 1` };
  if (season === lg.season) throw new Error(`season ${season} is the current season; the forward collector owns it`);
  const ins = database.prepare(`INSERT OR IGNORE INTO league_history_transactions
    (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id, member_id,
     related_tx_id, scoring_period, bid_amount, is_pending, items_json, raw_json, source, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'espn_period', ?)`);
  let written = 0, seen = 0;
  for (const p of periods) {
    const tx = transactionsFromPayload(await fetchJson(periodUrl(lg, season, p), headersFor(lg, baseHeaders)));
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const t of tx) {
        if (!t?.id) continue;
        seen++;
        written += Number(ins.run(lg.id, season, String(t.id), t.type ?? null, t.status ?? null, t.executionType ?? null,
          iso(t.proposedDate), iso(t.processDate), t.teamId ?? null, t.memberId ?? null, t.relatedTransactionId ?? null,
          t.scoringPeriodId ?? p, t.bidAmount ?? null, t.isPending ? 1 : 0, JSON.stringify(t.items ?? []), JSON.stringify(t),
          now.toISOString()).changes);
      }
      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw e;
    }
    await sleep(paceMs);
  }
  return { state: 'ran', seen, written };
}
