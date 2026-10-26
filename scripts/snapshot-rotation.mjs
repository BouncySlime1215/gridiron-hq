#!/usr/bin/env node
/**
 * SNAPSHOT ROTATION (plan item 54): a nightly read-only copy of the application
 * database, integrity-checked, kept for 7 days, with a size report.
 *
 * scripts/nightly-backup.sh already copies the database at 04:30 with VACUUM INTO and
 * prunes by count with a hard delete, without ever opening the copy it just made. This
 * is the checked version of that job, and of the Mac-side bin/make-snapshot.sh (which
 * lives outside the repository):
 *
 *   1. room: refuse unless the snapshot disk has 1.5 x (main + WAL) free. Nothing is
 *      written on a refusal.
 *   2. snapshot: VACUUM INTO from a read-only connection (writers are not blocked and
 *      the source file is not modified), then the copy loses its write bits.
 *   3. verify: PRAGMA integrity_check on the copy, and every table the source has must
 *      be in it. The verdict is written beside the copy as `<name>.verify.json`.
 *   4. rotate: keep every verified copy from the last RETAIN_DAYS (by the name's stamp
 *      or the file's mtime) and always the newest verified one; older verified copies
 *      are RENAMED into the Trash with their verdict file. Nothing is ever deleted.
 *      Unverified or failed copies never move: that is a person's call. While the
 *      newest copy is failed or unverified, nothing old moves at all.
 *   5. report: source size, each copy, total, growth since the previous copy, free disk.
 *
 * Dry run by default. Writing anything needs `--apply` AND GRIDIRON_SNAPSHOT_ROTATION=1.
 *
 * Usage:
 *   node scripts/snapshot-rotation.mjs                         # what tonight would do
 *   GRIDIRON_SNAPSHOT_ROTATION=1 node scripts/snapshot-rotation.mjs --apply
 *   node scripts/snapshot-rotation.mjs --db <file> --dest <dir> --trash <dir> --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FLAG = 'GRIDIRON_SNAPSHOT_ROTATION';
export const RETAIN_DAYS = 7;
/** Headroom for a snapshot: the same 1.5 x (main + WAL) the production read snapshot used. */
export const HEADROOM_FACTOR = 1.5;
const DAY_MS = 86_400_000;
const VERDICT_SUFFIX = '.verify.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(ROOT, 'server', 'data.sqlite');
export const DEFAULT_DEST = process.env.GRIDIRON_SNAPSHOT_DIR || path.join(os.homedir(), 'Documents', 'gridiron-db-snapshots');

export function flagOn(env = process.env) {
  return ['1', 'true', 'on'].includes(String(env[FLAG] ?? '').toLowerCase());
}

const baseOf = dbPath => path.basename(dbPath).replace(/\.sqlite$/, '');
const pad = n => String(n).padStart(2, '0');

/** `data.20260926T043000Z.snapshot.sqlite` for data.sqlite at that UTC second. */
export function snapshotName(dbPath, now = Date.now()) {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `${baseOf(dbPath)}.${stamp}.snapshot.sqlite`;
}

/** Epoch ms from a snapshot name of database `base`, or null when it is not one. */
export function parseSnapshotStamp(name, base) {
  if (!name.startsWith(`${base}.`)) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.snapshot\.sqlite$/.exec(name.slice(base.length + 1));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? ms : null;
}

function readVerdict(file) {
  const p = `${file}${VERDICT_SUFFIX}`;
  if (!fs.existsSync(p)) return { verdict: null, verdict_error: 'no verdict file' };
  try {
    return { verdict: JSON.parse(fs.readFileSync(p, 'utf8')), verdict_error: null };
  } catch (error) {
    // An unreadable verdict is reported and the copy is treated as unverified (never moved).
    return { verdict: null, verdict_error: `unreadable verdict: ${error.message}` };
  }
}

/** This database's snapshots in `destDir`, newest first, plus lookalikes left alone and why. */
export function listSnapshots(destDir, dbPath) {
  const base = baseOf(dbPath);
  const snapshots = [];
  const ignored = [];
  if (!fs.existsSync(destDir)) return { snapshots, ignored };
  for (const name of fs.readdirSync(destDir)) {
    if (!name.startsWith(`${base}.`) || !name.endsWith('.snapshot.sqlite')) continue;
    const file = path.join(destDir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile()) { ignored.push({ name, reason: st.isSymbolicLink() ? 'symlink' : 'not_a_file' }); continue; }
    const stampMs = parseSnapshotStamp(name, base);
    if (stampMs == null) { ignored.push({ name, reason: 'unreadable_stamp' }); continue; }
    const { verdict, verdict_error } = readVerdict(file);
    snapshots.push({ name, path: file, bytes: st.size, stamp_ms: stampMs, mtime_ms: st.mtimeMs,
      verified: verdict?.ok === true, failed: verdict?.ok === false, verdict_error });
  }
  snapshots.sort((a, b) => b.stamp_ms - a.stamp_ms || b.name.localeCompare(a.name));
  return { snapshots, ignored };
}

/** Main file plus WAL: what VACUUM INTO has to read. */
export function sourceBytes(dbPath) {
  const wal = `${dbPath}-wal`;
  return fs.statSync(dbPath).size + (fs.existsSync(wal) ? fs.statSync(wal).size : 0);
}

function nearestExisting(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

function freeBytes(destDir, statfs) {
  const s = statfs(nearestExisting(destDir));
  return s.bavail * s.bsize;
}

/** Is there room on the snapshot disk? Reads only. */
export function checkRoom({ dbPath, destDir, statfs = fs.statfsSync }) {
  const source = sourceBytes(dbPath);
  const needed = Math.ceil(source * HEADROOM_FACTOR);
  const free = freeBytes(destDir, statfs);
  return { ok: free >= needed, source_bytes: source, needed_bytes: needed, free_bytes: free };
}

/** VACUUM INTO from a read-only connection; the copy loses its write bits. Returns its path. */
export function takeSnapshot({ dbPath, destDir, now = Date.now() }) {
  fs.mkdirSync(destDir, { recursive: true });
  const out = path.join(destDir, snapshotName(dbPath, now));
  if (fs.existsSync(out)) throw new Error(`A snapshot named ${path.basename(out)} already exists; not overwriting it.`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  fs.chmodSync(out, 0o444);
  return out;
}

function tableNames(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(r => r.name);
  } finally {
    d.close();
  }
}

/**
 * integrity_check on the copy, and every source table present in it. A copy SQLite
 * cannot even open is a failed verdict carrying SQLite's message, not an exception:
 * the point of this step is to record that verdict. The source failing to open does
 * throw, since then nothing can be said about the copy.
 */
export function verifySnapshot(snapshotPath, dbPath, now = Date.now()) {
  const sourceTables = tableNames(dbPath);
  let integrity;
  let tables = [];
  try {
    const d = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const rows = d.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check);
      integrity = rows.length === 1 && rows[0] === 'ok' ? 'ok' : rows.slice(0, 5).join('; ');
    } finally {
      d.close();
    }
    if (integrity === 'ok') tables = tableNames(snapshotPath);
  } catch (error) {
    integrity = `could not read: ${error.message}`;
  }
  const have = new Set(tables);
  const missing = integrity === 'ok' ? sourceTables.filter(t => !have.has(t)) : [];
  const verdict = {
    ok: integrity === 'ok' && missing.length === 0,
    integrity,
    missing_tables: missing,
    tables: tables.length,
    bytes: fs.statSync(snapshotPath).size,
    checked_at: new Date(now).toISOString(),
  };
  fs.writeFileSync(`${snapshotPath}${VERDICT_SUFFIX}`, `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

/** Pure decision: which copies stay and which go to the Trash. Nothing on disk changes. */
export function planRotation({ destDir, dbPath, now = Date.now(), retainDays = RETAIN_DAYS, latest = null }) {
  const { snapshots, ignored } = listSnapshots(destDir, dbPath);
  const cutoff = now - retainDays * DAY_MS;
  const newest = snapshots[0];
  let blocked = null;
  if (latest?.ok === false || newest?.failed) blocked = 'newest_snapshot_failed_verification';
  else if (newest && !newest.verified) blocked = 'newest_snapshot_unverified';

  const keep = [];
  const move = [];
  const unverified = [];
  let newestVerifiedSeen = false;
  for (const s of snapshots) {
    if (!s.verified) { unverified.push(s); continue; }
    const recent = Math.max(s.stamp_ms, s.mtime_ms) >= cutoff;
    if (recent || !newestVerifiedSeen || blocked) keep.push(s);
    else move.push(s);
    newestVerifiedSeen = true;
  }
  return {
    dest_dir: destDir, retain_days: retainDays, now, blocked,
    keep, move, unverified, ignored,
    bytes_to_move: move.reduce((n, s) => n + s.bytes, 0),
  };
}

/** The user's Trash, or null where this script does not know one (it then refuses to move). */
export function defaultTrashDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, '.Trash');
  if (platform === 'linux') return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Trash');
  return null;
}

function freeName(dir, name) {
  const taken = n => fs.existsSync(path.join(dir, n)) || fs.existsSync(path.join(dir, `${n}${VERDICT_SUFFIX}`));
  if (!taken(name)) return name;
  for (let i = 2; ; i += 1) if (!taken(`${name} ${i}`)) return `${name} ${i}`;
}

/**
 * Rename every copy in `plan.move`, and its verdict file, into the Trash. rename() only:
 * on another volume it fails with EXDEV and the copy stays. Each failure is reported.
 */
export function applyRotation(plan, { trashDir = defaultTrashDir(), platform = process.platform, rename = fs.renameSync, now = Date.now() } = {}) {
  if (!trashDir) throw new Error(`No Trash folder known for platform "${platform}"; nothing was moved.`);
  const freedesktop = platform === 'linux';
  const filesDir = freedesktop ? path.join(trashDir, 'files') : trashDir;
  fs.mkdirSync(filesDir, { recursive: true });
  if (freedesktop) fs.mkdirSync(path.join(trashDir, 'info'), { recursive: true });

  const moved = [];
  const failed = [];
  for (const s of plan.move) {
    const target = freeName(filesDir, s.name);
    try {
      rename(s.path, path.join(filesDir, target));
    } catch (error) {
      failed.push({ name: s.name, bytes: s.bytes, code: error.code ?? 'ERROR',
        reason: error.code === 'EXDEV' ? 'on a different volume than the Trash; left in place' : error.message });
      continue;
    }
    const verdictFile = `${s.path}${VERDICT_SUFFIX}`;
    if (fs.existsSync(verdictFile)) {
      try {
        rename(verdictFile, path.join(filesDir, `${target}${VERDICT_SUFFIX}`));
      } catch (error) {
        failed.push({ name: `${s.name}${VERDICT_SUFFIX}`, bytes: 0, code: error.code ?? 'ERROR',
          reason: `snapshot moved, its verdict file did not: ${error.message}` });
      }
    }
    if (freedesktop) {
      const when = new Date(now).toISOString().slice(0, 19);
      fs.writeFileSync(path.join(trashDir, 'info', `${target}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(s.path)}\nDeletionDate=${when}\n`);
    }
    moved.push({ name: s.name, bytes: s.bytes, trash_name: target });
  }
  return { trash_dir: trashDir, moved, failed, bytes_moved: moved.reduce((n, s) => n + s.bytes, 0) };
}

/** Sizes: the source, every copy, their total, growth since the previous verified copy, free disk. */
export function sizeReport({ dbPath, destDir, statfs = fs.statfsSync }) {
  const { snapshots } = listSnapshots(destDir, dbPath);
  const verified = snapshots.filter(s => s.verified);
  return {
    source_bytes: sourceBytes(dbPath),
    snapshots: snapshots.map(s => ({ name: s.name, bytes: s.bytes, verified: s.verified })),
    total_snapshot_bytes: snapshots.reduce((n, s) => n + s.bytes, 0),
    growth_bytes: verified.length >= 2 ? verified[0].bytes - verified[1].bytes : null,
    free_bytes: freeBytes(destDir, statfs),
  };
}

export function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : '';
  const b = Math.abs(bytes);
  if (b >= 1024 ** 3) return `${sign}${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${sign}${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${sign}${b} B`;
}

function formatPlan(plan, result) {
  const lines = [];
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  for (const s of plan.keep) lines.push(`  keep        ${s.name}  ${formatBytes(s.bytes)}  ${day(s.stamp_ms)}`);
  for (const s of plan.move) lines.push(`  ${result ? 'to Trash  ' : 'would move'}  ${s.name}  ${formatBytes(s.bytes)}  ${day(s.stamp_ms)}`);
  for (const s of plan.unverified) lines.push(`  left alone (${s.failed ? 'failed verification' : s.verdict_error})  ${s.name}`);
  for (const s of plan.ignored) lines.push(`  left alone (${s.reason})  ${s.name}`);
  if (plan.blocked) lines.push(`Nothing old moves: ${plan.blocked.replace(/_/g, ' ')}.`);
  if (result) {
    lines.push(`Moved ${result.moved.length} old snapshot(s), ${formatBytes(result.bytes_moved)}, to ${result.trash_dir}.`);
    for (const f of result.failed) lines.push(`  NOT moved ${f.name} (${f.code}): ${f.reason}`);
    if (result.moved.length) lines.push('The space comes back when the Trash is emptied.');
  }
  return lines;
}

function formatSize(r, label) {
  return [
    `Source database: ${formatBytes(r.source_bytes)} (main + WAL)`,
    `${label}: ${r.snapshots.length}, ${formatBytes(r.total_snapshot_bytes)} in all`,
    ...r.snapshots.map(s => `  ${s.name}  ${formatBytes(s.bytes)}${s.verified ? '' : '  (not verified)'}`),
    `Growth since the previous verified snapshot: ${r.growth_bytes == null ? 'n/a (fewer than 2)' : formatBytes(r.growth_bytes)}`,
    `Free on the snapshot disk: ${formatBytes(r.free_bytes)}`,
  ];
}

function parseArgs(argv) {
  const args = { apply: false, json: false, db: DEFAULT_DB_PATH, dest: DEFAULT_DEST, trash: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--dest') args.dest = argv[++i];
    else if (a === '--trash') args.trash = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Returns the exit code: 0 done (or dry run), 1 something failed and was reported,
 * 2 refused because --apply came without the flag.
 */
export function main(argv = process.argv.slice(2), env = process.env, out = console, deps = {}) {
  const { now = Date.now(), statfs = fs.statfsSync, platform = process.platform } = deps;
  const args = parseArgs(argv);
  const room = checkRoom({ dbPath: args.db, destDir: args.dest, statfs });
  const roomLine = `Room: need ${formatBytes(room.needed_bytes)} free (1.5 x source), have ${formatBytes(room.free_bytes)}.`;

  if (!args.apply || !flagOn(env)) {
    const plan = planRotation({ destDir: args.dest, dbPath: args.db, now });
    const lines = [
      `Dry run: tonight would snapshot ${args.db} to ${path.join(args.dest, snapshotName(args.db, now))}.`,
      roomLine + (room.ok ? '' : ' SHORT: tonight would refuse and write nothing.'),
      'Rotation of the copies already there:',
      ...formatPlan(plan, null),
      ...formatSize(sizeReport({ dbPath: args.db, destDir: args.dest, statfs }), 'Snapshots on disk'),
    ];
    if (args.json) out.log(JSON.stringify({ dry_run: true, room, plan }, null, 2));
    else out.log(lines.join('\n'));
    if (args.apply) {
      out.error(`Refusing to write anything: --apply needs ${FLAG}=1.`);
      return 2;
    }
    return 0;
  }

  if (!room.ok) {
    out.error(`${roomLine} Refusing to snapshot; nothing was written.`);
    return 1;
  }
  let snap;
  try {
    snap = takeSnapshot({ dbPath: args.db, destDir: args.dest, now });
  } catch (error) {
    out.error(`Snapshot FAILED: ${error.message}. Nothing old was moved.`);
    return 1;
  }
  const verdict = verifySnapshot(snap, args.db, now);
  const plan = planRotation({ destDir: args.dest, dbPath: args.db, now, latest: verdict });
  const trashDir = args.trash || deps.trashDir || defaultTrashDir(platform);
  const result = plan.move.length ? applyRotation(plan, { trashDir, platform, now }) : { trash_dir: trashDir, moved: [], failed: [], bytes_moved: 0 };
  const size = sizeReport({ dbPath: args.db, destDir: args.dest, statfs });
  if (args.json) {
    out.log(JSON.stringify({ snapshot: snap, verdict, plan, result, size }, null, 2));
  } else {
    out.log([
      `Snapshot ${path.basename(snap)}: ${verdict.ok ? 'integrity ok' : `FAILED verification (${verdict.integrity}${verdict.missing_tables.length ? `; missing tables ${verdict.missing_tables.join(', ')}` : ''})`}, ${verdict.tables} tables, ${formatBytes(verdict.bytes)}.`,
      ...formatPlan(plan, result),
      ...formatSize(size, 'Snapshots kept'),
    ].join('\n'));
  }
  return verdict.ok && result.failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
