#!/usr/bin/env node
/**
 * PULSE-01: one chat-pulse pass for the target league (server/services/people/pulse.js).
 *
 * The refresh loop (scripts/refresh-live-data.mjs, step `people_pulse`, only when
 * GRIDIRON_PULSE_ENABLED=1 or preview mode) spawns this after the league_chat step, so it
 * labels the messages that step just extracted. It:
 *   1. labels the league-mates' new messages and appends people_pulse rows (labels only);
 *   2. when a LIVE credible statement arrived (weight >= CREDIBLE_LIFT; the first pass is a
 *      backfill and never counts), asks the planner to replan now: it launches the War Room
 *      producer (scripts/campaign/produce-plans.mjs) detached, the same way and through the
 *      same lock as the refresh loop's warroom_plans step, only when GRIDIRON_WARROOM_ENABLED=1.
 *      It runs every league, not `--leagues <id>`: the producer writes the plans file from the
 *      leagues it ran, so a one-league run would drop the others from the War Room. A run that
 *      already holds the lock is left alone (already_running). Every outcome is recorded on the
 *      run row (launched / already_running / no_planner / warroom_disabled), never dropped.
 * Prints one `people_pulse: {...}` summary line (counts only).
 *
 * Weight source: CRED-01's server/services/people/credibility.js when it exists and exports
 * `followThrough(leagueId, {database})` -> (rosterId, type) -> {lift, n, basis} | null;
 * otherwise the pooled PEOPLE-LAB prior (pulse.js#POOLED_PRIOR).
 *
 * --grade <labels dir>: no writes. Labels the PEOPLE-LAB slice (league-mates' messages from
 * 2026-07-01) and compares with the hand labels (<dir>/*.jsonl, league_ref L4, speaker not
 * Nick): per-type precision / recall and WANT_PLAYER player agreement. Counts only.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=<db> GRIDIRON_CHAT_DB_PATH=<chat db> node scripts/people/pulse.mjs [--league 4]
 *   GRIDIRON_DB_PATH=<copy> GRIDIRON_CHAT_DB_PATH=<copy> node scripts/people/pulse.mjs --grade <labels dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLANNER = 'scripts/campaign/produce-plans.mjs';
export const DEFAULT_LEAGUE = 4;

const arg = (args, name, fallback = null) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : fallback;
};

/** CRED-01's per-manager follow-through, when that module is on this tree. */
export async function loadCredibility(leagueId, database, { root = ROOT } = {}) {
  const file = path.join(root, 'server/services/people/credibility.js');
  if (!fs.existsSync(file)) return { source: 'pooled_prior', fn: null };
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.followThrough !== 'function') return { source: 'pooled_prior (credibility.js has no followThrough)', fn: null };
  return { source: 'cred-01', fn: mod.followThrough(leagueId, { database }) };
}

/**
 * Ask the planner to replan now (see 2. above). Returns {status, detail}. `launch` and `files`
 * are the refresh loop's own launcher and producer lock/log (refresh-live-data.mjs), so the two
 * can never run the producer twice at once.
 */
export async function requestReplan(leagueId, { env = process.env, root = ROOT, launch = null, files = null } = {}) {
  if (!fs.existsSync(path.join(root, PLANNER))) return { status: 'no_planner', detail: `${PLANNER} is not on this tree` };
  if (env.GRIDIRON_WARROOM_ENABLED !== '1') return { status: 'warroom_disabled', detail: 'GRIDIRON_WARROOM_ENABLED is not 1' };
  const refresh = launch && files ? null : await import('../refresh-live-data.mjs');
  const f = files ?? refresh.warRoomFiles(env);
  const holder = fs.existsSync(f.lock) ? Number(fs.readFileSync(f.lock, 'utf8')) : null;
  if (holder) {
    let alive = false;
    // kill(pid, 0) throws ESRCH for a gone process; EPERM means it exists under another user.
    try { process.kill(holder, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) return { status: 'already_running', detail: `producer pid ${holder} holds the lock; the next warroom_plans run replans league ${leagueId}` };
  }
  const pid = (launch ?? refresh.launchDetached)(process.execPath, ['--env-file-if-exists=.env', PLANNER],
    { cwd: root, env: { ...env, SCHEDULER_DISABLED: '1' }, log: f.log });
  return { status: 'launched', detail: `producer pid ${pid} (all leagues, incl. ${leagueId}); log ${path.basename(f.log)}` };
}

export async function runPulse({ leagueId = DEFAULT_LEAGUE, env = process.env, now = new Date(), log = console.log,
  replan = requestReplan } = {}) {
  const { db } = await import('../../server/db/index.js');
  const { openChatDb } = await import('../../server/services/manager-signals.js');
  const { pulseTick, recordReplan } = await import('../../server/services/people/pulse.js');
  const chat = openChatDb();
  if (!chat) {
    log(`people_pulse: ${JSON.stringify({ league: leagueId, status: 'no_chat_db' })}`);
    return { status: 'no_chat_db' };
  }
  try {
    const cred = await loadCredibility(leagueId, db);
    const r = pulseTick({ database: db, chat, leagueId, now, credibility: cred.fn });
    let asked = { status: 'not_needed', detail: null };
    if (r.liveCredible.length) {
      asked = await replan(leagueId, { env });
      asked.detail = `${r.liveCredible.length} credible (${[...new Set(r.liveCredible.map(s => s.type))].join(',')}); ${asked.detail}`;
    }
    recordReplan(r.run_id, asked.status, asked.detail, db);
    const summary = { league: leagueId, status: 'ok', read: r.read, statements: r.statements, credible: r.credible,
      live_credible: r.liveCredible.length, backfill: r.backfill, weight_source: cred.source, replan: asked.status,
      speakers: r.speakers, to_msg_id: r.to };
    log(`people_pulse: ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    chat.close();
  }
}

/* ------------------------------------------------------------------ grading */

export function readHandLabels(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

/**
 * Per-type message-level precision/recall of `predicted` (Map msg_id -> [statement]) against
 * `truth` (Map msg_id -> [statement]) over the message ids in `universe`.
 */
export function gradeLabels(universe, predicted, truth, types) {
  const per = {};
  for (const type of types) {
    let tp = 0; let fp = 0; let fn = 0;
    for (const id of universe) {
      const p = (predicted.get(id) ?? []).some(s => s.type === type);
      const t = (truth.get(id) ?? []).some(s => s.type === type);
      if (p && t) tp += 1; else if (p) fp += 1; else if (t) fn += 1;
    }
    per[type] = { tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null,
      recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
  }
  const sum = k => Object.values(per).reduce((a, r) => a + r[k], 0);
  const tp = sum('tp'); const fp = sum('fp'); const fn = sum('fn');
  const micro = { tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
  micro.f1 = micro.precision && micro.recall ? +((2 * micro.precision * micro.recall) / (micro.precision + micro.recall)).toFixed(3) : 0;
  return { per, micro };
}

export async function grade(dir, { leagueId = DEFAULT_LEAGUE, since = '2026-07-01' } = {}) {
  const { db } = await import('../../server/db/index.js');
  const { openChatDb } = await import('../../server/services/manager-signals.js');
  const P = await import('../../server/services/people/pulse.js');
  const chat = openChatDb();
  if (!chat) throw new Error('grade: chat DB not found (GRIDIRON_CHAT_DB_PATH)');
  try {
    const speakers = P.speakerMap(leagueId, db);
    const names = [...speakers.keys()];
    const msgs = chat.prepare(`SELECT msg_id, name, ts_utc, text FROM messages WHERE is_from_me = 0 AND COALESCE(is_tapback, 0) = 0
        AND text IS NOT NULL AND length(trim(text)) > 0 AND ts_utc >= ? AND name IN (${names.map(() => '?').join(',')})`)
      .all(since, ...names);
    const lexicon = P.buildLexicon(P.leaguePlayers(leagueId, db),
      { firstNameCounts: P.firstNameCounts(db), excludeWords: P.memberWords(leagueId, db) });
    const ownership = P.ownershipTimeline(leagueId, db);
    const universe = new Set(msgs.map(m => m.msg_id));
    const predicted = new Map();
    for (const m of msgs) {
      const s = P.labelMessage(m.text, { speakerRoster: speakers.get(m.name), lexicon, owners: ownership.at(m.ts_utc),
        jev: P.jevFeatures(chat, m.msg_id) });
      if (s.length) predicted.set(m.msg_id, s);
    }
    const truth = new Map();
    let outside = 0;
    for (const l of readHandLabels(dir)) {
      if (l.league_ref !== 'L4') continue;
      if (!universe.has(l.msg_id)) { outside += 1; continue; }
      if (!truth.has(l.msg_id)) truth.set(l.msg_id, []);
      truth.get(l.msg_id).push(l);
    }
    const g = gradeLabels(universe, predicted, truth, P.STATEMENT_TYPES);
    // WANT_PLAYER: of the messages both call WANT_PLAYER, how often the player sets overlap.
    let both = 0; let overlap = 0;
    for (const [id, ts] of truth) {
      const t = ts.filter(s => s.type === 'WANT_PLAYER').flatMap(s => s.players ?? []);
      const p = (predicted.get(id) ?? []).filter(s => s.type === 'WANT_PLAYER').flatMap(s => s.players);
      if (!t.length || !p.length) continue;
      both += 1;
      if (p.some(x => t.includes(x))) overlap += 1;
    }
    const credibleTruth = [...truth.values()].filter(ts => ts.some(s => s.type === 'WANT_PLAYER')).length;
    const credibleHit = [...truth.keys()].filter(id => truth.get(id).some(s => s.type === 'WANT_PLAYER')
      && (predicted.get(id) ?? []).some(s => s.type === 'WANT_PLAYER')).length;
    return { messages: msgs.length, labelled_truth_msgs: truth.size, truth_outside_slice: outside,
      predicted_msgs: predicted.size, ...g, want_player_players: { both, overlap },
      credible_recall: { truth: credibleTruth, hit: credibleHit } };
  } finally {
    chat.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const leagueId = Number(arg(args, '--league', DEFAULT_LEAGUE));
  const gradeDir = arg(args, '--grade');
  if (gradeDir) {
    console.log(JSON.stringify(await grade(gradeDir, { leagueId }), null, 1));
    return 0;
  }
  const r = await runPulse({ leagueId });
  return r.status === 'ok' || r.status === 'no_chat_db' ? 0 : 1;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
