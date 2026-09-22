/**
 * nflverse-data is CC BY 4.0, and most of the NFL data this app serves comes
 * from it. The licence's one real obligation is attribution: name the creator,
 * link the licence, say whether the material was modified (Section 3(a)(1)).
 * ffopportunity.js already carries that as a frozen descriptor; these tests
 * hold nflverse to the same shape and put both on the data surface the app
 * reads, so the licence travels with the data rather than living in a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-nflverse-attribution-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db } = await import('../server/db/index.js');
const nflverse = await import('../server/services/nflverse.js');
const { FFOPPORTUNITY_SOURCE } = await import('../server/services/ffopportunity.js');
const { default: dataFreshnessRouter } = await import('../server/routes/data-freshness.js');

const app = express();
app.use('/api/data-freshness', dataFreshnessRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('nflverse has a frozen source descriptor naming its data licence', () => {
  const src = nflverse.NFLVERSE_SOURCE;
  assert.ok(src, 'nflverse.js exports NFLVERSE_SOURCE');
  assert.ok(Object.isFrozen(src), 'the descriptor is frozen, like FFOPPORTUNITY_SOURCE');
  assert.equal(src.repo, 'nflverse/nflverse-data');
  assert.equal(src.creator, 'nflverse');
  assert.equal(src.data_license, 'CC BY 4.0');
  assert.equal(src.license_url, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(src.license_file, 'https://github.com/nflverse/nflverse-data/blob/master/LICENSE.md');
  assert.equal(src.code_copied, false);
});

test('the descriptor says the data is modified, as Section 3(a)(1)(b) asks', () => {
  const src = nflverse.NFLVERSE_SOURCE;
  assert.equal(src?.modified, true, 'the app derives features from the data, so it is modified');
  assert.ok(typeof src?.modification === 'string' && src.modification.length > 0, 'the modification is described');
});

test('every nflverse-data release URL the server fetches from is the one the descriptor names', () => {
  const src = nflverse.NFLVERSE_SOURCE;
  assert.ok(src?.release_url, 'the descriptor names its release URL');
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download[^'"`$\s]*/g)) {
          hits.push([path.relative(root, p), m[0]]);
        }
      }
    }
  };
  walk(path.join(root, 'server'));
  assert.ok(hits.length >= 2, `found the release URL in ${hits.length} server file(s); expected nflverse.js and nfl-advanced.js at least`);
  for (const [file, url] of hits) {
    assert.ok(url.startsWith(src.release_url), `${file} fetches ${url}, which is not under ${src.release_url}`);
  }
});

test('the data-freshness report carries both CC BY sources, verbatim', async () => {
  const body = await (await fetch(`${base}/api/data-freshness`)).json();
  assert.ok(Array.isArray(body.sources), 'the report has a sources array');
  assert.deepEqual(body.sources.find(s => s.repo === 'nflverse/nflverse-data'), { ...nflverse.NFLVERSE_SOURCE });
  assert.deepEqual(body.sources.find(s => s.repo === 'ffverse/ffopportunity'), { ...FFOPPORTUNITY_SOURCE });
});
