/**
 * One engine tick (ENGINE-ARCHITECTURE.md §4.3, §9.2).
 *
 *   1. Adapters append new source rows as events (cursors.js), each stream isolated.
 *   2. onEvent learners get each new event, each with a time budget (default 2 s); a
 *      learner that throws or overruns is recorded against itself and the others still run.
 *   3. Producers run in DAG order. Cheap ones (schedule 'tick', cost 'cheap') run whole,
 *      every tick: write-on-change keeps an unchanged world from adding rows. Heavy ones
 *      (cost 'heavy', scope league) run per league only when that league's dirty bit is set:
 *      an input event or input field row relevant to the league has an id past the cut of
 *      its last successful run (engine_cursors `league:<id>`). A producer's active version
 *      runs in lane live and each shadow version in lane shadow, on the same inputs.
 *      A producer that throws or overruns its budget is recorded (engine_runs.error), its
 *      cursor stays (so the dirty bit stays set), and its league publishes nothing.
 *   4. Publish one snapshot per league whose DAG finished and whose rows moved (or that has
 *      none yet); league 0 is the global snapshot. The others keep their previous one.
 *   5. Hooks that are due start as children, only while engine.lock is still ours.
 *   6. Heartbeat: sync_log row `engine_daemon` (the Data Health page shows it), with every
 *      failure named in its detail.
 *
 * League relevance of a global row or event: a player-keyed one matters to the leagues whose
 * lineup events carry that player; an unresolved alias (gsis:/espn:) matters to every league
 * (a missed rebuild is worse than a spare one); anything not about a player (games, weeks,
 * NFL teams) matters to every league.
 *
 * Budgets are checked after the fact: node:sqlite and the producers run synchronously on
 * one thread, so an overrun cannot be pre-empted, only refused publication.
 */
import crypto from 'node:crypto';
import { handlersFor } from '../registry.js';
import { runAdapters, getCursor, setCursor, HEARTBEAT_JOB } from './cursors.js';
import { makeContext } from './context.js';
import { startRun, finishRun, currentCut } from './runs.js';
import { publishSnapshot, latestSnapshot } from './snapshots.js';

const PLAYER_ENTITY = new Set(['player', 'player_week', 'player_week_scored']);
const ALIAS = new Set(['gsis', 'espn', 'sleeper']);
export const DEFAULT_LEARNER_BUDGET_MS = 2000;

const errText = e => String(e?.message ?? e).slice(0, 500);

/** league id -> Set(player id) from league.lineup events (the rosters the log has seen). */
export function rosterIndex(database) {
  const out = new Map();
  for (const r of database.prepare(`SELECT DISTINCT league_id, player_id FROM engine_events
      WHERE event_type = 'league.lineup' AND player_id IS NOT NULL AND league_id > 0`).all()) {
    const l = Number(r.league_id);
    if (!out.has(l)) out.set(l, new Set());
    out.get(l).add(Number(r.player_id));
  }
  return out;
}

/** Every league the log knows (league_id > 0 on any event). */
export function knownLeagues(database) {
  return database.prepare('SELECT DISTINCT league_id FROM engine_events WHERE league_id > 0 ORDER BY league_id').all()
    .map(r => Number(r.league_id));
}

/** Does a set of player ids / alias flags touch league L? null players = about no player. */
function touches(league, { leagueId, players, alias }, rosters) {
  if (leagueId > 0) return leagueId === league;
  if (alias) return true;
  if (!players.length) return true;
  if (league === 0) return false;
  const roster = rosters.get(league);
  return !!roster && players.some(p => roster.has(p));
}

function stateRowScope(r) {
  const players = PLAYER_ENTITY.has(r.entity_type) ? [Number(String(r.entity_id).split(':')[0])] : [];
  return { leagueId: Number(r.league_id), players, alias: false };
}

function eventScope(r) {
  const players = new Set(r.player_id == null ? [] : [Number(r.player_id)]);
  let alias = false;
  for (const part of String(r.ents ?? '').split(',').filter(Boolean)) {
    const cut = part.indexOf(':');
    const type = part.slice(0, cut);
    if (type === 'player') players.add(Number(part.slice(cut + 1)));
    else if (ALIAS.has(type)) alias = true;
  }
  return { leagueId: Number(r.league_id), players: [...players], alias: alias && !players.size };
}

/**
 * Why (producer, version) is dirty for `league`, or null when it is clean. `wm` is the cut
 * of its last successful run ({event, state}); none means it never ran.
 */
export function dirtyReason({ inputs, league, wm, rosters }, database) {
  if (!wm) return 'first_run';
  const types = inputs?.events ?? [];
  const fields = inputs?.fields ?? [];
  if (types.length) {
    const found = database.prepare(`SELECT e.id, e.league_id, e.player_id,
        (SELECT group_concat(x.entity_type || ':' || x.entity_id) FROM engine_event_entities x
          WHERE x.event_id = e.id AND x.entity_type IN ('player', 'gsis', 'espn', 'sleeper')) AS ents
        FROM engine_events e WHERE e.id > ? AND e.event_type IN (${types.map(() => '?').join(',')})
          AND e.league_id IN (0, ?)`).all(wm.event, ...types, league);
    const hit = found.find(r => touches(league, eventScope(r), rosters));
    if (hit) return `event ${hit.id}`;
  }
  if (fields.length) {
    const found = database.prepare(`SELECT id, entity_type, entity_id, league_id FROM engine_state
        WHERE id > ? AND lane = 'live' AND field IN (${fields.map(() => '?').join(',')}) AND league_id IN (0, ?)`)
      .all(wm.state, ...fields, league);
    const hit = found.find(r => touches(league, stateRowScope(r), rosters));
    if (hit) return `state ${hit.id}`;
  }
  return null;
}

async function dispatchLearners(events, { budgetMs, clock }) {
  const failures = [];
  let dispatched = 0;
  for (const ev of events) {
    for (const handler of handlersFor(ev.event_type)) {
      const learner = handler.learnerName ?? handler.name ?? 'anonymous';
      const t0 = clock();
      dispatched += 1;
      try {
        const out = handler(ev);
        if (out && typeof out.then === 'function') {
          let timer;
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${budgetMs} ms`)), budgetMs); });
          try { await Promise.race([out, timeout]); } finally { clearTimeout(timer); }
        }
        const ms = clock() - t0;
        if (ms > budgetMs) failures.push({ learner, event_id: ev.id, error: `over budget: ${ms} ms > ${budgetMs} ms` });
      } catch (error) {
        failures.push({ learner, event_id: ev.id, error: errText(error) });
      }
    }
  }
  return { dispatched, failures };
}

async function runProducer({ database, producer, version, lane, tick, league, dirty, clock }) {
  const scopeKey = league == null ? '' : `league:${league}`;
  const cut = currentCut(database);
  const budget = Number(producer.inputs?.budget_ms) || 30000;
  const lease = startRun({ producer: producer.name, version, lane, scopeKey, tickId: tick.id, cut, leaseMs: budget,
    dirtyReason: dirty }, database);
  const t0 = clock();
  let error = null;
  let counts = { written: 0, unchanged: 0 };
  try {
    const fit = producer.resolveFit ? producer.resolveFit(database) : null;
    const made = makeContext({ database, producer, version, lane, tick, cut, league, runId: lease.id, fit });
    counts = made.counts;
    await producer.run(made.ctx);
  } catch (e) {
    error = errText(e);
  }
  const ms = clock() - t0;
  if (!error && ms > budget) error = `over budget: ${ms} ms > ${budget} ms`;
  finishRun(lease, { producer: producer.name, version, lane, scopeKey, tickId: tick.id, rowsWritten: counts.written,
    rowsUnchanged: counts.unchanged, error, dirtyReason: dirty }, database);
  return { producer: producer.name, version, lane, league, ok: !error, error, ms, ...counts, cut };
}

function versionsOf(producer) {
  return [[producer.active, 'live'], ...(producer.shadow ?? []).map(v => [v, 'shadow'])];
}

/**
 * Run one tick. `dag` is buildDag(producers).order; `lock` is the engine.lock handle
 * (hooks fire only while lock.held()); `hooks` a createHookRunner(); `heartbeat(job,
 * status, detail)` defaults to scheduler.js recordSync. Returns a summary.
 */
export async function runTick({
  database, dag = [], now = new Date(), tickId = crypto.randomUUID(), lock = null, hooks = null, sweep = false,
  shouldStop = () => false, heartbeat = null, learnerBudgetMs = DEFAULT_LEARNER_BUDGET_MS, timeZone,
  clock = () => Date.now(),
} = {}) {
  const t0 = clock();
  const tick = { id: tickId, as_of: new Date(now).toISOString() };
  const startCut = currentCut(database);
  const summary = { tick_id: tick.id, as_of: tick.as_of, stopped: false, adapters: [], events: 0, learners: null,
    runs: [], failed: [], snapshots: [], hooks: [], lock_held: null };

  // 1. adapters
  const ingest = runAdapters({ database, tickId: tick.id, sweep, shouldStop });
  summary.adapters = ingest.streams;
  summary.events = ingest.events.length;
  summary.stopped = ingest.stopped;
  for (const s of ingest.streams) if (s.error) summary.failed.push({ what: `adapter ${s.stream}`, error: s.error });

  // 2. learners
  summary.learners = await dispatchLearners(ingest.events, { budgetMs: learnerBudgetMs, clock });
  for (const f of summary.learners.failures) summary.failed.push({ what: `learner ${f.learner}`, event_id: f.event_id, error: f.error });

  // 3. producers, in DAG order
  const leagues = knownLeagues(database);
  const rosters = rosterIndex(database);
  let cheapFailed = false;
  const failedLeagues = new Set();
  for (const producer of dag) {
    if (summary.stopped || shouldStop()) { summary.stopped = true; break; }
    if ((producer.inputs?.schedule ?? 'tick') !== 'tick') continue;
    const heavy = producer.inputs?.cost === 'heavy';
    for (const [version, lane] of versionsOf(producer)) {
      if (!heavy) {
        const r = await runProducer({ database, producer, version, lane, tick, league: null, dirty: 'tick', clock });
        summary.runs.push(r);
        if (!r.ok) { cheapFailed = true; summary.failed.push({ what: `producer ${producer.name}@${version}`, error: r.error }); }
        continue;
      }
      for (const league of leagues) {
        if (shouldStop()) { summary.stopped = true; break; }
        const source = `league:${league}`;
        const wmText = getCursor(producer.name, version, source, database);
        const wm = wmText ? JSON.parse(wmText) : null;
        const dirty = dirtyReason({ inputs: producer.inputs, league, wm, rosters }, database);
        if (!dirty) continue;
        const r = await runProducer({ database, producer, version, lane, tick, league, dirty, clock });
        summary.runs.push(r);
        if (r.ok) setCursor(producer.name, version, source, JSON.stringify(r.cut), database, now);
        else {
          failedLeagues.add(league);
          summary.failed.push({ what: `producer ${producer.name}@${version} league ${league}`, error: r.error });
        }
      }
    }
  }

  // 4. snapshots
  if (!summary.stopped) {
    const newRows = database.prepare('SELECT entity_type, entity_id, league_id FROM engine_state WHERE id > ?').all(startCut.state);
    const versionSet = Object.fromEntries(dag.map(p => [p.name, p.active]));
    const week = currentNflWeek(database, tick.as_of);
    for (const league of [0, ...leagues]) {
      if (cheapFailed || failedLeagues.has(league)) continue;
      const moved = newRows.some(r => touches(league, stateRowScope(r), rosters)
        && (league !== 0 || Number(r.league_id) === 0));
      if (!moved && latestSnapshot(league, database)) continue;
      const id = publishSnapshot({ leagueId: league, tickId: tick.id, versionSet, season: week?.season ?? null,
        nflWeek: week?.week ?? null, now }, database);
      summary.snapshots.push({ league, id });
    }
  }

  // 5. hooks (never in a tick that lost the lock)
  summary.lock_held = lock ? lock.held() : null;
  if (hooks) {
    for (const key of hooks.checkLeases(now)) summary.failed.push({ what: `hook ${key}`, error: 'lease expired: killed' });
    if (!summary.stopped && lock?.held()) summary.hooks = hooks.runDue({ now, tickId: tick.id, timeZone });
  }
  if (lock && !summary.lock_held) summary.failed.push({ what: 'engine.lock', error: 'this daemon no longer holds engine.lock' });

  // 6. heartbeat
  summary.ms = clock() - t0;
  const beat = heartbeat ?? (await import('../../scheduler.js')).recordSync;
  beat(HEARTBEAT_JOB, summary.failed.length ? 'error' : 'ok', JSON.stringify({
    tick_id: tick.id, ms: summary.ms, events: summary.events, learners_dispatched: summary.learners.dispatched,
    runs: summary.runs.length, rows_written: summary.runs.reduce((a, r) => a + r.written, 0),
    snapshots: summary.snapshots.length, stopped: summary.stopped, failed: summary.failed,
  }));
  return summary;
}

/** The calendar's current NFL week ({season, week}) as of `asOf`, or null before it has run. */
export function currentNflWeek(database, asOf) {
  const r = database.prepare(`SELECT value FROM engine_state WHERE id IN (
        SELECT MAX(id) FROM engine_state WHERE field = 'nfl.week' AND entity_type = 'week' AND lane = 'live'
          AND as_of <= ? GROUP BY entity_id)
      AND json_extract(value, '$.current') = 1 LIMIT 1`).get(asOf);
  if (!r) return null;
  const v = JSON.parse(r.value);
  return { season: v.season, week: v.week };
}
