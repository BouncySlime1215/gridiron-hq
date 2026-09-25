/**
 * VETO-RISK (batch D item 24): the one producer of P(veto) for an accepted deal.
 *
 * WHY. ONE-PLAN L7 defines P(complete) = p_yes x p_survives_review, but the planner
 * serves the product of p_yes alone (campaign/paths.js#pathExpectation): today's
 * implicit P(veto) is 0. A league-4 "yes" is not a landed trade: the league reviews
 * every accepted deal and has killed some this season.
 *
 * WHAT. From the league's own league_transactions_raw rows:
 *   an accepted offer = a TRADE_PROPOSAL whose partner wrote TRADE_ACCEPT / EXECUTE;
 *   it LANDED when the league's TRADE_ACCEPT / PROCESS row is EXECUTED, and was
 *   VETOED when that row is CANCELED with at least one TRADE_VETO vote (or, with no
 *   PROCESS row yet, when the veto votes reach the threshold). A cancel with no veto
 *   vote is not a veto (counted as canceled_other); an open review is not a label.
 * Three arms, graded forward-only (gradeVeto):
 *   none  P(veto) = 0, what is served today;
 *   base  the league's veto share, Beta(1,1)-smoothed;
 *   skew  two buckets by the deal's absolute market-value skew, each shrunk to base.
 * A threshold the other owners cannot reach is P(veto) = 0 (basis 'unreachable').
 *
 * SHADOW. trade-tactics.js#vetoRiskFor keeps its low/watch/high LABEL; this module is
 * the only one that prints a probability. Behind GRIDIRON_VETO_RISK the producer
 * writes `_run.inputs.veto_risk` (vetoShadow): each served plan's P(complete) with
 * the review folded in, BESIDE the served p_complete. Nothing served reads it. 'on'
 * is refused down to shadow until the league-level grade passes and Nick says so.
 */

export const VETO_ENV = 'GRIDIRON_VETO_RISK';

/** Every number the model judges with, in one frozen place, so a local run prints what it used. */
export const VETO_MODEL = Object.freeze({
  version: 1,
  basis: 'GUESS: prior, skew cut and shrinkage set by hand before any league-4 measurement',
  prior: Object.freeze({ a: 1, b: 1 }),
  skew_cut_pct: 15,
  bucket_k: 4,
  // Grading (pre-registered in docs/tdd/2026-09-25-veto-risk.tdd.md).
  min_prior: 5,
  min_scored: 10,
  skew_margin: 0.005,
  max_calibration_gap: 0.10,
});

/** off by default; '1' or 'shadow' -> shadow; 'on' -> shadow with a note (not graded yet). */
export function vetoRiskFlag(env = process.env) {
  const v = String(env[VETO_ENV] ?? '').trim().toLowerCase();
  if (v === '1' || v === 'shadow') return { mode: 'shadow' };
  if (v === 'on') return { mode: 'shadow', note: 'on refused: P(veto) is not graded yet, so it stays shadow' };
  return { mode: 'off' };
}

/** ESPN times are stored as ISO text; fixtures may pass epoch ms. null when unreadable. */
const toMs = v => (typeof v === 'number' ? v : (v ? Date.parse(v) : NaN));
// tx_id is unique only within (league, season): key every join on both.
const key = (season, tx) => `${season ?? ''}|${tx}`;

const parseItems = json => {
  if (Array.isArray(json)) return json;
  try { return JSON.parse(json || '[]'); } catch { return null; }
};

/**
 * Accepted offers and how their review ended.
 * Returns { deals: [{ tx_id, proposer, partner, proposed_at, decided_at, items, outcome, veto_votes, uphold_votes }],
 *           counts: { accepted, landed, vetoed, in_review, canceled_other } }.
 * `deals` holds only landed and vetoed offers, in decision order.
 */
export function decidedDeals(txRows, { votesRequired = null } = {}) {
  const byRel = new Map();
  for (const t of txRows) {
    if (!t.related_tx_id) continue;
    const k = key(t.season, t.related_tx_id);
    (byRel.get(k) ?? byRel.set(k, []).get(k)).push(t);
  }
  const counts = { accepted: 0, landed: 0, vetoed: 0, in_review: 0, canceled_other: 0 };
  const deals = [];
  for (const p of txRows) {
    if (p.type !== 'TRADE_PROPOSAL' || p.execution_type !== 'EXECUTE') continue;
    const rel = byRel.get(key(p.season, p.tx_id)) ?? [];
    const yes = rel.find(r => r.type === 'TRADE_ACCEPT' && r.execution_type === 'EXECUTE');
    if (!yes) continue;
    counts.accepted++;
    const proc = rel.find(r => r.type === 'TRADE_ACCEPT' && r.execution_type === 'PROCESS');
    const vetoVotes = rel.filter(r => r.type === 'TRADE_VETO').length;
    const upholdVotes = rel.filter(r => r.type === 'TRADE_UPHOLD').length;
    let outcome;
    if (proc?.status === 'EXECUTED') outcome = 'landed';
    else if (proc?.status === 'CANCELED') outcome = vetoVotes > 0 ? 'vetoed' : 'canceled_other';
    else outcome = Number.isFinite(votesRequired) && vetoVotes >= votesRequired ? 'vetoed' : 'in_review';
    counts[outcome]++;
    if (outcome !== 'landed' && outcome !== 'vetoed') continue;
    // Decided when the league processed it; with no PROCESS row (votes reached the bar), the last vote.
    const at = [toMs(proc?.processed_at), ...rel.map(r => toMs(r.proposed_at)).sort((a, b) => b - a), toMs(p.proposed_at)]
      .find(Number.isFinite) ?? null;
    deals.push({ tx_id: p.tx_id, season: p.season ?? null, proposer: String(p.team_id),
      partner: yes.team_id == null ? null : String(yes.team_id),
      proposed_at: Number.isFinite(toMs(p.proposed_at)) ? toMs(p.proposed_at) : null, decided_at: at, items: parseItems(p.items_json) ?? [],
      outcome, veto_votes: vetoVotes, uphold_votes: upholdVotes });
  }
  deals.sort((a, b) => (a.decided_at ?? 0) - (b.decided_at ?? 0));
  return { deals, counts };
}

/** The engine's skew unit: |sent - received| / received, in percent. */
function skewOf(sent, received) {
  if (!(received > 0)) return null;
  return Math.abs(((sent - received) / received) * 100);
}

/**
 * Absolute market-value skew of a historical deal from the proposer's side, or null when any traded
 * player cannot be priced (a partial price would invent a skew).
 */
export function dealSkewPct(items, proposer, priceOf) {
  const trades = (items ?? []).filter(i => i.type === 'TRADE');
  if (!trades.length) return null;
  let out = 0, back = 0;
  for (const i of trades) {
    const v = priceOf(i.playerId);
    if (!Number.isFinite(v)) return null;
    if (String(i.fromTeamId) === String(proposer)) out += v; else back += v;
  }
  return skewOf(out, back);
}

const rate = (v, n, { a, b }) => (v + a) / (n + a + b);
const shrink = (v, n, base, k) => (v + k * base) / (n + k);

/**
 * Fit the three arms on decided deals ({ outcome, skew_pct }).
 * otherOwners: the owners who vote on a deal between two teams (team count - 2).
 */
export function fitVeto(deals, { votesRequired = null, otherOwners = null, model = VETO_MODEL } = {}) {
  const n = deals.length;
  const v = deals.filter(d => d.outcome === 'vetoed').length;
  const base = rate(v, n, model.prior);
  const bucket = high => {
    const ds = deals.filter(d => Number.isFinite(d.skew_pct) && (d.skew_pct >= model.skew_cut_pct) === high);
    const bv = ds.filter(d => d.outcome === 'vetoed').length;
    return { n: ds.length, vetoed: bv, p: shrink(bv, ds.length, base, model.bucket_k) };
  };
  const unreachable = Number.isFinite(votesRequired) && Number.isFinite(otherOwners) && votesRequired > otherOwners;
  return { n, vetoed: v, base: { p: base, n, vetoed: v }, low: bucket(false), high: bucket(true),
    priced_n: deals.filter(d => Number.isFinite(d.skew_pct)).length,
    votes_required: votesRequired, other_owners: otherOwners, unreachable, fitted: false,
    label: n ? `guess from ${v} vetoed of ${n} decided deals (not graded)` : 'guess: no decided deals yet (prior only)',
    model };
}

/** P(veto) for one deal: { p, basis, n }. */
export function pVeto(table, { skewPct = null } = {}) {
  if (!table) return { p: 0, basis: 'none', n: 0 };
  if (table.unreachable) return { p: 0, basis: 'unreachable', n: table.n };
  if (!Number.isFinite(skewPct)) return { p: table.base.p, basis: 'base', n: table.n };
  const high = skewPct >= table.model.skew_cut_pct;
  const b = high ? table.high : table.low;
  return { p: b.p, basis: high ? 'skew_high' : 'skew_low', n: b.n };
}

/**
 * Forward-only grade: each deal is predicted from deals decided strictly before it, once at least
 * `min_prior` are. Brier and log loss per arm; the verdict follows the pre-registered bar.
 */
export function gradeVeto(deals, { votesRequired = null, otherOwners = null, model = VETO_MODEL } = {}) {
  const ordered = [...deals].sort((a, b) => (a.decided_at ?? 0) - (b.decided_at ?? 0));
  const rows = [];
  for (let i = 0; i < ordered.length; i++) {
    const d = ordered[i];
    const prior = ordered.slice(0, i).filter(x => (x.decided_at ?? 0) < (d.decided_at ?? 0));
    if (prior.length < model.min_prior) continue;
    const t = fitVeto(prior, { votesRequired, otherOwners, model });
    rows.push({ tx_id: d.tx_id ?? null, prior_n: prior.length, y: d.outcome === 'vetoed' ? 1 : 0,
      p: { none: 0, base: t.unreachable ? 0 : t.base.p, skew: pVeto(t, { skewPct: d.skew_pct }).p } });
  }
  const eps = 1e-6;
  const score = arm => {
    if (!rows.length) return { brier: null, log_loss: null, mean_p: null };
    let br = 0, ll = 0, mp = 0;
    for (const r of rows) {
      const p = Math.min(1 - eps, Math.max(eps, r.p[arm]));
      br += (r.p[arm] - r.y) ** 2;
      ll -= r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p);
      mp += r.p[arm];
    }
    return { brier: br / rows.length, log_loss: ll / rows.length, mean_p: mp / rows.length };
  };
  const arms = { none: score('none'), base: score('base'), skew: score('skew') };
  const observed = rows.length ? rows.reduce((s, r) => s + r.y, 0) / rows.length : null;
  const out = { n_decided: ordered.length, n_scored: rows.length, observed_rate: observed, arms, rows, model,
    verdict: 'not_enough_data', pick: null, why: null };
  if (rows.length < model.min_scored) {
    out.why = `${rows.length} scored deals, the bar needs ${model.min_scored}`;
    return out;
  }
  if (!(arms.base.brier < arms.none.brier)) {
    out.verdict = 'failing';
    out.why = 'the league veto rate does not beat P(veto) = 0';
    return out;
  }
  const pick = arms.skew.brier <= arms.base.brier - model.skew_margin ? 'skew' : 'base';
  const gap = Math.abs(arms[pick].mean_p - observed);
  out.pick = pick;
  out.calibration_gap = gap;
  if (gap > model.max_calibration_gap) {
    out.verdict = 'failing';
    out.why = `calibration gap ${gap.toFixed(3)} > ${model.max_calibration_gap}`;
    return out;
  }
  out.verdict = 'passing';
  out.why = `${pick} beats P(veto) = 0 on ${rows.length} forward-scored deals`;
  return out;
}

/**
 * SHADOW: each served plan's P(complete) with the review folded in, beside the served number.
 * vr: { table, valueOf(id) -> market value, counts? }; res: the planner result ({ best, deck }).
 * Never mutates res; nothing served reads the result.
 */
export function vetoShadow(vr, res) {
  if (!vr?.table) return { status: 'not_read', lane: 'shadow' };
  const t = vr.table;
  const row = plan => {
    if (!plan?.steps?.length) return null;
    let withVeto = 1;
    const steps = plan.steps.map(s => {
      const give = s.give.map(id => vr.valueOf(id)), get = s.get.map(id => vr.valueOf(id));
      const priced = [...give, ...get].every(Number.isFinite);
      const skew = priced ? skewOf(give.reduce((a, b) => a + b, 0), get.reduce((a, b) => a + b, 0)) : null;
      const pv = pVeto(t, { skewPct: skew });
      withVeto *= s.p * (1 - pv.p);
      return { team: s.team, p: s.p, skew_pct: skew, p_veto: pv.p, basis: pv.basis };
    });
    return { p_complete: plan.p_complete, p_complete_with_veto: withVeto, steps };
  };
  return { status: vr.status ?? 'ok', lane: 'shadow', fitted: false,
    history: { n: t.n, vetoed: t.vetoed, priced_n: t.priced_n, base_p: t.base.p, votes_required: t.votes_required,
      other_owners: t.other_owners, unreachable: t.unreachable, label: t.label, ...(vr.counts ? { counts: vr.counts } : {}) },
    model: { version: t.model.version, skew_cut_pct: t.model.skew_cut_pct, bucket_k: t.model.bucket_k, basis: t.model.basis },
    best: row(res?.best ?? null),
    deck: (res?.deck ?? []).map(c => row(c.plan)).filter(Boolean) };
}

/**
 * DB read for one league (all seasons in the table): { table, counts, deals } or a status when the
 * source is missing. priceOfEspn(espnPlayerId) -> market value or undefined.
 */
export function readVetoHistory(database, lg, { priceOfEspn = () => undefined } = {}) {
  const has = database.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'league_transactions_raw'`).get();
  let payload = {};
  try { payload = typeof lg?.payload === 'string' ? JSON.parse(lg.payload || '{}') : (lg?.payload ?? {}); } catch { payload = {}; }
  const teamCount = payload?.teams?.length ?? lg?.team_count ?? 0;
  const votesRequired = payload?.settings?.tradeSettings?.vetoVotesRequired ?? null;
  const otherOwners = teamCount ? Math.max(0, teamCount - 2) : null;
  if (!has) return { status: 'source_table_absent', votesRequired, otherOwners, table: fitVeto([], { votesRequired, otherOwners }), counts: null, deals: [] };
  const tx = database.prepare(`SELECT season, tx_id, type, status, execution_type, team_id, related_tx_id, proposed_at, processed_at, items_json
                               FROM league_transactions_raw WHERE league_id = ?`).all(lg.id);
  const { deals, counts } = decidedDeals(tx, { votesRequired });
  for (const d of deals) d.skew_pct = dealSkewPct(d.items, d.proposer, priceOfEspn);
  return { status: 'ok', votesRequired, otherOwners, table: fitVeto(deals, { votesRequired, otherOwners }), counts, deals };
}
