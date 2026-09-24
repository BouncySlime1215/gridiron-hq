/**
 * ONE-READER ratchet: only server/services/people/profile-reader.js may parse
 * negotiation_profiles.profile_json (PEOPLE-WIRING.md: "no consumer parses
 * profile_json itself"; FIELD-REGISTRY.md: people.profile has one producer).
 *
 * READER-SWITCH: the three legacy files now read through the reader and LEGACY
 * is empty. The rule is per read, not per file: the ONE-READER version flagged
 * any file that named profile_json and called JSON.parse anywhere, which held
 * the profile builder for parsing the league payload. Outside the reader a file
 * parses profile_json when
 *   - a JSON.parse( call names profile_json on its line, or
 *   - it reads a `.profile_json` / `['profile_json']` property, or destructures
 *     profile_json, on a line that does not hand it to parseProfileJson(.
 * That is stricter than before in one way: handing a stored row's text to
 * anything but parseProfileJson fails even when the file never calls JSON.parse.
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
const LEGACY = new Map([]);
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

const PARSE_LINE = /JSON\.parse\s*\([^\n]*profile_json/;
const READ_LINE = /(\.profile_json\b|\[\s*['"`]profile_json['"`]\s*\]|\{[^}\n]*\bprofile_json\b[^}\n]*\}\s*=)/;
/** The offending lines of one source text (1-based line numbers). */
export function profileJsonParses(src) {
  return src.split('\n').flatMap((line, i) => (PARSE_LINE.test(line)
    || (READ_LINE.test(line) && !/\bparseProfileJson\s*\(/.test(line)) ? [i + 1] : []));
}

const parsers = DIRS.flatMap(d => walk(d)).filter(f => f !== READER
  && profileJsonParses(fs.readFileSync(path.join(ROOT, f), 'utf8')).length);

test('ONE-READER: no new file parses profile_json outside the reader', () => {
  const extra = parsers.filter(f => !LEGACY.has(f));
  assert.deepEqual(extra, [], `read profiles through ${READER} (parseProfileJson / peopleProfile)`);
});

test('ONE-READER: the legacy list only shrinks', () => {
  const gone = [...LEGACY.keys()].filter(f => !parsers.includes(f));
  assert.deepEqual(gone, [], 'these no longer parse profile_json: delete their LEGACY lines');
  assert.equal(LEGACY.size, 0, 'the list never grows (READER-SWITCH emptied it)');
});

test('ONE-READER: the reader is the one that parses', () => {
  const src = fs.readFileSync(path.join(ROOT, READER), 'utf8');
  assert.match(src, /export function parseProfileJson\(/);
  assert.match(src, /JSON\.parse\(json\)/);
});

test('READER-SWITCH: the per-read rule catches what it should', () => {
  assert.deepEqual(profileJsonParses('const p = JSON.parse(r.profile_json);'), [1]);
  assert.deepEqual(profileJsonParses('const t = r.profile_json;\nconst p = JSON.parse(t);'), [1],
    'a read handed to anything but parseProfileJson');
  assert.deepEqual(profileJsonParses("const t = r['profile_json'];"), [1]);
  assert.deepEqual(profileJsonParses('const { profile_json } = row;'), [1]);
  assert.deepEqual(profileJsonParses('const { raw } = parseProfileJson(r.profile_json);'), []);
  assert.deepEqual(profileJsonParses("db.prepare('SELECT profile_json FROM negotiation_profiles');"), []);
  assert.deepEqual(profileJsonParses('const league = JSON.parse(row.payload);'), []);
});

// ---------------------------------------------------------------- the rebuild
// scripts/build-negotiation-profiles.mjs runs nothing on import (IS_MAIN guard).

const build = await import('../scripts/build-negotiation-profiles.mjs');
const reader = await import('../server/services/people/profile-reader.js');

function storedRow(extra = {}) {
  return {
    headline: 'h', says_no: { how: 'plain', does_his_no_hold: 'rarely (one exception)', evidence: ['e'] },
    praise_means: { reading: 'marketing — hypes', why: 'w', evidence: ['e'] },
    techniques: [{ name: 't', how_he_does_it: 'h', evidence: ['e'], how_often: 'often (8 offers)' }],
    calibration: { enthusiasm_scale: 's', inflation: 'moderate' },
    what_moves_him: ['m'], how_to_approach: 'a', confidence: 'High.', caveats: ['c'],
    as_of: '2026-09-22', messages_read: 90, ...extra,
  };
}

test('READER-SWITCH: a stored row is checked with schema v2, not the model tool schema', () => {
  const row = storedRow({ nick_override: { buyer: false, contactable: true } });
  assert.deepEqual(build.storedProfileErrors(reader.parseProfileJson(JSON.stringify(row))), [],
    'sentences in enum slots and nick_override are valid stored shapes');
  assert.deepEqual(build.storedProfileErrors(reader.parseProfileJson('{not json')), ['unparseable JSON']);
  assert.ok(build.storedProfileErrors(reader.parseProfileJson(JSON.stringify(storedRow({ nick_overide: {} }))))
    .some(e => /unexpected key/.test(e)), 'a typo is still malformed');
});

test('READER-SWITCH: a rebuild never overwrites nick_override', () => {
  const override = { buyer: false, active: 'yes', note: 'set by hand', fan_of: ['Team Z'] };
  const prior = reader.parseProfileJson(JSON.stringify(storedRow({ nick_override: override }))).raw;
  const modelOutput = storedRow({ headline: 'new read' }); // the model never writes nick_override
  const merged = build.withNickOverride(modelOutput, prior);
  assert.deepEqual(merged.nick_override, override);
  assert.equal(merged.headline, 'new read', 'the model output is kept otherwise');
  assert.equal(modelOutput.nick_override, undefined, 'the model output object is not mutated');
  assert.deepEqual(build.withNickOverride({ ...modelOutput, nick_override: { buyer: true } }, prior).nick_override,
    override, 'even an override the model wrote loses to the stored one');
  assert.equal(build.withNickOverride(modelOutput, null), modelOutput, 'no prior row: unchanged');
  assert.equal(build.withNickOverride(modelOutput, { nick_override: 'x' }), modelOutput, 'not an object: unchanged');
  assert.deepEqual(build.storedProfileErrors(reader.parseProfileJson(merged)), [], 'the merged row is one the reader accepts');
});
