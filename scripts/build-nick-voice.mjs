#!/usr/bin/env node
/**
 * VOICE-01: build Nick's style profiles into the private chat DB (table nick_voice_profile).
 *
 *   node scripts/build-nick-voice.mjs [--db <chat db>] [--dry-run]
 *
 * Reads Nick's own texts (messages + messages_ext, is_from_me = 1, tapbacks removed), computes
 * one profile per scope with server/services/coach/voice.js#buildVoiceProfiles and replaces the
 * table's rows in one transaction. --db defaults to the chat DB the server reads (chatDbPath).
 * Prints counts only; no message text is printed, logged or written anywhere but that DB.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { buildVoiceProfiles, corpusHash, readBursts, readMine, PROFILE_TABLE } from '../server/services/coach/voice.js';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes('--dry-run');
const file = opt('--db') ?? (await import('../server/services/manager-signals.js')).chatDbPath();
if (!existsSync(file)) { console.error(`no chat DB at ${file}`); process.exit(1); }

const chat = new DatabaseSync(file, { readOnly: dry });
chat.exec('PRAGMA busy_timeout = 5000');
const mine = readMine(chat);
const scopes = buildVoiceProfiles(mine, { burstsBy: readBursts(chat) });
const hash = corpusHash(mine);
const now = new Date().toISOString();

if (!dry) {
  chat.exec(`CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE} (
    scope TEXT PRIMARY KEY, kind TEXT NOT NULL, n INTEGER NOT NULL, profile_json TEXT NOT NULL,
    corpus_hash TEXT, built_at TEXT NOT NULL)`);
  chat.exec('BEGIN');
  try {
    chat.exec(`DELETE FROM ${PROFILE_TABLE}`);
    const ins = chat.prepare(`INSERT INTO ${PROFILE_TABLE} (scope, kind, n, profile_json, corpus_hash, built_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const s of scopes) ins.run(s.scope, s.kind, s.n, JSON.stringify(s.profile), hash, now);
    chat.exec('COMMIT');
  } catch (e) { chat.exec('ROLLBACK'); throw e; }
}
chat.close();

const kinds = scopes.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {});
console.log(JSON.stringify({ texts: mine.length, scopes: scopes.length, kinds, corpus_hash: hash, written: !dry }));
