/**
 * TELLS-01a: refitTells, the nightly hook for the always-on engine (ENGINE-00b registers it;
 * until then TELLS-01b runs it from the post-sync job).
 *
 * For every roster of every league it is given, it recomputes the surviving tells (the screen
 * artifact's `confirmed` tells, server/data/tells-screen.json) as of `asOf` with the tell
 * library, and shrinks each value toward the population prior the factory fit
 * (empirical Bayes: shrunk = (n * value + k * prior_mean) / (n + k), n = weeks of the tell's
 * window observed as of `asOf`, k = the prior's k_weeks).
 *
 * It RETURNS rows and WRITES NOTHING: TELLS-01b owns the engine_state writes. It is walk-forward
 * safe because the library drops every event stamped after `asOf`, and idempotent because it
 * is a pure function of (events as of asOf, screen, positions).
 *
 * Off unless GRIDIRON_TELLS_ENABLED=1 (or `enabled: true` is passed). Arm B tells are `lead`
 * in the screen (their 90% CI did not clear 0) and are not returned unless `includeLeads`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalRecords, computeTells, survivingTellIds, windowWeeks, LIBRARY_VERSION, TELL_EVENT_TYPES,
} from './library.js';

const SCREEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/tells-screen.json');
const READER_LIMIT = 10000; // engine/events.js getEvents caps a read at 10,000 rows

let screenCache = null;
export function loadScreen() {
  if (!screenCache) screenCache = JSON.parse(readFileSync(SCREEN_PATH, 'utf8'));
  return screenCache;
}

export function tellsEnabled(env = process.env) {
  return ['1', 'true', 'on'].includes(String(env.GRIDIRON_TELLS_ENABLED ?? '').toLowerCase());
}

/**
 * Default event loader: ENGINE-00a's as-of reader (server/services/engine/events.js,
 * PR #216). Imported lazily so this module loads before the spine merges. A read that
 * hits the reader's row cap throws rather than scoring a truncated history.
 */
async function engineLoader({ asOf, leagueId }) {
  let getEvents;
  try {
    ({ getEvents } = await import('../engine/events.js'));
  } catch (error) {
    throw new Error(`refitTells: ENGINE-00a's event reader (server/services/engine/events.js) is not available: ${error.message}`);
  }
  const rows = getEvents({ asOf, leagueId, types: Object.values(TELL_EVENT_TYPES), limit: READER_LIMIT });
  if (rows.length >= READER_LIMIT) {
    throw new Error(`refitTells: league ${leagueId} has >= ${READER_LIMIT} tell events as of ${asOf}; refusing a truncated read`);
  }
  return rows;
}

const round = v => (v == null ? null : Math.round(v * 1e6) / 1e6);

/**
 * @param opts.asOf     required cutoff
 * @param opts.leagues  [{ leagueId, previous: { leagueId, playoffWeekStart } | null }]
 * @param opts.loadEvents async ({ asOf, leagueId }) => engine_events rows (default: ENGINE-00a getEvents)
 * @param opts.positions { playerId: position } for the position families
 * @param opts.screen   the screen artifact (default: server/data/tells-screen.json)
 * @param opts.enabled  overrides GRIDIRON_TELLS_ENABLED
 * @param opts.includeLeads also return `lead` tells (arm B), flagged as such
 * @returns { enabled, as_of, version, rows } — rows sorted by league, roster, tell
 */
export async function refitTells({
  asOf, leagues = [], loadEvents = engineLoader, positions = {}, screen = null, enabled = null,
  includeLeads = false, env = process.env,
} = {}) {
  if (asOf == null) throw new Error('refitTells needs asOf: a refit without a cutoff can see the future');
  const on = enabled ?? tellsEnabled(env);
  if (!on) return { enabled: false, as_of: asOf, version: LIBRARY_VERSION, rows: [] };
  const art = screen ?? loadScreen();
  const ids = survivingTellIds(art, { includeLeads });
  const meta = new Map();
  for (const t of art.tells) {
    if (ids.includes(t.id) && t.verdict !== 'dead' && !meta.has(t.id)) meta.set(t.id, t);
  }
  const rows = [];
  for (const lg of leagues) {
    const events = [...await loadEvents({ asOf, leagueId: lg.leagueId })];
    if (lg.previous?.leagueId != null) events.push(...await loadEvents({ asOf, leagueId: lg.previous.leagueId }));
    const values = computeTells(events, { ids, asOf, leagueId: lg.leagueId, previous: lg.previous ?? null, positions });
    const { tw } = canonicalRecords(events, { asOf });
    const weeksOf = new Map();
    for (const r of tw) {
      if (r.lg !== lg.leagueId) continue;
      if (!weeksOf.has(r.roster)) weeksOf.set(r.roster, new Set());
      weeksOf.get(r.roster).add(r.week);
    }
    for (const [roster, vals] of [...values].sort((a, b) => a[0] - b[0])) {
      for (const id of [...ids].sort()) {
        const t = meta.get(id);
        const value = vals[id];
        const win = windowWeeks(id);
        const n = win ? win.filter(w => weeksOf.get(roster)?.has(w)).length : null;
        const m = t.prior?.mean ?? null;
        const k = t.prior?.k_weeks ?? null;
        let shrunk = value;
        if (value != null && m != null && k != null && n != null && n + k > 0) shrunk = (n * value + k * m) / (n + k);
        rows.push({
          league_id: lg.leagueId, roster_id: roster, tell_id: id, arm: t.arm, verdict: t.verdict,
          outcome: t.outcome, value: round(value), n_weeks: n, prior_mean: m, k_weeks: k, shrunk: round(shrunk),
        });
      }
    }
  }
  return { enabled: true, as_of: asOf, version: LIBRARY_VERSION, rows };
}
