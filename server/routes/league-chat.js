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
import { existsSync, mkdirSync, renameSync, createWriteStream, statSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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

/** A corpus far larger than any real one; the stream is cut rather than filling the disk. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Accept an uploaded corpus.
 *
 * **Streamed to disk, never buffered.** This used to be `express.raw`, which
 * collects the whole body in memory and concatenates it — about twice the
 * corpus resident at the peak. At 16k messages the corpus is ~62MB, and on a
 * small Fly machine that was enough to get the process killed mid-request:
 * the client saw a bare 502 from fly-proxy with no detail, because the app
 * never lived long enough to answer. Verified 2026-09-19 against the
 * deployment — 35MB succeeded, 48MB and up died in seconds, which is a
 * memory ceiling rather than a timeout or a proxy limit. Piping to a file
 * keeps resident memory flat no matter how big the corpus gets, which
 * matters because it only ever grows.
 *
 * Reading the stream by hand is safe here despite the global `express.json()`
 * upstream: that middleware only consumes a body whose content-type is JSON,
 * and leaves any other request untouched for us to read. A client that sends
 * `application/json` is the one case it would swallow, so `empty_body` below
 * names that trap explicitly rather than reporting a mystery.
 *
 * The upload is written to a temporary path and opened before anything existing
 * is touched: installing a truncated or wrong file would read downstream exactly
 * like having no chat data at all, which is the failure this route exists to
 * prevent.
 */
r.post('/upload', async (req, res) => {
  const dest = chatDbPath();
  const tmp = `${dest}.incoming`;

  try {
    mkdirSync(path.dirname(dest), { recursive: true });

    let tooBig = false;
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES && !tooBig) {
        tooBig = true;
        req.destroy(new Error('upload exceeds the maximum accepted size'));
      }
    });

    try {
      await pipeline(req, createWriteStream(tmp));
    } catch (e) {
      rmSync(tmp, { force: true });
      if (tooBig) {
        return res.status(413).json({ error: 'too_large',
          detail: `The upload passed ${Math.round(MAX_UPLOAD_BYTES / 1e6)} MB, which is far larger than any real corpus. `
            + 'Nothing was replaced.' });
      }
      // A dropped connection is the common case, and it must not look like a
      // rejected file: the client should retry, not go rebuild its corpus.
      return res.status(400).json({ error: 'upload_interrupted',
        detail: `The upload stopped before the whole file arrived (${e.message}). Nothing was replaced — send it again.` });
    }

    if (!statSync(tmp).size) {
      rmSync(tmp, { force: true });
      return res.status(400).json({ error: 'empty_body',
        detail: 'Send the corpus as the raw request body, e.g. curl --data-binary @league_chat.sqlite. '
          + 'A body sent as application/json is consumed before this route sees it; use application/octet-stream.' });
    }

    let messages = null;
    try {
      const db = new DatabaseSync(tmp, { readOnly: true });
      messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      db.close();
    } catch (e) {
      rmSync(tmp, { force: true });
      return res.status(400).json({ error: 'not_the_corpus',
        detail: `Uploaded file is not a readable league-chat database: ${e.message}. Nothing was replaced.` });
    }
    if (!messages) {
      rmSync(tmp, { force: true });
      return res.status(400).json({ error: 'empty_corpus',
        detail: 'The uploaded corpus has no messages, which would read as no chat data. Nothing was replaced.' });
    }

    if (existsSync(dest)) {
      renameSync(dest, `${dest}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
    renameSync(tmp, dest);
    res.json({ ok: true, messages, size_bytes: statSync(dest).size, corpus: corpusStats() });
  } catch (e) {
    rmSync(tmp, { force: true });
    res.status(500).json({ error: e.message });
  }
});

export default r;
