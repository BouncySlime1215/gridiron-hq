#!/usr/bin/env node
/**
 * CRED-01 nightly: recompute per-manager credibility (follow-through lift per
 * statement type x manager, 7d and 21d, shrunk to the league) and store one
 * as-of run in people_credibility. See server/services/people/credibility.js.
 *
 * Inputs (all read-only):
 *   - the app DB (GRIDIRON_DB_PATH): league_transactions_raw, league_roster_snapshots,
 *     players, league_member_identity (chat name -> roster; chat_name 'ME' is Nick)
 *   - the private chat DB (GRIDIRON_CHAT_DB_PATH, default data/derived/league_chat.sqlite):
 *     speaker + time per message id only, never text
 *   - statements: PEOPLE-LAB *.jsonl label records (--labels DIR or GRIDIRON_PEOPLE_LABELS_DIR);
 *     PULSE-01's people_pulse (#316) replaces them once it merges
 *
 * Usage:
 *   node scripts/people/credibility.mjs --league 4 [--season 2026] [--labels DIR]
 *        [--as-of 2026-09-20T00:00:00Z] [--dry-run] [--json]
 * Exit 0 on a stored (or dry) run, 0 with status 'skipped' when an input is
 * missing (no labels / no chat DB / no confirmed identities), 1 on an error.
 * Prints counts and statuses only; never a name or a message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.SCHEDULER_DISABLED = '1';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const LEAGUE = Number(arg('--league', '4'));
const LABELS = arg('--labels', process.env.GRIDIRON_PEOPLE_LABELS_DIR ?? null);
const AS_OF = arg('--as-of');
const DRY = argv.includes('--dry-run');
const AS_JSON = argv.includes('--json');

const { runMigrations } = await import('../../server/db/migrate.js');
const { db } = await import('../../server/db/index.js');
const { PROJECT_ROOT } = await import('../../server/platform/paths.js');
const cred = await import('../../server/services/people/credibility.js');

function finish(result, code = 0) {
  console.log(AS_JSON ? JSON.stringify(result) : Object.entries(result).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
  process.exit(code);
}

try {
  if (!DRY) await runMigrations();
  const chatPath = process.env.GRIDIRON_CHAT_DB_PATH || path.join(PROJECT_ROOT, 'data/derived/league_chat.sqlite');
  // Statement source: PEOPLE-LAB label files. PULSE-01's people_pulse (#316) becomes the source once it merges.
  if (!LABELS || !fs.existsSync(LABELS)) finish({ status: 'skipped', reason: 'no statement labels (--labels or GRIDIRON_PEOPLE_LABELS_DIR)' });
  if (!fs.existsSync(chatPath)) finish({ status: 'skipped', reason: 'no chat DB' });
  const ident = db.prepare(`SELECT roster_id, chat_name FROM league_member_identity
      WHERE league_id = ? AND chat_name IS NOT NULL`).all(LEAGUE);
  const me = ident.find(r => r.chat_name === 'ME');
  const byName = new Map(ident.filter(r => r.chat_name !== 'ME').map(r => [r.chat_name, Number(r.roster_id)]));
  if (!byName.size) finish({ status: 'skipped', reason: 'no chat identities for this league' });
  const nick = me ? Number(me.roster_id) : null;

  const season = Number(arg('--season', null) ?? db.prepare('SELECT MAX(season) AS s FROM league_transactions_raw WHERE league_id = ?').get(LEAGUE)?.s);
  const actions = cred.loadActions(db, LEAGUE, season);

  const records = [];
  for (const f of fs.readdirSync(LABELS).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(LABELS, f), 'utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  const chat = new DatabaseSync(chatPath, { readOnly: true });
  const statements = cred.statementsFromLabels(records, chat, (name, fromMe) => (fromMe ? nick : byName.get(name) ?? null));
  chat.close();

  const rosters = [...new Set(actions.moves.flatMap(m => [m.from, m.to]).filter(t => t && t !== nick))].sort((a, b) => a - b);
  const asOfMs = AS_OF ? cred.parseTs(AS_OF) : null;
  const statementsCut = asOfMs == null ? statements : statements.filter(s => s.t <= asOfMs);
  const run = cred.computeCredibility(statementsCut, actions, { rosters, excludeSpeakers: nick == null ? [] : [nick], asOf: asOfMs });
  const stored = DRY ? 0 : cred.storeCredibility(db, LEAGUE, run);

  const byStatus = {};
  for (const r of run.rows) if (r.roster_id !== '*') byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const league = Object.fromEntries(run.rows.filter(r => r.roster_id === '*')
    .map(r => [`${r.stmt_type}/${r.window_days}d`, { n: r.league_n, lift: r.league_lift, ci: [r.league_ci_lo, r.league_ci_hi], status: r.status }]));
  finish({ status: 'ok', league_id: LEAGUE, season, as_of: run.as_of, method: run.method_version,
    source: 'labels', statements: statementsCut.length, rosters: rosters.length, rows: run.rows.length, stored, dry_run: DRY, by_status: byStatus, league });
} catch (e) {
  finish({ status: 'error', error: String(e?.message ?? e) }, 1);
}
