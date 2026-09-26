/**
 * IDEA-001 serve-log: keep every number the app serves on a trade card, a
 * title-odds surface or a range, as served, so it can be graded later against
 * what actually happened. A replay grades today's code; this grades the number
 * Nick read on the day.
 *
 * OFF THE REQUEST THREAD. A route calls `recordServed(res, surface, lg, payload)`,
 * which stamps a request id on the response and pushes one queue entry: no SQL,
 * no walk of the payload. `flushServed()` — run by the flush loop
 * (`startServeLogFlusher`, started in server/index.js whether or not the
 * scheduler is braked) — turns entries into rows and writes them in one
 * transaction. The weekly job (`snapshotServedNumbers`, scheduler job
 * `served_numbers_weekly`, also in scripts/refresh-live-data.mjs) computes the
 * same surfaces once per league per NFL week and writes them directly: it is
 * already off the request thread.
 *
 * NOTHING HERE IS SILENT. A full queue drops its oldest entry and counts it; a
 * payload the extractor cannot read is counted with its surface; a failed write
 * puts the batch back and throws. `serveLogState()` reports all of it, and
 * GET /api/trades/:leagueId/served-numbers serves that state next to the rows.
 *
 * Table: served_numbers (server/migrations/079_served_numbers.js).
 *
 * SERVE-LOG REPRO (item 31, GRIDIRON_SERVE_PIN=1): each entry also carries a pin
 * (serve-pin.js: code sha, league snapshot hash, producer args, seed), written to
 * served_pins in the same transaction as its numbers; off, nothing about the
 * queue or the rows changes.
 */
import { randomUUID } from 'node:crypto';
import { withRandomSeed } from './stats-util.js';
import { db as processDb } from '../db/index.js';
import { calMonitorEnabled, matchupPostures } from './eval/calibration-monitor.js';
import { servePinOn, pinFor, pinRow, PIN_INSERT, titleOddsSeed } from './serve-pin.js';

/** Payload entries, not rows: one entry is one response. */
export const SERVE_LOG_QUEUE_CAP = 500;
/**
 * One flush tick writes at most this many rows (whole entries; one entry larger
 * than this still goes whole). Measured on this branch with 300-deal /find
 * payloads (1,800 rows each): a tick of two entries, 3,600 rows, took 23.5-24.7 ms.
 * Without the budget a full queue of them was 900,000 rows and one 12.3-13.9 s block.
 */
export const SERVE_LOG_FLUSH_ROWS = 2000;
export const SERVE_LOG_FLUSH_MS = 1000;
/** Paired-SE multiple the cards print as the band (season-sim.js TRADE_DELTA_NOISE_SE). */
const BAND_SE = 2;

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const band = (v, se, sign) => (num(v) == null || num(se) == null ? null : +(num(v) + sign * BAND_SE * num(se)).toFixed(6));
const ids = list => (list ?? []).map(p => (typeof p === 'object' && p ? p.id : p)).map(String).sort().join(',');
/** One deal is one entity wherever it is served: my team, partner, sorted ids out > in. */
export const dealEntity = (me, partner, give, get) => `deal:${me ?? ''}|${partner ?? ''}|${ids(give)}>${ids(get)}`;

const simVersion = p => `runs=${p?.runs ?? ''};seed=${p?.seed ?? ''};from_week=${p?.from_week ?? ''}`;

/** Title and playoff numbers for one side of a paired simulation, with the ±2 SE bands. */
function sideNumbers(side, prefix = '') {
  if (!side) return [];
  return [
    ['title_before', side.title_before], ['title_after', side.title_after],
    ['title_delta', side.title_delta], ['title_delta_se', side.title_delta_se],
    ['title_delta_lo', band(side.title_delta, side.title_delta_se, -1)],
    ['title_delta_hi', band(side.title_delta, side.title_delta_se, +1)],
    ['playoff_before', side.playoff_before], ['playoff_after', side.playoff_after],
    ['playoff_delta', side.playoff_delta], ['playoff_delta_se', side.playoff_delta_se],
    ['playoff_delta_lo', band(side.playoff_delta, side.playoff_delta_se, -1)],
    ['playoff_delta_hi', band(side.playoff_delta, side.playoff_delta_se, +1)],
    ['wins_delta', side.wins_delta],
  ].map(([f, v]) => [`${prefix}${f}`, v]);
}

/**
 * Each surface: which model made the number, its version, and the numbers
 * themselves as [entity, field, value]. Throws on a payload it cannot read; the
 * flush counts that rather than writing a partial answer.
 */
const EXTRACTORS = {
  /** POST /api/model/:id/trade-impact — the title-odds block on TradeCard. */
  trade_impact: (p, ctx) => {
    const entity = dealEntity(p.me?.roster_id ?? ctx.myTeamId, p.them?.roster_id ?? ctx.theirTeamId, ctx.iGive, ctx.iGet);
    return { model: 'season-sim.tradeImpact', version: simVersion(p),
      numbers: [...sideNumbers(p.me), ...sideNumbers(p.them, 'their_')].map(([f, v]) => [entity, f, v]) };
  },
  /** GET /api/model/:id/simulate — every team's title and playoff odds and their 95% intervals. */
  title_odds: p => {
    if (!Array.isArray(p.teams)) throw new Error('title_odds payload has no teams list');
    const numbers = [];
    for (const t of p.teams) {
      const e = `team:${t.roster_id}`;
      numbers.push([e, 'title_odds', t.title_odds], [e, 'title_odds_lo', t.title_odds_95?.[0]],
        [e, 'title_odds_hi', t.title_odds_95?.[1]], [e, 'playoff_odds', t.playoff_odds],
        [e, 'playoff_odds_lo', t.playoff_odds_95?.[0]], [e, 'playoff_odds_hi', t.playoff_odds_95?.[1]],
        [e, 'finals_odds', t.finals_odds], [e, 'expected_wins', t.expected_wins],
        [e, 'expected_points', t.expected_points]);
    }
    return { model: 'season-sim.simulateSeason', version: simVersion(p), numbers };
  },
  /** GET /api/trades/:id/title-trades — the Title-impact tab. */
  title_trades: (p, ctx) => {
    if (!Array.isArray(p.deals)) throw new Error('title_trades payload has no deals list');
    const numbers = [];
    for (const d of p.deals) {
      const e = dealEntity(ctx.myTeamId, d.partner_id, d.i_give, d.i_get);
      numbers.push([e, 'title_before', d.title_before], [e, 'title_after', d.title_after],
        [e, 'title_delta', d.title_delta], [e, 'title_delta_se', d.title_delta_se],
        [e, 'title_delta_lo', band(d.title_delta, d.title_delta_se, -1)],
        [e, 'title_delta_hi', band(d.title_delta, d.title_delta_se, +1)],
        [e, 'playoff_delta', d.playoff_delta], [e, 'ppg_delta', d.ppg_delta], [e, 'value_delta', d.value_delta],
        [e, 'their_title_delta', d.their_title_delta], [e, 'their_title_delta_se', d.their_title_delta_se],
        [e, 'their_title_delta_lo', band(d.their_title_delta, d.their_title_delta_se, -1)],
        [e, 'their_title_delta_hi', band(d.their_title_delta, d.their_title_delta_se, +1)]);
    }
    return { model: 'title-odds-trades.titleOddsTrades', version: `runs=${p.runs_each ?? ''}`, numbers };
  },
  /** GET /api/trades/:id/find — the trade cards' points, value and p10/p90 lineup range. */
  trade_find: p => {
    if (!Array.isArray(p.deals)) throw new Error('trade_find payload has no deals list');
    const me = p.me?.roster_id;
    const numbers = [];
    for (const d of p.deals) {
      const e = dealEntity(me, d.partner_id, d.i_give, d.i_get);
      numbers.push([e, 'ppg_delta', d.me?.ppg_delta], [e, 'value_delta', d.me?.value_delta],
        [e, 'floor_delta', d.me?.floor_delta], [e, 'ceiling_delta', d.me?.ceiling_delta],
        [e, 'their_ppg_delta', d.them?.ppg_delta], [e, 'their_value_delta', d.them?.value_delta]);
    }
    const c = p.model_context ?? {};
    return { model: 'trade-engine.findTrades', version: `${c.engine ?? ''}|cutoff=${c.cutoff ?? ''}`, numbers };
  },
  /**
   * GET /api/trades/:id/war-room — the War Room's numbers, read from the plans
   * file (contract warroom-plans/1): the next move and each deck card's first
   * step (p_yes, title_odds_delta ± 2 SE, title_after) and my title odds now.
   * Payload: the league's plans entry. A field that is not 'ok' served no number.
   */
  war_room: p => {
    const v = f => (f?.status === 'ok' ? f.value : null);
    const moves = [v(p.next_move), ...(v(p.alternatives) ?? [])].filter(m => m?.move_id);
    if (!moves.length && !p.destination) throw new Error('war_room payload has no next move, deck or destination');
    const numbers = [];
    const seen = new Set();
    for (const m of moves) {
      const st = m.steps?.[0];
      if (!st) continue;
      const e = dealEntity(p.me, st.partner, st.give, st.get);
      if (seen.has(e)) continue;
      seen.add(e);
      const d = st.title_odds_delta;
      numbers.push([e, 'p_yes', v(st.p_yes)], [e, 'title_odds_delta', v(d)],
        [e, 'title_odds_delta_se', d?.status === 'ok' ? d.se : null],
        [e, 'title_odds_delta_lo', d?.status === 'ok' ? band(d.value, d.se, -1) : null],
        [e, 'title_odds_delta_hi', d?.status === 'ok' ? band(d.value, d.se, +1) : null],
        [e, 'title_after', v(st.title_after)]);
    }
    const dest = v(p.destination);
    if (dest) numbers.push([`team:${p.me}`, 'title_now', v(dest.title_now)]);
    return { model: 'campaign-producer.plans', version: String(p.plans_version ?? ''), numbers };
  },
  /**
   * CAL-MON (eval/calibration-monitor.js): one matchup's win probability, as
   * lineup-posture.js#lineupPosture served it, logged by the weekly snapshot
   * while GRIDIRON_CAL_MONITOR=1. Entity `matchup:<week>:<roster>|<opponent>`.
   */
  matchup_win: p => {
    if (p.roster_id == null || p.week == null) throw new Error('matchup_win payload has no roster or week');
    if (p.opponent_roster_id == null || p.win_probability == null) return { model: 'lineup-posture.lineupPosture', version: '', numbers: [] };
    const e = `matchup:${p.week}:${p.roster_id}|${p.opponent_roster_id}`;
    return { model: 'lineup-posture.lineupPosture', version: String(p.sd_model ?? ''),
      numbers: [[e, 'win_prob', num(p.win_probability) == null ? null : num(p.win_probability) / 100], [e, 'edge', p.edge]] };
  },
};
export const SERVED_SURFACES = Object.keys(EXTRACTORS);

/** Pure: the rows one served payload becomes (without league/time stamps). */
export function servedNumbers(surface, payload, context = {}) {
  const extract = EXTRACTORS[surface];
  if (!extract) throw new Error(`serve-log: unknown surface ${surface}`);
  const { model, version, numbers } = extract(payload, context);
  return numbers.map(([entity, field, value]) => ({ entity, field, value: num(value), model, model_version: version }));
}

// ------------------------------------------------------------------ queue
const queue = [];
const state = { queued: 0, enqueued: 0, written_rows: 0, dropped: 0, extract_errors: 0,
  flushes: 0, last_flush_at: null, last_error: null, last_error_at: null };
const noteError = message => { state.last_error = message; state.last_error_at = new Date().toISOString(); };

export function serveLogState() { return { ...state, queued: queue.length }; }
/** Tests only. */
export function __resetServeLog() {
  queue.length = 0;
  Object.assign(state, { enqueued: 0, written_rows: 0, dropped: 0, extract_errors: 0, flushes: 0,
    last_flush_at: null, last_error: null, last_error_at: null });
}

const servable = payload => payload && typeof payload === 'object' && !payload.error;
const leagueWeek = lg => (Number(lg?.current_week) >= 1 ? Number(lg.current_week) : null);

/**
 * Called by a route right before `res.json(payload)`. O(1): one header, one push
 * (with the pin flag on, plus one payload hash per league sync, memoised).
 * An error payload served no number, so it records none. Returns the request id.
 * `args` / `seed`: the producer arguments and seed, kept only in the pin.
 */
export function recordServed(res, surface, lg, payload, context = {}, { trigger = 'request', args = null, seed = null } = {}) {
  if (!servable(payload) || !lg) return null;
  const requestId = randomUUID();
  res?.setHeader?.('X-Served-Request-Id', requestId);
  if (queue.length >= SERVE_LOG_QUEUE_CAP) { queue.shift(); state.dropped++; }
  queue.push({ surface, payload, context, request_id: requestId, trigger, served_at: new Date().toISOString(),
    league_id: lg.id, as_of: lg.fetched_at ?? null, season: lg.season ?? null, week: leagueWeek(lg),
    ...(servePinOn() ? { pin: pinFor(surface, lg, payload, { args, context, seed }) } : {}) });
  state.enqueued++;
  return requestId;
}

const INSERT = `INSERT INTO served_numbers
  (league_id, surface, entity, field, value, model, model_version, as_of, served_at, request_id, trigger, season, week)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** One entry's rows, or null (counted and reported) when its payload cannot be read. */
function entryRows(e) {
  try {
    return servedNumbers(e.surface, e.payload, e.context).map(n => [e.league_id, e.surface, n.entity,
      n.field, n.value, n.model, n.model_version, e.as_of, e.served_at, e.request_id, e.trigger, e.season, e.week]);
  } catch (err) {
    // Counted and reported, not swallowed: one unreadable payload must not
    // cost the rest of the batch, and the state says it happened.
    state.extract_errors++;
    noteError(`${e.surface} (league ${e.league_id}): ${err.message}`);
    return null;
  }
}

/** Rows (and their entries' pins) in one transaction. Throws on a failed write, after rolling back. */
function writeRows(out, database, pinned = []) {
  if (!out.length) return 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    const stmt = database.prepare(INSERT);
    for (const r of out) stmt.run(...r);
    if (pinned.length) {
      const pinStmt = database.prepare(PIN_INSERT);
      for (const e of pinned) pinStmt.run(...pinRow(e));
    }
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackErr) { err.message += ` (rollback: ${rollbackErr.message})`; }
    throw err;
  }
  return out.length;
}

const writeEntries = (entries, database) => {
  const readable = entries.map(e => [e, entryRows(e)]).filter(([, r]) => r);
  return writeRows(readable.flatMap(([, r]) => r), database, readable.map(([e]) => e).filter(e => e.pin));
};

/**
 * Drain the front of the queue into served_numbers, up to `maxRows` rows. On
 * failure the batch goes back to the front and this throws.
 */
export function flushServed({ database = processDb, maxRows = SERVE_LOG_FLUSH_ROWS } = {}) {
  // `readable` is what goes back on a failed write: an entry whose payload
  // could not be read is already counted, and re-queuing it would count it again.
  const batch = []; const readable = []; const out = [];
  while (queue.length && (!batch.length || out.length < maxRows)) {
    const e = queue.shift();
    batch.push(e);
    const r = entryRows(e);
    if (r) { readable.push(e); out.push(...r); }
  }
  if (!batch.length) return { entries: 0, rows: 0 };
  let written;
  try {
    written = writeRows(out, database, readable.filter(e => e.pin));
  } catch (err) {
    queue.unshift(...readable);
    while (queue.length > SERVE_LOG_QUEUE_CAP) { queue.shift(); state.dropped++; }
    noteError(`flush: ${err.message}`);
    throw err;
  }
  state.flushes++; state.written_rows += written; state.last_flush_at = new Date().toISOString();
  return { entries: batch.length, rows: written };
}

/** The flush loop. Unref'd so it never holds a process open; returns a stop function. */
export function startServeLogFlusher({ intervalMs = SERVE_LOG_FLUSH_MS, database = processDb } = {}) {
  const timer = setInterval(() => {
    try { flushServed({ database }); } catch (err) {
      // Already recorded in serveLogState().last_error and the batch is back on
      // the queue; the log line is for whoever is watching the terminal.
      console.warn(`[serve-log] flush failed, will retry: ${err.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ read
/** What was served for one league, newest first. Parameterised; `limit` capped. */
export function readServed(leagueId, { requestId = null, entity = null, limit = 500, database = processDb } = {}) {
  const where = ['league_id = ?']; const args = [leagueId];
  if (requestId) { where.push('request_id = ?'); args.push(String(requestId)); }
  if (entity) { where.push('entity = ?'); args.push(String(entity)); }
  args.push(Math.max(1, Math.min(5000, Number(limit) || 500)));
  return database.prepare(`SELECT league_id, surface, entity, field, value, model, model_version, as_of,
      served_at, request_id, trigger, season, week
    FROM served_numbers WHERE ${where.join(' AND ')} ORDER BY served_at DESC, id DESC LIMIT ?`).all(...args);
}

// ------------------------------------------------------------------ weekly
/**
 * Once per league per NFL week: the title odds, the title-trades tab and the
 * finder's cards, as the routes would serve them to the league's own team.
 * Idempotent on (league, season, week): a week already snapshotted is skipped,
 * so the job's own cadence only decides how soon after a new week it lands.
 * Producers are imported lazily so the scheduler, which imports this module,
 * does not pull the season simulator into every process that loads it.
 */
export async function snapshotServedNumbers({ database = processDb } = {}) {
  const [{ simulateSeason }, { titleOddsTrades }, { findTrades }, { scoringFor }] = await Promise.all([
    import('./season-sim.js'), import('./title-odds-trades.js'), import('./trade-engine.js'), import('./scoring.js')]);
  const leagues = database.prepare('SELECT * FROM leagues ORDER BY id').all();
  const out = [];
  for (const lg of leagues) {
    if (!lg.payload) { out.push({ league_id: lg.id, state: 'not_synced' }); continue; }
    const week = leagueWeek(lg);
    const done = database.prepare(`SELECT 1 FROM served_numbers WHERE league_id = ? AND trigger = 'weekly'
      AND season IS ? AND week IS ? LIMIT 1`).get(lg.id, lg.season ?? null, week);
    if (done) { out.push({ league_id: lg.id, week, state: 'already_snapshotted' }); continue; }
    const entries = [];
    const pinOn = servePinOn();
    const add = (surface, payload, context = {}, { args = null, seed = null } = {}) => {
      if (!servable(payload)) return;
      entries.push({ surface, payload, context, request_id: requestId, trigger: 'weekly',
        served_at: new Date().toISOString(), league_id: lg.id, as_of: lg.fetched_at ?? null,
        season: lg.season ?? null, week,
        ...(pinOn ? { pin: pinFor(surface, lg, payload, { args, context, seed }) } : {}) });
    };
    const requestId = `weekly:${randomUUID()}`;
    const myTeamId = lg.my_team_id ?? null;
    // With the pin flag on the weekly title odds run on a recorded seed (serve-pin.js#titleOddsSeed).
    const oddsSeed = pinOn ? titleOddsSeed(lg, { runs: 2000, fromWeek: null }) : null;
    add('title_odds', withRandomSeed(oddsSeed, () => simulateSeason(lg, { runs: 2000, scoring: scoringFor(lg) })),
      {}, { args: { runs: 2000, from_week: null }, seed: oddsSeed });
    add('title_trades', titleOddsTrades(lg.id, { teamId: myTeamId }), { myTeamId }, { args: { teamId: myTeamId } });
    add('trade_find', findTrades(lg, { myTeamId, limit: 20 }), {}, { args: { myTeamId, limit: 20 } });
    if (calMonitorEnabled()) {
      const { lineupPosture } = await import('./lineup-posture.js');
      for (const m of matchupPostures(lg, lineupPosture)) add('matchup_win', m);
    }
    const rows = writeEntries(entries, database);
    out.push({ league_id: lg.id, week, state: rows ? 'snapshotted' : 'nothing_served', rows, request_id: requestId });
  }
  return { leagues: out };
}
