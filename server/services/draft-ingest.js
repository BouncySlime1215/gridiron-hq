/**
 * Live draft ingest from captured ESPN draft-room frames.
 *
 * A bookmarklet in the user's own ESPN tab taps the draft room's WebSocket and POSTs
 * the raw frames here (see draft-frames.js for the protocol). This module stores
 * them, rebuilds the board from them, and hands the result to the same reconciler
 * the ESPN poller uses — so the board, recommendations and grade all keep working
 * unchanged, and every correction is audited the same way.
 *
 * Board reconstruction, per capture (one browser tab session):
 *   - If the capture contains an INIT snapshot, its decoded ledger is the
 *     authoritative list of made picks, and SELECTED frames after it append.
 *   - Otherwise the board starts from the baseline the tab reported (or our local
 *     pick count when the capture began) and SELECTED frames append in order.
 *   - SELECTED carries a roster slot, not the overall pick number, so pick numbers
 *     are derived by counting. UNDONE <n> removes pick n.
 */
import crypto from 'node:crypto';
import { rows, row, run, db } from '../db/index.js';
import { hashSessionToken } from '../platform/auth.js';
import { reconcileDraftBoard } from './draft-reconcile.js';
import { parseFrame, decodeInitLedger } from './draft-frames.js';
import { resolveEspnPlayers, boardSummary, ingestIsFresh } from './espn-draft.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS draft_capture_sessions (
    capture_id TEXT PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    baseline_picks INTEGER,
    started_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS draft_capture_events (
    capture_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    draft_id INTEGER NOT NULL,
    ts INTEGER,
    dir TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (capture_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_draft_capture_events_draft ON draft_capture_events(draft_id, capture_id, seq);
`);

export const MAX_FRAMES_PER_BATCH = 200;
const KEY_PREFIX = 'gik_';
const KEY_HOURS_AFTER_DRAFT = 8;
const KEY_HOURS_DEFAULT = 12;

/* ------------------------------------------------------------------ keys */

/**
 * Mint a fresh ingest key for a draft, replacing any previous one. Only the hash is
 * stored; the raw key is returned once for the commissioner to paste into the tab.
 */
export function mintIngestKey(draftId, now = Date.now()) {
  const draft = row('SELECT id, draft_at FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const draftAt = draft.draft_at ? Date.parse(draft.draft_at) : NaN;
  const afterDraft = Number.isFinite(draftAt) ? draftAt + KEY_HOURS_AFTER_DRAFT * 3600_000 : NaN;
  // draft_at + 8h, unless that is already behind us (a draft linked after the fact,
  // or a stale scheduled time) — a key that expires the moment it is minted is useless.
  const expires = Number.isFinite(afterDraft) && afterDraft > now + 3600_000 ? afterDraft : now + KEY_HOURS_DEFAULT * 3600_000;
  const expiresAt = new Date(expires).toISOString();
  run('UPDATE drafts SET ingest_key_hash = ?, ingest_key_expires_at = ? WHERE id = ?', hashSessionToken(key), expiresAt, draft.id);
  return { key, expires_at: expiresAt };
}

/** True when `key` is the draft's current, unexpired ingest key. */
export function verifyIngestKey(draft, key, now = Date.now()) {
  if (!draft?.ingest_key_hash || typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return false;
  const expires = draft.ingest_key_expires_at ? Date.parse(draft.ingest_key_expires_at) : NaN;
  if (!Number.isFinite(expires) || expires <= now) return false;
  const a = Buffer.from(hashSessionToken(key), 'hex'), b = Buffer.from(draft.ingest_key_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- status */

export function ingestStatus(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  const captureId = draft.ingest_capture_id ?? null;
  return {
    active: ingestIsFresh(draft),
    last_seen_at: draft.ingest_last_seen_at ?? null,
    capture_id: captureId,
    frames_seen: captureId ? row('SELECT COUNT(*) AS n FROM draft_capture_events WHERE capture_id = ?', captureId).n : 0,
    picks_from_capture: row(`SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ? AND source = 'espn-page'`, draft.id).n,
    key_expires_at: draft.ingest_key_expires_at ?? null
  };
}

/* ---------------------------------------------------------------- ingest */

function validFrame(f) {
  if (!f || typeof f !== 'object') return 'frame is not an object';
  if (!Number.isInteger(f.seq) || f.seq < 0) return 'seq must be a non-negative integer';
  if (f.dir !== 'in' && f.dir !== 'out') return 'dir must be "in" or "out"';
  if (typeof f.data !== 'string') return 'data must be a string';
  return null;
}

/** Store a batch's frames. Returns counts plus per-frame problems. */
function storeFrames(draftId, captureId, frames) {
  let accepted = 0, duplicates = 0;
  const parseErrors = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of frames) {
      const problem = validFrame(f);
      if (problem) { parseErrors.push({ seq: f?.seq ?? null, error: problem }); continue; }
      const ev = parseFrame(f.data);
      const { type, raw, ...payload } = ev;
      if (type === 'UNKNOWN') payload.raw = String(raw ?? '').slice(0, 512);
      const r = db.prepare(`INSERT OR IGNORE INTO draft_capture_events (capture_id, seq, draft_id, ts, dir, type, payload_json)
                            VALUES (?,?,?,?,?,?,?)`)
        .run(captureId, f.seq, draftId, Number.isFinite(f.ts) ? Math.trunc(f.ts) : null, f.dir, type, JSON.stringify(payload));
      if (r.changes > 0) accepted += 1; else duplicates += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { accepted, duplicates, parseErrors };
}

/**
 * Rebuild the authoritative made-pick list from one capture's stored inbound events.
 * Returns { made, fromInit, undone, errors } where `made` is in the reconciler's shape
 * ({ overallPickNumber, teamId, playerId, keeper }) sorted by pick number.
 */
export function reconstructBoard(draft, captureId) {
  const total = draft.team_count * draft.rounds;
  const errors = [];
  const events = rows(`SELECT seq, type, payload_json FROM draft_capture_events
                       WHERE capture_id = ? AND dir = 'in' ORDER BY seq`, captureId)
    .map(e => ({ seq: e.seq, type: e.type, ...JSON.parse(e.payload_json ?? '{}') }));

  // Latest INIT wins: it is a full snapshot, so anything before it is history.
  let init = null;
  for (const e of events) if (e.type === 'INIT') init = e;
  let ledger = null;
  if (init) {
    ledger = decodeInitLedger(init.data, { teamCount: draft.team_count, rounds: draft.rounds });
    if (ledger.error) { errors.push({ seq: init.seq, error: ledger.error }); ledger = null; }
  }

  const made = new Map(); // pickNumber -> pick
  let afterSeq = -Infinity;
  if (ledger) {
    for (const p of ledger.picks) {
      if (p.playerId !== -1) made.set(p.pickNumber, { overallPickNumber: p.pickNumber, teamId: p.teamId, playerId: p.playerId, keeper: false });
    }
    afterSeq = init.seq;
  } else {
    // No snapshot: keep whatever was on the board when this capture began, expressed
    // so the reconciler leaves it untouched, and append from there.
    const session = row('SELECT baseline_picks FROM draft_capture_sessions WHERE capture_id = ?', captureId);
    const baseline = session?.baseline_picks ?? 0;
    for (const p of rows(`SELECT dp.pick_number, dp.team_slot, dp.espn_team_id, dp.player_id, pl.espn_id
                          FROM draft_picks dp JOIN players pl ON pl.id = dp.player_id
                          WHERE dp.draft_id = ? AND dp.pick_number <= ? ORDER BY dp.pick_number`, draft.id, baseline)) {
      made.set(p.pick_number, {
        overallPickNumber: p.pick_number,
        teamId: p.espn_team_id ?? `slot:${p.team_slot}`,
        playerId: p.espn_id ?? `local:${p.player_id}`,
        keeper: false, _local: { playerId: p.player_id, slot: p.team_slot }
      });
    }
  }

  const taken = new Set([...made.values()].map(p => p.playerId));
  const nextNumber = () => (made.size ? Math.max(...made.keys()) : 0) + 1;
  let undone = 0;
  for (const e of events) {
    if (e.seq <= afterSeq) continue;
    if (e.type === 'SELECTED') {
      if (e.playerId === -1 || taken.has(e.playerId)) continue; // empty or an echo of a pick we already hold
      const n = nextNumber();
      if (n > total) { errors.push({ seq: e.seq, error: `pick ${n} exceeds the ${total}-pick board` }); continue; }
      made.set(n, { overallPickNumber: n, teamId: e.teamId, playerId: e.playerId, keeper: false });
      taken.add(e.playerId);
    } else if (e.type === 'UNDONE') {
      const gone = made.get(e.pickNumber);
      if (gone) { made.delete(e.pickNumber); taken.delete(gone.playerId); undone += 1; }
    }
  }

  const list = [...made.values()].sort((a, b) => a.overallPickNumber - b.overallPickNumber);
  return { made: list, fromInit: !!ledger, undone, errors };
}

/**
 * Accept one batch of captured frames for a draft and mirror the resulting board.
 * Must run under withDraftLock(draftId) — the route does that.
 */
export async function ingestCapture(draftId, { capture_id: captureId, frames = [], baseline = null, heartbeat = false } = {}) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  if (typeof captureId !== 'string' || !captureId.trim() || captureId.length > 128) {
    throw Object.assign(new Error('capture_id required'), { status: 400 });
  }
  if (!Array.isArray(frames)) throw Object.assign(new Error('frames must be an array'), { status: 400 });
  if (frames.length > MAX_FRAMES_PER_BATCH) {
    throw Object.assign(new Error(`at most ${MAX_FRAMES_PER_BATCH} frames per batch`), { status: 400 });
  }

  const now = new Date().toISOString();
  if (!row('SELECT 1 FROM draft_capture_sessions WHERE capture_id = ?', captureId)) {
    const reported = Number.isInteger(baseline?.picks_on_board) && baseline.picks_on_board >= 0 ? baseline.picks_on_board : null;
    const local = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
    run(`INSERT INTO draft_capture_sessions (capture_id, draft_id, baseline_picks, last_seen_at) VALUES (?,?,?,?)`,
      captureId, draft.id, reported ?? local, now);
  }
  const { accepted, duplicates, parseErrors } = storeFrames(draft.id, captureId, frames);
  run('UPDATE draft_capture_sessions SET last_seen_at = ? WHERE capture_id = ?', now, captureId);
  run('UPDATE drafts SET ingest_last_seen_at = ?, ingest_capture_id = ? WHERE id = ?', now, captureId, draft.id);

  const meta = { source: 'espn-page', accepted, duplicates, parse_errors: parseErrors, heartbeat: !!heartbeat };
  const localCount = () => row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;

  // Nothing new (a heartbeat, or a redelivered batch): report the board as it stands.
  if (accepted === 0) {
    return { ok: true, ...meta, ...boardSummary(draft, { madeCount: localCount(), complete: draft.status === 'complete', inProgress: draft.status !== 'complete' }) };
  }

  const { made, fromInit, undone, errors } = reconstructBoard(draft, captureId);
  meta.parse_errors.push(...errors);

  // A capture with no snapshot that knows about FEWER picks than we hold, without an
  // undo to explain it, is a stale or late-joining tab — applying it would delete
  // real picks as "stale". Keep the board and say so, same as the poller's guard
  // against a transient empty ESPN response.
  const before = localCount();
  if (!fromInit && made.length < before - undone) {
    meta.parse_errors.push({ seq: null, error: `capture ${captureId} trails the mirrored board (${made.length} < ${before}); ignored` });
    return { ok: true, ...meta, ...boardSummary(draft, { madeCount: before }), desynced: true };
  }

  const espnIds = [...new Set(made.map(p => p.playerId).filter(id => typeof id === 'number'))];
  const idMap = espnIds.length ? await resolveEspnPlayers(espnIds, draft.season, { network: false }) : new Map();
  const order = JSON.parse(draft.pick_order ?? '{}').order ?? [];
  const slotOf = new Map(order.map((teamId, i) => [teamId, i + 1]));
  for (const p of made) {
    if (!p._local) continue;
    idMap.set(p.playerId, p._local.playerId);
    if (typeof p.teamId === 'string') slotOf.set(p.teamId, p._local.slot);
  }

  const { added, corrected, removed, quarantined } = reconcileDraftBoard(draft.id, made, idMap, slotOf, `capture:${captureId}:${now}`);
  if (added.length) {
    run(`UPDATE draft_picks SET source = 'espn-page' WHERE draft_id = ? AND pick_number IN (${added.map(() => '?').join(',')})`,
      draft.id, ...added);
  }
  const total = draft.team_count * draft.rounds;
  const complete = made.length >= total;
  run(`UPDATE drafts SET status = ? WHERE id = ?`, complete ? 'complete' : 'active', draft.id);

  return {
    ok: true, ...meta,
    ...boardSummary(draft, { madeCount: made.length, added, corrected, removed, quarantined, inProgress: !complete, complete })
  };
}
