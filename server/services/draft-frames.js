/**
 * ESPN draft-room WebSocket frame parsing. Pure functions, no DB, no network.
 *
 * ESPN's `mDraftDetail` REST view is frozen for the whole of a live draft (every
 * slot stays playerId -1 until one flush at completion), so live picks only ever
 * travel over the draft room's socket. A bookmarklet in the user's own ESPN tab
 * taps that socket and POSTs the raw text frames to us; this module turns them
 * into typed events and the binary INIT snapshot into a pick ledger.
 *
 * Frames are space-delimited text, one event per frame:
 *   SELECTED <teamId> <playerId> <slotId> [{SWID}]   a pick landed (slotId is a ROSTER
 *                                                   slot, not the overall pick number)
 *   SELECTING <teamId> <ms>                          team on the clock
 *   CLOCK <phase> <msRemaining> [teamId]
 *   AUTODRAFT <teamId> <bool>
 *   UNDONE <pickNumber>                              commissioner reversal
 *   JOINED/LEFT <member>   TOKEN <...>   STATE <n>   PING/PONG
 *   SELECT <playerId>                                client -> server, the user's own choice
 *   INIT <base64>                                    binary snapshot of the whole grid
 *
 * The exact byte layout of INIT beyond the first four big-endian i32s of each
 * record is not pinned down, so decodeInitLedger() is deliberately defensive:
 * it validates what it reads and returns [] with an error rather than a board
 * it can't trust.
 */

const INT = /^-?\d+$/;

function int(token) {
  return typeof token === 'string' && INT.test(token) ? Number(token) : null;
}

function bool(token) {
  if (token == null) return null;
  const t = String(token).toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return null;
}

/** One raw text frame -> a typed event. Never throws; anything unrecognised is UNKNOWN. */
export function parseFrame(text) {
  if (typeof text !== 'string') return { type: 'UNKNOWN', raw: text == null ? '' : String(text) };
  const raw = text;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { type: 'UNKNOWN', raw };
  const [kind, ...args] = tokens;
  const type = kind.toUpperCase();

  switch (type) {
    case 'SELECTED': {
      const teamId = int(args[0]), playerId = int(args[1]), slotId = int(args[2]);
      if (teamId == null || playerId == null) return { type: 'UNKNOWN', raw };
      const swid = args[3] ?? null;
      return { type, teamId, playerId, slotId, swid };
    }
    case 'SELECTING': {
      const teamId = int(args[0]);
      if (teamId == null) return { type: 'UNKNOWN', raw };
      return { type, teamId, ms: int(args[1]) };
    }
    case 'CLOCK': {
      if (!args.length) return { type: 'UNKNOWN', raw };
      return { type, phase: args[0], msRemaining: int(args[1]), teamId: int(args[2]) };
    }
    case 'AUTODRAFT': {
      const teamId = int(args[0]);
      if (teamId == null) return { type: 'UNKNOWN', raw };
      return { type, teamId, enabled: bool(args[1]) };
    }
    case 'UNDONE': {
      const pickNumber = int(args[0]);
      if (pickNumber == null || pickNumber < 1) return { type: 'UNKNOWN', raw };
      return { type, pickNumber };
    }
    case 'JOINED':
    case 'LEFT':
      return { type, member: args[0] ?? null };
    case 'TOKEN':
      // Never echo the token itself back out — it is the user's session material.
      return { type, redacted: true };
    case 'STATE':
      return { type, state: int(args[0]) ?? (args[0] ?? null) };
    case 'PING':
    case 'PONG':
      return { type };
    case 'SELECT': {
      const playerId = int(args[0]);
      if (playerId == null) return { type: 'UNKNOWN', raw };
      return { type, playerId };
    }
    case 'INIT': {
      const data = args.join('');
      if (!data || !/^[A-Za-z0-9+/=_-]+$/.test(data)) return { type: 'UNKNOWN', raw };
      return { type, data };
    }
    default:
      return { type: 'UNKNOWN', raw };
  }
}

export const INIT_RECORD_STRIDES = [45, 44, 46, 48];
const MAX_HEADER_SCAN = 256;
const MAX_TEAM_ID = 1024;

/**
 * Try one (offset, stride) reading of the ledger. Returns the run of records that
 * pass every sanity check, stopping at the first that doesn't.
 */
function readRun(buf, offset, stride, maxPick) {
  const out = [];
  let leagueId = null, prevPick = 0;
  for (let at = offset; at + 16 <= buf.length; at += stride) {
    const lg = buf.readInt32BE(at);
    const teamId = buf.readInt32BE(at + 4);
    const pickNumber = buf.readInt32BE(at + 8);
    const playerId = buf.readInt32BE(at + 12);
    if (leagueId == null) {
      if (lg <= 0) break;
      leagueId = lg;
    } else if (lg !== leagueId) break;
    if (pickNumber !== prevPick + 1) break;
    if (maxPick && pickNumber > maxPick) break;
    if (teamId <= 0 || teamId > MAX_TEAM_ID) break;
    if (playerId === 0) break;
    out.push({ teamId, pickNumber, playerId });
    prevPick = pickNumber;
    if (at + stride > buf.length) break; // trailing partial record: stop cleanly
  }
  return { leagueId, picks: out };
}

/**
 * Decode an INIT snapshot into the pick grid.
 *
 * @param base64 - the INIT payload
 * @param opts.teamCount / opts.rounds - when known, bound pickNumber to 1..N*R
 * @returns { picks: [{teamId, pickNumber, playerId}], stride, offset, leagueId, error }
 *   picks is [] (with `error` set) when nothing trustworthy could be read.
 */
export function decodeInitLedger(base64, { teamCount = 0, rounds = 0 } = {}) {
  let buf;
  try {
    buf = Buffer.from(String(base64 ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return { picks: [], stride: null, offset: null, leagueId: null, error: 'INIT payload is not base64' };
  }
  if (buf.length < 16) return { picks: [], stride: null, offset: null, leagueId: null, error: 'INIT payload too short' };

  const maxPick = teamCount > 0 && rounds > 0 ? teamCount * rounds : 0;
  // A run counts as trustworthy when it is either the whole expected grid or at
  // least three sequential records agreeing on league id — one or two records can
  // line up by accident in a stream of arbitrary bytes.
  const minRun = maxPick ? Math.min(3, maxPick) : 3;

  let best = null;
  for (const stride of INIT_RECORD_STRIDES) {
    const lastOffset = Math.min(MAX_HEADER_SCAN, Math.max(0, buf.length - 16));
    for (let offset = 0; offset <= lastOffset; offset++) {
      const run = readRun(buf, offset, stride, maxPick);
      if (run.picks.length < minRun) continue;
      if (!best || run.picks.length > best.picks.length) best = { ...run, stride, offset };
      if (maxPick && run.picks.length === maxPick) break;
    }
    // The documented stride is tried first; only fall through to the others when
    // it produced nothing usable at all.
    if (best) break;
  }

  if (!best) return { picks: [], stride: null, offset: null, leagueId: null, error: 'INIT ledger did not decode with any known record stride' };
  return { picks: best.picks, stride: best.stride, offset: best.offset, leagueId: best.leagueId, error: null };
}

/** Convenience: just the records (empty on failure). */
export function decodeInit(base64, opts) {
  return decodeInitLedger(base64, opts).picks;
}

/**
 * Build a synthetic INIT payload — the exact inverse of decodeInitLedger() at the
 * documented 45-byte stride. Used by tests and handy for fixtures.
 */
export function encodeInitLedger(leagueId, records, { stride = 45 } = {}) {
  const buf = Buffer.alloc(records.length * stride);
  records.forEach((r, i) => {
    const at = i * stride;
    buf.writeInt32BE(leagueId, at);
    buf.writeInt32BE(r.teamId, at + 4);
    buf.writeInt32BE(r.pickNumber, at + 8);
    buf.writeInt32BE(r.playerId, at + 12);
  });
  return buf.toString('base64');
}
