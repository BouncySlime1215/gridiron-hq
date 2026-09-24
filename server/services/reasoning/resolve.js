/**
 * REASON-02 resolver: settle every open reasoning claim against what happened.
 * Run offline (scripts/reasoning/grade-claims.mjs), never on a request.
 *
 * A claim settles `true` or `false` only on evidence it names; a claim whose
 * test never happened (the offer was never answered, no roster data arrived)
 * settles `void` after its window plus GRACE_DAYS, and void never counts in
 * the C8 share. Until then it stays open. Each rule is versioned in
 * claims.js RULES; a change of rule is a new version, not an edit.
 *
 * offer_reply_v1 (counter_with) — trade_outcomes (067): the first offer to his
 *   team for this card (idea_id = card id, or the same players either way
 *   round) made at or after the claim, answered accepted/declined/countered.
 *   True when the answer is the predicted reply and, when the claim named a
 *   position and the counter's positions are known, that position is in them.
 *   The counter's positions come from counter_json as #239 writes it
 *   (trade-outcomes.js settleSentOffers: { tx_id, items } with the counter
 *   proposal's raw ESPN items): the players on HIS receive side (toTeamId =
 *   the counterparty), placed through players.espn_id -> players.position.
 *   The players table holds one current position per player and no history,
 *   so the position is today's, not the one at the counter's time; the
 *   evidence says so. Positions count as known only when every asked player
 *   is placed; otherwise the position is left unchecked and the ids named.
 * acquires_position_v1 (wants_position) — league_roster_snapshots (058): a
 *   player at the position first seen on his roster inside the window who was
 *   not on it before the claim. False only when snapshots reach past the
 *   deadline without one.
 * news_material_v1 (check_first) — league_roster_snapshots final rows for the
 *   card players the news touched, from the scoring period current at the
 *   claim, finalised after it (a row turns live -> final in place, so
 *   changed_at, not first_seen_at, dates the final): material when he was out (MATERIAL_STATUSES) or scored under
 *   MATERIAL_SHARE of his projection. True when any player's was material.
 */
export const GRACE_DAYS = 14;
export const MATERIAL_STATUSES = Object.freeze(['OUT', 'INJURY_RESERVE', 'SUSPENSION', 'DOUBTFUL']);
export const MATERIAL_SHARE = 0.5;

const REPLY_STATUS = Object.freeze({ accept: 'accepted', decline: 'declined', counter: 'countered' });
const ANSWERED = new Set(Object.values(REPLY_STATUS));
const DAY = 86400000;

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const idNum = v => (/^\d+$/.test(String(v)) ? Number(v) : v);

/** JSON from a ledger cell; an unreadable cell is reported, not read as empty. */
function parse(json, fallback, unreadable) {
  if (json == null) return fallback;
  try {
    return JSON.parse(json);
  } catch (e) {
    unreadable.push(String(e.message).slice(0, 120));
    return fallback;
  }
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

function waitOrVoid(claim, now, why, extra = {}) {
  const graceEnd = Date.parse(claim.resolve_by) + GRACE_DAYS * DAY;
  return now.getTime() >= graceEnd ? { status: 'void', evidence: { why, ...extra } } : null;
}

export const POSITION_SOURCE = 'players.position (current only; the players table has no position history)';

/**
 * The positions he asked for in a #239 counter: players moving to him
 * (toTeamId = counterparty), resolved by ESPN id. Asked ids and unresolved ids
 * are always reported; `positions` is null unless every one was placed.
 */
function askedPositions(db, counter, counterparty) {
  const items = Array.isArray(counter?.items) ? counter.items : null;
  if (!items) return { ids: null, positions: null, unresolved: null, source: 'counter_json carries no items' };
  const ids = [...new Set(items.filter(i => i && String(i.toTeamId) === String(counterparty) && i.playerId != null)
    .map(i => String(i.playerId)))].sort();
  if (!ids.length) return { ids, positions: null, unresolved: [], source: 'the counter asks for no player' };
  if (!hasTable(db, 'players')) return { ids, positions: null, unresolved: ids, source: 'no players table to place the asked players' };
  const lookup = db.prepare('SELECT UPPER(position) pos FROM players WHERE espn_id = ? AND position IS NOT NULL ORDER BY id LIMIT 1');
  const found = new Set();
  const unresolved = [];
  for (const id of ids) {
    const r = lookup.get(idNum(id));
    if (r?.pos) found.add(r.pos); else unresolved.push(id);
  }
  return { ids, positions: unresolved.length ? null : [...found].sort(), unresolved, source: POSITION_SOURCE };
}

function offerReply(db, claim, pred, now) {
  const late = now.getTime() >= Date.parse(claim.resolve_by);
  if (!hasTable(db, 'trade_outcomes')) return late ? { status: 'void', evidence: { why: 'no_offer_ledger' } } : null;
  const rows = db.prepare(`SELECT id, status, counter_json, counterparty_team_id, give_json, get_json, idea_id, proposed_at
    FROM trade_outcomes WHERE league_id = ? AND counterparty_team_id = ? AND proposed_at >= ?
    ORDER BY proposed_at, id`).all(claim.league_id, pred.partner_team, claim.made_at);
  const unreadable = [];
  const give = pred.card_players.give;
  const get = pred.card_players.get;
  const mine = rows.filter(r => {
    if (r.idea_id != null && String(r.idea_id) === claim.card_id) return true;
    const g = parse(r.give_json, [], unreadable).map(String);
    const t = parse(r.get_json, [], unreadable).map(String);
    return (sameSet(g, give) && sameSet(t, get)) || (sameSet(g, get) && sameSet(t, give));
  });
  const answered = mine.find(r => ANSWERED.has(r.status));
  if (!answered) return late ? { status: 'void', evidence: { why: 'offer_never_answered', offers_matched: mine.length, unreadable_cells: unreadable.length } } : null;
  const counter = parse(answered.counter_json, null, unreadable);
  const ask = answered.status === 'countered'
    ? askedPositions(db, counter, answered.counterparty_team_id ?? pred.partner_team)
    : { ids: null, positions: null, unresolved: null, source: null };
  const asked = ask.positions;
  const replyOk = answered.status === REPLY_STATUS[pred.reply];
  const posChecked = replyOk && pred.reply === 'counter' && pred.pos != null && asked != null;
  const posOk = !posChecked || asked.includes(pred.pos.toUpperCase());
  return {
    status: replyOk && posOk ? 'true' : 'false',
    evidence: { trade_outcome_id: answered.id, outcome_status: answered.status, predicted: pred.reply,
      predicted_pos: pred.pos ?? null, pos_checked: posChecked, asked_positions: asked,
      asked_player_ids: ask.ids, unresolved_player_ids: ask.unresolved, position_source: ask.source,
      unreadable_cells: unreadable.length }
  };
}

function acquiresPosition(db, claim, pred, now) {
  if (!hasTable(db, 'league_roster_snapshots')) return waitOrVoid(claim, now, 'no_roster_data');
  const team = idNum(pred.team);
  const before = new Set(db.prepare(`SELECT DISTINCT espn_player_id id FROM league_roster_snapshots
    WHERE league_id = ? AND team_id = ? AND first_seen_at <= ?`).all(claim.league_id, team, claim.made_at).map(r => r.id));
  const added = db.prepare(`SELECT DISTINCT espn_player_id id FROM league_roster_snapshots
    WHERE league_id = ? AND team_id = ? AND UPPER(position) = ? AND first_seen_at > ? AND first_seen_at <= ?
    ORDER BY first_seen_at`).all(claim.league_id, team, pred.pos.toUpperCase(), claim.made_at, claim.resolve_by)
    .map(r => r.id).filter(id => !before.has(id));
  if (added.length) return { status: 'true', evidence: { added } };
  if (now.getTime() < Date.parse(claim.resolve_by)) return null;
  const through = db.prepare(`SELECT MAX(first_seen_at) t FROM league_roster_snapshots
    WHERE league_id = ? AND team_id = ?`).get(claim.league_id, team)?.t;
  if (through && through >= claim.resolve_by) return { status: 'false', evidence: { added: [], observed_through: through } };
  return waitOrVoid(claim, now, 'no_roster_data');
}

function newsMaterial(db, claim, pred, now) {
  if (!hasTable(db, 'league_roster_snapshots')) return waitOrVoid(claim, now, 'no_final_rows');
  // The period in play at the claim: the latest one any roster row existed for.
  const current = db.prepare(`SELECT MAX(scoring_period_id) p FROM league_roster_snapshots
    WHERE league_id = ? AND first_seen_at <= ?`).get(claim.league_id, claim.made_at)?.p ?? 0;
  const players = pred.player_ids.map(pid => {
    const r = db.prepare(`SELECT scoring_period_id, pregame_injury_status, injury_status, projected_points, actual_points
      FROM league_roster_snapshots WHERE league_id = ? AND (espn_player_id = ? OR player_id = ?)
        AND source = 'final' AND scoring_period_id >= ? AND changed_at > ?
      ORDER BY scoring_period_id LIMIT 1`).get(claim.league_id, idNum(pid), idNum(pid), current, claim.made_at);
    if (!r) return { player_id: pid, material: null };
    const status = String(r.pregame_injury_status ?? r.injury_status ?? '').toUpperCase();
    const out = MATERIAL_STATUSES.includes(status);
    const short = r.actual_points != null && r.projected_points > 0 && r.actual_points < MATERIAL_SHARE * r.projected_points;
    const known = out || r.actual_points != null;
    return { player_id: pid, period: r.scoring_period_id, status: status || null,
      projected: r.projected_points, actual: r.actual_points, material: known ? out || short : null };
  });
  if (players.some(p => p.material === true)) return { status: 'true', evidence: { players } };
  if (players.every(p => p.material === false)) return { status: 'false', evidence: { players } };
  return waitOrVoid(claim, now, 'no_final_rows', { players });
}

const RULE_FNS = Object.freeze({
  offer_reply_v1: offerReply,
  acquires_position_v1: acquiresPosition,
  news_material_v1: newsMaterial
});

/** Settle what can be settled. Returns counts by outcome, plus what stays open. */
export function resolveOpenClaims(database, { now = new Date(), leagueId = null } = {}) {
  const open = database.prepare(`SELECT id, league_id, card_id, made_at, resolve_rule, resolve_by, prediction_json
    FROM reasoning_claims WHERE status = 'open' AND (? IS NULL OR league_id = ?) ORDER BY id`)
    .all(leagueId, leagueId);
  const upd = database.prepare(`UPDATE reasoning_claims SET status = ?, resolved_at = ?, evidence_json = ?
    WHERE id = ? AND status = 'open'`);
  const counts = { true: 0, false: 0, void: 0, open: 0 };
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const claim of open) {
      const fn = RULE_FNS[claim.resolve_rule];
      if (!fn) throw new Error(`reasoning claim ${claim.id} has unknown resolve rule ${claim.resolve_rule}`);
      const verdict = fn(database, claim, JSON.parse(claim.prediction_json), now);
      if (!verdict) { counts.open += 1; continue; }
      upd.run(verdict.status, now.toISOString(), JSON.stringify({ rule: claim.resolve_rule, ...verdict.evidence }), claim.id);
      counts[verdict.status] += 1;
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return counts;
}
