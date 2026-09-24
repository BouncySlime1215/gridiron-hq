/**
 * JEV-01b (chat): grade Jev's chat labels against what the league did later,
 * calibrate them, and fit how much weight they earn beside the incumbent.
 *
 * The rules — units, outcomes, incumbents, floors, the decision rule — are
 * pre-registered in docs/evidence/2026-09-24/jev-01b-chat-preregistration.md
 * and this file implements that document; change one, change the other by
 * addendum.
 *
 * Two questions in `jev_chat_signals` have an outcome the app records without
 * anyone reading the chat:
 *   open_to_trade           manager x weekly cutoff: does his team trade in the next 14 days?
 *   own_roster.untouchable  a message naming a player he owns: is the player still his 14 days later?
 *
 * Every absence is typed. A league with no corpus, no trusted identity or no
 * transactions says which; a question under its floor is
 * `{ status: 'unknown', reason: 'thin' }` with its n and the floor, and carries
 * no weight and no map, so nothing downstream can mistake it for a number.
 *
 * The grade is aggregates only: no chat name, message or player leaves it.
 * Units are keyed by roster id.
 */
import { rows } from '../../db/index.js';
import { identityMap } from '../manager-identity.js';
import { normalizePlayerName } from '../player-identity.js';
import { fitCalibration, applyCalibration, clampP } from './calibrate.js';
import { blend, fitWeight, logLoss, brier, clusterBootstrapCI } from './stack.js';

/** Default off. With it on, buildManagerSignals adds the `jev_blend` rows. */
export const JEV_CHAT_BLEND_ENV = 'GRIDIRON_JEV_CHAT_BLEND';
export const jevChatBlendEnabled = () => process.env[JEV_CHAT_BLEND_ENV] === '1';

export const WINDOW_DAYS = 14;
export const LOOKBACK_DAYS = 7;
export const PRIOR_DAYS = 28;
export const ROSTER_SIZE = 16;
export const MIN_N = 60;
export const MIN_CLASS = 10;
export const MIN_HOLDOUT = 20;
export const TRAIN_SHARE = 0.7;
export const WEIGHT_FLOOR = 0.05;
export const CV_FOLDS = 5;
/** The graded questions and the manager_signals metric each one serves. */
export const QUESTIONS = Object.freeze({
  open_to_trade: 'jev_p_trade_14d',
  'own_roster.untouchable': 'jev_p_declaration_holds',
});

const DAY = 86400000;
const WINDOW = WINDOW_DAYS * DAY;
const tableExists = name => rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;
const round = (x, d = 4) => +x.toFixed(d);

function parseItems(t) {
  try { return JSON.parse(t.items_json || '[]'); } catch (err) {
    throw new Error(`league_transactions_raw ${t.tx_id}: items_json is not JSON (${err.message})`);
  }
}

/**
 * The league-season's transactions as timed events:
 *   trades  { team, at }            a proposal sent, or a party to a processed trade
 *   moves   { team, espn, at, dir } a player onto (+1) or off (-1) a roster, executed
 * `start` is the first stamped event: coverage begins there, not earlier.
 * `untimed` counts rows with no stamp, which no window can place.
 */
function txLedger(leagueId, season) {
  if (!tableExists('league_transactions_raw')) return null;
  const all = rows(`SELECT tx_id, type, status, execution_type, proposed_at, processed_at, team_id, items_json
                    FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, season);
  if (!all.length) return null;
  const trades = [], moves = [];
  let start = Infinity, untimed = 0;
  for (const t of all) {
    const proposed = Date.parse(t.proposed_at), processed = Date.parse(t.processed_at);
    if (!Number.isFinite(proposed) && !Number.isFinite(processed)) { untimed++; continue; }
    start = Math.min(start, ...[proposed, processed].filter(Number.isFinite));
    const at = Number.isFinite(processed) ? processed : proposed;
    if (t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE') {
      trades.push({ team: Number(t.team_id), at: Number.isFinite(proposed) ? proposed : at });
      continue;
    }
    if (t.status !== 'EXECUTED') continue;
    if (t.type === 'TRADE_ACCEPT') {
      // Only the league's PROCESS row moves players (manager-signals.js completedTrades).
      if (t.execution_type !== 'PROCESS') continue;
      const parties = new Set();
      for (const i of parseItems(t)) {
        if (Number(i.fromTeamId) > 0) { parties.add(Number(i.fromTeamId)); moves.push({ team: Number(i.fromTeamId), espn: Number(i.playerId), at, dir: -1 }); }
        if (Number(i.toTeamId) > 0) { parties.add(Number(i.toTeamId)); moves.push({ team: Number(i.toTeamId), espn: Number(i.playerId), at, dir: 1 }); }
      }
      for (const team of parties) trades.push({ team, at });
      continue;
    }
    if (t.type.startsWith('TRADE_')) continue;
    for (const i of parseItems(t)) {
      if (i?.type === 'ADD' && Number(i.toTeamId) > 0) moves.push({ team: Number(i.toTeamId), espn: Number(i.playerId), at, dir: 1 });
      if (i?.type === 'DROP' && Number(i.fromTeamId) > 0) moves.push({ team: Number(i.fromTeamId), espn: Number(i.playerId), at, dir: -1 });
    }
  }
  if (!Number.isFinite(start)) return null;
  moves.sort((a, b) => a.at - b.at);
  return { start, untimed, trades, moves, offs: moves.filter(m => m.dir === -1) };
}

/** P(his team has trade activity in the next 14 days), from activity before t only. */
function tradeIncumbent(ledger, team, t, teams) {
  const days = Math.max(0, (t - ledger.start) / DAY);
  const before = ledger.trades.filter(x => x.at < t);
  const mine = before.filter(x => x.team === team).length;
  const league = (before.length + 0.5) / (teams * days + WINDOW_DAYS);
  const rate = (mine + league * PRIOR_DAYS) / (days + PRIOR_DAYS);
  return clampP(1 - Math.exp(-WINDOW_DAYS * rate));
}

/** P(a player on his roster is still there in 14 days), from moves before t only. */
function holdIncumbent(ledger, team, t, teams) {
  const days = Math.max(0, (t - ledger.start) / DAY);
  const before = ledger.offs.filter(x => x.at < t);
  const mine = before.filter(x => x.team === team).length;
  const league = (before.length + 0.5) / (teams * ROSTER_SIZE * days + ROSTER_SIZE * WINDOW_DAYS);
  const rate = (mine + league * ROSTER_SIZE * PRIOR_DAYS) / (ROSTER_SIZE * (days + PRIOR_DAYS));
  return clampP(Math.exp(-WINDOW_DAYS * rate));
}

/** team -> normalized name -> ESPN id, from every roster snapshot of the season. */
function snapshotIds(leagueId, season) {
  const out = new Map();
  if (!tableExists('league_roster_snapshots')) return out;
  for (const r of rows(`SELECT DISTINCT team_id, espn_player_id, player_name FROM league_roster_snapshots
                        WHERE league_id = ? AND season = ? AND player_name IS NOT NULL`, leagueId, season)) {
    const team = Number(r.team_id);
    if (!out.has(team)) out.set(team, new Map());
    out.get(team).set(normalizePlayerName(r.player_name), Number(r.espn_player_id));
  }
  return out;
}

/** Owned at t: the last roster event before t is an add; with none, a snapshot row counts. */
function ownedAt(ledger, team, espn, t) {
  let last = 0;
  for (const m of ledger.moves) {
    if (m.at >= t) break;
    if (m.team === team && m.espn === espn) last = m.dir;
  }
  return last >= 0;
}

const heldThrough = (ledger, team, espn, t) =>
  !ledger.offs.some(m => m.team === team && m.espn === espn && m.at > t && m.at <= t + WINDOW);

/**
 * Every gradable unit per question, plus the current claims to serve.
 * Returns `{ reason }` when the league cannot be graded at all.
 */
export function buildUnits(leagueId, { chat, asOf = Date.now() }) {
  const lg = rows('SELECT payload, season FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return { reason: 'league_not_synced' };
  const payload = JSON.parse(lg.payload);
  const season = lg.season ?? payload.seasonId;
  const teams = Math.max(1, (payload.teams ?? []).length);
  const rosterOf = new Map();
  for (const [rosterId, ident] of identityMap(leagueId)) {
    if (ident.chat_name && ident.chat_name !== 'ME') rosterOf.set(ident.chat_name, rosterId);
  }
  if (!rosterOf.size) return { reason: 'no_trusted_identity' };
  const ledger = txLedger(leagueId, season);
  if (!ledger) return { reason: 'no_transactions' };

  // ---- open_to_trade: manager x weekly cutoff
  const said = new Map(); // roster -> [{ at, p }]
  for (const s of chat.prepare(`SELECT s.name, m.ts_utc, s.probability FROM jev_chat_signals s
                                 JOIN messages m ON m.msg_id = s.msg_id
                                 WHERE s.question = 'open_to_trade' AND s.probability IS NOT NULL`).all()) {
    const roster = rosterOf.get(s.name);
    const at = Date.parse(s.ts_utc);
    if (roster == null || !Number.isFinite(at)) continue;
    (said.get(roster) ?? said.set(roster, []).get(roster)).push({ at, p: s.probability });
  }
  const claimBefore = (roster, t) => {
    let best = null;
    for (const m of said.get(roster) ?? []) if (m.at >= t - LOOKBACK_DAYS * DAY && m.at < t) best = Math.max(best ?? 0, m.p);
    return best;
  };
  const open = [];
  for (let t = ledger.start; t + WINDOW <= asOf; t += 7 * DAY) {
    for (const roster of rosterOf.values()) {
      const claim = claimBefore(roster, t);
      if (claim == null) continue;
      const team = Number(roster);
      const y = ledger.trades.some(x => x.team === team && x.at > t && x.at <= t + WINDOW) ? 1 : 0;
      open.push({ roster_id: roster, cluster: roster, t, claim, inc: tradeIncumbent(ledger, team, t, teams), y });
    }
  }

  // ---- own_roster.untouchable: one declaration about a player he owns
  const ids = snapshotIds(leagueId, season);
  const decl = [], recentDecl = [];
  for (const s of chat.prepare(`SELECT s.msg_id, s.name, s.mentioned_player, s.probability, m.ts_utc
                                 FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
                                 WHERE s.question = 'own_roster.untouchable' AND s.mentioned_player IS NOT NULL
                                   AND s.probability IS NOT NULL`).all()) {
    const roster = rosterOf.get(s.name);
    const t = Date.parse(s.ts_utc);
    if (roster == null || !Number.isFinite(t) || t < ledger.start || t >= asOf) continue;
    const team = Number(roster);
    const espn = ids.get(team)?.get(normalizePlayerName(s.mentioned_player));
    if (espn == null || !ownedAt(ledger, team, espn, t)) continue;
    const unit = { roster_id: roster, cluster: roster, t, claim: s.probability,
      inc: holdIncumbent(ledger, team, t, teams), player: s.mentioned_player, msg_id: s.msg_id };
    if (t + WINDOW <= asOf) decl.push({ ...unit, y: heldThrough(ledger, team, espn, t) ? 1 : 0 });
    else if (t >= asOf - WINDOW) recentDecl.push(unit);
  }

  const currentOpen = [];
  for (const roster of rosterOf.values()) {
    const claim = claimBefore(roster, asOf);
    if (claim != null) currentOpen.push({ roster_id: roster, claim, inc: tradeIncumbent(ledger, Number(roster), asOf, teams) });
  }
  return {
    coverage: { start: new Date(ledger.start).toISOString(), as_of: new Date(asOf).toISOString(), untimed: ledger.untimed },
    units: { open_to_trade: open, 'own_roster.untouchable': decl },
    current: { open_to_trade: currentOpen, 'own_roster.untouchable': recentDecl },
  };
}

/**
 * Grade one question's units by the pre-registered rule: calibrate and weigh
 * on the earliest 70%, score on the latest 30%, serve a refit on all of them.
 */
export function gradeUnits(units) {
  const n = units.length;
  const positives = units.reduce((s, u) => s + u.y, 0);
  const nTrain = Math.floor(n * TRAIN_SHARE);
  const floor = { n: MIN_N, per_class: MIN_CLASS, holdout: MIN_HOLDOUT };
  if (n < MIN_N || positives < MIN_CLASS || n - positives < MIN_CLASS || n - nTrain < MIN_HOLDOUT) {
    return { status: 'unknown', reason: 'thin', n, positives, floor };
  }
  const sorted = [...units].sort((a, b) => a.t - b.t);
  const fit = set => {
    const cal = fitCalibration(set.map(u => ({ p: u.claim, y: u.y })));
    // The weight is fitted on out-of-fold calibrated claims: a map scored on
    // the points it was fitted to flatters itself (isotonic most of all) and
    // would buy a noise arm weight it never earned.
    const oof = set.map((u, i) => ({ inc: u.inc, y: u.y, i }));
    for (let f = 0; f < CV_FOLDS; f++) {
      const foldCal = fitCalibration(set.filter((_, j) => j % CV_FOLDS !== f).map(u => ({ p: u.claim, y: u.y })));
      for (const o of oof) if (o.i % CV_FOLDS === f) o.jev = applyCalibration(foldCal, set[o.i].claim);
    }
    return { cal, weight: fitWeight(oof) };
  };
  const train = fit(sorted.slice(0, nTrain));
  const test = sorted.slice(nTrain).map(u => ({
    cluster: u.cluster, y: u.y, inc: u.inc,
    p: blend(u.inc, applyCalibration(train.cal, u.claim), train.weight),
  }));
  const llBlend = logLoss(test), llInc = logLoss(test.map(u => ({ p: u.inc, y: u.y })));
  const ci = clusterBootstrapCI(test.map(u => ({
    cluster: u.cluster, d: logLoss([u]) - logLoss([{ p: u.inc, y: u.y }]) })));
  const leader = train.weight <= WEIGHT_FLOOR ? 'incumbent' : ci[1] < 0 ? 'jev' : ci[0] > 0 ? 'incumbent' : 'undecided';
  const served = fit(sorted);
  const diff = round(llBlend - llInc);
  const text = leader === 'jev'
    ? `Jev leads the incumbent by ${round(-diff)} log loss (holdout n=${test.length})`
    : leader === 'incumbent'
      ? `incumbent leads; Jev weight ${round(train.weight, 2)} (holdout n=${test.length})`
      : `undecided: blend minus incumbent ${diff} log loss, 90% CI [${round(ci[0])}, ${round(ci[1])}] (holdout n=${test.length})`;
  return {
    status: 'measured', n, positives, leader, text,
    weight: round(served.weight),
    calibration: { ...served.cal, n },
    holdout: {
      n: test.length, weight: round(train.weight),
      log_loss_blend: round(llBlend), log_loss_incumbent: round(llInc),
      brier_blend: round(brier(test)), brier_incumbent: round(brier(test.map(u => ({ p: u.inc, y: u.y })))),
      diff_ci90: ci.map(x => round(x)),
    },
  };
}

/** The whole grade for one league: aggregates only. */
export function gradeJevChatSignals(leagueId, { chat, asOf = Date.now() } = {}) {
  return gradeFrom(leagueId, chat, asOf).grade;
}

function gradeFrom(leagueId, chat, asOf) {
  if (!chat) return { grade: { league_id: leagueId, status: 'unknown', reason: 'no_chat_corpus' } };
  const built = buildUnits(leagueId, { chat, asOf });
  if (built.reason) return { grade: { league_id: leagueId, status: 'unknown', reason: built.reason } };
  const questions = Object.fromEntries(Object.keys(QUESTIONS).map(q => [q, gradeUnits(built.units[q])]));
  const measured = Object.values(questions).some(q => q.status === 'measured');
  return {
    built,
    grade: {
      league_id: leagueId, status: measured ? 'measured' : 'unknown', ...(measured ? {} : { reason: 'thin' }),
      window_days: WINDOW_DAYS, coverage: built.coverage, questions,
    },
  };
}

/**
 * The manager_signals rows the flag adds: for each measured question, the
 * blended probability per chat-identified manager with a current claim, under
 * source `jev_blend`. `state` says per question why a row is or is not there.
 */
export function jevChatBlendRows(leagueId, { chat, asOf = Date.now() } = {}) {
  const { built, grade } = gradeFrom(leagueId, chat, asOf);
  if (!grade.questions) return { rows: [], state: { status: 'unknown', reason: grade.reason } };
  const out = [], state = {};
  for (const [q, metric] of Object.entries(QUESTIONS)) {
    const g = grade.questions[q];
    state[q] = g.status === 'measured' ? 'measured' : `unknown:${g.reason}`;
    if (g.status !== 'measured') continue;
    const byRoster = new Map();
    for (const c of built.current[q]) {
      const p = blend(c.inc, applyCalibration(g.calibration, c.claim), g.weight);
      (byRoster.get(c.roster_id) ?? byRoster.set(c.roster_id, []).get(c.roster_id)).push(p);
    }
    for (const [rosterId, ps] of byRoster) {
      out.push({ roster_id: rosterId, metric, value: round(ps.reduce((a, b) => a + b, 0) / ps.length), n: g.n, source: 'jev_blend' });
    }
  }
  return { rows: out, state };
}
