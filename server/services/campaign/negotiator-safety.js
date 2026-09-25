/**
 * NEGOTIATOR-SAFETY (deep-queue item 11, research R3/R11): four guards on what the negotiator says.
 *
 *   counterGate      (a) Coach says take or counter-with only on the ENGINE's re-price of the package it
 *                    names (coach/negotiator.js prices both through the campaign adapter). Unpriced: no
 *                    verdict and no draft. A walk stays: it is the plan's walk-away rule, not a judgement.
 *   filterText       (b) a drafted text is rejected when it names a blocked player (never-give.js: pinned
 *                    never-give / never-get, objectives untouchables, sold this season), names one of
 *                    Nick's players outside what the plan gives, uses a pressure phrase, or proposes a
 *                    package the engine priced below the plan's backup.
 *   offerState       (c) every sent offer expires OFFER_HOURS after its last send, and is due to be
 *                    withdrawn at once when material news lands on any player in the deal after that
 *                    send (campaign/deal-news.js reads it). The app cannot cancel on ESPN: "withdraw"
 *                    means the card says so and drafts the note; Nick cancels.
 *   ensureWhyLine    (d) the card's message opens with one line on why the deal helps HIM
 *                    (negotiator-defaults.js#whyLine, else a plain fallback), within the text limit.
 *   applyNegotiatorSafety  (b)+(d) over a served plans entry (next move + alternatives), in the producer.
 *
 * Switch: GRIDIRON_NEGOTIATOR_SAFETY=1 only (never the preview switch). It moves no served number: it
 * withholds a verdict, rejects a text, adds a why line, and marks an offer to withdraw.
 *
 * Hand-set, not fitted: what counts as material news (injury report, depth-chart rank, roster move),
 * the fallback why line, the withdraw wording. No offer has been graded under these rules.
 */
import { whyLine, pressureTactics, OFFER_HOURS, WITHDRAW_IF } from './negotiator-defaults.js';
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';
import { splitName, surname, COMMON_WORDS, checkBursts, factsFor, MAX_CHARS } from './message-check.js';

export const NEGOTIATOR_SAFETY_ENV = 'GRIDIRON_NEGOTIATOR_SAFETY';
export const negotiatorSafetyOn = (env = process.env) => env?.[NEGOTIATOR_SAFETY_ENV] === '1';

/** Why a text was rejected. */
export const SAFETY_REASONS = Object.freeze(['blocked_player', 'gives_more', 'pressure', 'worse_than_plan']);
/** What counts as material news on a player in a sent deal. */
export const NEWS_KINDS = Object.freeze(['injury', 'role', 'roster']);
export const WITHDRAW_TEXT = 'Pulling this offer back for now, something changed on my end. I will come back with a fresh one.';

const S = x => String(x);
const HOUR = 3600 * 1000;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Curly apostrophes read straight, periods dropped ("A.J." and "AJ" are one spelling). */
const plain = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/\./g, '');
const nameOf = (names, id) => plain(splitName(names?.[S(id)] ?? '').name).trim();

/**
 * The ids no text may name: the rule gate's sets (ruleGate(...).rules from never-give.js) plus the
 * pinned ids, which hold even when the gate could not be built.
 */
export function blockedIds(rules = null) {
  const out = new Set([...PINNED_NEVER_GIVE, ...PINNED_NEVER_GET]);
  for (const set of [rules?.neverGive, rules?.neverGet, rules?.sold]) for (const id of set ?? []) out.add(S(id));
  return out;
}

const fullRe = name => new RegExp(`(^|[^A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`, 'gi');
/** A surname alone: a capitalised or otherwise non-common-word match outside any masked name. */
function surnameHit(text, sn) {
  if (sn.length < 3) return false;
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9'-])${esc(sn)}(?![A-Za-z0-9'-])`, 'gi'))) {
    if (m[0] === m[0].toLowerCase() && COMMON_WORDS.has(m[0])) continue;
    return true;
  }
  return false;
}

/**
 * One drafted text against the deal it belongs to.
 * opts: names (id -> "Name (POS)"), blocked (Set of ids, blockedIds()), mine (Nick's roster ids),
 *   allowedGive (what the plan may give: step give, opening, walk-away, second package, counter rung),
 *   allowed (every id the text may name: allowedGive plus the gets), priced ({ after, floor } title odds:
 *   the engine's price of the package the text proposes and the plan's backup) or null.
 * -> { ok, reasons: SAFETY_REASONS[], hits: [{ reason, id?, phrase? }] }
 */
export function filterText(text, { names = {}, blocked = blockedIds(), mine = [], allowedGive = [], allowed = [], priced = null } = {}) {
  const t = plain(text);
  const ok = new Set([...allowed, ...allowedGive].map(S));
  const give = new Set(allowedGive.map(S));
  let masked = t;
  const okSur = new Set();
  for (const id of ok) {
    const n = nameOf(names, id);
    if (n.length < 2) continue;
    okSur.add(surname(n).toLowerCase());
    masked = masked.replace(fullRe(n), (m, pre) => `${pre}${'_'.repeat(m.length - pre.length)}`);
  }
  // A bare surname outside every allowed full name: for a blocked player it fails closed even when an allowed
  // player shares it ("Brown" beside Marquise Brown is rejected); for Nick's other players it is his.
  const named = (id, { strict = false } = {}) => {
    const n = nameOf(names, id);
    if (n.length < 2) return false;
    if (fullRe(n).test(ok.has(S(id)) ? t : masked)) return true;
    const sn = surname(n);
    return (strict || !okSur.has(sn.toLowerCase())) && surnameHit(masked, sn);
  };
  const hits = [];
  for (const id of blocked) if (named(id, { strict: true })) hits.push({ reason: 'blocked_player', id: S(id) });
  for (const id of new Set(mine.map(S))) {
    if (blocked.has(id) || give.has(id)) continue;
    if (named(id)) hits.push({ reason: 'gives_more', id });
  }
  for (const phrase of pressureTactics(text)) hits.push({ reason: 'pressure', phrase });
  if (priced && Number.isFinite(priced.after) && Number.isFinite(priced.floor) && priced.after < priced.floor) {
    hits.push({ reason: 'worse_than_plan' });
  }
  return { ok: hits.length === 0, reasons: [...new Set(hits.map(h => h.reason))], hits };
}

/**
 * (a) The verdict Coach may give on a counter. decision: 'take' | 'counter' | 'walk' (the plan's walk-away
 * rule). A take needs the engine's price of his counter; a counter-with needs the engine's price of ours.
 * -> { decision, held: null | 'his_counter_unpriced' | 'our_counter_unpriced' }
 */
export function counterGate({ decision, hisPrice = null, ourPrice = null }) {
  const priced = p => !!p && Number.isFinite(p.title_after);
  if (decision === 'take' && !priced(hisPrice)) return { decision: 'wait', held: 'his_counter_unpriced' };
  if (decision === 'counter' && !priced(ourPrice)) return { decision: 'wait', held: 'our_counter_unpriced' };
  return { decision, held: null };
}

const joinNames = list => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/**
 * (d) The text opening with a why line for the partner. who(id) -> { name, position }.
 * -> { text, why: string|null, added: boolean } (why null: none fits in maxChars; text unchanged).
 */
export function ensureWhyLine(text, { who, give, holes = [], maxChars = MAX_CHARS }) {
  const src = String(text ?? '');
  const why = whyLine({ who, give, holes }) ?? (give.length ? `${joinNames(give.map(id => who(id).name))} adds depth to your roster.` : null);
  if (!why) return { text: src, why: null, added: false };
  if (src.startsWith(why)) return { text: src, why, added: false };
  const sep = src.includes('\n') ? '\n' : ' ';
  const parts = src.split(/(?<=[.!?])\s+/);
  for (let keep = parts.length; keep >= 1; keep--) {
    const out = `${why}${sep}${parts.slice(0, keep).join(' ')}`;
    if (out.length <= maxChars) return { text: out, why, added: true };
  }
  return { text: src, why: null, added: false };
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) or ISO -> ms. */
export const parseAt = s => {
  if (s == null || s === '') return NaN;
  const t = String(s);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
};

/**
 * (c) A sent offer's expiry and withdraw state.
 * lastSend: ISO of the latest send (the offer, or Nick's latest counter); ids: every player in the deal;
 * news: deal-news.js#dealNews result { events: [{ player_id, kind, at, detail }], missing: [source] }.
 * -> { expires_at, expires_hours, state: 'live' | 'expired' | 'withdraw', news, sources_missing,
 *      withdraw_if, withdraw_message, why }
 */
export function offerState({ lastSend, now, ids = [], news = { events: [], missing: [] }, hours = OFFER_HOURS }) {
  const sent = parseAt(lastSend);
  const deal = new Set(ids.map(S));
  const material = (news?.events ?? []).filter(e => deal.has(S(e.player_id)) && NEWS_KINDS.includes(e.kind) && parseAt(e.at) > sent)
    .sort((a, b) => parseAt(a.at) - parseAt(b.at));
  const expires = sent + hours * HOUR;
  const state = material.length ? 'withdraw' : now >= expires ? 'expired' : 'live';
  const missing = [...(news?.missing ?? [])];
  return {
    expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : null, expires_hours: hours, state,
    news: material, sources_missing: missing, withdraw_if: WITHDRAW_IF,
    withdraw_message: state === 'live' ? null : WITHDRAW_TEXT,
    why: state === 'withdraw' ? `news on a player in the deal since you sent it (${material.map(e => e.kind).join(', ')}): withdraw it now; the plan re-prices it on the next refresh`
      : state === 'expired' ? `the offer ran out ${hours} h after it was sent: withdraw it if it is still open`
        : `stands until ${new Date(expires).toISOString()}${missing.length ? `; not watched for news: ${missing.join(', ')}` : ''}`,
  };
}

/* ------------------------------------------------------------------ the producer pass */

const okv = f => (f && f.status === 'ok' ? f.value : null);
const ids = a => (Array.isArray(a) ? a.map(S) : []);
const REPLY_KINDS = ['accept', 'decline', 'counter', 'silence'];

/**
 * (b)+(d) over a plans entry (pure; returns a new entry). Each step's message opens with a why line and
 * passes the filter, else it is held back as 'failed' with the reason; a reply-table message that fails
 * the filter is dropped from its row. Each step carries `safety` (why line, what was filtered, expiry).
 * opts: blocked (blockedIds()), mine (Nick's roster ids), force (tests). Off -> the same entry.
 * -> { entry, stats: { steps, why_added, why_missing, rejected: { message, reply }, reasons } }
 */
export function applyNegotiatorSafety(entry, { blocked = blockedIds(), mine = [], env = process.env, force = false } = {}) {
  const stats = { steps: 0, why_added: 0, why_missing: 0, rejected: { message: 0, reply: 0 }, reasons: {} };
  if ((!force && !negotiatorSafetyOn(env)) || !entry || entry.error) return { entry, stats };
  const out = structuredClone(entry);
  const names = out.names ?? {};
  const holesOf = new Map((okv(out.partners) ?? []).map(p => [S(p.team), p.roster_holes ?? []]));
  const who = id => splitName(names[S(id)] ?? `player ${id}`);
  const mineIds = ids([...mine]);
  const count = r => { for (const k of r) stats.reasons[k] = (stats.reasons[k] ?? 0) + 1; };
  const done = new Map();
  for (const m of [okv(out.next_move), ...(okv(out.alternatives) ?? [])].filter(Boolean)) {
    // The next move is also a deck card: one pass per move id, the same steps on both.
    if (done.has(m.move_id)) { m.steps = done.get(m.move_id); continue; }
    done.set(m.move_id, m.steps);
    for (const s of m.steps ?? []) {
      if (s.claim || !s.message) continue;
      stats.steps++;
      const opening = okv(s.opening);
      const give = opening ? ids(opening.give) : ids(s.give);
      const table = okv(s.reply_table);
      const rules = okv(table?.counter)?.counter_rules ?? null;
      const rungText = String(rules?.counter_with ?? '').split('(')[0];
      const rung = rules ? mineIds.filter(id => new RegExp(`(^|[^0-9])${id}(?![0-9])`).test(rungText)
        || (nameOf(names, id).length >= 2 && fullRe(nameOf(names, id)).test(plain(rungText)))) : [];
      const alt = ids(okv(s.negotiation)?.alt_package?.give);
      const allowedGive = [...new Set([...ids(s.give), ...give, ...ids(okv(s.walk_away)?.max_give), ...alt, ...rung])];
      const allowed = [...allowedGive, ...ids(s.get)];
      const filter = text => filterText(text, { names, blocked, mine: mineIds, allowedGive, allowed });
      const filtered = [];
      let why = false;
      const msg = okv(s.message);
      if (typeof msg === 'string') {
        const holes = holesOf.get(S(s.partner)) ?? [];
        const w = ensureWhyLine(msg, { who, give, holes });
        const facts = factsFor({ names, ids: allowed, holes });
        // The why line itself must pass the grounding checker (only this step's players and positions).
        const text = w.added && !checkBursts(w.why, facts).ok ? msg : w.text;
        why = !!w.why && text.startsWith(w.why);
        if (why && w.added && text !== msg) stats.why_added++;
        if (!why) stats.why_missing++;
        const f = filter(text);
        if (f.ok) s.message = { ...s.message, value: text };
        else {
          stats.rejected.message++; count(f.reasons);
          filtered.push({ text: 'message', reasons: f.reasons });
          s.message = { status: 'failed', source: s.message.source ?? 'plan.template',
            reason: `Held back by the message filter (${f.reasons.join(', ').replace(/_/g, ' ')}).` };
        }
      }
      for (const k of REPLY_KINDS) {
        const row = table?.[k];
        const t = row?.status === 'ok' ? row.value?.message : null;
        if (typeof t !== 'string') continue;
        const f = filter(t);
        if (f.ok) continue;
        stats.rejected.reply++; count(f.reasons);
        filtered.push({ text: k, reasons: f.reasons });
        const { message: _drop, ...rest } = row.value;
        table[k] = { ...row, value: rest };
      }
      s.safety = { status: 'ok', source: 'plan.template',
        value: { why_line: why, filtered, expires_hours: OFFER_HOURS, withdraw_if: WITHDRAW_IF } };
    }
  }
  return { entry: out, stats };
}
