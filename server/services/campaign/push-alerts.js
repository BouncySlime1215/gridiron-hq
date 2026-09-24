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
 *   - queued alerts go out only outside quiet hours (1:00-7:59 AM America/New_York),
 *     one message per league per run; the next run from 8 AM sends what is still owed.
 *
 * Channel (defaultSender): GRIDIRON_PUSH_NTFY_URL (a topic URL: a secret, never
 * logged) or, on macOS, a Notification Center banner. Neither -> alerts stay
 * queued and the summary line says so. Message text carries the league id and the
 * reason only, never a manager or league name.
 *
 * Flag: GRIDIRON_WARROOM_PUSH_ENABLED=1, or preview mode (preview-mode.js);
 * GRIDIRON_WARROOM_PUSH_ENABLED=0 vetoes preview. Off -> nothing read or written.
 */
import { spawnSync } from 'node:child_process';
import { previewUnconfirmed, previewText } from '../preview-mode.js';

export const FLAG_ENV = 'GRIDIRON_WARROOM_PUSH_ENABLED';
export const NTFY_ENV = 'GRIDIRON_PUSH_NTFY_URL';
export const QUIET = Object.freeze({ tz: 'America/New_York', from: 1, to: 8 });
export const MAX_ATTEMPTS = 3;

const FEAS_LABEL = { on_track: 'on track', reachable: 'reachable with a trade', out_of_reach: 'out of reach' };

/** { on, preview }: the flag wins either way; preview mode only fills in when it is unset. */
export function pushAlertsFlag(env = process.env) {
  if (env[FLAG_ENV] === '1') return { on: true, preview: false };
  if (env[FLAG_ENV] === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

const etHour = at => Number(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.tz, hour: 'numeric', hourCycle: 'h23' }).format(at));

/** True from 1:00 through 7:59 AM Eastern (EDT or EST, whichever is in force). */
export const inQuietHours = (at = new Date()) => { const h = etHour(at); return h >= QUIET.from && h < QUIET.to; };

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
    out.push({ kind: 'next_move', value: String(nm.value.move_id),
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

/** Diff one plans file against state; queue one alert per change. Returns counts. */
export function recordRun(db, file, { now = new Date() } = {}) {
  const at = now.toISOString();
  const c = { baselined: 0, queued: 0, superseded: 0 };
  const getState = db.prepare('SELECT seen_value, announced_value FROM warroom_push_state WHERE league_id = ? AND kind = ?');
  const insState = db.prepare('INSERT INTO warroom_push_state (league_id, kind, seen_value, announced_value, updated_at) VALUES (?, ?, ?, ?, ?)');
  const setSeen = db.prepare('UPDATE warroom_push_state SET seen_value = ?, updated_at = ? WHERE league_id = ? AND kind = ?');
  const supersede = db.prepare("UPDATE warroom_push_alerts SET status = 'superseded' WHERE league_id = ? AND kind = ? AND status = 'queued'");
  const queue = db.prepare('INSERT INTO warroom_push_alerts (league_id, kind, from_value, to_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of file?.leagues ?? []) {
      const league = String(e.league);
      for (const { kind, value, reason } of observedValues(e)) {
        const s = getState.get(league, kind);
        if (!s) { insState.run(league, kind, value, value, at); c.baselined++; continue; }
        if (s.seen_value === value) continue;
        setSeen.run(value, at, league, kind);
        c.superseded += Number(supersede.run(league, kind).changes);
        if (value === s.announced_value) continue;
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

function messageFor(league, alerts, preview) {
  const parts = alerts.map(a => (a.kind === 'next_move'
    ? (a.to_value === 'none' ? 'no move clears the bar now' : `new next move (${a.reason})`)
    : a.reason));
  const text = `League ${league}: ${parts.join('; ')}. Open the War Room.`;
  return preview ? previewText(text) : text;
}

/** Send what is owed, one message per league. `send(msg)` resolves { channel } or throws. */
export async function dispatch(db, { now = new Date(), send = null, preview = false } = {}) {
  const c = { sent: 0, held: 0, failed: 0, unsent: 0, errors: [] };
  const queued = db.prepare("SELECT * FROM warroom_push_alerts WHERE status = 'queued' ORDER BY league_id, kind").all();
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
      const r = await send({ league, text: messageFor(league, alerts, preview) });
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
 * The producer's one call. Returns { status: 'off' | 'inert' | 'ok', preview, ...counts, line }.
 * `send` defaults to defaultSender(env); pass null to force "no channel".
 */
export async function runPushAlerts(db, file, { env = process.env, now = new Date(), send } = {}) {
  const flag = pushAlertsFlag(env);
  if (!flag.on) return { status: 'off', preview: false, line: `off (${FLAG_ENV} not 1)` };
  if (!tablesPresent(db)) {
    return { status: 'inert', preview: flag.preview, line: 'INERT: tables from migration 091 missing; start the app once to apply it' };
  }
  const sender = send === undefined ? defaultSender(env) : send;
  const rec = recordRun(db, file, { now });
  const d = await dispatch(db, { now, send: sender, preview: flag.preview });
  const bits = [`queued ${rec.queued}`, `sent ${d.sent}`];
  if (rec.superseded) bits.push(`superseded ${rec.superseded}`);
  if (rec.baselined) bits.push(`baselined ${rec.baselined}`);
  if (d.held) bits.push(`held ${d.held} (quiet hours 1-8 AM ET)`);
  if (d.unsent) bits.push(`unsent ${d.unsent} (no push channel: set ${NTFY_ENV} or run on macOS)`);
  if (d.failed) bits.push(`FAILED ${d.failed}: ${d.errors.join(' | ')}`);
  return { status: 'ok', preview: flag.preview, ...rec, ...d, line: bits.join(', ') };
}
