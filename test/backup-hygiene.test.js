import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planPrune, applyPrune, parseStamp, defaultTrashDir, formatReport, main, FLAG,
} from '../scripts/backup-hygiene.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T05:00:00.000Z');
const stampOf = ms => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** A fake database folder: the live file, its WAL, and snapshots aged `ages` days. */
function fixture(ages, { extras = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hygiene-'));
  const dir = path.join(root, 'db');
  fs.mkdirSync(dir);
  const db = path.join(dir, 'data.sqlite');
  fs.writeFileSync(db, 'live');
  fs.writeFileSync(`${db}-wal`, 'wal');
  const names = ages.map((age, i) => {
    const ms = NOW - age * DAY;
    const name = `data.sqlite.pre-migration-${stampOf(ms)}.bak`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(100 * (i + 1)));
    fs.utimesSync(file, ms / 1000, ms / 1000);
    return name;
  });
  if (extras) {
    fs.writeFileSync(path.join(dir, 'other.sqlite.pre-migration-2026-01-01T00-00-00-000Z.bak'), 'x');
    fs.writeFileSync(path.join(dir, 'data.sqlite.pre-migration-garbage.bak'), 'x');
    fs.writeFileSync(path.join(dir, 'data.sqlite.20260101.bak'), 'x');
    fs.symlinkSync(db, path.join(dir, 'data.sqlite.pre-migration-2026-01-02T00-00-00-000Z.bak'));
  }
  const old = NOW - 100 * DAY;
  for (const f of ['other.sqlite.pre-migration-2026-01-01T00-00-00-000Z.bak', 'data.sqlite.pre-migration-garbage.bak', 'data.sqlite.20260101.bak']) {
    if (extras) fs.utimesSync(path.join(dir, f), old / 1000, old / 1000);
  }
  return { root, dir, db, names, trash: path.join(root, 'Trash') };
}

function listing(dir) {
  return fs.readdirSync(dir).sort().map(n => {
    const st = fs.lstatSync(path.join(dir, n));
    return `${n}:${st.size}:${st.mtimeMs}`;
  });
}

test('parseStamp reads backupBeforeMigration stamps and nothing else', () => {
  assert.equal(parseStamp('2026-09-10T12-34-56-789Z'), Date.parse('2026-09-10T12:34:56.789Z'));
  assert.equal(parseStamp('garbage'), null);
  assert.equal(parseStamp('2026-09-10T12:34:56.789Z'), null);
});

test('B1 keeps the newest 3 even when every snapshot is ancient', () => {
  const f = fixture([400, 300, 200, 100, 90]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  assert.deepEqual(plan.newest.map(s => s.name), [f.names[4], f.names[3], f.names[2]]);
  assert.deepEqual(plan.move.map(s => s.name).sort(), [f.names[0], f.names[1]].sort());
});

test('B2 never moves a snapshot younger than 14 days, by stamp or by mtime', () => {
  const f = fixture([1, 2, 3, 13, 20, 30]);
  // A snapshot whose name says old but whose file was touched recently stays too.
  const touched = path.join(f.dir, f.names[5]);
  fs.utimesSync(touched, (NOW - 5 * DAY) / 1000, (NOW - 5 * DAY) / 1000);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  assert.deepEqual(plan.too_young.map(s => s.name).sort(), [f.names[3], f.names[5]].sort());
  assert.deepEqual(plan.move.map(s => s.name), [f.names[4]]);
  for (const s of plan.move) assert.ok(NOW - Math.max(s.stamp_ms, s.mtime_ms) >= 14 * DAY);
});

test('B3 touches only exact-name regular snapshot files of this database', () => {
  const f = fixture([100, 90, 80, 70, 60]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  const moving = plan.move.map(s => s.name);
  assert.deepEqual(moving.sort(), [f.names[0], f.names[1]].sort());
  assert.deepEqual(plan.ignored.map(i => i.reason).sort(), ['symlink', 'unreadable_stamp']);
  applyPrune(plan, { trashDir: f.trash, platform: 'darwin', now: NOW });
  for (const keep of ['data.sqlite', 'data.sqlite-wal', 'other.sqlite.pre-migration-2026-01-01T00-00-00-000Z.bak',
    'data.sqlite.pre-migration-garbage.bak', 'data.sqlite.20260101.bak', 'data.sqlite.pre-migration-2026-01-02T00-00-00-000Z.bak']) {
    assert.ok(fs.lstatSync(path.join(f.dir, keep)), keep);
  }
  assert.equal(fs.readFileSync(f.db, 'utf8'), 'live');
});

test('B4 moves to the Trash, never deletes: every byte is still on disk afterwards', () => {
  const f = fixture([100, 90, 80, 70, 60]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  const result = applyPrune(plan, { trashDir: f.trash, platform: 'darwin', now: NOW });
  assert.equal(result.moved.length, 2);
  assert.deepEqual(result.failed, []);
  for (const m of result.moved) {
    assert.equal(fs.statSync(path.join(f.trash, m.trash_name)).size, m.bytes);
    assert.equal(fs.existsSync(path.join(f.dir, m.name)), false);
  }
  // The source never names a deleting call.
  const src = fs.readFileSync(fileURLToPath(new URL('../scripts/backup-hygiene.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /\b(unlink|unlinkSync|rmSync|rmdirSync|rimraf)\b|fs\.rm\(|\brm -/);
});

test('B4b a name already in the Trash is not overwritten', () => {
  const f = fixture([100, 90, 80, 70]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  fs.mkdirSync(f.trash, { recursive: true });
  fs.writeFileSync(path.join(f.trash, plan.move[0].name), 'earlier');
  const result = applyPrune(plan, { trashDir: f.trash, platform: 'darwin', now: NOW });
  assert.equal(fs.readFileSync(path.join(f.trash, plan.move[0].name), 'utf8'), 'earlier');
  assert.equal(result.moved[0].trash_name, `${plan.move[0].name} 2`);
});

test('B4c linux Trash gets files/ plus a .trashinfo so it can be restored', () => {
  const f = fixture([100, 90, 80, 70]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  const result = applyPrune(plan, { trashDir: f.trash, platform: 'linux', now: NOW });
  const info = fs.readFileSync(path.join(f.trash, 'info', `${result.moved[0].trash_name}.trashinfo`), 'utf8');
  assert.match(info, /^\[Trash Info\]\nPath=.*data\.sqlite\.pre-migration-.*\.bak\nDeletionDate=2026-09-26T05:00:00\n$/);
  assert.ok(fs.existsSync(path.join(f.trash, 'files', result.moved[0].trash_name)));
});

test('B5 a file on another volume stays put and is reported, not copied and deleted', () => {
  const f = fixture([100, 90, 80, 70, 60]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  const exdev = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; };
  const result = applyPrune(plan, { trashDir: f.trash, platform: 'darwin', rename: exdev, now: NOW });
  assert.equal(result.moved.length, 0);
  assert.equal(result.bytes_moved, 0);
  assert.deepEqual(result.failed.map(x => x.code), ['EXDEV', 'EXDEV']);
  for (const s of plan.move) assert.ok(fs.existsSync(s.path));
  assert.match(formatReport(plan, result), /NOT moved .*EXDEV/);
});

test('B6 space saved equals the bytes actually moved', () => {
  const f = fixture([100, 90, 80, 70, 60]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  const expected = plan.move.reduce((n, s) => n + fs.statSync(s.path).size, 0);
  assert.equal(plan.bytes_to_move, expected);
  const result = applyPrune(plan, { trashDir: f.trash, platform: 'darwin', now: NOW });
  assert.equal(result.bytes_moved, expected);
  assert.equal(result.bytes_moved, 100 + 200);
  assert.match(formatReport(plan, result), /Moved 2 snapshot\(s\), 300 B, to /);
});

test('B7 dry run and --apply without the flag change nothing on disk', () => {
  const f = fixture([100, 90, 80, 70, 60]);
  const before = listing(f.dir);
  const logs = [];
  const out = { log: m => logs.push(m), error: m => logs.push(m) };
  assert.equal(main(['--db', f.db], {}, out), 0);
  assert.equal(main(['--db', f.db, '--apply'], {}, out), 2);
  assert.equal(main(['--db', f.db, '--apply'], { [FLAG]: '0' }, out), 2);
  assert.deepEqual(listing(f.dir), before);
  assert.match(logs.join('\n'), /Refusing to move anything: --apply needs GRIDIRON_BACKUP_HYGIENE=1/);
});

test('unknown platform has no Trash, and apply refuses rather than guessing', () => {
  assert.equal(defaultTrashDir('win32', '/home/x', {}), null);
  assert.equal(defaultTrashDir('darwin', '/Users/x', {}), '/Users/x/.Trash');
  assert.equal(defaultTrashDir('linux', '/home/x', {}), '/home/x/.local/share/Trash');
  const f = fixture([100, 90, 80, 70]);
  const plan = planPrune({ dbPath: f.db, now: NOW });
  assert.throws(() => applyPrune(plan, { trashDir: null, platform: 'win32' }), /No Trash folder/);
  assert.ok(fs.existsSync(plan.move[0].path));
});
