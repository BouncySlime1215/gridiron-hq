/**
 * ARCHITECTURE (plan item 40): docs/ARCHITECTURE.md is generated from the code and a small checked
 * registry, so it cannot drift. These tests are the drift gate CI runs through `npm test`:
 *
 *   - the committed page equals what the generator writes from today's tree;
 *   - every plans.json section and every served source id has exactly one producer in the registry;
 *   - every producer the registry names exists (file and symbol), so a rename breaks the build, not the page;
 *   - every GRIDIRON_* flag the server or scripts read is listed, by name only (never a value).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECTIONS, SOURCE_IDS } from '../server/services/campaign/plans-schema.js';
import {
  ROOT, REGISTRY_PATH, OUT_PATH, readRegistry, validateRegistry, resolveRef, scanFlags, flagKind, renderArchitecture
} from '../scripts/architecture-map.mjs';

const registry = readRegistry();

test('the committed ARCHITECTURE.md is what the generator writes today (run `npm run map:architecture`)', () => {
  const want = renderArchitecture({ registry });
  const have = fs.readFileSync(OUT_PATH, 'utf8');
  assert.equal(have, want, 'docs/ARCHITECTURE.md is stale: run `npm run map:architecture` and commit the result');
});

test('the registry is valid against today\'s tree', () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test('every plans.json section has exactly one producer, and no stale section is listed', () => {
  assert.deepEqual(Object.keys(registry.sections).sort(), Object.keys(SECTIONS).sort());
});

test('every served source id has exactly one producer, and no stale source is listed', () => {
  assert.deepEqual(Object.keys(registry.sources).sort(), [...SOURCE_IDS].sort());
});

test('a section added to the schema without a producer is refused', () => {
  const bad = structuredClone(registry);
  delete bad.sections.next_move;
  const errs = validateRegistry(bad);
  assert.ok(errs.some(e => /section next_move has no producer/.test(e)), errs.join('\n'));
});

test('a producer whose symbol no longer exists is refused', () => {
  const bad = structuredClone(registry);
  bad.sections.next_move.computed_by = 'server/services/campaign/planner.js#noSuchFunction';
  const errs = validateRegistry(bad);
  assert.ok(errs.some(e => /noSuchFunction/.test(e)), errs.join('\n'));
});

test('a producer whose file no longer exists is refused', () => {
  const bad = structuredClone(registry);
  bad.sources['market.fc'].producer = 'server/services/gone.js#fcValues';
  const errs = validateRegistry(bad);
  assert.ok(errs.some(e => /gone\.js/.test(e)), errs.join('\n'));
});

test('a source listed that the schema no longer has is refused', () => {
  const bad = structuredClone(registry);
  bad.sources['old.source'] = { producer: 'server/services/fc-value.js#fcValues', what: 'x' };
  const errs = validateRegistry(bad);
  assert.ok(errs.some(e => /old\.source/.test(e)), errs.join('\n'));
});

test('resolveRef finds exported functions, consts and re-exports, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  fs.writeFileSync(path.join(dir, 'm.js'), [
    'export function a() {}', 'export async function b() {}', 'export const c = 1;',
    'function d() {}', 'export { d as e };', '// export function ghost() {}'
  ].join('\n'));
  for (const s of ['a', 'b', 'c', 'd']) assert.equal(resolveRef(`m.js#${s}`, dir), null, s);
  assert.match(resolveRef('m.js#ghost', dir), /ghost/);
  assert.match(resolveRef('m.js#zzz', dir), /zzz/);
  assert.match(resolveRef('nope.js#a', dir), /nope\.js/);
  assert.match(resolveRef('m.js', dir), /file#symbol/);
});

test('scanFlags lists GRIDIRON_* names with their readers, skips tests, and reads no values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'a.js'), "const on = process.env.GRIDIRON_ALPHA === '1'; import { previewUnconfirmed } from './p.js';");
  fs.writeFileSync(path.join(dir, 'scripts', 'b.mjs'), "const t = process.env.GRIDIRON_CHAT_TOKEN; const k = 'GRIDIRON_ALPHA';");
  fs.writeFileSync(path.join(dir, 'test', 'c.test.js'), "process.env.GRIDIRON_TEST_ONLY = '1';");
  const flags = scanFlags(dir);
  assert.deepEqual(flags.map(f => f.name), ['GRIDIRON_ALPHA', 'GRIDIRON_CHAT_TOKEN']);
  assert.deepEqual(flags[0].files, ['scripts/b.mjs', 'server/a.js']);
  assert.equal(flags[0].preview, true);
  assert.equal(flags[1].preview, false);
});

test('flagKind separates switches from settings and secrets by name', () => {
  assert.equal(flagKind('GRIDIRON_WANTS'), 'switch');
  assert.equal(flagKind('GRIDIRON_IS_TITLE'), 'switch');
  assert.equal(flagKind('GRIDIRON_CHAT_TOKEN'), 'secret');
  assert.equal(flagKind('GRIDIRON_GOOGLE_CLIENT_SECRET'), 'secret');
  assert.equal(flagKind('GRIDIRON_ANTHROPIC_API_KEY'), 'secret');
  assert.equal(flagKind('GRIDIRON_DB_PATH'), 'setting');
  assert.equal(flagKind('GRIDIRON_OFFER_WATCH_IDLE_SECONDS'), 'setting');
  assert.equal(flagKind('GRIDIRON_WARROOM_LEAGUES'), 'setting');
});

test('the page lists every flag the tree reads, and every registry producer', () => {
  const md = fs.readFileSync(OUT_PATH, 'utf8');
  for (const f of scanFlags(ROOT)) assert.ok(md.includes(`\`${f.name}\``), f.name);
  for (const [k, v] of Object.entries(registry.sections)) {
    assert.ok(md.includes(`| \`${k}\` |`), k);
    assert.ok(md.includes(v.computed_by.split('#')[1]), v.computed_by);
  }
  for (const k of SOURCE_IDS) assert.ok(md.includes(`| \`${k}\` |`), k);
});

test('the page carries no env values, only names', () => {
  const md = fs.readFileSync(OUT_PATH, 'utf8');
  assert.doesNotMatch(md, /GRIDIRON_[A-Z0-9_]+=\S/);
});

test('the registry file is the one the generator reads', () => {
  assert.equal(path.relative(ROOT, REGISTRY_PATH), path.join('docs', 'architecture', 'registry.json'));
});
