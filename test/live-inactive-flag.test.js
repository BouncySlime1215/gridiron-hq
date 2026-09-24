/**
 * FIX-184-3: LIVE_INACTIVE_WARNINGS has one reader, server/services/live-inactive-flag.js.
 *
 * The reader ORs in preview mode (preview-mode.js#previewUnconfirmed) and stamps
 * `preview` / `preview_reason` when the warning is on only because of it, the same
 * shape as offer-loop-flag.js and number-health-flag.js (test/fix-10-flags.test.js).
 * The Start/Sit side of the preview label is pinned in
 * test/lineup-live-inactive-warning.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
// Absent before FIX-184-3. Only a missing module is tolerated, so the RED run fails on
// the assertions rather than on the import.
let flag = null;
try { flag = await import('../server/services/live-inactive-flag.js'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

const ENV = 'LIVE_INACTIVE_WARNINGS';
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (/\.(c|m)?js$|\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

test('live-inactive-flag.js is the only file under server/, scripts/ or client/src that names LIVE_INACTIVE_WARNINGS', () => {
  const hits = ['server', 'scripts', 'client/src']
    .filter(d => fs.existsSync(path.join(REPO, d)))
    .flatMap(d => jsFiles(path.join(REPO, d)))
    .filter(f => fs.readFileSync(f, 'utf8').includes(ENV))
    .map(f => path.relative(REPO, f));
  // Known-nonzero control: the scan must find the reader itself, or it is scanning nothing.
  assert.deepEqual(hits, ['server/services/live-inactive-flag.js']);
});

test('off by default, on only for exactly "1", preview turns it on labelled, the site flag wins over preview', () => {
  assert.ok(flag, 'server/services/live-inactive-flag.js exists');
  assert.equal(flag.LIVE_INACTIVE_ENV, ENV);
  withEnv({ [ENV]: undefined, [PREVIEW_ENV]: undefined }, () => {
    const off = flag.liveInactiveFields();
    assert.equal(off.enabled, false);
    assert.match(off.reason, /Set LIVE_INACTIVE_WARNINGS=1/, 'the off reason names the switch');
    assert.equal(off.preview, undefined);
  });
  for (const v of ['0', 'true', '']) {
    withEnv({ [ENV]: v, [PREVIEW_ENV]: undefined }, () => assert.equal(flag.liveInactiveFields().enabled, false, `${JSON.stringify(v)}: off`));
  }
  withEnv({ [ENV]: '1', [PREVIEW_ENV]: undefined }, () => assert.deepEqual(flag.liveInactiveFields(), { enabled: true }));
  withEnv({ [ENV]: undefined, [PREVIEW_ENV]: '1' }, () => {
    const p = flag.liveInactiveFields();
    assert.equal(p.enabled, true);
    assert.equal(p.preview, true);
    assert.match(p.preview_reason, /default-off, unconfirmed forward/);
  });
  withEnv({ [ENV]: '1', [PREVIEW_ENV]: '1' }, () => assert.deepEqual(flag.liveInactiveFields(), { enabled: true }, 'not a preview'));
});

test('preview-mode.js lists the live inactive reader as a converted site', () => {
  const src = fs.readFileSync(new URL('../server/services/preview-mode.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('Converted sites'), src.indexOf('*/'));
  assert.match(block, /live-inactive-flag\.js/);
});
