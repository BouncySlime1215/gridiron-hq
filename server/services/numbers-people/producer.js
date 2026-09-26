/**
 * NUMBERS-PEOPLE producer: the one writer of the Numbers & People reads.
 *
 * For every league with a served plan (the War Room plans file, not out of date)
 * it reads the key items (items.js), and when a run is due asks both lanes once
 * (lanes.js: Claude on the numbers, then Jev leading the people lane on Claude's read) and stores the reads with their verdicts (store.js). A run is due
 * when there is no finished run yet, the last one is WINDOW_HOURS old, or the
 * plan's key items changed (items.js#inputsHash). Nick's Refresh forces one.
 * Never per page view: a view reads the stored rows.
 *
 * GRIDIRON_NUMBERS_PEOPLE turns it off with 0 (default on: Nick asked for it).
 * Preview mode neither turns it on nor off. Spend is logged in ai_usage under
 * numbers_people:* (Claude against the numbers_people daily budget; Jev uncapped);
 * a run the budget stops is recorded as 'budget' and the tab keeps showing the last reads.
 */
import { db as defaultDb, row } from '../../db/index.js';
import { readPlansFile, leagueEntry } from '../coach/brief.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { outOfDateReason } from '../campaign/plan-age.js';
import { leagueCurrentWeek } from '../league-week.js';
import { peopleSignals } from '../coach/lanes.js';
import { keyItems, inputsHash } from './items.js';
import { readBothLanes } from './lanes.js';
import { saveRun, lastRun, storeReady } from './store.js';

export const NP_ENV = 'GRIDIRON_NUMBERS_PEOPLE';
export const numbersPeopleOn = (env = process.env) => env[NP_ENV] !== '0';
export const WINDOW_HOURS = 6;
/** After a run the budget stopped or that failed, the schedule waits this long before asking again. */
export const RETRY_HOURS = 1;

const hoursSince = (iso, now) => (now - Date.parse(iso)) / 3_600_000;

/** Served plan entries: in the file, no producer error, not out of date. */
export async function servedEntries(plansPath = warRoomPlansPath()) {
  const file = await readPlansFile(plansPath);
  if (!file || !Array.isArray(file.leagues)) return { file: null, entries: [] };
  const entries = file.leagues.filter(e => e && e.league != null && !e.error && !outOfDateReason(e, file.leagues));
  return { file, entries };
}

/** Roster ids with an offer to or from Nick still open. */
export function openOfferRosters(database, leagueId, me) {
  if (me == null) return new Set();
  const out = new Set();
  const has = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_outcomes'").get();
  if (!has) return out;
  for (const r of database.prepare(`SELECT proposer_team_id AS a, counterparty_team_id AS b FROM trade_outcomes
    WHERE league_id = ? AND status = 'proposed'`).all(leagueId)) {
    if (String(r.a) === String(me) && r.b != null) out.add(String(r.b));
    else if (String(r.b) === String(me) && r.a != null) out.add(String(r.a));
  }
  return out;
}

function weekOf(leagueId) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  return lg ? leagueCurrentWeek(lg) : null;
}

/** Why a run is due for this league now, or null when it is not. */
export function dueReason({ last, lastAny, hash, force, now }) {
  if (force) return 'refresh';
  if (lastAny && lastAny.status !== 'ok' && hoursSince(lastAny.created_at, now) < RETRY_HOURS) return null;
  if (!last) return 'schedule';
  if (last.inputs_hash !== hash) return 'plan_change';
  return hoursSince(last.created_at, now) >= WINDOW_HOURS ? 'schedule' : null;
}

const inFlight = new Map();

/**
 * One league. Returns { league, status: 'ran'|'skipped'|'budget'|'failed', ... }.
 * A second call while one runs for the same league gets the same promise.
 */
export function runLeague({ leagueId, entry, force = false, trigger = null, database = defaultDb, now = Date.now(),
  signalsFor = null, plansAt = null, jevLane = undefined } = {}) {
  const key = String(leagueId);
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => {
    if (!storeReady(database)) return { league: leagueId, status: 'skipped', reason: 'the reads table is not on this database yet' };
    const items = keyItems(entry, { openOffers: openOfferRosters(database, leagueId, entry?.me) });
    if (!items.length) return { league: leagueId, status: 'skipped', reason: 'the plan has no key items' };
    const hash = inputsHash(items);
    const why = dueReason({ last: lastRun(database, leagueId, { status: 'ok' }), lastAny: lastRun(database, leagueId), hash, force, now });
    if (!why) return { league: leagueId, status: 'skipped', reason: 'read within the window and the plan has not changed' };
    const week = weekOf(leagueId);
    const signals = signalsFor ?? ((roster, players) => peopleSignals({ leagueId, focus: { partner: roster, players }, database }));
    const started = Date.now();
    const base = { leagueId, week, planAt: plansAt ?? entry?.planned_at ?? null, inputsHash: hash, trigger: trigger ?? why };
    try {
      const out = await readBothLanes(items, { signalsFor: signals, ...(jevLane ? { jevLane } : {}) });
      const latencyMs = Date.now() - started;
      const runId = saveRun(database, { ...base, status: 'ok', reads: out.reads, costUsd: out.cost_usd, latencyMs,
        reason: out.skipped.length ? `${out.skipped.length} item(s) the numbers lane did not read` : null });
      const verdicts = out.reads.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});
      return { league: leagueId, status: 'ran', run_id: runId, trigger: base.trigger, items: out.reads.length, skipped: out.skipped.length,
        verdicts, jev: out.jev, cost_usd: out.cost_usd, latency_ms: latencyMs };
    } catch (e) {
      const budget = e?.code === 'LLM_BUDGET_EXHAUSTED';
      const reason = budget ? 'daily AI budget for these reads is used up' : `lane call failed: ${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 200)}`;
      saveRun(database, { ...base, status: budget ? 'budget' : 'failed', reason, latencyMs: Date.now() - started });
      if (!budget) console.warn(`[numbers-people] league ${leagueId}: ${reason}`);
      return { league: leagueId, status: budget ? 'budget' : 'failed', reason };
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** One league by id, from the plans file; { status: 'skipped' } when it has no served plan. */
export async function runForLeague(leagueId, { force = false, trigger = null, plansPath = warRoomPlansPath(), database = defaultDb, jevLane = undefined } = {}) {
  if (!numbersPeopleOn()) return { league: leagueId, status: 'off', reason: `${NP_ENV}=0` };
  const { file, entries } = await servedEntries(plansPath);
  const entry = file ? entries.find(e => String(e.league) === String(leagueId)) ?? null : null;
  if (!entry) return { league: leagueId, status: 'skipped', reason: leagueEntry(file, leagueId) ? 'the plan is out of date' : 'no served plan for this league' };
  return runLeague({ leagueId: Number(leagueId), entry, force, trigger, database, jevLane, plansAt: entry.planned_at ?? file.generated_at ?? null });
}

/** The scheduler job: every league with a served plan, one at a time. */
export async function refreshNumbersPeople({ plansPath = warRoomPlansPath(), database = defaultDb } = {}) {
  if (!numbersPeopleOn()) return { skipped: true, reason: `${NP_ENV}=0` };
  const { file, entries } = await servedEntries(plansPath);
  if (!file) return { skipped: true, reason: 'no War Room plans file yet' };
  const leagues = [];
  for (const entry of entries) {
    leagues.push(await runLeague({ leagueId: Number(entry.league), entry, database, plansAt: entry.planned_at ?? file.generated_at ?? null }));
  }
  const failed = leagues.filter(l => l.status === 'failed');
  if (failed.length && failed.length === leagues.length) {
    throw new Error(`numbers-people: every league failed (${failed.map(f => `${f.league}: ${f.reason}`).join('; ')})`);
  }
  return { leagues, ran: leagues.filter(l => l.status === 'ran').length,
    cost_usd: leagues.reduce((s, l) => s + (l.cost_usd ?? 0), 0) };
}
