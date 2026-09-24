/**
 * COACH-NAV: Coach as the navigator (COACH-ANCHOR.md job 1).
 *
 * Nick talks ("get a WR1 by week 8 but keep my RB1", "go all in", "add a stop:
 * cover the week-9 bye"). This module turns the words into itinerary edits,
 * shows the engine's trade-off for each edit BEFORE anything is written, and
 * writes a warroom_requests row only after Nick confirms that exact preview.
 * Every reply about the plan ends with one grounded line:
 * "Destination: ... · Where we are: ... · Next move: ...".
 *
 * Four rules.
 *
 * WORDS -> TYPED EDITS, DETERMINISTICALLY. `parseNavigation` is rules, not a
 * model call: the edits are the War Room's plan-changing UI actions
 * (warroom-actions/schema.js PLAN_CHANGING), checked by validateAction, so a
 * navigation request costs nothing and cannot invent an action type. Players
 * are resolved only from the plan's own `names` (and, for "my RB1", from a
 * roster source when one is wired); a word it cannot resolve stays a label.
 *
 * PREVIEW FROM THE ENGINE, NEVER COMPUTED HERE. The trade-off is the
 * producer's stop_tradeoffs row under plans-schema.js#tradeoffKey (the same
 * key the dashboard reads). Title odds now and the ETA come from the plan's
 * destination. A change the planner has not priced is said to be unpriced; no
 * number is made up for it. The only thing done to a number is writing a
 * fraction as a percentage, which verify.js accepts as the same number.
 *
 * NO WRITE WITHOUT CONFIRM. `navigate` never writes. `confirmNavigation`
 * writes only when the confirmation carries the proposal's token, and the
 * token binds the edits to the plan version they were previewed on: a plan
 * regenerated since the preview is refused as stale. The request goes through
 * store.js#recordRequest with source 'coach', confirmed = 1, which is the only
 * way schema.js lets a Coach-proposed plan change in.
 *
 * GROUNDED. The preview lines and the footer are claims whose cites are
 * plan_read rows recorded in the turn's ledger, and they ship only after
 * verify.js#verifyAnswer passes them.
 *
 * Behind GRIDIRON_COACH_NAV (default off; the preview switch turns it
 * on through preview-mode.js; GRIDIRON_COACH_NAV=0 vetoes preview).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { previewUnconfirmed } from '../preview-mode.js';
import { validateAction, requestForAction } from '../warroom-actions/schema.js';
import { recordRequest } from '../warroom-actions/store.js';
import { tradeoffKey } from '../campaign/plans-schema.js';
import { planRead, plansPath } from './brain-tools.js';
import { verifyAnswer, groundAnswer } from './verify.js';
import { newLedger } from './ledger.js';

export const NAV_ENV = 'GRIDIRON_COACH_NAV';

/** On with its own flag or preview mode; its own flag set to '0' vetoes preview. */
export function navOn() {
  const own = process.env[NAV_ENV];
  if (own === '1') return true;
  if (own === '0') return false;
  return previewUnconfirmed();
}

export class NavigatorError extends Error {
  constructor(message) { super(message); this.name = 'NavigatorError'; }
}

/* ------------------------------------------------------------ sources */

/**
 * `roster(leagueId)` -> [{ player_id, position, rank }] for Nick's team, best
 * first within a position (rank 1 = his RB1). Null on this build: "my RB1"
 * then stays a label, which the producer resolves.
 */
const sources = { roster: () => null };

/** Swap a source (tests; a later unit that wires Nick's roster). */
export function setNavigatorSources({ roster } = {}) {
  if (roster !== undefined) sources.roster = roster ?? (() => null);
}

/* ------------------------------------------------------------ parsing */

const WEEK = /\b(?:week|wk)[\s-]?(\d{1,2})\b/;
const weekIn = t => { const m = t.match(WEEK); return m ? Number(m[1]) : null; };
const untilWeekIn = t => { const m = t.match(/\b(?:until|thru|through|till|to)\s+(?:week|wk)[\s-]?(\d{1,2})\b/); return m ? Number(m[1]) : null; };
const byWeekIn = t => { const m = t.match(/\b(?:by|before|no later than)\s+(?:week|wk)[\s-]?(\d{1,2})\b/); return m ? Number(m[1]) : null; };

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameCore = s => String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Every way a clause can name a plan player: "P21", "K. Bell", "Bell". Longest first. */
function playerMatchers(names) {
  const out = [];
  for (const [id, full] of Object.entries(names ?? {})) {
    const core = nameCore(full);
    if (!core) continue;
    out.push({ id, full, pattern: core });
    const last = core.match(/^[A-Z]\.\s?(.+)$/)?.[1];
    if (last && last.length >= 3) out.push({ id, full, pattern: last });
  }
  return out.sort((a, b) => b.pattern.length - a.pattern.length);
}

/** Players a clause names, in the order they appear. */
function playersIn(clause, matchers) {
  const found = [];
  for (const m of matchers) {
    const rx = new RegExp(`(^|[^a-z0-9])${escape(m.pattern.toLowerCase())}([^a-z0-9]|$)`);
    const hit = rx.exec(clause);
    if (hit && !found.some(f => f.id === m.id)) found.push({ id: m.id, full: m.full, at: hit.index });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** "my RB1" / "my top WR" / "my best back" -> { position, rank }. */
function myPositionRef(clause) {
  const words = { qb: 'QB', rb: 'RB', back: 'RB', wr: 'WR', receiver: 'WR', te: 'TE', 'tight end': 'TE' };
  const m = clause.match(/\bmy (?:(top|best|first|second|third) )?(qb|rb|wr|te|back|receiver|tight end)s? ?(\d)?\b/);
  if (!m) return null;
  const rank = m[3] ? Number(m[3]) : ({ second: 2, third: 3 }[m[1]] ?? 1);
  return { position: words[m[2]], rank };
}

/** "a WR1", "a starting RB", "another receiver" -> position (not a named player). */
function unnamedPosition(clause) {
  const m = clause.match(/\b(?:a|an|another|one more) (?:starting |top |good |real )?(qb|rb|wr|te|receiver|back|tight end)(\d)?\b/);
  if (!m) return null;
  const pos = { receiver: 'WR', back: 'RB', 'tight end': 'TE' }[m[1]] ?? m[1].toUpperCase();
  return { position: pos, tier: m[2] ? Number(m[2]) : null };
}

const RISK_WORDS = [
  ['all_in', /\b(all[- ]?in|fuck it|go for broke|swing big|max(?:imum)? risk|aggressive|push (?:all )?(?:the|my) chips)\b/],
  ['safe', /\b(play it safe|safe mode|go safe|be safe|safe|conservative|low risk|careful|protect (?:my|the) (?:floor|lead))\b/],
  ['balanced', /\b(balanced|normal risk|middle of the road|back to normal)\b/]
];

const STOP_VERBS = {
  untouchable: /\b(keep|don'?t (?:trade|touch|move|sell|deal)|do not (?:trade|touch|move|sell|deal)|untouchable|hold onto|hold on to|not trading|off limits|off the table)\b/,
  sell: /\b(sell|dump|trade away|shop|move on from|get rid of|cash out)\b/,
  flip: /\bflip\b/,
  claim: /\b(claim|pick up|pickup|waiver|waivers|add off the wire)\b/,
  get: /\b(get|land|acquire|trade for|add|go get|grab|want|target|upgrade|i'?d like|need|find me|looking for)\b/
};

function clauses(raw) {
  return raw.split(/\s*(?:;|\.\s|\bbut\b|\band also\b|\bthen\b|\bplus\b|,\s*and\b|\band\b(?= (?:keep|don'?t|do not|go|add|get|sell|flip|claim|cover|play|make|win|drop|remove)\b))\s*/)
    .map(s => s.trim()).filter(Boolean);
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One clause -> one edit (a UI action before validation), or null.
 * `ctx` = { matchers, stops, roster }.
 */
function parseClause(clause, ctx) {
  const t = clause.toLowerCase();
  const players = playersIn(t, ctx.matchers);
  const week = weekIn(t);

  // Remove a stop: by player, by week, or by words of its label.
  if (/\b(remove|drop|delete|cancel|scrap|forget about|take off|kill)\b/.test(t) && /\bstop\b|\bfrom the (?:route|itinerary|plan)\b/.test(t)
    || /\b(remove|drop|delete|scrap)\b.*\b(bye|stop)\b/.test(t)) {
    const stops = ctx.stops ?? [];
    const hit = (players.length && stops.find(s => players.some(p => p.id === String(s.player_id))))
      || (week && stops.find(s => s.week === week))
      || stops.find(s => s.kind === 'cover_bye' && /\bbye\b/.test(t))
      || stops.find(s => t.includes(String(s.label).toLowerCase()));
    return hit ? { type: 'remove_stop', stop_id: hit.id } : { unresolved: 'remove_stop', clause };
  }

  // Risk mode.
  for (const [mode, rx] of RISK_WORDS) {
    if (rx.test(t) && !/\b(keep|untouchable)\b/.test(t)) {
      return { type: 'set_risk_mode', mode, until_week: untilWeekIn(t) };
    }
  }

  // Objective: title / playoffs / points / a named player as the goal.
  if (/\b(make|reach|get into|sneak into|just make) (?:it to )?the playoffs\b|\bplayoffs? (?:is|are) the goal\b/.test(t)) {
    return { type: 'set_objective', goal: 'playoffs', arrive_by: byWeekIn(t) };
  }
  if (/\b(win (?:it all|the title|the championship|the league|a title)|go (?:for|after) the (?:title|ring|championship)|title or bust|chase the title)\b/.test(t)) {
    return { type: 'set_objective', goal: 'title', arrive_by: byWeekIn(t) };
  }
  const pts = t.match(/\b(\d{2,3})\s*(?:projected )?(?:points|pts)\s*(?:a|per|each|every)\s*week\b/);
  if (pts) return { type: 'set_objective', goal: 'points', points_per_week: Number(pts[1]), arrive_by: byWeekIn(t) };

  const isStop = /\bstop\b/.test(t);

  // Cover a bye (before sell: "sell X before his bye" is a sell).
  if (/\bbye\b/.test(t) && /\b(cover|fill|handle|plan for|deal with|get through)\b/.test(t) && week) {
    return { type: 'add_stop', stop: { kind: 'cover_bye', label: `Cover the week ${week} bye`, player_id: null, week } };
  }

  const stopFor = (kind, verb) => {
    const p = players[0];
    const w = kind === 'untouchable' ? null : (byWeekIn(t) ?? week);
    if (p) return { type: 'add_stop', stop: { kind, label: `${verb} ${p.full}`, player_id: p.id, week: w } };
    const mine = myPositionRef(t);
    if (mine) {
      const pick = (ctx.roster ?? []).filter(r => r.position === mine.position)
        .sort((a, b) => a.rank - b.rank)[mine.rank - 1];
      const label = `${verb} my ${mine.position}${mine.rank}`;
      return { type: 'add_stop', stop: { kind, label, player_id: pick ? String(pick.player_id) : null, week: w } };
    }
    const pos = unnamedPosition(t);
    if (pos) {
      return { type: 'add_stop', stop: { kind, label: `${verb} a ${pos.position}${pos.tier ?? ''}${w ? ` by week ${w}` : ''}`, player_id: null, week: w } };
    }
    return null;
  };

  if (STOP_VERBS.untouchable.test(t)) { const e = stopFor('untouchable', 'Keep'); if (e) return e; }
  if (STOP_VERBS.flip.test(t)) { const e = stopFor('flip', 'Flip'); if (e) return e; }
  if (STOP_VERBS.sell.test(t)) { const e = stopFor('sell', 'Sell'); if (e) return e; }
  if (STOP_VERBS.claim.test(t)) { const e = stopFor('claim', 'Claim'); if (e) return e; }
  if (STOP_VERBS.get.test(t)) {
    // A named player with "I want / go get / target" and no "stop" is the goal itself.
    if (players.length && !isStop && /\b(i want|go get|target|make .* the goal|goal is|go after)\b/.test(t)) {
      return { type: 'set_objective', goal: 'get_player', player_id: players[0].id, arrive_by: byWeekIn(t) ?? week };
    }
    const e = stopFor('get', 'Get'); if (e) return e;
  }

  // "add a stop: <anything>" that matched nothing above is Nick's own words.
  const custom = clause.match(/\badd (?:a )?stop\s*[:,-]?\s*(.+)$/i);
  if (custom) {
    return { type: 'add_stop', stop: { kind: 'custom', label: cap(custom[1].trim()).slice(0, 120), player_id: null, week } };
  }
  return null;
}

/**
 * Plain words -> validated itinerary edits.
 * @param {string} text
 * @param {{ names?: object, stops?: object[], roster?: object[] }} plan
 * @returns {{ edits: object[], unresolved: string[] }}
 */
export function parseNavigation(text, { names = {}, stops = [], roster = null } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 400) return { edits: [], unresolved: raw ? ['the request is too long to read as one edit'] : [] };
  const ctx = { matchers: playerMatchers(names), stops, roster };
  const edits = [];
  const unresolved = [];
  for (const clause of clauses(raw)) {
    const e = parseClause(clause, ctx);
    if (!e) continue;
    if (e.unresolved) { unresolved.push(`no stop on the route matches "${clause}"`); continue; }
    const checked = validateAction(e);
    if (!checked.ok) { unresolved.push(`"${clause}": ${checked.error}`); continue; }
    if (!edits.some(x => tradeoffKey(x) === tradeoffKey(checked.action))) edits.push(checked.action);
  }
  return { edits, unresolved };
}

/* ------------------------------------------------------------ plan rows */

const safeKey = key => key.replace(/[^A-Za-z0-9_]/g, '_');

/** plan_read one section and record it in the ledger exactly as the plan_read tool would. */
function readSection(ledger, leagueId, section) {
  const rows = planRead({ league_id: leagueId, section });
  const entry = ledger.record({ tool: 'plan_read', sql: null, params: [], tables: ['warroom_plans_file'],
    columns: Object.keys(rows[0] ?? {}), rows, row_count: rows.length, truncated: false, provenance: {} });
  return { entry, row: rows[0] ?? {} };
}

/** A cite for column `col` of a recorded one-row entry, or null when the plan has no such cell. */
const citeOf = (sec, col) => (Object.hasOwn(sec.row, col) && sec.row[col] != null ? `${sec.entry.id}#0.${col}` : null);
const pct = v => (v * 100).toFixed(Math.abs(v * 100) < 10 ? 1 : 0);
const pts = v => (v * 100).toFixed(1);

/** The stops on the route, rebuilt from plan_read's flat row (for "remove the X stop"). */
function stopsFrom(itin) {
  const out = [];
  for (let i = 0; Object.hasOwn(itin.row, `itinerary_stops_${i}_id`); i++) {
    const g = k => itin.row[`itinerary_stops_${i}_${k}`];
    out.push({ id: g('id'), kind: g('kind'), label: g('label'), player_id: g('player_id') ?? null, week: g('week') ?? null });
  }
  return out;
}

/**
 * The league's player names: the plan's own `names` map (for resolving who Nick
 * means; not evidence, so not in the ledger), plus plan_read `_name` cells.
 */
function namesFrom(leagueId, sections) {
  const names = {};
  try {
    const doc = JSON.parse(fs.readFileSync(plansPath(), 'utf8'));
    const entry = Array.isArray(doc?.leagues) ? doc.leagues.find(l => l?.league === leagueId) : null;
    for (const [k, v] of Object.entries(entry?.names ?? {})) if (typeof v === 'string') names[k] = v;
  } catch { /* no readable plans file: plan_read already says so, typed */ }
  for (const sec of sections) {
    for (const [col, v] of Object.entries(sec.row)) {
      const m = col.match(/^(.*)_name$/);
      if (!m || typeof v !== 'string') continue;
      const id = sec.row[m[1]];
      if (id != null) names[String(id)] = v;
    }
  }
  return names;
}

/* ------------------------------------------------------------ preview */

function describe(edit) {
  switch (edit.type) {
    case 'set_objective': return edit.goal === 'get_player' ? 'make getting this player the goal'
      : edit.goal === 'points' ? 'aim for a points-per-week target' : edit.goal === 'title' ? 'aim for the title' : 'aim for the playoffs';
    case 'add_stop': return `add a stop (${edit.stop.kind.replace('_', ' ')}): ${edit.stop.label}`;
    case 'remove_stop': return 'remove a stop';
    case 'set_risk_mode': return `switch to ${edit.mode.replace('_', '-')}`;
    case 'set_tolerance': return `change the ${edit.key.replace(/_/g, ' ')} tolerance`;
    default: return edit.type;
  }
}

/**
 * The engine's trade-off for one edit, as claims with cites, plus a typed
 * summary for the dashboard. Reads stop_tradeoffs under tradeoffKey(edit);
 * never computes a number.
 */
function previewOne(edit, { trade, dest, brain }) {
  const key = tradeoffKey(edit);
  const p = `stop_tradeoffs_${safeKey(key)}_`;
  const has = Object.hasOwn(trade.row, `${p}stop_label`);
  const claims = [];
  const titleCite = citeOf(dest, 'destination_title_now_value');
  const etaCite = citeOf(dest, 'destination_eta_week_value');
  const preview = { key, edit, description: describe(edit), status: has ? 'ok' : 'unknown' };

  if (has) {
    const v = col => trade.row[`${p}${col}`];
    const cost = v('cost_value'); const gain = v('gain_value'); const net = v('net_value');
    Object.assign(preview, { stop_label: v('stop_label'), cost, gain, net, extra_steps: v('extra_steps'),
      verdict: v('verdict'), because: v('because'), new_next_move_changes: v('new_next_move_changes') });
    const parts = [];
    const cites = [citeOf(trade, `${p}stop_label`)];
    if (Number.isFinite(cost)) { parts.push(`costs ${pts(cost)} pts of title odds`); cites.push(citeOf(trade, `${p}cost_value`)); }
    if (Number.isFinite(gain)) { parts.push(`gains ${pts(gain)}`); cites.push(citeOf(trade, `${p}gain_value`)); }
    if (Number.isFinite(net)) { parts.push(`net ${pts(net)}`); cites.push(citeOf(trade, `${p}net_value`)); }
    const verdict = String(v('verdict') ?? '').replace(/_/g, ' ');
    cites.push(citeOf(trade, `${p}verdict`), citeOf(trade, `${p}because`));
    claims.push({ text: `Trade-off for "${v('stop_label')}": ${parts.join(', ')}; ${verdict}, because ${v('because')}.`,
      cites: cites.filter(Boolean) });
    const eta = [];
    const etaCites = [];
    if (Number.isInteger(v('extra_steps'))) { eta.push(`it adds ${v('extra_steps')} step${v('extra_steps') === 1 ? '' : 's'} to the route`); etaCites.push(citeOf(trade, `${p}extra_steps`)); }
    if (etaCite) { eta.push(`the ETA is week ${dest.row.destination_eta_week_value} today`); etaCites.push(etaCite); }
    if (v('new_next_move_changes') === true) { eta.push('and it changes the next move'); etaCites.push(citeOf(trade, `${p}new_next_move_changes`)); }
    if (eta.length) claims.push({ text: `${cap(eta.join('; '))}.`, cites: etaCites.filter(Boolean) });
    if (typeof v('gain_text') === 'string' && v('gain_text')) {
      claims.push({ text: v('gain_text'), cites: [citeOf(trade, `${p}gain_text`)] });
    }
  } else {
    const statusCite = citeOf(trade, 'stop_tradeoffs_status') ?? citeOf(trade, 'status');
    claims.push({ text: 'The planner has not priced this change yet: confirming records it, and the planner prices it on its next run.',
      cites: [statusCite].filter(Boolean) });
  }
  if (titleCite) {
    const now = dest.row.destination_title_now_value;
    claims.push({ text: `Title odds are ${pct(now)}% on the current plan before this change.`, cites: [titleCite] });
    preview.title_now = now;
  }
  if (etaCite) preview.eta_week = dest.row.destination_eta_week_value;
  const fell = citeOf(brain, 'brain_report_fell_back_to');
  if (edit.type === 'set_risk_mode' && edit.mode === 'all_in' && fell) {
    claims.push({ text: `The brain gate is holding all-in back to ${brain.row.brain_report_fell_back_to} until the report card passes, so the plan may not move yet.`,
      cites: [fell] });
    preview.gated_to = brain.row.brain_report_fell_back_to;
  }
  return { preview, claims };
}

/* ------------------------------------------------------------ footer */

/** "Destination: ... · Where we are: ... · Next move: ..." as one claim with its cites. */
function footerClaim({ dest, next }) {
  const cites = [];
  const use = (sec, col) => { const c = citeOf(sec, col); if (c) cites.push(c); return c; };

  let destination;
  if (use(dest, 'destination_goal_value_label')) {
    destination = dest.row.destination_goal_value_label;
    use(dest, 'destination_goal_value_player_id_name');
    if (use(dest, 'destination_arrive_by_value')) destination += ` by week ${dest.row.destination_arrive_by_value}`;
  } else {
    destination = 'not set in the plan';
    use(dest, 'destination_status'); use(dest, 'status');
  }

  const where = [];
  if (use(dest, 'destination_title_now_value')) where.push(`${pct(dest.row.destination_title_now_value)}% title odds now`);
  if (use(dest, 'destination_title_planned_now_value')) where.push(`${pct(dest.row.destination_title_planned_now_value)}% planned`);
  if (use(dest, 'destination_eta_week_value')) where.push(`ETA week ${dest.row.destination_eta_week_value}`);
  const whereText = where.length ? where.join(', ') : 'unknown (the plan has no title odds yet)';

  let move;
  const s = i => `next_move_steps_0_${i}`;
  if (use(next, s('partner'))) {
    const side = k => {
      const out = [];
      for (let i = 0; Object.hasOwn(next.row, `${s(k)}_${i}`); i++) {
        use(next, `${s(k)}_${i}`);
        out.push(use(next, `${s(k)}_${i}_name`) ? next.row[`${s(k)}_${i}_name`] : `player ${next.row[`${s(k)}_${i}`]}`);
      }
      return out.join(' + ');
    };
    move = `give ${side('give')} to Team ${next.row[s('partner')]} for ${side('get')}`;
  } else if (use(next, 'next_move_reason')) {
    move = `none yet (${next.row.next_move_reason})`;
  } else {
    move = 'none yet';
    use(next, 'next_move_status'); use(next, 'status'); use(next, 'reason');
  }
  return { text: `Destination: ${destination} · Where we are: ${whereText} · Next move: ${move}.`, cites, footer: true };
}

/* ------------------------------------------------------------ navigate */

const tokenFor = (leagueId, edits, generatedAt) => crypto.createHash('sha256')
  .update(JSON.stringify({ leagueId, edits, generatedAt })).digest('hex').slice(0, 16);

/**
 * One navigation turn. Reads the plan through plan_read (recorded in `ledger`),
 * parses `text` into edits, previews each, builds the footer, and verifies
 * every claim. Writes nothing.
 *
 * @returns {{ proposal: { token, league_id, plans_generated_at, edits, previews, unresolved },
 *   answer: { claims, refusals, as_of }, verification, actions: object[] }}
 */
export function navigate({ leagueId, text, ledger = newLedger(), edits: given = null } = {}) {
  const id = Number(leagueId);
  if (!Number.isInteger(id) || id < 1) throw new NavigatorError(`league_id must be a whole number, got ${JSON.stringify(leagueId)}.`);
  const dest = readSection(ledger, id, 'destination');
  const next = readSection(ledger, id, 'next_move');
  const itin = readSection(ledger, id, 'itinerary');
  const trade = readSection(ledger, id, 'stop_tradeoffs');
  const brain = readSection(ledger, id, 'brain_report');

  const refusals = [];
  if (dest.row.status !== 'ok') refusals.push(`The plan for league ${id} is not readable: ${dest.row.reason}`);

  let edits = [];
  let unresolved = [];
  if (Array.isArray(given)) {
    for (const e of given) {
      const checked = validateAction(e);
      if (checked.ok && requestForAction(checked.action)) edits.push(checked.action);
      else unresolved.push(checked.ok ? `${e.type} is not a plan change` : checked.error);
    }
  } else {
    const names = namesFrom(id, [dest, next, itin]);
    ({ edits, unresolved } = parseNavigation(text, { names, stops: stopsFrom(itin), roster: sources.roster(id) }));
  }
  for (const u of unresolved) refusals.push(`Coach could not turn this into a plan change: ${u}.`);
  if (!edits.length && !unresolved.length && text) {
    refusals.push('That does not read as a change to the plan (goal, stops, rules or risk mode), so nothing is proposed.');
  }

  const previews = [];
  const claims = [];
  for (const edit of edits) {
    const { preview, claims: c } = previewOne(edit, { trade, dest, brain });
    previews.push(preview);
    claims.push(...c);
  }
  claims.push(footerClaim({ dest, next }));

  const generatedAt = dest.row.plans_generated_at ?? null;
  const draft = { claims, refusals, as_of: generatedAt ? `plans file generated ${generatedAt}` : null };
  const verification = verifyAnswer({ answer: draft, ledger, question: String(text ?? '') });
  const answer = verification.ok ? draft : groundAnswer(draft, verification);
  const proposal = { token: tokenFor(id, edits, generatedAt), league_id: id, plans_generated_at: generatedAt,
    edits, previews, unresolved, writes: 0,
    note: edits.length ? 'Nothing is written yet. Nick confirms this preview and only then is it recorded.' : 'No plan change proposed.' };
  return { proposal, answer, verification, actions: edits };
}

/**
 * Record a previewed proposal, only on Nick's confirm of THAT preview.
 *
 * @param {{ userId: number, proposal: object, confirm?: { token: string } | null }} args
 * @returns {{ written: number, requests: object[], refused?: string }}
 */
export function confirmNavigation({ userId, proposal, confirm = null, now = Date.now() } = {}) {
  if (!navOn()) return { written: 0, requests: [], refused: 'Coach navigation is off (GRIDIRON_COACH_NAV).' };
  if (!proposal?.edits?.length) return { written: 0, requests: [], refused: 'There is no proposed change to confirm.' };
  if (!confirm || confirm.token !== proposal.token) {
    return { written: 0, requests: [], refused: 'Not confirmed: nothing changes until Nick confirms this exact preview.' };
  }
  // The plan must still be the one the preview was read from.
  const current = planRead({ league_id: proposal.league_id, section: 'destination' })[0]?.plans_generated_at ?? null;
  if (current !== proposal.plans_generated_at
    || tokenFor(proposal.league_id, proposal.edits, current) !== proposal.token) {
    return { written: 0, requests: [], refused: 'The plan changed since this preview. Ask again to see the new trade-off.' };
  }
  const requests = proposal.edits.map(edit => {
    const req = requestForAction(edit);
    return recordRequest({ userId, leagueId: proposal.league_id, kind: req.kind, payload: req.payload,
      source: 'coach', confirmed: true, now });
  });
  return { written: requests.length, requests };
}

/* ------------------------------------------------------------ tool */

/** Coach's itinerary_edit tool (COACH-ANCHOR.md "Tools Coach gets"), run by tools.js#runCoachTool. */
export const NAV_TOOL = Object.freeze({
  name: 'itinerary_edit', kind: 'navigate', source: 'server/services/coach/navigator.js#navigate',
  tables: ['warroom_plans_file'],
  description: "Turn Nick's words about the plan into itinerary edits (goal, stops, untouchables, risk mode) and read " +
    "the engine's trade-off for each (title odds, cost, ETA) from the plan. Pass his words as `request`. Nothing is " +
    'written: the dashboard shows the preview and Nick confirms it. The result carries ready-made claims with cites; ' +
    'put them in your answer as they are, and keep the footer claim (destination, where we are, next move) last. ' +
    'Never state a trade-off number yourself.',
  input_schema: { type: 'object', required: ['league_id', 'request'], properties: {
    league_id: { type: 'integer', description: "the user's league id" },
    request: { type: 'string', description: "Nick's words, as he said them" } } },
  run(input, { ledger }) {
    return navigate({ leagueId: input?.league_id, text: String(input?.request ?? ''), ledger });
  }
});

