/**
 * FIX-07: War Room requests (migration 076) -> the producer's objective and skips.
 *
 * The WR-3 route records each input Nick gives in `warroom_requests` and
 * nothing else. The producer reads them here, per league:
 *
 *   - OBJECTIVE STATE is the fold of every non-retracted request, oldest first,
 *     consumed or not: the latest objective.set / target.approve sets the goal,
 *     the latest mode.set the risk mode, each tolerance.set its slider, stop.add
 *     and stop.remove the stops. So a goal set once holds until Nick changes it,
 *     and a run that fails does not forget it.
 *   - SKIPS come from every non-retracted deck.skip, weighted as partners.js
 *     #skipWeights weights the skips file ("not now" still fades after a week).
 *   - PENDING = rows with consumed_at IS NULL. The producer stamps consumed_at on
 *     exactly these, in the same transaction as the plans write
 *     (scripts/campaign/produce-plans.mjs#commitRun).
 *
 * Ignored, and said so in `ignored`: a retracted request (a `retract` row names
 * it), a Coach plan change without confirmed = 1 (the route already refuses
 * those; a row written around it is still not followed), and a row whose
 * payload does not parse.
 *
 * `objectives.json` and `skips.jsonl` stay as CLI-only test inputs: a request
 * overrides the file's value for the same key.
 */
import { db, rows, run } from '../../db/index.js';
import { PLAN_REQUESTS } from '../warroom-actions/schema.js';
import { normaliseObjective } from './objectives.js';
import { skipWeights } from './partners.js';
import { ajState } from './aj-pick.js';
import { protectState } from './protected-upgrade.js';

/** Deck-skip reasons: #230's ids and the shared ones (FIX-06 renames #230's to the shared set). */
const SKIP_REASON = Object.freeze({
  player: 'player', cost: 'cost', manager: 'manager', not_now: 'not_now',
  dont_like_player: 'player', costs_too_much: 'cost', dont_trust_manager: 'manager',
});

/**
 * Who a skip down-weights. A hand-set mapping, not fitted: "the player" and
 * "costs too much" are about what the card gets; "the manager" and "not now"
 * (and no reason) are about who it is with.
 */
const SKIPS_PLAYERS = new Set(['player', 'cost']);

const parse = text => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/** Objective-file kinds from a request goal (objectives.js#OBJECTIVE_KINDS). */
function goalFields(p) {
  if (p.goal === 'get_player') return { kind: 'player', target: String(p.player_id) };
  if (p.goal === 'points') return { kind: 'points', points_per_week: p.points_per_week };
  return { kind: p.goal, goal: p.goal };
}

/**
 * Pure fold. rows: warroom_requests rows for ONE league, any order.
 * base: that league's objectives-file row (or {}).
 * Returns { objective (raw, for normaliseObjective), skips (skipWeights rows),
 *   sent (pending "I sent it" steps for campaign_steps), pending (ids to stamp),
 *   used (ids folded), ignored [{ id, why }], from_requests }.
 */
export function foldRequests(list, { base = {}, leagueId } = {}) {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  const ignored = [];
  const parsed = new Map();
  for (const r of sorted) {
    const p = parse(r.payload);
    if (!p.ok) { ignored.push({ id: r.id, why: 'payload does not parse' }); continue; }
    parsed.set(r.id, p.value);
  }
  const retracted = new Set(sorted.filter(r => r.kind === 'retract' && parsed.has(r.id))
    .map(r => Number(parsed.get(r.id).request_id)));
  const objective = { ...base, tolerances: { ...(base.tolerances ?? {}) }, stops: [...(base.stops ?? [])],
    untouchables: [...(base.untouchables ?? [])] };
  const skips = [];
  const sent = [];
  const used = [];
  let version = Number.isInteger(base.version) ? base.version : 0;
  for (const r of sorted) {
    if (!parsed.has(r.id) || r.kind === 'retract') continue;
    if (retracted.has(r.id)) { ignored.push({ id: r.id, why: 'retracted' }); continue; }
    if (r.source === 'coach' && PLAN_REQUESTS.includes(r.kind) && Number(r.confirmed) !== 1) {
      ignored.push({ id: r.id, why: 'Coach plan change not confirmed by Nick' }); continue;
    }
    const p = parsed.get(r.id);
    switch (r.kind) {
      case 'objective.set':
        delete objective.target; delete objective.points_per_week;
        Object.assign(objective, goalFields(p));
        if (p.goal === 'title' || p.goal === 'playoffs') objective.goal = p.goal;
        objective.arrive_by = p.arrive_by ?? null;
        break;
      case 'target.approve':
        delete objective.points_per_week;
        Object.assign(objective, { kind: 'player', target: String(p.player_id) });
        break;
      case 'mode.set':
        objective.risk_mode = p.mode;
        objective.risk_until_week = p.until_week ?? null; // objectives.js#normaliseObjective's key (FIX-03)
        break;
      case 'tolerance.set':
        // The slider says points of title odds (schema.js: 0-100); the planner works in 0-1.
        objective.tolerances[p.key] = p.key === 'max_downside_per_step' ? p.value / 100 : p.value;
        break;
      case 'stop.add': {
        const s = p.stop ?? {};
        const stop = { id: `req-${r.id}`, kind: s.kind, label: s.label, week: s.week ?? undefined,
          player: s.player_id ?? undefined, added_by: r.source === 'coach' ? 'coach' : 'nick' };
        if (s.kind === 'untouchable' && s.player_id != null) objective.untouchables.push(String(s.player_id));
        else objective.stops.push(stop);
        break;
      }
      case 'stop.remove': {
        const before = objective.stops.length;
        objective.stops = objective.stops.filter((st, j) => (st.id ?? `nick-${j}`) !== p.stop_id);
        if (objective.stops.length === before) { ignored.push({ id: r.id, why: `no stop ${p.stop_id} to remove` }); continue; }
        break;
      }
      case 'deck.skip': {
        const reason = SKIP_REASON[p.reason] ?? 'other';
        const card = p.card;
        if (!card) { ignored.push({ id: r.id, why: 'skipped card was not in the plans file' }); continue; }
        if (SKIPS_PLAYERS.has(reason)) {
          for (const player of card.get ?? []) skips.push({ league: leagueId, player, reason, at: r.created_at });
        } else skips.push({ league: leagueId, manager: card.partner, reason, at: r.created_at });
        break;
      }
      case 'offer.sent':
        // Graded through trade_outcomes (the store wrote it); E5 gets the step's predicted gain.
        if (r.consumed_at == null && p.card && Number.isFinite(p.card.title_odds_delta) && p.trade_outcome?.id != null) {
          sent.push({ move_id: p.move_id, step_index: p.step_index ?? 0, trade_outcome_id: p.trade_outcome.id,
            predicted: p.card.title_odds_delta, se: Number.isFinite(p.card.title_odds_delta_se) ? p.card.title_odds_delta_se : null });
        }
        continue;
      default:
        continue; // offer.reply: settled from ESPN by trade-outcomes.js, not folded here
    }
    if (PLAN_REQUESTS.includes(r.kind)) version = Math.max(version, r.id);
    used.push(r.id);
  }
  return {
    objective: { ...objective, version }, skips, sent, used, ignored,
    pending: sorted.filter(r => r.consumed_at == null).map(r => r.id),
    from_requests: used.some(id => PLAN_REQUESTS.includes(sorted.find(r => r.id === id)?.kind)),
  };
}

const hasTable = name => rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

/**
 * Read one league's requests and fold them. With no `warroom_requests` table
 * (076 not run here) the file inputs stand alone and `status` says so.
 */
export function leagueRequests(leagueId, { base = {} } = {}) {
  if (!hasTable('warroom_requests')) {
    return { status: 'absent', reason: 'warroom_requests does not exist here (migration 076 has not run)',
      ...foldRequests([], { base, leagueId }) };
  }
  const list = rows('SELECT * FROM warroom_requests WHERE league_id = ? ORDER BY id', leagueId);
  return { status: 'ok', ...foldRequests(list, { base, leagueId }) };
}

/**
 * Stamp consumed_at on the pending ids, write each consumed "I sent it" step's
 * predicted gain to `campaign_steps` (083; E5's evidence, INSERT OR IGNORE on
 * its identity), then run `write` (the plans file write), in one transaction:
 * if the write throws, nothing is stamped and the requests are read again next
 * run. consumed: [{ leagueId, pending: ids, sent: fold.sent }]. Returns counts.
 */
export function consumeWith(consumed, write, { at = new Date().toISOString() } = {}) {
  const steps = hasTable('campaign_steps');
  db.exec('BEGIN IMMEDIATE');
  try {
    const n = { consumed: 0, campaign_steps: 0, campaign_steps_skipped: steps ? 0 : 'table absent (083 not run)' };
    for (const c of consumed) {
      for (const id of c.pending) {
        n.consumed += Number(run('UPDATE warroom_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', at, id).changes);
      }
      if (!steps) continue;
      for (const s of c.sent ?? []) {
        n.campaign_steps += Number(run(`INSERT OR IGNORE INTO campaign_steps
          (league_id, move_id, step_index, trade_outcome_id, predicted_title_odds_gain, predicted_se, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, c.leagueId, s.move_id, s.step_index, s.trade_outcome_id, s.predicted, s.se, at).changes);
      }
    }
    write();
    db.exec('COMMIT');
    return n;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Everything the producer plans one league with. objectiveRow: the league's
 * objectives-file row (CLI/test input); fileSkips: skips.jsonl rows (same).
 * Returns { objective (normalised), weights (skipWeights), consume ({ leagueId,
 * pending, sent } for consumeWith), summary (for the entry's `inputs`) }.
 */
export function leagueInputs(leagueId, { objectiveRow = null, fileSkips = [], now = Date.now() } = {}) {
  const reqs = leagueRequests(leagueId, { base: objectiveRow ?? {} });
  const objective = normaliseObjective(reqs.objective, { leagueGoal: reqs.objective.goal ?? 'title' });
  objective.source = reqs.from_requests ? 'warroom_requests' : objectiveRow ? 'objectives_file' : 'default';
  // AJ-PICK: the one fold of aj.allow / aj.revoke / aj.confirm (aj-pick.js); the rows are stamped with the rest.
  const aj = ajState({ rows }, leagueId);
  // PROTECTED-UPGRADE: Nick's Locked / Blue chips only setting for 160 / 80 (protected-upgrade.js).
  const prot = protectState({ rows }, leagueId);
  return {
    objective, aj: { allow: aj.allow, confirmed: aj.confirmed }, protect: { upgrade: prot.upgrade, modes: prot.modes },
    weights: skipWeights([...fileSkips, ...reqs.skips], leagueId, now),
    consume: { leagueId, pending: reqs.pending, sent: reqs.sent },
    summary: { status: reqs.status, reason: reqs.reason ?? null, pending: reqs.pending.length, folded: reqs.used.length,
      skips: reqs.skips.length, ignored: reqs.ignored, aj_pick: { status: aj.status, picks: aj.allow.size, confirmed: aj.confirmed.size },
      protected_upgrade: { status: prot.status, upgrade: [...prot.upgrade] } },
  };
}
