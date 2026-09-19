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
  try {
    out.newest_message = db.prepare('SELECT MAX(sent_at) AS m FROM messages').get()?.m ?? null;
  } catch { /* an older corpus without the column reports null rather than failing the page */ }
  db.close();
  return out;
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
  if (!stats || !stats.messages) {
    return { state: 'absent', label: 'No chat data',
      note: 'Every ladder is priced on our numbers only — the counterparty half of the Trade Brain is off.' };
  }
  const at = pull?.finished_at ? Date.parse(pull.finished_at) : null;
  if (!at) return { state: 'unknown', label: 'Never pulled from here', note: 'The corpus was uploaded, not pulled on this machine.' };
  const hours = (Date.now() - at) / 3.6e6;
  if (hours < 12) return { state: 'fresh', label: 'Up to date', note: null };
  if (hours < 48) return { state: 'aging', label: `${Math.round(hours)} hours old`,
    note: 'Still usable. Pull before acting on a timing read.' };
  return { state: 'stale', label: `${Math.round(hours / 24)} days old`,
    note: 'Sentiment and timing reads are from before this week. Pull from the laptop.' };
}

/** Everything the panel needs, in one call, from any machine. */
export function status() {
  const stats = corpusStats();
  const pull = lastPull();
  return {
    capability: extractionCapability(),
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
