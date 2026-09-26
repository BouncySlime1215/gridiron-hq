#!/usr/bin/env node
/**
 * BACKUP HYGIENE (plan item 55): move old pre-migration snapshots to the Trash.
 *
 * server/db/index.js#backupBeforeMigration writes `data.sqlite.pre-migration-<stamp>.bak`
 * beside the database before every schema upgrade, and never prunes them: on 2026-09-10
 * eight of them held 57.3 GB and the next migration was refused for lack of room.
 * That code is right that giving up a recovery point is a person's call. This script
 * is that person's tool, run by hand; nothing imports it and no job schedules it.
 *
 * What it will do, and nothing else:
 *   - consider only regular files named exactly `<db file>.pre-migration-<stamp>.bak`
 *     in the database's own folder (never the live file, -wal/-shm, symlinks, or any
 *     other .bak);
 *   - always keep the newest KEEP (3) by stamp, however old they are;
 *   - of the rest, only those older than MIN_AGE_DAYS (14) by BOTH the name's stamp
 *     and the file's mtime;
 *   - MOVE them to the Trash with rename(). It never deletes. A file on another volume
 *     than the Trash stays where it is and is reported, rather than copied then deleted.
 *
 * Dry run by default. Moving needs `--apply` AND GRIDIRON_BACKUP_HYGIENE=1.
 *
 * Usage:
 *   node scripts/backup-hygiene.mjs                    # report what would move
 *   GRIDIRON_BACKUP_HYGIENE=1 node scripts/backup-hygiene.mjs --apply
 *   node scripts/backup-hygiene.mjs --db /path/to/data.sqlite --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FLAG = 'GRIDIRON_BACKUP_HYGIENE';
export const KEEP = 3;
export const MIN_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Same default as server/db/index.js, read without opening the database. */
export const DEFAULT_DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(ROOT, 'server', 'data.sqlite');

export function flagOn(env = process.env) {
  return ['1', 'true', 'on'].includes(String(env[FLAG] ?? '').toLowerCase());
}

/**
 * backupBeforeMigration's stamp is `new Date().toISOString()` with ':' and '.' turned
 * into '-': 2026-09-10T12-34-56-789Z. Returns epoch ms, or null if it is not that shape.
 */
export function parseStamp(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every pre-migration snapshot of `dbPath`, plus lookalikes that were left alone and why. */
export function listSnapshots(dbPath) {
  const dir = path.dirname(path.resolve(dbPath));
  const base = path.basename(dbPath);
  const re = new RegExp(`^${escapeRe(base)}\\.pre-migration-(.+)\\.bak$`);
  const snapshots = [];
  const ignored = [];
  for (const name of fs.readdirSync(dir)) {
    const m = re.exec(name);
    if (!m) {
      if (name.startsWith(`${base}.pre-migration-`)) ignored.push({ name, reason: 'not_a_snapshot_name' });
      continue;
    }
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile()) { ignored.push({ name, reason: st.isSymbolicLink() ? 'symlink' : 'not_a_file' }); continue; }
    const stampMs = parseStamp(m[1]);
    if (stampMs == null) { ignored.push({ name, reason: 'unreadable_stamp' }); continue; }
    snapshots.push({ name, path: file, bytes: st.size, stamp_ms: stampMs, mtime_ms: st.mtimeMs });
  }
  snapshots.sort((a, b) => b.stamp_ms - a.stamp_ms || b.name.localeCompare(a.name));
  return { dir, snapshots, ignored };
}

/** Pure decision: which snapshots stay, which go. Nothing on disk changes. */
export function planPrune({ dbPath = DEFAULT_DB_PATH, now = Date.now(), keep = KEEP, minAgeDays = MIN_AGE_DAYS } = {}) {
  const { dir, snapshots, ignored } = listSnapshots(dbPath);
  const cutoff = now - minAgeDays * DAY_MS;
  const newest = [];
  const tooYoung = [];
  const move = [];
  snapshots.forEach((s, i) => {
    if (i < keep) newest.push(s);
    else if (Math.max(s.stamp_ms, s.mtime_ms) > cutoff) tooYoung.push(s);
    else move.push(s);
  });
  return {
    dir, keep, min_age_days: minAgeDays, now,
    newest, too_young: tooYoung, move, ignored,
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
  if (!fs.existsSync(path.join(dir, name))) return name;
  for (let i = 2; ; i += 1) {
    const candidate = `${name} ${i}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/**
 * Move every file in `plan.move` to the Trash. rename() only: on a different volume it
 * fails with EXDEV and the file stays put. Each failure is reported, never swallowed.
 */
export function applyPrune(plan, { trashDir = defaultTrashDir(), platform = process.platform, rename = fs.renameSync, now = Date.now() } = {}) {
  if (!trashDir) throw new Error(`No Trash folder known for platform "${platform}"; nothing was moved.`);
  // freedesktop Trash keeps files/ and info/ so the file manager can restore to origin.
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
    if (freedesktop) {
      const when = new Date(now).toISOString().slice(0, 19);
      fs.writeFileSync(path.join(trashDir, 'info', `${target}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(s.path)}\nDeletionDate=${when}\n`);
    }
    moved.push({ name: s.name, bytes: s.bytes, trash_name: target });
  }
  return { trash_dir: trashDir, moved, failed, bytes_moved: moved.reduce((n, s) => n + s.bytes, 0) };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} B`;
}

export function formatReport(plan, result = null) {
  const lines = [];
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  lines.push(`Pre-migration snapshots in ${plan.dir}: ${plan.newest.length + plan.too_young.length + plan.move.length}`);
  for (const s of plan.newest) lines.push(`  keep (newest ${plan.keep})   ${s.name}  ${formatBytes(s.bytes)}  ${day(s.stamp_ms)}`);
  for (const s of plan.too_young) lines.push(`  keep (< ${plan.min_age_days} days) ${s.name}  ${formatBytes(s.bytes)}  ${day(s.stamp_ms)}`);
  for (const s of plan.move) lines.push(`  ${result ? 'to Trash' : 'would move'}  ${s.name}  ${formatBytes(s.bytes)}  ${day(s.stamp_ms)}`);
  for (const s of plan.ignored) lines.push(`  left alone (${s.reason})  ${s.name}`);
  if (!result) {
    lines.push(`Dry run: ${plan.move.length} snapshot(s), ${formatBytes(plan.bytes_to_move)}, would move to the Trash.`);
  } else {
    lines.push(`Moved ${result.moved.length} snapshot(s), ${formatBytes(result.bytes_moved)}, to ${result.trash_dir}.`);
    for (const f of result.failed) lines.push(`  NOT moved ${f.name} (${f.code}): ${f.reason}`);
    if (result.moved.length) lines.push('The space comes back when the Trash is emptied.');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { apply: false, json: false, db: DEFAULT_DB_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--db') args.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const args = parseArgs(argv);
  const plan = planPrune({ dbPath: args.db });
  if (args.apply && !flagOn(env)) {
    out.log(formatReport(plan));
    out.error(`Refusing to move anything: --apply needs ${FLAG}=1.`);
    return 2;
  }
  const result = args.apply ? applyPrune(plan) : null;
  if (args.json) out.log(JSON.stringify({ plan, result }, null, 2));
  else out.log(formatReport(plan, result));
  return result?.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
