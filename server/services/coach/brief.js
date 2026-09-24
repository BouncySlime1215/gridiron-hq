/**
 * COACH-BRIEF (COACH-ANCHOR.md job 6): Coach's morning brief, weekly itinerary
 * check-in and next-move push text for the target league.
 *
 *   morningBrief   what changed overnight (credible statements, replies,
 *                  injuries), the next move and why, and the brain's status
 *   weeklyCheckIn  where the plan stands against its itinerary this NFL week
 *   nextMovePush   one short text when the next move changed (PUSH-01 sends it;
 *                  nothing here sends anything)
 *
 * No model call. Every line is built from the plans file (the warroom-plans/1
 * contract, FIX-03) and the overnight rows (brief-inputs.js), and every line
 * is a claim checked by Coach's own verify.js before it ships: the rows it
 * stands on are recorded in a ledger, the claim cites them, and a number that
 * is not in a cited cell drops the claim. A cited string cell quoted word for
 * word is its own evidence, so a producer reason ("No arrive-by week is set.")
 * passes while a number Coach wrote around it still has to ground. A claim
 * marked `strict` (the planner's own prose) gets no such allowance: each of
 * its numbers must match a cited number cell. Dropped claims are kept on the
 * brief with the violation, so nothing is silently lost.
 *
 * Cost: $0. Cache (coach_briefs, migration 088): one row per league, kind,
 * plan version and window. A second read of the same plan in the same window
 * is a lookup; a new plan version, a new morning or new overnight rows build a
 * fresh brief. Absent table -> the brief is built, not cached, and says so.
 *
 * Flag: GRIDIRON_COACH_BRIEF_ENABLED=1, or preview mode (preview-mode.js);
 * GRIDIRON_COACH_BRIEF_ENABLED=0 vetoes preview. Off -> nothing is read or written.
 * Public repo: teams are "Team <roster id>"; chat names and text never appear.
 */
import crypto from 'node:crypto';
import { previewUnconfirmed, previewFields, previewText } from '../preview-mode.js';
import { newLedger } from './ledger.js';
import { verifyAnswer } from './verify.js';
import { readStatements, readReplies, readInjuries, trustedChatNames } from './brief-inputs.js';
import { claimsFor } from './brief-claims.js';

export const BRIEF_ENV = 'GRIDIRON_COACH_BRIEF_ENABLED';
export const TARGET_LEAGUE = 4;
export const BRIEF_PREVIEW_REASON =
  "Coach's brief reads the War Room plans, which the brain has not proven yet (E1-E7 pending)";
/** Default overnight window when no earlier morning brief says where the last one ended. */
export const DEFAULT_WINDOW_HOURS = 12;
/** An earlier brief older than this does not set the window (a missed morning is not "overnight"). */
export const MAX_WINDOW_HOURS = 36;
/**
 * Rows arrive late (an ESPN sync writes a 6:55 decline at 7:30; the classifier labels
 * a message hours after it was sent), so the next window reaches back this far past
 * the last brief's end, and skips rows that brief already reported.
 */
export const LATE_ROWS_HOURS = 6;
/** How many reported row keys a brief carries forward to the next one. */
const MAX_CARRIED_KEYS = 2000;
export const PUSH_MAX_CHARS = 280;

/** { on, preview }: the flag wins either way; preview mode fills in only when it is unset. */
export function coachBriefFlag(env = process.env) {
  if (env[BRIEF_ENV] === '1') return { on: true, preview: false };
  if (env[BRIEF_ENV] === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * The plan version a brief is cached under: the run, the objective and
 * itinerary versions, and the next move. Two runs that agree on all of them
 * are the same plan to Nick.
 */
export function planVersion(file, entry) {
  const nm = entry?.next_move;
  return sha(JSON.stringify([
    file?.generated_at ?? null, file?.producer_version ?? null, entry?.error ?? null,
    entry?._run?.objective_version ?? null, entry?.itinerary?.value?.version ?? null,
    nm?.status ?? null, nm?.value?.move_id ?? null
  ]));
}

/** The date in New York for `at` (YYYY-MM-DD): one morning brief per ET day. */
export function etDate(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function leagueEntry(file, leagueId) {
  return (file?.leagues ?? []).find(e => String(e.league) === String(leagueId)) ?? null;
}

/* ---------------------------------------------------------------- cache */

function cacheReady(db) {
  return !!db?.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'coach_briefs'").get();
}

function cached(db, key) {
  const r = db.prepare(`SELECT body FROM coach_briefs WHERE league_id = ? AND kind = ? AND plan_version = ? AND window_key = ?`)
    .get(key.league, key.kind, key.plan_version, key.window_key);
  return r ? JSON.parse(r.body) : null;
}

function save(db, key, body) {
  db.prepare(`INSERT OR IGNORE INTO coach_briefs (league_id, kind, plan_version, window_key, body, claims_kept, claims_dropped)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key.league, key.kind, key.plan_version, key.window_key,
    JSON.stringify(body), body.claims.length, body.dropped.length);
}

/**
 * Where this morning's window starts, and which rows it skips. A brief already
 * built today (ET) keeps its start and skip list, so a re-read the same morning
 * covers the same night. Otherwise the window starts LATE_ROWS_HOURS before the
 * last brief's end (if that brief is recent enough to count as "overnight") and
 * skips every row the last brief reported, so a late row is caught and an early
 * one is not repeated.
 */
function windowStart(db, leagueId, now) {
  const r = db.prepare(`SELECT body FROM coach_briefs WHERE league_id = ? AND kind = 'morning' ORDER BY id DESC LIMIT 1`).get(leagueId);
  const b = r ? JSON.parse(r.body) : null;
  const w = b?.window;
  if (!w?.until) return null;
  if (etDate(new Date(w.until)) === etDate(now)) return { since: w.since, exclude: b.exclude ?? [] };
  const age = now.getTime() - Date.parse(w.until);
  if (!(age > 0 && age <= MAX_WINDOW_HOURS * 3600e3)) return null;
  return { since: new Date(Date.parse(w.until) - LATE_ROWS_HOURS * 3600e3).toISOString(),
    exclude: [...(b.reported ?? []), ...(b.exclude ?? [])].slice(0, MAX_CARRIED_KEYS) };
}

/* ------------------------------------------------------------ grounding */

/**
 * Check one claim against the ledger. A cited string cell quoted verbatim is
 * removed before the number check (unless the claim is strict); what is left
 * goes through verify.js exactly as a Coach answer would.
 */
export function checkClaim(claim, ledger) {
  let text = claim.text;
  if (!claim.strict) {
    for (const cite of claim.cites) {
      const v = ledger.cell(cite)?.value;
      if (typeof v === 'string' && v.length >= 3) text = text.split(v).join(' ');
    }
  }
  // Identifier phrases ("Team 7", a player's name) are names, not claims: removed
  // longest first so "Team 12" never leaves a stray "2" behind "Team 1".
  for (const l of [...(claim.labels ?? [])].sort((x, y) => y.length - x.length)) {
    if (l) text = text.split(l).join(' ');
  }
  return verifyAnswer({ answer: { claims: [{ text, cites: claim.cites }], as_of: 'plans file' }, ledger });
}

function ground(draft, ledger) {
  const claims = [];
  const dropped = [];
  for (const c of draft) {
    const v = checkClaim(c, ledger);
    if (v.ok) claims.push({ section: c.section, text: c.text, cites: c.cites });
    else dropped.push({ section: c.section, text: c.text, violations: v.violations.map(x => x.detail) });
  }
  return { claims, dropped };
}

const HEADINGS = {
  overnight: 'Overnight', statements: 'Overnight', replies: 'Overnight', injuries: 'Overnight',
  next_move: 'Next move', brain: 'Brain status', itinerary: 'Itinerary', footer: null, push: null
};

/** The text Nick reads: claims grouped under their headings, in order. */
export function render(claims, { preview = false, title = null } = {}) {
  const lines = [];
  if (title) lines.push(preview ? previewText(title) : title);
  let heading;
  for (const c of claims) {
    const h = HEADINGS[c.section] ?? null;
    if (h && h !== heading) { lines.push('', `${h}:`); heading = h; }
    if (!h && c.section === 'footer') lines.push('');
    lines.push(h ? `- ${c.text}` : c.text);
  }
  return lines.join('\n').trim();
}

/* -------------------------------------------------------------- builders */

/** The next move as one key: its move_id, 'none' when no move clears the bar, null when unreadable. */
const moveKey = e => (e?.next_move?.status === 'ok' ? String(e.next_move.value.move_id)
  : e?.next_move?.status === 'unknown' ? 'none' : null);

/**
 * The next move the last push row for this league recorded: the push baseline
 * when no previous plans file is given. Only push rows count, so a morning
 * brief built after a change cannot swallow that change's push.
 */
function lastPushedMove(db, leagueId) {
  const r = db.prepare(`SELECT body FROM coach_briefs WHERE league_id = ? AND kind = 'push' ORDER BY id DESC LIMIT 1`).get(leagueId);
  return r ? JSON.parse(r.body).move_key ?? null : null;
}

/** A brief as served: the stored body plus the flag's preview fields. */
const served = (flag, body, isCached) => ({ status: 'ok', preview: flag.preview,
  ...(flag.preview ? previewFields(BRIEF_PREVIEW_REASON) : {}), ...body, cached: isCached });

function frame({ db, file, leagueId, env, now }) {
  const flag = coachBriefFlag(env);
  if (!flag.on) return { done: { status: 'off', preview: false, line: `off (${BRIEF_ENV} not 1)` } };
  if (!file || !Array.isArray(file.leagues)) {
    return { done: { status: 'unknown', preview: flag.preview, reason: 'No plans file has been written yet, so there is no plan to brief.' } };
  }
  const entry = leagueEntry(file, leagueId);
  if (!entry) return { done: { status: 'unknown', preview: flag.preview, reason: `League ${leagueId} is not in the plans file.` } };
  return { flag, entry, version: planVersion(file, entry), cacheOk: cacheReady(db), at: now.toISOString() };
}

function finish({ db, key, flag, cacheOk, body }) {
  if (!cacheOk) return { ...served(flag, body, false), cache: 'inert: coach_briefs (migration 088) is missing; start the app once to apply it' };
  save(db, key, body);
  return { ...served(flag, body, false), cache: 'saved' };
}

/**
 * The morning brief. `chat` is the private chat DB (or null); `credibility`
 * is Map(team -> { shop }) from the counterpart model when it is available.
 */
export function morningBrief({ db, chat = null, file, leagueId = TARGET_LEAGUE, now = new Date(), since = null,
  credibility = new Map(), env = process.env } = {}) {
  const f = frame({ db, file, leagueId, env, now });
  if (f.done) return f.done;
  const { flag, entry, version, cacheOk } = f;
  const until = now.toISOString();
  const start = since ? null : cacheOk ? windowStart(db, leagueId, now) : null;
  const from = since ?? start?.since ?? new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3600e3).toISOString();
  const skip = start?.exclude ?? [];
  const exclude = new Set(skip);
  const me = entry.me ?? null;
  const step = entry.next_move?.status === 'ok' ? entry.next_move.value.steps?.[0] : null;
  const partnerOf = moveId => {
    const moves = entry.alternatives?.status === 'ok' ? entry.alternatives.value : [];
    const m = [entry.next_move?.value, ...moves].find(x => x?.move_id === moveId);
    return m?.steps?.[0]?.partner == null ? null : String(m.steps[0].partner);
  };
  const inputs = {
    statements: readStatements(chat, { names: trustedChatNames(db, leagueId), since: from, until, credibility, exclude }),
    replies: readReplies(db, { leagueId, me, since: from, until, partnerOf, exclude }),
    injuries: readInjuries(db, { leagueId, me, since: from, until, watch: step ? [...step.give, ...step.get] : [], exclude })
  };
  const key = { league: leagueId, kind: 'morning', plan_version: version,
    window_key: `${etDate(now)}|${sha(JSON.stringify(Object.values(inputs).map(s => [s.status, s.rows])))}` };
  if (cacheOk && !since) {
    const hit = cached(db, key);
    if (hit) return served(flag, hit, true);
  }
  const ledger = newLedger();
  const draft = claimsFor('morning', { entry, inputs, ledger, leagueId });
  const { claims, dropped } = ground(draft, ledger);
  const body = { kind: 'morning', league: leagueId, plan_version: version, move_key: moveKey(entry), window: { since: from, until },
    reported: Object.values(inputs).flatMap(x => x.keys ?? []), exclude: skip,
    plans_as_of: file.generated_at ?? null, claims, dropped,
    text: render(claims, { preview: flag.preview, title: `Morning brief, league ${leagueId}` }),
    ledger: ledger.toJson() };
  // A hand-picked window (--since) is a one-off read: saving it would make it tonight's window.
  if (since) return { ...served(flag, body, false), cache: 'not saved: an explicit since is a one-off read' };
  return finish({ db, key, flag, cacheOk, body });
}

/** The weekly check-in against the itinerary, cached per plan version and NFL week. */
export function weeklyCheckIn({ db, file, leagueId = TARGET_LEAGUE, now = new Date(), env = process.env } = {}) {
  const f = frame({ db, file, leagueId, env, now });
  if (f.done) return f.done;
  const { flag, entry, version, cacheOk } = f;
  const week = entry._run?.week ?? null;
  const key = { league: leagueId, kind: 'weekly', plan_version: version, window_key: `week:${week ?? 'unknown'}` };
  if (cacheOk) {
    const hit = cached(db, key);
    if (hit) return served(flag, hit, true);
  }
  const ledger = newLedger();
  const { claims, dropped } = ground(claimsFor('weekly', { entry, ledger, leagueId }), ledger);
  const body = { kind: 'weekly', league: leagueId, plan_version: version, move_key: moveKey(entry), week, plans_as_of: file.generated_at ?? null,
    claims, dropped, text: render(claims, { preview: flag.preview, title: `Weekly check-in, league ${leagueId}` }),
    ledger: ledger.toJson() };
  return finish({ db, key, flag, cacheOk, body });
}

/**
 * Push text for a changed next move, or { status: 'unchanged' }. `previous`
 * is the prior plans file; without one, the baseline is the last push row's
 * move (the first call records one and pushes nothing). A failed section on either
 * side is not a change. The text is capped at PUSH_MAX_CHARS by dropping
 * trailing claims, never by cutting one in half.
 */
export function nextMovePush({ db, previous, file, leagueId = TARGET_LEAGUE, now = new Date(), env = process.env } = {}) {
  const f = frame({ db, file, leagueId, env, now });
  if (f.done) return f.done;
  const { flag, entry, version, cacheOk } = f;
  if (!previous && !cacheOk) {
    return { status: 'unknown', preview: flag.preview,
      reason: 'No previous plans file and no coach_briefs table (migration 088), so a change cannot be told from a first plan.' };
  }
  const before = previous ? moveKey(leagueEntry(previous, leagueId)) : lastPushedMove(db, leagueId);
  const after = moveKey(entry);
  if (!before && after && !previous && cacheOk) {
    save(db, { league: leagueId, kind: 'push', plan_version: version, window_key: 'baseline' },
      { kind: 'push', league: leagueId, plan_version: version, move_key: after, from: null, to: after, claims: [], dropped: [], text: '' });
  }
  if (!after || !before || before === after) {
    return { status: 'unchanged', preview: flag.preview, from: before, to: after,
      reason: !before ? 'No earlier plan to compare with: the first plan is a baseline, not a change.'
        : !after ? 'The next move could not be read this run, so it is not a change.' : 'Same next move.' };
  }
  const key = { league: leagueId, kind: 'push', plan_version: version, window_key: `${before}->${after}` };
  if (cacheOk) {
    const hit = cached(db, key);
    if (hit) return served(flag, hit, true);
  }
  const ledger = newLedger();
  const { claims, dropped } = ground(claimsFor('push', { entry, ledger, leagueId }), ledger);
  const kept = [];
  for (const c of claims) {
    const next = [...kept, c].map(x => x.text).join(' ');
    if ((flag.preview ? previewText(next) : next).length > PUSH_MAX_CHARS) break;
    kept.push(c);
  }
  const plain = kept.map(c => c.text).join(' ');
  const body = { kind: 'push', league: leagueId, plan_version: version, move_key: after, from: before, to: after,
    claims: kept, dropped: [...dropped, ...claims.slice(kept.length).map(c => ({ ...c, violations: ['over the push length cap'] }))],
    text: flag.preview ? previewText(plain) : plain, ledger: ledger.toJson() };
  return finish({ db, key, flag, cacheOk, body });
}
