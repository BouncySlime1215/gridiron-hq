/**
 * Script reach is an entry-point question, not a proximity one.
 *
 * `surfaceFamilies` cut every bucket at the same `hops` limit, and the callers
 * pass CLOSE_HOPS (3). For routes that limit is doing real work — in a monolith
 * this size a module nine hops from a route is sharing a library, not wired into
 * it. For scripts it is wrong by construction: everything in a script's import
 * closure is EXECUTED when that script runs, however far down it sits, and
 * `package.json` naming the script is what CONTRACT.md's `wired` test asks about.
 *
 * The case that found it, reported against this map's own output: nothing in
 * docs/wiring/wiring-map.json recorded a script reach for
 * server/services/nfl-features.js, although `npm run audit:nfl` runs it. The
 * chain below is four hops, and the map stopped at three.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { build, surfaceFamilies, close, CLOSE_HOPS, MAX_HOPS } =
  await import('../scripts/wiring-map.mjs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// build() walks the whole repository; one model serves every case here.
const model = build();
const { importsOf, reachNames } = model;

const SCRIPT = 'scripts/nfl-blind-audit.mjs';
const CHAIN = [
  SCRIPT,
  'server/services/nfl-blind-audit.js',
  'server/services/pick-reasoning.js',
  'server/services/nfl-reasoning.js',
  'server/services/nfl-features.js',
];
const SUBJECT = CHAIN.at(-1);

test('package.json runs the script this chain starts at', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cmds = Object.values(pkg.scripts ?? {});
  assert.ok(cmds.some(c => String(c).includes(SCRIPT)),
    `no package.json script runs ${SCRIPT}; the chain this test pins starts elsewhere`);
});

test('every import edge in the chain is in the map', () => {
  for (let i = 0; i < CHAIN.length - 1; i++) {
    const imports = [...(importsOf.get(CHAIN[i]) ?? [])];
    assert.ok(imports.includes(CHAIN[i + 1]),
      `${CHAIN[i]} does not import ${CHAIN[i + 1]}; imports: ${imports.join(', ')}`);
  }
});

test('the chain is longer than CLOSE_HOPS, which is the point of the case', () => {
  assert.equal(CHAIN.length - 1, 4);
  assert.ok(CHAIN.length - 1 > CLOSE_HOPS);
});

test('nfl-features.js records the script that runs it, at its true hop count', () => {
  const { scripts } = surfaceFamilies(reachNames, [SUBJECT], CLOSE_HOPS);
  const hit = scripts.find(s => s.name === SCRIPT);
  assert.ok(hit, `${SUBJECT} records no reach from ${SCRIPT}; scripts: ${JSON.stringify(scripts)}`);
  assert.equal(hit.hops, CHAIN.length - 1);
});

test('close() keeps a script reach past CLOSE_HOPS', () => {
  const wiring = close(surfaceFamilies(reachNames, [SUBJECT], CLOSE_HOPS));
  assert.ok(wiring.scripts.some(s => s.name === SCRIPT && s.hops > CLOSE_HOPS));
});

test('the proximity cap still binds on routes, jobs and pages', () => {
  // Lifting it for scripts must not lift it for everything: a module far from a
  // route is exactly the "sharing a library" case CLOSE_HOPS exists to exclude.
  let checked = 0;
  for (const f of model.files.values()) {
    if (f.tree === 'test') continue;
    const w = close(surfaceFamilies(reachNames, [f.path], CLOSE_HOPS));
    for (const bucket of ['route_families', 'jobs', 'pages']) {
      for (const x of w[bucket]) {
        assert.ok(x.hops <= CLOSE_HOPS,
          `${f.path} ${bucket} ${x.name} at ${x.hops} hops survived the cap`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} capped entries seen; the assertion is not exercised`);
});

test('script reach stays bounded by MAX_HOPS', () => {
  for (const f of model.files.values()) {
    if (f.tree === 'test') continue;
    for (const s of surfaceFamilies(reachNames, [f.path], CLOSE_HOPS).scripts) {
      assert.ok(s.hops <= MAX_HOPS, `${f.path} -> ${s.name} at ${s.hops} hops exceeds MAX_HOPS`);
    }
  }
});
