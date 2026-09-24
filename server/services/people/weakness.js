/**
 * WEAK-01: the weakness scanner, and the one producer's model for `people.weakness`
 * (FIELD-REGISTRY.md; published by engine/producers/weakness.js).
 *
 * For every counterparty in a league it ranks "attack surfaces": facts about where he is
 * weak right now, each with the evidence it rests on, the as_of of the newest input it
 * used, and a confidence label saying what kind of evidence that is:
 *
 *   proven     rests on a signal that passed a held-out test: wants_player (PEOPLE-LAB,
 *              the 17x in-market signal), the IDEA-084 activity intensity (confirmed on
 *              Sleeper 2023 and 2024 held out), a CRED-01 credibility row whose status
 *              is 'proven'.
 *   measured   a fact read off the league (rosters, byes, record, deadline, days since
 *              his last move). True, but nobody has tested that it makes him deal worse.
 *   unproven   a model read that has not passed a test (the valuation map's hand-set,
 *              fitted:false per-player factors).
 *
 * The five kinds (BUILD-PLAN v2 Stage 2):
 *   roster_hole    starting slots he cannot fill in a coming week (byes, IR, empty
 *                  position) and bye crunches (three or more RB/WR/TE/QB out the same week).
 *   value_gap      players he prices above our value (sell him those) or his own players
 *                  he prices below it (buy): counterparty-pricing.js#playerValuation.
 *   desperation    games behind the playoff line, recent losses, and the trade deadline
 *                  getting close; the served playoff-odds trend when two snapshots exist.
 *   recent_activity  WEAK-02: how recently he made a roster move and his activity intensity
 *                  (IDEA-084 point process) against the league. INVERTED from WEAK-01's
 *                  attention_gap: r44 (rnd/loop/r44-WEAK-SLEEPER.md, 131k Sleeper manager-weeks)
 *                  found recently active managers sell (10.5% within 14 days at 0-3 days since
 *                  the last move vs 1.5% at 30-60 days) and idle ones do not.
 *   in_market      he said he wants a player (wants_player, from people.counterpart),
 *                  with credibility attached; shop talk only when credibility backs it.
 *
 * Honesty rule: a surface is a TRUE fact with its evidence. The planner may use it for
 * targets, timing and framing; nothing here is a sentence to send, and no surface may
 * be turned into a claim that is not in its evidence. A kind the scanner could not read
 * is listed under `absent` with the reason (typed unknown), never scored as zero; a
 * kind it read and found nothing in is listed under `clear`.
 *
 * Scores: strength in [0, 1] per surface, times CONFIDENCE_WEIGHT (hand-set), times
 * SELLER_WEIGHT (WEAK-02, from r44): roster_hole and desperation are kept as framing facts
 * but weigh 0 in the ranking (holes made r44's held-out log loss worse; desperation added
 * nothing). Ranking is within the manager; the league order ("who is likely to sell") is by
 * the sum of each manager's top three scores.
 *
 * Pure except weaknessInputs (reads the app DB, as of a cut: nothing after the cut is
 * read, so a replay of a past date sees what was known then).
 *
 * Flag: GRIDIRON_WEAKNESS=1 on, =0 off (vetoes preview); unset follows the local
 * preview switch (preview-mode.js). Default off.
 */
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const WEAKNESS_VERSION = 'weakness.2';
export const PEOPLE_WEAKNESS_FIELD = 'people.weakness';
export const WEAKNESS_ENV = 'GRIDIRON_WEAKNESS';
export const WEAKNESS_SOURCE = 'server/services/people/weakness.js';
export const PREVIEW_REASON = 'weakness scanner (WEAK-01/02) is default-off: the seller ranking rests on r44 (Sleeper, held out) and is not validated on ESPN leagues; other scores are hand-set';

export const CONFIDENCE = Object.freeze({ proven: 'proven', measured: 'measured', unproven: 'unproven' });
/** Hand-set: how much a surface's label discounts its strength in the ranking. */
export const CONFIDENCE_WEIGHT = Object.freeze({ proven: 1, measured: 0.8, unproven: 0.5 });
export const SURFACE_KINDS = Object.freeze(['roster_hole', 'value_gap', 'desperation', 'recent_activity', 'in_market']);
/** The signals a 'proven' label may rest on (the metric checks every proven surface names one). */
export const PROVEN_SIGNALS = Object.freeze(['wants_player', 'activity_intensity', 'activity_recency', 'credibility']);

/**
 * WEAK-02: r44 WEAK-SLEEPER (rnd/loop/r44-WEAK-SLEEPER.md, CONFIRM; fit Sleeper 2021-22, graded
 * once on 2023-24, 130,974 manager-weeks, 8,224 sellers, 809 league chains). Only the attention
 * surface carries signal, and it runs the other way to WEAK-01's framing.
 */
export const R44 = Object.freeze({
  source: 'rnd/loop/r44-WEAK-SLEEPER.md (Sleeper; fit 2021-22, graded 2023-24; league-chain bootstrap 95% CI)',
  attention: Object.freeze({ logloss_gain: 0.00063, ci: Object.freeze([0.00034, 0.00088]), bh_p: 0.0000,
    seller_rate_by_days: Object.freeze({ '0-3': 0.105, '3-7': 0.072, '7-14': 0.047, '14-30': 0.029, '30-60': 0.015, never: 0.015 }) }),
  roster_hole: Object.freeze({ logloss_gain: -0.00018, ci: Object.freeze([-0.00032, -0.00005]), bh_p: 0.9955,
    seller_rate: Object.freeze({ no_hole: 0.066, one_hole: 0.049, two_holes: 0.021, bye_crunch: 0.062, no_crunch: 0.063 }) }),
  desperation: Object.freeze({ logloss_gain: 0.00002, ci: Object.freeze([-0.00003, 0.00006]), bh_p: 0.3473,
    seller_rate_by_recent_losses: Object.freeze({ 0: 0.062, 1: 0.064, 2: 0.063 }) }),
});

/**
 * WEAK-02 seller weights (fit on Sleeper 2021-22 only, never on the graded seasons): the
 * within-14-days seller rate of each bin relative to the top bin. Days since his last roster
 * move (0-3: 10.6%; never moved: 1.6%) times his activity intensity against the league median
 * (at or above: 7.3%; up to half below: 6.0%; more than half below: 3.4%).
 */
export const SELLER = Object.freeze({
  days: Object.freeze([[3, 1], [7, 0.629], [14, 0.428], [30, 0.334], [Infinity, 0.127]]),
  never: 0.147,
  intensity: Object.freeze([[0, 1], [0.5, 0.821], [Infinity, 0.47]]),
  fit: 'Sleeper 2021-22 seller-within-14-days rates by bin, relative to the top bin (rnd/loop r44 rows; WEAK-02)',
  holdout: 'graded Sleeper 2023-24, within league-week: top-3 hit 0.355 vs WEAK-01 0.205 (random 0.270), +0.150 [+0.132, +0.168]; AUC 0.616 vs 0.414, +0.202 [+0.184, +0.221] (499 chains with a seller, 2,000 chain-bootstrap reps)',
});
/** WEAK-02: a surface's weight in the seller ranking (r44). Holes and desperation stay as framing facts only. */
export const SELLER_WEIGHT = Object.freeze({ roster_hole: 0, value_gap: 1, desperation: 0, recent_activity: 1, in_market: 1 });

/**
 * IDEA-084 PP adds model (rnd/loop/r25-IDEA-084.md, CONFIRM): Poisson GLM on Sleeper 2021-22
 * (122,482 team-weeks, weeks 3..14), offset log(lambda0), alpha 2, gamma 0.7. Every
 * coefficient re-derived by re-fitting the same design on the fit seasons (identical to the
 * printed ones to 3 dp; the print had filtered out `wp` and the week effects).
 * Transfer from Sleeper to ESPN league 4 is not yet validated (the report says so).
 */
export const PP_ADDS = Object.freeze({
  alpha: 2, gamma: 0.7, const: -0.2298, logl0: -0.1780,
  week: Object.freeze({ 4: 0.1341, 5: 0.2265, 6: 0.4072, 7: 0.4802, 8: 0.2891, 9: 0.3942, 10: 0.2281,
    11: 0.1568, 12: 0.0306, 13: 0.0993, 14: 0.1931 }),
  lost1: 0.0233, streak2: -0.0286, margin1: -0.0596, dead1: -0.1739, empty1: -0.1734, wp: 0.1670, exc: 0.5418,
  min_history: 2,
  source: 'rnd/loop/r25-IDEA-084.md (fit Sleeper 2021-22; graded 2023 +0.0259 [+0.0216,+0.0310], 2024 +0.0069 [+0.0039,+0.0101] nats/team-week)',
});

/** Hand-set scales (fitted: false), named so the evidence can cite them. */
export const SCALES = Object.freeze({
  hole_slots_full: 2,          // two unfillable starting slots in a week = strength 1
  hole_near_weeks: 3,          // weeks ahead that count in full; later weeks x hole_far_weight
  hole_far_weight: 0.6,
  crunch_min: 3,               // RB/WR/TE/QB on bye the same week to call it a crunch
  crunch_strength: 0.3,
  value_cap: 0.20,             // counterparty-pricing.js PLAYER_VALUATION_CAP: a capped read = strength 1
  value_min: 0.02,             // below 2% of our value is not a gap
  behind_full: 3,              // wins behind the playoff line + half a point per recent loss, /3
  deadline_days: 70,           // deadline pressure is linear over the last 70 days
  odds_drop_full: 0.25,        // a 25-point fall in served playoff odds = strength 1
  wants_prior: 2.0,            // counterpart.js WANTS_PRIOR_LOG_LIFT: full lift = strength 1
  wants_not_nicks: 0.5,        // he wants a player Nick does not have: half strength
  top_n: 3,
});

const DAY = 864e5;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const maxMs = (...xs) => { const v = xs.flat().filter(Number.isFinite); return v.length ? Math.max(...v) : null; };

/** { on, preview }: =1 on, =0 off (vetoes preview), unset follows the preview switch. */
export function weaknessFlag(env = process.env) {
  if (env[WEAKNESS_ENV] === '1') return { on: true, preview: false };
  if (env[WEAKNESS_ENV] === '0') return { on: false, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true, ...previewFields(PREVIEW_REASON) } : { on: false, preview: false };
}

/* ================================================================== ledger (pure) */

export const toMs = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(/\dT\d|Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};
export const txTime = r => toMs(r.processed_at) ?? toMs(r.proposed_at);

const ROSTER_MOVE = r => (r.type === 'DRAFT' && r.status === 'EXECUTED')
  || ((r.type === 'FREEAGENT' || r.type === 'WAIVER') && r.status === 'EXECUTED')
  || (r.type === 'TRADE_ACCEPT' && r.status === 'EXECUTED' && r.execution_type === 'PROCESS');
/** r44's "move" on Sleeper: a waiver or free-agent claim (any status) or a completed trade. */
const IS_MOVE = r => r.type === 'FREEAGENT' || r.type === 'WAIVER' || isExecutedTrade(r);
export const isExecutedTrade = r => r.type === 'TRADE_ACCEPT' && r.status === 'EXECUTED' && r.execution_type === 'PROCESS';

const items = r => {
  try { return JSON.parse(r.items_json || '[]'); } catch (e) { throw new Error(`tx ${r.tx_id}: items_json is not JSON (${e.message})`); }
};

/**
 * Replay the league's transaction ledger up to (not including) cutMs.
 * Returns rosters (Map team -> Set player id: `base` (a captured lineup, known at baseMs)
 * or the draft, plus every executed add, drop and trade after it), each team's last action of any kind (lineup, add, proposal, reply, vote; the
 * draft itself excluded), each team's last roster move (lastMove: a free-agent or waiver claim
 * of any status, or an executed trade; r44's "last move" on Sleeper) and adds per scoring period.
 */
export function replayLedger(txRows, cutMs, { base = null, baseMs = -Infinity } = {}) {
  const rows = txRows.map(r => ({ r, t: txTime(r) })).filter(x => x.t != null && x.t < cutMs)
    .sort((a, b) => a.t - b.t || String(a.r.tx_id).localeCompare(String(b.r.tx_id)));
  const rosters = new Map(base ? [...base].map(([t, set]) => [String(t), new Set(set)]) : []);
  const lastAction = new Map();
  const lastMove = new Map();
  const adds = new Map();
  const seenTx = new Set();
  const of = team => { const k = String(team); if (!rosters.has(k)) rosters.set(k, new Set()); return rosters.get(k); };
  for (const { r, t } of rows) {
    const actor = Number(r.team_id) > 0 ? String(r.team_id) : null;
    if (actor && r.type !== 'DRAFT') {
      const prev = lastAction.get(actor);
      if (!prev || t > prev.at) lastAction.set(actor, { at: t, type: r.type });
    }
    if (IS_MOVE(r)) {
      const movers = new Set(actor ? [actor] : []);
      if (r.type === 'TRADE_ACCEPT') for (const i of items(r)) for (const x of [i.fromTeamId, i.toTeamId]) if (Number(x) > 0) movers.add(String(x));
      for (const m of movers) { const prev = lastMove.get(m); if (!prev || t > prev.at) lastMove.set(m, { at: t, type: r.type }); }
    }
    if (!ROSTER_MOVE(r)) continue;
    const moves = t > baseMs && !(base && r.type === 'DRAFT');
    const key = `${r.tx_id}|${r.type}`;
    if (seenTx.has(key)) continue;
    seenTx.add(key);
    for (const i of items(r)) {
      const pid = String(i.playerId);
      if (i.type === 'DRAFT' && Number(i.toTeamId) > 0) { if (moves) of(i.toTeamId).add(pid); }
      else if (i.type === 'ADD' && Number(i.toTeamId) > 0) {
        if (moves) of(i.toTeamId).add(pid);
        const team = String(i.toTeamId), wk = Number(r.scoring_period);
        if (Number.isFinite(wk)) {
          if (!adds.has(team)) adds.set(team, new Map());
          adds.get(team).set(wk, (adds.get(team).get(wk) ?? 0) + 1);
        }
      } else if (!moves) continue;
      else if (i.type === 'DROP' && Number(i.fromTeamId) > 0) of(i.fromTeamId).delete(pid);
      else if (i.type === 'TRADE') {
        if (Number(i.fromTeamId) > 0) of(i.fromTeamId).delete(pid);
        if (Number(i.toTeamId) > 0) of(i.toTeamId).add(pid);
      }
    }
  }
  return { rosters, lastAction, lastMove, adds };
}

/** Executed trades in the ledger: [{ tx_id, at, week, sides: Map team -> [player ids he gave] }]. */
export function executedTrades(txRows) {
  const out = new Map();
  for (const r of txRows) {
    if (!isExecutedTrade(r)) continue;
    if (out.has(r.tx_id)) continue;
    const sides = new Map();
    for (const i of items(r)) {
      if (i.type !== 'TRADE' || !(Number(i.fromTeamId) > 0)) continue;
      const k = String(i.fromTeamId);
      sides.set(k, [...(sides.get(k) ?? []), String(i.playerId)]);
    }
    out.set(r.tx_id, { tx_id: r.tx_id, at: txTime(r), week: Number(r.scoring_period), sides });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/* ================================================================== roster holes (pure) */

const FLEX_OK = Object.freeze({ FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] });
const normPos = p => (p === 'D/ST' || p === 'DST' ? 'DEF' : p ?? null);

/** Kicker and team defense are streamed off waivers every bye week: never a trade surface. */
export const STREAMED_SLOTS = Object.freeze(['K', 'DEF', 'D/ST']);

/** Slot list (roster_positions) -> { dedicated: {QB:1,..}, flex: [['RB','WR','TE'], ...] } (K/DEF left out). */
export function slotDemand(slots) {
  const dedicated = {};
  const flex = [];
  for (const s of slots) {
    if (FLEX_OK[s]) flex.push(FLEX_OK[s]);
    else if (s !== 'BENCH' && s !== 'IR' && !STREAMED_SLOTS.includes(s)) dedicated[s] = (dedicated[s] ?? 0) + 1;
  }
  return { dedicated, flex };
}

/** How many starting slots a set of available positions leaves empty (dedicated first, then flex). */
export function unfilledSlots(positions, demand) {
  const count = {};
  for (const p of positions) if (p) count[p] = (count[p] ?? 0) + 1;
  const holes = [];
  for (const [pos, need] of Object.entries(demand.dedicated)) {
    const have = count[pos] ?? 0;
    const used = Math.min(have, need);
    count[pos] = have - used;
    for (let i = used; i < need; i++) holes.push(pos);
  }
  // Most restrictive flex first.
  for (const elig of [...demand.flex].sort((a, b) => a.length - b.length)) {
    const pick = elig.filter(p => (count[p] ?? 0) > 0).sort((a, b) => count[b] - count[a])[0];
    if (pick) count[pick] -= 1; else holes.push(`FLEX(${elig.join('/')})`);
  }
  return holes;
}

/**
 * roster: [{ player, position, bye, ir, out_now }]; weeks: the weeks to check.
 * Returns the per-week holes and crunches plus the surface (or null when clear).
 */
export function rosterHoleSurface({ roster, slots, weeks, currentWeek, asOfMs, basis = null }) {
  const demand = slotDemand(slots);
  const unknownPos = roster.filter(p => !p.position).length;
  const perWeek = [];
  for (const w of weeks) {
    const avail = roster.filter(p => p.position && p.bye !== w && !p.ir && !(w === currentWeek && p.out_now));
    const holes = unfilledSlots(avail.map(p => p.position), demand);
    const onBye = roster.filter(p => p.bye === w && ['QB', 'RB', 'WR', 'TE'].includes(p.position));
    const crunch = onBye.length >= SCALES.crunch_min;
    if (holes.length || crunch) {
      perWeek.push({ week: w, unfillable_slots: holes, bye_out: onBye.map(p => ({ player: p.player, position: p.position })),
        crunch, near: w - currentWeek < SCALES.hole_near_weeks });
    }
  }
  const scoreOf = x => (x.near ? 1 : SCALES.hole_far_weight)
    * clamp(x.unfillable_slots.length / SCALES.hole_slots_full + (x.crunch ? SCALES.crunch_strength : 0), 0, 1);
  const worst = [...perWeek].sort((a, b) => scoreOf(b) - scoreOf(a) || a.week - b.week)[0];
  if (!worst || scoreOf(worst) <= 0) return { surface: null, weeks_checked: weeks.length, unknown_positions: unknownPos };
  return {
    unknown_positions: unknownPos, weeks_checked: weeks.length,
    surface: {
      kind: 'roster_hole', confidence: CONFIDENCE.measured, strength: r3(scoreOf(worst)), as_of: iso(asOfMs),
      signal: 'rosters + NFL schedule byes',
      evidence: {
        worst_week: worst.week, unfillable_slots: worst.unfillable_slots, bye_out: worst.bye_out, crunch: worst.crunch,
        weeks: perWeek.map(x => ({ week: x.week, unfillable: x.unfillable_slots.length, crunch: x.crunch })),
        roster_size: roster.length, unknown_positions: unknownPos, roster_basis: basis, streamed_slots_ignored: STREAMED_SLOTS.slice(0, 2),
        formula: `min(1, unfillable/${SCALES.hole_slots_full} + ${SCALES.crunch_strength} if >=${SCALES.crunch_min} on bye) x ${SCALES.hole_far_weight} beyond ${SCALES.hole_near_weeks} weeks (hand-set, fitted:false)`,
        seller_weight: SELLER_WEIGHT.roster_hole,
        measured_lift: `r44: not a seller signal. Managers with two unfillable slots next week sold within 14 days at ${pct(R44.roster_hole.seller_rate.two_holes)} vs ${pct(R44.roster_hole.seller_rate.no_hole)} with none (likely abandoned teams); a bye crunch ${pct(R44.roster_hole.seller_rate.bye_crunch)} vs ${pct(R44.roster_hole.seller_rate.no_crunch)}; adding holes made held-out log loss worse (${R44.roster_hole.logloss_gain} [${R44.roster_hole.ci[0]}, ${R44.roster_hole.ci[1]}]). Weight 0 in the seller ranking`,
        source: R44.source,
      },
      use: 'framing only (unproven as a reason he will deal): which position he is short that week',
    },
  };
}

/* ================================================================== activity intensity (pure) */

/**
 * The IDEA-084 PP intensity for week w = h + 1. history: [{ adds, pts, opp, dead, empty }]
 * for weeks 1..h (his), leagueMeanAdds: league mean adds per team-week over 1..h,
 * leagueMeanPts: league mean points per team-week over 1..h.
 */
export function ppIntensity(history, { leagueMeanAdds, leagueMeanPts }) {
  const h = history.length;
  const c = PP_ADDS;
  if (h < c.min_history) return { status: 'thin', reason: `${h} completed week(s); the model was fit on weeks 3+ (needs ${c.min_history})`, h };
  const N = history.reduce((s, x) => s + x.adds, 0);
  const l0 = Math.max((N + c.alpha * leagueMeanAdds) / (h + c.alpha), 1e-3);
  const last = history[h - 1], prev = history[h - 2];
  const lost = x => (x.pts < x.opp ? 1 : 0);
  const lost1 = lost(last);
  const streak2 = lost1 * lost(prev);
  const margin1 = clamp((last.pts - last.opp) / (leagueMeanPts || 1), -1, 1);
  const dead1 = Math.min(last.dead ?? 0, 3), empty1 = Math.min(last.empty ?? 0, 3);
  const wp = history.reduce((s, x) => s + (x.pts > x.opp ? 1 : x.pts === x.opp ? 0.5 : 0), 0) / h;
  let E = 0, S = 0;
  for (let k = 1; k <= h; k++) { const g = c.gamma ** (k - 1); E += g * history[h - k].adds; S += g; }
  const exc = Math.log1p(E) - Math.log1p(l0 * S);
  const w = h + 1;
  const eta = Math.log(l0) + c.const + c.logl0 * Math.log(l0) + (c.week[Math.min(w, 14)] ?? 0)
    + c.lost1 * lost1 + c.streak2 * streak2 + c.margin1 * margin1 + c.dead1 * dead1 + c.empty1 * empty1 + c.wp * wp + c.exc * exc;
  return { status: 'ok', lambda: Math.exp(eta), lambda0: l0, week: w, h,
    features: { lost1, streak2, margin1: r3(margin1), dead1, empty1, wp: r3(wp), exc: r3(exc), adds_to_date: N } };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

const pct = x => `${(x * 100).toFixed(1)}%`;
const binOf = (x, table) => table.find(([hi]) => x <= hi)[1];

/**
 * WEAK-02 recent_activity (replaces WEAK-01's attention_gap, which scored idleness as a
 * weakness; r44 found that backwards). Strength = SELLER.days bin of his days since his last
 * roster move (never moved: SELLER.never) x SELLER.intensity bin of how far his IDEA-084
 * intensity sits below the league median (1 before two completed weeks). Recent and busy
 * managers score high: the ones who actually sell.
 */
export function recentActivitySurface({ intensity, leagueLambdas, lastMove, lastAction = null, cutMs, asOfMs }) {
  // Whole days, so a published scan changes once a day, not every tick (write-on-change).
  const days = lastMove ? Math.floor((cutMs - lastMove.at) / DAY) : null;
  const recency = days == null ? SELLER.never : binOf(Math.max(0, days), SELLER.days);
  const med = intensity?.status === 'ok' ? median(leagueLambdas) : null;
  const below = med ? clamp((med - intensity.lambda) / med, 0, 1) : null;
  const mult = below == null ? 1 : binOf(below, SELLER.intensity);
  const strength = recency * mult;
  const r = R44.attention;
  return {
    surface: {
      kind: 'recent_activity', confidence: CONFIDENCE.proven, strength: r3(strength),
      as_of: iso(asOfMs), signal: 'activity_recency',
      evidence: {
        days_since_last_move: days, never_moved: days == null, last_move_type: lastMove?.type ?? null, last_move_at: iso(lastMove?.at),
        days_since_last_action: lastAction ? Math.floor((cutMs - lastAction.at) / DAY) : null, last_action_type: lastAction?.type ?? null,
        recency_weight: recency, intensity_weight: mult,
        intensity: intensity?.status === 'ok' ? { adds_next_week: r3(intensity.lambda), league_median: r3(med), below_median: r3(below),
          week: intensity.week, features: intensity.features, model: PP_ADDS.source } : { status: intensity?.status ?? 'unknown', reason: intensity?.reason ?? null },
        measured_lift: `r44: sold within 14 days at ${pct(r.seller_rate_by_days['0-3'])} when his last move was 0-3 days ago vs ${pct(r.seller_rate_by_days['30-60'])} at 30-60 days (never moved ${pct(r.seller_rate_by_days.never)}); held-out log-loss gain +${r.logloss_gain} [+${r.ci[0]}, +${r.ci[1]}], BH p ${r.bh_p.toFixed(4)}`,
        ranking_holdout: SELLER.holdout,
        formula: `days-since-last-move bin weight x intensity-gap bin weight (${SELLER.fit})`,
        source: R44.source,
        caveat: 'measured on Sleeper; transfer to this ESPN league is not validated. A move here is a free-agent or waiver claim or an executed trade (lineup sets and proposals do not count), as on Sleeper',
      },
      use: 'targets and timing: he is active and likely to deal now; open with an offer while he is moving',
    },
  };
}

/* ================================================================== desperation (pure) */

/** record: [{ week, pts, opp }] completed; standings: Map team -> wins; playoffTeams; odds: [{ as_of, p_playoffs }]. */
export function desperationSurface({ team, record, standings, playoffTeams, deadlineMs, cutMs, odds = [], asOfMs }) {
  if (!record.length && odds.length < 2) {
    return { surface: null, absent: 'no completed week and fewer than two served playoff-odds snapshots' };
  }
  const wins = standings.get(String(team)) ?? 0;
  const sorted = [...standings.values()].sort((a, b) => b - a);
  const line = sorted[Math.min(playoffTeams, sorted.length) - 1] ?? 0;
  const behind = Math.max(0, line - wins);
  let recentLosses = 0;
  for (let i = record.length - 1; i >= 0 && record[i].pts < record[i].opp; i--) recentLosses++;
  const daysToDeadline = deadlineMs ? Math.floor((deadlineMs - cutMs) / DAY) : null;
  const deadlineFactor = daysToDeadline == null ? 0.5 : daysToDeadline < 0 ? 0 : 0.5 + 0.5 * clamp(1 - daysToDeadline / SCALES.deadline_days, 0, 1);
  let oddsDrop = null;
  if (odds.length >= 2) oddsDrop = odds[0].p_playoffs - odds[odds.length - 1].p_playoffs;
  const base = clamp((behind + 0.5 * recentLosses) / SCALES.behind_full, 0, 1);
  const oddsPart = oddsDrop != null ? clamp(oddsDrop / SCALES.odds_drop_full, 0, 1) : 0;
  const strength = clamp(Math.max(base, oddsPart) * deadlineFactor, 0, 1);
  if (strength <= 0) return { surface: null };
  return {
    surface: {
      kind: 'desperation', confidence: CONFIDENCE.measured, strength: r3(strength), as_of: iso(asOfMs),
      signal: 'record, playoff line, deadline',
      evidence: {
        wins, losses: record.filter(x => x.pts < x.opp).length, games: record.length, playoff_line_wins: line, wins_behind_line: behind,
        losing_streak: recentLosses, playoff_teams: playoffTeams,
        days_to_deadline: r3(daysToDeadline), deadline_at: iso(deadlineMs),
        playoff_odds_trend: odds.length >= 2 ? { from: r3(odds[0].p_playoffs), to: r3(odds[odds.length - 1].p_playoffs), snapshots: odds.length }
          : { status: 'unknown', reason: `${odds.length} served playoff-odds snapshot(s); a trend needs two` },
        formula: `max((behind + 0.5 x losing streak)/${SCALES.behind_full}, odds drop/${SCALES.odds_drop_full}) x (0.5 + 0.5 x deadline closeness over ${SCALES.deadline_days} days) (hand-set, fitted:false)`,
        seller_weight: SELLER_WEIGHT.desperation,
        measured_lift: `r44: not a seller signal. Sold within 14 days at ${pct(R44.desperation.seller_rate_by_recent_losses[0])}, ${pct(R44.desperation.seller_rate_by_recent_losses[1])} and ${pct(R44.desperation.seller_rate_by_recent_losses[2])} after 0, 1 and 2 recent losses; held-out log-loss gain +${R44.desperation.logloss_gain} [${R44.desperation.ci[0]}, +${R44.desperation.ci[1]}], BH p ${R44.desperation.bh_p}. Weight 0 in the seller ranking`,
        source: R44.source,
      },
      use: 'framing only (unproven as a reason he will deal): he needs points now',
    },
  };
}

/* ================================================================== in market (pure) */

/**
 * cp: a people.counterpart value (publicModel shape) or null; nickRoster: Set of Nick's ids;
 * cred: CRED-01 rows for him ([{ stmt_type, window_days, status, lift_shrunk, n_statements, as_of }]) or null.
 */
export function inMarketSurface({ cp, cpAsOf = null, nickRoster, cred = null, credReason = null, asOfMs, wantsBefore = null }) {
  if (!cp) return { surface: null, absent: 'no people.counterpart row for him on the hub' };
  if (cp.status !== 'ok') return { surface: null, absent: `people.counterpart is ${cp.status}: ${cp.reason ?? 'no chat read'}` };
  const credProven = (cred ?? []).filter(r => r.status === 'proven');
  const credibility = {
    table: cred == null ? { status: 'unknown', reason: credReason ?? 'people_credibility table absent (CRED-01 #321 not merged here)' }
      : { rows: cred.length, proven: credProven.map(r => ({ stmt_type: r.stmt_type, window_days: r.window_days, lift: r3(r.lift_shrunk), n: r.n_statements, as_of: r.as_of })) },
    model: cp.credibility ?? null,
  };
  const wants = (cp.wants ?? []).filter(w => w.lift > 0 && (!wantsBefore || wantsBefore(w)));
  const scored = wants.map(w => {
    const onNick = nickRoster.has(String(w.player));
    return { player: String(w.player), n: w.n, lift: r3(w.lift), nick_has_him: onNick,
      strength: clamp(w.lift / SCALES.wants_prior, 0, 1) * (onNick ? 1 : SCALES.wants_not_nicks) };
  }).sort((a, b) => b.strength - a.strength);
  if (scored.length) {
    const top = scored[0];
    return {
      surface: {
        kind: 'in_market', confidence: CONFIDENCE.proven, strength: r3(top.strength), as_of: iso(maxMs(toMs(cpAsOf), asOfMs)),
        signal: 'wants_player',
        evidence: { wants: scored.slice(0, 5).map(({ strength, ...w }) => ({ ...w, strength: r3(strength) })),
          credibility, formula: `lift/${SCALES.wants_prior} x (${SCALES.wants_not_nicks} if Nick does not have him) (lift from people.counterpart: PEOPLE-LAB prior shrunk by mentions and decayed by age)` },
        use: 'targets: offer him the player he asked for; partner order',
      },
    };
  }
  const shopProven = credProven.find(r => /shop|avail|sell/i.test(r.stmt_type));
  if ((cp.shopping ?? []).length && shopProven) {
    return {
      surface: {
        kind: 'in_market', confidence: CONFIDENCE.proven, strength: r3(clamp(shopProven.lift_shrunk / 3, 0, 1)), as_of: iso(maxMs(toMs(cpAsOf), toMs(shopProven.as_of))),
        signal: 'credibility',
        evidence: { shopping: cp.shopping.slice(0, 5), credibility, formula: 'CRED-01 proven shop follow-through lift / 3 (hand-set scale)' },
        use: 'targets: he said these are available and his word on that has held',
      },
    };
  }
  return { surface: null, clear_reason: (cp.shopping ?? []).length ? 'shop talk only, and no proven credibility behind it' : 'no wants on record' };
}

/* ================================================================== value gap (pure) */

/**
 * reads: [{ player, owner ('his' | 'nick'), multiplier, sources: [..] }] from the valuation map
 * (his price as a multiple of our value). Sell: he prices a Nick player above ours. Buy: he
 * prices his own player below ours.
 */
export function valueGapSurface({ reads, asOfMs, readAsOf = null }) {
  if (reads == null) return { surface: null, absent: 'no valuation-map read for him' };
  const gaps = [];
  for (const r of reads) {
    const d = r.multiplier - 1;
    if (Math.abs(d) < SCALES.value_min) continue;
    if (r.owner === 'nick' && d > 0) gaps.push({ ...r, side: 'sell_to_him', gap: d });
    else if (r.owner === 'his' && d < 0) gaps.push({ ...r, side: 'buy_from_him', gap: d });
  }
  if (!gaps.length) return { surface: null, clear_reason: `no player priced ${SCALES.value_min * 100}%+ off our value in a direction Nick can use` };
  gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const top = gaps[0];
  return {
    surface: {
      kind: 'value_gap', confidence: CONFIDENCE.unproven, strength: r3(clamp(Math.abs(top.gap) / SCALES.value_cap, 0, 1)),
      as_of: iso(maxMs(toMs(readAsOf), asOfMs)), signal: 'valuation map (hand-set factors, fitted:false)',
      evidence: { gaps: gaps.slice(0, 5).map(g => ({ player: String(g.player), side: g.side, his_vs_ours: r3(g.multiplier), sources: g.sources })),
        our_value: 'our value = 1.0 by construction (his price = our value x the capped factors)',
        formula: `|his/ours - 1| / ${SCALES.value_cap} (the per-player cap)` },
      use: 'targets and framing: sell him what he prices high, buy what he prices low; never state his number as fact',
    },
  };
}

/* ================================================================== scan (pure) */

const scoreOf = s => s.strength * CONFIDENCE_WEIGHT[s.confidence] * (SELLER_WEIGHT[s.kind] ?? 1);

/**
 * One manager's scan from the per-kind results. results: { kind: { surface, absent?, clear_reason? } }.
 * Surfaces sorted by score, ranked 1..n.
 */
export function assembleScan({ team, leagueId, cutMs, results, stampMs = cutMs }) {
  const surfaces = [];
  const absent = [];
  const clear = [];
  for (const kind of SURFACE_KINDS) {
    const r = results[kind] ?? { surface: null, absent: 'not scanned' };
    if (r.surface) surfaces.push({ ...r.surface, score: r3(scoreOf(r.surface)) });
    else if (r.absent) absent.push({ kind, status: 'unknown', reason: r.absent });
    else clear.push({ kind, reason: r.clear_reason ?? 'scanned: nothing found' });
  }
  surfaces.sort((a, b) => b.score - a.score || SURFACE_KINDS.indexOf(a.kind) - SURFACE_KINDS.indexOf(b.kind));
  surfaces.forEach((s, i) => { s.rank = i + 1; });
  const top = surfaces.slice(0, SCALES.top_n);
  return {
    source: WEAKNESS_SOURCE, version: WEAKNESS_VERSION, league_id: leagueId, team: String(team), scan_cut: iso(stampMs),
    surfaces, absent, clear,
    top_score: r3(top.reduce((s, x) => s + x.score, 0)),
    honesty: 'facts for targets, timing and framing only; never a claim beyond the evidence',
  };
}

/**
 * Scan every counterparty of a league from gathered inputs (weaknessInputs, plus the hub's
 * counterpart values and optional value reads). Returns { cut, teams: Map team -> scan,
 * order: [team] by top_score }.
 */
export function scanLeague(inp, { counterparts = new Map(), counterpartAsOf = null, valueReads = null, valueReason = null,
  valueAsOf = null, wantsBefore = null, stampMs = null } = {}) {
  const { cutMs, teams, me } = inp;
  const others = teams.filter(t => t !== me);
  const nickRoster = inp.rosters.get(me) ?? new Set();
  // League-level activity context.
  const hist = new Map(teams.map(t => [t, inp.history.get(t) ?? []]));
  const h = inp.completedWeeks.length;
  const allAdds = teams.flatMap(t => hist.get(t).map(x => x.adds));
  const allPts = teams.flatMap(t => hist.get(t).map(x => x.pts));
  const leagueMeanAdds = allAdds.length ? allAdds.reduce((a, b) => a + b, 0) / allAdds.length : 0;
  const leagueMeanPts = allPts.length ? allPts.reduce((a, b) => a + b, 0) / allPts.length : 0;
  const intensity = new Map(teams.map(t => [t, ppIntensity(hist.get(t), { leagueMeanAdds, leagueMeanPts })]));
  const lambdas = [...intensity.values()].filter(x => x.status === 'ok').map(x => x.lambda);
  const standings = new Map(teams.map(t => [t, hist.get(t).reduce((s, x) => s + (x.pts > x.opp ? 1 : x.pts === x.opp ? 0.5 : 0), 0)]));
  const weeks = [];
  for (let w = inp.currentWeek; w <= inp.lastRegularWeek; w++) weeks.push(w);
  const scans = new Map();
  for (const team of others) {
    const roster = [...(inp.rosters.get(team) ?? [])].map(pid => ({ player: pid, ...(inp.playerInfo.get(pid) ?? {}) }))
      .map(p => ({ ...p, position: normPos(p.position) }));
    const results = {
      roster_hole: roster.length ? rosterHoleSurface({ roster, slots: inp.slots, weeks, currentWeek: inp.currentWeek, asOfMs: inp.rosterAsOf, basis: inp.rosterBasis })
        : { surface: null, absent: 'no roster for him as of the cut' },
      value_gap: valueReads ? valueGapSurface({ reads: valueReads.get(team) ?? null, asOfMs: inp.rosterAsOf, readAsOf: valueAsOf })
        : { surface: null, absent: valueReason ?? 'valuation map not read' },
      desperation: desperationSurface({ team, record: hist.get(team), standings, playoffTeams: inp.playoffTeams,
        deadlineMs: inp.deadlineMs, cutMs, odds: inp.odds.get(team) ?? [], asOfMs: maxMs(inp.scoresAsOf, (inp.odds.get(team) ?? []).map(o => toMs(o.as_of))) }),
      recent_activity: recentActivitySurface({ intensity: intensity.get(team), leagueLambdas: lambdas, lastMove: inp.lastMove?.get(team) ?? null,
        lastAction: inp.lastAction.get(team) ?? null, cutMs, asOfMs: maxMs(inp.lastMove?.get(team)?.at, h ? inp.scoresAsOf : null) ?? stampMs ?? cutMs }),
      in_market: inMarketSurface({ cp: counterparts.get(team) ?? null, cpAsOf: counterpartAsOf, nickRoster,
        cred: inp.credibility == null ? null : inp.credibility.filter(r => String(r.roster_id) === team),
        credReason: inp.credibilityReason, asOfMs: null, wantsBefore }),
    };
    scans.set(team, assembleScan({ team, leagueId: inp.leagueId, cutMs, results, stampMs: stampMs ?? cutMs }));
  }
  const order = [...scans.values()].sort((a, b) => b.top_score - a.top_score || Number(a.team) - Number(b.team)).map(s => s.team);
  order.forEach((t, i) => { scans.get(t).league_rank = i + 1; scans.get(t).league_size = order.length; });
  return { cut: iso(stampMs ?? cutMs), teams: scans, order };
}

/* ================================================================== metric + retro (pure) */

/** The WEAK-01 metric over one league scan. */
export function scanMetrics(scan) {
  const all = [...scan.teams.values()];
  const surfaces = all.flatMap(s => s.surfaces);
  const withEvidence = surfaces.filter(s => s.evidence && Object.keys(s.evidence).length && s.as_of);
  const proven = surfaces.filter(s => s.confidence === CONFIDENCE.proven);
  const provenOk = proven.filter(s => PROVEN_SIGNALS.includes(s.signal));
  const byKind = Object.fromEntries(SURFACE_KINDS.map(k => [k, {
    surfaces: surfaces.filter(s => s.kind === k).length,
    absent: all.filter(s => s.absent.some(a => a.kind === k)).length,
    clear: all.filter(s => s.clear.some(a => a.kind === k)).length }]));
  return {
    managers_scanned: all.length,
    surfaces: surfaces.length,
    surfaces_per_manager: all.map(s => s.surfaces.length),
    share_with_evidence_and_as_of: surfaces.length ? r3(withEvidence.length / surfaces.length) : null,
    proven: proven.length, proven_on_tested_signal: provenOk.length,
    share_proven_on_tested_signal: proven.length ? r3(provenOk.length / proven.length) : null,
    labels: Object.fromEntries(Object.values(CONFIDENCE).map(c => [c, surfaces.filter(s => s.confidence === c).length])),
    by_kind: byKind,
  };
}

/**
 * Retro check: for each executed trade in `weeks`, every counterparty side that gave players
 * (a seller) is scored on the scan as of one millisecond before the trade: hit when his league
 * rank by top_score was <= topN. Baseline: topN / managers (a random manager's chance).
 * scanAt(ms) -> (a promise of) a scanLeague result. Descriptive only (n small).
 */
export async function retroCheck({ trades, me, scanAt, weeks = [1, 2], topN = SCALES.top_n }) {
  const obs = [];
  for (const t of trades.filter(x => weeks.includes(x.week))) {
    const scan = await scanAt(t.at - 1);
    for (const [team] of t.sides) {
      if (team === me) continue;
      const s = scan.teams.get(team);
      if (!s) continue;
      obs.push({ tx: String(t.tx_id).slice(0, 8), week: t.week, seller: team, with_nick: t.sides.has(me),
        rank: s.league_rank, of: s.league_size, hit: s.league_rank <= topN,
        top_kind: s.surfaces[0]?.kind ?? null, top_score: s.top_score });
    }
  }
  const n = obs.length;
  const hits = obs.filter(o => o.hit).length;
  const size = obs[0]?.of ?? null;
  return { n, hits, share: n ? r3(hits / n) : null, baseline: size ? r3(topN / size) : null, top_n: topN, observations: obs,
    note: 'descriptive: tiny n, sides of one trade are not independent, and week-1 scans have no completed games' };
}

/* ================================================================== inputs (DB, as of a cut) */

const PRO_TEAM_FALLBACK = null;

async function dbHandle(database) {
  if (database) return database;
  return (await import('../../db/index.js')).db;
}

/**
 * Everything the scan reads for one league, as of cutMs (nothing after the cut).
 * Never selects credential columns from `leagues`.
 */
export async function weaknessInputs(leagueId, { cutMs, database = null, proTeam = PRO_TEAM_FALLBACK } = {}) {
  const db = await dbHandle(database);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const lg = db.prepare(`SELECT id, season, my_team_id, roster_positions,
      json_extract(payload, '$.settings.tradeSettings.deadlineDate') AS deadline,
      json_extract(payload, '$.settings.scheduleSettings.playoffTeamCount') AS playoff_teams,
      json_extract(payload, '$.settings.scheduleSettings.matchupPeriodCount') AS reg_weeks
    FROM leagues WHERE id = ?`).get(Number(leagueId));
  if (!lg) throw new Error(`league ${leagueId} not found`);
  const season = Number(lg.season);
  const me = lg.my_team_id == null ? null : String(lg.my_team_id);
  const slots = lg.roster_positions ? JSON.parse(lg.roster_positions) : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
  let tx = [];
  try {
    tx = all(`SELECT tx_id, type, status, execution_type, team_id, scoring_period, items_json, proposed_at, processed_at
      FROM league_transactions_raw WHERE league_id = ? AND season = ?`, lg.id, season);
  } catch (e) { if (!/no such table/.test(String(e?.message))) throw e; }

  // Weeks complete as of the cut: the week's last NFL game date + 1 day is before the cut.
  const weekEnd = new Map(all(`SELECT week, MAX(date) AS last FROM schedule_games WHERE season = ? GROUP BY week`, season)
    .map(r => [Number(r.week), toMs(`${r.last}T23:59:59Z`) + DAY]));
  const regWeeks = Number(lg.reg_weeks) || 14;
  const completedWeeks = [];
  for (let w = 1; w <= regWeeks; w++) { if (weekEnd.get(w) != null && weekEnd.get(w) <= cutMs) completedWeeks.push(w); else break; }
  const currentWeek = completedWeeks.length + 1;

  // Rosters as of the cut. The ESPN transaction feed has gaps (some executed trades never
  // appear in it), so the base is a captured lineup: the current week's when it was captured
  // before the cut, else the last completed week's final lineup (known at that week's end);
  // the draft only before any week is complete. Ledger moves after the base are applied.
  const snapTeams = all(`SELECT scoring_period_id AS w, team_id, espn_player_id, MIN(first_seen_at) AS seen
    FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND on_roster = 1 AND team_id > 0
    GROUP BY scoring_period_id, team_id, espn_player_id`, lg.id, season);
  const periodSeen = new Map();
  for (const r of snapTeams) { const t = toMs(r.seen); if (t != null) periodSeen.set(r.w, Math.max(periodSeen.get(r.w) ?? 0, t)); }
  let baseWeek = null, baseMs = -Infinity, rosterBasis = 'draft + transaction ledger';
  if (periodSeen.has(currentWeek) && periodSeen.get(currentWeek) <= cutMs) {
    baseWeek = currentWeek; baseMs = periodSeen.get(currentWeek);
    rosterBasis = `week ${currentWeek} lineup captured ${iso(baseMs)} + later ledger moves`;
  } else if (completedWeeks.length && periodSeen.has(completedWeeks.at(-1))) {
    baseWeek = completedWeeks.at(-1); baseMs = weekEnd.get(baseWeek);
    rosterBasis = `week ${baseWeek} final lineup (known ${iso(baseMs)}) + later ledger moves`;
  }
  let base = null;
  if (baseWeek != null) {
    base = new Map();
    for (const r of snapTeams) {
      if (r.w !== baseWeek) continue;
      const k = String(r.team_id);
      if (!base.has(k)) base.set(k, new Set());
      base.get(k).add(String(r.espn_player_id));
    }
  }
  const ledger = replayLedger(tx, cutMs, { base, baseMs });

  // Scores (completed weeks only).
  const scores = all(`SELECT week, roster_id, points, opponent_roster_id, captured_at FROM league_week_scores
    WHERE league_id = ? AND season = ? AND week <= ?`, lg.id, season, completedWeeks.length);
  const ptsOf = new Map(scores.map(r => [`${r.week}|${r.roster_id}`, Number(r.points)]));
  // Dead / empty starters per completed week from the period lineups.
  const lineups = completedWeeks.length ? all(`SELECT scoring_period_id AS w, team_id, is_starter, actual_points
    FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id <= ?`, lg.id, season, completedWeeks.length) : [];
  const startSlots = slots.filter(s => s !== 'BENCH' && s !== 'IR').length;
  const dead = new Map(), started = new Map();
  for (const r of lineups) {
    if (!r.is_starter) continue;
    const k = `${r.w}|${r.team_id}`;
    started.set(k, (started.get(k) ?? 0) + 1);
    if (r.actual_points == null || Number(r.actual_points) === 0) dead.set(k, (dead.get(k) ?? 0) + 1);
  }
  const teams = new Set([...ledger.rosters.keys()]);
  for (const r of scores) teams.add(String(r.roster_id));
  if (me) teams.add(me);
  const teamList = [...teams].sort((a, b) => Number(a) - Number(b));
  const history = new Map();
  for (const t of teamList) {
    history.set(t, completedWeeks.map(w => {
      const s = scores.find(r => Number(r.week) === w && String(r.roster_id) === t);
      const k = `${w}|${t}`;
      return { week: w, adds: ledger.adds.get(t)?.get(w) ?? 0, pts: Number(s?.points ?? 0),
        opp: s ? (ptsOf.get(`${w}|${s.opponent_roster_id}`) ?? 0) : 0,
        dead: dead.get(k) ?? 0, empty: started.has(k) ? Math.max(0, startSlots - started.get(k)) : 0 };
    }).filter((x, i) => scores.some(r => Number(r.week) === completedWeeks[i] && String(r.roster_id) === t)));
  }
  const scoresAsOf = completedWeeks.length ? weekEnd.get(completedWeeks.at(-1)) : null;

  // Player facts: position and NFL team (static), IR / out only from a lineup captured before the cut.
  const byes = new Map();
  const weeksByAbbr = new Map();
  for (const r of all(`SELECT t.abbr, g.week FROM schedule_games g JOIN nfl_teams t ON t.id = g.team_id WHERE g.season = ?`, season)) {
    if (!weeksByAbbr.has(r.abbr)) weeksByAbbr.set(r.abbr, new Set());
    weeksByAbbr.get(r.abbr).add(Number(r.week));
  }
  for (const [abbr, set] of weeksByAbbr) {
    if (set.size < 15) continue;
    for (let w = 1; w <= Math.max(...set); w++) if (!set.has(w)) { byes.set(abbr, w); break; }
  }
  const PRO = proTeam ?? (await import('../espn-draft.js')).PRO_TEAM;
  const playerInfo = new Map();
  const snapRows = all(`SELECT espn_player_id, position, pro_team_id, scoring_period_id, injury_status, lineup_slot_id, changed_at
    FROM league_roster_snapshots WHERE league_id = ? AND season = ? ORDER BY scoring_period_id`, lg.id, season);
  let rosterAsOf = null;
  const latestCaptured = new Map();
  for (const r of snapRows) {
    const pid = String(r.espn_player_id);
    const info = playerInfo.get(pid) ?? {};
    info.position = info.position ?? r.position ?? null;
    if (r.pro_team_id != null) info.bye = byes.get(PRO[Number(r.pro_team_id)]) ?? info.bye ?? null;
    playerInfo.set(pid, info);
    const at = toMs(r.changed_at);
    if (at != null && at <= cutMs) {
      const prev = latestCaptured.get(pid);
      if (!prev || r.scoring_period_id >= prev.w) latestCaptured.set(pid, { w: r.scoring_period_id, ir: Number(r.lineup_slot_id) === 21 || r.injury_status === 'INJURY_RESERVE', out: r.injury_status === 'OUT' });
      rosterAsOf = maxMs(rosterAsOf, at);
    }
  }
  for (const [pid, c] of latestCaptured) { const i = playerInfo.get(pid); i.ir = c.ir; i.out_now = c.out; }
  // D/ST ids are negative ESPN ids; the position is DEF even when no lineup recorded it.
  for (const set of ledger.rosters.values()) for (const pid of set) {
    if (!playerInfo.has(pid)) playerInfo.set(pid, {});
    if (Number(pid) < 0 && !playerInfo.get(pid).position) playerInfo.get(pid).position = 'DEF';
  }
  const lastTx = maxMs(tx.map(txTime).filter(t => t != null && t < cutMs));
  rosterAsOf = maxMs(rosterAsOf, lastTx);

  // Served playoff odds, as of the cut.
  const odds = new Map();
  try {
    for (const r of all(`SELECT team_id, p_playoffs, as_of FROM title_odds_snapshots WHERE league_id = ? AND season = ?
        AND p_playoffs IS NOT NULL ORDER BY as_of`, lg.id, season)) {
      if (toMs(r.as_of) == null || toMs(r.as_of) > cutMs) continue;
      const k = String(r.team_id);
      odds.set(k, [...(odds.get(k) ?? []), { as_of: r.as_of, p_playoffs: Number(r.p_playoffs) }]);
    }
  } catch (e) { if (!/no such table/.test(String(e?.message))) throw e; }

  // CRED-01 credibility (newest run at or before the cut), if the table exists.
  let credibility = null, credibilityReason = null;
  try {
    const cutIso = iso(cutMs);
    const asOf = db.prepare(`SELECT MAX(as_of) AS a FROM people_credibility WHERE league_id = ? AND as_of <= ?`).get(lg.id, cutIso)?.a;
    if (asOf) credibility = all(`SELECT roster_id, stmt_type, window_days, status, lift_shrunk, n_statements, as_of
      FROM people_credibility WHERE league_id = ? AND as_of = ?`, lg.id, asOf);
    else credibilityReason = 'people_credibility has no run for this league at or before the cut';
  } catch (e) {
    if (!/no such table/.test(String(e?.message))) throw e;
    credibilityReason = 'people_credibility table absent (CRED-01 #321 not merged here)';
  }

  return {
    leagueId: lg.id, season, me, cutMs, slots, rosterBasis, teams: teamList, rosters: ledger.rosters, lastAction: ledger.lastAction, lastMove: ledger.lastMove,
    history, completedWeeks, currentWeek, lastRegularWeek: regWeeks, playoffTeams: Number(lg.playoff_teams) || 6,
    deadlineMs: toMs(lg.deadline), playerInfo, rosterAsOf, scoresAsOf, odds, credibility, credibilityReason,
  };
}

/**
 * Value reads from the valuation map (counterparty-pricing.js): for each counterparty, his
 * price as a multiple of our value on every player Nick has and every player he has.
 * Returns { reads: Map team -> [{ player, owner, multiplier, sources }], as_of, reason }.
 * Not as-of safe (the map reads today's chat and archetypes), so a replay of a past date
 * must not call it.
 */
export async function valueReads(inp, { season = inp.season, week = inp.currentWeek, asOfMs = null } = {}) {
  const cp = await import('../counterparty-pricing.js');
  const layer = cp.counterpartyLayer(inp.leagueId, { season, week });
  if (!layer?.size) return { reads: null, reason: 'valuation map has no manager signals for this league' };
  const db = (await import('../../db/index.js')).db;
  const names = new Map(db.prepare(`SELECT espn_player_id AS id, MAX(player_name) AS name, MAX(position) AS position
      FROM league_roster_snapshots WHERE league_id = ? AND season = ? GROUP BY espn_player_id`).all(inp.leagueId, inp.season)
    .map(r => [String(r.id), r]));
  const nick = inp.rosters.get(inp.me) ?? new Set();
  const reads = new Map();
  for (const [team, m] of layer) {
    const t = String(team);
    if (t === inp.me) continue;
    const out = [];
    const his = inp.rosters.get(t) ?? new Set();
    for (const [owner, set] of [['nick', nick], ['his', his]]) {
      for (const pid of set) {
        const n = names.get(pid);
        if (!n?.name) continue;
        const v = cp.playerValuation(m, { name: n.name, position: n.position, value: 1 });
        out.push({ player: pid, owner, multiplier: v.multiplier, sources: v.factors.map(f => f.source) });
      }
    }
    reads.set(t, out);
  }
  return { reads, as_of: iso(asOfMs ?? Date.now()), reason: null };
}

/**
 * The WEAK-01 measurement for one league (read-only): scan as of `cutMs` with the hub's
 * people.counterpart (or, when the hub has no rows, the same producer function the hub
 * publishes, directPeople), the valuation map, the metric, and the retro check on weeks 1-2's
 * executed trades (as-of safe kinds only: roster_hole, desperation, recent_activity).
 */
export async function measureLeague(leagueId, { cutMs = Date.now(), retroWeeks = [1, 2] } = {}) {
  const inp = await weaknessInputs(leagueId, { cutMs });
  const { counterparts, counterpartAsOf, counterpartSource } = await counterpartValues(leagueId, { asOf: iso(cutMs) });
  let vr;
  try { vr = await valueReads(inp); } catch (e) { vr = { reads: null, reason: `valuation map failed: ${e.message}` }; }
  const scan = scanLeague(inp, { counterparts, counterpartAsOf, valueReads: vr.reads, valueReason: vr.reason, valueAsOf: vr.as_of });
  const db = (await import('../../db/index.js')).db;
  const tx = db.prepare(`SELECT tx_id, type, status, execution_type, team_id, scoring_period, items_json, proposed_at, processed_at
    FROM league_transactions_raw WHERE league_id = ? AND season = ?`).all(inp.leagueId, inp.season);
  const notAsOf = 'not as-of safe for a replay (chat profile and valuation map are built today)';
  const retro = await retroCheck({ trades: executedTrades(tx), me: inp.me, weeks: retroWeeks,
    scanAt: async ms => scanLeague(await weaknessInputs(leagueId, { cutMs: ms }), { valueReason: notAsOf, counterparts: new Map() }) });
  return { league_id: inp.leagueId, cut: iso(cutMs), current_week: inp.currentWeek, counterpart_source: counterpartSource,
    metric: scanMetrics(scan), order: scan.order, retro, scan };
}

/** people.counterpart values for a league: the hub first; the producer's own direct build when the hub is empty. */
export async function counterpartValues(leagueId, { asOf }) {
  const hub = await import('./hub-read.js');
  const h = await hub.hubPeopleCounterpart(leagueId, { asOf });
  if (h.available) {
    return { counterparts: new Map([...h.byRoster].filter(([, e]) => e.value).map(([t, e]) => [t, e.value])),
      counterpartAsOf: h.as_of, counterpartSource: 'hub (engine_state people.counterpart)' };
  }
  const people = await import('../engine/producers/people.js');
  const league = (await people.peopleLeagues()).find(l => l.id === Number(leagueId));
  if (!league) return { counterparts: new Map(), counterpartAsOf: null, counterpartSource: `none: ${h.reason}` };
  const d = await people.directPeople(league, { asOf });
  return { counterparts: new Map([...d.counterparts].map(([t, cp]) => [t, people.counterpartValue(cp, { modelNow: d.now })])),
    counterpartAsOf: iso(d.now), counterpartSource: `direct producer build (hub empty: ${h.reason})` };
}
