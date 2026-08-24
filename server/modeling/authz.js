// Consume only the verified principal installed by platform identity middleware.
// Headers, request bodies and query strings are never identity sources.
export const modelPrincipal = req => req.principal ?? req.auth?.principal ?? req.user ?? null;

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
