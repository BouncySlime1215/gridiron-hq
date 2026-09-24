/**
 * BLEND-01: this week's points, blended with ESPN's weekly projection.
 *
 * One producer. trade-engine.js#buildAssetUniverse builds `current_week_ppg` for every
 * weekly page (Start/Sit, the League Hub card, the waiver board, the matchup card, the
 * trade pill all read it), and it passes its own number through servedWeekBlend() at the
 * one line where that number is made. Nothing else in the app blends.
 *
 * WHICH blend is served was chosen by a pre-registered tournament of seven candidates
 * (docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md; runner
 * scripts/weekly-blend-tournament.mjs, which grades THESE functions, not copies):
 *   ours         our number alone (the incumbent)
 *   espn         ESPN's weekly projection alone
 *   half         50/50
 *   news         ours, except ESPN's number when late news lands (the trigger below)
 *   fit_shrunk   one weight fit on 2022-2024, shrunk toward 50/50
 *   pos_phase    a weight per position and season phase, shrunk toward fit_shrunk's
 *   espn_proven  ESPN plus our disagreement, only in the cells where it was proven
 * TOURNAMENT_DECISION below records the winner and its ship rule; SERVED_BLEND serves it only
 * once SERVING_HOLDS is empty (today it is not, so ours is served, labelled 'blend_off').
 *
 * ESPN's number is a model input only: it prices this week's number and is never shown as
 * odds or as a pick of its own.
 *
 * Where it comes from: league_roster_snapshots.projected_points (migration 058, writer
 * scripts/collect-roster-snapshots.mjs:109 writePeriod, value built at :92), the current
 * scoring period's rostered rows, for this league and any league that scores identically
 * (ESPN's number is league-scored). Leagues that disagree by more than 0.01 give no value.
 * A player with no value keeps our number, labelled `no_espn_value`: free agents are only
 * covered when someone in another identically scored league rosters them.
 */
import { rows } from '../db/index.js';
import { scoringFor } from './scoring.js';

/** The graded positions. K and DEF keep our number (the tournament graded QB/RB/WR/TE only). */
export const BLEND_POSITIONS = Object.freeze(new Set(['QB', 'RB', 'WR', 'TE']));
/** Season phases for pos_phase and espn_proven (HX-01's week bands; week 1 counts as 2-4). */
export const PHASES = Object.freeze(['2-4', '5-8', '9-13', '14-18']);
/** Late news: ESPN has him at 0 while we do not, or his week's status is Out or Doubtful. */
export const LATE_NEWS_STATUS = /^(out|doubtful)\b/i;
/** Two leagues' ESPN numbers for one player must agree this closely to be one value. */
export const ESPN_AGREEMENT = 0.01;

export function phaseFor(week) {
  const w = Number(week);
  if (!Number.isFinite(w) || w <= 4) return '2-4';
  if (w <= 8) return '5-8';
  if (w <= 13) return '9-13';
  return '14-18';
}

const finite = v => typeof v === 'number' && Number.isFinite(v);

export function lateNewsTrigger({ ours, espn, reportStatus }) {
  if (!finite(espn)) return false;
  return (espn === 0 && ours > 0) || LATE_NEWS_STATUS.test(String(reportStatus ?? ''));
}

const cell = (table, position, week) => table?.[position]?.[phaseFor(week)];

/**
 * The seven candidates. `value` is only called with a finite `ours` and `espn` (the
 * fallbacks are decided once, in blendWeekPoints). `ladder` is the pre-registered
 * complexity order (fewest fitted parameters first); `weight` is the share on ours
 * where the candidate has one.
 */
export const CANDIDATES = Object.freeze({
  ours: Object.freeze({ id: 'C1', ladder: 0, fitted: 0, value: x => x.ours, weight: () => 1 }),
  espn: Object.freeze({ id: 'C2', ladder: 1, fitted: 0, value: x => x.espn, weight: () => 0 }),
  half: Object.freeze({ id: 'C3', ladder: 1, fitted: 0, value: x => 0.5 * x.ours + 0.5 * x.espn, weight: () => 0.5 }),
  news: Object.freeze({ id: 'C7', ladder: 2, fitted: 0,
    value: x => (lateNewsTrigger(x) ? x.espn : x.ours), weight: x => (lateNewsTrigger(x) ? 0 : 1) }),
  fit_shrunk: Object.freeze({ id: 'C4', ladder: 3, fitted: 1,
    value: (x, p) => p.w * x.ours + (1 - p.w) * x.espn, weight: (_x, p) => p.w }),
  pos_phase: Object.freeze({ id: 'C5', ladder: 4, fitted: 16,
    value: (x, p) => { const w = cell(p.w, x.position, x.week) ?? p.pooled; return w * x.ours + (1 - w) * x.espn; },
    weight: (x, p) => cell(p.w, x.position, x.week) ?? p.pooled }),
  espn_proven: Object.freeze({ id: 'C6', ladder: 5, fitted: 16,
    value: (x, p) => x.espn + (cell(p.b, x.position, x.week) ?? 0) * (x.ours - x.espn),
    weight: (x, p) => cell(p.b, x.position, x.week) ?? 0 })
});

/**
 * One player's number under one candidate (and, optionally, the late-news layer on top).
 * `bye` means he has no game this week (a bye, or no team), and the number is then 0.
 * Returns the number and why: 'no_game' | 'ours_position_not_graded' | 'no_espn_value' |
 * 'ours' | 'espn_late_news' | 'blend'. `weight_ours` is the share of the number that is
 * ours (1 when the number is ours alone, 0 when it is ESPN's alone).
 */
export function blendWeekPoints({ ours, espn = null, position, week, reportStatus = null, bye = false },
  { candidate, params = null, newsLayer = false } = {}) {
  const spec = CANDIDATES[candidate];
  if (!spec) throw new Error(`unknown blend candidate ${JSON.stringify(candidate)}`);
  if (!finite(ours)) throw new Error(`blendWeekPoints needs a finite number of ours (got ${ours})`);
  const e = finite(espn) ? espn : null;
  const own = basis => ({ ppg: ours, basis, weight_ours: 1, espn: e });
  if (bye) return { ppg: 0, basis: 'no_game', weight_ours: null, espn: e };
  if (!BLEND_POSITIONS.has(position)) return own('ours_position_not_graded');
  if (e == null) return own('no_espn_value');
  if (candidate === 'ours') return own('ours');
  const x = { ours, espn: e, position, week, reportStatus };
  if ((newsLayer || candidate === 'news') && lateNewsTrigger(x)) {
    return { ppg: e, basis: 'espn_late_news', weight_ours: 0, espn: e };
  }
  if (candidate === 'news') return own('ours');
  return { ppg: spec.value(x, params), basis: 'blend', weight_ours: spec.weight(x, params), espn: e };
}

/**
 * What the tournament decided (runner output
 * docs/evidence/2026-09-22/weekly-blend-tournament-output.json, `decision`; pinned by
 * test/weekly-blend.test.js). ESPN's weekly projection alone won: on 2023-2024, graded
 * walk-forward, it ordered the start/sit calls our number poses better than our number
 * (pair accuracy 0.683 vs 0.636), no blend of ours beat it by more than its MDE, and its point
 * estimates were above 0 on 2026 week 2 (one week, not blind: it had been looked at before the
 * pre-registration was committed).
 */
export const TOURNAMENT_DECISION = Object.freeze({
  winner: 'espn',
  on: true,
  verdict: 'shipped',
  news_layer: false,
  params: null,
  evidence: 'docs/evidence/2026-09-22/weekly-blend-tournament-output.json'
});

/**
 * FIX-164-1: the forward check the ship rule needs. The tournament's 2026 week 2 check is one
 * week, its pair-accuracy CI crosses 0 (ESPN minus ours +0.052 [-0.002, +0.102]) and it was
 * looked at before the pre-registration was committed. Only BLIND forward weeks count: 2026
 * weeks whose first game is after the pre-registration commit, graded by
 * `scripts/weekly-blend-tournament.mjs --forward-blind` (tournament output `forward_blind`,
 * one row per graded week in docs/evidence/HOLDOUT-LEDGER.md). The hold lifts only when the
 * pooled blind weeks give an ESPN-minus-ours pair-accuracy 90% CI lower bound above 0.
 */
export const FORWARD_CONFIRMATION = Object.freeze({
  prereg_commit: '7c443485a6d0efe1d930b254ac13ec98525c9eac',
  prereg_committed_at: '2026-09-22T20:21:29-04:00',
  season: 2026,
  rule: 'pooled blind 2026 weeks: ESPN minus ours pair accuracy, 90% CI lower bound > 0'
});

/** A week is blind when its first game day starts after the pre-registration commit. */
export function isBlindForwardWeek(firstGameday, committedAt = FORWARD_CONFIRMATION.prereg_committed_at) {
  const day = Date.parse(`${firstGameday}T00:00:00Z`);
  return Number.isFinite(day) && day > Date.parse(committedAt);
}

/** The forward hold's lift test on a `forward_blind` record (weeks graded, pooled comparison). */
export function forwardConfirmed(blind) {
  const lo = blind?.pooled?.pa?.ci90?.[0];
  return Boolean(blind?.weeks?.length) && blind.weeks.every(w => w.blind === true) && typeof lo === 'number' && lo > 0;
}

/**
 * Why the winner is not served yet. The tournament graded start/sit pairs where BOTH players
 * had an ESPN number; serving it changes numbers other pages compare across that line. Each
 * hold names what lifts it. While any stands, current_week_ppg is ours, labelled 'blend_off',
 * and context.week_blend says the blend is held and why.
 */
export const SERVING_HOLDS = Object.freeze([
  Object.freeze({
    id: 'waiver_ungraded',
    reason: 'the waiver board would price free agents rostered in another identically scored league on ESPN\'s number and every other free agent on ours, and that board was never graded against adding the highest-projected free agent',
    lifts_when: 'free agents have an ESPN capture (RL-1-1) or a waiver decision grade on 2023-2024 passes'
  }),
  Object.freeze({
    id: 'forward_unconfirmed',
    reason: 'the only forward week (2026 week 2) was looked at before the pre-registration, and its ESPN-minus-ours pair-accuracy CI crosses 0',
    lifts_when: 'blind forward 2026 weeks (first game after the pre-registration commit) give an ESPN-minus-ours pair-accuracy CI lower bound above 0 (forwardConfirmed on the tournament output\'s forward_blind)'
  })
]);

/**
 * Holds that were code-only and are lifted, each with the test that lifted it (FIX-164-3).
 * Kept so the surface and the evidence can say what was checked, not only what is left.
 */
export const LIFTED_HOLDS = Object.freeze([
  Object.freeze({ id: 'espn_zero_reads_as_missing', lifted_by: 'test/weekly-blend-holds.test.js',
    what: 'lineupCall compares a player whose weekly number is ESPN\'s 0 at 0 instead of reporting him as unpriced' }),
  Object.freeze({ id: 'labels_describe_ours', lifted_by: 'test/weekly-blend-wiring.test.js',
    what: 'week_basis says espn where weight_ours is 0, fantasy_coordinator and our construction move under week_blend.ours, and context.week_basis.label names the served source' }),
  Object.freeze({ id: 's03_identity', lifted_by: 'test/weekly-construction-grade.test.js',
    what: 'the served-identity walk and the consumer-parity check compare our construction with week_blend.ours.ppg, the blend\'s ours input' })
]);

/**
 * One provenance label for the served number (FIX-164-3b): 'espn' where none of it is ours,
 * 'blend' where part of it is, otherwise our construction's own basis.
 */
export function servedWeekBasis(oursBasis, weightOurs) {
  if (weightOurs === 0) return 'espn';
  if (typeof weightOurs === 'number' && weightOurs > 0 && weightOurs < 1) return 'blend';
  return oursBasis;
}

/**
 * context.week_basis for the served number: S-03's record of our construction as it is while
 * the blend is off; with it on, the label leads with the served source and our construction's
 * sentence moves to `ours_label`.
 */
export function servedWeekBasisContext(oursContext, config = SERVED_BLEND) {
  if (!config?.on || !oursContext) return oursContext;
  const rest = String(oursContext.label ?? '').replace(/^This week's points: /, '');
  const lead = config.candidate === 'espn'
    ? "This week's points: ESPN's weekly projection where ESPN has one. Where it has none, "
    : `This week's points: our projection blended with ESPN's weekly projection (${config.candidate}). Our part is `;
  return { ...oursContext, served: config.candidate, ours_label: oursContext.label, label: `${lead}${rest}` };
}

/**
 * The served switch: the tournament's winner, on only when the tournament said ship AND no
 * serving hold stands. `on: false` serves ours with every player saying why (`blend_off`).
 */
export const SERVED_BLEND = Object.freeze({
  on: TOURNAMENT_DECISION.on && SERVING_HOLDS.length === 0,
  candidate: TOURNAMENT_DECISION.winner,
  params: TOURNAMENT_DECISION.params,
  news_layer: TOURNAMENT_DECISION.news_layer,
  verdict: SERVING_HOLDS.length ? `held (${SERVING_HOLDS.map(h => h.id).join(', ')})` : TOURNAMENT_DECISION.verdict,
  holds: Object.freeze(SERVING_HOLDS.map(h => h.id)),
  evidence: TOURNAMENT_DECISION.evidence
});

/** The served entry point: trade-engine.js passes its own number through this, once. */
export function servedWeekBlend(input, config = SERVED_BLEND) {
  if (!config?.on) {
    const e = finite(input?.espn) ? input.espn : null;
    if (input?.bye) return { ppg: 0, basis: 'no_game', weight_ours: null, espn: e };
    if (!BLEND_POSITIONS.has(input?.position)) return { ppg: input.ours, basis: 'ours_position_not_graded', weight_ours: 1, espn: e };
    return { ppg: input.ours, basis: 'blend_off', weight_ours: 1, espn: e };
  }
  return blendWeekPoints(input, { candidate: config.candidate, params: config.params, newsLayer: config.news_layer });
}

/** A scoring map as a stable string, so two leagues' scoring can be compared. */
export function scoringKey(league) {
  const s = scoringFor(league);
  return JSON.stringify(Object.keys(s).sort().map(k => [k, s[k]]));
}

/**
 * ESPN's weekly projection for (season, week) as `league` scores it, keyed by ESPN player
 * id (string). Reads league_roster_snapshots only (writer collect-roster-snapshots.mjs:109).
 * Never selects a league's cookies. `state` names the absence: 'empty' when no identically
 * scored league has a row for this period, 'present' otherwise.
 */
export function espnWeekProjections({ league, season, week }) {
  const target = scoringKey(league);
  const leagues = rows(`SELECT id, platform, ppr, payload FROM leagues WHERE platform = 'espn' ORDER BY id`);
  const same = leagues.filter(l => l.id === league?.id || scoringKey(l) === target).map(l => l.id);
  const out = { values: new Map(), conflicting: 0, leagues: same, rows: 0, captured_at: null, state: 'empty' };
  if (!same.length) return out;
  const list = rows(`SELECT league_id, espn_player_id, projected_points, changed_at FROM league_roster_snapshots
                     WHERE season = ? AND scoring_period_id = ? AND on_roster = 1 AND projected_points IS NOT NULL
                       AND league_id IN (${same.map(() => '?').join(', ')})`, season, week, ...same);
  const seen = new Map();
  for (const r of list) {
    const id = Number(r.espn_player_id);
    const v = Number(r.projected_points);
    if (!id || !Number.isFinite(v)) continue;
    out.rows++;
    if (!out.captured_at || r.changed_at > out.captured_at) out.captured_at = r.changed_at;
    const k = String(id);
    const cur = seen.get(k);
    if (!cur) seen.set(k, { v, conflict: false });
    else if (Math.abs(cur.v - v) > ESPN_AGREEMENT) cur.conflict = true;
  }
  for (const [k, { v, conflict }] of seen) {
    if (conflict) out.conflicting++;
    else out.values.set(k, v);
  }
  if (out.rows) out.state = 'present';
  return out;
}

/** ESPN's number for one player from espnWeekProjections' map; an espn_id of 0 is "unknown". */
export function espnValueFor(espn, espnId) {
  const id = Number(espnId);
  if (!id) return null;
  return espn?.values?.get(String(id)) ?? null;
}

/** The sentence and facts for the surface (context.week_blend). */
export function weekBlendContext(espn, config = SERVED_BLEND) {
  const holds = config.holds ?? [];
  const label = !config.on
    ? holds.length
      ? `This week's points are our projection alone. ESPN's weekly projection won the blend test on start/sit calls, but it is not served yet: ${holds.length} check${holds.length === 1 ? '' : 's'} on the pages that read this number (${holds.join(', ')}) must pass first.`
      : `This week's points are our projection alone. A blend with ESPN's weekly projection was tested (${config.verdict}); it is not served.`
    : config.candidate === 'espn'
      ? "This week's points are ESPN's weekly projection where ESPN has one, and our projection where it does not."
      : `This week's points blend our projection with ESPN's weekly projection (${config.candidate}). Players ESPN has no number for keep ours.`;
  return {
    on: Boolean(config.on), candidate: config.candidate, news_layer: Boolean(config.news_layer), verdict: config.verdict,
    holds: [...holds], evidence: config.evidence, label,
    espn: { state: espn?.state ?? 'empty', rows: espn?.rows ?? 0, players: espn?.values?.size ?? 0,
      conflicting: espn?.conflicting ?? 0, leagues: espn?.leagues?.length ?? 0, captured_at: espn?.captured_at ?? null }
  };
}
