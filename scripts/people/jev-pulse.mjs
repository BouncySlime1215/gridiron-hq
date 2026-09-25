#!/usr/bin/env node
/**
 * PULSE-02: ask Jev the pulse's own questions about league-mates' messages
 * (server/services/people/pulse-jev.js) and store the answers in the private chat DB
 * (jev_pulse_signals / jev_pulse_done). The pulse labeller reads them (pulse.js#labelMessage).
 *
 * Spend: every call's tokens are priced (USD_PER_M_TOKENS, input + output) and stored on
 * jev_pulse_done; a pass stops before the day's total (UTC) passes the cap
 * (GRIDIRON_PULSE_JEV_USD_DAY, default DAILY_USD_CAP = $0.50). A message that fails is retried
 * on the next pass, up to 3 attempts. Needs AI_GATEWAY_API_KEY (the league_chat step's key);
 * without it nothing is sent and the labeller runs on its rules alone.
 *
 * pulse.mjs calls `classifyPending` for the new messages on every pulse tick when
 * GRIDIRON_PULSE_02=1 and GRIDIRON_PULSE_JEV=1 (a paid call: opt-in, like the league_chat step's Jev stage). Without it the
 * labeller runs on rules alone, and rules-only labels are gated from replanning (pulse.js#replanGate).
 * By hand (the grading slice, on a COPY of the chat DB):
 *   GRIDIRON_DB_PATH=<copy> GRIDIRON_CHAT_DB_PATH=<copy> node --env-file=.env.local scripts/people/jev-pulse.mjs --since 2026-07-01
 * Prints one `jev_pulse: {...}` line (counts and dollars only).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.SCHEDULER_DISABLED = '1';

export const JEV_PULSE_FLAG = 'GRIDIRON_PULSE_JEV';
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 6;

const arg = (args, name, fallback = null) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : fallback;
};

/**
 * Classify `msgs` ([{msg_id, chat_kind, chat_name, name, ts_utc, text}]) that have no stored
 * answer for this version yet. `chat` must be writable. `evaluate` is the ai SDK's
 * experimental_evaluate (injected in tests). Returns {asked, ok, failed, skipped_done, usd, stopped}.
 */
export async function classifyPulse({ chat, database, leagueId, msgs, evaluate, env = process.env, now = () => new Date() }) {
  const P = await import('../../server/services/people/pulse.js');
  const J = await import('../../server/services/people/pulse-jev.js');
  J.ensurePulseJevTables(chat);
  const cap = Number(env.GRIDIRON_PULSE_JEV_USD_DAY ?? J.DAILY_USD_CAP);
  const speakers = P.speakerMap(leagueId, database);
  const nickRoster = database.prepare('SELECT my_team_id AS t FROM leagues WHERE id = ?').get(leagueId)?.t ?? null;
  const players = P.leaguePlayers(leagueId, database);
  const nameOf = new Map(players.map(p => [Number(p.espn_id), p.name]));
  const lexicon = P.buildLexicon(players, { firstNameCounts: P.firstNameCounts(database), excludeWords: P.memberWords(leagueId, database),
    pulse02: true });
  const ownership = P.ownershipTimeline(leagueId, database, { pulse02: true });
  const doneRow = chat.prepare('SELECT ok, attempts FROM jev_pulse_done WHERE msg_id = ? AND version = ?');
  const todo = [];
  let skipped = 0;
  for (const m of msgs) {
    const d = doneRow.get(m.msg_id, J.PULSE_JEV_VERSION);
    if (d && (d.ok || d.attempts >= MAX_ATTEMPTS)) { skipped += 1; continue; }
    todo.push({ ...m, attempts: d?.attempts ?? 0 });
  }
  const insSig = chat.prepare('INSERT OR REPLACE INTO jev_pulse_signals (msg_id, question, probability, version, evaluated_at) VALUES (?, ?, ?, ?, ?)');
  const insDone = chat.prepare(`INSERT OR REPLACE INTO jev_pulse_done (msg_id, version, ok, attempts, input_tokens, output_tokens, usd, error, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const day = now().toISOString().slice(0, 10);
  let usd = J.spentOn(chat, day);
  const startUsd = usd;
  // Each call in flight reserves the day's average call cost (a floor of $0.0001 before any), so
  // parallel workers cannot all start under the cap and finish over it.
  const avg = chat.prepare(`SELECT AVG(usd) AS a FROM jev_pulse_done WHERE ok = 1 AND substr(evaluated_at, 1, 10) = ?`).get(day)?.a;
  let est = Math.max(0.0001, Number(avg) || 0);
  let ok = 0; let failed = 0; let stopped = null; let cursor = 0; let inflight = 0;
  const worker = async () => {
    while (!stopped) {
      const i = cursor++;
      if (i >= todo.length) return;
      if (usd + (inflight + 1) * est > cap) { stopped = `daily cap $${cap} reached`; return; }
      inflight += 1;
      const m = todo[i];
      const roster = speakers.get(m.name) ?? null;
      const owners = ownership.at(m.ts_utc);
      const context = J.threadContext(chat, m, m.name);
      const ids = [];
      for (const t of [...context.map(c => c.text), m.text]) for (const id of P.resolvePlayers(t, lexicon)) if (!ids.includes(id)) ids.push(id);
      const named = ids.filter(id => nameOf.has(id)).map(id => ({ name: nameOf.get(id), tag: J.ownerTag(owners.get(id), roster, nickRoster) }));
      const at = now().toISOString();
      try {
        const r = await evaluate({ model: J.PULSE_JEV_MODEL, state: J.pulseJevState(m, context, named), questions: J.PULSE_JEV_QUESTIONS });
        const inTok = r.usage?.inputTokens ?? 0; const outTok = r.usage?.outputTokens ?? 0;
        const cost = ((inTok + outTok) / 1e6) * J.USD_PER_M_TOKENS;
        usd += cost;
        est = Math.max(est, cost);
        for (const q of Object.keys(J.PULSE_JEV_QUESTIONS)) {
          const a = r.answers?.[q];
          if (a && Number.isFinite(a.probability)) insSig.run(m.msg_id, q, a.probability, J.PULSE_JEV_VERSION, at);
        }
        insDone.run(m.msg_id, J.PULSE_JEV_VERSION, 1, m.attempts + 1, inTok, outTok, cost, null, at);
        ok += 1;
      } catch (e) {
        const msg = String(e?.message ?? e);
        insDone.run(m.msg_id, J.PULSE_JEV_VERSION, 0, m.attempts + 1, 0, 0, 0, msg.slice(0, 300), at);
        failed += 1;
        if (/authentication|api key|not have access|free tier|unauthori[sz]ed/i.test(msg)) stopped = `gateway refused: ${msg.slice(0, 120)}`;
      } finally {
        inflight -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { asked: ok + failed, ok, failed, skipped_done: skipped, usd: +(usd - startUsd).toFixed(4), usd_today: +usd.toFixed(4), cap, stopped };
}

/** The league-mates' messages after `afterMsgId` (or from `since`), for a pulse pass. */
export function pendingMessages(chat, speakerNames, { afterMsgId = null, since = null, limit = 5000 } = {}) {
  if (!speakerNames.length) return [];
  return chat.prepare(`SELECT msg_id, chat_kind, chat_name, name, ts_utc, text FROM messages
      WHERE is_from_me = 0 AND COALESCE(is_tapback, 0) = 0 AND text IS NOT NULL AND length(trim(text)) > 0
        AND name IN (${speakerNames.map(() => '?').join(',')}) AND ${afterMsgId != null ? 'msg_id > ?' : 'ts_utc >= ?'}
      ORDER BY msg_id LIMIT ?`).all(...speakerNames, afterMsgId != null ? afterMsgId : since, limit);
}

/**
 * One classification pass for pulse.mjs: the messages a pulse tick is about to label.
 * Off unless GRIDIRON_PULSE_JEV=1 (presence of '1' only; no value is echoed); no key -> nothing sent. Returns a status object (never throws
 * on a gateway failure: the rows are marked failed and retried next pass).
 */
export async function classifyPending({ leagueId, database, env = process.env, afterMsgId = null, since = null, evaluate = null }) {
  if (env[JEV_PULSE_FLAG] !== '1') return { status: 'off' };
  if (!evaluate && !env.AI_GATEWAY_API_KEY) return { status: 'no_key' };
  const { chatDbPath } = await import('../../server/services/manager-signals.js');
  const file = chatDbPath();
  if (!fs.existsSync(file)) return { status: 'no_chat_db' };
  const chat = new DatabaseSync(file);
  chat.exec('PRAGMA busy_timeout = 60000');
  try {
    const P = await import('../../server/services/people/pulse.js');
    const names = [...P.speakerMap(leagueId, database).keys()];
    const msgs = pendingMessages(chat, names, { afterMsgId, since, limit: 400 });
    const ev = evaluate ?? (await import('ai')).experimental_evaluate;
    return { status: 'ok', ...(await classifyPulse({ chat, database, leagueId, msgs, evaluate: ev, env })) };
  } finally {
    chat.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const leagueId = Number(arg(args, '--league', 4));
  const since = arg(args, '--since');
  const after = arg(args, '--after');
  if (!since && !after) { console.error('usage: jev-pulse.mjs --since <iso> | --after <msg_id> [--league 4]'); return 2; }
  const { db } = await import('../../server/db/index.js');
  // Run by hand = the opt-in.
  const r = await classifyPending({ leagueId, database: db, env: { ...process.env, [JEV_PULSE_FLAG]: '1' },
    since, afterMsgId: after == null ? null : Number(after) });
  console.log(`jev_pulse: ${JSON.stringify({ league: leagueId, ...r })}`);
  return r.status === 'ok' && !r.failed ? 0 : 1;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
