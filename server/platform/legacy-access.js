import { requireAuthenticated } from './auth.js';
import { row } from '../db/index.js';

export function legacyRateLimit({ limit = 120, windowMs = 60_000 } = {}) {
  const windows = new Map();
  return (req, res, next) => {
    const key = req.auth?.userId ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const current = windows.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    windows.set(key, bucket);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) return res.status(429).json({ error: 'rate limit exceeded' });
    next();
  };
}

// Authenticate first: anonymous requests must consistently remain 401 responses
// and must not consume a shared IP bucket that can lock out legitimate users.
export const legacyAuthenticated = [requireAuthenticated, legacyRateLimit()];

export function requirePlatformAdmin(req, res, next) {
  // model:* is the persisted administrator-equivalent grant in migration 007;
  // never trust a caller-supplied role/header for this decision.
  const permission = row('SELECT 1 FROM model_permissions WHERE user_id=? AND permission=?',
    req.auth?.userId, 'model:*');
  if (!permission) return res.status(403).json({ error: 'platform administrator permission required' });
  next();
}

export const legacyAdmin = [...legacyAuthenticated, requirePlatformAdmin];
