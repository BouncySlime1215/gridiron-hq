// This app has no login system yet — it's a single local user running their
// own instance (npm start). Role is resolved from a request header rather
// than a session. For safety, the default role is a non-privileged 'user'.
// Set GRIDIRON_DEFAULT_ROLE=commissioner in a local dev environment to
// preserve the old single-user full-control install behavior.
export const ROLES = ['user', 'commissioner', 'developer', 'admin'];
const DEFAULT_ROLE = process.env.GRIDIRON_DEFAULT_ROLE || 'user';

export function resolveRole(req) {
  const header = req.get('x-gridiron-role');
  return ROLES.includes(header) ? header : DEFAULT_ROLE;
}

/** Express middleware factory: 403s unless the resolved role is one of `allowed`. */
export function requireRole(...allowed) {
  return (req, res, next) => {
    const role = resolveRole(req);
    req.gridironRole = role;
    if (!allowed.includes(role)) {
      return res.status(403).json({ error: `requires role: ${allowed.join(' or ')}`, role });
    }
    next();
  };
}
