#!/usr/bin/env node
/**
 * COACH-BRIEF: print Coach's morning brief, weekly check-in or next-move push
 * text for one league (default: the target league, 4).
 *
 * Reads the War Room plans file (GRIDIRON_WARROOM_PLANS, default
 * ~/gridiron-local/warroom/plans.json), the app DB (GRIDIRON_DB_PATH) and, for
 * the morning brief, the private chat DB (GRIDIRON_CHAT_DB_PATH; labels and
 * counts only). Writes one cache row to coach_briefs (migration 088) when that
 * table exists. Sends nothing: the push text is a draft for PUSH-01.
 *
 * Off unless GRIDIRON_COACH_BRIEF_ENABLED=1 or preview mode
 * (server/services/preview-mode.js); off prints one line and reads nothing.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=<db> node scripts/coach/morning-brief.mjs [--kind morning|weekly|push]
 *     [--league 4] [--plans <file>] [--previous <plans file>] [--since <ISO>] [--json] [--ledger] [--migrate]
 *   --migrate applies pending migrations first (use it on a DB copy, never the live DB).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export const KINDS = ['morning', 'weekly', 'push'];

export function parseArgs(argv) {
  const out = { kind: 'morning', league: null, plans: null, previous: null, since: null, json: false, ledger: false, migrate: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') out.kind = argv[++i];
    else if (a === '--league') out.league = Number(argv[++i]);
    else if (a === '--plans') out.plans = argv[++i];
    else if (a === '--previous') out.previous = argv[++i];
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

/** Absent -> null (the brief then says no plan has run); unreadable JSON throws. */
export function readPlans(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const file = readPlans(a.plans ?? warRoomPlansPath());
  let r;
  if (a.kind === 'weekly') r = brief.weeklyCheckIn({ db, file, leagueId });
  else if (a.kind === 'push') r = brief.nextMovePush({ db, file, leagueId, previous: a.previous ? readPlans(a.previous) : null });
  else {
    const { openChatDb } = await import('../../server/services/manager-signals.js');
    const chat = openChatDb();
    try { r = brief.morningBrief({ db, chat, file, leagueId, since: a.since }); } finally { chat?.close(); }
  }
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
