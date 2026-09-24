/**
 * BANDIT-01 (IDEA-037, people-model M5): which message framing to pitch a
 * manager with, learned from his replies by Thompson sampling.
 *
 * ARMS. Four framings (PITCH_ARMS in campaign/plans-schema.js, so the War Room
 * contract and this module cannot drift): need-based ("this fills your hole"),
 * value-based ("the numbers favour you"), face-saving ("you get to say you won
 * it"), urgency ("this is open until the waiver run"). One arm per sent offer.
 *
 * EVIDENCE. A `trade_outcomes` row counts only when Nick sent it (`sent_at`,
 * migration 080), it carries an arm (`pitch_json`, migration 087), and ESPN has
 * answered it. Reward: accepted = 1, declined = 0, expired = 0 (silence is a
 * no), countered = COUNTER_REWARD. A counter is engagement without a yes; 0.5
 * is a pre-registered guess, not a fit (docs/tdd/pitch-bandit.tdd.md).
 *
 * PRIOR, SHARED. For manager m and arm k, the prior is Beta(1, 1) plus the
 * OTHER managers' replies on k, shrunk to at most PRIOR_STRENGTH pseudo-offers:
 *   p = (S_others + 1) / (N_others + 2),  w = min(N_others, PRIOR_STRENGTH)
 *   prior = Beta(1 + w p, 1 + w (1 - p))
 * His own replies are never in his prior, so nothing is counted twice. The
 * posterior adds his own: Beta(prior_a + S_m, prior_b + N_m - S_m).
 *
 * OFFLINE. Nothing reads the suggested arm to change a number or a message;
 * the bandit only reports, and it reports "learning, n=<graded offers>" until
 * something grades it (JEV-01b `pitch_framing`). It is default-off: a
 * suggestion is served only under preview mode (preview-mode.js).
 */
import { rows, row, run } from '../db/index.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';
import { PITCH_ARMS } from './campaign/plans-schema.js';

export { PITCH_ARMS };
/** Most pseudo-offers the other managers' replies may lend one manager's prior. */
export const PRIOR_STRENGTH = 4;
/** Reward for a counter. A guess, pre-registered, not fitted. */
export const COUNTER_REWARD = 0.5;
export const PREVIEW_REASON = 'pitch bandit is default-off (BANDIT-01): no sent offer has been graded by framing yet, so its pick is exploration, not advice';
const CHOSEN_BY = ['nick', 'thompson'];
const REWARD = { accepted: 1, declined: 0, expired: 0, countered: COUNTER_REWARD };

const hasPitchColumn = () => rows(`PRAGMA table_info(trade_outcomes)`).some(c => c.name === 'pitch_json');
const label = n => `learning, n=${n}`;

/**
 * Record which framing a sent offer used. Refuses an unknown arm, a row that
 * was never sent, and a row that already has one: an arm changed after the
 * reply would grade the wrong framing.
 */
export function recordPitchArm(outcomeId, arm, { chosen_by = 'nick' } = {}) {
  if (!PITCH_ARMS.includes(arm)) throw new Error(`pitch-bandit: arm must be one of ${PITCH_ARMS.join(', ')}`);
  if (!CHOSEN_BY.includes(chosen_by)) throw new Error(`pitch-bandit: chosen_by must be one of ${CHOSEN_BY.join(', ')}`);
  if (!hasPitchColumn()) throw new Error('pitch-bandit: trade_outcomes.pitch_json does not exist — migration 087 has not run here');
  const o = row(`SELECT id, sent_at, pitch_json FROM trade_outcomes WHERE id = ?`, outcomeId);
  if (!o) throw new Error(`pitch-bandit: no trade_outcomes row ${outcomeId}`);
  if (!o.sent_at) throw new Error(`pitch-bandit: row ${outcomeId} was never sent; only a sent offer has a framing`);
  if (o.pitch_json != null) throw new Error(`pitch-bandit: row ${outcomeId} already has a pitch arm`);
  run(`UPDATE trade_outcomes SET pitch_json = ? WHERE id = ?`, JSON.stringify({ v: 1, arm, chosen_by }), outcomeId);
}

const emptyArms = () => Object.fromEntries(PITCH_ARMS.map(a => [a, { n: 0, s: 0 }]));

/**
 * Graded, armed, sent offers by counterparty and arm.
 * @returns {{ n: number, byManager: Map<string, Record<string, {n:number,s:number}>>,
 *   byArm: Record<string, {n:number,s:number}>, excluded: {pending:number, unarmed:number, unknown_arm:number},
 *   reason?: string }}
 */
export function pitchCounts(leagueId, season) {
  const out = { n: 0, byManager: new Map(), byArm: emptyArms(), excluded: { pending: 0, unarmed: 0, unknown_arm: 0 } };
  if (!hasPitchColumn()) return { ...out, reason: 'trade_outcomes.pitch_json does not exist — migration 087 has not run here' };
  const sent = rows(`SELECT counterparty_team_id, status, pitch_json FROM trade_outcomes
    WHERE league_id = ? AND season = ? AND source = 'app_proposed' AND sent_at IS NOT NULL`, leagueId, season);
  for (const o of sent) {
    if (o.pitch_json == null) { out.excluded.unarmed += 1; continue; }
    const arm = JSON.parse(o.pitch_json)?.arm;
    if (!PITCH_ARMS.includes(arm)) { out.excluded.unknown_arm += 1; continue; }
    if (!(o.status in REWARD)) { out.excluded.pending += 1; continue; }
    const team = String(o.counterparty_team_id);
    if (!out.byManager.has(team)) out.byManager.set(team, emptyArms());
    for (const cell of [out.byManager.get(team)[arm], out.byArm[arm]]) {
      cell.n += 1; cell.s += REWARD[o.status];
    }
    out.n += 1;
  }
  return out;
}

/** Per-arm Beta posterior for one manager, with the shared prior spelled out. */
export function posteriorFor(counts, teamId) {
  const own = counts.byManager.get(String(teamId)) ?? emptyArms();
  return Object.fromEntries(PITCH_ARMS.map(arm => {
    const N = counts.byArm[arm].n - own[arm].n;
    const S = counts.byArm[arm].s - own[arm].s;
    const p = (S + 1) / (N + 2);
    const w = Math.min(N, PRIOR_STRENGTH);
    const prior_alpha = 1 + w * p;
    const prior_beta = 1 + w * (1 - p);
    return [arm, {
      prior_alpha, prior_beta, n_others: N,
      n: own[arm].n, s: own[arm].s,
      alpha: prior_alpha + own[arm].s,
      beta: prior_beta + own[arm].n - own[arm].s,
    }];
  }));
}

/* ------------------------------------------------------------- sampling */

/** mulberry32: a small seeded RNG in [0, 1), so a pick can be replayed. */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  const u = 1 - rng(); // (0, 1]: log(0) is not a number
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) by Marsaglia-Tsang; shape < 1 via the U^(1/shape) boost. */
function sampleGamma(shape, rng) {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = 1 - rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** One draw from Beta(a, b). */
export function sampleBeta(a, b, rng = Math.random) {
  if (!(a > 0 && b > 0)) throw new Error(`pitch-bandit: Beta needs a, b > 0 (got ${a}, ${b})`);
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

/** Thompson sampling: one draw per arm, the largest wins. */
export function thompsonPick(posterior, rng = Math.random) {
  let best = null;
  const draws = {};
  for (const arm of PITCH_ARMS) {
    const { alpha, beta } = posterior[arm];
    draws[arm] = sampleBeta(alpha, beta, rng);
    if (best === null || draws[arm] > draws[best]) best = arm;
  }
  return { arm: best, draws };
}

/* ------------------------------------------------------------- surfaces */

/** The bandit for one manager: his arms, and (preview only) the arm to try next. */
export function pitchBandit(leagueId, season, { teamId, rng = Math.random } = {}) {
  const counts = pitchCounts(leagueId, season);
  const post = posteriorFor(counts, teamId);
  const n = PITCH_ARMS.reduce((t, a) => t + post[a].n, 0);
  const arms = PITCH_ARMS.map(arm => {
    const p = post[arm];
    // A flat prior is not a 50% measurement: no reply anywhere, no rate.
    const informed = p.n + p.n_others > 0;
    return { arm, n: p.n, s: p.s, n_others: p.n_others, alpha: p.alpha, beta: p.beta,
      prior_alpha: p.prior_alpha, prior_beta: p.prior_beta,
      mean: informed ? p.alpha / (p.alpha + p.beta) : null };
  });
  const base = { league_id: leagueId, team_id: teamId == null ? null : String(teamId),
    state: 'learning', n, label: label(n), arms, excluded: counts.excluded,
    ...(counts.reason ? { data_reason: counts.reason } : {}) };
  if (!previewUnconfirmed()) {
    return { ...base, enabled: false, suggested_arm: null,
      reason: `${PREVIEW_REASON}. It shows only in preview mode.` };
  }
  return { ...base, enabled: true, ...previewFields(PREVIEW_REASON), suggested_arm: thompsonPick(post, rng).arm };
}

/**
 * The War Room plans section `pitch_bandit` (plans-schema.js): league-wide
 * counts, plus each manager with a graded pitch and his next arm. 'unknown'
 * unless preview mode is on, so a default page never shows a pick.
 */
export function pitchBanditSection(leagueId, season, { rng = Math.random } = {}) {
  const source = 'pitch.bandit';
  if (!previewUnconfirmed()) return { status: 'unknown', source, reason: `${PREVIEW_REASON}. It shows only in preview mode.` };
  const counts = pitchCounts(leagueId, season);
  const managers = [...counts.byManager.keys()].sort().map(team_id => {
    const post = posteriorFor(counts, team_id);
    return { team_id, n: PITCH_ARMS.reduce((t, a) => t + post[a].n, 0), suggested_arm: thompsonPick(post, rng).arm };
  });
  return {
    status: 'ok', source, n: counts.n,
    value: {
      state: 'learning', label: label(counts.n), n: counts.n, preview: true,
      arms: PITCH_ARMS.map(arm => ({ arm, n: counts.byArm[arm].n, s: counts.byArm[arm].s })),
      managers,
    },
  };
}
