/**
 * ONE-READER ratchet: only server/services/people/profile-reader.js may parse
 * negotiation_profiles.profile_json (PEOPLE-WIRING.md: "no consumer parses
 * profile_json itself"; FIELD-REGISTRY.md: people.profile has one producer).
 *
 * A file "parses profile_json" when it names profile_json and calls JSON.parse.
 * LEGACY lists the files that still did when the ratchet landed; each switches
 * to parseProfileJson / peopleProfile in a follow-up and is then removed here.
 * The list can only shrink: a new file fails, and a listed file that no longer
 * parses fails until its line is deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READER = 'server/services/people/profile-reader.js';
const LEGACY = new Map([
  ['server/services/counterparty-pricing.js', 'negotiationProfilesFor: switch to parseProfileJson / peopleProfile'],
  ['scripts/check-negotiation-profiles.mjs', 'switch to peopleProfileFromChat'],
  ['scripts/build-negotiation-profiles.mjs', 'the writer; its prior-row check should use parseProfileJson + readProfile'],
]);
const DIRS = ['server', 'scripts', 'client/src'];
const EXT = /\.(m?js|cjs|ts|tsx|jsx)$/;

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (EXT.test(e.name)) out.push(rel);
  }
  return out;
}

const parsers = DIRS.flatMap(d => walk(d)).filter(f => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return src.includes('profile_json') && /JSON\.parse\s*\(/.test(src);
});

test('ONE-READER: no new file parses profile_json outside the reader', () => {
  const extra = parsers.filter(f => f !== READER && !LEGACY.has(f));
  assert.deepEqual(extra, [], `read profiles through ${READER} (parseProfileJson / peopleProfile)`);
});

test('ONE-READER: the legacy list only shrinks', () => {
  const gone = [...LEGACY.keys()].filter(f => !parsers.includes(f));
  assert.deepEqual(gone, [], 'these no longer parse profile_json: delete their LEGACY lines');
  assert.ok(LEGACY.size <= 3, 'the list never grows');
});

test('ONE-READER: the reader is the one that parses', () => {
  assert.ok(parsers.includes(READER));
});
