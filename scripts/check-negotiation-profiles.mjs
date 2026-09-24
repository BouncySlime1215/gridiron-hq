#!/usr/bin/env node
/**
 * Read-only check of the stored negotiation profiles against the v2 reader
 * (server/services/people/profile-reader.js), for a run on a DB copy. Every
 * profile_json goes through the reader's parseProfileJson + readProfile.
 *
 * Prints counts and schema paths only. No manager name, no profile text and no
 * chat text is printed: rows are numbered, and error messages name paths, not
 * values.
 *
 *   node scripts/check-negotiation-profiles.mjs
 *
 * Reads GRIDIRON_CHAT_DB_PATH (profiles, manager_notes) and GRIDIRON_DB_PATH
 * (which leagues have trusted chat identities). Exits 1 if any row is invalid.
 */
import { DatabaseSync } from 'node:sqlite';
import { parseProfileJson, readProfile } from '../server/services/people/profile-reader.js';

const chatPath = process.env.GRIDIRON_CHAT_DB_PATH;
if (!chatPath) throw new Error('GRIDIRON_CHAT_DB_PATH is not set');
const chat = new DatabaseSync(chatPath, { readOnly: true });
const stored = chat.prepare('SELECT profile_json FROM negotiation_profiles ORDER BY name').all();
let notes = null;
try {
  notes = chat.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT name) AS people FROM manager_notes').get();
} catch (e) {
  if (!/no such table/.test(String(e?.message))) throw e;
}
chat.close();

let valid = 0;
const keyCounts = new Map();
const lines = [];
stored.forEach((r, i) => {
  const { raw: parsed, error } = parseProfileJson(r.profile_json);
  if (error) { lines.push(`row ${i + 1}: ${error}`); return; }
  for (const k of Object.keys(parsed ?? {})) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  const { errors, unparsed, profile } = readProfile(parsed);
  if (!errors.length) valid++;
  const override = profile?.nick_override ? Object.keys(profile.nick_override).sort().join(',') || '(empty)' : '-';
  lines.push(`row ${i + 1}: ${errors.length ? 'INVALID' : 'valid'}; unparsed ${unparsed.length}; nick_override keys ${override}`);
  for (const e of errors) lines.push(`  error ${e}`);
  for (const u of unparsed) lines.push(`  unparsed ${u}`);
});

console.log(`negotiation_profiles: ${valid}/${stored.length} valid under schema v2`);
for (const l of lines) console.log(l);
console.log(`top-level keys: ${[...keyCounts].sort().map(([k, n]) => `${k}=${n}`).join(' ')}`);
console.log(notes ? `manager_notes: ${notes.n} rows, ${notes.people} people` : 'manager_notes: no table');

if (process.env.GRIDIRON_DB_PATH) {
  const { negotiationProfilesFor } = await import('../server/services/counterparty-pricing.js');
  const { peopleProfile } = await import('../server/services/people/profile-reader.js');
  const { isDeepStrictEqual } = await import('node:util');
  const { rows } = await import('../server/db/index.js');
  const leagues = rows(`SELECT DISTINCT league_id FROM league_member_identity
                        WHERE chat_name IS NOT NULL ORDER BY league_id`).map(r => r.league_id);
  for (const id of leagues) {
    const r = negotiationProfilesFor(id);
    const people = await peopleProfile(id);
    const withNick = [...r.nickByRoster.values()];
    const fields = from => withNick.reduce((n, x) => n + Object.values(x.sources).filter(f => f === from).length, 0);
    // The loader and people.profile are one reader; a disagreement here is a bug.
    const disagree = [...new Set([...r.nickByRoster.keys(), ...(people.byRoster?.keys() ?? [])])]
      .filter(rid => !isDeepStrictEqual(r.nickByRoster.get(rid) ?? null, people.byRoster?.get(rid)?.nick ?? null)).length;
    console.log(`league ${id}: available=${r.available} byRoster=${r.byRoster.size} self=${r.self ? 1 : 0}`
      + ` invalid=${r.invalid.length} unmapped=${r.unmapped.length} nickByRoster=${r.nickByRoster.size}`
      + ` nick_override_fields=${fields('nick_override')} notes_fields=${fields('manager_notes')}`
      + ` nick_disagreements_vs_people_profile=${disagree}`
      + (r.notes_reason ? ` notes_reason="${r.notes_reason}"` : ''));
  }
}
process.exit(valid === stored.length ? 0 : 1);
