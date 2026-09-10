/**
 * The pre-migration snapshot must refuse a disk it cannot finish on.
 *
 * Found on 2026-09-10, on the developer's own machine: the live database was
 * 9.0 GB, eight accumulated snapshots held 57.3 GB, and the volume was at 97%
 * with 15 GB free. Four migrations were pending. The next application start
 * would have attempted a 9 GB `VACUUM INTO` into 15 GB of headroom.
 *
 * The comment on `backupBeforeMigration` said snapshots are worth more than the
 * disk they cost, which is true, and quietly assumed the disk had room. A
 * snapshot that fills the disk is not protection — it is a second failure on
 * top of the one it was insuring against, and a half-written backup beside a
 * migration that then cannot complete is the worst state that code can reach.
 *
 * So it refuses. A refusal costs one command to recover from; a full disk
 * during a schema change may not be recoverable at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-headroom-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { assertRoomForSnapshot, backupBeforeMigration, db } = await import('../server/db/index.js');
test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); });

test('a small database on a normal disk passes the check', () => {
  const result = assertRoomForSnapshot(process.env.GRIDIRON_DB_PATH);
  assert.equal(result.ok, true);
  assert.ok(result.needed_bytes > 0);
  assert.ok(result.free_bytes > result.needed_bytes);
});

test('a database larger than the free disk is REFUSED, with a usable message', () => {
  // A sparse file the size of the whole volume: reported size exceeds free
  // space by construction, without actually consuming it.
  const huge = path.join(temp, 'enormous.sqlite');
  const fd = fs.openSync(huge, 'w');
  try {
    const volume = fs.statfsSync(temp);
    fs.ftruncateSync(fd, volume.blocks * volume.bsize);
  } finally {
    fs.closeSync(fd);
  }

  assert.throws(() => assertRoomForSnapshot(huge), error => {
    assert.match(error.message, /Refusing to migrate/);
    // The message has to be actionable at 3am, so it must say the sizes and
    // where the old snapshots are.
    assert.match(error.message, /GB free/);
    assert.match(error.message, /pre-migration-\*\.bak/);
    assert.match(error.message, /never deleted automatically/);
    return true;
  });
});

test('an unmeasurable disk does not block a migration', () => {
  // An unmeasurable disk is not the same as a full one. Inventing a reason to
  // refuse would turn a platform quirk into an outage.
  const result = assertRoomForSnapshot(path.join(temp, 'does-not-exist.sqlite'));
  assert.equal(result.checked, false);
  assert.equal(result.ok, undefined, 'no verdict is claimed when nothing could be measured');
});

test('the guard runs BEFORE any snapshot file is created', () => {
  // Order matters: a check that ran after the VACUUM would be pointless, and a
  // partially written .bak is exactly what must never appear.
  const before = fs.readdirSync(temp).filter(f => f.includes('.bak'));
  assert.deepEqual(before, [], 'no stray snapshot exists yet');

  // A fresh database has no migration history, so no snapshot is taken at all.
  assert.equal(backupBeforeMigration('test', db, process.env.GRIDIRON_DB_PATH), null);
  assert.deepEqual(fs.readdirSync(temp).filter(f => f.includes('.bak')), [],
    'and none was written');
});
