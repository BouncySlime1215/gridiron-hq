import { rows } from '../db/index.js';
import { resolveAuthenticatedUser } from '../platform/auth.js';

// Model identity is always reconstructed from the persisted bearer session and
// persisted grants. Request properties and headers are deliberately not trusted.
export function modelPrincipal(req) {
  const auth = resolveAuthenticatedUser(req);
  if (!auth) return null;
  return {
    id: auth.userId,
    subject: auth.subject,
    permissions: rows('SELECT permission FROM model_permissions WHERE user_id = ?', auth.userId).map(x => x.permission)
  };
}

export const requireModelPermission = permission => (req, res, next) => {
  const principal = modelPrincipal(req);
  if (!principal?.id) return res.status(401).json({ error: 'authentication required' });
  const permissions = principal.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes('model:*') && principal.role !== 'admin') {
    return res.status(403).json({ error: `${permission} permission required` });
  }
  req.modelPrincipal = principal;
  next();
};
