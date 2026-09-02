import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A fresh database must answer every status and report surface without a
// stack trace: pending, unavailable or empty, but never a throw.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-empty-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
await import('../server/services/shadow-ledger.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const surfaces = [
  ['report-cache', 'reportCacheStatus', []],
  ['odds-archive', 'oddsArchiveStatus', []],
  ['beat-the-close', 'beatTheCloseStatus', []],
  ['nfl-specialist-audit', 'specialistAudit', [{}]],
  ['nfl-slice-diagnostic', 'sliceDiagnostic', [{}]],
  ['line-move-study', 'lineMoveStudy', [{ includeModels: false }]],
  ['nfl-evidence-provenance', 'verifyForwardEvidence', [{}]],
  ['nfl-weather', 'weatherStatus', []],
  ['nfl-qbr', 'qbrStatus', []],
  ['book-feeds', 'bookFeedStatus', []],
  ['nfl-expert-council', 'expertCouncilStatus', []],
  ['nfl-blind-audit', 'listBlindAudits', []],
  ['nfl-news-market-latency', 'verifiedEventMarketLatency', [{ limit: 10 }]]
];

for (const [moduleName, fn, args] of surfaces) {
  test(`${moduleName}.${fn} answers on an empty database`, async () => {
    const mod = await import(`../server/services/${moduleName}.js`);
    assert.equal(typeof mod[fn], 'function', `${fn} is exported`);
    const out = mod[fn](...args);
    assert.ok(out !== undefined, 'returns something');
    if (out && typeof out === 'object' && 'available' in out) assert.equal(typeof out.available, 'boolean');
  });
}

test('the report store serves pending for every registered report on an empty database', async () => {
  const { REPORTS, serveReport } = await import('../server/services/report-cache.js');
  for (const name of Object.keys(REPORTS)) {
    const out = serveReport(name, { refreshIfStale: false });
    assert.equal(out.pending, true, `${name} is pending, not computed on a read`);
  }
});
