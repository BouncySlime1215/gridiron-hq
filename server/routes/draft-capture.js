/**
 * Draft-night WebSocket capture: hands the UI a bookmarklet that loads
 * client/public/draft-capture.js into the ESPN draft tab, and serves that
 * script directly so it works in dev (no client/dist) as well as installed mode.
 *
 * The capture POST itself (/api/drafts/:id/capture) lives in routes/drafts.js.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuthenticated, actorForDraft } from '../platform/auth.js';
import { getTunnelUrl } from './local-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'client', 'public', 'draft-capture.js');
const LOCAL_ORIGIN = `http://localhost:${Number(process.env.API_PORT) || 5177}`;

/**
 * Build the javascript: URL. A tiny loader only — the real logic is fetched from
 * our origin with a cache-buster, so the bookmark never goes stale.
 */
export function buildBookmarklet({ origin, draftId, ingestKey }) {
  const base = String(origin).replace(/\/+$/, '');
  const loaderUrl = `${base}/draft-capture.js`;
  const query = `?draft=${encodeURIComponent(String(draftId))}&key=${encodeURIComponent(ingestKey)}&origin=${encodeURIComponent(base)}&t=`;
  const href = `javascript:(function(){var s=document.createElement('script');s.src=${JSON.stringify(loaderUrl + query)}+Date.now();document.head.appendChild(s);})();`;
  return { href, loader_url: loaderUrl };
}

/**
 * The ingest key comes in as ?ingest_key=… from the UI, which obtained it via
 * POST /api/drafts/:id/ingest-key (commissioner-only). This route deliberately
 * does NOT mint one itself: mintIngestKey() rotates the stored hash, so a
 * silent mint here would invalidate the key the draft room already holds and
 * would sidestep the commissioner check.
 */
function resolveIngestKey(req) {
  const fromQuery = typeof req.query.ingest_key === 'string' ? req.query.ingest_key.trim() : '';
  return fromQuery ? { key: fromQuery, source: 'query' } : null;
}

export function serveCaptureScript(_req, res) {
  if (!fs.existsSync(SCRIPT_PATH)) return res.status(404).json({ error: 'draft-capture.js not found' });
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.sendFile(SCRIPT_PATH);
}

const r = express.Router();

r.get('/:id/capture-bookmarklet', requireAuthenticated, async (req, res, next) => {
  try {
    const draftId = Number(req.params.id);
    if (!Number.isInteger(draftId)) return res.status(400).json({ error: 'invalid draft id' });
    if (!actorForDraft(req.auth.userId, draftId)) return res.status(404).json({ error: 'draft not found' });

    const resolved = resolveIngestKey(req);
    if (!resolved) {
      return res.status(400).json({ error: 'ingest_key required: pass ?ingest_key=… obtained from POST /api/drafts/:id/ingest-key' });
    }

    const tunnel = getTunnelUrl();
    const origin = tunnel || LOCAL_ORIGIN;
    const warnings = [];
    if (!tunnel) {
      warnings.push(`no tunnel is registered; falling back to ${LOCAL_ORIGIN}. The https ESPN page will block an http script (mixed content) — run \`npm run tunnel\` first.`);
    }
    const { href, loader_url } = buildBookmarklet({ origin, draftId, ingestKey: resolved.key });
    res.json({
      href, loader_url, origin, draft_id: draftId,
      tunnel_up: !!tunnel, key_source: resolved.source, href_bytes: Buffer.byteLength(href), warnings
    });
  } catch (error) { next(error); }
});

export default r;
