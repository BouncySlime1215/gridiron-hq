#!/usr/bin/env node
/**
 * SOURCE-TABLES: build the graders' two missing source tables, once per refresh tick,
 * before the graders run (scripts/refresh-live-data.mjs step `source_tables`).
 *
 *   weekly_autopsy         E7's source: every finished team-week from its final lineups
 *                          (server/services/eval/sources/weekly-autopsy.js)
 *   planner_move_outcomes  E4-live's source: capture this week's planner / finder / greedy
 *                          moves, settle finished weeks on paired seeds
 *                          (server/services/eval/sources/planner-move-outcomes.js)
 *
 * Off unless GRIDIRON_SOURCE_TABLES=1 (sources/flag.js): off, it prints one line and
 * touches nothing. Prints one summary line:
 *
 *   source_tables: autopsy 3 weeks 30 rows (0 with a starter who has no stat line); moves captured 1, settled 1 (graded 1), retrying 0
 *
 * A league whose capture or settle throws is reported on the line and the others go on;
 * exit 1 when anything failed. Importing this file runs nothing.
 *
 * Usage: node --env-file-if-exists=.env scripts/eval/produce-source-tables.mjs [--leagues 4]
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sourceTablesEnabled, SOURCE_TABLES_ENV } from '../../server/services/eval/sources/flag.js';

process.env.SCHEDULER_DISABLED = '1';

export function parseArgs(argv) {
  const i = argv.indexOf('--leagues');
  if (i < 0) return { leagues: null };
  const list = String(argv[i + 1] ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  return { leagues: list.length ? list : null };
}

/** The plans file's league entries, or why there are none. */
export function readPlans(file) {
  if (!fs.existsSync(file)) return { entries: [], reason: 'no plans file yet' };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { entries: Array.isArray(doc.leagues) ? doc.leagues : [], generated_at: doc.generated_at ?? null };
}

/**
 * Capture every planned league-week not captured yet whose week is not final.
 * deps: { leagueRow(id), finder(lg, me), greedy(lg, me), seed(lg) } — the real ones below, fakes in tests.
 */
export function captureAll(database, P, { entries, generated_at = null, leagues = null, deps, now }) {
  const out = { captured: 0, failed: [] };
  for (const e of entries) {
    const id = Number(e.league);
    if (leagues && !leagues.includes(id)) continue;
    const week = e._run?.week;
    const lg = deps.leagueRow(id);
    if (!lg || !Number.isInteger(week)) continue;
    const key = { league_id: id, season: Number(lg.season), week };
    if (P.hasWeek(database, key) || P.weekIsFinal(database, key)) continue;
    try {
      const arms = {
        planner: P.plannerArm(e),
        finder: P.finderArm(deps.finder(lg, e.me)),
        greedy: deps.greedy(lg, e.me),
      };
      if (P.captureWeek(database, { ...key, me: e.me, arms, seed: deps.seed(lg), plans_generated_at: generated_at, now })) out.captured++;
    } catch (err) {
      out.failed.push(`capture league ${id}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return out;
}

/** Settle every captured row whose week is now final. deps: { leagueRow, teams(lg), reprice(lg, row, move) }. */
export function settleAll(database, P, { leagues = null, deps, now }) {
  const out = { settled: 0, graded: 0, retrying: 0, failed: [] };
  for (const row of P.dueRows(database)) {
    if (leagues && !leagues.includes(Number(row.league_id))) continue;
    try {
      const lg = deps.leagueRow(Number(row.league_id));
      if (!lg) throw new Error('league row gone');
      const r = P.settleRow(database, row, { teams: () => deps.teams(lg), reprice: (rw, m) => deps.reprice(lg, rw, m), now });
      if (r.retry) { out.retrying++; continue; }
      out.settled++;
      if (r.graded) out.graded++;
    } catch (err) {
      out.failed.push(`settle league ${row.league_id} week ${row.week}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return out;
}

/** The real dependencies: the app DB, the served finder, the trade engine and the season sim. */
async function realDeps() {
  const [{ row }, engine, sim, titleOdds, format, adapter] = await Promise.all([
    import('../../server/db/index.js'), import('../../server/services/trade-engine.js'),
    import('../../server/services/season-sim.js'), import('../../server/services/title-odds-trades.js'),
    import('../../server/services/format.js'), import('../campaign/league-adapter.mjs'),
  ]);
  const { greedyMove } = await import('../../server/services/eval/sources/planner-move-outcomes.js');
  const teamsOf = lg => engine.loadRosters(lg, engine.assetUniverse(lg, format.deriveFormat(lg).formatKey));
  return {
    leagueRow: id => row('SELECT * FROM leagues WHERE id = ?', id) ?? null,
    finder: (lg, me) => {
      const served = titleOdds.titleOddsTrades(lg.id, { teamId: me });
      if (served.error) return { error: String(served.error) };
      const found = engine.findTrades(lg, { myTeamId: me, requireMutual: true, limit: 8 * 3 });
      return adapter.pickFinderBest(served.deals, found.deals);
    },
    greedy: (lg, me) => {
      const slots = engine.lineupSlots(lg);
      return greedyMove({ teams: teamsOf(lg), me, lineupPoints: ps => engine.bestLineup(ps, slots, 'ros_ppg').points });
    },
    seed: lg => sim.tradeImpactSeed(lg),
    teams: teamsOf,
    reprice: (lg, r, m) => {
      const res = sim.tradeImpact(lg, { myTeamId: r.me, theirTeamId: m.partner, iGive: m.give.map(Number),
        iGet: m.get.map(Number), ...(r.seed != null ? { seed: r.seed } : {}) });
      return res.error ? { error: res.error } : { title_delta: res.me?.title_delta, title_delta_se: res.me?.title_delta_se };
    },
  };
}

export async function main({ argv = process.argv.slice(2), env = process.env, log = console.log, now = () => new Date().toISOString() } = {}) {
  if (!sourceTablesEnabled(env)) {
    log(`source_tables: off (${SOURCE_TABLES_ENV} is not 1)`);
    return 0;
  }
  const { leagues } = parseArgs(argv);
  const { db } = await import('../../server/db/index.js');
  const A = await import('../../server/services/eval/sources/weekly-autopsy.js');
  const P = await import('../../server/services/eval/sources/planner-move-outcomes.js');
  const { warRoomPlansPath } = await import('../../server/services/warroom-flag.js');
  const failed = [];
  let autopsy = null;
  try { autopsy = A.produceWeeklyAutopsy(db, { leagueIds: leagues, now }); } catch (e) { failed.push(`autopsy: ${String(e?.message ?? e).slice(0, 160)}`); }
  const deps = await realDeps();
  const plans = readPlans(warRoomPlansPath());
  const cap = captureAll(db, P, { ...plans, leagues, deps, now });
  const set = settleAll(db, P, { leagues, deps, now });
  failed.push(...cap.failed, ...set.failed);
  log(`source_tables: autopsy ${autopsy ? `${autopsy.weeks} weeks ${autopsy.rows} rows (${autopsy.unscored_teams} with a starter who has no stat line)` : 'FAILED'}; `
    + `moves captured ${cap.captured}${plans.reason ? ` (${plans.reason})` : ''}, settled ${set.settled} (graded ${set.graded}), retrying ${set.retrying}`
    + (failed.length ? ` | ERROR ${failed.join(' | ')}` : ''));
  return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code), e => { console.error(`source_tables: ERROR ${e?.stack ?? e}`); process.exit(1); });
}
