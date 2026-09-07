/**
 * CORS for the one endpoint a browser tab on espn.com talks to directly: the live
 * draft capture route. The bookmarklet runs inside ESPN's page, so the request
 * carries an ESPN origin and the browser will only deliver the response if we
 * echo that origin back. Nothing else in the app is cross-origin, so this is
 * scoped to exactly these origins rather than a global `*`.
 *
 * Access-Control-Allow-Private-Network answers Chrome's private-network-access
 * preflight: the page is on the public internet and we are on localhost/LAN.
 */
export const ESPN_ORIGINS = new Set([
  'https://fantasy.espn.com',
  'https://lm.fantasy.espn.com',
  'https://www.espn.com'
]);

export function espnCors(req, res, next) {
  const origin = req.get('origin');
  res.set('Vary', 'Origin');
  if (origin && ESPN_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Allow-Private-Network', 'true');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
