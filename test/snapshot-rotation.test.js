/**
 * 54 SNAPSHOT ROTATION: a nightly read-only copy of the application database,
 * integrity-checked, kept for 7 days, with a size report.
 *
 * scripts/nightly-backup.sh already copies the database at 04:30 and deletes old
 * copies with `rm -f`. This is the checked version: the copy is verified before
 * anything old goes, nothing is ever deleted (old copies are renamed into the
 * Trash), and a failed or short-of-space night writes nothing and says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FLAG, RETAIN_DAYS, snapshotName, parseSnapshotStamp, listSnapshots, checkRoom,
  takeSnapshot, verifySnapshot, planRotation, applyRotation, sizeReport, main,
} from '../scripts/snapshot-rotation.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T04:30:00Z');
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tempRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-snaprot-'));
  roots.push(r);
  return r;
}

/** A small WAL database with made-up rows, shaped like the app's. */
function fixtureDb(root) {
  const dbPath = path.join(root, 'data', 'data.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE players (id INTEGER PRIMARY KEY, pos TEXT, value REAL)');
  db.exec('CREATE TABLE trade_ledger (id INTEGER PRIMARY KEY, roster_id INTEGER, note TEXT)');
  db.exec('CREATE INDEX trade_ledger_roster ON trade_ledger(roster_id)');
  const ins = db.prepare('INSERT INTO players (pos, value) VALUES (?, ?)');
  for (let i = 0; i < 500; i += 1) ins.run(['QB', 'RB', 'WR', 'TE'][i % 4], i / 7);
  const led = db.prepare('INSERT INTO trade_ledger (roster_id, note) VALUES (?, ?)');
  for (let i = 0; i < 120; i += 1) led.run(i % 10, `row ${i}`);
  return { dbPath, db };
}

function counts(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['players', 'trade_ledger']
      .map(t => [t, d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  } finally { d.close(); }
}

/** A verified snapshot file stamped `daysAgo` before NOW, as a past night would leave it. */
function pastSnapshot(dest, dbPath, daysAgo, { verified = true } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const at = NOW - daysAgo * DAY;
  const name = snapshotName(dbPath, at);
  const file = path.join(dest, name);
  fs.writeFileSync(file, Buffer.alloc(1000 + daysAgo));
  const t = new Date(at);
  fs.utimesSync(file, t, t);
  fs.writeFileSync(`${file}.verify.json`, JSON.stringify({ ok: verified, integrity: verified ? 'ok' : 'bad' }));
  return name;
}

function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort()
    .map(n => { const st = fs.statSync(path.join(dir, n)); return `${n}:${st.isFile() ? st.size : 'dir'}`; });
}

const quiet = { log() {}, error() {} };

test('snapshot names carry a sortable UTC stamp that reads back', () => {
  const name = snapshotName('/x/data.sqlite', NOW);
  assert.equal(name, 'data.20260926T043000Z.snapshot.sqlite');
  assert.equal(parseSnapshotStamp(name, 'data'), NOW);
  assert.equal(parseSnapshotStamp('data.garbage.snapshot.sqlite', 'data'), null);
});

test('B1 the snapshot is a read-only copy with the same tables and rows, and the source is untouched', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  const before = counts(dbPath);
  const srcMtime = fs.statSync(dbPath).mtimeMs;
  const dest = path.join(root, 'snaps');
  const walBytes = fs.statSync(`${dbPath}-wal`).size;
  const snap = takeSnapshot({ dbPath, destDir: dest, now: NOW });
  // Checked before the writer closes: closing the last writer checkpoints the WAL.
  assert.equal(fs.statSync(dbPath).mtimeMs, srcMtime, 'source file not modified');
  assert.equal(fs.statSync(`${dbPath}-wal`).size, walBytes, 'source WAL not modified');
  db.close();
  assert.equal(path.basename(snap), snapshotName(dbPath, NOW));
  assert.deepEqual(counts(snap), before);
  assert.equal(fs.statSync(snap).mode & 0o222, 0, 'no write bit on the snapshot');
  const v = verifySnapshot(snap, dbPath);
  assert.equal(v.ok, true);
  assert.equal(v.integrity, 'ok');
  assert.deepEqual(v.missing_tables, []);
  assert.ok(fs.existsSync(`${snap}.verify.json`), 'the verdict is recorded beside the snapshot');
});

test('B2 a corrupted snapshot fails verification, and that night moves nothing old', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  db.close();
  const dest = path.join(root, 'snaps');
  const old = pastSnapshot(dest, dbPath, 12);
  const older = pastSnapshot(dest, dbPath, 15); // would move on a good night
  const snap = takeSnapshot({ dbPath, destDir: dest, now: NOW });
  fs.chmodSync(snap, 0o644);
  const fd = fs.openSync(snap, 'r+');
  fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096); // stomp page 2
  fs.closeSync(fd);
  const v = verifySnapshot(snap, dbPath);
  assert.equal(v.ok, false);
  assert.notEqual(v.integrity, 'ok');
  const plan = planRotation({ destDir: dest, dbPath, now: NOW, latest: v });
  assert.equal(plan.move.length, 0, 'no old copy leaves while the newest one is bad');
  assert.equal(plan.blocked, 'newest_snapshot_failed_verification');
  assert.ok(fs.existsSync(path.join(dest, old)));
  assert.ok(fs.existsSync(path.join(dest, older)));
  const fromDisk = planRotation({ destDir: dest, dbPath, now: NOW });
  assert.equal(fromDisk.blocked, 'newest_snapshot_failed_verification', 'the recorded verdict blocks a later run too');
  assert.equal(fromDisk.move.length, 0);
  fs.renameSync(snap, `${snap}.set-aside`);
  assert.equal(planRotation({ destDir: dest, dbPath, now: NOW }).move.length, 1, 'control: without the bad copy, day 15 would move');
});

test('B2b a snapshot missing a table the source has fails verification', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  const dest = path.join(root, 'snaps');
  const snap = takeSnapshot({ dbPath, destDir: dest, now: NOW });
  db.exec('CREATE TABLE added_after (x)');
  db.close();
  const v = verifySnapshot(snap, dbPath);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing_tables, ['added_after']);
});

test('B3 retention keeps every verified copy from the last 7 days and moves older ones', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  const names = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 14].map(d => pastSnapshot(dest, dbPath, d));
  assert.equal(RETAIN_DAYS, 7);
  const plan = planRotation({ destDir: dest, dbPath, now: NOW });
  assert.deepEqual(plan.keep.map(s => s.name), names.slice(0, 8), 'days 0..7 kept');
  assert.deepEqual(plan.move.map(s => s.name), names.slice(8), 'days 8, 10, 14 move');
});

test('B3b the newest verified copy is kept however old, and unverified copies are never moved', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  const newestOk = pastSnapshot(dest, dbPath, 20);
  const failed = pastSnapshot(dest, dbPath, 30, { verified: false });
  const olderOk = pastSnapshot(dest, dbPath, 40);
  fs.writeFileSync(path.join(dest, 'data.20260801T000000Z.snapshot.sqlite'), 'x'); // no verdict file
  fs.writeFileSync(path.join(dest, 'other.20260801T000000Z.snapshot.sqlite'), 'x'); // another database
  fs.writeFileSync(path.join(dest, 'data.sqlite.pre-migration-x.bak'), 'x');
  const plan = planRotation({ destDir: dest, dbPath, now: NOW });
  assert.deepEqual(plan.keep.map(s => s.name), [newestOk]);
  assert.deepEqual(plan.move.map(s => s.name), [olderOk]);
  assert.deepEqual(plan.unverified.map(s => s.name).sort(), [failed, 'data.20260801T000000Z.snapshot.sqlite'].sort());
  assert.ok(!plan.move.some(s => s.name.startsWith('other.') || s.name.endsWith('.bak')));
});

test('B3c a recent mtime keeps a copy even when its name says it is old', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 0);
  const touched = pastSnapshot(dest, dbPath, 9);
  const t = new Date(NOW - 2 * DAY);
  fs.utimesSync(path.join(dest, touched), t, t);
  const plan = planRotation({ destDir: dest, dbPath, now: NOW });
  assert.equal(plan.move.length, 0);
});

test('B4 old copies are renamed into the Trash with their verdict file, never deleted', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 0);
  const old = pastSnapshot(dest, dbPath, 9);
  const trash = path.join(root, 'Trash');
  fs.mkdirSync(trash);
  fs.writeFileSync(path.join(trash, old), 'someone else'); // never overwritten
  const plan = planRotation({ destDir: dest, dbPath, now: NOW });
  const result = applyRotation(plan, { trashDir: trash, platform: 'darwin' });
  assert.equal(result.failed.length, 0);
  assert.equal(result.moved.length, 1);
  assert.equal(fs.readFileSync(path.join(trash, old), 'utf8'), 'someone else');
  assert.equal(fs.statSync(path.join(trash, `${old} 2`)).size, 1009);
  assert.ok(fs.existsSync(path.join(trash, `${old} 2.verify.json`)));
  assert.ok(!fs.existsSync(path.join(dest, old)));
  assert.equal(result.bytes_moved, 1009);
  const src = fs.readFileSync(new URL('../scripts/snapshot-rotation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /unlink|rmSync|fs\.rm\(|rm -/, 'no deleting call anywhere in the script');
});

test('B4b a copy on another volume than the Trash stays put and is reported', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 0);
  const old = pastSnapshot(dest, dbPath, 9);
  const plan = planRotation({ destDir: dest, dbPath, now: NOW });
  const exdev = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  const result = applyRotation(plan, { trashDir: path.join(root, 'Trash'), platform: 'darwin', rename: exdev });
  assert.equal(result.moved.length, 0);
  assert.equal(result.failed[0].code, 'EXDEV');
  assert.ok(fs.existsSync(path.join(dest, old)));
});

test('B5 short of space: refuses before writing anything', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  const srcBytes = fs.statSync(dbPath).size + fs.statSync(`${dbPath}-wal`).size;
  const dest = path.join(root, 'snaps');
  const tight = () => ({ bavail: Math.floor(srcBytes * 1.2), bsize: 1, blocks: 1e9 });
  const room = checkRoom({ dbPath, destDir: dest, statfs: tight });
  assert.equal(room.ok, false);
  assert.equal(room.needed_bytes, Math.ceil(srcBytes * 1.5));
  const code = main(['--apply', '--db', dbPath, '--dest', dest], { [FLAG]: '1' }, quiet, { now: NOW, statfs: tight });
  db.close();
  assert.equal(code, 1);
  assert.deepEqual(tree(dest), []);
});

test('B6 dry run by default, and --apply without the flag exits 2; neither writes', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  db.close();
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 0);
  pastSnapshot(dest, dbPath, 9);
  const before = tree(dest);
  const lines = [];
  const out = { log: s => lines.push(s), error: s => lines.push(s) };
  assert.equal(main(['--db', dbPath, '--dest', dest], {}, out, { now: NOW }), 0);
  assert.match(lines.join('\n'), /Dry run/);
  assert.equal(main(['--apply', '--db', dbPath, '--dest', dest], {}, out, { now: NOW }), 2);
  assert.match(lines.join('\n'), new RegExp(`--apply needs ${FLAG}=1`));
  assert.deepEqual(tree(dest), before);
});

test('B7 a full night: snapshot, verify, rotate to Trash, size report', () => {
  const root = tempRoot();
  const { dbPath, db } = fixtureDb(root);
  db.close();
  const dest = path.join(root, 'snaps');
  const trash = path.join(root, 'Trash');
  const old = pastSnapshot(dest, dbPath, 9);
  const lines = [];
  const out = { log: s => lines.push(s), error: s => lines.push(s) };
  const code = main(['--apply', '--db', dbPath, '--dest', dest, '--trash', trash], { [FLAG]: '1' }, out, { now: NOW, platform: 'darwin' });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(fs.existsSync(path.join(dest, snapshotName(dbPath, NOW))));
  assert.ok(fs.existsSync(path.join(trash, old)));
  const text = lines.join('\n');
  assert.match(text, /integrity ok/);
  assert.match(text, /Source database/);
  assert.match(text, /Snapshots kept: 1/);
  assert.match(text, /Free on the snapshot disk/);
});

test('B8 the size report adds up and shows growth since the previous verified copy', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  fs.writeFileSync(dbPath, Buffer.alloc(5000));
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 0);
  pastSnapshot(dest, dbPath, 1);
  const r = sizeReport({ dbPath, destDir: dest, statfs: () => ({ bavail: 10, bsize: 1000, blocks: 100 }) });
  assert.equal(r.source_bytes, 5000);
  assert.equal(r.snapshots.length, 2);
  assert.equal(r.total_snapshot_bytes, 1000 + 1001);
  assert.equal(r.growth_bytes, 1000 - 1001);
  assert.equal(r.free_bytes, 10_000);
});

test('B9 listSnapshots only claims this database\'s snapshot names', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'data.sqlite');
  const dest = path.join(root, 'snaps');
  pastSnapshot(dest, dbPath, 1);
  fs.symlinkSync(path.join(dest, snapshotName(dbPath, NOW - DAY)), path.join(dest, snapshotName(dbPath, NOW - 3 * DAY)));
  const { snapshots, ignored } = listSnapshots(dest, dbPath);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(ignored.map(i => i.reason), ['symlink']);
});
