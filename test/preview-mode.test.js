/**
 * PREVIEW-01: GRIDIRON_PREVIEW_UNCONFIRMED has exactly one reader, server/services/preview-mode.js.
 * The per-site ON/OFF behaviour is pinned next to each site's own fixtures:
 *   test/receptiveness-activity.test.js, test/espn-zero-inactive.test.js,
 *   test/streaming-board.test.js, test/waiver-injury-alerts.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PREVIEW_ENV, previewUnconfirmed, previewFields, previewText } =
  await import('../server/services/preview-mode.js');

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

test('preview-mode.js is the only file under server/, scripts/ or client/src that names GRIDIRON_PREVIEW_UNCONFIRMED', () => {
  const hits = ['server', 'scripts', 'client/src']
    .filter(d => fs.existsSync(path.join(REPO, d)))
    .flatMap(d => jsFiles(path.join(REPO, d)))
    .filter(f => fs.readFileSync(f, 'utf8').includes('GRIDIRON_PREVIEW_UNCONFIRMED'))
    .map(f => path.relative(REPO, f));
  // Known-nonzero control: the scan must find the producer itself, or it is scanning nothing.
  assert.deepEqual(hits, ['server/services/preview-mode.js']);
});

test('the switch is on only for exactly "1"', () => {
  const saved = process.env[PREVIEW_ENV];
  try {
    delete process.env[PREVIEW_ENV];
    assert.equal(previewUnconfirmed(), false, 'unset: off');
    for (const v of ['0', 'true', 'yes', '']) {
      process.env[PREVIEW_ENV] = v;
      assert.equal(previewUnconfirmed(), false, `${JSON.stringify(v)}: off`);
    }
    process.env[PREVIEW_ENV] = '1';
    assert.equal(previewUnconfirmed(), true);
  } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
});

test('preview fields and label', () => {
  assert.deepEqual(previewFields('why'), { preview: true, preview_reason: 'why' });
  assert.equal(previewText('Swap now.'), 'Preview (unconfirmed forward): Swap now.');
});
