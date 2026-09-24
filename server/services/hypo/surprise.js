/**
 * HYPO-01a surprise detector: an outcome the model did not expect becomes a row in
 * `surprise_hypotheses` (migration 095) for Jev / R&D to test, with the ids of the
 * evidence that triggered it.
 *
 * Four streams, each scored as surprisal s = -ln p(outcome) under what we served:
 *   accept_low     a resolved league offer was accepted when P(accept) < 0.10
 *                  (p(outcome) = P(accept))
 *   decline_high   a resolved league offer was declined (or countered / expired, E1's
 *                  zeros) when P(accept) > 0.70 (p(outcome) = 1 - P(accept))
 *     The offers are E1's graded rows (eval/e1-league.js, #246): every resolved ESPN offer
 *     in the league plus the app's SENT offers (source 'app_proposed' AND sent_at IS NOT
 *     NULL; an unsent suggestion has no reply), each priced as of its proposal time, the
 *     recorded P(accept) when one was stored, else the production band replayed on what
 *     was knowable then (FIX-277-2).
 *   roster_burst   a team's roster decisions (executed adds + completed trades) in a 72 h
 *                  window are improbable under its own base rate: P(N >= n) < 0.05 for
 *                  N ~ Poisson(rate x 72 h), rate from the prior 28 days (at least 7
 *                  covered), n >= 3. p(outcome) = that tail. A DECISION is a run of the
 *                  team's moves each less than 60 min after the last: counting each claim
 *                  of one run as an independent event made it read as '3 moves in 0 h' at
 *                  p = 0.000025 (local runs, PR #277). The evidence keeps every tx id. A
 *                  burst is one scored window and never spans more than 72 h: a longer
 *                  chain of flagged windows is split, not merged (FIX-277-2).
 *   projection_miss  see projection-stream.js (FIX-277-4).
 *
 * The 10% / 70% cuts are the unit's own ("accept we gave <10%, decline we gave >70%").
 * The burst constants are hand-set, not fitted; the spec's per-stream 95th-percentile
 * threshold (refit nightly on a calibration window) needs graded weeks this league does
 * not have yet. model_p_accept is the midpoint of a band that trade-acceptance.js says is
 * "not a calibrated probability", so a surprise here is a surprise against what we
 * served, not against a calibrated model; the band travels in the evidence.
 *
 * Reads trade_outcomes, league_transactions_raw, weekly_prediction_snapshots and
 * league_roster_snapshots; writes surprise_hypotheses (the detail) and, in the same
 * transaction, one `hypo.surprise` event per hypothesis on the engine hub (engine_events,
 * migration 075; FIX-277-6) carrying its evidence ids and as_of. The write therefore needs
 * an engine write role (role.js); the CLI runs as 'script'.
 * Never writes P(accept) or points. The switch is hypoFlag (FIX-277-5): GRIDIRON_HYPO_ENABLED
 * '1' on, '0' off, unset follows preview mode (preview-mode.js); `enabled` overrides it.
 */
import { db, rows, row } from '../../db/index.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';
import { appendEvents } from '../engine/events.js';
import { registerEventType } from '../engine/registry.js';
import { mergeOffers, scoreAsOf } from '../eval/e1-league.js';
import { projectionUnits, projectionSurprises } from './projection-stream.js';

export const DETECTOR_VERSION = 'hypo-01a-v4';
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

export const HYPO_ENV = 'GRIDIRON_HYPO_ENABLED';
export const HYPO_PREVIEW_REASON = 'HYPO-01a surprise detector: hypothesis rows for Jev / R&D and their '
  + 'hypo.surprise hub events; default off until the pre-registered threshold is the write rule';

/**
 * { on, preview }, read per call. '1' / 'true' / 'on' is on; '0' / 'false' / 'off' vetoes
 * preview mode; unset (or anything else) follows previewUnconfirmed().
 */
export function hypoFlag(env = process.env) {
  const v = String(env[HYPO_ENV] ?? '').toLowerCase();
  if (['1', 'true', 'on'].includes(v)) return { on: true, preview: false };
  if (['0', 'false', 'off'].includes(v)) return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

export const hypoEnabled = (env = process.env) => hypoFlag(env).on;

/** The hub event each hypothesis is published as (FIX-277-6); surprise_hypotheses keeps the detail. */
export const SURPRISE_EVENT = 'hypo.surprise';
const SURPRISE_SOURCE = 'surprise_hypotheses';
registerEventType(SURPRISE_EVENT, {
  description: 'A HYPO-01a surprise: an outcome the served model did not expect, with its evidence ids '
    + '(detail row in surprise_hypotheses; model outputs under payload.model)',
});

/** P(N >= n) for N ~ Poisson(lambda). */
export function poissonTail(n, lambda) {
  if (n <= 0) return 1;
  let term = Math.exp(-lambda);
  let below = term;
  for (let k = 1; k < n; k++) { term *= lambda / k; below += term; }
  return Math.max(0, 1 - below);
}

const pct = p => `${Math.round(p * 100)}%`;
export const tableExists = name =>
  !!row(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

const OFFER_COLS = ['id', 'league_id', 'season', 'source', 'proposer_team_id', 'counterparty_team_id', 'proposed_at',
  'model_p_accept', 'model_p_accept_low', 'model_p_accept_high', 'model_basis', 'model_version', 'status',
  'espn_tx_id', 'idea_id', 'resolved_at', 'sent_at', 'matched_tx_id'];
const RAW_OFFER_COLS = ['league_id', 'season', 'tx_id', 'type', 'execution_type', 'team_id', 'related_tx_id',
  'proposed_at', 'items_json'];

/**
 * Every resolved offer in the league-season, scored as of its proposal time: E1's rows
 * (mergeOffers + scoreAsOf, eval/e1-league.js), read for one league so the replay's
 * league-wide rate is this league's. Each carries p (P(accept)), y (1 accepted, else 0),
 * basis ('recorded' | 'replay_anchor_only') and the surprisal of what happened.
 */
export function offerUnits(leagueId, season) {
  const to = rows(`SELECT ${OFFER_COLS.join(', ')} FROM trade_outcomes
     WHERE league_id = ? AND season = ?
       AND (source = 'observed' OR (source = 'app_proposed' AND sent_at IS NOT NULL))`, leagueId, season);
  const raw = tableExists(RAW_TABLE)
    ? rows(`SELECT ${RAW_OFFER_COLS.join(', ')} FROM ${RAW_TABLE}
         WHERE league_id = ? AND season = ? AND type IN ('TRADE_PROPOSAL', 'TRADE_ACCEPT', 'TRADE_DECLINE')`,
      leagueId, season)
    : [];
  const { offers } = mergeOffers({ rows: to, raw });
  return scoreAsOf(offers).map(o => ({
    ...o,
    at: o.resolved_at ?? o.proposed_at,
    surprisal: -Math.log(Math.max(1e-12, o.y === 1 ? o.p : 1 - o.p)),
  }));
}

function offerSurprises(units) {
  const out = [];
  for (const o of units) {
    const p = o.p;
    const kind = o.y === 1 && p < ACCEPT_LOW ? 'accept_low'
      : o.y === 0 && p > DECLINE_HIGH ? 'decline_high' : null;
    if (!kind) continue;
    const pOutcome = kind === 'accept_low' ? p : 1 - p;
    const band = o.basis === 'recorded' && o.model_p_accept_low != null
      ? `band ${pct(o.model_p_accept_low)}-${pct(o.model_p_accept_high)}, ${o.model_basis}`
      : `replayed as of the proposal on the production band, ${o.prior.n} prior decisions`;
    const statement = kind === 'accept_low'
      ? `Team ${o.counterparty_team_id} accepted an offer we gave ${pct(p)} to be accepted (${band}). `
        + 'Hypothesis: the acceptance model is missing something this manager values. '
        + 'Test: does the feature that separates this deal from his declines predict his accepts, '
        + 'walk-forward, excluding this offer?'
      : `Team ${o.counterparty_team_id} ${o.status} an offer we gave ${pct(p)} to be accepted (${band}). `
        + 'Hypothesis: the acceptance model over-prices this manager\'s willingness. '
        + 'Test: does the feature that separates this deal from his accepts predict his declines, '
        + 'walk-forward, excluding this offer?';
    out.push({
      surprise_key: o.id != null ? `${kind}:${o.id}` : `${kind}:tx:${o.league_id}:${o.season}:${o.espn_tx_id}`,
      kind, team_id: o.counterparty_team_id == null ? null : String(o.counterparty_team_id), model_p: p,
      surprisal: -Math.log(pOutcome), outcome: o.status, occurred_at: o.at, statement,
      evidence: {
        trade_outcome_ids: o.id != null ? [o.id] : [], tx_ids: o.espn_tx_id != null ? [String(o.espn_tx_id)] : [],
        idea_ids: o.idea_id ? [o.idea_id] : [], source: o.source, p_basis: o.basis,
        band: o.basis === 'recorded' ? { low: o.model_p_accept_low ?? null, mid: p, high: o.model_p_accept_high ?? null } : null,
        prior: { decisions: o.prior.n, accepts: o.prior.acc },
        basis: o.model_basis ?? null, model_version: o.model_version ?? null,
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

/**
 * Every window that opens where a decision starts, per team, scored against the team's
 * base rate (p null when the history is too short). Windows start only where a decision
 * starts, so a window cannot open mid-decision and count that decision's earlier moves
 * as its base rate.
 */
function teamWindows(leagueId, season) {
  const tx = rows(
    `SELECT tx_id, type, status, execution_type, proposed_at, processed_at, items_json
       FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);
  const stamps = tx.map(t => Date.parse(t.processed_at ?? t.proposed_at ?? '')).filter(Number.isFinite);
  if (!stamps.length) return [];
  const coverageStart = Math.min(...stamps);
  return [...movesByTeam(tx)].map(([team, moves]) => ({
    team,
    windows: moves
      .map((m, i) => (i === 0 || m.at - moves[i - 1].at >= DECISION_GAP_MINUTES * 60_000
        ? scoreWindow(moves, i, coverageStart) : null))
      .filter(Boolean),
  }));
}

/** Every scored window (a base rate known), for the walk-forward threshold (calibrate.js). */
export function burstUnits(leagueId, season) {
  if (!tableExists(RAW_TABLE)) return [];
  return teamWindows(leagueId, season).flatMap(({ team, windows }) => windows
    .filter(w => w.p != null)
    .map(w => ({ team_id: String(team), tx_id: w.inWindow[0].tx_id, at: new Date(w.inWindow[0].at).toISOString(),
      decisions: w.decisions, p: w.p, surprisal: -Math.log(Math.max(1e-300, w.p)) })));
}

/**
 * Non-overlapping flagged windows, most improbable first: take the flagged window with the
 * smallest p, drop every flagged window that overlaps it, repeat. Each burst is one scored
 * window, so it spans less than BURST_WINDOW_HOURS; a longer chain becomes several bursts
 * instead of one '10 moves in 113 h' row (FIX-277-2).
 */
function splitChain(flagged) {
  const left = [...flagged];
  const picked = [];
  const span = w => [w.inWindow[0].at, w.inWindow[0].at + BURST_WINDOW_HOURS * HOUR];
  while (left.length) {
    const best = left.reduce((a, b) => (b.p < a.p ? b : a));
    picked.push(best);
    const [s0, e0] = span(best);
    for (let i = left.length - 1; i >= 0; i--) {
      const [s1, e1] = span(left[i]);
      if (s1 < e0 && s0 < e1) left.splice(i, 1);
    }
  }
  return picked.sort((a, b) => a.inWindow[0].at - b.inWindow[0].at);
}

function burstSurprises(leagueId, season, skipped) {
  const out = [];
  for (const { team, windows } of teamWindows(leagueId, season)) {
    // Candidate windows (>= BURST_MIN_MOVES) chain when they overlap; a chain with no base
    // rate anywhere is reported as skipped, and a chain's flagged windows are split into
    // bursts of at most one window each.
    const candidates = windows.filter(w => w.decisions >= BURST_MIN_MOVES);
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
      for (const best of splitChain(flagged)) {
        const burst = best.inWindow;
        const hours = Math.round((burst.at(-1).at - burst[0].at) / HOUR);
        out.push({
          surprise_key: `roster_burst:${leagueId}:${season}:${team}:${burst[0].tx_id}`,
          kind: 'roster_burst', team_id: String(team), model_p: best.p, surprisal: -Math.log(best.p),
          outcome: `${burst.length} moves (${best.decisions} decisions) in ${hours} h`,
          occurred_at: new Date(burst[0].at).toISOString(),
          statement: `Team ${team} made ${burst.length} roster moves (${best.decisions} separate decisions) `
            + `in ${hours} h against a base rate of ${best.prior} decisions in the prior ${best.baselineDays.toFixed(0)} days (P = ${best.p.toExponential(1)}). `
            + 'Hypothesis: something changed for this manager (injury news, a lost matchup, a shift to '
            + 'buying or selling). Test: does a burst like this predict his next trade offer or '
            + 'acceptance, walk-forward, excluding this burst?',
          evidence: {
            tx_ids: burst.map(m => m.tx_id), moves: burst.length, decisions: best.decisions,
            adds: burst.filter(m => m.kind === 'add').length, trades: burst.filter(m => m.kind === 'trade').length,
            baseline: { prior_decisions: best.prior, prior_moves: best.priorMoves, days: best.baselineDays, lambda: best.lambda },
            window_hours: BURST_WINDOW_HOURS,
          },
        });
      }
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
  const flag = enabled == null ? hypoFlag(env) : { on: !!enabled, preview: false };
  if (!flag.on) return { enabled: false, written: 0, already: 0, published: 0, roster_moves: null, skipped: [], surprises: [] };
  const label = flag.preview ? previewFields(HYPO_PREVIEW_REASON) : {};

  const skipped = [];
  const rawPresent = tableExists(RAW_TABLE);
  const projection = projectionUnits(leagueId, season);
  const surprises = [
    ...offerSurprises(offerUnits(leagueId, season)),
    ...(rawPresent ? burstSurprises(leagueId, season, skipped) : []),
    ...projectionSurprises(projection.units),
  ];
  if (!write) {
    return { enabled: true, ...label, written: 0, already: null, published: 0, dry_run: true,
      roster_moves: rawPresent ? 'read' : 'raw_table_absent', projections: projection.state, skipped, surprises };
  }
  const insert = db.prepare(`INSERT INTO surprise_hypotheses
      (surprise_key, league_id, season, kind, team_id, model_p, surprisal, outcome, evidence_json,
       statement, detector_version, occurred_at, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(surprise_key) DO NOTHING`);
  let written = 0;
  let published = 0;
  const at = now();
  db.exec('BEGIN');
  try {
    for (const s of surprises) {
      written += Number(insert.run(s.surprise_key, leagueId, season, s.kind, s.team_id, s.model_p,
        s.surprisal, s.outcome, JSON.stringify(s.evidence), s.statement, DETECTOR_VERSION,
        s.occurred_at ?? null, at).changes);
    }
    // Every hypothesis of this run, new or already stored: appendEvents appends only when the
    // payload differs from the latest event for the key, so a rerun adds nothing and a row
    // written before FIX-277-6 is published once. Inside this transaction: row and event
    // commit together, or neither does.
    if (surprises.length) {
      published = appendEvents(surpriseEvents(leagueId, season, surprises.map(s => s.surprise_key))).inserted;
    }
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
  return {
    enabled: true, ...label, written, already: surprises.length - written, published,
    roster_moves: rawPresent ? 'read' : 'raw_table_absent', projections: projection.state, skipped, surprises,
  };
}

/**
 * Hub event ids for the evidence the spine already holds: offers by entity, ESPN tx by natural
 * key. A surprise's own events name the offer too; they are not evidence.
 */
function evidenceEventIds(leagueId, season, evidence) {
  const ids = new Set();
  for (const id of evidence.trade_outcome_ids ?? []) {
    for (const r of rows(`SELECT n.event_id FROM engine_event_entities n JOIN engine_events e ON e.id = n.event_id
        WHERE n.entity_type = 'offer' AND n.entity_id = ? AND e.source <> ?`, String(id), SURPRISE_SOURCE)) {
      ids.add(Number(r.event_id));
    }
  }
  for (const tx of evidence.tx_ids ?? []) {
    for (const r of rows(`SELECT id FROM engine_events WHERE source = ? AND natural_key >= ? AND natural_key < ?`,
      RAW_TABLE, `${leagueId}:${season}:${tx}:`, `${leagueId}:${season}:${tx};`)) ids.add(Number(r.id));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * One hypo.surprise event per stored hypothesis (FIX-277-6). as_of is the outcome's time
 * (occurred_at), or the capture time labelled first_seen when the outcome has none. The
 * payload carries ids and the served numbers only; the statement stays in the detail row.
 */
function surpriseEvents(leagueId, season, keys) {
  const stored = rows(`SELECT * FROM surprise_hypotheses WHERE surprise_key IN (${keys.map(() => '?').join(', ')})`, ...keys);
  return stored.map(h => {
    const ev = JSON.parse(h.evidence_json);
    const evidence = {
      trade_outcome_ids: ev.trade_outcome_ids ?? [], tx_ids: ev.tx_ids ?? [], snapshot_keys: ev.snapshot_keys ?? [],
      event_ids: evidenceEventIds(leagueId, season, ev),
    };
    return {
      event_type: SURPRISE_EVENT, source: SURPRISE_SOURCE, natural_key: h.surprise_key, provenance: 'derived',
      ...(h.occurred_at ? { as_of: h.occurred_at } : { as_of_quality: 'first_seen' }),
      league_id: leagueId, team_id: h.team_id,
      player_id: ev.player_id ?? null,
      entities: [{ type: 'hypothesis', id: h.id, role: 'subject' },
        ...evidence.trade_outcome_ids.map(id => ({ type: 'offer', id, role: 'subject' }))],
      payload: {
        hypothesis_id: Number(h.id), kind: h.kind, season: Number(h.season), outcome: h.outcome, evidence,
        model: { p: h.model_p, surprisal: h.surprisal, detector_version: h.detector_version },
      },
    };
  });
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
