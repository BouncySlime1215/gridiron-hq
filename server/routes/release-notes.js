import { Router } from 'express';
import { latestUnseen, markSeen, noteForToday, releaseNotesFlag, releaseNotesPath } from '../services/release-notes.js';

const r = Router();

/**
 * RELEASE NOTES (Batch D item 60): Today's "what changed for you" note, shown once.
 *
 * GET answers the newest note not yet seen (or `note: null`); POST .../:id/seen hides it. The notes are
 * written by scripts/release-notes.mjs after a batch merges; this route only reads and marks them.
 * Behind GRIDIRON_RELEASE_NOTES (off by default). Off, both answer `{ enabled: false, reason }` and
 * read nothing. An unreadable notes file is reported as `status: 'unknown'`, never as "no news".
 */
r.get('/', (_req, res) => {
  const flag = releaseNotesFlag();
  if (!flag.enabled) return res.json(flag);
  try {
    res.json({ enabled: true, status: 'ok', note: noteForToday(latestUnseen(releaseNotesPath())) });
  } catch (e) {
    console.error('[release-notes] read failed:', e.message);
    res.json({ enabled: true, status: 'unknown', note: null, reason: 'What changed could not be read.' });
  }
});

r.post('/:id/seen', (req, res, next) => {
  const flag = releaseNotesFlag();
  if (!flag.enabled) return res.json(flag);
  try {
    const result = markSeen(releaseNotesPath(), String(req.params.id));
    if (result === 'missing') return res.status(404).json({ ok: false, reason: 'No such note.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
