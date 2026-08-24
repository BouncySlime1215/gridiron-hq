// This app has no login system yet — it's a single local user running their
// own instance (npm start). Role is resolved from a request header rather
// than a session, which is honest about the current reality while still
// giving commissioner/developer/admin-gated actions a real enforcement point
// to attach to now, instead of deferring authorization until a multi-user
// auth system exists. When real accounts are added, resolveRole is the only
// function that needs to change.
export const ROLES = ['user', 'commissioner', 'developer', 'admin'];
const DEFAULT_ROLE = 'commissioner'; // local single-user install: full control by default

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
