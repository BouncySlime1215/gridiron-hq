/**
 * Single-instance lockfiles for the long-running processes (ENGINE-ARCHITECTURE.md §9.1;
 * ENGINE-SPECS ENGINE-00b-a (5)).
 *
 * The engine daemon takes `engine.lock` and the refresh loop takes `refresh.lock`, both
 * next to the database by default (~/gridiron-local/ on the Mac). Two refresh loops were
 * found running at once (A13); two daemons would be two writers of the engine tables.
 *
 * The lock is a file created with O_EXCL holding {pid, started_at, host, token}. A second
 * copy finds it and refuses with "already running pid N". A lock whose holder is dead
 * (`kill(pid, 0)` says ESRCH on this host) is taken over: a crash or a SIGKILL never
 * leaves the process locked out until someone deletes a file by hand. A lock held by a
 * live pid on another host is never taken (we cannot see that pid).
 *
 * This module lives outside services/engine/ on purpose: the refresh job never imports
 * services/engine/* (a grep test pins that), and both processes share this one primitive.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class LockHeldError extends Error {
  constructor(file, holder) {
    super(`already running pid ${holder?.pid ?? '?'} (lock ${file}, held since ${holder?.started_at ?? '?'} on ${holder?.host ?? '?'})`);
    this.name = 'LockHeldError';
    this.file = file;
    this.holder = holder;
  }
}

/** True when `pid` is a live process on this host. EPERM means it exists but is not ours. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readHolder(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(text); } catch { return { pid: null, unreadable: text.slice(0, 200) }; }
}

/**
 * Take the lock at `file` or throw LockHeldError. Returns {file, holder, tookOver,
 * previous, held(), release()}. `held()` re-reads the file and is true only while it still
 * carries this process's token; `release()` removes the file only if it is still ours.
 */
export function acquireLock(file, { name = path.basename(file), host = os.hostname(), pid = process.pid,
  alive = pidAlive } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holder = { name, pid, host, started_at: new Date().toISOString(), token: crypto.randomUUID() };
  let tookOver = false;
  let previous = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      try { fs.writeSync(fd, `${JSON.stringify(holder)}\n`); } finally { fs.closeSync(fd); }
      return makeHandle(file, holder, tookOver, previous);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const current = readHolder(file);
    if (current == null) continue; // removed between our open and our read: try again
    const sameHost = current.host == null || current.host === host;
    const dead = sameHost && Number.isInteger(current.pid) && !alive(current.pid);
    // An unreadable lock (a crash mid-write) with no pid is stale too; anything else is live.
    const stale = dead || (sameHost && current.pid == null);
    if (!stale) throw new LockHeldError(file, current);
    // Take over: rename the stale file aside first, so two contenders cannot both win.
    const aside = `${file}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    fs.rmSync(aside, { force: true });
    tookOver = true;
    previous = current;
  }
  throw new LockHeldError(file, readHolder(file));
}

function makeHandle(file, holder, tookOver, previous) {
  let released = false;
  return {
    file, holder, tookOver, previous,
    held() {
      if (released) return false;
      const current = readHolder(file);
      return current?.token === holder.token;
    },
    release() {
      if (released) return false;
      released = true;
      const current = readHolder(file);
      if (current?.token !== holder.token) return false;
      fs.rmSync(file, { force: true });
      return true;
    },
  };
}

/** The default lock path for a process: next to the database file. */
export function defaultLockPath(dbPath, name) {
  return path.join(path.dirname(path.resolve(dbPath)), name);
}
