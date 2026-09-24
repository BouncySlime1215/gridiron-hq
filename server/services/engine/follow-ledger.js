/**
 * The follow ledger (SELF-01a): did Nick follow the call?
 *
 * Every recommendation SHOWN (start/sit pair, waiver claim, trade idea, War
 * Room next move) is logged once, with its as-of inputs, the pick, the margin
 * it was made on and the alternative. Later, `resolveDue()` matches what was
 * actually done on ESPN into follow / ignore / no_action. Grading the choice is
 * SELF-01b's job; this file records, it never scores.
 *
 * Table: `follow_ledger` (server/migrations/082_follow_ledger.js).
 * Writers: `logShown()`, called live from rec-ledger.js `recordRoute()` for
 * every shown call the recommending routes make; `logNextMove()` for the War
 * Room (no caller yet: the War Room is not built); `backfillFromRecLedger()`
 * for calls rec_ledger (071) froze before this ledger existed. Resolver:
 * `resolveDue()`, run by the scheduler job `follow_ledger_sync` through
 * `syncFollowLedger()`. Reader: `followSummary()`.
 *
 * WHAT WAS DONE, per action:
 *   - start_sit: `league_roster_snapshots` (058) for the rec's scoring period
 *     (ESPN scoring period = the rec's week). Resolves at lock: the league
 *     clock is past the week, or ESPN has locked both players. `complied` is 1
 *     iff the pick started and the alternative did not. When the pair's state
 *     at the moment the call was shown is known (live logging), an unchanged
 *     pair is `no_action`; a changed pair is follow if it complied, else
 *     ignore (basis `lineup_change_since_shown`). A backfilled call has no
 *     shown-time state, so it resolves on the final lineup alone (basis
 *     `final_lineup_only`) and cannot be `no_action`.
 *   - waiver: `league_transactions_raw` (written by
 *     scripts/collect-league-transactions.mjs), executed WAIVER / FREEAGENT
 *     adds to my team in [shown_at, shown_at + WINDOW_DAYS]. Adding the pick
 *     is follow; any other add is ignore; no add is no_action.
 *   - trade: my own TRADE_PROPOSAL (EXECUTE) or TRADE_ACCEPT in the same
 *     window. One that brings any of the idea's `get` players to me is follow;
 *     any other is ignore; none is no_action.
 *
 * A MISSING CAPTURE IS NEVER AN ACTION. With no lineup rows for my team in the
 * period, or no raw transaction table, the row stays open with
 * `unresolved_reason` set, and `followSummary()` counts it by reason.
 *
 * NEAR TIE. `near_tie` (start/sit only) is 1 iff abs(margin) < NEAR_TIE_EPSILON,
 * a constant fixed here before any follow row was resolved, and stored on each
 * row so a later change cannot rewrite what an old row was flagged against.
 */
import crypto from 'node:crypto';
import { db, row, rows } from '../../db/index.js';
import { leagueCurrentWeek } from '../league-week.js';

/**
 * Pre-registered 2026-09-24, before any row resolved: a start/sit pair whose
 * projected gap is under one fantasy point is a near tie. Not fitted.
 */
export const NEAR_TIE_EPSILON = 1.0;
/** Days after a waiver or trade call is shown in which an ESPN move counts as the response. */
export const WINDOW_DAYS = 7;

const ACTIONS = new Set(['start_sit', 'waiver', 'trade']);
const REC_KIND_TO_ACTION = { lineup: 'start_sit', waiver: 'waiver', trade: 'trade' };

const tableExists = name =>
  !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const sha = v => crypto.createHash('sha256').update(canonical(v)).digest('hex');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round4 = v => (v == null ? null : Math.round(v * 1e4) / 1e4);
const sortedIds = list => (list ?? []).map(p => (p && typeof p === 'object' ? p.id : p))
  .filter(v => v != null).map(Number).sort((a, b) => a - b);

/* ------------------------------------------------------------ what was shown */

function decision(lg, rec, { kind, action, pick, alternative, identity, margin, asOf, now, source }) {
  const m = round4(num(margin));
  const nearTie = action === 'start_sit' && m != null ? (Math.abs(m) < NEAR_TIE_EPSILON ? 1 : 0) : null;
  const season = Number(rec.season), week = Number(rec.week);
  return {
    league_id: Number(lg.id), team_id: lg.my_team_id == null ? null : String(lg.my_team_id),
    season, week, kind, action,
    decision_key: sha({ league_id: Number(lg.id), season, week, kind, action, identity }),
    rec_ledger_hash: rec.inputs_hash ?? null, source, shown_at: rec.shown_at ?? now,
    as_of: asOf, pick, alternative, margin: m,
    epsilon: action === 'start_sit' ? NEAR_TIE_EPSILON : null, near_tie: nearTie,
  };
}

/**
 * The decisions a list of shown recommendations (the shape rec-ledger.js
 * `recsFromRoute` emits) implies. Pure: reads nothing, writes nothing. A
 * lineup call is one decision per slot that had a benched alternative.
 */
export function decisionsFromRecs(lg, recs, { now = new Date().toISOString(), source = 'live' } = {}) {
  const out = [];
  for (const rec of recs ?? []) {
    if (!rec || (rec.disposition ?? 'shown') !== 'shown') continue;
    const action = REC_KIND_TO_ACTION[rec.kind];
    if (!action || !(Number(rec.week) >= 1) || !Number.isInteger(Number(rec.season))) continue;
    const pred = rec.predicted ?? {}, base = rec.baseline_call ?? {};
    const common = { kind: action, action, now, source };
    if (action === 'start_sit') {
      const used = new Set();
      for (const alt of base.alternatives ?? []) {
        const i = (pred.starters ?? []).findIndex((s, k) => s.slot === alt.slot && !used.has(k));
        if (i < 0 || alt.id == null) continue;
        used.add(i);
        const s = pred.starters[i];
        const sp = num(s.week_points), ap = num(alt.week_points);
        out.push(decision(lg, rec, { ...common,
          pick: { id: Number(s.id), slot: s.slot }, alternative: { id: Number(alt.id), slot: alt.slot },
          identity: { pick: Number(s.id), alternative: Number(alt.id) },
          margin: sp != null && ap != null ? sp - ap : null,
          asOf: { rec_kind: 'lineup', objective: pred.objective ?? null, slot: s.slot,
            pick_points: sp, alternative_points: ap, lineup_at_shown: null } }));
      }
    } else if (action === 'waiver') {
      const add = pred.add?.id, drop = pred.drop?.id ?? null;
      if (add == null) continue;
      out.push(decision(lg, rec, { ...common,
        pick: { add: Number(add), drop: drop == null ? null : Number(drop), claim_type: pred.claim_type ?? null },
        alternative: base, identity: { add: Number(add), drop, claim_type: pred.claim_type ?? null },
        margin: pred.upgrade,
        asOf: { rec_kind: 'waiver', claim_type: pred.claim_type ?? null, upgrade: num(pred.upgrade),
          projected_ppg: num(pred.add?.projected_ppg), ros_ppg: num(pred.add?.ros_ppg) } }));
    } else {
      const give = sortedIds(pred.give), get = sortedIds(pred.get);
      if (!give.length || !get.length) continue;
      const partner = pred.partner_id == null ? null : String(pred.partner_id);
      out.push(decision(lg, rec, { ...common,
        pick: { partner_id: partner, give, get }, alternative: base,
        identity: { partner, give, get },
        margin: num(pred.horizon_gain) ?? num(pred.ppg_delta),
        asOf: { rec_kind: 'trade', source: pred.source ?? null, ppg_delta: num(pred.ppg_delta),
          horizon_gain: num(pred.horizon_gain), score_signed: num(pred.score_signed) } }));
    }
  }
  return out;
}

/* ------------------------------------------------------------- ESPN reads */

const espnIdOf = id => (id == null ? null : row('SELECT espn_id FROM players WHERE id = ?', Number(id))?.espn_id ?? null);

/** Lineup rows of my team for the period, and a lookup for one local player id. */
function lineupOf(leagueId, teamId, season, week) {
  const list = rows(`SELECT player_id, espn_player_id, is_starter, on_roster, lineup_locked
    FROM league_roster_snapshots
    WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND team_id = ?`,
  leagueId, season, week, Number(teamId));
  const find = id => {
    const espn = espnIdOf(id);
    const r = list.find(x => Number(x.player_id) === Number(id) || (espn != null && Number(x.espn_player_id) === Number(espn)));
    return r ? { started: r.on_roster === 1 && r.is_starter === 1 ? 1 : 0, locked: r.lineup_locked === 1 } : null;
  };
  return { captured: list.length > 0, find };
}

function pairAtShown(lg, d) {
  if (lg.my_team_id == null) return null;
  const lu = lineupOf(d.league_id, lg.my_team_id, d.season, d.week);
  const p = lu.find(d.pick.id), a = lu.find(d.alternative.id);
  return p && a ? { pick_started: p.started, alternative_started: a.started } : null;
}

/* ------------------------------------------------------------------ writers */

function insertDecisions(lg, decisions) {
  const out = { state: 'recorded', inserted: 0, skipped: 0 };
  if (!tableExists('follow_ledger')) {
    return { ...out, state: 'ledger_absent', reason: 'follow_ledger does not exist here; migration 082 has not run' };
  }
  const owned = !db.isTransaction;
  try {
    if (owned) db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare(`INSERT OR IGNORE INTO follow_ledger
      (league_id, team_id, season, week, kind, action, decision_key, rec_ledger_hash, source, shown_at,
       as_of_json, pick_json, alternative_json, margin, epsilon, near_tie)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const d of decisions) {
      if (d.action === 'start_sit' && d.source === 'live') d.as_of.lineup_at_shown = pairAtShown(lg, d);
      const info = insert.run(d.league_id, d.team_id, d.season, d.week, d.kind, d.action, d.decision_key,
        d.rec_ledger_hash, d.source, d.shown_at, JSON.stringify(d.as_of), JSON.stringify(d.pick),
        JSON.stringify(d.alternative), d.margin, d.epsilon, d.near_tie);
      if (Number(info.changes) > 0) out.inserted++; else out.skipped++;
    }
    if (owned) db.exec('COMMIT');
  } catch (e) {
    if (owned && db.isTransaction) db.exec('ROLLBACK');
    console.warn(`[follow-ledger] log failed, recommendation served unlogged: ${e.message}`);
    return { ...out, state: 'error', inserted: 0, reason: e.message };
  }
  return out;
}

/**
 * Log shown recommendations (rec-ledger.js `recsFromRoute` shape). The first
 * showing of a decision wins; a re-render inserts nothing. Never throws: the
 * recommendation is the product, the ledger the measurement.
 */
export function logShown(lg, recs, { now = new Date().toISOString(), source = 'live' } = {}) {
  if (!lg?.id) return { state: 'invalid', inserted: 0, skipped: 0, reason: 'no league' };
  const decisions = decisionsFromRecs(lg, recs, { now, source });
  if (!decisions.length) return { state: 'no_recommendation', inserted: 0, skipped: 0 };
  return insertDecisions(lg, decisions);
}

/**
 * Log one War Room next move. `move` = { season, week, action, pick,
 * alternative, margin, inputs }, where pick/alternative take the shape of the
 * action they stand for: start_sit {id} / {id}; waiver {add, drop}; trade
 * {partner_id, give:[ids], get:[ids]}.
 */
export function logNextMove(lg, move, { now = new Date().toISOString() } = {}) {
  if (!lg?.id || !move || !ACTIONS.has(move.action)) {
    return { state: 'invalid', inserted: 0, skipped: 0, reason: `action must be one of ${[...ACTIONS].join(', ')}` };
  }
  if (!(Number(move.week) >= 1) || !Number.isInteger(Number(move.season)) || !move.pick) {
    return { state: 'invalid', inserted: 0, skipped: 0, reason: 'a next move needs season, week and a pick' };
  }
  const d = decision(lg, move, {
    kind: 'next_move', action: move.action, pick: move.pick, alternative: move.alternative ?? null,
    identity: { pick: move.pick, alternative: move.alternative ?? null }, margin: move.margin,
    asOf: { rec_kind: 'next_move', inputs: move.inputs ?? null, lineup_at_shown: null }, now, source: 'live',
  });
  return insertDecisions(lg, [d]);
}

/**
 * Every shown call rec_ledger froze, as follow rows (source 'backfill',
 * shown_at = rec_ledger.made_at). One rec per (league, kind, inputs_hash): a
 * rec_ledger call is one row per grading horizon.
 */
export function backfillFromRecLedger({ leagueId = null, season = null } = {}) {
  const out = { state: 'recorded', inserted: 0, skipped: 0 };
  if (!tableExists('rec_ledger')) return { ...out, state: 'rec_ledger_absent' };
  const recs = rows(`SELECT league_id, kind, season, week, inputs_hash, MIN(made_at) AS made_at,
      predicted_json, baseline_call_json
    FROM rec_ledger
    WHERE disposition = 'shown' AND kind IN ('lineup', 'waiver', 'trade')
      AND (? IS NULL OR league_id = ?) AND (? IS NULL OR season = ?)
    GROUP BY league_id, kind, inputs_hash ORDER BY league_id, made_at`,
  leagueId, leagueId, season, season);
  const byLeague = new Map();
  for (const r of recs) {
    if (!byLeague.has(r.league_id)) byLeague.set(r.league_id, []);
    byLeague.get(r.league_id).push({
      league_id: r.league_id, kind: r.kind, season: r.season, week: r.week, inputs_hash: r.inputs_hash,
      shown_at: r.made_at, predicted: JSON.parse(r.predicted_json),
      baseline_call: r.baseline_call_json ? JSON.parse(r.baseline_call_json) : null,
    });
  }
  for (const [id, list] of byLeague) {
    const lg = row('SELECT id, my_team_id FROM leagues WHERE id = ?', id);
    if (!lg) continue;
    const res = logShown(lg, list, { source: 'backfill' });
    if (res.state === 'error') return { ...out, state: 'error', reason: res.reason };
    out.inserted += res.inserted; out.skipped += res.skipped;
  }
  return out;
}

/* ----------------------------------------------------------------- resolver */

function weekIsOver(lg, season, week) {
  if (Number(lg.season) > season) return true;
  return Number(lg.season) === season && leagueCurrentWeek(lg) > week;
}

function resolveStartSit(lg, r, asOf) {
  const lu = lineupOf(r.league_id, lg.my_team_id, r.season, r.week);
  const pick = JSON.parse(r.pick_json), alt = JSON.parse(r.alternative_json);
  const p = lu.find(pick?.id), a = lu.find(alt?.id);
  const over = weekIsOver(lg, r.season, r.week);
  const bothLocked = !!(p?.locked && a?.locked);
  if (!over && !bothLocked) return null;
  if (!lu.captured) return { reason: 'no_lineup_capture' };
  const ps = p?.started ?? 0, as = a?.started ?? 0;
  const complied = ps === 1 && as === 0 ? 1 : 0;
  const shown = asOf.lineup_at_shown;
  const matched = { pick_started: ps, alternative_started: as, week_over: over, both_locked: bothLocked };
  if (shown) {
    const changed = ps !== shown.pick_started || as !== shown.alternative_started;
    return { outcome: !changed ? 'no_action' : complied ? 'follow' : 'ignore', complied,
      basis: 'lineup_change_since_shown', matched };
  }
  return { outcome: complied ? 'follow' : 'ignore', complied, basis: 'final_lineup_only', matched };
}

/** A raw row's items, or an error. Corrupt JSON is a reason, never an empty list. */
function itemsOf(t) {
  try {
    const v = JSON.parse(t.items_json || '[]');
    return Array.isArray(v) ? { items: v } : { error: `tx ${t.tx_id} items_json is not a list` };
  } catch (e) { return { error: `tx ${t.tx_id} items_json is not valid JSON (${e.message})` }; }
}

function windowTxs(r, now) {
  const end = new Date(Date.parse(r.shown_at) + WINDOW_DAYS * 86400000).toISOString();
  if (now <= end) return { open: true };
  if (!tableExists('league_transactions_raw')) return { reason: 'no_transaction_capture' };
  return { txs: rows(`SELECT tx_id, type, status, execution_type, team_id, related_tx_id, items_json,
      COALESCE(processed_at, proposed_at) AS at
    FROM league_transactions_raw
    WHERE league_id = ? AND season = ? AND COALESCE(processed_at, proposed_at) >= ?
      AND COALESCE(processed_at, proposed_at) <= ?
    ORDER BY at, tx_id`, r.league_id, r.season, r.shown_at, end) };
}

function resolveWaiver(lg, r, now) {
  const w = windowTxs(r, now);
  if (w.open) return null;
  if (w.reason) return { reason: w.reason };
  const pick = JSON.parse(r.pick_json);
  const espn = espnIdOf(pick?.add);
  if (espn == null) return { reason: 'no_espn_id' };
  const me = String(lg.my_team_id);
  const adds = [];
  for (const t of w.txs) {
    if (!['WAIVER', 'FREEAGENT'].includes(t.type) || t.status !== 'EXECUTED') continue;
    const it = itemsOf(t);
    if (it.error) return { reason: 'unreadable_transaction', detail: it.error };
    for (const i of it.items) {
      if (i?.type === 'ADD' && String(i.toTeamId) === me) adds.push({ tx_id: t.tx_id, at: t.at, espn_id: i.playerId });
    }
  }
  const hit = adds.find(x => Number(x.espn_id) === Number(espn));
  return { outcome: hit ? 'follow' : adds.length ? 'ignore' : 'no_action', complied: hit ? 1 : 0,
    basis: `espn_adds_within_${WINDOW_DAYS}d`, matched: { adds } };
}

function resolveTrade(lg, r, now) {
  const w = windowTxs(r, now);
  if (w.open) return null;
  if (w.reason) return { reason: w.reason };
  const pick = JSON.parse(r.pick_json);
  const wanted = new Set();
  for (const id of pick?.get ?? []) {
    const e = espnIdOf(id);
    if (e == null) return { reason: 'no_espn_id' };
    wanted.add(Number(e));
  }
  const me = String(lg.my_team_id);
  const byId = new Map(w.txs.map(t => [t.tx_id, t]));
  const moves = [];
  for (const t of w.txs) {
    const mineProposal = t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE';
    if (!(mineProposal || t.type === 'TRADE_ACCEPT') || String(t.team_id) !== me) continue;
    let it = itemsOf(t);
    if (!it.error && !it.items.length && t.related_tx_id) {
      const rel = byId.get(t.related_tx_id)
        ?? row('SELECT tx_id, items_json FROM league_transactions_raw WHERE league_id = ? AND season = ? AND tx_id = ?',
          r.league_id, r.season, t.related_tx_id);
      if (rel) it = itemsOf(rel);
    }
    if (it.error) return { reason: 'unreadable_transaction', detail: it.error };
    const toMe = it.items.filter(i => String(i?.toTeamId) === me).map(i => Number(i.playerId));
    moves.push({ tx_id: t.tx_id, type: t.type, at: t.at, to_me: toMe });
  }
  const hit = moves.find(m => m.to_me.some(id => wanted.has(id)));
  return { outcome: hit ? 'follow' : moves.length ? 'ignore' : 'no_action', complied: hit ? 1 : 0,
    basis: `espn_trade_actions_within_${WINDOW_DAYS}d`, matched: { moves } };
}

/**
 * Resolve every open row whose window has closed. A resolved row is never
 * touched again, so re-running is a no-op on it. Open rows whose evidence is
 * missing get `unresolved_reason` and stay open, so a late capture can still
 * resolve them.
 */
export function resolveDue({ now = new Date().toISOString(), leagueId = null } = {}) {
  const out = { state: 'resolved', resolved: 0, open: 0, unresolved: 0 };
  if (!tableExists('follow_ledger')) return { ...out, state: 'ledger_absent' };
  const open = rows(`SELECT * FROM follow_ledger WHERE outcome IS NULL AND (? IS NULL OR league_id = ?) ORDER BY id`,
    leagueId, leagueId);
  const leagues = new Map();
  const done = db.prepare(`UPDATE follow_ledger SET outcome = ?, complied = ?, basis = ?, matched_json = ?,
    resolved_at = ?, unresolved_reason = NULL WHERE id = ? AND outcome IS NULL`);
  const stuck = db.prepare('UPDATE follow_ledger SET unresolved_reason = ? WHERE id = ? AND outcome IS NULL');
  for (const r of open) {
    if (!leagues.has(r.league_id)) leagues.set(r.league_id, row('SELECT * FROM leagues WHERE id = ?', r.league_id));
    const lg = leagues.get(r.league_id);
    let res;
    if (!lg) res = { reason: 'league_missing' };
    else if (lg.my_team_id == null) res = { reason: 'no_my_team' };
    else if (r.action === 'start_sit') res = resolveStartSit(lg, r, JSON.parse(r.as_of_json));
    else if (r.action === 'waiver') res = resolveWaiver(lg, r, now);
    else res = resolveTrade(lg, r, now);
    if (!res) { out.open++; continue; }
    if (res.reason) {
      if (res.detail) console.warn(`[follow-ledger] row ${r.id} unresolved: ${res.detail}`);
      stuck.run(res.reason, r.id); out.unresolved++; continue;
    }
    done.run(res.outcome, res.complied, res.basis, JSON.stringify(res.matched), now, r.id);
    out.resolved++;
  }
  return out;
}

/** The scheduler entry: backfill anything rec_ledger holds that this ledger does not, then resolve. */
export function syncFollowLedger({ now = new Date().toISOString() } = {}) {
  const backfill = backfillFromRecLedger();
  const resolve = resolveDue({ now });
  return { backfill, resolve };
}

/** Counts per league: outcomes, near ties, open rows and why the stuck ones are stuck. */
export function followSummary(leagueId) {
  if (!tableExists('follow_ledger')) return { state: 'ledger_absent', outcomes: {}, unresolved: {}, open: 0 };
  const outcomes = {}, unresolved = {}, byKind = {};
  let open = 0, nearTies = 0;
  for (const r of rows(`SELECT kind, outcome, near_tie, unresolved_reason, COUNT(*) AS n FROM follow_ledger
      WHERE league_id = ? GROUP BY kind, outcome, near_tie, unresolved_reason`, leagueId)) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    if (r.near_tie === 1) nearTies += r.n;
    if (r.outcome) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + r.n;
    else if (r.unresolved_reason) unresolved[r.unresolved_reason] = (unresolved[r.unresolved_reason] ?? 0) + r.n;
    else open += r.n;
  }
  return { state: 'ok', by_kind: byKind, outcomes, near_ties: nearTies, open, unresolved };
}
