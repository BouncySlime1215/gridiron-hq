/**
 * Backfill adapters: copy the existing streams into `engine_events`.
 *
 * Each adapter reads ONE existing table (whose writer is unchanged) and maps each
 * row to one event with a deterministic source_key, so a re-run appends nothing
 * (events.js ON CONFLICT (source, source_key) DO NOTHING). When a source row changes
 * state (a transaction's status, a new lineup snapshot, a re-captured line), its key
 * changes too and the new state is appended: history, never an overwrite.
 *
 * as_of is when the fact was true or known, never later information:
 *   transactions  processed_at, else proposed_at, else first_seen_at; PENDING rows use
 *                 proposed_at (their processed_at is the scheduled run, in the future)
 *   lineups       changed_at (actual/projected points are NOT copied: a lineup event
 *                 must not carry the game result)
 *   news          published_at, else ingested_at, else created_at, else date
 *   game lines    fetched_at (scores and closing lines are NOT copied)
 *   injuries      modified_at
 *   trades        proposed_at (else created_at) for the proposal, resolved_at for the result
 *   chat signals  computed_at; source='chat' rows of manager_signals only: counts and
 *                 rates per fantasy team, no names, no message text (the private chat
 *                 DB is never opened here)
 * A row with no usable timestamp is counted in `no_timestamp` and skipped, never
 * given a guessed time.
 *
 * Run off-server by scripts/engine-backfill.mjs. Never from the web server process.
 */
import { db as appDb } from '../../db/index.js';
import { appendEvents, normalizeAsOf } from './events.js';
import { writeState } from './state.js';

const CHUNK = 2000;

const parse = (s, fallback) => {
  if (s == null || s === '') return fallback;
  return JSON.parse(s);
};
const firstTime = (...vals) => vals.find(v => v != null && v !== '') ?? null;

function playerIndex(database, column) {
  const cols = database.prepare('PRAGMA table_info(players)').all().map(c => c.name);
  if (!cols.includes(column)) return new Map();
  return new Map(database.prepare(`SELECT id, ${column} AS k FROM players WHERE ${column} IS NOT NULL`).all()
    .map(r => [String(r.k), Number(r.id)]));
}

/** One adapter per stream. `rows(database, table)` yields source rows; `map(row, ctx)` returns events. */
export const ADAPTERS = Object.freeze([
  {
    stream: 'transactions', table: 'league_transactions_raw',
    sql: t => `SELECT league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id,
                 scoring_period, bid_amount, is_pending, items_json, first_seen_at FROM ${t}`,
    context: database => ({ byEspn: playerIndex(database, 'espn_id') }),
    map: (r, { byEspn }) => {
      const items = (parse(r.items_json, []) ?? []).map(i => ({
        type: i.type ?? null, espn_player_id: i.playerId ?? null,
        player_id: i.playerId == null ? null : byEspn.get(String(i.playerId)) ?? null,
        from_team_id: i.fromTeamId ?? null, to_team_id: i.toTeamId ?? null,
      }));
      const players = [...new Set(items.map(i => i.player_id).filter(p => p != null))];
      return [{
        // PENDING: processed_at is ESPN's SCHEDULED run, in the row's own future; what is
        // known now is the proposal. Every other status was processed at processed_at.
        event_type: 'espn.transaction',
        as_of: r.status === 'PENDING' ? firstTime(r.proposed_at, r.first_seen_at)
          : firstTime(r.processed_at, r.proposed_at, r.first_seen_at),
        league_id: r.league_id, team_id: r.team_id, player_id: players.length === 1 ? players[0] : null,
        source_key: `${r.league_id}:${r.season}:${r.tx_id}:${r.status ?? ''}`,
        payload: { season: r.season, tx_id: r.tx_id, type: r.type, status: r.status, execution_type: r.execution_type,
          scoring_period: r.scoring_period, bid_amount: r.bid_amount, is_pending: r.is_pending, items },
      }];
    },
  },
  {
    stream: 'lineups', table: 'league_roster_snapshots',
    sql: t => `SELECT league_id, season, scoring_period_id, team_id, espn_player_id, player_id, lineup_slot_id,
                 lineup_slot, is_starter, on_roster, injury_status, lineup_locked, source, changed_at FROM ${t}`,
    map: r => [{
      event_type: 'league.lineup', as_of: r.changed_at, league_id: r.league_id, team_id: r.team_id,
      player_id: r.player_id,
      source_key: `${r.league_id}:${r.season}:${r.scoring_period_id}:${r.team_id}:${r.espn_player_id}:${r.changed_at}`,
      payload: { season: r.season, scoring_period_id: r.scoring_period_id, espn_player_id: r.espn_player_id,
        lineup_slot_id: r.lineup_slot_id, lineup_slot: r.lineup_slot, is_starter: r.is_starter, on_roster: r.on_roster,
        injury_status: r.injury_status, lineup_locked: r.lineup_locked, snapshot: r.source },
    }],
  },
  {
    stream: 'news', table: 'news_items',
    sql: t => `SELECT id, date, team_id, headline, importance, source, published_at, ingested_at, created_at,
                 transaction_type, entities_json FROM ${t}`,
    map: r => {
      const players = [...new Set((parse(r.entities_json, {})?.players ?? []).map(p => p.id).filter(Number.isInteger))];
      return [{
        event_type: 'news.item', as_of: firstTime(r.published_at, r.ingested_at, r.created_at, r.date),
        player_id: players.length === 1 ? players[0] : null, source_key: String(r.id),
        payload: { news_id: r.id, headline: r.headline, importance: r.importance, news_source: r.source,
          transaction_type: r.transaction_type, nfl_team_id: r.team_id, player_ids: players },
      }];
    },
  },
  {
    stream: 'game_lines', table: 'game_lines',
    sql: t => `SELECT season, week, team, opponent, home, spread, total, implied_points, moneyline, open_spread,
                 open_total, source, fetched_at FROM ${t}`,
    map: r => [{
      event_type: 'market.game_line', as_of: r.fetched_at,
      source_key: `${r.season}:${r.week}:${r.team}:${r.fetched_at}`,
      payload: { season: r.season, week: r.week, team: r.team, opponent: r.opponent, home: r.home, spread: r.spread,
        total: r.total, implied_points: r.implied_points, moneyline: r.moneyline, open_spread: r.open_spread,
        open_total: r.open_total, line_source: r.source },
    }],
  },
  {
    stream: 'injuries', table: 'nfl_injuries',
    sql: t => `SELECT season, week, gsis_id, team, position, report_status, practice_status, injury, modified_at FROM ${t}`,
    context: database => ({ byGsis: playerIndex(database, 'gsis_id') }),
    map: (r, { byGsis }) => [{
      event_type: 'nfl.injury', as_of: r.modified_at, player_id: byGsis.get(String(r.gsis_id)) ?? null,
      source_key: `${r.season}:${r.week}:${r.gsis_id}:${r.modified_at}`,
      payload: { season: r.season, week: r.week, gsis_id: r.gsis_id, nfl_team: r.team, position: r.position,
        report_status: r.report_status, practice_status: r.practice_status, injury: r.injury },
    }],
  },
  {
    stream: 'trade_outcomes', table: 'trade_outcomes',
    sql: t => `SELECT id, league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
                 proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
                 status, not_proposed_reason, espn_tx_id, resolved_at, created_at FROM ${t}`,
    map: r => {
      const considered = r.status === 'not_proposed';
      const out = [{
        event_type: considered ? 'trade.considered' : 'trade.proposed', as_of: firstTime(r.proposed_at, r.created_at),
        league_id: r.league_id, team_id: r.proposer_team_id, source_key: `${r.id}:${considered ? 'considered' : 'proposed'}`,
        payload: { trade_outcome_id: r.id, season: r.season, ledger_source: r.source,
          counterparty_team_id: r.counterparty_team_id, give: parse(r.give_json, null), get: parse(r.get_json, null),
          model_p_accept: r.model_p_accept, model_p_accept_low: r.model_p_accept_low,
          model_p_accept_high: r.model_p_accept_high, model_basis: r.model_basis, model_version: r.model_version,
          not_proposed_reason: r.not_proposed_reason },
      }];
      if (!considered && r.status !== 'proposed' && r.resolved_at) {
        out.push({
          event_type: 'trade.resolved', as_of: r.resolved_at, league_id: r.league_id, team_id: r.proposer_team_id,
          source_key: `${r.id}:${r.status}`,
          payload: { trade_outcome_id: r.id, status: r.status, espn_tx_id: r.espn_tx_id,
            counterparty_team_id: r.counterparty_team_id },
        });
      }
      return out;
    },
  },
  {
    stream: 'chat_signals', table: 'manager_signals',
    sql: t => `SELECT league_id, roster_id, metric, value, n, computed_at FROM ${t} WHERE source = 'chat'`,
    map: r => [{
      event_type: 'manager.chat_signal', as_of: r.computed_at, league_id: r.league_id, team_id: r.roster_id,
      source_key: `${r.league_id}:${r.roster_id}:${r.metric}:${r.computed_at}`,
      payload: { metric: r.metric, value: r.value, n: r.n },
    }],
  },
]);

const tableExists = (database, t) =>
  !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/**
 * Backfill one stream. `table` overrides the adapter's table (tests use it to show
 * an absent table). Returns counts; an absent table is `table_state: 'table_absent'`
 * with null counts, never zero.
 */
export function backfillStream(stream, { database = appDb, table, dispatch = true } = {}) {
  const adapter = ADAPTERS.find(a => a.stream === stream);
  if (!adapter) throw new Error(`no backfill adapter for stream ${stream}`);
  const t = table ?? adapter.table;
  if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`bad table name ${t}`);
  const base = { stream, table: t, source: adapter.table };
  if (!tableExists(database, t)) {
    return { ...base, table_state: 'table_absent', source_rows: null, inserted: null, skipped: null, no_timestamp: null };
  }
  const ctx = adapter.context ? adapter.context(database) : {};
  let sourceRows = 0; let inserted = 0; let skipped = 0; let noTimestamp = 0;
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const r = appendEvents(batch, { database, dispatch });
    inserted += r.inserted; skipped += r.skipped; batch = [];
  };
  // .all() rather than .iterate(): appendEvents writes to the same connection, and a
  // write under an open read cursor on that connection is not safe to rely on.
  for (const r of database.prepare(adapter.sql(t)).all()) {
    sourceRows += 1;
    for (const ev of adapter.map(r, ctx)) {
      if (ev.as_of == null || ev.as_of === '') { noTimestamp += 1; continue; }
      batch.push({ ...ev, source: adapter.table });
      if (batch.length >= CHUNK) flush();
    }
  }
  flush();
  return { ...base, table_state: 'present', source_rows: sourceRows, inserted, skipped, no_timestamp: noTimestamp };
}

/**
 * Backfill every stream, then record the spine's own state row `engine.ingest`
 * (entity engine/events): per stream, events in the log as of now and the highest
 * event id. The reason chain has one contribution per stream (what this run added).
 */
export function backfillAll({ database = appDb, dispatch = true, now = new Date() } = {}) {
  const streams = ADAPTERS.map(a => backfillStream(a.stream, { database, dispatch }));
  const asOf = normalizeAsOf(now);
  const summary = {};
  const contributions = [];
  for (const s of streams) {
    const agg = database.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m FROM engine_events WHERE source = ? AND as_of <= ?`)
      .get(s.source, asOf);
    summary[s.stream] = { table: s.table, table_state: s.table_state, events: Number(agg.n), max_event_id: agg.m == null ? null : Number(agg.m) };
    contributions.push({ source: s.source, event_ids: [], delta: s.inserted,
      text: s.table_state === 'table_absent'
        ? `${s.table} does not exist on this database`
        : `${s.inserted} new events this run from ${s.source_rows} rows; ${agg.n} in the log` });
  }
  const written = writeState({ entityType: 'engine', entityId: 'events', field: 'engine.ingest', value: { streams: summary },
    asOf, producer: 'engine-backfill', producerVersion: '1', eventIds: [], reasonChain: { contributions } }, database);
  return { as_of: asOf, streams, state: written };
}
