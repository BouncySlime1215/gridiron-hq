/**
 * The engine daemon's single-instance lock (ENGINE-ARCHITECTURE.md §9.1): `engine.lock`
 * next to the database unless GRIDIRON_ENGINE_LOCK names another path. The primitive is
 * shared with the refresh loop (server/services/process-lock.js), which must not import
 * anything under services/engine/.
 */
import { acquireLock, defaultLockPath, LockHeldError, pidAlive } from '../../process-lock.js';

export { LockHeldError, pidAlive };

export function engineLockPath(dbPath, env = process.env) {
  return env.GRIDIRON_ENGINE_LOCK || defaultLockPath(dbPath, 'engine.lock');
}

/** Take engine.lock or throw LockHeldError ("already running pid N"). */
export function acquireEngineLock(dbPath, { file = engineLockPath(dbPath), ...opts } = {}) {
  return acquireLock(file, { name: 'engine-daemon', ...opts });
}
