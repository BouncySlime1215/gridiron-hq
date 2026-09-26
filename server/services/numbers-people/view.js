/**
 * NUMBERS-PEOPLE: what the Trades → Numbers & People tab shows, from the stored
 * reads only (never a model call on a view).
 *
 *   summary      agree / differ / same_but (and no_people_read) counts of the newest finished run
 *   items        per item: its label and players (from the served plan's names), both lanes'
 *                stance, why and cited numbers or signal labels (formatted here, the one
 *                formatter), the verdict, and its week-by-week history; DIFFER first
 *   scoreboard   when they differed, which lane was right (scoreboard.js; honest n)
 *   notice       when the newest attempt did not finish (budget used up, a failure), what
 *                is shown instead: the last reads, never an error
 */
import { db as defaultDb, row } from '../../db/index.js';
import { lastRun, readsOfRun, weeklyHistory, storeReady } from './store.js';
import { scoreboard } from './scoreboard.js';
import { numbersPeopleOn, WINDOW_HOURS } from './producer.js';
import { PEOPLE_LABEL } from '../coach/lanes.js';
import { JEV_CITE_LABELS } from './lanes.js';

const ORDER = { differ: 0, same_but: 1, agree: 2, no_people_read: 3 };
const ok = f => f?.status === 'ok';

const SIGNAL_LABELS = Object.freeze({
  in_market: 'In the market', wants: 'Players they want', shopping: 'Players they shop', untouchable: 'Players they keep',
  p_open_to_trade: 'Open to trading', profile_confidence: 'How sure the read is', messages_read: 'Chat messages read',
  nick_override: 'Your override', type: 'What they said (label)', phrase: 'What they said (label)', credible: 'Credible',
  weight: 'Weight', ago: 'When', kind: 'Trade screenshot', confidence: 'How sure the read is',
  wants_player_ids: 'Screenshot: asked for', would_give_player_ids: 'Screenshot: offered'
});
const HIDDEN_SIGNAL_FIELDS = new Set(['roster_id', 'signal', 'seen_at']);

const pct = v => `${Math.round(v * 100)}%`;
const pts = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`;

/** One cited fact as the tab shows it: label and formatted value. */
export function factText(c) {
  const v = c.value;
  let text;
  if (typeof v === 'boolean') text = v ? 'Yes' : 'No';
  else if (typeof v !== 'number') text = String(v);
  else if (/^p_|^reply_/.test(c.key)) text = pct(v);
  else if (/gain|edge/.test(c.key)) text = pts(v);
  else text = String(v);
  return { label: JEV_CITE_LABELS[c.key] ?? c.label, value: text };
}

/** One cited signal as the tab shows it, or null for a field that is bookkeeping (ids, dates). */
export function signalText(c, nameOf) {
  if (HIDDEN_SIGNAL_FIELDS.has(c.field)) return null;
  const label = SIGNAL_LABELS[c.field];
  if (!label) return null;
  let v = c.value;
  if (/_player_ids$/.test(c.field)) v = String(v).split(',').map(s => nameOf(s.trim())).filter(Boolean).join(', ');
  // A list value stays short: the first two, then "+N" (the lane column never cuts the label off for it).
  if (typeof v === 'string' && v.includes(', ')) { const xs = v.split(', '); v = xs.length > 2 ? `${xs.slice(0, 2).join(', ')} +${xs.length - 2}` : v; }
  else if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
  else if (typeof v === 'number') v = c.field.startsWith('p_') ? pct(v) : String(v);
  return v ? { label, value: String(v) } : null;
}

function laneOut(lane, { nameOf, people = false }) {
  if (!lane || lane.skipped) return { skipped: lane?.skipped ?? 'no read', ...(people ? { label: PEOPLE_LABEL } : {}) };
  const cites = [];
  for (const c of lane.cites ?? []) {
    const t = c.field ? signalText(c, nameOf) : factText(c);
    if (t && !cites.some(x => x.label === t.label && x.value === t.value)) cites.push(t);
  }
  return { stance: lane.stance, basis: lane.basis, why: lane.why ?? null, why_withheld: !!lane.why_withheld, cites,
    ...(people ? { label: PEOPLE_LABEL } : {}) };
}

/** Names from the served plan (players and teams), then the players table; never an id on screen. */
function namer(entry) {
  const names = entry?.names ?? {};
  const teams = ok(entry?.teams) ? entry.teams.value : {};
  const player = id => {
    const n = names[String(id)];
    if (n) return String(n);
    const r = row('SELECT name, position FROM players WHERE id = ?', Number(id));
    return r?.name ? `${r.name}${r.position ? ` (${r.position})` : ''}` : null;
  };
  const team = id => {
    const t = teams[String(id)];
    const manager = t?.manager?.trim?.();
    const name = t?.name?.trim?.();
    return manager && name ? `${manager} (${name})` : manager || name || 'A league-mate';
  };
  return { player, team };
}

function moveOf(entry, moveId) {
  const nm = ok(entry?.next_move) ? entry.next_move.value : null;
  const all = [...(nm ? [nm] : []), ...(ok(entry?.alternatives) ? entry.alternatives.value ?? [] : [])];
  return all.find(m => String(m?.move_id) === String(moveId)) ?? null;
}

/** The item's title, a short line under it and its players (ids + names, for photos). */
function describe(r, entry, n) {
  if (r.item_type === 'move') {
    const move = moveOf(entry, r.item_id);
    if (!move?.steps?.length) return { title: 'A move no longer in the plan', subtitle: null, players: [] };
    const s = move.steps[0];
    const get = s.get.map(String), give = s.give.map(String);
    const title = `Get ${get.map(n.player).filter(Boolean).join(' + ')} for ${give.map(n.player).filter(Boolean).join(' + ')}`;
    const more = move.steps.length > 1 ? ` · step 1 of ${move.steps.length}` : '';
    return { title, subtitle: `With ${n.team(s.partner)}${more}`, partner: String(s.partner),
      players: [...get, ...give].map(id => ({ id, name: n.player(id) ?? 'A player' })) };
  }
  if (r.item_type === 'target') {
    const t = (ok(entry?.targets) ? entry.targets.value : []).find(x => String(x.player) === String(r.item_id));
    return { title: n.player(r.item_id) ?? 'A player', subtitle: t?.owner != null ? `Go get · on ${n.team(t.owner)}'s roster` : 'Go get target',
      partner: t?.owner != null ? String(t.owner) : null, players: [{ id: String(r.item_id), name: n.player(r.item_id) ?? 'A player' }] };
  }
  return { title: n.team(r.item_id), subtitle: 'League-mate with an open or likely deal', partner: String(r.item_id), players: [] };
}

/** One stored read as the shared card (NumbersPeopleCard) shows it. */
function shapeItem(r, { entry, n, history, readAt = null }) {
  return {
    key: `${r.item_type}:${r.item_id}`, item_type: r.item_type, item_id: r.item_id, ...describe(r, entry, n),
    numbers: laneOut(r.lane_a, { nameOf: n.player }), people: laneOut(r.lane_b, { nameOf: n.player, people: true }),
    verdict: r.verdict, read_at: readAt ?? r.created_at ?? null,
    history: (history.get(`${r.item_type}:${r.item_id}`) ?? []).map(h => ({ week: h.week, numbers: h.lane_a?.stance ?? null,
      people: h.lane_b?.stance ?? null, verdict: h.verdict }))
  };
}

/**
 * COACH: the newest read of the item a Coach answer is about (the thread focus after the turn):
 * the focused move, else a Go get target among the focused players, else the focused
 * league-mate. Null when the flag is off or that item has no read.
 */
export function readForFocus({ leagueId, focus, entry = null, database = defaultDb }) {
  if (!numbersPeopleOn() || !focus || !storeReady(database)) return null;
  const last = lastRun(database, leagueId, { status: 'ok' });
  if (!last) return null;
  const reads = readsOfRun(database, last.id);
  const find = (type, id) => (id == null ? null : reads.find(r => r.item_type === type && r.item_id === String(id)) ?? null);
  const r = find('move', focus.move_id)
    ?? (focus.players ?? []).map(p => find('target', p)).find(Boolean)
    ?? find('partner', focus.partner);
  if (!r) return null;
  return shapeItem(r, { entry, n: namer(entry), history: weeklyHistory(database, leagueId, [r]), readAt: last.created_at });
}

/**
 * The tab's payload for one league. `entry` is the served plan entry (or null);
 * `refreshing` says a run is under way.
 */
export function numbersPeopleView({ leagueId, entry = null, database = defaultDb, now = Date.now(), refreshing = false, season = null } = {}) {
  const enabled = numbersPeopleOn();
  const base = { enabled, league: leagueId, window_hours: WINDOW_HOURS, refreshing };
  if (!enabled) return { ...base, status: 'off', items: [], summary: null, scoreboard: null };
  if (!storeReady(database)) return { ...base, status: 'empty', items: [], summary: null, scoreboard: null };
  const last = lastRun(database, leagueId, { status: 'ok' });
  const attempt = lastRun(database, leagueId);
  let notice = null;
  if (attempt && attempt.status !== 'ok' && (!last || attempt.id > last.id)) {
    const when = last ? 'Showing the last reads.' : 'There are no earlier reads to show yet.';
    notice = attempt.status === 'budget'
      ? { kind: 'budget', text: `Today's AI allowance for these reads is used up, so they were not refreshed. ${when} It resets at midnight.`, at: attempt.created_at }
      : { kind: 'failed', text: `The last refresh did not finish. ${when}`, at: attempt.created_at };
  }
  if (!last) return { ...base, status: 'empty', notice, items: [], summary: null, scoreboard: null };
  const n = namer(entry);
  const reads = readsOfRun(database, last.id);
  const history = weeklyHistory(database, leagueId, reads);
  const summary = { agree: 0, differ: 0, same_but: 0, no_people_read: 0 };
  const items = reads.map((r, i) => {
    summary[r.verdict] += 1;
    return { ...shapeItem(r, { entry, n, history }), order: i };
  }).sort((a, b) => (ORDER[a.verdict] - ORDER[b.verdict]) || (a.order - b.order));
  const me = entry?.me ?? row('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)?.my_team_id ?? null;
  const board = scoreboard(database, leagueId, { me, season: season ?? row('SELECT season FROM leagues WHERE id = ?', leagueId)?.season ?? null });
  const age = (now - Date.parse(last.created_at)) / 3_600_000;
  return { ...base, status: 'ok', notice, read_at: last.created_at, week: last.week, stale: age >= WINDOW_HOURS,
    summary, items, scoreboard: board };
}
