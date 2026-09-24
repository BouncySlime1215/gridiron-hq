/**
 * PEOPLE-01 ratchet: the chat psychology tables are read through
 * server/services/people/profile-reader.js and nowhere else.
 *
 * Scans every .js/.mjs file under server/ and scripts/ for SQL that names one
 * of the tables (FROM/JOIN/INTO/UPDATE/TABLE, or the bare name as a quoted
 * string). Comment lines are skipped. A file on the allowlist may keep its
 * mentions, each with the reason it is not a profile read; a new file fails.
 * The list only shrinks: an entry that no longer matches fails too, so it is
 * removed the day its last read moves into the reader.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READER = 'server/services/people/profile-reader.js';

const PSYCHOLOGY = ['negotiation_profiles', 'manager_chat_profile', 'manager_player_sentiment', 'manager_notes',
  'entity_map'];

// file -> { table: reason }. Not profile reads; each says what it is instead.
const ALLOWED = {
  'server/services/league-chat-sync.js': {
    manager_chat_profile: 'row count and stamps for the chat-sync status report',
    manager_player_sentiment: 'row count for the chat-sync status report',
  },
  'scripts/build-negotiation-profiles.mjs': {
    negotiation_profiles: 'the WRITER of the profiles',
    manager_chat_profile: 'builder input, off-server',
  },
  'scripts/chat-sync.mjs': { manager_chat_profile: 'row count in the upload summary' },
  'scripts/import-league-chat.mjs': {
    manager_chat_profile: 'copies derived tables between chat DBs',
    manager_player_sentiment: 'copies derived tables between chat DBs',
    negotiation_profiles: 'copies derived tables between chat DBs',
  },
};

// league_member_identity maps people to rosters. The reader reads it through
// identityMap() (manager-identity.js, its owner); these read it directly for
// identity, not psychology. No new file may join them.
const IDENTITY = 'league_member_identity';
const IDENTITY_READERS = new Set([
  'server/services/manager-identity.js',
  'server/services/manager-signals.js',
  'server/services/counterparty-pricing.js',
  'server/services/bluff-detector.js',
  'scripts/build-negotiation-profiles.mjs',
  'scripts/refresh-live-data.mjs',
]);

function files(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(rel);
    return /\.(m?js)$/.test(e.name) ? [rel] : [];
  });
}

const code = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const reads = (src, table) =>
  new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+${table}\b|['"\`]${table}['"\`]`)
    .test(src);

const SCANNED = [...files('server'), ...files('scripts')].filter(f => f !== READER && !f.endsWith('wiring-map.mjs'));

test('ratchet: nothing outside the reader and the allowlist reads the chat psychology tables', () => {
  const found = [];
  for (const f of SCANNED) {
    const src = code(f);
    for (const t of PSYCHOLOGY) if (reads(src, t) && !ALLOWED[f]?.[t]) found.push(`${f}: ${t}`);
  }
  assert.deepEqual(found, [], 'read these through server/services/people/profile-reader.js');
});

test('ratchet: league_member_identity gains no new direct reader', () => {
  const found = SCANNED.filter(f => reads(code(f), IDENTITY) && !IDENTITY_READERS.has(f));
  assert.deepEqual(found, []);
});

test('ratchet: the allowlist only shrinks — every entry still matches', () => {
  const stale = [];
  for (const [f, tables] of Object.entries(ALLOWED)) {
    const src = fs.existsSync(path.join(ROOT, f)) ? code(f) : '';
    for (const t of Object.keys(tables)) if (!reads(src, t)) stale.push(`${f}: ${t}`);
  }
  for (const f of IDENTITY_READERS) {
    if (!fs.existsSync(path.join(ROOT, f)) || !reads(code(f), IDENTITY)) stale.push(`${f}: ${IDENTITY}`);
  }
  assert.deepEqual(stale, [], 'remove these entries: the read moved or is gone');
});

test('ratchet: the reader itself reads every psychology table', () => {
  const src = code(READER);
  for (const t of PSYCHOLOGY) assert.ok(reads(src, t), `${READER} reads ${t}`);
  assert.match(src, /identityMap\(/, 'roster ids come from identityMap');
});

test('ratchet: the three switched consumers import the reader', () => {
  for (const f of ['server/services/counterparty-pricing.js', 'server/services/manager-signals.js',
    'server/services/coach/people/variables.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /from '[./]*people\/profile-reader\.js'/,
      `${f} reads through the reader`);
  }
});
