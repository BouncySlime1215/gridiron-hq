/**
 * The league-chat corpus: what is in it, pulling it, and moving it.
 *
 * Three endpoints for three machines-worth of situation:
 *
 *   GET  /status   works anywhere. Answers "how old is the chat data the trade
 *                  cards are built on", which is the question a cloud box has
 *                  and cannot answer for itself.
 *   POST /pull     only where `~/Library/Messages/chat.db` exists and opens —
 *                  i.e. Nick's Mac. Runs the extractor incrementally.
 *   POST /upload   the receiving end. A pull on the laptop can hand the derived
 *                  corpus to a cloud box; this is what accepts it.
 *
 * `/pull` is loopback-only on purpose. The tunnel makes this app reachable from
 * the internet (see espn-connect.js's note), and this route spawns a process
 * that reads a private message store — the one endpoint here that must never be
 * callable by whoever has the URL. `isDirectLoopback` already rejects anything
 * carrying a forwarding header, so a tunnelled request cannot pass for local.
 *
 * `/upload` writes the corpus and nothing else: it validates the body is really
 * the corpus before replacing what is there, and keeps the previous copy.
 */
import { Router } from 'express';
import { existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDirectLoopback } from './local-auth.js';
import { chatDbPath } from '../services/manager-signals.js';
import { status, pull, corpusStats } from '../services/league-chat-sync.js';

const r = Router();

/** The panel's whole state, from any machine. */
r.get('/status', (_req, res) => {
  try {
    res.json(status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Only the machine with Messages on it, and only when the browser is really on
 * that machine. A remote caller is told where the button does work rather than
 * being given a bare 403.
 */
function requireLocal(req, res, next) {
  if (isDirectLoopback(req)) return next();
  res.status(403).json({
    error: 'not_local',
    detail: 'Pulling messages reads a private store on the Mac, so it only runs from a browser '
      + 'on that Mac. Open the app locally and pull there; the corpus uploads from the laptop.',
  });
}

let running = null;   // one extraction at a time; the script is idempotent but concurrent runs race the same DB

r.post('/pull', requireLocal, async (req, res) => {
  if (running) return res.status(409).json({ error: 'already_running', detail: 'A pull is already in progress.' });
  const full = req.body?.full === true;
  running = pull({ full });
  try {
    const result = await running;
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    running = null;
  }
});

/**
 * Accept an uploaded corpus.
 *
 * Body is the raw SQLite file. It is written to a temporary path and opened
 * before anything existing is touched: installing a truncated or wrong upload
 * would read downstream exactly like having no chat data at all, which is the
 * failure this whole route exists to prevent.
 */
r.post('/upload', (req, res) => {
  const chunks = [];
  let size = 0;
  const LIMIT = 512 * 1024 * 1024;

  req.on('data', d => {
    size += d.length;
    if (size > LIMIT) { req.destroy(); return; }
    chunks.push(d);
  });

  req.on('end', () => {
    if (!chunks.length) return res.status(400).json({ error: 'empty_body' });
    const dest = chatDbPath();
    const tmp = `${dest}.incoming`;
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(tmp, Buffer.concat(chunks));

      let messages = null;
      try {
        const db = new DatabaseSync(tmp, { readOnly: true });
        messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
        db.close();
      } catch (e) {
        return res.status(400).json({ error: 'not_the_corpus',
          detail: `Uploaded file is not a readable league-chat database: ${e.message}. Nothing was replaced.` });
      }
      if (!messages) {
        return res.status(400).json({ error: 'empty_corpus',
          detail: 'The uploaded corpus has no messages, which would read as no chat data. Nothing was replaced.' });
      }

      if (existsSync(dest)) {
        renameSync(dest, `${dest}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      }
      renameSync(tmp, dest);
      res.json({ ok: true, messages, size_bytes: statSync(dest).size, corpus: corpusStats() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  req.on('error', e => res.status(400).json({ error: 'upload_failed', detail: e.message }));
});

export default r;
