/**
 * COACH-PRELOAD: the context every model turn starts with, so Coach answers
 * instead of spending its rounds finding the tables.
 *
 * Measured 2026-09-25: a live turn spent 4-5 of its rounds on catalog_lookup
 * and exploratory SQL, then refused. Everything Coach is usually asked about
 * is already served somewhere; this bundle puts it in front of the model,
 * recorded in the turn's ledger, so each number carries a cite verify.js
 * accepts (rN#i.column). Nothing here computes a number: every cell is a
 * served value (plans.json, the roster snapshot, the weekly prediction
 * snapshot, Nick's rule constants) or null with the reason.
 *
 *   plan_summary     goal, risk mode, title odds now (+/- SE), the planned title
 *                    odds, eta; the next move or the producer's reason there is none
 *   plan_moves       the next move and the deck: partner, gives, gets, title-odds
 *                    change +/- SE, P(yes) with its basis, expected, P(complete)
 *   plan_targets     the top targets: owner, gain if landed +/- SE, P(reach)
 *   my_roster        Nick's roster from the latest snapshot: slot, starter,
 *                    ESPN projection, the app's prediction and its 80% floor/ceiling
 *   partner_focus    the partner in focus: his read (P(responds), roster holes,
 *                    offers logged), the his-side line, P(yes) and its basis, and
 *                    his reply history on War Room records
 *   nick_rules       never-give / never-get ids, the overpay cap, the depth premium
 *                    and the blue-chip floor
 *
 * The bundle is recorded under the `plan_read` brain tool, so a label that
 * carries a digit ("P21 (WR)") names, not claims (verify.js's brain-tool rule).
 */
import { rows, row } from '../../db/index.js';
import { readPlansFile, leagueEntry } from './brief.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from '../campaign/never-give.js';
import { DEPTH_PREMIUM_MAX, BLUE_CHIP_SCORE } from '../campaign/search.js';
import { teamOf } from './brief-claims.js';

const ok = f => f?.status === 'ok';
const val = f => (ok(f) ? f.value : null);
const se = f => (ok(f) && typeof f.se === 'number' ? f.se : null);
const MAX_MOVES = 4;
const MAX_TARGETS = 5;
const MAX_ROSTER = 20;

const tableIn = name => !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

function namesFor(entry, ids) {
  const names = entry?.names ?? {};
  return ids.map(id => names[id] ?? row('SELECT name FROM players WHERE id = ?', Number(id))?.name ?? `player ${id}`).join(' + ');
}

function moveRow(entry, m, i) {
  const s = m.steps?.[0] ?? {};
  return {
    card: i + 1, move_id: String(m.move_id), partner: String(s.partner ?? ''), partner_label: teamOf(entry, s.partner),
    steps: m.steps?.length ?? 0, give: namesFor(entry, s.give ?? []), get: namesFor(entry, s.get ?? []),
    title_odds_change: val(s.title_odds_delta), title_odds_change_se: se(s.title_odds_delta),
    clears_noise: s.title_odds_delta?.clears_2se === true, title_after: val(s.title_after),
    p_yes: val(s.p_yes), p_yes_is_guess: s.p_yes?.guess === true,
    expected: val(m.expected), expected_se: se(m.expected), p_complete: val(m.p_complete)
  };
}

/** The latest roster snapshot of Nick's team, with the app's weekly prediction beside ESPN's. */
function myRoster(leagueId) {
  const lg = row('SELECT season, my_team_id FROM leagues WHERE id = ?', leagueId);
  if (!lg?.my_team_id || !tableIn('league_roster_snapshots')) return { rows: [], reason: 'no roster snapshot for this league' };
  const period = row(`SELECT MAX(scoring_period_id) AS p FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND team_id = ?`,
    leagueId, lg.season, Number(lg.my_team_id))?.p;
  if (period == null) return { rows: [], reason: 'no roster snapshot for your team yet' };
  const pred = tableIn('weekly_prediction_snapshots');
  const out = rows(`SELECT r.player_id, r.player_name, r.position, r.lineup_slot, r.is_starter, r.injury_status, r.projected_points
                    FROM league_roster_snapshots r
                    WHERE r.league_id = ? AND r.season = ? AND r.team_id = ? AND r.scoring_period_id = ?
                    ORDER BY r.is_starter DESC, r.projected_points DESC LIMIT ?`,
  leagueId, lg.season, Number(lg.my_team_id), period, MAX_ROSTER).map(r => {
    const p = pred && r.player_id != null
      ? row(`SELECT week, prediction, lower_80, upper_80 FROM weekly_prediction_snapshots WHERE season = ? AND player_id = ? ORDER BY week DESC LIMIT 1`,
        lg.season, r.player_id) : null;
    return { week: period, player: r.player_name, position: r.position, slot: r.lineup_slot, starter: r.is_starter === 1,
      injury: r.injury_status ?? null, espn_projection: r.projected_points ?? null,
      prediction: p?.prediction ?? null, floor_80: p?.lower_80 ?? null, ceiling_80: p?.upper_80 ?? null, prediction_week: p?.week ?? null };
  });
  return { rows: out, reason: out.length ? null : 'the roster snapshot is empty' };
}

/** Nick's War Room records about moves that go to this partner: sent and each reply kind. */
function replyHistory(leagueId, partner, entry) {
  if (!tableIn('warroom_requests')) return { sent: null, accepted: null, declined: null, countered: null, silent: null };
  const moves = new Set([...(ok(entry.next_move) ? [entry.next_move.value] : []), ...(val(entry.alternatives) ?? [])]
    .filter(m => m?.steps?.some(s => String(s.partner) === partner)).map(m => String(m.move_id)));
  const recs = rows(`SELECT kind, payload FROM warroom_requests WHERE league_id = ? AND kind IN ('offer.sent', 'offer.reply')`, leagueId)
    .map(r => ({ kind: r.kind, p: JSON.parse(r.payload ?? '{}') })).filter(r => moves.has(String(r.p.move_id)));
  const count = pred => recs.filter(pred).length;
  return { sent: count(r => r.kind === 'offer.sent'), accepted: count(r => r.p.reply === 'accept'),
    declined: count(r => r.p.reply === 'decline'), countered: count(r => r.p.reply === 'counter'), silent: count(r => r.p.reply === 'silence') };
}

function partnerFocus(entry, leagueId, focus) {
  const partner = focus?.partner != null ? String(focus.partner) : null;
  if (!partner) return null;
  const pa = (val(entry.partners) ?? []).find(p => String(p.team) === partner) ?? null;
  const move = [...(ok(entry.next_move) ? [entry.next_move.value] : []), ...(val(entry.alternatives) ?? [])]
    .find(m => String(m.move_id) === String(focus.move_id)) ?? null;
  const step = move?.steps?.find(s => String(s.partner) === partner) ?? null;
  const basis = val(entry.p_yes_basis);
  return { partner, partner_label: teamOf(entry, partner),
    p_responds: pa?.p_responds ?? null, edge: val(pa?.edge), roster_holes: pa?.roster_holes?.join(', ') || null,
    offers_logged: pa?.offers_logged ?? null, checked_out: pa?.checked_out === true, blocked: pa?.blocked === true,
    his_side: val(step?.reasoning)?.his_side ?? val(move?.reasoning)?.his_side ?? null,
    p_yes: val(step?.p_yes), p_yes_basis: basis?.mode ?? null,
    ...replyHistory(leagueId, partner, entry) };
}

function rulesRow() {
  const name = id => row('SELECT name FROM players WHERE id = ?', Number(id))?.name ?? `player ${id}`;
  return { never_give: PINNED_NEVER_GIVE.map(name).join(', '), never_get: PINNED_NEVER_GET.map(name).join(', '),
    overpay_cap_pct: 0, depth_premium_max_pct: DEPTH_PREMIUM_MAX * 100, blue_chip_floor: BLUE_CHIP_SCORE,
    sends_offers: false };
}

/**
 * Record the bundle in `ledger` and return the text block for the prompt
 * (what each query id holds and its rows), or null when there is no plan.
 */
export async function preloadContext({ leagueId, focus = {}, ledger, plansPath = warRoomPlansPath() }) {
  if (!Number.isInteger(leagueId)) return null;
  let file;
  try { file = await readPlansFile(plansPath); } catch (e) {
    console.warn(`[coach] preload: the plans file could not be read (${e?.message ?? e}); the turn runs without it`);
    return null;
  }
  const entry = file ? leagueEntry(file, leagueId) : null;
  if (!entry) return null;
  const rec = (table, rowsIn, note) => {
    const list = rowsIn.length ? rowsIn : [{ status: 'none', reason: note }];
    const e = ledger.record({ tool: 'plan_read', tables: [table], columns: Object.keys(list[0]), rows: list });
    return { id: e.id, table, rows: list };
  };
  const d = val(entry.destination) ?? {};
  const nm = entry.next_move;
  const parts = [];
  parts.push(rec('plan_summary', [{
    plans_generated_at: file.generated_at ?? null, goal: val(d.goal)?.label ?? null, risk_mode: val(d.risk_mode)?.mode ?? null,
    title_odds_now: val(d.title_now), title_odds_now_se: se(d.title_now), title_odds_planned: val(d.title_planned_now),
    eta_week: val(d.eta_week), next_move: ok(nm) ? 'served' : 'none', no_move_reason: ok(nm) ? null : (nm?.reason ?? null),
    playoff_odds: null, playoff_odds_reason: 'the plan is priced on title odds; no playoff-odds number is served'
  }], ''));
  const moves = [...(ok(nm) && nm.value?.steps?.length ? [nm.value] : []),
    ...(val(entry.alternatives) ?? []).filter(m => !ok(nm) || m.move_id !== nm.value?.move_id)].slice(0, MAX_MOVES);
  parts.push(rec('plan_moves', moves.map((m, i) => moveRow(entry, m, i)), 'no served move or alternative this run'));
  parts.push(rec('plan_targets', (val(entry.targets) ?? []).slice(0, MAX_TARGETS).map(t => ({
    player: namesFor(entry, [String(t.player)]), owner: teamOf(entry, t.owner), gain_if_landed: val(t.gain_if_landed),
    gain_if_landed_se: se(t.gain_if_landed), p_reach: val(t.p_reach), p_reach_is_guess: t.p_reach?.guess === true
  })), 'no targets in the plan'));
  const roster = myRoster(leagueId);
  parts.push(rec('my_roster', roster.rows, roster.reason));
  const pf = partnerFocus(entry, leagueId, focus);
  if (pf) parts.push(rec('partner_focus', [pf], ''));
  parts.push(rec('nick_rules', [rulesRow()], ''));
  const text = parts.map(p => `${p.id} (${p.table}): ${JSON.stringify(p.rows)}`).join('\n');
  return { text, queries: parts.map(p => p.id) };
}

/** Questions that earn the full tool budget: an analysis, not a lookup. */
export const DEEP_QUESTION = /\b(analy[sz]e|analysis|deep dive|break (it|this|that) down|walk me through|compare|evaluate)\b/i;
export const PRELOAD_TOOL_ROUNDS = 2;
