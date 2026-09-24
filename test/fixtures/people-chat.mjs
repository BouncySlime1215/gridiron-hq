/**
 * Fixture chat DB for the PEOPLE-01 / COUNTERPART-01 tests: made-up people, no real chat data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DAY = 864e5;
export const T0 = Date.parse('2026-09-18T05:30:00Z');

export const richProfile = (extra = {}) => ({
  headline: 'h', says_no: { how: 'short', does_his_no_hold: 'usually', evidence: [] },
  praise_means: { reading: 'belief', why: 'w', evidence: [] }, techniques: [],
  calibration: { enthusiasm_scale: 's', inflation: 'mild' }, what_moves_him: ['need'], how_to_approach: 'direct',
  confidence: 'medium', caveats: [], ...extra,
});

/** A chat DB file with the three tables. notesShape: 'column' | 'kv' | null (no table). */
export function makeChatDb({ negotiation = [], chatProfile = [], notes = [], notesShape = 'column' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-chat-'));
  const file = path.join(dir, 'chat.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE negotiation_profiles (name TEXT, profile_json TEXT, messages_read INTEGER, model TEXT, built_at TEXT, corpus_hash TEXT);
           CREATE TABLE manager_chat_profile (name TEXT, msgs INTEGER, p_competitive REAL, p_friendly REAL, p_defensive REAL, p_open_to_trade REAL, computed_at TEXT);`);
  const ins = db.prepare('INSERT INTO negotiation_profiles VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of negotiation) ins.run(r.name, typeof r.profile === 'string' ? r.profile : JSON.stringify(r.profile), r.messages_read ?? 400, 'fixture', new Date(r.built_at ?? T0).toISOString(), 'h');
  const cp = db.prepare('INSERT INTO manager_chat_profile VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of chatProfile) cp.run(r.name, r.msgs, 0.5, 0.3, 0.2, r.p_open_to_trade ?? 0.2, new Date(r.computed_at ?? T0).toISOString());
  if (notesShape === 'column') {
    db.exec('CREATE TABLE manager_notes (name TEXT, note TEXT, nick_override TEXT, updated_at TEXT)');
    const n = db.prepare('INSERT INTO manager_notes VALUES (?, ?, ?, ?)');
    for (const r of notes) n.run(r.name, 'dossier', r.override, new Date(r.at ?? T0).toISOString());
  } else if (notesShape === 'kv') {
    db.exec('CREATE TABLE manager_notes (manager TEXT, kind TEXT, value TEXT)');
    const n = db.prepare('INSERT INTO manager_notes VALUES (?, ?, ?)');
    for (const r of notes) n.run(r.name, 'nick_override', r.override);
  }
  db.close();
  return new DatabaseSync(file, { readOnly: true });
}

