/**
 * Adapters: copy the existing streams into `engine_events` (ENGINE-ARCHITECTURE.md §3.1).
 *
 * Each adapter reads ONE existing table (whose writer is unchanged) and maps each row to
 * events with a `natural_key` (the row's identity in its source). appendEvents appends an
 * event only when its payload differs from the latest event with the same key
 * (compare-latest), so a re-run appends nothing, a real change appends one event, and
 * A -> B -> A appends three. Payloads leave out capture stamps (fetched_at, changed_at),
 * so a re-capture of the same facts is not a change.
 *
 * as_of (valid time) and as_of_quality, per source:
 *   transactions  processed_at (exact) when present; a PENDING row or a TRADE_PROPOSAL
 *                 without it: proposed_at (exact; a PENDING row's processed_at is ESPN's
 *                 scheduled run, in its own future); every other status row without
 *                 processed_at (all 59 TRADE_DECLINEs): first_seen_at (first_seen), NEVER
 *                 proposed_at, or every decline would be dated at its proposal
 *   lineups       changed_at (exact); actual/projected points are NOT copied
 *   news          published_at (exact); later than the row's own ingested_at -> clamped to
 *                 it with payload.source_as_of; a bare date -> end of day ET (date_only);
 *                 else ingested_at/created_at (first_seen)
 *   game lines    fetched_at (first_seen: the capture that saw the line); scores and
 *                 closing lines are NOT copied
 *   injuries      modified_at (exact); when empty (every 2025-26 row) the capture time,
 *                 i.e. now (first_seen): never dropped, never guessed
 *   trades        proposed_at (else created_at) for the proposal, resolved_at for the
 *                 result; the app's own model outputs go under payload.model
 *   signals       computed_at; every manager_signals source, counts and rates per fantasy
 *                 team only; the league's scoring period is in the natural key
 *   coverage      sync_log.last_run_at: one source.coverage event per collector run seen
 *                 (compare-latest), so a window with no run reads unknown, never zero
 * Every party is an entity; a player without a players.id is an alias (espn:/gsis:).
 * Everything this backfill writes is provenance 'reconstructed' unless told otherwise.
 *
 * Run off-server by scripts/engine-backfill.mjs (role script). Never from the web server.
 */
import { db as appDb } from '../../db/index.js';
import { appendEvents, normalizeAsOf } from './events.js';
import { writeState } from './state.js';
import { registerField } from './registry.js';
import { recordRun } from './fields.js';

// The spine's own field. This module is its one writer; the capability stays here.
const INGEST_WRITER = registerField('engine.ingest', {
  producer: 'engine-backfill', version: '1', entityTypes: ['engine'], valueType: 'object',
  description: 'Per stream: events in the log as of the row, and the highest event id',
});

const CHUNK = 2000;

const parse = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
const present = v => v != null && v !== '';

function playerIndex(database, column) {
  const cols = database.prepare('PRAGMA table_info(players)').all().map(c => c.name);
  if (!cols.includes(column)) return new Map();
  return new Map(database.prepare(`SELECT id, ${column} AS k FROM players WHERE ${column} IS NOT NULL`).all()
    .map(r => [String(r.k), Number(r.id)]));
}

/** A player as an entity: players.id when known, else the raw source id as an alias. */
const playerEntity = (resolved, alias, rawId, entityRole = 'subject') => (resolved != null
  ? { type: 'player', id: resolved, role: entityRole }
  : present(rawId) ? { type: alias, id: String(rawId), role: entityRole } : null);
const team = (leagueId, teamId, entityRole) => (present(leagueId) && present(teamId) && Number(teamId) > 0
  ? { type: 'league_team', id: `${leagueId}:${teamId}`, role: entityRole } : null);

const STATUS_WITHOUT_PROCESSED = new Set(['PENDING']);

/** One adapter per stream. `sql(table)` selects source rows; `map(row, ctx)` returns events. */
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
      let asOf; let quality;
      if (STATUS_WITHOUT_PROCESSED.has(r.status) || (r.type === 'TRADE_PROPOSAL' && !present(r.processed_at))) {
        // What is known is the proposal; a PENDING row's processed_at is its scheduled future.
        [asOf, quality] = present(r.proposed_at) ? [r.proposed_at, 'exact'] : [r.first_seen_at, 'first_seen'];
      } else if (present(r.processed_at)) {
        [asOf, quality] = [r.processed_at, 'exact'];
      } else {
        [asOf, quality] = [r.first_seen_at, 'first_seen'];
      }
      const entities = [team(r.league_id, r.team_id, 'subject')];
      for (const i of items) {
        entities.push(playerEntity(i.player_id, 'espn', i.espn_player_id));
        entities.push(team(r.league_id, i.from_team_id, 'from'), team(r.league_id, i.to_team_id, 'to'));
      }
      return [{
        event_type: 'espn.transaction', as_of: asOf, as_of_quality: quality,
        league_id: r.league_id, team_id: r.team_id, player_id: players.length === 1 ? players[0] : null,
        natural_key: `${r.league_id}:${r.season}:${r.tx_id}:${r.status ?? ''}`, entities: entities.filter(Boolean),
        payload: { season: r.season, tx_id: r.tx_id, type: r.type, status: r.status, execution_type: r.execution_type,
          scoring_period: r.scoring_period, bid_amount: r.bid_amount, is_pending: r.is_pending,
          proposed_at: r.proposed_at ?? null, items },
      }];
    },
  },
  {
    stream: 'lineups', table: 'league_roster_snapshots',
    sql: t => `SELECT league_id, season, scoring_period_id, team_id, espn_player_id, player_id, lineup_slot_id,
                 lineup_slot, is_starter, on_roster, injury_status, lineup_locked, source, changed_at FROM ${t}`,
    map: r => [{
      event_type: 'league.lineup', as_of: r.changed_at, as_of_quality: 'exact', league_id: r.league_id,
      team_id: r.team_id, player_id: r.player_id,
      natural_key: `${r.league_id}:${r.season}:${r.scoring_period_id}:${r.team_id}:${r.espn_player_id}`,
      entities: [playerEntity(r.player_id, 'espn', r.espn_player_id)].filter(Boolean),
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
      const payload = { news_id: r.id, headline: r.headline, importance: r.importance, news_source: r.source,
        transaction_type: r.transaction_type, nfl_team_id: r.team_id, player_ids: players };
      let asOf; let quality;
      if (present(r.published_at) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.published_at).trim())) {
        [asOf, quality] = [String(r.published_at).trim(), 'date_only'];
      } else if (present(r.published_at)) {
        [asOf, quality] = [r.published_at, 'exact'];
        const received = present(r.ingested_at) ? normalizeAsOf(r.ingested_at) : null;
        if (received && normalizeAsOf(r.published_at) > received) {
          payload.source_as_of = normalizeAsOf(r.published_at);
          [asOf, quality] = [received, 'clamped'];
        }
      } else if (present(r.ingested_at) || present(r.created_at)) {
        [asOf, quality] = [present(r.ingested_at) ? r.ingested_at : r.created_at, 'first_seen'];
      } else {
        [asOf, quality] = [r.date, 'date_only'];
      }
      return [{
        event_type: 'news.item', as_of: asOf, as_of_quality: quality,
        player_id: players.length === 1 ? players[0] : null, natural_key: String(r.id),
        entities: players.map(p => ({ type: 'player', id: p, role: 'subject' })), payload,
      }];
    },
  },
  {
    stream: 'game_lines', table: 'game_lines',
    sql: t => `SELECT season, week, team, opponent, home, spread, total, implied_points, moneyline, open_spread,
                 open_total, source, fetched_at FROM ${t}`,
    map: r => {
      const home = Number(r.home) === 1 ? r.team : r.opponent;
      return [{
        event_type: 'market.game_line', as_of: r.fetched_at, as_of_quality: 'first_seen',
        natural_key: `${r.season}:${r.week}:${r.team}`,
        entities: [
          { type: 'nfl_team', id: r.team, role: 'subject' },
          present(r.opponent) ? { type: 'nfl_team', id: r.opponent, role: 'counterparty' } : null,
          present(home) ? { type: 'game', id: `${r.season}:${r.week}:${home}`, role: 'subject' } : null,
        ].filter(Boolean),
        payload: { season: r.season, week: r.week, team: r.team, opponent: r.opponent, home: r.home, spread: r.spread,
          total: r.total, implied_points: r.implied_points, moneyline: r.moneyline, open_spread: r.open_spread,
          open_total: r.open_total, line_source: r.source },
      }];
    },
  },
  {
    stream: 'injuries', table: 'nfl_injuries',
    sql: t => `SELECT season, week, gsis_id, team, position, report_status, practice_status, injury, modified_at FROM ${t}`,
    context: database => ({ byGsis: playerIndex(database, 'gsis_id') }),
    map: (r, { byGsis }) => {
      const playerId = byGsis.get(String(r.gsis_id)) ?? null;
      return [{
        event_type: 'nfl.injury',
        // No modified_at: stamped by appendEvents at this capture (as_of = ingested_at).
        as_of: present(r.modified_at) ? r.modified_at : null,
        as_of_quality: present(r.modified_at) ? 'exact' : 'first_seen',
        player_id: playerId, natural_key: `${r.season}:${r.week}:${r.gsis_id}`,
        entities: [playerEntity(playerId, 'gsis', r.gsis_id),
          present(r.team) ? { type: 'nfl_team', id: r.team, role: 'subject' } : null].filter(Boolean),
        payload: { season: r.season, week: r.week, gsis_id: r.gsis_id, nfl_team: r.team, position: r.position,
          report_status: r.report_status, practice_status: r.practice_status, injury: r.injury },
      }];
    },
  },
  {
    stream: 'trade_outcomes', table: 'trade_outcomes',
    sql: t => `SELECT id, league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
                 proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
                 status, not_proposed_reason, espn_tx_id, resolved_at, created_at FROM ${t}`,
    map: r => {
      const considered = r.status === 'not_proposed';
      const parties = [team(r.league_id, r.proposer_team_id, 'from'), team(r.league_id, r.counterparty_team_id, 'counterparty'),
        { type: 'offer', id: r.id, role: 'subject' }].filter(Boolean);
      const hasModel = [r.model_p_accept, r.model_p_accept_low, r.model_p_accept_high, r.model_basis, r.model_version].some(present);
      const out = [{
        event_type: considered ? 'trade.considered' : 'trade.proposed',
        as_of: present(r.proposed_at) ? r.proposed_at : r.created_at,
        as_of_quality: present(r.proposed_at) ? 'exact' : 'first_seen',
        league_id: r.league_id, team_id: r.proposer_team_id, natural_key: `${r.id}:${considered ? 'considered' : 'proposed'}`,
        entities: parties,
        payload: { trade_outcome_id: r.id, season: r.season, ledger_source: r.source,
          counterparty_team_id: r.counterparty_team_id, give: parse(r.give_json, null), get: parse(r.get_json, null),
          not_proposed_reason: r.not_proposed_reason,
          // The app's own model output: never a learner's feature (getEvents stripModel).
          ...(hasModel ? { model: { p_accept: r.model_p_accept, p_accept_low: r.model_p_accept_low,
            p_accept_high: r.model_p_accept_high, basis: r.model_basis, version: r.model_version } } : {}) },
      }];
      if (!considered && r.status !== 'proposed' && present(r.resolved_at)) {
        out.push({
          event_type: 'trade.resolved', as_of: r.resolved_at, as_of_quality: 'exact', league_id: r.league_id,
          team_id: r.proposer_team_id, natural_key: `${r.id}:${r.status}`, entities: parties,
          payload: { trade_outcome_id: r.id, status: r.status, espn_tx_id: r.espn_tx_id,
            counterparty_team_id: r.counterparty_team_id },
        });
      }
      return out;
    },
  },
  {
    stream: 'manager_signals', table: 'manager_signals',
    sql: t => `SELECT league_id, roster_id, metric, value, n, source, computed_at FROM ${t}`,
    // manager_signals has one row per (league, roster, metric) and no week column, so the
    // league's scoring period at capture goes into the natural key (weeks never collapse).
    context: database => {
      const hasWeek = database.prepare('PRAGMA table_info(leagues)').all().some(c => c.name === 'current_week');
      return { periods: new Map(hasWeek ? database.prepare('SELECT id, current_week FROM leagues').all()
        .map(l => [Number(l.id), l.current_week == null ? null : Number(l.current_week)]) : []) };
    },
    map: (r, { periods }) => {
      const period = periods.get(Number(r.league_id)) ?? null;
      return [{
        event_type: 'manager.signal', as_of: r.computed_at, as_of_quality: 'exact', league_id: r.league_id,
        team_id: r.roster_id, natural_key: `${r.league_id}:${r.roster_id}:${r.metric}:${period ?? 'unknown'}`,
        payload: { signal_source: r.source, metric: r.metric, value: r.value, n: r.n, scoring_period: period },
      }];
    },
  },
  {
    stream: 'coverage', table: 'sync_log',
    // last_detail is free text from the collectors: never copied.
    sql: t => `SELECT job, last_run_at, last_status, runs, consecutive_failures FROM ${t}`,
    map: r => (present(r.last_run_at) ? [{
      event_type: 'source.coverage', as_of: r.last_run_at, as_of_quality: 'exact', natural_key: String(r.job),
      entities: [{ type: 'source', id: String(r.job), role: 'subject' }],
      payload: { job: r.job, last_run_at: normalizeAsOf(r.last_run_at), status: r.last_status ?? null,
        consecutive_failures: r.consecutive_failures ?? null },
    }] : []),
  },
]);

const tableExists = (database, t) =>
  !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/**
 * Backfill one stream. `table` overrides the adapter's table (tests use it to show an
 * absent table). Returns counts; an absent table is `table_state: 'table_absent'` with
 * null counts, never zero. `skipped` = unchanged re-captures (compare-latest).
 */
export function backfillStream(stream, { database = appDb, table, provenance = 'reconstructed' } = {}) {
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
    const r = appendEvents(batch, { database });
    inserted += r.inserted; skipped += r.skipped; batch = [];
  };
  // .all() rather than .iterate(): appendEvents writes to the same connection, and a
  // write under an open read cursor on that connection is not safe to rely on.
  for (const r of database.prepare(adapter.sql(t)).all()) {
    sourceRows += 1;
    for (const ev of adapter.map(r, ctx)) {
      if (!present(ev.as_of) && ev.as_of_quality !== 'first_seen') { noTimestamp += 1; continue; }
      batch.push({ provenance, ...ev, source: adapter.table });
      if (batch.length >= CHUNK) flush();
    }
  }
  flush();
  return { ...base, table_state: 'present', source_rows: sourceRows, inserted, skipped, no_timestamp: noTimestamp };
}

/**
 * Backfill every stream, then record the spine's own state row `engine.ingest`
 * (entity engine/events): per stream, events in the log as of now and the highest event
 * id. The reason chain has one contribution per stream (what this run added).
 */
export function backfillAll({ database = appDb, now = new Date(), provenance = 'reconstructed' } = {}) {
  const startedAt = new Date().toISOString();
  const cut = database.prepare(`SELECT (SELECT MAX(id) FROM engine_events) AS e, (SELECT MAX(id) FROM engine_state) AS s`).get();
  const streams = ADAPTERS.map(a => backfillStream(a.stream, { database, provenance }));
  const asOf = normalizeAsOf(now);
  const summary = {};
  const contributions = [];
  for (const s of streams) {
    const agg = database.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m FROM engine_events WHERE source = ? AND as_of <= ?`)
      .get(s.source, asOf);
    summary[s.stream] = { table: s.table, table_state: s.table_state, events: Number(agg.n), max_event_id: agg.m == null ? null : Number(agg.m) };
    contributions.push({ source: s.source, kind: 'event', event_ids: [], delta: s.inserted,
      text: s.table_state === 'table_absent'
        ? `${s.table} does not exist on this database`
        : `${s.inserted} new events this run from ${s.source_rows} rows; ${agg.n} in the log` });
  }
  // This backfill is itself a run: its row carries the input cut, and engine.ingest cites it.
  const runId = recordRun({ producer: 'engine-backfill', version: '1', scopeKey: '', startedAt,
    inputCutEventId: cut.e == null ? null : Number(cut.e), inputCutStateId: cut.s == null ? null : Number(cut.s),
    rowsWritten: streams.reduce((a, s) => a + (s.inserted ?? 0), 0),
    rowsUnchanged: streams.reduce((a, s) => a + (s.skipped ?? 0), 0), dirtyReason: 'backfill' }, database);
  const written = writeState({ entityType: 'engine', entityId: 'events', field: 'engine.ingest', value: { streams: summary },
    asOf, writer: INGEST_WRITER, producerVersion: '1', eventIds: [], reasonChain: { contributions }, runId }, database);
  return { as_of: asOf, streams, state: written, run_id: runId };
}

/**
 * Bytes per row of the engine tables, from SQLite's dbstat (pages incl. indexes).
 * Returns {available:false, reason} when dbstat is not compiled into this SQLite.
 */
export function measureEngineBytes(database = appDb) {
  const tables = ['engine_events', 'engine_event_entities', 'engine_state'];
  let pages;
  try {
    pages = database.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`).all();
  } catch (error) {
    return { available: false, reason: `dbstat unavailable: ${error.message}` };
  }
  const byName = new Map(pages.map(p => [p.name, Number(p.bytes)]));
  const indexes = database.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${tables.map(() => '?').join(',')})`)
    .all(...tables);
  const out = {};
  for (const t of tables) {
    const rowsN = Number(database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    const tableBytes = byName.get(t) ?? 0;
    const indexBytes = indexes.filter(i => i.tbl_name === t).reduce((a, i) => a + (byName.get(i.name) ?? 0), 0);
    const bytes = tableBytes + indexBytes;
    out[t] = { rows: rowsN, table_bytes: tableBytes, index_bytes: indexBytes, bytes,
      bytes_per_row: rowsN ? Math.round((bytes / rowsN) * 10) / 10 : null };
  }
  return { available: true, tables: out };
}
