/**
 * SERVE-LOG REPRO (batch D item 31): "reproduce this card".
 *
 * Reads one served response back (served_numbers + its served_pins row, both
 * written by serve-log.js), checks it is being re-run on the same code and the
 * same league snapshot, re-runs the pinned producer with the pinned arguments
 * and seed, turns the result into rows with the serve-log's own extractor, and
 * compares every number. Nothing is written.
 *
 * Verdicts (worst surface wins; exit code for scripts/eval/repro-card.mjs):
 *   reproduced           every served number came back (|d| <= 1e-9, or both null)   0
 *   mismatch             a number differs, is missing, or is new; the diffs say which 1
 *   not_found / no_pin / code_unknown / code_mismatch / flags_mismatch /
 *   snapshot_mismatch / producer_run_needed
 *                        refused: re-running here would not be the same card        2
 * Refusals carry `fix`, the step that makes a re-run possible.
 */
import { db as processDb } from '../db/index.js';
import { readServed, servedNumbers } from './serve-log.js';
import { codePin, flagDiff, flagPin, readPins, snapshotPin } from './serve-pin.js';
import { withRandomSeed } from './stats-util.js';

export const REPRO_EXIT = {
  reproduced: 0, mismatch: 1,
  not_found: 2, no_pin: 2, code_unknown: 2, code_mismatch: 2, flags_mismatch: 2, snapshot_mismatch: 2,
  producer_run_needed: 2,
};
/** Worst first: the overall verdict is the first of these any surface has. */
const SEVERITY = ['not_found', 'no_pin', 'code_unknown', 'code_mismatch', 'flags_mismatch', 'snapshot_mismatch',
  'producer_run_needed', 'mismatch', 'reproduced'];
const TOLERANCE = 1e-9;
const MAX_DIFFS = 20;

/**
 * The producers a pinned card is re-run with, imported lazily (the season
 * simulator is heavy). Each takes (lg, args, seed) and returns the payload the
 * route served; the arguments are the ones the route recorded in the pin.
 */
export const DEFAULT_PRODUCERS = {
  title_odds: async (lg, args, seed) => {
    if (args.one_world) {
      const { oneWorldTitleOdds } = await import('./league-world.js');
      return oneWorldTitleOdds(lg, { ignored: {} });
    }
    const [{ simulateSeason }, { scoringFor }] = await Promise.all([import('./season-sim.js'), import('./scoring.js')]);
    return withRandomSeed(seed, () => simulateSeason(lg, { runs: args.runs, fromWeek: args.from_week, scoring: scoringFor(lg) }));
  },
  trade_impact: async (lg, args) => {
    const [{ tradeImpact }, { scoringFor }] = await Promise.all([import('./season-sim.js'), import('./scoring.js')]);
    const deal = { myTeamId: args.myTeamId, theirTeamId: args.theirTeamId, iGive: args.iGive, iGet: args.iGet };
    if (args.one_world) {
      const { leagueWorld, ONE_WORLD_RUNS } = await import('./league-world.js');
      return tradeImpact(lg, { ...deal, runs: ONE_WORLD_RUNS, scoring: scoringFor(lg), world: leagueWorld(lg) });
    }
    return tradeImpact(lg, { ...deal, runs: args.runs, fromWeek: args.fromWeek, seed: args.seed, scoring: scoringFor(lg) });
  },
  title_trades: async (lg, args) => {
    const { titleOddsTrades } = await import('./title-odds-trades.js');
    return titleOddsTrades(lg.id, args);
  },
  trade_find: async (lg, args) => {
    const { findTrades } = await import('./trade-engine.js');
    return findTrades(lg, { ...args, excludeIds: args.excludeIds ? new Set(args.excludeIds) : null });
  },
};

/** How to get a card whose producer is not re-run here. */
const PRODUCER_FIX = {
  war_room: lg => `the War Room card comes from the plans file; re-run node scripts/campaign/produce-plans.mjs --leagues ${lg} on the snapshot and compare the card`,
  matchup_win: () => 'matchup win probability is re-run by the weekly snapshot job (lineup-posture.js), not by this command',
};

const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= TOLERANCE);

/** Served rows vs re-run rows, keyed entity#field. */
export function compareNumbers(served, fresh) {
  const key = r => `${r.entity}#${r.field}`;
  const want = new Map(served.map(r => [key(r), r]));
  const got = new Map(fresh.map(r => [key(r), r]));
  const diffs = [];
  let equal = 0;
  for (const [k, r] of want) {
    const g = got.get(k);
    if (!g) diffs.push({ entity: r.entity, field: r.field, served: r.value, rerun: null, kind: 'missing' });
    else if (same(r.value, g.value)) equal++;
    else diffs.push({ entity: r.entity, field: r.field, served: r.value, rerun: g.value, kind: 'differs' });
  }
  for (const [k, g] of got) if (!want.has(k)) diffs.push({ entity: g.entity, field: g.field, served: null, rerun: g.value, kind: 'new' });
  return { compared: want.size, equal, diffs };
}

async function reproduceSurface({ surface, served, pinRow, lg, head, flags, producers, anyCode, anySnapshot }) {
  const out = { surface, numbers: served.length };
  if (!pinRow) return { ...out, status: 'no_pin', reason: 'served before GRIDIRON_SERVE_PIN was on, so nothing pins it' };
  const p = pinRow.pin;
  out.served_code = p.code?.sha ?? null;
  out.snapshot_as_of = p.snapshot?.as_of ?? null;
  if (!anyCode) {
    if (!p.code?.sha) return { ...out, status: 'code_unknown', reason: `the pin has no commit sha (${p.code?.reason ?? 'unknown'})` };
    if (!head?.sha) return { ...out, status: 'code_unknown', reason: `the running code has no commit sha (${head?.reason ?? 'unknown'})` };
    if (head.sha !== p.code.sha) {
      return { ...out, status: 'code_mismatch', reason: `served by ${p.code.sha}, running ${head.sha}`,
        fix: `git checkout ${p.code.sha} (or pass --any-code to compare across code)` };
    }
  }
  if (!anyCode) {
    const diff = flagDiff(p.flags ?? {}, flags);
    if (diff.length) {
      return { ...out, status: 'flags_mismatch', reason: `served with different switches: ${diff.map(d => `${d.name} ${d.served ?? 'unset'} -> ${d.now ?? 'unset'}`).join(', ')}`,
        fix: `run with ${diff.map(d => (d.served == null ? `${d.name} unset` : `${d.name}=${d.served}`)).join(' ')} (or pass --any-code)` };
    }
  }
  if (!anySnapshot) {
    const now = snapshotPin(lg);
    if (!p.snapshot?.sha256 || now.sha256 !== p.snapshot.sha256) {
      return { ...out, status: 'snapshot_mismatch', reason: `league data changed since the card was served (as of ${p.snapshot?.as_of ?? 'unknown'})`,
        fix: `run against a DB backup taken at ${p.snapshot?.as_of ?? 'the serve time'} with --db (or pass --any-snapshot)` };
    }
  }
  const produce = producers[surface];
  if (!produce) {
    return { ...out, status: 'producer_run_needed', reason: `${surface} is not re-run by this command`,
      fix: (PRODUCER_FIX[surface] ?? (() => 'no re-run path'))(lg.id) };
  }
  const payload = await produce(lg, p.args ?? {}, p.seed);
  const fresh = servedNumbers(surface, payload, p.context ?? {});
  const cmp = compareNumbers(served, fresh);
  return { ...out, status: cmp.diffs.length ? 'mismatch' : 'reproduced', seed: p.seed, seed_basis: p.seed_basis,
    compared: cmp.compared, equal: cmp.equal, diffs: cmp.diffs.slice(0, MAX_DIFFS), diff_count: cmp.diffs.length };
}

/**
 * Re-run one served response. `head` is the running code (codePin()) and `flags`
 * its switches (flagPin()); `anyCode` (code and switches) / `anySnapshot` compare
 * anyway instead of refusing.
 */
export async function reproduceCard({ leagueId, requestId, database = processDb, head = codePin(), flags = flagPin(),
  producers = DEFAULT_PRODUCERS, anyCode = false, anySnapshot = false } = {}) {
  const base = { league_id: leagueId, request_id: requestId };
  const served = readServed(leagueId, { requestId, limit: 5000, database });
  const lg = database.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
  if (!served.length || !lg) {
    return { ...base, status: 'not_found', exit: REPRO_EXIT.not_found, surfaces: [],
      reason: !lg ? `no league ${leagueId} in this database` : 'no served numbers with that request id in this league' };
  }
  const pins = new Map(readPins(leagueId, requestId, { database }).map(p => [p.surface, p]));
  const bySurface = new Map();
  for (const r of served) bySurface.set(r.surface, [...(bySurface.get(r.surface) ?? []), r]);
  const surfaces = [];
  for (const [surface, rs] of bySurface) {
    surfaces.push(await reproduceSurface({ surface, served: rs, pinRow: pins.get(surface), lg, head, flags, producers, anyCode, anySnapshot }));
  }
  const status = SEVERITY.find(s => surfaces.some(x => x.status === s));
  return { ...base, status, exit: REPRO_EXIT[status], served_at: served[0].served_at, surfaces };
}

/** The newest pinned response for a league (optionally one surface), or null. */
export function latestPinnedRequest(leagueId, { surface = null, database = processDb } = {}) {
  const where = ['league_id = ?']; const args = [leagueId];
  if (surface) { where.push('surface = ?'); args.push(String(surface)); }
  return database.prepare(`SELECT request_id FROM served_pins WHERE ${where.join(' AND ')}
    ORDER BY served_at DESC LIMIT 1`).get(...args)?.request_id ?? null;
}

/** One plain line per surface, for the command's text output. */
export function reproLines(r) {
  if (r.status === 'not_found') return [`Not found: ${r.reason}.`];
  return r.surfaces.map(s => {
    if (s.status === 'reproduced') return `${s.surface}: reproduced ${s.equal} of ${s.compared} numbers exactly (seed ${s.seed ?? s.seed_basis}).`;
    if (s.status === 'mismatch') {
      const d = s.diffs.slice(0, 5).map(x => `${x.entity} ${x.field}: served ${x.served}, re-run ${x.rerun}`).join('; ');
      return `${s.surface}: ${s.diff_count} of ${s.compared} numbers did not come back (${d}).`;
    }
    if (s.status === 'producer_run_needed') return `${s.surface}: needs a producer run: ${s.fix}.`;
    return `${s.surface}: not re-run (${s.status}): ${s.reason}.${s.fix ? ` Fix: ${s.fix}.` : ''}`;
  });
}
