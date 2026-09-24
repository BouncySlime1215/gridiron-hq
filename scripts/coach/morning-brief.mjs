#!/usr/bin/env node
/**
 * COACH-BRIEF: print Coach's morning brief or weekly check-in for one league
 * (default: the target league, 4).
 *
 * Reads the War Room plans file (warroom-flag.js#warRoomPlansPath, the one
 * reader of its path) and the app DB (GRIDIRON_DB_PATH). It
 * never opens the chat DB: statements and credibility come from PULSE-01 and
 * CRED-01 once those are on main. Writes one cache row to coach_briefs
 * (migration 101) when that table exists. Sends nothing; the push is PUSH-01's.
 *
 * Off unless GRIDIRON_COACH_BRIEF_ENABLED=1 or preview mode
 * (server/services/preview-mode.js); off prints one line and reads nothing.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=<db> node scripts/coach/morning-brief.mjs [--kind morning|weekly]
 *     [--league 4] [--plans <file>] [--since <ISO>] [--json] [--ledger] [--migrate]
 *   --migrate applies pending migrations first (use it on a DB copy, never the live DB).
 */
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export const KINDS = ['morning', 'weekly'];

export function parseArgs(argv) {
  const out = { kind: 'morning', league: null, plans: null, since: null, json: false, ledger: false, migrate: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') out.kind = argv[++i];
    else if (a === '--league') out.league = Number(argv[++i]);
    else if (a === '--plans') out.plans = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--ledger') out.ledger = true;
    else if (a === '--migrate') out.migrate = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!KINDS.includes(out.kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  if (out.league !== null && !Number.isInteger(out.league)) throw new Error('--league must be a league id');
  if (out.since !== null && Number.isNaN(Date.parse(out.since))) throw new Error('--since must be an ISO time');
  return out;
}

/** One line for the log: what ran and what the check kept. Never a path or a name. */
export function summaryLine(kind, r) {
  if (r.status !== 'ok') return `[coach-brief] ${kind}: ${r.status}${r.reason ? `: ${r.reason}` : r.line ? `: ${r.line}` : ''}`;
  return `[coach-brief] ${kind} league ${r.league}: ${r.claims.length} claims kept, ${r.dropped.length} dropped, `
    + `${r.cached ? 'from cache' : r.cache}${r.preview ? ', preview' : ''}`;
}

async function main() {
  const a = parseArgs(process.argv);
  // The flag first: off must not open, create or migrate any DB.
  const brief = await import('../../server/services/coach/brief.js');
  if (!brief.coachBriefFlag().on) { console.log(summaryLine(a.kind, { status: 'off', line: `${brief.BRIEF_ENV} not 1` })); return; }
  const { db } = await import('../../server/db/index.js');
  if (a.migrate) await (await import('../../server/db/migrate.js')).runMigrations();
  const { warRoomPlansPath } = await import('../../server/services/warroom-flag.js');
  const leagueId = a.league ?? brief.TARGET_LEAGUE;
  const file = await brief.readPlansFile(a.plans ?? warRoomPlansPath());
  const r = a.kind === 'weekly' ? brief.weeklyCheckIn({ db, file, leagueId })
    : brief.morningBrief({ db, file, leagueId, since: a.since });
  if (a.json) {
    const { ledger, ...rest } = r;
    console.log(JSON.stringify(a.ledger ? r : rest, null, 2));
  } else if (r.status === 'ok') {
    console.log(r.text || '(no text)');
    for (const d of r.dropped ?? []) console.log(`[dropped by the check] ${d.text} -- ${d.violations.join(' ')}`);
  }
  console.error(summaryLine(a.kind, r));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(`[coach-brief] FAILED: ${e.stack ?? e}`); process.exit(1); });
}
