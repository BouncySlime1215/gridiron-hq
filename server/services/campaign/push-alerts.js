/**
 * PUSH-01 / north-star row 7: push Nick when a league's War Room next move changes.
 *
 * Called by scripts/campaign/produce-plans.mjs after each plans run (every data
 * refresh), with the plans file it just wrote. Two values per league are watched:
 *   next_move    next_move.value.move_id ('none' when no move clears the bar)
 *   feasibility  the objective's feasibility status (on_track | reachable | out_of_reach):
 *                feasibility.status on a points league, feasibility_points.outlook otherwise
 * Only served contract fields are read, never `_run`.
 * A failed league (no next_move) or a failed section is not read: it neither
 * changes nor clears state.
 *
 * Dedupe is state, not the previous file (tables in migration 091):
 *   - first sighting of a league records a baseline and pushes nothing;
 *   - a value that moved queues one alert (any older unsent one for the same league
 *     and kind is superseded), unless it moved back to what Nick was last told;
 *   - plan item 16: a next move is queued only when it passes every one of Nick's rules
 *     (never-give.js#ruleVerdict through the ONE rule gate, ruleGate) and beats doing
 *     nothing (delta_final > 0, every leg clearing 2 SE on the confirm dice). A move that
 *     fails is recorded 'blocked' with its reasons and never sent; no gate -> blocked
 *     (fails closed). A queued move is re-checked on every run until it goes out.
 *     'No move clears the bar' is not a move and queues nothing;
 *   - a feasibility change is sent only together with a next-move push, never alone;
 *   - queued alerts go out only outside quiet hours (23:00-07:59 America/New_York),
 *     one message per league per run; the next run from 8 AM sends what is still owed.
 *
 * Channel (defaultSender): GRIDIRON_PUSH_NTFY_URL (a topic URL: a secret, never
 * logged) or, on macOS, a Notification Center banner. Neither -> alerts stay
 * queued and the summary line says so. Message text carries the league id and the
 * reason only, never a manager or league name.
 *
 * Flag: GRIDIRON_WARROOM_PUSH_ENABLED=1 only (never the preview switch). Off -> nothing
 * read or written.
 */
import { spawnSync } from 'node:child_process';

export const FLAG_ENV = 'GRIDIRON_WARROOM_PUSH_ENABLED';
export const NTFY_ENV = 'GRIDIRON_PUSH_NTFY_URL';
export const QUIET = Object.freeze({ tz: 'America/New_York', from: 23, to: 8 });
export const MAX_ATTEMPTS = 3;

const FEAS_LABEL = { on_track: 'on track', reachable: 'reachable with a trade', out_of_reach: 'out of reach' };

/** On only with its own flag set to 1. */
export const pushAlertsFlag = (env = process.env) => env[FLAG_ENV] === '1';

const etHour = at => Number(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.tz, hour: 'numeric', hourCycle: 'h23' }).format(at));

/** True from 11:00 PM through 7:59 AM Eastern (EDT or EST, whichever is in force). */
export const inQuietHours = (at = new Date()) => { const h = etHour(at); return h >= QUIET.from || h < QUIET.to; };

const FLOOR_REASONS = new Set(['below_blue_chip', 'unscored']);

/**
 * Plan item 16: whether a served next move may be pushed. -> { ok, reasons }.
 * Every leg goes through the rule gate from Nick's side (never give, never get, sold this season,
 * overpay cap, rules unreadable); the Blue chip floor applies to the path's final gets only (a flip
 * leg's get that a later leg gives away is not a final get, as the planner's GETS-FLOOR). The
 * +12% depth-only 2-for-1 exception needs Nick's own lineup-points change, which the contract does
 * not serve per leg, so here it never applies (stricter, never looser). The move must also beat
 * doing nothing: delta_final ok and > 0, and no leg failing 2 SE on the confirm dice.
 */
export function moveVerdict(value, gate) {
  const reasons = new Set();
  const steps = Array.isArray(value?.steps) ? value.steps : [];
  if (!steps.length) reasons.add('no_path');
  const df = value?.delta_final;
  if (!(df?.status === 'ok' && Number(df.value) > 0)) reasons.add('no_edge');
  if (steps.some(st => st?.title_odds_delta?.clears_2se === false)) reasons.add('no_edge');
  if (!gate || typeof gate.check !== 'function') {
    reasons.add('rules_unreadable');
    return { ok: false, reasons: [...reasons] };
  }
  const ids = xs => (Array.isArray(xs) ? xs : []).map(String);
  try {
    steps.forEach((st, i) => {
      for (const r of gate.check({ give: ids(st.give), get: ids(st.get), premium: null }).reasons) if (!FLOOR_REASONS.has(r)) reasons.add(r);
      const later = new Set(steps.slice(i + 1).flatMap(x => ids(x.give)));
      const final = ids(st.get).filter(id => !later.has(id));
      if (final.length) for (const r of gate.check({ give: [], get: final, premium: null }).reasons) if (FLOOR_REASONS.has(r)) reasons.add(r);
    });
  } catch {
    reasons.add('rules_unreadable'); // the gate threw mid-check: blocked, and the reason says so
  }
  return { ok: reasons.size === 0, reasons: [...reasons] };
}

/**
 * The watched values a league entry carries this run: [{ kind, value, reason }]. Served contract
 * fields only (plans-schema.js), never `_run`: next_move.value.move_id + change_reason, and the
 * feasibility status (feasibility.status on a points league, else feasibility_points.outlook) +
 * change_reason. A section that is not 'ok' is not read.
 */
export function observedValues(e) {
  if (!e) return [];
  const out = [];
  const nm = e.next_move;
  if (nm?.status === 'ok' && nm.value?.move_id) {
    out.push({ kind: 'next_move', value: String(nm.value.move_id), move: nm.value,
      reason: nm.value.change_reason ?? 'the next move changed since your last alert' });
  } else if (nm?.status === 'unknown') {
    out.push({ kind: 'next_move', value: 'none', reason: 'no move clears the bar now' });
  }
  const fe = e.feasibility?.status === 'ok' ? e.feasibility.value : null;
  const fp = e.feasibility_points?.status === 'ok' ? e.feasibility_points.value : null;
  const [fs, why] = FEAS_LABEL[fe?.status] ? [fe.status, fe.change_reason]
    : FEAS_LABEL[fp?.outlook] ? [fp.outlook, fp.change_reason] : [null, null];
  if (fs) out.push({ kind: 'feasibility', value: fs, reason: `goal is now ${FEAS_LABEL[fs]}${why ? ` (${why})` : ''}` });
  return out;
}

function tablesPresent(db) {
  const n = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('warroom_push_state','warroom_push_alerts')").get().n;
  return n === 2;
}

/** The gate for one league, or null (fails closed: every move blocked) when it cannot be built; the error is kept. */
function gateOf(gateFor, league, errors) {
  if (typeof gateFor !== 'function') return null;
  try { return gateFor(league) ?? null; } catch (err) {
    errors.push(`league ${league}: ${String(err?.message ?? err).slice(0, 200)}`);
    return null;
  }
}

/** Diff one plans file against state; queue one alert per change that may be pushed. Returns counts. */
export function recordRun(db, file, { now = new Date(), gateFor } = {}) {
  const at = now.toISOString();
  const c = { baselined: 0, queued: 0, superseded: 0, blocked: 0, blocked_reasons: {}, gate_errors: [] };
  const getState = db.prepare('SELECT seen_value, announced_value FROM warroom_push_state WHERE league_id = ? AND kind = ?');
  const insState = db.prepare('INSERT INTO warroom_push_state (league_id, kind, seen_value, announced_value, updated_at) VALUES (?, ?, ?, ?, ?)');
  const setSeen = db.prepare('UPDATE warroom_push_state SET seen_value = ?, updated_at = ? WHERE league_id = ? AND kind = ?');
  const supersede = db.prepare("UPDATE warroom_push_alerts SET status = 'superseded' WHERE league_id = ? AND kind = ? AND status = 'queued'");
  const queue = db.prepare('INSERT INTO warroom_push_alerts (league_id, kind, from_value, to_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const block = db.prepare("INSERT INTO warroom_push_alerts (league_id, kind, from_value, to_value, reason, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'blocked')");
  const queuedMove = db.prepare("SELECT id FROM warroom_push_alerts WHERE league_id = ? AND kind = 'next_move' AND status = 'queued' AND to_value = ?");
  const blockQueued = db.prepare("UPDATE warroom_push_alerts SET status = 'blocked', reason = ? WHERE id = ?");
  const tally = reasons => { c.blocked++; for (const r of reasons) c.blocked_reasons[r] = (c.blocked_reasons[r] ?? 0) + 1; };
  const blockedText = reasons => `blocked by your rules: ${reasons.join(', ')}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of file?.leagues ?? []) {
      const league = String(e.league);
      let gate;
      for (const { kind, value, reason, move } of observedValues(e)) {
        const s = getState.get(league, kind);
        if (!s) { insState.run(league, kind, value, value, at); c.baselined++; continue; }
        const verdict = move ? moveVerdict(move, gate === undefined ? (gate = gateOf(gateFor, league, c.gate_errors)) : gate) : null;
        if (s.seen_value === value) {
          // Still owed from an earlier run (quiet hours, no channel, a retry): re-checked before it goes out.
          const q = verdict && !verdict.ok ? queuedMove.get(league, value) : null;
          if (q) { blockQueued.run(blockedText(verdict.reasons), q.id); tally(verdict.reasons); }
          continue;
        }
        setSeen.run(value, at, league, kind);
        c.superseded += Number(supersede.run(league, kind).changes);
        if (value === s.announced_value) continue;
        if (kind === 'next_move' && value === 'none') continue; // no move to send
        if (verdict && !verdict.ok) { block.run(league, kind, s.announced_value, value, blockedText(verdict.reasons), at); tally(verdict.reasons); continue; }
        queue.run(league, kind, s.announced_value, value, reason, at);
        c.queued++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return c;
}

function messageFor(league, alerts) {
  const parts = alerts.map(a => (a.kind === 'next_move' ? `new next move (${a.reason})` : a.reason));
  return `League ${league}: ${parts.join('; ')}. Open the War Room.`;
}

/**
 * Send what is owed, one message per league. `send(msg)` resolves { channel } or throws.
 * A league with no queued next-move alert sends nothing: its feasibility alert waits for one.
 */
export async function dispatch(db, { now = new Date(), send = null } = {}) {
  const c = { sent: 0, held: 0, failed: 0, unsent: 0, waiting: 0, errors: [] };
  const all = db.prepare("SELECT * FROM warroom_push_alerts WHERE status = 'queued' ORDER BY league_id, kind").all();
  const withMove = new Set(all.filter(a => a.kind === 'next_move').map(a => a.league_id));
  const queued = all.filter(a => withMove.has(a.league_id));
  c.waiting = all.length - queued.length;
  if (!queued.length) return c;
  if (inQuietHours(now)) { c.held = queued.length; return c; }
  if (!send) { c.unsent = queued.length; return c; }
  const byLeague = new Map();
  for (const a of queued) byLeague.set(a.league_id, [...(byLeague.get(a.league_id) ?? []), a]);
  const markSent = db.prepare("UPDATE warroom_push_alerts SET status = 'sent', sent_at = ?, channel = ?, attempts = attempts + 1, error = NULL WHERE id = ?");
  const announce = db.prepare('UPDATE warroom_push_state SET announced_value = ?, updated_at = ? WHERE league_id = ? AND kind = ?');
  const markFail = db.prepare("UPDATE warroom_push_alerts SET attempts = attempts + 1, error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END WHERE id = ?");
  for (const [league, alerts] of byLeague) {
    try {
      const r = await send({ league, text: messageFor(league, alerts) });
      for (const a of alerts) { markSent.run(now.toISOString(), String(r?.channel ?? 'unknown'), a.id); announce.run(a.to_value, now.toISOString(), league, a.kind); }
      c.sent += alerts.length;
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 300);
      for (const a of alerts) markFail.run(msg, MAX_ATTEMPTS, a.id);
      c.failed += alerts.length;
      c.errors.push(`league ${league}: ${msg}`);
    }
  }
  return c;
}

/** The channel on this machine, or null. The ntfy URL is read, never printed. */
export function defaultSender(env = process.env, platform = process.platform) {
  const url = env[NTFY_ENV];
  if (url) {
    return async ({ text }) => {
      const res = await fetch(url, { method: 'POST', body: text, headers: { Title: 'Gridiron HQ War Room' } });
      if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
      return { channel: 'ntfy' };
    };
  }
  if (platform === 'darwin') {
    return async ({ text }) => {
      // The text goes in as an argument, never spliced into the script.
      const r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Gridiron HQ War Room"', '-e', 'end run', text],
        { encoding: 'utf8', timeout: 10_000 });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`osascript exited ${r.status}: ${(r.stderr ?? '').trim().slice(0, 200)}`);
      return { channel: 'macos' };
    };
  }
  return null;
}

/**
 * The producer's one call. Returns { status: 'off' | 'inert' | 'ok', ...counts, line }.
 * `send` defaults to defaultSender(env); pass null to force "no channel".
 * `gateFor(leagueId)` -> the league's rule gate (never-give.js#ruleGate) or null; absent -> every
 * move is blocked (fails closed).
 */
export async function runPushAlerts(db, file, { env = process.env, now = new Date(), send, gateFor } = {}) {
  if (!pushAlertsFlag(env)) return { status: 'off', line: `off (${FLAG_ENV} not 1)` };
  if (!tablesPresent(db)) {
    return { status: 'inert', line: 'INERT: tables from migration 091 missing; start the app once to apply it' };
  }
  const sender = send === undefined ? defaultSender(env) : send;
  const rec = recordRun(db, file, { now, gateFor });
  const d = await dispatch(db, { now, send: sender });
  const bits = [`queued ${rec.queued}`, `sent ${d.sent}`];
  if (rec.blocked) bits.push(`blocked ${rec.blocked} (${Object.entries(rec.blocked_reasons).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  if (rec.gate_errors.length) bits.push(`RULE GATE FAILED (moves blocked): ${rec.gate_errors.join(' | ')}`);
  if (rec.superseded) bits.push(`superseded ${rec.superseded}`);
  if (rec.baselined) bits.push(`baselined ${rec.baselined}`);
  if (d.waiting) bits.push(`waiting ${d.waiting} (goal change rides the next move push)`);
  if (d.held) bits.push(`held ${d.held} (quiet hours 11 PM-8 AM ET)`);
  if (d.unsent) bits.push(`unsent ${d.unsent} (no push channel: set ${NTFY_ENV} or run on macOS)`);
  if (d.failed) bits.push(`FAILED ${d.failed}: ${d.errors.join(' | ')}`);
  return { status: 'ok', ...rec, ...d, line: bits.join(', ') };
}
