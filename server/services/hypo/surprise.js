/**
 * HYPO-01a surprise detector: an outcome the model did not expect becomes a row in
 * `surprise_hypotheses` (migration 095) for Jev / R&D to test, with the ids of the
 * evidence that triggered it.
 *
 * Three streams, each scored as surprisal s = -ln p(outcome) under what we served:
 *   accept_low    an app-proposed offer resolved 'accepted' when model_p_accept < 0.10
 *                 (p(outcome) = model_p_accept)
 *   decline_high  an app-proposed offer resolved 'declined' when model_p_accept > 0.70
 *                 (p(outcome) = 1 - model_p_accept)
 *   roster_burst  a team's roster decisions (executed adds + completed trades) in a 72 h
 *                 window are improbable under its own base rate: P(N >= n) < 0.05 for
 *                 N ~ Poisson(rate x 72 h), rate from the prior 28 days (at least 7
 *                 covered), n >= 3. p(outcome) = that tail. A DECISION is a run of the
 *                 team's moves each less than 60 min after the last: counting each claim
 *                 of one run as an independent event made it read as '3 moves in 0 h' at
 *                 p = 0.000025 (local runs, PR #277). The evidence keeps every tx id.
 *
 * The 10% / 70% cuts are the unit's own ("accept we gave <10%, decline we gave >70%").
 * The burst constants are hand-set, not fitted; the spec's per-stream 95th-percentile
 * threshold (refit nightly on a calibration window) needs graded weeks this league does
 * not have yet. model_p_accept is the midpoint of a band that trade-acceptance.js says is
 * "not a calibrated probability", so a surprise here is a surprise against what we
 * served, not against a calibrated model; the band travels in the evidence.
 *
 * Reads trade_outcomes and league_transactions_raw; writes only surprise_hypotheses.
 * Never writes P(accept) or points. Off unless GRIDIRON_HYPO_ENABLED=1 (or `enabled`).
 */
import { db, rows, row } from '../../db/index.js';

export const DETECTOR_VERSION = 'hypo-01a-v3';
export const ACCEPT_LOW = 0.10;
export const DECLINE_HIGH = 0.70;
export const BURST_WINDOW_HOURS = 72;
export const BURST_MIN_MOVES = 3;
export const BURST_P_MAX = 0.05;
export const BASELINE_DAYS = 28;
export const BASELINE_MIN_DAYS = 7;
export const DECISION_GAP_MINUTES = 60;
const RATE_PSEUDO_COUNT = 0.5; // a quiet team's rate is never 0, so p is never 0
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RAW_TABLE = 'league_transactions_raw';

export function hypoEnabled(env = process.env) {
  return ['1', 'true', 'on'].includes(String(env.GRIDIRON_HYPO_ENABLED ?? '').toLowerCase());
}

/** P(N >= n) for N ~ Poisson(lambda). */
export function poissonTail(n, lambda) {
  if (n <= 0) return 1;
  let term = Math.exp(-lambda);
  let below = term;
  for (let k = 1; k < n; k++) { term *= lambda / k; below += term; }
  return Math.max(0, 1 - below);
}

const pct = p => `${Math.round(p * 100)}%`;
const tableExists = name =>
  !!row(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

function offerSurprises(leagueId, season) {
  const out = [];
  const offers = rows(
    `SELECT id, idea_id, counterparty_team_id, model_p_accept, model_p_accept_low,
            model_p_accept_high, model_basis, model_version, status, proposed_at, resolved_at
       FROM trade_outcomes
      WHERE league_id = ? AND season = ? AND model_p_accept IS NOT NULL
        AND status IN ('accepted', 'declined')
      ORDER BY id`, leagueId, season);
  for (const o of offers) {
    const p = o.model_p_accept;
    const kind = o.status === 'accepted' && p < ACCEPT_LOW ? 'accept_low'
      : o.status === 'declined' && p > DECLINE_HIGH ? 'decline_high' : null;
    if (!kind) continue;
    const pOutcome = kind === 'accept_low' ? p : 1 - p;
    const band = `band ${pct(o.model_p_accept_low)}-${pct(o.model_p_accept_high)}, ${o.model_basis}`;
    const statement = kind === 'accept_low'
      ? `Team ${o.counterparty_team_id} accepted an offer we gave ${pct(p)} to be accepted (${band}). `
        + 'Hypothesis: the acceptance model is missing something this manager values. '
        + 'Test: does the feature that separates this deal from his declines predict his accepts, '
        + 'walk-forward, excluding this offer?'
      : `Team ${o.counterparty_team_id} declined an offer we gave ${pct(p)} to be accepted (${band}). `
        + 'Hypothesis: the acceptance model over-prices this manager\'s willingness. '
        + 'Test: does the feature that separates this deal from his accepts predict his declines, '
        + 'walk-forward, excluding this offer?';
    out.push({
      surprise_key: `${kind}:${o.id}`,
      kind, team_id: o.counterparty_team_id, model_p: p, surprisal: -Math.log(pOutcome),
      outcome: o.status, occurred_at: o.resolved_at ?? o.proposed_at, statement,
      evidence: {
        trade_outcome_ids: [o.id], idea_ids: o.idea_id ? [o.idea_id] : [],
        band: { low: o.model_p_accept_low, mid: p, high: o.model_p_accept_high },
        basis: o.model_basis, model_version: o.model_version,
      },
    });
  }
  return out;
}

function parseItems(t) {
  try { return JSON.parse(t.items_json || '[]'); } catch (err) {
    throw new Error(`${RAW_TABLE} ${t.tx_id}: items_json is not JSON (${err.message})`);
  }
}

/** Per team, time-ordered moves: one per ADD on an executed add, one per party on a trade. */
function movesByTeam(tx) {
  const out = new Map();
  const push = (team, at, t, kind) =>
    (out.get(team) ?? out.set(team, []).get(team)).push({ at, tx_id: String(t.tx_id), kind });
  for (const t of tx) {
    const at = Date.parse(t.processed_at ?? t.proposed_at ?? '');
    if (!Number.isFinite(at) || t.status !== 'EXECUTED') continue;
    if (t.type === 'WAIVER' || t.type === 'FREEAGENT') {
      for (const i of parseItems(t)) {
        if (i?.type === 'ADD' && Number(i.toTeamId) > 0) push(Number(i.toTeamId), at, t, 'add');
      }
    } else if (t.type === 'TRADE_ACCEPT' && t.execution_type === 'PROCESS') {
      const parties = new Set(parseItems(t).flatMap(i => [i?.fromTeamId, i?.toTeamId])
        .filter(x => Number(x) > 0).map(Number));
      for (const team of parties) push(team, at, t, 'trade');
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at || a.tx_id.localeCompare(b.tx_id));
  return out;
}

/**
 * Decisions in a time-ordered run of one team's moves: a move less than DECISION_GAP_MINUTES
 * after the previous one belongs to the same decision. ESPN processes a team's claims one
 * after another, seconds to minutes apart, and a manager clearing his bench does the same;
 * counting each as an independent Poisson event overstates the surprise.
 */
function countDecisions(moves) {
  let n = 0;
  for (let i = 0; i < moves.length; i++) {
    if (i === 0 || moves[i].at - moves[i - 1].at >= DECISION_GAP_MINUTES * 60_000) n++;
  }
  return n;
}

/** One window starting at moves[i]: its moves and its tail probability, or why it has none. */
function scoreWindow(moves, i, coverageStart) {
  const start = moves[i].at;
  const inWindow = moves.filter(m => m.at >= start && m.at < start + BURST_WINDOW_HOURS * HOUR);
  const decisions = countDecisions(inWindow);
  const baselineStart = Math.max(coverageStart, start - BASELINE_DAYS * DAY);
  const baselineDays = (start - baselineStart) / DAY;
  if (baselineDays < BASELINE_MIN_DAYS) {
    return { inWindow, decisions, p: null, baselineDays };
  }
  const priorMoves = moves.filter(m => m.at >= baselineStart && m.at < start);
  const prior = countDecisions(priorMoves);
  const rate = (prior + RATE_PSEUDO_COUNT) / baselineDays;
  const lambda = rate * (BURST_WINDOW_HOURS / 24);
  return { inWindow, decisions, p: poissonTail(decisions, lambda), prior, priorMoves: priorMoves.length,
    baselineDays, lambda };
}

function burstSurprises(leagueId, season, skipped) {
  const tx = rows(
    `SELECT tx_id, type, status, execution_type, proposed_at, processed_at, items_json
       FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);
  const stamps = tx.map(t => Date.parse(t.processed_at ?? t.proposed_at ?? '')).filter(Number.isFinite);
  if (!stamps.length) return [];
  const coverageStart = Math.min(...stamps);
  const out = [];
  for (const [team, moves] of movesByTeam(tx)) {
    // Candidate windows (>= BURST_MIN_MOVES), then chains of overlapping candidates are
    // one burst, so a run of moves is one hypothesis however the windows slide over it.
    // Windows start only where a decision starts, so a window cannot open mid-decision and
    // count that decision's earlier moves as its base rate.
    const candidates = moves
      .map((m, i) => (i === 0 || m.at - moves[i - 1].at >= DECISION_GAP_MINUTES * 60_000
        ? scoreWindow(moves, i, coverageStart) : null))
      .filter(w => w && w.decisions >= BURST_MIN_MOVES);
    const clusters = [];
    for (const w of candidates) {
      const last = clusters.at(-1);
      const lastEnd = last ? Math.max(...last.flatMap(x => x.inWindow.map(m => m.at))) : -Infinity;
      if (last && w.inWindow[0].at <= lastEnd) last.push(w); else clusters.push([w]);
    }
    for (const cluster of clusters) {
      const flagged = cluster.filter(w => w.p != null && w.p < BURST_P_MAX);
      if (!flagged.length) {
        if (cluster.every(w => w.p == null)) {
          skipped.push({
            kind: 'roster_burst', team_id: String(team), tx_ids: cluster[0].inWindow.map(m => m.tx_id),
            reason: `no base rate: ${cluster[0].baselineDays.toFixed(1)} days of collected transactions `
              + `before this run of moves, ${BASELINE_MIN_DAYS} needed`,
          });
        }
        continue;
      }
      const burst = [...new Set(flagged.flatMap(w => w.inWindow))].sort((a, b) => a.at - b.at);
      const best = flagged.reduce((a, b) => (b.p < a.p ? b : a));
      const hours = Math.round((burst.at(-1).at - burst[0].at) / HOUR);
      out.push({
        surprise_key: `roster_burst:${leagueId}:${season}:${team}:${burst[0].tx_id}`,
        kind: 'roster_burst', team_id: String(team), model_p: best.p, surprisal: -Math.log(best.p),
        outcome: `${burst.length} moves (${countDecisions(burst)} decisions) in ${hours} h`,
        occurred_at: new Date(burst[0].at).toISOString(),
        statement: `Team ${team} made ${burst.length} roster moves (${countDecisions(burst)} separate decisions) `
          + `in ${hours} h against a base rate of ${best.prior} decisions in the prior ${best.baselineDays.toFixed(0)} days (P = ${best.p.toExponential(1)}). `
          + 'Hypothesis: something changed for this manager (injury news, a lost matchup, a shift to '
          + 'buying or selling). Test: does a burst like this predict his next trade offer or '
          + 'acceptance, walk-forward, excluding this burst?',
        evidence: {
          tx_ids: burst.map(m => m.tx_id), moves: burst.length, decisions: countDecisions(burst),
          adds: burst.filter(m => m.kind === 'add').length, trades: burst.filter(m => m.kind === 'trade').length,
          baseline: { prior_decisions: best.prior, prior_moves: best.priorMoves, days: best.baselineDays, lambda: best.lambda },
          window_hours: BURST_WINDOW_HOURS,
        },
      });
    }
  }
  return out;
}

/**
 * Detect and write surprises for one league-season. `write: false` detects only (dry run).
 * @returns { enabled, written, already, roster_moves, skipped, surprises }
 *   roster_moves is 'read' or 'raw_table_absent'; skipped lists runs of moves that
 *   could not be scored, with the reason.
 */
export function detectSurprises({ leagueId, season, enabled = null, env = process.env, write = true,
  now = () => new Date().toISOString() } = {}) {
  if (leagueId == null || season == null) throw new Error('detectSurprises needs leagueId and season');
  const on = enabled ?? hypoEnabled(env);
  if (!on) return { enabled: false, written: 0, already: 0, roster_moves: null, skipped: [], surprises: [] };

  const skipped = [];
  const rawPresent = tableExists(RAW_TABLE);
  const surprises = [
    ...offerSurprises(leagueId, season),
    ...(rawPresent ? burstSurprises(leagueId, season, skipped) : []),
  ];
  if (!write) {
    return { enabled: true, written: 0, already: null, dry_run: true,
      roster_moves: rawPresent ? 'read' : 'raw_table_absent', skipped, surprises };
  }
  const insert = db.prepare(`INSERT INTO surprise_hypotheses
      (surprise_key, league_id, season, kind, team_id, model_p, surprisal, outcome, evidence_json,
       statement, detector_version, occurred_at, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(surprise_key) DO NOTHING`);
  let written = 0;
  const at = now();
  db.exec('BEGIN');
  try {
    for (const s of surprises) {
      written += Number(insert.run(s.surprise_key, leagueId, season, s.kind, s.team_id, s.model_p,
        s.surprisal, s.outcome, JSON.stringify(s.evidence), s.statement, DETECTOR_VERSION,
        s.occurred_at ?? null, at).changes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    enabled: true, written, already: surprises.length - written,
    roster_moves: rawPresent ? 'read' : 'raw_table_absent', skipped, surprises,
  };
}

/** Hypothesis rows for Jev / R&D, newest first, evidence parsed. */
export function listHypotheses({ leagueId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (leagueId != null) { where.push('league_id = ?'); params.push(leagueId); }
  if (status != null) { where.push('status = ?'); params.push(status); }
  return rows(`SELECT * FROM surprise_hypotheses ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY detected_at DESC, id DESC LIMIT ?`, ...params, limit)
    .map(({ evidence_json, ...r }) => ({ ...r, evidence: JSON.parse(evidence_json) }));
}
