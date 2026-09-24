#!/usr/bin/env node
/**
 * JEV-01b: grade Jev's chat labels (`jev_chat_signals`) for every ESPN league
 * with a trusted chat identity, by the rule pre-registered in
 * docs/evidence/2026-09-24/jev-01b-chat-preregistration.md.
 *
 * Read-only on both databases (GRIDIRON_DB_PATH, GRIDIRON_CHAT_DB_PATH). Prints
 * aggregates only: per question n, positives, status, weight, holdout log loss
 * and Brier, the 90% interval and who leads. No chat name, message, player or
 * league name is printed, so the output may be posted where others read it.
 *
 * Usage:
 *   node scripts/jev-grade-report.mjs                    # as of now
 *   node scripts/jev-grade-report.mjs --as-of 2026-10-01
 * Exit 0 on a report (thin is a report); 1 when a league throws.
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { openChatDb } = await import('../server/services/manager-signals.js');
const { gradeJevChatSignals } = await import('../server/services/jev/chat-grader.js');

const i = process.argv.indexOf('--as-of');
const asOf = i > 0 ? Date.parse(process.argv[i + 1]) : Date.now();
if (!Number.isFinite(asOf)) { console.error('--as-of needs a date'); process.exit(2); }

/** The printable part of a question's grade: drops the map itself, keeps its kind and n. */
function summary(q) {
  if (q.status !== 'measured') return q;
  const { calibration, ...rest } = q;
  return { ...rest, calibration: { kind: calibration.kind, n: calibration.n } };
}

const chat = openChatDb();
const leagues = rows(`SELECT DISTINCT l.id FROM leagues l JOIN league_member_identity i ON i.league_id = l.id
                      WHERE l.platform = 'espn' AND i.chat_name IS NOT NULL ORDER BY l.id`);
const out = { as_of: new Date(asOf).toISOString(), chat_db: chat ? 'present' : 'absent', leagues: [] };
let failed = 0;
try {
  for (const { id } of leagues) {
    try {
      const g = gradeJevChatSignals(id, { chat, asOf });
      out.leagues.push({ ...g, questions: g.questions
        ? Object.fromEntries(Object.entries(g.questions).map(([k, v]) => [k, summary(v)])) : undefined });
    } catch (e) {
      failed++;
      out.leagues.push({ league_id: id, status: 'error', error: String(e?.message ?? e).slice(0, 200) });
    }
  }
} finally { chat?.close(); }
if (!leagues.length) out.reason = 'no ESPN league has a chat identity row';
console.log(JSON.stringify(out, null, 2));
process.exit(failed ? 1 : 0);
