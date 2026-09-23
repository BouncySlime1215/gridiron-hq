/**
 * league-history.js's own live-draft gate must not fail open.
 *
 * `liveDraft()` wraps a dynamic `import('./scheduler.js')` in a bare catch that
 * returns `false` ("no draft in progress") on ANY failure of that import or of
 * `liveDraftActive()` itself — not just the one narrow case scheduler.js's own
 * `liveDraftActive()` already documents and handles (a test harness with no
 * `drafts` table). If the import throws for any other reason — a real bug in
 * scheduler.js, a broken build, a transient module-loader fault — this second,
 * unscoped catch silently tells `backfillLeagueHistory()` that it is safe to
 * hit ESPN with Nick's own live cookies, which is exactly the class of mistake
 * the 2026-09-06/07 incident this gate exists for was made of. CLAUDE.md: "if
 * a layer goes inert, the surface must say so" — this pins that an unreadable
 * draft status is treated as unsafe (skip), not as "no draft".
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

mock.module('../server/services/scheduler.js', {
  namedExports: {
    liveDraftActive() { throw new Error('drafts table is on fire'); },
  },
});
const { backfillLeagueHistory } = await import('../server/services/league-history.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
     VALUES ('espn', '9001', 2026, 'Gate Test League', 's2-cookie', 'swid-cookie')`);

test('an unreadable draft status skips the run instead of touching ESPN', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not reach ESPN'); };

  const out = await backfillLeagueHistory();

  assert.equal(called, false, 'draft status could not be determined, so ESPN must not be touched');
  assert.ok(out.skipped, 'an unreadable draft status must skip the run, the same as a confirmed live draft');
  assert.match(String(out.skipped), /unknown|drafts table is on fire/i,
    'the skip must name why, not read identically to a normal confirmed-live-draft skip');
});
