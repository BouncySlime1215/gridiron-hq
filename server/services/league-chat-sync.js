/**
 * Pulling the league chat, from the one machine that can.
 *
 * `data/derived/league_chat.sqlite` is the only thing this project runs on that
 * cannot be fetched from anywhere: it is extracted from `~/Library/Messages/chat.db`
 * by `scripts/chat/extract_league_chat.py`, which needs a Mac and Full Disk
 * Access. Everything the Trade Brain knows about how each manager talks comes
 * out of it, so when the rest of the app moves to a cloud box this is the single
 * step that still has to happen on Nick's laptop.
 *
 * Hence the shape here. `status()` works anywhere and answers the question a
 * cloud box actually has — how old is the corpus I am pricing trades on — while
 * `pull()` only runs where chat.db exists. The UI shows the first everywhere and
 * offers the second only where it can work, rather than presenting a button that
 * fails on the machine it is most likely to be clicked from.
 *
 * Nothing in here reads message text. The extractor owns that; this owns when it
 * last ran, whether it can run here, and getting its output to the box that
 * needs it.
 */
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { row, run } from '../db/index.js';
import { chatDbPath } from './manager-signals.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTRACTOR = path.join(ROOT, 'scripts/chat/extract_league_chat.py');

/** Where the extractor reads from. Overridable so a smoke run can point at a copy. */
export function messagesDbPath() {
  return process.env.LEAGUE_CHAT_SRC || path.join(os.homedir(), 'Library/Messages/chat.db');
}

/**
 * Can this machine actually extract?
 *
 * Three things have to be true, and they fail for different reasons worth
 * telling apart: the extractor script is in the repo (it always is), Messages
 * has a database here (false on any Linux box, which is the cloud case), and we
 * can open it (false on a Mac without Full Disk Access — the file exists and
 * every read throws, which is the confusing one).
 */
export function extractionCapability() {
  if (!existsSync(EXTRACTOR)) {
    return { can: false, reason: 'missing_script',
      detail: 'scripts/chat/extract_league_chat.py is not in this checkout.' };
  }
  const src = messagesDbPath();
  if (!existsSync(src)) {
    return { can: false, reason: 'no_messages_db',
      detail: 'No Messages database on this machine — this is a cloud box, not the Mac. '
        + 'Pull from the laptop; the corpus is uploaded from there.' };
  }
  try {
    const probe = new DatabaseSync(src, { readOnly: true });
    probe.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    probe.close();
  } catch (e) {
    return { can: false, reason: 'no_disk_access',
      detail: 'Messages is here but cannot be opened — grant Full Disk Access to the terminal '
        + `running the server, then try again. (${e.message})` };
  }
  return { can: true, reason: null, detail: null };
}

const SETTING_LAST_PULL = 'league_chat_last_pull';

/** The last pull's own record. Stored in app_settings so it survives a restart. */
export function lastPull() {
  const raw = row(`SELECT value FROM app_settings WHERE key = ?`, SETTING_LAST_PULL)?.value;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function recordPull(entry) {
  run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  SETTING_LAST_PULL, JSON.stringify(entry));
}

/** What is actually in the corpus right now. null when there is no corpus at all. */
export function corpusStats() {
  const file = chatDbPath();
  if (!existsSync(file)) return null;
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return null; }
  const count = t => {
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; }
  };
  const out = {
    path: file,
    size_bytes: statSync(file).size,
    messages: count('messages'),
    classified: count('jev_chat_signals'),
    managers: count('manager_chat_profile'),
    sentiment_rows: count('manager_player_sentiment'),
    newest_message: null,
  };
  // `ts_utc`, not `sent_at`. The old query named a column this table has never
  // had (`extract_league_chat.py:84`), so it threw on every corpus and a bare
  // catch turned that into `newest_message: null` — the swallowed fault, and
  // the reason "how old is the chat data" could not be answered from here at
  // all. A genuinely older corpus with no such column is still tolerated, but
  // it is reported as a reason rather than as silence.
  try {
    out.newest_message = isoStamp(db.prepare('SELECT MAX(ts_utc) AS m FROM messages').get()?.m);
  } catch (e) {
    out.newest_message = null;
    out.newest_message_error = `messages.ts_utc is not readable on this corpus: ${String(e?.message ?? e)}`;
  }
  try {
    out.rolled_up_at = isoStamp(db.prepare('SELECT MAX(computed_at) AS m FROM manager_chat_profile').get()?.m);
  } catch { out.rolled_up_at = null; }
  db.close();
  return out;
}

/**
 * Every stamp the chat side serves, in ISO 8601 UTC.
 *
 * The extractor now writes ISO, but a corpus pulled before that change carries
 * SQLite's `YYYY-MM-DD HH:MM:SS`, and those two do not sort against each other
 * (`T` is 0x54, space is 0x20, so any ISO row beats every legacy row whatever
 * its date). Normalising on the way out is what lets one card carry chat's
 * `as_of` beside the transactions' and the archetype build's, both of which are
 * `new Date().toISOString()`.
 *
 * Unparseable input returns null rather than a guess: a wrong date on a
 * freshness badge is worse than no date.
 */
export function isoStamp(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T').replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, '')}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.000Z$/, 'Z') : null;
}

/**
 * How stale the counterparty read is, in the terms the UI shows.
 *
 * Deliberately blunt: a corpus nobody has refreshed in days is the difference
 * between the Trade Brain knowing who has been talking up which player this
 * week and it working from last week's mood. `fresh` is the only state where
 * the trade cards can be taken at face value without a second thought.
 */
export function freshness(stats, pull) {
  const age = stats?.newest_message ? isoStamp(stats.newest_message) : null;
  // Provenance, never an age. The rollup stamp says when the profiles were
  // rebuilt and the pull stamp says when this machine last ran the extractor;
  // neither is how old the conversation is, and both can be newer than the
  // newest message by days.
  const provenance = pull?.finished_at
    ? `pulled on this machine ${isoStamp(pull.finished_at)}`
    : (stats?.messages ? 'uploaded, not pulled here' : null);
  const rolled = stats?.rolled_up_at ? `; profiles rebuilt ${stats.rolled_up_at}` : '';

  if (!stats || !stats.messages) {
    // "Not on this machine", not "not pulled recently". The corpus comes out of
    // Apple Messages via a script that needs a Mac and Full Disk Access, so on
    // the deployed box this state is permanent and correct, and a reader who
    // takes it for a broken sync goes looking for a server job that does not
    // and should not exist. It can still be uploaded here, which is the half a
    // "cannot be produced here" sentence leaves out.
    return { state: 'absent', label: 'No chat data here', as_of: null, provenance: null,
      note: `Nothing at ${chatDbPath()}. The corpus is extracted from Apple Messages on the Mac and cannot be `
        + 'produced on this machine — pull it there and upload it. Until then every ladder is priced on our '
        + 'numbers only, and the counterparty half of the Trade Brain is off.' };
  }
  if (!age) {
    // Messages exist and none of them can be dated. Rare, and genuinely
    // unknown: reporting it as fresh or stale would be inventing an answer.
    return { state: 'unknown', label: 'Chat data of unknown age', as_of: null, provenance,
      note: stats.newest_message_error
        ?? 'The corpus has messages but no readable timestamp on any of them.' };
  }
  const hours = (Date.now() - Date.parse(age)) / 3.6e6;
  const said = `Newest message ${age}${provenance ? ` (${provenance})` : ''}${rolled}.`;
  if (hours < 12) return { state: 'fresh', label: 'Up to date', as_of: age, provenance, note: said };
  if (hours < 48) {
    return { state: 'aging', label: `${Math.round(hours)} hours old`, as_of: age, provenance,
      note: `${said} Still usable. Pull before acting on a timing read.` };
  }
  return { state: 'stale', label: `${Math.round(hours / 24)} days old`, as_of: age, provenance,
    note: `${said} Sentiment and timing reads are from before this week. Pull from the laptop.` };
}

/**
 * Which client state each upstream state becomes.
 *
 * The client types `state` as a closed union and colours off it
 * (`LeagueChatPull.tsx`), so the four states the corpus can actually be in are
 * mapped onto it here rather than being widened. Written down because a
 * mapping that lives only in the branches above is folklore: the next person
 * to add a state has to be able to see what it should collapse to.
 */
export const STATE_MAPPING = Object.freeze({
  no_path_configured: 'absent',
  file_not_on_this_machine: 'absent',
  present_but_no_messages: 'absent',
  present_but_undatable: 'unknown',
  present_and_dated: 'fresh | aging | stale, by the age of the newest message',
});

/**
 * Everything the panel needs, in one call, from any machine.
 *
 * `path` is at the top level, not only inside `corpus`, because the case that
 * needs it most is the one where `corpus` is null: on a box with no file there
 * is nothing else to say, and "we looked here" is the whole answer. It was
 * assembled inside `corpusStats()` and read by nothing, which meant the absent
 * state was the one state that said least.
 */
export function status() {
  const stats = corpusStats();
  const pull = lastPull();
  return {
    capability: extractionCapability(),
    path: chatDbPath(),
    corpus: stats,
    last_pull: pull,
    freshness: freshness(stats, pull),
  };
}

/**
 * Run the extractor.
 *
 * Incremental by default, which is the whole point of clicking this more than
 * once: the script only reads rows newer than the highest it has already
 * stored, so a second pull minutes later is cheap and changes nothing. `--full`
 * is there for a genuine rebuild and is never the default.
 *
 * `--classify` and `--rollup` follow in the same run because a pull that
 * collects messages and leaves them unlabelled moves no number the Trade Brain
 * reads: the sentiment and profile tables are what it actually opens.
 */
export function pull({ full = false, timeoutMs = 10 * 60 * 1000 } = {}) {
  const cap = extractionCapability();
  if (!cap.can) return Promise.resolve({ ok: false, ...cap });

  const python = process.env.GRIDIRON_RESEARCH_PYTHON || 'python3';
  const args = [EXTRACTOR, ...(full ? ['--full'] : []), '--classify', '--rollup'];
  const started = new Date().toISOString();

  return new Promise(resolve => {
    const child = spawn(python, args, { cwd: ROOT, env: process.env });
    let out = '', err = '';
    let timer = setTimeout(() => { timer = null; child.kill('SIGTERM'); }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn_failed',
        detail: `Could not run ${python}: ${e.message}`, started_at: started });
    });
    child.on('close', code => {
      const timedOut = timer === null;
      if (timer) clearTimeout(timer);
      const finished = new Date().toISOString();
      const stats = corpusStats();
      const entry = {
        started_at: started, finished_at: finished, ok: code === 0 && !timedOut,
        full, exit_code: code,
        messages: stats?.messages ?? null, classified: stats?.classified ?? null,
      };
      // A failed pull is recorded too — a panel that silently keeps showing the
      // last SUCCESSFUL pull's timestamp is how a stale corpus passes for fresh.
      recordPull(entry);
      resolve({
        ok: entry.ok,
        reason: timedOut ? 'timeout' : entry.ok ? null : 'extractor_failed',
        detail: timedOut
          ? `The extractor ran past ${Math.round(timeoutMs / 60000)} minutes and was stopped.`
          : entry.ok ? null : (err.trim().split('\n').slice(-5).join('\n') || `exit ${code}`),
        log: out.trim().split('\n').slice(-20).join('\n'),
        ...entry,
        corpus: stats,
      });
    });
  });
}
